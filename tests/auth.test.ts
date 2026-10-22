import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/app.js';
import type { Config } from '../src/config.js';
import { SiteAccessCache } from '../src/jira/access.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { basicAuthHeader, currentCredentials, NotSignedInError, parseBasicAuth, runWithCredentials, userKey } from '../src/jira/auth.js';
import { createJiraClient, JiraError, type JiraClient } from '../src/jira/client.js';
import { FieldCache } from '../src/jira/fields.js';
import { authHeader, AUTH_KEY, clearAuth, loadAuth, loginProblem, saveAuth, type StoredAuth } from '../web/auth-logic.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const ALICE = { email: 'alice@example.com', token: 'tok-alice' };
const BOB = { email: 'bob@example.com', token: 'tok:with:colons' };

// ---- credentials ----

describe('parseBasicAuth', () => {
  it('reads email and token; the token may contain colons', () => {
    expect(parseBasicAuth(`Basic ${b64('alice@example.com:tok-alice')}`)).toEqual(ALICE);
    expect(parseBasicAuth(`basic ${b64('bob@example.com:tok:with:colons')}`)).toEqual(BOB);
  });
  it.each([
    ['no header', undefined],
    ['another scheme', 'Bearer abc'],
    ['not base64', 'Basic !!!'],
    ['no colon', `Basic ${b64('alice@example.com')}`],
    ['empty token', `Basic ${b64('alice@example.com:')}`],
    ['blank token', `Basic ${b64('alice@example.com:   ')}`],
    ['no email', `Basic ${b64(':token')}`],
    ['user name that is not an email', `Basic ${b64('alice:token')}`],
  ])('rejects %s', (_, header) => {
    expect(parseBasicAuth(header)).toBeUndefined();
  });
  it('round-trips with the header the Jira client sends', () => {
    expect(parseBasicAuth(basicAuthHeader(BOB))).toEqual(BOB);
  });
});

describe('request context', () => {
  it('each concurrent request sees its own credentials', async () => {
    const seen = await Promise.all([
      runWithCredentials(ALICE, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return currentCredentials();
      }),
      runWithCredentials(BOB, async () => currentCredentials()),
    ]);
    expect(seen).toEqual([ALICE, BOB]);
    expect(currentCredentials()).toBeUndefined();
  });
  it('the cache key follows the email only, case-insensitively, and is not the email', () => {
    expect(userKey(ALICE)).toBe(userKey({ ...ALICE, token: 'rotated' }));
    expect(userKey(ALICE)).toBe(userKey({ email: 'ALICE@example.com', token: 'x' }));
    expect(userKey(ALICE)).not.toBe(userKey(BOB));
    expect(userKey(ALICE)).not.toContain('alice');
    expect(userKey(undefined)).toBe('');
  });
});

describe('Jira client credentials', () => {
  afterEach(() => vi.unstubAllGlobals());
  const BASE = 'https://example.atlassian.net';
  const ok = () => new Response('{"accountId":"a"}', { status: 200 });

  it('uses the signed-in user of the request, per call', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const client = createJiraClient(BASE);
    await runWithCredentials(ALICE, () => client.get('/rest/api/3/myself'));
    await runWithCredentials(BOB, () => client.get('/rest/api/3/myself'));
    const auth = (i: number) => ((fetchMock.mock.calls[i] as unknown as [URL, RequestInit])[1].headers as Record<string, string>).Authorization;
    expect(auth(0)).toBe(basicAuthHeader(ALICE));
    expect(auth(1)).toBe(basicAuthHeader(BOB));
  });

  it('without a signed-in user it does not call Jira', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await expect(createJiraClient(BASE).get('/rest/api/3/myself')).rejects.toBeInstanceOf(NotSignedInError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fixed credentials (the probe script) work without a request context', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await createJiraClient(BASE, { JIRA_EMAIL: ALICE.email, JIRA_API_TOKEN: ALICE.token }).get('/rest/api/3/myself');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('field cache is per user', () => {
  it('two users do not share an entry; one user does', async () => {
    const cache = new FieldCache();
    const calls: string[] = [];
    const client: JiraClient = {
      baseUrl: 'https://one.atlassian.net',
      async get<T>(): Promise<T> {
        calls.push(currentCredentials()!.email);
        return [] as T;
      },
    };
    await runWithCredentials(ALICE, () => cache.get('one', client));
    await runWithCredentials(ALICE, () => cache.get('one', client));
    await runWithCredentials(BOB, () => cache.get('one', client));
    expect(calls).toEqual([ALICE.email, BOB.email]);
  });
});

// ---- the real app ----

describe('sign-in gate (buildServer)', () => {
  const cfg = (): Config =>
    ({
      JIRA_SITES: [{ key: 'one', url: 'https://one.atlassian.net' }],
      REPORT_TZ: 'Asia/Dhaka',
      JIRA_CONCURRENCY: 2,
      MAX_RANGE_DAYS: 31,
      REPORT_TIMEOUT_SEC: 60,
      HOURS_PER_DAY: 8,
      TEMPLATES_FILE: join(mkdtempSync(join(tmpdir(), 'auth-')), 'templates.json'),
      PORT: 0,
    }) as Config;

  /** Jira answers /myself for ALICE's token only; records who each call was made as. */
  function fakeJira() {
    const seen: Array<{ path: string; email: string | undefined }> = [];
    const jira: JiraClient = {
      baseUrl: 'https://one.atlassian.net',
      async get<T>(path: string): Promise<T> {
        const who = currentCredentials();
        seen.push({ path, email: who?.email });
        if (who?.token !== ALICE.token) throw new JiraError('Jira 401', 401, path);
        if (path === '/rest/api/3/myself') return { accountId: 'acc-1', displayName: 'Alice A' } as T;
        if (path === '/rest/api/3/project/search') return { isLast: true, values: [{ id: '1', key: 'FFN', name: 'Fun' }] } as T;
        throw new Error(`unexpected ${path}`);
      },
    };
    return { jira, seen };
  }
  const build = (jira: JiraClient) => buildServer(cfg(), { logger: false, sites: [{ key: 'one', url: 'https://one.atlassian.net', jira }] });
  const as = (c: { email: string; token: string }) => ({ authorization: `Basic ${b64(`${c.email}:${c.token}`)}` });

  it('every /api route but the login needs credentials', async () => {
    const { jira, seen } = fakeJira();
    const a = await build(jira);
    for (const [method, url] of [
      ['GET', '/api/sites'],
      ['GET', '/api/projects'],
      ['GET', '/api/users'],
      ['GET', '/api/fields'],
      ['GET', '/api/templates'],
      ['GET', '/api/health/jira'],
      ['POST', '/api/report'],
      ['POST', '/api/custom-report'],
      ['POST', '/api/export'],
      ['POST', '/api/team-reports/export'],
      ['POST', '/api/report/abc/cancel'],
    ] as const) {
      const res = await a.inject({ method, url });
      expect([method, url, res.statusCode]).toEqual([method, url, 401]);
      expect(res.json()).toEqual({ error: 'Sign in required.' });
    }
    expect(seen).toHaveLength(0); // Jira was never asked
    expect((await a.inject({ url: '/api/projects', headers: { authorization: 'Basic nonsense' } })).statusCode).toBe(401);
  });

  it('the progress streams stay open (EventSource cannot send a header); the web page is not under /api', async () => {
    const a = await build(fakeJira().jira);
    expect((await a.inject({ url: '/api/report/progress/abc' })).statusCode).not.toBe(401);
    expect((await a.inject({ url: '/api/custom-report/progress/abc' })).statusCode).not.toBe(401);
    expect((await a.inject({ method: 'POST', url: '/api/login', payload: {} })).statusCode).toBe(400); // reached the route
  });

  it('a signed-in request reaches the route and Jira sees that user', async () => {
    const { jira, seen } = fakeJira();
    const a = await build(jira);
    const res = await a.inject({ url: '/api/projects', headers: as(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ key: 'FFN', name: 'Fun' }]);
    expect(seen).toEqual([{ path: '/rest/api/3/project/search', email: ALICE.email }]);
  });

  it("Jira rejecting a user's token → 401 so the browser signs them out", async () => {
    const a = await build(fakeJira().jira);
    const res = await a.inject({ url: '/api/projects', headers: as(BOB) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Could not load projects\. Jira did not accept your email and API token/);
  });

  describe('POST /api/login', () => {
    const login = (a: Awaited<ReturnType<typeof build>>, payload: unknown) => a.inject({ method: 'POST', url: '/api/login', payload: payload as object });

    it('accepted → who the token belongs to; nothing else is returned', async () => {
      const { jira, seen } = fakeJira();
      const res = await login(await build(jira), ALICE);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ email: ALICE.email, displayName: 'Alice A', accountId: 'acc-1', site: 'one', sites: [{ key: 'one', url: 'https://one.atlassian.net' }] });
      expect(res.body).not.toContain(ALICE.token);
      expect(seen).toEqual([{ path: '/rest/api/3/myself', email: ALICE.email }]);
    });

    it('rejected by Jira → 401 with a message that names no secret', async () => {
      const res = await login(await build(fakeJira().jira), BOB);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/did not accept this email and API token/);
      expect(res.body).not.toContain(BOB.token);
    });

    it('bad input → 400', async () => {
      const a = await build(fakeJira().jira);
      expect((await login(a, { email: 'not-an-email', token: 'x' })).statusCode).toBe(400);
      expect((await login(a, { email: ALICE.email })).statusCode).toBe(400);
      expect((await login(a, { email: ALICE.email, token: '' })).statusCode).toBe(400);
    });

    it('Jira unreachable → 502, not a 401', async () => {
      const jira: JiraClient = {
        baseUrl: 'https://one.atlassian.net',
        async get<T>(path: string): Promise<T> {
          throw new JiraError('Jira request failed: ENOTFOUND', undefined, path);
        },
      };
      const res = await login(await build(jira), ALICE);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/Cannot reach Jira/);
    });
  });
});

// ---- which sites a user gets (JIRA_SITES is the company list; each user sees the ones that accept their token) ----

describe('per-user site list', () => {
  const cfg = (): Config =>
    ({
      JIRA_SITES: [],
      REPORT_TZ: 'Asia/Dhaka',
      JIRA_CONCURRENCY: 2,
      MAX_RANGE_DAYS: 31,
      REPORT_TIMEOUT_SEC: 60,
      HOURS_PER_DAY: 8,
      TEMPLATES_FILE: join(mkdtempSync(join(tmpdir(), 'sites-')), 'templates.json'),
      PORT: 0,
    }) as Config;

  const USER1 = { email: 'user1@example.com', token: 't1' }; // masdirect only
  const USER2 = { email: 'user2@example.com', token: 't2' }; // masdirect + pm23, not altronics
  const NOBODY = { email: 'nobody@example.com', token: 't3' };
  const ACCESS: Record<string, string[]> = { masdirect: ['t1', 't2'], pm23: ['t2'], altronics: [] };

  /** A site that lets in the tokens in ACCESS, rejects the others with 401, or is down / forbidden. */
  function site(key: string, behaviour: { down?: boolean; forbidden?: boolean } = {}) {
    const probes: string[] = [];
    const jira: JiraClient = {
      baseUrl: `https://${key}.atlassian.net`,
      async get<T>(path: string): Promise<T> {
        const who = currentCredentials()!;
        probes.push(who.email);
        if (behaviour.down) throw new JiraError('Jira request failed: ENOTFOUND', undefined, path);
        if (behaviour.forbidden) throw new JiraError('Jira 403', 403, path);
        if (!(ACCESS[key] ?? []).includes(who.token)) throw new JiraError('Jira 401', 401, path);
        return { accountId: `acc-${who.email}`, displayName: `Name of ${who.email}` } as T;
      },
    };
    return { key, url: `https://${key}.atlassian.net`, jira, probes };
  }
  const as = (c: { email: string; token: string }) => ({ authorization: `Basic ${b64(`${c.email}:${c.token}`)}` });
  const KEYS = (r: { json: () => Array<{ key: string }> }) => r.json().map((s) => s.key);

  async function build(entries = [site('masdirect'), site('pm23'), site('altronics')]) {
    const app = await buildServer(cfg(), { logger: false, sites: entries });
    return { app, entries };
  }

  it('1. a user with access to masdirect only gets just masdirect (so the dropdown stays hidden)', async () => {
    const { app } = await build();
    const res = await app.inject({ url: '/api/sites', headers: as(USER1) });
    expect(res.statusCode).toBe(200);
    expect(KEYS(res)).toEqual(['masdirect']);
  });

  it('2. a user without access to altronics does not get it; the others keep the .env order', async () => {
    const { app } = await build();
    const res = await app.inject({ url: '/api/sites', headers: as(USER2) });
    expect(KEYS(res)).toEqual(['masdirect', 'pm23']);
    expect(res.json()[0]).toEqual({ key: 'masdirect', url: 'https://masdirect.atlassian.net' });
  });

  it('the sign-in returns the same list, the first of them as the default site, and who the user is', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: USER2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'Name of user2@example.com', site: 'masdirect' });
    expect(res.json().sites.map((s: { key: string }) => s.key)).toEqual(['masdirect', 'pm23']);
    expect(res.body).not.toContain(USER2.token);
  });

  it('a site the user has no access to, listed first in .env, is skipped (the default is their first site)', async () => {
    const { app } = await build([site('altronics'), site('pm23'), site('masdirect')]);
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: USER2 });
    expect(res.json().site).toBe('pm23');
  });

  it('a token no site accepts: sign-in → 401 naming the sites; an old session → 403 (not 401: no sign-out loop)', async () => {
    const { app } = await build();
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: NOBODY });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toMatch(/did not accept this email and API token on any of the configured Jira sites \(masdirect, pm23, altronics\)/);
    const sites = await app.inject({ url: '/api/sites', headers: as(NOBODY) });
    expect(sites.statusCode).toBe(403);
    expect(sites.json().error).toMatch(/no access to any of the configured sites/);
  });

  it('a site that is down is left out, and does not stop the others', async () => {
    const { app } = await build([site('masdirect'), site('pm23', { down: true }), site('altronics')]);
    expect(KEYS(await app.inject({ url: '/api/sites', headers: as(USER2) }))).toEqual(['masdirect']);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: USER2 })).statusCode).toBe(200);
  });

  it('every site down → 502 (Jira unreachable), not "wrong token"', async () => {
    const { app } = await build([site('masdirect', { down: true }), site('pm23', { down: true })]);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: USER2 });
    expect(login.statusCode).toBe(502);
    expect(login.json().error).toMatch(/Cannot reach Jira/);
    expect((await app.inject({ url: '/api/sites', headers: as(USER2) })).statusCode).toBe(502);
  });

  it('a 403 from a site means "no access" like a 401', async () => {
    const { app } = await build([site('masdirect'), site('pm23', { forbidden: true })]);
    expect(KEYS(await app.inject({ url: '/api/sites', headers: as(USER2) }))).toEqual(['masdirect']);
  });

  it('the list is kept for a few minutes (one probe per site), the sign-in always asks Jira again', async () => {
    const { app, entries } = await build();
    await app.inject({ url: '/api/sites', headers: as(USER2) });
    await app.inject({ url: '/api/sites', headers: as(USER2) });
    expect(entries.map((e) => e.probes.length)).toEqual([1, 1, 1]);
    await app.inject({ method: 'POST', url: '/api/login', payload: USER2 });
    expect(entries.map((e) => e.probes.length)).toEqual([2, 2, 2]);
  });

  it('GET /api/me says who the credentials belong to (for sign-ins saved without an account id)', async () => {
    const { app } = await build();
    const res = await app.inject({ url: '/api/me', headers: as(USER2) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: USER2.email, displayName: 'Name of user2@example.com', accountId: 'acc-user2@example.com' });
    expect(res.body).not.toContain(USER2.token);
    expect((await app.inject({ url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/me', headers: as(NOBODY) })).statusCode).toBe(404); // no site knows this token
  });

  it('another user, or the same email with another token, never gets a cached list', async () => {
    const { app } = await build();
    expect(KEYS(await app.inject({ url: '/api/sites', headers: as(USER2) }))).toEqual(['masdirect', 'pm23']);
    expect(KEYS(await app.inject({ url: '/api/sites', headers: as(USER1) }))).toEqual(['masdirect']);
    const wrong = await app.inject({ url: '/api/sites', headers: as({ email: USER2.email, token: 'wrong' }) });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('SiteAccessCache timing', () => {
  const registry = (probes: { n: number }, down: () => boolean) =>
    new SiteRegistry([
      {
        key: 'one',
        url: 'https://one.atlassian.net',
        jira: {
          baseUrl: 'https://one.atlassian.net',
          async get<T>(path: string): Promise<T> {
            probes.n++;
            if (down()) throw new JiraError('Jira request failed: ECONNRESET', undefined, path);
            return { accountId: 'a', displayName: 'A' } as T;
          },
        },
      },
    ]);

  it('a full answer lasts 5 minutes; one with an unreachable site is asked again after 30 seconds', async () => {
    let now = 1_000_000;
    let down = true;
    const probes = { n: 0 };
    const cache = new SiteAccessCache(registry(probes, () => down), () => now);
    expect((await cache.get(ALICE)).unchecked).toHaveLength(1);
    now += 29_000;
    await cache.get(ALICE);
    expect(probes.n).toBe(1);
    now += 2_000;
    down = false;
    expect((await cache.get(ALICE)).sites.map((s) => s.key)).toEqual(['one']);
    expect(probes.n).toBe(2);
    now += 299_000;
    await cache.get(ALICE);
    expect(probes.n).toBe(2);
    now += 2_000;
    await cache.get(ALICE);
    expect(probes.n).toBe(3);
  });

  it('concurrent callers share one probe', async () => {
    const probes = { n: 0 };
    const cache = new SiteAccessCache(registry(probes, () => false));
    await Promise.all([cache.get(ALICE), cache.get(ALICE), cache.get(ALICE)]);
    expect(probes.n).toBe(1);
  });
});

// ---- the browser's stored sign-in ----

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('stored sign-in', () => {
  const auth = (remember: boolean): StoredAuth => ({ ...ALICE, name: 'Alice A', remember });

  it('"keep me signed in" → localStorage only; otherwise sessionStorage only', () => {
    const local = memoryStore();
    const session = memoryStore();
    expect(saveAuth(local, session, auth(true))).toBe(true);
    expect(local.data.has(AUTH_KEY)).toBe(true);
    expect(session.data.has(AUTH_KEY)).toBe(false);
    expect(loadAuth(local, session)).toEqual(auth(true));

    saveAuth(local, session, auth(false)); // signing in again without "keep me": the long-lived copy goes
    expect(local.data.has(AUTH_KEY)).toBe(false);
    expect(loadAuth(local, session)).toEqual(auth(false));
  });

  it('sign out clears both', () => {
    const local = memoryStore();
    const session = memoryStore();
    saveAuth(local, session, auth(true));
    saveAuth(memoryStore(), session, auth(false));
    clearAuth(local, session);
    expect(loadAuth(local, session)).toBeUndefined();
  });

  it('nothing, corrupt or incomplete storage = signed out', () => {
    expect(loadAuth(undefined, undefined)).toBeUndefined();
    for (const bad of ['', 'not json', 'null', '{}', '{"email":"a@b.c"}', '{"email":"","token":"x"}', '{"email":1,"token":"x"}']) {
      expect(loadAuth(memoryStore({ [AUTH_KEY]: bad }), undefined)).toBeUndefined();
    }
  });

  it('blocked storage does not break signing in for this page load', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(saveAuth(blocked, blocked, auth(true))).toBe(false);
    expect(loadAuth(blocked, blocked)).toBeUndefined();
    expect(() => clearAuth(blocked, blocked)).not.toThrow();
  });

  it('the stored value holds only what is needed', () => {
    const local = memoryStore();
    saveAuth(local, undefined, auth(true));
    expect(JSON.parse(local.data.get(AUTH_KEY)!)).toEqual({ email: ALICE.email, token: ALICE.token, name: 'Alice A' });
  });

  it('the account id is kept with the sign-in; one saved without it still loads', () => {
    const local = memoryStore();
    saveAuth(local, undefined, { ...auth(true), accountId: 'acc-1' });
    expect(JSON.parse(local.data.get(AUTH_KEY)!)).toEqual({ email: ALICE.email, token: ALICE.token, name: 'Alice A', accountId: 'acc-1' });
    expect(loadAuth(local, undefined)).toEqual({ ...auth(true), accountId: 'acc-1' });
    expect(loadAuth(memoryStore({ [AUTH_KEY]: JSON.stringify({ email: 'a@b.c', token: 't' }) }), undefined)).toEqual({ email: 'a@b.c', token: 't', remember: true });
    expect(loadAuth(memoryStore({ [AUTH_KEY]: JSON.stringify({ email: 'a@b.c', token: 't', accountId: 5 }) }), undefined)?.accountId).toBeUndefined();
  });

  it('the header matches what the server parses, also for non-ASCII', () => {
    expect(parseBasicAuth(authHeader(BOB))).toEqual(BOB);
    const odd = { email: 'zoë@example.com', token: 'tökén' };
    expect(parseBasicAuth(authHeader(odd))).toEqual(odd);
  });

  it('form problems', () => {
    expect(loginProblem('', 'x')).toMatch(/email/);
    expect(loginProblem('nope', 'x')).toMatch(/not look like an email/);
    expect(loginProblem('a@b.co', '  ')).toMatch(/API token/);
    expect(loginProblem(' a@b.co ', 'x')).toBeUndefined();
  });
});
