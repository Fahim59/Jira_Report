import { JiraError } from './client.js';

export type JiraFailureKind = 'auth' | 'forbidden' | 'rateLimited' | 'network' | 'server' | 'badRequest' | 'other';

export function jiraFailureKind(err: unknown): JiraFailureKind {
  if (!(err instanceof JiraError)) return 'other';
  const s = err.status;
  if (s === undefined) return 'network';
  if (s === 401) return 'auth';
  if (s === 403) return 'forbidden';
  if (s === 429) return 'rateLimited';
  if (s >= 500) return 'server';
  if (s === 400) return 'badRequest';
  return 'other';
}

/** Short reason for one failed issue, used to explain an incomplete report. */
export function shortFailureReason(err: unknown): string {
  switch (jiraFailureKind(err)) {
    case 'auth':
      return 'Jira rejected the credentials (HTTP 401)';
    case 'forbidden':
      return 'no permission in Jira (HTTP 403)';
    case 'rateLimited':
      return 'Jira rate limit (HTTP 429) persisted after retries';
    case 'network':
      return 'Jira unreachable or timed out';
    case 'server':
      return `Jira server error (HTTP ${(err as JiraError).status})`;
    default:
      return err instanceof JiraError && err.status ? `HTTP ${err.status}` : 'unexpected error';
  }
}

/**
 * HTTP status + user-facing message for a Jira call that failed after retries.
 * Messages describe what to do; they never include credentials or request headers.
 */
export function jiraErrorResponse(err: unknown, baseUrl: string): { status: number; error: string } {
  const detail = err instanceof Error ? err.message : String(err);
  switch (jiraFailureKind(err)) {
    case 'auth':
      // 401 is also the browser's cue to go back to the sign-in screen (web/api.ts).
      return {
        status: 401,
        error: 'Jira did not accept your email and API token (HTTP 401). The token may have been revoked or expired, or you may have lost access to this site: sign in again.',
      };
    case 'forbidden':
      return {
        status: 502,
        error: 'Jira denied access (HTTP 403): your Jira account lacks permission for this data, or your API token was revoked.',
      };
    case 'rateLimited':
      return { status: 503, error: 'Jira is rate limiting requests (HTTP 429) and retries did not help. Wait a minute, then try again or use a shorter range.' };
    case 'network':
      return { status: 502, error: `Cannot reach Jira at ${baseUrl} (network problem or Jira not responding). ${detail}` };
    case 'server':
      return { status: 502, error: `Jira is having problems (HTTP ${(err as JiraError).status}). Try again shortly.` };
    case 'badRequest':
      return { status: 400, error: detail };
    default:
      return { status: 502, error: `Jira request failed: ${detail}` };
  }
}
