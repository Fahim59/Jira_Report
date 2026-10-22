// Where the signed-in user's Atlassian email + API token are kept in this browser, and how they are sent.
// Pure (the Storage objects are passed in), so it can be unit-tested in node. See web/session.ts for the live state.

export interface StoredAuth {
  email: string;
  token: string;
  /** Display name Jira gave at sign-in (header). */
  name?: string;
  /** The user's Jira account id (preselects "me" in Users & Groups). Absent in sign-ins saved by older versions. */
  accountId?: string;
  /** true = localStorage (still signed in after the browser is closed); false = sessionStorage (until the tab is closed). */
  remember: boolean;
}

export const AUTH_KEY = 'worklog-report:auth';

/** The part of localStorage / sessionStorage used here (spelled out: the server tsconfig has no DOM types). */
export interface StoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
type Store = StoreLike | undefined;

function read(store: Store): StoredAuth | undefined {
  try {
    const raw = store?.getItem(AUTH_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<StoredAuth> | null;
    if (!v || typeof v.email !== 'string' || typeof v.token !== 'string' || !v.email || !v.token) return undefined;
    return { email: v.email, token: v.token, ...(typeof v.name === 'string' && v.name ? { name: v.name } : {}), ...(typeof v.accountId === 'string' && v.accountId ? { accountId: v.accountId } : {}), remember: false };
  } catch {
    return undefined; // storage blocked or the value is not ours
  }
}

/** The stored sign-in: the "remember me" copy (localStorage) wins over the per-tab one. Corrupt / blocked storage = signed out. */
export function loadAuth(local: Store, session: Store): StoredAuth | undefined {
  const l = read(local);
  if (l) return { ...l, remember: true };
  return read(session);
}

function write(store: Store, auth: StoredAuth | undefined): boolean {
  try {
    if (!store) return false;
    if (auth) store.setItem(AUTH_KEY, JSON.stringify({ email: auth.email, token: auth.token, ...(auth.name ? { name: auth.name } : {}), ...(auth.accountId ? { accountId: auth.accountId } : {}) }));
    else store.removeItem(AUTH_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the sign-in in exactly one place: localStorage when `remember`, else sessionStorage. Returns false if that
 * storage is unavailable (private mode, blocked): the caller still signs in for this page load, it just is not kept.
 */
export function saveAuth(local: Store, session: Store, auth: StoredAuth): boolean {
  write(auth.remember ? session : local, undefined);
  return write(auth.remember ? local : session, auth);
}

export function clearAuth(local: Store, session: Store): void {
  write(local, undefined);
  write(session, undefined);
}

/** `Authorization` header value: `Basic base64(email:token)`, UTF-8 safe. */
export function authHeader(auth: Pick<StoredAuth, 'email' | 'token'>): string {
  const bytes = new TextEncoder().encode(`${auth.email}:${auth.token}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** Form check before anything is sent; undefined = fine. */
export function loginProblem(email: string, token: string): string | undefined {
  if (!email.trim()) return 'Enter the email address of your Atlassian account.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'That does not look like an email address.';
  if (!token.trim()) return 'Enter your Atlassian API token.';
  return undefined;
}
