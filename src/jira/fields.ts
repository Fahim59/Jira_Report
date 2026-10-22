import { buildFieldList, type FieldInfo, type JiraFieldRaw } from '../services/custom/fields.js';
import { userKey } from './auth.js';
import type { JiraClient, RequestOptions } from './client.js';

const TTL_MS = 10 * 60_000;

/** All fields on the site (GET /rest/api/3/field, not paginated) plus the pseudo-fields, sorted by name. */
export async function listFields(client: JiraClient, opts: RequestOptions = {}): Promise<FieldInfo[]> {
  const raw = await client.get<JiraFieldRaw[]>('/rest/api/3/field', {}, opts);
  return buildFieldList(Array.isArray(raw) ? raw : []);
}

/**
 * In-memory field list per site, kept for 10 minutes. Concurrent misses share one Jira call;
 * failures are not cached.
 */
export class FieldCache {
  private readonly entries = new Map<string, { at: number; fields: Promise<FieldInfo[]> }>();

  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached per site and per signed-in user: the field list depends on what the account may see. */
  get(siteKey: string, client: JiraClient): Promise<FieldInfo[]> {
    const key = `${siteKey}|${userKey()}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.fields;
    const fields = listFields(client);
    const entry = { at: this.now(), fields };
    this.entries.set(key, entry);
    fields.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return fields;
  }
}
