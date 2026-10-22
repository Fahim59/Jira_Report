import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { JiraClient } from '../jira/client.js';
import { shortFailureReason } from '../jira/errors.js';
import { searchIssuesWithWorklogs } from '../jira/issues.js';
import { resolveProjectKey } from '../jira/projects.js';
import { fetchAllWorklogs, startedWindow } from '../jira/worklogs.js';
import type { NormalizedWorklog, Report, ReportFilter, ReportRow } from '../types.js';
import { normalizeWorklogs, type InvalidWorklog } from './normalize.js';

/** Thrown for bad user input (maps to HTTP 400 / probe usage error). */
export class RangeValidationError extends Error {
  override readonly name = 'RangeValidationError';
}

/** Project key not in Jira's project list (maps to HTTP 400). */
export class UnknownProjectError extends Error {
  override readonly name = 'UnknownProjectError';
  constructor(readonly projectKey: string) {
    super(`Unknown project key "${projectKey}". Pick a project from the list.`);
  }
}

/** The report was stopped before finishing: by its deadline or by the caller. No partial data is returned. */
export class ReportAbortedError extends Error {
  override readonly name = 'ReportAbortedError';
  constructor(
    readonly reason: 'timeout' | 'cancelled',
    message: string,
  ) {
    super(message);
  }
}

/** Most users a single report may be filtered to (POST /api/report, probe --user). */
export const MAX_ACCOUNT_IDS = 50;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates [from, to] and returns every calendar date in it (inclusive).
 * Rejects malformed dates, from > to and ranges longer than maxDays.
 */
export function dateRange(from: string, to: string, maxDays: number): string[] {
  const start = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  if (!ISO_DATE.test(from) || !start.isValid) throw new RangeValidationError(`invalid from date: ${from}`);
  if (!ISO_DATE.test(to) || !end.isValid) throw new RangeValidationError(`invalid to date: ${to}`);
  if (start > end) throw new RangeValidationError('from must be on or before to');
  const days = Math.round(end.diff(start, 'days').days) + 1;
  if (days > maxDays) throw new RangeValidationError(`range is ${days} days; maximum is ${maxDays}`);
  return Array.from({ length: days }, (_, i) => start.plus({ days: i }).toISODate()!);
}

export interface BuildReportInput {
  from: string;
  to: string;
  project?: string;
  dates: string[];
  worklogs: NormalizedWorklog[];
  failedIssueKeys: string[];
  failureReasons?: string[];
  retrievedAt: string;
}

/** Aggregates normalized worklogs into the user × date matrix. Every date is present (0 when no time). */
export function buildReport(input: BuildReportInput): Report {
  const { dates } = input;
  const zeroes = () => Object.fromEntries(dates.map((d) => [d, 0])) as Record<string, number>;
  const dateSet = new Set(dates);
  const rowsById = new Map<string, ReportRow>();
  const dateTotals = zeroes();
  let grandTotal = 0;
  const kept: NormalizedWorklog[] = [];

  for (const wl of input.worklogs) {
    if (!dateSet.has(wl.date)) continue;
    let row = rowsById.get(wl.accountId);
    if (!row) {
      row = { accountId: wl.accountId, user: wl.user, byDate: zeroes(), total: 0 };
      rowsById.set(wl.accountId, row);
    }
    row.byDate[wl.date]! += wl.seconds;
    row.total += wl.seconds;
    dateTotals[wl.date]! += wl.seconds;
    grandTotal += wl.seconds;
    kept.push(wl);
  }

  const rows = [...rowsById.values()].sort((a, b) => a.user.localeCompare(b.user) || a.accountId.localeCompare(b.accountId));
  kept.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.user.localeCompare(b.user) ||
      a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  const failedIssueKeys = [...new Set(input.failedIssueKeys)].sort();

  return {
    from: input.from,
    to: input.to,
    ...(input.project ? { project: input.project } : {}),
    dates,
    rows,
    dateTotals,
    grandTotal,
    worklogs: kept,
    retrievedAt: input.retrievedAt,
    complete: failedIssueKeys.length === 0,
    failedIssueKeys,
    ...(failedIssueKeys.length && input.failureReasons?.length ? { failureReasons: input.failureReasons } : {}),
  };
}

export type ReportStage = 'validating' | 'searching' | 'worklogs' | 'processing';

export interface GenerateHooks {
  onStage?: (stage: ReportStage) => void;
  onIssues?: (count: number) => void;
  onWorklogProgress?: (done: number, total: number) => void;
  onWorklogError?: (issueKey: string, err: unknown) => void;
  onInvalidWorklog?: (w: InvalidWorklog) => void;
}

export interface GenerateOptions {
  /** Caller cancellation (client disconnected, Cancel pressed). */
  signal?: AbortSignal;
  /** Deadline for the whole report; omitted or 0 = none. */
  timeoutMs?: number;
}

/** "3 issue(s): reason" lines, most frequent first. */
export function summarizeFailures(reasons: string[]): string[] {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} issue(s): ${r}`);
}

/**
 * One signal for a whole report: aborts with ReportAbortedError('cancelled') when the caller's signal aborts,
 * or ReportAbortedError('timeout') when opts.timeoutMs passes. Call dispose() when the report settles.
 */
export function startDeadline(opts: GenerateOptions): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const onCallerAbort = () => ac.abort(new ReportAbortedError('cancelled', 'Report cancelled.'));
  if (opts.signal?.aborted) onCallerAbort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        const secs = Math.round(opts.timeoutMs! / 1000);
        ac.abort(
          new ReportAbortedError(
            'timeout',
            `Report timed out after ${secs}s and was stopped, so no data is shown. Jira may be slow; try a shorter range, one project, or fewer users.`,
          ),
        );
      }, opts.timeoutMs)
    : undefined;
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Full pipeline: validate project -> JQL search -> per-issue worklog fetch -> normalize -> aggregate.
 * Rejects with ReportAbortedError on timeout/cancel (in-flight Jira calls are aborted too).
 */
export async function generateReport(
  client: JiraClient,
  cfg: Pick<Config, 'REPORT_TZ' | 'JIRA_CONCURRENCY' | 'MAX_RANGE_DAYS'>,
  filter: ReportFilter,
  hooks: GenerateHooks = {},
  opts: GenerateOptions = {},
): Promise<Report> {
  const zone = cfg.REPORT_TZ;
  const dates = dateRange(filter.from, filter.to, cfg.MAX_RANGE_DAYS);

  const deadline = startDeadline(opts);
  const { signal } = deadline;

  try {
    signal.throwIfAborted();
    let project = filter.project;
    if (project) {
      hooks.onStage?.('validating');
      project = await resolveProjectKey(client, project, { signal });
      if (!project) throw new UnknownProjectError(filter.project!);
    }
    const effective: ReportFilter = { ...filter, project };

    hooks.onStage?.('searching');
    const issues = await searchIssuesWithWorklogs(client, effective, { signal });
    hooks.onIssues?.(issues.length);

    hooks.onStage?.('worklogs');
    const reasons: string[] = [];
    const fetched = await fetchAllWorklogs(client, issues, startedWindow(filter.from, filter.to, zone), {
      concurrency: cfg.JIRA_CONCURRENCY,
      signal,
      onProgress: hooks.onWorklogProgress,
      onError: (key, err) => {
        reasons.push(shortFailureReason(err));
        hooks.onWorklogError?.(key, err);
      },
    });

    hooks.onStage?.('processing');
    const { worklogs, invalid } = normalizeWorklogs(fetched.issues, { from: filter.from, to: filter.to, zone, accountIds: filter.accountIds });
    invalid.forEach((w) => {
      reasons.push('unparseable worklog start time');
      hooks.onInvalidWorklog?.(w);
    });
    // Deadline hit while finishing up: still not presented as a report.
    signal.throwIfAborted();

    return buildReport({
      from: filter.from,
      to: filter.to,
      project,
      dates,
      worklogs,
      // An undatable worklog means that issue's numbers are unreliable: treat it like a failed fetch.
      failedIssueKeys: [...fetched.failedIssueKeys, ...invalid.map((w) => w.issueKey)],
      failureReasons: summarizeFailures(reasons),
      retrievedAt: DateTime.now().setZone(zone).startOf('second').toISO({ suppressMilliseconds: true })!,
    });
  } finally {
    deadline.dispose();
  }
}
