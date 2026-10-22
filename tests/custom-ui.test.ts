import { describe, expect, it } from 'vitest';
import { buildTree, periodKey, ValueResolver, type CustomWorklog, type TreeNode } from '../src/services/custom/engine.js';
import { buildFieldList, type FieldInfo } from '../src/services/custom/fields.js';
import { CustomFilterSchema, MAX_CONDITIONS as SERVER_MAX_CONDITIONS, MAX_AUTHORS, MAX_PROJECTS } from '../src/services/custom/filter.js';
import { formatAmount as serverFormatAmount, LayoutSchema, MAX_COLUMNS as SERVER_MAX_COLUMNS, MAX_GROUP_LEVELS as SERVER_MAX_LEVELS } from '../src/services/custom/layout.js';
import { DEFAULT_TOTAL_LABEL as SERVER_TOTAL_LABEL, MAX_LABEL as SERVER_MAX_LABEL, MAX_SHEET_NAME as SERVER_MAX_SHEET_NAME, MAX_SHEETS as SERVER_MAX_SHEETS, MAX_TEMPLATE_NAME as SERVER_MAX_TEMPLATE_NAME } from '../src/services/custom/template.js';
import { DEFAULT_TOTAL_LABEL, MAX_LABEL, MAX_SHEET_NAME, MAX_SHEETS, MAX_TEMPLATE_NAME } from '../web/advance/template-logic.js';
import {
  buildConditions,
  fieldOptions,
  findNode,
  formatAmount,
  isoWeekKey,
  issueKeyOf,
  MAX_COLUMNS,
  MAX_CONDITIONS,
  MAX_GROUP_LEVELS,
  MAX_PICKED,
  moveItem,
  nextLevelField,
  nodeDrilldown,
  operatorsFor,
  parentPaths,
  parseList,
  periodLabel,
  valueKind,
  visibleRows,
  type ConditionDraft,
} from '../web/advance/logic.js';

const H = 3600;
const CF = 'customfield_10050';
const FIELDS: FieldInfo[] = buildFieldList([
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
  { id: 'customfield_10051', name: 'Team', custom: true, schema: { type: 'option' } },
  { id: 'customfield_10052', name: 'Team', custom: true, schema: { type: 'array', items: 'option' } },
  { id: 'customfield_10060', name: 'Reviewer', custom: true, schema: { type: 'user' } },
  { id: 'status', name: 'Status', schema: { type: 'status' } },
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
]);
const field = (id: string) => FIELDS.find((f) => f.id === id);

describe('browser copies stay in sync with the server', () => {
  it('limits', () => {
    expect([MAX_COLUMNS, MAX_CONDITIONS]).toEqual([SERVER_MAX_COLUMNS, SERVER_MAX_CONDITIONS]);
    // The editor offers 5 group levels; the group-sheet schema accepts more (the Custom Report limit of 3 is only the old UI's).
    expect(MAX_GROUP_LEVELS).toBeGreaterThan(SERVER_MAX_LEVELS);
    expect(MAX_PICKED).toBe(MAX_PROJECTS);
    expect(MAX_PICKED).toBe(MAX_AUTHORS);
    expect([MAX_SHEETS, MAX_SHEET_NAME, MAX_TEMPLATE_NAME, MAX_LABEL, DEFAULT_TOTAL_LABEL]).toEqual([
      SERVER_MAX_SHEETS,
      SERVER_MAX_SHEET_NAME,
      SERVER_MAX_TEMPLATE_NAME,
      SERVER_MAX_LABEL,
      SERVER_TOTAL_LABEL,
    ]);
  });

  it('ISO week keys equal the server periodKey for every day 2020–2030', () => {
    for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2030, 11, 31); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (isoWeekKey(d) !== periodKey(d, 'week')) throw new Error(`${d}: ${isoWeekKey(d)} vs ${periodKey(d, 'week')}`);
    }
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
  });

  it('formatAmount', () => {
    for (const s of [0, 1, 900, 27000, 12345, 600 * H, 7 * H + 1234]) {
      expect(formatAmount(s, 'hours', 8)).toBe(serverFormatAmount(s, 'hours', 8));
      expect(formatAmount(s, 'days', 7.5)).toBe(serverFormatAmount(s, 'days', 7.5));
    }
  });
});

describe('fields', () => {
  it('labels: name, or "Name (id)" when names collide; search covers name and id; exclude drops ids', () => {
    const opts = fieldOptions(FIELDS, new Set(['status']));
    expect(opts.find((o) => o.value === CF)).toEqual({ value: CF, name: `Client Reference\n${CF}`, label: 'Client Reference' });
    expect(opts.filter((o) => o.label.startsWith('Team')).map((o) => o.label)).toEqual(['Team (customfield_10051)', 'Team (customfield_10052)']);
    expect(opts.some((o) => o.value === 'status')).toBe(false);
  });

  it('operators and value kinds: user fields use the user picker and have no "contains"', () => {
    expect(operatorsFor(field('customfield_10060'))).not.toContain('contains');
    expect(operatorsFor(field('worklog.author'))).not.toContain('contains');
    expect(operatorsFor(field(CF))).toContain('contains');
    expect(valueKind(field('worklog.author'), 'is')).toBe('user');
    expect(valueKind(field('assignee'), 'notIn')).toBe('users');
    expect(valueKind(field(CF), 'in')).toBe('list');
    expect(valueKind(field(CF), 'contains')).toBe('text');
    expect(valueKind(field(CF), 'isEmpty')).toBe('none');
  });

  it('next group level: preferred pseudo-fields first, never a used one', () => {
    expect(nextLevelField(FIELDS, [])).toBe('worklog.author');
    expect(nextLevelField(FIELDS, ['worklog.author'])).toBe('issue.keySummary');
    expect(nextLevelField(FIELDS, ['worklog.author', 'issue.keySummary', 'status', 'issue.key', 'project', 'worklog.date'])).not.toMatch(
      /^(worklog\.author|issue\.keySummary|status|issue\.key|project|worklog\.date)$/,
    );
  });

  it('moveItem reorders levels and ignores moves past the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('conditions and request', () => {
  const draft = (d: Partial<ConditionDraft>): ConditionDraft => ({ fieldId: CF, op: 'is', text: '', users: [], ...d });

  it('parseList splits on commas/new lines, trims, drops empties and duplicates', () => {
    expect(parseList(' TPX-65, TPX-66 ,\nTPX-65,, ')).toEqual(['TPX-65', 'TPX-66']);
  });

  it('builds conditions per value kind; rows without a field are skipped; missing values name the row', () => {
    const ok = buildConditions(
      [
        draft({ op: 'contains', text: ' TPX-65 ' }),
        draft({ fieldId: '' }),
        draft({ op: 'in', text: 'A, B' }),
        draft({ fieldId: 'assignee', op: 'isNot', users: ['acc-1', 'acc-2'] }),
        draft({ fieldId: 'worklog.author', op: 'in', users: ['acc-1'] }),
        draft({ op: 'isEmpty', text: 'ignored' }),
      ],
      FIELDS,
    );
    expect(ok).toEqual({
      conditions: [
        { fieldId: CF, op: 'contains', value: 'TPX-65' },
        { fieldId: CF, op: 'in', value: ['A', 'B'] },
        { fieldId: 'assignee', op: 'isNot', value: 'acc-1' },
        { fieldId: 'worklog.author', op: 'in', value: ['acc-1'] },
        { fieldId: CF, op: 'isEmpty' },
      ],
    });
    // Every built condition is valid for the server schema.
    expect(() => CustomFilterSchema.parse({ from: '2026-09-01', to: '2026-09-02', conditions: ok.conditions })).not.toThrow();

    expect(buildConditions([draft({}), draft({ op: 'is', text: '  ' })], FIELDS).error).toBe('Filter 1 (Client Reference): enter a value.');
    expect(buildConditions([draft({ fieldId: 'assignee', op: 'in' })], FIELDS).error).toBe('Filter 1 (Assignee): choose at least one user.');
  });
});

// ---- tree helpers on a real buildTree result ----

let n = 0;
const wl = (accountId: string, user: string, issueKey: string, date: string, hours: number): CustomWorklog => ({
  id: String(++n),
  date,
  accountId,
  user,
  issueKey,
  summary: `${issueKey} summary`,
  project: 'FFN',
  seconds: hours * H,
  started: `${date}T10:00:00.000+0600`,
  created: '',
  createdDate: '',
  comment: '',
  attributedTo: issueKey,
});

function report(period: 'none' | 'week' = 'none') {
  const worklogs = [
    wl('a', 'Alice', 'FFN-1', '2026-09-01', 2),
    wl('a', 'Alice', 'FFN-2', '2026-09-08', 3),
    wl('b', 'Bob', 'FFN-1', '2026-09-08', 4),
  ];
  const issues = new Map(['FFN-1', 'FFN-2'].map((k) => [k, { key: k, fields: { summary: `${k} summary` } }]));
  const layout = LayoutSchema.parse({ groupBy: ['worklog.author', 'issue.keySummary'], period });
  const tree = buildTree({ worklogs, layout, resolver: new ValueResolver(issues, new Map()), from: '2026-09-01', to: '2026-09-10' });
  return { ...tree, worklogs, period, allIds: worklogs.map((w) => w.id) };
}

describe('tree table', () => {
  it('visibleRows: depth-first, collapsed nodes hide their children; parentPaths lists collapsible nodes', () => {
    const r = report();
    const all = visibleRows(r.nodes, new Set());
    expect(all.map((x) => [x.depth, x.node.label, x.expanded])).toEqual([
      [0, 'Alice', true],
      [1, 'FFN-1 FFN-1 summary', false],
      [1, 'FFN-2 FFN-2 summary', false],
      [0, 'Bob', true],
      [1, 'FFN-1 FFN-1 summary', false],
    ]);
    const alice = all[0]!.path;
    expect(visibleRows(r.nodes, new Set([alice])).map((x) => x.node.label)).toEqual(['Alice', 'Bob', 'FFN-1 FFN-1 summary']);
    expect(parentPaths(r.nodes)).toEqual(['a', 'b']);
  });

  it('findNode returns the node and its label trail; issue keys only for issue-like levels', () => {
    const r = report();
    const row = visibleRows(r.nodes, new Set())[2]!;
    const found = findNode(r.nodes, row.path)!;
    expect(found.labels).toEqual(['Alice', 'FFN-2 FFN-2 summary']);
    expect(issueKeyOf(found.node)).toBe('FFN-2');
    expect(issueKeyOf(r.nodes[0]!)).toBeUndefined();
    const unavailable: TreeNode = { ...found.node, fieldId: 'epic', value: 'FFN-9 (unavailable)' };
    expect(issueKeyOf(unavailable)).toBeUndefined();
  });

  it('drill-down: a node total, a node period cell, and the sheet total, grouped by user', () => {
    const r = report('week');
    expect(r.periodKeys).toEqual(['2026-W36', '2026-W37']);
    const alice = r.nodes[0]!;
    const d = nodeDrilldown(r.worklogs, alice.worklogIds, r.period);
    expect([d.total, d.groups.map((g) => g.user)]).toEqual([alice.total, ['Alice']]);
    const wk = nodeDrilldown(r.worklogs, alice.worklogIds, r.period, '2026-W37');
    expect([wk.total, wk.groups[0]!.worklogs.map((w) => w.issueKey)]).toEqual([3 * H, ['FFN-2']]);
    expect(wk.total).toBe(alice.periods['2026-W37']);
    const all = nodeDrilldown(r.worklogs, r.allIds, r.period); // a sheet's grand total: the sheet's worklogIds
    expect([all.total, all.groups.map((g) => g.user)]).toEqual([r.total, ['Alice', 'Bob']]);
    expect(nodeDrilldown(r.worklogs, r.allIds, r.period, '2026-W36').total).toBe(r.periods['2026-W36']);
    expect(nodeDrilldown(r.worklogs, [alice.worklogIds[0]!], r.period).groups).toHaveLength(1); // only the given ids
  });

  it('period labels', () => {
    expect(periodLabel('2026-09-01', 'day')).toBe('01-Sep');
    expect(periodLabel('2026-W36', 'week')).toBe('2026-W36');
    expect(periodLabel('2026-09', 'month')).toBe('Sep 2026');
  });
});
