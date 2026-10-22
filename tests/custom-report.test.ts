import { describe, expect, it } from 'vitest';
import { JiraError, type JiraClient, type QueryValue } from '../src/jira/client.js';
import { KEY_CHUNK } from '../src/jira/custom.js';
import { generateTemplateReport, UnknownFieldError } from '../src/services/customReport.js';
import { buildFieldList, type JiraFieldRaw } from '../src/services/custom/fields.js';
import { InvalidJqlError } from '../src/services/custom/filter.js';
import type { TemplateReport } from '../src/services/custom/result.js';
import type { GroupSheetResult } from '../src/services/custom/sheets.js';
import { GlobalFilterSchema, TemplateBodySchema } from '../src/services/custom/template.js';
import { UnknownProjectError } from '../src/services/report.js';

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
] satisfies JiraFieldRaw[]);

const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31, HOURS_PER_DAY: 8 };

type Issue = { key: string; fields: Record<string, unknown> };
const issue = (key: string, fields: Record<string, unknown>): Issue => ({ key, fields: { project: PROJECT, issuetype: STORY, ...fields } });

interface FakeJira extends JiraClient {
  calls: Array<{ path: string; query: Record<string, QueryValue> }>;
}

/** `search` = issues the main JQL returns; `byKey` = issues loadable via `key in (...)`; `worklogs` per issue key. */
function fakeJira(opts: {
  search: Issue[];
  byKey?: Issue[];
  worklogs: Record<string, unknown[]>;
  failWorklogs?: string[];
  parseErrors?: string[];
}): FakeJira {
  const calls: FakeJira['calls'] = [];
  const all = new Map([...(opts.byKey ?? []), ...opts.search].map((i) => [i.key, i]));
  return {
    baseUrl: 'https://one.atlassian.net',
    calls,
    async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
      calls.push({ path, query });
      if (path === '/rest/api/3/project/search') return { isLast: true, values: [{ id: '1', ...PROJECT }] } as T;
      if (path === '/rest/api/3/search/jql') {
        const jql = String(query.jql);
        const m = /^key in \((.*)\)$/.exec(jql);
        if (!m) return { issues: opts.search, isLast: true } as T;
        const keys = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
        // Like Jira: one unknown key rejects the whole query.
        if (keys.some((k) => !all.has(k))) throw new JiraError(`Jira 400 on ${path}: An issue with key does not exist`, 400, path);
        return { issues: keys.map((k) => all.get(k)), isLast: true } as T;
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
      calls.push({ path, query: {} });
      const queries = (body as { queries: string[] }).queries;
      return { queries: queries.map((q, i) => ({ query: q, errors: i === 0 ? opts.parseErrors ?? [] : [] })) } as T;
    },
  };
}

let id = 0;
const worklog = (accountId: string, started: string, hours: number, extra: Record<string, unknown> = {}) => ({
  id: String(++id),
  issueId: '0',
  author: { accountId, displayName: { a: 'Alice', b: 'Bob' }[accountId] ?? accountId },
  started,
  timeSpentSeconds: hours * H,
  created: '2026-09-30T20:00:00.000+0000',
  ...extra,
});

/** One-sheet template (sheet "S"); `groupBy` is shorthand for a group sheet. */
const run = (jira: JiraClient, filter: object, sheet: { groupBy?: unknown[]; [k: string]: unknown }) => {
  const { groupBy, ...rest } = sheet;
  return generateTemplateReport(
    jira,
    cfg,
    FIELDS,
    GlobalFilterSchema.parse({ from: '2026-09-01', to: '2026-09-30', ...filter }),
    TemplateBodySchema.parse({ name: 'T', sheets: [{ name: 'S', ...(groupBy ? { rows: { mode: 'group', groupBy } } : {}), ...rest }] }),
  );
};
const tree = (r: TemplateReport) => (r.sheets[0] as GroupSheetResult).tree;

// The single-layout pipeline cases (Phase 8 Step 3), run as one-sheet templates.
describe('generateTemplateReport: one sheet', () => {
  it('requests the union of used fields + base fields in one search; no per-issue calls besides worklogs', async () => {
    const jira = fakeJira({
      search: [issue('FFN-1', { summary: 'Login', status: { name: 'Done' }, [CF]: 'TPX-65' })],
      worklogs: { 'FFN-1': [worklog('a', '2026-09-02T10:00:00.000+0600', 2, { comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } })] },
    });
    const r = await run(
      jira,
      {},
      {
        groupBy: ['worklog.author', { fieldId: 'issue.key', label: 'Issue key' }],
        columns: [{ fieldId: CF, label: '  ' }], // blank label = the field name
        filter: { conditions: [{ fieldId: 'status', op: 'is', value: 'done' }] },
      },
    );
    const searches = jira.calls.filter((c) => c.path === '/rest/api/3/search/jql');
    expect(searches).toHaveLength(1);
    expect(String(searches[0]!.query.fields).split(',').sort()).toEqual(['assignee', CF, 'issuetype', 'parent', 'project', 'status', 'summary'].sort());
    expect(jira.calls.map((c) => c.path).filter((p) => p.includes('/issue/'))).toEqual(['/rest/api/3/issue/FFN-1/worklog']);
    expect(r.complete).toBe(true);
    expect(tree(r).total).toBe(2 * H);
    expect(tree(r).nodes[0]!.children[0]!.columns[CF]).toBe('TPX-65');
    expect(r.sheets[0]!.headers).toEqual({ groupBy: ['Worklog Author', 'Issue key'], columns: ['Client Reference'], total: 'Total' });
    expect(r.worklogs[0]).toMatchObject({ issueKey: 'FFN-1', attributedTo: 'FFN-1', comment: 'hi', date: '2026-09-02', createdDate: '2026-10-01' });
    expect(r.fields.map((f) => f.name)).toEqual(['Worklog Author', 'Issue', 'Client Reference', 'Status']);
    expect(r.hoursPerDay).toBe(8);
    expect(r.jql).not.toContain('status'); // sheet conditions run in code, never in the global JQL
  });

  it('uses REPORT_TZ calendar dates: day boundaries and the exact [from, to] range', async () => {
    const jira = fakeJira({
      search: [issue('FFN-1', { summary: 'x' })],
      worklogs: {
        'FFN-1': [
          worklog('a', '2026-08-31T18:30:00.000+0000', 1), // 00:30 Sep 1 in Dhaka → in
          worklog('a', '2026-08-31T17:59:00.000+0000', 1), // 23:59 Aug 31 in Dhaka → out
          worklog('a', '2026-09-30T17:59:00.000+0000', 2), // 23:59 Sep 30 → in, day 30
          worklog('a', '2026-09-30T18:00:00.000+0000', 4), // 00:00 Oct 1 → out
        ],
      },
    });
    const r = await run(jira, {}, { groupBy: ['worklog.date'], period: 'day' });
    expect(tree(r).nodes.map((n) => [n.label, n.total])).toEqual([
      ['2026-09-01', 1 * H],
      ['2026-09-30', 2 * H],
    ]);
    expect(tree(r).periodKeys).toHaveLength(30);
    expect(tree(r).total).toBe(3 * H);
  });

  it('rollup + epic: loads the missing parent and grandparent in batches, then groups by the parent values', async () => {
    const jira = fakeJira({
      search: [
        issue('FFN-3', { summary: 'Sub', issuetype: SUBTASK, status: { name: 'Open' }, parent: { key: 'FFN-2', fields: { issuetype: STORY } } }),
        issue('FFN-9', { summary: 'Loose', status: { name: 'Open' } }),
      ],
      byKey: [
        // Story whose embedded parent lacks the issue type, so the epic needs a second batch.
        issue('FFN-2', { summary: 'Story', status: { name: 'Done' }, parent: { key: 'FFN-1', fields: { summary: 'Epic' } } }),
        issue('FFN-1', { summary: 'Big epic', issuetype: EPIC }),
      ],
      worklogs: { 'FFN-3': [worklog('a', '2026-09-05T10:00:00.000+0600', 3)], 'FFN-9': [worklog('b', '2026-09-05T10:00:00.000+0600', 1)] },
    });
    const r = await run(jira, {}, { groupBy: ['epic', 'issue.key', 'status'], sumSubtasksToParent: true });
    const batches = jira.calls.filter((c) => String(c.query.jql).startsWith('key in')).map((c) => c.query.jql);
    expect(batches).toEqual(['key in ("FFN-2")', 'key in ("FFN-1")']);
    expect(r.complete).toBe(true);
    expect(tree(r).nodes.map((n) => n.label)).toEqual(['FFN-1 Big epic', '(none)']);
    const story = tree(r).nodes[0]!.children[0]!;
    expect([story.label, story.total, story.children[0]!.label]).toEqual(['FFN-2', 3 * H, 'Done']);
    // Parents are loaded for their fields only; their worklogs are not fetched.
    expect(jira.calls.some((c) => c.path.includes('FFN-2/worklog'))).toBe(false);
    // Rollup is per sheet: the response worklog stays on its own issue; the sheet's node holds it.
    const sub = r.worklogs.find((w) => w.issueKey === 'FFN-3')!;
    expect(sub.attributedTo).toBe('FFN-3');
    expect(story.worklogIds).toEqual([sub.id]);
  });

  it(`batches parent loads by ${KEY_CHUNK} keys; an unloadable parent groups as "KEY (unavailable)" with a warning, still complete`, async () => {
    const subs = Array.from({ length: KEY_CHUNK + 1 }, (_, i) =>
      issue(`FFN-${1000 + i}`, { issuetype: SUBTASK, parent: { key: `P-${i}`, fields: { issuetype: STORY } } }),
    );
    const parents = subs.slice(1).map((_, i) => issue(`P-${i + 1}`, { summary: 'parent', status: { name: 'Done' } })); // P-0 is gone
    const worklogs = Object.fromEntries(subs.map((s) => [s.key, [worklog('a', '2026-09-05T10:00:00.000+0600', 1)]]));
    const jira = fakeJira({ search: subs, byKey: parents, worklogs });
    const r = await run(jira, {}, { groupBy: ['issue.key', 'status'], sumSubtasksToParent: true });
    expect(r.complete).toBe(true);
    expect(r.failedIssueKeys).toEqual([]);
    expect(r.failureReasons).toBeUndefined();
    expect(r.warnings).toEqual(['P-0 could not be loaded (deleted, moved or no permission). Time logged on FFN-1000 is grouped under "P-0 (unavailable)".']);
    expect(tree(r).nodes).toHaveLength(KEY_CHUNK + 1);
    expect(tree(r).total).toBe((KEY_CHUNK + 1) * H);
    const gone = tree(r).nodes.find((n) => n.value === 'P-0')!;
    expect([gone.label, gone.total, gone.children.map((c) => c.label)]).toEqual(['P-0 (unavailable)', 1 * H, ['P-0 (unavailable)']]);
    expect(jira.calls.some((c) => c.path.includes('FFN-1000/worklog'))).toBe(true);
  });

  it('an unloadable link in the epic chain groups under "KEY (unavailable)"; worklog failures still make it incomplete', async () => {
    const jira = fakeJira({
      search: [
        issue('FFN-1', { summary: 'Orphan', parent: { key: 'GONE-1', fields: { issuetype: STORY } } }),
        issue('FFN-2', { summary: 'Under epic', parent: { key: 'FFN-10', fields: { summary: 'Epic', issuetype: EPIC } } }),
        issue('FFN-3', { summary: 'Broken', parent: { key: 'GONE-1', fields: { issuetype: STORY } } }),
      ],
      worklogs: { 'FFN-1': [worklog('a', '2026-09-05T10:00:00.000+0600', 2)], 'FFN-2': [worklog('a', '2026-09-05T10:00:00.000+0600', 1)] },
      failWorklogs: ['FFN-3'],
    });
    const r = await run(jira, {}, { groupBy: ['epic'] });
    expect(tree(r).nodes.map((n) => [n.label, n.total])).toEqual([
      ['FFN-10 Epic', 1 * H],
      ['GONE-1 (unavailable)', 2 * H],
    ]);
    expect(r.warnings).toEqual(['GONE-1 could not be loaded (deleted, moved or no permission). Time logged on FFN-1 is grouped under "GONE-1 (unavailable)".']);
    expect(r.complete).toBe(false);
    expect(r.failedIssueKeys).toEqual(['FFN-3']);
  });

  it('"contains" is a substring match in code: non-matching issues are dropped before fetching worklogs', async () => {
    const jira = fakeJira({
      search: [issue('FFN-1', { [CF]: 'TPX-65' }), issue('FFN-2', { [CF]: 'TPX 65' })],
      worklogs: { 'FFN-1': [worklog('a', '2026-09-02T10:00:00.000+0600', 1)], 'FFN-2': [worklog('a', '2026-09-02T10:00:00.000+0600', 1)] },
    });
    const r = await run(jira, {}, { groupBy: ['issue.key'], filter: { conditions: [{ fieldId: CF, op: 'contains', value: 'TPX-65' }] } });
    expect(tree(r).nodes.map((n) => n.label)).toEqual(['FFN-1']);
    expect(jira.calls.some((c) => c.path.includes('FFN-2/worklog'))).toBe(false);
    expect(r.jql).not.toContain('cf[10050]');
  });

  it('applies authors and worklog-level conditions in code', async () => {
    const jira = fakeJira({
      search: [issue('FFN-1', {})],
      worklogs: {
        'FFN-1': [
          worklog('a', '2026-09-02T10:00:00.000+0600', 1, { comment: 'billable work' }),
          worklog('a', '2026-09-03T10:00:00.000+0600', 2, { comment: 'meeting' }),
          worklog('b', '2026-09-02T10:00:00.000+0600', 4, { comment: 'billable' }),
        ],
      },
    });
    const r = await run(
      jira,
      { authors: ['a'] },
      { groupBy: ['worklog.author'], filter: { conditions: [{ fieldId: 'worklog.comment', op: 'contains', value: 'BILLABLE' }] } },
    );
    expect(tree(r).total).toBe(1 * H);
    expect(r.worklogs).toHaveLength(1);
  });

  it('a failed worklog fetch makes the report incomplete', async () => {
    const jira = fakeJira({
      search: [issue('FFN-1', {}), issue('FFN-2', {})],
      worklogs: { 'FFN-1': [worklog('a', '2026-09-02T10:00:00.000+0600', 1)] },
      failWorklogs: ['FFN-2'],
    });
    const r = await run(jira, {}, { groupBy: ['issue.key'] });
    expect(r.complete).toBe(false);
    expect(r.failedIssueKeys).toEqual(['FFN-2']);
    expect(r.failureReasons?.[0]).toMatch(/^1 issue\(s\): Jira server error/);
  });

  it('rejects unknown fields, unknown projects, invalid JQL and too-long ranges', async () => {
    const jira = fakeJira({ search: [], worklogs: {}, parseErrors: ["Field 'foo' does not exist"] });
    await expect(run(jira, {}, { groupBy: ['customfield_999'] })).rejects.toBeInstanceOf(UnknownFieldError);
    await expect(run(jira, { projects: ['NOPE'] }, { groupBy: ['status'] })).rejects.toBeInstanceOf(UnknownProjectError);
    const badJql = { groupBy: ['status'], filter: { jql: 'foo = 1' } };
    await expect(run(jira, {}, badJql)).rejects.toThrow(InvalidJqlError);
    await expect(run(jira, {}, badJql)).rejects.toThrow(`Sheet "S": invalid JQL: Field 'foo' does not exist`);
    await expect(run(jira, { to: '2026-10-15' }, { groupBy: ['status'] })).rejects.toThrow(/maximum is 31/);
  });

  it('canonicalises project keys (case-insensitive)', async () => {
    const jira = fakeJira({ search: [], worklogs: {} });
    const r = await run(jira, { projects: ['ffn'] }, { groupBy: ['status'] });
    expect(r.filter.projects).toEqual(['FFN']);
    expect(r.jql).toContain('project in ("FFN")');
    expect(r.complete).toBe(true);
    expect(tree(r).nodes).toEqual([]);
  });
});
