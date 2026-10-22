import { describe, expect, it } from 'vitest';
import {
  attributionKey,
  buildTree,
  findEpic,
  issuePasses,
  missingAncestorKeys,
  MULTIPLE_LABEL,
  NONE_LABEL,
  periodKey,
  periodKeys,
  ValueResolver,
  type CustomIssue,
  type CustomWorklog,
  type TreeNode,
} from '../src/services/custom/engine.js';
import { formatAmount, LayoutSchema, toUnit, type Layout } from '../src/services/custom/layout.js';

const H = 3600;
const CF = 'customfield_10050'; // "Client Reference"
const STORY = { name: 'Story', subtask: false, hierarchyLevel: 0 };
const SUBTASK = { name: 'Sub-task', subtask: true, hierarchyLevel: -1 };
const EPIC = { name: 'Epic', subtask: false, hierarchyLevel: 1 };

function issue(key: string, fields: Record<string, unknown>): CustomIssue {
  return { key, fields: { issuetype: STORY, ...fields } };
}

const ISSUES: CustomIssue[] = [
  issue('FFN-100', { summary: 'Auth epic', issuetype: EPIC, status: { name: 'In Progress' } }),
  issue('FFN-1', {
    summary: 'Login',
    status: { name: 'Done' },
    [CF]: 'TPX-65',
    assignee: { accountId: 'u1', displayName: 'Alice' },
    parent: { key: 'FFN-100', fields: { summary: 'Auth epic', issuetype: EPIC } },
  }),
  issue('FFN-2', {
    summary: 'Fix bug',
    issuetype: SUBTASK,
    status: { name: 'In Progress' },
    [CF]: 'TPX-70',
    parent: { key: 'FFN-1', fields: { summary: 'Login', issuetype: STORY } },
  }),
  issue('FFN-10', { summary: 'Docs', status: { name: 'Done' }, [CF]: null }),
];
const issueMap = (list = ISSUES) => new Map(list.map((i) => [i.key, i]));
const TYPES = new Map([
  [CF, 'string'],
  ['assignee', 'user'],
  ['status', 'status'],
]);

let n = 0;
function wl(issueKey: string, date: string, accountId: string, hours: number, attributedTo = issueKey): CustomWorklog {
  const user = { a: 'Alice', b: 'Bob', c: 'Carol' }[accountId] ?? accountId;
  return {
    id: String(++n),
    date,
    accountId,
    user,
    issueKey,
    summary: '',
    project: 'FFN',
    seconds: hours * H,
    started: `${date}T09:00:00.000+0600`,
    created: `${date}T18:00:00.000+0600`,
    createdDate: date,
    comment: '',
    attributedTo,
  };
}

const WLS: CustomWorklog[] = [
  wl('FFN-1', '2026-09-01', 'a', 2),
  wl('FFN-1', '2026-09-02', 'b', 3),
  wl('FFN-2', '2026-09-02', 'a', 1.5),
  wl('FFN-10', '2026-09-08', 'b', 4),
  wl('FFN-10', '2026-10-01', 'c', 0.5),
];
const GRAND = 11 * H;

function layout(over: Partial<Layout>): Layout {
  return LayoutSchema.parse({ groupBy: ['status'], ...over });
}

function tree(over: Partial<Layout>, worklogs = WLS, issues = issueMap()) {
  return buildTree({ worklogs, layout: layout(over), resolver: new ValueResolver(issues, TYPES), from: '2026-09-01', to: '2026-10-01' });
}

/** Every node's total equals the sum of its children's, and its worklogIds are its children's combined. */
function expectConsistent(nodes: TreeNode[]): number {
  let sum = 0;
  for (const node of nodes) {
    if (node.children.length) {
      expect(expectConsistent(node.children)).toBe(node.total);
      expect(node.children.flatMap((c) => c.worklogIds).sort()).toEqual([...node.worklogIds].sort());
    }
    expect(Object.values(node.periods).reduce((a, b) => a + b, 0)).toBe(Object.keys(node.periods).length ? node.total : 0);
    sum += node.total;
  }
  return sum;
}

const labels = (nodes: TreeNode[]) => nodes.map((x) => x.label);

describe('LayoutSchema', () => {
  it('fills defaults and validates group-by', () => {
    expect(LayoutSchema.parse({ groupBy: ['status'] })).toEqual({
      groupBy: ['status'],
      columns: [],
      period: 'none',
      format: 'hours',
      sumSubtasksToParent: false,
      sort: 'value',
    });
    expect(LayoutSchema.safeParse({ groupBy: [] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ groupBy: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ groupBy: ['status', 'status'] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ groupBy: ['status"; x'] }).success).toBe(false);
  });
});

describe('buildTree', () => {
  it('1 level: groups and totals', () => {
    const t = tree({ groupBy: ['status'] });
    expect(labels(t.nodes)).toEqual(['Done', 'In Progress']);
    expect(t.nodes.map((x) => x.total)).toEqual([9.5 * H, 1.5 * H]);
    expect(t.total).toBe(GRAND);
    expect(t.nodes[0]!.children).toEqual([]);
  });

  it('2 levels: worklog.author → issue.key with an extra column (View B)', () => {
    const t = tree({ groupBy: ['worklog.author', 'issue.key'], columns: [CF] });
    expect(labels(t.nodes)).toEqual(['Alice', 'Bob', 'Carol']);
    const alice = t.nodes[0]!;
    expect(alice.value).toBe('a');
    expect(alice.total).toBe(3.5 * H);
    expect(labels(alice.children)).toEqual(['FFN-1', 'FFN-2']);
    expect(alice.children.map((c) => c.columns[CF])).toEqual(['TPX-65', 'TPX-70']);
    expect(alice.columns[CF]).toBe(MULTIPLE_LABEL); // two issues, two references
    expect(t.nodes[2]!.columns[CF]).toBe(''); // Carol: one issue with no reference
    expect(expectConsistent(t.nodes)).toBe(GRAND);
  });

  it('3 levels: issue.key → issue.keySummary → status (View A); subtotals add up to the grand total', () => {
    const t = tree({ groupBy: ['issue.key', 'issue.keySummary', 'status'] });
    expect(labels(t.nodes)).toEqual(['FFN-1', 'FFN-2', 'FFN-10']); // numeric key order
    expect(labels(t.nodes[0]!.children)).toEqual(['FFN-1 Login']);
    expect(labels(t.nodes[0]!.children[0]!.children)).toEqual(['Done']);
    expect(expectConsistent(t.nodes)).toBe(GRAND);
    expect(t.total).toBe(GRAND);
  });

  it('extra column: shared value when everything under the node agrees, else "(multiple)"', () => {
    const t = tree({ groupBy: ['status'], columns: [CF, 'assignee'] });
    const done = t.nodes.find((x) => x.label === 'Done')!;
    expect(done.columns[CF]).toBe(MULTIPLE_LABEL); // FFN-1 TPX-65, FFN-10 empty
    expect(t.nodes.find((x) => x.label === 'In Progress')!.columns[CF]).toBe('TPX-70');
    const byIssue = tree({ groupBy: ['issue.key'], columns: ['assignee'] });
    expect(byIssue.nodes[0]!.columns.assignee).toBe('Alice');
  });

  it('empty values are grouped as "(none)", sorted last', () => {
    const t = tree({ groupBy: [CF] });
    expect(labels(t.nodes)).toEqual(['TPX-65', 'TPX-70', NONE_LABEL]);
    expect(t.nodes[2]!.value).toBe('');
    expect(t.nodes[2]!.total).toBe(4.5 * H);
  });

  it('user fields group by accountId, show the display name', () => {
    const t = tree({ groupBy: ['assignee'] });
    expect(t.nodes.map((x) => [x.value, x.label])).toEqual([
      ['u1', 'Alice'],
      ['', NONE_LABEL],
    ]);
  });

  it('sort totalDesc orders every level by total, ties by label', () => {
    const t = tree({ groupBy: ['worklog.author', 'issue.key'], sort: 'totalDesc' });
    expect(labels(t.nodes)).toEqual(['Bob', 'Alice', 'Carol']); // 7h, 3.5h, 0.5h
    expect(labels(t.nodes[0]!.children)).toEqual(['FFN-10', 'FFN-1']); // 4h, 3h
  });

  it('periods: day / week / month buckets on every node, zero-filled', () => {
    const day = tree({ groupBy: ['status'], period: 'day' });
    expect(day.periodKeys).toHaveLength(31);
    expect(day.periods['2026-09-02']).toBe(4.5 * H);
    expect(day.periods['2026-09-03']).toBe(0);

    const week = tree({ groupBy: ['status'], period: 'week' });
    expect(week.periodKeys).toEqual(['2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40']);
    expect(week.periods).toEqual({ '2026-W36': 6.5 * H, '2026-W37': 4 * H, '2026-W38': 0, '2026-W39': 0, '2026-W40': 0.5 * H });

    const month = tree({ groupBy: ['status'], period: 'month' });
    expect(month.periodKeys).toEqual(['2026-09', '2026-10']);
    expect(month.nodes.find((x) => x.label === 'Done')!.periods).toEqual({ '2026-09': 9 * H, '2026-10': 0.5 * H });
    expect(expectConsistent(month.nodes)).toBe(GRAND);

    expect(tree({ groupBy: ['status'] }).periodKeys).toEqual([]);
  });

  it('rollup: sub-task worklogs counted on the parent, with the parent field values', () => {
    const issues = issueMap();
    const rolled = WLS.map((w) => ({ ...w, attributedTo: attributionKey(issues.get(w.issueKey)!, true) }));
    const t = tree({ groupBy: ['issue.key', 'status'] }, rolled, issues);
    expect(labels(t.nodes)).toEqual(['FFN-1', 'FFN-10']);
    expect(t.nodes[0]!.total).toBe(6.5 * H);
    expect(labels(t.nodes[0]!.children)).toEqual(['Done']); // FFN-1's status, not the sub-task's
    // The drill-down still sees the original issue.
    expect(rolled.find((w) => w.issueKey === 'FFN-2')!.attributedTo).toBe('FFN-1');
  });

  it('epic grouping uses the nearest Epic ancestor', () => {
    const t = tree({ groupBy: ['epic'] });
    expect(t.nodes.map((x) => [x.label, x.total])).toEqual([
      ['FFN-100 Auth epic', 6.5 * H],
      [NONE_LABEL, 4.5 * H],
    ]);
  });
});

describe('periods', () => {
  it('ISO weeks cross the year boundary correctly', () => {
    expect(periodKeys('2026-12-28', '2027-01-04', 'week')).toEqual(['2026-W53', '2027-W01']);
    expect(periodKey('2027-01-01', 'week')).toBe('2026-W53');
    expect(periodKey('2026-09-07', 'week')).toBe('2026-W37'); // Monday starts a week
    expect(periodKey('2026-09-06', 'week')).toBe('2026-W36'); // Sunday ends one
  });
});

describe('hierarchy', () => {
  it('findEpic: self, embedded parent, loaded chain, missing link, cycle', () => {
    const m = issueMap();
    expect(findEpic('FFN-100', m).epic).toEqual({ key: 'FFN-100', summary: 'Auth epic' });
    expect(findEpic('FFN-1', m).epic?.key).toBe('FFN-100');
    expect(findEpic('FFN-2', m).epic?.key).toBe('FFN-100'); // sub-task → story → epic
    expect(findEpic('FFN-10', m)).toEqual({});

    const noEpicType = issueMap([issue('S-2', { issuetype: SUBTASK, parent: { key: 'S-1', fields: { issuetype: STORY } } })]);
    expect(findEpic('S-2', noEpicType)).toEqual({ missing: 'S-1' });

    const cycle = issueMap([issue('C-1', { parent: { key: 'C-2' } }), issue('C-2', { parent: { key: 'C-1' } })]);
    expect(findEpic('C-1', cycle)).toEqual({});
  });

  it('missingAncestorKeys: rollup parents and the next epic link, minus loaded/unavailable', () => {
    const m = issueMap([
      issue('S-2', { issuetype: SUBTASK, parent: { key: 'S-1', fields: { issuetype: STORY } } }),
      issue('T-1', { parent: { key: 'E-1', fields: { issuetype: EPIC } } }),
    ]);
    expect(missingAncestorKeys(['S-2', 'T-1'], m, { epic: false, rollup: true })).toEqual(['S-1']);
    expect(missingAncestorKeys(['S-2', 'T-1'], m, { epic: true, rollup: false })).toEqual(['S-1']); // E-1 is known to be an Epic
    expect(missingAncestorKeys(['S-2'], m, { epic: true, rollup: true }, new Set(['S-1']))).toEqual([]);
    expect(missingAncestorKeys(['S-2'], m, { epic: false, rollup: false })).toEqual([]);
  });

  it('attributionKey: only sub-tasks with a parent roll up', () => {
    const m = issueMap();
    expect(attributionKey(m.get('FFN-2')!, true)).toBe('FFN-1');
    expect(attributionKey(m.get('FFN-2')!, false)).toBe('FFN-2');
    expect(attributionKey(m.get('FFN-1')!, true)).toBe('FFN-1'); // a story is not rolled into its epic
  });
});

describe('in-code issue checks', () => {
  const r = new ValueResolver(issueMap([...ISSUES, issue('FFN-11', { summary: 'x', [CF]: 'TPX 65' })]), TYPES);
  it('re-checks "contains" (Jira ~ is word-based and can over-match)', () => {
    const c = [{ fieldId: CF, op: 'contains' as const, value: 'TPX-65' }];
    expect(issuePasses('FFN-1', c, r)).toBe(true);
    expect(issuePasses('FFN-11', c, r)).toBe(false);
    expect(issuePasses('FFN-10', c, r)).toBe(false);
  });

  it('applies epic / issue.keySummary conditions; other JQL conditions are left to Jira', () => {
    expect(issuePasses('FFN-2', [{ fieldId: 'epic', op: 'is', value: 'FFN-100' }], r)).toBe(true);
    expect(issuePasses('FFN-10', [{ fieldId: 'epic', op: 'isNotEmpty' }], r)).toBe(false);
    expect(issuePasses('FFN-1', [{ fieldId: 'issue.keySummary', op: 'contains', value: 'login' }], r)).toBe(true);
    expect(issuePasses('FFN-1', [{ fieldId: 'status', op: 'is', value: 'Whatever' }], r)).toBe(true);
  });
});

describe('units', () => {
  it('hours or days of HOURS_PER_DAY', () => {
    expect(toUnit(7.5 * H, 'hours', 8)).toBe(7.5);
    expect(toUnit(12 * H, 'days', 8)).toBe(1.5);
    expect(formatAmount(7.5 * H, 'hours', 8)).toBe('7.5h');
    expect(formatAmount(7.5 * H, 'days', 8)).toBe('0.94d');
    expect(formatAmount(16 * H, 'days', 8)).toBe('2d');
  });
});
