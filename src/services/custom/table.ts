// Sheet results as plain tables (header + rows), the shape the Excel writer (and the preview) lays out.
// Amount cells are seconds; the caller converts them to the sheet's unit. Pure: no imports beyond types.
import type { TreeNode } from './engine.js';
import type { Period } from './layout.js';
import type { FlatSheetResult, GroupSheetResult, SheetResult } from './sheets.js';

export const HOURS_FIELD = 'metric.hours';
/** Group sheet count columns (same as filter.ts COUNT_FIELDS; this module stays import-free for the browser). */
const COUNTS: Readonly<Record<string, 'issueCount' | 'worklogCount'>> = { 'metric.issueCount': 'issueCount', 'metric.worklogCount': 'worklogCount' };
export const isCountColumn = (fieldId: string): boolean => fieldId in COUNTS;

/**
 * A group sheet's extra column for a node (or the whole tree): the count for metric.issueCount / worklogCount
 * (distinct issues of the node or tree, so a Total row is not the sum of the rows), else the shared value.
 */
export function groupColumnCell(node: Pick<TreeNode, 'issueCount' | 'worklogCount'> & { columns?: TreeNode['columns'] }, fieldId: string): TableCell {
  const count = COUNTS[fieldId];
  if (count) return node[count];
  return node.columns?.[fieldId] ?? '';
}
const DATE_FIELDS: ReadonlySet<string> = new Set(['worklog.started', 'worklog.created']);
/** Label of the grand total row (first column). */
export const TOTAL_ROW_LABEL = 'Total';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Column header: "01-Sep" (day), "2026-W36" (week), "Sep 2026" (month), "Q3 2026" (quarter), "2026" (year). Same as web/advance/logic.ts periodLabel. */
export function periodLabel(key: string, period: Period): string {
  if (period === 'day') return `${key.slice(8, 10)}-${MONTHS[Number(key.slice(5, 7)) - 1]}`;
  if (period === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  if (period === 'quarter') return `${key.slice(5)} ${key.slice(0, 4)}`;
  return key;
}

/** "Alice Total": the first cell of a subtotal row (lastLevel + subtotalRows), like an Excel pivot table. */
export const subtotalLabel = (label: string): string => `${label} Total`;

/** Display text; numbers in `amountColumns` are seconds; strings in `dateColumns` are raw Jira timestamps. */
export type TableCell = string | number;

export interface TableRow {
  kind: 'data' | 'subtotal' | 'total';
  cells: TableCell[];
  /** Worklogs behind the row (drill-down). */
  worklogIds: string[];
}

export interface SheetTable {
  header: string[];
  rows: TableRow[];
  /** 0-based columns holding amounts (seconds). */
  amountColumns: number[];
  /** 0-based columns holding Jira timestamps (Excel dates in REPORT_TZ). */
  dateColumns: number[];
  /** 0-based columns holding counts (plain numbers). */
  countColumns: number[];
  /** mergeGroupCells: [firstRow, col, lastRow, col], 0-based into `rows` / columns; vertical, top-aligned. */
  merges: Array<[number, number, number, number]>;
}

/** One table row per leaf; `firstLevel` = the shallowest level whose group starts on this row (shown from there on). */
export interface LeafRow {
  chain: TreeNode[];
  firstLevel: number;
}

/**
 * Depth-first over the tree: `leaf` for every leaf row, `close` after the last row of every parent group
 * (deepest first). A group's parent values belong on its first row only, hence `firstLevel`.
 */
function walkTree(nodes: readonly TreeNode[], leaf: (row: LeafRow) => void, close?: (node: TreeNode, depth: number) => void): void {
  const walk = (level: readonly TreeNode[], chain: TreeNode[], firstLevel: number) => {
    level.forEach((n, i) => {
      const start = i === 0 ? firstLevel : chain.length;
      if (n.children.length) {
        walk(n.children, [...chain, n], start);
        close?.(n, chain.length);
      } else leaf({ chain: [...chain, n], firstLevel: start });
    });
  };
  walk(nodes, [], 0);
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

/**
 * Group sheet table.
 * - everyLevel: Level / "Total <level>" pairs, extra columns, period columns, and a trailing total column (headed
 *   totalLabel) only with period columns (otherwise the deepest "Total <level>" is the row total).
 * - lastLevel: level columns, extra columns, period columns, then one total column headed totalLabel; with
 *   subtotalRows, a subtotal row after each parent group.
 * Parent values only on the first row of their group (with mergeGroupCells, merged down the group's rows together
 * with their "Total <level>" cell). Count columns hold the node's counts; the Total row the tree's distinct counts.
 * Total row when totals are on.
 */
export function groupTable(r: Pick<GroupSheetResult, 'tree' | 'sheet' | 'headers' | 'showTotals'>): SheetTable {
  const { tree, sheet, headers } = r;
  const levels = headers.groupBy.length;
  const columns = sheet.columns.map((c) => c.fieldId);
  const periods = tree.periodKeys;
  const periodHeaders = periods.map((k) => periodLabel(k, sheet.period));
  const last = sheet.totalColumns === 'lastLevel';
  const trailingTotal = last || periods.length > 0;
  const blank = (n: number): TableCell[] => Array<TableCell>(n).fill('');
  const tail = (node: Pick<TreeNode, 'periods' | 'total'>): TableCell[] => [
    ...periods.map((k) => node.periods[k] ?? 0),
    ...(trailingTotal ? [node.total] : []),
  ];

  type Counted = Pick<TreeNode, 'issueCount' | 'worklogCount'> & { columns?: TreeNode['columns'] };
  const cols = (node: Counted) => columns.map((c) => groupColumnCell(node, c));
  // Subtotal / Total rows: counts only (a shared text value is not a total).
  const countCells = (node: Counted) => columns.map((c) => (isCountColumn(c) ? groupColumnCell(node, c) : ''));
  const header = [
    ...(last ? headers.groupBy : headers.groupBy.flatMap((h) => [h, `Total ${h}`])),
    ...headers.columns,
    ...periodHeaders,
    ...(trailingTotal ? [sheet.totalLabel] : []),
  ];
  const levelWidth = last ? levels : levels * 2;
  const amountColumns = [
    ...(last ? [] : range(0, levels).map((i) => i * 2 + 1)),
    ...range(levelWidth + columns.length, periods.length + (trailingTotal ? 1 : 0)),
  ];

  const countColumns = columns.flatMap((c, i) => (isCountColumn(c) ? [levelWidth + i] : []));

  const rows: TableRow[] = [];
  const merges: SheetTable['merges'] = [];
  /** Row where the open group at each depth started. */
  const starts: number[] = [];
  const subtotals = last && sheet.subtotalRows && r.showTotals;
  walkTree(
    tree.nodes,
    ({ chain, firstLevel }) => {
      const leaf = chain[chain.length - 1]!;
      for (let d = firstLevel; d < chain.length - 1; d++) starts[d] = rows.length;
      const levelCells = range(0, levels).flatMap((i): TableCell[] => {
        const n = chain[i];
        const shown = n !== undefined && i >= firstLevel;
        if (last) return [shown ? n.label : ''];
        return shown ? [n.label, n.total] : ['', ''];
      });
      rows.push({ kind: 'data', cells: [...levelCells, ...cols(leaf), ...tail(leaf)], worklogIds: leaf.worklogIds });
    },
    (node, depth) => {
      const first = starts[depth]!;
      const lastRow = rows.length - 1;
      if (sheet.mergeGroupCells && lastRow > first) {
        for (const c of last ? [depth] : [depth * 2, depth * 2 + 1]) merges.push([first, c, lastRow, c]);
      }
      if (!subtotals) return;
      rows.push({
        kind: 'subtotal',
        cells: [...blank(depth), subtotalLabel(node.label), ...blank(levels - depth - 1), ...countCells(node), ...tail(node)],
        worklogIds: node.worklogIds,
      });
    },
  );

  if (r.showTotals) {
    const levelCells = last
      ? [TOTAL_ROW_LABEL, ...blank(levels - 1)]
      : range(0, levels).flatMap((i): TableCell[] => [i === 0 ? TOTAL_ROW_LABEL : '', tree.total]);
    rows.push({ kind: 'total', cells: [...levelCells, ...countCells(tree), ...tail(tree)], worklogIds: [] });
  }
  return { header, rows, amountColumns, dateColumns: [], countColumns, merges };
}

/**
 * Each-worklog / each-issue table: the configured columns. Total row (when shown) = the Hours column summed, with
 * "Total" in the first other column.
 */
export function flatTable(r: Pick<FlatSheetResult, 'columns' | 'rows' | 'headers' | 'showTotals'>): SheetTable {
  const amountColumns = r.columns.flatMap((c, i) => (c === HOURS_FIELD ? [i] : []));
  const dateColumns = r.columns.flatMap((c, i) => (DATE_FIELDS.has(c) ? [i] : []));
  const rows: TableRow[] = r.rows.map((row) => ({ kind: 'data', cells: row.cells, worklogIds: row.worklogIds }));
  if (r.showTotals) {
    const total = r.rows.reduce((sum, row) => sum + row.seconds, 0);
    const labelAt = r.columns.findIndex((c) => c !== HOURS_FIELD);
    rows.push({
      kind: 'total',
      cells: r.columns.map((c, i) => (c === HOURS_FIELD ? total : i === labelAt ? TOTAL_ROW_LABEL : '')),
      worklogIds: [],
    });
  }
  return { header: r.headers.columns, rows, amountColumns, dateColumns, countColumns: [], merges: [] };
}

export const sheetTable = (r: SheetResult): SheetTable => (r.mode === 'group' ? groupTable(r) : flatTable(r));
