// Pure selection/filter rules for web/multiselect.ts (no DOM, so they can be unit-tested in node).

export interface MultiOption {
  value: string;
  /** What filtering matches against (e.g. the display name). */
  name: string;
  /** Shown in the list and on the chip (e.g. "Jane Doe (inactive)"). */
  label: string;
}

/**
 * Next highlighted index for ArrowDown (step 1) / ArrowUp (step -1) over `count` options, wrapping
 * around. From "nothing highlighted" (-1), Down goes to the first and Up to the last. -1 if the list is empty.
 */
export function moveActive(active: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (active < 0) return step > 0 ? 0 : count - 1;
  return (active + step + count) % count;
}

/** Case-insensitive "contains anywhere in the name". Empty query matches everything. */
export function filterOptions(options: MultiOption[], query: string): MultiOption[] {
  const q = query.trim().toLocaleLowerCase();
  return q ? options.filter((o) => o.name.toLocaleLowerCase().includes(q)) : options;
}

/** Outcome of a selection action: the new selection, and whether the search text should be cleared. */
export interface PickResult {
  selected: string[];
  /** True when something was added: the search is reset so the next name can be typed right away. */
  clearQuery: boolean;
  note?: string;
}

/**
 * Click / Enter / Space on an option. Adding clears the search; removing keeps it (the user is still
 * working within that search). At the limit nothing changes and the search is kept.
 */
export function toggleValue(selected: string[], value: string, max: number, noun = 'users'): PickResult {
  if (selected.includes(value)) return { selected: selected.filter((v) => v !== value), clearQuery: false };
  if (selected.length >= max) return { selected, clearQuery: false, note: `Limit is ${max} ${noun}.` };
  return { selected: [...selected, value], clearQuery: true };
}

/** "Select all (filtered)": adds the filtered options up to the limit, then clears the search. */
export function selectAllFiltered(selected: string[], filtered: string[], max: number, noun = 'users'): PickResult {
  const room = Math.max(0, max - selected.length);
  const toAdd = filtered.filter((v) => !selected.includes(v));
  return {
    selected: [...selected, ...toAdd.slice(0, room)],
    clearQuery: true,
    note: toAdd.length > room ? `Limit is ${max} ${noun}; ${toAdd.length - room} not added.` : undefined,
  };
}
