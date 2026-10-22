// Team Reports (All Sites) tab: the Team Reports page reading every selected Jira site; each site answers its own report and
// ./merge.ts joins them (the same person on two sites is one row; "Site" is an extra Group By choice).
// Copied from ../team/tab.ts, whose rules (./logic.ts) and table (./render.ts) it shares. Team Reports page: Left panel = filters; top bar = Group By (any number), Period
// Grouping, Time Format, Time Zone, Export; the table is the one group sheet of POST /api/custom-report.
// Pure rules are in ./logic.ts, the table DOM in ./render.ts.
import {
  cancelReport,
  CancelledError,
  getFields,
  getGroupMembers,
  getGroups,
  getMe,
  getProjects,
  getUsers,
  postCustomReport,
  postTeamExport,
  type CustomReport,
  type FieldInfo,
  type SiteInfo,
} from '../api.js';
import { setupFavourites } from '../favourites.js';
import { CUSTOM_PRESET, DEFAULT_PRESET, GROUP_PRESETS, mergeReports, presetFor, SITE_FIELD, type SiteFailure, type SiteNode, type SitePart } from './merge.js';
import { MultiSelect } from '../multiselect.js';
import type { MultiOption } from '../multiselect-logic.js';
import { formatRetrieved } from '../render.js';
import {
  buildPivot,
  buildTeamRequest,
  groupChoices,
  groupValue,
  mergeAuthors,
  PERIOD_OPTIONS,
  pivotGrid,
  splitPeople,
  teamQueryProblem,
  TIME_FORMAT_OPTIONS,
  userValue,
  ZONE_OPTIONS,
  type GroupChoice,
  type Pivot,
  type TeamPeriod,
  type TimeFormat,
  type ZoneChoice,
} from '../team/logic.js';
import { renderPivot } from '../team/render.js';

export interface TeamAllDeps {
  /** The Jira sites this user can open (first = default). */
  sites: () => SiteInfo[];
  /** Jira base URL of a site (issue links). */
  siteUrl: (key: string | undefined) => string | undefined;
  maxRangeDays: () => number;
  /** The signed-in user's Jira account id (undefined for a sign-in saved before it was kept). */
  accountId: () => string | undefined;
  /** Keeps the account id found by GET /api/me with the stored sign-in. */
  rememberAccountId: (accountId: string) => void;
}

export interface TeamAllTab {
  /** Called when the tab becomes visible: loads fields/projects/users/groups of every site the first time. */
  shown(): void;
  hidden(): void;
}

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

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

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

function fillSelect<T extends string>(select: HTMLSelectElement, options: ReadonlyArray<{ value: T; label: string }>, value: T): void {
  select.replaceChildren(
    ...options.map((o) => {
      const opt = el('option', undefined, o.label);
      opt.value = o.value;
      return opt;
    }),
  );
  select.value = value;
}

export function setupTeamAll(deps: TeamAllDeps): TeamAllTab {
  const root = $<HTMLElement>('tab-teamall');
  const form = $<HTMLFormElement>('ta-form');
  const fromInput = $<HTMLInputElement>('ta-from');
  const toInput = $<HTMLInputElement>('ta-to');
  const jqlInput = $<HTMLTextAreaElement>('ta-jql');
  const extraJqlInput = $<HTMLTextAreaElement>('ta-extra-jql');
  const generateBtn = $<HTMLButtonElement>('ta-generate');
  const panelToggle = $<HTMLButtonElement>('ta-panel-toggle');
  const presetSelect = $<HTMLSelectElement>('ta-preset');
  const periodSelect = $<HTMLSelectElement>('ta-period');
  const formatSelect = $<HTMLSelectElement>('ta-format');
  const zoneSelect = $<HTMLSelectElement>('ta-zone');
  const exportBtn = $<HTMLButtonElement>('ta-export');
  const exportMenu = $<HTMLDivElement>('ta-export-menu');
  const exportExcelBtn = $<HTMLButtonElement>('ta-export-excel');
  const metaError = $<HTMLParagraphElement>('ta-meta-error');
  const formError = $<HTMLParagraphElement>('ta-error');
  const formInfo = $<HTMLParagraphElement>('ta-info');
  const loading = $<HTMLDivElement>('ta-loading');
  const loadingText = $<HTMLSpanElement>('ta-loading-text');
  const loadingBar = $<HTMLProgressElement>('ta-loading-bar');
  const cancelBtn = $<HTMLButtonElement>('ta-cancel');
  const incomplete = $<HTMLElement>('ta-incomplete');
  const failedKeys = $<HTMLElement>('ta-failed-keys');
  const failureReasons = $<HTMLElement>('ta-failure-reasons');
  const retryBtn = $<HTMLButtonElement>('ta-retry');
  const warnings = $<HTMLElement>('ta-warnings');
  const warningList = $<HTMLUListElement>('ta-warning-list');
  const result = $<HTMLElement>('ta-result');
  const retrieved = $<HTMLSpanElement>('ta-retrieved');
  const table = $<HTMLTableElement>('ta-table');
  const emptyHint = $<HTMLParagraphElement>('ta-empty-hint');

  // ---- state ----
  let choices: GroupChoice[] = [];
  let userAvatars = new Map<string, string>();
  /** accountId → display name (Favourite groups keep the names with their members). */
  let userNames = new Map<string, string>();
  let loadedFor = '';
  let loadSeq = 0;
  let busy = false;
  let exporting = false;
  let inFlight: { ids: string[]; controller: AbortController } | undefined;
  /** The result on screen, with the period it was built for (the period select may have moved on). */
  let current: { report: CustomReport; period: TeamPeriod; pivot: Pivot } | undefined;
  let autoTimer: number | undefined;

  const sitePicker = new MultiSelect($<HTMLDivElement>('ta-sites'), {
    max: 50,
    noun: 'sites',
    emptyText: 'None selected = all sites',
    placeholder: 'All sites',
    labelledBy: 'ta-sites-label',
    tools: false,
  });
  const groupPicker = new MultiSelect($<HTMLDivElement>('ta-groupby'), {
    // Optional and unlimited (Jira stops at 3): none = one Total column; the order picked is the order of the levels.
    max: Number.MAX_SAFE_INTEGER,
    noun: 'grouping items',
    emptyText: 'Optional: pick fields to group the rows by',
    placeholder: 'Group By',
    labelledBy: 'ta-groupby-label',
    tools: false,
    onChange: () => {
      syncPreset();
      queueRefresh();
    },
  });
  const projectPicker = new MultiSelect($<HTMLDivElement>('ta-projects'), {
    max: 50,
    noun: 'projects',
    emptyText: 'None selected = all projects',
    placeholder: 'All projects — type to search',
    labelledBy: 'ta-projects-label',
    tools: false,
    onChange: () => onPeopleChanged(), // Save Favourite is enabled by projects / JQL too
  });
  const peoplePicker = new MultiSelect($<HTMLDivElement>('ta-people'), {
    max: 100,
    noun: 'users or groups',
    emptyText: 'None selected = all users',
    placeholder: 'All users — type to find users or groups',
    labelledBy: 'ta-people-label',
    tools: false,
    onChange: () => onPeopleChanged(),
  });

  // Favourite groups hold users only: this view of the people picker is its users (groups are left out of Save,
  // and a favourite replaces the whole selection, like in the Team Matrix tab).
  const onPeopleChanged = setupFavourites({
    picker: {
      get values() {
        return splitPeople(peoplePicker.values).users;
      },
      setValues: (accountIds) => peoplePicker.setValues(accountIds.map(userValue)),
    },
    // A Team Reports favourite also keeps the projects, JQL Issue Filter and Extra JQL (and may have no users at all).
    filters: {
      read: () => ({
        projects: projectPicker.values,
        jql: jqlInput.value.trim(),
        extraJql: extraJqlInput.value.trim(),
        view: { groupBy: groupPicker.values, period: periodSelect.value, format: formatSelect.value, zone: zoneSelect.value },
      }),
      apply: (f) => {
        projectPicker.setValues(f.projects);
        jqlInput.value = f.jql;
        extraJqlInput.value = f.extraJql;
        if (f.view) {
          const has = (s: HTMLSelectElement, v: string) => [...s.options].some((o) => o.value === v);
          if (has(periodSelect, f.view.period)) periodSelect.value = f.view.period;
          if (has(formatSelect, f.view.format)) formatSelect.value = f.view.format;
          if (has(zoneSelect, f.view.zone)) {
            zoneSelect.value = f.view.zone;
            zoneSelect.title = ZONE_OPTIONS.find((z) => z.value === zoneSelect.value)?.hint ?? '';
          }
          groupPicker.setValues(f.view.groupBy);
          syncPreset();
          paint();
          queueRefresh();
        }
        onPeopleChanged();
        const gone = f.projects.filter((p) => !projectPicker.values.includes(p));
        return gone.length ? `${gone.length} project(s) not found: ${gone.join(', ')}` : undefined;
      },
    },
    max: 100,
    // Its own list of favourites (projects are saved as "site|KEY"): not the per-site ones of the Team Reports tab.
    scope: () => ({ site: 'all-sites', legacySite: 'all-sites' }),
    users: () => userNames,
    saveBtn: $<HTMLButtonElement>('ta-fav-save'),
    listBtn: $<HTMLButtonElement>('ta-fav-list'),
    dialog: $<HTMLDialogElement>('ta-fav'),
    table: $<HTMLTableElement>('ta-fav-table'),
    closeBtn: $<HTMLButtonElement>('ta-fav-close'),
    notice: $<HTMLParagraphElement>('ta-fav-notice'),
  });

  fillSelect(periodSelect, PERIOD_OPTIONS, 'day');
  fillSelect(formatSelect, TIME_FORMAT_OPTIONS, 'hours');
  // Jira's own "Current User" is the logged-in user's profile zone; this app has no login, so the default is each
// worklog author's profile zone, which gives the same days as Jira for a person's own time.
fillSelect(zoneSelect, ZONE_OPTIONS, 'author');
  zoneSelect.title = ZONE_OPTIONS.find((z) => z.value === zoneSelect.value)?.hint ?? '';

  // ---- helpers ----

  const period = () => periodSelect.value as TeamPeriod;
  const format = () => formatSelect.value as TimeFormat;

  // The Group by drop-down: ready-made choices (the All Sites tab's modes and the Site ones); "Custom" = what the field picker holds.
  presetSelect.replaceChildren(
    ...[...GROUP_PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: CUSTOM_PRESET, label: 'Custom' }].map((p) => {
      const o = el('option', undefined, p.label);
      o.value = p.id;
      return o;
    }),
  );
  presetSelect.value = DEFAULT_PRESET;

  /** Shows the preset that matches the field picker (or Custom). */
  function syncPreset(): void {
    presetSelect.value = presetFor(groupPicker.values);
  }

  presetSelect.addEventListener('change', () => {
    const preset = GROUP_PRESETS.find((p) => p.id === presetSelect.value);
    if (!preset) return; // "Custom" only says the picker below decides
    groupPicker.setValues(preset.groupBy.filter((id) => choices.some((c) => c.fieldId === id)));
    syncPreset();
    queueRefresh();
  });

  function selectedGroups(): GroupChoice[] {
    const byId = new Map(choices.map((c) => [c.fieldId, c]));
    return groupPicker.values.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  function updateButtons(): void {
    generateBtn.disabled = busy || choices.length === 0;
    exportBtn.disabled = !current || busy || exporting;
    exportExcelBtn.disabled = !current || busy || exporting;
    retryBtn.disabled = busy;
  }

  // ---- lists per site ----

  async function loadLists(): Promise<void> {
    const seq = ++loadSeq;
    const sites = deps.sites();
    loadedFor = sites.map((s) => s.key).join(',');
    showMsg(metaError, undefined);
    choices = [];
    userAvatars = new Map();
    userNames = new Map();
    groupPicker.setValues([]);
    groupPicker.setOptions([]);
    projectPicker.setValues([]);
    projectPicker.setOptions([]);
    peoplePicker.setValues([]);
    peoplePicker.setOptions([]);
    sitePicker.setValues([]);
    sitePicker.setOptions(sites.map((s): MultiOption => ({ value: s.key, name: s.key, label: s.url.replace(/^https:\/\//, '') })));
    updateButtons();

    const [answers, me] = await Promise.all([
      Promise.all(
        sites.map(async (s) => {
          const [f, p, u, g] = await Promise.allSettled([getFields(s.key), getProjects(s.key), getUsers(s.key), getGroups(s.key)]);
          return { site: s.key, f, p, u, g };
        }),
      ),
      deps.accountId() ? Promise.resolve(undefined) : getMe().catch(() => undefined),
    ]);
    if (seq !== loadSeq) return; // the list of sites changed meanwhile
    const problems: string[] = [];
    const fieldLists: FieldInfo[][] = [];
    const projects: MultiOption[] = [];
    const people = new Map<string, MultiOption>();
    const groups: MultiOption[] = [];
    for (const a of answers) {
      if (a.f.status === 'fulfilled') fieldLists.push(a.f.value);
      else problems.push(`${a.site}: ${errText(a.f.reason)}`);
      if (a.p.status === 'fulfilled') {
        for (const x of a.p.value) projects.push({ value: `${a.site}|${x.key}`, name: `${x.key}\n${x.name}\n${a.site}`, label: `${x.key} — ${x.name} (${a.site})` });
      } else {
        problems.push(`${a.site}: ${errText(a.p.reason)}`);
      }
      if (a.u.status === 'fulfilled') {
        for (const x of a.u.value) {
          if (x.avatarUrl && !userAvatars.has(x.accountId)) userAvatars.set(x.accountId, x.avatarUrl);
          if (!userNames.has(x.accountId)) userNames.set(x.accountId, x.displayName);
          if (x.active && !people.has(x.accountId)) people.set(x.accountId, { value: userValue(x.accountId), name: x.displayName, label: x.displayName });
        }
      } else {
        problems.push(`${a.site}: ${errText(a.u.reason)}`);
      }
      // A group belongs to one site: its members are looked up there, then count on every site.
      if (a.g.status === 'fulfilled') {
        for (const x of a.g.value) groups.push({ value: groupValue(`${a.site}|${x.groupId}`), name: x.name, label: `${x.name} (group, ${a.site})` });
      } else {
        problems.push(`${a.site}: groups are not available (${errText(a.g.reason)})`);
      }
    }
    // Group By offers the fields every site has (custom field ids differ between sites), plus "Site".
    if (fieldLists.length) applyFields(fieldLists[0]!.filter((x) => fieldLists.every((l) => l.some((y) => y.id === x.id))));
    projectPicker.setOptions(projects);
    const everyone = [...people.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
    peoplePicker.setOptions([...everyone, ...groups]);
    // Like Jira's "Current User": the signed-in user is selected to start with (remove the chip for everyone).
    if (me) deps.rememberAccountId(me.accountId);
    const mine = deps.accountId();
    if (mine && people.has(mine)) peoplePicker.setValues([userValue(mine)]);
    onPeopleChanged();
    showMsg(metaError, problems.length ? `${problems.join(' · ')}${choices.length ? '' : ' — the field list is needed; reload the page to try again.'}` : undefined);
    updateButtons();
  }

  function applyFields(fields: FieldInfo[]): void {
    choices = [{ fieldId: SITE_FIELD, name: 'Site', section: 'Issue' }, ...groupChoices(fields)];
    groupPicker.setOptions(choices.map((c) => ({ value: c.fieldId, name: c.name, label: c.name })));
    // Like the All Sites tab: grouped by user, then project, until the user picks something else.
    const start = GROUP_PRESETS.find((p) => p.id === DEFAULT_PRESET)!;
    groupPicker.setValues(start.groupBy.filter((id) => choices.some((c) => c.fieldId === id)));
    syncPreset();
  }

  // ---- run ----

  function startLoading(): { stop: () => void; setStage: (text: string) => void } {
    busy = true;
    loading.hidden = false;
    loadingBar.hidden = true;
    cancelBtn.disabled = false;
    updateButtons();

    const started = Date.now();
    let stage: string | undefined;
    const render = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      loadingText.textContent = stage ? `${stage} · ${secs}s` : `Generating report… ${secs}s`;
    };
    render();
    const timer = window.setInterval(render, 1000);
    return {
      setStage(text) {
        stage = text;
        render();
      },
      stop() {
        window.clearInterval(timer);
        busy = false;
        loading.hidden = true;
        updateButtons();
      },
    };
  }

  /** Generate Report (and every automatic refresh): reads the form, expands groups, asks every chosen site, merges, shows the table. */
  async function generate(): Promise<void> {
    if (busy) return;
    window.clearTimeout(autoTimer);
    showMsg(formError, undefined);
    showMsg(formInfo, undefined);
    const groupBy = selectedGroups();
    const query = { from: fromInput.value, to: toInput.value, groupBy };
    const problem = teamQueryProblem(query, deps.maxRangeDays());
    if (problem) return showMsg(formError, problem);

    const controller = new AbortController();
    inFlight = { ids: [], controller };
    const loadingState = startLoading();
    try {
      const chosen = new Set(sitePicker.values);
      const sites = deps.sites().filter((s) => chosen.size === 0 || chosen.has(s.key));
      if (sites.length === 0) throw new Error('No Jira site to read.');
      const { users, groups } = splitPeople(peoplePicker.values);
      let authors = users;
      if (groups.length) {
        loadingState.setStage(groups.length === 1 ? 'Loading the group’s members…' : `Loading members of ${groups.length} groups…`);
        const lists = await Promise.all(
          groups.map((g) => {
            const cut = g.indexOf('|');
            return getGroupMembers(g.slice(cut + 1), g.slice(0, cut));
          }),
        );
        if (controller.signal.aborted) throw new CancelledError();
        authors = mergeAuthors(users, lists.map((l) => l.map((m) => m.accountId)));
        if (authors.length === 0) throw new Error('The selected user(s) and group(s) have no members to report on.');
      }

      // "Site" is added to the table here; the sites themselves are asked for the other levels.
      const serverGroups = groupBy.filter((g) => g.fieldId !== SITE_FIELD);
      const projectIds = projectPicker.values;
      const askedSites = sites.filter((s) => projectIds.length === 0 || projectIds.some((p) => p.startsWith(`${s.key}|`)));
      if (askedSites.length === 0) throw new Error('None of the chosen projects belongs to the chosen sites.');
      let done = 0;
      loadingState.setStage(`Reading ${askedSites.length} site${askedSites.length === 1 ? '' : 's'}…`);
      const answers = await Promise.all(
        askedSites.map(async (s): Promise<{ part: SitePart } | { failure: SiteFailure }> => {
          const id = newRequestId();
          inFlight?.ids.push(id);
          try {
            const body = buildTeamRequest({
              site: s.key,
              from: query.from,
              to: query.to,
              projects: projectIds.filter((p) => p.startsWith(`${s.key}|`)).map((p) => p.slice(s.key.length + 1)),
              authors,
              groupBy: serverGroups,
              period: period(),
              zone: zoneSelect.value as ZoneChoice,
              browserZone: browserZone(),
              jql: jqlInput.value,
              extraJql: extraJqlInput.value,
            });
            const report = await postCustomReport({ ...body, requestId: id }, controller.signal);
            return { part: { site: s.key, report } };
          } catch (err) {
            if (err instanceof CancelledError || controller.signal.aborted) throw err;
            return { failure: { site: s.key, error: errText(err) } };
          } finally {
            loadingState.setStage(`Read ${++done} of ${askedSites.length} site${askedSites.length === 1 ? '' : 's'}…`);
          }
        }),
      );
      const parts = answers.flatMap((a) => ('part' in a ? [a.part] : []));
      const failures = answers.flatMap((a) => ('failure' in a ? [a.failure] : []));
      if (parts.length === 0) throw new Error(failures.map((f) => `${f.site}: ${f.error}`).join(' · '));
      // `site` is only there to satisfy the report type: links and the file name do not use it for a merged report.
      show({ ...mergeReports(parts, groupBy.map((g) => g.fieldId), failures), site: parts[0]!.site }, period());
    } catch (err) {
      if (err instanceof CancelledError || controller.signal.aborted) showMsg(formInfo, current ? 'Report cancelled. The previous report is still shown.' : 'Report cancelled.');
      else showMsg(formError, errText(err));
    } finally {
      inFlight = undefined;
      loadingState.stop();
    }
  }

  cancelBtn.addEventListener('click', () => {
    if (!inFlight) return;
    cancelBtn.disabled = true;
    loadingText.textContent = 'Cancelling…';
    for (const id of inFlight.ids) cancelReport(id, '/api/custom-report');
    inFlight.controller.abort();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void generate();
  });
  retryBtn.addEventListener('click', () => void generate());

  /** Group By / Period / Time Zone change the numbers: like Jira, the report refreshes by itself once one is on screen. */
  function queueRefresh(): void {
    if (!current || busy) return;
    window.clearTimeout(autoTimer);
    autoTimer = window.setTimeout(() => void generate(), 400);
  }

  periodSelect.addEventListener('change', queueRefresh);
  zoneSelect.addEventListener('change', () => {
    zoneSelect.title = ZONE_OPTIONS.find((z) => z.value === zoneSelect.value)?.hint ?? '';
    queueRefresh();
  });
  // Typing in a JQL box can make "Save Favourite" available.
  jqlInput.addEventListener('input', () => onPeopleChanged());
  extraJqlInput.addEventListener('input', () => onPeopleChanged());
  // Time Format only changes how the same seconds are written: no new request.
  formatSelect.addEventListener('change', () => paint());

  // ---- results ----

  function paint(): void {
    if (!current) return;
    const { report, pivot } = current;
    const issueTypes = new Map(report.issues.map((i) => [i.key, i.type]));
    renderPivot(table, pivot, {
      format: format(),
      hoursPerDay: report.hoursPerDay,
      siteUrlFor: (node) => deps.siteUrl((node as SiteNode).site),
      avatars: userAvatars,
      issueTypes,
    });
  }

  function show(report: CustomReport, forPeriod: TeamPeriod): void {
    const sheet = report.sheets[0];
    if (!sheet || sheet.mode !== 'group') throw new Error('The server answered with an unexpected report shape.');
    current = { report, period: forPeriod, pivot: buildPivot(sheet, forPeriod) };
    paint();
    retrieved.textContent = `Retrieved: ${formatRetrieved(report.retrievedAt)}`;
    incomplete.hidden = report.complete;
    failedKeys.textContent = report.failedIssueKeys.join(', ');
    failureReasons.textContent = report.failureReasons?.length ? `Why: ${report.failureReasons.join('; ')}. Retry may help.` : '';
    warningList.replaceChildren(...report.warnings.map((w) => el('li', undefined, w)));
    warnings.hidden = report.warnings.length === 0;
    result.hidden = false;
    emptyHint.hidden = true;
    updateButtons();
  }

  // ---- export ----

  function closeExportMenu(): void {
    exportMenu.hidden = true;
    exportBtn.setAttribute('aria-expanded', 'false');
  }

  exportBtn.addEventListener('click', () => {
    const open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!exportMenu.hidden && !(e.target as HTMLElement).closest('.tr-export')) closeExportMenu();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !exportMenu.hidden) {
      closeExportMenu();
      exportBtn.focus();
    }
  });

  exportExcelBtn.addEventListener('click', async () => {
    const s = current;
    if (!s || busy || exporting) return;
    closeExportMenu();
    exporting = true;
    updateButtons();
    showMsg(formError, undefined);
    try {
      const grid = pivotGrid(s.pivot, format(), s.report.hoursPerDay);
      const file = await postTeamExport({ fileSite: 'all-sites', from: s.report.from, to: s.report.to, complete: s.report.complete, grid });
      download(file.blob, file.filename);
    } catch (err) {
      showMsg(formError, errText(err));
    } finally {
      exporting = false;
      updateButtons();
    }
  });

  // ---- left panel ----

  panelToggle.addEventListener('click', () => {
    const collapsed = root.classList.toggle('tr-collapsed');
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
    panelToggle.title = collapsed ? 'Show filters' : 'Hide filters';
  });

  // ---- defaults ----
  const today = localIsoDate(new Date());
  fromInput.value = today;
  toInput.value = today;
  updateButtons();

  return {
    shown() {
      const key = deps.sites().map((s) => s.key).join(',');
      if (key && key !== loadedFor) void loadLists();
    },
    hidden() {
    },
  };
}
