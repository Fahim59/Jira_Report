// Per-request Jira credentials. Every user signs in with their own Atlassian email + API token; the browser sends
// them as `Authorization: Basic …` on each /api call. A hook (src/routes/auth.ts) parses the header and runs the rest
// of the request inside `runWithCredentials`, so the Jira clients (which hold no credentials of their own) pick the
// caller's up when they make a call. Credentials live only in that request's async context: never stored, never logged.
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Credentials {
  email: string;
  token: string;
}

/** A Jira call without credentials (the request never signed in). HTTP 401. */
export class NotSignedInError extends Error {
  override readonly name = 'NotSignedInError';
  readonly statusCode = 401;
  constructor(message = 'Sign in required.') {
    super(message);
  }
}

const store = new AsyncLocalStorage<Credentials>();

/** Runs `fn` (and everything it awaits) as the user holding `creds`. */
export function runWithCredentials<T>(creds: Credentials, fn: () => T): T {
  return store.run(creds, fn);
}

export const currentCredentials = (): Credentials | undefined => store.getStore();

/** `Authorization: Basic base64(email:token)` → credentials; undefined for anything else. The token may contain ':'. */
export function parseBasicAuth(header: string | undefined): Credentials | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return undefined;
  const text = Buffer.from(m[1]!, 'base64').toString('utf8');
  const at = text.indexOf(':');
  if (at <= 0 || at === text.length - 1) return undefined;
  const email = text.slice(0, at).trim();
  const token = text.slice(at + 1);
  return email.includes('@') && token.trim() ? { email, token } : undefined;
}

/** The header value for a Jira call. */
export const basicAuthHeader = (c: Credentials): string => 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64');

/** Short stable id of the signed-in user (cache keys): derived from the email only, so a rotated token keeps its cache. */
export function userKey(c: Credentials | undefined = currentCredentials()): string {
  return c ? createHash('sha256').update(c.email.toLowerCase()).digest('hex').slice(0, 16) : '';
}
