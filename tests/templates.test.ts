import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import type { Config } from '../src/config.js';
import { JiraError, type JiraClient } from '../src/jira/client.js';
import { FieldCache } from '../src/jira/fields.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { installErrorHandler } from '../src/routes/errors.js';
import { templateRoutes, type TemplateListItem } from '../src/routes/templates.js';
import { buildFieldList, type JiraFieldRaw } from '../src/services/custom/fields.js';
import { resolveStarter, STARTER_TEMPLATES } from '../src/services/custom/presets.js';
import { TemplateBodySchema, type TemplateBody } from '../src/services/custom/template.js';
import {
  FileTemplateStore,
  MAX_TEMPLATES_PER_SITE,
  ReadOnlyTemplateError,
  TemplateConflictError,
  TemplateNotFoundError,
  type StoreFs,
} from '../src/services/templateStore.js';

const CF = 'customfield_10050';
const RAW_FIELDS: JiraFieldRaw[] = [
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: 'status', name: 'Status', schema: { type: 'status' } },
  { id: 'issuetype', name: 'Issue Type', schema: { type: 'issuetype' } },
  { id: 'assignee', name: 'Assignee', schema: { type: 'user' } },
];

const body = (name: string, more: object = {}): TemplateBody =>
  TemplateBodySchema.parse({ name, sheets: [{ name: 'Report', rows: { mode: 'group', groupBy: ['status'] } }], ...more });

let dir: string;
let file: string;
let warnings: string[];
let clock: number;
let seq: number;
const store = (fs?: StoreFs) =>
  new FileTemplateStore(file, { fs, now: () => new Date(clock), newId: () => `id-${++seq}`, onWarn: (m) => warnings.push(m) });

async function seed(content: string): Promise<void> {
  await nodeFs.mkdir(join(dir, 'data'), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'templates-'));
  file = join(dir, 'data', 'templates.json');
  warnings = [];
  clock = Date.parse('2026-10-07T10:00:00Z');
  seq = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileTemplateStore', () => {
  it('missing file = no templates; reads write nothing', async () => {
    expect(await store().list('one')).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('CRUD: create (makes the folder), list per site by name, update, delete', async () => {
    const s = store();
    const b = await s.create('one', body('beta'));
    const a = await s.create('one', body('Alpha'));
    await s.create('two', body('Alpha'));
    expect(b).toEqual({ id: 'id-1', site: 'one', isDefault: false, updatedAt: '2026-10-07T10:00:00.000Z', ...body('beta') });
    expect((await s.list('one')).map((t) => t.name)).toEqual(['Alpha', 'beta']);
    expect((await s.list('two')).map((t) => t.id)).toEqual(['id-3']);

    clock += 60_000;
    const renamed = await s.update(a.id, body('Gamma', { defaults: { projects: ['FFN'] } }), a.updatedAt);
    expect(renamed).toMatchObject({ id: a.id, site: 'one', name: 'Gamma', defaults: { projects: ['FFN'], authors: [] }, updatedAt: '2026-10-07T10:01:00.000Z' });
    expect(await store().get(a.id)).toEqual(renamed); // persisted

    await s.delete(b.id);
    expect((await s.list('one')).map((t) => t.name)).toEqual(['Gamma']);
    await expect(s.delete(b.id)).rejects.toThrow(TemplateNotFoundError);
    await expect(s.update('nope', body('x'))).rejects.toMatchObject({ statusCode: 404 });
    await expect(s.setDefault('nope')).rejects.toThrow(TemplateNotFoundError);
  });

  it('names are unique per site (case-insensitive, trimmed) and never a built-in name', async () => {
    const s = store();
    const t = await s.create('one', body('Weekly'));
    await expect(s.create('one', body('  WEEKLY '))).rejects.toThrow(TemplateConflictError);
    await expect(s.create('one', body('weekly'))).rejects.toMatchObject({
      statusCode: 409,
      message: 'A template named "weekly" already exists on this site. Pick another name.',
    });
    await expect(s.create('two', body('Weekly'))).resolves.toMatchObject({ site: 'two' });
    await expect(s.create('one', body('time reports STYLE'))).rejects.toThrow(/name of a built-in template/);
    // Renaming to its own name in another case is fine; to another template's name is not.
    await expect(s.update(t.id, body('WEEKLY'))).resolves.toMatchObject({ name: 'WEEKLY' });
    const other = await s.create('one', body('Monthly'));
    await expect(s.update(other.id, body('weekly'))).rejects.toThrow(TemplateConflictError);
  });

  it(`at most ${MAX_TEMPLATES_PER_SITE} templates per site`, async () => {
    const templates = Array.from({ length: MAX_TEMPLATES_PER_SITE }, (_, i) => ({
      ...body(`T${i}`),
      id: `x${i}`,
      site: 'one',
      isDefault: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await seed(JSON.stringify({ version: 1, templates }));
    await expect(store().create('one', body('One more'))).rejects.toThrow(`At most ${MAX_TEMPLATES_PER_SITE} templates per site`);
    await expect(store().create('two', body('One more'))).resolves.toBeDefined();
  });

  it('one default per site: a pointer per site; setting one replaces the previous on that site only', async () => {
    const s = store();
    const a = await s.create('one', body('A'));
    const b = await s.create('one', body('B'));
    const c = await s.create('two', body('C'));
    await s.setDefault(c.id);
    expect(await s.setDefault(a.id, 'two')).toEqual({ site: 'one', id: a.id }); // a saved template's own site wins
    expect((await s.get(a.id)).updatedAt).toBe(a.updatedAt); // the edit-conflict token does not move
    await s.setDefault(b.id);
    expect((await s.list('one')).map((t) => [t.name, t.isDefault])).toEqual([['A', false], ['B', true]]);
    expect((await s.list('two'))[0]!.isDefault).toBe(true);
    expect(await s.defaultId('one')).toBe(b.id);
    expect(await s.update(b.id, body('B2'))).toMatchObject({ isDefault: true }); // an edit keeps it
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; defaults: object; templates: object[] };
    expect(saved.version).toBe(2);
    expect(saved.defaults).toEqual({ one: b.id, two: c.id });
    expect(saved.templates.every((t) => !('isDefault' in t))).toBe(true);
  });

  it('a built-in can be the default of a site; unset default; deleting the default leaves none', async () => {
    const s = store();
    const a = await s.create('one', body('A'));
    await s.setDefault(a.id);
    expect(await s.setDefault('builtin:issue-list', 'one')).toEqual({ site: 'one', id: 'builtin:issue-list' });
    expect(await s.defaultId('one')).toBe('builtin:issue-list');
    expect((await s.get(a.id)).isDefault).toBe(false);
    expect(await s.defaultId('two')).toBeUndefined();
    await expect(s.setDefault('builtin:issue-list')).rejects.toThrow(TemplateNotFoundError); // a built-in needs the site
    await expect(s.setDefault('builtin:nope', 'one')).rejects.toThrow(TemplateNotFoundError);

    await s.clearDefault(a.id); // not the default: no-op
    expect(await s.defaultId('one')).toBe('builtin:issue-list');
    await s.clearDefault('builtin:issue-list', 'one');
    expect(await s.defaultId('one')).toBeUndefined();
    await expect(s.clearDefault('nope')).rejects.toThrow(TemplateNotFoundError);

    await s.setDefault(a.id);
    await s.delete(a.id);
    expect(await s.defaultId('one')).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8')).defaults).toEqual({});
  });

  it('a v1 file (isDefault on each template) is read, and written back as v2 with the default pointer', async () => {
    const t = (id: string, name: string, isDefault: boolean) => ({ ...body(name), id, site: 'one', isDefault, updatedAt: '2026-01-01T00:00:00.000Z' });
    await seed(JSON.stringify({ version: 1, templates: [t('x', 'X', false), t('y', 'Y', true)] }));
    const s = store();
    expect(await s.defaultId('one')).toBe('y');
    expect((await s.list('one')).map((x) => [x.id, x.isDefault])).toEqual([['x', false], ['y', true]]);
    await s.create('one', body('Z'));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; defaults: object };
    expect(saved).toMatchObject({ version: 2, defaults: { one: 'y' } });
  });

  it('a default pointing at a template that no longer exists (hand edit) is ignored', async () => {
    await seed(JSON.stringify({ version: 2, defaults: { one: 'gone' }, templates: [] }));
    expect(await store().defaultId('one')).toBeUndefined();
  });

  it("updatedAt guards against overwriting someone else's save (409); every save moves it on", async () => {
    const s = store();
    const t = await s.create('one', body('A'));
    const first = await s.update(t.id, body('A1'), t.updatedAt); // same clock: still a new token
    expect(first.updatedAt).not.toBe(t.updatedAt);
    await expect(s.update(t.id, body('A2'), t.updatedAt)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed by someone else/) });
    await expect(s.update(t.id, body('A2'))).resolves.toMatchObject({ name: 'A2' }); // no token = last write wins
  });

  it('built-in ids are read-only (403)', async () => {
    const s = store();
    await expect(s.update('builtin:issue-list', body('x'))).rejects.toThrow(ReadOnlyTemplateError);
    await expect(s.delete('builtin:issue-list')).rejects.toThrow(ReadOnlyTemplateError);
    await expect(s.get('builtin:issue-list')).rejects.toThrow(TemplateNotFoundError);
  });

  it('concurrent writes are serialised (no lost update, no duplicate name)', async () => {
    const s = store();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.create('one', body(`T${i}`))));
    expect(await store().list('one')).toHaveLength(10);
    const both = await Promise.allSettled([s.create('one', body('Same')), s.create('one', body('same'))]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await s.list('one')).filter((t) => t.name.toLowerCase() === 'same')).toHaveLength(1);
  });

  it('atomic write: temp file in the same folder, then rename; a failed rename leaves the old file and no temp file', async () => {
    const ops: string[] = [];
    let failRename = false;
    const fs: StoreFs = {
      readFile: (p, e) => nodeFs.readFile(p, e),
      writeFile: (p, d, e) => {
        ops.push(`write ${p}`);
        return nodeFs.writeFile(p, d, e);
      },
      rename: async (a, b) => {
        ops.push(`rename ${a} -> ${b}`);
        if (failRename) throw Object.assign(new Error('disk full'), { code: 'EIO' });
        return nodeFs.rename(a, b);
      },
      unlink: (p) => nodeFs.unlink(p),
      mkdir: (p, o) => nodeFs.mkdir(p, o),
    };
    const s = store(fs);
    await s.create('one', body('Kept'));
    const tmp = ops[0]!.slice('write '.length);
    expect(tmp).toMatch(/[\\/]data[\\/]\.templates\.json\.\d+\..+\.tmp$/);
    expect(ops[1]).toBe(`rename ${tmp} -> ${file}`);
    const before = await readFile(file, 'utf8');

    failRename = true;
    await expect(s.create('one', body('Lost'))).rejects.toThrow('disk full');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(join(dir, 'data'))).toEqual(['templates.json']);
    failRename = false;
    expect((await s.list('one')).map((t) => t.name)).toEqual(['Kept']);
  });

  it('retries a rename that Windows refuses briefly (EPERM)', async () => {
    let refusals = 2;
    const fs: StoreFs = {
      readFile: (p, e) => nodeFs.readFile(p, e),
      writeFile: (p, d, e) => nodeFs.writeFile(p, d, e),
      rename: async (a, b) => {
        if (refusals-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        return nodeFs.rename(a, b);
      },
      unlink: (p) => nodeFs.unlink(p),
      mkdir: (p, o) => nodeFs.mkdir(p, o),
    };
    await expect(store(fs).create('one', body('A'))).resolves.toBeDefined();
    expect(await store().list('one')).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{ "version": 1, "templates": ['],
    ['wrong shape', '{ "templates": {} }'],
    ['an array', '[]'],
  ])('a corrupt file (%s) is moved aside; the store starts empty and keeps working', async (_, text) => {
    await seed(text);
    const s = store();
    expect(await s.list('one')).toEqual([]);
    expect(warnings).toEqual([
      'Template file templates.json was not valid JSON for this app; moved to templates.json.corrupt-2026-10-07T10-00-00-000Z. Starting with no saved templates.',
    ]);
    expect(await readFile(join(dir, 'data', 'templates.json.corrupt-2026-10-07T10-00-00-000Z'), 'utf8')).toBe(text);
    await s.create('one', body('Fresh'));
    expect((await store().list('one')).map((t) => t.name)).toEqual(['Fresh']);
  });

  it('invalid entries are skipped but written back unchanged; a BOM is tolerated', async () => {
    const good = { ...body('Good'), id: 'g', site: 'one', isDefault: false, updatedAt: '2026-01-01T00:00:00.000Z' };
    const bad = { id: 'b', site: 'one', name: 'Bad', sheets: [] };
    await seed('﻿' + JSON.stringify({ version: 1, templates: [good, bad, { ...good, id: 'builtin:x' }] }));
    const s = store();
    expect((await s.list('one')).map((t) => t.id)).toEqual(['g']);
    expect(warnings).toEqual(['Template file: 2 invalid entries skipped (kept in the file).']);
    await s.create('one', body('New'));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; templates: Array<{ id: string }> };
    expect(saved.version).toBe(2);
    expect(saved.templates.map((t) => t.id)).toEqual(['g', 'id-1', 'b', 'builtin:x']);
  });
});

// ---- routes ----

function fakeJira(o: { fieldsFail?: boolean; fields?: JiraFieldRaw[] } = {}): JiraClient {
  return {
    baseUrl: 'https://one.atlassian.net',
    async get<T>(path: string): Promise<T> {
      if (path === '/rest/api/3/field') {
        if (o.fieldsFail) throw new JiraError('Jira 503', 503, path);
        return (o.fields ?? RAW_FIELDS) as T;
      }
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

async function app(jira: JiraClient = fakeJira()) {
  const a = Fastify();
  installErrorHandler(a); // as in src/app.ts: before the routes
  const sites = new SiteRegistry([
    { key: 'one', url: 'https://one.atlassian.net', jira },
    { key: 'two', url: 'https://two.atlassian.net', jira },
  ]);
  await a.register(templateRoutes, { sites, fields: new FieldCache(), store: store() });
  return a;
}

const sheets = [{ name: 'Report', rows: { mode: 'group', groupBy: ['status'] } }];
type List = { site: string; defaultId?: string; templates: TemplateListItem[]; warnings: string[] };

describe('/api/templates', () => {
  it('GET: the 3 built-ins resolved for the site, then the saved templates by name', async () => {
    const a = await app();
    await a.inject({ method: 'POST', url: '/api/templates?site=one', payload: { name: 'zeta', sheets } });
    await a.inject({ method: 'POST', url: '/api/templates', payload: { site: 'one', name: 'Alpha', sheets } });
    await a.inject({ method: 'POST', url: '/api/templates?site=two', payload: { name: 'Other', sheets } });

    const res = await a.inject({ method: 'GET', url: '/api/templates?site=ONE' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as List;
    expect(list.site).toBe('one');
    expect(list.warnings).toEqual([]);
    expect(list.templates.map((t) => [t.id, t.name, t.builtIn])).toEqual([
      ['builtin:time-reports-style', 'Time Reports style', true],
      ['builtin:team-client-report', 'Team Client Report', true],
      ['builtin:issue-list', 'Issue list', true],
      ['id-2', 'Alpha', false],
      ['id-1', 'zeta', false],
    ]);
    const issueList = list.templates[2]!;
    expect(issueList).toMatchObject({ site: 'one', isDefault: false, warnings: [] });
    expect(issueList).toMatchObject(resolveStarter(STARTER_TEMPLATES[2]!, buildFieldList(RAW_FIELDS)).template);
  });

  it('GET: a starter field the site lacks → warning on that built-in, column skipped', async () => {
    const a = await app(fakeJira({ fields: RAW_FIELDS.filter((f) => f.id !== CF) }));
    const { templates } = (await a.inject({ method: 'GET', url: '/api/templates' })).json() as List;
    const team = templates.find((t) => t.id === 'builtin:team-client-report')!;
    expect(team.builtIn && team.warnings).toEqual(['Team Client Report / Report: field "Client Reference" not found on this site; the column is skipped.']);
    expect(team.sheets[0]!.columns).toEqual([]);
  });

  it('GET: fields unavailable → saved templates still listed, built-ins left out with a warning', async () => {
    const a = await app(fakeJira({ fieldsFail: true }));
    await store().create('one', body('Mine')); // saving needs the field list, so seed the store directly
    const res = await a.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as List;
    expect(list.templates.map((t) => t.name)).toEqual(['Mine']);
    expect(list.warnings).toHaveLength(1);
    expect(list.warnings[0]).toMatch(/^Built-in templates are unavailable: could not load fields\./);
  });

  it('unknown site → 400', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/templates?site=nope' })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/templates', payload: { site: 'nope', name: 'x', sheets } })).statusCode).toBe(400);
  });

  it('POST validates the body (400) and returns 201 with the saved template; a taken or built-in name is 409', async () => {
    const a = await app();
    const bad = await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'x', sheets: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/sheets: a template needs at least one sheet/);
    const ok = await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: 'id-1', site: 'one', name: 'Mine', isDefault: false, defaults: { projects: [], authors: [] } });
    expect((await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'MINE', sheets } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Issue list', sheets } })).statusCode).toBe(409);
  });

  it('PUT replaces (optional updatedAt guard), default, DELETE 204; built-ins 403; unknown 404', async () => {
    const a = await app();
    const created = (await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets } })).json();
    clock += 1000;
    const put = await a.inject({ method: 'PUT', url: `/api/templates/${created.id}`, payload: { name: 'Renamed', sheets, updatedAt: created.updatedAt } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: created.id, name: 'Renamed' });
    const stale = await a.inject({ method: 'PUT', url: `/api/templates/${created.id}`, payload: { name: 'X', sheets, updatedAt: created.updatedAt } });
    expect(stale.statusCode).toBe(409);
    expect((await a.inject({ method: 'PUT', url: `/api/templates/${created.id}`, payload: { name: '', sheets } })).statusCode).toBe(400);

    const def = await a.inject({ method: 'POST', url: `/api/templates/${created.id}/default?site=two` });
    expect(def.statusCode).toBe(200);
    expect(def.json()).toEqual({ site: 'one', defaultId: created.id });

    for (const req of [
      { method: 'PUT' as const, url: '/api/templates/builtin:issue-list', payload: { name: 'x', sheets } },
      { method: 'DELETE' as const, url: '/api/templates/builtin:issue-list' },
    ]) {
      const res = await a.inject(req);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Built-in templates are read-only. Use "Save as" to make an editable copy.');
    }

    expect((await a.inject({ method: 'DELETE', url: `/api/templates/${created.id}` })).statusCode).toBe(204);
    expect((await a.inject({ method: 'DELETE', url: `/api/templates/${created.id}` })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/templates/${created.id}/default` })).statusCode).toBe(404);
  });
});


describe('/api/templates default pointer and field check', () => {
  it('a built-in can be the default of ?site=; GET marks it; unset default → 204 and none', async () => {
    const a = await app();
    const set = await a.inject({ method: 'POST', url: '/api/templates/builtin:team-client-report/default?site=two' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ site: 'two', defaultId: 'builtin:team-client-report' });

    const two = (await a.inject({ method: 'GET', url: '/api/templates?site=two' })).json() as List;
    expect(two.defaultId).toBe('builtin:team-client-report');
    expect(two.templates.filter((t) => t.isDefault).map((t) => t.id)).toEqual(['builtin:team-client-report']);
    const one = (await a.inject({ method: 'GET', url: '/api/templates?site=one' })).json() as List;
    expect(one.defaultId).toBeUndefined();
    expect(one.templates.some((t) => t.isDefault)).toBe(false);

    // A saved default replaces the built-in one.
    const mine = (await a.inject({ method: 'POST', url: '/api/templates?site=two', payload: { name: 'Mine', sheets } })).json();
    await a.inject({ method: 'POST', url: `/api/templates/${mine.id}/default` });
    const after = (await a.inject({ method: 'GET', url: '/api/templates?site=two' })).json() as List;
    expect(after.templates.filter((t) => t.isDefault).map((t) => t.id)).toEqual([mine.id]);

    expect((await a.inject({ method: 'DELETE', url: `/api/templates/${mine.id}/default` })).statusCode).toBe(204);
    expect(((await a.inject({ method: 'GET', url: '/api/templates?site=two' })).json() as List).defaultId).toBeUndefined();

    expect((await a.inject({ method: 'POST', url: '/api/templates/builtin:nope/default' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/templates/builtin:issue-list/default?site=nope' })).statusCode).toBe(400);
    expect((await a.inject({ method: 'DELETE', url: '/api/templates/unknown-id/default' })).statusCode).toBe(404);
  });

  it('POST / PUT check every field id against the site field list: 400 naming the sheet and field', async () => {
    const a = await app();
    const bad = [{ name: 'Report', rows: { mode: 'group', groupBy: ['status'] }, columns: ['customfield_99999'] }];
    const post = await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets: bad } });
    expect(post.statusCode).toBe(400);
    expect(post.json()).toEqual({ error: 'Sheet "Report": unknown field(s): customfield_99999. Pick fields from the list.' });

    const cond = [{ name: 'S', rows: { mode: 'eachIssue' }, columns: ['summary'], filter: { conditions: [{ fieldId: 'customfield_1', op: 'isEmpty' }] } }];
    const condRes = await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets: cond } });
    expect(condRes.json().error).toMatch(/Sheet "S": unknown field\(s\): customfield_1\./);

    const ok = (await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets: [{ ...bad[0], columns: [CF] }] } })).json();
    const put = await a.inject({ method: 'PUT', url: `/api/templates/${ok.id}`, payload: { name: 'Mine', sheets: bad } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/customfield_99999/);
  });

  it('saving while the field list cannot be loaded → the Jira error status, nothing saved', async () => {
    const a = await app(fakeJira({ fieldsFail: true }));
    const res = await a.inject({ method: 'POST', url: '/api/templates', payload: { name: 'Mine', sheets } });
    expect(res.statusCode).toBeGreaterThanOrEqual(502);
    expect(res.json().error).toMatch(/^Could not check the template's fields\./);
    expect(await store().list('one')).toEqual([]);
  });
});

// ---- the real app: the root error handler applies inside every route plugin ----

describe('buildServer error handler', () => {
  const AUTH = { authorization: `Basic ${Buffer.from('x@example.com:token').toString('base64')}` };
  const cfg = () =>
    ({
      JIRA_SITES: [{ key: 'one', url: 'https://one.atlassian.net' }],
      JIRA_EMAIL: 'x@example.com',
      JIRA_API_TOKEN: 'unused',
      REPORT_TZ: 'Asia/Dhaka',
      JIRA_CONCURRENCY: 2,
      MAX_RANGE_DAYS: 31,
      REPORT_TIMEOUT_SEC: 60,
      HOURS_PER_DAY: 8,
      TEMPLATES_FILE: file,
      PORT: 0,
    }) as Config;
  const build = () => buildServer(cfg(), { logger: false, sites: [{ key: 'one', url: 'https://one.atlassian.net', jira: fakeJira() }] });

  it('a 400 thrown in a route plugin → 400 { error: message }', async () => {
    const a = await build();
    const bad = [{ name: 'Report', rows: { mode: 'group', groupBy: ['nope_field'] } }];
    const res = await a.inject({ headers: AUTH, method: 'POST', url: '/api/templates', payload: { name: 'X', sheets: bad } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Sheet "Report": unknown field(s): nope_field. Pick fields from the list.' });
  });

  it('store errors (404 / 403 / 409) thrown in routes keep their status and message', async () => {
    const a = await build();
    const missing = await a.inject({ headers: AUTH, method: 'DELETE', url: '/api/templates/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Template not found. It may have been deleted; reload the template list.' });
    const ro = await a.inject({ headers: AUTH, method: 'DELETE', url: '/api/templates/builtin:issue-list' });
    expect(ro.statusCode).toBe(403);
    await a.inject({ headers: AUTH, method: 'POST', url: '/api/templates', payload: { name: 'A', sheets } });
    const dup = await a.inject({ headers: AUTH, method: 'POST', url: '/api/templates', payload: { name: 'a', sheets } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatch(/already exists/);
  });

  it('Fastify errors (bad JSON body) and unexpected errors use the same { error } shape', async () => {
    const a = await build();
    a.get('/boom', async () => {
      throw new Error('secret detail');
    });
    const json = await a.inject({ method: 'POST', url: '/api/templates', headers: { ...AUTH, 'content-type': 'application/json' }, payload: '{bad' });
    expect(json.statusCode).toBe(400);
    expect(Object.keys(json.json())).toEqual(['error']);
    const boom = await a.inject({ headers: AUTH, method: 'GET', url: '/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'Internal server error' });
  });
});
