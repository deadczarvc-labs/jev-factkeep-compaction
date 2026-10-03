import { checkBaseUrl, DEFAULT_MODEL, JevConfigError, SYSTEM_ONE_URL } from './request.js';

export const OPENROUTER_SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
export const VERCEL_SYSTEM_ONE_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';

export type JevProvider = 'typesafe' | 'openrouter' | 'vercel' | 'custom';

export interface JevProviderOptions {
  /** Defaults to TypeSafe; never inferred from credentials or a URL. */
  provider?: JevProvider;
  /** The full System One endpoint; custom requires an explicit URL. */
  baseUrl?: string;
  /** Defaults to the selected provider's compatible Jev model. */
  model?: string;
  /** Only literal true permits sending history to a third-party endpoint. */
  allowThirdPartyEgress?: boolean;
}

type JevKeyEnv = 'TYPESAFE_API_KEY' | 'OPENROUTER_API_KEY' | 'AI_GATEWAY_API_KEY';

export type ResolvedJevEndpoint = Readonly<{
  provider: JevProvider;
  baseUrl: string;
  model: string;
  keyEnv: JevKeyEnv | null;
  thirdParty: boolean;
}>;

const NAMED_ENDPOINTS = {
  typesafe: { baseUrl: SYSTEM_ONE_URL, model: DEFAULT_MODEL, keyEnv: 'TYPESAFE_API_KEY' },
  openrouter: { baseUrl: OPENROUTER_SYSTEM_ONE_URL, model: DEFAULT_MODEL, keyEnv: 'OPENROUTER_API_KEY' },
  vercel: { baseUrl: VERCEL_SYSTEM_ONE_URL, model: 'typesafe-ai/jev', keyEnv: 'AI_GATEWAY_API_KEY' },
} as const;

function supportedModel(provider: JevProvider, model: string): boolean {
  if (!model || model.length > 128 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(model)) return false;
  switch (provider) {
    case 'typesafe': return /^jev-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model);
    case 'openrouter': return /^(?:typesafe\/)?jev-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || model === '~typesafe/jev-latest';
    case 'vercel': return model === 'typesafe-ai/jev';
    case 'custom': return true;
  }
}

/** Pure endpoint policy: validate before any credential lookup or HTTP. Errors never echo options. */
export function resolveJevEndpoint(options: JevProviderOptions = {}): ResolvedJevEndpoint {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Jev provider options must be an object');
  }
  const provider = options.provider === undefined ? 'typesafe' : options.provider;
  if (provider !== 'typesafe' && provider !== 'openrouter' && provider !== 'vercel' && provider !== 'custom') {
    throw new Error('Unknown Jev provider');
  }
  if (options.allowThirdPartyEgress !== undefined && typeof options.allowThirdPartyEgress !== 'boolean') {
    throw new Error('allowThirdPartyEgress must be a boolean');
  }
  if (options.baseUrl !== undefined && typeof options.baseUrl !== 'string') {
    throw new Error('baseUrl must be a string');
  }
  if (options.model !== undefined && typeof options.model !== 'string') {
    throw new Error('Unsupported Jev model for selected provider');
  }
  const named = provider === 'custom' ? undefined : NAMED_ENDPOINTS[provider];
  if (!named && options.baseUrl === undefined) throw new Error('baseUrl is required for custom provider');
  const baseUrl = options.baseUrl ?? named!.baseUrl;
  checkBaseUrl(baseUrl);
  if (named && baseUrl !== named.baseUrl) throw new Error('baseUrl does not match selected Jev provider');
  const model = options.model ?? named?.model ?? DEFAULT_MODEL;
  if (!supportedModel(provider, model)) throw new Error('Unsupported Jev model for selected provider');
  // Check the written authority, not URL's normalized IPv4 aliases.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(baseUrl)?.[1];
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(authority ?? '');
  const thirdParty = provider === 'custom' ? !loopback : provider !== 'typesafe';
  if (thirdParty && options.allowThirdPartyEgress !== true) throw new Error('Third-party Jev egress is disabled');
  return Object.freeze({ provider, baseUrl, model, keyEnv: named?.keyEnv ?? null, thirdParty });
}

/** Select exactly one credential namespace. Even an explicit empty key suppresses ambient fallback. */
export function selectJevApiKey(
  endpoint: ResolvedJevEndpoint,
  explicitKey: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const key = explicitKey !== undefined ? explicitKey : endpoint.keyEnv === null ? undefined : env[endpoint.keyEnv];
  if (key !== undefined && typeof key !== 'string') throw new Error('apiKey must be a string');
  return key;
}

/** Missing keys fail before HTTP, with a safe provider-specific diagnostic. */
export function requireJevApiKey(endpoint: ResolvedJevEndpoint, key: string | undefined): string {
  if (typeof key !== 'string' || key.length === 0) {
    // Typed so the round scheduler treats a missing key as config-fatal, never as a retryable failure.
    throw new JevConfigError('api_key', endpoint.keyEnv === null ? 'apiKey is required for custom provider' : `${endpoint.keyEnv} is not configured`);
  }
  return key;
}
