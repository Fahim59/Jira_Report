import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJiraClient, JiraError, type JiraClient, type QueryValue, type RequestOptions } from '../src/jira/client.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { reportRoutes } from '../src/routes/report.js';
import { generateReport, ReportAbortedError, UnknownProjectError } from '../src/services/report.js';
import { RunRegistry } from '../src/services/runs.js';
import type { JiraWorklog } from '../src/types.js';

const H = 3600;
const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31 };
const range = { from: '2026-10-01', to: '2026-10-02' };
const ISSUES = ['TPX-1', 'TPX-2', 'TPX-3', 'TPX-4'];

const worklog = (id: string): JiraWorklog => ({
  id,
  issueId: id,
  started: '2026-10-01T09:00:00.000+0600',
  timeSpentSeconds: H,
  author: { accountId: 'acc-a', displayName: 'Alice' },
});

/** Resolves never; rejects with the signal's reason when it aborts (like the real client). */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

interface FakeOptions {
  /** Worklog fetches for these issues never finish on their own. */
  hangOn?: string[];
  /** Called on every request; return a value/promise to override the default answer. */
  override?: (path: string, opts: RequestOptions) => Promise<unknown> | undefined;
}

function fakeJira(o: FakeOptions = {}) {
  const calls: { path: string; query?: Record<string, QueryValue>; signal?: AbortSignal }[] = [];
  const client: JiraClient = {
    baseUrl: 'https://example.atlassian.net',
    async get<T>(path: string, query?: Record<string, QueryValue>, opts: RequestOptions = {}): Promise<T> {
      calls.push({ path, query, signal: opts.signal });
      const custom = o.override?.(path, opts);
      if (custom) return custom as Promise<T>;
      if (path === '/rest/api/3/project/search') {
        return { startAt: 0, maxResults: 100, isLast: true, values: [{ id: '1', key: 'TPX', name: 'Tapix' }, { id: '2', key: 'OPS', name: 'Ops' }] } as T;
      }
      if (path === '/rest/api/3/search/jql') {
        return { issues: ISSUES.map((key) => ({ id: key, key, fields: { summary: key, project: { id: '1', key: 'TPX', name: 'Tapix' } } })), isLast: true } as T;
      }
      const key = decodeURIComponent(/\/issue\/([^/]+)\/worklog$/.exec(path)![1]!);
      if (o.hangOn?.includes(key)) return hang(opts.signal);
      return { startAt: 0, maxResults: 1000, total: 1, worklogs: [worklog(key)] } as T;
    },
  };
  return { client, calls };
}

describe('report timeout', () => {
  it('rejects with a timeout error instead of returning a partial report, and aborts in-flight Jira calls', async () => {
    const { client, calls } = fakeJira({ hangOn: ['TPX-2'] });
    const err = await generateReport(client, cfg, range, {}, { timeoutMs: 50 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReportAbortedError);
    expect((err as ReportAbortedError).reason).toBe('timeout');
    expect((err as Error).message).toMatch(/^Report timed out after \d+s/);
    const hung = calls.find((c) => c.path.includes('TPX-2'))!;
    expect(hung.signal?.aborted).toBe(true);
  });

  it('finishes normally when the deadline is not hit', async () => {
    const { client } = fakeJira();
    const r = await generateReport(client, cfg, range, {}, { timeoutMs: 5_000 });
    expect(r.complete).toBe(true);
    expect(r.grandTotal).toBe(ISSUES.length * H);
  });
});

describe('cancellation', () => {
  it('stops the pipeline, aborts Jira calls and starts no new ones', async () => {
    const { client, calls } = fakeJira({ hangOn: ['TPX-1', 'TPX-2'] }); // concurrency 2: both workers stuck
    const ac = new AbortController();
    const p = generateReport(client, cfg, range, { onStage: (s) => s === 'worklogs' && setTimeout(() => ac.abort(), 10) }, { signal: ac.signal });

    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportAbortedError);
    expect((err as ReportAbortedError).reason).toBe('cancelled');
    const worklogCalls = calls.filter((c) => c.path.endsWith('/worklog'));
    expect(worklogCalls.map((c) => c.path)).toEqual(['/rest/api/3/issue/TPX-1/worklog', '/rest/api/3/issue/TPX-2/worklog']);
    expect(worklogCalls.every((c) => c.signal?.aborted)).toBe(true);
  });

  it('an already-aborted signal makes no Jira calls', async () => {
    const { client, calls } = fakeJira();
    const ac = new AbortController();
    ac.abort();
    await expect(generateReport(client, cfg, range, {}, { signal: ac.signal })).rejects.toBeInstanceOf(ReportAbortedError);
    expect(calls).toHaveLength(0);
  });
});

describe('Jira client and abort signals', () => {
  afterEach(() => vi.unstubAllGlobals());
  const BASE = 'https://example.atlassian.net';
  const creds = { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'secret' };

  it('passes the signal to fetch and does not retry after abort', async () => {
    const fetchMock = vi.fn((_url: URL, init: RequestInit) => hang(init.signal ?? undefined));
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    const reason = new Error('stop');
    const p = createJiraClient(BASE, creds).get('/rest/api/3/myself', {}, { signal: ac.signal });
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abort interrupts a Retry-After wait (429)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    const p = createJiraClient(BASE, creds).get('/rest/api/3/myself', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('stop')), 20);
    const t0 = Date.now();
    await expect(p).rejects.toThrow('stop');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('project validation', () => {
  it('rejects a key that is not in the project list', async () => {
    const { client, calls } = fakeJira();
    await expect(generateReport(client, cfg, { ...range, project: 'NOPE' })).rejects.toBeInstanceOf(UnknownProjectError);
    expect(calls.map((c) => c.path)).toEqual(['/rest/api/3/project/search']); // no search, no worklogs
  });

  it('accepts a known key case-insensitively and uses the canonical key', async () => {
    const { client, calls } = fakeJira();
    const r = await generateReport(client, cfg, { ...range, project: 'tpx' });
    expect(r.project).toBe('TPX');
    expect(String(calls.find((c) => c.path === '/rest/api/3/search/jql')!.query!.jql)).toContain('project = "TPX"');
  });
});

describe('POST /api/report', () => {
  async function app(jira: JiraClient, timeoutSec = 30, runs = new RunRegistry()) {
    const a = Fastify();
    const sites = new SiteRegistry([{ key: 'example', url: 'https://example.atlassian.net', jira }]);
    await a.register(reportRoutes, { sites, cfg: { ...cfg, REPORT_TIMEOUT_SEC: timeoutSec }, runs });
    return a;
  }
  const post = (a: Awaited<ReturnType<typeof app>>, payload: object) => a.inject({ method: 'POST', url: '/api/report', payload });

  it('unknown project key -> 400', async () => {
    const res = await post(await app(fakeJira().client), { ...range, project: 'NOPE' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown project key "NOPE"/);
  });

  it('timeout -> 504 with a clear message, no report body', async () => {
    const res = await post(await app(fakeJira({ hangOn: ['TPX-3'] }).client, 0.05), range);
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: expect.stringMatching(/timed out .* no data is shown/) });
  });

  it('cancel endpoint stops a running report; a second POST with the same id is refused', async () => {
    const runs = new RunRegistry();
    const a = await app(fakeJira({ hangOn: ['TPX-1'] }).client, 30, runs);
    const requestId = 'abcdef0123456789abcd';
    const first = post(a, { ...range, requestId });
    await vi.waitFor(() => expect(runs.isRunning(requestId)).toBe(true));

    const dup = await post(a, { ...range, requestId });
    expect(dup.statusCode).toBe(409);

    const cancel = await a.inject({ method: 'POST', url: `/api/report/${requestId}/cancel` });
    expect(cancel.statusCode).toBe(204);
    expect((await first).statusCode).toBe(499);
    expect(runs.size).toBe(0);
  });

  it('maps Jira 401 to an actionable message', async () => {
    const jira = fakeJira({ override: (p) => (p === '/rest/api/3/search/jql' ? Promise.reject(new JiraError('Jira 401', 401, p)) : undefined) });
    const res = await post(await app(jira.client), range);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/did not accept your email and API token \(HTTP 401\).*sign in again/);
  });

  it('explains why a report is incomplete (rate limited after retries)', async () => {
    const jira = fakeJira({ override: (p) => (p.includes('TPX-2/') ? Promise.reject(new JiraError('Jira 429', 429, p)) : undefined) });
    const res = await post(await app(jira.client), range);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ complete: false, failedIssueKeys: ['TPX-2'], failureReasons: ['1 issue(s): Jira rate limit (HTTP 429) persisted after retries'] });
  });

  it('streams progress stages over SSE', async () => {
    const runs = new RunRegistry();
    const a = await app(fakeJira().client, 30, runs);
    const requestId = 'progress0123456789ab';
    const sse = a.inject({ method: 'GET', url: `/api/report/progress/${requestId}` });
    await vi.waitFor(() => expect(runs.size).toBe(1)); // listener registered before the report starts
    expect((await post(a, { ...range, project: 'TPX', requestId })).statusCode).toBe(200);

    const res = await sse;
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as { stage: string; done?: number; total?: number; issues?: number });
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(['validating', 'searching', 'worklogs', 'processing', 'done']));
    expect(events).toContainEqual({ stage: 'searching', issues: ISSUES.length });
    expect(events).toContainEqual({ stage: 'worklogs', done: ISSUES.length, total: ISSUES.length });
    expect(events.at(-1)).toEqual({ stage: 'done' });
    expect(runs.size).toBe(0);
  });
});
