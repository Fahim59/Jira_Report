import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { JiraClient, QueryValue } from '../src/jira/client.js';
import { FieldCache } from '../src/jira/fields.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { listJql, listRoutes, splitOrderBy } from '../src/routes/list.js';
import {
  activeFilterCount,
  buildTree,
  cellText,
  distinctValues,
  filterRows,
  formatDuration,
  groupRows,
  layoutLines,
  moveColumn,
  PAGE_SIZE,
  pageLines,
  parentKeys,
  requestFields,
  valuesOf,
  type ListRowData,
} from '../web/list/logic.js';

const row = (key: string, extra: Partial<ListRowData> = {}): ListRowData => ({
  key,
  summary: `Summary ${key}`,
  type: 'Task',
  subtask: false,
  status: 'To Do',
  statusCategory: 'new',
  values: {},
  ...extra,
});

describe('formatDuration', () => {
  it('writes seconds like Jira (8-hour days, 5-day weeks)', () => {
    expect(formatDuration(3 * 8 * 3600 + 2 * 3600)).toBe('3 days, 2 hours');
    expect(formatDuration(6 * 3600)).toBe('6 hours');
    expect(formatDuration(5 * 8 * 3600 + 4 * 8 * 3600)).toBe('1 week, 4 days');
    expect(formatDuration(3600 * 3 + 30 * 60)).toBe('3 hours, 30 minutes');
    expect(formatDuration(8 * 3600)).toBe('1 day');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
  it('cellText formats the time fields only', () => {
    const r = row('A-1', { values: { timespent: '21600', labels: 'x, y', customfield_1: '5' } });
    expect(cellText(r, 'timespent')).toBe('6');
    expect(cellText(r, 'customfield_1')).toBe('5');
    expect(cellText(r, 'status')).toBe('To Do');
    expect(cellText(r, 'aggregatetimespent')).toBe('');
  });
});

describe('filter and values', () => {
  const rows = [
    row('A-1', { status: 'Done', values: { labels: 'ui, api', assignee: 'Ann' } }),
    row('A-2', { values: { labels: 'api', assignee: 'Bob' } }),
    row('A-3', { type: 'Bug', values: { assignee: '' } }),
  ];
  it('list fields have several values, others one, empty = none', () => {
    expect(valuesOf(rows[0]!, 'labels', true)).toEqual(['ui', 'api']);
    expect(valuesOf(rows[0]!, 'labels', false)).toEqual(['ui, api']);
    expect(valuesOf(rows[2]!, 'labels', true)).toEqual(['']);
  });
  it('a row matches when it has one of the ticked values for every filtered field', () => {
    const multi = (id: string) => id === 'labels';
    expect(filterRows(rows, { labels: ['api'] }, multi).map((r) => r.key)).toEqual(['A-1', 'A-2']);
    expect(filterRows(rows, { labels: ['api'], status: ['Done'] }, multi).map((r) => r.key)).toEqual(['A-1']);
    expect(filterRows(rows, { assignee: [''] }, multi).map((r) => r.key)).toEqual(['A-3']);
    expect(filterRows(rows, { issuetype: [] }, multi)).toHaveLength(3);
    expect(activeFilterCount({ a: ['x'], b: [] })).toBe(1);
  });
  it('distinct values: most common first, None last', () => {
    expect(distinctValues(rows, 'labels', true)).toEqual([
      { value: 'api', count: 2 },
      { value: 'ui', count: 1 },
      { value: '', count: 1 },
    ]);
  });
});

describe('hierarchy and groups', () => {
  const rows = [row('E-1', { type: 'Epic' }), row('S-1', { parent: 'E-1' }), row('T-1', { parent: 'S-1', subtask: true }), row('X-1', { parent: 'MISSING-1' })];
  it('nests rows under a parent that is in the list; the rest are roots', () => {
    const tree = buildTree(rows, true);
    expect(tree.map((n) => n.row.key)).toEqual(['E-1', 'X-1']);
    expect(tree[0]!.children[0]!.children[0]!.row.key).toBe('T-1');
    expect(buildTree(rows, false)).toHaveLength(4);
  });
  it('a parent loop does not lose rows', () => {
    const loop = [row('A-1', { parent: 'A-2' }), row('A-2', { parent: 'A-1' })];
    const roots = buildTree(loop, true);
    expect(roots.length).toBeGreaterThan(0);
    const keys: string[] = [];
    const walk = (ns: typeof roots) => ns.forEach((n) => (keys.push(n.row.key), walk(n.children)));
    walk(roots);
    expect(keys.sort()).toEqual(['A-1', 'A-2']);
  });
  it('children show only under open rows', () => {
    const closed = layoutLines(rows, { hierarchy: true, expanded: new Set(), collapsedGroups: new Set() });
    expect(closed.map((l) => (l.kind === 'item' ? l.row.key : ''))).toEqual(['E-1', 'X-1']);
    const open = layoutLines(rows, { hierarchy: true, expanded: new Set(parentKeys(rows, true)), collapsedGroups: new Set() });
    expect(open.map((l) => (l.kind === 'item' ? `${l.depth}${l.row.key}` : ''))).toEqual(['0E-1', '1S-1', '2T-1', '0X-1']);
    expect(parentKeys(rows, false)).toEqual([]);
  });
  it('groups by a field, a list field puts a row in each group, collapsed groups hide their rows', () => {
    const g = [row('A-1', { values: { labels: 'a, b' } }), row('A-2', { values: { labels: 'b' } }), row('A-3')];
    expect(groupRows(g, 'labels', true).map((x) => [x.value, x.rows.length])).toEqual([['a', 1], ['b', 2], ['', 1]]);
    const lines = layoutLines(g, { hierarchy: false, groupBy: { fieldId: 'labels', multi: true }, expanded: new Set(), collapsedGroups: new Set(['b']) });
    expect(lines.map((l) => (l.kind === 'group' ? `[${l.label}:${l.count}${l.open ? '' : ' closed'}]` : l.row.key))).toEqual(['[a:1]', 'A-1', '[b:2 closed]', '[None:1]', 'A-3']);
  });
  it('requestFields: each real field once', () => {
    expect(requestFields(['status', 'timespent'], 'labels', ['status', 'assignee', 'issue.key'])).toEqual(['status', 'timespent', 'labels', 'assignee', 'issue.key']);
    expect(requestFields(['worklog.author', 'metric.hours', 'epic'], undefined, [])).toEqual([]);
  });
});

describe('pageLines', () => {
  const many = Array.from({ length: 450 }, (_, i) => row(`A-${i + 1}`));
  const lines = layoutLines(many, { hierarchy: false, expanded: new Set(), collapsedGroups: new Set() });
  it('a page is 200 work items; each Load more adds 200 until all are shown', () => {
    expect(PAGE_SIZE).toBe(200);
    const first = pageLines(lines, 200);
    expect([first.lines.length, first.shown, first.items]).toEqual([200, 200, 450]);
    const second = pageLines(lines, 400);
    expect([second.lines.length, second.shown]).toEqual([400, 400]);
    const last = pageLines(lines, 600);
    expect([last.lines.length, last.shown, last.items]).toEqual([450, 450, 450]);
    expect(pageLines([], 200)).toEqual({ lines: [], items: 0, shown: 0 });
  });
  it('group headings come along, but a heading with nothing under it is left out', () => {
    const rows = [row('A-1', { values: { labels: 'x' } }), row('A-2', { values: { labels: 'x' } }), row('A-3', { values: { labels: 'y' } })];
    const grouped = layoutLines(rows, { hierarchy: false, groupBy: { fieldId: 'labels', multi: false }, expanded: new Set(), collapsedGroups: new Set() });
    const two = pageLines(grouped, 2);
    expect(two.lines.map((l) => (l.kind === 'group' ? `[${l.label}]` : l.row.key))).toEqual(['[x]', 'A-1', 'A-2']);
    expect(two.items).toBe(3);
  });
});

describe('moveColumn', () => {
  it('moves one column to a place; clamps; no-op for a bad index', () => {
    const cols = ['a', 'b', 'status', 'd'];
    expect(moveColumn(cols, 2, 0)).toEqual(['status', 'a', 'b', 'd']);
    expect(moveColumn(cols, 0, 2)).toEqual(['b', 'status', 'a', 'd']);
    expect(moveColumn(cols, 1, 99)).toEqual(['a', 'status', 'd', 'b']);
    expect(moveColumn(cols, 1, -5)).toEqual(['b', 'a', 'status', 'd']);
    expect(moveColumn(cols, 9, 0)).toEqual(cols);
    expect(cols).toEqual(['a', 'b', 'status', 'd']);
  });
});

describe('list JQL', () => {
  it('splits ORDER BY off the conditions', () => {
    expect(splitOrderBy('status = Done order by created ASC')).toEqual({ conditions: 'status = Done', order: 'order by created ASC' });
    expect(splitOrderBy('ORDER BY key')).toEqual({ conditions: '', order: 'ORDER BY key' });
    expect(splitOrderBy('status = Done')).toEqual({ conditions: 'status = Done', order: '' });
  });
  it('combines projects, users, JQL and hide-done; unbounded = undefined', () => {
    expect(listJql({ projects: ['FFN'], assignees: ['a1'], jql: 'labels = x ORDER BY key DESC', hideDone: true })).toBe(
      'project in ("FFN") AND assignee in ("a1") AND (labels = x) AND statusCategory != Done ORDER BY key DESC',
    );
    expect(listJql({ projects: ['FFN'], assignees: [], jql: '', hideDone: false })).toBe('project in ("FFN") ORDER BY created DESC');
    expect(listJql({ projects: [], assignees: [], jql: '', hideDone: true })).toBeUndefined();
    expect(listJql({ projects: [], assignees: [], jql: 'ORDER BY key', hideDone: false })).toBeUndefined();
  });
});

describe('routes', () => {
  function fakeJira() {
    const calls: { path: string; query?: Record<string, QueryValue> }[] = [];
    const client: JiraClient = {
      baseUrl: 'https://one.atlassian.net',
      async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
        calls.push({ path, query });
        if (path === '/rest/api/3/field') {
          return [
            { id: 'summary', name: 'Summary', schema: { type: 'string' } },
            { id: 'status', name: 'Status', schema: { type: 'status' } },
            { id: 'labels', name: 'Labels', schema: { type: 'array', items: 'string' } },
            { id: 'timespent', name: 'Time Spent', schema: { type: 'number' } },
            { id: 'assignee', name: 'Assignee', schema: { type: 'user' } },
            { id: 'issue.key', name: 'Issue', schema: { type: 'string' } },
            { id: 'issue.id', name: 'Issue id', schema: { type: 'string' } },
            { id: 'assignee.id', name: 'Assignee Id', schema: { type: 'string' } },
            { id: 'parent.id', name: 'Parent id', schema: { type: 'string' } },
            { id: 'parent.key', name: 'Parent key', schema: { type: 'string' } },
            { id: 'parent.summary', name: 'Parent summary', schema: { type: 'string' } },
            { id: 'worklog.author', name: 'Worklog Author', schema: { type: 'user' } },
          ] as T;
        }
        return {
          isLast: true,
          issues: [
            { id: '101', key: 'FFN-1', fields: { summary: 'Epic one', issuetype: { name: 'Epic', subtask: false }, status: { name: 'Done', statusCategory: { key: 'done' } }, labels: ['a', 'b'], timespent: 7200 } },
            { id: '102', key: 'FFN-2', fields: { assignee: { accountId: 'acc-1', displayName: 'Ann' }, summary: 'Child', issuetype: { name: 'Task', subtask: false }, status: { name: 'To Do', statusCategory: { key: 'new' } }, parent: { id: '101', key: 'FFN-1', fields: { summary: 'Epic one' } }, labels: [], timespent: null } },
          ],
        } as T;
      },
    } as JiraClient;
    return { client, calls };
  }
  async function app() {
    const jira = fakeJira();
    const a = Fastify();
    await a.register(listRoutes, { sites: new SiteRegistry([{ key: 'one', url: 'https://one.atlassian.net', jira: jira.client }]), fields: new FieldCache() });
    return { a, jira };
  }

  it('returns work items with parent, status category and requested values', async () => {
    const { a, jira } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/list', payload: { projects: ['FFN'], fields: ['labels', 'timespent'] } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jql).toBe('project in ("FFN") ORDER BY created DESC');
    expect(body.rows).toEqual([
      { key: 'FFN-1', summary: 'Epic one', type: 'Epic', subtask: false, status: 'Done', statusCategory: 'done', values: { labels: 'a, b', timespent: '7200' } },
      { key: 'FFN-2', summary: 'Child', type: 'Task', subtask: false, status: 'To Do', statusCategory: 'new', parent: 'FFN-1', values: { labels: '', timespent: '' } },
    ]);
    expect(body.truncated).toBe(false);
    const search = jira.calls.find((c) => c.path === '/rest/api/3/search/jql')!;
    expect(String(search.query?.fields).split(',').sort()).toEqual(['issuetype', 'labels', 'parent', 'status', 'summary', 'timespent']);
  });
  it('computes the id / key / parent columns from the issue itself, and asks Jira for the assignee only when needed', async () => {
    const { a, jira } = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/list',
      payload: { assignees: ['acc-1'], fields: ['issue.key', 'issue.id', 'assignee.id', 'parent.id', 'parent.key', 'parent.summary'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[1].values).toEqual({ 'issue.key': 'FFN-2', 'issue.id': '102', 'assignee.id': 'acc-1', 'parent.id': '101', 'parent.key': 'FFN-1', 'parent.summary': 'Epic one' });
    expect(res.json().rows[0].values['parent.key']).toBe('');
    const asked = String(jira.calls.find((c) => c.path === '/rest/api/3/search/jql')!.query?.fields).split(',').sort();
    expect(asked).toEqual(['assignee', 'issuetype', 'parent', 'status', 'summary']);
    expect((await a.inject({ method: 'POST', url: '/api/list', payload: { projects: ['FFN'], fields: ['worklog.author'] } })).json().error).toMatch(/Unknown field/);
  });
  it('lists the people with recent work (assignee, reporter, creator) once each', async () => {
    const { a, jira } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/list/users?days=30' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 30, accountIds: ['acc-1'], issues: 2, truncated: false });
    expect(jira.calls.find((c) => c.path === '/rest/api/3/search/jql')!.query?.jql).toBe('updated >= -30d ORDER BY updated DESC');
    expect((await a.inject({ method: 'GET', url: '/api/list/users?days=0' })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/list/users?site=zzz' })).statusCode).toBe(400);
  });
  it('`all: true` reads up to the export cap instead of the screen cap', async () => {
    const { a } = await app();
    const screen = await a.inject({ method: 'POST', url: '/api/list', payload: { projects: ['FFN'] } });
    expect(screen.json().limit).toBe(1000);
    const full = await a.inject({ method: 'POST', url: '/api/list', payload: { projects: ['FFN'], all: true } });
    expect(full.json().limit).toBe(20000);
    expect(full.json().rows).toHaveLength(2);
  });
  it('needs something to narrow by; rejects unknown fields and bad input', async () => {
    const { a } = await app();
    const post = (payload: Record<string, unknown>) => a.inject({ method: 'POST', url: '/api/list', payload });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ projects: ['FFN'], fields: ['nope'] })).json().error).toMatch(/Unknown field/);
    expect((await post({ projects: ['F F'] })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/list?site=zzz', payload: { projects: ['FFN'] } })).statusCode).toBe(400);
  });
  it('exports the table as an .xlsx with indent and group rows', async () => {
    const { a } = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/list/export',
      payload: {
        headers: ['Work', 'Status'],
        rows: [
          { cells: ['To Do (2)'], level: 0, group: true },
          { cells: ['FFN-1 Epic one', 'Done'], level: 0, group: false },
          { cells: ['FFN-2 Child', 'To Do'], level: 1, group: false },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/work-items_one_\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Work items')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Work', 'Status']);
    expect(ws.getCell('A2').value).toBe('To Do (2)');
    expect(ws.getCell('A4').value).toBe('FFN-2 Child');
    expect(ws.getCell('A4').alignment?.indent).toBe(1);
    expect(ws.getCell('B4').value).toBe('To Do');
    expect((await a.inject({ method: 'POST', url: '/api/list/export', payload: { headers: [], rows: [] } })).statusCode).toBe(400);
  });
});
