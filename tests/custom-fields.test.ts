import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { JiraError, type JiraClient } from '../src/jira/client.js';
import { FieldCache } from '../src/jira/fields.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { fieldRoutes } from '../src/routes/fields.js';
import {
  adfToText,
  buildFieldList,
  normalizeFieldValue,
  PSEUDO_FIELDS,
  schemaTypeOf,
  type JiraFieldRaw,
} from '../src/services/custom/fields.js';

const adf = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

describe('normalizeFieldValue', () => {
  it('null / undefined → ""', () => {
    expect(normalizeFieldValue(null, 'string')).toBe('');
    expect(normalizeFieldValue(undefined)).toBe('');
  });

  it('strings and numbers as is', () => {
    expect(normalizeFieldValue('TPX-65', 'string')).toBe('TPX-65');
    expect(normalizeFieldValue('', 'string')).toBe('');
    expect(normalizeFieldValue(3.5, 'number')).toBe('3.5');
    expect(normalizeFieldValue(0, 'number')).toBe('0');
    expect(normalizeFieldValue(Number.NaN, 'number')).toBe('');
  });

  it('booleans → Yes / No', () => {
    expect(normalizeFieldValue(true)).toBe('Yes');
    expect(normalizeFieldValue(false)).toBe('No');
  });

  it('option → .value (cascading: "Parent - Child")', () => {
    expect(normalizeFieldValue({ id: '1', value: 'Gold', self: 'x' }, 'option')).toBe('Gold');
    expect(normalizeFieldValue({ value: 'EU', child: { value: 'DE' } }, 'option-with-child')).toBe('EU - DE');
  });

  it('user → .displayName (even though accountId/name-like keys exist)', () => {
    expect(normalizeFieldValue({ accountId: 'a1', displayName: 'Rahim Uddin', key: 'ignored' }, 'user')).toBe('Rahim Uddin');
  });

  it('arrays → items normalized and joined with ", " (empty items dropped)', () => {
    expect(normalizeFieldValue([{ value: 'A' }, { value: 'B' }], 'array<option>')).toBe('A, B');
    expect(normalizeFieldValue(['x', 'y'], 'array<string>')).toBe('x, y');
    expect(normalizeFieldValue([{ displayName: 'U1' }, null, { displayName: 'U2' }], 'array<user>')).toBe('U1, U2');
    expect(normalizeFieldValue([], 'array<option>')).toBe('');
  });

  it('other objects → name / key / value / displayName fallback, in that order', () => {
    expect(normalizeFieldValue({ name: 'In Progress', key: 'k' }, 'status')).toBe('In Progress');
    expect(normalizeFieldValue({ id: '10', key: 'FFN-1', fields: {} }, 'issuelink')).toBe('FFN-1');
    expect(normalizeFieldValue({ value: 'V' }, 'any')).toBe('V');
    expect(normalizeFieldValue({ displayName: 'D' }, 'any')).toBe('D');
    expect(normalizeFieldValue({ id: '1' }, 'any')).toBe('');
    expect(normalizeFieldValue({ name: '', key: 'K' }, 'any')).toBe('K');
  });

  it('option / user schema with an unexpected shape still falls back', () => {
    expect(normalizeFieldValue({ name: 'N' }, 'option')).toBe('N');
    expect(normalizeFieldValue({ name: 'N' }, 'user')).toBe('N');
  });

  it('ADF → plain text', () => {
    const doc = adf(para(text('Hello '), { type: 'text', text: 'world', marks: [{ type: 'strong' }] }), para(text('Line 2')));
    expect(normalizeFieldValue(doc, 'string')).toBe('Hello world\nLine 2');
  });
});

describe('adfToText', () => {
  it('handles hard breaks, mentions, emoji, lists and links; collapses blank lines', () => {
    const doc = adf(
      para(text('a'), { type: 'hardBreak' }, text('b')),
      para(),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }, { type: 'listItem', content: [para(text('two'))] }] },
      para({ type: 'mention', attrs: { id: 'x', text: '@Rahim' } }, text(' '), { type: 'emoji', attrs: { shortName: ':smile:' } }),
      para({ type: 'inlineCard', attrs: { url: 'https://x.test' } }),
    );
    expect(adfToText(doc)).toBe('a\nb\none\ntwo\n@Rahim :smile:\nhttps://x.test');
  });

  it('empty / malformed documents → ""', () => {
    expect(adfToText(adf())).toBe('');
    expect(adfToText(null)).toBe('');
    expect(adfToText(adf({ type: 'paragraph', content: [{ type: 'text' }] }))).toBe('');
  });
});

describe('buildFieldList', () => {
  const raw: JiraFieldRaw[] = [
    { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
    { id: 'customfield_10050', name: 'Client Reference', custom: true, schema: { type: 'string', custom: 'x:textfield', customId: 10050 } },
    { id: 'customfield_10060', name: 'Labels CF', custom: true, schema: { type: 'array', items: 'option' } },
    { id: 'status', name: 'Status', custom: false, schema: { type: 'status' } },
    { id: 'thumbnail', name: 'Images', custom: false },
  ];

  it('maps schema types', () => {
    expect(schemaTypeOf({ type: 'array', items: 'user' })).toBe('array<user>');
    expect(schemaTypeOf({ type: 'array' })).toBe('array<any>');
    expect(schemaTypeOf(undefined)).toBe('any');
  });

  it('adds pseudo-fields, de-duplicates by id (Jira wins), sorts by name', () => {
    const list = buildFieldList(raw);
    const ids = list.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PSEUDO_FIELDS) expect(ids).toContain(p.id);
    expect(list.find((f) => f.id === 'status')).toEqual({ id: 'status', name: 'Status', custom: false, schemaType: 'status' });
    expect(list.find((f) => f.id === 'customfield_10060')).toEqual({ id: 'customfield_10060', name: 'Labels CF', custom: true, schemaType: 'array<option>' });
    expect(list.find((f) => f.id === 'thumbnail')?.schemaType).toBe('any');
    const names = list.map((f) => f.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

function fakeClient(responses: Array<JiraFieldRaw[] | Error>): JiraClient & { calls: number } {
  const c = {
    baseUrl: 'https://one.atlassian.net',
    calls: 0,
    async get<T>(path: string): Promise<T> {
      expect(path).toBe('/rest/api/3/field');
      const r = responses[Math.min(c.calls, responses.length - 1)]!;
      c.calls++;
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return c;
}

describe('FieldCache', () => {
  const fields: JiraFieldRaw[] = [{ id: 'summary', name: 'Summary', schema: { type: 'string' } }];

  it('serves from cache within the TTL and refetches after it', async () => {
    let now = 0;
    const cache = new FieldCache(600_000, () => now);
    const client = fakeClient([fields]);
    await cache.get('one', client);
    now = 599_999;
    await cache.get('one', client);
    expect(client.calls).toBe(1);
    now = 600_000;
    await cache.get('one', client);
    expect(client.calls).toBe(2);
  });

  it('shares one in-flight call, caches per site, and never caches failures', async () => {
    const cache = new FieldCache();
    const a = fakeClient([fields]);
    await Promise.all([cache.get('one', a), cache.get('one', a)]);
    expect(a.calls).toBe(1);

    const b = fakeClient([new JiraError('Jira 503', 503, '/rest/api/3/field'), fields]);
    await expect(cache.get('two', b)).rejects.toThrow('503');
    await expect(cache.get('two', b)).resolves.toHaveLength(PSEUDO_FIELDS.length + 1);
    expect(b.calls).toBe(2);
  });
});

describe('GET /api/fields', () => {
  async function app(responses: Array<JiraFieldRaw[] | Error>) {
    const client = fakeClient(responses);
    const sites = new SiteRegistry([{ key: 'one', url: client.baseUrl, jira: client }]);
    const a = Fastify();
    await a.register(fieldRoutes, { sites, fields: new FieldCache() });
    return a;
  }

  it('returns {id,name,custom,schemaType}[] including pseudo-fields', async () => {
    const a = await app([[{ id: 'customfield_10050', name: 'Client Reference', custom: true, schema: { type: 'string' } }]]);
    const res = await a.inject({ url: '/api/fields?site=one' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toContainEqual({ id: 'customfield_10050', name: 'Client Reference', custom: true, schemaType: 'string' });
    expect(body.map((f) => f.id)).toContain('issue.keySummary');
    for (const f of body) expect(Object.keys(f).sort()).toEqual(['custom', 'id', 'name', 'schemaType']);
  });

  it('unknown site → 400; Jira failure → friendly error', async () => {
    const a = await app([new JiraError('Jira 503', 503, '/rest/api/3/field')]);
    expect((await a.inject({ url: '/api/fields?site=nope' })).statusCode).toBe(400);
    const res = await a.inject({ url: '/api/fields' });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json().error).toMatch(/^Could not load fields\./);
  });

  it('Jira rejecting the signed-in user\'s token → 401 (the browser goes back to the sign-in screen)', async () => {
    const a = await app([new JiraError('Jira 401', 401, '/rest/api/3/field')]);
    const res = await a.inject({ url: '/api/fields' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/^Could not load fields\. Jira did not accept your email and API token/);
  });
});
