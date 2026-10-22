// Which of the configured Jira sites (JIRA_SITES) accept the signed-in user's email + API token. An API token cannot be
// asked "which sites do I have?" (only OAuth can), so every configured site is tried with the user's own token and the
// ones Jira lets in are kept. That is the user's site dropdown.
import { createHash } from 'node:crypto';
import type { JiraUserRef } from '../types.js';
import { runWithCredentials, type Credentials } from './auth.js';
import { jiraFailureKind } from './errors.js';
import type { JiraSite, SiteRegistry } from './sites.js';

/** One site's answer is not waited for longer than this: a site that is down must not hold up the sign-in. */
const PROBE_TIMEOUT_MS = 8_000;
/** How long a user's site list is reused (a new or revoked access shows up after this, or at the next sign-in). */
const TTL_MS = 5 * 60_000;
/** A list with a site that could not be checked (down, rate limited) is re-checked sooner. */
const SHORT_TTL_MS = 30_000;

export interface SiteAccess {
  /** Sites that accepted the credentials, in JIRA_SITES order. */
  sites: JiraSite[];
  /** Who the credentials belong to (from the first site that accepted them). */
  user?: Pick<JiraUserRef, 'displayName' | 'accountId'>;
  /** Sites that could not be checked (unreachable, timed out, Jira error): neither accepted nor rejected. */
  unchecked: Array<{ site: JiraSite; err: unknown }>;
}

/** Tries every configured site with `creds`. A 401 / 403 means "no access"; anything else means "could not check". */
export async function probeSites(registry: SiteRegistry, creds: Credentials): Promise<SiteAccess> {
  const results = await Promise.all(
    registry.entries.map(async (entry) => {
      try {
        const me = await runWithCredentials(creds, () =>
          entry.jira.get<JiraUserRef>('/rest/api/3/myself', {}, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        );
        return { site: { key: entry.key, url: entry.url }, me, err: undefined };
      } catch (err) {
        const kind = jiraFailureKind(err);
        return { site: { key: entry.key, url: entry.url }, me: undefined, err, denied: kind === 'auth' || kind === 'forbidden' };
      }
    }),
  );
  const accepted = results.filter((r) => r.me);
  const first = accepted[0]?.me;
  return {
    sites: accepted.map((r) => r.site),
    ...(first ? { user: { displayName: first.displayName, accountId: first.accountId } } : {}),
    unchecked: results.filter((r) => !r.me && !('denied' in r && r.denied)).map((r) => ({ site: r.site, err: r.err })),
  };
}

/**
 * Per-user site lists, kept for a few minutes. Keyed by email + token (so a wrong token never gets a cached answer);
 * concurrent callers share one probe. The key is a hash: the token itself is not kept here.
 */
export class SiteAccessCache {
  private readonly entries = new Map<string, { until: number; access: Promise<SiteAccess> }>();

  constructor(
    private readonly registry: SiteRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  /** `fresh` skips the cache (the sign-in itself must be answered by Jira, not by memory). */
  get(creds: Credentials, fresh = false): Promise<SiteAccess> {
    const key = createHash('sha256').update(`${creds.email.toLowerCase()}\n${creds.token}`).digest('hex');
    const hit = this.entries.get(key);
    if (!fresh && hit && hit.until > this.now()) return hit.access;

    const access = probeSites(this.registry, creds);
    const entry = { until: this.now() + SHORT_TTL_MS, access };
    this.entries.set(key, entry);
    void access.then(
      (a) => {
        entry.until = this.now() + (a.unchecked.length ? SHORT_TTL_MS : TTL_MS);
        this.prune();
      },
      () => this.entries.delete(key),
    );
    return access;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.until <= t) this.entries.delete(k);
  }
}
