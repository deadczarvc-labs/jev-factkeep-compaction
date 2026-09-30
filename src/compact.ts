import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 200,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

// Fork (astra-hub, 2026-09-30): the upstream rules lost 10 of 10 content facts on a real transcript
// (session-tracks/jev-tails-20260929/compaction-compare.md). Facts sit in the lines a later step quotes:
// errors, paths, versions, ids, endpoints, HTTP codes, counts. A reduced result keeps them.
const FACT_PATTERNS: readonly RegExp[] = [
  /\b(error|errors|failed|failure|fail|exception|traceback|denied|refused|invalid|not found|timed? ?out|fatal|panic|warning)\b|invalid_\w+/i,
  /✖|✗|\bFAIL\b|\bERR\b/,
  /\bHTTP\b[\s/\d.]*\d{3}\b|\bstatus[\s:=]+\d{3}\b/i,
  /[A-Za-z]:[\\/][^\s"'<>]+|(?:^|[\s"'(=])\/(?:[\w.@-]+\/)+[\w.@-]+/,
  /\b\d+\.\d+\.\d+\b/,
  /\b[0-9a-f]{7,40}\b/,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\blocalhost:\d+\b/,
  /\b(pid|port|exit|rc|code|size|bytes|pass(?:ed)?|fail(?:ed)?|tests?|total|count)\b[\s:=]*\d/i,
  /\b\d[\d,.]*\s?(ms|kb|mb|gb|bytes|%|tokens|lines?|files?)\b/i,
  /\b\d{4,}\b/, // sizes, pids, ids: `ls -l` and process tables carry them bare
  /\b[\w.-]+\.(?:[cm]?[jt]sx?|py|json|ya?ml|md|toml|txt|log|rs|go|sh|ps1|cmd|lock|sql)\b/i,
];
const FACT_LINE_CHARS = 200;
const TAIL_CHARS = 120;
const ERROR_KEEP_CHARS = 2_000;

/** Lines of `text` that carry facts, most fact-dense first until `budget` chars, returned in text order. */
export function factLines(text: string, budget: number): string[] {
  const scored = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim().slice(0, FACT_LINE_CHARS), index }))
    .filter(({ line }) => line.length > 0)
    .map((entry) => ({ ...entry, score: FACT_PATTERNS.filter((re) => re.test(entry.line)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: typeof scored = [];
  const seen = new Set<string>();
  let used = 0;
  for (const entry of scored) {
    if (seen.has(entry.line) || used + entry.line.length + 1 > budget) continue;
    seen.add(entry.line);
    picked.push(entry);
    used += entry.line.length + 1;
  }
  return picked.sort((a, b) => a.index - b.index).map(({ line }) => line);
}

/** A reduced result that keeps its head, its fact lines and its tail; an error keeps more. */
export function factStubText(text: string, isError: boolean, headChars: number, factBudget: number): string {
  const headKeep = isError ? Math.max(headChars, ERROR_KEEP_CHARS) : headChars;
  if (text.length <= headKeep + TAIL_CHARS + 120) return text;
  const head = text.slice(0, headKeep);
  const tail = text.slice(-TAIL_CHARS);
  const facts = factLines(text.slice(headKeep, -TAIL_CHARS), factBudget);
  const omitted = text.length - headKeep - TAIL_CHARS;
  return `${head}\n[fast-jev-compaction omitted ${omitted} chars of this tool result${isError ? ' (error)' : ''}${
    facts.length ? `; kept its ${facts.length} fact line(s)` : ''
  }; re-run the tool if needed]\n${facts.length ? `${facts.join('\n')}\n…\n` : ''}${tail}`;
}

// The upstream goal (README "What and why", step 4): drop what re-running the tool would give back. So a
// reproducible read of files (Read, Grep, Glob, ls, cat, rg, sha256sum, git log...) shrinks to one line, while
// observations of transient state (network, processes, logs), errors and side effects keep their fact stub.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ToolSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_VERBS = new Set([
  'cd', 'echo', 'printf', 'true', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'find', 'fd', 'rg', 'grep',
  'egrep', 'sha256sum', 'sha1sum', 'md5sum', 'stat', 'file', 'tree', 'cut', 'tr', 'sort', 'uniq', 'sed', 'awk',
  'jq', 'basename', 'dirname', 'realpath', 'es', 'es.exe', 'get-content', 'get-childitem', 'select-string',
  'select-object', 'measure-object', 'get-filehash', 'test-path', 'resolve-path', 'format-table', 'out-string',
]);
const GIT_READS = /^git\s+(log|show|diff|status|blame|ls-files|rev-parse|branch|remote|describe)\b/;

/** True when re-running the call would give its output back: a read of files, not of the world. */
export function reproducible(tool: string, input: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(tool)) return true;
  if (!SHELL_TOOLS.has(tool)) return false;
  const command = String(input['command'] ?? '');
  if (!command || /(^|[^>2&])>{1,2}(?!&)|\btee\b|\|\s*(sh|bash|pwsh|iex)\b/.test(command.replace(/2>&1|2>\/dev\/null|2>\$null|>\s*\/dev\/null|>\s*\$null/g, ''))) return false;
  return command.split(/\r?\n|;|&&|\|\||\|/).every((segment) => {
    const words = segment.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^timeout\s+\S+\s+/, '').replace(/^command\s+/, '');
    if (!words) return true;
    if (GIT_READS.test(words)) return true;
    if (/^sed\s+(-\w*i|--in-place)/.test(words)) return false; // edits in place
    return READ_VERBS.has(words.split(/\s+/)[0]!.replace(/^["']|["']$/g, '').toLowerCase());
  });
}

/** One line for a reproducible read: the call (brief) stays, its output is a note. */
function rerunNote(text: string): string {
  return text.length <= 160 ? text : `[fast-jev-compaction omitted ${text.length} chars: a reproducible read, re-run the tool to see it]`;
}

/** String fields of a stubbed call's input cut to `max` chars: the call stays readable, not verbatim. */
export function briefInput(input: unknown, max: number): unknown {
  if (typeof input === 'string') return input.length > max ? `${input.slice(0, max)}…[${input.length - max} chars]` : input;
  if (Array.isArray(input)) return input.map((item) => briefInput(item, max));
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, briefInput(v, max)]));
  }
  return input;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  keepFacts = true,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  // Fork: a call Jev no longer needs is reduced to a fact stub (brief input, fact lines), never erased.
  if (keepFacts) return applyFactStubs(messages, actions, headChars);
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

const FACT_BUDGET_CHARS = 360;
const INPUT_BRIEF_CHARS = 200;
const RERUN_INPUT_CHARS = 160; // enough for the path or command that re-runs it

function applyFactStubs(
  messages: readonly Message[],
  actions: ReadonlyMap<string, CallDecision['action']>,
  headChars: number,
): Message[] {
  const rerunnable = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses) if (reproducible(tool.tool, tool.input)) rerunnable.add(tool.tool_use_id);
  }
  const reduce = (id: string, text: string, isError: boolean) =>
    rerunnable.has(id) && !isError ? rerunNote(text) : factStubText(text, isError, headChars, FACT_BUDGET_CHARS);
  return messages.map((message) => {
    let changed = false;
    const toolUses = message.toolUses.map((tool) => {
      const action = actions.get(tool.tool_use_id);
      if (!action || action === 'keep') return tool;
      const brief = rerunnable.has(tool.tool_use_id) ? RERUN_INPUT_CHARS : INPUT_BRIEF_CHARS;
      const input = action === 'drop_call' || rerunnable.has(tool.tool_use_id) ? (briefInput(tool.input, brief) as Record<string, unknown>) : tool.input;
      const text = tool.text === undefined ? undefined : reduce(tool.tool_use_id, tool.text, tool.isError ?? false);
      if (text === tool.text && JSON.stringify(input) === JSON.stringify(tool.input)) return tool;
      changed = true;
      const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input };
      if (text !== undefined) copy.text = text;
      if (tool.isError) copy.isError = true;
      return copy;
    });
    const toolResults = (message.toolResults ?? []).map((result) => {
      if (!actions.has(result.tool_use_id)) return result;
      const text = reduce(result.tool_use_id, result.text, result.isError ?? false);
      if (text === result.text) return result;
      changed = true;
      return { tool_use_id: result.tool_use_id, text, isError: result.isError };
    });
    if (!changed) return message;
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    return rebuilt;
  });
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
