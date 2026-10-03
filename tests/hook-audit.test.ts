import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactSession, forgetAnswers, register, resolveHookConfig, VERSION } from '../hooks/fast-jev.ts';
import type { CompactResult, Message } from '../src/types.js';
import { finalizeMetrics } from '../src/audit.js';

const seam = { fake: true };
const fakeCompaction: typeof compactSession = async () => {
    const messages = P('1234');
    const result = { messages, decisions: [], stats: { messagesBefore: 3, messagesAfter: 3, charsBefore: 11, charsAfter: 7,
      calls: 1, kept: 0, resultsDropped: 1, callsDropped: 0, pinned: 0, stateTokens: 1, stateStage: 'full', requests: 1, ms: 0,
      jev: { completion: 'complete', terminalCode: 'none', attempts: 1, retries: 0, parsed: 1, scoredCalls: 1, unscoredCalls: 0 } } } satisfies CompactResult;
    return { result, messages };
};
function P(text: string): Message[] {
  return [{ role: 'user', text: 's', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Read', input: {}, text }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text }] }];
}
function H(route = 'compact_success', options: Record<string, unknown> = {}) {
  const records: Record<string, any>[] = [];
  const logs: string[] = [];
  const run = vi.fn(async (_argv: readonly string[], init: { stdin: string }) => {
    records.push(JSON.parse(init.stdin));
    return { exitCode: 0, stdout: '{"status":"written"}', stderr: '' };
  });
  const write = vi.fn(async (_path: string, _text: string) => {});
  const $ = {
    plugin: { root: 'C:/ops/fjc-wt-r1-audit' },
    process: { run }, fs: { write }, settings: { read: async () => ({}) }, env: { get: async () => undefined },
    session: { id: async () => 'session-fixture', usage: async () => ({ context: { window: 100 } }) },
    clock: { now: async () => 1000, sleep: async (ms: number, { signal }: { signal: AbortSignal }) => {
      if (ms === 1000) return;
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    ui: { log: (line: string) => { logs.push(line); }, toast: (_line: string) => {} },
    http: { fetch: vi.fn(async () => { throw new Error('unexpected fetch'); }) },
  };
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  register(((name: string, handler: (...args: unknown[]) => Promise<any>) => handlers.set(name, handler)) as never, {
    apiKey: route === 'missing_key_no_own' ? '' : 'fixture', auditLog: true,
    auditNodePath: process.execPath, auditLauncherPath: 'C:/Users/test/nowin.exe',
    preserveRecentMessages: 0, saveFullOutputs: false, minReductionRatio: route === 'below_gate' ? 0.5 : 0.25, ...options,
  } as never, seam.fake ? fakeCompaction : compactSession);
  const next = vi.fn(async (): Promise<any> => ({ messages: P('12') }));
  const invoke = () => handlers.get('session.compact')!($, { trigger: 'manual', messages: P('12345678') }, next);
  const final = () => records.find((r) => r.kind === 'final')!;
  const expectFinal = () => ({ outcome: final().outcome, tokens_before: final().estimates.tokens_before,
    tokens_after: final().estimates.tokens_after, host_applied: final().host_applied });
  return { $, records, logs, run, write, next, invoke, final, expectFinal, handlers };
}
beforeEach(() => {
  forgetAnswers(); seam.fake = true;
  let id = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, '0')}` });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('observational audit lifecycle table', () => {
  it('fresh returned is not applied', async () => {
    const h = H(); await h.invoke();
    expect(h.expectFinal()).toEqual({ outcome: 'jev_returned', tokens_before: 7, tokens_after: 5, host_applied: null });
    expect(h.next).not.toHaveBeenCalled(); expect(h.records.map((r) => r.kind)).toEqual(['begin', 'final']);
  });
  it('summary resolved messages', async () => {
    const h = H('below_gate'); await h.invoke();
    expect(h.expectFinal()).toEqual({ outcome: 'summary_returned', tokens_before: 7, tokens_after: 4, host_applied: null });
    expect(h.next).toHaveBeenCalledOnce();
  });
  it('summary actually skipped', async () => {
    const h = H('below_gate'); h.next.mockResolvedValue({ skip: 'fixture' }); await h.invoke();
    expect(h.expectFinal()).toEqual({ outcome: 'summary_skip_returned', tokens_before: 7, tokens_after: 7, host_applied: null });
    expect(h.next).toHaveBeenCalledOnce(); expect(JSON.stringify(h.records)).not.toContain('skip":"fixture');
  });
  it('summary failure returns own', async () => {
    const h = H('below_gate'); h.next.mockRejectedValue(new Error('fixture')); await h.invoke();
    expect(h.expectFinal()).toEqual({ outcome: 'own_returned_after_summary_error', tokens_before: 7, tokens_after: 5, host_applied: null });
    expect(h.next).toHaveBeenCalledOnce();
  });
  it('summary failure without own', async () => {
    const h = H('missing_key_no_own'), error = new Error('fixture'); h.next.mockRejectedValue(error);
    await expect(h.invoke()).rejects.toBe(error);
    expect(h.expectFinal()).toEqual({ outcome: 'error_raised', tokens_before: 7, tokens_after: null, host_applied: null });
    expect(h.next).toHaveBeenCalledOnce();
  });
  it('UI failure is not fallback', async () => {
    const h = H(); h.$.ui.log = h.$.ui.toast = () => { throw new Error('fixture'); }; await h.invoke();
    expect(h.final().outcome).toBe('jev_returned'); expect(h.next).not.toHaveBeenCalled();
    expect(h.records.filter((r) => r.kind === 'final')).toHaveLength(1);
  });
  it('audit failure is not fallback', async () => {
    const h = H(); h.run.mockImplementation(async (_argv, init) => {
      h.records.push(JSON.parse(init.stdin)); return { exitCode: 1, stdout: '{"status":"audit_io"}', stderr: '' };
    });
    expect((await h.invoke()).messages).toEqual(P('1234')); expect(h.next).not.toHaveBeenCalled();
    expect(h.final().outcome).toBe('jev_returned');
    expect(h.logs.join('\n')).toContain('audit_io');
  });
  it('cache is not fresh answers', async () => {
    seam.fake = false;
    const h = H('compact_success', { minReductionRatio: 0 });
    h.$.http.fetch.mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0.9 } } }) } as never);
    await h.invoke(); h.records.length = 0; h.$.http.fetch.mockClear(); await h.invoke();
    const { fresh, cache, attempts, parsed } = h.final().round;
    expect({ fresh, cache, attempts, parsed }).toEqual({ fresh: 0, cache: 1, attempts: 0, parsed: 0 });
    expect(h.$.http.fetch).not.toHaveBeenCalled();
  });
  it('partial provenance r2', async () => {
    seam.fake = false;
    const h = H('compact_success', { minReductionRatio: 0 });
    const messages = [...P('12345678'), ...P('87654321').slice(1).map((m) => ({ ...m,
      toolUses: m.toolUses.map((u) => ({ ...u, tool_use_id: 'v' })),
      ...(m.toolResults ? { toolResults: m.toolResults.map((r) => ({ ...r, tool_use_id: 'v' })) } : {}) }))];
    h.$.http.fetch.mockResolvedValueOnce({ status: 429, ok: false, text: '' } as never)
      .mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0.9 }, call_t2: { noul: 0.9 } } }) } as never);
    await h.handlers.get('session.compact')!(h.$, { trigger: 'manual', messages }, h.next);
    const { completion, fresh, unscored_calls, cache, attempts, parsed } = h.final().round;
    expect({ completion, fresh, unscored_calls, cache }).toEqual({ completion: 'partial', fresh: 1, unscored_calls: 1, cache: 0 });
    expect({ attempts, parsed }).toEqual({ attempts: 2, parsed: 1 });
    h.$.http.fetch.mockClear();
    h.$.http.fetch.mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t2: { noul: 0.9 }, result_t2: { noul: 0.9 } } }) } as never);
    await compactSession(messages as never, resolveHookConfig({ apiKey: 'fixture', preserveRecentMessages: 0 }), h.$.http.fetch, 0);
    expect(Object.keys(JSON.parse(h.$.http.fetch.mock.calls[0]![1]!.body!).questions)).toEqual(['call_t2', 'result_t2']);
  });
  it('disabled audit has no I/O', async () => {
    const h = H('compact_success', { auditLog: false });
    expect((await h.invoke()).messages).toEqual(P('1234')); expect(h.run).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it('no native capability is not read modify write', async () => {
    const h = H(); h.run.mockRejectedValue(new Error('unavailable'));
    await h.invoke(); expect(h.logs.join('\n')).toContain('audit_unavailable'); expect(h.write).not.toHaveBeenCalled(); expect(h.next).not.toHaveBeenCalled();
  });
});

describe('audit route and configuration controls', () => {
  it('uses literal process argv with bounded stdin and timeout', async () => {
    const h = H(); await h.invoke();
    expect(h.run.mock.calls[0]![0]).toEqual(['C:/Users/test/nowin.exe', process.execPath, 'C:/ops/fjc-wt-r1-audit/scripts/audit-writer.mjs', '--append']);
    expect(h.run.mock.calls[0]![1]).toMatchObject({ timeoutMs: 1500 });
    expect(h.records[0]!.plugin_version).toBe(VERSION);
  });
  it('never launches an unconfigured or relative runtime', async () => {
    for (const options of [{ auditNodePath: '' }, { auditNodePath: 'node' }, { auditLauncherPath: '' }, { auditNodePath: '\\\\server\\node.exe' }]) {
      const h = H('compact_success', options); await h.invoke(); expect(h.run).not.toHaveBeenCalled(); expect(h.next).not.toHaveBeenCalled();
      expect(h.logs.join('\n')).toContain('audit_unavailable');
    }
  });
  it('summary core counters do not enter estimated ratios', async () => {
    const h = H('below_gate'); h.next.mockResolvedValue({ messages: P('12'), tokensBefore: 999, tokensAfter: 0 }); await h.invoke();
    expect(h.final().observed.core_tokens_after).toEqual({ value: 0, source: 'next' }); expect(h.final().estimates.tokens_after).toBe(4);
  });
  it('precompute and subagent identity remain scoped', async () => {
    const h = H(); await h.handlers.get('session.compact')!(h.$, { trigger: 'precompute', agentId: 'sub-1', messages: P('12345678') }, h.next);
    expect(h.final()).toMatchObject({ trigger: 'precompute', session_id: 'session-fixture:sub-1', host_applied: null });
  });
  it('auto requests use a separate DTO and retain the refusal guard', async () => {
    const h = H(); h.$.session.usage = async () => ({ context: { tokens: 99, window: 100, percent: 99 } });
    Object.assign(h.$.session, { compact: vi.fn(async () => { throw new Error('not available'); }) });
    await h.handlers.get('turn.complete')!(h.$, {}, h.next); await h.handlers.get('turn.complete')!(h.$, {}, h.next);
    expect(h.records.map((r) => r.kind)).toEqual(['auto_request']);
    expect(h.records[0]!.request_outcome).toBe('not_available');
  });
  it('offload success measures the actual mapped pointer snapshot', async () => {
    seam.fake = false;
    const h = H('compact_success', { saveFullOutputs: true, minReductionRatio: 0 });
    const messages = P('observation line\n'.repeat(1000)); messages[1]!.toolUses[0]!.tool = 'Bash';
    Object.assign(h.$.session, { cwd: async () => 'C:/fixture' });
    Object.assign(h.$.fs, { list: async () => [], stat: async () => ({ mtimeMs: 0 }) });
    h.$.http.fetch.mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } }) } as never);
    const returned = await h.handlers.get('session.compact')!(h.$, { trigger: 'manual', messages }, h.next);
    expect(returned.messages[2].toolResults[0].text).toContain('the full output is saved at C:/fixture/');
    expect(h.final().estimates).toEqual(finalizeMetrics(messages, returned.messages));
    expect(h.next).not.toHaveBeenCalled();
  });
  it('offload failure measures the actual retained transcript note', async () => {
    seam.fake = false;
    const h = H('compact_success', { saveFullOutputs: true, minReductionRatio: 0 });
    const messages = P('observation line\n'.repeat(1000)); messages[1]!.toolUses[0]!.tool = 'Bash';
    Object.assign(h.$.session, { cwd: async () => 'C:/fixture' });
    Object.assign(h.$.fs, { list: async () => [], stat: async () => ({ mtimeMs: 0 }) });
    h.write.mockRejectedValue(new Error('private disk error'));
    h.$.http.fetch.mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.1 }, result_t1: { noul: 0.1 } } }) } as never);
    const returned = await h.handlers.get('session.compact')!(h.$, { trigger: 'manual', messages }, h.next);
    expect(returned.messages[2].toolResults[0].text).not.toContain('the full output is saved at');
    expect(h.final().estimates).toEqual(finalizeMetrics(messages, returned.messages));
    expect(JSON.stringify(h.records)).not.toContain('private disk error'); expect(h.next).not.toHaveBeenCalled();
  });
  it('zero response usage is present and missing usage remains null', async () => {
    seam.fake = false;
    for (const usage of [{ input_tokens: 0, output_tokens: 0 }, undefined]) {
      forgetAnswers();
      const h = H('compact_success', { minReductionRatio: 0 });
      h.$.http.fetch.mockResolvedValue({ status: 200, ok: true, text: JSON.stringify({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0.9 } }, usage }) } as never);
      await h.invoke();
      expect(h.final().round).toMatchObject({ actual_input_tokens: usage ? 0 : null, actual_output_tokens: usage ? 0 : null, usage_responses: usage ? 1 : 0 });
      expect(h.final().round.request_estimated_max).toBeGreaterThan(0);
    }
  });
});
