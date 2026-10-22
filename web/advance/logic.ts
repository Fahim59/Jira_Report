// Pure rules for the Custom Report tab (no DOM, so they can be unit-tested in node). DOM lives in web/advance/tab.ts.
import type { CustomWorklog, TreeNode } from '../../src/services/custom/engine.js';
import type { FieldInfo } from '../../src/services/custom/fields.js';
import type { Condition, Operator } from '../../src/services/custom/filter.js';
import type { Layout, Period } from '../../src/services/custom/layout.js';
import type { Drilldown, DrilldownGroup } from '../drilldown.js';
import type { MultiOption } from '../multiselect-logic.js';

/** Same limits as the server (src/services/custom/filter.ts, layout.ts); the server enforces them either way. */
export const MAX_GROUP_LEVELS = 5;
export const MAX_COLUMNS = 20;
export const MAX_CONDITIONS = 20;
export const MAX_PICKED = 50;

export const ROLLUP_TOOLTIP =
  'Filters are checked on the issue the time was logged on (as Jira sees it), not on the parent it is summed into. ' +
  'Example: with "Status is Done", a Done sub-task is kept even if its parent is not Done.';

/** Preferred fields for a new group-by level, in order (first unused wins). */
const LEVEL_DEFAULTS = ['worklog.author', 'issue.keySummary', 'status', 'issue.key', 'project', 'worklog.date'];

// ---- Fields ----

/**
 * Picker options for fields: label = name, or "Name (id)" when several fields share the name (common with custom
 * fields). Search matches the name or the id, never across the two. `exclude` drops ids (e.g. other group levels).
 */
export function fieldOptions(fields: readonly FieldInfo[], exclude: ReadonlySet<string> = new Set()): MultiOption[] {
  const count = new Map<string, number>();
  for (const f of fields) count.set(f.name.toLowerCase(), (count.get(f.name.toLowerCase()) ?? 0) + 1);
  return fields
    .filter((f) => !exclude.has(f.id))
    .map((f) => ({
      value: f.id,
      name: `${f.name}\n${f.id}`,
      label: (count.get(f.name.toLowerCase()) ?? 0) > 1 ? `${f.name} (${f.id})` : f.name,
    }));
}

/** Field name for headers; the id if the field list does not have it. */
export function fieldName(fields: readonly FieldInfo[], id: string): string {
  return fields.find((f) => f.id === id)?.name ?? id;
}

/** User fields pick values with the user picker (accountIds). */
export function isUserField(f: FieldInfo | undefined): boolean {
  return f?.schemaType === 'user' || f?.schemaType === 'array<user>';
}

/** First field of LEVEL_DEFAULTS (then of the list) that exists and is not used yet. */
export function nextLevelField(fields: readonly FieldInfo[], used: readonly string[]): string | undefined {
  const free = (id: string) => !used.includes(id) && fields.some((f) => f.id === id);
  return LEVEL_DEFAULTS.find(free) ?? fields.find((f) => free(f.id))?.id;
}

/** Moves item `i` one place up (-1) or down (+1); unchanged at the ends. */
export function moveItem<T>(items: readonly T[], i: number, step: -1 | 1): T[] {
  const j = i + step;
  if (i < 0 || i >= items.length || j < 0 || j >= items.length) return [...items];
  const out = [...items];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

// ---- Conditions ----

export const OPERATOR_LABELS: Readonly<Record<Operator, string>> = {
  is: 'is',
  isNot: 'is not',
  in: 'is one of',
  notIn: 'is not one of',
  contains: 'contains',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

const ALL_OPERATORS = Object.keys(OPERATOR_LABELS) as Operator[];

/** "contains" is text search; it makes no sense for user fields (picked by accountId). */
export function operatorsFor(f: FieldInfo | undefined): Operator[] {
  return isUserField(f) ? ALL_OPERATORS.filter((o) => o !== 'contains') : ALL_OPERATORS;
}

/** How the value is entered: nothing, one/many users, one text, or a comma-separated list. */
export type ValueKind = 'none' | 'user' | 'users' | 'text' | 'list';

export function valueKind(f: FieldInfo | undefined, op: Operator): ValueKind {
  if (op === 'isEmpty' || op === 'isNotEmpty') return 'none';
  const many = op === 'in' || op === 'notIn';
  if (isUserField(f)) return many ? 'users' : 'user';
  return many ? 'list' : 'text';
}

/** "a, b,\nc" → ["a", "b", "c"]: split on commas/new lines, trimmed, empties and duplicates dropped. */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
}

/** One filter row as edited in the UI. */
export interface ConditionDraft {
  fieldId: string;
  op: Operator;
  /** Text / comma-separated list (non-user fields). */
  text: string;
  /** accountIds (user fields). */
  users: string[];
}

/**
 * Drafts → conditions. A row without a field is skipped; a row missing its value is an error naming the row
 * (1-based, as the user sees them).
 */
export function buildConditions(
  drafts: readonly ConditionDraft[],
  fields: readonly FieldInfo[],
): { conditions: Condition[]; error?: string } {
  const conditions: Condition[] = [];
  for (const [i, d] of drafts.entries()) {
    if (!d.fieldId) continue;
    const f = fields.find((x) => x.id === d.fieldId);
    const name = `Filter ${i + 1} (${f?.name ?? d.fieldId})`;
    switch (valueKind(f, d.op)) {
      case 'none':
        conditions.push({ fieldId: d.fieldId, op: d.op });
        break;
      case 'user':
        if (!d.users[0]) return { conditions, error: `${name}: choose a user.` };
        conditions.push({ fieldId: d.fieldId, op: d.op, value: d.users[0] });
        break;
      case 'users':
        if (!d.users.length) return { conditions, error: `${name}: choose at least one user.` };
        conditions.push({ fieldId: d.fieldId, op: d.op, value: [...d.users] });
        break;
      case 'text': {
        const v = d.text.trim();
        if (!v) return { conditions, error: `${name}: enter a value.` };
        conditions.push({ fieldId: d.fieldId, op: d.op, value: v });
        break;
      }
      case 'list': {
        const vs = parseList(d.text);
        if (!vs.length) return { conditions, error: `${name}: enter one or more values, separated by commas.` };
        conditions.push({ fieldId: d.fieldId, op: d.op, value: vs });
        break;
      }
    }
  }
  return { conditions };
}

// ---- Dates ----

/** Whole days in [from, to], inclusive; both yyyy-MM-dd. */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

// ---- Tree table ----

/** Path id of a node: its ancestors' values and its own, joined (unique within a tree). */
export const childPath = (parent: string, node: TreeNode): string => (parent ? `${parent}\u001f${node.value}` : node.value);

export interface TreeRow {
  node: TreeNode;
  path: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Rows to show, depth-first in the server's order; children of collapsed nodes are skipped. */
export function visibleRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: readonly TreeNode[], parent: string, depth: number) => {
    for (const node of list) {
      const path = childPath(parent, node);
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(path);
      out.push({ node, path, depth, hasChildren, expanded });
      if (expanded) walk(node.children, path, depth + 1);
    }
  };
  walk(nodes, '', 0);
  return out;
}

/** Paths of every node that has children ("Collapse all"). */
export function parentPaths(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode[], parent: string) => {
    for (const node of list) {
      if (!node.children.length) continue;
      const path = childPath(parent, node);
      out.push(path);
      walk(node.children, path);
    }
  };
  walk(nodes, '');
  return out;
}

/** The node at `path` and the labels from the top level down to it. */
export function findNode(nodes: readonly TreeNode[], path: string): { node: TreeNode; labels: string[] } | undefined {
  const walk = (list: readonly TreeNode[], parent: string, labels: string[]): { node: TreeNode; labels: string[] } | undefined => {
    for (const node of list) {
      const p = childPath(parent, node);
      if (p === path) return { node, labels: [...labels, node.label] };
      if (path.startsWith(`${p}\u001f`)) return walk(node.children, p, [...labels, node.label]);
    }
    return undefined;
  };
  return walk(nodes, '', []);
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const ISSUE_FIELDS = new Set(['issue.key', 'issue.keySummary', 'parent', 'epic']);

/** Jira issue key a node stands for (issue/parent/epic levels), for a /browse link; undefined otherwise. */
export function issueKeyOf(node: TreeNode): string | undefined {
  return ISSUE_FIELDS.has(node.fieldId) && ISSUE_KEY.test(node.value) ? node.value : undefined;
}

// ---- Periods ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO week key ("2026-W36") of a calendar date; same as the server's periodKey (luxon "kkkk-'W'WW"). */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7; // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Period bucket of a worklog date (mirrors the server's periodKey). */
export function periodOf(date: string, period: Period): string {
  if (period === 'day') return date;
  if (period === 'week') return isoWeekKey(date);
  if (period === 'month') return date.slice(0, 7);
  if (period === 'quarter') return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
  if (period === 'year') return date.slice(0, 4);
  return '';
}

/** Column header: "01-Sep" (day), "2026-W36" (week), "Sep 2026" (month), "Q3 2026" (quarter), "2026" (year). */
export function periodLabel(key: string, period: Period): string {
  if (period === 'day') return `${key.slice(8, 10)}-${MONTHS[Number(key.slice(5, 7)) - 1]}`;
  if (period === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  if (period === 'quarter') return `${key.slice(5)} ${key.slice(0, 4)}`;
  return key;
}

// ---- Drill-down ----

/**
 * Worklogs behind a preview cell for the shared drill-down modal: `worklogIds` = the node's / row's (the sheet's for
 * its grand total), optionally limited to one period bucket. Grouped by user (name order).
 */
export function nodeDrilldown(worklogs: readonly CustomWorklog[], worklogIds: readonly string[], period: Period, periodKey?: string): Drilldown {
  const ids = new Set(worklogIds);
  const byUser = new Map<string, DrilldownGroup>();
  for (const wl of worklogs) {
    if (!ids.has(wl.id)) continue;
    if (periodKey !== undefined && periodOf(wl.date, period) !== periodKey) continue;
    let g = byUser.get(wl.accountId);
    if (!g) {
      g = { accountId: wl.accountId, user: wl.user, worklogs: [], total: 0 };
      byUser.set(wl.accountId, g);
    }
    g.worklogs.push(wl);
    g.total += wl.seconds;
  }
  const groups = [...byUser.values()].sort((a, b) => a.user.localeCompare(b.user) || a.accountId.localeCompare(b.accountId));
  return { date: periodKey ?? '', groups, total: groups.reduce((s, g) => s + g.total, 0) };
}

// ---- Amounts ----

/** "7.5h" / "0.94d" (at most 2 decimals), like the server's formatAmount. */
export function formatAmount(seconds: number, format: Layout['format'], hoursPerDay: number): string {
  const hours = seconds / 3600;
  const n = Math.round((format === 'days' ? hours / hoursPerDay : hours) * 100) / 100;
  return `${n}${format === 'days' ? 'd' : 'h'}`;
}

// ---- Timestamps ----

/**
 * Jira timestamp ("2026-09-01T10:00:00.000+0600") → "01-Sep-2026 10:00:00" in `timeZone` (REPORT_TZ), the wall-clock
 * time the .xlsx shows. Unparseable text is returned as is.
 */
export function formatTimestamp(raw: string, timeZone: string): string {
  const ms = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!raw || Number.isNaN(ms)) return raw;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  } catch {
    return raw; // unknown time zone
  }
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${p('day')}-${MONTHS[Number(p('month')) - 1]}-${p('year')} ${p('hour')}:${p('minute')}:${p('second')}`;
}
