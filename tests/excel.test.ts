import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { JiraClient } from '../src/jira/client.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { exportRoutes } from '../src/routes/export.js';
import { buildWorkbook, DETAIL_SHEET, exportFilename, SUMMARY_SHEET } from '../src/services/excel.js';
import { buildReport } from '../src/services/report.js';
import type { NormalizedWorklog, Report } from '../src/types.js';

const H = 3600;
const BASE_URL = 'https://example.atlassian.net';

function nw(id: string, date: string, accountId: string, user: string, seconds: number, issueKey = 'TPX-1'): NormalizedWorklog {
  return { id, date, accountId, user, issueKey, summary: `summary ${issueKey}`, project: 'TPX', seconds };
}

const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
const report = buildReport({
  from: '2026-10-01',
  to: '2026-10-03',
  dates,
  failedIssueKeys: [],
  retrievedAt: '2026-10-06T12:00:00+06:00',
  worklogs: [
    nw('1', '2026-10-03', 'acc-b', 'Bob', 2 * H),
    nw('2', '2026-10-01', 'acc-a', 'Alice', 7.5 * H),
    nw('3', '2026-10-03', 'acc-a', 'Alice', 20 * 60, 'TPX-2'), // 0.333…h: totals must still match exactly
    nw('4', '2026-10-01', 'acc-b', 'Bob', 1 * H, 'TPX-10'),
    nw('5', '2026-10-01', 'acc-a', 'Alice', 0.5 * H, 'TPX-3'),
  ],
});
const incomplete: Report = { ...report, complete: false, failedIssueKeys: ['TPX-7', 'TPX-9'], project: 'TPX' };

/** Round-trips through a real .xlsx buffer so we test what Excel would open. */
async function roundTrip(r: Report): Promise<ExcelJS.Workbook> {
  const buf = await buildWorkbook(r, BASE_URL).xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  return wb;
}

const num = (c: ExcelJS.Cell) => c.value as number;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('Team Summary sheet', () => {
  it('has header, one row per user and a TOTAL row whose totals equal the report totals', async () => {
    const ws = (await roundTrip(report)).getWorksheet(SUMMARY_SHEET)!;
    expect(ws.getRow(1).values).toEqual([undefined, 'User', '01-Oct', '02-Oct', '03-Oct', 'Total']);
    expect(ws.rowCount).toBe(1 + report.rows.length + 1);
    const totalCol = dates.length + 2;

    report.rows.forEach((r, i) => {
      const row = ws.getRow(i + 2);
      expect(row.getCell(1).value).toBe(r.user);
      dates.forEach((d, j) => close(num(row.getCell(j + 2)), (r.byDate[d] ?? 0) / H));
      close(num(row.getCell(totalCol)), r.total / H);
      // Row total equals the sum of its day cells.
      close(dates.reduce((s, _, j) => s + num(row.getCell(j + 2)), 0), num(row.getCell(totalCol)));
    });

    const total = ws.getRow(report.rows.length + 2);
    expect(total.getCell(1).value).toBe('TOTAL');
    expect(total.font?.bold).toBe(true);
    dates.forEach((d, j) => {
      close(num(total.getCell(j + 2)), (report.dateTotals[d] ?? 0) / H);
      // Column total equals the sum of the user cells above it.
      const colSum = report.rows.reduce((s, _, i) => s + num(ws.getRow(i + 2).getCell(j + 2)), 0);
      close(colSum, num(total.getCell(j + 2)));
    });
    close(num(total.getCell(totalCol)), report.grandTotal / H);
    expect(typeof total.getCell(totalCol).value).toBe('number');
  });

  it('freezes the header and first column and bolds the header', async () => {
    const ws = (await roundTrip(report)).getWorksheet(SUMMARY_SHEET)!;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 });
    expect(ws.getRow(1).font?.bold).toBe(true);
  });
});

describe('Detailed Worklogs sheet', () => {
  it('lists worklogs sorted by date then user, hours summing to grandTotal', async () => {
    const ws = (await roundTrip(report)).getWorksheet(DETAIL_SHEET)!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Date', 'User', 'Issue', 'Summary', 'Project', 'Hours']);
    const body = Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2));
    expect(body).toHaveLength(report.worklogs.length);

    expect(body.map((r) => [(r.getCell(1).value as Date).toISOString().slice(0, 10), r.getCell(2).value])).toEqual([
      ['2026-10-01', 'Alice'],
      ['2026-10-01', 'Alice'],
      ['2026-10-01', 'Bob'],
      ['2026-10-03', 'Alice'],
      ['2026-10-03', 'Bob'],
    ]);
    close(
      body.reduce((s, r) => s + num(r.getCell(6)), 0),
      report.grandTotal / H,
    );
  });

  it('hyperlinks the issue key to Jira', async () => {
    const ws = (await roundTrip(report)).getWorksheet(DETAIL_SHEET)!;
    expect(ws.getRow(2).getCell(3).value).toEqual({ text: 'TPX-1', hyperlink: `${BASE_URL}/browse/TPX-1` });
  });
});

describe('incomplete report', () => {
  it('puts the warning in row 1 of both sheets and keeps the data intact below it', async () => {
    const wb = await roundTrip(incomplete);
    for (const name of [SUMMARY_SHEET, DETAIL_SHEET]) {
      const ws = wb.getWorksheet(name)!;
      expect(ws.getRow(1).getCell(1).value).toBe('⚠ Incomplete report — failed issues: TPX-7, TPX-9');
      expect(ws.getRow(2).getCell(1).value).toBe(name === SUMMARY_SHEET ? 'User' : 'Date');
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    }
    const detail = wb.getWorksheet(DETAIL_SHEET)!;
    let sum = 0;
    for (let i = 3; i <= detail.rowCount; i++) sum += num(detail.getRow(i).getCell(6));
    close(sum, incomplete.grandTotal / H);
  });
});

describe('exportFilename', () => {
  it('starts with the site and includes the project only when set', () => {
    expect(exportFilename(report, 'example')).toBe('worklog-report_example_2026-10-01_2026-10-03.xlsx');
    expect(exportFilename(incomplete, 'other')).toBe('worklog-report_other_2026-10-01_2026-10-03_TPX.xlsx');
  });
});

describe('POST /api/export', () => {
  const OTHER_URL = 'https://other.atlassian.net';
  const unused = {} as JiraClient; // export never calls Jira
  async function app() {
    const a = Fastify();
    const sites = new SiteRegistry([
      { key: 'example', url: BASE_URL, jira: unused },
      { key: 'other', url: OTHER_URL, jira: unused },
    ]);
    await a.register(exportRoutes, { sites, cfg: { MAX_RANGE_DAYS: 31 } });
    return a;
  }
  const exportReport = async (payload: object) => (await app()).inject({ method: 'POST', url: '/api/export', payload });
  async function workbook(rawPayload: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rawPayload as unknown as ArrayBuffer);
    return wb;
  }

  it('streams an .xlsx with the right filename (no site in the report = first site)', async () => {
    const res = await exportReport(incomplete);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe('attachment; filename="worklog-report_example_2026-10-01_2026-10-03_TPX.xlsx"');
    const wb = await workbook(res.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, DETAIL_SHEET]);
    expect(wb.getWorksheet(DETAIL_SHEET)!.getRow(3).getCell(3).value).toEqual({ text: 'TPX-1', hyperlink: `${BASE_URL}/browse/TPX-1` });
  });

  it("uses the report's site for issue links and the filename", async () => {
    const res = await exportReport({ ...report, site: 'other' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="worklog-report_other_2026-10-01_2026-10-03.xlsx"');
    const ws = (await workbook(res.rawPayload)).getWorksheet(DETAIL_SHEET)!;
    expect(ws.getRow(2).getCell(3).value).toEqual({ text: 'TPX-1', hyperlink: `${OTHER_URL}/browse/TPX-1` });
  });

  it('site keys are case-insensitive', async () => {
    const res = await exportReport({ ...report, site: 'OTHER' });
    expect(res.headers['content-disposition']).toContain('worklog-report_other_');
  });

  it('unknown site -> 400', async () => {
    const res = await exportReport({ ...report, site: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid report: Unknown site "nope". Known sites: example, other.');
  });

  it.each([
    ['empty body', {}],
    ['missing worklogs', { ...report, worklogs: undefined }],
    ['negative seconds', { ...report, grandTotal: -1 }],
    ['bad date', { ...report, from: '01-10-2026' }],
    ['from > to', { ...report, from: '2026-10-04' }],
    ['unsafe project key', { ...report, project: '../x"' }],
  ])('rejects %s with 400', async (_, payload) => {
    const res = await exportReport(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Invalid report:/);
  });
});
