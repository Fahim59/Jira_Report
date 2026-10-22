import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { JiraError, type JiraClient } from '../src/jira/client.js';
import { parseSites, parseSiteUrl, SiteRegistry } from '../src/jira/sites.js';
import { healthRoutes } from '../src/routes/health.js';
import { metaRoutes } from '../src/routes/meta.js';
import { reportRoutes } from '../src/routes/report.js';

describe('parseSiteUrl / parseSites', () => {
  it('trims whitespace and trailing slashes, lower-cases, and keys by subdomain', () => {
    expect(parseSiteUrl('  https://MasDirect.atlassian.net///  ')).toEqual({ key: 'masdirect', url: 'https://masdirect.atlassian.net' });
    expect(parseSites('https://masdirect.atlassian.net/, https://other-team.atlassian.net')).toEqual([
      { key: 'masdirect', url: 'https://masdirect.atlassian.net' },
      { key: 'other-team', url: 'https://other-team.atlassian.net' },
    ]);
  });

  it.each([
    ['http (not https)', 'http://masdirect.atlassian.net'],
    ['not atlassian.net', 'https://jira.example.com'],
    ['look-alike domain', 'https://masdirect.atlassian.net.evil.com'],
    ['nested subdomain', 'https://a.b.atlassian.net'],
    ['path', 'https://masdirect.atlassian.net/jira'],
    ['port', 'https://masdirect.atlassian.net:8443'],
    ['query', 'https://masdirect.atlassian.net?x=1'],
    ['credentials', 'https://user@masdirect.atlassian.net'],
    ['bare host', 'masdirect.atlassian.net'],
    ['leading hyphen', 'https://-x.atlassian.net'],
    ['reserved name', 'https://all.atlassian.net'],
  ])('rejects %s', (_, url) => {
    expect(() => parseSiteUrl(url)).toThrow();
  });

  it('rejects an empty list and duplicate sites', () => {
    expect(() => parseSites(' , ')).toThrow(/at least one/);
    expect(() => parseSites('https://a.atlassian.net,https://A.atlassian.net/')).toThrow(/more than once/);
  });
});

describe('loadConfig JIRA_SITES', () => {
  const base = { JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'secret' };

  it('parses the list; the first site is first', () => {
    const cfg = loadConfig({ ...base, JIRA_SITES: 'https://one.atlassian.net/,https://two.atlassian.net' });
    expect(cfg.JIRA_SITES.map((s) => s.key)).toEqual(['one', 'two']);
  });

  it('reports invalid sites without echoing the token', () => {
    let msg = '';
    try {
      loadConfig({ ...base, JIRA_SITES: 'https://one.atlassian.net,http://bad.example.com' });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/JIRA_SITES: "http:\/\/bad.example.com" is not a Jira Cloud site URL/);
    expect(msg).not.toContain('secret');
  });

  it('points at the rename when only the old JIRA_BASE_URL is set', () => {
    expect(() => loadConfig({ ...base, JIRA_BASE_URL: 'https://one.atlassian.net' })).toThrow(/JIRA_BASE_URL was replaced by JIRA_SITES/);
  });
});

/** Fake client per site: /myself answers with the site's name, or fails with `fail`. */
function fakeSite(key: string, fail?: JiraError): { key: string; url: string; jira: JiraClient; paths: string[] } {
  const url = `https://${key}.atlassian.net`;
  const paths: string[] = [];
  const jira: JiraClient = {
    baseUrl: url,
    async get<T>(path: string): Promise<T> {
      paths.push(path);
      if (fail) throw fail;
      if (path === '/rest/api/3/myself') return { accountId: 'me', displayName: `Me on ${key}` } as T;
      if (path === '/rest/api/3/project/search') return { startAt: 0, maxResults: 100, isLast: true, values: [{ id: '1', key: key.toUpperCase(), name: key }] } as T;
      if (path === '/rest/api/3/users/search') return [] as T;
      if (path === '/rest/api/3/search/jql') return { issues: [], isLast: true } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  return { key, url, jira, paths };
}

describe('SiteRegistry.resolve', () => {
  const sites = new SiteRegistry([fakeSite('one'), fakeSite('two')]);
  it('missing/empty = first site; keys are case-insensitive; unknown = undefined', () => {
    expect(sites.resolve(undefined)?.key).toBe('one');
    expect(sites.resolve('')?.key).toBe('one');
    expect(sites.resolve(' TWO ')?.key).toBe('two');
    expect(sites.resolve('three')).toBeUndefined();
    expect(sites.resolve(['two'])).toBeUndefined();
  });
});

describe('site parameter on /api routes', () => {
  const cfg = { REPORT_TZ: 'Asia/Dhaka', JIRA_CONCURRENCY: 2, MAX_RANGE_DAYS: 31, REPORT_TIMEOUT_SEC: 30 };

  async function app(entries = [fakeSite('one'), fakeSite('two')]) {
    const a = Fastify();
    const sites = new SiteRegistry(entries);
    await a.register(healthRoutes, { sites });
    await a.register(metaRoutes, { sites, cfg });
    await a.register(reportRoutes, { sites, cfg });
    return { a, entries };
  }

  it('GET /api/sites lists key + url only, first = default', async () => {
    const { a } = await app();
    const res = await a.inject('/api/sites');
    expect(res.json()).toEqual([
      { key: 'one', url: 'https://one.atlassian.net' },
      { key: 'two', url: 'https://two.atlassian.net' },
    ]);
  });

  it.each([
    ['GET', '/api/projects?site=nope'],
    ['GET', '/api/users?site=nope'],
    ['GET', '/api/config?site=nope'],
    ['GET', '/api/health/jira?site=nope'],
    ['GET', '/api/report/progress/abcdef0123456789abcd?site=nope'],
    ['POST', '/api/report/abcdef0123456789abcd/cancel?site=nope'],
  ] as const)('%s %s -> 400', async (method, url) => {
    const { a, entries } = await app();
    const res = await a.inject({ method, url });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Unknown site "nope". Known sites: one, two.' });
    expect(entries.flatMap((e) => e.paths)).toEqual([]); // Jira never called
  });

  it('POST /api/report with an unknown site -> 400', async () => {
    const { a } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/report', payload: { from: '2026-10-01', to: '2026-10-02', site: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Unknown site "nope"/);
  });

  it('routes each request to the chosen site (default = first)', async () => {
    const { a, entries } = await app();
    expect((await a.inject('/api/projects')).json()).toEqual([{ key: 'ONE', name: 'one' }]);
    expect((await a.inject('/api/projects?site=TWO')).json()).toEqual([{ key: 'TWO', name: 'two' }]);
    expect((await a.inject('/api/config?site=two')).json()).toEqual({ site: 'two', jiraBaseUrl: 'https://two.atlassian.net', maxRangeDays: 31, reportTimeoutSec: 30 });
    expect(entries[0]!.paths).toEqual(['/rest/api/3/project/search']);
    expect(entries[1]!.paths).toEqual(['/rest/api/3/project/search']);
  });

  it('the report JSON carries its site', async () => {
    const { a, entries } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/report', payload: { from: '2026-10-01', to: '2026-10-02', site: 'Two' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ site: 'two', complete: true });
    expect(entries[0]!.paths).toEqual([]);
    const dflt = await a.inject({ method: 'POST', url: '/api/report', payload: { from: '2026-10-01', to: '2026-10-02' } });
    expect(dflt.json().site).toBe('one');
  });

  it('health checks one site', async () => {
    const { a } = await app();
    const res = await a.inject('/api/health/jira?site=two');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ site: 'two', baseUrl: 'https://two.atlassian.net', ok: true, user: 'Me on two' });
  });

  it('health ?site=all reports every site; 502 if any is down', async () => {
    const { a } = await app([fakeSite('one'), fakeSite('two', new JiraError('Jira 401', 401, '/rest/api/3/myself'))]);
    const res = await a.inject('/api/health/jira?site=all');
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.sites).toEqual([
      { site: 'one', baseUrl: 'https://one.atlassian.net', ok: true, user: 'Me on one' },
      { site: 'two', baseUrl: 'https://two.atlassian.net', ok: false, user: null, error: expect.stringMatching(/HTTP 401/) },
    ]);

    const allUp = await (await app()).a.inject('/api/health/jira?site=ALL');
    expect(allUp.statusCode).toBe(200);
    expect(allUp.json().ok).toBe(true);
  });
});
