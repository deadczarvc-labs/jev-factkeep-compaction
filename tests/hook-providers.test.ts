import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compactSession, forgetAnswers, register, resolveHookConfig, resolveRuntimeConfig,
  type HookFetch,
} from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

const T = 'https://api.typesafe.ai/v1/systemone';
const O = 'https://openrouter.ai/api/v1/systemone';
const V = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const KT = 'fixtureTypeSafe';
const KO = 'fixtureOpenRouter';
const KV = 'fixtureGateway';
type Env = Record<string, string | undefined>;
type Handler = (...args: unknown[]) => Promise<unknown>;

function H(options: Parameters<typeof resolveHookConfig>[0], env: Env, settingsEnv: Env) {
  const envTrace: string[] = [];
  const fetchSpy = vi.fn<HookFetch>();
  const $ = {
    env: { get: vi.fn(async (name: string) => { envTrace.push(name); return env[name]; }) },
    settings: { read: vi.fn(async () => ({ env: settingsEnv })) },
    http: { fetch: fetchSpy },
  };
  return { result: resolveRuntimeConfig($, resolveHookConfig(options)), envTrace, fetchSpy, $ };
}

function host(env: Env = {}, settings: Record<string, unknown> = {}) {
  return {
    env: { get: vi.fn(async (name: string) => env[name]) },
    settings: { read: vi.fn(async () => settings) },
    http: { fetch: vi.fn<HookFetch>(async (_url, init) => {
      const questions = JSON.parse(init?.body ?? '{}').questions;
      return { status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.98 }])) }) };
    }) },
    ui: { log: vi.fn(), toast: vi.fn() },
    fs: { write: vi.fn(), list: vi.fn(async () => []), stat: vi.fn() },
    session: {
      usage: vi.fn(async () => ({ context: {} })),
      cwd: vi.fn(async () => 'C:/fixture'), id: vi.fn(async () => 'fixture'),
    },
    clock: { sleep: vi.fn((ms: number, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, ms);
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    })) },
  };
}

function load(options: Parameters<typeof resolveHookConfig>[0]): Handler {
  const handlers = new Map<string, Handler>();
  register(((name: string, handler: Handler) => handlers.set(name, handler)) as never, options);
  return handlers.get('session.compact')!;
}

function transcript(): Message[] {
  return [
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.txt' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'x'.repeat(5000) }] },
    { role: 'user', text: 'continue', toolUses: [] },
  ];
}

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); forgetAnswers(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); forgetAnswers(); });

describe('approved hook provider table', () => {
  it('OpenRouter without consent ⇒ deny before key read', async () => {
    const run = H({ provider: 'openrouter' }, { OPENROUTER_API_KEY: KO }, {});
    await expect(run.result).rejects.toThrow('Third-party Jev egress is disabled');
    expect(run.envTrace).toEqual([]);
    expect(run.fetchSpy).not.toHaveBeenCalled();
  });

  it('Gateway without consent ⇒ deny before key read', async () => {
    const run = H({ provider: 'vercel' }, { AI_GATEWAY_API_KEY: KV }, {});
    await expect(run.result).rejects.toThrow('Third-party Jev egress is disabled');
    expect(run.envTrace).toEqual([]);
    expect(run.fetchSpy).not.toHaveBeenCalled();
  });

  it('hook Gateway selection ⇒ literal env read', async () => {
    const run = H({ provider: 'vercel', allowThirdPartyEgress: true }, { TYPESAFE_API_KEY: KT, AI_GATEWAY_API_KEY: KV }, {});
    const config = await run.result;
    expect({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }).toEqual({
      provider: 'vercel', baseUrl: V, model: 'typesafe-ai/jev', apiKey: KV,
    });
    expect(run.envTrace).toEqual(['AI_GATEWAY_API_KEY']);
    expect(run.fetchSpy).not.toHaveBeenCalled();
  });

  it('hook OpenRouter settings key ⇒ same namespace only', async () => {
    const run = H({ provider: 'openrouter', allowThirdPartyEgress: true }, {}, { TYPESAFE_API_KEY: KT, OPENROUTER_API_KEY: KO });
    const config = await run.result;
    expect({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }).toEqual({
      provider: 'openrouter', baseUrl: O, model: 'jev-latest', apiKey: KO,
    });
    expect(run.envTrace).toEqual(['OPENROUTER_API_KEY']);
  });

  it('consent error on empty transcript ⇒ zero egress', async () => {
    const fetchSpy = vi.fn<HookFetch>();
    await expect(compactSession([], resolveHookConfig({ provider: 'vercel' }), fetchSpy)).rejects.toThrow('Third-party Jev egress is disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
    const write = vi.fn();
    await expect(compactSession([], resolveHookConfig({ provider: 'vercel' }), fetchSpy, undefined, { dir: 'C:/fixture/cache', fs: { write } }))
      .rejects.toThrow('Third-party Jev egress is disabled');
    expect(write).not.toHaveBeenCalled();
    const positive = vi.fn<HookFetch>(host().http.fetch);
    await compactSession(transcript(), resolveHookConfig({ apiKey: KT, preserveRecentMessages: 1 }), positive, 0);
    expect(positive).toHaveBeenCalledOnce();
  });

  it('disabled provider in registered hook ⇒ built-in fallback once', async () => {
    const $ = host({ OPENROUTER_API_KEY: KO });
    const event = { trigger: 'manual', messages: [] };
    const summary = { messages: [{ role: 'user', text: 'summary', toolUses: [] }] };
    const next = vi.fn(async () => summary);
    const result = await load({ provider: 'openrouter', saveFullOutputs: false })($, event, next);
    expect($.env.get).not.toHaveBeenCalled();
    expect($.http.fetch).not.toHaveBeenCalled();
    expect($.fs.write).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(event);
    expect(result).toBe(summary);
  });
});

describe('hook transport boundary regressions', () => {
  it('retains invalid raw fields until the session fallback boundary', async () => {
    for (const options of [
      { provider: 'gateway' }, { allowThirdPartyEgress: 'true' }, { baseUrl: false }, { baseUrl: '' }, { model: false }, { model: '' },
    ]) {
      const $ = host({ TYPESAFE_API_KEY: KT });
      const event = { trigger: 'manual', messages: [] };
      const summary = { messages: [] };
      const next = vi.fn(async () => summary);
      expect(await load({ ...options, saveFullOutputs: false })($, event, next)).toBe(summary);
      expect($.env.get).not.toHaveBeenCalled();
      expect($.http.fetch).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith(event);
    }
  });

  it('explicit empty hook key suppresses both credential sources', async () => {
    const run = H({ provider: 'openrouter', allowThirdPartyEgress: true, apiKey: '' }, { OPENROUTER_API_KEY: KO }, { OPENROUTER_API_KEY: KO });
    await expect(run.result).rejects.toThrow('OPENROUTER_API_KEY is not configured');
    expect(run.envTrace).toEqual([]);
    expect(run.$.settings.read).not.toHaveBeenCalled();
  });

  it('custom never reads an ambient hook credential', async () => {
    const run = H({ provider: 'custom', baseUrl: 'http://localhost:8321/v1/systemone' }, { TYPESAFE_API_KEY: KT }, { TYPESAFE_API_KEY: KT });
    await expect(run.result).rejects.toThrow('apiKey is required for custom provider');
    expect(run.envTrace).toEqual([]);
    expect(run.$.settings.read).not.toHaveBeenCalled();
  });

  it('absent model uses the selected provider default but explicit legacy model fails', async () => {
    expect(resolveHookConfig({}).model).toBeUndefined();
    const invalid = H({ provider: 'vercel', allowThirdPartyEgress: true, model: 'jev-latest' }, { AI_GATEWAY_API_KEY: KV }, {});
    await expect(invalid.result).rejects.toThrow('Unsupported Jev model for selected provider');
    expect(invalid.envTrace).toEqual([]);
  });

  it('freezes the merged snapshot and gates before cached answers or offload', async () => {
    const options = { apiKey: KT, saveFullOutputs: false, preserveRecentMessages: 1, minReductionRatio: 0 };
    const settings: Record<string, unknown> = {
      pluginConfigs: { 'fast-jev-compaction@fixture': { options: { provider: 'vercel', allowThirdPartyEgress: false } } },
    };
    const $ = host({ AI_GATEWAY_API_KEY: KV }, settings);
    const handler = load(options);
    const next = vi.fn(async () => ({ messages: [] }));
    const event = { trigger: 'manual', messages: transcript() };
    await handler($, event, next);
    settings.pluginConfigs = {};
    options.apiKey = KO;
    await handler($, event, next);
    expect($.env.get).not.toHaveBeenCalled();
    expect($.http.fetch).not.toHaveBeenCalled();
    expect($.fs.write).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('hook selected key is masked in fitted history without changing the transcript', async () => {
    const $ = host({ AI_GATEWAY_API_KEY: KV, TYPESAFE_API_KEY: KT });
    const messages = transcript();
    messages[0]!.text = KV;
    const config = await resolveRuntimeConfig($, resolveHookConfig({ provider: 'vercel', allowThirdPartyEgress: true, preserveRecentMessages: 1 }));
    expect(Object.isFrozen(config)).toBe(true);
    await compactSession(messages, config, $.http.fetch, 0);
    expect($.env.get).toHaveBeenCalledOnce();
    expect($.env.get).toHaveBeenCalledWith('AI_GATEWAY_API_KEY');
    expect($.http.fetch).toHaveBeenCalledOnce();
    const [url, init] = $.http.fetch.mock.calls[0]!;
    expect(url).toBe(V);
    expect(init?.headers).toEqual({ authorization: 'Bearer ' + KV, 'content-type': 'application/json' });
    expect(init?.body).not.toContain(KV);
    expect(init?.body).toContain('[REDACTED:known]');
    expect(messages[0]?.text).toBe(KV);
  });

  it('TypeSafe is still the hook default with other ambient keys present', async () => {
    const run = H({}, { TYPESAFE_API_KEY: KT, OPENROUTER_API_KEY: KO, AI_GATEWAY_API_KEY: KV }, {});
    const config = await run.result;
    expect(config.baseUrl).toBe(T);
    expect(config.model).toBe('jev-latest');
    expect(config.apiKey).toBe(KT);
    expect(run.envTrace).toEqual(['TYPESAFE_API_KEY']);
  });
});
