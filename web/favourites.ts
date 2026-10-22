import {
  deleteGroup,
  describeFilters,
  filtersTooltip,
  findGroup,
  hasFilters,
  loadFavourites,
  makeGroup,
  migrateFavourites,
  missingNotice,
  resolveGroup,
  storeFavourites,
  upsertGroup,
  validateGroupName,
  type FavouriteFilters,
  type FavouriteGroup,
  type KeyValueStore,
  type SiteScope,
} from './favourites-logic.js';

/** What favourites need from a picker: its selected account ids, and a way to replace them. */
export interface UserPicker {
  readonly values: string[];
  setValues(accountIds: string[]): void;
}

/** The rest of a filter that a favourite also keeps (Team Reports: projects, JQL Issue Filter, Extra JQL). */
export interface FilterPart {
  read(): FavouriteFilters;
  /** Puts a saved filter set back. Returns a note when something could not be restored (e.g. a project that is gone). */
  apply(filters: FavouriteFilters): string | undefined;
}

export interface FavouritesDeps {
  picker: UserPicker;
  /** Only Team Reports: favourites then hold these too, and may even be saved without users. */
  filters?: FilterPart;
  max: number;
  /** Current site (groups are stored per site), or undefined while the site list is not loaded. */
  scope: () => SiteScope | undefined;
  /** Display names of the users from /api/users, or undefined while not (or never) loaded. */
  users: () => ReadonlyMap<string, string> | undefined;
  saveBtn: HTMLButtonElement;
  listBtn: HTMLButtonElement;
  dialog: HTMLDialogElement;
  table: HTMLTableElement;
  closeBtn: HTMLButtonElement;
  notice: HTMLElement;
}

/** window.localStorage, or undefined where even touching it throws (blocked site data, some private modes). */
function browserStore(): KeyValueStore | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Moves favourites saved before multi-site support to `legacySite` (the first site). Returns a problem, if any. */
export function migrateStoredFavourites(legacySite: string): string | undefined {
  return migrateFavourites(browserStore(), legacySite);
}

/** Esc is native to <dialog>; a click on the dialog element outside its box is a click on the ::backdrop. */
export function closeOnOutsideClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}

/** Wires Save Favourite / Favourite List. Returns a function to call when the picker's selection changes. */
export function setupFavourites(d: FavouritesDeps): () => void {
  const store = browserStore();

  const notify = (message: string | undefined) => {
    d.notice.textContent = message ?? '';
    d.notice.hidden = !message;
  };

  const NO_SITE = 'The Jira site list is not loaded, so favourites are unavailable. Reload the page and try again.';

  /** Fresh read on every use, so another tab's changes are picked up. Storage problems become a notice. */
  const load = (scope: SiteScope): FavouriteGroup[] => {
    const { groups, problem } = loadFavourites(store, scope);
    if (problem) notify(problem);
    return groups;
  };

  /** Something to save: users, or (Team Reports) a project / JQL / Extra JQL. */
  const updateSave = () => {
    d.saveBtn.disabled = d.picker.values.length === 0 && !(d.filters && hasFilters(d.filters.read()));
  };

  /** "3 users, 2 projects, JQL Issue Filter" (Team Reports) or "3 user(s)" (users only). */
  const summary = (userCount: number, filters: FavouriteFilters | undefined) =>
    filters
      ? [userCount ? `${userCount} user${userCount === 1 ? '' : 's'}` : '', describeFilters(filters)].filter(Boolean).join(', ')
      : `${userCount} user(s)`;

  d.saveBtn.addEventListener('click', () => {
    const accountIds = d.picker.values;
    const filters = d.filters?.read();
    if (accountIds.length === 0 && !(filters && hasFilters(filters))) return;
    const scope = d.scope();
    if (!scope) return notify(NO_SITE);
    notify(undefined);
    const ask = filters ? `Name for this favourite (${summary(accountIds.length, filters)}):` : `Name for this group of ${accountIds.length} user(s):`;
    let input: string | null = '';
    let name: string | undefined;
    let message = ask;
    while (name === undefined) {
      input = window.prompt(message, input);
      if (input === null) return; // cancelled
      const v = validateGroupName(input);
      if ('error' in v) message = `${v.error}\n\n${ask}`;
      else name = v.name;
    }
    const groups = load(scope);
    const existing = findGroup(groups, name);
    if (existing && !window.confirm(`A group named "${existing.name}" already exists. Overwrite it?`)) return;
    const users = d.users();
    const group = makeGroup(name, accountIds, (id) => users?.get(id), new Date(), filters);
    const problem = storeFavourites(store, scope, upsertGroup(groups, group));
    notify(problem ?? (filters ? `Saved favourite "${name}" (${summary(accountIds.length, filters)}).` : `Saved favourite "${name}" (${accountIds.length} member(s)).`));
  });

  const renderTable = (scope: SiteScope) => {
    const groups = load(scope);
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>Name</th><th class="num">No of Members</th>${d.filters ? '<th>Also saved</th>' : ''}<th>Select</th><th>Delete</th></tr>`;
    const body = document.createElement('tbody');
    if (groups.length === 0) {
      const tr = body.insertRow();
      const td = tr.insertCell();
      td.colSpan = d.filters ? 5 : 4;
      td.className = 'no-data';
      td.textContent = 'No saved groups';
    }
    for (const g of groups) {
      const tr = body.insertRow();
      const name = tr.insertCell();
      name.className = 'summary';
      name.textContent = g.name;
      name.title = `${g.names.join(', ')}\nSaved ${new Date(g.savedAt).toLocaleString()}`;
      const count = tr.insertCell();
      count.className = 'num';
      count.textContent = String(g.accountIds.length);
      if (d.filters) {
        // What else the favourite sets besides its users; "—" for one saved without filters (users only).
        const extra = tr.insertCell();
        extra.textContent = describeFilters(g.filters) || '—';
        extra.title = filtersTooltip(g.filters);
      }
      tr.insertCell().append(actionButton('Select', `Select group ${g.name}`, () => select(g)));
      tr.insertCell().append(actionButton('Delete', `Delete group ${g.name}`, () => remove(scope, g)));
    }
    d.table.replaceChildren(head, body);
  };

  const select = (g: FavouriteGroup) => {
    const users = d.users();
    d.dialog.close();
    if (!users && g.accountIds.length) {
      notify('The user list is not loaded, so a favourite group cannot be selected. Reload the page and try again.');
      return;
    }
    const { accountIds, missing } = resolveGroup(g, new Set(users?.keys() ?? []), d.max);
    d.picker.setValues(accountIds);
    // A favourite saved from Team Reports also puts back its projects and JQL (one saved without them leaves those alone).
    const restored = g.filters && d.filters ? d.filters.apply(g.filters) : undefined;
    notify([missingNotice(missing), restored].filter(Boolean).join(' · ') || undefined);
  };

  const remove = (scope: SiteScope, g: FavouriteGroup) => {
    if (!window.confirm(`Delete favourite group "${g.name}"?`)) return;
    notify(undefined);
    const problem = storeFavourites(store, scope, deleteGroup(load(scope), g.name));
    if (problem) notify(problem);
    renderTable(scope);
  };

  d.listBtn.addEventListener('click', () => {
    const scope = d.scope();
    if (!scope) return notify(NO_SITE);
    notify(undefined);
    renderTable(scope);
    d.dialog.showModal();
  });
  d.closeBtn.addEventListener('click', () => d.dialog.close());
  closeOnOutsideClick(d.dialog);

  updateSave();
  return updateSave;
}

function actionButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'secondary';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
