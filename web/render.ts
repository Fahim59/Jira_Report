import type { Drilldown } from './drilldown.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 27000 -> "7.5h", 25200 -> "7h", 0 -> "0h". Same rounding as scripts/probe.ts. */
export function formatHours(seconds: number): string {
  const h = Math.round((seconds / 3600) * 100) / 100;
  return `${h}h`;
}

/**
 * retrievedAt is an ISO timestamp already expressed in REPORT_TZ (e.g. 2026-10-06T19:20:05+06:00),
 * so its wall-clock fields are reformatted as-is -> "06-Oct-2026 19:20:05".
 */
export function formatRetrieved(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, hh, mi, ss] = m;
  return `${d}-${MONTHS[Number(mo) - 1]}-${y} ${hh}:${mi}:${ss}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function issueCell(key: string, jiraBaseUrl: string | undefined): HTMLTableCellElement {
  const td = el('td', 'issue');
  if (!jiraBaseUrl) {
    td.textContent = key;
    return td;
  }
  const a = el('a', undefined, key);
  a.href = `${jiraBaseUrl}/browse/${encodeURIComponent(key)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  td.append(a);
  return td;
}

/**
 * Worklog table for the modal. User cell: plain list + total.
 * TOTAL-row cell (grouped): a header and subtotal per user, then the overall total.
 */
export function renderDrilldown(table: HTMLTableElement, d: Drilldown, jiraBaseUrl: string | undefined, grouped: boolean): void {
  table.replaceChildren();
  const COLS = 4;

  const thead = el('thead');
  const head = el('tr');
  head.append(el('th', undefined, 'Issue'), el('th', undefined, 'Summary'), el('th', undefined, 'Project'), el('th', 'num', 'Time'));
  thead.append(head);

  const tbody = el('tbody');
  if (d.groups.length === 0) {
    const tr = el('tr');
    const td = el('td', 'no-data', 'No worklogs.');
    td.colSpan = COLS;
    tr.append(td);
    tbody.append(tr);
  }
  for (const g of d.groups) {
    if (grouped) {
      const tr = el('tr', 'group');
      const th = el('th', undefined, g.user);
      th.colSpan = COLS - 1;
      th.scope = 'rowgroup';
      th.title = g.accountId;
      tr.append(th, el('th', 'num', formatHours(g.total)));
      tbody.append(tr);
    }
    for (const wl of g.worklogs) {
      const tr = el('tr');
      tr.append(issueCell(wl.issueKey, jiraBaseUrl), el('td', 'summary', wl.summary), el('td', undefined, wl.project), el('td', 'num', formatHours(wl.seconds)));
      tbody.append(tr);
    }
  }

  const tfoot = el('tfoot');
  const total = el('tr');
  const label = el('th', undefined, 'Total');
  label.colSpan = COLS - 1;
  label.scope = 'row';
  total.append(label, el('td', 'num', formatHours(d.total)));
  tfoot.append(total);

  table.append(thead, tbody, tfoot);
}
