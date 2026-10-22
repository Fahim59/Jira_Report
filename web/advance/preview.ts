// Preview of a Generate result: one tab per sheet; a collapsible tree for group sheets, a table for the flat modes.
// Any non-zero amount opens the shared drill-down modal (via onDrill). Pure helpers are in ./logic.ts.
import type { FlatSheetResult, GroupSheetResult, SheetResult } from '../../src/services/custom/sheets.js';
import { flatTable, groupColumnCell, isCountColumn } from '../../src/services/custom/table.js';
import { fillPlaceholders, placeholderValues } from '../../src/services/custom/text.js';
import type { CustomReport } from '../api.js';
import type { Drilldown } from '../drilldown.js';
import { findNode, formatAmount, formatTimestamp, issueKeyOf, nodeDrilldown, parentPaths, periodLabel, visibleRows } from './logic.js';

/** Flat sheets show at most this many rows on screen; the .xlsx has them all. */
export const PREVIEW_ROW_CAP = 2000;
const LINK_COLUMNS = new Set(['issue.key', 'parent.key']);
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Display names of the selected projects / users (as sent with the .xlsx export), for title placeholders. */
export interface PreviewLabels {
  projects?: Record<string, string>;
  users?: Record<string, string>;
}

export interface PreviewElements {
  tabs: HTMLElement;
  panel: HTMLElement;
  /** Above the table: the sheet's title + subtitle (header style "title"). */
  heading: HTMLElement;
  /** Below the table: the sheet's notes. */
  notes: HTMLElement;
  table: HTMLTableElement;
  sheetSummary: HTMLElement;
  expandAll: HTMLButtonElement;
  collapseAll: HTMLButtonElement;
  rowCap: HTMLElement;
}

export interface PreviewDeps {
  /** Jira base URL of a site (issue links). */
  siteUrl: (key: string | undefined) => string | undefined;
  /** Opens the drill-down modal. */
  onDrill: (title: string, subtitle: string, d: Drilldown) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(baseUrl: string, key: string): HTMLAnchorElement {
  const a = el('a', undefined, key);
  a.href = `${baseUrl}/browse/${encodeURIComponent(key)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export class Preview {
  private report: CustomReport | undefined;
  private labels: PreviewLabels = {};
  private active = 0;
  private collapsed = new Set<string>();
  /** Drill-down targets of the rendered table, by data-drill index. */
  private targets: { title: string; subtitle: string; ids: string[]; periodKey?: string }[] = [];

  constructor(
    private readonly e: PreviewElements,
    private readonly deps: PreviewDeps,
  ) {
    e.tabs.addEventListener('click', (ev) => {
      const tab = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-sheet]');
      if (tab) this.selectSheet(Number(tab.dataset.sheet), false);
    });
    e.tabs.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const n = this.report?.sheets.length ?? 0;
      if (!n) return;
      ev.preventDefault();
      this.selectSheet((this.active + (ev.key === 'ArrowRight' ? 1 : n - 1)) % n, true);
    });
    e.table.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const toggle = target.closest<HTMLButtonElement>('button.cr-toggle');
      if (toggle?.dataset.path !== undefined) {
        const p = toggle.dataset.path;
        if (this.collapsed.has(p)) this.collapsed.delete(p);
        else this.collapsed.add(p);
        this.renderSheet();
        e.table.querySelector<HTMLButtonElement>(`button.cr-toggle[data-path="${CSS.escape(p)}"]`)?.focus();
        return;
      }
      const cell = target.closest<HTMLTableCellElement>('td.drill');
      if (cell) this.drill(cell);
    });
    e.table.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const cell = (ev.target as HTMLElement).closest<HTMLTableCellElement>('td.drill');
      if (!cell) return;
      ev.preventDefault();
      this.drill(cell);
    });
    e.expandAll.addEventListener('click', () => {
      this.collapsed = new Set();
      this.renderSheet();
    });
    e.collapseAll.addEventListener('click', () => {
      const s = this.sheet;
      if (s?.mode === 'group') this.collapsed = new Set(parentPaths(s.tree.nodes));
      this.renderSheet();
    });
  }

  private get sheet(): SheetResult | undefined {
    return this.report?.sheets[this.active];
  }

  show(report: CustomReport, labels: PreviewLabels = {}): void {
    this.report = report;
    this.labels = labels;
    this.active = 0;
    this.collapsed = new Set();
    this.renderTabs();
    this.renderSheet();
  }

  clear(): void {
    this.report = undefined;
    this.targets = [];
    this.e.tabs.replaceChildren();
    this.e.table.replaceChildren();
    this.e.sheetSummary.textContent = '';
    this.e.rowCap.hidden = true;
    this.e.heading.replaceChildren();
    this.e.notes.replaceChildren();
    this.e.heading.hidden = this.e.notes.hidden = true;
  }

  private amount(seconds: number, s: SheetResult): string {
    return formatAmount(seconds, s.sheet.format, this.report?.hoursPerDay ?? 8);
  }

  private selectSheet(i: number, focus: boolean): void {
    if (!this.report || i === this.active) return;
    this.active = i;
    this.collapsed = new Set();
    this.renderTabs();
    this.renderSheet();
    if (focus) this.e.tabs.querySelector<HTMLButtonElement>(`button[data-sheet="${i}"]`)?.focus();
  }

  private renderTabs(): void {
    const r = this.report;
    if (!r) return;
    this.e.tabs.replaceChildren(
      ...r.sheets.map((s, i) => {
        const b = el('button', 'cr-sheet-tab');
        b.type = 'button';
        b.dataset.sheet = String(i);
        b.id = `cr-sheet-tab-${i}`;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(i === this.active));
        b.setAttribute('aria-controls', this.e.panel.id);
        b.tabIndex = i === this.active ? 0 : -1;
        b.append(el('span', undefined, s.name), el('span', 'cr-sheet-tab-total', this.amount(s.total, s)));
        return b;
      }),
    );
    this.e.panel.setAttribute('aria-labelledby', `cr-sheet-tab-${this.active}`);
  }

  private renderSheet(): void {
    const s = this.sheet;
    this.targets = [];
    if (!s) return;
    const unit = s.sheet.format === 'days' ? `days (${this.report!.hoursPerDay}h)` : 'hours';
    const what = s.mode === 'group' ? `by ${s.headers.groupBy.join(' › ')}` : `${s.mode === 'eachWorklog' ? 'one row per worklog' : 'one row per issue'}`;
    this.e.sheetSummary.textContent = `${s.name}: ${what} · total ${this.amount(s.total, s)} · ${unit}`;
    this.renderHeading(s);
    if (s.mode === 'group') this.renderTree(s);
    else this.renderFlat(s);
  }

  /** Title + subtitle (placeholders filled like the .xlsx) and notes. */
  private renderHeading(s: SheetResult): void {
    const r = this.report!;
    const { heading, notes } = this.e;
    heading.replaceChildren();
    notes.replaceChildren();
    if (s.sheet.headerStyle === 'title' && s.sheet.title) {
      const values = placeholderValues({
        projects: r.filter.projects,
        authors: r.filter.authors,
        from: r.from,
        to: r.to,
        timeZone: r.timeZone,
        retrievedAt: r.retrievedAt,
        siteUrl: this.deps.siteUrl(r.site),
        site: r.site,
        labels: this.labels,
        knownUsers: new Map(r.worklogs.map((w) => [w.accountId, w.user])),
      });
      heading.append(el('p', 'cr-sheet-heading-title', fillPlaceholders(s.sheet.title, values)));
      if (s.sheet.subtitle) heading.append(el('p', 'cr-sheet-heading-sub', fillPlaceholders(s.sheet.subtitle, values)));
    }
    const lines = s.sheet.notes ?? [];
    if (lines.length) notes.append(el('h4', undefined, 'Notes'), ...lines.map((l) => el('p', undefined, l)));
    heading.hidden = heading.childElementCount === 0;
    notes.hidden = notes.childElementCount === 0;
  }

  /** A drill-down cell (non-zero amounts only). */
  private drillCell(td: HTMLTableCellElement, seconds: number, target: (typeof this.targets)[number]): void {
    if (seconds === 0) {
      td.classList.add('zero');
      return;
    }
    td.classList.add('drill');
    td.tabIndex = 0;
    td.setAttribute('role', 'button');
    td.dataset.drill = String(this.targets.push(target) - 1);
  }

  private drill(td: HTMLTableCellElement): void {
    const r = this.report;
    const s = this.sheet;
    const t = this.targets[Number(td.dataset.drill)];
    if (!r || !s || !t) return;
    const d = nodeDrilldown(r.worklogs, t.ids, s.sheet.period, t.periodKey);
    this.deps.onDrill(t.title, `${t.subtitle} · ${this.amount(d.total, s)}`, d);
  }

  private renderTree(s: GroupSheetResult): void {
    const r = this.report!;
    const { tree, sheet, headers } = s;
    const baseUrl = this.deps.siteUrl(r.site);
    const columns = sheet.columns.map((c) => c.fieldId);
    const range = `${r.from} → ${r.to}`;

    const head = el('tr');
    head.append(el('th', 'col-user', headers.groupBy.join(' › ')));
    columns.forEach((c, i) => head.append(el('th', isCountColumn(c) ? 'num' : 'cr-col', headers.columns[i] ?? '')));
    for (const k of tree.periodKeys) {
      const th = el('th', 'num', periodLabel(k, sheet.period));
      th.title = k;
      head.append(th);
    }
    head.append(el('th', 'num col-total', headers.total));
    const thead = el('thead');
    thead.append(head);

    const tbody = el('tbody');
    if (tree.nodes.length === 0) tbody.append(this.noData(2 + columns.length + tree.periodKeys.length));
    for (const row of visibleRows(tree.nodes, this.collapsed)) {
      const { node } = row;
      const tr = el('tr', `cr-depth-${row.depth}`);
      const th = el('th', 'col-user cr-tree-cell');
      th.scope = 'row';
      th.style.paddingLeft = `${0.5 + row.depth * 1.25}rem`;
      if (row.hasChildren) {
        const t = el('button', 'cr-toggle', row.expanded ? '▾' : '▸');
        t.type = 'button';
        t.dataset.path = row.path;
        t.setAttribute('aria-expanded', String(row.expanded));
        t.setAttribute('aria-label', `${row.expanded ? 'Collapse' : 'Expand'} ${node.label}`);
        th.append(t);
      } else {
        th.append(el('span', 'cr-toggle-space'));
      }
      const key = issueKeyOf(node);
      if (key && baseUrl) th.append(link(baseUrl, key), document.createTextNode(node.label.startsWith(key) ? node.label.slice(key.length) : ` ${node.label}`));
      else th.append(document.createTextNode(node.label));
      th.title = node.label;
      if (node.value === '') th.classList.add('cr-none');
      tr.append(th);
      for (const c of columns) tr.append(el('td', isCountColumn(c) ? 'num' : 'cr-col', String(groupColumnCell(node, c))));
      const title = findNode(tree.nodes, row.path)?.labels.join(' › ') ?? node.label;
      for (const k of tree.periodKeys) {
        const td = el('td', 'num', this.amount(node.periods[k] ?? 0, s));
        this.drillCell(td, node.periods[k] ?? 0, { title, subtitle: periodLabel(k, sheet.period), ids: node.worklogIds, periodKey: k });
        tr.append(td);
      }
      const total = el('td', 'num col-total', this.amount(node.total, s));
      this.drillCell(total, node.total, { title, subtitle: range, ids: node.worklogIds });
      tr.append(total);
      tbody.append(tr);
    }

    const parts: HTMLElement[] = [thead, tbody];
    if (s.showTotals) {
      const tr = el('tr');
      const label = el('th', 'col-user', 'Total');
      label.scope = 'row';
      tr.append(label);
      // Counts: distinct over the whole sheet (not the sum of the rows).
      for (const c of columns) tr.append(isCountColumn(c) ? el('td', 'num', String(groupColumnCell(tree, c))) : el('td', 'cr-col'));
      const all = { title: `${s.name}: all results`, ids: s.worklogIds };
      for (const k of tree.periodKeys) {
        const td = el('td', 'num', this.amount(tree.periods[k] ?? 0, s));
        this.drillCell(td, tree.periods[k] ?? 0, { ...all, subtitle: periodLabel(k, sheet.period), periodKey: k });
        tr.append(td);
      }
      const grand = el('td', 'num col-total grand', this.amount(tree.total, s));
      this.drillCell(grand, tree.total, { ...all, subtitle: range });
      tr.append(grand);
      const tfoot = el('tfoot');
      tfoot.append(tr);
      parts.push(tfoot);
    }
    this.e.table.replaceChildren(...parts);
    this.e.table.classList.add('cr-tree');
    const any = parentPaths(tree.nodes).length > 0;
    this.e.expandAll.hidden = this.e.collapseAll.hidden = !any;
    this.e.rowCap.hidden = true;
  }

  private renderFlat(s: FlatSheetResult): void {
    const r = this.report!;
    const baseUrl = this.deps.siteUrl(r.site);
    const t = flatTable(s);
    const amounts = new Set(t.amountColumns);
    const dates = new Set(t.dateColumns);
    const head = el('tr');
    t.header.forEach((h, i) => head.append(el('th', amounts.has(i) ? 'num' : 'cr-col', h)));
    const thead = el('thead');
    thead.append(head);

    const tbody = el('tbody');
    const tfoot = el('tfoot');
    const dataRows = t.rows.filter((x) => x.kind === 'data');
    if (dataRows.length === 0) tbody.append(this.noData(Math.max(1, t.header.length)));
    const range = `${r.from} → ${r.to}`;
    let shown = 0;
    for (const [rowIndex, row] of t.rows.entries()) {
      const total = row.kind === 'total';
      if (!total && shown >= PREVIEW_ROW_CAP) continue;
      if (!total) shown++;
      const tr = el('tr');
      row.cells.forEach((cell, i) => {
        const col = s.columns[i];
        if (amounts.has(i)) {
          const seconds = typeof cell === 'number' ? cell : 0;
          const td = el('td', total ? 'num col-total grand' : 'num', this.amount(seconds, s));
          const ids = total ? s.worklogIds : row.worklogIds;
          // A row: its first two text cells (e.g. "Alice · FFN-1"), else the issue key / sheet name.
          const text = row.cells.filter((c, j) => !amounts.has(j) && !dates.has(j) && String(c).trim()).slice(0, 2).join(' · ');
          const title = total ? `${s.name}: all rows` : text || (s.mode === 'eachIssue' ? s.rows[rowIndex]?.key : undefined) || s.name;
          this.drillCell(td, seconds, { title, subtitle: range, ids });
          tr.append(td);
          return;
        }
        const text = dates.has(i) && typeof cell === 'string' ? formatTimestamp(cell, r.timeZone) : String(cell);
        const td = el(total && text ? 'th' : 'td', 'cr-col');
        if (!total && col && LINK_COLUMNS.has(col) && baseUrl && ISSUE_KEY.test(text)) td.append(link(baseUrl, text));
        else td.textContent = text;
        if (text.length > 40) td.title = text;
        tr.append(td);
      });
      (total ? tfoot : tbody).append(tr);
    }
    this.e.table.replaceChildren(thead, tbody, ...(tfoot.childElementCount ? [tfoot] : []));
    this.e.table.classList.remove('cr-tree');
    this.e.expandAll.hidden = this.e.collapseAll.hidden = true;
    this.e.rowCap.hidden = dataRows.length <= PREVIEW_ROW_CAP;
    this.e.rowCap.textContent = `Showing the first ${PREVIEW_ROW_CAP} of ${dataRows.length} rows. The .xlsx has all of them; the Total row covers all of them.`;
  }

  private noData(span: number): HTMLTableRowElement {
    const td = el('td', 'no-data', 'No time logged for this sheet.');
    td.colSpan = span;
    const tr = el('tr');
    tr.append(td);
    return tr;
  }
}
