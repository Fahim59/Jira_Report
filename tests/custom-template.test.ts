import { describe, expect, it } from 'vitest';
import { buildTree, ValueResolver, type CustomIssue, type CustomWorklog } from '../src/services/custom/engine.js';
import { runTemplate, type FlatSheetResult, type GroupSheetResult, type TemplateData } from '../src/services/custom/sheets.js';
import {
  GlobalFilterSchema,
  MAX_LABEL,
  MAX_SHEETS,
  refHeader,
  SheetSchema,
  TemplateBodySchema,
  templateFieldIds,
  totalHeader,
  type TemplateBody,
} from '../src/services/custom/template.js';

const H = 3600;
const CF = 'customfield_10050'; // "Client Reference"
const LABELS = 'labels';
const STORY = { name: 'Story', subtask: false, hierarchyLevel: 0 };
const SUBTASK = { name: 'Sub-task', subtask: true, hierarchyLevel: -1 };
const FFN = { key: 'FFN', name: 'Fun Fun' };
const IOIA = { key: 'IOIA', name: 'Io Ia' };

const issue = (key: string, fields: Record<string, unknown>): CustomIssue => ({
  id: String(1000 + Number(key.split('-')[1])),
  key,
  fields: { issuetype: STORY, project: FFN, ...fields },
});

const ISSUES: CustomIssue[] = [
  issue('FFN-1', {
    summary: 'Login',
    status: { name: 'Done' },
    [CF]: 'TPX-65',
    [LABELS]: ['backend', 'Urgent'],
    assignee: { accountId: 'u1', displayName: 'Alice' },
  }),
  issue('FFN-2', {
    summary: 'Fix login bug',
    issuetype: SUBTASK,
    status: { name: 'In Progress' },
    [CF]: 'TPX-70',
    parent: { id: '1001', key: 'FFN-1', fields: { summary: 'Login', issuetype: STORY } },
  }),
  issue('FFN-10', { summary: 'Docs', status: { name: 'To Do' }, [CF]: null }),
  issue('IOIA-5', { summary: 'Billing', project: IOIA, status: { name: 'Done' }, [CF]: 'TPX-99' }),
];
const TYPES = new Map([
  [CF, 'string'],
  [LABELS, 'array<string>'],
  ['assignee', 'user'],
  ['status', 'status'],
  ['project', 'project'],
]);

let n = 0;
function wl(issueKey: string, started: string, accountId: string, hours: number, comment = ''): CustomWorklog {
  const user = { a: 'Alice', b: 'Bob', c: 'Carol' }[accountId] ?? accountId;
  return {
    id: String(++n),
    date: started.slice(0, 10),
    accountId,
    user,
    issueKey,
    summary: '',
    project: issueKey.split('-')[0]!,
    seconds: hours * H,
    started,
    created: `${started.slice(0, 10)}T20:00:00.000+0600`,
    createdDate: started.slice(0, 10),
    comment,
    attributedTo: issueKey,
  };
}

const WLS: CustomWorklog[] = [
  wl('FFN-1', '2026-09-02T10:00:00.000+0600', 'b', 3, 'review'),
  wl('FFN-1', '2026-09-01T09:00:00.000+0600', 'a', 2, 'Pairing on LOGIN'),
  wl('FFN-2', '2026-09-02T03:30:00.000+0000', 'a', 1.5), // 09:30 Dhaka: after a's 09:00 on Sep 1, before b
  wl('FFN-10', '2026-09-08T11:00:00.000+0600', 'b', 4),
  wl('IOIA-5', '2026-09-03T11:00:00.000+0600', 'c', 0.5),
];
const GLOBAL_TOTAL = 11 * H;

function data(extra: Partial<TemplateData> = {}): TemplateData {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    timeZone: 'Asia/Dhaka',
    worklogs: WLS,
    resolver: new ValueResolver(new Map(ISSUES.map((i) => [i.key, i])), TYPES),
    ...extra,
  };
}

const sheet = (s: object) => SheetSchema.parse({ name: 'S', rows: { mode: 'group', groupBy: ['issue.key'] }, ...s });
const template = (...sheets: object[]): TemplateBody =>
  TemplateBodySchema.parse({ name: 'T', sheets: sheets.map((s, i) => ({ name: `S${i + 1}`, ...s })) });
const run = (t: TemplateBody, d = data()) => runTemplate(d, t);
const flat = (s: object, d = data()) => run(template(s), d)[0] as FlatSheetResult;
const totalOf = (s: object, d = data()) => run(template(s), d)[0]!.total;

describe('template schemas', () => {
  it('fills defaults and accepts the three row modes', () => {
    const t = template(
      { rows: { mode: 'group', groupBy: ['worklog.author', 'issue.key'] }, columns: [CF] },
      { rows: { mode: 'eachWorklog' }, columns: ['worklog.author', 'metric.hours'] },
      { rows: { mode: 'eachIssue' }, columns: ['issue.key', 'metric.hours'] },
    );
    expect(t.defaults).toEqual({ projects: [], authors: [] });
    expect(t.sheets[0]).toMatchObject({
      totals: true, period: 'none', format: 'hours', sumSubtasksToParent: false, sort: 'value', filter: { conditions: [] },
    });
    expect(t.sheets.map((s) => s.rows.mode)).toEqual(['group', 'eachWorklog', 'eachIssue']);
  });

  it('sheet names: Excel rules, unique case-insensitively', () => {
    const bad = (name: string) => SheetSchema.safeParse({ name, rows: { mode: 'eachWorklog' }, columns: ['issue.key'] }).success;
    expect(bad('Work logs')).toBe(true);
    expect(bad('x'.repeat(31))).toBe(true);
    for (const name of ['', '   ', 'x'.repeat(32), 'a:b', 'a/b', 'a\\b', 'a?b', 'a*b', 'a[b', 'a]b', "'quoted'"]) expect(bad(name)).toBe(false);
    const dup = TemplateBodySchema.safeParse({
      name: 'T',
      sheets: [
        { name: 'Report', rows: { mode: 'group', groupBy: ['issue.key'] } },
        { name: 'report', rows: { mode: 'group', groupBy: ['issue.key'] } },
      ],
    });
    expect(dup.success).toBe(false);
    expect(dup.error!.issues[0]!.message).toMatch(/used twice/);
  });

  it(`1..${MAX_SHEETS} sheets; template name required`, () => {
    const s = (i: number) => ({ name: `S${i}`, rows: { mode: 'group', groupBy: ['issue.key'] } });
    expect(TemplateBodySchema.safeParse({ name: 'T', sheets: [] }).success).toBe(false);
    expect(TemplateBodySchema.safeParse({ name: 'T', sheets: Array.from({ length: MAX_SHEETS }, (_, i) => s(i)) }).success).toBe(true);
    expect(TemplateBodySchema.safeParse({ name: 'T', sheets: Array.from({ length: MAX_SHEETS + 1 }, (_, i) => s(i)) }).success).toBe(false);
    expect(TemplateBodySchema.safeParse({ name: ' ', sheets: [s(1)] }).success).toBe(false);
  });

  it('metric.hours: a flat-sheet column only; never group by, a group column or a condition', () => {
    const ok = (s: object) => SheetSchema.safeParse({ name: 'S', ...s }).success;
    expect(ok({ rows: { mode: 'eachWorklog' }, columns: ['metric.hours'] })).toBe(true);
    expect(ok({ rows: { mode: 'eachIssue' }, columns: ['metric.hours'] })).toBe(true);
    expect(ok({ rows: { mode: 'group', groupBy: ['metric.hours'] } })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: ['issue.key'] }, columns: ['metric.hours'] })).toBe(false);
    expect(ok({ rows: { mode: 'eachWorklog' }, columns: ['issue.key'], filter: { conditions: [{ fieldId: 'metric.hours', op: 'isNotEmpty' }] } })).toBe(false);
  });

  it('flat sheets need a column, take no period; each-issue sheets take no worklog fields; group by any number of unique fields (the Custom editor still offers 1–3)', () => {
    const ok = (s: object) => SheetSchema.safeParse({ name: 'S', ...s }).success;
    expect(ok({ rows: { mode: 'eachWorklog' }, columns: [] })).toBe(false);
    expect(ok({ rows: { mode: 'eachWorklog' }, columns: ['issue.key'], period: 'week' })).toBe(false);
    expect(ok({ rows: { mode: 'eachIssue' }, columns: ['worklog.author'] })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: [] } })).toBe(true); // Team Reports: one total per period
    expect(ok({ rows: { mode: 'group', groupBy: ['issue.key', 'status', 'project', 'assignee'] } })).toBe(true);
    expect(ok({ rows: { mode: 'group', groupBy: Array.from({ length: 51 }, (_, i) => `customfield_${i}`) } })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: ['status', 'status'] } })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: ['status'] }, period: 'month' })).toBe(true);
  });

  it('sheet JQL: trimmed, empty → none, structural check (no ORDER BY, balanced parentheses)', () => {
    expect(sheet({ filter: { jql: '  status = Done ' } }).filter.jql).toBe('status = Done');
    expect(sheet({ filter: { jql: '   ' } }).filter.jql).toBeUndefined();
    expect(SheetSchema.safeParse({ name: 'S', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'status = Done ORDER BY key' } }).success).toBe(false);
    expect(SheetSchema.safeParse({ name: 'S', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'status = Done) OR (project = X' } }).success).toBe(false);
  });

  it('global filter = site, dates, projects, authors (de-duplicated); from ≤ to', () => {
    const g = GlobalFilterSchema.parse({ from: '2026-09-01', to: '2026-09-29', projects: ['FFN', 'FFN'], authors: ['a'] });
    expect(g).toEqual({ from: '2026-09-01', to: '2026-09-29', projects: ['FFN'], authors: ['a'], zone: 'server' });
    expect(GlobalFilterSchema.safeParse({ from: '2026-09-02', to: '2026-09-01' }).success).toBe(false);
    expect(GlobalFilterSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });

  it('field union over every sheet (rows, columns, conditions), each id once', () => {
    const t = template(
      { rows: { mode: 'group', groupBy: ['worklog.author', 'issue.key'] }, columns: [CF] },
      { rows: { mode: 'eachWorklog' }, columns: ['issue.key', 'metric.hours'], filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'Done' }] } },
      { rows: { mode: 'eachIssue' }, columns: [CF, 'assignee'] },
    );
    expect(templateFieldIds(t)).toEqual(['worklog.author', 'issue.key', CF, 'metric.hours', 'status', 'assignee']);
  });
});

describe('header labels (columns and group levels)', () => {
  it('accepts fieldId or { fieldId, label }, normalised to { fieldId, label? }; blank labels dropped, labels trimmed', () => {
    const s = sheet({
      rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: ' User ' }, 'issue.key'] },
      columns: [CF, { fieldId: 'status', label: '' }, { fieldId: 'assignee' }],
    });
    expect(s.rows).toEqual({ mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, { fieldId: 'issue.key' }] });
    expect(s.columns).toEqual([{ fieldId: CF }, { fieldId: 'status' }, { fieldId: 'assignee' }]);
  });

  it(`rejects labels over ${MAX_LABEL} chars, unknown keys, bad field ids, and the same field twice in group by (any form)`, () => {
    const ok = (s: object) => SheetSchema.safeParse({ name: 'S', rows: { mode: 'eachWorklog' }, columns: ['issue.key'], ...s }).success;
    expect(ok({ columns: [{ fieldId: 'issue.key', label: 'x'.repeat(MAX_LABEL) }] })).toBe(true);
    expect(ok({ columns: [{ fieldId: 'issue.key', label: 'x'.repeat(MAX_LABEL + 1) }] })).toBe(false);
    expect(ok({ columns: [{ fieldId: 'issue.key', name: 'Key' }] })).toBe(false);
    expect(ok({ columns: [{ label: 'Key' }] })).toBe(false);
    expect(ok({ columns: [{ fieldId: 'not a field', label: 'X' }] })).toBe(false);
    expect(ok({ columns: [42] })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: ['status', { fieldId: 'status', label: 'State' }] }, columns: [] })).toBe(false);
    // The per-mode rules still see the field id inside the object form.
    expect(ok({ rows: { mode: 'group', groupBy: [{ fieldId: 'metric.hours', label: 'H' }] }, columns: [] })).toBe(false);
    expect(ok({ rows: { mode: 'group', groupBy: ['status'] }, columns: [{ fieldId: 'metric.hours', label: 'H' }] })).toBe(false);
    expect(ok({ rows: { mode: 'eachIssue' }, columns: [{ fieldId: 'worklog.author', label: 'Author' }] })).toBe(false);
  });

  it('a repeated column keeps its first occurrence and label; the field union is by id', () => {
    const s = sheet({ rows: { mode: 'eachWorklog' }, columns: [{ fieldId: CF, label: 'Client' }, CF, { fieldId: CF, label: 'Other' }, 'metric.hours'] });
    expect(s.columns).toEqual([{ fieldId: CF, label: 'Client' }, { fieldId: 'metric.hours' }]);
    expect(templateFieldIds({ sheets: [s] })).toEqual([CF, 'metric.hours']);
  });

  it('refHeader / totalHeader: label, else the field name, else the field id', () => {
    const names = new Map([[CF, 'Client Reference']]);
    expect(refHeader({ fieldId: CF, label: 'Client' }, names)).toBe('Client');
    expect(refHeader({ fieldId: CF }, names)).toBe('Client Reference');
    expect(refHeader({ fieldId: CF })).toBe(CF);
    expect(totalHeader({ fieldId: 'worklog.author', label: 'User' }, names)).toBe('Total User');
    expect(totalHeader({ fieldId: CF }, names)).toBe('Total Client Reference');
  });

  it('SheetResult.headers per mode; labels do not change cells, ids or the tree', () => {
    const fieldNames = new Map([[CF, 'Client Reference'], ['issue.key', 'Issue'], ['metric.hours', 'Hours'], ['worklog.author', 'Worklog Author']]);
    const d = data({ fieldNames });
    const [group, logs] = run(
      template(
        { rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, 'issue.key'] }, columns: [CF] },
        { rows: { mode: 'eachWorklog' }, columns: [{ fieldId: 'worklog.author', label: 'Author' }, 'issue.key', { fieldId: 'metric.hours', label: 'Time' }] },
      ),
      d,
    ) as [GroupSheetResult, FlatSheetResult];
    expect(group.headers).toEqual({ groupBy: ['User', 'Issue'], columns: ['Client Reference'], total: 'Total' });
    expect(group.tree).toEqual(
      buildTree({ worklogs: WLS, layout: { groupBy: ['worklog.author', 'issue.key'], columns: [CF], period: 'none', sort: 'value' }, resolver: d.resolver, from: d.from, to: d.to }),
    );
    expect(logs.headers).toEqual({ groupBy: [], columns: ['Author', 'Issue', 'Time'], total: 'Total' });
    expect(logs.columns).toEqual(['worklog.author', 'issue.key', 'metric.hours']);
    expect(logs.showTotals).toBe(true); // Hours column found by id, whatever its label
    expect(logs.rows[0]!.cells).toEqual(['Alice', 'FFN-1', 2 * H]);
  });
});

describe('runTemplate: modes', () => {
  it('group mode = the existing tree on the sheet subset', () => {
    const t = template({ rows: { mode: 'group', groupBy: ['worklog.author', 'issue.key'] }, columns: [CF], period: 'week', sort: 'totalDesc', totals: false });
    const r = run(t)[0] as GroupSheetResult;
    const d = data();
    expect(r.mode).toBe('group');
    expect(r.tree).toEqual(
      buildTree({ worklogs: WLS, layout: { groupBy: ['worklog.author', 'issue.key'], columns: [CF], period: 'week', sort: 'totalDesc' }, resolver: d.resolver, from: d.from, to: d.to }),
    );
    expect(r.total).toBe(GLOBAL_TOTAL);
    expect(r.showTotals).toBe(false);
    expect(r.worklogIds).toHaveLength(WLS.length);
  });

  it('each worklog: one row per worklog by author, then start time (instants, not strings); every cell kind', () => {
    const r = flat({
      rows: { mode: 'eachWorklog' },
      columns: ['worklog.author', 'issue.key', 'summary', 'worklog.started', 'worklog.created', 'worklog.timeZone', 'metric.hours', 'worklog.comment', CF],
    });
    expect(r.rows.map((x) => [x.cells[0], x.cells[1]])).toEqual([
      ['Alice', 'FFN-1'],
      ['Alice', 'FFN-2'],
      ['Bob', 'FFN-1'],
      ['Bob', 'FFN-10'],
      ['Carol', 'IOIA-5'],
    ]);
    expect(r.rows[0]!.cells).toEqual([
      'Alice', 'FFN-1', 'Login', '2026-09-01T09:00:00.000+0600', '2026-09-01T20:00:00.000+0600', 'Asia/Dhaka', 2 * H, 'Pairing on LOGIN', 'TPX-65',
    ]);
    expect(r.rows[0]!.worklogIds).toEqual([r.rows[0]!.key]);
    expect(r.showTotals).toBe(true);
    expect(r.total).toBe(GLOBAL_TOTAL);
  });

  it('each issue: one row per issue with time, newest key first, Hours = the issue total; Jira.csv columns', () => {
    const r = flat({
      rows: { mode: 'eachIssue' },
      columns: ['issuetype', 'issue.key', 'issue.id', 'summary', 'status', 'assignee', 'assignee.id', 'parent.id', 'parent.key', 'parent.summary', 'metric.hours'],
    });
    expect(r.rows.map((x) => x.key)).toEqual(['IOIA-5', 'FFN-10', 'FFN-2', 'FFN-1']);
    expect(r.rows.find((x) => x.key === 'FFN-2')!.cells).toEqual([
      'Sub-task', 'FFN-2', '1002', 'Fix login bug', 'In Progress', '', '', '1001', 'FFN-1', 'Login', 1.5 * H,
    ]);
    expect(r.rows.find((x) => x.key === 'FFN-1')!.cells.slice(5, 7)).toEqual(['Alice', 'u1']);
    expect(r.rows.find((x) => x.key === 'FFN-1')!.seconds).toBe(5 * H);
  });

  it('each issue with rollup: rows are the parents (sub-task time summed into them)', () => {
    const r = flat({ rows: { mode: 'eachIssue' }, columns: ['issue.key', 'metric.hours'], sumSubtasksToParent: true });
    expect(r.rows.map((x) => [x.key, x.cells[1]])).toEqual([
      ['IOIA-5', 0.5 * H],
      ['FFN-10', 4 * H],
      ['FFN-1', 6.5 * H],
    ]);
  });

  it('rollup is per sheet: the same data attributed differently in two sheets', () => {
    const [plain, rolled] = run(
      template(
        { rows: { mode: 'group', groupBy: ['issue.key'] } },
        { rows: { mode: 'group', groupBy: ['issue.key'] }, sumSubtasksToParent: true },
      ),
    ) as GroupSheetResult[];
    expect(plain!.tree.nodes.map((x) => x.value)).toContain('FFN-2');
    expect(rolled!.tree.nodes.map((x) => x.value)).not.toContain('FFN-2');
    expect(rolled!.total).toBe(plain!.total);
  });

  it('flat totals row only with an Hours column and totals on', () => {
    expect(flat({ rows: { mode: 'eachWorklog' }, columns: ['issue.key'] }).showTotals).toBe(false);
    expect(flat({ rows: { mode: 'eachWorklog' }, columns: ['metric.hours'], totals: false }).showTotals).toBe(false);
  });
});

describe('runTemplate: per-sheet conditions (in code)', () => {
  const only = (conditions: object[]) =>
    flat({ rows: { mode: 'eachWorklog' }, columns: ['issue.key'], filter: { conditions } }).rows.map((r) => r.cells[0]);
  const issuesFor = (c: object) => [...new Set(only([c]))].sort();

  it('is / isNot / in / notIn: case-insensitive; "not" keeps empty values', () => {
    expect(issuesFor({ fieldId: 'status', op: 'is', value: 'done' })).toEqual(['FFN-1', 'IOIA-5']);
    expect(issuesFor({ fieldId: 'status', op: 'isNot', value: 'Done' })).toEqual(['FFN-10', 'FFN-2']);
    expect(issuesFor({ fieldId: CF, op: 'in', value: ['TPX-65', 'tpx-99'] })).toEqual(['FFN-1', 'IOIA-5']);
    expect(issuesFor({ fieldId: CF, op: 'notIn', value: ['TPX-65', 'TPX-99'] })).toEqual(['FFN-10', 'FFN-2']);
  });

  it('contains = case-insensitive substring (not word match)', () => {
    expect(issuesFor({ fieldId: 'summary', op: 'contains', value: 'LOGIN' })).toEqual(['FFN-1', 'FFN-2']);
    expect(issuesFor({ fieldId: 'summary', op: 'contains', value: 'og' })).toEqual(['FFN-1', 'FFN-2']);
    expect(issuesFor({ fieldId: 'worklog.comment', op: 'contains', value: 'login' })).toEqual(['FFN-1']);
  });

  it('isEmpty / isNotEmpty', () => {
    expect(issuesFor({ fieldId: CF, op: 'isNotEmpty' })).toEqual(['FFN-1', 'FFN-2', 'IOIA-5']);
    expect(issuesFor({ fieldId: CF, op: 'isEmpty' })).toEqual(['FFN-10']);
    expect(issuesFor({ fieldId: 'parent', op: 'isNotEmpty' })).toEqual(['FFN-2']);
  });

  it('user fields compare by accountId, not display name', () => {
    expect(issuesFor({ fieldId: 'assignee', op: 'is', value: 'u1' })).toEqual(['FFN-1']);
    expect(issuesFor({ fieldId: 'assignee', op: 'is', value: 'Alice' })).toEqual([]);
    expect(only([{ fieldId: 'worklog.author', op: 'in', value: ['a', 'c'] }]).sort()).toEqual(['FFN-1', 'FFN-2', 'IOIA-5']);
    expect(only([{ fieldId: 'worklog.author', op: 'is', value: 'Alice' }])).toEqual([]);
  });

  it('lists match any item; objects match their name or key', () => {
    expect(issuesFor({ fieldId: LABELS, op: 'is', value: 'urgent' })).toEqual(['FFN-1']);
    expect(issuesFor({ fieldId: 'project', op: 'is', value: 'IOIA' })).toEqual(['IOIA-5']);
    expect(issuesFor({ fieldId: 'project', op: 'is', value: 'fun fun' })).toEqual(['FFN-1', 'FFN-10', 'FFN-2']);
  });

  it('several conditions = AND; worklog-level conditions per worklog', () => {
    const rows = only([
      { fieldId: 'status', op: 'is', value: 'Done' },
      { fieldId: 'worklog.date', op: 'is', value: '2026-09-02' },
    ]);
    expect(rows).toEqual(['FFN-1']);
  });

  it('conditions apply to the issue the time was logged on, even with rollup', () => {
    const r = flat({
      rows: { mode: 'eachIssue' },
      columns: ['issue.key', 'metric.hours'],
      sumSubtasksToParent: true,
      filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'In Progress' }] },
    });
    expect(r.rows.map((x) => [x.key, x.cells[1]])).toEqual([['FFN-1', 1.5 * H]]); // only FFN-2's time, under its parent
  });
});

describe('runTemplate: per-sheet JQL and narrowing', () => {
  it('JQL keys are intersected with the fetched issues', () => {
    const d = data({ jqlKeys: new Map([['status = Done', new Set(['FFN-1', 'IOIA-5', 'NOT-FETCHED-1'])]]) });
    const r = flat({ rows: { mode: 'eachIssue' }, columns: ['issue.key'], filter: { jql: 'status = Done' } }, d);
    expect(r.rows.map((x) => x.key)).toEqual(['IOIA-5', 'FFN-1']);
  });

  it('a sheet with JQL but no search result is a programming error', () => {
    expect(() => run(template({ rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'x = 1' } }))).toThrow(/No JQL search result/);
  });

  it('sheets only narrow: every sheet total ≤ the unfiltered total and uses a subset of the worklogs', () => {
    const d = data({ jqlKeys: new Map([['project = IOIA OR project = OTHER', new Set(['IOIA-5', 'OTHER-1'])]]) });
    const results = run(
      template(
        { name: 'All', rows: { mode: 'group', groupBy: ['issue.key'] } },
        { name: 'Billable', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { conditions: [{ fieldId: CF, op: 'isNotEmpty' }] } },
        { name: 'Other', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { jql: 'project = IOIA OR project = OTHER', conditions: [{ fieldId: 'project', op: 'isNot', value: 'FFN' }] } },
        { name: 'Nobody', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { conditions: [{ fieldId: 'worklog.author', op: 'is', value: 'zz' }] } },
      ),
      d,
    );
    const all = new Set(WLS.map((w) => w.id));
    expect(results.map((r) => r.total)).toEqual([GLOBAL_TOTAL, 7 * H, 0.5 * H, 0]);
    for (const r of results) {
      expect(r.total).toBeLessThanOrEqual(results[0]!.total);
      expect(r.worklogIds.every((id) => all.has(id))).toBe(true);
    }
    expect(totalOf({ rows: { mode: 'group', groupBy: ['status'] } })).toBe(GLOBAL_TOTAL);
  });
});

describe('sheet options: total columns, subtotal rows, issues without worklogs', () => {
  const parse = (s: object) => SheetSchema.safeParse({ name: 'S', ...s });
  const groupSheet = { rows: { mode: 'group', groupBy: ['worklog.author', 'issue.key'] } };
  const issueSheet = { rows: { mode: 'eachIssue' }, columns: ['issue.key', 'metric.hours'] };
  const messages = (s: object) => {
    const r = parse(s);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('defaults: everyLevel, "Total", no subtotal rows, no issues without time; blank label = "Total"', () => {
    expect(sheet({})).toMatchObject({ totalColumns: 'everyLevel', totalLabel: 'Total', subtotalRows: false, includeIssuesWithoutWorklogs: false });
    expect(sheet({ totalLabel: '  ' }).totalLabel).toBe('Total');
    expect(sheet({ totalLabel: ' Hours ', totalColumns: 'lastLevel', subtotalRows: true })).toMatchObject({ totalLabel: 'Hours', subtotalRows: true });
    expect(messages({ ...groupSheet, totalLabel: 'x'.repeat(MAX_LABEL + 1) })).toEqual([`totalLabel: total label must be at most ${MAX_LABEL} characters`]);
  });

  it('subtotal rows need lastLevel and totals on', () => {
    expect(messages({ ...groupSheet, subtotalRows: true })).toEqual(['subtotalRows: subtotal rows need totalColumns "lastLevel"']);
    expect(messages({ ...groupSheet, subtotalRows: true, totalColumns: 'lastLevel', totals: false })).toEqual(['subtotalRows: subtotal rows need totals on']);
  });

  it('total columns / label / subtotal rows are group-only; issues without time are each-issue-only', () => {
    expect(messages({ ...issueSheet, totalColumns: 'lastLevel', totalLabel: 'Hours', subtotalRows: true })).toEqual([
      'totalColumns: total columns are only available in group sheets',
      'totalLabel: a total label is only available in group sheets',
      'subtotalRows: subtotal rows are only available in group sheets',
    ]);
    expect(messages({ ...groupSheet, includeIssuesWithoutWorklogs: true })).toEqual([
      'includeIssuesWithoutWorklogs: issues without time can only be included in each-issue sheets',
    ]);
    expect(messages({ rows: { mode: 'eachWorklog' }, columns: ['issue.key'], includeIssuesWithoutWorklogs: true })).toHaveLength(1);
    expect(messages({ ...issueSheet, includeIssuesWithoutWorklogs: true })).toEqual([]);
  });

  it('headers.total = the total label', () => {
    const [g] = run(template({ ...groupSheet, totalColumns: 'lastLevel', totalLabel: 'Hours' }));
    expect(g!.headers.total).toBe('Hours');
  });

  it('each issue + includeIssuesWithoutWorklogs: extra issues get 0 hours, pass issue-level conditions only, newest key first', () => {
    const extra = [issue('FFN-20', { summary: 'Idle', status: { name: 'Done' } }), issue('FFN-21', { summary: 'Idle 2', status: { name: 'To Do' } })];
    const d = data({
      resolver: new ValueResolver(new Map([...ISSUES, ...extra].map((i) => [i.key, i])), TYPES),
      issuesWithoutWorklogs: new Map([['S1', ['FFN-21', 'FFN-20', 'FFN-1']]]),
    });
    const conditions = [{ fieldId: 'status', op: 'is', value: 'Done' }, { fieldId: 'worklog.author', op: 'is', value: 'a' }];
    const r = flat({ ...issueSheet, includeIssuesWithoutWorklogs: true, filter: { conditions } }, d);
    // FFN-21 fails "Status is Done"; FFN-1 keeps its own time (Alice's 2h only: the worklog condition narrows time,
    // not issues); IOIA-5 (Done, only Carol's time) is not in the extra list, so it has no row.
    expect(r.rows.map((x) => [x.key, x.cells[1], x.worklogIds.length])).toEqual([
      ['FFN-20', 0, 0],
      ['FFN-1', 2 * H, 1],
    ]);
    expect(r.total).toBe(2 * H);
    // Without the option the extra issues are ignored.
    expect(flat({ ...issueSheet, filter: { conditions } }, d).rows.map((x) => x.key)).toEqual(['FFN-1']);
  });

  it('includeIssuesWithoutWorklogs with rollup: a sub-task without time adds its parent', () => {
    const parent = issue('FFN-40', { summary: 'Story' });
    const sub = issue('FFN-41', { summary: 'Sub', issuetype: SUBTASK, parent: { id: '1040', key: 'FFN-40' } });
    const d = data({
      resolver: new ValueResolver(new Map([...ISSUES, parent, sub].map((i) => [i.key, i])), TYPES),
      issuesWithoutWorklogs: new Map([['S1', ['FFN-41']]]),
    });
    const r = flat({ ...issueSheet, includeIssuesWithoutWorklogs: true, sumSubtasksToParent: true }, d);
    expect(r.rows.map((x) => [x.key, x.seconds])).toEqual([['IOIA-5', 0.5 * H], ['FFN-40', 0], ['FFN-10', 4 * H], ['FFN-1', 6.5 * H]]);
  });
});
