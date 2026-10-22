import { describe, expect, it } from 'vitest';
import { normalizeWorklogs, reportDate } from '../src/services/normalize.js';
import type { IssueWorklogs, JiraWorklog } from '../src/types.js';

const ZONE = 'Asia/Dhaka'; // UTC+6, no DST

function wl(id: string, started: string, seconds: number, accountId = 'acc-a', displayName = 'Alice'): JiraWorklog {
  return { id, issueId: '1', started, timeSpentSeconds: seconds, author: { accountId, displayName } };
}

function issue(key: string, worklogs: JiraWorklog[]): IssueWorklogs {
  return { issue: { key, summary: `Summary ${key}`, projectKey: 'TPX', projectName: 'Test Project' }, worklogs };
}

describe('reportDate (timezone midnight edge)', () => {
  it('uses the REPORT_TZ calendar date, not UTC or the author offset', () => {
    // 17:59:59Z = 23:59:59 in Dhaka -> still Oct 1
    expect(reportDate('2026-10-01T17:59:59.000+0000', ZONE)).toBe('2026-10-01');
    // 18:00:00Z = 00:00:00 in Dhaka -> Oct 2
    expect(reportDate('2026-10-01T18:00:00.000+0000', ZONE)).toBe('2026-10-02');
    // Author in a US zone logging late evening Sep 30 local = Oct 1 morning in Dhaka
    expect(reportDate('2026-09-30T22:00:00.000-0400', ZONE)).toBe('2026-10-01');
    // Jira offset format without a colon, already in Dhaka time
    expect(reportDate('2026-10-01T00:00:00.000+0600', ZONE)).toBe('2026-10-01');
    expect(reportDate('2026-10-01T23:59:59.999+0600', ZONE)).toBe('2026-10-01');
  });

  it('returns undefined for unparseable timestamps', () => {
    expect(reportDate('not-a-date', ZONE)).toBeUndefined();
  });
});

describe('normalizeWorklogs', () => {
  const opts = { from: '2026-10-01', to: '2026-10-02', zone: ZONE };

  it('maps fields and filters to the exact [from, to] range in REPORT_TZ', () => {
    const { worklogs, invalid } = normalizeWorklogs(
      [
        issue('TPX-1', [
          wl('1', '2026-09-30T17:59:59.000+0000', 100), // Sep 30 23:59:59 Dhaka -> out
          wl('2', '2026-09-30T18:00:00.000+0000', 200), // Oct 1 00:00 Dhaka -> in
          wl('3', '2026-10-02T17:59:59.000+0000', 300), // Oct 2 23:59:59 Dhaka -> in
          wl('4', '2026-10-02T18:00:00.000+0000', 400), // Oct 3 00:00 Dhaka -> out
        ]),
      ],
      opts,
    );
    expect(invalid).toEqual([]);
    expect(worklogs).toEqual([
      { id: '2', date: '2026-10-01', accountId: 'acc-a', user: 'Alice', issueKey: 'TPX-1', summary: 'Summary TPX-1', project: 'TPX', seconds: 200 },
      { id: '3', date: '2026-10-02', accountId: 'acc-a', user: 'Alice', issueKey: 'TPX-1', summary: 'Summary TPX-1', project: 'TPX', seconds: 300 },
    ]);
  });

  it('keeps only the requested authors when accountIds is given; empty = everyone', () => {
    const fetched = [
      issue('TPX-1', [
        wl('1', '2026-10-01T09:00:00.000+0600', 3600, 'acc-a', 'Alice'),
        wl('2', '2026-10-01T09:00:00.000+0600', 3600, 'acc-b', 'Bob'),
        wl('3', '2026-10-01T09:00:00.000+0600', 3600, 'acc-c', 'Cara'),
      ]),
    ];
    expect(normalizeWorklogs(fetched, { ...opts, accountIds: ['acc-c', 'acc-b'] }).worklogs.map((w) => w.user)).toEqual(['Bob', 'Cara']);
    expect(normalizeWorklogs(fetched, { ...opts, accountIds: [] }).worklogs).toHaveLength(3);
  });

  it('reports unparseable started values instead of silently dropping them', () => {
    const { worklogs, invalid } = normalizeWorklogs([issue('TPX-9', [wl('7', 'garbage', 3600)])], opts);
    expect(worklogs).toEqual([]);
    expect(invalid).toEqual([{ issueKey: 'TPX-9', worklogId: '7', started: 'garbage' }]);
  });

  it('falls back to accountId when the author has no display name', () => {
    const raw = wl('1', '2026-10-01T09:00:00.000+0600', 60);
    delete raw.author;
    const { worklogs } = normalizeWorklogs([issue('TPX-1', [raw])], opts);
    expect(worklogs[0]).toMatchObject({ accountId: 'unknown', user: 'unknown' });
  });
});
