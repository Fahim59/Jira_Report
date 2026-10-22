// Sheet engine (Phase 8b): runs every sheet of a template on the one fetched data set.
// Per-sheet filters only narrow: a sheet sees a subset of the globally fetched worklogs, never more.
// Pure: no Node/Fastify imports.
import { DateTime } from 'luxon';
import {
  attributionKey,
  buildTree,
  compareIssueKeysDesc,
  isWorklogField,
  summaryOf,
  type CustomWorklog,
  type Tree,
  type ValueResolver,
} from './engine.js';
import { isCountField, matchesCondition, type Condition } from './filter.js';
import { HOURS_FIELD } from './table.js';
import { applyExtract, compileExtract } from './text.js';
import { refHeader, refIds, type RowMode, type Sheet, type TemplateBody } from './template.js';

export { HOURS_FIELD };

/** Display text, or seconds for metric.hours. worklog.started/created are raw Jira timestamps in flat sheets. */
export type Cell = string | number;

export interface FlatRow {
  /** Worklog id (each-worklog) or issue key (each-issue). */
  key: string;
  /** Parallel to the sheet's columns. */
  cells: Cell[];
  seconds: number;
  /** Worklogs behind the row, for drill-down. */
  worklogIds: string[];
}

interface SheetResultBase {
  name: string;
  mode: RowMode;
  /** The sheet as run (format, filters, ... for the preview and the Excel writer). */
  sheet: Sheet;
  /** Seconds of every worklog in the sheet. */
  total: number;
  /** Whether subtotal / Total rows are shown: group sheets with totals on; flat sheets with totals on and an Hours column. */
  showTotals: boolean;
  /**
   * Header per group level / column: its label, else the field name (group totals are "Total <header>").
   * `total` = the sheet's totalLabel (group sheets: the single / trailing total column).
   */
  headers: { groupBy: string[]; columns: string[]; total: string };
  worklogIds: string[];
}

export interface GroupSheetResult extends SheetResultBase {
  mode: 'group';
  tree: Tree;
}

export interface FlatSheetResult extends SheetResultBase {
  mode: 'eachWorklog' | 'eachIssue';
  /** Field ids, parallel to each row's cells and to headers.columns. */
  columns: string[];
  rows: FlatRow[];
}

export type SheetResult = GroupSheetResult | FlatSheetResult;

export interface TemplateData {
  from: string;
  to: string;
  /** REPORT_TZ (the "Worklog Time Zone" column). */
  timeZone: string;
  /** Every worklog the global filter fetched (`attributedTo` is recomputed per sheet). */
  worklogs: readonly CustomWorklog[];
  resolver: ValueResolver;
  /** Field id → name (from /api/fields), for headers of refs without a label. Missing = the field id. */
  fieldNames?: ReadonlyMap<string, string>;
  /** Sheet JQL → keys of the issues `(global JQL) AND (sheet JQL)` matched. Needed for every sheet with JQL. */
  jqlKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Sheet name → issue keys from the extra issue search of an each-issue sheet with includeIssuesWithoutWorklogs
   * (global projects + sheet JQL, no date/author restriction). Those issues must be in `resolver.issues`.
   */
  issuesWithoutWorklogs?: ReadonlyMap<string, readonly string[]>;
  /** Sheet name → issue keys from the extra JQL search of a group sheet (shown as rows with 0 hours). */
  extraIssues?: ReadonlyMap<string, readonly string[]>;
}

function jqlKeysFor(sheet: Sheet, data: Pick<TemplateData, 'jqlKeys'>): ReadonlySet<string> | undefined {
  const jql = sheet.filter.jql;
  if (!jql) return undefined;
  const keys = data.jqlKeys?.get(jql);
  if (!keys) throw new Error(`No JQL search result for sheet "${sheet.name}"`);
  return keys;
}

const passes = (c: Condition, values: string[]) => matchesCondition(c, values);

/**
 * Whether a sheet can use any worklog of `issueKey`: its JQL matched the issue and every issue-level condition holds
 * (on the issue the time was logged on, not the rollup parent). Used before fetching worklogs, to skip issues no sheet wants.
 */
export function sheetAcceptsIssue(sheet: Sheet, issueKey: string, data: Pick<TemplateData, 'jqlKeys' | 'resolver'>): boolean {
  const keys = jqlKeysFor(sheet, data);
  if (keys && !keys.has(issueKey)) return false;
  return issueConditionsPass(sheet, issueKey, data.resolver);
}

/** The sheet's issue-level conditions on `issueKey` (worklog-level ones only narrow time, never an issue). */
function issueConditionsPass(sheet: Sheet, issueKey: string, resolver: ValueResolver): boolean {
  return sheet.filter.conditions.every((c) => isWorklogField(c.fieldId) || passes(c, resolver.issueMatchValues(c.fieldId, issueKey)));
}

/** The sheet's worklogs: the global set narrowed by its JQL and conditions, attributed per its rollup setting. */
export function sheetWorklogs(sheet: Sheet, data: TemplateData): CustomWorklog[] {
  const { resolver } = data;
  const accepted = new Map<string, boolean>();
  const out: CustomWorklog[] = [];
  for (const wl of data.worklogs) {
    let ok = accepted.get(wl.issueKey);
    if (ok === undefined) accepted.set(wl.issueKey, (ok = sheetAcceptsIssue(sheet, wl.issueKey, data)));
    if (!ok) continue;
    if (!sheet.filter.conditions.every((c) => !isWorklogField(c.fieldId) || passes(c, resolver.matchValues(c.fieldId, wl)))) continue;
    const issue = resolver.issues.get(wl.issueKey);
    const attributedTo = issue ? attributionKey(issue, sheet.sumSubtasksToParent) : wl.issueKey;
    out.push(attributedTo === wl.attributedTo ? wl : { ...wl, attributedTo });
  }
  return out;
}

const startedMillis = (iso: string): number => {
  const dt = DateTime.fromISO(iso, { setZone: true });
  return dt.isValid ? dt.toMillis() : Number.NaN;
};

/** Each-worklog order: author name, then start time (then issue key, worklog id for a stable order). */
export function compareWorklogsByAuthor(a: CustomWorklog, b: CustomWorklog): number {
  const ta = startedMillis(a.started);
  const tb = startedMillis(b.started);
  return (
    a.user.localeCompare(b.user) ||
    a.accountId.localeCompare(b.accountId) ||
    (Number.isNaN(ta) || Number.isNaN(tb) ? a.started.localeCompare(b.started) : ta - tb) ||
    a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }) ||
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
}

function worklogCell(fieldId: string, wl: CustomWorklog, data: TemplateData): Cell {
  switch (fieldId) {
    case HOURS_FIELD:
      return wl.seconds;
    case 'worklog.timeZone':
      return wl.zone ?? data.timeZone;
    case 'worklog.started':
      return wl.started;
    case 'worklog.created':
      return wl.created; // the full timestamp here (group sheets group by its date)
  }
  return data.resolver.value(fieldId, wl).label;
}

/** A text cell after its column's extract pattern (numbers are left alone). */
const extractCell = (cell: Cell, re: RegExp | undefined): Cell => (typeof cell === 'string' ? applyExtract(re, cell) : cell);

function eachWorklogRows(sheet: Sheet, worklogs: CustomWorklog[], data: TemplateData): FlatRow[] {
  const res = sheet.columns.map((c) => compileExtract(c.extract));
  return [...worklogs].sort(compareWorklogsByAuthor).map((wl) => ({
    key: wl.id,
    cells: sheet.columns.map((c, i) => extractCell(worklogCell(c.fieldId, wl, data), res[i])),
    seconds: wl.seconds,
    worklogIds: [wl.id],
  }));
}

/**
 * One row per issue with time in the sheet (the rollup parent when rolling up), newest key first. With
 * includeIssuesWithoutWorklogs, the extra search's issues that pass the sheet's issue-level conditions are added
 * with 0 hours (rolled up like time would be).
 */
function eachIssueRows(sheet: Sheet, worklogs: CustomWorklog[], data: TemplateData): FlatRow[] {
  const byIssue = new Map<string, { seconds: number; worklogIds: string[] }>();
  for (const wl of worklogs) {
    let row = byIssue.get(wl.attributedTo);
    if (!row) byIssue.set(wl.attributedTo, (row = { seconds: 0, worklogIds: [] }));
    row.seconds += wl.seconds;
    row.worklogIds.push(wl.id);
  }
  if (sheet.includeIssuesWithoutWorklogs) {
    for (const key of data.issuesWithoutWorklogs?.get(sheet.name) ?? []) {
      const issue = data.resolver.issues.get(key);
      if (!issue || !issueConditionsPass(sheet, key, data.resolver)) continue;
      const target = attributionKey(issue, sheet.sumSubtasksToParent);
      if (!byIssue.has(target)) byIssue.set(target, { seconds: 0, worklogIds: [] });
    }
  }
  const res = sheet.columns.map((c) => compileExtract(c.extract));
  return [...byIssue.keys()].sort(compareIssueKeysDesc).map((key) => {
    const { seconds, worklogIds } = byIssue.get(key)!;
    return {
      key,
      cells: refIds(sheet.columns).map((c, i) => (c === HOURS_FIELD ? seconds : applyExtract(res[i], data.resolver.issueValue(c, key).label))),
      seconds,
      worklogIds,
    };
  });
}

/**
 * A group sheet's extra-JQL issues as 0-second worklogs (so they get rows, with blank hours): those that pass the
 * sheet's issue-level conditions (rolled up like time would be). They are not worklogs of the report: no drill-down.
 */
function extraIssueWorklogs(sheet: Sheet, data: TemplateData): CustomWorklog[] {
  const out: CustomWorklog[] = [];
  for (const key of data.extraIssues?.get(sheet.name) ?? []) {
    const issue = data.resolver.issues.get(key);
    if (!issue || !issueConditionsPass(sheet, key, data.resolver)) continue;
    const target = attributionKey(issue, sheet.sumSubtasksToParent);
    out.push({
      id: `extra:${key}`,
      date: data.from,
      accountId: '',
      user: '',
      issueKey: key,
      summary: summaryOf(issue),
      project: '',
      seconds: 0,
      started: '',
      created: '',
      createdDate: '',
      comment: '',
      attributedTo: target,
      zone: data.timeZone,
    });
  }
  return out;
}

/** Runs one sheet on the fetched data. */
export function runSheet(sheet: Sheet, data: TemplateData): SheetResult {
  const worklogs = sheetWorklogs(sheet, data);
  const base = {
    name: sheet.name,
    sheet,
    total: worklogs.reduce((sum, w) => sum + w.seconds, 0),
    headers: {
      groupBy: sheet.rows.mode === 'group' ? sheet.rows.groupBy.map((r) => refHeader(r, data.fieldNames)) : [],
      columns: sheet.columns.map((r) => refHeader(r, data.fieldNames)),
      total: sheet.totalLabel,
    },
    worklogIds: worklogs.map((w) => w.id),
  };
  if (sheet.rows.mode === 'group') {
    // Count columns come from the nodes' issueCount / worklogCount, not from field values.
    const valueColumns = sheet.columns.filter((c) => !isCountField(c.fieldId));
    const tree = buildTree({
      worklogs: sheet.extraJql ? [...worklogs, ...extraIssueWorklogs(sheet, data)] : worklogs,
      layout: { groupBy: refIds(sheet.rows.groupBy), columns: refIds(valueColumns), period: sheet.period, sort: sheet.sort },
      resolver: data.resolver,
      from: data.from,
      to: data.to,
      extract: {
        groupBy: sheet.rows.groupBy.map((r) => compileExtract(r.extract)),
        columns: valueColumns.map((r) => compileExtract(r.extract)),
      },
    });
    return { ...base, mode: 'group', showTotals: sheet.totals, tree };
  }
  const rows = sheet.rows.mode === 'eachWorklog' ? eachWorklogRows(sheet, worklogs, data) : eachIssueRows(sheet, worklogs, data);
  return {
    ...base,
    mode: sheet.rows.mode,
    showTotals: sheet.totals && refIds(sheet.columns).includes(HOURS_FIELD),
    columns: refIds(sheet.columns),
    rows,
  };
}

/** One SheetResult per template sheet, in order. */
export function runTemplate(data: TemplateData, template: Pick<TemplateBody, 'sheets'>): SheetResult[] {
  return template.sheets.map((s) => runSheet(s, data));
}
