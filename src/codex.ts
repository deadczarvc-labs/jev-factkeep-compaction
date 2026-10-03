import { deflateRawSync } from 'node:zlib';
import { factLines, reproducible } from './compact.js';
import { safeSlice } from './state.js';
import { tokenValues, toks, type ValueContext, valueLines } from './value-select.js';

/** Picks the lines of `text` worth keeping within `budget` chars, in text order. */
export type LineSelector = (text: string, budget: number) => string[];

/**
 * Lines ranked by conditional compressed length (MDL): a 200-char chunk scores its deflate size with the preceding
 * 32 KB of the same output as dictionary, per char. Ids, hashes, verdicts and errors do not compress against what came
 * before; repeated rows and boilerplate do. Taken by score until the budget, emitted in text order. Rule fixed before
 * JEV-CMP-23 H-A screening (ha/prereg.md); held-out confirmation JEV-CMP-25: 51.2% vs 40.6% of 404 facts for the regex
 * fact lines at a 10% budget, +10.6 pts [+4.3, +17.4] clustered by session.
 */
export function mdlLines(text: string, budget: number): string[] {
  const chunks: Array<{ s: string; at: number }> = [];
  let at = 0;
  for (const line of text.split('\n')) {
    for (let k = 0; k < Math.max(1, line.length); ) {
      const s = safeSlice(line, k, k + 200);
      chunks.push({ s, at: at + k });
      k += Math.max(1, s.length);
    }
    at += line.length + 1;
  }
  const scored = chunks.map((c, i) => {
    if (c.s.replace(/\s/g, '').length < 4) return { i, c, score: 0 };
    const dict = Buffer.from(safeSlice(text, Math.max(0, c.at - 32_768), c.at));
    const z = deflateRawSync(Buffer.from(c.s), dict.length ? { dictionary: dict } : {}).length;
    return { i, c, score: z / (c.s.length + 16) };
  });
  const picked: typeof scored = [];
  let used = 0;
  for (const x of [...scored].sort((p, q) => q.score - p.score || p.i - q.i)) {
    if (x.score === 0 || used + x.c.s.length + 1 > budget) continue;
    picked.push(x);
    used += x.c.s.length + 1;
  }
  return picked.sort((p, q) => p.i - q.i).map((x) => x.c.s);
}

/**
 * Regex fact lines within half the budget, then MDL chunks not already inside them. Not the default: it kept more
 * experimenter-chosen facts (JEV-CMP-25: +11.4 pts) but fewer of the tokens agents later act on (G08: sheet −1.6 pts
 * at 50k, Hermes stubs −1.6…−6.7); MDL ranks repetitive lines low, e.g. grep hits sharing a path the agent then opens.
 */
export function hybridLines(text: string, budget: number): string[] {
  const regex = factLines(text, Math.floor(budget / 2));
  const used = regex.reduce((n, l) => n + l.length + 1, 0);
  return [...regex, ...mdlLines(text, budget - used).filter((c) => !regex.some((l) => l.includes(c)))];
}

/**
 * Codex adapter. Codex compacts a chat into the user messages plus an opaque (server-encrypted) summary: every tool
 * output leaves the context, and what the summary kept cannot be checked. Its `SessionStart` hook with source
 * `compact` runs right after that, before the next model request, and may add developer context. This module turns the
 * session rollout into that context with the same fact rules as the Claude Code hook: a reproducible read becomes a
 * re-run line, an observation keeps its fact lines, and the full output is saved to a file (see codex/fact-sheet.ts).
 */
export interface CodexCall {
  id: string; // call_id
  tool: string; // 'Bash' for shell commands (what `reproducible` expects), else the Codex tool name(s)
  command: string; // the shell command(s), or the tool call in brief
  output: string; // model-facing output text, JSON wrappers of exec_command decoded
  error: boolean; // a non-zero exit code or a failed call
}

type Json = Record<string, unknown>;

const SHELL_WRAPPERS = /^(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)$/i;
const JS_STRING = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.source;
const CMD_ARG = new RegExp(/(?:\bcmd|"cmd")\s*:\s*/.source + JS_STRING, 'g');
const TOOL_CALL = /\btools\.([A-Za-z_][\w]*)\s*\(/g;
const EXEC_PREAMBLE = /^(?:Script completed|Script failed.*|Wall time [\d.]+ seconds|Output:)\s*$/;

function jsString(literal: string): string {
  const body = literal.slice(1, -1);
  try {
    return JSON.parse(literal[0] === '"' ? literal : `"${body.replace(/\\(['`])/g, '$1').replace(/"/g, '\\"')}"`) as string;
  } catch {
    return body;
  }
}

function brief(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${safeSlice(one, 0, max)}…` : one;
}

function shellCommand(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const parts = command.map(String);
  return parts.length >= 3 && SHELL_WRAPPERS.test(parts[0]!.split(/[\\/]/).pop()!) ? parts[parts.length - 1]! : parts.join(' ');
}

/** A code-mode `exec` script: the shell commands it runs, and whether it calls anything besides exec_command. */
function scriptCall(input: string): Pick<CodexCall, 'tool' | 'command'> {
  const tools = [...new Set([...input.matchAll(TOOL_CALL)].map((m) => m[1]!))];
  const commands = [...input.matchAll(CMD_ARG)].map((m) => jsString(m[1]!));
  if (commands.length && tools.every((t) => t === 'exec_command')) return { tool: 'Bash', command: commands.join('\n') };
  return { tool: tools.length ? tools.join('+') : 'exec', command: commands.length ? commands.join('\n') : brief(input, 400) };
}

/**
 * Command outputs inside a JSON value a script printed: an exec_command result `{exit_code, output}` at any depth
 * (alone, in an array, in a `Promise.allSettled` entry), a rejected entry's reason. Empty when there is none.
 */
function unwrap(value: unknown, out: { parts: string[]; error: boolean }): void {
  if (Array.isArray(value)) return value.forEach((v) => unwrap(v, out));
  if (!value || typeof value !== 'object') return;
  const o = value as Json;
  if (o['status'] === 'rejected') {
    out.error = true;
    out.parts.push(`[rejected] ${typeof o['reason'] === 'string' ? o['reason'] : JSON.stringify(o['reason'])}`);
    return;
  }
  if (typeof o['output'] === 'string') {
    const code = o['exit_code'] ?? (o['metadata'] as Json | undefined)?.['exit_code'];
    if (typeof code === 'number' && code !== 0) out.error = true;
    out.parts.push(`${typeof code === 'number' ? `[exit ${code}] ` : ''}${o['output']}`);
    return;
  }
  Object.values(o).forEach((v) => unwrap(v, out));
}

function decoded(text: string, out: { parts: string[]; error: boolean }): void {
  const trimmed = text.trim();
  const tryJson = (s: string): boolean => {
    if (!/^[[{]/.test(s) || (!s.includes('"output"') && !s.includes('"rejected"'))) return false;
    try {
      const inner = { parts: [] as string[], error: false };
      unwrap(JSON.parse(s), inner);
      if (!inner.parts.length) return false;
      out.parts.push(...inner.parts);
      out.error ||= inner.error;
      return true;
    } catch {
      return false;
    }
  };
  if (tryJson(trimmed)) return;
  for (const line of text.split('\n')) if (!tryJson(line.trim())) out.parts.push(line); // JSON lines, or plain text
}

function outputText(output: unknown): { text: string; error: boolean } {
  const items = typeof output === 'string' ? [output] : Array.isArray(output) ? output.map((i) => (typeof i === 'string' ? i : String((i as Json)?.['text'] ?? ''))) : [];
  const out = { parts: [] as string[], error: /^Script failed/m.test(items.join('\n')) };
  for (const item of items) decoded(item, out);
  const text = out.parts.join('\n').split(/\r?\n/).filter((line) => !EXEC_PREAMBLE.test(line)).join('\n').trim();
  return { text, error: out.error };
}

/** Tool calls with their outputs from a Codex rollout (JSONL), in call order; a call without an output is skipped. */
export function parseRollout(jsonl: string): CodexCall[] {
  const calls = new Map<string, Omit<CodexCall, 'output' | 'error'> & { ordinal: number }>();
  const done: Array<CodexCall & { ordinal: number }> = [];
  for (const [ordinal, line] of jsonl.split('\n').entries()) {
    if (!line.includes('"response_item"')) continue;
    let p: Json;
    try {
      const o = JSON.parse(line) as Json;
      if (o['type'] !== 'response_item') continue;
      p = o['payload'] as Json;
    } catch {
      continue;
    }
    const id = String(p['call_id'] ?? '');
    if (!id) continue;
    switch (p['type']) {
      case 'function_call': {
        const name = [p['namespace'], p['name']].filter(Boolean).join('__');
        let args: Json = {};
        try {
          args = JSON.parse(String(p['arguments'] ?? '{}')) as Json;
        } catch {
          // keep the raw arguments in the label
        }
        const command = shellCommand(args['cmd'] ?? args['command']);
        calls.set(id, { ordinal, ...(command && /exec_command|shell/.test(name) ? { id, tool: 'Bash', command } : { id, tool: name, command: brief(`${name} ${String(p['arguments'] ?? '')}`, 400) }) });
        break;
      }
      case 'custom_tool_call':
        calls.set(id, { id, ordinal, ...(p['name'] === 'exec' ? scriptCall(String(p['input'] ?? '')) : { tool: String(p['name']), command: brief(String(p['input'] ?? ''), 400) }) });
        break;
      case 'local_shell_call':
        calls.set(id, { id, ordinal, tool: 'Bash', command: shellCommand((p['action'] as Json | undefined)?.['command']) });
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const call = calls.get(id);
        if (!call) break;
        calls.delete(id);
        const { text, error } = outputText(p['output']);
        done.push({ ...call, output: text, error });
        break;
      }
    }
  }
  return done.sort((a, b) => a.ordinal - b.ordinal).map(({ ordinal, ...call }) => call);
}

/**
 * Candidate G19 (preregistered experiment, not on by default): fact lines by learned token value (V4,
 * value-select.ts) with each call's fact budget ×`k`. The context per output is the one the value model was fitted on:
 * the arguments of the last call before it, the last user text, the outputs left to the end, and the tokens the agent
 * reused (named in a reply or call after an output introduced them); events as the G17/G19 harness reads a rollout.
 */
export function v4SheetSelector(jsonl: string, calls: readonly CodexCall[], k = 4): LineSelector {
  const decodedOutput = new Map(calls.map((c) => [c.id, c.output]));
  const textOf = (body: unknown): string =>
    typeof body === 'string' ? body : Array.isArray(body) ? body.map((x) => String((x as Json)?.['text'] ?? '')).join('\n') : '';
  const ev: Array<{ k: 'user' | 'asst' | 'in' | 'out'; text: string }> = [];
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"response_item"')) continue;
    let p: Json;
    try {
      const o = JSON.parse(line) as Json;
      if (o['type'] !== 'response_item') continue;
      p = o['payload'] as Json;
    } catch {
      continue;
    }
    const t = p['type'];
    if (t === 'message' && (p['role'] === 'user' || p['role'] === 'assistant')) ev.push({ k: p['role'] === 'user' ? 'user' : 'asst', text: textOf(p['content']) });
    else if (t === 'agent_message') ev.push({ k: 'asst', text: textOf(p['content']) });
    else if (t === 'function_call' || t === 'custom_tool_call') ev.push({ k: 'in', text: String(p['arguments'] ?? p['input'] ?? '') });
    else if (t === 'function_call_output' || t === 'custom_tool_call_output') ev.push({ k: 'out', text: decodedOutput.get(String(p['call_id'] ?? '')) ?? textOf(p['output']) });
  }
  const outs = ev.filter((e) => e.k === 'out');
  const user = [...ev].reverse().find((e) => e.k === 'user')?.text ?? '';
  const intro = new Map<string, number>();
  const reused = new Set<string>();
  ev.forEach((e, i) => {
    const ts = toks(e.text);
    if (e.k === 'in' || e.k === 'asst') for (const t of ts) if ((intro.get(t) ?? Infinity) < i) reused.add(t);
    if (e.k === 'out') for (const t of ts) if (!intro.has(t)) intro.set(t, i);
  });
  const ctxOf = new Map<string, ValueContext>();
  let lastIn = '';
  let n = 0;
  for (const e of ev) {
    if (e.k === 'in') lastIn = e.text;
    if (e.k === 'out') ctxOf.set(e.text, { input: lastIn, user, dist: outs.length - n++, reused });
  }
  const valuesOf = new Map<string, Map<string, number>>();
  return (text, budget) => {
    if (!valuesOf.has(text)) valuesOf.set(text, tokenValues(text, ctxOf.get(text) ?? { input: '', user, dist: 0, reused }));
    return valueLines(text, budget * k, valuesOf.get(text)!);
  };
}

export const SMALL_OUTPUT = 400; // an output up to this many chars is kept whole: it is almost all facts

/**
 * Codex on Windows reads through PowerShell variables: `$p='f.md'; $x=Get-Content $p; $x[10..90]`. For the shared
 * read rule, a literal assignment is neutral, `$x = <command>` is that command, and printing a variable is an echo.
 * `reproducible` still sees the original (MUTABLE_SOURCE: a variable holding a .log path stays an observation).
 */
export function psReads(command: string): string {
  return command
    .split(/\r?\n|;/)
    .map((segment) => {
      const s = segment.trim();
      if (/^\$[\w:]+\s*=\s*(?:'[^']*'|"[^"]*"|@\(|\d)/.test(s) && !/\|/.test(s)) return 'true';
      if (/^\$[\w:]+(?:\[[^\]]*\]|\.\w+)*$/.test(s)) return 'echo';
      return s.replace(/^\$[\w:]+\s*=\s*/, '');
    })
    .join('\n');
}
const ERROR_MARK = /\b(?:error|failed|failure|exception|traceback|denied|not found|timed? ?out)\b/i;

/**
 * Detail tiers of a digest entry: 0 = the output verbatim, 1 = its fact lines (a reproducible read: one re-run line),
 * 2 = one line naming the call and where its full output is.
 */
export type Tier = 0 | 1 | 2;

/** One call as digest lines: short output whole, a reproducible read as a re-run line, an observation as its facts. */
export function callEntry(call: CodexCall, savedAt?: string, tier: Tier = 1, select: LineSelector = factLines): string {
  const head = `- ${call.id} \`${brief(call.command, 160)}\`${call.error ? ' (error)' : ''}`;
  const where = savedAt ? `full output: ${savedAt}` : 'full output: in the session rollout';
  if (call.output.length <= SMALL_OUTPUT || tier === 0) return call.output ? `${head}\n${indent(call.output)}` : `${head} (no output)`;
  if (tier === 2) return `${head} — ${call.output.length} chars; ${where}`;
  const read = !call.error && call.tool === 'Bash' && reproducible('Bash', { command: psReads(call.command), original: call.command });
  if (read) return `${head} — a read (${call.output.length} chars), re-run to see it; ${where}`;
  const error = call.error || ERROR_MARK.test(safeSlice(call.output, -600));
  const budget = Math.min(error ? 2400 : 1200, Math.max(300, Math.floor(call.output.length * 0.1)));
  const facts = select(call.output, budget);
  const tail = error ? safeSlice(call.output, -300).trim() : '';
  return `${head} — ${call.output.length} chars, ${facts.length} fact line(s) kept; ${where}\n${indent([...facts, ...(tail && !facts.some((f) => tail.includes(f)) ? ['…', tail] : [])].join('\n'))}`;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

export interface Digest {
  text: string; // model-facing: newest calls first within the budget, listed in call order
  full: string; // every call, for the saved facts file
  listed: number;
  total: number;
}

/**
 * Context around each compaction in the rollout (JEV-CMP-23 H-C): `before` = the last request's input tokens before it,
 * `after` = the first request's after it (null for the one that just happened); `reads` = tool calls that open a saved
 * output of this hook (`fast-jev` + `cache` in the command). Missing measured usage stays null, not an estimated zero.
 * Logged so the budget can later follow the measured level.
 */
export function compactionStats(jsonl: string, calls: readonly CodexCall[]): { before: Array<number | null>; after: Array<number | null>; reads: number } {
  const before: Array<number | null> = [];
  const after: Array<number | null> = [];
  let last: number | null = null;
  let waiting = false;
  for (const line of jsonl.split('\n')) {
    if (line.includes('"compacted"') && /"type"\s*:\s*"compacted"/.test(line)) {
      before.push(last);
      after.push(null);
      waiting = true;
      continue;
    }
    const m = line.includes('"token_count"') ? /"last_token_usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)/.exec(line) : null;
    if (!m || Number(m[1]) === 0) continue;
    last = Number(m[1]);
    if (waiting) {
      after[after.length - 1] = last;
      waiting = false;
    }
  }
  return { before, after, reads: calls.filter((c) => /fast-jev/i.test(c.command) && /cache/i.test(c.command)).length };
}

/** The model's context window in tokens, as the rollout last reports it. */
export function contextWindow(jsonl: string): number | undefined {
  const found = [...jsonl.matchAll(/"model_context_window"\s*:\s*(\d+)/g)].pop();
  return found ? Number(found[1]) : undefined;
}

export const MIN_BUDGET = 18_000;
export const MAX_BUDGET = 200_000;

/**
 * Digest size in chars: 5% of the model window (≈ 4 chars a token), within [MIN_BUDGET, MAX_BUDGET]. A compacted Codex
 * chat keeps only the user messages and a summary, so the window has room; a fixed size ignores it (JEV-CMP-21: 18k chars
 * against 0.3–0.9M chars of output reached back ~35 calls, no better than a raw tail of the same size).
 */
export function budgetFor(windowTokens?: number): number {
  if (!windowTokens) return MIN_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(windowTokens * 4 * 0.05)));
}

/**
 * The fact sheet for the calls; `savedAt(id)` names a call's saved full output, if any. Newest first: outputs verbatim
 * within half the budget (one too long for that is skipped, not a stop); fact lines for the calls not yet placed; one line
 * each while room is left; then the remaining room turns fact lines back into verbatim outputs. What fits whole goes whole.
 * JEV-CMP-21: fact lines first let 35 older calls starve the three newest, which a raw tail of the same size kept.
 */
export function buildDigest(
  calls: readonly CodexCall[],
  budgetChars: number,
  savedAt: (id: string) => string | undefined,
  sheetPath?: string,
  verbatimShare = 0.5,
  select: LineSelector = factLines,
): Digest {
  const cache = new Map<string, string>();
  const entry = (i: number, tier: Tier) => {
    const key = `${i}:${tier}`;
    if (!cache.has(key)) cache.set(key, callEntry(calls[i]!, savedAt(calls[i]!.id), tier, select));
    return cache.get(key)!;
  };
  const budget = budgetChars - 600; // the header
  const tiers = new Map<number, Tier>();
  let used = 0;
  const newestFirst = calls.map((_, k) => calls.length - 1 - k);
  const place = (i: number, tier: Tier, limit: number): boolean => {
    const size = entry(i, tier).length + 1 - (tiers.has(i) ? entry(i, tiers.get(i)!).length + 1 : 0);
    if (used + size > limit) return false;
    tiers.set(i, tier);
    used += size;
    return true;
  };
  for (const i of newestFirst) place(i, 0, budget * verbatimShare);
  for (const tier of [1, 2] as const) {
    for (const i of newestFirst) if (!tiers.has(i) && !place(i, tier, budget)) break;
  }
  for (const i of newestFirst) if (tiers.get(i) === 1) place(i, 0, budget);
  if (!tiers.size && calls.length) tiers.set(calls.length - 1, 2); // the newest call is always listed
  const picked = [...tiers.keys()].sort((a, b) => a - b);
  const entries = calls.map((_, k) => entry(k, 1));
  const older = calls.length - picked.length;
  const header = [
    'fast-jev-compaction (Codex): the chat was just compacted, so tool outputs left the context. They follow in call order:',
    'the newest in full, older ones as fact lines, the oldest as one line. "re-run" marks a read you can repeat; every long output',
    'is saved in full (secret values masked): read the file before relying on a detail not shown here.',
    older ? `${older} older call(s) are not listed here${sheetPath ? `; all ${entries.length}: ${sheetPath}` : ''}.` : '',
  ].filter(Boolean).join('\n');
  return { text: `${header}\n${picked.map((i) => entry(i, tiers.get(i)!)).join('\n')}`, full: `${header.split('\n').slice(0, 3).join('\n')}\n${entries.join('\n')}\n`, listed: picked.length, total: entries.length };
}
