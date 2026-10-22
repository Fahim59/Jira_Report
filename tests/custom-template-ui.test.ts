// Step E: the template editor's pure rules (web/advance/template-logic.ts), checked against the server schemas.
import { describe, expect, it } from 'vitest';
import { buildFieldList, type FieldInfo } from '../src/services/custom/fields.js';
import { contentDisposition } from '../src/services/custom/export.js';
import { resolveStarter, STARTER_TEMPLATES } from '../src/services/custom/presets.js';
import { GlobalFilterSchema, SheetSchema, TemplateBodySchema, type TemplateBody } from '../src/services/custom/template.js';
import { formatTimestamp, type ConditionDraft } from '../web/advance/logic.js';
import {
  buildGenerateBody,
  columnAllowed,
  conditionToDraft,
  draftKey,
  draftToBody,
  draftToSheet,
  duplicateSheet,
  filenameFromDisposition,
  HOURS_FIELD,
  initialTemplateId,
  newSheet,
  newTemplate,
  setMode,
  sheetNameProblem,
  templateNameProblem,
  templateToDraft,
  uniqueSheetName,
  type SheetDraft,
} from '../web/advance/template-logic.js';

const CF = 'customfield_10050';
const FIELDS: FieldInfo[] = buildFieldList([
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
  { id: 'customfield_10060', name: 'Reviewer', custom: true, schema: { type: 'user' } },
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: 'status', name: 'Status', schema: { type: 'status' } },
  { id: 'issuetype', name: 'Issue Type', schema: { type: 'issuetype' } },
  { id: 'assignee', name: 'Assignee', schema: { type: 'user' } },
]);

const starters = STARTER_TEMPLATES.map((s) => resolveStarter(s, FIELDS).template);
const filter = { site: 'one', from: '2026-09-01', to: '2026-09-29', projects: ['FFN'], authors: [] };

describe('drafts round-trip', () => {
  it.each(starters.map((t) => [t.name, t] as const))('built-in "%s": draft → body parses back to the same template', (_, t) => {
    const draft = templateToDraft(t, FIELDS);
    const { body, error } = draftToBody(draft, FIELDS);
    expect(error).toBeUndefined();
    expect(TemplateBodySchema.parse(body)).toEqual(t);
  });

  it('a template with every sheet option and condition kind survives the round trip', () => {
    const t: TemplateBody = TemplateBodySchema.parse({
      name: 'All options',
      defaults: { projects: ['FFN'], authors: ['acc-1'] },
      sheets: [
        {
          name: 'Grouped',
          rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, 'issue.keySummary'] },
          columns: [{ fieldId: CF, label: 'Client' }],
          totals: true,
          period: 'week',
          format: 'days',
          sort: 'totalDesc',
          sumSubtasksToParent: true,
          totalColumns: 'lastLevel',
          totalLabel: 'Hours',
          subtotalRows: true,
          filter: {
            conditions: [
              { fieldId: CF, op: 'in', value: ['A', 'B'] },
              { fieldId: 'assignee', op: 'is', value: 'acc-1' },
              { fieldId: 'customfield_10060', op: 'notIn', value: ['acc-1', 'acc-2'] },
              { fieldId: 'status', op: 'isNotEmpty' },
              { fieldId: 'summary', op: 'contains', value: 'login' },
            ],
            jql: 'status = Done',
          },
        },
        { name: 'Issues', rows: { mode: 'eachIssue' }, columns: ['issue.key', HOURS_FIELD], includeIssuesWithoutWorklogs: true, totals: false },
        { name: 'Logs', rows: { mode: 'eachWorklog' }, columns: ['worklog.started', HOURS_FIELD] },
      ],
    });
    const { body } = draftToBody(templateToDraft(t, FIELDS), FIELDS);
    expect(TemplateBodySchema.parse(body)).toEqual(t);
  });

  it('conditions → filter rows: user fields as accountIds, lists as "a, b"', () => {
    expect(conditionToDraft({ fieldId: CF, op: 'in', value: ['A', 'B'] }, FIELDS)).toEqual({ fieldId: CF, op: 'in', text: 'A, B', users: [] });
    expect(conditionToDraft({ fieldId: 'assignee', op: 'is', value: 'acc-1' }, FIELDS)).toEqual({ fieldId: 'assignee', op: 'is', text: '', users: ['acc-1'] });
    expect(conditionToDraft({ fieldId: 'status', op: 'isEmpty' }, FIELDS)).toEqual({ fieldId: 'status', op: 'isEmpty', text: '', users: [] });
  });

  it('draftKey (the unsaved-changes dot) ignores the name, sees every other edit', () => {
    const a = templateToDraft(starters[0]!, FIELDS);
    const b = structuredClone(a);
    b.name = 'Other';
    expect(draftKey(b)).toBe(draftKey(a));
    b.sheets[0]!.groupBy[0]!.label = 'Key';
    expect(draftKey(b)).not.toBe(draftKey(a));
    const c = structuredClone(a);
    c.defaults.projects = ['FFN'];
    expect(draftKey(c)).not.toBe(draftKey(a));
  });
});

describe('modes and options', () => {
  it('columnAllowed matches the server rules for every field and mode', () => {
    for (const mode of ['group', 'eachWorklog', 'eachIssue'] as const) {
      for (const f of FIELDS) {
        const rows = mode === 'group' ? { mode, groupBy: ['status'] } : { mode };
        const ok = SheetSchema.safeParse({ name: 'S', rows, columns: [f.id] }).success;
        expect([mode, f.id, columnAllowed(mode, f.id)]).toEqual([mode, f.id, ok]);
      }
    }
  });

  it('switching mode drops columns the new mode cannot show and fills what it needs', () => {
    const s: SheetDraft = { ...newSheet('S', FIELDS), columns: [{ fieldId: CF, label: '', extract: '' }] };
    const worklogs = setMode(s, 'eachWorklog', FIELDS);
    expect(worklogs.columns.map((c) => c.fieldId)).toEqual([CF]);
    const withLog = { ...worklogs, columns: [...worklogs.columns, { fieldId: 'worklog.comment', label: 'Comment', extract: '' }, { fieldId: HOURS_FIELD, label: '', extract: '' }] };
    expect(setMode(withLog, 'eachIssue', FIELDS).columns.map((c) => c.fieldId)).toEqual([CF, HOURS_FIELD]);
    expect(setMode(withLog, 'group', FIELDS).columns.map((c) => c.fieldId)).toEqual([CF, 'worklog.comment']);
    // An empty flat sheet gets Hours; group levels survive a round trip through a flat mode.
    expect(setMode(newSheet('S', FIELDS), 'eachIssue', FIELDS).columns).toEqual([{ fieldId: HOURS_FIELD, label: '', extract: '' }]);
    expect(setMode(setMode(s, 'eachIssue', FIELDS), 'group', FIELDS).groupBy).toEqual(s.groupBy);
  });

  it('options that do not apply to the mode are sent as defaults (never a validation error)', () => {
    const s: SheetDraft = {
      ...newSheet('Flat', FIELDS),
      mode: 'eachWorklog',
      columns: [{ fieldId: HOURS_FIELD, label: '', extract: '' }],
      period: 'month',
      totalColumns: 'lastLevel',
      totalLabel: 'Hours',
      subtotalRows: true,
      includeIssuesWithoutWorklogs: true,
      sort: 'totalDesc',
    };
    const { sheet } = draftToSheet(s, FIELDS);
    expect(SheetSchema.parse(sheet)).toMatchObject({ period: 'none', totalColumns: 'everyLevel', totalLabel: 'Total', subtotalRows: false, includeIssuesWithoutWorklogs: false });
    // Subtotal rows only with one total column and totals on.
    const g: SheetDraft = { ...newSheet('G', FIELDS), subtotalRows: true };
    expect(SheetSchema.parse(draftToSheet(g, FIELDS).sheet).subtotalRows).toBe(false);
    expect(SheetSchema.parse(draftToSheet({ ...g, totalColumns: 'lastLevel' }, FIELDS).sheet).subtotalRows).toBe(true);
    expect(SheetSchema.parse(draftToSheet({ ...g, totalColumns: 'lastLevel', totals: false }, FIELDS).sheet).subtotalRows).toBe(false);
  });

  it('labels: trimmed; blank = no label', () => {
    const s: SheetDraft = { ...newSheet('S', FIELDS), groupBy: [{ fieldId: 'status', label: '  State ', extract: '' }, { fieldId: 'summary', label: '   ', extract: '' }] };
    expect(SheetSchema.parse(draftToSheet(s, FIELDS).sheet).rows).toEqual({ mode: 'group', groupBy: [{ fieldId: 'status', label: 'State' }, { fieldId: 'summary' }] });
  });
});

describe('validation messages name the sheet', () => {
  const draft = (sheets: Partial<SheetDraft>[]) => ({ ...newTemplate(FIELDS), sheets: sheets.map((s) => ({ ...newSheet('S', FIELDS), ...s })) });
  const cond = (d: Partial<ConditionDraft>): ConditionDraft => ({ fieldId: CF, op: 'is', text: '', users: [], ...d });

  it.each([
    [[{ name: '' }], 'Sheet "(no name)": a sheet name is required.'],
    [[{ name: 'A/B' }], 'Sheet "A/B": sheet names cannot contain : \\ / ? * [ ].'],
    [[{ name: 'x'.repeat(32) }], `Sheet "${'x'.repeat(32)}": sheet names can have at most 31 characters.`],
    [[{ name: 'Same' }, { name: ' same ' }], 'Sheet name "same" is used twice. Sheet names must be unique (ignoring case).'],
    [[{ groupBy: [] }], 'Sheet "S": choose at least one Group by field.'],
    [[{ groupBy: [{ fieldId: 'status', label: '' }, { fieldId: 'status', label: 'x' }] }], 'Sheet "S": each Group by field can be used only once.'],
    [[{ mode: 'eachIssue', columns: [] }], 'Sheet "S": choose at least one column.'],
    [[{ mode: 'eachIssue', columns: [{ fieldId: 'worklog.comment', label: '' }] }], 'Sheet "S": column "Worklog Comment" is not available in this row mode.'],
    [[{ conditions: [cond({ text: ' ' })] }], 'Sheet "S": Filter 1 (Client Reference): enter a value.'],
    [[], 'A template needs at least one sheet.'],
  ] as [Partial<SheetDraft>[], string][])('%j', (sheets, msg) => {
    expect(draftToBody(draft(sheets), FIELDS).error).toBe(msg);
  });

  it('sheet and template names', () => {
    expect(sheetNameProblem("'quoted'")).toBe('sheet names cannot start or end with an apostrophe');
    expect(sheetNameProblem('Work logs')).toBeUndefined();
    expect(templateNameProblem('  ')).toBe('Please enter a template name.');
    expect(templateNameProblem('x'.repeat(101))).toBe('Template names can have at most 100 characters.');
  });
});

describe('sheet list helpers', () => {
  it('uniqueSheetName: case-insensitive, numbered, at most 31 characters', () => {
    expect(uniqueSheetName('Sheet', ['Report'])).toBe('Sheet');
    expect(uniqueSheetName('Report', ['report', 'Report (2)'])).toBe('Report (3)');
    expect(uniqueSheetName('Report (2)', ['Report', 'Report (2)'])).toBe('Report (3)');
    const long = 'x'.repeat(31);
    expect(uniqueSheetName(long, [long])).toBe(`${'x'.repeat(27)} (2)`);
  });

  it('duplicateSheet: a deep copy right after the original, with a free name; capped at 10 sheets', () => {
    const sheets = [newSheet('A', FIELDS), newSheet('B', FIELDS)];
    const out = duplicateSheet(sheets, 0);
    expect(out.map((s) => s.name)).toEqual(['A', 'A (2)', 'B']);
    out[1]!.groupBy[0]!.label = 'changed';
    expect(sheets[0]!.groupBy[0]!.label).toBe('');
    const ten = Array.from({ length: 10 }, (_, i) => newSheet(`S${i}`, FIELDS));
    expect(duplicateSheet(ten, 0)).toHaveLength(10);
  });
});

describe('Generate request', () => {
  it('Time Reports style: the body passes the server schemas (global filter + inline template)', () => {
    const { body, error } = buildGenerateBody(filter, templateToDraft(starters[0]!, FIELDS), FIELDS, 31);
    expect(error).toBeUndefined();
    expect(GlobalFilterSchema.parse(body!.filter)).toEqual({ site: 'one', from: '2026-09-01', to: '2026-09-29', projects: ['FFN'], authors: [], zone: 'server' });
    expect(TemplateBodySchema.parse(body!.template)).toEqual(starters[0]);
  });

  it.each([
    [{ from: '' }, 'Please choose both From and To dates.'],
    [{ from: '2026-09-30', to: '2026-09-01' }, 'Invalid range: From must be on or before To.'],
    [{ to: '2026-10-05' }, 'Invalid range: 35 days selected; the maximum is 31. Choose a shorter range.'],
  ])('global filter %j', (f, msg) => {
    expect(buildGenerateBody({ ...filter, ...f }, templateToDraft(starters[0]!, FIELDS), FIELDS, 31).error).toBe(msg);
  });

  it('"Issue list" (issues without time) needs a project, like the server', () => {
    const issueList = templateToDraft(starters[2]!, FIELDS);
    expect(buildGenerateBody({ ...filter, projects: [] }, issueList, FIELDS, 31).error).toBe(
      'Sheet "Issues" also lists issues without time, which needs at least one project. Pick one or more projects in the filter.',
    );
    expect(buildGenerateBody(filter, issueList, FIELDS, 31).error).toBeUndefined();
  });
});

describe('template list and download', () => {
  const item = (id: string, builtIn: boolean, isDefault = false) => ({ id, builtIn, isDefault });

  it('initialTemplateId: the saved default, else none (a new blank template opens)', () => {
    expect(initialTemplateId([item('x', false), item('y', false, true)])).toBe('y');
    expect(initialTemplateId([item('builtin:a', true, true), item('x', false)])).toBeUndefined(); // built-ins are not offered here
    expect(initialTemplateId([item('x', false)])).toBeUndefined();
    expect(initialTemplateId([])).toBeUndefined();
  });

  it("filenameFromDisposition reads the server's filename* (Unicode kept), else the ASCII name", () => {
    const name = 'Time Reports — Ünïcode_2026-09-01_2026-09-29.xlsx';
    expect(filenameFromDisposition(contentDisposition(name), 'x.xlsx')).toBe(name);
    expect(filenameFromDisposition('attachment; filename="a.xlsx"', 'x.xlsx')).toBe('a.xlsx');
    expect(filenameFromDisposition(null, 'x.xlsx')).toBe('x.xlsx');
  });

  it('formatTimestamp shows the REPORT_TZ wall-clock time, like the .xlsx', () => {
    expect(formatTimestamp('2026-09-01T10:00:00.000+0600', 'Asia/Dhaka')).toBe('01-Sep-2026 10:00:00');
    expect(formatTimestamp('2026-08-31T23:30:00.000-0500', 'Asia/Dhaka')).toBe('01-Sep-2026 10:30:00');
    expect(formatTimestamp('not a date', 'Asia/Dhaka')).toBe('not a date');
  });
});
