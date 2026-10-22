import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JiraClient } from '../src/jira/client.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { customExportRoutes } from '../src/routes/customExport.js';
import { compareIssueKeysDesc, ValueResolver, type CustomIssue, type CustomWorklog } from '../src/services/custom/engine.js';
import {
  contentDisposition,
  DATETIME_FMT,
  describeSheetFilters,
  excelDateTime,
  filenameSafe,
  periodLabel as serverPeriodLabel,
  TABLE_HEADER_ROW,
  templateFilename,
  templateSheet,
  type WorkbookReport,
} from '../src/services/custom/export.js';
import { buildFieldList, type FieldInfo } from '../src/services/custom/fields.js';
import { ISSUE_LIST_SHEET, resolveStarter, STARTER_TEMPLATES, WORK_LOGS_SHEET, type StarterSheet } from '../src/services/custom/presets.js';
import { runTemplate, type TemplateData } from '../src/services/custom/sheets.js';
import { TemplateBodySchema } from '../src/services/custom/template.js';
import { buildTemplateWorkbook } from '../src/services/customExcel.js';
import { periodLabel as webPeriodLabel } from '../web/advance/logic.js';

const H = 3600;
const CF = 'customfield_10050';
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
/** Team sample from the other tool (View A): table structure reference. */
const SAMPLE = fixturePath('Report 2.xlsx');
/** Accepted output of this exporter (author → issue, Client Reference): the format to keep. */
const REPORT_1 = fixturePath('Report 1.xlsx');
/** Jira's own issue CSV export (FFN): the "Issue list" columns. */
const JIRA_CSV = fixturePath('Jira.csv');

/** The site's field list: pseudo-fields plus Summary and Client Reference. */
const FIELDS: FieldInfo[] = buildFieldList([
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  { id: CF, name: 'Client Reference', custom: true, schema: { type: 'string' } },
]);
const TYPES = new Map(FIELDS.map((f) => [f.id, f.schemaType]));
const NAMES = new Map(FIELDS.map((f) => [f.id, f.name]));

const ISSUES: CustomIssue[] = [
  { key: 'FFN-1', fields: { summary: 'Login', status: { name: 'Done' }, project: { key: 'FFN', name: 'FloraFire' }, [CF]: 'TPX-1' } },
  { key: 'FFN-2', fields: { summary: 'Logout', status: { name: 'QA' }, project: { key: 'FFN', name: 'FloraFire' }, [CF]: 'TPX-2' } },
  { key: 'FFN-3', fields: { summary: 'Search', status: { name: 'Done' }, project: { key: 'FFN', name: 'FloraFire' }, [CF]: 'TPX-3' } },
];

let n = 0;
function wl(accountId: string, user: string, issueKey: string, started: string, hours: number, comment = ''): CustomWorklog {
  return {
    id: String(++n),
    date: started.slice(0, 10),
    accountId,
    user,
    issueKey,
    summary: ISSUES.find((i) => i.key === issueKey)!.fields!.summary as string,
    project: 'FFN',
    seconds: hours * H,
    started,
    created: '2026-09-10T08:00:00.000+0600',
    createdDate: '2026-09-10',
    comment,
    attributedTo: issueKey,
  };
}

/** Alice: FFN-1 2h + 1.5h (Done), FFN-2 1h (QA); Bob: FFN-1 3h (Done), FFN-3 0.5h (Done). 8h in all. */
function worklogs(): CustomWorklog[] {
  n = 0;
  return [
    wl('a', 'Alice', 'FFN-1', '2026-09-01T10:00:00.000+0600', 2, 'Built the form'),
    wl('a', 'Alice', 'FFN-1', '2026-09-02T09:30:00.000+0600', 1.5),
    wl('a', 'Alice', 'FFN-2', '2026-09-02T14:00:00.000+0600', 1),
    wl('b', 'Bob', 'FFN-1', '2026-09-01T11:00:00.000+0600', 3),
    wl('b', 'Bob', 'FFN-3', '2026-09-03T16:15:00.000+0600', 0.5),
  ];
}

/** A displayed template report (as POST /api/custom-report returns it) for `sheets`. */
function report(
  sheets: object[],
  extra: Partial<WorkbookReport> = {},
  opts: { name?: string; issues?: CustomIssue[]; data?: Partial<TemplateData>; worklogs?: CustomWorklog[] } = {},
): WorkbookReport & { site: string } {
  const template = TemplateBodySchema.parse({ name: opts.name ?? 'Time Reports style', sheets });
  const all = opts.worklogs ?? worklogs();
  const resolver = new ValueResolver(new Map((opts.issues ?? ISSUES).map((i) => [i.key, i])), TYPES);
  const data: TemplateData = { from: '2026-09-01', to: '2026-09-03', timeZone: 'Asia/Dhaka', worklogs: all, resolver, fieldNames: NAMES, ...opts.data };
  return {
    site: 'one',
    from: '2026-09-01',
    to: '2026-09-03',
    filter: { from: '2026-09-01', to: '2026-09-03', projects: ['FFN'], authors: [] },
    template,
    fields: FIELDS,
    sheets: runTemplate(data, template),
    worklogs: all,
    timeZone: 'Asia/Dhaka',
    hoursPerDay: 8,
    retrievedAt: '2026-10-07T10:00:05+06:00',
    complete: true,
    failedIssueKeys: [],
    ...extra,
  };
}

const group = (groupBy: unknown[], more: object = {}) => ({ name: 'Report', rows: { mode: 'group', groupBy }, ...more });
const THREE_LEVELS = group(['project', 'worklog.author', 'status']);
/** Starter sheet → plain sheet input (field names → ids for this site). */
const preset = (s: StarterSheet, more: object = {}) => {
  const { template } = resolveStarter({ name: 'x', sheets: [s] }, FIELDS);
  return { ...template.sheets[0]!, ...more };
};

/** First sheet's layout. */
const layoutOf = (r: WorkbookReport, i = 0) => templateSheet(r, r.sheets[i]!);
/** Rows from row 8 on. */
const tableOf = (rows: unknown[][]) => rows.slice(TABLE_HEADER_ROW - 1);

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const back = new ExcelJS.Workbook();
  await back.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return back;
}

const rowValues = (ws: ExcelJS.Worksheet, r: number, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const v = ws.getCell(r, i + 1).value;
    return v === null || v === undefined ? '' : v;
  });
const shape = (ws: ExcelJS.Worksheet, r: number, count: number) =>
  rowValues(ws, r, count).map((v) => (typeof v === 'number' ? 'n' : v === '' ? '' : 's'));
const bold = (ws: ExcelJS.Worksheet, r: number, count: number) => Array.from({ length: count }, (_, i) => !!ws.getCell(r, i + 1).font?.bold);

describe('header block (every worksheet)', () => {
  it('rows 1–6: labels in merged A:B, values from C; row 7 blank; table from row 8, frozen there', () => {
    const s = templateSheet(report([THREE_LEVELS]), report([THREE_LEVELS]).sheets[0]!, { projects: { FFN: 'FloraFire nopStation' } });
    expect(s.rows.slice(0, 6).map((r) => [r[0], r[2]])).toEqual([
      ['From', '2026-09-01'],
      ['Projects', 'FloraFire nopStation'],
      ['Filters', 'None'],
      ['Time Zone', 'Asia/Dhaka'],
      ['Generated on', '2026-10-07T10:00:05+06:00'],
      ['Report Time Format', 'Hours'],
    ]);
    expect([s.rows[0]![4], s.rows[0]![6]]).toEqual(['To', '2026-09-03']);
    expect(s.merges).toEqual(
      expect.arrayContaining([
        [1, 1, 1, 2], [1, 3, 1, 4], [1, 5, 1, 6], [1, 7, 1, 9],
        [2, 1, 2, 2], [2, 3, 2, 9], [3, 3, 3, 9], [5, 3, 5, 9], [6, 1, 6, 2], [6, 3, 6, 4],
      ]),
    );
    expect(s.rows[6]).toEqual([]);
    expect(s.freezeRows).toBe(8);
    expect(s.name).toBe('Report');
  });

  it("Filters = the global users plus this sheet's conditions and JQL, in words (per sheet)", () => {
    const r = report([
      group(['status'], { name: 'All' }),
      group(['status'], {
        name: 'Billable',
        filter: {
          conditions: [
            { fieldId: 'status', op: 'in', value: ['Done', 'QA'] },
            { fieldId: CF, op: 'contains', value: 'TPX-6' },
            { fieldId: 'assignee', op: 'is', value: 'acc-9' },
            { fieldId: 'status', op: 'isNotEmpty' },
          ],
          jql: 'labels = x',
        },
      }),
      { ...preset(ISSUE_LIST_SHEET), name: 'Issues' },
    ], {}, { data: { jqlKeys: new Map([['labels = x', new Set<string>()]]) } });
    r.filter = { ...r.filter, authors: ['a'] };
    const [all, billable, issues] = r.sheets.map((s) => describeSheetFilters(r, s, { users: { 'acc-9': 'Carol' } }));
    expect(all).toBe('Users: Alice');
    expect(billable).toBe(
      'Users: Alice; Status is one of (Done, QA); Client Reference contains "TPX-6"; Assignee is Carol; Status is not empty; JQL: labels = x',
    );
    expect(issues).toBe('Users: Alice; Issues without time included');
  });

  it('Report Time Format follows the sheet; an incomplete report has the red row 7 on every sheet and _INCOMPLETE in the filename', () => {
    const r = report([group(['status'], { format: 'days' }), preset(WORK_LOGS_SHEET)], {
      complete: false,
      failedIssueKeys: ['FFN-9'],
      failureReasons: ['rate limited'],
    });
    for (const i of [0, 1]) {
      const s = layoutOf(r, i);
      expect(s.rows[6]![0]).toBe('⚠ Incomplete report — worklogs could not be loaded for: FFN-9 (rate limited)');
      expect(s.warningRow).toBe(7);
      expect(s.merges).toContainEqual([7, 1, 7, 9]);
    }
    expect(layoutOf(r, 0).rows[5]![2]).toBe('Days (8h per day)');
    expect(layoutOf(r, 1).rows[5]![2]).toBe('Hours');
    expect(templateFilename(r)).toBe('Time Reports style_2026-09-01_2026-09-03_INCOMPLETE.xlsx');
  });
});

describe('group sheets', () => {
  it('everyLevel: Level / Total Level pairs, parent values only on the first row of a group, bold Total row', () => {
    const s = layoutOf(report([THREE_LEVELS]));
    expect(tableOf(s.rows)).toEqual([
      ['Project', 'Total Project', 'Worklog Author', 'Total Worklog Author', 'Status', 'Total Status'],
      ['FloraFire', 8, 'Alice', 4.5, 'Done', 3.5],
      ['', '', '', '', 'QA', 1],
      ['', '', 'Bob', 3.5, 'Done', 3.5],
      ['Total', 8, '', 8, '', 8],
    ]);
    expect(s.boldRows).toEqual([8, 12]);
  });

  it('everyLevel: extra columns, then period columns, then a trailing total column headed totalLabel; days format', () => {
    const s = layoutOf(report([group(['worklog.author', 'issue.key'], { columns: [CF], period: 'day', format: 'days', totalLabel: 'Sum' })]));
    expect(tableOf(s.rows)).toEqual([
      ['Worklog Author', 'Total Worklog Author', 'Issue', 'Total Issue', 'Client Reference', '01-Sep', '02-Sep', '03-Sep', 'Sum'],
      ['Alice', 0.56, 'FFN-1', 0.44, 'TPX-1', 0.25, 0.19, 0, 0.44],
      ['', '', 'FFN-2', 0.13, 'TPX-2', 0, 0.13, 0, 0.13],
      ['Bob', 0.44, 'FFN-1', 0.38, 'TPX-1', 0.38, 0, 0, 0.38],
      ['', '', 'FFN-3', 0.06, 'TPX-3', 0, 0, 0.06, 0.06],
      ['Total', 1, '', 1, '', 0.63, 0.31, 0.06, 1],
    ]);
  });

  it('lastLevel (Team Client Report): level columns, extra columns, one total column headed totalLabel; no subtotal rows', () => {
    const s = layoutOf(report([group([{ fieldId: 'worklog.author', label: 'User' }, 'issue.key'], { columns: [CF], totalColumns: 'lastLevel', totalLabel: 'Hours' })]));
    expect(tableOf(s.rows)).toEqual([
      ['User', 'Issue', 'Client Reference', 'Hours'],
      ['Alice', 'FFN-1', 'TPX-1', 3.5],
      ['', 'FFN-2', 'TPX-2', 1],
      ['Bob', 'FFN-1', 'TPX-1', 3],
      ['', 'FFN-3', 'TPX-3', 0.5],
      ['Total', '', '', 8],
    ]);
    expect(s.boldRows).toEqual([8, 13]);
  });

  it('lastLevel + periods + subtotalRows: a bold subtotal row after each parent group, period columns before the total', () => {
    const s = layoutOf(report([group(['worklog.author', 'issue.key'], { columns: [CF], period: 'day', totalColumns: 'lastLevel', subtotalRows: true })]));
    expect(tableOf(s.rows)).toEqual([
      ['Worklog Author', 'Issue', 'Client Reference', '01-Sep', '02-Sep', '03-Sep', 'Total'],
      ['Alice', 'FFN-1', 'TPX-1', 2, 1.5, 0, 3.5],
      ['', 'FFN-2', 'TPX-2', 0, 1, 0, 1],
      ['Alice Total', '', '', 2, 2.5, 0, 4.5],
      ['Bob', 'FFN-1', 'TPX-1', 3, 0, 0, 3],
      ['', 'FFN-3', 'TPX-3', 0, 0, 0.5, 0.5],
      ['Bob Total', '', '', 3, 0, 0.5, 3.5],
      ['Total', '', '', 5, 2.5, 0.5, 8],
    ]);
    expect(s.boldRows).toEqual([8, 11, 14, 15]);
  });

  it('lastLevel + subtotalRows with 3 levels: deepest subtotal first; parents not repeated after a subtotal', () => {
    const s = layoutOf(report([{ ...THREE_LEVELS, totalColumns: 'lastLevel', subtotalRows: true }]));
    expect(tableOf(s.rows)).toEqual([
      ['Project', 'Worklog Author', 'Status', 'Total'],
      ['FloraFire', 'Alice', 'Done', 3.5],
      ['', '', 'QA', 1],
      ['', 'Alice Total', '', 4.5],
      ['', 'Bob', 'Done', 3.5],
      ['', 'Bob Total', '', 3.5],
      ['FloraFire Total', '', '', 8],
      ['Total', '', '', 8],
    ]);
  });

  it('totals off: no Total row', () => {
    const s = layoutOf(report([group(['worklog.author'], { totals: false, totalColumns: 'lastLevel' })]));
    expect(tableOf(s.rows)).toEqual([['Worklog Author', 'Total'], ['Alice', 4.5], ['Bob', 3.5]]);
  });

  it('auto column widths, at most 60', () => {
    const r = report([group(['issue.keySummary'])]);
    const g = r.sheets[0]!;
    if (g.mode === 'group') g.tree.nodes[0]!.label = 'x'.repeat(200);
    const w = layoutOf(r).widths;
    expect(w[0]).toBe(60);
    expect(w.every((x) => x >= 8 && x <= 60)).toBe(true);
  });
});

describe('flat sheets', () => {
  it('each worklog ("Work logs" preset): configured columns, author/start order, REPORT_TZ Excel dates, hours in the format', () => {
    const s = layoutOf(report([preset(WORK_LOGS_SHEET, { columns: [...preset(WORK_LOGS_SHEET).columns, CF] })]));
    const [header, ...rows] = tableOf(s.rows);
    expect(header).toEqual([
      'Author', 'Issue', 'Issue Summary', 'Work log started', 'Work log created', 'Work log time zone', 'Time spent', 'Work log comment', 'Client Reference',
    ]);
    expect(rows.map((r) => [r[0], r[1], r[6], r[8]])).toEqual([
      ['Alice', 'FFN-1', 2, 'TPX-1'],
      ['Alice', 'FFN-1', 1.5, 'TPX-1'],
      ['Alice', 'FFN-2', 1, 'TPX-2'],
      ['Bob', 'FFN-1', 3, 'TPX-1'],
      ['Bob', 'FFN-3', 0.5, 'TPX-3'],
      ['Total', '', 8, ''],
    ]);
    expect(rows[0]!.slice(2, 8)).toEqual([
      'Login', new Date(Date.UTC(2026, 8, 1, 10, 0)), new Date(Date.UTC(2026, 8, 10, 8, 0)), 'Asia/Dhaka', 2, 'Built the form',
    ]);
    expect(s.dateColumns).toEqual([4, 5]);
    expect(s.boldRows).toEqual([8, 14]);
  });

  it('each issue: Hours = the issue total in the format; "Total" in the first non-Hours column', () => {
    const s = layoutOf(report([{ name: 'I', rows: { mode: 'eachIssue' }, columns: ['metric.hours', 'issue.key', 'status'], format: 'days' }]));
    expect(tableOf(s.rows)).toEqual([
      ['Hours', 'Issue', 'Status'],
      [0.06, 'FFN-3', 'Done'],
      [0.13, 'FFN-2', 'QA'],
      [0.81, 'FFN-1', 'Done'],
      [1, 'Total', ''],
    ]);
  });

  it('no Hours column → no Total row', () => {
    const s = layoutOf(report([{ name: 'I', rows: { mode: 'eachIssue' }, columns: ['issue.key'] }]));
    expect(tableOf(s.rows)).toEqual([['Issue'], ['FFN-3'], ['FFN-2'], ['FFN-1']]);
  });

  it('excelDateTime converts to the zone; bad input stays text', () => {
    expect(excelDateTime('2026-09-01T23:30:00.000-0400', 'Asia/Dhaka')).toEqual(new Date(Date.UTC(2026, 8, 2, 9, 30)));
    expect(excelDateTime('nope', 'Asia/Dhaka')).toBe('nope');
    expect(excelDateTime('', 'Asia/Dhaka')).toBe('');
  });
});

/** Minimal RFC 4180 reader for the fixture. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

describe('"Issue list" preset vs Jira.csv (xlsx: header and cell values)', () => {
  it('the same 10 columns and values, newest key first, issues without time included (0 hours)', async () => {
    const [header, ...rows] = parseCsv(readFileSync(JIRA_CSV, 'utf8'));
    // The issues as Jira's search returns them, in random order; none has time in the range.
    const issues: CustomIssue[] = [...rows].reverse().map(([type, key, id, summary, status, assignee, assigneeId, parentId, parentKey, parentSummary]) => ({
      id: id!,
      key: key!,
      fields: {
        summary,
        issuetype: { name: type },
        status: { name: status },
        assignee: assignee ? { displayName: assignee, accountId: assigneeId } : null,
        ...(parentKey ? { parent: { id: parentId, key: parentKey, fields: { summary: parentSummary } } } : {}),
      },
    }));
    const sheet = { ...preset(ISSUE_LIST_SHEET), name: 'Issues' };
    const r = report([sheet], {}, { issues, worklogs: [], data: { issuesWithoutWorklogs: new Map([['Issues', issues.map((i) => i.key)]]) } });
    const wb = await roundTrip(buildTemplateWorkbook(r));
    const ws = wb.getWorksheet('Issues')!;
    expect(rowValues(ws, 8, 10)).toEqual(header);
    const expected = [...rows].sort((a, b) => compareIssueKeysDesc(a[1]!, b[1]!));
    expect(Array.from({ length: rows.length }, (_, i) => rowValues(ws, 9 + i, 10))).toEqual(expected);
    expect(ws.rowCount).toBe(8 + rows.length); // no Total row: no Hours column
  });
});

describe('workbook vs the team samples (structure, not totals)', () => {
  it('keeps the accepted Report 1.xlsx format: group sheet cell for cell; Work logs columns, now under the header block', async () => {
    const ref = new ExcelJS.Workbook();
    await ref.xlsx.readFile(REPORT_1);
    const r = report([
      group(['worklog.author', 'issue.keySummary'], { columns: [CF] }),
      preset(WORK_LOGS_SHEET, { columns: [...preset(WORK_LOGS_SHEET).columns, CF] }),
    ]);
    r.filter = { ...r.filter, authors: ['a', 'b'] };
    const ours = await roundTrip(buildTemplateWorkbook(r, { projects: { FFN: 'FloraFire nopStation' } }));
    expect(ours.worksheets.map((w) => w.name)).toEqual(ref.worksheets.map((w) => w.name));

    const [rr, or] = [ref.getWorksheet('Report')!, ours.getWorksheet('Report')!];
    expect([...or.model.merges].sort()).toEqual([...rr.model.merges].sort());
    expect(or.views[0]).toMatchObject({ state: 'frozen', ySplit: 8 });
    expect(rr.views[0]).toMatchObject({ state: 'frozen', ySplit: 8 });
    for (let row = 1; row <= 7; row++) {
      expect(or.getCell(row, 1).value ?? null).toEqual(rr.getCell(row, 1).value ?? null);
      expect(shape(or, row, 9)).toEqual(shape(rr, row, 9));
      expect(bold(or, row, 9)).toEqual(bold(rr, row, 9));
    }
    expect(or.getCell(1, 5).value).toBe(rr.getCell(1, 5).value); // "To"
    expect(or.getCell(3, 3).value).toBe('Users: Alice, Bob'); // like "Users: Mustafizur Rahman, Foysal Rabbi"
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
    expect(String(rr.getCell(5, 3).value)).toMatch(iso);
    expect(String(or.getCell(5, 3).value)).toMatch(iso);
    expect(rowValues(or, 8, 5)).toEqual(rowValues(rr, 8, 5));
    expect(bold(or, 8, 5)).toEqual(bold(rr, 8, 5));
    expect(shape(or, 9, 4)).toEqual(shape(rr, 9, 4));
    expect(rowValues(or, 10, 2)).toEqual(rowValues(rr, 10, 2)); // ['', '']
    expect(shape(or, or.rowCount, 5)).toEqual(shape(rr, rr.rowCount, 5));
    expect(bold(or, or.rowCount, 5)).toEqual(bold(rr, rr.rowCount, 5));
    expect(or.columns.slice(5).map((c) => c.width)).toEqual(rr.columns.slice(5).map((c) => c.width));

    // Work logs: same 9 columns and cell kinds; the table now starts at row 8 under the header block (Step C).
    const [rw, ow] = [ref.getWorksheet('Work logs')!, ours.getWorksheet('Work logs')!];
    expect(rowValues(ow, 8, 9)).toEqual(rowValues(rw, 1, 9));
    expect(bold(ow, 8, 9)).toEqual(bold(rw, 1, 9));
    expect(ow.views[0]).toMatchObject({ state: 'frozen', ySplit: 8 });
    expect(ow.getCell(1, 1).value).toBe('From');
    expect(shape(ow, 9, 3)).toEqual(shape(rw, 2, 3));
    for (const c of [4, 5]) {
      expect(ow.getCell(9, c).value).toBeInstanceOf(Date);
      expect(ow.getCell(9, c).numFmt).toBe(rw.getCell(2, c).numFmt);
      expect(ow.getCell(8, c).numFmt).not.toBe(DATETIME_FMT); // header text keeps the default format
    }
    expect(typeof ow.getCell(9, 7).value).toBe('number');
  });

  it('same table header and Level/Total pairs as the team sample (Report 2.xlsx); "Work logs" preset = its 8 columns', async () => {
    const sample = new ExcelJS.Workbook();
    await sample.xlsx.readFile(SAMPLE);
    const { template } = resolveStarter(STARTER_TEMPLATES.find((t) => t.name === 'Time Reports style')!, FIELDS);
    const r = report(template.sheets);
    const ours = await roundTrip(buildTemplateWorkbook(r));

    expect(ours.worksheets.map((w) => w.name)).toEqual(['Report', 'Work logs']);
    const [sr, or] = [sample.getWorksheet('Report')!, ours.getWorksheet('Report')!];
    expect(rowValues(or, 8, 6)).toEqual(rowValues(sr, 8, 6));
    expect(or.getCell(8, 1).font?.bold).toBe(true);
    expect(rowValues(or, 9, 6)).toEqual(['FFN-1', 6.5, 'FFN-1 Login', 6.5, 'Done', 6.5]);
    expect(String(sr.getCell(9, 3).value)).toMatch(new RegExp(`^${sr.getCell(9, 1).value} `));
    const typed = (ws: ExcelJS.Worksheet, row: number) => rowValues(ws, row, 6).map((v) => (typeof v === 'number' ? 'n' : v));
    expect(typed(or, or.rowCount)).toEqual(typed(sr, sr.rowCount));
    expect(or.getCell(or.rowCount, 2).value).toBe(8);
    expect(or.getCell(or.rowCount, 1).font?.bold).toBe(true);
    for (const range of ['A1:B1', 'C1:D1', 'E1:F1', 'G1:I1', 'A2:B2', 'C2:I2', 'A3:B3', 'A4:B4', 'A5:B5', 'A6:B6', 'C6:D6']) {
      expect(sr.model.merges).toContain(range);
      expect(or.model.merges).toContain(range);
    }
    expect(or.getCell(7, 1).value).toBeNull();

    const [sw, ow] = [sample.getWorksheet('Work logs')!, ours.getWorksheet('Work logs')!];
    expect(rowValues(ow, 8, 8)).toEqual(rowValues(sw, 1, 8));
    expect(ow.getCell(8, 1).font?.bold).toBe(true);
    expect(ow.getCell(9, 4).value).toBeInstanceOf(Date);
    expect(ow.getCell(9, 4).numFmt).toBe(sw.getCell(2, 4).numFmt);
    expect(typeof ow.getCell(9, 7).value).toBe(typeof sw.getCell(2, 7).value);
  });
});

describe('filename', () => {
  it('<Template name>_<from>_<to>.xlsx; unsafe characters replaced, Unicode kept', () => {
    expect(templateFilename(report([THREE_LEVELS]))).toBe('Time Reports style_2026-09-01_2026-09-03.xlsx');
    expect(filenameSafe('A/B: "Sept"?')).toBe('A-B- -Sept-');
    expect(filenameSafe(' .. ')).toBe('Report');
    expect(filenameSafe('Équipe — Sept')).toBe('Équipe — Sept');
  });

  it('Content-Disposition has an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('Team Client Report_2026-09-01_2026-09-30.xlsx')).toBe(
      `attachment; filename="Team Client Report_2026-09-01_2026-09-30.xlsx"; filename*=UTF-8''Team%20Client%20Report_2026-09-01_2026-09-30.xlsx`,
    );
    expect(contentDisposition('Équipe.xlsx')).toBe(`attachment; filename="_quipe.xlsx"; filename*=UTF-8''%C3%89quipe.xlsx`);
  });

  it('server and browser period labels agree', () => {
    for (const [k, p] of [['2026-09-01', 'day'], ['2026-W36', 'week'], ['2026-09', 'month']] as const) {
      expect(serverPeriodLabel(k, p)).toBe(webPeriodLabel(k, p));
    }
  });
});

describe('POST /api/custom-report/export', () => {
  async function app() {
    const a = Fastify();
    const jira = {} as JiraClient; // never called: the export uses the posted result only
    const sites = new SiteRegistry([{ key: 'one', url: 'https://one.atlassian.net', jira }]);
    await a.register(customExportRoutes, { sites, cfg: { MAX_RANGE_DAYS: 31 } });
    return a;
  }
  const post = async (payload: object, url = '/api/custom-report/export') => (await app()).inject({ method: 'POST', url, payload });
  const TWO = () => report([THREE_LEVELS, preset(WORK_LOGS_SHEET)], {}, { name: 'Team / Sept' });

  it('streams one .xlsx with a worksheet per template sheet, in order, named after the template', async () => {
    const res = await post({ report: JSON.parse(JSON.stringify(TWO())), labels: { projects: { FFN: 'FloraFire nopStation' } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toBe(contentDisposition('Team - Sept_2026-09-01_2026-09-03.xlsx'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Report', 'Work logs']);
    const ws = wb.getWorksheet('Report')!;
    expect(ws.getCell(2, 3).value).toBe('FloraFire nopStation');
    expect(rowValues(ws, 9, 6)).toEqual(['FloraFire', 8, 'Alice', 4.5, 'Done', 3.5]);
    expect(wb.getWorksheet('Work logs')!.getCell(9, 4).value).toBeInstanceOf(Date);
  });

  it.each([
    ['missing report', {}, /report/],
    ['bad time zone', { report: { ...TWO(), timeZone: 'Mars/Base' } }, /timeZone/],
    ['unknown site', { report: { ...TWO(), site: 'two' } }, /Unknown site/],
    ['sheet result for another sheet', { report: { ...TWO(), sheets: [TWO().sheets[1], TWO().sheets[0]] } }, /do not match the template sheets/],
    ['missing sheet result', { report: { ...TWO(), sheets: [TWO().sheets[0]] } }, /one sheet result per template sheet/],
    ['invalid sheet', { report: { ...TWO(), template: { ...TWO().template, sheets: [{ name: 'a:b', rows: { mode: 'eachWorklog' } }] } } }, /template\.sheets/],
  ])('%s -> 400', async (_, payload, msg) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(msg);
  });

  it('the CSV and Issues CSV formats are gone: ?format is ignored and the answer is the xlsx', async () => {
    const res = await post({ report: TWO() }, '/api/custom-report/export?format=csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });
});

describe('starter presets', () => {
  const starter = (name: string) => STARTER_TEMPLATES.find((t) => t.name === name)!;

  it('Team Client Report: Report = User → Issue, Client Reference (TPX-####), lastLevel totals headed "Hours"; then Summary', () => {
    const { template, warnings } = resolveStarter(starter('Team Client Report'), FIELDS);
    expect(warnings).toEqual([]);
    expect(template.sheets.map((s) => s.name)).toEqual(['Report', 'Summary']); // Summary: tests/custom-sheet-options.test.ts
    expect(template.sheets[0]).toMatchObject({
      rows: { mode: 'group', groupBy: [{ fieldId: 'worklog.author', label: 'User' }, { fieldId: 'issue.keySummary', label: 'Issue' }] },
      columns: [{ fieldId: CF, label: 'Client Reference', extract: 'TPX-\\d+' }],
      totals: true,
      totalColumns: 'lastLevel',
      totalLabel: 'Hours',
      subtotalRows: false,
    });
  });

  it('Issue list: the 10 Jira.csv columns, issues without time included', () => {
    const { template } = resolveStarter(starter('Issue list'), FIELDS);
    expect(template.sheets[0]!.includeIssuesWithoutWorklogs).toBe(true);
    expect(template.sheets[0]!.columns.map((c) => c.label)).toEqual(parseCsv(readFileSync(JIRA_CSV, 'utf8'))[0]);
  });

  it('a field the site does not have: warning, the column is skipped', () => {
    const { template, warnings } = resolveStarter(starter('Team Client Report'), FIELDS.filter((f) => f.id !== CF));
    expect(template.sheets[0]!.columns).toEqual([]);
    expect(warnings).toEqual(['Team Client Report / Report: field "Client Reference" not found on this site; the column is skipped.']);
  });
});
