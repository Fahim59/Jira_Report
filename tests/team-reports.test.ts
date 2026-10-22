import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { JiraClient, QueryValue } from '../src/jira/client.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { teamExportRoutes } from '../src/routes/teamExport.js';
import { periodKey, periodKeys, type TreeNode } from '../src/services/custom/engine.js';
import { buildFieldList } from '../src/services/custom/fields.js';
import type { GroupSheetResult } from '../src/services/custom/sheets.js';
import { periodLabel } from '../src/services/custom/table.js';
import { GlobalFilterSchema, SheetSchema, TemplateBodySchema } from '../src/services/custom/template.js';
import { extraIssuesJql, generateTemplateReport } from '../src/services/customReport.js';
import { periodLabel as browserPeriodLabel, periodOf } from '../web/advance/logic.js';
import {
  buildPivot,
  buildTeamRequest,
  formatTime,
  groupChoices,
  initials,
  isoWeekStart,
  issueIconFor,
  mergeAuthors,
  monthBanners,
  periodColumn,
  pivotGrid,
  splitPeople,
  teamQueryProblem,
  type GroupChoice,
} from '../web/team/logic.js';

const H = 3600;

// ---- helpers ----

function node(label: string, periods: Record<string, number>, children: TreeNode[] = [], value = label, fieldId = 'worklog.author'): TreeNode {
  const total = Object.values(periods).reduce((a, b) => a + b, 0);
  return {
    fieldId,
    value,
    label,
    total,
    periods,
    columns: {},
    worklogIds: [],
    issueCount: 1,
    worklogCount: 1,
    children,
  };
}

function groupResult(nodes: TreeNode[], periodKeysList: string[], groupBy: string[]): Pick<GroupSheetResult, 'tree' | 'headers'> {
  const periods: Record<string, number> = {};
  for (const k of periodKeysList) periods[k] = nodes.reduce((s, n) => s + (n.periods[k] ?? 0), 0);
  return {
    tree: {
      periodKeys: periodKeysList,
      nodes,
      total: nodes.reduce((s, n) => s + n.total, 0),
      periods,
      issueCount: 1,
      worklogCount: 1,
    },
    headers: { groupBy, columns: [], total: 'Total' },
  };
}

// ---- periods (server and browser mirrors) ----

describe('quarter and year periods', () => {
  it('bucket keys', () => {
    expect(periodKey('2026-07-04', 'quarter')).toBe('2026-Q3');
    expect(periodKey('2026-03-31', 'quarter')).toBe('2026-Q1');
    expect(periodKey('2026-12-01', 'quarter')).toBe('2026-Q4');
    expect(periodKey('2026-07-04', 'year')).toBe('2026');
    expect(periodKeys('2026-12-30', '2027-01-02', 'year')).toEqual(['2026', '2027']);
    expect(periodKeys('2026-03-30', '2026-04-02', 'quarter')).toEqual(['2026-Q1', '2026-Q2']);
  });

  it('the browser copy agrees with the server (keys and labels)', () => {
    for (const d of ['2026-01-01', '2026-03-31', '2026-04-01', '2026-09-30', '2026-12-31']) {
      for (const p of ['quarter', 'year'] as const) expect(periodOf(d, p)).toBe(periodKey(d, p));
    }
    expect(periodLabel('2026-Q3', 'quarter')).toBe('Q3 2026');
    expect(browserPeriodLabel('2026-Q3', 'quarter')).toBe('Q3 2026');
    expect(periodLabel('2026', 'year')).toBe('2026');
  });
});

// ---- schemas ----

describe('global filter: time zone', () => {
  it('defaults to the server zone; "user" needs a valid zone of its own', () => {
    const base = { from: '2026-09-01', to: '2026-09-29' };
    expect(GlobalFilterSchema.parse(base).zone).toBe('server');
    expect(GlobalFilterSchema.parse({ ...base, zone: 'author' }).zone).toBe('author');
    expect(GlobalFilterSchema.safeParse({ ...base, zone: 'user' }).success).toBe(false);
    expect(GlobalFilterSchema.safeParse({ ...base, zone: 'user', userZone: 'Mars/Olympus' }).success).toBe(false);
    expect(GlobalFilterSchema.parse({ ...base, zone: 'user', userZone: 'Asia/Dhaka' }).userZone).toBe('Asia/Dhaka');
    expect(GlobalFilterSchema.safeParse({ ...base, zone: 'noon' }).success).toBe(false);
  });

  it('a group can bring many users (up to 300)', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `acc-${i}`);
    const base = { from: '2026-09-01', to: '2026-09-29' };
    expect(GlobalFilterSchema.safeParse({ ...base, authors: ids(300) }).success).toBe(true);
    expect(GlobalFilterSchema.safeParse({ ...base, authors: ids(301) }).success).toBe(false);
    // A saved template's defaults keep the picker's limit.
    expect(TemplateBodySchema.safeParse({ name: 'T', defaults: { authors: ids(51) }, sheets: [{ name: 'S', rows: { mode: 'group', groupBy: ['issue.key'] } }] }).success).toBe(false);
  });
});

describe('sheet: extra JQL', () => {
  const group = { name: 'S', rows: { mode: 'group', groupBy: ['issue.key'] } };
  it('group sheets only, trimmed, blank = none', () => {
    expect(SheetSchema.parse({ ...group, extraJql: '  labels = x  ' }).extraJql).toBe('labels = x');
    expect(SheetSchema.parse({ ...group, extraJql: '   ' }).extraJql).toBeUndefined();
    expect(SheetSchema.safeParse({ name: 'S', rows: { mode: 'eachIssue' }, columns: ['issue.key'], extraJql: 'labels = x' }).success).toBe(false);
  });
  it('the search: global projects, then the extra JQL, newest first', () => {
    expect(extraIssuesJql(['FFN'], 'labels = x')).toBe('project in ("FFN") AND (labels = x) ORDER BY key DESC');
    expect(extraIssuesJql([], 'labels = x')).toBe('(labels = x) ORDER BY key DESC');
  });
});

// ---- generateTemplateReport: time zones, extra JQL ----

const FIELDS = buildFieldList([{ id: 'summary', name: 'Summary', schema: { type: 'string' } }]);
const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31, HOURS_PER_DAY: 8 };
const PROJECT = { key: 'FFN', name: 'Fun Fun' };
const STORY = { name: 'Story', subtask: false, hierarchyLevel: 0 };
const issue = (key: string) => ({ key, fields: { summary: key, project: PROJECT, issuetype: STORY } });

function fakeJira(opts: { issues: ReturnType<typeof issue>[]; extra?: ReturnType<typeof issue>[]; worklogs: Record<string, unknown[]> }) {
  const calls: Array<{ path: string; query: Record<string, QueryValue> }> = [];
  const client: JiraClient = {
    baseUrl: 'https://one.atlassian.net',
    async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, query });
      if (path === '/rest/api/3/project/search') return { isLast: true, values: [{ id: '1', ...PROJECT }] } as T;
      if (path === '/rest/api/3/search/jql') {
        const jql = String(query.jql);
        if (jql.endsWith(' ORDER BY key DESC')) return { issues: opts.extra ?? [], isLast: true } as T;
        return { issues: opts.issues, isLast: true } as T;
      }
      const key = decodeURIComponent(/\/issue\/([^/]+)\/worklog$/.exec(path)![1]!);
      const worklogs = opts.worklogs[key] ?? [];
      return { startAt: 0, maxResults: 1000, total: worklogs.length, worklogs } as T;
    },
    async post<T>(): Promise<T> {
      return { queries: [{ errors: [] }] } as T;
    },
  };
  return { client, calls };
}

let wid = 0;
const worklog = (started: string, hours: number, tz?: string) => ({
  id: String(++wid),
  issueId: '0',
  author: { accountId: 'a', displayName: 'Alice', ...(tz ? { timeZone: tz } : {}) },
  started,
  timeSpentSeconds: hours * H,
  created: '2026-09-30T20:00:00.000+0000',
});

const DAY_SHEET = { name: 'S', rows: { mode: 'group', groupBy: ['worklog.date'] }, period: 'day' };
const run = (jira: JiraClient, filter: object, sheets: object[] = [DAY_SHEET]) =>
  generateTemplateReport(
    jira,
    cfg,
    FIELDS,
    GlobalFilterSchema.parse({ from: '2026-09-01', to: '2026-09-29', ...filter }),
    TemplateBodySchema.parse({ name: 'T', sheets }),
  );

// 01:00 Dhaka on 3 Sep is 19:00 UTC on 2 Sep, which is 15:00 on 2 Sep in New York.
const LATE = '2026-09-03T01:00:00.000+0600';

describe('generateTemplateReport: time zone', () => {
  const data = () => ({ issues: [issue('FFN-1')], worklogs: { 'FFN-1': [worklog(LATE, 2, 'America/New_York')] } });
  const dates = (r: Awaited<ReturnType<typeof run>>) => (r.sheets[0] as GroupSheetResult).tree.nodes.map((n) => n.value);

  it('server (default): the day follows REPORT_TZ', async () => {
    const r = await run(fakeJira(data()).client, {});
    expect(dates(r)).toEqual(['2026-09-03']);
    expect(r.timeZone).toBe('Asia/Dhaka');
    expect(r.zoneMode).toBe('server');
  });

  it('user: the day follows the zone the browser sent', async () => {
    const r = await run(fakeJira(data()).client, { zone: 'user', userZone: 'America/New_York' });
    expect(dates(r)).toEqual(['2026-09-02']);
    expect(r.timeZone).toBe('America/New_York');
  });

  it("author: the day follows the worklog author's own zone (REPORT_TZ when unknown); wider worklog window", async () => {
    const server = fakeJira(data());
    await run(server.client, {});
    const jira = fakeJira({
      issues: [issue('FFN-1')],
      worklogs: { 'FFN-1': [worklog(LATE, 2, 'America/New_York'), worklog(LATE, 1), worklog(LATE, 4, 'Not/AZone')] },
    });
    const r = await run(jira.client, { zone: 'author' });
    const tree = (r.sheets[0] as GroupSheetResult).tree;
    expect(Object.fromEntries(tree.nodes.map((n) => [n.value, n.total]))).toEqual({ '2026-09-02': 2 * H, '2026-09-03': 5 * H });

    const window = (calls: Array<{ path: string; query: Record<string, QueryValue> }>) => calls.find((c) => c.path.endsWith('/worklog'))!.query;
    const narrow = window(server.calls);
    const wide = window(jira.calls);
    expect(Number(wide.startedAfter)).toBe(Number(narrow.startedAfter) - 86_400_000);
    expect(Number(wide.startedBefore)).toBe(Number(narrow.startedBefore) + 86_400_000);
  });

  it('a worklog outside [from, to] in the author zone is dropped', async () => {
    const jira = fakeJira({
      issues: [issue('FFN-1')],
      worklogs: { 'FFN-1': [worklog('2026-09-01T03:00:00.000+0600', 2, 'America/New_York')] }, // 31 Aug 17:00 in New York
    });
    const r = await run(jira.client, { zone: 'author' });
    expect((r.sheets[0] as GroupSheetResult).tree.total).toBe(0);
  });

  it('"Worklog Time Zone" shows (and groups by) the zone each day was computed in', async () => {
    const jira = fakeJira({ issues: [issue('FFN-1')], worklogs: { 'FFN-1': [worklog(LATE, 2, 'America/New_York'), worklog(LATE, 1)] } });
    const r = await run(jira.client, { zone: 'author' }, [{ name: 'S', rows: { mode: 'group', groupBy: ['worklog.timeZone'] } }]);
    expect((r.sheets[0] as GroupSheetResult).tree.nodes.map((n) => n.value).sort()).toEqual(['America/New_York', 'Asia/Dhaka']);
  });
});

describe('generateTemplateReport: extra JQL', () => {
  it('adds the extra issues as rows with no time; time on them still counts', async () => {
    const jira = fakeJira({
      issues: [issue('FFN-1')],
      extra: [issue('FFN-9'), issue('FFN-1')],
      worklogs: { 'FFN-1': [worklog('2026-09-03T10:00:00.000+0600', 2)] },
    });
    const sheet = { name: 'S', rows: { mode: 'group', groupBy: ['issue.key'] }, period: 'day', extraJql: 'labels = x' };
    const r = await run(jira.client, { projects: ['ffn'] }, [sheet]);
    const tree = (r.sheets[0] as GroupSheetResult).tree;
    expect(tree.nodes.map((n) => [n.value, n.total])).toEqual([
      ['FFN-1', 2 * H],
      ['FFN-9', 0],
    ]);
    expect(tree.total).toBe(2 * H);
    expect(r.sheets[0]!.worklogIds).toHaveLength(1); // the extra rows are not worklogs
    expect(r.worklogs).toHaveLength(1);
    const extraSearch = jira.calls.find((c) => String(c.query.jql).endsWith(' ORDER BY key DESC'))!;
    expect(String(extraSearch.query.jql)).toBe('project in ("FFN") AND (labels = x) ORDER BY key DESC');
    // Only the issue that has time is asked for worklogs.
    expect(jira.calls.filter((c) => c.path.endsWith('/worklog')).map((c) => c.path.split('/')[5])).toEqual(['FFN-1']);
  });
});

// ---- browser logic ----

describe('formatTime', () => {
  it('hours, hours & minutes, hh:mm, days; zero is blank', () => {
    expect(formatTime(7.5 * H, 'hours', 8)).toBe('7.5h');
    expect(formatTime(2 * H, 'hours', 8)).toBe('2h');
    expect(formatTime(0, 'hours', 8)).toBe('');
    expect(formatTime(7.5 * H, 'hm', 8)).toBe('7h 30m');
    expect(formatTime(8 * H, 'hm', 8)).toBe('8h');
    expect(formatTime(45 * 60, 'hm', 8)).toBe('45m');
    expect(formatTime(7.5 * H, 'hhmm', 8)).toBe('7:30');
    expect(formatTime(5 * 60, 'hhmm', 8)).toBe('0:05');
    expect(formatTime(7.5 * H, 'days', 8)).toBe('0.94d');
    expect(formatTime(16 * H, 'days', 8)).toBe('2d');
    expect(formatTime(7.5 * H, 'days', 7.5)).toBe('1d');
  });
});

describe('period columns', () => {
  it('day: number over weekday, weekend shaded, month banner', () => {
    expect(periodColumn('2026-07-04', 'day')).toEqual({ key: '2026-07-04', text: '04', sub: 'Sa', weekend: true, group: 'Jul, 2026' });
    expect(periodColumn('2026-07-22', 'day')).toMatchObject({ text: '22', sub: 'We', weekend: false });
    expect(periodColumn('2026-07-05', 'day')).toMatchObject({ sub: 'Su', weekend: true });
  });
  it('week: Mon–Sun range over the ISO week number, under the month of its Monday', () => {
    expect(periodColumn('2026-W27', 'week')).toEqual({ key: '2026-W27', text: '29-05', sub: '27', weekend: false, group: 'Jun, 2026' });
    expect(periodColumn('2026-W28', 'week')).toMatchObject({ text: '06-12', sub: '28', group: 'Jul, 2026' });
    expect(isoWeekStart('2027-W01')).toBe('2027-01-04');
    expect(isoWeekStart('2026-W53')).toBe('2026-12-28');
  });
  it('month, quarter, year have no banner', () => {
    expect(periodColumn('2026-07', 'month')).toEqual({ key: '2026-07', text: 'Jul', sub: '2026', weekend: false });
    expect(periodColumn('2026-Q3', 'quarter')).toEqual({ key: '2026-Q3', text: 'Q3', sub: '2026', weekend: false });
    expect(periodColumn('2026', 'year')).toEqual({ key: '2026', text: '2026', weekend: false });
  });
  it('banners group consecutive columns', () => {
    const cols = ['2026-06-30', '2026-07-01', '2026-07-02'].map((k) => periodColumn(k, 'day'));
    expect(monthBanners(cols)).toEqual([
      { text: 'Jun, 2026', span: 1 },
      { text: 'Jul, 2026', span: 2 },
    ]);
    expect(monthBanners(['2026-07'].map((k) => periodColumn(k, 'month')))).toEqual([]);
  });
  it('every week key the server makes is understood', () => {
    for (const key of periodKeys('2026-12-20', '2027-01-20', 'week')) expect(isoWeekStart(key)).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

describe('buildPivot', () => {
  const keys = ['2026-07-01', '2026-07-02'];
  const alice = node('Alice', { '2026-07-01': 3 * H, '2026-07-02': 1 * H }, [
    node('FFN-1', { '2026-07-01': 2 * H }, [], 'FFN-1', 'issue.key'),
    node('FFN-2', { '2026-07-01': 1 * H, '2026-07-02': 1 * H }, [], 'FFN-2', 'issue.key'),
  ], 'a');
  const bob = node('Bob', { '2026-07-02': 2 * H }, [node('FFN-1', { '2026-07-02': 2 * H }, [], 'FFN-1', 'issue.key')], 'b');
  const pivot = buildPivot(groupResult([alice, bob], keys, ['Work Log Author', 'Issue']), 'day');

  it('one row per leaf; a parent value and its total are merged down its rows', () => {
    expect(pivot.rows).toHaveLength(3);
    const shape = pivot.rows.map((r) => r.cells.map((c) => `${c.kind}${c.level}x${c.rowSpan}:${c.node.label}`));
    expect(shape).toEqual([
      ['label0x2:Alice', 'total0x2:Alice', 'label1x1:FFN-1', 'total1x1:FFN-1'],
      ['label1x1:FFN-2', 'total1x1:FFN-2'],
      ['label0x1:Bob', 'total0x1:Bob', 'label1x1:FFN-1', 'total1x1:FFN-1'],
    ]);
  });
  it('amounts per period column and the totals', () => {
    expect(pivot.rows.map((r) => r.amounts)).toEqual([[2 * H, 0], [1 * H, 1 * H], [0, 2 * H]]);
    expect(pivot.totals).toEqual([3 * H, 3 * H]);
    expect(pivot.total).toBe(6 * H);
    expect(pivot.levels).toEqual(['Work Log Author', 'Issue']);
    expect(pivot.banners).toEqual([{ text: 'Jul, 2026', span: 2 }]);
  });
});

describe('pivotGrid (Excel)', () => {
  const keys = ['2026-07-03', '2026-07-04'];
  const alice = node('Alice', { '2026-07-03': 3 * H + 1800, '2026-07-04': 0 }, [], 'a');
  const grid = pivotGrid(buildPivot(groupResult([alice], keys, ['Work Log Author']), 'day'), 'hours', 8);
  const at = (r: number, c: number) => grid.cells.find((x) => x.r === r && x.c === c);

  it('header rows (banner + period), then the user row, then Total', () => {
    expect(grid).toMatchObject({ rows: 4, cols: 4, headRows: 2, levelCols: 2 });
    expect(at(0, 0)).toMatchObject({ text: 'Work Log Author', rowSpan: 2, style: 'level' });
    expect(at(0, 1)).toMatchObject({ text: 'Total\nWork Log Author', rowSpan: 2, style: 'totalHead' });
    expect(at(0, 2)).toMatchObject({ text: 'Jul, 2026', colSpan: 2, style: 'banner' });
    expect(at(1, 2)).toMatchObject({ text: '03\nFr', style: 'period' });
    expect(at(1, 3)).toMatchObject({ text: '04\nSa', style: 'periodWeekend' });
    expect(at(2, 0)).toMatchObject({ text: 'Alice', style: 'label' });
    expect(at(3, 0)).toMatchObject({ text: 'Total', style: 'sumLabel' });
  });
  it('hours stay numbers with a unit format; zero stays empty', () => {
    expect(at(2, 1)).toMatchObject({ text: '3.5h', value: 3.5, numFmt: 'General"h"', style: 'total' });
    expect(at(2, 2)).toMatchObject({ value: 3.5 });
    expect(at(2, 3)).toMatchObject({ text: '', style: 'amountWeekend' });
    expect(at(2, 3)!.value).toBeUndefined();
  });
  it('hh:mm is text; days are numbers in days', () => {
    const pivot = buildPivot(groupResult([alice], keys, ['Work Log Author']), 'day');
    expect(pivotGrid(pivot, 'hhmm', 8).cells.find((x) => x.r === 2 && x.c === 2)).toMatchObject({ text: '3:30' });
    expect(pivotGrid(pivot, 'hhmm', 8).cells.find((x) => x.r === 2 && x.c === 2)!.value).toBeUndefined();
    expect(pivotGrid(pivot, 'days', 7).cells.find((x) => x.r === 2 && x.c === 2)).toMatchObject({ value: 0.5, numFmt: 'General"d"' });
  });
  it('month periods have one header row', () => {
    const g = pivotGrid(buildPivot(groupResult([node('Alice', { '2026-07': H })], ['2026-07'], ['Work Log Author']), 'month'), 'hours', 8);
    expect(g.headRows).toBe(1);
    expect(g.cells.find((x) => x.r === 0 && x.c === 2)).toMatchObject({ text: 'Jul\n2026' });
  });
});

describe('no Group By', () => {
  const keys = ['2026-07-03', '2026-07-04'];
  const flat = (periods: Record<string, number>) => {
    const r = groupResult([], keys, []);
    r.tree.total = Object.values(periods).reduce((a, b) => a + b, 0);
    Object.assign(r.tree.periods, periods);
    return buildPivot(r, 'day');
  };

  it('one Total column and no rows; the totals come from the tree', () => {
    const p = flat({ '2026-07-03': 3 * H, '2026-07-04': 0 });
    expect(p).toMatchObject({ flat: true, levels: [], rows: [], total: 3 * H, totals: [3 * H, 0] });
    expect(buildPivot(groupResult([node('Alice', {})], keys, ['Work Log Author']), 'day').flat).toBe(false);
  });

  it('Excel: a Total column, then the single row of period totals', () => {
    const grid = pivotGrid(flat({ '2026-07-03': 3 * H, '2026-07-04': 0 }), 'hours', 8);
    expect(grid).toMatchObject({ rows: 3, cols: 3, headRows: 2, levelCols: 1 });
    const at = (r: number, c: number) => grid.cells.find((x) => x.r === r && x.c === c);
    expect(at(0, 0)).toMatchObject({ text: 'Total', rowSpan: 2, style: 'totalHead' });
    expect(at(0, 1)).toMatchObject({ text: 'Jul, 2026', colSpan: 2 });
    expect(at(2, 0)).toMatchObject({ value: 3, style: 'total' });
    expect(at(2, 1)).toMatchObject({ value: 3 });
  });

  it('no time at all: only the header', () => {
    const grid = pivotGrid(flat({}), 'hours', 8);
    expect(grid.rows).toBe(2);
    expect(grid.cells.every((c) => c.r < 2)).toBe(true);
  });

  it('the export route accepts that grid', async () => {
    const a = Fastify();
    await a.register(teamExportRoutes, { sites: new SiteRegistry([{ key: 'one', url: 'https://one.atlassian.net', jira: {} as JiraClient }]) });
    const grid = pivotGrid(flat({ '2026-07-03': 3 * H }), 'hours', 8);
    const res = await a.inject({ method: 'POST', url: '/api/team-reports/export', payload: { site: 'one', from: '2026-07-03', to: '2026-07-04', grid } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Team Reports')!;
    expect(ws.getCell('A1').value).toBe('Total');
    expect(ws.getCell('A3').value).toBe(3);
    expect(ws.views[0]).toMatchObject({ xSplit: 1, ySplit: 2 });
  });
});

describe('request', () => {
  const choice = (fieldId: string, label?: string): GroupChoice => ({ fieldId, name: fieldId, section: 'Issue', ...(label ? { label } : {}) });
  const q = {
    site: 'one',
    from: '2026-09-01',
    to: '2026-09-29',
    projects: ['FFN'],
    authors: ['a'],
    groupBy: [choice('worklog.author', 'Work Log Author'), choice('issue.key')],
    period: 'week' as const,
    zone: 'user' as const,
    browserZone: 'Asia/Dhaka',
    jql: ' status = Done ',
    extraJql: 'labels = x',
  };

  it('passes the server schemas', () => {
    const body = buildTeamRequest(q);
    const filter = GlobalFilterSchema.parse(body.filter);
    expect(filter).toMatchObject({ site: 'one', zone: 'user', userZone: 'Asia/Dhaka', authors: ['a'] });
    const sheet = TemplateBodySchema.parse(body.template).sheets[0]!;
    expect(sheet).toMatchObject({ period: 'week', totalColumns: 'everyLevel', totals: true, extraJql: 'labels = x' });
    expect(sheet.filter.jql).toBe('status = Done');
    expect(sheet.rows).toEqual({ mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'Work Log Author' }, { fieldId: 'issue.key' }] });
  });
  it('blank JQL boxes send nothing; userZone only with the "user" zone', () => {
    const body = buildTeamRequest({ ...q, zone: 'author', jql: ' ', extraJql: '' });
    expect(body.filter).not.toHaveProperty('userZone');
    const sheet = TemplateBodySchema.parse(body.template).sheets[0]!;
    expect(sheet.filter.jql).toBeUndefined();
    expect(sheet.extraJql).toBeUndefined();
  });
  it('form problems', () => {
    const ok = { from: '2026-09-01', to: '2026-09-05', groupBy: [choice('worklog.author')] };
    expect(teamQueryProblem(ok, 31)).toBeUndefined();
    expect(teamQueryProblem({ ...ok, from: '' }, 31)).toMatch(/both From and To/);
    expect(teamQueryProblem({ ...ok, from: '2026-09-09' }, 31)).toMatch(/From must be on or before To/);
    expect(teamQueryProblem({ ...ok, to: '2026-12-31' }, 31)).toMatch(/maximum is 31/);
    // Group By is optional and not limited to Jira's three.
    expect(teamQueryProblem({ from: ok.from, to: ok.to }, 31)).toBeUndefined();
  });

  it('any number of group levels, or none, passes the server schemas', () => {
    const many = ['status', 'issue.key', 'project', 'assignee', 'issuetype', 'priority'].map((id) => choice(id));
    const body = buildTeamRequest({ ...q, groupBy: many });
    const sheet = TemplateBodySchema.parse(body.template).sheets[0]!;
    expect(sheet.rows).toEqual({ mode: 'group', groupBy: many.map((g) => ({ fieldId: g.fieldId })) });
  });

  it('an empty Group By means one row per Work Log Author, like Jira', () => {
    const sheet = TemplateBodySchema.parse(buildTeamRequest({ ...q, groupBy: [] }).template).sheets[0]!;
    expect(sheet.rows).toEqual({ mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'Work Log Author' }] });
  });
});

describe('Group By choices and people', () => {
  it('every field of the site (same list as Custom Report); duplicate names told apart; worklog author/date keep Jira names', () => {
    const list = groupChoices(
      buildFieldList([
        { id: 'status', name: 'Status', schema: { type: 'status' } },
        { id: 'customfield_1', name: 'Team', custom: true, schema: { type: 'option' } },
        { id: 'customfield_2', name: 'Team', custom: true, schema: { type: 'option' } },
      ]),
    );
    const names = list.map((c) => c.name);
    expect(names).toContain('Status');
    expect(names).toContain('Team (customfield_1)');
    expect(names).toContain('Team (customfield_2)');
    expect(list.map((c) => c.fieldId)).toEqual(buildFieldList([
      { id: 'status', name: 'Status', schema: { type: 'status' } },
      { id: 'customfield_1', name: 'Team', custom: true, schema: { type: 'option' } },
      { id: 'customfield_2', name: 'Team', custom: true, schema: { type: 'option' } },
    ]).map((f) => f.id));
    expect(list.some((c) => c.fieldId.startsWith('metric.'))).toBe(true);
    expect(list.find((c) => c.fieldId === 'worklog.author')).toEqual({ fieldId: 'worklog.author', name: 'Work Log Author', section: 'Worklog', label: 'Work Log Author' });
    expect(list.find((c) => c.fieldId === 'worklog.date')?.name).toBe('Work Log Started');
  });
  it('users and groups are split, and a group expands to its members once', () => {
    expect(splitPeople(['user:a', 'group:g1', 'user:b', 'group:g2'])).toEqual({ users: ['a', 'b'], groups: ['g1', 'g2'] });
    expect(mergeAuthors(['a', 'b'], [['b', 'c'], ['c', 'd']])).toEqual(['a', 'b', 'c', 'd']);
  });
  it('icons and initials', () => {
    expect([undefined, 'Bug', 'Story', 'Sub-task', 'Epic', 'Task', 'Change'].map(issueIconFor)).toEqual(['other', 'bug', 'story', 'subtask', 'epic', 'task', 'other']);
    expect([initials('Mustafizur Rahman'), initials('Cher'), initials('  '), initials('a b c')]).toEqual(['MR', 'C', '?', 'AC']);
  });
});

// ---- Excel route ----

describe('POST /api/team-reports/export', () => {
  async function app() {
    const a = Fastify();
    const jira = { baseUrl: 'https://one.atlassian.net' } as JiraClient;
    await a.register(teamExportRoutes, { sites: new SiteRegistry([{ key: 'one', url: 'https://one.atlassian.net', jira }]) });
    return a;
  }

  const alice = node('Alice', { '2026-07-03': 3 * H, '2026-07-04': 0 }, [
    node('FFN-1', { '2026-07-03': 2 * H }, [], 'FFN-1', 'issue.key'),
    node('FFN-2', { '2026-07-03': 1 * H }, [], 'FFN-2', 'issue.key'),
  ], 'a');
  const grid = pivotGrid(buildPivot(groupResult([alice], ['2026-07-03', '2026-07-04'], ['Work Log Author', 'Issue']), 'day'), 'hours', 8);

  it('writes the table: merges, numbers with their unit format, frozen header, filename', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/team-reports/export', payload: { site: 'one', from: '2026-07-03', to: '2026-07-04', complete: true, grid } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('team-report_one_2026-07-03_2026-07-04.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Team Reports')!;
    expect(ws.getCell('A1').value).toBe('Work Log Author');
    expect(ws.getCell('E1').value).toBe('Jul, 2026');
    expect(ws.getCell('E2').value).toBe('03\nFr');
    expect(ws.getCell('A3').value).toBe('Alice');
    expect(ws.getCell('B3').value).toBe(3);
    expect(ws.getCell('B3').numFmt).toBe('General"h"');
    expect(ws.getCell('C3').value).toBe('FFN-1');
    expect(ws.getCell('E3').value).toBe(2);
    expect(ws.getCell('F3').value).toBe(''); // a zero day stays empty
    expect(ws.getCell('A5').value).toBe('Total'); // 2 header rows + 2 issue rows, then the total row
    expect(ws.getCell('B5').value).toBe(3);
    // Alice and her total span her two issue rows; the headers span both header rows.
    expect(ws.getCell('A4').master.address).toBe('A3');
    expect(ws.getCell('B4').master.address).toBe('B3');
    expect(ws.getCell('A2').master.address).toBe('A1');
    expect(ws.getCell('F1').master.address).toBe('E1');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 4, ySplit: 2 });
  });

  it('an incomplete report is marked in the filename', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/team-reports/export', payload: { site: 'one', from: '2026-07-03', to: '2026-07-04', complete: false, grid } });
    expect(res.headers['content-disposition']).toContain('_INCOMPLETE.xlsx');
  });

  it('rejects an unknown site, a bad table and an unknown number format', async () => {
    const a = await app();
    const post = (payload: unknown) => a.inject({ method: 'POST', url: '/api/team-reports/export', payload: payload as object });
    expect((await post({ site: 'nope', from: '2026-07-03', to: '2026-07-04', grid })).statusCode).toBe(400);
    expect((await post({ site: 'one', from: '2026-07-04', to: '2026-07-03', grid })).statusCode).toBe(400);
    expect((await post({ site: 'one', from: '2026-07-03', to: '2026-07-04', grid: { ...grid, cols: 2 } })).statusCode).toBe(400); // cells outside the table
    const evil = { ...grid, cells: grid.cells.map((c, i) => (i === 0 ? { ...c, numFmt: '[Red]0' } : c)) };
    expect((await post({ site: 'one', from: '2026-07-03', to: '2026-07-04', grid: evil })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });
});
