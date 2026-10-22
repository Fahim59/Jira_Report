// List tab (a look-alike of Jira's List view): pure rules. No DOM, so they can be unit-tested in node.

/** One work item of POST /api/list. */
export interface ListRowData {
  key: string;
  summary: string;
  type: string;
  subtask: boolean;
  status: string;
  /** Jira's status category key: "new" | "indeterminate" | "done". */
  statusCategory: string;
  parent?: string;
  /** Normalised value per requested field id. */
  values: Record<string, string>;
}

// ---- Durations (Jira's 8-hour day, 5-day week) ----

/** Fields whose value is a number of seconds. */
export const DURATION_FIELDS: ReadonlySet<string> = new Set([
  'timeoriginalestimate',
  'timeestimate',
  'timespent',
  'aggregatetimeoriginalestimate',
  'aggregatetimeestimate',
  'aggregatetimespent',
]);

const SECONDS = { week: 5 * 8 * 3600, day: 8 * 3600, hour: 3600, minute: 60 } as const;

/** 3 days, 2 hours · 1 week, 4 days · 6 hours · 30 minutes; "" for empty / zero. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  let left = Math.round(seconds / 60) * 60;
  const parts: string[] = [];
  for (const unit of ['week', 'day', 'hour', 'minute'] as const) {
    const n = Math.floor(left / SECONDS[unit]);
    left -= n * SECONDS[unit];
    if (n) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

// ---- Values ----

/** Fields a row has without asking (always loaded). */
export const BUILTIN_VALUE: Readonly<Record<string, (r: ListRowData) => string>> = {
  status: (r) => r.status,
  issuetype: (r) => r.type,
  parent: (r) => r.parent ?? '',
  summary: (r) => r.summary,
  issuekey: (r) => r.key,
};

/** The text of one cell, durations written the Jira way. */
export function cellText(row: ListRowData, fieldId: string): string {
  const raw = BUILTIN_VALUE[fieldId]?.(row) ?? row.values[fieldId] ?? '';
  if (DURATION_FIELDS.has(fieldId)) {
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? formatDuration(n) : '';
  }
  return raw;
}

/** The values of a row for filtering / grouping: several for list fields ("a, b" from an array), else one ("" = none). */
export function valuesOf(row: ListRowData, fieldId: string, multi: boolean): string[] {
  const raw = BUILTIN_VALUE[fieldId]?.(row) ?? row.values[fieldId] ?? '';
  if (raw === '') return [''];
  if (!multi) return [raw];
  return raw.split(', ').filter(Boolean);
}

// ---- Filtering ----

/** Basic filter: field id → the values the user ticked (a row matches when it has one of them, for every field). */
export type BasicFilter = Record<string, readonly string[]>;

export function activeFilterCount(f: BasicFilter): number {
  return Object.values(f).filter((v) => v.length > 0).length;
}

export function filterRows(rows: readonly ListRowData[], f: BasicFilter, multi: (id: string) => boolean): ListRowData[] {
  const active = Object.entries(f).filter(([, v]) => v.length > 0);
  if (active.length === 0) return [...rows];
  return rows.filter((r) => active.every(([id, wanted]) => valuesOf(r, id, multi(id)).some((v) => wanted.includes(v))));
}

/** Distinct values of a field in the rows, most common first ("" = "None" last). */
export function distinctValues(rows: readonly ListRowData[], fieldId: string, multi: boolean): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const v of valuesOf(r, fieldId, multi)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value === '' ? 1 : b.value === '' ? -1 : b.count - a.count || a.value.localeCompare(b.value)));
}

// ---- Hierarchy and groups ----

export interface TreeNode {
  row: ListRowData;
  children: TreeNode[];
}

/** Rows nested under their parent when the parent is in the list (and hierarchy is on); the rest are roots. Order kept. */
export function buildTree(rows: readonly ListRowData[], hierarchy: boolean): TreeNode[] {
  const nodes = rows.map((row): TreeNode => ({ row, children: [] }));
  if (!hierarchy) return nodes;
  const byKey = new Map(nodes.map((n) => [n.row.key, n]));
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const parent = n.row.parent ? byKey.get(n.row.parent) : undefined;
    // A parent chain that loops would make nodes disappear: such a row stays a root.
    if (parent && parent !== n && !isAncestor(n, parent, byKey)) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

function isAncestor(candidate: TreeNode, of: TreeNode, byKey: Map<string, TreeNode>): boolean {
  const seen = new Set<string>();
  for (let cur: TreeNode | undefined = of; cur && !seen.has(cur.row.key); cur = cur.row.parent ? byKey.get(cur.row.parent) : undefined) {
    if (cur === candidate) return true;
    seen.add(cur.row.key);
  }
  return false;
}

export interface Group {
  value: string;
  rows: ListRowData[];
}

/** Rows split by one field, groups in order of first appearance; a list field puts a row in each of its groups. */
export function groupRows(rows: readonly ListRowData[], fieldId: string, multi: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    for (const v of valuesOf(r, fieldId, multi)) {
      let g = groups.get(v);
      if (!g) groups.set(v, (g = { value: v, rows: [] }));
      g.rows.push(r);
    }
  }
  return [...groups.values()];
}

export const NO_VALUE = 'None';

/** One line of the table: a group heading or a work item. */
export type DisplayLine =
  | { kind: 'group'; id: string; label: string; count: number; open: boolean }
  | { kind: 'item'; row: ListRowData; depth: number; expandable: boolean; open: boolean };

export interface LayoutOptions {
  hierarchy: boolean;
  groupBy?: { fieldId: string; multi: boolean };
  /** Keys of rows whose children are shown. */
  expanded: ReadonlySet<string>;
  /** Group values that are collapsed. */
  collapsedGroups: ReadonlySet<string>;
}

/** The lines to draw, top to bottom: groups (if any), each with its tree of work items (children only under open rows). */
export function layoutLines(rows: readonly ListRowData[], o: LayoutOptions): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const open = o.expanded.has(n.row.key);
      lines.push({ kind: 'item', row: n.row, depth, expandable: n.children.length > 0, open });
      if (open) walk(n.children, depth + 1);
    }
  };
  if (!o.groupBy) {
    walk(buildTree(rows, o.hierarchy), 0);
    return lines;
  }
  for (const g of groupRows(rows, o.groupBy.fieldId, o.groupBy.multi)) {
    const open = !o.collapsedGroups.has(g.value);
    lines.push({ kind: 'group', id: g.value, label: g.value || NO_VALUE, count: g.rows.length, open });
    if (open) walk(buildTree(g.rows, o.hierarchy), 0);
  }
  return lines;
}

/** Work items per page on screen; "Load more" adds this many. */
export const PAGE_SIZE = 200;

/**
 * The first `limit` work-item lines (group headings and the children of open rows come along; a group heading with no
 * item under it is left out). `items` = work-item lines in all, `shown` = how many of them are in `lines`.
 */
export function pageLines(lines: readonly DisplayLine[], limit: number): { lines: DisplayLine[]; items: number; shown: number } {
  const items = lines.filter((l) => l.kind === 'item').length;
  if (items <= limit) return { lines: [...lines], items, shown: items };
  let seen = 0;
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === 'item' && ++seen > limit) {
      cut = i;
      break;
    }
  }
  while (cut > 0 && lines[cut - 1]!.kind === 'group') cut--;
  return { lines: lines.slice(0, cut), items, shown: limit };
}

/** Keys that have children (for "expand all"). */
export function parentKeys(rows: readonly ListRowData[], hierarchy: boolean): string[] {
  if (!hierarchy) return [];
  const keys = new Set(rows.map((r) => r.key));
  return [...new Set(rows.flatMap((r) => (r.parent && keys.has(r.parent) ? [r.parent] : [])))];
}

// ---- Columns ----

/** Fields listable as columns / group / filter: real Jira fields only (no worklog / metric pseudo-fields). */
export function isListField(id: string): boolean {
  return (/^[A-Za-z][A-Za-z0-9_]*$/.test(id) && id !== 'epic') || LIST_PSEUDO_FIELDS.has(id);
}

/** Columns computed from the issue (the server fills them in): ids, keys and the parent's summary. */
export const LIST_PSEUDO_FIELDS: ReadonlySet<string> = new Set(['issue.key', 'issue.id', 'assignee.id', 'parent.id', 'parent.key', 'parent.summary']);

const COLUMN_LABELS: Readonly<Record<string, string>> = { 'issue.key': 'Issue key', timeoriginalestimate: 'Original Estimate' };

/** Header of a column / name in the column picker (the Issue list export's names). */
export function columnLabel(id: string, name: string): string {
  return COLUMN_LABELS[id] ?? name;
}

/** The Issue list export's columns, in its order (Issue Type, Issue key, Issue id, Summary, Status, Assignee, Assignee Id, Parent id/key/summary, Original Estimate, Time Spent). */
export const DEFAULT_COLUMNS = [
  'issuetype',
  'issue.key',
  'issue.id',
  'summary',
  'status',
  'assignee',
  'assignee.id',
  'parent.id',
  'parent.key',
  'parent.summary',
  'timeoriginalestimate',
  'timespent',
] as const;
export const DEFAULT_FILTER_FIELDS = ['parent', 'assignee', 'status', 'issuetype', 'labels'] as const;

/** Name Jira's List view uses for a field in the filter list ("Work type" for Issue Type). */
export function listFieldName(id: string, name: string): string {
  return id === 'issuetype' ? 'Work type' : name;
}

/** The field ids a request needs: columns, the group field and the filter fields (each once, real fields only). */
export function requestFields(columns: readonly string[], groupField: string | undefined, filterFields: readonly string[]): string[] {
  return [...new Set([...columns, ...(groupField ? [groupField] : []), ...filterFields])].filter(isListField);
}

/** The columns with the one at `from` moved to position `to` (both clamped to the list; unchanged for a no-op). */
export function moveColumn(columns: readonly string[], from: number, to: number): string[] {
  const out = [...columns];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item!);
  return out;
}
