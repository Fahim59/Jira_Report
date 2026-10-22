import { highlightOption, onOutside } from './combobox.js';
import { filterOptions, moveActive, selectAllFiltered, toggleValue, type MultiOption, type PickResult } from './multiselect-logic.js';

export { filterOptions, type MultiOption } from './multiselect-logic.js';

export interface MultiSelectOptions {
  /** Upper bound on the selection (mirrors the server limit). */
  max: number;
  placeholder: string;
  labelledBy: string;
  /** What the options are, for the limit message ("Limit is 50 users."). Default "users". */
  noun?: string;
  /** Status line when nothing is selected. Default "None selected = all users". */
  emptyText?: string;
  /** Show "Select all (filtered)" / "Clear" above the list. Default true. */
  tools?: boolean;
  onChange?: (values: string[]) => void;
}

let instanceCount = 0;

/**
 * Searchable multi-select: a text input with chips for the selection and a listbox of checkboxes.
 * Focus stays in the input; the highlighted option is exposed via aria-activedescendant.
 *
 * Keyboard: type to filter · ↑/↓ move · Enter toggles · Space toggles once an option is highlighted
 * with the arrows (otherwise it types a space, names have spaces) · Esc closes · Backspace on an
 * empty input removes the last chip. Selecting a user (or "Select all (filtered)") clears the search
 * and shows the full list again, with focus kept in the input and the list open.
 */
export class MultiSelect {
  private options: MultiOption[] = [];
  private byValue = new Map<string, MultiOption>();
  private selected: string[] = []; // selection order = chip order
  private filtered: MultiOption[] = [];
  private active = -1; // index into `filtered`, -1 = none highlighted
  private readonly id = `ms${++instanceCount}`;

  private readonly control: HTMLDivElement;
  private readonly chips: HTMLSpanElement;
  private readonly input: HTMLInputElement;
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly status: HTMLSpanElement;
  private readonly selectAllBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: MultiSelectOptions,
  ) {
    root.classList.add('ms');

    this.control = document.createElement('div');
    this.control.className = 'ms-control';
    this.chips = document.createElement('span');
    this.chips.className = 'ms-chips';
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
    this.control.append(this.chips, this.input);

    this.panel = document.createElement('div');
    this.panel.className = 'ms-panel';
    this.panel.hidden = true;
    const tools = document.createElement('div');
    tools.className = 'ms-tools';
    this.selectAllBtn = this.toolButton('Select all (filtered)');
    this.clearBtn = this.toolButton('Clear');
    this.status = document.createElement('span');
    this.status.className = 'ms-status';
    this.status.setAttribute('aria-live', 'polite');
    if (opts.tools === false) tools.append(this.status);
    else tools.append(this.selectAllBtn, this.clearBtn, this.status);
    this.list = document.createElement('ul');
    this.list.className = 'ms-list';
    this.list.id = `${this.id}-list`;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.setAttribute('aria-labelledby', opts.labelledBy);
    this.panel.append(tools, this.list);

    root.replaceChildren(this.control, this.panel);
    this.bind();
    this.renderChips();
  }

  setOptions(options: MultiOption[]): void {
    this.options = options;
    this.byValue = new Map(options.map((o) => [o.value, o]));
    this.selected = this.selected.filter((v) => this.byValue.has(v));
    this.refilter();
    this.renderChips();
  }

  /** Selected values; empty = no filter (all users). */
  get values(): string[] {
    return [...this.selected];
  }

  /** Replaces the selection (unknown values dropped, capped at max). Fires onChange. */
  setValues(values: string[]): void {
    this.selected = [...new Set(values)].filter((v) => this.byValue.has(v)).slice(0, this.opts.max);
    this.changed();
  }

  /** Labels of the selected options, in chip order. */
  get labels(): string[] {
    return this.selected.map((v) => this.byValue.get(v)?.label ?? v);
  }

  // ---- behaviour ----

  private toolButton(text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ms-tool';
    b.textContent = text;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    return b;
  }

  private bind(): void {
    this.control.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.ms-chip-x')) return;
      if (e.target !== this.input) e.preventDefault();
      this.input.focus();
      this.open();
    });
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('input', () => {
      this.open();
      this.active = -1;
      this.refilter();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-index]');
      if (!li) return;
      this.active = Number(li.dataset.index);
      this.toggle(this.filtered[this.active]!.value);
    });

    this.selectAllBtn.addEventListener('click', () => {
      this.apply(selectAllFiltered(this.selected, this.filtered.map((o) => o.value), this.opts.max, this.opts.noun));
    });
    this.clearBtn.addEventListener('click', () => {
      this.selected = [];
      this.changed();
    });

    this.chips.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest<HTMLButtonElement>('.ms-chip-x');
      if (!x) return;
      this.selected = this.selected.filter((v) => v !== x.dataset.value);
      this.changed();
      this.input.focus();
    });

    onOutside(this.root, () => this.close());
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (this.panel.hidden) this.open();
        if (this.filtered.length === 0) return;
        this.setActive(moveActive(this.active, this.filtered.length, e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      case 'Enter':
        if (this.panel.hidden) return; // closed: Enter submits the filter form as usual
        e.preventDefault();
        if (this.active >= 0) this.toggle(this.filtered[this.active]!.value);
        return;
      case ' ':
        if (this.active >= 0 && !this.panel.hidden) {
          e.preventDefault();
          this.toggle(this.filtered[this.active]!.value);
        }
        return;
      case 'Escape':
        if (!this.panel.hidden) {
          e.preventDefault();
          this.close();
        }
        return;
      case 'Backspace':
        if (this.input.value === '' && this.selected.length > 0) {
          this.selected.pop();
          this.changed();
        }
        return;
    }
  }

  private toggle(value: string): void {
    this.apply(toggleValue(this.selected, value, this.opts.max, this.opts.noun));
  }

  private apply(r: PickResult): void {
    if (r.clearQuery) {
      // Fresh search: empty text, full list, nothing highlighted (so Space types a space again).
      this.input.value = '';
      this.active = -1;
      this.filtered = filterOptions(this.options, '');
      this.list.scrollTop = 0;
      this.input.focus();
      this.open();
    }
    if (r.selected === this.selected) {
      this.renderList(r.note); // nothing changed (limit reached)
      return;
    }
    this.selected = r.selected;
    this.changed(r.note);
  }

  private changed(note?: string): void {
    this.renderChips();
    this.renderList(note);
    this.opts.onChange?.(this.values);
  }

  private open(): void {
    if (!this.panel.hidden) return;
    this.panel.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.renderList();
  }

  private close(): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.setActive(-1);
  }

  private refilter(): void {
    this.filtered = filterOptions(this.options, this.input.value);
    if (this.active >= this.filtered.length) this.active = -1;
    this.renderList();
  }

  private setActive(index: number): void {
    this.active = index;
    highlightOption(this.list, this.input, index);
  }

  // ---- rendering ----

  private renderChips(): void {
    this.chips.replaceChildren(
      ...this.selected.map((v) => {
        const label = this.byValue.get(v)?.label ?? v;
        const chip = document.createElement('span');
        chip.className = 'ms-chip';
        chip.title = label;
        const text = document.createElement('span');
        text.className = 'ms-chip-text';
        text.textContent = label;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ms-chip-x';
        x.dataset.value = v;
        x.tabIndex = -1;
        x.setAttribute('aria-label', `Remove ${label}`);
        x.textContent = '×';
        chip.append(text, x);
        return chip;
      }),
    );
    this.input.placeholder = this.selected.length ? '' : this.opts.placeholder;
  }

  private renderList(note?: string): void {
    if (this.panel.hidden) return;
    const chosen = new Set(this.selected);
    const items = this.filtered.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${this.id}-opt-${i}`;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(chosen.has(o.value)));
      if (i === this.active) li.classList.add('active');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.tabIndex = -1;
      box.checked = chosen.has(o.value);
      box.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = o.label;
      li.append(box, text);
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'ms-empty';
      const noun = this.opts.noun ?? 'users';
      li.textContent = this.options.length ? `No matching ${noun}` : `No ${noun} loaded`;
      items.push(li);
    }
    this.list.replaceChildren(...items);
    this.setActive(this.active);

    this.selectAllBtn.disabled = this.filtered.every((o) => chosen.has(o.value));
    this.clearBtn.disabled = this.selected.length === 0;
    this.status.textContent = note ?? (this.selected.length ? `${this.selected.length} selected` : (this.opts.emptyText ?? 'None selected = all users'));
  }
}
