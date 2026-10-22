import { describe, expect, it } from 'vitest';
import { filterOptions, moveActive } from '../web/multiselect-logic.js';
import { ALL_PROJECTS_LABEL, initialActive, projectOptions } from '../web/singleselect-logic.js';

const options = projectOptions([
  { key: 'TPX', name: 'Tapix Platform' },
  { key: 'OPS', name: 'Field Officer App' },
  { key: 'HR', name: 'People Ops' },
]);
const labels = (query: string) => filterOptions(options, query).map((o) => o.label);

describe('projectOptions', () => {
  it('puts "All projects" (value "") first and shows projects as "KEY — Name"', () => {
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ['', ALL_PROJECTS_LABEL],
      ['TPX', 'TPX — Tapix Platform'],
      ['OPS', 'OPS — Field Officer App'],
      ['HR', 'HR — People Ops'],
    ]);
    expect(projectOptions([])).toEqual([{ value: '', name: ALL_PROJECTS_LABEL, label: ALL_PROJECTS_LABEL }]);
  });
});

describe('project filter', () => {
  it('empty or blank search shows everything, "All projects" first', () => {
    expect(labels('')).toEqual(options.map((o) => o.label));
    expect(labels('   ')[0]).toBe(ALL_PROJECTS_LABEL);
  });

  it('matches the key, case-insensitively', () => {
    expect(labels('tpx')).toEqual(['TPX — Tapix Platform']);
    expect(labels('Tp')).toEqual(['TPX — Tapix Platform']);
  });

  it('matches anywhere in the name, case-insensitively', () => {
    expect(labels('officer')).toEqual(['OPS — Field Officer App']);
    expect(labels('PLATF')).toEqual(['TPX — Tapix Platform']);
  });

  it('matches key or name, keeping list order', () => {
    expect(labels('ops')).toEqual(['OPS — Field Officer App', 'HR — People Ops']);
  });

  it('"All projects" stays first when it matches too', () => {
    expect(labels('p')[0]).toBe(ALL_PROJECTS_LABEL);
    expect(labels('all')).toEqual([ALL_PROJECTS_LABEL]);
  });

  it('does not match across the key/name boundary or the " — " separator', () => {
    expect(labels('x t')).toEqual([]); // "TPX" + "Tapix"
    expect(labels('—')).toEqual([]);
  });

  it('nothing matching gives an empty list (shown as "No matching projects")', () => {
    expect(labels('zzz')).toEqual([]);
  });
});

describe('highlight rules', () => {
  it('without a search, highlights the current selection (first option if not found)', () => {
    expect(initialActive(options, 'OPS', '')).toBe(2);
    expect(initialActive(options, '', '')).toBe(0);
    expect(initialActive(options, 'GONE', '')).toBe(0);
  });

  it('while searching, highlights the first match; none when nothing matches', () => {
    expect(initialActive(filterOptions(options, 'ops'), 'TPX', 'ops')).toBe(0);
    expect(initialActive([], '', 'zzz')).toBe(-1);
  });

  it('while searching, an exact (case-insensitive) label match wins over earlier partial matches', () => {
    const fields = ['[CHART] Time in Status', 'Epic Status', 'Status', 'Status category'].map((l) => ({ value: l, name: l, label: l }));
    expect(initialActive(fields, '', ' status ')).toBe(2);
    expect(initialActive(fields, '', 'stat')).toBe(0);
  });

  it('arrow keys move and wrap around', () => {
    expect(moveActive(-1, 4, 1)).toBe(0);
    expect(moveActive(-1, 4, -1)).toBe(3);
    expect(moveActive(3, 4, 1)).toBe(0);
    expect(moveActive(0, 4, -1)).toBe(3);
    expect(moveActive(1, 4, 1)).toBe(2);
    expect(moveActive(0, 0, 1)).toBe(-1);
  });
});
