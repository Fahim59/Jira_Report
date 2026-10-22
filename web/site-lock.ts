// The site switcher is disabled while any report (matrix or Custom Report) is generating: a report belongs to
// the site it was started on. Each tab locks/unlocks under its own name, so one finishing does not unlock the other.

const holders = new Set<string>();

export function setSiteLock(select: HTMLSelectElement, owner: string, locked: boolean): void {
  if (locked) holders.add(owner);
  else holders.delete(owner);
  select.disabled = holders.size > 0;
}

export function isSiteLocked(): boolean {
  return holders.size > 0;
}
