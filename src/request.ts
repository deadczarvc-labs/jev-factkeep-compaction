import { redactField, redactForEgress } from './secrets.js';
import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/** API key destination: HTTPS or an explicit loopback HTTP host, no userinfo. */
export function checkBaseUrl(url: string): void {
  const message = 'baseUrl must be https:// or a loopback http:// URL';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(message);
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1];
  // Check the host as written, not a normalized IPv4 alias such as 127.1.
  const loopbackHttp = parsed.protocol === 'http:' &&
    /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(authority ?? '');
  if (!authority || parsed.username || parsed.password || authority.includes('@') ||
    !(parsed.protocol === 'https:' || loopbackHttp)) {
    throw new Error(message);
  }
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * The HTTP request for one Jev call, for any fetch-like transport. Every string of the body is masked with its field
 * name in view (`redactField`) and every object key with `redactForEgress`, the API key as a known value: the second
 * mask behind `compact`, which masks the history before cutting it, and the only one for a caller that builds its own
 * state. A JSON replacer keeps `toJSON` and the usual error on a cyclic value; `state` and `questions` are not changed.
 */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const url = params.baseUrl ?? SYSTEM_ONE_URL;
  checkBaseUrl(url);
  const arrayField = new WeakMap<object, string>();
  return {
    url,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: params.model ?? DEFAULT_MODEL, state, questions }, function (this: object, key: string, value: unknown) {
      const known = [params.apiKey];
      // JSON.stringify names an array element "0"; the field that holds the array is the name redactField needs.
      const field = Array.isArray(this) ? (arrayField.get(this) ?? key) : key;
      if (typeof value === 'string') return redactField(field, value, known);
      if (Array.isArray(value)) arrayField.set(value, field);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      // An object whose key is a secret comes back as a copy with masked keys (JSON.stringify then visits its values);
      // any other object is returned as is, so the usual cycle check still applies.
      const keys = Object.keys(value).map((k) => [k, redactForEgress(k, known)] as const);
      if (keys.every(([k, masked]) => k === masked)) return value;
      return Object.fromEntries(keys.map(([k, masked]) => [masked, (value as Record<string, unknown>)[k]]));
    }),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
