import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactSession, forgetAnswers, register } from '../hooks/fast-jev.ts';
import type { HookFetch, HookFetchInit, SessionCompaction } from '../hooks/fast-jev.ts';
import { RAIL_FLOOR } from '../src/compact.js';
import type { Message } from '../src/types.js';

const TIMEOUT = 120_000;
const MESSAGES: Message[] = [
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Bash', input: { command: 'printf fixture' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
  { role: 'assistant', text: 'done', toolUses: [] },
  { role: 'user', text: 'next', toolUses: [] },
];
const SUMMARY: Message[] = [{ role: 'user', text: 'built-in summary', toolUses: [] }];

function success(init?: HookFetchInit, score = 0.1): Awaited<ReturnType<HookFetch>> {
  const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
  return {
    status: 200, ok: true,
    text: JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: score }])) }),
  };
}

function sleep(ms: number, { signal }: { signal: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

async function flush(): Promise<void> { for (let i = 0; i < 60; i++) await Promise.resolve(); }

type Handler = (...args: unknown[]) => Promise<{ messages: Message[] }>;
function host(fetch: HookFetch, remainingMs?: number) {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const compactions: SessionCompaction[] = [];
  const compactor = vi.fn<typeof compactSession>(async (...args) => {
    const result = await compactSession(...args);
    compactions.push(result);
    return result;
  });
  const $ = {
    settings: { read: async () => ({}) }, env: { get: async () => undefined },
    ui: { log: (line: string) => { logs.push(line); }, toast: () => {} },
    session: {
      usage: vi.fn(async () => ({ context: { tokens: 300_000, window: 1_000_000 } })),
      cwd: async () => 'C:/fixture', id: async () => 'budget-fixture',
    },
    clock: { now: vi.fn(async () => Date.now()), sleep: vi.fn(sleep) },
    fs: {
      write: vi.fn(async (path: string, text: string) => { files.set(path, text); }),
      list: async () => [], stat: async () => ({ mtimeMs: 0 }),
    },
    http: { fetch },
  };
  const handlers = new Map<string, Handler>();
  register(((name: string, handler: Handler) => handlers.set(name, handler)) as never, {
    apiKey: 'fixture', preserveRecentMessages: 1, compactionTimeoutMs: TIMEOUT,
  }, compactor);
  const next = Object.assign(vi.fn(async (_event: { messages: Message[]; instructions?: string }) => ({ messages: SUMMARY })),
    remainingMs === undefined ? {} : { budget: { remainingMs } });
  const invoke = (agentId?: string) => handlers.get('session.compact')!($, {
    trigger: 'manual', messages: MESSAGES, ...(agentId ? { agentId } : {}),
  }, next);
  // The deadline has its own signal and is not a retry sleep (architect's clarification).
  const retrySleeps = () => {
    const deadline = $.clock.sleep.mock.calls.find(([ms]) => ms === TIMEOUT);
    return $.clock.sleep.mock.calls.filter(([, options]) => options.signal !== deadline?.[1].signal);
  };
  return { $, next, invoke, logs, files, compactor, compactions, retrySleeps };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); forgetAnswers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('hook budget and scoped usage table', () => {
  it('retry sleep longer than the hook budget falls back through the hook', async () => {
    const fetch = vi.fn<HookFetch>(async () => ({ status: 429, ok: false, headers: { 'Retry-After': '8' }, text: 'unavailable' }));
    const h = host(fetch, 5000);
    const pending = h.invoke();
    await flush();
    expect(h.retrySleeps().filter(([ms]) => ms >= 3000)).toEqual([]);
    await expect(pending).resolves.toEqual({ messages: SUMMARY });
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.next.mock.calls[0]?.[0]).toMatchObject({
      instructions: expect.stringContaining('The full outputs of this session\'s tool calls are saved as files under'),
    });
    expect(h.files.get('C:/fixture/.claude/fast-jev/cache/budget-fixture/r1.txt')).toBe('x'.repeat(5000));
    expect(h.logs.some((line) => line.startsWith('fallback to built-in summary'))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retry sleep within the hook budget still retries', async () => {
    const fetch = vi.fn<HookFetch>()
      .mockResolvedValueOnce({ status: 429, ok: false, headers: { 'Retry-After': '1' }, text: 'unavailable' })
      .mockImplementation(async (_url, init) => success(init));
    const h = host(fetch, 60000);
    const pending = h.invoke();
    await flush();
    expect(h.retrySleeps().map(([ms]) => ms)).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toHaveProperty('messages');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.next).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatch(/^kept /);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('missing hook budget leaves retries as before', async () => {
    const fetch = vi.fn<HookFetch>()
      .mockResolvedValueOnce({ status: 429, ok: false, headers: { 'Retry-After': '1' }, text: 'unavailable' })
      .mockImplementation(async (_url, init) => success(init));
    const h = host(fetch);
    expect(h.next).not.toHaveProperty('budget');
    const pending = h.invoke();
    await flush();
    expect(h.retrySleeps().map(([ms]) => ms)).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.next).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatch(/^kept /);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('subagent compaction ignores main session usage', async () => {
    const fetch = vi.fn<HookFetch>(async (_url, init) => success(init, 0.9));
    const h = host(fetch);
    const returned = await h.invoke('a1');
    expect(h.$.session.usage).not.toHaveBeenCalled();
    expect(h.compactor.mock.calls[0]?.[3]).toBe(RAIL_FLOOR);
    expect(h.compactions[0]?.result.stats.charsAfter).toBe(h.compactions[0]?.result.stats.charsBefore);
    expect(h.next).toHaveBeenCalledOnce();
    expect(returned.messages).toBe(SUMMARY);
    expect(h.logs.some((line) => line.startsWith('fallback to built-in summary (below the 25%'))).toBe(true);
    expect(h.logs.some((line) => line.includes('0% reduction'))).toBe(true);
    expect(h.logs.some((line) => line.startsWith('kept '))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('main compaction still reads session usage', async () => {
    const fetch = vi.fn<HookFetch>(async (_url, init) => success(init, 0.9));
    const h = host(fetch);
    await h.invoke();
    expect(h.$.session.usage).toHaveBeenCalledOnce();
    expect(h.next).not.toHaveBeenCalled();
    expect(h.logs.at(-1)).toMatch(/^kept /);
    expect(vi.getTimerCount()).toBe(0);
  });
});
