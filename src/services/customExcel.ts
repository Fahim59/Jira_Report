import ExcelJS from 'exceljs';
import { DATETIME_FMT, workbookLayout, type ExportLabels, type SheetLayout, type WorkbookOptions, type WorkbookReport } from './custom/export.js';

const BOLD: Partial<ExcelJS.Font> = { bold: true };
const WARN_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFC00000' } };
const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14 };
const SUBTITLE_FONT: Partial<ExcelJS.Font> = { size: 9 };

function addSheet(wb: ExcelJS.Workbook, layout: SheetLayout): void {
  const ws = wb.addWorksheet(layout.name);
  layout.rows.forEach((cells) => ws.addRow(cells));
  for (const [r1, c1, r2, c2] of layout.merges) ws.mergeCells(r1, c1, r2, c2);
  for (const r of layout.boldRows) ws.getRow(r).font = BOLD;
  for (const [r, c] of layout.boldCells) ws.getCell(r, c).font = BOLD;
  if (layout.warningRow) ws.getRow(layout.warningRow).font = WARN_FONT;
  if (layout.titleRow) ws.getCell(layout.titleRow, 1).font = TITLE_FONT;
  if (layout.subtitleRow) ws.getCell(layout.subtitleRow, 1).font = SUBTITLE_FONT;
  for (const [r1, c1, r2, c2] of layout.groupMerges) {
    ws.mergeCells(r1, c1, r2, c2);
    ws.getCell(r1, c1).alignment = { vertical: 'top' };
  }
  layout.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (const c of layout.dateColumns) {
    // Only data cells: the header text keeps the default format.
    ws.getColumn(c).eachCell((cell, row) => {
      if (row > layout.freezeRows) cell.numFmt = DATETIME_FMT;
    });
  }
  ws.views = [{ state: 'frozen', ySplit: layout.freezeRows }];
}

/** Template report workbook: one worksheet per template sheet, built only from the displayed result (no Jira calls). */
export function buildTemplateWorkbook(report: WorkbookReport, labels: ExportLabels = {}, opts: WorkbookOptions = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'jira-worklog-report';
  wb.created = new Date();
  for (const layout of workbookLayout(report, labels, opts)) addSheet(wb, layout);
  return wb;
}
