import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/services/report.js';
import type { NormalizedWorklog } from '../src/types.js';
import { drilldown } from '../web/drilldown.js';

const H = 3600;

function nw(id: string, date: string, accountId: string, user: string, seconds: number, issueKey = 'TPX-1'): NormalizedWorklog {
  return { id, date, accountId, user, issueKey, summary: 's', project: 'TPX', seconds };
}

const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
const report = buildReport({
  from: '2026-10-01',
  to: '2026-10-03',
  dates,
  failedIssueKeys: [],
  retrievedAt: '2026-10-06T12:00:00+06:00',
  worklogs: [
    nw('1', '2026-10-01', 'acc-z', 'Zed', 2 * H),
    nw('2', '2026-10-01', 'acc-a', 'Alice', 7.5 * H),
    nw('3', '2026-10-03', 'acc-a', 'Alice', 1 * H, 'TPX-2'),
    nw('4', '2026-10-03', 'acc-a', 'Alice', 0.25 * H, 'TPX-3'),
    nw('5', '2026-10-01', 'acc-z', 'Zed', 1 * H, 'TPX-2'),
    nw('6', '2026-10-03', 'acc-a2', 'Alice', 3 * H), // same display name, different account
  ],
});

describe('drilldown', () => {
  it('user cell: only that user and date, total equals the cell', () => {
    const d = drilldown(report, '2026-10-03', 'acc-a');
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.worklogs.map((w) => w.id)).toEqual(['3', '4']);
    expect(d.total).toBe(1.25 * H);
  });

  it('TOTAL-row cell: all users for the date, grouped by user in matrix row order', () => {
    const d = drilldown(report, '2026-10-01');
    expect(d.groups.map((g) => [g.accountId, g.total])).toEqual([
      ['acc-a', 7.5 * H],
      ['acc-z', 3 * H],
    ]);
    expect(d.groups[1]!.worklogs.map((w) => w.id)).toEqual(['1', '5']);
    expect(d.total).toBe(10.5 * H);
  });

  it('keeps users with the same display name apart (grouped by accountId)', () => {
    const d = drilldown(report, '2026-10-03');
    expect(d.groups.map((g) => g.accountId).sort()).toEqual(['acc-a', 'acc-a2']);
  });

  it('empty for a 0h cell', () => {
    expect(drilldown(report, '2026-10-02')).toEqual({ date: '2026-10-02', groups: [], total: 0 });
    expect(drilldown(report, '2026-10-01', 'acc-a2').total).toBe(0);
  });

  it('every matrix cell equals its drill-down total', () => {
    for (const date of dates) {
      expect(drilldown(report, date).total).toBe(report.dateTotals[date]);
      for (const row of report.rows) {
        const d = drilldown(report, date, row.accountId);
        expect(d.total).toBe(row.byDate[date]);
        expect(d.groups.reduce((s, g) => s + g.worklogs.reduce((t, w) => t + w.seconds, 0), 0)).toBe(d.total);
      }
    }
  });
});
