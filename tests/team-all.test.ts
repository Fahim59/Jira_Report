import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../src/services/custom/engine.js';
import type { TemplateReport } from '../src/services/custom/result.js';
import { CUSTOM_PRESET, DEFAULT_PRESET, GROUP_PRESETS, mergeReports, presetFor, type SiteNode } from '../web/teamall/merge.js';
import { buildPivot } from '../web/team/logic.js';

const H = 3600;
const node = (fieldId: string, value: string, label: string, periods: Record<string, number>, children: TreeNode[] = []): TreeNode => ({
  fieldId,
  value,
  label,
  total: Object.values(periods).reduce((s, v) => s + v, 0),
  periods,
  columns: {},
  worklogIds: [`${fieldId}:${value}`],
  issueCount: 1,
  worklogCount: 1,
  children,
});

/** A site's report grouped by user (level 1) and project (level 2). */
function report(site: string, nodes: TreeNode[], extra: Partial<TemplateReport> = {}): { site: string; report: TemplateReport } {
  const total = nodes.reduce((s, n) => s + n.total, 0);
  const periods: Record<string, number> = {};
  for (const n of nodes) for (const [k, v] of Object.entries(n.periods)) periods[k] = (periods[k] ?? 0) + v;
  return {
    site,
    report: {
      from: '2026-06-01',
      to: '2026-06-02',
      sheets: [
        {
          name: 'Team Reports',
          mode: 'group',
          total,
          showTotals: true,
          headers: { groupBy: ['Work Log Author', 'Project'], columns: [], total: 'Total' },
          worklogIds: [],
          tree: { periodKeys: ['2026-06-01', '2026-06-02'], nodes, total, periods, issueCount: nodes.length },
        },
      ],
      worklogs: [],
      issues: [],
      hoursPerDay: 8,
      retrievedAt: `2026-10-22T10:0${site === 'a' ? 1 : 2}:00+06:00`,
      complete: true,
      failedIssueKeys: [],
      warnings: [],
      ...extra,
    } as unknown as TemplateReport,
  };
}

const userAnn = (project: string, p: Record<string, number>) => node('worklog.author', 'u1', 'Ann', p, [node('project', project, project, p)]);
const a = () => report('a', [userAnn('WEB', { '2026-06-01': 4 * H })]);
const b = () => report('b', [userAnn('ERP', { '2026-06-01': 2 * H, '2026-06-02': 3 * H })]);

describe('mergeReports', () => {
  it('the same person on two sites is one row, their projects stay apart, time adds up', () => {
    const m = mergeReports([a(), b()], ['worklog.author', 'project']);
    const sheet = m.sheets[0]!;
    if (sheet.mode !== 'group') throw new Error('group sheet expected');
    expect(sheet.tree.nodes.map((n) => [n.label, n.total / H])).toEqual([['Ann', 9]]);
    expect(sheet.tree.nodes[0]!.children.map((c) => [c.label, c.total / H])).toEqual([
      ['ERP (b)', 5],
      ['WEB (a)', 4],
    ]);
    expect(sheet.tree.total / H).toBe(9);
    expect(sheet.tree.periods['2026-06-01']! / H).toBe(6);
    expect(sheet.headers.groupBy).toEqual(['Work Log Author', 'Project']);
    expect(m.site).toBeUndefined();
  });

  it('a Site level can sit first, in the middle or last', () => {
    const first = mergeReports([a(), b()], ['site', 'worklog.author', 'project']).sheets[0]!;
    if (first.mode !== 'group') throw new Error();
    expect(first.headers.groupBy).toEqual(['Site', 'Work Log Author', 'Project']);
    expect(first.tree.nodes.map((n) => [n.label, n.total / H, n.children[0]!.label, n.children[0]!.children[0]!.label])).toEqual([
      ['a', 4, 'Ann', 'WEB (a)'],
      ['b', 5, 'Ann', 'ERP (b)'],
    ]);

    const middle = mergeReports([a(), b()], ['worklog.author', 'site', 'project']).sheets[0]!;
    if (middle.mode !== 'group') throw new Error();
    expect(middle.headers.groupBy).toEqual(['Work Log Author', 'Site', 'Project']);
    expect(middle.tree.nodes[0]!.total / H).toBe(9);
    expect(middle.tree.nodes[0]!.children.map((c) => [c.label, c.total / H, c.children[0]!.label])).toEqual([['a', 4, 'WEB (a)'], ['b', 5, 'ERP (b)']]);

    const last = mergeReports([a(), b()], ['worklog.author', 'project', 'site']).sheets[0]!;
    if (last.mode !== 'group') throw new Error();
    expect(last.headers.groupBy).toEqual(['Work Log Author', 'Project', 'Site']);
    const erp = last.tree.nodes[0]!.children.find((c) => c.label === 'ERP (b)')!;
    expect(erp.children.map((c) => [c.fieldId, c.label, c.total / H])).toEqual([['site', 'b', 5]]);
  });

  it('only Site: one row per site, no other level', () => {
    const m = mergeReports([a(), b()], ['site']).sheets[0]!;
    if (m.mode !== 'group') throw new Error();
    expect(m.headers.groupBy).toEqual(['Site']);
    expect(m.tree.nodes.map((n) => [n.label, n.total / H, n.children.length])).toEqual([['a', 4, 0], ['b', 5, 0]]);
    const pivot = buildPivot(m, 'day');
    expect(pivot.rows.map((r) => r.amounts.map((x) => x / H))).toEqual([[4, 0], [2, 3]]);
  });

  it('issues with the same key on two sites are not merged and remember their site', () => {
    const issue = (site: string, p: number) => report(site, [node('issue.key', 'WEB-1', 'WEB-1', { '2026-06-01': p * H })]);
    const m = mergeReports([issue('a', 1), issue('b', 2)], ['issue.key']).sheets[0]!;
    if (m.mode !== 'group') throw new Error();
    expect(m.tree.nodes.map((n) => [n.label, (n as SiteNode).site, n.total / H])).toEqual([['WEB-1', 'a', 1], ['WEB-1', 'b', 2]]);
  });

  it('merges the rest: complete, warnings, failed keys, failed sites', () => {
    const x = report('a', [], { complete: false, failedIssueKeys: ['WEB-9'], failureReasons: ['1 issue(s): Jira rate limit'], warnings: ['careful'] });
    const m = mergeReports([x, b()], ['worklog.author'], [{ site: 'c', error: 'HTTP 403' }]);
    expect(m.complete).toBe(false);
    expect(m.failedIssueKeys).toEqual(['a:WEB-9']);
    expect(m.warnings).toEqual(['a: careful']);
    expect(m.failureReasons).toEqual(['a: 1 issue(s): Jira rate limit', 'c: could not be read (HTTP 403)']);
    expect(m.retrievedAt).toBe('2026-10-22T10:02:00+06:00');
    expect(mergeReports([b()], ['worklog.author']).complete).toBe(true);
    expect(() => mergeReports([], [])).toThrow(/No site/);
  });

  it('a single site passes through with plain labels', () => {
    const m = mergeReports([a()], ['worklog.author', 'project']).sheets[0]!;
    if (m.mode !== 'group') throw new Error();
    expect(m.tree.nodes[0]!.children[0]!.label).toBe('WEB');
  });
});

describe('Group by presets', () => {
  it('each preset is recognised from its fields, anything else is custom', () => {
    for (const p of GROUP_PRESETS) expect(presetFor(p.groupBy)).toBe(p.id);
    expect(presetFor(['project', 'worklog.author'])).toBe('project-user');
    expect(presetFor(['status'])).toBe(CUSTOM_PRESET);
    expect(presetFor([])).toBe(CUSTOM_PRESET);
    expect(GROUP_PRESETS.some((p) => p.id === DEFAULT_PRESET)).toBe(true);
    expect(new Set(GROUP_PRESETS.map((p) => p.id)).size).toBe(GROUP_PRESETS.length);
  });
});
