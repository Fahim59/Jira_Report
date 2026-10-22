import ExcelJS from 'exceljs';
import type { NormalizedWorklog, Report } from '../types.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Hours are stored exact (seconds / 3600) and only rounded for display, so Excel sums match the report. */
const HOURS_FMT = '0.00';
const DATE_FMT = 'dd-mmm-yyyy';
const BOLD: Partial<ExcelJS.Font> = { bold: true };
const WARN_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFC00000' } };
const LINK_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF0563C1' }, underline: true };
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7ECF3' } };

export const SUMMARY_SHEET = 'Team Summary';
export const DETAIL_SHEET = 'Detailed Worklogs';

const hours = (seconds: number) => seconds / 3600;

/** "2026-10-01" -> "01-Oct". */
function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}`;
}

/** Calendar date as an Excel date (exceljs converts via UTC, so UTC midnight is exact). */
function excelDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** worklog-report_<site>_<from>_<to>[_<project>].xlsx */
export function exportFilename(report: Pick<Report, 'from' | 'to' | 'project'>, siteKey: string): string {
  return `worklog-report_${siteKey}_${report.from}_${report.to}${report.project ? `_${report.project}` : ''}.xlsx`;
}

/** Adds the "⚠ Incomplete report" banner as row 1 when needed. Returns the number of rows used. */
function addIncompleteBanner(ws: ExcelJS.Worksheet, report: Report, width: number): number {
  if (report.complete) return 0;
  const row = ws.addRow([`⚠ Incomplete report — failed issues: ${report.failedIssueKeys.join(', ')}`]);
  row.font = WARN_FONT;
  ws.mergeCells(row.number, 1, row.number, Math.max(width, 1));
  return 1;
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = BOLD;
  row.eachCell((c) => (c.fill = HEADER_FILL));
}

function addSummarySheet(wb: ExcelJS.Workbook, report: Report): void {
  const ws = wb.addWorksheet(SUMMARY_SHEET);
  const width = report.dates.length + 2;
  const offset = addIncompleteBanner(ws, report, width);

  styleHeader(ws.addRow(['User', ...report.dates.map(dayLabel), 'Total']));
  for (const r of report.rows) {
    ws.addRow([r.user, ...report.dates.map((d) => hours(r.byDate[d] ?? 0)), hours(r.total)]);
  }
  const total = ws.addRow(['TOTAL', ...report.dates.map((d) => hours(report.dateTotals[d] ?? 0)), hours(report.grandTotal)]);
  total.font = BOLD;
  total.border = { top: { style: 'thin' } };

  ws.getColumn(1).width = Math.min(40, Math.max(12, ...report.rows.map((r) => r.user.length + 2)));
  for (let c = 2; c <= width; c++) {
    ws.getColumn(c).width = 9;
    ws.getColumn(c).numFmt = HOURS_FMT;
  }
  ws.getColumn(width).font = BOLD;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: offset + 1 }];
}

function addDetailSheet(wb: ExcelJS.Workbook, report: Report, jiraBaseUrl: string): void {
  const ws = wb.addWorksheet(DETAIL_SHEET);
  const offset = addIncompleteBanner(ws, report, 6);
  styleHeader(ws.addRow(['Date', 'User', 'Issue', 'Summary', 'Project', 'Hours']));

  const sorted = [...report.worklogs].sort(compareWorklogs);
  for (const wl of sorted) {
    const row = ws.addRow([
      excelDate(wl.date),
      wl.user,
      { text: wl.issueKey, hyperlink: `${jiraBaseUrl}/browse/${encodeURIComponent(wl.issueKey)}` },
      wl.summary,
      wl.project,
      hours(wl.seconds),
    ]);
    row.getCell(3).font = LINK_FONT;
  }

  const widths = [13, 24, 12, 60, 10, 9];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(1).numFmt = DATE_FMT;
  ws.getColumn(6).numFmt = HOURS_FMT;
  ws.views = [{ state: 'frozen', ySplit: offset + 1 }];
  if (sorted.length) ws.autoFilter = { from: { row: offset + 1, column: 1 }, to: { row: offset + 1 + sorted.length, column: 6 } };
}

/** Date, then user; issue key and id keep the order stable. */
function compareWorklogs(a: NormalizedWorklog, b: NormalizedWorklog): number {
  return (
    a.date.localeCompare(b.date) ||
    a.user.localeCompare(b.user) ||
    a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }) ||
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
}

/** Builds the workbook purely from the report (no Jira calls). Issue links point at `jiraBaseUrl` (the report's site). */
export function buildWorkbook(report: Report, jiraBaseUrl: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'jira-worklog-report';
  wb.created = new Date();
  addSummarySheet(wb, report);
  addDetailSheet(wb, report, jiraBaseUrl);
  return wb;
}
