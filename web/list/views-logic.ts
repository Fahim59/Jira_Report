// Saved views of the List tab (browser only, per site): projects, users, filters, group, columns and the menu switches.
// Pure rules + storage I/O behind a minimal Storage-like interface, so they can be unit-tested in node.
import { validateGroupName, type KeyValueStore } from '../favourites-logic.js';

export const VIEWS_KEY = 'worklog-report:list-views';
export const MAX_VIEWS = 50;

/** Everything a saved view puts back. */
export interface ListViewState {
  projects: string[];
  users: string[];
  /** JQL Issue Filter ("" = none). */
  jql: string;
  hideDone: boolean;
  hierarchy: boolean;
  /** Field id of the group, if any. */
  groupField?: string;
  columns: string[];
  /** Basic filter: field id → ticked values. */
  basic: Record<string, string[]>;
  /** Fields added to the Basic filter with "+ Add field". */
  filterFields: string[];
}

export interface ListView {
  name: string;
  state: ListViewState;
  savedAt: string;
}

export interface SiteViews {
  views: ListView[];
  /** Name of the view that opens first. */
  defaultName?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** A comparable form of a state: empty filters dropped, lists in a fixed order where order carries no meaning. */
export function normalizeState(s: ListViewState): ListViewState {
  const basic: Record<string, string[]> = {};
  for (const id of Object.keys(s.basic).sort()) {
    const values = [...new Set(s.basic[id])].sort();
    if (values.length) basic[id] = values;
  }
  return {
    projects: [...new Set(s.projects)].sort(),
    users: [...new Set(s.users)].sort(),
    jql: s.jql.trim(),
    hideDone: s.hideDone,
    hierarchy: s.hierarchy,
    ...(s.groupField ? { groupField: s.groupField } : {}),
    columns: [...s.columns], // the order of the columns is part of the view
    basic,
    filterFields: [...new Set(s.filterFields)],
  };
}

export const stateKey = (s: ListViewState): string => JSON.stringify(normalizeState(s));

function cleanState(raw: unknown): ListViewState | undefined {
  if (!isRecord(raw)) return undefined;
  const { projects, users, jql, hideDone, hierarchy, groupField, columns, basic, filterFields } = raw;
  if (!strings(projects) || !strings(users) || typeof jql !== 'string' || typeof hideDone !== 'boolean' || typeof hierarchy !== 'boolean') return undefined;
  if (!strings(columns) || !strings(filterFields) || !isRecord(basic)) return undefined;
  if (groupField !== undefined && typeof groupField !== 'string') return undefined;
  const cleanBasic: Record<string, string[]> = {};
  for (const [id, values] of Object.entries(basic)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || !strings(values)) return undefined;
    cleanBasic[id] = values;
  }
  return normalizeState({ projects, users, jql, hideDone, hierarchy, ...(groupField ? { groupField } : {}), columns, basic: cleanBasic, filterFields });
}

const SITE_KEY = /^[a-z0-9][a-z0-9-]*$/;

export interface LoadedViews {
  /** Views per site key. */
  sites: Record<string, SiteViews>;
  problem?: string;
}

/** Parses the stored JSON. Anything unusable = nothing, plus a problem; damaged views are dropped. */
export function parseViews(raw: string | null): LoadedViews {
  if (raw === null) return { sites: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { sites: {}, problem: 'Saved views were unreadable and have been ignored.' };
  }
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.sites)) return { sites: {}, problem: 'Saved views were in an unknown format and have been ignored.' };
  const sites: Record<string, SiteViews> = {};
  let damaged = 0;
  for (const [site, entry] of Object.entries(data.sites)) {
    if (!SITE_KEY.test(site) || !isRecord(entry) || !Array.isArray(entry.views)) {
      damaged++;
      continue;
    }
    const views: ListView[] = [];
    for (const v of entry.views) {
      const state = isRecord(v) ? cleanState(v.state) : undefined;
      if (!isRecord(v) || typeof v.name !== 'string' || !v.name.trim() || typeof v.savedAt !== 'string' || !state) {
        damaged++;
        continue;
      }
      views.push({ name: v.name, state, savedAt: v.savedAt });
    }
    const defaultName = typeof entry.defaultName === 'string' && views.some((x) => x.name === entry.defaultName) ? entry.defaultName : undefined;
    if (views.length) sites[site] = { views: sortViews(views), ...(defaultName ? { defaultName } : {}) };
  }
  return { sites, ...(damaged ? { problem: `${damaged} damaged saved view(s) were ignored.` } : {}) };
}

export const sortViews = (views: ListView[]): ListView[] => [...views].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

export function loadSiteViews(store: KeyValueStore | undefined, site: string): { value: SiteViews; problem?: string } {
  if (!store) return { value: { views: [] }, problem: 'Browser storage is unavailable, so views cannot be loaded or saved.' };
  try {
    const { sites, problem } = parseViews(store.getItem(VIEWS_KEY));
    return { value: sites[site] ?? { views: [] }, ...(problem ? { problem } : {}) };
  } catch {
    return { value: { views: [] }, problem: 'Browser storage could not be read, so saved views are unavailable.' };
  }
}

/** Replaces one site's views, leaving the other sites alone. Returns a problem message on failure. */
export function storeSiteViews(store: KeyValueStore | undefined, site: string, value: SiteViews): string | undefined {
  if (!store) return 'Browser storage is unavailable, so the view could not be saved.';
  try {
    const { sites } = parseViews(store.getItem(VIEWS_KEY));
    if (value.views.length) sites[site] = value;
    else delete sites[site];
    store.setItem(VIEWS_KEY, JSON.stringify({ version: 1, sites }));
    return undefined;
  } catch {
    return 'Browser storage could not be written, so the change was not saved.';
  }
}

export const findView = (s: SiteViews, name: string): ListView | undefined => s.views.find((v) => sameName(v.name, name.trim()));

/** Adds or replaces (same name, any case) a view. The default follows a renamed-by-case view; the list stays sorted. */
export function upsertView(s: SiteViews, name: string, state: ListViewState, now = new Date()): SiteViews {
  const existing = findView(s, name);
  const view: ListView = { name: existing?.name ?? name, state: normalizeState(state), savedAt: now.toISOString() };
  return { ...s, views: sortViews([...s.views.filter((v) => v !== existing), view]) };
}

export function renameView(s: SiteViews, from: string, to: string): SiteViews {
  const views = s.views.map((v) => (v.name === from ? { ...v, name: to } : v));
  return { views: sortViews(views), ...(s.defaultName ? { defaultName: s.defaultName === from ? to : s.defaultName } : {}) };
}

export function deleteView(s: SiteViews, name: string): SiteViews {
  const views = s.views.filter((v) => v.name !== name);
  return { views, ...(s.defaultName && s.defaultName !== name ? { defaultName: s.defaultName } : {}) };
}

export function setDefaultView(s: SiteViews, name: string | undefined): SiteViews {
  return { views: s.views, ...(name ? { defaultName: name } : {}) };
}

/** Name checks for Save as / Rename: the Favourites rules (required, ≤ 50), plus the list limit and, when renaming, clashes. */
export function viewNameProblem(s: SiteViews, input: string, renaming?: string): { name: string } | { error: string } {
  const v = validateGroupName(input);
  if ('error' in v) return { error: v.error.replace('Group name', 'View name') };
  const clash = findView(s, v.name);
  // Save as may overwrite (the caller asks first); a rename may not take another view's name.
  if (clash && renaming !== undefined && clash.name !== renaming) return { error: `A view named "${clash.name}" already exists.` };
  if (!clash && !renaming && s.views.length >= MAX_VIEWS) return { error: `At most ${MAX_VIEWS} views can be saved.` };
  return { name: v.name };
}
