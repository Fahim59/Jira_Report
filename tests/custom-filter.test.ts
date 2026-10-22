import { describe, expect, it } from 'vitest';
import { JiraError, type JiraClient } from '../src/jira/client.js';
import { validateCustomJql } from '../src/jira/jql.js';
import {
  checkUserJql,
  compileCondition,
  compileFilter,
  CustomFilterSchema,
  InvalidJqlError,
  jqlFieldRef,
  jqlString,
  matchesCondition,
  type Condition,
} from '../src/services/custom/filter.js';

const base = { from: '2026-09-01', to: '2026-09-29' };
const parse = (body: unknown) => CustomFilterSchema.parse(body);
const issuesOf = (body: unknown) => {
  const r = CustomFilterSchema.safeParse(body);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('jqlString escaping', () => {
  it('escapes double quotes and backslashes', () => {
    expect(jqlString('plain')).toBe('"plain"');
    expect(jqlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(jqlString('C:\\temp')).toBe('"C:\\\\temp"');
    // Backslash before a quote: both escaped, so the quote cannot close the string.
    expect(jqlString('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

describe('jqlFieldRef', () => {
  it('custom fields use cf[id]; issue.key → issuekey; system ids as is', () => {
    expect(jqlFieldRef('customfield_10050')).toBe('cf[10050]');
    expect(jqlFieldRef('issue.key')).toBe('issuekey');
    expect(jqlFieldRef('status')).toBe('status');
  });

  it('rejects post-fetch pseudo-fields and anything that is not an identifier', () => {
    expect(() => jqlFieldRef('worklog.author')).toThrow();
    expect(() => jqlFieldRef('epic')).toThrow();
    expect(() => jqlFieldRef('status = x OR project')).toThrow();
  });
});

describe('compileCondition: every operator', () => {
  const cf = 'customfield_10050';
  it.each<[Condition, string]>([
    [{ fieldId: 'status', op: 'is', value: 'Done' }, 'status = "Done"'],
    [{ fieldId: 'status', op: 'isNot', value: 'Done' }, '(status != "Done" OR status is EMPTY)'],
    [{ fieldId: cf, op: 'in', value: ['A', 'B'] }, 'cf[10050] in ("A", "B")'],
    [{ fieldId: cf, op: 'notIn', value: ['A'] }, '(cf[10050] not in ("A") OR cf[10050] is EMPTY)'],
    [{ fieldId: cf, op: 'contains', value: 'TPX-65' }, 'cf[10050] ~ "TPX-65"'],
    [{ fieldId: 'assignee', op: 'isEmpty' }, 'assignee is EMPTY'],
    [{ fieldId: 'assignee', op: 'isNotEmpty' }, 'assignee is not EMPTY'],
  ])('%j → %s', (c, jql) => {
    expect(compileCondition(c)).toBe(jql);
  });
});

describe('CustomFilterSchema', () => {
  it('fills defaults, trims and de-duplicates', () => {
    const f = parse({ ...base, projects: ['FFN', ' FFN '], authors: ['a', 'a'], jql: '   ' });
    expect(f).toEqual({ ...base, projects: ['FFN'], authors: ['a'], conditions: [], jql: undefined });
  });

  it('rejects bad dates and from > to', () => {
    expect(issuesOf({ from: '2026-02-30', to: '2026-03-01' })[0]).toMatch(/^from: must be a valid/);
    expect(issuesOf({ from: '2026-09-10', to: '2026-09-01' })[0]).toMatch(/must not be after/);
  });

  it('checks the value shape per operator', () => {
    const cond = (c: object) => issuesOf({ ...base, conditions: [c] });
    expect(cond({ fieldId: 'status', op: 'is', value: ['Done'] })[0]).toMatch(/single value/);
    expect(cond({ fieldId: 'status', op: 'in', value: 'Done' })[0]).toMatch(/non-empty list/);
    expect(cond({ fieldId: 'status', op: 'in', value: [] })[0]).toMatch(/non-empty list/);
    expect(cond({ fieldId: 'status', op: 'isEmpty', value: 'x' })[0]).toMatch(/omitted/);
    expect(cond({ fieldId: 'status', op: 'contains', value: '  ' })[0]).toMatch(/must not be empty/);
    expect(cond({ fieldId: 'status', op: 'like', value: 'x' })).not.toHaveLength(0);
    expect(cond({ fieldId: 'status', op: 'isEmpty' })).toEqual([]);
  });

  it('rejects field ids that could inject JQL', () => {
    for (const fieldId of ['status = "x" OR project', 'cf[1]', 'status"', 'worklog.secret', 'a b']) {
      expect(issuesOf({ ...base, conditions: [{ fieldId, op: 'isEmpty' }] })[0]).toMatch(/not a valid field id/);
    }
  });
});

describe('compileFilter', () => {
  it('base clauses only: widened worklogDate window, ORDER BY key', () => {
    const c = compileFilter(parse(base));
    expect(c.where).toBe('worklogDate >= "2026-08-31" AND worklogDate <= "2026-09-30"');
    expect(c.jql).toBe(`${c.where} ORDER BY key ASC`);
    expect(c.postConditions).toEqual([]);
    expect(c.conditionFieldIds).toEqual([]);
  });

  it('combines projects, authors, conditions and user JQL; worklog-level conditions stay in code', () => {
    const c = compileFilter(
      parse({
        from: '2026-01-01',
        to: '2026-12-31',
        projects: ['FFN', 'ABC'],
        authors: ['acc-1', 'acc-2'],
        conditions: [
          { fieldId: 'customfield_10050', op: 'contains', value: 'TPX-65' },
          { fieldId: 'status', op: 'notIn', value: ['Done', 'Closed'] },
          { fieldId: 'worklog.author', op: 'is', value: 'acc-1' },
          { fieldId: 'worklog.date', op: 'in', value: ['2026-01-05'] },
        ],
        jql: 'labels = billable OR priority = High',
      }),
    );
    expect(c.where).toBe(
      'worklogDate >= "2025-12-31" AND worklogDate <= "2027-01-01"' +
        ' AND project in ("FFN", "ABC")' +
        ' AND worklogAuthor in ("acc-1", "acc-2")' +
        ' AND (cf[10050] ~ "TPX-65" AND (status not in ("Done", "Closed") OR status is EMPTY))' +
        ' AND (labels = billable OR priority = High)',
    );
    expect(c.postConditions.map((p) => p.fieldId)).toEqual(['worklog.author', 'worklog.date']);
    expect(c.conditionFieldIds).toEqual(['customfield_10050', 'status']);
  });

  it('isNot / notIn keep empty values: (field != X OR field is EMPTY) in the final JQL', () => {
    const c = compileFilter(
      parse({
        ...base,
        conditions: [
          { fieldId: 'customfield_10050', op: 'isNot', value: 'TPX-1' },
          { fieldId: 'assignee', op: 'notIn', value: ['acc-1', 'acc-2'] },
        ],
      }),
    );
    expect(c.where).toContain(
      'AND ((cf[10050] != "TPX-1" OR cf[10050] is EMPTY) AND (assignee not in ("acc-1", "acc-2") OR assignee is EMPTY))',
    );
  });

  it('leaves worklogAuthor out of the JQL above 20 authors', () => {
    const authors = Array.from({ length: 21 }, (_, i) => `acc-${i}`);
    expect(compileFilter(parse({ ...base, authors })).where).not.toContain('worklogAuthor');
    expect(compileFilter(parse({ ...base, authors: authors.slice(0, 20) })).where).toContain('worklogAuthor in (');
  });

  describe('injection attempts', () => {
    it('quoted values cannot break out of the string', () => {
      const c = compileFilter(parse({ ...base, conditions: [{ fieldId: 'status', op: 'is', value: '") OR project = X' }] }));
      expect(c.where).toContain('AND (status = "\\") OR project = X")');
      // Whatever the value, the condition remains one quoted string: strip it and nothing is left outside.
      const outside = c.where.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect(outside).not.toContain('OR project');
    });

    it('project keys and accountIds are quoted too', () => {
      const c = compileFilter(parse({ ...base, projects: ['X") OR (project = Y'], authors: ['a" OR "b'] }));
      const outside = c.where.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect(outside).toBe('worklogDate >= "" AND worklogDate <= "" AND project in ("") AND worklogAuthor in ("")');
    });

    it.each([
      ['closing our parenthesis', 'project = X) OR (project = Y', /without a matching "\("/],
      ['unbalanced open', '(project = X', /without a matching "\)"/],
      ['unclosed string', 'summary ~ "abc', /unclosed/],
      ['ORDER BY', 'project = X ORDER BY created', /ORDER BY/],
    ])('user JQL: rejects %s', (_, jql, msg) => {
      expect(checkUserJql(jql)).toMatch(msg);
      expect(() => compileFilter(parse({ ...base, jql }))).toThrow(InvalidJqlError);
    });

    it('user JQL: parentheses / ORDER BY inside quoted strings are fine', () => {
      expect(checkUserJql('summary ~ "a ) b" AND text ~ \'order by\' AND summary ~ "x \\" )"')).toBeUndefined();
      expect(compileFilter(parse({ ...base, jql: '(a = 1 OR b = 2)' })).where).toMatch(/AND \(\(a = 1 OR b = 2\)\)$/);
    });
  });
});

describe('matchesCondition (post-fetch)', () => {
  const c = (op: Condition['op'], value?: string | string[]): Condition => ({ fieldId: 'worklog.author', op, value });
  it('applies every operator case-insensitively', () => {
    expect(matchesCondition(c('is', 'ACC-1'), ['acc-1'])).toBe(true);
    expect(matchesCondition(c('is', 'acc-1'), ['acc-2'])).toBe(false);
    expect(matchesCondition(c('isNot', 'acc-1'), ['acc-2'])).toBe(true);
    expect(matchesCondition(c('isNot', 'acc-1'), [])).toBe(true);
    expect(matchesCondition(c('in', ['a', 'b']), ['B'])).toBe(true);
    expect(matchesCondition(c('notIn', ['a', 'b']), ['b'])).toBe(false);
    expect(matchesCondition(c('contains', 'px-6'), ['FFN-1', 'TPX-65 Summary'])).toBe(true);
    expect(matchesCondition(c('contains', 'zzz'), ['TPX-65'])).toBe(false);
    expect(matchesCondition(c('isEmpty'), ['', '  '])).toBe(true);
    expect(matchesCondition(c('isNotEmpty'), ['x'])).toBe(true);
    expect(matchesCondition(c('isNotEmpty'), [])).toBe(false);
  });
});

describe('validateCustomJql', () => {
  function client(reply: unknown | Error): JiraClient & { bodies: unknown[] } {
    const bodies: unknown[] = [];
    return {
      baseUrl: 'https://one.atlassian.net',
      bodies,
      async get<T>(): Promise<T> {
        throw new Error('unexpected GET');
      },
      async post<T>(path: string, body: unknown, query?: Record<string, unknown>): Promise<T> {
        expect(path).toBe('/rest/api/3/jql/parse');
        expect(query).toEqual({ validation: 'strict' });
        bodies.push(body);
        if (reply instanceof Error) throw reply;
        return reply as T;
      },
    };
  }

  it('skips the call when there is nothing user-supplied in the JQL', async () => {
    const c = client(new Error('should not be called'));
    await validateCustomJql(c, compileFilter(parse(base)), undefined);
    expect(c.bodies).toEqual([]);
  });

  it("returns Jira's message for invalid user JQL", async () => {
    const f = parse({ ...base, jql: 'foo = bar' });
    const compiled = compileFilter(f);
    const c = client({ queries: [{ errors: ["Field 'foo' does not exist or you do not have permission to view it."] }, { errors: ['x'] }] });
    await expect(validateCustomJql(c, compiled, f.jql)).rejects.toThrow("Invalid JQL: Field 'foo' does not exist");
    expect(c.bodies).toEqual([{ queries: ['foo = bar', compiled.where] }]);
  });

  it('reports errors in the compiled conditions; passes when Jira finds none', async () => {
    const f = parse({ ...base, conditions: [{ fieldId: 'customfield_1', op: 'is', value: 'Nope' }] });
    const compiled = compileFilter(f);
    await expect(validateCustomJql(client({ queries: [{ errors: ["The option 'Nope' does not exist"] }] }), compiled, undefined)).rejects.toThrow(
      /^The filters are not valid in Jira: The option 'Nope'/,
    );
    await expect(validateCustomJql(client({ queries: [{ errors: [] }] }), compiled, undefined)).resolves.toBeUndefined();
  });

  it('maps a 400 from Jira to InvalidJqlError; other failures pass through', async () => {
    const f = parse({ ...base, jql: 'x' });
    const compiled = compileFilter(f);
    const bad = new JiraError('Jira 400 on /rest/api/3/jql/parse: Error in the JQL Query', 400, '/rest/api/3/jql/parse');
    const err = await validateCustomJql(client(bad), compiled, f.jql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidJqlError);
    expect((err as InvalidJqlError).statusCode).toBe(400);
    expect((err as Error).message).toBe('Invalid JQL: Error in the JQL Query');
    const down = new JiraError('Jira 503', 503, '/rest/api/3/jql/parse');
    await expect(validateCustomJql(client(down), compiled, f.jql)).rejects.toBe(down);
  });
});
