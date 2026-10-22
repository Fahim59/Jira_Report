import type { Config } from '../config.js';
import { basicAuthHeader, currentCredentials, NotSignedInError } from './auth.js';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

export type QueryValue = string | number | boolean | undefined;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

export interface RequestOptions {
  /** Aborts the request, including any retry wait. The rejection is the signal's reason, never retried. */
  signal?: AbortSignal;
}

export interface JiraClient {
  readonly baseUrl: string;
  get<T>(path: string, query?: Record<string, QueryValue>, opts?: RequestOptions): Promise<T>;
  /** JSON POST with the same timeout/retry rules. Only for read-style endpoints (e.g. /jql/parse). Optional so test fakes can omit it. */
  post?<T>(path: string, body: unknown, query?: Record<string, QueryValue>, opts?: RequestOptions): Promise<T>;
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After may be delta-seconds or an HTTP date. Returns ms, or undefined if absent/unparseable. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s (+ up to 250ms jitter)
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
}

/** Extracts Jira's error messages without echoing anything request-related. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
      const parts = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})];
      if (parts.length) return parts.join('; ');
    } catch {
      /* not JSON */
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/** fetch() hides the real cause (ENOTFOUND, ECONNREFUSED, ...) in err.cause. */
function networkReason(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } } | undefined;
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

/**
 * Client for one site (`baseUrl` without trailing slash). The same credentials work on every site the account can access.
 * Without `cfg` credentials (the web app) each call uses the signed-in user's, from the request context (src/jira/auth.ts),
 * and fails with NotSignedInError if there are none. With `cfg` (the probe script) every call uses those.
 */
export function createJiraClient(baseUrl: string, cfg?: Partial<Pick<Config, 'JIRA_EMAIL' | 'JIRA_API_TOKEN'>>): JiraClient {
  // Kept in this closure only; never logged or returned.
  const fixed = cfg?.JIRA_EMAIL && cfg.JIRA_API_TOKEN ? basicAuthHeader({ email: cfg.JIRA_EMAIL, token: cfg.JIRA_API_TOKEN }) : undefined;
  const authFor = (): string => {
    if (fixed) return fixed;
    const creds = currentCredentials();
    if (!creds) throw new NotSignedInError();
    return basicAuthHeader(creds);
  };

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, QueryValue>,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const { signal } = opts;
    signal?.throwIfAborted();
    const authHeader = authFor();
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastError: JiraError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
          body: method === 'POST' ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]) : AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Caller cancelled (or the whole report timed out): stop now, no retry.
        if (signal?.aborted) throw signal.reason;
        // Network error or per-request timeout: treat like a transient 5xx.
        const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : networkReason(err);
        lastError = new JiraError(`Jira request failed: ${reason}`, undefined, path);
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          throw err;
        }
      }

      const detail = await errorDetail(res);
      if (signal?.aborted) throw signal.reason;
      lastError = new JiraError(`Jira ${res.status} on ${path}${detail ? `: ${detail}` : ''}`, res.status, path);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw lastError;

      const wait =
        res.status === 429
          ? Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? backoffMs(attempt), MAX_RETRY_AFTER_MS)
          : backoffMs(attempt);
      await sleep(wait, signal);
    }
    // Unreachable, but satisfies the type checker.
    throw lastError ?? new JiraError('Jira request failed', undefined, path);
  }

  return {
    baseUrl,
    get: <T>(path: string, query: Record<string, QueryValue> = {}, opts: RequestOptions = {}) => request<T>('GET', path, query, undefined, opts),
    post: <T>(path: string, body: unknown, query: Record<string, QueryValue> = {}, opts: RequestOptions = {}) =>
      request<T>('POST', path, query, body, opts),
  };
}
