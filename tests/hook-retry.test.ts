import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compactSession, decisionLog, finalCompactionOutcome, forgetAnswers, jevAsker, register, resolveHookConfig, summarize, toSessionMessages,
} from '../hooks/fast-jev.ts';
import type { HookFetch, HookFetchInit } from '../hooks/fast-jev.ts';
import type { CallAnswer, CompactResult, JevResponse, Message } from '../src/index.js';

const seam = vi.hoisted(() => ({ reduction: undefined as number | undefined, results: [] as CompactResult[] }));
vi.mock('../src/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compact.js')>();
  return { ...actual, compact: async (...args: Parameters<typeof actual.compact>) => {
    const result = await actual.compact(...args);
    const projected = seam.reduction === undefined ? result : { ...result, stats: { ...result.stats, charsBefore: 100, charsAfter: 100 * (1 - seam.reduction) } };
    seam.results.push(projected); return projected;
  } };
});

const H: Message[] = [
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r2', tool: 'Read', input: { file_path: 'b.txt' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r2', text: 'y'.repeat(5000) }] },
  { role: 'assistant', text: 'done', toolUses: [] },
  { role: 'user', text: 'next', toolUses: [] },
];
const H1 = H.filter((_message, i) => i !== 3 && i !== 4);
const V1: JevResponse = { answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } };
const SUMMARY: Message[] = [{ role: 'user', text: 'SUMMARY', toolUses: [] }];
const pressureStub = () => ({ minReduction: 0, gate: 0.25 });

async function flush(): Promise<void> { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function sleep(ms: number, { signal }: { signal: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
type Handler = (...args: unknown[]) => Promise<{ messages: Message[] }>;
function load() {
  const handlers = new Map<string, Handler>();
  register(((name: string, handler: Handler) => handlers.set(name, handler)) as never, {
    apiKey: 'fixture', preserveRecentMessages: 1, saveFullOutputs: false, compactionTimeoutMs: 10000, minReductionRatio: 0.25,
  });
  return handlers.get('session.compact')!;
}
function host(fetch: HookFetch) {
  const logs: string[] = [];
  const write = vi.fn(async (_path: string, _text: string) => {});
  const clock = { now: vi.fn(async () => Date.now()), sleep: vi.fn(sleep) };
  const $ = {
    settings: { read: async () => ({}) }, env: { get: async () => undefined },
    ui: { log: (line: string) => { logs.push(line); }, toast: () => {} },
    session: { usage: async () => ({ context: {} }) }, http: { fetch }, clock, fs: { write },
  };
  return { $, clock, logs, write };
}
const partialFetch: HookFetch = async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: { ...V1.answers, call_t2: { noul: 0.7 } } }) });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); forgetAnswers(); seam.reduction = undefined; seam.results = []; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('R2 hook table', () => {
  it('preserves Retry-After headers through the host bridge', async () => {
    const requests: { url: string; init?: HookFetchInit }[] = [];
    const h = host(async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1 ? { status: 429, ok: false, headers: { 'retry-after': '2' }, text: 'unavailable' } : { status: 200, ok: true, headers: {}, text: JSON.stringify(V1) };
    });
    const next = vi.fn(async () => ({ messages: SUMMARY }));
    const pending = load()(h.$, { trigger: 'manual', messages: H1 }, next);
    await flush();
    expect(h.clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([10000, 2000]);
    const roundSignal = h.clock.sleep.mock.calls[1]![1].signal;
    expect(roundSignal).toBeInstanceOf(AbortSignal); expect(roundSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); await pending;
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]!.init).not.toHaveProperty('signal'); expect(JSON.parse(requests[0]!.init!.body!).model).toBe('jev-latest');
    expect(seam.results[0]!.stats.jev).toMatchObject({ attempts: 2, retries: 1, completion: 'complete' });
    expect(h.clock.now).toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  });
  it('returns the successful summary once when a partial result misses the gate', async () => {
    seam.reduction = 0.20;
    const needed = vi.fn(pressureStub)(), h = host(partialFetch), next = vi.fn(async () => ({ messages: SUMMARY }));
    const returned = await load()(h.$, { trigger: 'manual', messages: H }, next);
    expect(next).toHaveBeenCalledOnce(); expect(returned.messages).toBe(SUMMARY);
    expect(finalCompactionOutcome(seam.results[0], needed, 'returned')).toEqual({ outcome: 'fallback-returned', host_applied: null });
    expect(h.write).not.toHaveBeenCalled();
  });
  it('returns its own partial result once when the summary fails below the gate', async () => {
    seam.reduction = 0.20;
    const needed = vi.fn(pressureStub)(), h = host(partialFetch), next = vi.fn(async () => { throw new Error('summary stopped'); });
    const returned = await load()(h.$, { trigger: 'manual', messages: H }, next);
    expect(next).toHaveBeenCalledOnce(); expect(returned.messages[3]).toBe(H[3]); expect(returned.messages[4]).toBe(H[4]);
    expect(returned.messages).toEqual(toSessionMessages(H, seam.results[0]!.messages));
    expect(finalCompactionOutcome(seam.results[0], needed, 'failed')).toEqual({ outcome: 'own-returned', host_applied: null });
    expect(h.write).not.toHaveBeenCalled();
  });
  it('returns a partial result once without summary when the gate is passed', async () => {
    seam.reduction = 0.30;
    const needed = vi.fn(pressureStub)(), h = host(partialFetch), next = vi.fn(async () => ({ messages: SUMMARY }));
    let returns = 0;
    const returned = await load()(h.$, { trigger: 'manual', messages: H }, next).then((value) => { returns++; return value; });
    expect(next).not.toHaveBeenCalled(); expect(returns).toBe(1); expect(returned.messages).toEqual(toSessionMessages(H, seam.results[0]!.messages));
    expect(finalCompactionOutcome(seam.results[0], needed, 'not-called')).toEqual({ outcome: 'partial-returned', host_applied: null });
    expect(returned.messages[4]).toBe(H[4]);
  });
  it('logs unscored calls without fake probability scores', async () => {
    const { result } = await compactSession(H, resolveHookConfig({ apiKey: 'fixture', preserveRecentMessages: 1 }), partialFetch, 0);
    const unscored = result.decisions.find((decision) => decision.id === 't2')!;
    expect(unscored).toMatchObject({ reason: 'unscored', keepCall: 1, keepResult: 1 });
    const log = decisionLog({ ...result, decisions: [unscored] });
    expect(log).toContain('t2:Read:keep/unscored'); expect(log).not.toContain('call=1.00'); expect(log).not.toContain('result=1.00');
    expect(summarize(result)).toContain('1 unscored'); expect(summarize(result)).toContain('1 attempt(s)');
  });
});

describe('R2 hook controls', () => {
  it('resolves and validates retry options at the hook boundary', () => {
    expect(resolveHookConfig({})).toMatchObject({ maxJevAttempts: 3, maxConcurrentJevRequests: 4, partialAnswers: 'retain-unscored' });
    expect(resolveHookConfig({ maxJevAttempts: 1, maxConcurrentJevRequests: 8, partialAnswers: 'rollback' })).toMatchObject({ maxJevAttempts: 1, maxConcurrentJevRequests: 8, partialAnswers: 'rollback' });
    for (const options of [{ maxJevAttempts: 0 }, { maxJevAttempts: '3' }, { maxConcurrentJevRequests: 1.5 }, { partialAnswers: 'unknown' }]) expect(() => resolveHookConfig(options)).toThrow(RangeError);
  });
  it('does not infer host network failures from their messages', async () => {
    const fetch = vi.fn<HookFetch>(async () => { throw new Error('network (503)'); });
    const h = host(fetch), next = vi.fn(async () => ({ messages: SUMMARY }));
    const result = await load()(h.$, { trigger: 'auto', messages: H1 }, next);
    expect(fetch).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(result.messages).toBe(SUMMARY);
    expect(h.clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([10000]);
    expect(h.logs.join('\n')).not.toContain('network (503)');
  });
  it('checks the round signal before and after buffered host HTTP', async () => {
    const controller = new AbortController(), fetch = vi.fn<HookFetch>();
    controller.abort(new Error('cancelled'));
    await expect(jevAsker(fetch, 'fixture', 'jev-latest').ask({}, {}, controller.signal)).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
    const second = new AbortController();
    fetch.mockImplementation(async () => { second.abort(new Error('closed')); return { status: 200, ok: true, text: '{' }; });
    await expect(jevAsker(fetch, 'fixture', 'jev-latest').ask({}, {}, second.signal)).rejects.toThrow('closed');
  });
  it('suppresses late invalid host callbacks without cache, offload or second return', async () => {
    const fetch = vi.fn<HookFetch>(); let late!: (response: Awaited<ReturnType<HookFetch>>) => void;
    fetch.mockImplementation(() => new Promise((resolve) => { late = resolve; }));
    const h = host(fetch), next = vi.fn(async () => ({ messages: SUMMARY })); let returns = 0;
    const pending = load()(h.$, { trigger: 'manual', messages: H1 }, next).then((value) => { returns++; return value; });
    await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).messages).toBe(SUMMARY); expect(returns).toBe(1); expect(next).toHaveBeenCalledOnce();
    late({ status: 200, ok: true, text: '{' }); await flush(); await vi.advanceTimersByTimeAsync(0);
    expect(returns).toBe(1); expect(next).toHaveBeenCalledOnce(); expect(h.write).not.toHaveBeenCalled();
    const retry = vi.fn<HookFetch>(async () => ({ status: 200, ok: true, text: JSON.stringify(V1) }));
    await compactSession(H1, resolveHookConfig({ apiKey: 'fixture', preserveRecentMessages: 1 }), retry, 0);
    expect(retry).toHaveBeenCalledOnce();
  });
  it('keeps the outcome adapter pure and reports no inferred host application', () => {
    expect(finalCompactionOutcome(undefined, pressureStub(), 'returned')).toEqual({ outcome: 'fallback-returned', host_applied: null });
    expect(finalCompactionOutcome(undefined, pressureStub(), 'failed')).toEqual({ outcome: 'failure', host_applied: null });
    const cache = new Map<string, CallAnswer>();
    expect(cache.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
