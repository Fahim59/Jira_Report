// Custom Report tab (Phase 8b): global filter, template dropdown (Save / Save as / Rename / Delete / default), sheet
// editor, and one Generate button that shows a preview and downloads one .xlsx. Pure rules are in ./logic.ts and
// ./template-logic.ts; the sheet editor is ./editor.ts, the preview ./preview.ts.
import {
  cancelReport,
  CancelledError,
  createTemplate,
  deleteTemplate,
  getFields,
  getProjects,
  getTemplates,
  getUsers,
  postCustomExport,
  postCustomReport,
  setDefaultTemplate,
  unsetDefaultTemplate,
  updateTemplate,
  watchProgress,
  type CustomReport,
  type CustomReportRequest,
  type FieldInfo,
  type ProgressEvent,
  type TemplateItem,
} from '../api.js';
import { MultiSelect } from '../multiselect.js';
import type { MultiOption } from '../multiselect-logic.js';
import { formatRetrieved, renderDrilldown } from '../render.js';
import { setSiteLock } from '../site-lock.js';
import { SheetEditor } from './editor.js';
import { MAX_PICKED } from './logic.js';
import { Preview } from './preview.js';
import {
  buildGenerateBody,
  draftKey,
  draftToBody,
  initialTemplateId,
  newTemplate,
  templateNameProblem,
  templateToDraft,
  type TemplateDraft,
} from './template-logic.js';

export interface AdvanceTabDeps {
  siteSelect: HTMLSelectElement;
  /** Selected site key; undefined = the server's default. */
  site: () => string | undefined;
  /** Jira base URL of a site (issue links). */
  siteUrl: (key: string | undefined) => string | undefined;
  maxRangeDays: () => number;
}

export interface AdvanceTab {
  /** Called when the tab becomes visible: loads fields/projects/users/templates for the site the first time. */
  shown(): void;
  /** Called when the other tab is shown: a site switch then reloads the lists only when this tab is next shown. */
  hidden(): void;
  /** Site switched: clears the result, the filter and the template, reloads the lists (now, or when next shown). */
  siteChanged(): void;
}

/** Dropdown value of an unsaved new template. */
const NEW_TEMPLATE = '__new__';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showMsg(target: HTMLElement, message: string | undefined): void {
  target.textContent = message ?? '';
  target.hidden = !message;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function progressText(e: ProgressEvent): string | undefined {
  switch (e.stage) {
    case 'validating':
      return 'Checking projects, fields and JQL…';
    case 'searching':
      return e.issues === undefined ? 'Searching Jira for issues with worklogs…' : `Found ${e.issues} issue(s) with worklogs…`;
    case 'worklogs':
      return e.total === undefined ? 'Fetching worklogs…' : `Fetching worklogs: ${e.done ?? 0} / ${e.total} issue(s)`;
    case 'processing':
      return 'Building sheets…';
    default:
      return undefined;
  }
}

/** Saves a Blob as a file (the browser's download). */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function setupAdvanceReport(deps: AdvanceTabDeps): AdvanceTab {
  const form = $<HTMLFormElement>('ar-form');
  const fromInput = $<HTMLInputElement>('ar-from');
  const toInput = $<HTMLInputElement>('ar-to');
  const templateSelect = $<HTMLSelectElement>('ar-template');
  const dirtyDot = $<HTMLSpanElement>('ar-dirty');
  const dirtyText = $<HTMLSpanElement>('ar-dirty-text');
  const saveBtn = $<HTMLButtonElement>('ar-tpl-save');
  const saveAsBtn = $<HTMLButtonElement>('ar-tpl-saveas');
  const renameBtn = $<HTMLButtonElement>('ar-tpl-rename');
  const deleteBtn = $<HTMLButtonElement>('ar-tpl-delete');
  const defaultBtn = $<HTMLButtonElement>('ar-tpl-default');
  const tplNote = $<HTMLParagraphElement>('ar-tpl-note');
  const tplWarnings = $<HTMLUListElement>('ar-tpl-warnings');
  const generateBtn = $<HTMLButtonElement>('ar-generate');
  const metaError = $<HTMLParagraphElement>('ar-meta-error');
  const formError = $<HTMLParagraphElement>('ar-error');
  const formInfo = $<HTMLParagraphElement>('ar-info');
  const loading = $<HTMLDivElement>('ar-loading');
  const loadingText = $<HTMLSpanElement>('ar-loading-text');
  const loadingBar = $<HTMLProgressElement>('ar-loading-bar');
  const cancelBtn = $<HTMLButtonElement>('ar-cancel');
  const incomplete = $<HTMLElement>('ar-incomplete');
  const failedKeys = $<HTMLElement>('ar-failed-keys');
  const failureReasons = $<HTMLElement>('ar-failure-reasons');
  const retryBtn = $<HTMLButtonElement>('ar-retry');
  const warnings = $<HTMLElement>('ar-warnings');
  const warningList = $<HTMLUListElement>('ar-warning-list');
  const result = $<HTMLElement>('ar-result');
  const summary = $<HTMLSpanElement>('ar-summary');
  const downloadStatus = $<HTMLSpanElement>('ar-download');
  const retrieved = $<HTMLSpanElement>('ar-retrieved');
  const emptyHint = $<HTMLParagraphElement>('ar-empty-hint');
  const drill = $<HTMLDialogElement>('drill');
  const drillTitle = $<HTMLHeadingElement>('drill-title');
  const drillDate = $<HTMLParagraphElement>('drill-date');
  const drillTable = $<HTMLTableElement>('drill-table');

  // ---- state ----
  let fields: FieldInfo[] = [];
  let userOptions: MultiOption[] = [];
  let userNames = new Map<string, string>();
  let projectNames = new Map<string, string>();
  let templates: TemplateItem[] = [];
  /** The template being edited; undefined = a new, unsaved one. */
  let current: TemplateItem | undefined;
  /** draftKey of the editor as loaded / last saved (the unsaved-changes dot compares with it). */
  let baseline = '';
  /** Site the lists were loaded for ('' = server default); null = not loaded yet (load when shown). */
  let loadedFor: string | null = null;
  let visible = false;
  let loadSeq = 0;
  let busy = false;
  let saving = false;
  let inFlight: { id: string; controller: AbortController } | undefined;
  let lastRun: { body: CustomReportRequest; labels: string } | undefined;
  let report: CustomReport | undefined;

  const projectPicker = new MultiSelect($<HTMLDivElement>('ar-projects'), {
    max: MAX_PICKED,
    noun: 'projects',
    emptyText: 'None selected = all projects',
    placeholder: 'All projects — type to search',
    labelledBy: 'ar-projects-label',
    onChange: () => updateDirty(),
  });
  const userPicker = new MultiSelect($<HTMLDivElement>('ar-users'), {
    max: MAX_PICKED,
    placeholder: 'All users — type to search',
    labelledBy: 'ar-users-label',
    onChange: () => updateDirty(),
  });

  const editor = new SheetEditor($('ar-sheet-list'), $('ar-sheet-panel'), $<HTMLButtonElement>('ar-add-sheet'), {
    fields: () => fields,
    userOptions: () => userOptions,
    onChange: () => updateDirty(),
    info: (m) => showMsg(formInfo, m),
  });

  const preview = new Preview(
    {
      tabs: $('ar-sheet-tabs'),
      panel: $('ar-table-panel'),
      heading: $('ar-sheet-heading'),
      notes: $('ar-notes'),
      table: $<HTMLTableElement>('ar-table'),
      sheetSummary: $('ar-sheet-summary'),
      expandAll: $<HTMLButtonElement>('ar-expand-all'),
      collapseAll: $<HTMLButtonElement>('ar-collapse-all'),
      rowCap: $('ar-row-cap'),
    },
    {
      siteUrl: deps.siteUrl,
      onDrill: (title, subtitle, d) => {
        drillTitle.textContent = title;
        drillDate.textContent = subtitle;
        renderDrilldown(drillTable, d, deps.siteUrl(report?.site), true);
        drill.showModal();
      },
    },
  );

  // ---- template state ----

  /** The editor's draft with the global Projects / Users as the template's defaults (saved with it). */
  function currentDraft(): TemplateDraft {
    const d = editor.value;
    d.defaults = { projects: projectPicker.values, authors: userPicker.values };
    return d;
  }

  const isDirty = () => fields.length > 0 && draftKey(currentDraft()) !== baseline;

  function updateDirty(): void {
    const dirty = isDirty();
    dirtyDot.hidden = !dirty;
    dirtyText.textContent = dirty ? 'Unsaved changes' : '';
    updateButtons();
  }

  function updateButtons(): void {
    const ready = fields.length > 0 && !busy && !saving;
    const saved = current && !current.builtIn ? current : undefined;
    saveBtn.disabled = !ready || current?.builtIn === true || (saved !== undefined && !isDirty());
    saveBtn.title = current?.builtIn ? 'Built-in templates are read-only. Use "Save as" to make an editable copy.' : current ? '' : 'Save this new template (asks for a name)';
    saveAsBtn.disabled = !ready;
    renameBtn.disabled = !ready || !saved;
    deleteBtn.disabled = !ready || !saved;
    defaultBtn.disabled = !ready || !current;
    defaultBtn.textContent = current?.isDefault ? 'Unset default' : 'Set default';
    defaultBtn.title = current
      ? current.isDefault
        ? 'This template opens first on this site. Click to remove that.'
        : 'Open this template first when the Custom Report tab loads on this site'
      : 'Save the template first';
    templateSelect.disabled = !ready;
    generateBtn.disabled = busy || fields.length === 0 || editor.value.sheets.length === 0;
  }

  function renderTemplateSelect(): void {
    const option = (value: string, label: string) => {
      const o = el('option', undefined, label);
      o.value = value;
      return o;
    };
    const name = (t: TemplateItem) => `${t.name}${t.isDefault ? ' ★ default' : ''}`;
    const groups: HTMLElement[] = [];
    const builtIns = templates.filter((t) => t.builtIn);
    const saved = templates.filter((t) => !t.builtIn);
    if (builtIns.length) {
      const g = el('optgroup');
      g.label = 'Built-in (read-only)';
      g.append(...builtIns.map((t) => option(t.id, name(t))));
      groups.push(g);
    }
    if (saved.length) {
      const g = el('optgroup');
      g.label = 'Saved';
      g.append(...saved.map((t) => option(t.id, name(t))));
      groups.push(g);
    }
    templateSelect.replaceChildren(...groups, option(NEW_TEMPLATE, current ? '+ New Report Template' : 'New Report Template'));
    templateSelect.value = current?.id ?? NEW_TEMPLATE;
  }

  function renderNote(): void {
    tplNote.textContent = current?.builtIn
      ? 'Built-in template: read-only. Change it and use "Save as" to keep your version. Projects and Users above are saved with a template as its defaults.'
      : current
        ? 'Projects and Users above are saved with the template as its defaults.'
        : 'New template: press Save to give it a name. Projects and Users above are saved with it as its defaults.';
    const w = current?.builtIn ? current.warnings : [];
    tplWarnings.replaceChildren(...w.map((x) => el('li', undefined, x)));
    tplWarnings.hidden = w.length === 0;
  }

  /** Opens a template (or a new one) in the editor and pre-fills Projects / Users with its defaults. */
  function openTemplate(t: TemplateItem | undefined): void {
    current = t;
    const draft = t ? templateToDraft(t, fields) : newTemplate(fields);
    projectPicker.setValues(draft.defaults.projects);
    userPicker.setValues(draft.defaults.authors);
    editor.load(draft);
    baseline = draftKey(currentDraft()); // after the pickers dropped values the site does not have
    showMsg(formInfo, undefined);
    renderTemplateSelect();
    renderNote();
    updateDirty();
  }

  /** Reloads the template list (keeps the editor as is); returns false on failure (message shown). */
  async function reloadTemplates(): Promise<boolean> {
    const seq = loadSeq;
    try {
      const list = await getTemplates(deps.site());
      if (seq !== loadSeq) return false;
      templates = list.templates.filter((t) => !t.builtIn); // no built-in reports here: users build their own
      const fresh = current && templates.find((t) => t.id === current!.id);
      if (fresh) current = fresh;
      renderTemplateSelect();
      renderNote();
      updateButtons();
      return true;
    } catch (err) {
      showMsg(formError, `Could not reload the template list: ${errText(err)}`);
      return false;
    }
  }

  const confirmDiscard = () => !isDirty() || confirm(`Discard your unsaved changes to "${current?.name ?? 'the new template'}"?`);

  templateSelect.addEventListener('change', () => {
    const id = templateSelect.value;
    if (!confirmDiscard()) {
      templateSelect.value = current?.id ?? NEW_TEMPLATE;
      return;
    }
    showMsg(formError, undefined);
    openTemplate(id === NEW_TEMPLATE ? undefined : templates.find((t) => t.id === id));
  });

  /** Runs a template action with the buttons locked; errors are shown, not thrown. */
  async function templateAction(fn: () => Promise<void>): Promise<void> {
    if (saving || busy) return;
    saving = true;
    showMsg(formError, undefined);
    showMsg(formInfo, undefined);
    updateButtons();
    try {
      await fn();
    } catch (err) {
      showMsg(formError, errText(err));
    } finally {
      saving = false;
      updateButtons();
    }
  }

  function askName(message: string, suggestion: string): string | undefined {
    const name = prompt(message, suggestion);
    if (name === null) return undefined;
    const problem = templateNameProblem(name);
    if (problem) {
      showMsg(formError, problem);
      return undefined;
    }
    return name.trim();
  }

  async function saveAs(): Promise<void> {
    const draft = currentDraft();
    const built = draftToBody(draft, fields);
    if (built.error !== undefined) return showMsg(formError, built.error);
    const name = askName('Save as a new template named:', current ? `${current.name} (copy)` : '');
    if (!name) return;
    const saved = await createTemplate(deps.site(), { ...built.body, name });
    await reloadTemplates();
    const item = templates.find((t) => t.id === saved.id) ?? { ...saved, builtIn: false as const };
    current = item;
    editor.value.name = item.name;
    baseline = draftKey(currentDraft());
    renderTemplateSelect();
    renderNote();
    updateDirty();
    showMsg(formInfo, `Saved as "${item.name}".`);
  }

  saveBtn.addEventListener('click', () =>
    void templateAction(async () => {
      if (!current) return saveAs();
      if (current.builtIn) return;
      const built = draftToBody(currentDraft(), fields, current.name);
      if (built.error !== undefined) return showMsg(formError, built.error);
      const saved = await updateTemplate(current.id, built.body, current.updatedAt);
      current = { ...saved, builtIn: false };
      templates = templates.map((t) => (t.id === saved.id ? current! : t));
      baseline = draftKey(currentDraft());
      renderTemplateSelect();
      updateDirty();
      showMsg(formInfo, `Saved "${saved.name}".`);
    }),
  );

  saveAsBtn.addEventListener('click', () => void templateAction(saveAs));

  renameBtn.addEventListener('click', () =>
    void templateAction(async () => {
      const t = current;
      if (!t || t.builtIn) return;
      const name = askName('Rename the template to:', t.name);
      if (!name || name === t.name) return;
      // Renames the saved version only: unsaved edits stay in the editor (and stay unsaved).
      const saved = await updateTemplate(t.id, { name, defaults: t.defaults, sheets: t.sheets }, t.updatedAt);
      current = { ...saved, builtIn: false };
      editor.value.name = saved.name;
      await reloadTemplates();
      updateDirty();
      showMsg(formInfo, `Renamed to "${saved.name}".`);
    }),
  );

  deleteBtn.addEventListener('click', () =>
    void templateAction(async () => {
      const t = current;
      if (!t || t.builtIn) return;
      if (!confirm(`Delete the template "${t.name}" for everyone? This cannot be undone.`)) return;
      await deleteTemplate(t.id);
      current = undefined;
      if (await reloadTemplates()) openTemplate(templates.find((x) => x.id === initialTemplateId(templates)));
      showMsg(formInfo, `Deleted "${t.name}".`);
    }),
  );

  defaultBtn.addEventListener('click', () =>
    void templateAction(async () => {
      const t = current;
      if (!t) return;
      if (t.isDefault) await unsetDefaultTemplate(t.id, deps.site());
      else await setDefaultTemplate(t.id, deps.site());
      await reloadTemplates();
      showMsg(formInfo, t.isDefault ? `"${t.name}" is no longer the default. The first built-in template opens first.` : `"${t.name}" now opens first on this site.`);
    }),
  );

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  // ---- lists per site ----

  async function loadLists(): Promise<void> {
    const seq = ++loadSeq;
    const site = deps.site();
    loadedFor = site ?? '';
    showMsg(metaError, undefined);
    fields = [];
    templates = [];
    current = undefined;
    userOptions = [];
    userNames = new Map();
    projectNames = new Map();
    projectPicker.setValues([]);
    projectPicker.setOptions([]);
    userPicker.setValues([]);
    userPicker.setOptions([]);
    editor.clear();
    baseline = draftKey(currentDraft());
    templateSelect.replaceChildren(el('option', undefined, 'Loading templates…'));
    tplNote.textContent = '';
    tplWarnings.hidden = true;
    updateDirty();

    const [f, p, u, t] = await Promise.allSettled([getFields(site), getProjects(site), getUsers(site), getTemplates(site)]);
    if (seq !== loadSeq) return; // site switched meanwhile
    const problems: string[] = [];
    if (p.status === 'fulfilled') {
      projectNames = new Map(p.value.map((x) => [x.key, x.name]));
      projectPicker.setOptions(p.value.map((x) => ({ value: x.key, name: `${x.key}\n${x.name}`, label: `${x.key} — ${x.name}` })));
    } else {
      problems.push(errText(p.reason));
    }
    if (u.status === 'fulfilled') {
      // Active users only; names of all users are kept for chips and headers.
      userOptions = u.value.filter((x) => x.active).map((x) => ({ value: x.accountId, name: x.displayName, label: x.displayName }));
      userNames = new Map(u.value.map((x) => [x.accountId, x.displayName]));
      userPicker.setOptions(userOptions);
    } else {
      problems.push(errText(u.reason));
    }
    if (f.status === 'fulfilled') {
      fields = f.value;
    } else {
      problems.push(errText(f.reason));
    }
    if (t.status === 'fulfilled') {
      templates = t.value.templates.filter((x) => !x.builtIn);
      problems.push(...t.value.warnings);
    } else {
      problems.push(`Could not load the templates: ${errText(t.reason)}`);
    }
    if (fields.length) {
      openTemplate(templates.find((x) => x.id === initialTemplateId(templates)));
    } else {
      renderTemplateSelect();
      updateDirty();
    }
    showMsg(
      metaError,
      problems.length
        ? `${problems.join(' ')}${fields.length ? '' : ' — the Custom Report needs the field list; reload the page to try again.'}`
        : undefined,
    );
  }

  // ---- run ----

  /** Shows the loading state; returns `stop` (with `setStage` for the steps after the report). */
  function startLoading(requestId: string): (() => void) & { setStage: (text: string) => void } {
    busy = true;
    loading.hidden = false;
    retryBtn.disabled = true;
    cancelBtn.disabled = false;
    editor.setDisabled(true);
    updateButtons();
    setSiteLock(deps.siteSelect, 'advance', true);

    const started = Date.now();
    let stage: string | undefined;
    loadingBar.hidden = true;
    const render = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      loadingText.textContent = stage ? `${stage} · ${secs}s` : `Generating report… ${secs}s`;
    };
    render();
    const timer = window.setInterval(render, 1000);
    const stopProgress = watchProgress(
      requestId,
      (e) => {
        stage = progressText(e) ?? stage;
        if (e.stage === 'worklogs' && e.total) {
          loadingBar.hidden = false;
          loadingBar.max = e.total;
          loadingBar.value = e.done ?? 0;
        } else if (e.stage !== 'worklogs') {
          loadingBar.hidden = true;
        }
        render();
      },
      () => {
        stage = undefined;
        loadingBar.hidden = true;
        render();
      },
      '/api/custom-report',
    );
    const setStage = (text: string) => {
      stage = text;
      loadingBar.hidden = true;
      cancelBtn.disabled = true; // the report is done; building the file is quick
      render();
    };

    const stop = () => {
      window.clearInterval(timer);
      stopProgress();
      busy = false;
      loading.hidden = true;
      retryBtn.disabled = false;
      editor.setDisabled(false);
      updateButtons();
      setSiteLock(deps.siteSelect, 'advance', false);
    };
    return Object.assign(stop, { setStage });
  }

  /** Display names for the .xlsx header block: only the selected projects / users are needed. */
  function exportLabels(r: CustomReport) {
    const pick = (keys: readonly string[], names: Map<string, string>) =>
      Object.fromEntries(keys.flatMap((k) => (names.has(k) ? [[k, names.get(k)!]] : [])));
    return { projects: pick(r.filter.projects, projectNames), users: pick(r.filter.authors, userNames) };
  }

  async function run(body: CustomReportRequest, labels: string): Promise<void> {
    if (busy) return;
    showMsg(formError, undefined);
    showMsg(formInfo, undefined);
    const id = newRequestId();
    const controller = new AbortController();
    inFlight = { id, controller };
    const stop = startLoading(id);
    try {
      const r = await postCustomReport({ ...body, requestId: id }, controller.signal);
      lastRun = { body, labels };
      show(r, labels);
      // Same result, as one .xlsx (built from the result on the server, no Jira calls).
      stop.setStage('Building the .xlsx…');
      downloadStatus.textContent = 'Building the .xlsx…';
      try {
        const file = await postCustomExport(r, exportLabels(r));
        download(file.blob, file.filename);
        downloadStatus.textContent = `Downloaded ${file.filename}`;
      } catch (err) {
        downloadStatus.textContent = '';
        showMsg(formError, `${errText(err)} The preview below is complete.`);
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        showMsg(formInfo, report ? 'Report cancelled. The previous result is still shown below.' : 'Report cancelled.');
      } else {
        showMsg(formError, errText(err));
      }
    } finally {
      inFlight = undefined;
      stop();
    }
  }

  cancelBtn.addEventListener('click', () => {
    if (!inFlight) return;
    cancelBtn.disabled = true;
    loadingText.textContent = 'Cancelling…';
    cancelReport(inFlight.id, '/api/custom-report');
    inFlight.controller.abort();
  });

  retryBtn.addEventListener('click', () => {
    if (lastRun) void run(lastRun.body, lastRun.labels);
  });

  function describe(f: { projects: string[]; authors: string[] }, templateName: string): string {
    const projects = f.projects.length ? (f.projects.length <= 3 ? f.projects.join(', ') : `${f.projects.length} projects`) : 'All projects';
    const names = f.authors.map((a) => userNames.get(a) ?? a);
    const users = names.length ? (names.length <= 3 ? names.join(', ') : `${names.length} users`) : 'All users';
    return `${projects} · ${users} · ${templateName}${isDirty() ? ' (unsaved changes)' : ''}`;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || fields.length === 0) return;
    const filter = { site: deps.site(), from: fromInput.value, to: toInput.value, projects: projectPicker.values, authors: userPicker.values };
    const draft = currentDraft();
    const built = buildGenerateBody(filter, { ...draft, name: current?.name ?? 'Report' }, fields, deps.maxRangeDays());
    if (built.error !== undefined) return showMsg(formError, built.error);
    void run(built.body, describe(filter, current?.name ?? 'New template'));
  });

  // ---- results ----

  function clearResult(): void {
    report = undefined;
    lastRun = undefined;
    preview.clear();
    result.hidden = true;
    incomplete.hidden = true;
    warnings.hidden = true;
    emptyHint.hidden = false;
    downloadStatus.textContent = '';
    if (drill.open) drill.close();
  }

  function show(r: CustomReport, labels: string): void {
    if (drill.open) drill.close();
    report = r;
    summary.textContent = `${r.from} → ${r.to} · ${labels} · ${r.sheets.length} sheet(s)`;
    retrieved.textContent = `Retrieved: ${formatRetrieved(r.retrievedAt)}`;
    downloadStatus.textContent = '';
    incomplete.hidden = r.complete;
    failedKeys.textContent = r.failedIssueKeys.join(', ');
    failureReasons.textContent = r.failureReasons?.length ? `Why: ${r.failureReasons.join('; ')}. Retry may help.` : '';
    warningList.replaceChildren(...r.warnings.map((w) => el('li', undefined, w)));
    warnings.hidden = r.warnings.length === 0;
    result.hidden = false;
    emptyHint.hidden = true;
    preview.show(r, exportLabels(r));
  }

  // ---- defaults ----
  const today = new Date();
  fromInput.value = localIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  toInput.value = localIsoDate(today);
  updateButtons();

  return {
    shown() {
      visible = true;
      if (loadedFor === null) void loadLists();
    },
    hidden() {
      visible = false;
    },
    siteChanged() {
      clearResult();
      showMsg(formError, undefined);
      showMsg(formInfo, undefined);
      loadedFor = null;
      loadSeq++; // drop answers for the old site
      if (visible) void loadLists();
    },
  };
}
