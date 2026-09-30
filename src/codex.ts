import { factLines, reproducible } from './compact.js';

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
  return one.length > max ? `${one.slice(0, max)}…` : one;
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
  const calls = new Map<string, Omit<CodexCall, 'output' | 'error'>>();
  const done: CodexCall[] = [];
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
        calls.set(id, command && /exec_command|shell/.test(name) ? { id, tool: 'Bash', command } : { id, tool: name, command: brief(`${name} ${String(p['arguments'] ?? '')}`, 400) });
        break;
      }
      case 'custom_tool_call':
        calls.set(id, { id, ...(p['name'] === 'exec' ? scriptCall(String(p['input'] ?? '')) : { tool: String(p['name']), command: brief(String(p['input'] ?? ''), 400) }) });
        break;
      case 'local_shell_call':
        calls.set(id, { id, tool: 'Bash', command: shellCommand((p['action'] as Json | undefined)?.['command']) });
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
  return done;
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

/** One call as digest lines: short output whole, a reproducible read as a re-run line, an observation as its facts. */
export function callEntry(call: CodexCall, savedAt?: string): string {
  const head = `- ${call.id} \`${brief(call.command, 160)}\`${call.error ? ' (error)' : ''}`;
  const where = savedAt ? `full output: ${savedAt}` : 'full output: in the session rollout';
  if (call.output.length <= SMALL_OUTPUT) return call.output ? `${head}\n${indent(call.output)}` : `${head} (no output)`;
  if (!call.error && call.tool === 'Bash' && reproducible('Bash', { command: psReads(call.command), original: call.command })) {
    return `${head} — a read (${call.output.length} chars), re-run to see it; ${where}`;
  }
  const error = call.error || ERROR_MARK.test(call.output.slice(-600));
  const budget = Math.min(error ? 2400 : 1200, Math.max(300, Math.floor(call.output.length * 0.1)));
  const facts = factLines(call.output, budget);
  const tail = error ? call.output.slice(-300).trim() : '';
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

/** The fact sheet for the calls; `savedAt(id)` names a call's saved full output, if any. */
export function buildDigest(calls: readonly CodexCall[], budgetChars: number, savedAt: (id: string) => string | undefined, sheetPath?: string): Digest {
  const entries = calls.map((call) => callEntry(call, savedAt(call.id)));
  const picked: number[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (picked.length && used + entries[i]!.length + 1 > budgetChars) break; // the newest call is always listed
    picked.unshift(i);
    used += entries[i]!.length + 1;
  }
  const older = entries.length - picked.length;
  const header = [
    'fast-jev-compaction (Codex): the chat was just compacted, so tool outputs left the context. Facts from them follow,',
    'newest calls within the budget, in call order. "re-run" marks a read you can repeat; an observation keeps its fact',
    'lines; every long output is saved in full (secret values masked). Read the file before relying on a detail not shown.',
    older ? `${older} older call(s) are not listed here${sheetPath ? `; all ${entries.length}: ${sheetPath}` : ''}.` : '',
  ].filter(Boolean).join('\n');
  return { text: `${header}\n${picked.map((i) => entries[i]).join('\n')}`, full: `${header.split('\n').slice(0, 3).join('\n')}\n${entries.join('\n')}\n`, listed: picked.length, total: entries.length };
}
