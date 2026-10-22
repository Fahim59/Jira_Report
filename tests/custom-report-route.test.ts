import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { JiraError, type JiraClient, type QueryValue, type RequestOptions } from '../src/jira/client.js';
import { FieldCache } from '../src/jira/fields.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { customReportRoutes } from '../src/routes/customReport.js';
import { reportRoutes } from '../src/routes/report.js';
import { RunRegistry } from '../src/services/runs.js';

const H = 3600;
const CF = 'customfield_10050';
const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31, HOURS_PER_DAY: 8 };
const PROJECT = { id: '1', key: 'FFN', name: 'Fun Fun' };
const STORY = { name: 'Story', subtask: false, hierarchyLevel: 0 };
const ISSUES = ['FFN-1', 'FFN-2', 'FFN-3'];

/** Resolves never; rejects with the signal's reason when it aborts (like the real client). */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

interface FakeOptions {
  hangOn?: string[];
  failWorklogs?: string[];
  /** Errors /jql/parse reports for the user's JQL. */
  jqlErrors?: string[];
  fieldsFail?: boolean;
}

function fakeJira(o: FakeOptions = {}) {
  const calls: { path: string; query?: Record<string, QueryValue> }[] = [];
  const client: JiraClient = {
    baseUrl: 'https://one.atlassian.net',
    async get<T>(path: string, query?: Record<string, QueryValue>, opts: RequestOptions = {}): Promise<T> {
      calls.push({ path, query });
      if (path === '/rest/api/3/field') {
        if (o.fieldsFail) throw new JiraError('Jira 503', 503, path);
        return [
          { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
          { id: 'status', name: 'Status', schema: { type: 'status' } },
          { id: 'summary', name: 'Summary', schema: { type: 'string' } },
        ] as T;
      }
      if (path === '/rest/api/3/project/search') return { isLast: true, values: [PROJECT] } as T;
      if (path === '/rest/api/3/search/jql') {
        return {
          isLast: true,
          issues: ISSUES.map((key, i) => ({
            key,
            fields: { summary: `Task ${i + 1}`, project: PROJECT, issuetype: STORY, status: { name: i ? 'Done' : 'Open' }, [CF]: `TPX-6${i}` },
          })),
        } as T;
      }
      const key = decodeURIComponent(/\/issue\/([^/]+)\/worklog$/.exec(path)![1]!);
      if (o.hangOn?.includes(key)) return hang(opts.signal);
      if (o.failWorklogs?.includes(key)) throw new JiraError('Jira 429', 429, path);
      const worklogs = [{ id: `${key}-w`, issueId: key, started: '2026-09-02T10:00:00.000+0600', timeSpentSeconds: 2 * H, author: { accountId: 'a', displayName: 'Alice' } }];
      return { startAt: 0, maxResults: 1000, total: 1, worklogs } as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path });
      const queries = (body as { queries: string[] }).queries;
      return { queries: queries.map((q, i) => ({ query: q, errors: i === 0 ? o.jqlErrors ?? [] : [] })) } as T;
    },
  };
  return { client, calls };
}

async function app(jira: JiraClient, timeoutSec = 30, runs = new RunRegistry()) {
  const a = Fastify();
  const sites = new SiteRegistry([{ key: 'one', url: 'https://one.atlassian.net', jira }]);
  const c = { ...cfg, REPORT_TIMEOUT_SEC: timeoutSec };
  await a.register(reportRoutes, { sites, cfg: c, runs });
  await a.register(customReportRoutes, { sites, fields: new FieldCache(), cfg: c, runs });
  return a;
}
type App = Awaited<ReturnType<typeof app>>;

const filter = { from: '2026-09-01', to: '2026-09-29', projects: ['ffn'] };
const groupBy = ['issue.key', 'issue.keySummary', 'status'];
const template = { name: 'Time Reports style', sheets: [{ name: 'Report', rows: { mode: 'group', groupBy } }] };
const withSheet = (sheet: object) => ({ ...template, sheets: [{ ...template.sheets[0], ...sheet }] });
const post = (a: App, payload: object, url = '/api/custom-report') => a.inject({ method: 'POST', url, payload });

describe('POST /api/custom-report', () => {
  it('returns one result per sheet, worklogs, issues, complete, failedIssueKeys and warnings', async () => {
    const res = await post(await app(fakeJira().client), { filter, template });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      site: 'one',
      from: '2026-09-01',
      to: '2026-09-29',
      filter: { projects: ['FFN'] }, // canonical project key
      template: {
        name: 'Time Reports style',
        defaults: { projects: [], authors: [] },
        sheets: [
          {
            name: 'Report',
            rows: { mode: 'group', groupBy: groupBy.map((fieldId) => ({ fieldId })) },
            columns: [],
            totals: true,
            period: 'none',
            format: 'hours',
            sumSubtasksToParent: false,
            sort: 'value',
            filter: { conditions: [] },
          },
        ],
      },
      sheets: [{ name: 'Report', mode: 'group', total: 3 * 2 * H, showTotals: true, headers: { groupBy: ['Issue', 'Issue (Key Summary)', 'Status'], columns: [] } }],
      complete: true,
      failedIssueKeys: [],
      warnings: [],
      timeZone: 'Asia/Dhaka',
      hoursPerDay: 8,
    });
    expect(body.worklogs).toHaveLength(3);
    expect(body.issues.map((i: { key: string }) => i.key)).toEqual(['FFN-3', 'FFN-2', 'FFN-1']); // newest first
    expect(body).not.toHaveProperty('layout');
    expect(body).not.toHaveProperty('nodes');
    const first = body.sheets[0].tree.nodes[0];
    expect([first.label, first.children[0].label, first.children[0].children[0].label, first.children[0].children[0].total]).toEqual([
      'FFN-1',
      'FFN-1 Task 1',
      'Open',
      2 * H,
    ]);
    expect(body).not.toHaveProperty('failureReasons');
  });

  it('N sheets from one fetch: labels as headers, flat rows, per-sheet narrowing, worklogs fetched once per issue', async () => {
    const jira = fakeJira();
    const res = await post(await app(jira.client), {
      filter,
      template: {
        name: 'Mixed',
        sheets: [
          { name: 'All', rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, 'issue.key'] }, columns: [{ fieldId: CF, label: 'Client' }] },
          {
            name: 'Work logs',
            rows: { mode: 'eachWorklog' },
            columns: [{ fieldId: 'worklog.author', label: 'Author' }, { fieldId: 'issue.key', label: 'Issue key' }, 'status', 'metric.hours'],
            filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'Done' }] },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const [all, logs] = res.json().sheets;
    expect(all).toMatchObject({ name: 'All', mode: 'group', total: 3 * 2 * H, headers: { groupBy: ['User', 'Issue'], columns: ['Client'] } });
    expect(logs).toMatchObject({ name: 'Work logs', mode: 'eachWorklog', total: 2 * 2 * H, showTotals: true, headers: { groupBy: [], columns: ['Author', 'Issue key', 'Status', 'Hours'] } });
    expect(logs.columns).toEqual(['worklog.author', 'issue.key', 'status', 'metric.hours']);
    expect(logs.rows.map((r: { cells: unknown[] }) => r.cells)).toEqual([
      ['Alice', 'FFN-2', 'Done', 2 * H],
      ['Alice', 'FFN-3', 'Done', 2 * H],
    ]);
    expect(jira.calls.filter((c) => c.path === '/rest/api/3/search/jql')).toHaveLength(1);
    expect(jira.calls.filter((c) => c.path.endsWith('/worklog')).map((c) => c.path)).toEqual(ISSUES.map((k) => `/rest/api/3/issue/${k}/worklog`));
  });

  it('accepts ?site= and filter.site; unknown site -> 400', async () => {
    const a = await app(fakeJira().client);
    expect((await post(a, { filter, template }, '/api/custom-report?site=ONE')).statusCode).toBe(200);
    expect((await post(a, { filter: { ...filter, site: 'one' }, template })).statusCode).toBe(200);
    const bad = await post(a, { filter: { ...filter, site: 'two' }, template });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Unknown site/);
  });

  it.each([
    ['missing template', { filter }, /template/],
    ['old single-layout body', { filter, layout: { groupBy } }, /template/],
    ['no sheets', { filter, template: { ...template, sheets: [] } }, /at least one sheet/],
    ['repeated group level', { filter, template: withSheet({ rows: { mode: 'group', groupBy: ['status', 'issue.key', 'status'] } }) }, /only once/],
    ['duplicate sheet names', { filter, template: { ...template, sheets: [template.sheets[0], { ...template.sheets[0], name: 'REPORT' }] } }, /used twice/],
    ['bad sheet name', { filter, template: withSheet({ name: 'a/b' }) }, /must not contain/],
    ['label too long', { filter, template: withSheet({ columns: [{ fieldId: 'status', label: 'x'.repeat(101) }] }) }, /label must be at most 100/],
    ['sheet filter on hours', { filter, template: withSheet({ filter: { conditions: [{ fieldId: 'metric.hours', op: 'isNotEmpty' }] } }) }, /template\.sheets\.0\.filter/],
    ['bad date', { filter: { ...filter, to: '2026-02-30' }, template }, /filter\.to/],
    ['bad requestId', { filter, template, requestId: 'x' }, /requestId/],
  ])('invalid body (%s) -> 400 naming the problem', async (_, payload, msg) => {
    const res = await post(await app(fakeJira().client), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msg);
  });

  it.each([
    ['range over MAX_RANGE_DAYS', { filter: { ...filter, to: '2026-10-05' }, template }, /range is 35 days; maximum is 31/],
    ['from > to', { filter: { ...filter, from: '2026-09-30', to: '2026-09-01' }, template }, /before|after/],
    ['unknown project', { filter: { ...filter, projects: ['NOPE'] }, template }, /Unknown project key "NOPE"/],
    ['unknown field', { filter, template: withSheet({ rows: { mode: 'group', groupBy: ['customfield_99999'] } }) }, /Sheet "Report": unknown field\(s\): customfield_99999/],
  ])('%s -> 400', async (_, payload, msg) => {
    const res = await post(await app(fakeJira().client), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msg);
  });

  it("invalid sheet JQL -> 400 with Jira's message naming the sheet; no search runs", async () => {
    const jira = fakeJira({ jqlErrors: ["Field 'foo' does not exist or you do not have permission to view it."] });
    const res = await post(await app(jira.client), { filter, template: withSheet({ filter: { jql: 'foo = 1' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`Sheet "Report": invalid JQL: Field 'foo' does not exist or you do not have permission to view it.`);
    expect(jira.calls.some((c) => c.path === '/rest/api/3/search/jql')).toBe(false);
  });

  it('a failed worklog fetch is reported as incomplete with a reason, never as complete', async () => {
    const res = await post(await app(fakeJira({ failWorklogs: ['FFN-2'] }).client), { filter, template });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      complete: false,
      failedIssueKeys: ['FFN-2'],
      failureReasons: ['1 issue(s): Jira rate limit (HTTP 429) persisted after retries'],
      sheets: [{ total: 2 * 2 * H }],
    });
  });

  it('field list failure -> Jira error status with a clear message', async () => {
    const res = await post(await app(fakeJira({ fieldsFail: true }).client), { filter, template });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/^Could not load fields\. Jira is having problems/);
  });

  it('timeout -> 504, no report body', async () => {
    const res = await post(await app(fakeJira({ hangOn: ['FFN-3'] }).client, 0.05), { filter, template });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: expect.stringMatching(/timed out/) });
  });

  it('double submit -> 409 (also across /api/report); cancel -> 204 and the run ends with 499', async () => {
    const runs = new RunRegistry();
    const a = await app(fakeJira({ hangOn: ['FFN-1'] }).client, 30, runs);
    const requestId = 'custom0123456789abcd';
    const first = post(a, { filter, template, requestId });
    await vi.waitFor(() => expect(runs.isRunning(requestId)).toBe(true));

    expect((await post(a, { filter, template, requestId })).statusCode).toBe(409);
    expect((await post(a, { from: '2026-09-01', to: '2026-09-02', requestId }, '/api/report')).statusCode).toBe(409);

    expect((await a.inject({ method: 'POST', url: '/api/custom-report/nope0123456789abcdef/cancel' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/custom-report/${requestId}/cancel` })).statusCode).toBe(204);
    expect((await first).statusCode).toBe(499);
    expect(runs.size).toBe(0);
  });

  it('streams progress stages over SSE', async () => {
    const runs = new RunRegistry();
    const a = await app(fakeJira().client, 30, runs);
    const requestId = 'customprogress012345';
    const sse = a.inject({ method: 'GET', url: `/api/custom-report/progress/${requestId}` });
    await vi.waitFor(() => expect(runs.size).toBe(1));
    expect((await post(a, { filter, template, requestId })).statusCode).toBe(200);

    const res = await sse;
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as { stage: string });
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(['validating', 'searching', 'worklogs', 'processing', 'done']));
    expect(events).toContainEqual({ stage: 'searching', issues: ISSUES.length });
    expect(events.at(-1)).toEqual({ stage: 'done' });
    expect(runs.size).toBe(0);
  });
});

describe('POST /api/custom-report: issues without time', () => {
  it('needs at least one global project: 400 with a clear message, no report calls', async () => {
    const jira = fakeJira();
    const sheet = { name: 'Issues', rows: { mode: 'eachIssue' }, columns: ['issue.key'], includeIssuesWithoutWorklogs: true };
    const res = await post(await app(jira.client), { filter: { ...filter, projects: [] }, template: { name: 'T', sheets: [sheet] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Sheet "Issues" also lists issues without time, which needs at least one project. Pick one or more projects in the filter.',
    });
    expect(jira.calls.filter((c) => c.path !== '/rest/api/3/field')).toEqual([]);
  });
});
