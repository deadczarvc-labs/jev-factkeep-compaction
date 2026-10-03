import { buildJevRequest, isNativeJevNetworkError, JevConfigError, JevHttpError, JevNetworkError, parseJevResponse, parseRetryAfter } from './request.js';
import { requireJevApiKey, resolveJevEndpoint, selectJevApiKey, type JevProviderOptions, type ResolvedJevEndpoint } from './providers.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions extends JevProviderOptions {
  /** The selected service's key, otherwise its own namespace; custom has no ambient key. */
  apiKey?: string;
  /** Defaults to global fetch; injected transports must honor redirect and abort policy. */
  fetch?: typeof fetch;
}

/** Asks Jev through one explicitly resolved System One transport. */
export class JevClient implements JevAsker {
  private readonly apiKey: string | undefined;
  private readonly endpoint: ResolvedJevEndpoint;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.endpoint = resolveJevEndpoint(options);
    this.apiKey = selectJevApiKey(this.endpoint, options.apiKey, process.env);
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
    signal?.throwIfAborted();
    const apiKey = requireJevApiKey(this.endpoint, this.apiKey);
    const request = (() => {
      try {
        return buildJevRequest({ apiKey, model: this.endpoint.model, baseUrl: this.endpoint.baseUrl }, state, questions);
      } catch (error) {
        throw error instanceof JevConfigError ? error : new JevConfigError('request');
      }
    })();
    let response: Response;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      // A refused redirect carries no network code, so it stays a plain failure and is never retried.
      if (isNativeJevNetworkError(error)) throw new JevNetworkError();
      throw error;
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      // Classification needs headers, not an error body. Observe cancellation without waiting for an arbitrary stream.
      try { void response.body?.cancel().catch(() => {}); } catch { /* An injected stream may throw synchronously. */ }
      throw new JevHttpError(response.status, parseRetryAfter(response.headers, Date.now()));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      signal?.throwIfAborted();
      if (isNativeJevNetworkError(error)) throw new JevNetworkError();
      throw error;
    }
    signal?.throwIfAborted();
    return parseJevResponse(response.status, response.ok, text, response.headers);
  }
}
