// List tab: a look-alike of Jira's List view. Projects + Users on top, then Filter / Group / ⋯ / Configure columns;
// the table is the work items of the selection (POST /api/list), with the hierarchy under each parent.
import { getActiveUserIds, getFields, getProjects, getUsers, postList, postListExport, type FieldInfo, type ListResult } from '../api.js';
import { MultiSelect, type MultiOption } from '../multiselect.js';
import { setSiteLock } from '../site-lock.js';
import {
  deleteView,
  findView,
  loadSiteViews,
  renameView,
  setDefaultView,
  stateKey,
  storeSiteViews,
  upsertView,
  viewNameProblem,
  type ListViewState,
  type SiteViews,
} from './views-logic.js';
import { issueIconFor } from '../team/logic.js';
import {
  activeFilterCount,
  columnLabel,
  cellText,
  DEFAULT_COLUMNS,
  DEFAULT_FILTER_FIELDS,
  distinctValues,
  filterRows,
  isListField,
  layoutLines,
  listFieldName,
  moveColumn,
  PAGE_SIZE,
  pageLines,
  parentKeys,
  requestFields,
  type BasicFilter,
  type ListRowData,
} from './logic.js';

export interface ListTabDeps {
  siteSelect: HTMLSelectElement;
  /** Selected site key; undefined = the server's default. */
  site: () => string | undefined;
  /** Jira base URL of a site (work item links). */
  siteUrl: (key: string | undefined) => string | undefined;
}

export interface ListTab {
  shown(): void;
  hidden(): void;
  siteChanged(): void;
}

/** How far back work counts as recent for the Users list. */
const ACTIVITY_DAYS = 90;
const COLUMNS_KEY = 'worklog-report:list-columns-2';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showMsg(target: HTMLElement, message: string | undefined): void {
  target.textContent = message ?? '';
  target.hidden = !message;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadColumns(): string[] | undefined {
  try {
    const v = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? 'null') as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function saveColumns(columns: string[]): void {
  try {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // Storage unavailable: the choice is just not remembered.
  }
}

/** A button with a drop-down panel under it. The panel is rebuilt by `build` each time it opens. */
class Popover {
  readonly wrap = el('div', 'ls-pop-wrap');
  readonly button: HTMLButtonElement;
  readonly panel = el('div', 'ls-pop');
  private open = false;

  constructor(label: string, private readonly build: (panel: HTMLElement) => void, opts: { aria?: string; className?: string } = {}) {
    this.button = el('button', `secondary ${opts.className ?? ''}`.trim(), label);
    this.button.type = 'button';
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    if (opts.aria) this.button.setAttribute('aria-label', opts.aria);
    this.panel.hidden = true;
    this.wrap.append(this.button, this.panel);
    this.button.addEventListener('click', () => (this.open ? this.close() : this.show()));
    document.addEventListener('mousedown', (e) => {
      if (this.open && !this.wrap.contains(e.target as Node)) this.close();
    });
    this.wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) {
        this.close();
        this.button.focus();
      }
    });
  }

  show(): void {
    this.rebuild();
    this.panel.hidden = false;
    this.open = true;
    this.button.setAttribute('aria-expanded', 'true');
  }

  close(): void {
    this.panel.hidden = true;
    this.open = false;
    this.button.setAttribute('aria-expanded', 'false');
  }

  get isOpen(): boolean {
    return this.open;
  }

  rebuild(): void {
    this.panel.replaceChildren();
    this.build(this.panel);
  }
}

export function setupList(deps: ListTabDeps): ListTab {
  const metaError = $<HTMLParagraphElement>('ls-meta-error');
  const formError = $<HTMLParagraphElement>('ls-error');
  const formInfo = $<HTMLParagraphElement>('ls-info');
  const loadingBox = $<HTMLDivElement>('ls-loading');
  const wrap = $<HTMLDivElement>('ls-wrap');
  const table = $<HTMLTableElement>('ls-table');
  const footer = $<HTMLParagraphElement>('ls-footer');
  const hint = $<HTMLParagraphElement>('ls-hint');
  const tools = $<HTMLDivElement>('ls-tools');

  let visible = false;
  let loadedFor: string | null = null;
  let loadSeq = 0;
  let fields: FieldInfo[] = [];
  let fieldById = new Map<string, FieldInfo>();
  let result: ListResult | undefined;
  /** The field ids the shown result was loaded with. */
  let loadedFields = '';
  let abort: AbortController | undefined;
  /** What the shown result was asked with: the Excel export asks again for every match. */
  let lastRequest: { projects: string[]; assignees: string[]; jql: string; hideDone: boolean; fields: string[] } | undefined;
  let reloadTimer: number | undefined;
  let busy = false;
  let exporting = false;
  /** Work items shown (grows by PAGE_SIZE with "Load more"); back to one page when the rows, filter, group or hierarchy change. */
  let pageLimit = PAGE_SIZE;
  let pageSignature = '';

  let columns: string[] = loadColumns() ?? [...DEFAULT_COLUMNS];
  let groupField: string | undefined;
  let basic: BasicFilter = {};
  let extraFilterFields: string[] = [];
  let jql = '';
  let hideDone = false;
  let hierarchy = true;
  let expanded = new Set<string>();
  let collapsedGroups = new Set<string>();
  let filterTab: 'basic' | 'jql' = 'basic';
  let filterField: string | undefined;

  // Saved views (browser only, per site).
  let siteViews: SiteViews = { views: [] };
  let currentView: string | undefined;
  let baseline = '';

  const multi = (id: string) => fieldById.get(id)?.schemaType.startsWith('array<') ?? false;
  const nameOf = (id: string) => listFieldName(id, fieldById.get(id)?.name ?? id);
  /** Header of a table column (the Issue list export's names). */
  const headerName = (id: string) => columnLabel(id, fieldById.get(id)?.name ?? id);
  const filterFields = () => [...DEFAULT_FILTER_FIELDS.filter((id) => fieldById.has(id)), ...extraFilterFields];

  const projectPicker = new MultiSelect($<HTMLDivElement>('ls-projects'), {
    max: 50,
    noun: 'projects',
    emptyText: 'None selected = all projects',
    placeholder: 'All projects — type to search',
    labelledBy: 'ls-projects-label',
    tools: false,
    onChange: () => scheduleLoad(),
  });
  const userPicker = new MultiSelect($<HTMLDivElement>('ls-users'), {
    max: 100,
    noun: 'users',
    emptyText: 'None selected = all users',
    placeholder: 'All users — type to search',
    labelledBy: 'ls-users-label',
    tools: false,
    onChange: () => scheduleLoad(),
  });

  // ---- saved views ----

  const BLANK: ListViewState = { projects: [], users: [], jql: '', hideDone: false, hierarchy: true, columns: [...DEFAULT_COLUMNS], basic: {}, filterFields: [] };

  function snapshot(): ListViewState {
    return {
      projects: projectPicker.values,
      users: userPicker.values,
      jql,
      hideDone,
      hierarchy,
      ...(groupField ? { groupField } : {}),
      columns,
      basic: Object.fromEntries(Object.entries(basic).map(([k, v]) => [k, [...v]])),
      filterFields: extraFilterFields,
    };
  }

  /** Puts a view (or a blank one) into the pickers, filters, group and columns, then loads its work items. */
  function applyState(st: ListViewState): void {
    projectPicker.setValues(st.projects);
    userPicker.setValues(st.users);
    jql = st.jql;
    hideDone = st.hideDone;
    hierarchy = st.hierarchy;
    groupField = st.groupField && fieldById.has(st.groupField) ? st.groupField : undefined;
    const known = st.columns.filter((c) => fieldById.has(c));
    columns = known.length ? known : DEFAULT_COLUMNS.filter((c) => fieldById.has(c));
    saveColumns(columns);
    basic = Object.fromEntries(Object.entries(st.basic).map(([k, v]) => [k, [...v]]));
    extraFilterFields = st.filterFields.filter((id) => fieldById.has(id) && !(DEFAULT_FILTER_FIELDS as readonly string[]).includes(id));
    expanded = new Set();
    collapsedGroups = new Set();
    filterField = undefined;
    baseline = stateKey(snapshot());
    updateToolLabels();
    scheduleLoad(0);
  }

  const viewStore = (): Storage | undefined => {
    try {
      return window.localStorage ?? undefined;
    } catch {
      return undefined;
    }
  };
  const viewScope = () => deps.site() ?? 'default';

  const viewBar = el('div', 'ls-views');
  const viewSelect = el('select');
  viewSelect.id = 'ls-view';
  const viewLabel = el('label', 'ls-view-pick');
  viewLabel.htmlFor = 'ls-view';
  const dirtyDot = el('span', 'cr-dirty', '●');
  dirtyDot.title = 'Unsaved changes';
  dirtyDot.hidden = true;
  const viewButton = (text: string, onClick: () => void) => {
    const b = el('button', 'secondary', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const viewNote = el('span', 'ls-view-note');
  viewNote.setAttribute('role', 'status');

  const saveBtn = viewButton('Save', () => saveView());
  const saveAsBtn = viewButton('Save as…', () => saveViewAs());
  const renameBtn = viewButton('Rename…', () => renameCurrent());
  const deleteBtn = viewButton('Delete', () => deleteCurrent());
  const defaultBtn = viewButton('Make default', () => toggleDefault());
  viewLabel.append(el('span', undefined, 'View'), viewSelect);
  viewBar.append(viewLabel, dirtyDot, saveBtn, saveAsBtn, renameBtn, deleteBtn, defaultBtn, viewNote);
  $('tab-list').prepend(viewBar);

  const isDirty = () => fields.length > 0 && stateKey(snapshot()) !== baseline;
  const NEW_VIEW = '';

  function updateViews(): void {
    const ready = fields.length > 0 && !busy;
    const dirty = isDirty();
    dirtyDot.hidden = !dirty;
    saveBtn.disabled = !ready || !dirty;
    saveAsBtn.disabled = !ready;
    renameBtn.disabled = !ready || !currentView;
    deleteBtn.disabled = !ready || !currentView;
    const isDefault = !!currentView && siteViews.defaultName === currentView;
    defaultBtn.disabled = !ready || !currentView;
    defaultBtn.textContent = isDefault ? 'Remove default' : 'Make default';
    defaultBtn.title = currentView ? (isDefault ? 'This view opens first on this site. Click to remove that.' : 'Open this view first when the List tab loads on this site') : 'Save the view first';
    viewSelect.disabled = !ready;
  }

  function renderViewSelect(): void {
    const option = (value: string, label: string) => {
      const o = el('option', undefined, label);
      o.value = value;
      return o;
    };
    viewSelect.replaceChildren(
      option(NEW_VIEW, currentView ? '+ New view' : 'New view'),
      ...siteViews.views.map((v) => option(v.name, `${v.name}${siteViews.defaultName === v.name ? ' ★ default' : ''}`)),
    );
    viewSelect.value = currentView ?? NEW_VIEW;
    updateViews();
  }

  function persist(next: SiteViews): boolean {
    const problem = storeSiteViews(viewStore(), viewScope(), next);
    if (problem) {
      viewNote.textContent = problem;
      return false;
    }
    siteViews = next;
    return true;
  }

  function askName(initial: string, renaming?: string): string | undefined {
    const ask = renaming ? 'New name for this view:' : 'Name for this view:';
    let message = ask;
    let input: string | null = initial;
    for (;;) {
      input = window.prompt(message, input);
      if (input === null) return undefined;
      const v = viewNameProblem(siteViews, input, renaming);
      if ('name' in v) return v.name;
      message = `${v.error}\n\n${ask}`;
    }
  }

  function saveView(): void {
    if (!currentView) return saveViewAs();
    viewNote.textContent = '';
    if (persist(upsertView(siteViews, currentView, snapshot()))) {
      baseline = stateKey(snapshot());
      viewNote.textContent = `Saved "${currentView}".`;
      renderViewSelect();
    }
  }

  function saveViewAs(): void {
    viewNote.textContent = '';
    const name = askName(currentView ?? '');
    if (!name) return;
    const existing = findView(siteViews, name);
    if (existing && !window.confirm(`A view named "${existing.name}" already exists. Overwrite it?`)) return;
    if (persist(upsertView(siteViews, name, snapshot()))) {
      currentView = findView(siteViews, name)!.name;
      baseline = stateKey(snapshot());
      viewNote.textContent = `Saved "${currentView}".`;
      renderViewSelect();
    }
  }

  function renameCurrent(): void {
    if (!currentView) return;
    viewNote.textContent = '';
    const name = askName(currentView, currentView);
    if (!name || name === currentView) return;
    if (persist(renameView(siteViews, currentView, name))) {
      currentView = name;
      renderViewSelect();
    }
  }

  function deleteCurrent(): void {
    if (!currentView || !window.confirm(`Delete view "${currentView}"?`)) return;
    viewNote.textContent = '';
    if (persist(deleteView(siteViews, currentView))) {
      currentView = undefined; // what is on screen stays, as an unsaved new view
      baseline = stateKey(BLANK);
      renderViewSelect();
    }
  }

  function toggleDefault(): void {
    if (!currentView) return;
    viewNote.textContent = '';
    const isDefault = siteViews.defaultName === currentView;
    if (persist(setDefaultView(siteViews, isDefault ? undefined : currentView))) renderViewSelect();
  }

  viewSelect.addEventListener('change', () => {
    const name = viewSelect.value;
    if (isDirty() && !window.confirm(`Discard your unsaved changes${currentView ? ` to "${currentView}"` : ''}?`)) {
      viewSelect.value = currentView ?? NEW_VIEW;
      return;
    }
    viewNote.textContent = '';
    currentView = name === NEW_VIEW ? undefined : name;
    applyState(name === NEW_VIEW ? BLANK : (findView(siteViews, name)?.state ?? BLANK));
    renderViewSelect();
  });

  /** After the lists of a site are loaded: its saved views, and the default one opens. */
  function loadViews(): void {
    const { value, problem } = loadSiteViews(viewStore(), viewScope());
    siteViews = value;
    viewNote.textContent = problem ?? '';
    const def = value.defaultName ? findView(value, value.defaultName) : undefined;
    currentView = def?.name;
    if (def) applyState(def.state);
    else baseline = stateKey(snapshot());
    renderViewSelect();
  }

  // ---- tool buttons ----

  const filterPop = new Popover('Filter', (p) => buildFilter(p), { className: 'ls-filter-btn' });
  const groupPop = new Popover('Group', (p) => buildGroup(p));
  const morePop = new Popover('⋯', (p) => buildMore(p), { aria: 'More options' });
  const columnsPop = new Popover('Configure columns', (p) => buildColumns(p));
  filterPop.panel.classList.add('ls-pop-right');
  groupPop.panel.classList.add('ls-pop-right');
  morePop.panel.classList.add('ls-pop-right');
  columnsPop.panel.classList.add('ls-pop-right');
  tools.append(filterPop.wrap, groupPop.wrap, morePop.wrap, columnsPop.wrap);

  function updateToolLabels(): void {
    const n = activeFilterCount(basic) + (jql.trim() ? 1 : 0);
    filterPop.button.textContent = n ? `Filter ${n}` : 'Filter';
    filterPop.button.classList.toggle('active', n > 0);
    groupPop.button.textContent = groupField ? `Group: ${nameOf(groupField)}` : 'Group';
    groupPop.button.classList.toggle('active', !!groupField);
    updateViews();
  }

  // ---- Filter ----

  function buildFilter(p: HTMLElement): void {
    const tabs = el('div', 'ls-tabs');
    for (const [id, label] of [['basic', 'Basic'], ['jql', 'JQL']] as const) {
      const b = el('button', filterTab === id ? 'ls-tab on' : 'ls-tab', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        filterTab = id;
        filterPop.rebuild();
      });
      tabs.append(b);
    }
    const clear = el('button', 'ls-link', 'Clear all');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      basic = {};
      const hadJql = jql.trim() !== '';
      jql = '';
      updateToolLabels();
      filterPop.rebuild();
      if (hadJql) scheduleLoad(0);
      else render();
    });
    p.append(tabs);
    if (filterTab === 'jql') {
      const box = el('textarea', 'ls-jql');
      box.rows = 5;
      box.spellcheck = false;
      box.placeholder = 'e.g. status = "In Progress" ORDER BY created DESC';
      box.value = jql;
      const go = el('button', undefined, 'Search');
      go.type = 'button';
      go.addEventListener('click', () => {
        jql = box.value.trim();
        updateToolLabels();
        scheduleLoad(0);
      });
      p.append(box, el('p', 'ls-note', 'Combined with the projects and users above. An ORDER BY at the end sets the order.'), go, clear);
      return;
    }

    const body = el('div', 'ls-filter-body');
    const left = el('div', 'ls-filter-fields');
    const right = el('div', 'ls-filter-values');
    const drawRight = () => {
      right.replaceChildren();
      if (!filterField) {
        right.append(el('p', 'ls-note', 'Select a field to start creating a filter.'));
        return;
      }
      const field = filterField;
      const search = el('input');
      search.type = 'text';
      search.placeholder = `Search ${nameOf(field).toLowerCase()}`;
      const list = el('div', 'ls-values');
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const values = distinctValues(result?.rows ?? [], field, multi(field)).filter((v) => (v.value || 'none').toLowerCase().includes(q));
        list.replaceChildren(
          ...(values.length ? values : [{ value: '\u0000', count: 0 }]).map((v) => {
            if (v.value === '\u0000') return el('p', 'ls-note', result ? 'No values.' : 'Load work items first.');
            const l = el('label', 'ls-value');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = (basic[field] ?? []).includes(v.value);
            cb.addEventListener('change', () => {
              const cur = new Set(basic[field] ?? []);
              if (cb.checked) cur.add(v.value);
              else cur.delete(v.value);
              basic = { ...basic, [field]: [...cur] };
              updateToolLabels();
              drawLeft();
              render();
            });
            l.append(cb, el('span', undefined, v.value || 'None'), el('span', 'ls-count', String(v.count)));
            return l;
          }),
        );
      };
      search.addEventListener('input', draw);
      draw();
      right.append(search, list);
    };
    const drawLeft = () => {
      left.replaceChildren(
        ...filterFields().map((id) => {
          const b = el('button', id === filterField ? 'ls-field on' : 'ls-field');
          b.type = 'button';
          b.append(el('span', undefined, nameOf(id)));
          const n = (basic[id] ?? []).length;
          if (n) b.append(el('span', 'ls-badge', String(n)));
          b.addEventListener('click', () => {
            filterField = id;
            drawLeft();
            drawRight();
          });
          return b;
        }),
      );
      const add = el('select', 'ls-add-field');
      add.setAttribute('aria-label', 'Add field');
      const first = el('option', undefined, '+ Add field');
      first.value = '';
      add.append(first);
      for (const f of fields.filter((x) => !filterFields().includes(x.id)).sort((a, b) => a.name.localeCompare(b.name))) {
        const o = el('option', undefined, listFieldName(f.id, f.name));
        o.value = f.id;
        add.append(o);
      }
      add.addEventListener('change', () => {
        if (!add.value) return;
        extraFilterFields = [...extraFilterFields, add.value];
        filterField = add.value;
        drawLeft();
        drawRight();
        if (requestKey() !== loadedFields) scheduleLoad(0); // the values of the new field are loaded with the rows
      });
      left.append(add);
    };
    drawLeft();
    drawRight();
    body.append(left, right);
    p.append(body, clear);
  }

  // ---- Group ----

  function buildGroup(p: HTMLElement): void {
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search grouping options';
    const list = el('div', 'ls-options');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...fields
          .filter((f) => f.name.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => {
            const b = el('button', f.id === groupField ? 'ls-option on' : 'ls-option', listFieldName(f.id, f.name));
            b.type = 'button';
            b.addEventListener('click', () => {
              groupField = f.id;
              collapsedGroups = new Set();
              groupPop.close();
              updateToolLabels();
              if (requestKey() !== loadedFields) scheduleLoad(0);
              else render();
            });
            return b;
          }),
      );
    };
    search.addEventListener('input', draw);
    const clear = el('button', 'ls-link', 'Clear selection');
    clear.type = 'button';
    clear.disabled = !groupField;
    clear.addEventListener('click', () => {
      groupField = undefined;
      groupPop.close();
      updateToolLabels();
      render();
    });
    draw();
    p.append(search, list, clear);
  }

  // ---- ⋯ ----

  function buildMore(p: HTMLElement): void {
    const toggle = (label: string, on: boolean, change: (v: boolean) => void) => {
      const l = el('label', 'ls-switch');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.addEventListener('change', () => change(cb.checked));
      l.append(el('span', undefined, label), cb);
      return l;
    };
    const exportBtn = el('button', 'ls-menu-item', 'Export to Excel');
    exportBtn.type = 'button';
    exportBtn.disabled = !result || busy || exporting;
    exportBtn.addEventListener('click', () => {
      morePop.close();
      void exportExcel();
    });
    p.append(
      toggle('Hide done work items', hideDone, (v) => {
        hideDone = v;
        scheduleLoad(0);
      }),
      toggle('Show hierarchy', hierarchy, (v) => {
        hierarchy = v;
        render();
      }),
      el('hr', 'ls-sep'),
      exportBtn,
    );
  }

  // ---- Configure columns ----

  /** Columns changed (added, removed or moved): remembered, and the table follows (a reload only when new fields are needed). */
  function columnsChanged(): void {
    saveColumns(columns);
    if (requestKey() !== loadedFields) scheduleLoad();
    else render();
  }

  function buildColumns(p: HTMLElement): void {
    // The shown columns, in table order: drag a row (or use the arrows) to move it, like Jira's Configure columns.
    const shown = el('div', 'ls-shown');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search columns';
    const list = el('div', 'ls-options');
    const total = el('p', 'ls-note');

    const drawShown = () => {
      const ids = columns.filter((c) => fieldById.has(c));
      const rows = ids.map((id, i) => {
        const row = el('div', 'ls-col-row');
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', String(i));
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          row.classList.add('over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('over'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('over');
          const from = Number(e.dataTransfer?.getData('text/plain'));
          if (Number.isInteger(from) && from !== i) {
            columns = moveColumn(ids, from, i);
            refresh();
          }
        });
        const move = (to: number, label: string) => {
          const b = el('button', 'ls-icon-btn', to < i ? '↑' : '↓');
          b.type = 'button';
          b.title = label;
          b.setAttribute('aria-label', `${label}: ${columnLabel(id, fieldById.get(id)?.name ?? id)}`);
          b.disabled = to < 0 || to >= ids.length;
          b.addEventListener('click', () => {
            columns = moveColumn(ids, i, to);
            refresh();
          });
          return b;
        };
        const remove = el('button', 'ls-icon-btn', '×');
        remove.type = 'button';
        remove.title = 'Remove column';
        remove.setAttribute('aria-label', `Remove column ${columnLabel(id, fieldById.get(id)?.name ?? id)}`);
        remove.addEventListener('click', () => {
          columns = ids.filter((c) => c !== id);
          refresh();
        });
        row.append(el('span', 'ls-grip', '⋮⋮'), el('span', 'ls-col-name', columnLabel(id, fieldById.get(id)?.name ?? id)), move(i - 1, 'Move left'), move(i + 1, 'Move right'), remove);
        return row;
      });
      shown.replaceChildren(el('p', 'ls-sub', 'Shown columns (drag to reorder)'), ...(rows.length ? rows : [el('p', 'ls-note', 'No columns selected.')]));
    };

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...fields
          .filter((f) => columnLabel(f.id, f.name).toLowerCase().includes(q))
          .sort((a, b) => columnLabel(a.id, a.name).localeCompare(columnLabel(b.id, b.name)))
          .map((f) => {
            const l = el('label', 'ls-value');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = columns.includes(f.id);
            cb.addEventListener('change', () => {
              columns = cb.checked ? [...columns, f.id] : columns.filter((c) => c !== f.id);
              refresh();
            });
            l.append(cb, el('span', undefined, columnLabel(f.id, f.name)));
            return l;
          }),
      );
    };
    const refresh = () => {
      drawShown();
      draw();
      total.textContent = `${columns.length} selected of ${fields.length} available fields`;
      columnsChanged();
    };
    drawShown();
    draw();
    total.textContent = `${columns.length} selected of ${fields.length} available fields`;
    search.addEventListener('input', draw);
    p.append(shown, el('p', 'ls-sub', 'Add or remove columns'), search, total, list);
  }

  // ---- loading ----

  const requestKey = () => requestFields(columns, groupField, filterFields()).sort().join(',');

  function scheduleLoad(delay = 400): void {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void load(), delay);
  }

  async function loadLists(): Promise<void> {
    const seq = ++loadSeq;
    const site = deps.site();
    loadedFor = site ?? '';
    showMsg(metaError, undefined);
    const [f, p, u] = await Promise.allSettled([getFields(site), getProjects(site), getUsers(site)]);
    if (seq !== loadSeq) return;
    const problems: string[] = [];
    if (f.status === 'fulfilled') {
      fields = f.value.filter((x) => isListField(x.id));
      fieldById = new Map(fields.map((x) => [x.id, x]));
      columns = columns.filter((c) => fieldById.has(c));
      if (columns.length === 0) columns = DEFAULT_COLUMNS.filter((c) => fieldById.has(c));
    } else {
      problems.push(errText(f.reason));
    }
    if (p.status === 'fulfilled') {
      projectPicker.setOptions(p.value.map((x): MultiOption => ({ value: x.key, name: `${x.key}\n${x.name}`, label: `${x.key} — ${x.name}` })));
    } else {
      problems.push(errText(p.reason));
    }
    if (u.status === 'fulfilled') {
      // Only active users: an inactive account has no work assigned that anyone needs to pick.
      activeUsers = u.value.filter((x) => x.active).map((x): MultiOption => ({ value: x.accountId, name: x.displayName, label: x.displayName }));
      userPicker.setOptions(activeUsers);
      void narrowToRecentUsers(seq);
    } else {
      problems.push(errText(u.reason));
    }
    showMsg(metaError, problems.length ? problems.join(' ') : undefined);
    updateToolLabels();
    if (fields.length) loadViews();
  }

  /** Active users of the site; narrowed to the ones with recent work once that is known (see narrowToRecentUsers). */
  let activeUsers: MultiOption[] = [];

  /**
   * Jira does not say who was invited but has not accepted yet, so the Users list keeps the people with recent activity
   * (assignee / reporter / creator of a work item updated in the last ACTIVITY_DAYS days). Until that is known the
   * active users are listed; if it cannot be found out they stay listed.
   */
  async function narrowToRecentUsers(seq: number): Promise<void> {
    try {
      const { accountIds } = await getActiveUserIds(deps.site(), ACTIVITY_DAYS);
      if (seq !== loadSeq) return;
      const recent = new Set(accountIds);
      const keep = new Set(userPicker.values); // a user already picked stays
      userPicker.setOptions(activeUsers.filter((o) => recent.has(o.value) || keep.has(o.value)));
    } catch {
      // The full active list stays.
    }
  }

  async function load(): Promise<void> {
    abort?.abort();
    if (fields.length === 0) return;
    const projects = projectPicker.values;
    const assignees = userPicker.values;
    if (projects.length === 0 && assignees.length === 0 && jql.trim() === '') {
      result = undefined;
      render();
      return;
    }
    const seq = loadSeq;
    const ctl = (abort = new AbortController());
    const fieldIds = requestFields(columns, groupField, filterFields());
    busy = true;
    loadingBox.hidden = false;
    setSiteLock(deps.siteSelect, 'list', true);
    showMsg(formError, undefined);
    try {
      const res = await postList({ site: deps.site(), projects, assignees, jql, hideDone, fields: fieldIds }, ctl.signal);
      if (ctl.signal.aborted || seq !== loadSeq) return;
      result = res;
      lastRequest = { projects, assignees, jql, hideDone, fields: fieldIds };
      loadedFields = [...fieldIds].sort().join(',');
      expanded = new Set(expanded); // keep what the user opened
      showMsg(formInfo, undefined);
    } catch (err) {
      if (ctl.signal.aborted || seq !== loadSeq) return;
      result = undefined;
      showMsg(formError, errText(err));
    } finally {
      if (abort === ctl) {
        busy = false;
        loadingBox.hidden = true;
        setSiteLock(deps.siteSelect, 'list', false);
      }
    }
    render();
    if (filterPop.isOpen) filterPop.rebuild();
  }

  // ---- table ----

  function currentRows(): ListRowData[] {
    return result ? filterRows(result.rows, basic, multi) : [];
  }

  function render(): void {
    updateViews();
    if (!result) {
      wrap.hidden = true;
      footer.hidden = true;
      hint.hidden = busy || !!formError.textContent;
      return;
    }
    hint.hidden = true;
    wrap.hidden = false;
    const rows = currentRows();
    const signature = `${result.retrievedAt}|${JSON.stringify(basic)}|${groupField ?? ''}|${hierarchy}`;
    if (signature !== pageSignature) {
      pageSignature = signature;
      pageLimit = PAGE_SIZE;
    }
    const all = layoutLines(rows, { hierarchy, groupBy: groupField ? { fieldId: groupField, multi: multi(groupField) } : undefined, expanded, collapsedGroups });
    const page = pageLines(all, pageLimit);
    const lines = page.lines;
    const base = deps.siteUrl(deps.site()) ?? '';
    const cols = columns.filter((c) => fieldById.has(c));

    const head = el('tr');
    const parents = parentKeys(rows, hierarchy);
    cols.forEach((c, i) => {
      const th = el('th', DURATION_LIKE(c) ? 'ls-num' : undefined);
      if (i === 0 && parents.length) {
        const all = parents.every((k) => expanded.has(k));
        const t = el('button', 'ls-toggle', all ? '▾' : '▸');
        t.type = 'button';
        t.title = all ? 'Collapse all' : 'Expand all';
        t.setAttribute('aria-label', t.title);
        t.addEventListener('click', () => {
          expanded = all ? new Set() : new Set(parents);
          render();
        });
        th.append(t);
      }
      th.append(el('span', undefined, headerName(c)));
      // Drag a header onto another to move the column.
      th.draggable = true;
      th.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', c));
      th.addEventListener('dragover', (e) => e.preventDefault());
      th.addEventListener('drop', (e) => {
        e.preventDefault();
        const moved = e.dataTransfer?.getData('text/plain') ?? '';
        const from = columns.indexOf(moved);
        const to = columns.indexOf(c);
        if (from >= 0 && to >= 0 && from !== to) {
          columns = moveColumn(columns, from, to);
          columnsChanged();
        }
      });
      head.append(th);
    });

    /** One cell: status as a label, the key as a link to the work item, durations in Jira's words, the rest as text. */
    const fill = (target: HTMLElement, c: string, r: ListRowData) => {
      const text = cellText(r, c);
      if (c === 'status' && text) {
        target.append(el('span', `ls-status ls-status-${r.statusCategory || 'new'}`, text));
      } else if ((c === 'issue.key' || c === 'issuekey') && text) {
        const key = el('a', r.statusCategory === 'done' ? 'ls-key done' : 'ls-key', text);
        key.href = `${base}/browse/${encodeURIComponent(r.key)}`;
        key.target = '_blank';
        key.rel = 'noopener noreferrer';
        target.append(key);
      } else if (c === 'summary') {
        const span = el('span', 'ls-summary', text);
        span.title = text;
        target.append(span);
      } else {
        target.append(text);
      }
    };

    const body = el('tbody');
    for (const line of lines) {
      const tr = el('tr');
      if (line.kind === 'group') {
        tr.className = 'ls-group';
        const td = el('td');
        td.colSpan = Math.max(cols.length, 1);
        const t = el('button', 'ls-toggle', line.open ? '▾' : '▸');
        t.type = 'button';
        t.setAttribute('aria-label', `${line.open ? 'Collapse' : 'Expand'} group ${line.label}`);
        t.addEventListener('click', () => {
          const next = new Set(collapsedGroups);
          if (line.open) next.add(line.id);
          else next.delete(line.id);
          collapsedGroups = next;
          render();
        });
        td.append(t, el('strong', undefined, line.label), el('span', 'ls-count', ` ${line.count}`));
        tr.append(td);
        body.append(tr);
        continue;
      }
      const r = line.row;
      cols.forEach((c, i) => {
        const td = el('td', DURATION_LIKE(c) ? 'ls-num' : undefined);
        if (i === 0) {
          // The hierarchy sits in the first column: indent, expand / collapse, type icon.
          const inner = el('div', 'ls-work-in');
          inner.style.paddingLeft = `${line.depth * 22}px`;
          if (line.expandable) {
            const t = el('button', 'ls-toggle', line.open ? '▾' : '▸');
            t.type = 'button';
            t.setAttribute('aria-label', `${line.open ? 'Collapse' : 'Expand'} ${r.key}`);
            t.addEventListener('click', () => {
              const next = new Set(expanded);
              if (line.open) next.delete(r.key);
              else next.add(r.key);
              expanded = next;
              render();
            });
            inner.append(t);
          } else {
            inner.append(el('span', 'ls-toggle-gap'));
          }
          inner.append(el('span', `tr-icon tr-icon-${r.subtask ? 'subtask' : issueIconFor(r.type)}`));
          fill(inner, c, r);
          td.append(inner);
        } else {
          fill(td, c, r);
        }
        tr.append(td);
      });
      body.append(tr);
    }
    if (lines.length === 0) {
      const tr = body.insertRow();
      const td = tr.insertCell();
      td.colSpan = Math.max(cols.length, 1);
      td.className = 'no-data';
      td.textContent = 'No work items match.';
    }
    // "Load more" is the last row of the table (the footer under a tall table can be off the screen).
    if (page.items > page.shown) {
      const tr = el('tr', 'ls-more-row');
      const td = el('td');
      td.colSpan = Math.max(cols.length, 1);
      const more = el('button', 'ls-more', `Load more (${Math.min(PAGE_SIZE, page.items - page.shown)} of ${page.items - page.shown} left)`);
      more.type = 'button';
      more.addEventListener('click', () => {
        pageLimit += PAGE_SIZE;
        render();
      });
      td.append(more);
      tr.append(td);
      body.append(tr);
    }
    table.replaceChildren(el('thead'), body);
    table.tHead!.append(head);

    footer.hidden = false;
    const count = `${rows.length}${rows.length === result.rows.length ? '' : ` of ${result.rows.length}`} work item${result.rows.length === 1 ? '' : 's'}${result.truncated ? ` (first ${result.limit}; the Excel export has all)` : ''}`;
    footer.replaceChildren(document.createTextNode(page.items > page.shown ? `Showing ${page.shown} of ${page.items} · ${count}` : count));
    if (page.items > page.shown) {
      // Also here, under the table, where it is always on screen.
      const more = el('button', 'ls-more', `Load more (${Math.min(PAGE_SIZE, page.items - page.shown)} of ${page.items - page.shown} left)`);
      more.type = 'button';
      more.addEventListener('click', () => {
        pageLimit += PAGE_SIZE;
        render();
      });
      footer.append(more);
    }
  }

  /** Time columns are right-aligned. */
  function DURATION_LIKE(id: string): boolean {
    return /^(aggregate)?time(spent|estimate|originalestimate)$/.test(id);
  }

  /** The Excel file has every work item that matches (like Jira's export), not just the ones loaded on screen. */
  async function exportExcel(): Promise<void> {
    if (!result || !lastRequest) return;
    showMsg(formError, undefined);
    let rows = currentRows();
    exporting = true;
    updateViews();
    try {
      if (result.truncated) {
        showMsg(formInfo, 'Exporting: reading every matching work item…');
        const all = await postList({ site: deps.site(), ...lastRequest, all: true });
        rows = filterRows(all.rows, basic, multi);
        showMsg(formInfo, all.truncated ? `Exported the first ${all.limit} work items; the search has more. Narrow the projects, users or JQL to export the rest.` : undefined);
      }
      const cols = columns.filter((c) => fieldById.has(c));
      // Everything open, so the file has all the work items whatever is folded on screen.
      const lines = layoutLines(rows, {
        hierarchy,
        groupBy: groupField ? { fieldId: groupField, multi: multi(groupField) } : undefined,
        expanded: new Set(parentKeys(rows, hierarchy)),
        collapsedGroups: new Set(),
      });
      const file = await postListExport({
        site: deps.site(),
        headers: cols.map(headerName),
        rows: lines.map((l) =>
          l.kind === 'group'
            ? { cells: [`${l.label} (${l.count})`], level: 0, group: true }
            : { cells: cols.map((c) => cellText(l.row, c)), level: l.depth, group: false },
        ),
      });
      download(file.blob, file.filename);
    } catch (err) {
      showMsg(formInfo, undefined);
      showMsg(formError, errText(err));
    } finally {
      exporting = false;
      updateViews();
    }
  }

  function reset(): void {
    abort?.abort();
    window.clearTimeout(reloadTimer);
    result = undefined;
    loadedFields = '';
    groupField = undefined;
    basic = {};
    extraFilterFields = [];
    jql = '';
    expanded = new Set();
    collapsedGroups = new Set();
    filterField = undefined;
    projectPicker.setValues([]);
    projectPicker.setOptions([]);
    userPicker.setValues([]);
    userPicker.setOptions([]);
    fields = [];
    fieldById = new Map();
    siteViews = { views: [] };
    currentView = undefined;
    baseline = '';
    viewNote.textContent = '';
    busy = false;
    loadingBox.hidden = true;
    setSiteLock(deps.siteSelect, 'list', false);
    showMsg(formError, undefined);
    showMsg(formInfo, undefined);
    updateToolLabels();
    render();
  }

  updateToolLabels();
  render();

  return {
    shown() {
      visible = true;
      if (loadedFor === null) void loadLists();
    },
    hidden() {
      visible = false;
    },
    siteChanged() {
      reset();
      loadedFor = null;
      loadSeq++; // drop answers for the old site
      if (visible) void loadLists();
    },
  };
}
