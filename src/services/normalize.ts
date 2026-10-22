import { DateTime } from 'luxon';
import type { IssueWorklogs, NormalizedWorklog } from '../types.js';

export interface NormalizeOptions {
  /** Inclusive calendar-date range in `zone` (yyyy-MM-dd). */
  from: string;
  to: string;
  zone: string;
  /** If non-empty, only worklogs authored by these accounts are kept. */
  accountIds?: string[];
}

export interface InvalidWorklog {
  issueKey: string;
  worklogId: string;
  started: string;
}

export interface NormalizeResult {
  worklogs: NormalizedWorklog[];
  /** Worklogs whose `started` could not be parsed; they cannot be dated, so the report is not complete. */
  invalid: InvalidWorklog[];
}

/** Calendar date (yyyy-MM-dd) of a Jira `started` timestamp in `zone`, or undefined if unparseable. */
export function reportDate(started: string, zone: string): string | undefined {
  const dt = DateTime.fromISO(started, { setZone: true });
  if (!dt.isValid) return undefined;
  return dt.setZone(zone).toISODate() ?? undefined;
}

/**
 * Flattens fetched worklogs into report rows. Uses `started` (never `created`), converts it to `zone`,
 * takes the calendar date and keeps only dates within [from, to].
 */
export function normalizeWorklogs(fetched: IssueWorklogs[], opts: NormalizeOptions): NormalizeResult {
  const worklogs: NormalizedWorklog[] = [];
  const invalid: InvalidWorklog[] = [];
  const authors = opts.accountIds?.length ? new Set(opts.accountIds) : undefined;

  for (const { issue, worklogs: raw } of fetched) {
    for (const wl of raw) {
      const date = reportDate(wl.started, opts.zone);
      if (date === undefined) {
        invalid.push({ issueKey: issue.key, worklogId: wl.id, started: wl.started });
        continue;
      }
      // yyyy-MM-dd strings compare correctly as plain strings.
      if (date < opts.from || date > opts.to) continue;
      const accountId = wl.author?.accountId ?? 'unknown';
      if (authors && !authors.has(accountId)) continue;

      worklogs.push({
        id: wl.id,
        date,
        accountId,
        user: wl.author?.displayName ?? accountId,
        issueKey: issue.key,
        summary: issue.summary,
        project: issue.projectKey,
        seconds: wl.timeSpentSeconds,
      });
    }
  }

  return { worklogs, invalid };
}
