// Team Reports → .xlsx: writes the positioned cells the browser built (web/team/logic.ts pivotGrid), no Jira calls.
import ExcelJS from 'exceljs';

export type GridStyle = 'level' | 'totalHead' | 'banner' | 'period' | 'periodWeekend' | 'label' | 'total' | 'amount' | 'amountWeekend' | 'sumLabel';

export interface TeamGridCell {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  value?: number;
  numFmt?: string;
  style: GridStyle;
}

export interface TeamGrid {
  rows: number;
  cols: number;
  headRows: number;
  levelCols: number;
  cells: TeamGridCell[];
}

const YELLOW = 'FFFFF0B3';
const BLUE = 'FFB3D4FF';
const GREY = 'FFF4F5F7';
const LINE: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFC1C7D0' } };
const BORDER: Partial<ExcelJS.Borders> = { top: LINE, left: LINE, bottom: LINE, right: LINE };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

interface Look {
  font?: Partial<ExcelJS.Font>;
  fill?: ExcelJS.Fill;
  alignment: Partial<ExcelJS.Alignment>;
}

const LOOKS: Record<GridStyle, Look> = {
  level: { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } },
  totalHead: { font: { bold: true }, fill: fill(YELLOW), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } },
  banner: { font: { bold: true }, fill: fill(BLUE), alignment: { horizontal: 'center', vertical: 'middle' } },
  period: { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } },
  periodWeekend: { font: { bold: true, color: { argb: 'FF6B778C' } }, fill: fill(GREY), alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } },
  label: { alignment: { horizontal: 'left', vertical: 'middle', wrapText: true } },
  total: { font: { bold: true }, fill: fill(YELLOW), alignment: { horizontal: 'center', vertical: 'middle' } },
  amount: { alignment: { horizontal: 'center', vertical: 'middle' } },
  amountWeekend: { fill: fill(GREY), alignment: { horizontal: 'center', vertical: 'middle' } },
  sumLabel: { font: { bold: true }, alignment: { horizontal: 'right', vertical: 'middle' } },
};

export const TEAM_SHEET_NAME = 'Team Reports';

/** `team-report_<site>_<from>_<to>[_INCOMPLETE].xlsx` */
export function teamFilename(site: string, from: string, to: string, complete: boolean): string {
  return `team-report_${site}_${from}_${to}${complete ? '' : '_INCOMPLETE'}.xlsx`;
}

export function buildTeamWorkbook(grid: TeamGrid): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'jira-worklog-report';
  wb.created = new Date();
  const ws = wb.addWorksheet(TEAM_SHEET_NAME);

  // Column widths: group labels wide, their totals and the period columns narrow.
  for (let c = 0; c < grid.cols; c++) {
    ws.getColumn(c + 1).width = c < grid.levelCols ? (grid.levelCols === 1 || c % 2 === 1 ? 12 : 30) : 9;
  }
  for (const cell of grid.cells) {
    const target = ws.getCell(cell.r + 1, cell.c + 1);
    target.value = cell.value ?? cell.text;
    if (cell.numFmt) target.numFmt = cell.numFmt;
    const look = LOOKS[cell.style];
    if (look.font) target.font = look.font;
    if (look.fill) target.fill = look.fill;
    target.alignment = look.alignment;
    target.border = BORDER;
  }
  for (const cell of grid.cells) {
    if (cell.rowSpan > 1 || cell.colSpan > 1) {
      ws.mergeCells(cell.r + 1, cell.c + 1, cell.r + cell.rowSpan, cell.c + cell.colSpan);
    }
  }
  // Merged areas keep the look of their first cell on every covered cell (borders and fills would otherwise break).
  for (const cell of grid.cells) {
    for (let r = cell.r; r < cell.r + cell.rowSpan; r++) {
      for (let c = cell.c; c < cell.c + cell.colSpan; c++) {
        const t = ws.getCell(r + 1, c + 1);
        t.border = BORDER;
        const look = LOOKS[cell.style];
        if (look.fill) t.fill = look.fill;
      }
    }
  }
  // Header cells are two lines ("22" over "We", "Total" over the level): leave room for them.
  for (let r = 1; r <= grid.headRows; r++) ws.getRow(r).height = r === grid.headRows ? 32 : 18;
  ws.views = [{ state: 'frozen', xSplit: grid.levelCols, ySplit: grid.headRows }];
  return wb;
}
