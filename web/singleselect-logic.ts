// Pure rules for the searchable single-select (web/singleselect.ts) and its project options.
// Filtering itself is the multi-select's filterOptions (case-insensitive, matches anywhere in `name`).
import type { ProjectOption } from '../src/types.js';
import type { MultiOption } from './multiselect-logic.js';

export const ALL_PROJECTS_LABEL = 'All projects';

/**
 * "All projects" (value '') first, then each project as "KEY — Name" in the given order. The search
 * text is key and name joined by a newline, so a query matches either one but never across the two.
 */
export function projectOptions(projects: ProjectOption[]): MultiOption[] {
  return [
    { value: '', name: ALL_PROJECTS_LABEL, label: ALL_PROJECTS_LABEL },
    ...projects.map((p) => ({ value: p.key, name: `${p.key}\n${p.name}`, label: `${p.key} — ${p.name}` })),
  ];
}

/**
 * Option to highlight after the list opens or the search changes: with no search, the current
 * selection (so Enter keeps it); while searching, an option whose label equals the search (case-insensitive,
 * e.g. "Status" among "Epic Status", "Status"), else the first match (so typing + Enter picks it). -1 = none.
 */
export function initialActive(filtered: MultiOption[], selected: string, query: string): number {
  if (filtered.length === 0) return -1;
  const q = query.trim().toLocaleLowerCase();
  if (q) return Math.max(0, filtered.findIndex((o) => o.label.toLocaleLowerCase() === q));
  return Math.max(0, filtered.findIndex((o) => o.value === selected));
}
