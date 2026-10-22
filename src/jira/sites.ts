import type { Config } from '../config.js';
import { createJiraClient, type JiraClient } from './client.js';

/** One Jira Cloud site. `key` is the subdomain (https://<key>.atlassian.net), lower-case. */
export interface JiraSite {
  key: string;
  url: string;
}

export interface SiteEntry extends JiraSite {
  jira: JiraClient;
}

/** Reserved for GET /api/health/jira?site=all, so it cannot be a site key. */
export const ALL_SITES = 'all';

const SITE_URL = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/;

/** Validates one site URL (trailing slashes trimmed, case-insensitive). Throws with a readable message. */
export function parseSiteUrl(raw: string): JiraSite {
  const url = raw.trim().replace(/\/+$/, '').toLowerCase();
  const m = SITE_URL.exec(url);
  if (!m) throw new Error(`"${raw.trim()}" is not a Jira Cloud site URL (expected https://<sub>.atlassian.net)`);
  if (m[1] === ALL_SITES) throw new Error(`"${raw.trim()}": the site name "${ALL_SITES}" is reserved`);
  return { key: m[1]!, url };
}

/** Parses JIRA_SITES (comma-separated URLs). Order is kept; the first site is the default. */
export function parseSites(raw: string): JiraSite[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('at least one site URL is required');
  const sites = parts.map(parseSiteUrl);
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.key)) throw new Error(`site "${s.key}" is listed more than once`);
    seen.add(s.key);
  }
  return sites;
}

/** The configured sites with their clients. Lookups by key are case-insensitive. */
export class SiteRegistry {
  private readonly byKey: Map<string, SiteEntry>;

  constructor(readonly entries: SiteEntry[]) {
    if (entries.length === 0) throw new Error('SiteRegistry needs at least one site');
    this.byKey = new Map(entries.map((e) => [e.key, e]));
  }

  /**
   * One client per site. The clients hold no credentials: each call uses the signed-in user's email + API token (the same
   * ones work on every site the account can access), taken from the request context. JIRA_EMAIL / JIRA_API_TOKEN from the
   * environment are deliberately not used here, or the app would be open to anyone; only the probe script uses them.
   */
  static fromConfig(cfg: Pick<Config, 'JIRA_SITES'>): SiteRegistry {
    return new SiteRegistry(cfg.JIRA_SITES.map((s) => ({ ...s, jira: createJiraClient(s.url) })));
  }

  get default(): SiteEntry {
    return this.entries[0]!;
  }

  get keys(): string[] {
    return this.entries.map((e) => e.key);
  }

  /** Public list for the browser (no clients, no credentials). */
  list(): JiraSite[] {
    return this.entries.map(({ key, url }) => ({ key, url }));
  }

  /** Missing/empty key = default site; unknown key = undefined. */
  resolve(key: unknown): SiteEntry | undefined {
    if (key === undefined || key === null || (typeof key === 'string' && key.trim() === '')) return this.default;
    if (typeof key !== 'string') return undefined;
    return this.byKey.get(key.trim().toLowerCase());
  }

  unknownSiteMessage(key: unknown): string {
    return `Unknown site "${String(key).slice(0, 100)}". Known sites: ${this.keys.join(', ')}.`;
  }
}
