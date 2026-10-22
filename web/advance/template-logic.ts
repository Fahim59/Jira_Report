// Pure rules for the template editor of the Custom Report tab (no DOM, no zod: unit-tested in node).
// A TemplateDraft is what the editor edits; draftToBody() turns it into the TemplateBody the server takes, with the
// same rules as src/services/custom/template.ts (the server checks again either way).
import type { FieldInfo } from '../../src/services/custom/fields.js';
import type { Condition } from '../../src/services/custom/filter.js';
import { isCountColumn } from '../../src/services/custom/table.js';
import type { FieldRef, HeaderStyle, RowMode, Sheet, TemplateBody, TotalColumns } from '../../src/services/custom/template.js';
import { extractProblem, MAX_NOTE, MAX_NOTES, MAX_TITLE } from '../../src/services/custom/text.js';
import { buildConditions, isUserField, rangeDays, type ConditionDraft } from './logic.js';

/** Same limits as src/services/custom/template.ts (kept in sync by tests/custom-ui.test.ts). */
export const MAX_SHEETS = 10;
export const MAX_SHEET_NAME = 31;
export const MAX_TEMPLATE_NAME = 100;
export const MAX_LABEL = 100;
export const DEFAULT_TOTAL_LABEL = 'Total';
export const HOURS_FIELD = 'metric.hours';
export const ROW_MODE_LABELS: Readonly<Record<RowMode, string>> = {
  group: 'Grouped (tree)',
  eachWorklog: 'One row per worklog',
  eachIssue: 'One row per issue',
};

/** A group level or column as edited: the field, its header label ('' = the field name) and extract regex ('' = none). */
export interface RefDraft {
  fieldId: string;
  label: string;
  extract: string;
}

export interface SheetDraft {
  name: string;
  mode: RowMode;
  /** Group mode only (kept while another mode is chosen, so switching back restores them). */
  groupBy: RefDraft[];
  columns: RefDraft[];
  totals: boolean;
  period: Sheet['period'];
  format: Sheet['format'];
  sumSubtasksToParent: boolean;
  sort: Sheet['sort'];
  totalColumns: TotalColumns;
  totalLabel: string;
  subtotalRows: boolean;
  includeIssuesWithoutWorklogs: boolean;
  mergeGroupCells: boolean;
  headerStyle: HeaderStyle;
  title: string;
  subtitle: string;
  /** One note per line. */
  notes: string;
  conditions: ConditionDraft[];
  jql: string;
}

export interface TemplateDraft {
  name: string;
  defaults: { projects: string[]; authors: string[] };
  sheets: SheetDraft[];
}

// ---- Fields per mode ----

/** Whether a field can be a column of a sheet in `mode` (Hours: flat sheets only; counts: group sheets only; worklog.*: not per issue). */
export function columnAllowed(mode: RowMode, fieldId: string): boolean {
  if (fieldId === HOURS_FIELD) return mode !== 'group';
  if (isCountColumn(fieldId)) return mode === 'group';
  if (mode === 'eachIssue') return !fieldId.startsWith('worklog.');
  return true;
}

/** Hours and the counts: numbers computed per row (no group by, conditions or extract). */
export const isMetric = (fieldId: string): boolean => fieldId === HOURS_FIELD || isCountColumn(fieldId);

/** Group levels and sheet conditions take any field but Hours and the counts. */
export const levelAllowed = (fieldId: string): boolean => !isMetric(fieldId);

/** Columns a mode switch drops (they are not available in the new mode). */
export function droppedColumns(draft: Pick<SheetDraft, 'columns'>, mode: RowMode): RefDraft[] {
  return draft.columns.filter((c) => !columnAllowed(mode, c.fieldId));
}

/** Changes the rows mode; columns the new mode cannot show are removed. */
export function setMode(draft: SheetDraft, mode: RowMode, fields: readonly FieldInfo[]): SheetDraft {
  const columns = draft.columns.filter((c) => columnAllowed(mode, c.fieldId));
  // A flat sheet needs a column; Hours is the natural first one.
  if (mode !== 'group' && columns.length === 0 && fields.some((f) => f.id === HOURS_FIELD)) columns.push({ fieldId: HOURS_FIELD, label: '', extract: '' });
  const groupBy = mode === 'group' && draft.groupBy.length === 0 ? firstLevel(fields) : draft.groupBy;
  return { ...draft, mode, columns, groupBy };
}

const LEVEL_DEFAULTS = ['worklog.author', 'issue.keySummary', 'status'];
function firstLevel(fields: readonly FieldInfo[]): RefDraft[] {
  const id = LEVEL_DEFAULTS.find((x) => fields.some((f) => f.id === x)) ?? fields.find((f) => levelAllowed(f.id))?.id;
  return id ? [{ fieldId: id, label: '', extract: '' }] : [];
}

/** First field (preferred ones first) that is not used yet and is allowed. */
export function nextFreeField(fields: readonly FieldInfo[], used: readonly string[], allowed: (id: string) => boolean, preferred: readonly string[] = []): string | undefined {
  const free = (id: string) => !used.includes(id) && allowed(id) && fields.some((f) => f.id === id);
  return preferred.find(free) ?? fields.find((f) => free(f.id))?.id;
}

// ---- Drafts ----

export function newSheet(name: string, fields: readonly FieldInfo[]): SheetDraft {
  return {
    name,
    mode: 'group',
    groupBy: firstLevel(fields),
    columns: [],
    totals: true,
    period: 'none',
    format: 'hours',
    sumSubtasksToParent: false,
    sort: 'value',
    totalColumns: 'everyLevel',
    totalLabel: '',
    subtotalRows: false,
    includeIssuesWithoutWorklogs: false,
    mergeGroupCells: false,
    headerStyle: 'standard',
    title: '',
    subtitle: '',
    notes: '',
    conditions: [],
    jql: '',
  };
}

export function newTemplate(fields: readonly FieldInfo[]): TemplateDraft {
  return { name: '', defaults: { projects: [], authors: [] }, sheets: [newSheet('Report', fields)] };
}

/** "Report" → "Report (2)", "Report (3)", ...: a sheet name not used yet (case-insensitive), at most 31 chars. */
export function uniqueSheetName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const stem = base.replace(/ \(\d+\)$/, '').trim() || 'Sheet';
  if (!used.has(stem.toLowerCase())) return stem.slice(0, MAX_SHEET_NAME);
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const name = `${stem.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** A copy of sheet `i` right after it, with a free name. */
export function duplicateSheet(sheets: readonly SheetDraft[], i: number): SheetDraft[] {
  const src = sheets[i];
  if (!src || sheets.length >= MAX_SHEETS) return [...sheets];
  const copy: SheetDraft = structuredClone(src);
  copy.name = uniqueSheetName(src.name, sheets.map((s) => s.name));
  return [...sheets.slice(0, i + 1), copy, ...sheets.slice(i + 1)];
}

const refDraft = (r: FieldRef): RefDraft => ({ fieldId: r.fieldId, label: r.label ?? '', extract: r.extract ?? '' });

/** A condition as the editor's filter row: user fields → accountIds, lists → "a, b", text as is. */
export function conditionToDraft(c: Condition, fields: readonly FieldInfo[]): ConditionDraft {
  const values = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
  const user = isUserField(fields.find((f) => f.id === c.fieldId));
  return { fieldId: c.fieldId, op: c.op, text: user ? '' : values.join(', '), users: user ? [...values] : [] };
}

/** A sheet as the server returns it (parsed TemplateBody) → editor draft. */
export function sheetToDraft(s: Sheet, fields: readonly FieldInfo[]): SheetDraft {
  return {
    name: s.name,
    mode: s.rows.mode,
    groupBy: s.rows.mode === 'group' ? s.rows.groupBy.map(refDraft) : [],
    columns: s.columns.map(refDraft),
    totals: s.totals,
    period: s.period,
    format: s.format,
    sumSubtasksToParent: s.sumSubtasksToParent,
    sort: s.sort,
    totalColumns: s.totalColumns,
    totalLabel: s.totalLabel === DEFAULT_TOTAL_LABEL ? '' : s.totalLabel,
    subtotalRows: s.subtotalRows,
    includeIssuesWithoutWorklogs: s.includeIssuesWithoutWorklogs,
    mergeGroupCells: s.mergeGroupCells ?? false,
    headerStyle: s.headerStyle ?? 'standard',
    title: s.title ?? '',
    subtitle: s.subtitle ?? '',
    notes: (s.notes ?? []).join('\n'),
    conditions: s.filter.conditions.map((c) => conditionToDraft(c, fields)),
    jql: s.filter.jql ?? '',
  };
}

export function templateToDraft(t: TemplateBody, fields: readonly FieldInfo[]): TemplateDraft {
  return {
    name: t.name,
    defaults: { projects: [...t.defaults.projects], authors: [...t.defaults.authors] },
    sheets: t.sheets.map((s) => sheetToDraft(s, fields)),
  };
}

/**
 * Identity of a draft for the unsaved-changes dot: defaults and sheets (the name is the saved template's, changed by
 * Rename / Save as only). Key order is fixed by the draft builders.
 */
export const draftKey = (d: TemplateDraft): string => JSON.stringify({ defaults: d.defaults, sheets: d.sheets });

// ---- Validation + request body ----

/** Excel's sheet-name rules (same as SheetNameSchema); the message or undefined. */
export function sheetNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'a sheet name is required';
  if (n.length > MAX_SHEET_NAME) return `sheet names can have at most ${MAX_SHEET_NAME} characters`;
  if (/[:\\/?*[\]]/.test(n)) return 'sheet names cannot contain : \\ / ? * [ ]';
  if (n.startsWith("'") || n.endsWith("'")) return 'sheet names cannot start or end with an apostrophe';
  return undefined;
}

const toRef = (r: RefDraft): FieldRef => {
  const label = r.label.trim().slice(0, MAX_LABEL);
  const extract = isMetric(r.fieldId) ? '' : (r.extract ?? '').trim();
  return { fieldId: r.fieldId, ...(label ? { label } : {}), ...(extract ? { extract } : {}) };
};

/** The extract pattern's problem (blank = none), or undefined. */
export function refExtractProblem(r: Pick<RefDraft, 'fieldId' | 'extract'>): string | undefined {
  const x = (r.extract ?? '').trim(); // drafts from before extract existed have none
  return x && !isMetric(r.fieldId) ? extractProblem(x) : undefined;
}

/** Note lines as the server takes them: trimmed, blank lines dropped. */
export const noteLines = (notes: string): string[] =>
  notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Sheet draft → the sheet as the server takes it, or the first problem (prefixed with the sheet name). Options that
 * do not apply to the mode are sent as their defaults, so a hidden option never fails validation.
 */
export function draftToSheet(d: SheetDraft, fields: readonly FieldInfo[]): { sheet: Record<string, unknown>; error?: undefined } | { sheet?: undefined; error: string } {
  const name = d.name.trim();
  const fail = (msg: string) => ({ error: `Sheet "${name || '(no name)'}": ${msg}.` });
  const nameProblem = sheetNameProblem(d.name);
  if (nameProblem) return fail(nameProblem);
  const columns = d.columns.filter((c) => c.fieldId);
  const badColumn = columns.find((c) => !columnAllowed(d.mode, c.fieldId));
  if (badColumn) return fail(`column "${fieldLabel(fields, badColumn.fieldId)}" is not available in this row mode`);
  if (new Set(columns.map((c) => c.fieldId)).size !== columns.length) return fail('a column is used twice');

  const levels = d.mode === 'group' ? d.groupBy.filter((l) => l.fieldId) : [];
  for (const r of [...levels, ...columns]) {
    const problem = refExtractProblem(r);
    if (problem) return fail(`"${r.label.trim() || fieldLabel(fields, r.fieldId)}": ${problem}`);
  }
  const title = d.title.trim();
  const subtitle = d.subtitle.trim();
  if (d.headerStyle === 'title' && !title) return fail('enter a title (header style "Title + subtitle")');
  if (title.length > MAX_TITLE || subtitle.length > MAX_TITLE) return fail(`the title and subtitle can have at most ${MAX_TITLE} characters`);
  const notes = noteLines(d.notes);
  if (notes.length > MAX_NOTES) return fail(`at most ${MAX_NOTES} note lines`);
  if (notes.some((n) => n.length > MAX_NOTE)) return fail(`a note line can have at most ${MAX_NOTE} characters`);

  const { conditions, error } = buildConditions(d.conditions, fields);
  if (error) return fail(error.replace(/\.$/, ''));
  const jql = d.jql.trim();
  const base = {
    name,
    columns: columns.map(toRef),
    format: d.format,
    sumSubtasksToParent: d.sumSubtasksToParent,
    filter: { conditions, ...(jql ? { jql } : {}) },
    headerStyle: d.headerStyle,
    // Title / subtitle only with the title style (kept in the draft while another style is chosen).
    ...(d.headerStyle === 'title' ? { title, ...(subtitle ? { subtitle } : {}) } : {}),
    notes,
  };

  if (d.mode === 'group') {
    if (!levels.length) return fail('choose at least one Group by field');
    if (new Set(levels.map((l) => l.fieldId)).size !== levels.length) return fail('each Group by field can be used only once');
    const last = d.totalColumns === 'lastLevel';
    return {
      sheet: {
        ...base,
        rows: { mode: 'group', groupBy: levels.map(toRef) },
        totals: d.totals,
        period: d.period,
        sort: d.sort,
        totalColumns: d.totalColumns,
        ...(d.totalLabel.trim() ? { totalLabel: d.totalLabel.trim().slice(0, MAX_LABEL) } : {}),
        // Subtotal rows need the single total column and totals on (the editor disables the box otherwise).
        subtotalRows: last && d.totals && d.subtotalRows,
        mergeGroupCells: d.mergeGroupCells,
      },
    };
  }
  if (!columns.length) return fail('choose at least one column');
  return {
    sheet: {
      ...base,
      rows: { mode: d.mode },
      totals: d.totals,
      ...(d.mode === 'eachIssue' ? { includeIssuesWithoutWorklogs: d.includeIssuesWithoutWorklogs } : {}),
    },
  };
}

const fieldLabel = (fields: readonly FieldInfo[], id: string) => fields.find((f) => f.id === id)?.name ?? id;

/** Template draft → TemplateBody (as JSON for the server), or the first problem. `name` overrides the draft's name. */
export function draftToBody(
  d: TemplateDraft,
  fields: readonly FieldInfo[],
  name = d.name,
): { body: { name: string; defaults: TemplateDraft['defaults']; sheets: Record<string, unknown>[] }; error?: undefined } | { body?: undefined; error: string } {
  if (!d.sheets.length) return { error: 'A template needs at least one sheet.' };
  if (d.sheets.length > MAX_SHEETS) return { error: `A template can have at most ${MAX_SHEETS} sheets.` };
  const seen = new Set<string>();
  const sheets: Record<string, unknown>[] = [];
  for (const s of d.sheets) {
    const key = s.name.trim().toLowerCase();
    if (key && seen.has(key)) return { error: `Sheet name "${s.name.trim()}" is used twice. Sheet names must be unique (ignoring case).` };
    seen.add(key);
    const r = draftToSheet(s, fields);
    if (r.error !== undefined) return { error: r.error };
    sheets.push(r.sheet);
  }
  return {
    body: {
      name: name.trim() || 'Untitled',
      defaults: { projects: [...d.defaults.projects], authors: [...d.defaults.authors] },
      sheets,
    },
  };
}

/** Template name problem for Save as / Rename, or undefined. */
export function templateNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Please enter a template name.';
  if (n.length > MAX_TEMPLATE_NAME) return `Template names can have at most ${MAX_TEMPLATE_NAME} characters.`;
  return undefined;
}

// ---- Global filter ----

export interface GlobalFilterState {
  site?: string;
  from: string;
  to: string;
  projects: string[];
  authors: string[];
}

/** Checks the global filter like the server would; the problem, or undefined. */
export function globalFilterProblem(f: GlobalFilterState, maxRangeDays: number): string | undefined {
  if (!f.from || !f.to) return 'Please choose both From and To dates.';
  if (f.from > f.to) return 'Invalid range: From must be on or before To.';
  const days = rangeDays(f.from, f.to);
  if (days > maxRangeDays) return `Invalid range: ${days} days selected; the maximum is ${maxRangeDays}. Choose a shorter range.`;
  return undefined;
}

/** POST /api/custom-report body. */
export function buildGenerateBody(
  f: GlobalFilterState,
  d: TemplateDraft,
  fields: readonly FieldInfo[],
  maxRangeDays: number,
): { body: { filter: Record<string, unknown>; template: Record<string, unknown> }; error?: undefined } | { body?: undefined; error: string } {
  const problem = globalFilterProblem(f, maxRangeDays);
  if (problem) return { error: problem };
  const t = draftToBody(d, fields);
  if (t.error !== undefined) return { error: t.error };
  const issuesWithoutTime = d.sheets.find((s) => s.mode === 'eachIssue' && s.includeIssuesWithoutWorklogs);
  if (issuesWithoutTime && !f.projects.length) {
    return { error: `Sheet "${issuesWithoutTime.name.trim()}" also lists issues without time, which needs at least one project. Pick one or more projects in the filter.` };
  }
  return {
    body: {
      filter: { ...(f.site ? { site: f.site } : {}), from: f.from, to: f.to, projects: [...f.projects], authors: [...f.authors] },
      template: t.body,
    },
  };
}

// ---- Template list ----

/** The template to open: the site's default, else the first built-in, else the first saved one. */
export function initialTemplateId(list: readonly { id: string; isDefault: boolean; builtIn: boolean }[]): string | undefined {
  // Advance Report has no built-in starters: the saved default, else a new blank template.
  return list.find((t) => t.isDefault && !t.builtIn)?.id;
}

/** "filename*=UTF-8''…" (preferred), else filename="…", else the fallback. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      // Fall through to the ASCII name.
    }
  }
  return /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? fallback;
}
