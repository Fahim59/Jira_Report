// Custom Report filter model + JQL compiler. Pure: no Node/Fastify imports (zod runs in the browser too).
import { z } from 'zod';

export const MAX_PROJECTS = 50;
export const MAX_AUTHORS = 50;
/** Authors in one run's filter: a Team Reports group can expand to many users (the JQL clause only uses ≤ JQL_MAX_AUTHORS, the rest is code-only). */
export const MAX_RUN_AUTHORS = 300;
/** Above this many authors, worklogAuthor is left out of the JQL (length limits); filtering is code-only. Same as /api/report. */
export const JQL_MAX_AUTHORS = 20;
export const MAX_CONDITIONS = 20;
export const MAX_IN_VALUES = 100;
export const MAX_USER_JQL = 2000;

export const OPERATORS = ['is', 'isNot', 'in', 'notIn', 'contains', 'isEmpty', 'isNotEmpty'] as const;
export type Operator = (typeof OPERATORS)[number];

/**
 * Pseudo-fields that JQL cannot express; conditions on them are applied in code after fetching.
 * worklog.* come from the worklog; issue.keySummary and epic are computed (epic = nearest Epic ancestor, Step 3).
 */
export const POST_FETCH_FIELDS: ReadonlySet<string> = new Set([
  'worklog.author', 'worklog.date', 'worklog.comment', 'worklog.created', 'worklog.started', 'worklog.timeZone',
  'issue.keySummary', 'issue.id', 'epic', 'parent.id', 'parent.key', 'parent.summary', 'assignee.id',
]);

/**
 * Computed per-row numbers: never in group by or a condition. metric.hours = time per row (flat sheets);
 * metric.issueCount / metric.worklogCount = distinct issues / worklogs in a group (group sheets, see COUNT_FIELDS).
 */
export const METRIC_FIELDS: ReadonlySet<string> = new Set(['metric.hours', 'metric.issueCount', 'metric.worklogCount']);
export const isMetricField = (id: string): boolean => METRIC_FIELDS.has(id);
/** Count columns of group sheets. */
export const COUNT_FIELDS: ReadonlySet<string> = new Set(['metric.issueCount', 'metric.worklogCount']);
export const isCountField = (id: string): boolean => COUNT_FIELDS.has(id);

/** Pseudo-fields with a direct JQL equivalent. */
const JQL_ALIASES: Readonly<Record<string, string>> = { 'issue.key': 'issuekey' };

const CUSTOM_FIELD = /^customfield_(\d{1,18})$/;
/** System field ids are plain identifiers, so they can be written into JQL unquoted without any injection risk. */
const SYSTEM_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isValidFieldId(id: string): boolean {
  return CUSTOM_FIELD.test(id) || SYSTEM_FIELD.test(id) || POST_FETCH_FIELDS.has(id) || METRIC_FIELDS.has(id) || id in JQL_ALIASES;
}

/** Jira field id behind a field, or undefined for the app's pseudo-fields (computed from base fields or worklogs). */
export function jiraFieldId(id: string): string | undefined {
  return POST_FETCH_FIELDS.has(id) || METRIC_FIELDS.has(id) || id in JQL_ALIASES ? undefined : id;
}

export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s;
}

const isoDate = z.string().refine(isRealDate, 'must be a valid yyyy-MM-dd date');
const id = z.string().trim().min(1).max(128);
const dedupe = (xs: string[]) => [...new Set(xs)];
const conditionValue = z.string().trim().min(1, 'must not be empty').max(500);

export const ConditionSchema = z
  .object({
    fieldId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidFieldId, 'is not a valid field id')
      .refine((id) => !isMetricField(id), 'cannot be used in a filter'),
    op: z.enum(OPERATORS),
    value: z.union([conditionValue, z.array(conditionValue).max(MAX_IN_VALUES)]).optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
    if (c.op === 'isEmpty' || c.op === 'isNotEmpty') {
      if (c.value !== undefined && !(Array.isArray(c.value) && c.value.length === 0)) issue(`must be omitted for "${c.op}"`);
    } else if (c.op === 'in' || c.op === 'notIn') {
      if (!Array.isArray(c.value) || c.value.length === 0) issue(`must be a non-empty list for "${c.op}"`);
    } else if (typeof c.value !== 'string') {
      issue(`must be a single value for "${c.op}"`);
    }
  })
  .transform((c): Condition => {
    if (c.op === 'isEmpty' || c.op === 'isNotEmpty') return { fieldId: c.fieldId, op: c.op };
    return { fieldId: c.fieldId, op: c.op, value: Array.isArray(c.value) ? dedupe(c.value) : c.value };
  });

/** value: one string for is/isNot/contains, a list for in/notIn, absent for isEmpty/isNotEmpty. */
export interface Condition {
  fieldId: string;
  op: Operator;
  value?: string | string[];
}

export const CustomFilterSchema = z
  .object({
    // Site key; missing = first configured site.
    site: z.string().max(100).optional(),
    from: isoDate,
    to: isoDate,
    projects: z.array(id).max(MAX_PROJECTS, `at most ${MAX_PROJECTS} projects`).default([]).transform(dedupe),
    // Worklog authors (accountIds). Empty = everyone.
    authors: z.array(id).max(MAX_AUTHORS, `at most ${MAX_AUTHORS} users can be selected`).default([]).transform(dedupe),
    conditions: z.array(ConditionSchema).max(MAX_CONDITIONS, `at most ${MAX_CONDITIONS} filters`).default([]),
    jql: z
      .string()
      .max(MAX_USER_JQL, `JQL must be at most ${MAX_USER_JQL} characters`)
      .optional()
      .transform((s) => (s?.trim() ? s.trim() : undefined)),
  })
  .refine((f) => f.from <= f.to, { path: ['from'], message: '"from" must not be after "to"' });

export type CustomFilter = z.infer<typeof CustomFilterSchema>;

/** Quotes a value for JQL, escaping backslashes and double quotes. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shiftDay(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** JQL field reference: customfield_12345 → cf[12345]; issue.key → issuekey; system ids as is. */
export function jqlFieldRef(fieldId: string): string {
  const cf = CUSTOM_FIELD.exec(fieldId);
  if (cf) return `cf[${cf[1]}]`;
  const alias = JQL_ALIASES[fieldId];
  if (alias) return alias;
  if (POST_FETCH_FIELDS.has(fieldId) || METRIC_FIELDS.has(fieldId) || !SYSTEM_FIELD.test(fieldId)) throw new Error(`Field "${fieldId}" cannot be used in JQL`);
  return fieldId;
}

export function isPostFetchCondition(c: Condition): boolean {
  return POST_FETCH_FIELDS.has(c.fieldId);
}

/**
 * Conditions that may be compiled into JQL purely to narrow a search whose result is re-checked in code
 * (the issues-without-time search of an each-issue sheet). Pseudo-fields have no JQL form, and "contains" is left
 * out because JQL's `~` is a word search: it can miss substrings the in-code check accepts.
 */
export function jqlNarrowingConditions(conditions: readonly Condition[]): Condition[] {
  return conditions.filter((c) => !isPostFetchCondition(c) && !isMetricField(c.fieldId) && c.op !== 'contains');
}

function asList(v: Condition['value']): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * One issue-field condition as JQL. "is not" / "not in" also match empty values (Jira's != alone skips them),
 * which is what a user means by "Status is not Done".
 */
export function compileCondition(c: Condition): string {
  const f = jqlFieldRef(c.fieldId);
  const values = asList(c.value);
  const one = jqlString(values[0] ?? '');
  const list = `(${values.map(jqlString).join(', ')})`;
  switch (c.op) {
    case 'is':
      return `${f} = ${one}`;
    case 'isNot':
      return `(${f} != ${one} OR ${f} is EMPTY)`;
    case 'in':
      return `${f} in ${list}`;
    case 'notIn':
      return `(${f} not in ${list} OR ${f} is EMPTY)`;
    case 'contains':
      return `${f} ~ ${one}`;
    case 'isEmpty':
      return `${f} is EMPTY`;
    case 'isNotEmpty':
      return `${f} is not EMPTY`;
  }
}

/**
 * Structural check of the user's JQL before it is embedded as `AND (<jql>)`: parentheses must balance
 * outside quoted strings (so it cannot close our parenthesis and escape the date/project scope),
 * strings must be closed, and ORDER BY is not allowed (the report sets its own order).
 * Returns an error message, or undefined if fine. Jira's own parser validates the rest.
 */
export function checkUserJql(jql: string): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  let outside = '';
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      outside += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      outside += ' ';
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return 'JQL has a ")" without a matching "("';
    outside += ch;
  }
  if (quote) return 'JQL has an unclosed quoted string';
  if (depth !== 0) return 'JQL has a "(" without a matching ")"';
  if (/\border\s+by\b/i.test(outside)) return 'JQL must not contain ORDER BY (the report sets its own order)';
  return undefined;
}

export class InvalidJqlError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJqlError';
  }
}

export interface CompiledFilter {
  /** Full JQL for /search/jql, including ORDER BY. */
  jql: string;
  /** The same without ORDER BY (what Jira's parser validates). */
  where: string;
  /** Conditions applied in code after fetching (worklog-level and computed pseudo-fields). */
  postConditions: Condition[];
  /** Issue fields the conditions refer to (to add to fields= in the search). */
  conditionFieldIds: string[];
}

/**
 * Final JQL = worklogDate window [AND project in (...)] [AND worklogAuthor in (...)]
 *             [AND (<compiled issue conditions>)] [AND (<user JQL>)] ORDER BY key ASC.
 * The worklogDate window is widened by a day each side (Jira uses the API user's timezone);
 * exact REPORT_TZ filtering and the author filter are always applied in code as well.
 */
export function compileFilter(filter: CustomFilter): CompiledFilter {
  const clauses = [`worklogDate >= ${jqlString(shiftDay(filter.from, -1))}`, `worklogDate <= ${jqlString(shiftDay(filter.to, 1))}`];
  if (filter.projects.length) clauses.push(`project in (${filter.projects.map(jqlString).join(', ')})`);
  if (filter.authors.length > 0 && filter.authors.length <= JQL_MAX_AUTHORS) {
    clauses.push(`worklogAuthor in (${filter.authors.map(jqlString).join(', ')})`);
  }

  const jqlConditions = filter.conditions.filter((c) => !isPostFetchCondition(c));
  if (jqlConditions.length) clauses.push(`(${jqlConditions.map(compileCondition).join(' AND ')})`);

  if (filter.jql) {
    const problem = checkUserJql(filter.jql);
    if (problem) throw new InvalidJqlError(problem);
    clauses.push(`(${filter.jql})`);
  }

  const where = clauses.join(' AND ');
  return {
    jql: `${where} ORDER BY key ASC`,
    where,
    postConditions: filter.conditions.filter(isPostFetchCondition),
    conditionFieldIds: dedupe(jqlConditions.map((c) => c.fieldId)),
  };
}

/**
 * Applies one condition in code. `actual` is every value the item has for the field (e.g. [accountId]
 * for worklog.author, or the epic's key and "KEY Summary"); comparisons are case-insensitive and trimmed.
 */
export function matchesCondition(c: Condition, actual: readonly string[]): boolean {
  const have = actual.map((v) => v.trim().toLowerCase()).filter((v) => v !== '');
  const want = asList(c.value).map((v) => v.trim().toLowerCase());
  const anyEqual = have.some((v) => want.includes(v));
  switch (c.op) {
    case 'is':
    case 'in':
      return anyEqual;
    case 'isNot':
    case 'notIn':
      return !anyEqual;
    case 'contains':
      return have.some((v) => v.includes(want[0] ?? ''));
    case 'isEmpty':
      return have.length === 0;
    case 'isNotEmpty':
      return have.length > 0;
  }
}
