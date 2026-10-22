// Report templates (Phase 8b): a template is a list of sheets; one Generate = one Jira fetch for all of them.
// Pure: no Node/Fastify imports (zod runs in the browser too).
import { z } from 'zod';
import {
  checkUserJql,
  ConditionSchema,
  isCountField,
  isMetricField,
  isRealDate,
  MAX_AUTHORS,
  MAX_CONDITIONS,
  MAX_PROJECTS,
  MAX_RUN_AUTHORS,
  MAX_USER_JQL,
} from './filter.js';
import { fieldIdSchema, MAX_COLUMNS, PERIODS } from './layout.js';
import { extractProblem, MAX_EXTRACT, MAX_NOTE, MAX_NOTES, MAX_TITLE } from './text.js';

export const MAX_SHEETS = 10;
/** Sanity bound on one group sheet's levels (a field can be used once, so this is never reached in practice). */
export const MAX_GROUP_FIELDS = 50;
export const MAX_SHEET_NAME = 31;
export const MAX_TEMPLATE_NAME = 100;
export const MAX_LABEL = 100;
export const ROW_MODES = ['group', 'eachWorklog', 'eachIssue'] as const;
export type RowMode = (typeof ROW_MODES)[number];
/** Group sheets: a "Total <level>" column after every level, or one total column after the period columns. */
export const TOTAL_COLUMNS = ['everyLevel', 'lastLevel'] as const;
export type TotalColumns = (typeof TOTAL_COLUMNS)[number];
export const DEFAULT_TOTAL_LABEL = 'Total';
/** Above the table: 'standard' = the rows 1–6 block; 'title' = bold title + subtitle, table from row 4; 'none' = table first. */
export const HEADER_STYLES = ['standard', 'title', 'none'] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];
/** Each-issue sheets with includeIssuesWithoutWorklogs: at most this many issues from the extra issue search. */
export const MAX_ISSUES_WITHOUT_WORKLOGS = 5000;

export const ZONE_MODES = ['server', 'user', 'author'] as const;

/** IANA zone name Intl accepts (same check in Node and the browser). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const dedupe = (xs: string[]) => [...new Set(xs)];
const id = z.string().trim().min(1).max(128);
const isoDate = z.string().refine(isRealDate, 'must be a valid yyyy-MM-dd date');
const projects = z.array(id).max(MAX_PROJECTS, `at most ${MAX_PROJECTS} projects`).default([]).transform(dedupe);
// Worklog authors (accountIds). Empty = everyone.
const authors = z.array(id).max(MAX_AUTHORS, `at most ${MAX_AUTHORS} users can be selected`).default([]).transform(dedupe);

/** Chosen on every run; applies to every sheet and drives the single Jira fetch. */
export const GlobalFilterSchema = z
  .object({
    // Site key; missing = first configured site.
    site: z.string().max(100).optional(),
    from: isoDate,
    to: isoDate,
    projects,
    authors: z.array(id).max(MAX_RUN_AUTHORS, `at most ${MAX_RUN_AUTHORS} users can be selected`).default([]).transform(dedupe),
    // Whose calendar decides which day a worklog belongs to: the configured REPORT_TZ ("server"), `userZone` (the
    // browser's zone, "user") or each worklog author's own Jira time zone ("author", REPORT_TZ if unknown).
    zone: z.enum(ZONE_MODES).default('server'),
    userZone: z.string().max(64).refine(isTimeZone, 'is not a valid time zone').optional(),
  })
  .refine((f) => f.from <= f.to, { path: ['from'], message: '"from" must not be after "to"' })
  .refine((f) => f.zone !== 'user' || f.userZone !== undefined, { path: ['userZone'], message: 'is required with time zone "user"' });

export type GlobalFilter = z.infer<typeof GlobalFilterSchema>;

/** Excel's sheet-name rules: 1–31 chars, none of : \ / ? * [ ], not starting or ending with an apostrophe. */
export const SheetNameSchema = z
  .string()
  .trim()
  .min(1, 'sheet name is required')
  .max(MAX_SHEET_NAME, `sheet name must be at most ${MAX_SHEET_NAME} characters`)
  .refine((s) => !/[:\\/?*[\]]/.test(s), 'sheet name must not contain : \\ / ? * [ ]')
  .refine((s) => !s.startsWith("'") && !s.endsWith("'"), 'sheet name must not start or end with an apostrophe');

const SheetFilterSchema = z
  .object({
    conditions: z.array(ConditionSchema).max(MAX_CONDITIONS, `at most ${MAX_CONDITIONS} filters`).default([]),
    jql: z
      .string()
      .max(MAX_USER_JQL, `JQL must be at most ${MAX_USER_JQL} characters`)
      .optional()
      .transform((s) => (s?.trim() ? s.trim() : undefined))
      .superRefine((s, ctx) => {
        const problem = s === undefined ? undefined : checkUserJql(s);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
  })
  .prefault({});

/** A column or group level: the field, and optionally the header to show instead of the field name. */
export interface FieldRef {
  fieldId: string;
  /** Excel / preview header ("Total <label>" for group totals). Absent = the field name. */
  label?: string;
  /**
   * Regex applied to the value before grouping / display (text/applyExtract): group 1 of the first match if
   * present, else the whole match; no match = the value unchanged.
   */
  extract?: string;
}

/** `fieldId` or `{ fieldId, label?, extract? }`, normalised to FieldRef (a blank label / extract = none). */
const fieldRef = (id: z.ZodType<string>) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? { fieldId: v } : v),
    z
      .object({
        fieldId: id,
        label: z.string().trim().max(MAX_LABEL, `label must be at most ${MAX_LABEL} characters`).optional(),
        extract: z
          .string()
          .trim()
          .max(MAX_EXTRACT, `extract pattern must be at most ${MAX_EXTRACT} characters`)
          .optional()
          .superRefine((x, ctx) => {
            const problem = x ? extractProblem(x) : undefined;
            if (problem) ctx.addIssue({ code: 'custom', message: problem });
          }),
      })
      .strict()
      .transform(({ fieldId, label, extract }): FieldRef => ({ fieldId, ...(label ? { label } : {}), ...(extract ? { extract } : {}) })),
  );

/** Field ids of refs, in order. */
export const refIds = (refs: readonly FieldRef[]): string[] => refs.map((r) => r.fieldId);

/** Drops repeated fields (the first ref, with its label, wins). */
const dedupeRefs = (refs: FieldRef[]): FieldRef[] => {
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(r.fieldId) && !!seen.add(r.fieldId));
};

const RowsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('group'),
    groupBy: z
      .array(fieldRef(fieldIdSchema.refine((f) => !isMetricField(f), 'cannot be grouped by')))
      // No minimum (Team Reports can group by nothing: one total per period) and no practical maximum: the Custom
      // Report editor offers up to MAX_GROUP_LEVELS, the server only guards against absurd bodies.
      .max(MAX_GROUP_FIELDS, `group by at most ${MAX_GROUP_FIELDS} fields`)
      .refine((refs) => new Set(refIds(refs)).size === refs.length, 'a field can be used only once in group by'),
  }),
  z.object({ mode: z.literal('eachWorklog') }),
  z.object({ mode: z.literal('eachIssue') }),
]);

export const SheetSchema = z
  .object({
    name: SheetNameSchema,
    rows: RowsSchema,
    columns: z
      .array(fieldRef(fieldIdSchema))
      .max(MAX_COLUMNS, `at most ${MAX_COLUMNS} columns`)
      .default([])
      .transform(dedupeRefs),
    totals: z.boolean().default(true),
    period: z.enum(PERIODS).default('none'),
    format: z.enum(['hours', 'days']).default('hours'),
    sumSubtasksToParent: z.boolean().default(false),
    sort: z.enum(['value', 'totalDesc']).default('value'),
    filter: SheetFilterSchema,
    // Group sheets only (see TOTAL_COLUMNS). The label heads the single total column (lastLevel) or the trailing
    // Total column after period columns (everyLevel); blank = "Total".
    totalColumns: z.enum(TOTAL_COLUMNS).default('everyLevel'),
    totalLabel: z
      .string()
      .trim()
      .max(MAX_LABEL, `total label must be at most ${MAX_LABEL} characters`)
      .optional()
      .transform((s) => s || DEFAULT_TOTAL_LABEL),
    // lastLevel only: a bold subtotal row after each parent group.
    subtotalRows: z.boolean().default(false),
    // Each-issue sheets only: also list matching issues without time in the range (0 hours).
    includeIssuesWithoutWorklogs: z.boolean().default(false),
    // Group sheets only: JQL for additional issues without time ("Extra JQL"); they appear as rows with 0 hours.
    extraJql: z
      .string()
      .max(MAX_USER_JQL, `extra JQL must be at most ${MAX_USER_JQL} characters`)
      .optional()
      .transform((s) => (s?.trim() ? s.trim() : undefined))
      .superRefine((s, ctx) => {
        const problem = s === undefined ? undefined : checkUserJql(s);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    // Group sheets only: merge each parent level's value (and its "Total <level>" cell) down its rows, top-aligned.
    mergeGroupCells: z.boolean().default(false),
    headerStyle: z.enum(HEADER_STYLES).default('standard'),
    // headerStyle 'title' only (title required there); placeholders {projects} {from} {to} {tz} {site} {generated} {users}.
    title: optionalText(MAX_TITLE, 'title'),
    subtitle: optionalText(MAX_TITLE, 'subtitle'),
    // Lines below the table (after a blank row and a bold "Notes" heading). Blank lines are dropped.
    notes: z
      .array(z.string().max(MAX_NOTE, `a note line must be at most ${MAX_NOTE} characters`))
      .max(MAX_NOTES, `at most ${MAX_NOTES} note lines`)
      .default([])
      .transform((lines) => lines.map((l) => l.trim()).filter(Boolean)),
  })
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (s.rows.mode !== 'eachIssue' && s.includeIssuesWithoutWorklogs) {
      issue(['includeIssuesWithoutWorklogs'], 'issues without time can only be included in each-issue sheets');
    }
    if (s.rows.mode !== 'group' && s.extraJql) issue(['extraJql'], 'extra JQL is only available in group sheets');
    s.columns.forEach((c, i) => {
      if (c.extract && isMetricField(c.fieldId)) issue(['columns', i, 'extract'], 'numbers cannot have an extract pattern');
    });
    if (s.headerStyle === 'title' && !s.title) issue(['title'], 'a title is required with header style "title"');
    if (s.headerStyle !== 'title' && (s.title || s.subtitle)) issue(['title'], 'a title / subtitle needs header style "title"');
    if (s.rows.mode === 'group') {
      s.columns.forEach((c, i) => {
        if (isMetricField(c.fieldId) && !isCountField(c.fieldId)) issue(['columns', i], 'hours are already shown in group sheets');
      });
      if (s.subtotalRows && s.totalColumns !== 'lastLevel') issue(['subtotalRows'], 'subtotal rows need totalColumns "lastLevel"');
      if (s.subtotalRows && !s.totals) issue(['subtotalRows'], 'subtotal rows need totals on');
      return;
    }
    if (s.columns.length === 0) issue(['columns'], 'pick at least one column');
    if (s.period !== 'none') issue(['period'], 'period columns are only available in group sheets');
    if (s.totalColumns !== 'everyLevel') issue(['totalColumns'], 'total columns are only available in group sheets');
    if (s.totalLabel !== DEFAULT_TOTAL_LABEL) issue(['totalLabel'], 'a total label is only available in group sheets');
    if (s.subtotalRows) issue(['subtotalRows'], 'subtotal rows are only available in group sheets');
    if (s.mergeGroupCells) issue(['mergeGroupCells'], 'merged group cells are only available in group sheets');
    s.columns.forEach((c, i) => {
      if (isCountField(c.fieldId)) issue(['columns', i], 'issue / worklog counts are only available in group sheets');
    });
    if (s.rows.mode === 'eachIssue') {
      s.columns.forEach((c, i) => {
        if (c.fieldId.startsWith('worklog.')) issue(['columns', i], 'worklog fields are not available in each-issue sheets');
      });
    }
  });

export type Sheet = z.infer<typeof SheetSchema>;

function optionalText(max: number, what: string) {
  return z
    .string()
    .trim()
    .max(max, `${what} must be at most ${max} characters`)
    .optional()
    .transform((s) => s || undefined);
}

const sheets = z
  .array(SheetSchema)
  .min(1, 'a template needs at least one sheet')
  .max(MAX_SHEETS, `at most ${MAX_SHEETS} sheets`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((s, i) => {
      const k = s.name.toLowerCase(); // Excel sheet names are case-insensitive
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `sheet name "${s.name}" is used twice` });
      seen.add(k);
    });
  });

/** What the user edits (and what POST /api/custom-report takes inline, saved or not). */
export const TemplateBodySchema = z.object({
  name: z.string().trim().min(1, 'template name is required').max(MAX_TEMPLATE_NAME),
  defaults: z.object({ projects, authors }).prefault({}),
  sheets,
});

export type TemplateBody = z.infer<typeof TemplateBodySchema>;

/** A saved template (Step D store). */
export interface Template extends TemplateBody {
  id: string;
  site: string;
  isDefault: boolean;
  updatedAt: string;
}

/** Every field a sheet uses (rows, columns, conditions), in first-use order. */
export function sheetFieldIds(sheet: Sheet): string[] {
  const groupBy = sheet.rows.mode === 'group' ? refIds(sheet.rows.groupBy) : [];
  return dedupe([...groupBy, ...refIds(sheet.columns), ...sheet.filter.conditions.map((c) => c.fieldId)]);
}

/** Union of the fields used by all sheets: drives the one search's fields= and the field check. */
export function templateFieldIds(template: Pick<TemplateBody, 'sheets'>): string[] {
  return dedupe(template.sheets.flatMap(sheetFieldIds));
}

/** Header of a column / group level: its label, else the field name, else the field id. */
export function refHeader(ref: FieldRef, fieldNames?: ReadonlyMap<string, string>): string {
  return ref.label ?? fieldNames?.get(ref.fieldId) ?? ref.fieldId;
}

/** Header of a group level's subtotal column: "Total <header>". */
export const totalHeader = (ref: FieldRef, fieldNames?: ReadonlyMap<string, string>): string =>
  `Total ${refHeader(ref, fieldNames)}`;
