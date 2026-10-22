import { describe, expect, it } from 'vitest';
import {
  cleanFilters,
  deleteGroup,
  describeFilters,
  FAVOURITES_KEY,
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
  type FavouriteGroup,
  type KeyValueStore,
} from '../web/favourites-logic.js';
import { chooseSite, LAST_SITE_KEY, loadLastSite, saveLastSite } from '../web/sites-logic.js';

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const names: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Carol' };
const group = (name: string, ids: string[]): FavouriteGroup => makeGroup(name, ids, (id) => names[id], new Date('2026-10-06T10:00:00Z'));
/** "one" is the first configured site, where pre-multi-site (v1) favourites belong. */
const ONE = { site: 'one', legacySite: 'one' };
const TWO = { site: 'two', legacySite: 'one' };
const stored = (store: MemoryStore) => JSON.parse(store.data.get(FAVOURITES_KEY)!) as unknown;

describe('validateGroupName', () => {
  it('trims, requires a name, and caps it at 50 characters', () => {
    expect(validateGroupName('  Backend  ')).toEqual({ name: 'Backend' });
    expect(validateGroupName('   ')).toEqual({ error: 'Group name is required.' });
    expect(validateGroupName('x'.repeat(50))).toEqual({ name: 'x'.repeat(50) });
    expect(validateGroupName(` ${'x'.repeat(51)} `)).toHaveProperty('error');
  });
});

describe('save', () => {
  it('stores { version: 2, sites: { <site>: groups } } with a names snapshot and savedAt, under one key', () => {
    const store = new MemoryStore();
    expect(storeFavourites(store, ONE, upsertGroup([], group('Team', ['a', 'b'])))).toBeUndefined();
    expect([...store.data.keys()]).toEqual([FAVOURITES_KEY]);
    expect(stored(store)).toEqual({
      version: 2,
      sites: { one: [{ name: 'Team', accountIds: ['a', 'b'], names: ['Alice', 'Bob'], savedAt: '2026-10-06T10:00:00.000Z' }] },
    });
    expect(loadFavourites(store, ONE)).toEqual({ groups: [group('Team', ['a', 'b'])] });
  });

  it('falls back to the accountId when a display name is unknown', () => {
    expect(group('X', ['zz']).names).toEqual(['zz']);
  });

  it('keeps groups sorted by name, case-insensitively', () => {
    let groups: FavouriteGroup[] = [];
    for (const n of ['beta', 'Alpha', 'gamma', 'Delta']) groups = upsertGroup(groups, group(n, ['a']));
    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'beta', 'Delta', 'gamma']);
  });
});

describe('overwrite', () => {
  it('finds an existing name case-insensitively and replaces that group', () => {
    const groups = upsertGroup([group('Team', ['a'])], group('Other', ['c']));
    expect(findGroup(groups, '  TEAM ')?.name).toBe('Team');
    expect(findGroup(groups, 'nope')).toBeUndefined();

    const updated = upsertGroup(groups, group('team', ['a', 'b']));
    expect(updated).toHaveLength(2);
    expect(updated.map((g) => g.name)).toEqual(['Other', 'team']);
    expect(findGroup(updated, 'Team')?.accountIds).toEqual(['a', 'b']);
  });
});

describe('delete', () => {
  it('removes only the named group (case-insensitive)', () => {
    const groups = [group('A', ['a']), group('B', ['b'])];
    expect(deleteGroup(groups, 'a').map((g) => g.name)).toEqual(['B']);
    expect(deleteGroup(groups, 'missing')).toEqual(groups);
  });

  it('round-trips through storage', () => {
    const store = new MemoryStore();
    storeFavourites(store, ONE, [group('A', ['a']), group('B', ['b'])]);
    storeFavourites(store, ONE, deleteGroup(loadFavourites(store, ONE).groups, 'A'));
    expect(loadFavourites(store, ONE).groups.map((g) => g.name)).toEqual(['B']);
  });
});

describe('favourites are per site', () => {
  it('a group saved on one site appears only on that site', () => {
    const store = new MemoryStore();
    storeFavourites(store, ONE, [group('Team', ['a'])]);
    expect(loadFavourites(store, TWO)).toEqual({ groups: [] });

    storeFavourites(store, TWO, [group('Team', ['b', 'c']), group('Ops', ['c'])]);
    expect(loadFavourites(store, ONE).groups).toEqual([group('Team', ['a'])]);
    expect(loadFavourites(store, TWO).groups.map((g) => g.name)).toEqual(['Ops', 'Team']);
    expect(findGroup(loadFavourites(store, TWO).groups, 'team')?.accountIds).toEqual(['b', 'c']);
  });

  it('saving or deleting on one site leaves the other site untouched', () => {
    const store = new MemoryStore();
    storeFavourites(store, ONE, [group('A', ['a'])]);
    storeFavourites(store, TWO, [group('A', ['b'])]);
    storeFavourites(store, TWO, deleteGroup(loadFavourites(store, TWO).groups, 'A'));
    expect(loadFavourites(store, TWO).groups).toEqual([]);
    expect(loadFavourites(store, ONE).groups).toEqual([group('A', ['a'])]);
    // A site with no groups left is dropped from storage.
    expect(stored(store)).toEqual({ version: 2, sites: { one: [group('A', ['a'])] } });
  });
});

describe('migration from v1 (single-site) favourites', () => {
  const v1 = () => JSON.stringify({ version: 1, groups: [group('Old', ['a', 'b'])] });

  it('existing groups belong to the first site, and not to the others', () => {
    const store = new MemoryStore();
    store.setItem(FAVOURITES_KEY, v1());
    expect(loadFavourites(store, ONE).groups).toEqual([group('Old', ['a', 'b'])]);
    expect(loadFavourites(store, TWO).groups).toEqual([]);
  });

  it('migrateFavourites rewrites v1 as v2 under the first site; running it again changes nothing', () => {
    const store = new MemoryStore();
    store.setItem(FAVOURITES_KEY, v1());
    expect(migrateFavourites(store, 'one')).toBeUndefined();
    expect(stored(store)).toEqual({ version: 2, sites: { one: [group('Old', ['a', 'b'])] } });
    const migrated = store.data.get(FAVOURITES_KEY);
    migrateFavourites(store, 'two'); // already v2: the groups stay on "one"
    expect(store.data.get(FAVOURITES_KEY)).toBe(migrated);
  });

  it('saving on another site before migration keeps the v1 groups on the first site', () => {
    const store = new MemoryStore();
    store.setItem(FAVOURITES_KEY, v1());
    storeFavourites(store, TWO, [group('New', ['c'])]);
    expect(loadFavourites(store, ONE).groups).toEqual([group('Old', ['a', 'b'])]);
    expect(loadFavourites(store, TWO).groups).toEqual([group('New', ['c'])]);
  });

  it('nothing stored or unusable storage: no-op, never throws', () => {
    const empty = new MemoryStore();
    expect(migrateFavourites(empty, 'one')).toBeUndefined();
    expect(empty.data.size).toBe(0);
    expect(migrateFavourites(undefined, 'one')).toBeUndefined();
    expect(migrateFavourites(throwing, 'one')).toBeTruthy();
  });
});

describe('select with missing members', () => {
  it('keeps members still in /api/users and names the missing ones from the snapshot', () => {
    const g = group('Team', ['a', 'b', 'c']);
    const r = resolveGroup(g, new Set(['a', 'c', 'x']), 50);
    expect(r).toEqual({ accountIds: ['a', 'c'], missing: ['Bob'] });
    expect(missingNotice(r.missing)).toBe('1 member(s) not found: Bob');
  });

  it('no notice when everyone is found; all missing gives an empty selection', () => {
    expect(missingNotice(resolveGroup(group('T', ['a']), new Set(['a']), 50).missing)).toBeUndefined();
    expect(resolveGroup(group('T', ['a', 'b']), new Set(), 50)).toEqual({ accountIds: [], missing: ['Alice', 'Bob'] });
  });

  it('drops duplicate ids and caps at the selection limit', () => {
    const g: FavouriteGroup = { name: 'T', accountIds: ['a', 'a', 'b', 'c'], names: ['Alice', 'Alice', 'Bob', 'Carol'], savedAt: '' };
    expect(resolveGroup(g, new Set(['a', 'b', 'c']), 2).accountIds).toEqual(['a', 'b']);
  });
});

describe('corrupt or unavailable storage', () => {
  it('missing key is simply empty, with no notice', () => {
    expect(loadFavourites(new MemoryStore(), ONE)).toEqual({ groups: [] });
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['null', 'null'],
    ['unknown version', JSON.stringify({ version: 3, sites: {} })],
    ['v2 without sites', JSON.stringify({ version: 2, groups: [] })],
    ['v1 groups not an array', JSON.stringify({ version: 1, groups: {} })],
    ['bare array', '[]'],
  ])('%s → empty with a notice', (_, raw) => {
    const store = new MemoryStore();
    store.setItem(FAVOURITES_KEY, raw);
    const r = loadFavourites(store, ONE);
    expect(r.groups).toEqual([]);
    expect(r.problem).toBeTruthy();
  });

  it('drops damaged groups, keeps valid ones, and reports it', () => {
    const store = new MemoryStore();
    const good = group('Good', ['a']);
    store.setItem(FAVOURITES_KEY, JSON.stringify({ version: 2, sites: { one: [good, { name: 'Bad', accountIds: 'a' }, null, { ...good, name: '  ' }] } }));
    const r = loadFavourites(store, ONE);
    expect(r.groups).toEqual([good]);
    expect(r.problem).toBe('3 damaged favourite group(s) were ignored.');
  });

  it('ignores entries that are not site keys or not lists', () => {
    const store = new MemoryStore();
    const good = group('Good', ['a']);
    store.setItem(FAVOURITES_KEY, `{"version":2,"sites":{"__proto__":[],"Bad Key":[],"two":{},"one":[${JSON.stringify(good)}]}}`);
    const r = loadFavourites(store, ONE);
    expect(r.groups).toEqual([good]);
    expect(r.problem).toBe('3 damaged favourite group(s) were ignored.');
  });

  it('storage that throws or is missing → empty + notice on read, message (not an exception) on write', () => {
    expect(loadFavourites(throwing, ONE).groups).toEqual([]);
    expect(loadFavourites(throwing, ONE).problem).toBeTruthy();
    expect(loadFavourites(undefined, ONE).problem).toBeTruthy();
    expect(storeFavourites(throwing, ONE, [group('A', ['a'])])).toBeTruthy();
    expect(storeFavourites(undefined, ONE, [])).toBeTruthy();
  });
});

describe('last selected site', () => {
  it('uses the remembered site only while it is still configured', () => {
    expect(chooseSite(['one', 'two'], 'two')).toBe('two');
    expect(chooseSite(['one', 'two'], 'gone')).toBe('one');
    expect(chooseSite(['one', 'two'], null)).toBe('one');
    expect(chooseSite([], 'two')).toBeUndefined();
  });

  it('round-trips through storage and never throws', () => {
    const store = new MemoryStore();
    saveLastSite(store, 'two');
    expect(store.data.get(LAST_SITE_KEY)).toBe('two');
    expect(loadLastSite(store)).toBe('two');
    expect(loadLastSite(throwing)).toBeNull();
    expect(() => saveLastSite(throwing, 'x')).not.toThrow();
    expect(loadLastSite(undefined)).toBeNull();
  });
});

describe('favourites that also keep projects and JQL (Team Reports)', () => {
  const when = new Date('2026-10-06T10:00:00Z');
  const withFilters = (name: string, ids: string[], projects: string[], jql: string, extraJql: string) =>
    makeGroup(name, ids, (id) => names[id], when, { projects, jql, extraJql });

  it('stores the projects, the JQL Issue Filter and the Extra JQL next to the users (trimmed, projects once)', () => {
    const g = withFilters('Squad', ['a'], ['FFN', 'PM', 'FFN'], '  status = Done  ', ' labels = x ');
    expect(g.filters).toEqual({ projects: ['FFN', 'PM'], jql: 'status = Done', extraJql: 'labels = x' });
    expect(group('Plain', ['a']).filters).toBeUndefined(); // Team Matrix favourites stay users only
    expect('filters' in group('Plain', ['a'])).toBe(false);
  });

  it('survives a save and a load; a favourite may have no users at all', () => {
    const store = new MemoryStore();
    const squad = withFilters('Squad', ['a', 'b'], ['FFN'], 'status = Done', '');
    const projectOnly = withFilters('Only FFN', [], ['FFN'], '', '');
    expect(storeFavourites(store, ONE, upsertGroup(upsertGroup([], squad), projectOnly))).toBeUndefined();
    const { groups, problem } = loadFavourites(store, ONE);
    expect(problem).toBeUndefined();
    expect(groups).toEqual([projectOnly, squad].sort((x, y) => x.name.localeCompare(y.name)));
    expect(groups.find((g) => g.name === 'Only FFN')?.accountIds).toEqual([]);
  });

  it('favourites saved before this existed (no filters) still load', () => {
    const store = new MemoryStore();
    store.setItem(FAVOURITES_KEY, JSON.stringify({ version: 2, sites: { one: [group('Old', ['a'])] } }));
    const { groups, problem } = loadFavourites(store, ONE);
    expect(problem).toBeUndefined();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.filters).toBeUndefined();
  });

  it('a damaged filters value is dropped, the group (and its users) is kept', () => {
    const store = new MemoryStore();
    const bad = [
      { ...group('A', ['a']), filters: 'nope' },
      { ...group('B', ['a']), filters: { projects: 'FFN', jql: '', extraJql: '' } },
      { ...group('C', ['a']), filters: { projects: ['FFN'], jql: 5, extraJql: '' } },
      { ...group('D', ['a']), filters: { projects: ['FFN', 7], jql: '', extraJql: '' } },
    ];
    store.setItem(FAVOURITES_KEY, JSON.stringify({ version: 2, sites: { one: bad } }));
    const { groups, problem } = loadFavourites(store, ONE);
    expect(problem).toBeUndefined();
    expect(groups.map((g) => g.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(groups.every((g) => g.filters === undefined && g.accountIds.length === 1)).toBe(true);
  });

  it('hasFilters / describeFilters / filtersTooltip', () => {
    const none = { projects: [], jql: '  ', extraJql: '' };
    expect(hasFilters(none)).toBe(false);
    expect(hasFilters({ ...none, projects: ['FFN'] })).toBe(true);
    expect(hasFilters({ ...none, extraJql: 'labels = x' })).toBe(true);
    const all = { projects: ['FFN', 'PM'], jql: 'status = Done', extraJql: 'labels = x' };
    expect(describeFilters(all)).toBe('2 projects, JQL Issue Filter, Extra JQL');
    expect(describeFilters({ ...none, projects: ['FFN'] })).toBe('1 project');
    expect(describeFilters(none)).toBe('');
    expect(describeFilters(undefined)).toBe('');
    expect(filtersTooltip(all)).toBe('Projects: FFN, PM\nJQL Issue Filter: status = Done\nExtra JQL: labels = x');
    expect(filtersTooltip(undefined)).toBe('');
  });

  it('cleanFilters keeps a good value and rejects the rest', () => {
    expect(cleanFilters({ projects: ['A', 'A'], jql: 'x', extraJql: '' })).toEqual({ projects: ['A'], jql: 'x', extraJql: '' });
    expect(cleanFilters(null)).toBeUndefined();
    expect(cleanFilters([])).toBeUndefined();
    expect(cleanFilters({ projects: [] })).toBeUndefined();
  });

  it('keeps Group By, Period, Time Format and Time Zone, and drops a damaged view only', () => {
    const view = { groupBy: ['worklog.author', 'issue.key'], period: 'week', format: 'hhmm', zone: 'server' };
    const g = makeGroup('V', ['a'], (id) => names[id], when, { projects: [], jql: '', extraJql: '', view });
    expect(g.filters?.view).toEqual(view);
    expect(describeFilters(g.filters)).toBe('Group By, Period, Time Format, Time Zone');
    expect(filtersTooltip(g.filters)).toContain('Group By: worklog.author, issue.key');
    expect(cleanFilters({ projects: ['A'], jql: '', extraJql: '', view: { groupBy: 'x' } })).toEqual({ projects: ['A'], jql: '', extraJql: '' });
  });
});
