import type { CustomIssue } from '../services/custom/engine.js';
import { jqlString } from '../services/custom/filter.js';
import { JiraError, type JiraClient, type RequestOptions } from './client.js';

const PAGE_SIZE = 100;
/** Keys per `key in (...)` batch when loading ancestors. */
export const KEY_CHUNK = 100;

interface SearchPage {
  issues?: CustomIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** All issues matching `jql`, with the given fields (nextPageToken pagination, de-duplicated by key). */
export async function searchIssuesWithFields(
  client: JiraClient,
  jql: string,
  fields: readonly string[],
  opts: RequestOptions = {},
): Promise<CustomIssue[]> {
  return (await searchIssuesLimited(client, jql, fields, Infinity, opts)).issues;
}

/**
 * The first `limit` issues matching `jql` (in the JQL's order). `truncated` = Jira had more. Stops paging at the
 * limit, so a broad query costs at most limit / 100 + 1 pages.
 */
export async function searchIssuesLimited(
  client: JiraClient,
  jql: string,
  fields: readonly string[],
  limit: number,
  opts: RequestOptions = {},
): Promise<{ issues: CustomIssue[]; truncated: boolean }> {
  const out: CustomIssue[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;
  do {
    const page = await client.get<SearchPage>('/rest/api/3/search/jql', {
      jql,
      fields: fields.join(','),
      maxResults: PAGE_SIZE,
      nextPageToken,
    }, opts);
    for (const issue of page.issues ?? []) {
      if (!issue?.key || seen.has(issue.key)) continue;
      if (out.length >= limit) return { issues: out, truncated: true };
      seen.add(issue.key);
      out.push(issue);
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);
  return { issues: out, truncated: false };
}

/**
 * Loads issues by key in batches (`key in (...)`, KEY_CHUNK at a time). Jira rejects the whole query (400) if any
 * key is unknown or not visible, so a rejected batch is retried key by key; keys that still fail are returned in
 * `unavailable`. Other errors (auth, network, ...) propagate.
 */
export async function fetchIssuesByKeys(
  client: JiraClient,
  keys: readonly string[],
  fields: readonly string[],
  opts: RequestOptions = {},
): Promise<{ issues: CustomIssue[]; unavailable: string[] }> {
  const query = (ks: readonly string[]) => `key in (${ks.map(jqlString).join(', ')})`;
  const load = async (ks: readonly string[]): Promise<CustomIssue[]> => {
    try {
      return await searchIssuesWithFields(client, query(ks), fields, opts);
    } catch (err) {
      if (!(err instanceof JiraError && err.status === 400)) throw err;
      if (ks.length === 1) return [];
      const out: CustomIssue[] = [];
      for (const k of ks) out.push(...(await load([k])));
      return out;
    }
  };

  const issues: CustomIssue[] = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) issues.push(...(await load(keys.slice(i, i + KEY_CHUNK))));
  const got = new Set(issues.map((x) => x.key.toUpperCase()));
  const unavailable = keys.filter((k) => !got.has(k.toUpperCase()));
  return { issues, unavailable };
}
