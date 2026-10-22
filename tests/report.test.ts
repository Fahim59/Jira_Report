import { describe, expect, it } from 'vitest';
import { buildReport, dateRange, RangeValidationError } from '../src/services/report.js';
import type { NormalizedWorklog } from '../src/types.js';

const H = 3600;

function nw(id: string, date: string, accountId: string, user: string, seconds: number, issueKey = 'TPX-1'): NormalizedWorklog {
  return { id, date, accountId, user, issueKey, summary: 's', project: 'TPX', seconds };
}

const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
const base = { from: '2026-10-01', to: '2026-10-03', dates, failedIssueKeys: [], retrievedAt: '2026-10-06T12:00:00+06:00' };

describe('dateRange', () => {
  it('lists every date inclusive', () => {
    expect(dateRange('2026-09-29', '2026-10-02', 31)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(dateRange('2026-10-01', '2026-10-01', 31)).toEqual(['2026-10-01']);
  });

  it('rejects from > to, ranges over the limit and malformed dates', () => {
    expect(() => dateRange('2026-10-02', '2026-10-01', 31)).toThrow(RangeValidationError);
    expect(dateRange('2026-10-01', '2026-10-31', 31)).toHaveLength(31);
    expect(() => dateRange('2026-10-01', '2026-11-01', 31)).toThrow(/32 days; maximum is 31/);
    expect(() => dateRange('2026-2-01', '2026-10-01', 31)).toThrow(RangeValidationError);
    expect(() => dateRange('2026-02-30', '2026-03-01', 31)).toThrow(RangeValidationError);
  });
});

describe('buildReport', () => {
  const worklogs = [
    nw('1', '2026-10-01', 'acc-b', 'Bob', 2 * H),
    nw('2', '2026-10-01', 'acc-a', 'Alice', 7.5 * H),
    nw('3', '2026-10-03', 'acc-a', 'Alice', 1 * H, 'TPX-2'),
    nw('4', '2026-10-03', 'acc-a', 'Alice', 0.5 * H, 'TPX-3'),
    nw('5', '2026-10-01', 'acc-b', 'Bob', 1 * H, 'TPX-2'),
  ];
  const r = buildReport({ ...base, worklogs });

  it('shows 0h days for every user and in date totals', () => {
    expect(r.dates).toEqual(dates);
    const alice = r.rows.find((x) => x.accountId === 'acc-a')!;
    const bob = r.rows.find((x) => x.accountId === 'acc-b')!;
    expect(alice.byDate).toEqual({ '2026-10-01': 7.5 * H, '2026-10-02': 0, '2026-10-03': 1.5 * H });
    expect(bob.byDate).toEqual({ '2026-10-01': 3 * H, '2026-10-02': 0, '2026-10-03': 0 });
    expect(r.dateTotals['2026-10-02']).toBe(0);
  });

  it('computes user totals', () => {
    expect(r.rows.map((x) => [x.user, x.total])).toEqual([
      ['Alice', 9 * H],
      ['Bob', 3 * H],
    ]);
  });

  it('computes daily totals and the grand total consistently', () => {
    expect(r.dateTotals).toEqual({ '2026-10-01': 10.5 * H, '2026-10-02': 0, '2026-10-03': 1.5 * H });
    expect(r.grandTotal).toBe(12 * H);
    const sumRows = r.rows.reduce((s, x) => s + x.total, 0);
    const sumDays = Object.values(r.dateTotals).reduce((s, x) => s + x, 0);
    expect(sumRows).toBe(r.grandTotal);
    expect(sumDays).toBe(r.grandTotal);
  });

  it('rows come only from people who logged time, sorted by name', () => {
    expect(r.rows.map((x) => x.user)).toEqual(['Alice', 'Bob']);
  });

  it('ignores worklogs outside the date list', () => {
    const r2 = buildReport({ ...base, worklogs: [...worklogs, nw('9', '2026-10-04', 'acc-c', 'Carol', 8 * H)] });
    expect(r2.grandTotal).toBe(12 * H);
    expect(r2.rows.map((x) => x.user)).toEqual(['Alice', 'Bob']);
    expect(r2.worklogs).toHaveLength(5);
  });

  it('empty range still has all dates with 0 totals', () => {
    const empty = buildReport({ ...base, worklogs: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.dateTotals).toEqual({ '2026-10-01': 0, '2026-10-02': 0, '2026-10-03': 0 });
    expect(empty.grandTotal).toBe(0);
    expect(empty.complete).toBe(true);
  });

  it('is incomplete when any issue failed', () => {
    const bad = buildReport({ ...base, worklogs, failedIssueKeys: ['TPX-9', 'TPX-2', 'TPX-9'] });
    expect(bad.complete).toBe(false);
    expect(bad.failedIssueKeys).toEqual(['TPX-2', 'TPX-9']);
  });
});
