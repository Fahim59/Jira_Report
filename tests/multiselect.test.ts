import { describe, expect, it } from 'vitest';
import { filterOptions, selectAllFiltered, toggleValue } from '../web/multiselect-logic.js';

describe('toggleValue (click / Enter / Space)', () => {
  it('adding a user clears the search', () => {
    expect(toggleValue(['a'], 'b', 50)).toEqual({ selected: ['a', 'b'], clearQuery: true });
  });

  it('removing a user keeps the search', () => {
    expect(toggleValue(['a', 'b'], 'a', 50)).toEqual({ selected: ['b'], clearQuery: false });
  });

  it('at the limit nothing is added and the search is kept', () => {
    const selected = ['a', 'b'];
    const r = toggleValue(selected, 'c', 2);
    expect(r.selected).toBe(selected);
    expect(r.clearQuery).toBe(false);
    expect(r.note).toBe('Limit is 2 users.');
  });
});

describe('selectAllFiltered', () => {
  it('adds the filtered users not yet selected, then clears the search', () => {
    expect(selectAllFiltered(['a'], ['a', 'b', 'c'], 50)).toEqual({ selected: ['a', 'b', 'c'], clearQuery: true, note: undefined });
  });

  it('respects the limit, says how many were left out, and still clears the search', () => {
    expect(selectAllFiltered(['a'], ['b', 'c', 'd'], 2)).toEqual({ selected: ['a', 'b'], clearQuery: true, note: 'Limit is 2 users; 2 not added.' });
  });
});

describe('filterOptions', () => {
  const opts = [
    { value: '1', name: 'Jane Doe', label: 'Jane Doe' },
    { value: '2', name: 'John Smith', label: 'John Smith (inactive)' },
  ];

  it('matches a case-insensitive substring of the name', () => {
    expect(filterOptions(opts, 'SMI').map((o) => o.value)).toEqual(['2']);
  });

  it('an empty search (after a selection clears it) shows everyone', () => {
    expect(filterOptions(opts, '')).toBe(opts);
  });
});
