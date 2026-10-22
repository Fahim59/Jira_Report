// Template report workbook layout (Phase 8b Step C): one worksheet per template sheet, built from the displayed result.
// Pure: no Node/Fastify/exceljs imports; src/services/customExcel.ts turns the sheet layouts into a workbook.
import { DateTime } from 'luxon';
import type { FieldInfo } from './fields.js';
import type { Condition, Operator } from './filter.js';
import { toUnit, type TimeFormat } from './layout.js';
import type { TemplateReport } from './result.js';
import type { SheetResult } from './sheets.js';
import { sheetTable } from './table.js';
import { fillPlaceholders, placeholderValues, projectsText, usersText, type PlaceholderValues } from './text.js';

export { periodLabel } from './table.js';

/** Header style 'standard': rows 1–6 header block, row 7 blank (or the incomplete warning), row 8 the table header. */
export const TABLE_HEADER_ROW = 8;
/** Header style 'title': row 1 title, row 2 subtitle, row 3 blank (or the warning), row 4 the table header. */
export const TITLE_TABLE_HEADER_ROW = 4;
export const NOTES_HEADING = 'Notes';
export const MAX_COLUMN_WIDTH = 60;
const MIN_COLUMN_WIDTH = 8;
/** Header values span at least to column I, like the team's sample. */
const MIN_HEADER_COLUMNS = 9;
/** Same date-time format as the team's sample export. */
export const DATETIME_FMT = 'm/d/yyyy h:mm:ss AM/PM';

const OP_TEXT: Readonly<Record<Operator, string>> = {
  is: 'is',
  isNot: 'is not',
  in: 'is one of',
  notIn: 'is not one of',
  contains: 'contains',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

export type CellValue = string | number | Date;

/** One sheet, cell by cell. Rows/columns are 1-based in `merges`, `boldCells`, `boldRows`, `dateColumns`. */
export interface SheetLayout {
  name: string;
  /** rows[0] is sheet row 1. "" = empty cell. */
  rows: CellValue[][];
  /** [firstRow, firstCol, lastRow, lastCol]. */
  merges: Array<[number, number, number, number]>;
  boldRows: number[];
  boldCells: Array<[number, number]>;
  /** Red bold warning row (incomplete report), if any. */
  warningRow?: number;
  /** Header style 'title': the large bold title row and the small subtitle row. */
  titleRow?: number;
  subtitleRow?: number;
  /** mergeGroupCells: vertical merges [firstRow, col, lastRow, col], top-aligned. */
  groupMerges: Array<[number, number, number, number]>;
  /** Frozen rows at the top. */
  freezeRows: number;
  widths: number[];
  /** Columns whose data cells (below freezeRows) are dates. */
  dateColumns: number[];
}

/** Display names the browser knows but the report does not carry (project names, user names for accountIds). */
export interface ExportLabels {
  projects?: Record<string, string>;
  users?: Record<string, string>;
}

/** The parts of a TemplateReport the workbook needs (what POST /api/custom-report/export validates). */
export type WorkbookReport = Pick<
  TemplateReport,
  'from' | 'to' | 'filter' | 'template' | 'fields' | 'sheets' | 'timeZone' | 'hoursPerDay' | 'retrievedAt' | 'complete' | 'failedIssueKeys' | 'failureReasons'
> & { site?: string; worklogs: ReadonlyArray<{ accountId: string; user: string }> };

export interface WorkbookOptions {
  /** Jira site URL of the report ({site} in titles = its host). */
  siteUrl?: string;
}

/** Amount in the sheet's unit, rounded to 2 decimals like the on-screen "7.5h" (totals are summed in seconds first). */
export function exportAmount(seconds: number, format: TimeFormat, hoursPerDay: number): number {
  return Math.round(toUnit(seconds, format, hoursPerDay) * 100) / 100;
}

const nameOf = (fields: readonly FieldInfo[], id: string): string => fields.find((f) => f.id === id)?.name ?? id;

/** "Status is Done", "Assignee is one of (Ann, Bob)", "Labels is empty". User values use display names when known. */
export function describeCondition(c: Condition, fields: readonly FieldInfo[], labels: ExportLabels = {}): string {
  const field = fields.find((f) => f.id === c.fieldId);
  const isUser = field?.schemaType === 'user' || field?.schemaType === 'array<user>';
  const show = (v: string) => (isUser ? labels.users?.[v] ?? v : v);
  const name = nameOf(fields, c.fieldId);
  if (c.value === undefined) return `${name} ${OP_TEXT[c.op]}`;
  if (Array.isArray(c.value)) return `${name} ${OP_TEXT[c.op]} (${c.value.map(show).join(', ')})`;
  return `${name} ${OP_TEXT[c.op]} ${c.op === 'contains' ? `"${c.value}"` : show(c.value)}`;
}

/** Global users, then this sheet's conditions and JQL, as one line; "None" without any. */
export function describeSheetFilters(report: WorkbookReport, sheet: SheetResult, labels: ExportLabels = {}): string {
  const parts: string[] = [];
  if (report.filter.authors.length) parts.push(`Users: ${usersText(report.filter.authors, labels.users, knownUsers(report))}`);
  parts.push(...sheet.sheet.filter.conditions.map((c) => describeCondition(c, report.fields, labels)));
  if (sheet.sheet.filter.jql) parts.push(`JQL: ${sheet.sheet.filter.jql}`);
  if (sheet.sheet.includeIssuesWithoutWorklogs) parts.push('Issues without time included');
  return parts.length ? parts.join('; ') : 'None';
}

const knownUsers = (report: Pick<WorkbookReport, 'worklogs'>) => new Map(report.worklogs.map((w) => [w.accountId, w.user]));

export function describeProjects(report: Pick<WorkbookReport, 'filter'>, labels: ExportLabels = {}): string {
  return projectsText(report.filter.projects, labels.projects);
}

/** Values of {projects} {from} {to} {tz} {site} {generated} {users} for this report. */
export function reportPlaceholders(report: WorkbookReport, labels: ExportLabels = {}, opts: WorkbookOptions = {}): PlaceholderValues {
  return placeholderValues({
    projects: report.filter.projects,
    authors: report.filter.authors,
    from: report.from,
    to: report.to,
    timeZone: report.timeZone,
    retrievedAt: report.retrievedAt,
    siteUrl: opts.siteUrl,
    site: report.site,
    labels,
    knownUsers: knownUsers(report),
  });
}

export function describeFormat(format: TimeFormat, hoursPerDay: number): string {
  return format === 'days' ? `Days (${hoursPerDay}h per day)` : 'Hours';
}

function textWidth(v: CellValue): number {
  if (v instanceof Date) return 22;
  const s = String(v);
  return Math.max(0, ...s.split('\n').map((line) => line.length));
}

/** Widest cell (+2) per column over `rows`, clamped to [8, 60]. */
export function autoWidths(rows: readonly CellValue[][], count: number): number[] {
  return Array.from({ length: count }, (_, c) =>
    Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, ...rows.map((r) => textWidth(r[c] ?? '') + 2))),
  );
}

function incompleteText(report: WorkbookReport): string {
  const why = report.failureReasons?.length ? ` (${report.failureReasons.join('; ')})` : '';
  return `⚠ Incomplete report — worklogs could not be loaded for: ${report.failedIssueKeys.join(', ')}${why}`;
}

/** retrievedAt in the report's time zone, ISO with offset ("2026-09-29T18:40:06+06:00"). */
function generatedOn(report: WorkbookReport): string {
  const dt = DateTime.fromISO(report.retrievedAt, { setZone: true });
  return dt.isValid ? dt.setZone(report.timeZone).toISO({ suppressMilliseconds: true })! : report.retrievedAt;
}

/**
 * A Jira timestamp as an Excel date showing the wall-clock time in `zone` (Excel has no time zones; exceljs writes
 * dates via UTC, so the zone's local time is encoded as UTC). Unparseable → the raw text.
 */
export function excelDateTime(iso: string, zone: string): CellValue {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return iso;
  const l = dt.setZone(zone);
  return new Date(Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second, l.millisecond));
}

/**
 * One worksheet. Above the table, per the sheet's headerStyle:
 * - standard: header block (rows 1–6: From/To, Projects, Filters, Time Zone, Generated on, Report Time Format),
 *   row 7 blank or the red incomplete warning, the table from row 8;
 * - title: row 1 the bold title, row 2 the subtitle (placeholders filled), row 3 blank or the warning, table from row 4;
 * - none: the table from row 1 (incomplete: the warning in row 1, the table from row 3).
 * The table layout per mode is in table.ts. Notes (if any) follow the last table row after a blank row, under a bold
 * "Notes" heading. Amounts in the sheet's format; timestamps as REPORT_TZ dates. Bold header / subtotal / Total rows,
 * frozen at the table header row.
 */
export function templateSheet(report: WorkbookReport, result: SheetResult, labels: ExportLabels = {}, opts: WorkbookOptions = {}): SheetLayout {
  const { sheet } = result;
  const table = sheetTable(result);
  const width = table.header.length;
  const style = sheet.headerStyle ?? 'standard';
  const last = style === 'standard' ? Math.max(width, MIN_HEADER_COLUMNS) : Math.max(width, 1);
  const pad = (cells: CellValue[]) => [...cells, ...Array<CellValue>(Math.max(0, last - cells.length)).fill('')];
  const warning: CellValue[] = report.complete ? [] : [incompleteText(report)];

  const rows: CellValue[][] = [];
  const merges: SheetLayout['merges'] = [];
  const boldCells: SheetLayout['boldCells'] = [];
  const extra: Pick<SheetLayout, 'titleRow' | 'subtitleRow'> = {};
  let warningRow: number | undefined;
  if (style === 'standard') {
    rows.push(
      pad(['From', '', report.from, '', 'To', '', report.to]),
      pad(['Projects', '', describeProjects(report, labels)]),
      pad(['Filters', '', describeSheetFilters(report, result, labels)]),
      pad(['Time Zone', '', report.timeZone]),
      pad(['Generated on', '', generatedOn(report)]),
      pad(['Report Time Format', '', describeFormat(sheet.format, report.hoursPerDay)]),
      warning,
    );
    merges.push(
      [1, 1, 1, 2], [1, 3, 1, 4], [1, 5, 1, 6], [1, 7, 1, last],
      ...[2, 3, 4, 5].flatMap((r): SheetLayout['merges'] => [[r, 1, r, 2], [r, 3, r, last]]),
      [6, 1, 6, 2], [6, 3, 6, 4],
    );
    boldCells.push([1, 1], [1, 5], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]);
    warningRow = 7;
  } else if (style === 'title') {
    const values = reportPlaceholders(report, labels, opts);
    rows.push([fillPlaceholders(sheet.title ?? '', values)], sheet.subtitle ? [fillPlaceholders(sheet.subtitle, values)] : [], warning);
    extra.titleRow = 1;
    extra.subtitleRow = 2;
    warningRow = 3;
  } else if (!report.complete) {
    rows.push(warning, []);
    warningRow = 1;
  }
  if (report.complete) warningRow = undefined;
  else if (last > 1) merges.push([warningRow!, 1, warningRow!, last]);
  const headerRow = rows.length + 1;

  const amounts = new Set(table.amountColumns);
  const dates = new Set(table.dateColumns);
  const cell = (v: string | number, col: number): CellValue => {
    if (amounts.has(col) && typeof v === 'number') return exportAmount(v, sheet.format, report.hoursPerDay);
    if (dates.has(col) && typeof v === 'string') return excelDateTime(v, report.timeZone);
    return v;
  };
  const body: CellValue[][] = [table.header, ...table.rows.map((r) => r.cells.map(cell))];
  const boldRows = [headerRow];
  table.rows.forEach((r, i) => {
    if (r.kind !== 'data') boldRows.push(headerRow + 1 + i);
  });
  rows.push(...body);

  const notes = sheet.notes ?? [];
  if (notes.length) {
    rows.push([], [NOTES_HEADING], ...notes.map((n) => [n]));
    boldCells.push([headerRow + body.length + 1, 1]);
  }

  return {
    name: result.name,
    rows,
    merges,
    groupMerges: table.merges.map(([r1, c1, r2, c2]): [number, number, number, number] => [headerRow + 1 + r1, c1 + 1, headerRow + 1 + r2, c2 + 1]),
    boldRows,
    boldCells,
    ...(warningRow ? { warningRow } : {}),
    ...extra,
    freezeRows: headerRow,
    widths: autoWidths(body, last),
    dateColumns: table.dateColumns.map((c) => c + 1),
  };
}

/** Every sheet of the report, in template order. */
export function workbookLayout(report: WorkbookReport, labels: ExportLabels = {}, opts: WorkbookOptions = {}): SheetLayout[] {
  return report.sheets.map((s) => templateSheet(report, s, labels, opts));
}

// ---- filename ----

/** Characters Windows / macOS do not allow in file names (and control characters), replaced by "-". */
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** The template name made safe for a file name (spaces and Unicode kept), at most 100 chars; "Report" if empty. */
export function filenameSafe(name: string): string {
  const s = name.replace(UNSAFE_FILENAME, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.]+$/g, '').slice(0, 100).trim();
  return s || 'Report';
}

/** <Template name>_<from>_<to>[_INCOMPLETE].xlsx */
export function templateFilename(report: Pick<WorkbookReport, 'template' | 'from' | 'to' | 'complete'>): string {
  return `${filenameSafe(report.template.name)}_${report.from}_${report.to}${report.complete ? '' : '_INCOMPLETE'}.xlsx`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987), for non-ASCII template names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
