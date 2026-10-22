// Pure field logic for the Custom Report (no Node/Fastify imports, so it can run in the browser later).

/** One reportable field: a Jira field (system or custom) or a pseudo-field computed by the app. */
export interface FieldInfo {
  id: string;
  name: string;
  custom: boolean;
  /** Jira schema type ("string", "option", "user", "array<option>", ...), or the pseudo-field's own type. */
  schemaType: string;
}

/** A field as returned by GET /rest/api/3/field. */
export interface JiraFieldRaw {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; items?: string; custom?: string; customId?: number };
}

/**
 * Fields the app always offers. Worklog-level ones come from the worklog itself; `issue.*` are computed
 * from the issue; the standard ones are listed even if /field omits them (Jira's own entry wins if present).
 */
export const PSEUDO_FIELDS: readonly FieldInfo[] = [
  { id: 'worklog.author', name: 'Worklog Author', custom: false, schemaType: 'user' },
  { id: 'worklog.date', name: 'Worklog Date', custom: false, schemaType: 'date' },
  { id: 'worklog.comment', name: 'Worklog Comment', custom: false, schemaType: 'string' },
  { id: 'worklog.created', name: 'Worklog Created', custom: false, schemaType: 'datetime' },
  { id: 'worklog.started', name: 'Worklog Started', custom: false, schemaType: 'datetime' },
  { id: 'worklog.timeZone', name: 'Worklog Time Zone', custom: false, schemaType: 'string' },
  { id: 'issue.key', name: 'Issue', custom: false, schemaType: 'string' },
  { id: 'issue.keySummary', name: 'Issue (Key Summary)', custom: false, schemaType: 'string' },
  { id: 'issue.id', name: 'Issue id', custom: false, schemaType: 'string' },
  { id: 'parent', name: 'Parent', custom: false, schemaType: 'issuelink' },
  { id: 'parent.id', name: 'Parent id', custom: false, schemaType: 'string' },
  { id: 'parent.key', name: 'Parent key', custom: false, schemaType: 'string' },
  { id: 'parent.summary', name: 'Parent summary', custom: false, schemaType: 'string' },
  { id: 'epic', name: 'Epic', custom: false, schemaType: 'issuelink' },
  { id: 'project', name: 'Project', custom: false, schemaType: 'project' },
  { id: 'issuetype', name: 'Issue Type', custom: false, schemaType: 'issuetype' },
  { id: 'status', name: 'Status', custom: false, schemaType: 'status' },
  { id: 'assignee', name: 'Assignee', custom: false, schemaType: 'user' },
  { id: 'assignee.id', name: 'Assignee Id', custom: false, schemaType: 'string' },
  // Time in the row: one worklog's time (each-worklog sheets) or an issue's total (each-issue sheets). Columns only.
  { id: 'metric.hours', name: 'Hours', custom: false, schemaType: 'number' },
  // Group sheets: distinct issues (after sub-task rollup) / worklogs in the row. Columns only.
  { id: 'metric.issueCount', name: 'Issue Count', custom: false, schemaType: 'number' },
  { id: 'metric.worklogCount', name: 'Worklog Count', custom: false, schemaType: 'number' },
];

/** "array<option>" for arrays, the plain type otherwise, "any" when Jira gives no schema. */
export function schemaTypeOf(schema: JiraFieldRaw['schema']): string {
  const type = schema?.type;
  if (!type) return 'any';
  return type === 'array' ? `array<${schema?.items ?? 'any'}>` : type;
}

/** Jira's fields plus the pseudo-fields, de-duplicated by id (Jira wins), sorted by name then id. */
export function buildFieldList(raw: readonly JiraFieldRaw[]): FieldInfo[] {
  const byId = new Map<string, FieldInfo>();
  for (const f of PSEUDO_FIELDS) byId.set(f.id, { ...f });
  for (const f of raw) {
    if (!f?.id || !f.name) continue;
    byId.set(f.id, { id: f.id, name: f.name, custom: f.custom === true, schemaType: schemaTypeOf(f.schema) });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Atlassian Document Format root (rich-text fields and worklog comments). */
export function isAdf(v: unknown): v is Obj & { type: 'doc'; content: unknown[] } {
  return isObj(v) && v.type === 'doc' && Array.isArray(v.content);
}

const ADF_BLOCKS = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem',
  'panel', 'rule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'mediaGroup', 'mediaSingle',
  'expand', 'nestedExpand', 'taskList', 'taskItem', 'decisionList', 'decisionItem',
]);

function adfNode(node: unknown): string {
  if (!isObj(node)) return '';
  const attrs = isObj(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case 'text':
      return typeof node.text === 'string' ? node.text : '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
    case 'status':
    case 'date':
      return String(attrs.text ?? attrs.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(attrs.url ?? '');
  }
  const children = Array.isArray(node.content) ? node.content : [];
  // Block children go on their own lines; inline children run together.
  const sep = children.some((c) => isObj(c) && ADF_BLOCKS.has(String(c.type))) ? '\n' : '';
  return children.map(adfNode).join(sep);
}

/** Plain text of an ADF document: blocks on separate lines, blank lines collapsed, trimmed. */
export function adfToText(doc: unknown): string {
  return adfNode(doc).replace(/\n{2,}/g, '\n').trim();
}

/** Display string for any Jira field value (see the Custom Report spec, Step 1). */
export function normalizeFieldValue(raw: unknown, schemaType = 'any'): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (Array.isArray(raw)) {
    const item = /^array<(.+)>$/.exec(schemaType)?.[1] ?? 'any';
    return raw.map((v) => normalizeFieldValue(v, item)).filter((s) => s !== '').join(', ');
  }
  if (!isObj(raw)) return '';
  if (isAdf(raw)) return adfToText(raw);

  if (schemaType === 'option' || schemaType === 'option-with-child') {
    const parent = typeof raw.value === 'string' ? raw.value : '';
    const child = isObj(raw.child) && typeof raw.child.value === 'string' ? raw.child.value : '';
    if (parent) return child ? `${parent} - ${child}` : parent;
  }
  if (schemaType === 'user' && typeof raw.displayName === 'string') return raw.displayName;

  for (const k of ['name', 'key', 'value', 'displayName'] as const) {
    const v = raw[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}
