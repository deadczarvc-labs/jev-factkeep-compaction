import type {
  On,
  PluginOptions,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, fullOutputNote, RAIL_FLOOR, reductionRatio, resolveOptions } from '../src/compact.js';
import { redactSecrets } from '../src/secrets.js';
import { collectToolCalls, estimateTokens, safeSlice } from '../src/state.js';
import { ESTIMATOR_ID, PROJECTION_ID, estimateDenseTokens, measureTranscript, type MeasureResult } from '../src/metrics.js';
import { auditArgv, buildAuditEvent, canonicalContentChanged, classifyGate, finalizeMeasurements, normalizeObserved, observedCounters, parseAuditAck, serializeAuditEvent, type AuditEvent, type AuditIdentity, type AuditOutcome, type AuditErrorCode, type AuditSink } from '../src/audit.js';
import { buildJevRequest, JevConfigError, JevRoundError, parseJevResponse } from '../src/request.js';
import { requireJevApiKey, resolveJevEndpoint, selectJevApiKey, type JevProviderOptions, type ResolvedJevEndpoint } from '../src/providers.js';
import type {
  CallAnswer,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
  RoundObservation,
  JevResponse,
} from '../src/types.js';

/** The running version, in every toast and log line (tests/hook.test.ts keeps it equal to plugin.json). */
export const VERSION = '0.3.0-astra.28';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
  headers?: Readonly<Record<string, string>>;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  /** Raw transport values survive the plugin boundary until runtime validation inside the fallback guard. */
  apiKey?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  allowThirdPartyEgress?: unknown;
  compactAtPercent: number;
  minReductionRatio: number;
  /** Save the full output of every reduced result under `<cwd>/.claude/fast-jev/<session>/`. Default true. */
  saveFullOutputs: boolean;
  /** Metadata-only local journal; disabled means no audit process or filesystem I/O. */
  auditLog: boolean;
  /** Explicit trusted absolute Node runtime and, on Windows, a separately verified hidden launcher. */
  auditNodePath?: string;
  auditLauncherPath?: string;
  /** Internal metadata observer; never sourced from plugin options or allowed to change compaction. */
  observeRound?: (round: RoundObservation) => void;
};

export type ResolvedHookConfig = Readonly<
  Omit<HookConfig, keyof JevProviderOptions | 'apiKey'> & ResolvedJevEndpoint & {
    apiKey: string;
    allowThirdPartyEgress: boolean;
  }
>;

// Only validated, immutable runtime snapshots reuse their resolved tuple.
const runtimeEndpoints = new WeakMap<HookConfig, ResolvedJevEndpoint>();

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Snapshot plugin options, applying only compaction defaults; transport defaults belong to its provider. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const timeout = options.compactionTimeoutMs;
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1000) {
    numbers.compactionTimeoutMs = timeout;
  }
  const retryOptions: CompactOptions = {};
  for (const key of ['maxJevAttempts', 'maxConcurrentJevRequests'] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (typeof value !== 'number') throw new RangeError(`${key} must be an integer`);
      retryOptions[key] = value;
    }
  }
  const partial = options.partialAnswers;
  if (partial !== undefined) {
    if (partial !== 'retain-unscored' && partial !== 'rollback') throw new RangeError('partialAnswers must be retain-unscored or rollback');
    retryOptions.partialAnswers = partial;
  }
  const retries = resolveOptions(retryOptions);
  const config: HookConfig = {
    ...numbers,
    maxJevAttempts: retries.maxJevAttempts,
    maxConcurrentJevRequests: retries.maxConcurrentJevRequests,
    partialAnswers: retries.partialAnswers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    saveFullOutputs: options.saveFullOutputs !== false,
    auditLog: options.auditLog === true,
    ...(optionString(options, 'auditNodePath') ? { auditNodePath: optionString(options, 'auditNodePath') } : {}),
    ...(optionString(options, 'auditLauncherPath') ? { auditLauncherPath: optionString(options, 'auditLauncherPath') } : {}),
  };
  for (const key of ['provider', 'baseUrl', 'model', 'allowThirdPartyEgress', 'apiKey'] as const) {
    // The host passes an unset string userConfig field as '' (live /compact probe, astra.27): here '' means unset.
    if (Object.hasOwn(options, key) && options[key] !== '') config[key] = options[key];
  }
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return Object.freeze(config);
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  endpoint: ResolvedJevEndpoint,
  nowMs: NonNullable<CompactOptions['nowMs']> = async () => Date.now(),
  observation?: { request: (tokens: number) => void; usage: (usage: JevResponse['usage']) => void },
): JevAsker {
  // Configuration errors trigger fallback even with no candidates or cached answers.
  requireJevApiKey(endpoint, apiKey);
  return {
    async ask(state, questions, signal) {
      signal?.throwIfAborted();
      const request = (() => {
        try { return buildJevRequest({ apiKey, model: endpoint.model, baseUrl: endpoint.baseUrl }, state, questions); }
        catch (error) { throw error instanceof JevConfigError ? error : new JevConfigError('request'); }
      })();
      if (observation) { try { observation.request(estimateDenseTokens(request.body)); } catch { /* Observation never controls HTTP. */ } }
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      signal?.throwIfAborted();
      const now = await nowMs();
      signal?.throwIfAborted();
      // The SDK buffers text and declares neither cancellation nor a network-error discriminator.
      const parsed = parseJevResponse(response.status, response.ok, response.text, response.headers, now);
      if (observation) { try { observation.usage(parsed.usage); } catch { /* Retain only numeric usage. */ } }
      return parsed;
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

// Jev's answers by tool_use_id (globally unique), kept for the life of the hook module: a re-compaction of the same
// session does not ask about calls it already decided. ponytail: in-memory, capped; lost on restart, which only
// costs the requests it would have saved.
const knownAnswers = new Map<string, CallAnswer>();
const KNOWN_CAP = 20_000;

/** Clears the remembered answers (tests; a fresh session never needs it: tool_use_ids do not repeat). */
export function forgetAnswers(): void {
  knownAnswers.clear();
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
/** The context window's fill, as `$.session.usage().context` has it. */
export type WindowUsage = { tokens?: number; window?: number };

/** At most this share of the window is taken as system prompt and tools (first calls: 55–127k of 1M, 2026-10-02). */
export const OVERHEAD_CAP = 0.15;

export type Pressure = {
  /** The char reduction the rails must reach. */
  minReduction: number;
  /** The reduction below which the hook falls back to the built-in summary. */
  gate: number;
};

export type CompactionFinalOutcome = Readonly<{
  outcome: 'result-returned' | 'partial-returned' | 'fallback-returned' | 'own-returned' | 'failure';
  host_applied: null;
}>;

/** Pure final-outcome seam for the audit writer. Returning a candidate is not independent host application evidence. */
export function finalCompactionOutcome(
  result: CompactResult | undefined,
  needed: Pressure,
  fallback: 'not-called' | 'returned' | 'failed',
): CompactionFinalOutcome {
  let outcome: CompactionFinalOutcome['outcome'] = 'failure';
  if (fallback === 'returned') outcome = 'fallback-returned';
  else if (result) {
    const reduction = reductionRatio(result);
    if (fallback === 'failed' && reduction > 0 && reduction < needed.gate) outcome = 'own-returned';
    else if (fallback === 'not-called' && reduction >= needed.gate) outcome = result.stats.jev?.completion === 'partial' ? 'partial-returned' : 'result-returned';
  }
  return Object.freeze({ outcome, host_applied: null });
}

/**
 * How much a compaction must free: enough to bring the context back to `compactAtPercent − 10` of the window, and
 * accepted when it lands at or below `compactAtPercent − 5`. A fixed minimum (the old 30% rails floor, 25% gate) made
 * repeated compactions of one session cut more than the window needed and fall back to the summary once kept facts
 * filled it; in a simulated session one window long this keeps 97.0% of 336 preregistered facts against 92.6%. The
 * part of the context outside the transcript (system prompt, tools) does not shrink. Its size is the window's token
 * count minus the transcript's estimate, capped by `lowest` (the smallest context seen this session) and by
 * OVERHEAD_CAP of the window: the estimate reads ~1.75× low on Cyrillic and code (engine postTokens 356 878 against
 * 628 724 real, 2026-10-02), which inflated the overhead to ~400k and once demanded 42% where 5% sufficed (core summary,
 * 110 s). The char ratio of a reduction applies to the transcript's real tokens. Without usage figures the fixed defaults
 * apply.
 */
export function pressure(
  usage: WindowUsage | undefined,
  transcriptTokens: number,
  config: HookConfig,
  lowest?: number,
): Pressure {
  if (!usage?.tokens || !usage.window || transcriptTokens <= 0) {
    return { minReduction: RAIL_FLOOR, gate: config.minReductionRatio };
  }
  const overhead = Math.max(
    0,
    Math.min(usage.tokens - transcriptTokens, lowest ?? Number.POSITIVE_INFINITY, OVERHEAD_CAP * usage.window),
  );
  const transcript = usage.tokens - overhead;
  const need = (percent: number) => 1 - ((percent / 100) * usage.window! - overhead) / transcript;
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return {
    minReduction: clamp(need(config.compactAtPercent - 10), 0.05, 0.9),
    gate: clamp(need(config.compactAtPercent - 5), 0, 0.9),
  };
}

/** Estimated tokens of a transcript's texts, tool inputs and tool results. */
export function transcriptTokens(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const message of messages as readonly Message[]) {
    total += estimateTokens(message.text ?? '');
    for (const use of message.toolUses ?? []) total += estimateTokens(JSON.stringify(use.input ?? {}));
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text ?? '');
  }
  return total;
}

export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  minReduction?: number,
  offload?: { dir: string; fs: OffloadFs },
): Promise<SessionCompaction> {
  // Raw helpers and registered hooks share the same gate, even for empty or pinned-only history.
  const endpoint = runtimeEndpoints.get(config) ?? resolveJevEndpoint(config as JevProviderOptions);
  const apiKey = requireJevApiKey(endpoint, selectJevApiKey(endpoint, config.apiKey as string | undefined, {}));
  const snapshot = config.auditLog ? provenanceBefore(messages, config) : undefined;
  let maximum: number | null = null, responses = 0, usageResponses = 0, input = 0, output = 0, allInput = true, allOutput = true;
  const observation = snapshot ? {
    request: (tokens: number) => { maximum = Math.max(maximum ?? 0, tokens); },
    usage: (usage: JevResponse['usage']) => {
      responses++;
      const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
      const i = usage?.input_tokens, o = usage?.output_tokens;
      if (valid(i) || valid(o)) usageResponses++;
      if (valid(i)) input += i; else allInput = false;
      if (valid(o)) output += o; else allOutput = false;
    },
  } : undefined;
  const observe = (result?: CompactResult, error?: unknown) => {
    if (!snapshot || !config.observeRound) return;
    const counts = result?.stats.jev ?? (error instanceof JevRoundError ? error.counts : undefined);
    const fresh = result ? counts?.scoredCalls ?? 0 : 0, unscored = counts?.unscoredCalls ?? 0;
    const round: RoundObservation = {
      completion: result ? result.stats.jev?.completion ?? 'complete' : 'failed',
      terminal_code: result?.stats.jev?.terminalCode ?? (error instanceof JevRoundError ? error.code : error ? 'unknown' : 'none'),
      requests_planned: result?.stats.requests ?? null, attempts: counts?.attempts ?? 0, retries: counts?.retries ?? 0,
      parsed: counts?.parsed ?? 0, scored_calls: counts?.scoredCalls ?? 0, unscored_calls: unscored, fresh,
      cache: snapshot.cache, pinned: snapshot.pinned, reduced: snapshot.reduced,
      floor: result ? Math.max(0, snapshot.candidates - fresh - unscored) : 0,
      request_estimated_max: maximum, actual_input_tokens: responses > 0 && allInput ? input : null,
      actual_output_tokens: responses > 0 && allOutput ? output : null, usage_responses: usageResponses,
    };
    try { config.observeRound(round); } catch { /* The observer cannot fail compaction. */ }
  };
  let result: CompactResult;
  try { result = await compact(messages, jevAsker(fetchFn, apiKey, endpoint, config.nowMs, observation), {
    ...config,
    secrets: [...(config.secrets ?? []), apiKey],
    knownAnswers,
    ...(minReduction === undefined ? {} : { minReduction }),
  }); } catch (error) { observe(undefined, error); throw error; }
  for (const id of knownAnswers.keys()) {
    if (knownAnswers.size <= KNOWN_CAP) break;
    knownAnswers.delete(id);
  }
  const kept = offload ? await offloadOutputs(messages, result.messages, offload.dir, offload.fs) : result.messages;
  observe(result);
  return { result: { ...result, messages: kept }, messages: toSessionMessages(messages, kept) };
}

/** The same paired-call eligibility as the core, captured before its valid-answer cache is published. */
function provenanceBefore(messages: readonly SessionMessage[], config: HookConfig) {
  const calls = collectToolCalls(messages, config.preserveRecentMessages ?? 6);
  const reduced = new Set(messages.flatMap((m) => [
    ...(m.toolResults ?? []).filter((r) => /\[fast-jev-compaction (?:omitted|truncated) /.test(r.text)).map((r) => r.tool_use_id),
    ...m.toolUses.filter((u) => u.text !== undefined && /\[fast-jev-compaction (?:omitted|truncated) /.test(u.text)).map((u) => u.tool_use_id),
  ]));
  const snapshot = { pinned: 0, reduced: 0, cache: 0, candidates: 0 };
  for (const call of calls) {
    if (call.pinned) snapshot.pinned++;
    else if (reduced.has(call.tool_use_id)) snapshot.reduced++;
    else if (knownAnswers.has(call.tool_use_id)) snapshot.cache++;
    else snapshot.candidates++;
  }
  return snapshot;
}

/**
 * Before a fallback to the built-in summary: every tool output longer than 200 chars goes to `<dir>/<tool_use_id>.txt`,
 * with an index (id, tool, brief input, size); returns the line the summarizer is given, or undefined when a write
 * fails (the summary then goes ahead without it).
 */
export async function saveForSummary(messages: readonly SessionMessage[], dir: string, fs: OffloadFs): Promise<string | undefined> {
  const uses = new Map<string, ToolUse>();
  for (const message of messages as readonly Message[]) for (const use of message.toolUses ?? []) uses.set(use.tool_use_id, use);
  const index: string[] = [];
  try {
    await fs.write(`${dir.replace(/[\\/][^\\/]+[\\/]?$/, '')}/.gitignore`, '*\n');
    for (const message of messages as readonly Message[]) {
      for (const result of message.toolResults ?? []) {
        if (result.text.length < 200) continue;
        await fs.write(`${dir}/${result.tool_use_id.replace(/[^\w.-]/g, '_')}.txt`, safeSlice(redactSecrets(result.text), 0, OFFLOAD_MAX_CHARS));
        const use = uses.get(result.tool_use_id);
        index.push(`${result.tool_use_id}\t${use?.tool ?? '?'}\t${safeSlice(redactSecrets(JSON.stringify(use?.input ?? {})), 0, 160)}\t${result.text.length} chars`);
      }
    }
    if (index.length === 0) return undefined;
    const name = `${dir}/index-${Date.now()}.txt`;
    await fs.write(name, `${index.join('\n')}\n`);
    return `The full outputs of this session's tool calls are saved as files under ${dir}, one per tool_use_id (index: ${name}). Keep this path in the summary so exact outputs can be read back.`;
  } catch {
    return undefined;
  }
}

/** The file writes the offload needs: `$.fs` in the hook, a fake in tests. */
export type OffloadFs = {
  write: (path: string, text: string) => Promise<void>;
  list?: (path: string) => Promise<ReadonlyArray<{ name: string; kind: string; size: number }>>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
};

/** Saved outputs live as long as Claude Code keeps a transcript by default. */
export const OUTPUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Empties saved outputs older than `maxAgeMs` under `root` (`<cwd>/.claude/fast-jev/cache`). `$.fs` cannot delete, so
 * an expired file is overwritten with nothing; its name (a tool_use_id) stays. Returns how many were emptied.
 */
export async function expireOutputs(root: string, fs: OffloadFs, now: number, maxAgeMs = OUTPUT_MAX_AGE_MS): Promise<number> {
  if (!fs.list || !fs.stat) return 0;
  let emptied = 0;
  try {
    for (const session of await fs.list(root)) {
      if (session.kind !== 'dir') continue;
      for (const file of await fs.list(`${root}/${session.name}`)) {
        if (file.kind !== 'file' || file.size === 0 || !file.name.endsWith('.txt')) continue;
        const path = `${root}/${session.name}/${file.name}`;
        if (now - (await fs.stat(path)).mtimeMs > maxAgeMs) {
          await fs.write(path, '');
          emptied++;
        }
      }
    }
  } catch {
    // a missing root or a refused read: nothing to expire this time
  }
  return emptied;
}

const OFFLOAD_MAX_CHARS = 4_000_000; // $.fs.write rejects over 4 MiB

/**
 * Saves the full output of every result a compaction reduced to `<dir>/<tool_use_id>.txt` and points its note there,
 * so no fact is gone: what the stub does not keep is one Read away. A reproducible read is not saved (a re-run gives
 * it back). A write that fails leaves the note pointing to the transcript. `<dir>/../.gitignore` keeps the files out
 * of git.
 */
export async function offloadOutputs(
  original: readonly SessionMessage[],
  compacted: readonly Message[],
  dir: string,
  fs: OffloadFs,
): Promise<Message[]> {
  const full = new Map<string, string>();
  for (const message of original as readonly Message[]) {
    for (const result of message.toolResults ?? []) full.set(result.tool_use_id, result.text);
  }
  const root = dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
  let ignored = false;
  const out: Message[] = [];
  for (const message of compacted) {
    if (!message.toolResults?.some((result) => result.text.includes(fullOutputNote(result.tool_use_id)))) {
      out.push(message);
      continue;
    }
    const results = [];
    for (const result of message.toolResults) {
      const note = fullOutputNote(result.tool_use_id);
      const text = full.get(result.tool_use_id);
      if (!result.text.includes(note) || text === undefined) {
        results.push(result);
        continue;
      }
      const path = `${dir}/${result.tool_use_id.replace(/[^\w.-]/g, '_')}.txt`;
      try {
        if (!ignored) {
          await fs.write(`${root}/.gitignore`, '*\n');
          ignored = true;
        }
        await fs.write(path, safeSlice(redactSecrets(text), 0, OFFLOAD_MAX_CHARS));
        results.push({ ...result, text: result.text.replace(note, `the full output is saved at ${path}; Read it for anything not kept here`) });
      } catch {
        results.push(result);
      }
    }
    out.push({ ...message, toolResults: results });
  }
  return out;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    (stats.jev?.unscoredCalls ?? 0) > 0 ? `${stats.jev!.unscoredCalls} unscored` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${stats.jev ? `; ${stats.jev.attempts} attempt(s), ${stats.jev.retries} retry send(s), ${stats.jev.completion}` : ''}`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        d.reason === 'unscored' ? `${d.id}:${d.tool}:${d.action}/unscored` :
          `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

type HookKeySource = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
};

async function getApiKey(
  $: HookKeySource,
  config: HookConfig,
  endpoint: ResolvedJevEndpoint,
): Promise<string | undefined> {
  // Validate an explicit value without reading any ambient credential; empty is still explicit.
  const explicit = selectJevApiKey(endpoint, config.apiKey as string | undefined, {});
  if (explicit !== undefined || endpoint.keyEnv === null) return explicit;
  let fromEnv: string | undefined;
  switch (endpoint.keyEnv) {
    case 'TYPESAFE_API_KEY': fromEnv = await $.env.get('TYPESAFE_API_KEY'); break;
    case 'OPENROUTER_API_KEY': fromEnv = await $.env.get('OPENROUTER_API_KEY'); break;
    case 'AI_GATEWAY_API_KEY': fromEnv = await $.env.get('AI_GATEWAY_API_KEY'); break;
  }
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)[endpoint.keyEnv];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Resolve the final merged options before any literal credential read. Call inside session.compact's try. */
export async function resolveRuntimeConfig($: HookKeySource, config: HookConfig): Promise<ResolvedHookConfig> {
  // The raw plugin boundary is intentionally unknown; the shared resolver validates every transport field.
  const endpoint = resolveJevEndpoint(config as JevProviderOptions);
  const apiKey = requireJevApiKey(endpoint, await getApiKey($, config, endpoint));
  const resolved = Object.freeze({ ...config, ...endpoint, allowThirdPartyEgress: config.allowThirdPartyEgress === true, apiKey });
  runtimeEndpoints.set(resolved, endpoint);
  return resolved;
}

function safeUi(action: () => void): void { try { action(); } catch { /* UI cannot choose a compaction route. */ } }

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
  toast = true,
): void {
  // The version goes last: jev-watch classifies the outcome by the text's start (`kept …`, `fallback to …`).
  const line = `${text} · ${VERSION}`;
  safeUi(() => $.ui.log(line));
  // A routine compaction is a transcript line only: a 15 s toast every half hour per session read as an alarm
  // (user 2026-10-03). The fallback and its failure still toast: they cost minutes, and Send now / Stop matter there.
  if (toast) safeUi(() => $.ui.toast(line, { timeoutMs: 15_000 }));
}

// ponytail: the hook context's type is not exported under a name here; only session.cwd/id and fs.write are used.
// Under `cache/`: backup and indexing setups usually exclude it (docs/security.md). A backup that keeps transcripts
// (`*.jsonl`) out on purpose must keep their saved outputs out too.
let lastExpiry = 0;

async function offloadTarget($: {
  session: { cwd: () => Promise<string>; id: () => Promise<string> };
  fs: {
    write: (path: string, text: string) => Promise<void>;
    list: (path?: string) => Promise<ReadonlyArray<{ name: string; kind: string; size: number }>>;
    stat: (path: string) => Promise<{ mtimeMs: number }>;
  };
}): Promise<{ dir: string; fs: OffloadFs } | undefined> {
  try {
    const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()]);
    const root = `${cwd.replace(/[\\/]+$/, '')}/.claude/fast-jev/cache`;
    const fs: OffloadFs = {
      write: (path: string, text: string) => $.fs.write(path, text),
      list: (path: string) => $.fs.list(path),
      stat: (path: string) => $.fs.stat(path),
    };
    if (Date.now() - lastExpiry > 24 * 60 * 60 * 1000) {
      lastExpiry = Date.now();
      await expireOutputs(root, fs, Date.now());
    }
    return { dir: `${root}/${id.replace(/[^\w.-]/g, '_')}`, fs };
  } catch {
    return undefined;
  }
}

/**
 * This plugin's options as settings.json `pluginConfigs["fast-jev-compaction@…"].options` holds them. The desktop host
 * (SDK) was seen handing the hook its defaults while settings said otherwise: turn.complete fired from ~595k of a 1M
 * window (60%, the default) in every desktop session with `compactAtPercent: 95` configured (2026-10-02).
 */
export function settingsOptions(settings: Readonly<Record<string, unknown>>): PluginOptions {
  const configs = settings['pluginConfigs'];
  const out: Record<string, string | number | boolean | readonly string[]> = {};
  if (!configs || typeof configs !== 'object') return out;
  for (const [key, value] of Object.entries(configs as Record<string, unknown>)) {
    if (key !== 'fast-jev-compaction' && !key.startsWith('fast-jev-compaction@')) continue;
    const options = (value as { options?: unknown } | null)?.options;
    if (options && typeof options === 'object') Object.assign(out, options);
  }
  return out;
}

/** The options in force: the host's, with settings.json's laid over them; a difference is logged once. */
async function readOptions(
  $: {
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
    ui: { log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void };
  },
  options: PluginOptions,
  configured: HookConfig,
): Promise<HookConfig> {
  let extra: PluginOptions;
  try {
    extra = settingsOptions(await $.settings.read());
  } catch {
    return configured;
  }
  if (Object.keys(extra).length === 0) return configured;
  const merged = resolveHookConfig({ ...options, ...extra });
  if (merged.compactAtPercent !== configured.compactAtPercent) {
    // Debug log only: a line in the transcript read as breakage; jev-watch still records it.
    safeUi(() => $.ui.log(`options: compactAtPercent ${merged.compactAtPercent} from settings.json (the host passed ${configured.compactAtPercent}) · ${VERSION}`, {
      to: 'debug',
    }));
  }
  return merged;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fillText(usage: WindowUsage | undefined): string {
  return usage?.tokens && usage.window ? `context ${usage.tokens}/${usage.window} tokens` : 'context fill unknown';
}

/** Optional compactor injection is only for offline lifecycle fixtures; hosts call the original two-argument register. */
export const register = (on: On, options: PluginOptions, compactor: typeof compactSession = compactSession): void => {
  const rawOptions = Object.freeze({ ...options });
  const configured = resolveHookConfig(rawOptions);
  let compacting = false;
  // Set once $.session.compact said the host has no between-turn compaction (SDK / desktop): the engine's own
  // threshold compacts there, and asking again every turn only filled the transcript (300+ lines in 10 sessions).
  let compactUnavailable = false;
  // The smallest main-loop context seen in this session: an upper bound on system prompt + tools (see pressure()).
  let lowest: number | undefined;
  const seen = (tokens: number | undefined) => {
    if (tokens && tokens > 0) lowest = Math.min(lowest ?? tokens, tokens);
  };

  // The options in force, read once per registration (readOptions).
  let effective: Promise<HookConfig> | undefined;

  on('session.compact', async ($, event, next) => {
    // The plugin's own compaction when it fell short of the gate: installed if the built-in summary then fails, so a
    // summary aborted by Send now / Stop (or erroring) never leaves the session over the limit.
    let own: SessionMessage[] | undefined;
    let candidate: CompactResult | undefined;
    let needed: Pressure = { minReduction: RAIL_FLOOR, gate: configured.minReductionRatio };
    let settings = configured, usage: WindowUsage | undefined, before: MeasureResult | undefined, identity: AuditIdentity | undefined;
    let finalized = false, auditKnown: readonly string[] = [], round: RoundObservation | undefined, freshCandidates = 0;
    let errorCode: AuditErrorCode = 'none';
    const emit: AuditSink = async (event: AuditEvent) => {
      let status: Awaited<ReturnType<AuditSink>>;
      try {
        const argv = auditArgv(settings.auditNodePath, settings.auditLauncherPath, $.plugin.root);
        if (!argv) status = { status: 'audit_unavailable' };
        else {
          const ack = await $.process.run(argv, { stdin: serializeAuditEvent(event), timeoutMs: 1500 });
          status = parseAuditAck(ack.stdout, ack.exitCode);
        }
      } catch { status = { status: 'audit_unavailable' }; }
      if (status.status !== 'written' && status.status !== 'duplicate') safeUi(() => $.ui.log(`audit_status=${status.status}`, { to: 'debug' }));
      return status;
    };
    const begin = async (known: readonly string[] = []) => {
      if (!settings.auditLog || identity) return;
      try {
        auditKnown = known;
        const started = await $.clock.now();
        let session: string | null = null;
        try { const id = await $.session.id(); session = event.agentId ? `${id}:${event.agentId}` : id; } catch { /* Identity can be unavailable. */ }
        before = measureTranscript(event.messages);
        const record = buildAuditEvent({ schema: 1, kind: 'begin', plugin: 'fast-jev-compaction', plugin_version: VERSION,
          attempt_id: crypto.randomUUID(), session_id: session, trigger: event.trigger, started_at_ms: started,
          before, estimator_id: ESTIMATOR_ID, projection_id: PROJECTION_ID }, known);
        if (record.kind !== 'begin') return;
        const { schema, plugin, plugin_version, attempt_id, session_id, trigger, started_at_ms } = record;
        identity = { schema, plugin, plugin_version, attempt_id, session_id, trigger, started_at_ms };
        freshCandidates = provenanceBefore(event.messages, settings).candidates;
        await emit(record);
      } catch { safeUi(() => $.ui.log('audit_status=audit_unavailable', { to: 'debug' })); }
    };
    const finish = async (outcome: AuditOutcome, messages: readonly SessionMessage[] | null,
      core?: { tokensBefore?: number; tokensAfter?: number }) => {
      if (!settings.auditLog || finalized) return;
      finalized = true;
      if (!identity || !before) return;
      try {
        const finished = Math.max(identity.started_at_ms, await $.clock.now());
        const counts = candidate?.stats.jev;
        const observedRound: RoundObservation = round ?? {
          completion: candidate ? counts?.completion ?? 'complete' : 'failed', terminal_code: counts?.terminalCode ?? 'none',
          requests_planned: candidate?.stats.requests ?? null, attempts: counts?.attempts ?? 0, retries: counts?.retries ?? 0,
          parsed: counts?.parsed ?? 0, scored_calls: counts?.scoredCalls ?? 0, unscored_calls: counts?.unscoredCalls ?? 0,
          fresh: counts?.scoredCalls ?? 0, cache: 0, floor: 0, reduced: 0, pinned: candidate?.stats.pinned ?? 0,
          request_estimated_max: null, actual_input_tokens: null, actual_output_tokens: null, usage_responses: 0,
        };
        const gate = classifyGate({ freshCandidates, reduction: candidate ? reductionRatio(candidate) : 0, gate: needed.gate,
          hasUsage: typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens) && typeof usage.window === 'number' && usage.window > 0,
          error: errorCode !== 'none' && errorCode !== 'summary_error' });
        await emit(buildAuditEvent({ ...identity, kind: 'final', finished_at_ms: finished, duration_ms: finished - identity.started_at_ms,
          ...gate, outcome, error_code: errorCode, estimates: finalizeMeasurements(before, messages === null ? null : measureTranscript(messages)),
          round: observedRound, observed: observedCounters(normalizeObserved({ usage, core })), host_applied: null }, auditKnown));
      } catch { safeUi(() => $.ui.log('audit_status=audit_unavailable', { to: 'debug' })); }
    };
    // A fallback still keeps every output: saved to files, and the summarizer is told where they are.
    const fallback = async (reason: string, settings: HookConfig) => {
      notify($, `fallback to built-in summary (${reason}); it takes 1–3 min, Send now or Stop aborts it`);
      const target = settings.saveFullOutputs ? await offloadTarget($) : undefined;
      const note = target ? await saveForSummary(event.messages, target.dir, target.fs) : undefined;
      try {
        const returned = await next(note ? { ...event, instructions: [event.instructions, note].filter(Boolean).join('\n\n') } : event);
        await finish(returned.messages ? 'summary_returned' : 'summary_skip_returned', returned.messages ?? event.messages,
          returned.messages ? returned : undefined);
        return returned;
      } catch (error) {
        errorCode = 'summary_error';
        if (!own || finalCompactionOutcome(candidate, needed, 'failed').outcome !== 'own-returned') {
          await finish('error_raised', null); throw error;
        }
        notify($, `kept ${own.length}/${event.messages.length} messages after the built-in summary failed (${errorText(error)})`);
        await finish('own_returned_after_summary_error', own);
        return { messages: own };
      }
    };
    try {
      settings = await (effective ??= readOptions($, rawOptions, configured));
      const config = await resolveRuntimeConfig($, {
        ...settings,
        deadlineSleep: (ms: number, options: { signal: AbortSignal }) => $.clock.sleep(ms, options),
        retrySleep: (ms: number, options: { signal: AbortSignal }) => $.clock.sleep(ms, options),
        nowMs: () => $.clock.now(),
        ...(settings.auditLog ? { observeRound: (value: RoundObservation) => { round = value; } } : {}),
      });
      await begin([...(config.secrets ?? []), config.apiKey]);
      usage = await $.session.usage().then(
        (u) => u.context,
        () => undefined,
      );
      needed = pressure(usage, transcriptTokens(event.messages), config, lowest);
      const { result, messages } = await compactor(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
        },
        needed.minReduction,
        config.saveFullOutputs ? await offloadTarget($) : undefined,
      );
      candidate = result;
      // Per-call decisions are diagnosis, not news: debug log (and jev-watch), never the transcript.
      for (const line of decisionLogLines(result)) safeUi(() => $.ui.log(line, { to: 'debug' }));
      if (finalCompactionOutcome(result, needed, 'not-called').outcome === 'failure') {
        if (reductionRatio(result) > 0) own = messages;
        // `return` without `await`: a failing fallback must not land in the catch below and run the summary twice.
        return fallback(
          `below the ${percent(needed.gate)} this window needs: ${summarize(result)}; ${fillText(usage)}, compactAtPercent ${settings.compactAtPercent}`,
          settings,
        );
      }
      notify(
        $,
        // fill and the pair in force: what a held-out check attributes the event to (track autocompact-threshold)
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)}; ${fillText(usage)}, compactAtPercent ${settings.compactAtPercent})`,
        false,
      );
      if (settings.auditLog) {
        try {
          const outcome: AuditOutcome = (round?.fresh ?? result.stats.jev?.scoredCalls ?? 0) > 0 ? 'jev_returned' :
            canonicalContentChanged(event.messages, messages) ? 'local_returned' : 'original_returned';
          await finish(outcome, messages);
        } catch { safeUi(() => $.ui.log('audit_status=audit_unavailable', { to: 'debug' })); }
      }
      return { messages };
    } catch (error) {
      errorCode = error instanceof JevConfigError ? error.kind === 'api_key' ? 'missing_key' : error.kind === 'url' ? 'invalid_endpoint' : 'contract' :
        error instanceof JevRoundError ? error.code : 'unknown';
      await begin([...(settings.secrets ?? []), ...(typeof settings.apiKey === 'string' ? [settings.apiKey] : [])]);
      return fallback(errorText(error), settings);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // A subagent's turn ends while the main turn still runs: compacting there only fails with "a turn is running"
    // (79 transcript lines by 2026-10-02). Checked before any await, so parallel subagents cannot race past it.
    if (event.agentId || compacting || compactUnavailable) return next(event);
    let fill: WindowUsage | undefined;
    let threshold = configured.compactAtPercent;
    let settings = configured, autoIdentity: AuditIdentity | undefined;
    let requestOutcome: 'requested' | 'not_available' | 'error' = 'error';
    try {
      settings = await (effective ??= readOptions($, rawOptions, configured));
      threshold = settings.compactAtPercent;
      const { context } = await $.session.usage();
      fill = context;
      seen(context.tokens ?? undefined);
      if ((context.percent ?? 0) < threshold) return next(event);
      compacting = true;
      if (settings.auditLog) {
        try {
          const id = await $.session.id();
          const raw = buildAuditEvent({ schema: 1, kind: 'auto_request', plugin: 'fast-jev-compaction', plugin_version: VERSION,
            attempt_id: crypto.randomUUID(), session_id: id, trigger: 'plugin', started_at_ms: await $.clock.now(),
            request_outcome: 'requested', error_code: 'none' }, typeof settings.apiKey === 'string' ? [settings.apiKey] : []);
          const { schema, plugin, plugin_version, attempt_id, session_id, trigger, started_at_ms } = raw;
          autoIdentity = { schema, plugin, plugin_version, attempt_id, session_id, trigger, started_at_ms };
        } catch { safeUi(() => $.ui.log('audit_status=audit_unavailable', { to: 'debug' })); }
      }
      await $.session.compact();
      requestOutcome = 'requested';
    } catch (error) {
      const text = errorText(error);
      compactUnavailable = /not available/.test(text);
      requestOutcome = compactUnavailable ? 'not_available' : 'error';
      // The headless refusal is expected there, so it goes to the debug log (and jev-watch), not the transcript.
      if (compactUnavailable) {
        safeUi(() => $.ui.log(
          `auto-compact skipped (${text}); not asked again this session: the engine's threshold compacts here (${fillText(fill)}, compactAtPercent ${threshold}) · ${VERSION}`,
          { to: 'debug' },
        ));
      } else {
        safeUi(() => $.ui.log(`auto-compact skipped (${text})`, { to: 'debug' }));
      }
    } finally {
      compacting = false;
    }
    if (autoIdentity) {
      try {
        const argv = auditArgv(settings.auditNodePath, settings.auditLauncherPath, $.plugin.root);
        const record = buildAuditEvent({ ...autoIdentity, kind: 'auto_request', request_outcome: requestOutcome, error_code: requestOutcome === 'requested' ? 'none' : 'unknown' });
        const ack = argv ? await $.process.run(argv, { stdin: serializeAuditEvent(record), timeoutMs: 1500 }) : undefined;
        const status = ack ? parseAuditAck(ack.stdout, ack.exitCode).status : 'audit_unavailable';
        if (status !== 'written' && status !== 'duplicate') safeUi(() => $.ui.log(`audit_status=${status}`, { to: 'debug' }));
      } catch { safeUi(() => $.ui.log('audit_status=audit_unavailable', { to: 'debug' })); }
    }
    return next(event);
  });
};

export { resolveOptions };
