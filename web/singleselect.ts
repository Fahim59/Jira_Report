import { highlightOption, onOutside } from './combobox.js';
import { filterOptions, moveActive, type MultiOption } from './multiselect-logic.js';
import { initialActive } from './singleselect-logic.js';

export interface SingleSelectOptions {
  labelledBy: string;
  /** Shown in the list when the search matches nothing. */
  noMatchText: string;
  onChange?: (value: string) => void;
}

let instanceCount = 0;

/**
 * Searchable single-select (combobox). Closed, the input shows the selected option's label. Opening
 * empties the input (the current label becomes the placeholder) so typing searches right away.
 *
 * Keyboard: type to filter · ↑/↓ move · Enter selects the highlighted option (closed: submits the form)
 * · Esc closes without changing. Clicking outside also closes without changing; any typed text is
 * replaced by the current selection again. Shares the multi-select's filtering, keyboard and CSS (.ms-*).
 */
export class SingleSelect {
  private options: MultiOption[] = [];
  private filtered: MultiOption[] = [];
  private selected = '';
  private active = -1;
  private readonly id = `ss${++instanceCount}`;

  private readonly control: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLUListElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: SingleSelectOptions,
  ) {
    root.classList.add('ms', 'ss');

    this.control = document.createElement('div');
    this.control.className = 'ms-control';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'ms-input';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', `${this.id}-list`);
    this.input.setAttribute('aria-labelledby', opts.labelledBy);
    this.control.append(this.input);

    this.panel = document.createElement('div');
    this.panel.className = 'ms-panel';
    this.panel.hidden = true;
    this.list = document.createElement('ul');
    this.list.className = 'ms-list';
    this.list.id = `${this.id}-list`;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-labelledby', opts.labelledBy);
    this.panel.append(this.list);

    root.replaceChildren(this.control, this.panel);
    this.bind();
  }

  /** Replaces the options. The selection is kept if still present, otherwise it falls back to the first option. */
  setOptions(options: MultiOption[]): void {
    this.options = options;
    if (!options.some((o) => o.value === this.selected)) this.selected = options[0]?.value ?? '';
    if (this.panel.hidden) this.showSelection();
    else this.refilter();
  }

  get value(): string {
    return this.selected;
  }

  /** Selects `value` if it is an option (no onChange). */
  setValue(value: string): void {
    if (!this.options.some((o) => o.value === value)) return;
    this.selected = value;
    if (this.panel.hidden) this.showSelection();
    else this.renderList();
  }

  get label(): string {
    return this.options.find((o) => o.value === this.selected)?.label ?? this.selected;
  }

  // ---- behaviour ----

  private bind(): void {
    this.control.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) e.preventDefault();
      this.input.focus();
      this.open();
    });
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('input', () => {
      this.open();
      this.refilter();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-index]');
      if (li) this.pick(Number(li.dataset.index));
    });

    onOutside(this.root, () => this.close());
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (this.panel.hidden) return this.open();
        this.setActive(moveActive(this.active, this.filtered.length, e.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'Enter':
        if (this.panel.hidden) return; // closed: Enter submits the filter form as usual
        e.preventDefault();
        if (this.active >= 0) this.pick(this.active);
        return;
      case 'Escape':
        if (this.panel.hidden) return;
        e.preventDefault();
        this.close();
        return;
    }
  }

  private pick(index: number): void {
    const option = this.filtered[index];
    if (!option) return;
    const changed = option.value !== this.selected;
    this.selected = option.value;
    this.close();
    if (changed) this.opts.onChange?.(this.selected);
  }

  private open(): void {
    if (!this.panel.hidden) return;
    this.panel.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    // Start a fresh search; the current choice stays visible as the placeholder.
    this.input.placeholder = this.label;
    this.input.value = '';
    this.list.scrollTop = 0;
    this.refilter();
  }

  /** Closes and shows the selection again: typed text that was not picked is dropped. */
  private close(): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.setActive(-1);
    this.showSelection();
  }

  private showSelection(): void {
    this.input.value = this.label;
    this.input.placeholder = '';
  }

  private refilter(): void {
    this.filtered = filterOptions(this.options, this.input.value);
    this.active = initialActive(this.filtered, this.selected, this.input.value);
    this.renderList();
  }

  private setActive(index: number): void {
    this.active = index;
    highlightOption(this.list, this.input, index);
  }

  // ---- rendering ----

  private renderList(): void {
    if (this.panel.hidden) return;
    const items = this.filtered.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${this.id}-opt-${i}`;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(o.value === this.selected));
      if (o.value === this.selected) li.classList.add('chosen');
      li.textContent = o.label;
      li.title = o.label;
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'ms-empty';
      li.textContent = this.opts.noMatchText;
      items.push(li);
    }
    this.list.replaceChildren(...items);
    this.setActive(this.active);
  }
}
