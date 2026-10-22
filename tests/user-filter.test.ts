import { describe, expect, it } from 'vitest';
import type { JiraClient } from '../src/jira/client.js';
import { buildWorklogJql, JQL_MAX_AUTHORS } from '../src/jira/issues.js';
import { generateReport } from '../src/services/report.js';
import type { JiraWorklog } from '../src/types.js';

const H = 3600;
const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31 };
const range = { from: '2026-10-01', to: '2026-10-02' };

function wl(id: string, started: string, seconds: number, accountId: string, displayName: string): JiraWorklog {
  return { id, issueId: id, started, timeSpentSeconds: seconds, author: { accountId, displayName } };
}

// Like Jira with an author filter that is ignored: search always returns every issue, so the
// in-code accountIds filter is what makes the result exact.
const worklogsByIssue: Record<string, JiraWorklog[]> = {
  'TPX-1': [
    wl('1', '2026-10-01T09:00:00.000+0600', 2 * H, 'acc-a', 'Alice'),
    wl('2', '2026-10-01T10:00:00.000+0600', 3 * H, 'acc-b', 'Bob'),
    wl('3', '2026-10-02T09:00:00.000+0600', 4 * H, 'acc-c', 'Cara'),
  ],
  'TPX-2': [
    wl('4', '2026-10-02T11:00:00.000+0600', 1.5 * H, 'acc-a', 'Alice'),
    wl('5', '2026-10-02T12:00:00.000+0600', 0.5 * H, 'acc-c', 'Cara'),
    wl('6', '2026-10-01T23:30:00.000+0000', 1 * H, 'acc-b', 'Bob'), // Oct 2 05:30 Dhaka
  ],
};

function fakeJira(): JiraClient & { jqls: string[] } {
  const jqls: string[] = [];
  return {
    baseUrl: 'https://example.atlassian.net',
    jqls,
    async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
      if (path === '/rest/api/3/search/jql') {
        jqls.push(String(query?.jql));
        const issues = Object.keys(worklogsByIssue).map((key) => ({ id: key, key, fields: { summary: `S ${key}`, project: { id: '1', key: 'TPX', name: 'TPX' } } }));
        return { issues, isLast: true } as T;
      }
      const key = decodeURIComponent(/\/issue\/([^/]+)\/worklog$/.exec(path)![1]!);
      const worklogs = worklogsByIssue[key]!;
      return { startAt: 0, maxResults: 1000, total: worklogs.length, worklogs } as T;
    },
  };
}

const fixed = <T extends { retrievedAt: string }>(r: T) => ({ ...r, retrievedAt: 'x' });

describe('report filtered by accountIds', () => {
  it('2 selected users: only their rows, with correct totals', async () => {
    const jira = fakeJira();
    const r = await generateReport(jira, cfg, { ...range, accountIds: ['acc-c', 'acc-a'] });

    expect(r.rows.map((x) => x.accountId)).toEqual(['acc-a', 'acc-c']);
    expect(r.rows.find((x) => x.accountId === 'acc-a')).toMatchObject({ byDate: { '2026-10-01': 2 * H, '2026-10-02': 1.5 * H }, total: 3.5 * H });
    expect(r.rows.find((x) => x.accountId === 'acc-c')).toMatchObject({ byDate: { '2026-10-01': 0, '2026-10-02': 4.5 * H }, total: 4.5 * H });
    expect(r.dateTotals).toEqual({ '2026-10-01': 2 * H, '2026-10-02': 6 * H });
    expect(r.grandTotal).toBe(8 * H);
    expect(new Set(r.worklogs.map((w) => w.accountId))).toEqual(new Set(['acc-a', 'acc-c']));
    expect(jira.jqls[0]).toContain('worklogAuthor in ("acc-c", "acc-a")');
  });

  it('empty or missing accountIds equals the all-users report', async () => {
    const all = await generateReport(fakeJira(), cfg, range);
    const empty = await generateReport(fakeJira(), cfg, { ...range, accountIds: [] });
    expect(fixed(empty)).toEqual(fixed(all));
    expect(all.rows.map((x) => x.accountId)).toEqual(['acc-a', 'acc-b', 'acc-c']);
    expect(all.grandTotal).toBe(12 * H);
  });
});

describe('buildWorklogJql author clause', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `acc-${i}`);

  it('uses worklogAuthor in (...) up to the limit', () => {
    expect(buildWorklogJql({ ...range, accountIds: ['a"b'] })).toContain('worklogAuthor in ("a\\"b")');
    expect(buildWorklogJql({ ...range, accountIds: ids(JQL_MAX_AUTHORS) })).toContain('worklogAuthor in (');
  });

  it('omits worklogAuthor when empty or above the limit', () => {
    expect(buildWorklogJql({ ...range, accountIds: [] })).not.toContain('worklogAuthor');
    expect(buildWorklogJql({ ...range, accountIds: ids(JQL_MAX_AUTHORS + 1) })).not.toContain('worklogAuthor');
  });
});
