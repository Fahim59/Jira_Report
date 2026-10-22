// Team Reports tab (the Jira "Team Reports" look-alike): pure rules. No DOM, no zod/luxon, so the browser bundle stays small.
// The report itself comes from POST /api/custom-report (one group sheet); this module only shapes it for the table.
import type { TreeNode } from '../../src/services/custom/engine.js';
import type { FieldInfo } from '../../src/services/custom/fields.js';
import type { GroupSheetResult } from '../../src/services/custom/sheets.js';

// ---- Options of the top bar ----

export type TeamPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const PERIOD_OPTIONS: ReadonlyArray<{ value: TeamPeriod; label: string; param: string }> = [
  { value: 'day', label: 'Day', param: 'days' },
  { value: 'week', label: 'Week', param: 'isoWeek' },
  { value: 'month', label: 'Month', param: 'months' },
  { value: 'quarter', label: 'Quarter', param: 'quarters' },
  { value: 'year', label: 'Year', param: 'years' },
];

export type TimeFormat = 'hours' | 'hm' | 'hhmm' | 'days';
export const TIME_FORMAT_OPTIONS: ReadonlyArray<{ value: TimeFormat; label: string }> = [
  { value: 'hours', label: 'Hours' },
  { value: 'hm', label: 'Hours & Minutes' },
  { value: 'hhmm', label: 'hh:mm' },
  { value: 'days', label: 'Days' },
];

export type ZoneChoice = 'user' | 'server' | 'author';
export const ZONE_OPTIONS: ReadonlyArray<{ value: ZoneChoice; label: string; hint: string }> = [
  { value: 'user', label: 'Current User', hint: "The days follow your browser's time zone (this app has no Jira login, so it cannot use your Jira profile zone)." },
  { value: 'server', label: 'Jira Server', hint: 'The days follow the report server’s time zone (REPORT_TZ).' },
  { value: 'author', label: 'Work Log Author', hint: "Each worklog's day follows its author's own Jira time zone." },
];

// ---- Group By choices ----

/** Group By list entries: Jira's "ISSUE" fields, then its two "WORKLOG" ones (worklog start date as "Work Log Started"). */
export interface GroupChoice {
  /** Field id sent as the group level. */
  fieldId: string;
  name: string;
  section: 'Issue' | 'Worklog';
  /** Header shown instead of the field's own name. */
  label?: string;
}

/** Jira's names for the two worklog fields; they also head the table. */
const WORKLOG_NAMES: Readonly<Record<string, string>> = { 'worklog.author': 'Work Log Author', 'worklog.date': 'Work Log Started' };

/** Every field of the site, in the Custom Report tab's order and naming (the same list). */
export function groupChoices(fields: readonly FieldInfo[]): GroupChoice[] {
  const all = fields.map((f): GroupChoice => {
    const worklogName = WORKLOG_NAMES[f.id];
    return worklogName
      ? { fieldId: f.id, name: worklogName, section: 'Worklog', label: worklogName }
      : { fieldId: f.id, name: f.name, section: f.id.startsWith('worklog.') ? 'Worklog' : 'Issue' };
  });
  // Fields can share a name: the id tells them apart.
  const count = new Map<string, number>();
  for (const c of all) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);
  return all.map((c) => ((count.get(c.name.toLowerCase()) ?? 0) > 1 ? { ...c, name: `${c.name} (${c.fieldId})` } : c));
}


// ---- Time formats ----

const two = (n: number) => String(n).padStart(2, '0');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "7.5h" · "7h 30m" · "7:30" · "0.94d". Zero shows as "" (Jira leaves empty cells blank). */
export function formatTime(seconds: number, format: TimeFormat, hoursPerDay: number): string {
  if (!seconds) return '';
  switch (format) {
    case 'hours':
      return `${round2(seconds / 3600)}h`;
    case 'days':
      return `${round2(seconds / 3600 / hoursPerDay)}d`;
    case 'hm':
    case 'hhmm': {
      const minutes = Math.round(seconds / 60);
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (format === 'hhmm') return `${h}:${two(m)}`;
      return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
    }
  }
}

// ---- Period columns ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export interface PeriodColumn {
  key: string;
  /** Big text ("22", "29-05", "Jul", "Q3", "2026"). */
  text: string;
  /** Small grey text under it (weekday, ISO week number, year). */
  sub?: string;
  /** Saturday / Sunday (day periods): the whole column is shaded. */
  weekend: boolean;
  /** Month banner this column sits under (day and week periods): "Jul, 2026". */
  group?: string;
}

const utcDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const isoDate = (t: Date) => `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
const monthBanner = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]}, ${date.slice(0, 4)}`;

/** Monday of an ISO week key ("2026-W27" → "2026-06-29"). */
export function isoWeekStart(key: string): string {
  const [year, week] = key.split('-W').map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000);
  return isoDate(new Date(monday.getTime() + (week - 1) * 7 * 86_400_000));
}

export function periodColumn(key: string, period: TeamPeriod): PeriodColumn {
  switch (period) {
    case 'day': {
      const dow = (utcDate(key).getUTCDay() + 6) % 7; // Mon = 0
      return { key, text: key.slice(8, 10), sub: WEEKDAYS[dow], weekend: dow >= 5, group: monthBanner(key) };
    }
    case 'week': {
      const start = isoWeekStart(key);
      const end = isoDate(new Date(utcDate(start).getTime() + 6 * 86_400_000));
      return { key, text: `${start.slice(8, 10)}-${end.slice(8, 10)}`, sub: key.slice(6), weekend: false, group: monthBanner(start) };
    }
    case 'month':
      return { key, text: MONTHS[Number(key.slice(5, 7)) - 1]!, sub: key.slice(0, 4), weekend: false };
    case 'quarter':
      return { key, text: key.slice(5), sub: key.slice(0, 4), weekend: false };
    case 'year':
      return { key, text: key, weekend: false };
  }
}

/** Consecutive columns under the same banner: [{ text: "Jul, 2026", span: 22 }]. Empty when the period has no banner. */
export function monthBanners(columns: readonly PeriodColumn[]): Array<{ text: string; span: number }> {
  const out: Array<{ text: string; span: number }> = [];
  for (const c of columns) {
    if (!c.group) return [];
    const last = out[out.length - 1];
    if (last?.text === c.group) last.span++;
    else out.push({ text: c.group, span: 1 });
  }
  return out;
}

// ---- Pivot ----

export interface PivotCell {
  kind: 'label' | 'total';
  /** Group level (0-based). */
  level: number;
  /** Rows the cell spans (a parent group's value and total are merged down its rows). */
  rowSpan: number;
  node: TreeNode;
}

export interface PivotRow {
  cells: PivotCell[];
  /** Seconds per period column. */
  amounts: number[];
  leaf: TreeNode;
}

export interface Pivot {
  /** Header of each group level ("Work Log Author", "Issue"); each is followed by its "Total <level>" column. */
  levels: string[];
  columns: PeriodColumn[];
  banners: Array<{ text: string; span: number }>;
  /** One row per leaf group. Empty without group levels (see `flat`). */
  rows: PivotRow[];
  total: number;
  /** Seconds per period column. */
  totals: number[];
  /** No Group By: the table is a single "Total" column and one row of period totals (nothing when there is no time). */
  flat: boolean;
}

const leafCount = (n: TreeNode): number => (n.children.length ? n.children.reduce((s, c) => s + leafCount(c), 0) : 1);

/** The group sheet as Jira's table: level + total columns, period columns, parent cells merged down their rows. */
export function buildPivot(result: Pick<GroupSheetResult, 'tree' | 'headers'>, period: TeamPeriod): Pivot {
  const { tree, headers } = result;
  const columns = tree.periodKeys.map((k) => periodColumn(k, period));
  const rows: PivotRow[] = [];
  const visit = (node: TreeNode, level: number, pending: PivotCell[]) => {
    const rowSpan = leafCount(node);
    const own: PivotCell[] = [
      { kind: 'label', level, rowSpan, node },
      { kind: 'total', level, rowSpan, node },
    ];
    if (node.children.length) {
      node.children.forEach((c, i) => visit(c, level + 1, i === 0 ? [...pending, ...own] : []));
      return;
    }
    rows.push({ cells: [...pending, ...own], amounts: tree.periodKeys.map((k) => node.periods[k] ?? 0), leaf: node });
  };
  tree.nodes.forEach((n) => visit(n, 0, []));
  return {
    levels: headers.groupBy,
    columns,
    banners: monthBanners(columns),
    rows,
    total: tree.total,
    totals: tree.periodKeys.map((k) => tree.periods[k] ?? 0),
    flat: headers.groupBy.length === 0,
  };
}

// ---- Excel grid ----

export type GridStyle = 'level' | 'totalHead' | 'banner' | 'period' | 'periodWeekend' | 'label' | 'total' | 'amount' | 'amountWeekend' | 'sumLabel';

/** One cell of the exported sheet, 0-based, with its merge span. */
export interface GridCell {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
  /** Text shown; with `value`, the text is only the fallback (Excel shows the number in `numFmt`). */
  text: string;
  value?: number;
  numFmt?: string;
  style: GridStyle;
}

export interface Grid {
  rows: number;
  cols: number;
  /** Rows of the table header (they are frozen). */
  headRows: number;
  /** Columns of the group levels and their totals (they are frozen). */
  levelCols: number;
  cells: GridCell[];
}

/** The pivot as positioned cells (the same table the page shows) for the Excel writer. Hours and days stay numbers. */
export function pivotGrid(pivot: Pivot, format: TimeFormat, hoursPerDay: number): Grid {
  const headRows = pivot.banners.length ? 2 : 1;
  const levelCols = pivot.flat ? 1 : pivot.levels.length * 2;
  const cells: GridCell[] = [];
  const add = (c: Omit<GridCell, 'rowSpan' | 'colSpan'> & Partial<Pick<GridCell, 'rowSpan' | 'colSpan'>>) =>
    cells.push({ rowSpan: 1, colSpan: 1, ...c });

  const amount = (seconds: number): Pick<GridCell, 'text' | 'value' | 'numFmt'> => {
    const text = formatTime(seconds, format, hoursPerDay);
    if (!seconds || (format !== 'hours' && format !== 'days')) return { text };
    const unit = format === 'hours' ? seconds / 3600 : seconds / 3600 / hoursPerDay;
    return { text, value: round2(unit), numFmt: `General"${format === 'hours' ? 'h' : 'd'}"` };
  };

  if (pivot.flat) add({ r: 0, c: 0, rowSpan: headRows, text: 'Total', style: 'totalHead' });
  pivot.levels.forEach((level, i) => {
    add({ r: 0, c: i * 2, rowSpan: headRows, text: level, style: 'level' });
    add({ r: 0, c: i * 2 + 1, rowSpan: headRows, text: `Total\n${level}`, style: 'totalHead' });
  });
  let col = levelCols;
  for (const b of pivot.banners) {
    add({ r: 0, c: col, colSpan: b.span, text: b.text, style: 'banner' });
    col += b.span;
  }
  pivot.columns.forEach((p, i) =>
    add({ r: headRows - 1, c: levelCols + i, text: p.sub ? `${p.text}\n${p.sub}` : p.text, style: p.weekend ? 'periodWeekend' : 'period' }),
  );

  pivot.rows.forEach((row, ri) => {
    const r = headRows + ri;
    for (const cell of row.cells) {
      if (cell.kind === 'label') add({ r, c: cell.level * 2, rowSpan: cell.rowSpan, text: cell.node.label, style: 'label' });
      else add({ r, c: cell.level * 2 + 1, rowSpan: cell.rowSpan, ...amount(cell.node.total), style: 'total' });
    }
    row.amounts.forEach((s, i) =>
      add({ r, c: levelCols + i, ...amount(s), style: pivot.columns[i]!.weekend ? 'amountWeekend' : 'amount' }),
    );
  });

  // The total row; without group levels it is the only row, holding the single "Total" column.
  const hasTotalRow = pivot.flat ? pivot.total > 0 : pivot.rows.length > 0;
  if (hasTotalRow) {
    const r = headRows + pivot.rows.length;
    if (pivot.flat) add({ r, c: 0, ...amount(pivot.total), style: 'total' });
    pivot.levels.forEach((_, i) => {
      add({ r, c: i * 2, text: i === 0 ? 'Total' : '', style: 'sumLabel' });
      add({ r, c: i * 2 + 1, ...amount(pivot.total), style: 'total' });
    });
    pivot.totals.forEach((s, i) =>
      add({ r, c: levelCols + i, ...amount(s), style: pivot.columns[i]!.weekend ? 'amountWeekend' : 'amount' }),
    );
  }
  return {
    rows: headRows + pivot.rows.length + (hasTotalRow ? 1 : 0),
    cols: levelCols + pivot.columns.length,
    headRows,
    levelCols,
    cells,
  };
}

// ---- Request ----

export interface TeamQuery {
  site?: string;
  from: string;
  to: string;
  projects: string[];
  authors: string[];
  groupBy: GroupChoice[];
  period: TeamPeriod;
  zone: ZoneChoice;
  /** The browser's IANA zone (sent with zone "user"). */
  browserZone: string;
  jql: string;
  extraJql: string;
  requestId?: string;
}

/** POST /api/custom-report body: one group sheet shaped like Jira's Team Reports table. */
export function buildTeamRequest(q: TeamQuery): { filter: Record<string, unknown>; template: Record<string, unknown> } {
  const jql = q.jql.trim();
  const extra = q.extraJql.trim();
  return {
    filter: {
      ...(q.site ? { site: q.site } : {}),
      from: q.from,
      to: q.to,
      projects: q.projects,
      authors: q.authors,
      zone: q.zone,
      ...(q.zone === 'user' ? { userZone: q.browserZone } : {}),
    },
    template: {
      name: 'Team Reports',
      defaults: {},
      sheets: [
        {
          name: 'Team Reports',
          // Jira shows one row per person while Group By is empty, so an empty choice means Work Log Author.
          rows: {
            mode: 'group',
            groupBy: (q.groupBy.length ? q.groupBy : [{ fieldId: 'worklog.author', label: 'Work Log Author' }]).map((g) => ({
              fieldId: g.fieldId,
              ...(g.label ? { label: g.label } : {}),
            })),
          },
          columns: [],
          totals: true,
          period: q.period,
          format: 'hours',
          sort: 'value',
          totalColumns: 'everyLevel',
          filter: { conditions: [], ...(jql ? { jql } : {}) },
          ...(extra ? { extraJql: extra } : {}),
        },
      ],
    },
  };
}

/** Local problem with the form before it is sent; undefined = fine. */
export function teamQueryProblem(q: Pick<TeamQuery, 'from' | 'to'>, maxRangeDays: number): string | undefined {
  if (!q.from || !q.to) return 'Please choose both From and To dates.';
  if (q.from > q.to) return 'Invalid range: From must be on or before To.';
  const days = Math.round((utcDate(q.to).getTime() - utcDate(q.from).getTime()) / 86_400_000) + 1;
  if (days > maxRangeDays) return `Invalid range: ${days} days selected; the maximum is ${maxRangeDays}. Choose a shorter range.`;
  return undefined;
}

// ---- Users & Groups ----

export const userValue = (accountId: string) => `user:${accountId}`;
export const groupValue = (groupId: string) => `group:${groupId}`;

/** Splits the picker's values into account ids and group ids. */
export function splitPeople(values: readonly string[]): { users: string[]; groups: string[] } {
  const users: string[] = [];
  const groups: string[] = [];
  for (const v of values) {
    if (v.startsWith('user:')) users.push(v.slice(5));
    else if (v.startsWith('group:')) groups.push(v.slice(6));
  }
  return { users, groups };
}

/** Selected users plus every member of the selected groups, each once. */
export function mergeAuthors(users: readonly string[], memberLists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set([...users, ...memberLists.flat()])];
}

// ---- Issue type icon ----

export type IssueIcon = 'story' | 'bug' | 'task' | 'subtask' | 'epic' | 'other';

/** Which small icon to draw for an issue type name. */
export function issueIconFor(type: string | undefined): IssueIcon {
  const t = (type ?? '').toLowerCase();
  if (t.includes('sub')) return 'subtask';
  if (t.includes('bug') || t.includes('defect')) return 'bug';
  if (t.includes('epic')) return 'epic';
  if (t.includes('story')) return 'story';
  if (t.includes('task')) return 'task';
  return 'other';
}

/** Initials for an avatar placeholder: "Mustafizur Rahman" → "MR". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '')).toUpperCase();
}
