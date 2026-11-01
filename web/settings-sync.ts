// Keeps a few localStorage choices (List columns, favourites) in data/settings.json on the server too,
// so they can be committed and shipped to another deployment. The file is shared by everyone using the server.
import { authorization } from './session.js';

const SYNCED_KEYS = ['worklog-report:list-columns-2', 'worklog-report:favourites'];

function store(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function put(key: string, value: string): void {
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authorization() },
    body: JSON.stringify({ key, value }),
  }).catch(() => {}); // server unreachable: the browser copy still works
}

let patched = false;

/** Every later save of a synced key is also sent to the server. */
function watchSaves(ls: Storage): void {
  if (patched) return;
  patched = true;
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
    original.call(this, key, value);
    if (this === ls && SYNCED_KEYS.includes(key)) put(key, value);
  };
}

/**
 * Copies the server's saved values into localStorage (the server wins; a key the server has never seen is uploaded
 * from this browser instead). Returns true when localStorage changed, so the caller can reload for the tabs to read it.
 */
export async function syncSettings(): Promise<boolean> {
  const ls = store();
  if (!ls) return false;
  let values: Record<string, string> = {};
  try {
    const res = await fetch('/api/settings', { headers: authorization() });
    if (!res.ok) return false;
    values = ((await res.json()) as { values?: Record<string, string> }).values ?? {};
  } catch {
    return false;
  }
  let changed = false;
  for (const key of SYNCED_KEYS) {
    const server = values[key];
    const local = ls.getItem(key);
    if (server !== undefined) {
      if (server !== local) {
        ls.setItem(key, server);
        changed = true;
      }
    } else if (local !== null) {
      put(key, local);
    }
  }
  watchSaves(ls);
  return changed;
}
