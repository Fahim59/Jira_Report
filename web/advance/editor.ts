// Sheet editor of the Advance Report tab: the sheet list (add, duplicate, delete, rename, reorder) and the selected
// sheet's panel (rows mode, group levels, columns with labels, totals and format options). It edits a TemplateDraft in
// place and calls onChange after every edit. Pure rules are in ./template-logic.ts and ./logic.ts.
import type { RowMode } from '../../src/services/custom/template.js';
import { MAX_EXTRACT } from '../../src/services/custom/text.js';
import type { FieldInfo } from '../api.js';
import type { MultiOption } from '../multiselect-logic.js';
import { SingleSelect } from '../singleselect.js';
import {
  fieldName,
  fieldOptions,
  MAX_COLUMNS,
  MAX_GROUP_LEVELS,
  moveItem,
  ROLLUP_TOOLTIP,
} from './logic.js';
import {
  columnAllowed,
  DEFAULT_TOTAL_LABEL,
  droppedColumns,
  duplicateSheet,
  isMetric,
  levelAllowed,
  MAX_LABEL,
  MAX_SHEET_NAME,
  MAX_SHEETS,
  newSheet,
  nextFreeField,
  refExtractProblem,
  ROW_MODE_LABELS,
  setMode,
  sheetNameProblem,
  uniqueSheetName,
  type RefDraft,
  type SheetDraft,
  type TemplateDraft,
} from './template-logic.js';

export interface EditorDeps {
  fields: () => FieldInfo[];
  userOptions: () => MultiOption[];
  /** The draft changed (unsaved-changes dot). */
  onChange: () => void;
  /** A notice for the user (e.g. columns dropped by a mode switch); undefined clears it. */
  info: (message: string | undefined) => void;
}

let seq = 0;
const uid = (stem: string) => `${stem}-${++seq}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, title: string, onClick: () => void, opts: { disabled?: boolean; className?: string; label?: string } = {}): HTMLButtonElement {
  const b = el('button', opts.className ?? 'cr-icon secondary', text);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', opts.label ?? title);
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

function select<T extends string>(options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select');
  for (const [v, label] of options) {
    const o = el('option', undefined, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

/** A labelled control: <label><span>Text</span>control</label>. */
function labelled(text: string, control: HTMLElement, className = 'cr-opt'): HTMLLabelElement {
  const l = el('label', className);
  l.append(el('span', undefined, text), control);
  return l;
}

function checkbox(text: string, checked: boolean, onChange: (v: boolean) => void, opts: { disabled?: boolean; title?: string } = {}): HTMLLabelElement {
  const l = el('label', 'cr-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = !!opts.disabled;
  input.addEventListener('change', () => onChange(input.checked));
  l.append(input, document.createTextNode(` ${text}`));
  if (opts.title) l.title = opts.title;
  return l;
}

export class SheetEditor {
  private draft: TemplateDraft = { name: '', defaults: { projects: [], authors: [] }, sheets: [] };
  private selected = 0;
  private disabled = false;

  constructor(
    private readonly list: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly addBtn: HTMLButtonElement,
    private readonly deps: EditorDeps,
  ) {
    addBtn.addEventListener('click', () => {
      const sheets = this.draft.sheets;
      if (sheets.length >= MAX_SHEETS) return;
      sheets.push(newSheet(uniqueSheetName('Sheet', sheets.map((s) => s.name)), this.fields));
      this.select(sheets.length - 1);
      this.changed();
      this.panel.querySelector<HTMLInputElement>('.cr-sheet-name')?.select();
    });
  }

  private get fields(): FieldInfo[] {
    return this.deps.fields();
  }

  private get sheet(): SheetDraft | undefined {
    return this.draft.sheets[this.selected];
  }

  /** Starts editing `draft` (owned by the editor from now on), first sheet selected. */
  load(draft: TemplateDraft): void {
    this.draft = draft;
    this.selected = 0;
    this.render();
  }

  get value(): TemplateDraft {
    return this.draft;
  }

  /** Nothing to edit (no field list): empty editor. */
  clear(): void {
    this.load({ name: '', defaults: { projects: [], authors: [] }, sheets: [] });
  }

  /** Locks the editor while a report is generating (the run uses the template as it was). */
  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.panel.closest('fieldset')?.toggleAttribute('disabled', disabled);
  }

  private changed(): void {
    this.deps.onChange();
  }

  private select(i: number): void {
    this.selected = Math.max(0, Math.min(i, this.draft.sheets.length - 1));
    this.render();
  }

  render(): void {
    this.renderList();
    this.renderPanel();
  }

  // ---- sheet list ----

  private renderList(): void {
    const sheets = this.draft.sheets;
    this.list.replaceChildren(
      ...sheets.map((s, i) => {
        const b = el('button', 'cr-sheet-item');
        b.type = 'button';
        b.append(el('span', 'cr-sheet-item-name', s.name.trim() || '(no name)'), el('span', 'cr-sheet-item-mode', ROW_MODE_LABELS[s.mode]));
        if (i === this.selected) b.setAttribute('aria-current', 'true');
        if (sheetNameProblem(s.name)) b.classList.add('invalid');
        b.addEventListener('click', () => this.select(i));
        return b;
      }),
    );
    this.addBtn.disabled = this.disabled || sheets.length >= MAX_SHEETS || this.fields.length === 0;
    this.addBtn.title = sheets.length >= MAX_SHEETS ? `At most ${MAX_SHEETS} sheets` : '';
  }

  // ---- selected sheet ----

  private renderPanel(): void {
    const s = this.sheet;
    if (!s) {
      this.panel.replaceChildren(el('p', 'cr-sub', this.fields.length ? 'Add a sheet to start.' : 'The sheet editor needs the field list.'));
      return;
    }
    const rows = this.rowsSection(s);
    const levels = s.mode === 'group' ? rows[0] : undefined;
    const columns = rows[rows.length - 1]!;
    const used = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : 'none');
    // The two cards sit side by side and start collapsed.
    const pair = el('div', 'ar-card-row');
    pair.append(
      this.card(s.mode === 'group' ? 'Extra columns' : 'Columns', used(s.columns.length, 'column'), columns, false),
      this.card('Totals & format', 'Total row, period, hours/days, sorting', this.optionsSection(s), false),
    );
    this.panel.replaceChildren(this.head(s), ...(levels ? [levels] : []), pair);
  }

  /** Which cards are open, by title: kept across re-renders of the panel. */
  private readonly cardOpen = new Map<string, boolean>();

  /** A collapsible block of the sheet editor: title, one-line summary of what is set, then the controls. */
  private card(title: string, summary: string, body: HTMLElement, openByDefault: boolean): HTMLElement {
    const d = el('details', 'ar-card');
    d.open = this.cardOpen.get(title) ?? openByDefault;
    d.addEventListener('toggle', () => this.cardOpen.set(title, d.open));
    const head = el('summary', 'ar-card-head');
    head.append(el('span', 'ar-card-title', title), el('span', 'ar-card-sum', summary));
    d.append(head, body);
    return d;
  }

  private head(s: SheetDraft): HTMLElement {
    const i = this.selected;
    const n = this.draft.sheets.length;
    const head = el('div', 'cr-sheet-head');

    const nameId = uid('ar-sheet-name');
    const name = el('input', 'cr-sheet-name');
    name.type = 'text';
    name.id = nameId;
    name.maxLength = MAX_SHEET_NAME;
    name.value = s.name;
    name.spellcheck = false;
    const problem = el('span', 'cr-field-error');
    problem.id = uid('ar-sheet-name-err');
    name.setAttribute('aria-describedby', problem.id);
    const showProblem = () => {
      const p = sheetNameProblem(s.name);
      const dup = this.draft.sheets.some((o, j) => j !== i && o.name.trim().toLowerCase() === s.name.trim().toLowerCase());
      problem.textContent = p ? `Invalid: ${p}.` : dup ? 'Another sheet has this name.' : '';
      name.setAttribute('aria-invalid', String(!!p || dup));
    };
    name.addEventListener('input', () => {
      s.name = name.value;
      showProblem();
      this.renderList();
      this.changed();
    });
    showProblem();
    const nameLabel = el('label', 'cr-opt cr-sheet-name-field');
    nameLabel.htmlFor = nameId;
    nameLabel.append(el('span', undefined, 'Sheet name'), name, problem);

    const mode = labelled(
      'Rows',
      select(Object.entries(ROW_MODE_LABELS) as [RowMode, string][], s.mode, (m) => {
        const dropped = droppedColumns(s, m);
        this.draft.sheets[i] = setMode(s, m, this.fields);
        this.deps.info(dropped.length ? `Removed column(s) not available for "${ROW_MODE_LABELS[m]}": ${dropped.map((c) => c.label || fieldName(this.fields, c.fieldId)).join(', ')}.` : undefined);
        this.render();
        this.changed();
      }),
    );

    const actions = el('div', 'cr-sheet-actions');
    const move = (step: -1 | 1) => {
      this.draft.sheets = moveItem(this.draft.sheets, i, step);
      this.select(i + step);
      this.changed();
    };
    actions.append(
      button('↑', 'Move sheet up', () => move(-1), { disabled: i === 0 }),
      button('↓', 'Move sheet down', () => move(1), { disabled: i === n - 1 }),
      button('Duplicate', 'Duplicate this sheet', () => {
        this.draft.sheets = duplicateSheet(this.draft.sheets, i);
        this.select(i + 1);
        this.changed();
      }, { disabled: n >= MAX_SHEETS, className: 'secondary' }),
      button('Delete', 'Delete this sheet', () => {
        if (!confirm(`Delete sheet "${s.name.trim() || '(no name)'}"?`)) return;
        this.draft.sheets.splice(i, 1);
        this.select(i - (i === n - 1 ? 1 : 0));
        this.changed();
      }, { disabled: n <= 1, className: 'secondary' }),
    );
    head.append(nameLabel, mode, actions);
    return head;
  }

  /** Group levels (group mode) and the columns, each with a label input. */
  private rowsSection(s: SheetDraft): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (s.mode === 'group') {
      out.push(
        this.refList(s.groupBy, {
          title: `Group by (1–${MAX_GROUP_LEVELS} levels)`,
          noun: 'level',
          max: MAX_GROUP_LEVELS,
          min: 1,
          allowed: levelAllowed,
          preferred: ['worklog.author', 'issue.keySummary', 'status', 'issue.key', 'project', 'worklog.date'],
          hint: 'Header: the label, else the field name. Each level also gets a "Total <header>" column unless Total columns is "One total column". Extract: a regex; the value becomes its first match (group 1 if the pattern has one), else stays as is. Applied before grouping.',
        }),
      );
    }
    out.push(
      this.refList(s.columns, {
        title: s.mode === 'group' ? 'Extra columns' : 'Columns',
        noun: 'column',
        max: MAX_COLUMNS,
        min: s.mode === 'group' ? 0 : 1,
        allowed: (id) => columnAllowed(s.mode, id),
        preferred: s.mode === 'group' ? [] : ['worklog.author', 'issue.key', 'summary', 'metric.hours'],
        hint:
          s.mode === 'group'
            ? 'A value shared by everything in the row, else "(multiple)". "Issue Count" / "Worklog Count": distinct issues (after sub-task rollup) / worklogs in the row; the Total row counts distinct issues overall.'
            : s.mode === 'eachWorklog'
              ? 'One row per worklog, ordered by author, then start time. "Hours" = that worklog\'s time.'
              : 'One row per issue, newest key first. "Hours" = the issue\'s time in the range. Worklog fields are not available.',
      }),
    );
    return out;
  }

  private refList(
    refs: RefDraft[],
    o: { title: string; noun: string; max: number; min: number; allowed: (id: string) => boolean; preferred: string[]; hint: string },
  ): HTMLElement {
    const box = el('div', 'cr-refs');
    const titleId = uid('ar-refs-title');
    const title = el('span', 'cr-sub', o.title);
    title.id = titleId;
    const rows = el('div', 'cr-ref-rows');
    const render = () => {
      rows.replaceChildren(
        ...refs.map((ref, i) => {
          const row = el('div', 'cr-ref');
          const n = el('span', 'cr-level-n', `${i + 1}.`);
          n.id = uid('ar-ref-n');
          const pickBox = el('div', 'cr-level-field');
          const others = new Set(refs.filter((_, j) => j !== i).map((r) => r.fieldId));
          const picker = new SingleSelect(pickBox, {
            labelledBy: `${titleId} ${n.id}`,
            noMatchText: 'No matching fields',
            onChange: (v) => {
              ref.fieldId = v;
              render();
              this.changed();
            },
          });
          picker.setOptions(fieldOptions(this.fields.filter((f) => o.allowed(f.id) || f.id === ref.fieldId), others));
          picker.setValue(ref.fieldId);
          const label = el('input', 'cr-ref-label');
          label.type = 'text';
          label.maxLength = MAX_LABEL;
          label.value = ref.label;
          label.placeholder = fieldName(this.fields, ref.fieldId);
          label.title = 'Header label (empty = the field name)';
          label.setAttribute('aria-label', `Header label for ${o.noun} ${i + 1} (empty = ${label.placeholder})`);
          label.addEventListener('input', () => {
            ref.label = label.value;
            this.changed();
          });
          const extract = el('input', 'cr-ref-extract');
          extract.type = 'text';
          extract.maxLength = MAX_EXTRACT;
          extract.value = ref.extract;
          extract.placeholder = 'Extract (regex)';
          extract.spellcheck = false;
          extract.setAttribute('aria-label', `Extract pattern for ${o.noun} ${i + 1} (optional regular expression)`);
          extract.hidden = isMetric(ref.fieldId);
          const showExtractProblem = () => {
            const problem = refExtractProblem(ref);
            extract.classList.toggle('invalid', !!problem);
            extract.setAttribute('aria-invalid', String(!!problem));
            extract.title = problem ? `Invalid: ${problem}` : 'Optional regex: the value becomes its first match (group 1 if present); no match = unchanged';
          };
          extract.addEventListener('input', () => {
            ref.extract = extract.value;
            showExtractProblem();
            this.changed();
          });
          showExtractProblem();
          const move = (step: -1 | 1) => {
            const moved = moveItem(refs, i, step);
            refs.splice(0, refs.length, ...moved);
            render();
            this.changed();
          };
          row.append(
            n,
            pickBox,
            label,
            extract,
            button('↑', `Move ${o.noun} up`, () => move(-1), { disabled: i === 0, label: `Move ${o.noun} ${i + 1} up` }),
            button('↓', `Move ${o.noun} down`, () => move(1), { disabled: i === refs.length - 1, label: `Move ${o.noun} ${i + 1} down` }),
            button('×', `Remove ${o.noun}`, () => {
              refs.splice(i, 1);
              render();
              this.changed();
            }, { disabled: refs.length <= o.min, label: `Remove ${o.noun} ${i + 1}` }),
          );
          if (!o.allowed(ref.fieldId)) row.classList.add('invalid');
          return row;
        }),
      );
      add.disabled = refs.length >= o.max || !nextFreeField(this.fields, refs.map((r) => r.fieldId), o.allowed);
    };
    const add = button(`+ Add ${o.noun}`, `Add a ${o.noun}`, () => {
      const id = nextFreeField(this.fields, refs.map((r) => r.fieldId), o.allowed, o.preferred);
      if (!id || refs.length >= o.max) return;
      refs.push({ fieldId: id, label: '', extract: '' });
      render();
      this.changed();
    }, { className: 'secondary' });
    render();
    box.append(title, rows, add);
    return box;
  }

  private optionsSection(s: SheetDraft): HTMLElement {
    const box = el('div', 'ar-options');
    const rerender = () => {
      this.renderPanel();
      this.changed();
    };
    const group = s.mode === 'group';
    const grid = el('div', 'ar-grid');
    const checks = el('div', 'ar-checks');
    if (group) {
      grid.append(
        labelled('Period', select([['none', 'None'], ['day', 'Day'], ['week', 'Week (ISO)'], ['month', 'Month']] as const, s.period, (v) => {
          s.period = v;
          this.changed();
        })),
      );
    }
    grid.append(
      labelled('Format', select([['hours', 'Hours'], ['days', 'Days']] as const, s.format, (v) => {
        s.format = v;
        this.changed();
      })),
    );
    if (group) {
      grid.append(
        labelled('Sort', select([['value', 'By name'], ['totalDesc', 'By total (largest first)']] as const, s.sort, (v) => {
          s.sort = v;
          this.changed();
        })),
        labelled('Total columns', select([['everyLevel', 'After every level'], ['lastLevel', 'One total column']] as const, s.totalColumns, (v) => {
          s.totalColumns = v;
          rerender();
        })),
      );
      const totalLabel = el('input', 'cr-total-label');
      totalLabel.type = 'text';
      totalLabel.maxLength = MAX_LABEL;
      totalLabel.value = s.totalLabel;
      totalLabel.placeholder = DEFAULT_TOTAL_LABEL;
      totalLabel.title = 'Header of the single total column, or of the Total column after period columns';
      totalLabel.addEventListener('input', () => {
        s.totalLabel = totalLabel.value;
        this.changed();
      });
      grid.append(labelled('Total label', totalLabel));
    }
    checks.append(
      checkbox(group ? 'Totals (Total row)' : 'Totals (Total row, needs an Hours column)', s.totals, (v) => {
        s.totals = v;
        rerender();
      }),
    );
    if (group) {
      const canSubtotal = s.totalColumns === 'lastLevel' && s.totals;
      checks.append(
        checkbox('Subtotal rows', canSubtotal && s.subtotalRows, (v) => {
          s.subtotalRows = v;
          this.changed();
        }, { disabled: !canSubtotal, title: canSubtotal ? 'A bold "<group> Total" row after each parent group' : 'Needs Total columns "One total column" and Totals on' }),
        checkbox('Merge group cells', s.mergeGroupCells, (v) => {
          s.mergeGroupCells = v;
          this.changed();
        }, { title: 'In the .xlsx, merge each parent group\'s value (and its total cell) down its rows, top-aligned' }),
      );
    }
    if (s.mode === 'eachIssue') {
      checks.append(
        checkbox('Include issues without time (0 hours)', s.includeIssuesWithoutWorklogs, (v) => {
          s.includeIssuesWithoutWorklogs = v;
          this.changed();
        }, { title: 'Also lists matching issues of the selected projects with no time in the range. Needs at least one project in the filter.' }),
      );
    }
    const rollup = checkbox('Sum sub-tasks into parent', s.sumSubtasksToParent, (v) => {
      s.sumSubtasksToParent = v;
      this.changed();
    });
    const info = el('span', 'info', 'ⓘ');
    info.tabIndex = 0;
    info.setAttribute('role', 'img');
    info.title = ROLLUP_TOOLTIP;
    info.setAttribute('aria-label', ROLLUP_TOOLTIP);
    rollup.append(info);
    checks.append(rollup);
    box.append(grid, checks);
    return box;
  }
}
