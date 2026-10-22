import type { NormalizedWorklog, Report } from '../src/types.js';

// Pure (DOM-free) so it can be unit tested in node; render.ts draws the result.

export interface DrilldownGroup {
  accountId: string;
  user: string;
  worklogs: NormalizedWorklog[];
  total: number; // seconds
}

export interface Drilldown {
  date: string;
  groups: DrilldownGroup[];
  total: number; // seconds; equals the clicked matrix cell
}

/**
 * Worklogs behind one matrix cell, taken from the report already on screen (no Jira calls).
 * With accountId: that user's cell (one group). Without: the TOTAL-row cell, grouped by user
 * in the matrix's row order.
 */
export function drilldown(report: Report, date: string, accountId?: string): Drilldown {
  const byUser = new Map<string, DrilldownGroup>();
  for (const wl of report.worklogs) {
    if (wl.date !== date || (accountId !== undefined && wl.accountId !== accountId)) continue;
    let group = byUser.get(wl.accountId);
    if (!group) {
      group = { accountId: wl.accountId, user: wl.user, worklogs: [], total: 0 };
      byUser.set(wl.accountId, group);
    }
    group.worklogs.push(wl);
    group.total += wl.seconds;
  }

  const rowOrder = new Map(report.rows.map((r, i) => [r.accountId, i]));
  const groups = [...byUser.values()].sort(
    (a, b) => (rowOrder.get(a.accountId) ?? Infinity) - (rowOrder.get(b.accountId) ?? Infinity) || a.user.localeCompare(b.user),
  );
  return { date, groups, total: groups.reduce((sum, g) => sum + g.total, 0) };
}
