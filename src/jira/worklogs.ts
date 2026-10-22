import { DateTime } from 'luxon';
import type { IssueInfo, IssueWorklogs, JiraWorklog, JiraWorklogPage, WorklogFetchResult } from '../types.js';
import type { JiraClient, RequestOptions } from './client.js';

const PAGE_SIZE = 1000;

export interface StartedWindow {
  startedAfter: number; // epoch ms
  startedBefore: number; // epoch ms
}

/**
 * Epoch-ms window for the worklog endpoint: start of (from - 1 day) to start of (to + 2 days) in REPORT_TZ.
 * Deliberately generous; exact [from, to] filtering on the REPORT_TZ calendar date is done afterwards.
 */
export function startedWindow(from: string, to: string, zone: string): StartedWindow {
  const start = DateTime.fromISO(from, { zone }).startOf('day').minus({ days: 1 });
  const end = DateTime.fromISO(to, { zone }).startOf('day').plus({ days: 2 });
  if (!start.isValid || !end.isValid) throw new Error(`Invalid date range: ${from}..${to}`);
  return { startedAfter: start.toMillis(), startedBefore: end.toMillis() };
}

/** All worklogs on one issue within the window (startAt/maxResults/total pagination). */
export async function fetchIssueWorklogs(
  client: JiraClient,
  issueKey: string,
  window: StartedWindow,
  opts: RequestOptions = {},
): Promise<JiraWorklog[]> {
  const out: JiraWorklog[] = [];
  let startAt = 0;
  for (;;) {
    const page = await client.get<JiraWorklogPage>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`, {
      startAt,
      maxResults: PAGE_SIZE,
      startedAfter: window.startedAfter,
      startedBefore: window.startedBefore,
    }, opts);
    const batch = page.worklogs ?? [];
    out.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= page.total) break;
  }
  return out;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Results keep input order.
 * Once `signal` aborts, no new items are started.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface FetchAllOptions {
  concurrency: number;
  onError?: (issueKey: string, err: unknown) => void;
  /** Called after each issue settles (fetched or failed). */
  onProgress?: (done: number, total: number) => void;
  /** Cancellation/timeout: rejects with the signal's reason. Never turned into "failed issues". */
  signal?: AbortSignal;
}

/**
 * Fetches worklogs for every issue with bounded concurrency. A failure on one issue (after the client's
 * retries) does not abort the rest; its key is reported in failedIssueKeys so the caller can mark the
 * report incomplete. An aborted signal, by contrast, rejects the whole call: a cut-short fetch is not a
 * partial report.
 */
export async function fetchAllWorklogs(
  client: JiraClient,
  issues: IssueInfo[],
  window: StartedWindow,
  opts: FetchAllOptions,
): Promise<WorklogFetchResult> {
  const { signal } = opts;
  const failedIssueKeys: string[] = [];
  let done = 0;
  const settled = await mapLimit(
    issues,
    opts.concurrency,
    async (issue): Promise<IssueWorklogs | undefined> => {
      try {
        return { issue, worklogs: await fetchIssueWorklogs(client, issue.key, window, { signal }) };
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        failedIssueKeys.push(issue.key);
        opts.onError?.(issue.key, err);
        return undefined;
      } finally {
        if (!signal?.aborted) opts.onProgress?.(++done, issues.length);
      }
    },
    signal,
  );
  signal?.throwIfAborted();
  return {
    issues: settled.filter((x): x is IssueWorklogs => x !== undefined),
    failedIssueKeys: failedIssueKeys.sort(),
  };
}
