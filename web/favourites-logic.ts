// Favourite user groups, stored only in the browser. Pure rules + storage I/O behind a minimal
// Storage-like interface (no DOM, so they can be unit-tested in node).

export const FAVOURITES_KEY = 'worklog-report:favourites';
/** v1 = { version: 1, groups } (single site, before multi-site support); v2 = groups per site key. */
export const FAVOURITES_VERSION = 2;
export const MAX_GROUP_NAME = 50;

/** The rest of a Team Reports filter that a favourite can hold next to its users (Team Matrix favourites have none). */
export interface FavouriteFilters {
  /** Project keys (may be empty = all projects). */
  projects: string[];
  /** JQL Issue Filter ("" = none). */
  jql: string;
  /** Extra JQL ("" = none). */
  extraJql: string;
  /** The top bar of the report; absent on favourites saved before it was kept. */
  view?: FavouriteView;
}

/** Group By (field ids, in level order), Period Grouping, Time Format and Time Zone as the select values. */
export interface FavouriteView {
  groupBy: string[];
  period: string;
  format: string;
  zone: string;
}

export interface FavouriteGroup {
  name: string;
  accountIds: string[];
  /** Display names when saved, same order as accountIds; used to name members that have since disappeared. */
  names: string[];
  /** ISO timestamp. */
  savedAt: string;
  /** Present when saved from Team Reports: selecting the favourite also sets these. Absent = users only. */
  filters?: FavouriteFilters;
}

interface StoredFavourites {
  version: typeof FAVOURITES_VERSION;
  /** Site key -> groups saved on that site. */
  sites: Record<string, FavouriteGroup[]>;
}

/** The subset of window.localStorage used here; undefined when storage is unavailable. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Which site's groups to use. v1 data (saved before sites existed) belongs to `legacySite`, the first configured site. */
export interface SiteScope {
  site: string;
  legacySite: string;
}

export interface LoadResult {
  groups: FavouriteGroup[];
  /** Set when storage could not be read or held unusable data; groups is then [] (or the valid part). */
  problem?: string;
}

export interface ParsedFavourites {
  sites: Record<string, FavouriteGroup[]>;
  problem?: string;
  /** True when the stored data was v1 and has been mapped to the legacy site (not yet written back). */
  migrated?: boolean;
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function isGroup(g: unknown): g is FavouriteGroup {
  if (!g || typeof g !== 'object') return false;
  const o = g as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.trim() !== '' &&
    Array.isArray(o.accountIds) &&
    o.accountIds.every((v) => typeof v === 'string') &&
    Array.isArray(o.names) &&
    o.names.every((v) => typeof v === 'string') &&
    typeof o.savedAt === 'string'
  );
}

/** A stored `filters` value that is well-formed, else undefined (a damaged one is dropped, the group is kept). */
export function cleanFilters(raw: unknown): FavouriteFilters | undefined {
  if (!isRecord(raw)) return undefined;
  const { projects, jql, extraJql } = raw;
  if (!Array.isArray(projects) || !projects.every((p) => typeof p === 'string') || typeof jql !== 'string' || typeof extraJql !== 'string') return undefined;
  const view = cleanView(raw.view);
  return { projects: [...new Set(projects as string[])], jql, extraJql, ...(view ? { view } : {}) };
}

function cleanView(raw: unknown): FavouriteView | undefined {
  if (!isRecord(raw)) return undefined;
  const { groupBy, period, format, zone } = raw;
  if (!Array.isArray(groupBy) || !groupBy.every((g) => typeof g === 'string')) return undefined;
  if (typeof period !== 'string' || typeof format !== 'string' || typeof zone !== 'string') return undefined;
  return { groupBy: [...new Set(groupBy as string[])], period, format, zone };
}

function withCleanFilters(g: FavouriteGroup): FavouriteGroup {
  const { filters: raw, ...rest } = g;
  const filters = cleanFilters(raw);
  return filters ? { ...rest, filters } : rest;
}

/** Whether a filter set holds anything (a favourite may be saved for its projects / JQL alone). */
export const hasFilters = (f: FavouriteFilters): boolean => f.projects.length > 0 || f.jql.trim() !== '' || f.extraJql.trim() !== '';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 projects, JQL Issue Filter, Extra JQL" (what a favourite includes besides users); "" when nothing. */
export function describeFilters(f: FavouriteFilters | undefined): string {
  if (!f) return '';
  return [f.projects.length ? plural(f.projects.length, 'project') : '', f.jql.trim() ? 'JQL Issue Filter' : '', f.extraJql.trim() ? 'Extra JQL' : '', f.view ? 'Group By, Period, Time Format, Time Zone' : '']
    .filter(Boolean)
    .join(', ');
}

/** Longer text for a tooltip: the project keys and the JQL itself. */
export function filtersTooltip(f: FavouriteFilters | undefined): string {
  if (!f) return '';
  return [
    f.projects.length ? `Projects: ${f.projects.join(', ')}` : '',
    f.jql.trim() ? `JQL Issue Filter: ${f.jql.trim()}` : '',
    f.extraJql.trim() ? `Extra JQL: ${f.extraJql.trim()}` : '',
    f.view ? `Group By: ${f.view.groupBy.join(', ') || '—'}\nPeriod: ${f.view.period} · Time Format: ${f.view.format} · Time Zone: ${f.view.zone}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Groups sorted by name (case-insensitive). */
export function sortGroups(groups: FavouriteGroup[]): FavouriteGroup[] {
  return [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

const SITE_KEY = /^[a-z0-9][a-z0-9-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Parses the stored JSON into groups per site. Missing key = nothing saved. v1 data is assigned to
 * `legacySite`. Anything unusable = nothing, plus a problem; damaged groups are dropped and counted.
 */
export function parseFavourites(raw: string | null, legacySite: string): ParsedFavourites {
  if (raw === null) return { sites: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { sites: {}, problem: 'Saved favourites were unreadable and have been ignored.' };
  }
  let bySite: Record<string, unknown>;
  let migrated = false;
  if (isRecord(data) && data.version === 1 && Array.isArray(data.groups)) {
    bySite = { [legacySite]: data.groups };
    migrated = true;
  } else if (isRecord(data) && data.version === FAVOURITES_VERSION && isRecord(data.sites)) {
    bySite = data.sites;
  } else {
    return { sites: {}, problem: 'Saved favourites were in an unknown format and have been ignored.' };
  }

  const sites: Record<string, FavouriteGroup[]> = {};
  let damaged = 0;
  for (const [site, groups] of Object.entries(bySite)) {
    // Site keys are Jira subdomains; anything else (e.g. "__proto__") is not ours.
    if (!SITE_KEY.test(site) || !Array.isArray(groups)) {
      damaged++;
      continue;
    }
    const valid = groups.filter(isGroup).map(withCleanFilters);
    damaged += groups.length - valid.length;
    if (valid.length) sites[site] = sortGroups(valid);
  }
  return {
    sites,
    ...(damaged ? { problem: `${damaged} damaged favourite group(s) were ignored.` } : {}),
    ...(migrated ? { migrated } : {}),
  };
}

function readAll(store: KeyValueStore, legacySite: string): ParsedFavourites {
  return parseFavourites(store.getItem(FAVOURITES_KEY), legacySite);
}

/** Groups saved on `scope.site` only. */
export function loadFavourites(store: KeyValueStore | undefined, scope: SiteScope): LoadResult {
  if (!store) return { groups: [], problem: 'Browser storage is unavailable, so favourites cannot be loaded or saved.' };
  try {
    const { sites, problem } = readAll(store, scope.legacySite);
    return { groups: sites[scope.site] ?? [], ...(problem ? { problem } : {}) };
  } catch {
    return { groups: [], problem: 'Browser storage could not be read, so favourites are unavailable.' };
  }
}

function writeAll(store: KeyValueStore, sites: Record<string, FavouriteGroup[]>): void {
  const data: StoredFavourites = { version: FAVOURITES_VERSION, sites };
  store.setItem(FAVOURITES_KEY, JSON.stringify(data));
}

/**
 * Replaces the groups of `scope.site`, leaving other sites untouched. Returns a problem message on
 * failure (unavailable storage, quota, private mode).
 */
export function storeFavourites(store: KeyValueStore | undefined, scope: SiteScope, groups: FavouriteGroup[]): string | undefined {
  if (!store) return 'Browser storage is unavailable, so favourites cannot be saved.';
  try {
    const { sites } = readAll(store, scope.legacySite);
    if (groups.length) sites[scope.site] = sortGroups(groups);
    else delete sites[scope.site];
    writeAll(store, sites);
    return undefined;
  } catch {
    return 'Browser storage could not be written, so the change was not saved.';
  }
}

/** Rewrites v1 favourites as v2 under `legacySite` (the first site). No-op otherwise. Returns a problem message on failure. */
export function migrateFavourites(store: KeyValueStore | undefined, legacySite: string): string | undefined {
  if (!store) return undefined;
  try {
    const { sites, migrated } = readAll(store, legacySite);
    if (migrated) writeAll(store, sites);
    return undefined;
  } catch {
    return 'Saved favourites could not be upgraded to per-site storage.';
  }
}

/** Trimmed name, or an error message: required, at most MAX_GROUP_NAME characters. */
export function validateGroupName(input: string): { name: string } | { error: string } {
  const name = input.trim();
  if (!name) return { error: 'Group name is required.' };
  if (name.length > MAX_GROUP_NAME) return { error: `Group name must be at most ${MAX_GROUP_NAME} characters (it has ${name.length}).` };
  return { name };
}

/** The existing group with this name (case-insensitive), if any. */
export function findGroup(groups: FavouriteGroup[], name: string): FavouriteGroup | undefined {
  return groups.find((g) => sameName(g.name, name.trim()));
}

/** Adds the group, replacing any group with the same name (case-insensitive). Result is sorted. */
export function upsertGroup(groups: FavouriteGroup[], group: FavouriteGroup): FavouriteGroup[] {
  return sortGroups([...groups.filter((g) => !sameName(g.name, group.name)), group]);
}

export function deleteGroup(groups: FavouriteGroup[], name: string): FavouriteGroup[] {
  return groups.filter((g) => !sameName(g.name, name));
}

/** Builds a group from the current selection; names come from `nameOf` (snapshot), falling back to the id. */
export function makeGroup(
  name: string,
  accountIds: string[],
  nameOf: (id: string) => string | undefined,
  now = new Date(),
  filters?: FavouriteFilters,
): FavouriteGroup {
  const group: FavouriteGroup = { name, accountIds: [...accountIds], names: accountIds.map((id) => nameOf(id) ?? id), savedAt: now.toISOString() };
  if (!filters) return group;
  const view = cleanView(filters.view);
  return { ...group, filters: { projects: [...new Set(filters.projects)], jql: filters.jql.trim(), extraJql: filters.extraJql.trim(), ...(view ? { view } : {}) } };
}

/**
 * Members to select: those still in the user list. Missing ones are reported by their saved name.
 * Duplicate ids are dropped and the result is capped at `max` (the multi-select limit).
 */
export function resolveGroup(group: FavouriteGroup, known: ReadonlySet<string>, max: number): { accountIds: string[]; missing: string[] } {
  const accountIds: string[] = [];
  const missing: string[] = [];
  group.accountIds.forEach((id, i) => {
    if (!known.has(id)) missing.push(group.names[i] ?? id);
    else if (!accountIds.includes(id)) accountIds.push(id);
  });
  return { accountIds: accountIds.slice(0, max), missing };
}

/** "N member(s) not found: a, b", or undefined when nothing is missing. */
export function missingNotice(missing: string[]): string | undefined {
  return missing.length ? `${missing.length} member(s) not found: ${missing.join(', ')}` : undefined;
}
