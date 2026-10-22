// Built-in starter templates (Phase 8b). Fields are referenced by name, because custom field ids differ per site;
// resolveStarter() maps them to ids with the site's /api/fields list. Pure: no Node/Fastify imports.
import type { FieldInfo } from './fields.js';
import { TemplateBodySchema, type TemplateBody } from './template.js';

/** A column / group level by field name (case-insensitive), with the header to show and an optional extract regex. */
export interface StarterRef {
  field: string;
  label?: string;
  extract?: string;
}

/** A sheet as SheetSchema takes it, except that group levels and columns are StarterRefs. */
export type StarterSheet = Record<string, unknown> & {
  name: string;
  rows: { mode: 'group'; groupBy: StarterRef[] } | { mode: 'eachWorklog' } | { mode: 'eachIssue' };
  columns?: StarterRef[];
};

export interface StarterTemplate {
  /** Stable id, `builtin:<slug>`; read-only in the template store. */
  id: string;
  name: string;
  sheets: StarterSheet[];
}

const ref = (field: string, label?: string, extract?: string): StarterRef => ({ field, ...(label ? { label } : {}), ...(extract ? { extract } : {}) });

/** The team sample's "Work logs" sheet: 8 columns, one row per worklog. */
export const WORK_LOGS_SHEET: StarterSheet = {
  name: 'Work logs',
  rows: { mode: 'eachWorklog' },
  columns: [
    ref('Worklog Author', 'Author'),
    ref('Issue', 'Issue'),
    ref('Summary', 'Issue Summary'),
    ref('Worklog Started', 'Work log started'),
    ref('Worklog Created', 'Work log created'),
    ref('Worklog Time Zone', 'Work log time zone'),
    ref('Hours', 'Time spent'),
    ref('Worklog Comment', 'Work log comment'),
  ],
};

/** Jira's own issue CSV export (Jira.csv), as an each-issue sheet: the same 10 columns. */
export const ISSUE_LIST_SHEET: StarterSheet = {
  name: 'Issues',
  rows: { mode: 'eachIssue' },
  columns: [
    ref('Issue Type', 'Issue Type'),
    ref('Issue', 'Issue key'),
    ref('Issue id', 'Issue id'),
    ref('Summary', 'Summary'),
    ref('Status', 'Status'),
    ref('Assignee', 'Assignee'),
    ref('Assignee Id', 'Assignee Id'),
    ref('Parent id', 'Parent'),
    ref('Parent key', 'Parent key'),
    ref('Parent summary', 'Parent summary'),
  ],
  includeIssuesWithoutWorklogs: true,
};

/** Ids of the built-in starters start with this; nothing else may. */
export const BUILTIN_PREFIX = 'builtin:';
export const isBuiltinId = (id: string): boolean => id.startsWith(BUILTIN_PREFIX);

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'builtin:time-reports-style',
    name: 'Time Reports style',
    sheets: [
      {
        name: 'Report',
        rows: { mode: 'group', groupBy: [ref('Issue', 'Issue'), ref('Issue (Key Summary)', 'Summary'), ref('Status', 'Status')] },
        totals: true,
      },
      WORK_LOGS_SHEET,
    ],
  },
  {
    id: 'builtin:team-client-report',
    name: 'Team Client Report',
    sheets: [
      {
        name: 'Report',
        rows: { mode: 'group', groupBy: [ref('Worklog Author', 'User'), ref('Issue (Key Summary)', 'Issue')] },
        // Some Jira values are full URLs; keep the TPX-#### reference only.
        columns: [ref('Client Reference', 'Client Reference', 'TPX-\\d+')],
        totals: true,
        totalColumns: 'lastLevel',
        totalLabel: 'Hours',
        subtotalRows: false,
      },
      {
        name: 'Summary',
        rows: { mode: 'group', groupBy: [ref('Worklog Author', 'User')] },
        columns: [ref('Issue Count', 'Issues')],
        totals: true,
        totalColumns: 'lastLevel',
        totalLabel: 'Spent Hours',
        headerStyle: 'title',
        title: '{projects} — Worklog Summary',
        subtitle: 'Period: {from} – {to} · Time zone: {tz} · Source: {site}, worklog started date · Generated {generated}',
        notes: [
          'Client Reference normalised to TPX-#### (some Jira values were full URLs). Blank = no Client Reference set on the issue.',
          "'Issues' counts distinct issues each user logged time on in the period.",
        ],
      },
    ],
  },
  { id: 'builtin:issue-list', name: 'Issue list', sheets: [ISSUE_LIST_SHEET] },
];

/**
 * Starter → TemplateBody for one site. A field name the site does not have gives a warning and that column / group
 * level is skipped (a sheet left without group levels or columns is skipped too, with a warning).
 */
export function resolveStarter(starter: Pick<StarterTemplate, 'name' | 'sheets'>, fields: readonly FieldInfo[]): { template: TemplateBody; warnings: string[] } {
  const byName = new Map<string, string>();
  for (const f of fields) if (!byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f.id);
  const warnings: string[] = [];
  const resolve = (sheet: string, refs: readonly StarterRef[]) =>
    refs.flatMap((r) => {
      const fieldId = byName.get(r.field.toLowerCase());
      if (!fieldId) {
        warnings.push(`${starter.name} / ${sheet}: field "${r.field}" not found on this site; the column is skipped.`);
        return [];
      }
      return [{ fieldId, ...(r.label ? { label: r.label } : {}), ...(r.extract ? { extract: r.extract } : {}) }];
    });

  const sheets = starter.sheets.flatMap((s) => {
    const columns = resolve(s.name, s.columns ?? []);
    const rows = s.rows.mode === 'group' ? { mode: 'group', groupBy: resolve(s.name, s.rows.groupBy) } : s.rows;
    if (('groupBy' in rows && rows.groupBy.length === 0) || (rows.mode !== 'group' && columns.length === 0)) {
      warnings.push(`${starter.name} / ${s.name}: no usable fields on this site; the sheet is skipped.`);
      return [];
    }
    return [{ ...s, rows, columns }];
  });
  return { template: TemplateBodySchema.parse({ name: starter.name, sheets }), warnings };
}
