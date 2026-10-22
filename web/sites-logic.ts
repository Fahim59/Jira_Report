// Site picker rules (no DOM). The last selected site is remembered per browser.
import type { KeyValueStore } from './favourites-logic.js';

export const LAST_SITE_KEY = 'worklog-report:site';

/** The remembered site if it is still configured, else the first (default) site. Undefined only for an empty list. */
export function chooseSite(keys: string[], remembered: string | null | undefined): string | undefined {
  return remembered && keys.includes(remembered) ? remembered : keys[0];
}

export function loadLastSite(store: KeyValueStore | undefined): string | null {
  try {
    return store?.getItem(LAST_SITE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Best effort: a browser that cannot store it just starts on the default site next time. */
export function saveLastSite(store: KeyValueStore | undefined, key: string): void {
  try {
    store?.setItem(LAST_SITE_KEY, key);
  } catch {
    // Ignored.
  }
}
