// The signed-in user of this browser tab: loaded from storage at start-up, replaced by signIn, dropped by signOut.
import { authHeader, clearAuth, loadAuth, saveAuth, type StoredAuth } from './auth-logic.js';

const NOTE_KEY = 'worklog-report:login-note';

/** window.localStorage / sessionStorage, or undefined where touching them throws. */
function local(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}
function session(): Storage | undefined {
  try {
    return window.sessionStorage ?? undefined;
  } catch {
    return undefined;
  }
}

let current: StoredAuth | undefined = loadAuth(local(), session());

export const currentAuth = (): StoredAuth | undefined => current;

/** Remembers the sign-in (per the user's choice) and uses it for every request from now on. */
export function signIn(auth: StoredAuth): void {
  current = auth;
  saveAuth(local(), session(), auth);
}

/** Adds the account id to the stored sign-in (older ones lack it), keeping the user's choice of where it is stored. */
export function rememberAccountId(accountId: string): void {
  if (current && current.accountId !== accountId) signIn({ ...current, accountId });
}

/**
 * Forgets the sign-in and reloads, so no data of the old user stays on the page. `note` is shown once on the sign-in
 * screen (e.g. "Jira did not accept your token").
 */
export function signOut(note?: string): void {
  current = undefined;
  clearAuth(local(), session());
  try {
    if (note) session()?.setItem(NOTE_KEY, note);
  } catch {
    // The note is only a courtesy.
  }
  window.location.reload();
}

/** The note left by signOut, once. */
export function takeLoginNote(): string | undefined {
  try {
    const note = session()?.getItem(NOTE_KEY) ?? undefined;
    session()?.removeItem(NOTE_KEY);
    return note || undefined;
  } catch {
    return undefined;
  }
}

/** Headers that make a request the signed-in user's. */
export function authorization(): Record<string, string> {
  return current ? { Authorization: authHeader(current) } : {};
}
