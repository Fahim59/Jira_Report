// Team Reports table (DOM). The rules are in ./logic.ts.
import { formatTime, initials, issueIconFor, type PeriodColumn, type Pivot, type PivotCell, type TimeFormat } from './logic.js';

export interface PivotView {
  format: TimeFormat;
  hoursPerDay: number;
  /** Jira base URL of the report's site (issue links); undefined = keys are plain text. */
  siteUrl?: string;
  /** accountId → 24×24 profile picture. */
  avatars: ReadonlyMap<string, string>;
  /** Issue key → issue type name (icon). */
  issueTypes: ReadonlyMap<string, string>;
  /** Several sites: the Jira base URL for one node's issue link (overrides `siteUrl`). */
  siteUrlFor?: (node: PivotCell['node']) => string | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function th(className: string, ...children: Array<HTMLElement | string>): HTMLTableCellElement {
  const cell = el('th', className);
  cell.append(...children);
  return cell;
}

function periodHead(c: PeriodColumn, solo: boolean): HTMLTableCellElement {
  const cell = th(`tr-period${c.weekend ? ' tr-weekend' : ''}${solo ? ' tr-period-solo' : ''}`, el('span', 'tr-p-main', c.text));
  if (c.sub) cell.append(el('span', 'tr-p-sub', c.sub));
  cell.scope = 'col';
  return cell;
}

function avatar(name: string, url: string | undefined): HTMLElement {
  const box = el('span', 'tr-avatar');
  const fallback = () => {
    box.replaceChildren(document.createTextNode(initials(name)));
    box.classList.add('tr-avatar-initials');
  };
  if (!url) {
    fallback();
    return box;
  }
  const img = el('img');
  img.src = url;
  img.alt = '';
  img.width = 24;
  img.height = 24;
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', fallback, { once: true });
  box.append(img);
  return box;
}

/** The first cell of a group: user (picture + name), issue (type icon + linked key), or plain text. */
function labelContent(cell: PivotCell, view: PivotView): HTMLElement {
  const { node } = cell;
  const wrap = el('span', 'tr-who');
  if (node.fieldId === 'worklog.author' && node.value) {
    wrap.append(avatar(node.label, view.avatars.get(node.value)), el('span', 'tr-who-name', node.label));
    return wrap;
  }
  if (node.fieldId === 'issue.key' && node.value) {
    wrap.append(el('span', `tr-icon tr-icon-${issueIconFor(view.issueTypes.get(node.value))}`));
    const base = view.siteUrlFor ? view.siteUrlFor(node) : view.siteUrl;
    if (base) {
      const a = el('a', 'tr-issue', node.label);
      a.href = `${base.replace(/\/+$/, '')}/browse/${encodeURIComponent(node.value)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap.append(a);
    } else {
      wrap.append(el('span', 'tr-issue', node.label));
    }
    return wrap;
  }
  wrap.append(el('span', 'tr-who-name', node.label));
  return wrap;
}

/** Renders the pivot into `table` (replacing its content). */
export function renderPivot(table: HTMLTableElement, pivot: Pivot, view: PivotView): void {
  const fmt = (seconds: number) => formatTime(seconds, view.format, view.hoursPerDay);
  const headRows = pivot.banners.length ? 2 : 1;
  const colCount = (pivot.flat ? 1 : pivot.levels.length * 2) + pivot.columns.length;

  const head = el('thead');
  const first = el('tr');
  if (pivot.flat) {
    const total = th('tr-total-head', 'Total');
    total.rowSpan = headRows;
    first.append(total);
  }
  for (const level of pivot.levels) {
    const lv = th('tr-level', level);
    lv.rowSpan = headRows;
    const total = th('tr-total-head', 'Total', el('br'), level);
    total.rowSpan = headRows;
    first.append(lv, total);
  }
  if (pivot.banners.length) {
    for (const b of pivot.banners) {
      const cell = th('tr-banner', b.text);
      cell.colSpan = b.span;
      first.append(cell);
    }
    const second = el('tr');
    second.append(...pivot.columns.map((c) => periodHead(c, false)));
    head.append(first, second);
  } else {
    first.append(...pivot.columns.map((c) => periodHead(c, true)));
    head.append(first);
  }

  const body = el('tbody');
  if (pivot.flat && pivot.total > 0) {
    // No Group By: the one row is the total of everything, per period.
    const tr = el('tr', 'tr-sum');
    tr.append(el('td', 'tr-total', fmt(pivot.total)));
    pivot.totals.forEach((seconds, i) => tr.append(el('td', `tr-amt${pivot.columns[i]!.weekend ? ' tr-weekend' : ''}`, fmt(seconds))));
    body.append(tr);
  } else if (pivot.rows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'tr-empty', 'No work logged for this selection.');
    td.colSpan = colCount;
    tr.append(td);
    body.append(tr);
  }
  for (const row of pivot.rows) {
    const tr = el('tr');
    for (const cell of row.cells) {
      const td = el('td', cell.kind === 'label' ? 'tr-label' : 'tr-total');
      td.rowSpan = cell.rowSpan;
      if (cell.kind === 'label') td.append(labelContent(cell, view));
      else td.textContent = fmt(cell.node.total);
      tr.append(td);
    }
    row.amounts.forEach((seconds, i) => {
      const td = el('td', `tr-amt${pivot.columns[i]!.weekend ? ' tr-weekend' : ''}`, fmt(seconds));
      tr.append(td);
    });
    body.append(tr);
  }

  if (pivot.rows.length > 0) {
    const tr = el('tr', 'tr-sum');
    pivot.levels.forEach((_, i) => {
      tr.append(el('td', 'tr-label tr-sum-label', i === 0 ? 'Total' : ''), el('td', 'tr-total', fmt(pivot.total)));
    });
    pivot.totals.forEach((seconds, i) => tr.append(el('td', `tr-amt${pivot.columns[i]!.weekend ? ' tr-weekend' : ''}`, fmt(seconds))));
    body.append(tr);
  }

  table.replaceChildren(head, body);
}
