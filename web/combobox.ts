// DOM helpers shared by the searchable pickers (web/multiselect.ts, web/singleselect.ts).

/**
 * Highlights option `index` (-1 = none) of a listbox whose options carry data-index, scrolls it into
 * view and exposes it to screen readers via the input's aria-activedescendant.
 */
export function highlightOption(list: HTMLElement, input: HTMLInputElement, index: number): void {
  for (const li of list.querySelectorAll('li.active')) li.classList.remove('active');
  const li = index >= 0 ? list.querySelector<HTMLLIElement>(`li[data-index="${index}"]`) : null;
  if (li) {
    li.classList.add('active');
    li.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', li.id);
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

/**
 * Calls `onOutside` when a mouse press lands outside `root` or focus leaves it. Once `root` has been removed from
 * the page (the template editor re-renders its pickers), the document listener removes itself.
 */
export function onOutside(root: HTMLElement, onOutside: () => void): void {
  const listener = (e: MouseEvent) => {
    if (!root.isConnected) return document.removeEventListener('mousedown', listener);
    if (!root.contains(e.target as Node)) onOutside();
  };
  document.addEventListener('mousedown', listener);
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) onOutside();
  });
}
