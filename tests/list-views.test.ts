import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../web/favourites-logic.js';
import {
  deleteView,
  findView,
  loadSiteViews,
  normalizeState,
  parseViews,
  renameView,
  setDefaultView,
  stateKey,
  storeSiteViews,
  upsertView,
  viewNameProblem,
  VIEWS_KEY,
  type ListViewState,
  type SiteViews,
} from '../web/list/views-logic.js';

const state = (over: Partial<ListViewState> = {}): ListViewState => ({
  projects: ['FFN'],
  users: ['u1'],
  jql: '',
  hideDone: false,
  hierarchy: true,
  columns: ['status', 'timespent'],
  basic: { status: ['Done'] },
  filterFields: [],
  ...over,
});

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('list views', () => {
  it('stateKey ignores order of projects/users/filter values and empty filters, but not column order', () => {
    expect(stateKey(state({ projects: ['B', 'A'] }))).toBe(stateKey(state({ projects: ['A', 'B'] })));
    expect(stateKey(state({ basic: { status: ['Done'], labels: [] } }))).toBe(stateKey(state()));
    expect(stateKey(state({ jql: '  x ' }))).toBe(stateKey(state({ jql: 'x' })));
    expect(stateKey(state({ columns: ['timespent', 'status'] }))).not.toBe(stateKey(state()));
    expect(stateKey(state({ groupField: 'labels' }))).not.toBe(stateKey(state()));
  });

  it('save as, overwrite (any case), rename, delete and default keep one sorted list', () => {
    let s: SiteViews = { views: [] };
    s = upsertView(s, 'Zeta', state());
    s = upsertView(s, 'alpha', state({ hideDone: true }));
    expect(s.views.map((v) => v.name)).toEqual(['alpha', 'Zeta']);
    s = upsertView(s, 'ALPHA', state({ hideDone: false }));
    expect(s.views).toHaveLength(2);
    expect(findView(s, 'Alpha')?.state.hideDone).toBe(false);
    expect(findView(s, 'Alpha')?.name).toBe('alpha');

    s = setDefaultView(s, 'Zeta');
    expect(s.defaultName).toBe('Zeta');
    s = renameView(s, 'Zeta', 'Beta');
    expect(s.defaultName).toBe('Beta');
    expect(s.views.map((v) => v.name)).toEqual(['alpha', 'Beta']);
    s = setDefaultView(s, undefined);
    expect(s.defaultName).toBeUndefined();
    s = setDefaultView(s, 'alpha');
    s = deleteView(s, 'alpha');
    expect(s.defaultName).toBeUndefined();
    expect(s.views.map((v) => v.name)).toEqual(['Beta']);
  });

  it('name rules: required, 50 characters, rename may not take another name, save as may overwrite', () => {
    const s = upsertView(upsertView({ views: [] }, 'One', state()), 'Two', state());
    expect(viewNameProblem(s, '  ')).toMatchObject({ error: expect.stringMatching(/View name is required/) });
    expect(viewNameProblem(s, 'x'.repeat(51))).toMatchObject({ error: expect.stringMatching(/at most 50/) });
    expect(viewNameProblem(s, 'one')).toEqual({ name: 'one' }); // Save as: the caller asks before overwriting
    expect(viewNameProblem(s, 'two', 'One')).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect(viewNameProblem(s, 'ONE', 'One')).toEqual({ name: 'ONE' }); // only the case changes
  });

  it('stores per site and reads it back; other sites are untouched', () => {
    const store = memory();
    expect(storeSiteViews(store, 'one', setDefaultView(upsertView({ views: [] }, 'A', state()), 'A'))).toBeUndefined();
    expect(storeSiteViews(store, 'two', upsertView({ views: [] }, 'B', state()))).toBeUndefined();
    const one = loadSiteViews(store, 'one').value;
    expect(one.defaultName).toBe('A');
    expect(one.views[0]!.state).toEqual(normalizeState(state()));
    expect(loadSiteViews(store, 'two').value.views.map((v) => v.name)).toEqual(['B']);
    expect(loadSiteViews(store, 'three').value.views).toEqual([]);
    expect(storeSiteViews(store, 'one', { views: [] })).toBeUndefined();
    expect(loadSiteViews(store, 'one').value.views).toEqual([]);
    expect(loadSiteViews(store, 'two').value.views).toHaveLength(1);
  });

  it('unusable storage and damaged data give nothing plus a message, never a throw', () => {
    expect(loadSiteViews(undefined, 'one').problem).toMatch(/unavailable/);
    expect(storeSiteViews(undefined, 'one', { views: [] })).toMatch(/unavailable/);
    expect(parseViews('{nope').problem).toMatch(/unreadable/);
    expect(parseViews(JSON.stringify({ version: 9, sites: {} })).problem).toMatch(/unknown format/);
    const good = { name: 'Good', savedAt: 'x', state: state() };
    const raw = JSON.stringify({
      version: 1,
      sites: {
        one: { views: [good, { name: 'Bad', savedAt: 'x', state: { projects: 'FFN' } }, { name: '', savedAt: 'x', state: state() }], defaultName: 'Missing' },
        __proto__: { views: [good] },
      },
    });
    const { sites, problem } = parseViews(raw);
    expect(sites.one!.views.map((v) => v.name)).toEqual(['Good']);
    expect(sites.one!.defaultName).toBeUndefined();
    expect(problem).toMatch(/2 damaged/);
    const throwing: KeyValueStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadSiteViews(throwing, 'one').problem).toMatch(/could not be read/);
    expect(storeSiteViews(throwing, 'one', upsertView({ views: [] }, 'A', state()))).toMatch(/could not be written/);
    expect(VIEWS_KEY).toBe('worklog-report:list-views');
  });
});
