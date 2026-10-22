// Sheet options added for the team's "Summary" sheet: count columns, header style + title placeholders, notes,
// extract patterns, merged group cells; and the two-sheet "Team Client Report" starter (fixture Report_1.xlsx).
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ValueResolver, type CustomIssue, type CustomWorklog } from '../src/services/custom/engine.js';
import { NOTES_HEADING, templateSheet, TITLE_TABLE_HEADER_ROW, type WorkbookReport } from '../src/services/custom/export.js';
import { buildFieldList, type FieldInfo } from '../src/services/custom/fields.js';
import { resolveStarter, STARTER_TEMPLATES } from '../src/services/custom/presets.js';
import { runTemplate, type GroupSheetResult, type TemplateData } from '../src/services/custom/sheets.js';
import { groupTable } from '../src/services/custom/table.js';
import { SheetSchema, TemplateBodySchema } from '../src/services/custom/template.js';
import { applyExtract, extractProblem, fillPlaceholders, formatGenerated, MAX_EXTRACT, siteHost } from '../src/services/custom/text.js';
import { buildTemplateWorkbook } from '../src/services/customExcel.js';
import { draftToSheet, newSheet, sheetToDraft, type SheetDraft } from '../web/advance/template-logic.js';

const H = 3600;
const CF = 'customfield_10820';
const FIELDS: FieldInfo[] = buildFieldList([
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
]);
const TYPES = new Map(FIELDS.map((f) => [f.id, f.schemaType]));
const NAMES = new Map(FIELDS.map((f) => [f.id, f.name]));
const SAMPLE = fileURLToPath(new URL('./fixtures/Report_1.xlsx', import.meta.url));

const story = (key: string, summary: string, ref: string | null): CustomIssue => ({
  key,
  fields: { summary, issuetype: { name: 'Story', hierarchyLevel: 0 }, [CF]: ref },
});
const ISSUES: CustomIssue[] = [
  story('IOIA-1', 'Checkout', 'TPX-1162'),
  // Some Jira values are full URLs.
  story('IOIA-2', 'Pricing', 'https://tpx.example.com/browse/TPX-1378?focus=1'),
  story('IOIA-3', 'Stand-ups', null),
  { key: 'IOIA-4', fields: { summary: 'Checkout tests', issuetype: { name: 'Sub-task', subtask: true }, parent: { key: 'IOIA-1' }, [CF]: 'TPX-1162' } },
];

let n = 0;
function wl(accountId: string, user: string, issueKey: string, date: string, hours: number): CustomWorklog {
  return {
    id: String(++n),
    date,
    accountId,
    user,
    issueKey,
    summary: '',
    project: 'IOIA',
    seconds: hours * H,
    started: `${date}T10:00:00.000+0600`,
    created: `${date}T18:00:00.000+0600`,
    createdDate: date,
    comment: '',
    attributedTo: issueKey,
  };
}

/** Alice: IOIA-1 2h + 1h, IOIA-2 1h, IOIA-4 (sub-task of IOIA-1) 0.5h; Bob: IOIA-1 3h, IOIA-3 0.5h. 8h, 6 worklogs. */
function worklogs(): CustomWorklog[] {
  n = 0;
  return [
    wl('a', 'Alice', 'IOIA-1', '2026-09-01', 2),
    wl('a', 'Alice', 'IOIA-1', '2026-09-02', 1),
    wl('a', 'Alice', 'IOIA-2', '2026-09-02', 1),
    wl('a', 'Alice', 'IOIA-4', '2026-09-03', 0.5),
    wl('b', 'Bob', 'IOIA-1', '2026-09-01', 3),
    wl('b', 'Bob', 'IOIA-3', '2026-09-03', 0.5),
  ];
}

function report(sheets: object[], extra: Partial<WorkbookReport> = {}, name = 'Team Client Report'): WorkbookReport & { site: string } {
  const template = TemplateBodySchema.parse({ name, sheets });
  const all = worklogs();
  const data: TemplateData = {
    from: '2026-09-01',
    to: '2026-09-30',
    timeZone: 'Asia/Dhaka',
    worklogs: all,
    resolver: new ValueResolver(new Map(ISSUES.map((i) => [i.key, i])), TYPES),
    fieldNames: NAMES,
  };
  return {
    site: 'pm23',
    from: '2026-09-01',
    to: '2026-09-30',
    filter: { from: '2026-09-01', to: '2026-09-30', projects: ['IOIA'], authors: [] },
    template,
    fields: FIELDS,
    sheets: runTemplate(data, template),
    worklogs: all,
    timeZone: 'Asia/Dhaka',
    hoursPerDay: 8,
    retrievedAt: '2026-10-05T04:30:00Z',
    complete: true,
    failedIssueKeys: [],
    ...extra,
  };
}

const USER = { fieldId: 'worklog.author', label: 'User' };
const group = (groupBy: unknown[], more: object = {}) => ({ name: 'Report', rows: { mode: 'group', groupBy }, ...more });
const sheetError = (s: object) => {
  const r = SheetSchema.safeParse(s);
  return r.success ? undefined : r.error.issues.map((i) => i.message).join('; ');
};
const tableRows = (r: WorkbookReport, i = 0) => groupTable(r.sheets[i] as GroupSheetResult).rows.map((x) => x.cells);

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const back = new ExcelJS.Workbook();
  await back.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return back;
}
const values = (ws: ExcelJS.Worksheet, r: number, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const v = ws.getCell(r, i + 1).value;
    return v === null || v === undefined ? '' : v;
  });

describe('schema', () => {
  it('count columns: group sheets only; Hours still not in group sheets; never in group by or a condition', () => {
    expect(sheetError(group([USER], { columns: ['metric.issueCount', { fieldId: 'metric.worklogCount', label: 'Logs' }] }))).toBeUndefined();
    expect(sheetError(group([USER], { columns: ['metric.hours'] }))).toMatch(/hours are already shown/);
    expect(sheetError({ name: 'S', rows: { mode: 'eachWorklog' }, columns: ['metric.issueCount'] })).toMatch(/only available in group sheets/);
    expect(sheetError({ name: 'S', rows: { mode: 'eachIssue' }, columns: ['metric.hours', 'metric.worklogCount'] })).toMatch(/only available in group sheets/);
    expect(sheetError(group(['metric.issueCount']))).toMatch(/cannot be grouped by/);
    expect(sheetError(group(['status'], { filter: { conditions: [{ fieldId: 'metric.issueCount', op: 'isEmpty' }] } }))).toMatch(/filter/);
  });

  it('extract: trimmed, blank = none, at most 200 chars, must compile, not on numbers', () => {
    const parsed = SheetSchema.parse(group([{ fieldId: 'status', extract: '  ' }], { columns: [{ fieldId: CF, extract: ' TPX-\\d+ ' }] }));
    expect(parsed.rows).toEqual({ mode: 'group', groupBy: [{ fieldId: 'status' }] });
    expect(parsed.columns).toEqual([{ fieldId: CF, extract: 'TPX-\\d+' }]);
    expect(sheetError(group(['status'], { columns: [{ fieldId: CF, extract: 'x'.repeat(MAX_EXTRACT + 1) }] }))).toMatch(/at most 200/);
    expect(sheetError(group(['status'], { columns: [{ fieldId: CF, extract: 'TPX-(\\d+' }] }))).toMatch(/not a valid regular expression/);
    expect(sheetError(group(['status'], { columns: [{ fieldId: 'metric.issueCount', extract: '\\d' }] }))).toMatch(/numbers cannot/);
    expect(extractProblem('[')).toMatch(/not a valid regular expression/);
    expect(extractProblem('TPX-\\d+')).toBeUndefined();
  });

  it('header style: standard by default; title needs a title; title / subtitle only with the title style', () => {
    expect(SheetSchema.parse(group(['status']))).toMatchObject({ headerStyle: 'standard', notes: [], mergeGroupCells: false });
    expect(SheetSchema.parse(group(['status']))).not.toHaveProperty('title', expect.anything());
    expect(sheetError(group(['status'], { headerStyle: 'title' }))).toMatch(/a title is required/);
    expect(sheetError(group(['status'], { headerStyle: 'title', title: '   ' }))).toMatch(/a title is required/);
    expect(sheetError(group(['status'], { headerStyle: 'none', title: 'T' }))).toMatch(/needs header style "title"/);
    expect(sheetError(group(['status'], { headerStyle: 'title', title: 'T', subtitle: 'x'.repeat(201) }))).toMatch(/at most 200/);
    expect(SheetSchema.parse(group(['status'], { headerStyle: 'title', title: ' T ', subtitle: '' }))).toMatchObject({ title: 'T', subtitle: undefined });
  });

  it('notes: trimmed, blank lines dropped, at most 10 lines of 500 chars', () => {
    expect(SheetSchema.parse(group(['status'], { notes: [' a ', '', '  ', 'b'] })).notes).toEqual(['a', 'b']);
    expect(sheetError(group(['status'], { notes: Array(11).fill('x') }))).toMatch(/at most 10 note lines/);
    expect(sheetError(group(['status'], { notes: ['x'.repeat(501)] }))).toMatch(/at most 500/);
  });

  it('mergeGroupCells: group sheets only', () => {
    expect(SheetSchema.parse(group(['status'], { mergeGroupCells: true })).mergeGroupCells).toBe(true);
    expect(sheetError({ name: 'S', rows: { mode: 'eachWorklog' }, columns: ['metric.hours'], mergeGroupCells: true })).toMatch(/merged group cells/);
  });
});

describe('extract', () => {
  it('group 1 if the pattern has one, else the whole match; no / empty match = unchanged', () => {
    const re = (s: string) => new RegExp(s);
    expect(applyExtract(re('TPX-\\d+'), 'https://x/browse/TPX-1378?focus=1')).toBe('TPX-1378');
    expect(applyExtract(re('browse/(TPX-\\d+)'), 'https://x/browse/TPX-1378')).toBe('TPX-1378');
    expect(applyExtract(re('(TPX)?-\\d+'), 'ABC-12')).toBe('-12'); // group 1 did not take part: the whole match
    expect(applyExtract(re('TPX-\\d+'), 'no reference')).toBe('no reference');
    expect(applyExtract(re('x*'), 'abc')).toBe('abc');
    expect(applyExtract(undefined, 'abc')).toBe('abc');
    expect(applyExtract(re('.'), '')).toBe('');
  });

  it('a column: the URL becomes TPX-1378; blank stays blank', () => {
    const r = report([group([{ fieldId: 'issue.key' }], { columns: [{ fieldId: CF, extract: 'TPX-\\d+' }], totalColumns: 'lastLevel' })]);
    expect(tableRows(r).map((c) => c.slice(0, 2))).toEqual([
      ['IOIA-1', 'TPX-1162'],
      ['IOIA-2', 'TPX-1378'],
      ['IOIA-3', ''],
      ['IOIA-4', 'TPX-1162'],
      ['Total', ''],
    ]);
  });

  it('a group level: applied before grouping, so a URL and the plain reference form one group', () => {
    const r = report([group([{ fieldId: CF, label: 'Ref', extract: 'TPX-\\d+' }], { totalColumns: 'lastLevel' })]);
    const sheet = r.sheets[0] as GroupSheetResult;
    expect(sheet.tree.nodes.map((x) => [x.label, x.total / H])).toEqual([
      ['TPX-1162', 6.5],
      ['TPX-1378', 1],
      ['(none)', 0.5],
    ]);
    const unchanged = report([group([CF], { totalColumns: 'lastLevel' })]).sheets[0] as GroupSheetResult;
    expect(unchanged.tree.nodes.map((x) => x.label)).toEqual(['https://tpx.example.com/browse/TPX-1378?focus=1', 'TPX-1162', '(none)']);
  });

  it('flat sheets too (text cells only)', () => {
    const r = report([{ name: 'Issues', rows: { mode: 'eachIssue' }, columns: ['issue.key', { fieldId: CF, extract: 'TPX-(\\d+)' }, 'metric.hours'] }]);
    const sheet = r.sheets[0]!;
    expect(sheet.mode === 'eachIssue' && sheet.rows.map((x) => x.cells)).toEqual([
      ['IOIA-4', '1162', 0.5 * H],
      ['IOIA-3', '', 0.5 * H],
      ['IOIA-2', '1378', H],
      ['IOIA-1', '1162', 6 * H],
    ]);
  });
});

describe('count columns', () => {
  const summary = (more: object = {}) =>
    group([USER], { columns: [{ fieldId: 'metric.issueCount', label: 'Issues' }, { fieldId: 'metric.worklogCount', label: 'Logs' }], totalColumns: 'lastLevel', ...more });

  it('distinct issues / worklogs per row; the Total row counts distinct issues overall (not the sum)', () => {
    const r = report([summary()]);
    expect(r.sheets[0]!.headers.columns).toEqual(['Issues', 'Logs']);
    // Alice: IOIA-1, -2, -4; Bob: IOIA-1, -3. Overall 4 distinct issues (3 + 2 = 5 would double-count IOIA-1).
    expect(tableRows(r)).toEqual([
      ['Alice', 3, 4, 4.5 * H],
      ['Bob', 2, 2, 3.5 * H],
      ['Total', 4, 6, 8 * H],
    ]);
  });

  it('after sub-task rollup: IOIA-4 counts as IOIA-1', () => {
    expect(tableRows(report([summary({ sumSubtasksToParent: true })]))).toEqual([
      ['Alice', 2, 4, 4.5 * H],
      ['Bob', 2, 2, 3.5 * H],
      ['Total', 3, 6, 8 * H],
    ]);
  });

  it('subtotal rows and everyLevel: counts per group; text columns stay blank in subtotal / Total rows', () => {
    const r = report([
      group(['worklog.author', 'issue.key'], {
        columns: ['metric.issueCount', CF],
        totalColumns: 'lastLevel',
        subtotalRows: true,
      }),
    ]);
    expect(tableRows(r)).toEqual([
      ['Alice', 'IOIA-1', 1, 'TPX-1162', 3 * H],
      ['', 'IOIA-2', 1, 'https://tpx.example.com/browse/TPX-1378?focus=1', H],
      ['', 'IOIA-4', 1, 'TPX-1162', 0.5 * H],
      ['Alice Total', '', 3, '', 4.5 * H],
      ['Bob', 'IOIA-1', 1, 'TPX-1162', 3 * H],
      ['', 'IOIA-3', 1, '', 0.5 * H],
      ['Bob Total', '', 2, '', 3.5 * H],
      ['Total', '', 4, '', 8 * H],
    ]);
    const every = report([group([USER], { columns: ['metric.worklogCount'] })]);
    expect(tableRows(every)).toEqual([
      ['Alice', 4.5 * H, 4],
      ['Bob', 3.5 * H, 2],
      ['Total', 8 * H, 6],
    ]);
  });

  it('Excel: counts are plain numbers (not converted to hours or days)', () => {
    const r = report([summary({ format: 'days' })]);
    const rows = templateSheet(r, r.sheets[0]!).rows.slice(7);
    expect(rows.slice(0, 4).map((x) => x.slice(0, 4))).toEqual([
      ['User', 'Issues', 'Logs', 'Total'],
      ['Alice', 3, 4, 0.56],
      ['Bob', 2, 2, 0.44],
      ['Total', 4, 6, 1],
    ]);
  });
});

describe('header style, title placeholders and notes', () => {
  const titled = {
    headerStyle: 'title',
    title: '{projects} — Worklog Summary',
    subtitle: 'Period: {from} – {to} · Time zone: {tz} · Source: {site} · Generated {generated} · {users} · {unknown}',
  };

  it('placeholders: known ones filled, anything else left as typed', () => {
    const v = { projects: 'P', from: 'F', to: 'T', tz: 'Z', site: 'S', generated: 'G', users: 'U' };
    expect(fillPlaceholders('{projects}|{from}|{to}|{tz}|{site}|{generated}|{users}|{x}|{ projects }', v)).toBe('P|F|T|Z|S|G|U|{x}|{ projects }');
    expect(formatGenerated('2026-10-05T04:30:00Z', 'Asia/Dhaka')).toBe('05-Oct-2026 10:30');
    expect(formatGenerated('nope', 'Asia/Dhaka')).toBe('nope');
    expect(siteHost('https://pm23.atlassian.net')).toBe('pm23.atlassian.net');
  });

  it('title: row 1 title, row 2 subtitle, row 3 blank, table header in row 4 (frozen there)', () => {
    const r = report([group([USER], { totalColumns: 'lastLevel', ...titled })], { filter: { from: '2026-09-01', to: '2026-09-30', projects: ['IOIA'], authors: ['b'] } });
    const l = templateSheet(r, r.sheets[0]!, { projects: { IOIA: 'Institute of Internal Auditors' } }, { siteUrl: 'https://pm23.atlassian.net' });
    expect(l.rows.slice(0, 3)).toEqual([
      ['Institute of Internal Auditors — Worklog Summary'],
      ['Period: 2026-09-01 – 2026-09-30 · Time zone: Asia/Dhaka · Source: pm23.atlassian.net · Generated 05-Oct-2026 10:30 · Bob · {unknown}'],
      [],
    ]);
    expect(TITLE_TABLE_HEADER_ROW).toBe(4);
    expect(l.rows[3]).toEqual(['User', 'Total']);
    expect(l).toMatchObject({ titleRow: 1, subtitleRow: 2, freezeRows: 4, merges: [], boldRows: [4, 7] });
    // No site URL: the site key.
    expect(templateSheet(r, r.sheets[0]!).rows[1]![0]).toContain('Source: pm23 ·');
  });

  it('title without subtitle; incomplete: the warning in row 3, merged across the table', () => {
    const r = report([group([USER], { totalColumns: 'lastLevel', headerStyle: 'title', title: 'T' })], { complete: false, failedIssueKeys: ['IOIA-9'] });
    const l = templateSheet(r, r.sheets[0]!);
    expect(l.rows[1]).toEqual([]);
    expect(String(l.rows[2]![0])).toMatch(/^⚠ Incomplete report .*IOIA-9/);
    expect(l).toMatchObject({ warningRow: 3, merges: [[3, 1, 3, 2]], freezeRows: 4 });
  });

  it('none: the table from row 1; incomplete: warning row 1, table from row 3', () => {
    const sheet = group([USER], { totalColumns: 'lastLevel', headerStyle: 'none' });
    const l = templateSheet(report([sheet]), report([sheet]).sheets[0]!);
    expect(l.rows[0]).toEqual(['User', 'Total']);
    expect(l).toMatchObject({ freezeRows: 1, boldRows: [1, 4], merges: [] });
    const inc = report([sheet], { complete: false, failedIssueKeys: ['IOIA-9'] });
    const li = templateSheet(inc, inc.sheets[0]!);
    expect(li.rows[1]).toEqual([]);
    expect(li.rows[2]).toEqual(['User', 'Total']);
    expect(li).toMatchObject({ warningRow: 1, freezeRows: 3 });
  });

  it('standard stays rows 1–6 + table from row 8; notes: blank row, bold "Notes", one line each, below the Total row', () => {
    const r = report([group([USER], { totalColumns: 'lastLevel', notes: ['First note.', 'Second note.'] })]);
    const l = templateSheet(r, r.sheets[0]!);
    expect(l.rows[0]!.slice(0, 1)).toEqual(['From']);
    expect(l.freezeRows).toBe(8);
    // Header 8, Alice 9, Bob 10, Total 11, blank 12, Notes 13, lines 14–15.
    expect(l.rows.slice(10)).toEqual([['Total', 8], [], [NOTES_HEADING], ['First note.'], ['Second note.']]);
    expect(l.boldCells).toContainEqual([13, 1]);
    expect(l.boldRows).not.toContain(14);
  });

  it('workbook: title 14pt bold, subtitle 9pt, Notes bold', async () => {
    const r = report([group([USER], { totalColumns: 'lastLevel', ...titled, notes: ['n1'] })]);
    const ws = (await roundTrip(buildTemplateWorkbook(r))).worksheets[0]!;
    expect(ws.getCell(1, 1).font).toMatchObject({ bold: true, size: 14 });
    expect(ws.getCell(2, 1).font).toMatchObject({ size: 9 });
    expect(values(ws, 4, 2)).toEqual(['User', 'Total']);
    expect(values(ws, 9, 1)).toEqual([NOTES_HEADING]);
    expect(ws.getCell(9, 1).font?.bold).toBe(true);
    expect(values(ws, 10, 1)).toEqual(['n1']);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
  });
});

describe('mergeGroupCells', () => {
  it('everyLevel: a parent value and its "Total <level>" cell merged down the group rows; one-row groups are not merged', async () => {
    const r = report([group(['worklog.author', 'issue.key'], { mergeGroupCells: true })]);
    const l = templateSheet(r, r.sheets[0]!);
    // Header row 8; Alice rows 9–11 (IOIA-1, -2, -4), Bob rows 12–13.
    expect(l.groupMerges).toEqual([
      [9, 1, 11, 1],
      [9, 2, 11, 2],
      [12, 1, 13, 1],
      [12, 2, 13, 2],
    ]);
    const ws = (await roundTrip(buildTemplateWorkbook(r))).worksheets[0]!;
    expect(ws.model.merges).toEqual(expect.arrayContaining(['A9:A11', 'B9:B11', 'A12:A13', 'B12:B13']));
    expect(ws.getCell('A9').alignment).toMatchObject({ vertical: 'top' });
    expect(ws.getCell('A9').value).toBe('Alice');
    expect(ws.getCell('B9').value).toBe(4.5);
    const one = report([group(['worklog.author', 'issue.key'], { mergeGroupCells: true })]);
    expect(templateSheet(one, one.sheets[0]!).groupMerges.every(([r1, , r2]) => r2 > r1)).toBe(true);
  });

  it('lastLevel: the level column only; with subtotal rows the subtotal row is not part of the merge', () => {
    const r = report([group(['worklog.author', 'issue.key'], { totalColumns: 'lastLevel', subtotalRows: true, mergeGroupCells: true })]);
    const l = templateSheet(r, r.sheets[0]!);
    // Alice 9–11, "Alice Total" 12, Bob 13–14, "Bob Total" 15.
    expect(l.groupMerges).toEqual([
      [9, 1, 11, 1],
      [13, 1, 14, 1],
    ]);
  });

  it('off by default: no merges', () => {
    const r = report([group(['worklog.author', 'issue.key'])]);
    expect(templateSheet(r, r.sheets[0]!).groupMerges).toEqual([]);
  });
});

describe('"Team Client Report" starter (Report + Summary)', () => {
  const starter = STARTER_TEMPLATES.find((t) => t.id === 'builtin:team-client-report')!;
  const resolved = () => resolveStarter(starter, FIELDS);

  it('resolves to the two sheets with their labels, extract and options', () => {
    const { template, warnings } = resolved();
    expect(warnings).toEqual([]);
    expect(template.sheets.map((s) => s.name)).toEqual(['Report', 'Summary']);
    expect(template.sheets[0]).toMatchObject({
      rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, { fieldId: 'issue.keySummary', label: 'Issue' }] },
      columns: [{ fieldId: CF, label: 'Client Reference', extract: 'TPX-\\d+' }],
      totalColumns: 'lastLevel',
      totalLabel: 'Hours',
      headerStyle: 'standard',
    });
    expect(template.sheets[1]).toMatchObject({
      rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }] },
      columns: [{ fieldId: 'metric.issueCount', label: 'Issues' }],
      totalColumns: 'lastLevel',
      totalLabel: 'Spent Hours',
      headerStyle: 'title',
      title: '{projects} — Worklog Summary',
      subtitle: 'Period: {from} – {to} · Time zone: {tz} · Source: {site}, worklog started date · Generated {generated}',
      notes: [
        'Client Reference normalised to TPX-#### (some Jira values were full URLs). Blank = no Client Reference set on the issue.',
        "'Issues' counts distinct issues each user logged time on in the period.",
      ],
    });
  });

  it('labels are applied: Report headers are User | Issue | Client Reference | Hours (not "Worklog Author" / "Total Worklog Author")', () => {
    const r = report(resolved().template.sheets);
    const rows = templateSheet(r, r.sheets[0]!).rows;
    expect(rows[7]).toEqual(['User', 'Issue', 'Client Reference', 'Hours']);
    expect(rows[9]!.slice(0, 4)).toEqual(['', 'IOIA-2 Pricing', 'TPX-1378', 1]);
  });

  it('Summary matches the team sample (Report_1.xlsx): title, subtitle, header row 4, Total row, notes', async () => {
    const sample = new ExcelJS.Workbook();
    await sample.xlsx.readFile(SAMPLE);
    const ref = sample.getWorksheet('Summary')!;
    const r = report(resolved().template.sheets);
    const ws = (await roundTrip(buildTemplateWorkbook(r, { projects: { IOIA: 'IOIA' } }, { siteUrl: 'https://pm23.atlassian.net' }))).getWorksheet('Summary')!;

    expect(values(ws, 4, 3)).toEqual(values(ref, 4, 3)); // User | Issues | Spent Hours
    expect(String(ws.getCell(1, 1).value)).toBe('IOIA — Worklog Summary');
    expect(String(ws.getCell(2, 1).value)).toBe(
      'Period: 2026-09-01 – 2026-09-30 · Time zone: Asia/Dhaka · Source: pm23.atlassian.net, worklog started date · Generated 05-Oct-2026 10:30',
    );
    for (const cell of ['A1', 'A2']) expect(typeof ref.getCell(cell).value).toBe(typeof ws.getCell(cell).value);
    expect(ws.getCell(1, 1).font?.bold && ref.getCell(1, 1).font?.bold).toBe(true);
    expect(values(ws, 5, 3)).toEqual(['Alice', 3, 4.5]);
    expect(values(ws, 6, 3)).toEqual(['Bob', 2, 3.5]);
    expect(values(ws, 7, 3)).toEqual(['Total', 4, 8]); // 4 distinct issues, not 3 + 2
    expect(values(ref, 10, 1)).toEqual(values(ws, 7, 1));
    expect(values(ws, 9, 1)).toEqual([NOTES_HEADING]);
    expect(String(ws.getCell(10, 1).value)).toMatch(/^Client Reference normalised to TPX-####/);
    expect(String(ref.getCell(14, 1).value)).toMatch(/ClientReference normalised to TPX-####/);
    expect(String(ws.getCell(11, 1).value)).toBe(String(ref.getCell(15, 1).value).replace(/^• /, ''));
  });
});

describe('editor drafts', () => {
  it('round trip: extract, header style, title, notes, merge, counts', () => {
    const { template } = resolveStarter(STARTER_TEMPLATES.find((t) => t.id === 'builtin:team-client-report')!, FIELDS);
    for (const s of template.sheets) {
      const d = sheetToDraft(s, FIELDS);
      expect(SheetSchema.parse(draftToSheet(d, FIELDS).sheet)).toEqual(s);
    }
    const merged: SheetDraft = { ...newSheet('M', FIELDS), mergeGroupCells: true, notes: ' a \n\n b ' };
    expect(SheetSchema.parse(draftToSheet(merged, FIELDS).sheet)).toMatchObject({ mergeGroupCells: true, notes: ['a', 'b'] });
  });

  it('a title kept in the draft is not sent with another header style; problems name the sheet', () => {
    const d: SheetDraft = { ...newSheet('S', FIELDS), headerStyle: 'standard', title: 'Kept', subtitle: 'Kept too' };
    expect(draftToSheet(d, FIELDS).sheet).not.toHaveProperty('title');
    expect(draftToSheet({ ...d, headerStyle: 'title', title: ' ' }, FIELDS).error).toBe('Sheet "S": enter a title (header style "Title + subtitle").');
    const bad: SheetDraft = { ...newSheet('S', FIELDS), columns: [{ fieldId: CF, label: 'Ref', extract: 'TPX-(' }] };
    expect(draftToSheet(bad, FIELDS).error).toMatch(/^Sheet "S": "Ref": extract pattern is not a valid regular expression/);
    expect(draftToSheet({ ...bad, columns: [{ fieldId: 'metric.issueCount', label: '', extract: 'TPX-(' }] }, FIELDS).error).toBeUndefined();
  });
});
