// Custom Report engine: issue hierarchy (epic, sub-task rollup), field values, in-code conditions, tree builder.
// Pure: no Node/Fastify imports (luxon is plain JS).
import { DateTime } from 'luxon';
import { normalizeFieldValue } from './fields.js';
import { matchesCondition, type Condition } from './filter.js';
import type { Layout, Period } from './layout.js';
import { applyExtract } from './text.js';

export const NONE_LABEL = '(none)';
export const MULTIPLE_LABEL = '(multiple)';

/** Label for an issue that could not be loaded (deleted, moved or hidden): its time is grouped here, not dropped. */
export const unavailableLabel = (key: string): string => `${key} (unavailable)`;

// ---- Issues and hierarchy ----

/** An issue as returned by /search/jql (fields = whatever was requested). */
export interface CustomIssue {
  /** Numeric issue id (Jira always returns it next to the key). */
  id?: string;
  key: string;
  fields?: Record<string, unknown>;
}

interface IssueTypeRef {
  name?: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

/** Jira embeds a slim copy of the parent (key, summary, status, issuetype) in fields.parent. */
interface ParentRef {
  id?: string;
  key?: string;
  fields?: { summary?: string; issuetype?: IssueTypeRef };
}

export interface IssueRef {
  key: string;
  summary: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function summaryOf(issue: CustomIssue): string {
  const s = issue.fields?.summary;
  return typeof s === 'string' ? s : '';
}

function issueTypeOf(issue: CustomIssue): IssueTypeRef | undefined {
  return obj(issue.fields?.issuetype) as IssueTypeRef | undefined;
}

function parentOf(issue: CustomIssue): ParentRef | undefined {
  const p = obj(issue.fields?.parent) as ParentRef | undefined;
  return typeof p?.key === 'string' && p.key ? p : undefined;
}

/** Epic = hierarchy level 1 (Jira Cloud), or an issue type literally named "Epic". */
export function isEpicType(t: IssueTypeRef | undefined): boolean {
  return t?.hierarchyLevel === 1 || t?.name?.toLowerCase() === 'epic';
}

/** Sub-task = hierarchy level -1, or the issue type's subtask flag. */
export function isSubtaskType(t: IssueTypeRef | undefined): boolean {
  return t?.subtask === true || t?.hierarchyLevel === -1;
}

export function isSubtask(issue: CustomIssue): boolean {
  return isSubtaskType(issueTypeOf(issue));
}

export function parentKeyOf(issue: CustomIssue): string | undefined {
  return parentOf(issue)?.key;
}

export interface EpicLookup {
  epic?: IssueRef;
  /** First ancestor needed to decide that is not loaded (fetch it, or the epic is unknown). */
  missing?: string;
}

/**
 * Nearest Epic for an issue: the issue itself if it is an Epic, otherwise the closest Epic up the parent chain
 * (sub-task → story → epic). The parent copy Jira embeds is enough to recognise an Epic parent without a fetch.
 */
export function findEpic(key: string, issues: ReadonlyMap<string, CustomIssue>): EpicLookup {
  let cur = issues.get(key);
  if (!cur) return { missing: key };
  const seen = new Set<string>();
  while (!seen.has(cur.key)) {
    seen.add(cur.key);
    if (isEpicType(issueTypeOf(cur))) return { epic: { key: cur.key, summary: summaryOf(cur) } };
    const p = parentOf(cur);
    if (!p) return {};
    const loaded = issues.get(p.key!);
    if (loaded) {
      cur = loaded;
      continue;
    }
    if (isEpicType(p.fields?.issuetype)) return { epic: { key: p.key!, summary: p.fields?.summary ?? '' } };
    return { missing: p.key };
  }
  return {}; // parent cycle: no epic
}

/** Issue a worklog counts towards: the parent for a sub-task when rolling up, else the issue itself. */
export function attributionKey(issue: CustomIssue, rollup: boolean): string {
  return rollup && isSubtask(issue) ? parentKeyOf(issue) ?? issue.key : issue.key;
}

/**
 * Ancestor keys that still have to be fetched: rollup parents of sub-tasks, and the next unknown link in each
 * epic chain (for the issue itself and its rollup target). Keys in `unavailable` (already tried) are skipped.
 */
export function missingAncestorKeys(
  keys: Iterable<string>,
  issues: ReadonlyMap<string, CustomIssue>,
  need: { epic: boolean; rollup: boolean },
  unavailable: ReadonlySet<string> = new Set(),
): string[] {
  const out = new Set<string>();
  const add = (k: string | undefined) => {
    if (k && !issues.has(k) && !unavailable.has(k)) out.add(k);
  };
  for (const key of keys) {
    const issue = issues.get(key);
    if (!issue) continue;
    const target = attributionKey(issue, need.rollup);
    add(target);
    if (need.epic) {
      add(findEpic(key, issues).missing);
      if (issues.has(target)) add(findEpic(target, issues).missing);
    }
  }
  return [...out];
}

/** One issue as in Jira's own issue CSV export (the "Issues CSV"); "" when unknown or empty. */
export interface IssueRow {
  id: string;
  key: string;
  type: string;
  summary: string;
  status: string;
  assignee: string;
  assigneeId: string;
  parentId: string;
  parentKey: string;
  parentSummary: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Issue → Issues CSV row. The parent's summary comes from the loaded parent if there is one, else Jira's embedded copy. */
export function issueRow(issue: CustomIssue, issues: ReadonlyMap<string, CustomIssue> = new Map()): IssueRow {
  const f = issue.fields ?? {};
  const assignee = obj(f.assignee);
  const p = parentOf(issue);
  const loaded = p ? issues.get(p.key!) : undefined;
  return {
    id: str(issue.id),
    key: issue.key,
    type: str(issueTypeOf(issue)?.name),
    summary: summaryOf(issue),
    status: str(obj(f.status)?.name),
    assignee: str(assignee?.displayName),
    assigneeId: str(assignee?.accountId),
    parentId: str(p?.id ?? loaded?.id),
    parentKey: p?.key ?? '',
    parentSummary: loaded ? summaryOf(loaded) : p?.fields?.summary ?? '',
  };
}

/** Newest first, like Jira's issue navigator (key number descending). */
export function compareIssueKeysDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

// ---- Worklogs and field values ----

/** One worklog in the Custom Report. The first eight fields match the matrix's NormalizedWorklog (drill-down reuse). */
export interface CustomWorklog {
  id: string;
  /** yyyy-MM-dd of `started` in REPORT_TZ. */
  date: string;
  accountId: string;
  user: string;
  /** The issue the time was logged on. */
  issueKey: string;
  summary: string;
  project: string;
  seconds: number;
  /** Raw Jira timestamps (with offset). */
  started: string;
  created: string;
  /** yyyy-MM-dd of `created` in REPORT_TZ ("" if unknown). */
  createdDate: string;
  comment: string;
  /** Issue used for grouping and issue-field values: the parent when a sub-task is rolled up. */
  attributedTo: string;
  /** The time zone `date` was computed in (the author's own with zone mode "author"). */
  zone?: string;
  /** Extra column → this worklog's own value (display label); set when the layout has extra columns (Excel "Work logs"). */
  columns?: Record<string, string>;
}

/** `value` identifies the group (e.g. accountId); `label` is what is shown (e.g. display name). "" = empty. */
export interface FieldValue {
  value: string;
  label: string;
}

const EMPTY: FieldValue = { value: '', label: '' };
const same = (s: string): FieldValue => ({ value: s, label: s });

function keySummary(key: string, summary: string): string {
  return summary ? `${key} ${summary}` : key;
}

/**
 * Resolves field values for worklogs/issues, memoising epic lookups. Issues in `unavailable` (could not be loaded)
 * and epic chains broken by one resolve to "KEY (unavailable)" for every issue field, so their time stays visible.
 */
export class ValueResolver {
  private readonly epics = new Map<string, FieldValue>();

  constructor(
    readonly issues: ReadonlyMap<string, CustomIssue>,
    /** fieldId → schemaType (from /api/fields). Unknown ids are normalised as "any". */
    readonly schemaTypes: ReadonlyMap<string, string>,
    readonly unavailable: ReadonlySet<string> = new Set(),
  ) {}

  private epicValue(key: string): FieldValue {
    let v = this.epics.get(key);
    if (!v) {
      const { epic, missing } = findEpic(key, this.issues);
      v = epic
        ? { value: epic.key, label: keySummary(epic.key, epic.summary) }
        : missing && this.unavailable.has(missing)
          ? { value: unavailableLabel(missing), label: unavailableLabel(missing) }
          : EMPTY;
      this.epics.set(key, v);
    }
    return v;
  }

  /** Value of an issue-level field (anything except worklog.*) on `issueKey`. */
  issueValue(fieldId: string, issueKey: string): FieldValue {
    const issue = this.issues.get(issueKey);
    if (!issue) {
      const isKey = fieldId === 'issue.key' || fieldId === 'issue.keySummary';
      if (this.unavailable.has(issueKey)) {
        const label = unavailableLabel(issueKey);
        return { value: isKey ? issueKey : label, label };
      }
      return isKey ? { value: issueKey, label: issueKey } : EMPTY;
    }
    switch (fieldId) {
      case 'issue.key':
        return { value: issue.key, label: issue.key };
      case 'issue.keySummary':
        return { value: issue.key, label: keySummary(issue.key, summaryOf(issue)) };
      case 'epic':
        return this.epicValue(issue.key);
      case 'issue.id':
        return same(str(issue.id));
      case 'parent':
      case 'parent.id':
      case 'parent.key':
      case 'parent.summary': {
        const p = parentOf(issue);
        if (!p) return EMPTY;
        const loaded = this.issues.get(p.key!);
        const summary = loaded ? summaryOf(loaded) : p.fields?.summary ?? '';
        if (fieldId === 'parent.id') return same(str(p.id ?? loaded?.id));
        if (fieldId === 'parent.key') return same(p.key!);
        if (fieldId === 'parent.summary') return same(summary);
        return { value: p.key!, label: keySummary(p.key!, summary) };
      }
      case 'assignee.id':
        return same(str(obj(issue.fields?.assignee)?.accountId));
    }
    const raw = issue.fields?.[fieldId];
    const type = this.schemaTypes.get(fieldId) ?? 'any';
    const user = obj(raw);
    if (type === 'user' && typeof user?.accountId === 'string') {
      return { value: user.accountId, label: normalizeFieldValue(raw, type) || user.accountId };
    }
    const s = normalizeFieldValue(raw, type);
    return { value: s, label: s };
  }

  /** Value of any field for a worklog: worklog.* from the worklog, everything else from its attributed issue. */
  value(fieldId: string, wl: CustomWorklog): FieldValue {
    switch (fieldId) {
      case 'worklog.author':
        return { value: wl.accountId, label: wl.user };
      case 'worklog.date':
        return { value: wl.date, label: wl.date };
      case 'worklog.comment':
        return { value: wl.comment, label: wl.comment };
      case 'worklog.created':
        return { value: wl.createdDate, label: wl.createdDate };
      case 'worklog.started':
        return { value: wl.started, label: wl.started };
      case 'worklog.timeZone':
        return same(wl.zone ?? '');
    }
    return this.issueValue(fieldId, wl.attributedTo);
  }

  /**
   * Values a condition is matched against, on the issue the time was logged on (not the rollup parent).
   * User fields: accountIds only. Lists: every item. Objects: the display value plus their key (project key).
   * Issue links: the key and "KEY Summary". Unloadable issues: "KEY (unavailable)".
   */
  matchValues(fieldId: string, wl: CustomWorklog): string[] {
    switch (fieldId) {
      case 'worklog.author':
        return [wl.accountId];
      case 'worklog.date':
      case 'worklog.created':
      case 'worklog.comment':
      case 'worklog.started':
        return [this.value(fieldId, wl).value];
    }
    return this.issueMatchValues(fieldId, wl.issueKey);
  }

  /** matchValues for an issue-level field on `issueKey`. */
  issueMatchValues(fieldId: string, issueKey: string): string[] {
    const issue = this.issues.get(issueKey);
    if (!issue || POSITIONAL_PSEUDO.has(fieldId)) return candidates(this.issueValue(fieldId, issueKey));
    return fieldAtoms(issue.fields?.[fieldId], this.schemaTypes.get(fieldId) ?? 'any');
  }
}

/** Pseudo-fields whose values come from ValueResolver.issueValue (not a raw Jira field). */
const POSITIONAL_PSEUDO: ReadonlySet<string> = new Set([
  'issue.key', 'issue.keySummary', 'issue.id', 'epic', 'parent', 'parent.id', 'parent.key', 'parent.summary', 'assignee.id',
]);

/** Comparable values of a raw Jira field value (see ValueResolver.matchValues). */
export function fieldAtoms(raw: unknown, schemaType: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    const item = /^array<(.+)>$/.exec(schemaType)?.[1] ?? 'any';
    return [...new Set(raw.flatMap((v) => fieldAtoms(v, item)))];
  }
  const o = obj(raw);
  if (schemaType === 'user') {
    if (typeof o?.accountId === 'string') return [o.accountId];
  }
  const out = [normalizeFieldValue(raw, schemaType)];
  if (typeof o?.key === 'string') out.push(o.key);
  return [...new Set(out.filter((v) => v !== ''))];
}

export const isWorklogField = (fieldId: string): boolean => fieldId.startsWith('worklog.');

/** Candidates a condition is matched against: the value and its label (e.g. accountId and display name). */
function candidates(v: FieldValue): string[] {
  return v.value === v.label ? [v.value] : [v.value, v.label];
}

/**
 * Issue-level checks in code, on the issue the time was logged on (as JQL saw it):
 * post-fetch issue pseudo-fields (issue.keySummary, epic), and a re-check of every "contains" condition
 * (Jira's ~ is word-based/fuzzy, so it can over-match).
 */
export function issuePasses(issueKey: string, conditions: readonly Condition[], r: ValueResolver): boolean {
  return conditions.every((c) => {
    if (isWorklogField(c.fieldId)) return true;
    if (c.op !== 'contains' && c.fieldId !== 'issue.keySummary' && c.fieldId !== 'epic') return true;
    return matchesCondition(c, candidates(r.issueValue(c.fieldId, issueKey)));
  });
}

// ---- Periods ----

/** Period bucket for a report calendar date: the date, ISO week ("2026-W36"), month ("2026-09"), quarter ("2026-Q3") or year. */
export function periodKey(date: string, period: Period): string {
  switch (period) {
    case 'day':
      return date;
    case 'week':
      return DateTime.fromISO(date, { zone: 'utc' }).toFormat("kkkk-'W'WW");
    case 'month':
      return date.slice(0, 7);
    case 'quarter':
      return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
    case 'year':
      return date.slice(0, 4);
    case 'none':
      return '';
  }
}

/** Every period bucket touching [from, to], in order (empty for "none"). */
export function periodKeys(from: string, to: string, period: Period): string[] {
  if (period === 'none') return [];
  const out: string[] = [];
  const end = DateTime.fromISO(to, { zone: 'utc' });
  for (let d = DateTime.fromISO(from, { zone: 'utc' }); d <= end; d = d.plus({ days: 1 })) {
    const k = periodKey(d.toISODate()!, period);
    if (out[out.length - 1] !== k) out.push(k);
  }
  return out;
}

// ---- Tree ----

/** Totals are in seconds; convert with toUnit()/formatAmount() for display. */
export interface TreeNode {
  fieldId: string;
  /** Group identity ("" = empty). */
  value: string;
  /** Display text ("(none)" when empty). */
  label: string;
  total: number;
  periods: Record<string, number>;
  /** Extra column → shared value of everything under this node, or "(multiple)". */
  columns: Record<string, string>;
  /** Every worklog under this node (all descendants), for drill-down. */
  worklogIds: string[];
  /** Distinct issues (attributedTo, i.e. after rollup) under this node. */
  issueCount: number;
  /** Worklogs under this node (= worklogIds.length). */
  worklogCount: number;
  children: TreeNode[];
}

export interface Tree {
  periodKeys: string[];
  nodes: TreeNode[];
  total: number;
  periods: Record<string, number>;
  /** Distinct issues in the whole tree (not the sum of the nodes': one issue can be under several). */
  issueCount: number;
  worklogCount: number;
}

interface Building extends TreeNode {
  childMap: Map<string, Building>;
  columnValues: Map<string, Set<string>>;
  issues: Set<string>;
}

export interface BuildTreeInput {
  worklogs: readonly CustomWorklog[];
  layout: Pick<Layout, 'groupBy' | 'columns' | 'period' | 'sort'>;
  resolver: ValueResolver;
  from: string;
  to: string;
  /** Extract patterns, parallel to layout.groupBy / layout.columns (see text.ts applyExtract). */
  extract?: { groupBy?: readonly (RegExp | undefined)[]; columns?: readonly (RegExp | undefined)[] };
}

/** A value after its extract pattern: a match replaces both the group identity and the label. */
function extracted(v: FieldValue, re: RegExp | undefined): FieldValue {
  if (!re) return v;
  const label = applyExtract(re, v.label);
  return label === v.label ? v : { value: label, label };
}

function compareNodes(sort: Layout['sort']) {
  const byLabel = (a: TreeNode, b: TreeNode) =>
    Number(a.value === '') - Number(b.value === '') || // "(none)" last
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.value.localeCompare(b.value);
  return sort === 'totalDesc' ? (a: TreeNode, b: TreeNode) => b.total - a.total || byLabel(a, b) : byLabel;
}

/** Groups worklogs into a 1–3 level tree with totals, period totals and extra column values per node. */
export function buildTree(input: BuildTreeInput): Tree {
  const { layout, resolver } = input;
  const keys = periodKeys(input.from, input.to, layout.period);
  const zeroes = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
  const root = { childMap: new Map<string, Building>(), total: 0, periods: zeroes(), issues: new Set<string>(), worklogCount: 0 };
  const groupRe = input.extract?.groupBy ?? [];
  const columnRe = input.extract?.columns ?? [];

  for (const wl of input.worklogs) {
    const pk = layout.period === 'none' ? undefined : periodKey(wl.date, layout.period);
    const columnLabels = layout.columns.map((c, i) => [c, applyExtract(columnRe[i], resolver.value(c, wl).label)] as const);
    root.total += wl.seconds;
    root.issues.add(wl.attributedTo);
    root.worklogCount++;
    if (pk !== undefined) root.periods[pk] = (root.periods[pk] ?? 0) + wl.seconds;

    let level = root.childMap;
    for (const [depth, fieldId] of layout.groupBy.entries()) {
      const v = extracted(resolver.value(fieldId, wl), groupRe[depth]);
      let node = level.get(v.value);
      if (!node) {
        node = {
          fieldId,
          value: v.value,
          label: v.value === '' ? NONE_LABEL : v.label || v.value,
          total: 0,
          periods: zeroes(),
          columns: {},
          worklogIds: [],
          issueCount: 0,
          worklogCount: 0,
          children: [],
          childMap: new Map(),
          columnValues: new Map(layout.columns.map((c) => [c, new Set<string>()])),
          issues: new Set(),
        };
        level.set(v.value, node);
      }
      node.total += wl.seconds;
      if (pk !== undefined) node.periods[pk] = (node.periods[pk] ?? 0) + wl.seconds;
      node.worklogIds.push(wl.id);
      node.issues.add(wl.attributedTo);
      for (const [c, label] of columnLabels) node.columnValues.get(c)!.add(label);
      level = node.childMap;
    }
  }

  const cmp = compareNodes(layout.sort);
  const finish = (m: Map<string, Building>): TreeNode[] =>
    [...m.values()]
      .map(({ childMap, columnValues, issues, ...node }): TreeNode => ({
        ...node,
        issueCount: issues.size,
        worklogCount: node.worklogIds.length,
        columns: Object.fromEntries([...columnValues].map(([c, set]) => [c, set.size === 1 ? [...set][0]! : MULTIPLE_LABEL])),
        children: finish(childMap),
      }))
      .sort(cmp);

  return {
    periodKeys: keys,
    nodes: finish(root.childMap),
    total: root.total,
    periods: root.periods,
    issueCount: root.issues.size,
    worklogCount: root.worklogCount,
  };
}
