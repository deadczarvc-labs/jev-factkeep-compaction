import { beforeEach, describe, expect, it } from 'vitest';
import {
  compactSession,
  forgetAnswers,
  offloadOutputs,
  VERSION,
  expireOutputs,
  saveForSummary,
  pressure,
  register,
  settingsOptions,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, fullOutputNote, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest', saveFullOutputs: true });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      saveFullOutputs: true,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300, false));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300, false));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  beforeEach(() => forgetAnswers());

  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    // Fork: the dropped call t1 stays as a rebuilt fact stub (no handle) instead of disappearing.
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(messages[2]?.toolResults?.[0]?.text).toMatch(/fast-jev-compaction omitted \d+ chars/);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('remembered answers', () => {
  beforeEach(() => forgetAnswers());

  it('does not ask Jev again about calls it already answered for this session', async () => {
    const messages = [
      { role: 'user', text: 'fix the build', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'k1', tool: 'Bash', input: { command: 'npm test' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'k1', text: 'FAIL a.test.ts\n' + 'x'.repeat(9000) }] },
      { role: 'assistant', text: 'fixing', toolUses: [] },
      { role: 'user', text: 'go on', toolUses: [] },
    ] as never;
    let requests = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      requests++;
      const keys = Object.keys(JSON.parse(init.body).questions);
      const text = JSON.stringify({ answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: 0.1 }])) });
      return { status: 200, ok: true, text };
    }) as never;
    const config = resolveHookConfig({ apiKey: 'k', preserveRecentMessages: 1 });
    const first = await compactSession(messages, config, fetchFn);
    const second = await compactSession(messages, config, fetchFn);
    expect(requests).toBe(1);
    expect(second.result.decisions.map((d) => d.action)).toEqual(first.result.decisions.map((d) => d.action));
  });
});

describe('pressure', () => {
  const config = resolveHookConfig({});

  it('falls back to the fixed minimum without usage figures', () => {
    expect(pressure(undefined, 10_000, config)).toEqual({ minReduction: 0.3, gate: 0.25 });
  });

  it('asks for what brings the context back under the trigger, overhead included', () => {
    // 60% of a 200k window, all of it transcript: back to 50% needs 1/6, accepted at 55%
    const bare = pressure({ tokens: 120_000, window: 200_000 }, 120_000, config);
    expect(bare.minReduction).toBeCloseTo(1 - 100 / 120, 5);
    expect(bare.gate).toBeCloseTo(1 - 110 / 120, 5);
    // 20k of the 120k is system prompt and tools, which do not shrink: the transcript must give more
    const withOverhead = pressure({ tokens: 120_000, window: 200_000 }, 100_000, config);
    expect(withOverhead.minReduction).toBeCloseTo(1 - 80 / 100, 5);
    // a full window needs far more; a manual /compact at low fill needs almost nothing
    expect(pressure({ tokens: 190_000, window: 200_000 }, 190_000, config).minReduction).toBeGreaterThan(0.45);
    expect(pressure({ tokens: 40_000, window: 200_000 }, 40_000, config)).toEqual({ minReduction: 0.05, gate: 0 });
  });
});

describe('offloadOutputs', () => {
  const full = `status=failed pid 4242\n${'trace line\n'.repeat(900)}`;
  const original = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'deploy' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: full }] },
  ] as Message[];
  const stub = `status=failed pid 4242\n[fast-jev-compaction omitted 9000 chars; ${fullOutputNote('t1')}]`;
  const compacted = [original[0]!, { ...original[1]!, toolResults: [{ tool_use_id: 't1', text: stub }] }] as Message[];

  it('saves the full output of a reduced result and points its note to the file', async () => {
    const files = new Map<string, string>();
    const out = await offloadOutputs(original as never, compacted, 'C:/p/.claude/fast-jev/s1', {
      write: async (path, text) => void files.set(path, text),
    });
    expect(files.get('C:/p/.claude/fast-jev/s1/t1.txt')).toBe(full);
    expect(files.get('C:/p/.claude/fast-jev/.gitignore')).toBe('*\n');
    const text = out[1]!.toolResults![0]!.text;
    expect(text).toContain('the full output is saved at C:/p/.claude/fast-jev/s1/t1.txt');
    expect(text).not.toContain(fullOutputNote('t1'));
  });

  it('keeps the transcript note when the write fails', async () => {
    const out = await offloadOutputs(original as never, compacted, 'C:/p/.claude/fast-jev/s1', {
      write: async () => {
        throw new Error('EACCES');
      },
    });
    expect(out[1]!.toolResults![0]!.text).toBe(stub);
  });

  it('leaves untouched results and re-run notes alone', async () => {
    const files = new Map<string, string>();
    const out = await offloadOutputs(original as never, original, 'C:/p/.claude/fast-jev/s1', {
      write: async (path, text) => void files.set(path, text),
    });
    expect(files.size).toBe(0);
    expect(out[1]).toBe(original[1]);
  });
});

describe('saveForSummary', () => {
  it('saves every long output with an index and returns the line for the summarizer', async () => {
    const files = new Map<string, string>();
    const messages = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a1', tool: 'Bash', input: { command: 'make' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a1', text: `error: ${'x'.repeat(300)}` }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a2', tool: 'Bash', input: { command: 'true' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a2', text: 'ok' }] },
    ] as Message[];
    const line = await saveForSummary(messages as never, 'C:/p/.claude/fast-jev/s1', {
      write: async (path, text) => void files.set(path, text),
    });
    expect(files.has('C:/p/.claude/fast-jev/s1/a1.txt')).toBe(true);
    expect(files.has('C:/p/.claude/fast-jev/s1/a2.txt')).toBe(false); // short output: not worth a file
    const index = [...files.entries()].find(([path]) => /index-\d+\.txt$/.test(path));
    expect(index?.[1]).toMatch(/^a1\tBash\t\{"command":"make"\}\t307 chars\n$/);
    expect(line).toContain('C:/p/.claude/fast-jev/s1');
  });

  it('returns undefined when a write fails, so the summary goes ahead without the line', async () => {
    const messages = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a1', text: 'y'.repeat(500) }] }] as Message[];
    expect(await saveForSummary(messages as never, 'C:/p/x/s', { write: async () => { throw new Error('EACCES'); } })).toBeUndefined();
  });
});

describe('saved outputs: secrets, age and paths', () => {
  const key = `sk-${'proj'}-${'aB3dE6gH9jK2mN5pQ8sT'.repeat(2)}`;

  it('masks secret values in the saved copy, not in the context note', async () => {
    const files = new Map<string, string>();
    const original = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'env' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `OPENAI_API_KEY=${key}\n${'line\n'.repeat(2000)}` }] },
    ] as Message[];
    const compacted = [original[0]!, { ...original[1]!, toolResults: [{ tool_use_id: 't1', text: `[fast-jev-compaction omitted; ${fullOutputNote('t1')}]` }] }] as Message[];
    await offloadOutputs(original as never, compacted, 'C:/p/.claude/fast-jev/cache/s1', { write: async (path, text) => void files.set(path, text) });
    const saved = files.get('C:/p/.claude/fast-jev/cache/s1/t1.txt')!;
    expect(saved).not.toContain(key);
    expect(saved).toContain('OPENAI_API_KEY=[REDACTED:sk-proj]');
  });

  it('keeps a hostile tool_use_id inside the session folder', async () => {
    const files = new Map<string, string>();
    const id = '../../../evil';
    const original = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'x'.repeat(9000) }] }] as Message[];
    const compacted = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `[stub; ${fullOutputNote(id)}]` }] }] as Message[];
    await offloadOutputs(original as never, compacted, 'C:/p/.claude/fast-jev/cache/s1', { write: async (path, text) => void files.set(path, text) });
    const written = [...files.keys()].filter((path) => path.endsWith('.txt'));
    expect(written).toEqual(['C:/p/.claude/fast-jev/cache/s1/.._.._.._evil.txt']);
  });

  it('empties saved outputs older than 30 days and leaves fresh ones', async () => {
    const now = Date.UTC(2026, 9, 30);
    const day = 24 * 60 * 60 * 1000;
    const files = new Map<string, { text: string; mtimeMs: number }>([
      ['R/s-old/a.txt', { text: 'old output', mtimeMs: now - 31 * day }],
      ['R/s-new/b.txt', { text: 'new output', mtimeMs: now - day }],
    ]);
    const fs = {
      write: async (path: string, text: string) => void files.set(path, { text, mtimeMs: now }),
      list: async (path: string) =>
        path === 'R'
          ? [{ name: 's-old', kind: 'dir', size: 0 }, { name: 's-new', kind: 'dir', size: 0 }]
          : [...files.entries()].filter(([p]) => p.startsWith(`${path}/`)).map(([p, f]) => ({ name: p.slice(path.length + 1), kind: 'file', size: f.text.length })),
      stat: async (path: string) => ({ mtimeMs: files.get(path)!.mtimeMs }),
    };
    expect(await expireOutputs('R', fs, now)).toBe(1);
    expect(files.get('R/s-old/a.txt')!.text).toBe('');
    expect(files.get('R/s-new/b.txt')!.text).toBe('new output');
  });
});

describe('settingsOptions', () => {
  it('reads only this plugin\'s pluginConfigs options', () => {
    expect(
      settingsOptions({
        pluginConfigs: {
          'fast-jev-compaction@fast-jev-compaction': { options: { compactAtPercent: 95 } },
          'jev-watch@jev-watch': { options: { watch: 'x' } },
        },
      }),
    ).toEqual({ compactAtPercent: 95 });
    expect(settingsOptions({})).toEqual({});
    expect(settingsOptions({ pluginConfigs: { 'fast-jev-compaction@m': null } })).toEqual({});
  });
});

describe('register', () => {
  beforeEach(() => forgetAnswers());

  type Handler = (...args: unknown[]) => Promise<unknown>;

  function host(settings: Record<string, unknown>, usage: Record<string, number>, compact?: () => Promise<unknown>) {
    const logs: string[] = [];
    const debug: string[] = [];
    const calls = { compact: 0 };
    const $ = {
      settings: { read: async () => settings },
      env: { get: async () => undefined },
      ui: {
        log: (text: string, options?: { to?: string }) => (options?.to === 'debug' ? debug : logs).push(text),
        toast: () => undefined,
      },
      session: {
        usage: async () => ({ context: usage }),
        compact: async () => {
          calls.compact++;
          return compact ? compact() : { skip: 'none' };
        },
      },
      // t1 (the Read) dropped, t2 kept: a real reduction, far below a full window's gate
      http: { fetch: jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1)) },
    };
    return { $, logs, debug, calls };
  }

  function load(options: Record<string, unknown> = {}) {
    const handlers = new Map<string, Handler>();
    register(((name: string, handler: Handler) => handlers.set(name, handler)) as never, {
      apiKey: 'k',
      preserveRecentMessages: 1,
      saveFullOutputs: false,
      ...options,
    } as never);
    return handlers;
  }

  const full = { tokens: 990_000, window: 1_000_000, percent: 99 };

  it('installs its own compaction when the built-in summary it fell back to fails', async () => {
    const { $, logs, debug } = host({}, full);
    const event = { trigger: 'auto', messages: transcript() };
    const next = async () => {
      throw new Error('reactive compaction did not settle ok');
    };
    const answer = (await load().get('session.compact')!($, event, next)) as { messages: SessionMessage[] };
    // the transcript gets outcomes only; per-call decisions go to the debug log
    expect(logs.some((line) => line.startsWith('decisions'))).toBe(false);
    expect(debug.some((line) => line.startsWith('decisions: t1:Read:drop_call'))).toBe(true);
    expect(logs.some((line) => line.startsWith('fallback to built-in summary (below the 90%'))).toBe(true);
    expect(logs.some((line) => /context 990000\/1000000 tokens, compactAtPercent 60/.test(line))).toBe(true);
    expect(answer.messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(logs.at(-1)).toMatch(/^kept 7\/7 messages after the built-in summary failed \(reactive compaction did not settle ok\)/);
  });

  it('passes the failure on when it has nothing of its own to install', async () => {
    const { $ } = host({}, full);
    const event = { trigger: 'auto', messages: transcript() };
    const next = async () => {
      throw new Error('summary failed');
    };
    // everything newer than the first message pinned: nothing dropped, so no reduction to fall back on
    await expect(load({ preserveRecentMessages: 50 }).get('session.compact')!($, event, next)).rejects.toThrow('summary failed');
  });

  it('takes compactAtPercent from settings.json when the host passed the default', async () => {
    const { $, logs, debug } = host(
      { pluginConfigs: { 'fast-jev-compaction@fast-jev-compaction': { options: { compactAtPercent: 95 } } } },
      // a small window, so the transcript (~300 tokens) is a real share of it, as in a long session
      { tokens: 960, window: 1_000, percent: 96 },
    );
    let summarized = false;
    const next = async () => {
      summarized = true;
      return { messages: [] };
    };
    const answer = (await load().get('session.compact')!($, { trigger: 'auto', messages: transcript() }, next)) as {
      messages: SessionMessage[];
    };
    // 96% of the window back under 90% needs little: the hook's own result stands, no summary
    expect(summarized).toBe(false);
    expect(answer.messages).toHaveLength(7);
    expect(debug[0]).toMatch(/^options: compactAtPercent 95 from settings\.json \(the host passed 60\)/);
    expect(logs.some((line) => line.startsWith('options'))).toBe(false);
  });

  it('asks a headless host for compaction once, then leaves it to the engine', async () => {
    const { $, logs, debug, calls } = host({}, { tokens: 700_000, window: 1_000_000, percent: 70 }, async () => {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet');
    });
    const turn = load().get('turn.complete')!;
    const next = async (e: unknown) => e;
    await turn($, {}, next);
    await turn($, {}, next);
    expect(calls.compact).toBe(1);
    // expected on that host: the debug log, never the transcript
    expect(logs).toHaveLength(0);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatch(/not asked again this session: the engine's threshold compacts here \(context 700000\/1000000 tokens, compactAtPercent 60\)/);
  });
});

describe('turn.complete of a subagent', () => {
  it('never asks for compaction while the main turn runs', async () => {
    let usage = 0;
    let compact = 0;
    const $ = {
      settings: { read: async () => ({}) },
      ui: { log: () => undefined, toast: () => undefined },
      session: {
        usage: async () => {
          usage++;
          return { context: { tokens: 990_000, window: 1_000_000, percent: 99 } };
        },
        compact: async () => {
          compact++;
          throw new Error('$.session.compact: a turn is running');
        },
      },
    };
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    register(((name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler)) as never, {} as never);
    const next = async (e: unknown) => e;
    await handlers.get('turn.complete')!($, { agentId: 'sub-1' }, next);
    expect([usage, compact]).toEqual([0, 0]);
    // the main loop's own turn still checks the window
    await handlers.get('turn.complete')!($, {}, next);
    expect([usage, compact]).toEqual([1, 1]);
  });
});

describe('version', () => {
  it('matches plugin.json, so a toast names the version that really runs', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(manifest.version);
  });
});
