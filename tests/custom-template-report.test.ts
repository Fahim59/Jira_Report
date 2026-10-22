import { describe, expect, it } from 'vitest';
import { JiraError, type JiraClient, type QueryValue } from '../src/jira/client.js';
import { generateTemplateReport, InvalidTemplateRunError, issuesWithoutWorklogsJql, UnknownFieldError } from '../src/services/customReport.js';
import { buildFieldList, type JiraFieldRaw } from '../src/services/custom/fields.js';
import { InvalidJqlError } from '../src/services/custom/filter.js';
import type { FlatSheetResult, GroupSheetResult } from '../src/services/custom/sheets.js';
import { GlobalFilterSchema, MAX_ISSUES_WITHOUT_WORKLOGS, TemplateBodySchema } from '../src/services/custom/template.js';

const H = 3600;
const CF = 'customfield_10050';
const STORY = { name: 'Story', subtask: false, hierarchyLevel: 0 };
const SUBTASK = { name: 'Sub-task', subtask: true, hierarchyLevel: -1 };
const EPIC = { name: 'Epic', subtask: false, hierarchyLevel: 1 };
const PROJECT = { key: 'FFN', name: 'Fun Fun' };

const FIELDS = buildFieldList([
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: 'status', name: 'Status', schema: { type: 'status' } },
  { id: 'labels', name: 'Labels', schema: { type: 'array', items: 'string' } },
] satisfies JiraFieldRaw[]);

const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31, HOURS_PER_DAY: 8 };

type Issue = { key: string; fields: Record<string, unknown> };
const issue = (key: string, fields: Record<string, unknown>): Issue => ({ key, fields: { project: PROJECT, issuetype: STORY, ...fields } });

interface Call {
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, QueryValue>;
  body?: unknown;
}

/**
 * `search` = issues the global JQL returns. A sheet search `<global> AND (<jql>) ORDER BY ...` returns the issues
 * `sheetJql[<jql>]` lists. `byKey` = ancestors loadable via `key in (...)`. `projectIssues` = what an issues-without-
 * worklogs search (`project in (...) [AND (<jql>)] ORDER BY key DESC`) returns, narrowed by `sheetJql` when it has one.
 */
function fakeJira(opts: {
  search: Issue[];
  projectIssues?: Issue[];
  sheetJql?: Record<string, string[]>;
  byKey?: Issue[];
  worklogs: Record<string, unknown[]>;
  failWorklogs?: string[];
  parseErrors?: Record<string, string[]>;
}) {
  const calls: Call[] = [];
  const all = new Map([...(opts.byKey ?? []), ...opts.search].map((i) => [i.key, i]));
  const client: JiraClient = {
    baseUrl: 'https://one.atlassian.net',
    async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ method: 'GET', path, query });
      if (path === '/rest/api/3/project/search') return { isLast: true, values: [{ id: '1', ...PROJECT }] } as T;
      if (path === '/rest/api/3/search/jql') {
        const jql = String(query.jql);
        const keyIn = /^key in \((.*)\)$/.exec(jql);
        if (keyIn) {
          const keys = [...keyIn[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
          if (keys.some((k) => !all.has(k))) throw new JiraError(`Jira 400 on ${path}: An issue with key does not exist`, 400, path);
          return { issues: keys.map((k) => all.get(k)), isLast: true } as T;
        }
        const sheet = Object.entries(opts.sheetJql ?? {}).find(([j]) => jql.includes(` AND (${j}) ORDER BY`));
        if (jql.startsWith('project in (') && jql.endsWith(' ORDER BY key DESC')) {
          const issues = (opts.projectIssues ?? []).filter((i) => !sheet || sheet[1].includes(i.key));
          return { issues, isLast: true } as T;
        }
        if (sheet) return { issues: sheet[1].map((key) => ({ key })), isLast: true } as T;
        return { issues: opts.search, isLast: true } as T;
      }
      const wm = /^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/.exec(path);
      if (wm) {
        const key = decodeURIComponent(wm[1]!);
        if (opts.failWorklogs?.includes(key)) throw new JiraError('Jira 503', 503, path);
        const worklogs = opts.worklogs[key] ?? [];
        return { startAt: 0, maxResults: 1000, total: worklogs.length, worklogs } as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: 'POST', path, query: {}, body });
      const queries = (body as { queries: string[] }).queries;
      return { queries: queries.map((q) => ({ query: q, errors: opts.parseErrors?.[q] ?? [] })) } as T;
    },
  };
  const searches = () => calls.filter((c) => c.path === '/rest/api/3/search/jql');
  const worklogCalls = () => calls.filter((c) => c.path.endsWith('/worklog')).map((c) => c.path.split('/')[5]);
  return { client, calls, searches, worklogCalls };
}

let id = 0;
const worklog = (accountId: string, started: string, hours: number) => ({
  id: String(++id),
  issueId: '0',
  author: { accountId, displayName: { a: 'Alice', b: 'Bob' }[accountId] ?? accountId },
  started,
  timeSpentSeconds: hours * H,
  created: '2026-09-30T20:00:00.000+0000',
});

const run = (jira: JiraClient, sheets: object[], filter: object = {}) =>
  generateTemplateReport(
    jira,
    cfg,
    FIELDS,
    GlobalFilterSchema.parse({ from: '2026-09-01', to: '2026-09-29', ...filter }),
    TemplateBodySchema.parse({ name: 'T', sheets }),
  );

const ISSUES = [
  issue('FFN-1', { summary: 'Login', status: { name: 'Done' }, [CF]: 'TPX-65' }),
  issue('FFN-2', { summary: 'Docs', status: { name: 'To Do' }, [CF]: null }),
  issue('FFN-3', { summary: 'Billing', status: { name: 'Done' }, [CF]: 'TPX-70' }),
];
const WORKLOGS = {
  'FFN-1': [worklog('a', '2026-09-02T10:00:00.000+0600', 2), worklog('b', '2026-09-03T10:00:00.000+0600', 3)],
  'FFN-2': [worklog('a', '2026-09-04T10:00:00.000+0600', 4)],
  'FFN-3': [worklog('b', '2026-09-05T10:00:00.000+0600', 1)],
};

const ACCEPTANCE_3 = [
  { name: 'All', rows: { mode: 'group', groupBy: ['worklog.author', 'issue.key'] } },
  { name: 'Billable', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { conditions: [{ fieldId: CF, op: 'isNotEmpty' }] } },
  { name: 'Done', rows: { mode: 'eachIssue' }, columns: ['issue.key', 'status', 'metric.hours'], filter: { jql: 'status = Done' } },
];

describe('generateTemplateReport', () => {
  it('acceptance 3: three sheets, one global search + one keys-only search per sheet JQL, worklogs fetched once per issue', async () => {
    const jira = fakeJira({ search: ISSUES, sheetJql: { 'status = Done': ['FFN-1', 'FFN-3'] }, worklogs: WORKLOGS });
    const r = await run(jira.client, ACCEPTANCE_3, { projects: ['ffn'] });

    const searches = jira.searches();
    expect(searches).toHaveLength(2);
    expect(String(searches[0]!.query.jql)).toBe(
      'worklogDate >= "2026-08-31" AND worklogDate <= "2026-09-30" AND project in ("FFN") ORDER BY key ASC',
    );
    expect(searches[1]!.query).toMatchObject({
      jql: 'worklogDate >= "2026-08-31" AND worklogDate <= "2026-09-30" AND project in ("FFN") AND (status = Done) ORDER BY key ASC',
      fields: 'key',
    });
    expect(jira.worklogCalls().sort()).toEqual(['FFN-1', 'FFN-2', 'FFN-3']);

    const [all, billable, done] = r.sheets;
    expect(r.sheets.map((s) => [s.name, s.mode, s.total])).toEqual([
      ['All', 'group', 10 * H],
      ['Billable', 'group', 6 * H],
      ['Done', 'eachIssue', 6 * H],
    ]);
    for (const s of r.sheets) expect(s.total).toBeLessThanOrEqual(all!.total);
    expect((billable as GroupSheetResult).tree.nodes.map((n) => n.value)).toEqual(['FFN-1', 'FFN-3']);
    expect((done as FlatSheetResult).rows.map((x) => x.cells)).toEqual([
      ['FFN-3', 'Done', 1 * H],
      ['FFN-1', 'Done', 5 * H],
    ]);
    expect(r).toMatchObject({ complete: true, failedIssueKeys: [], warnings: [], from: '2026-09-01', to: '2026-09-29', timeZone: 'Asia/Dhaka', hoursPerDay: 8 });
    expect(r.filter.projects).toEqual(['FFN']);
    expect(r.worklogs).toHaveLength(4);
    expect(r.issues.map((i) => i.key)).toEqual(['FFN-3', 'FFN-2', 'FFN-1']);
  });

  it('validates every sheet JQL in one /jql/parse call (alone and combined with the global JQL)', async () => {
    const jira = fakeJira({ search: ISSUES, sheetJql: { 'status = Done': ['FFN-1'], 'labels = x': [] }, worklogs: WORKLOGS });
    await run(jira.client, [
      { name: 'A', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'status = Done' } },
      { name: 'B', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'labels = x' } },
      { name: 'C', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'status = Done' } },
    ]);
    const posts = jira.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { queries: string[] }).queries).toHaveLength(6);
    expect(jira.searches()).toHaveLength(3); // global + 2 distinct sheet JQLs
  });

  it('no sheet JQL → no /jql/parse call and no extra search', async () => {
    const jira = fakeJira({ search: ISSUES, worklogs: WORKLOGS });
    await run(jira.client, [{ name: 'A', rows: { mode: 'group', groupBy: ['status'] } }]);
    expect(jira.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(jira.searches()).toHaveLength(1);
  });

  it('invalid sheet JQL → InvalidJqlError naming the sheet', async () => {
    const jira = fakeJira({ search: ISSUES, worklogs: WORKLOGS, parseErrors: { 'stauts = Done': ["Field 'stauts' does not exist"] } });
    const p = run(jira.client, [{ name: 'Done', rows: { mode: 'group', groupBy: ['status'] }, filter: { jql: 'stauts = Done' } }]);
    await expect(p).rejects.toBeInstanceOf(InvalidJqlError);
    await expect(p).rejects.toThrow(`Sheet "Done": invalid JQL: Field 'stauts' does not exist`);
    expect(jira.worklogCalls()).toEqual([]);
  });

  it('fields= is the union of every sheet field that lives on the issue, plus the base fields', async () => {
    const jira = fakeJira({ search: ISSUES, worklogs: WORKLOGS });
    await run(jira.client, [
      { name: 'A', rows: { mode: 'group', groupBy: ['worklog.author', 'issue.keySummary'] }, columns: [CF] },
      { name: 'B', rows: { mode: 'eachWorklog' }, columns: ['worklog.started', 'metric.hours', 'parent.key', 'assignee.id'] },
      { name: 'C', rows: { mode: 'eachIssue' }, columns: ['issue.key'], filter: { conditions: [{ fieldId: 'labels', op: 'isEmpty' }] } },
    ]);
    expect(String(jira.searches()[0]!.query.fields).split(',').sort()).toEqual(
      ['assignee', CF, 'issuetype', 'labels', 'parent', 'project', 'status', 'summary'].sort(),
    );
  });

  it('issues no sheet can use get no worklog calls', async () => {
    const jira = fakeJira({ search: ISSUES, sheetJql: { 'status = Done': ['FFN-1'] }, worklogs: WORKLOGS });
    const r = await run(jira.client, [
      { name: 'Done', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { jql: 'status = Done' } },
      { name: 'Billing', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { conditions: [{ fieldId: 'summary', op: 'contains', value: 'bill' }] } },
    ]);
    expect(jira.worklogCalls().sort()).toEqual(['FFN-1', 'FFN-3']);
    expect(r.sheets.map((s) => s.total)).toEqual([5 * H, 1 * H]);
  });

  it('authors and the exact date range apply to every sheet (global filter)', async () => {
    const jira = fakeJira({
      search: ISSUES,
      worklogs: { ...WORKLOGS, 'FFN-2': [worklog('a', '2026-09-29T18:00:00.000+0000', 4)] }, // Sep 30 in Dhaka: out
    });
    const r = await run(jira.client, [{ name: 'A', rows: { mode: 'eachWorklog' }, columns: ['worklog.author', 'metric.hours'] }], { authors: ['a'] });
    expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.cells)).toEqual([['Alice', 2 * H]]);
  });

  it('rollup in one sheet loads the parents once; epic in another resolves the chain', async () => {
    const jira = fakeJira({
      search: [issue('FFN-5', { summary: 'Sub', issuetype: SUBTASK, status: { name: 'Open' }, parent: { key: 'FFN-4', fields: { issuetype: STORY } } })],
      byKey: [
        issue('FFN-4', { summary: 'Story', status: { name: 'Open' }, parent: { key: 'FFN-100', fields: { summary: 'Big', issuetype: EPIC } } }),
      ],
      worklogs: { 'FFN-5': [worklog('a', '2026-09-02T10:00:00.000+0600', 2)] },
    });
    const r = await run(jira.client, [
      { name: 'Rolled', rows: { mode: 'eachIssue' }, columns: ['issue.key', 'metric.hours'], sumSubtasksToParent: true },
      { name: 'Epics', rows: { mode: 'group', groupBy: ['epic'] } },
    ]);
    expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.cells)).toEqual([['FFN-4', 2 * H]]);
    expect((r.sheets[1] as GroupSheetResult).tree.nodes.map((n) => n.label)).toEqual(['FFN-100 Big']);
    expect(jira.searches().filter((c) => String(c.query.jql).startsWith('key in'))).toHaveLength(1);
  });

  it('an unloadable rollup parent gives one warning for the workbook; complete stays true', async () => {
    const jira = fakeJira({
      search: [issue('FFN-5', { summary: 'Sub', issuetype: SUBTASK, parent: { key: 'GONE-1', fields: { issuetype: STORY } } })],
      worklogs: { 'FFN-5': [worklog('a', '2026-09-02T10:00:00.000+0600', 2)] },
    });
    const r = await run(jira.client, [
      { name: 'A', rows: { mode: 'group', groupBy: ['issue.key'] }, sumSubtasksToParent: true },
      { name: 'B', rows: { mode: 'eachIssue' }, columns: ['issue.key'], sumSubtasksToParent: true },
    ]);
    expect(r.complete).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('GONE-1 could not be loaded');
  });

  it('a failed worklog fetch makes the whole workbook incomplete', async () => {
    const jira = fakeJira({ search: ISSUES, worklogs: WORKLOGS, failWorklogs: ['FFN-2'] });
    const r = await run(jira.client, [
      { name: 'A', rows: { mode: 'group', groupBy: ['issue.key'] } },
      { name: 'B', rows: { mode: 'group', groupBy: ['issue.key'] }, filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'Done' }] } },
    ]);
    expect(r.complete).toBe(false);
    expect(r.failedIssueKeys).toEqual(['FFN-2']);
    expect(r.failureReasons?.length).toBeGreaterThan(0);
  });

  it('rejects unknown fields (naming the sheet) and too-long ranges before calling Jira', async () => {
    const jira = fakeJira({ search: ISSUES, worklogs: WORKLOGS });
    await expect(run(jira.client, [{ name: 'Mine', rows: { mode: 'group', groupBy: ['customfield_99999'] } }])).rejects.toThrow(UnknownFieldError);
    await expect(run(jira.client, [{ name: 'Mine', rows: { mode: 'group', groupBy: ['customfield_99999'] } }])).rejects.toThrow(/Sheet "Mine"/);
    await expect(run(jira.client, [{ name: 'A', rows: { mode: 'group', groupBy: ['status'] } }], { to: '2026-10-15' })).rejects.toThrow();
    expect(jira.calls).toHaveLength(0);
  });

  describe('each issue + includeIssuesWithoutWorklogs', () => {
    const IDLE = [
      issue('FFN-9', { summary: 'Idle', status: { name: 'Done' }, [CF]: null }),
      issue('FFN-8', { summary: 'Hold', status: { name: 'Done' }, [CF]: null }),
    ];
    const issuesSheet = (more: object = {}) => ({
      name: 'Issues',
      rows: { mode: 'eachIssue' },
      columns: ['issue.key', 'status', 'metric.hours'],
      includeIssuesWithoutWorklogs: true,
      ...more,
    });

    it('one extra search (global projects + sheet JQL, no date/author), conditions in code, 0 hours, no worklog calls', async () => {
      const jira = fakeJira({
        search: ISSUES,
        projectIssues: [...ISSUES, ...IDLE],
        sheetJql: { 'status = Done': ['FFN-1', 'FFN-3', 'FFN-8', 'FFN-9'] },
        worklogs: WORKLOGS,
      });
      const r = await run(
        jira.client,
        [issuesSheet({ filter: { jql: 'status = Done', conditions: [{ fieldId: 'summary', op: 'contains', value: 'i' }] } })],
        { projects: ['ffn'], authors: ['a', 'b'] },
      );
      const extra = jira.searches().filter((c) => String(c.query.jql).endsWith('ORDER BY key DESC'));
      expect(extra).toHaveLength(1);
      expect(extra[0]!.query.jql).toBe('project in ("FFN") AND (status = Done) ORDER BY key DESC');
      expect(String(extra[0]!.query.fields).split(',')).toEqual(expect.arrayContaining(['summary', 'status']));
      expect(jira.worklogCalls().sort()).toEqual(['FFN-1', 'FFN-3']);
      // FFN-8 "Hold" fails "Summary contains i"; FFN-9 has no time.
      expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.cells)).toEqual([
        ['FFN-9', 'Done', 0],
        ['FFN-3', 'Done', 1 * H],
        ['FFN-1', 'Done', 5 * H],
      ]);
      expect(r.sheets[0]!.total).toBe(6 * H);
      expect(r.issues.map((i) => i.key)).toEqual(['FFN-3', 'FFN-1']); // issues time was logged on
      expect(r.warnings).toEqual([]);
    });

    it('identical extra searches run once', async () => {
      const jira = fakeJira({ search: ISSUES, projectIssues: [...ISSUES, ...IDLE], worklogs: WORKLOGS });
      const r = await run(jira.client, [issuesSheet(), issuesSheet({ name: 'Again' })], { projects: ['FFN'] });
      const extra = jira.searches().filter((c) => String(c.query.jql).endsWith('ORDER BY key DESC'));
      expect(extra.map((c) => c.query.jql)).toEqual(['project in ("FFN") ORDER BY key DESC']);
      for (const s of r.sheets) expect((s as FlatSheetResult).rows.map((x) => x.key)).toEqual(['FFN-9', 'FFN-8', 'FFN-3', 'FFN-2', 'FFN-1']);
      expect(issuesWithoutWorklogsJql(['A', 'B'], undefined)).toBe('project in ("A", "B") ORDER BY key DESC');
      expect(issuesWithoutWorklogsJql(['A'], 'x = 1', ['status = "Done"'])).toBe('project in ("A") AND (status = "Done") AND (x = 1) ORDER BY key DESC');
    });

    it('needs at least one global project: 400 before any Jira call', async () => {
      const jira = fakeJira({ search: ISSUES, projectIssues: IDLE, worklogs: WORKLOGS });
      const err = await run(jira.client, [{ name: 'All', rows: { mode: 'group', groupBy: ['status'] } }, issuesSheet()]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidTemplateRunError);
      expect(err).toMatchObject({
        statusCode: 400,
        message: 'Sheet "Issues" also lists issues without time, which needs at least one project. Pick one or more projects in the filter.',
      });
      expect(jira.calls).toHaveLength(0);
      // Without the option, no projects is fine.
      await expect(run(jira.client, [issuesSheet({ includeIssuesWithoutWorklogs: false })])).resolves.toBeDefined();
    });

    it('JQL-expressible conditions go into the extra JQL when Jira accepts them; every condition is still checked in code', async () => {
      const labelsClause = 'labels in ("x", "y")';
      const jira = fakeJira({
        search: ISSUES,
        // The fake ignores the condition clauses: FFN-7 (Open) would be listed if the in-code re-check were skipped.
        projectIssues: [...ISSUES, ...IDLE, issue('FFN-7', { summary: 'Idle', status: { name: 'Open' }, [CF]: 'TPX-1' })],
        sheetJql: { 'type = Task': ['FFN-1', 'FFN-3', 'FFN-7', 'FFN-8', 'FFN-9'] },
        worklogs: WORKLOGS,
        parseErrors: { [labelsClause]: ['not supported'] },
      });
      const conditions = [
        { fieldId: 'status', op: 'is', value: 'Done' },
        { fieldId: CF, op: 'isNotEmpty' },
        { fieldId: 'labels', op: 'in', value: ['x', 'y'] }, // rejected by Jira's parser → code only
        { fieldId: 'summary', op: 'contains', value: 'i' }, // JQL ~ is a word search → code only
        { fieldId: 'worklog.author', op: 'is', value: 'a' }, // worklog-level → code only
      ];
      const r = await run(jira.client, [issuesSheet({ filter: { jql: 'type = Task', conditions } })], { projects: ['FFN'] });

      const parses = jira.calls.filter((c) => c.path === '/rest/api/3/jql/parse').map((c) => (c.body as { queries: string[] }).queries);
      expect(parses).toContainEqual(['status = "Done"', 'cf[10050] is not EMPTY', labelsClause]);
      const extra = jira.searches().filter((c) => String(c.query.jql).endsWith('ORDER BY key DESC'));
      expect(extra.map((c) => c.query.jql)).toEqual([
        'project in ("FFN") AND (status = "Done") AND (cf[10050] is not EMPTY) AND (type = Task) ORDER BY key DESC',
      ]);
      // labels/summary/status/CF re-checked in code: no issue has labels x or y, so nothing passes.
      expect((r.sheets[0] as FlatSheetResult).rows).toEqual([]);
    });

    it('in-code re-check drops what the JQL let through; no parse call without JQL-expressible conditions', async () => {
      const jira = fakeJira({
        search: ISSUES,
        projectIssues: [...ISSUES, ...IDLE, issue('FFN-7', { summary: 'Idle', status: { name: 'Open' }, [CF]: 'TPX-1' })],
        worklogs: WORKLOGS,
      });
      const r = await run(jira.client, [issuesSheet({ filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'done' }] } })], { projects: ['FFN'] });
      expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.key)).toEqual(['FFN-9', 'FFN-8', 'FFN-3', 'FFN-1']);

      const plain = fakeJira({ search: ISSUES, projectIssues: IDLE, worklogs: WORKLOGS });
      await run(plain.client, [issuesSheet({ filter: { conditions: [{ fieldId: 'summary', op: 'contains', value: 'i' }] } })], { projects: ['FFN'] });
      expect(plain.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('the whole /jql/parse call rejected (400) → conditions stay code-only', async () => {
      const jira = fakeJira({ search: ISSUES, projectIssues: [...ISSUES, ...IDLE], worklogs: WORKLOGS });
      jira.client.post = async () => {
        throw new JiraError('Jira 400 on /rest/api/3/jql/parse: bad', 400, '/rest/api/3/jql/parse');
      };
      const r = await run(jira.client, [issuesSheet({ filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'Done' }] } })], { projects: ['FFN'] });
      const extra = jira.searches().filter((c) => String(c.query.jql).endsWith('ORDER BY key DESC'));
      expect(extra.map((c) => c.query.jql)).toEqual(['project in ("FFN") ORDER BY key DESC']);
      expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.key)).toEqual(['FFN-9', 'FFN-8', 'FFN-3', 'FFN-1']);
    });

    it(`caps the extra search at ${MAX_ISSUES_WITHOUT_WORKLOGS} issues with a warning (complete stays true)`, async () => {
      const many = Array.from({ length: MAX_ISSUES_WITHOUT_WORKLOGS + 1 }, (_, i) => issue(`FFN-${10_000 - i}`, { summary: 'x', status: { name: 'Open' } }));
      const jira = fakeJira({ search: ISSUES, projectIssues: many, worklogs: WORKLOGS });
      const r = await run(jira.client, [issuesSheet()], { projects: ['FFN'] });
      const rows = (r.sheets[0] as FlatSheetResult).rows;
      expect(rows).toHaveLength(MAX_ISSUES_WITHOUT_WORKLOGS + ISSUES.length);
      expect(rows.some((x) => x.key === `FFN-${10_000 - MAX_ISSUES_WITHOUT_WORKLOGS}`)).toBe(false);
      expect(r.complete).toBe(true);
      expect(r.warnings).toEqual([
        `Sheet "Issues": more than ${MAX_ISSUES_WITHOUT_WORKLOGS} issues match without the date range, so only the newest ${MAX_ISSUES_WITHOUT_WORKLOGS} are listed. Narrow the projects or the sheet's JQL.`,
      ]);
    });

    it('without the option there is no extra search', async () => {
      const jira = fakeJira({ search: ISSUES, projectIssues: IDLE, worklogs: WORKLOGS });
      const r = await run(jira.client, [issuesSheet({ includeIssuesWithoutWorklogs: false })]);
      expect(jira.searches()).toHaveLength(1);
      expect((r.sheets[0] as FlatSheetResult).rows.map((x) => x.key)).toEqual(['FFN-3', 'FFN-2', 'FFN-1']);
    });
  });
});
