// Team Reports tab: a look-alike of Jira's "Team Reports" page. Left panel = filters; top bar = Group By (any number), Period
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
  watchProgress,
  type CustomReport,
  type FieldInfo,
  type ProgressEvent,
} from '../api.js';
import { setupFavourites } from '../favourites.js';
import type { SiteScope } from '../favourites-logic.js';
import { MultiSelect } from '../multiselect.js';
import type { MultiOption } from '../multiselect-logic.js';
import { formatRetrieved } from '../render.js';
import { setSiteLock } from '../site-lock.js';
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
} from './logic.js';
import { renderPivot } from './render.js';

export interface TeamTabDeps {
  siteSelect: HTMLSelectElement;
  /** Selected site key; undefined = the server's default. */
  site: () => string | undefined;
  /** Jira base URL of a site (issue links). */
  siteUrl: (key: string | undefined) => string | undefined;
  maxRangeDays: () => number;
  /** The signed-in user's Jira account id (undefined for a sign-in saved before it was kept). */
  accountId: () => string | undefined;
  /** Keeps the account id found by GET /api/me with the stored sign-in. */
  rememberAccountId: (accountId: string) => void;
  /** Where favourite groups of the current site are kept (see web/favourites.ts); undefined while the site list is not loaded. */
  favouriteScope: () => SiteScope | undefined;
}

export interface TeamTab {
  /** Called when the tab becomes visible: loads fields/projects/users/groups for the site the first time. */
  shown(): void;
  hidden(): void;
  /** Site switched: clears the result and the selections, reloads the lists (now, or when next shown). */
  siteChanged(): void;
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

function progressText(e: ProgressEvent): string | undefined {
  switch (e.stage) {
    case 'validating':
      return 'Checking projects and JQL…';
    case 'searching':
      return e.issues === undefined ? 'Searching Jira for issues with worklogs…' : `Found ${e.issues} issue(s) with worklogs…`;
    case 'worklogs':
      return e.total === undefined ? 'Fetching worklogs…' : `Fetching worklogs: ${e.done ?? 0} / ${e.total} issue(s)`;
    case 'processing':
      return 'Building the report…';
    default:
      return undefined;
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

export function setupTeamReports(deps: TeamTabDeps): TeamTab {
  const root = $<HTMLElement>('tab-team');
  const form = $<HTMLFormElement>('tr-form');
  const fromInput = $<HTMLInputElement>('tr-from');
  const toInput = $<HTMLInputElement>('tr-to');
  const jqlInput = $<HTMLTextAreaElement>('tr-jql');
  const extraJqlInput = $<HTMLTextAreaElement>('tr-extra-jql');
  const generateBtn = $<HTMLButtonElement>('tr-generate');
  const panelToggle = $<HTMLButtonElement>('tr-panel-toggle');
  const periodSelect = $<HTMLSelectElement>('tr-period');
  const formatSelect = $<HTMLSelectElement>('tr-format');
  const zoneSelect = $<HTMLSelectElement>('tr-zone');
  const exportBtn = $<HTMLButtonElement>('tr-export');
  const exportMenu = $<HTMLDivElement>('tr-export-menu');
  const exportExcelBtn = $<HTMLButtonElement>('tr-export-excel');
  const metaError = $<HTMLParagraphElement>('tr-meta-error');
  const formError = $<HTMLParagraphElement>('tr-error');
  const formInfo = $<HTMLParagraphElement>('tr-info');
  const loading = $<HTMLDivElement>('tr-loading');
  const loadingText = $<HTMLSpanElement>('tr-loading-text');
  const loadingBar = $<HTMLProgressElement>('tr-loading-bar');
  const cancelBtn = $<HTMLButtonElement>('tr-cancel');
  const incomplete = $<HTMLElement>('tr-incomplete');
  const failedKeys = $<HTMLElement>('tr-failed-keys');
  const failureReasons = $<HTMLElement>('tr-failure-reasons');
  const retryBtn = $<HTMLButtonElement>('tr-retry');
  const warnings = $<HTMLElement>('tr-warnings');
  const warningList = $<HTMLUListElement>('tr-warning-list');
  const result = $<HTMLElement>('tr-result');
  const retrieved = $<HTMLSpanElement>('tr-retrieved');
  const table = $<HTMLTableElement>('tr-table');
  const emptyHint = $<HTMLParagraphElement>('tr-empty-hint');

  // ---- state ----
  let choices: GroupChoice[] = [];
  let userAvatars = new Map<string, string>();
  /** accountId → display name (Favourite groups keep the names with their members). */
  let userNames = new Map<string, string>();
  let loadedFor: string | null = null;
  let visible = false;
  let loadSeq = 0;
  let busy = false;
  let exporting = false;
  let inFlight: { id: string; controller: AbortController } | undefined;
  /** The result on screen, with the period it was built for (the period select may have moved on). */
  let current: { report: CustomReport; period: TeamPeriod; pivot: Pivot } | undefined;
  let autoTimer: number | undefined;

  const groupPicker = new MultiSelect($<HTMLDivElement>('tr-groupby'), {
    // Optional and unlimited (Jira stops at 3): none = one Total column; the order picked is the order of the levels.
    max: Number.MAX_SAFE_INTEGER,
    noun: 'grouping items',
    emptyText: 'Optional: pick fields to group the rows by',
    placeholder: 'Group By',
    labelledBy: 'tr-groupby-label',
    tools: false,
    onChange: () => queueRefresh(),
  });
  const projectPicker = new MultiSelect($<HTMLDivElement>('tr-projects'), {
    max: 50,
    noun: 'projects',
    emptyText: 'None selected = all projects',
    placeholder: 'All projects — type to search',
    labelledBy: 'tr-projects-label',
    tools: false,
    onChange: () => onPeopleChanged(), // Save Favourite is enabled by projects / JQL too
  });
  const peoplePicker = new MultiSelect($<HTMLDivElement>('tr-people'), {
    max: 100,
    noun: 'users or groups',
    emptyText: 'None selected = all users',
    placeholder: 'All users — type to find users or groups',
    labelledBy: 'tr-people-label',
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
          paint();
          queueRefresh();
        }
        onPeopleChanged();
        const gone = f.projects.filter((p) => !projectPicker.values.includes(p));
        return gone.length ? `${gone.length} project(s) not found: ${gone.join(', ')}` : undefined;
      },
    },
    max: 100,
    scope: () => deps.favouriteScope(),
    users: () => userNames,
    saveBtn: $<HTMLButtonElement>('tr-fav-save'),
    listBtn: $<HTMLButtonElement>('tr-fav-list'),
    dialog: $<HTMLDialogElement>('tr-fav'),
    table: $<HTMLTableElement>('tr-fav-table'),
    closeBtn: $<HTMLButtonElement>('tr-fav-close'),
    notice: $<HTMLParagraphElement>('tr-fav-notice'),
  });
  const favDialog = $<HTMLDialogElement>('tr-fav');
  const favNotice = $<HTMLParagraphElement>('tr-fav-notice');

  fillSelect(periodSelect, PERIOD_OPTIONS, 'day');
  fillSelect(formatSelect, TIME_FORMAT_OPTIONS, 'hours');
  // Jira's own "Current User" is the logged-in user's profile zone; this app has no login, so the default is each
// worklog author's profile zone, which gives the same days as Jira for a person's own time.
fillSelect(zoneSelect, ZONE_OPTIONS, 'author');
  zoneSelect.title = ZONE_OPTIONS.find((z) => z.value === zoneSelect.value)?.hint ?? '';

  // ---- helpers ----

  const period = () => periodSelect.value as TeamPeriod;
  const format = () => formatSelect.value as TimeFormat;

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
    const site = deps.site();
    loadedFor = site ?? '';
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
    updateButtons();

    const [f, p, u, g, me] = await Promise.allSettled([
      getFields(site),
      getProjects(site),
      getUsers(site),
      getGroups(site),
      deps.accountId() ? Promise.resolve(undefined) : getMe(),
    ]);
    if (seq !== loadSeq) return; // site switched meanwhile
    const problems: string[] = [];
    if (f.status === 'fulfilled') {
      applyFields(f.value);
    } else {
      problems.push(errText(f.reason));
    }
    if (p.status === 'fulfilled') {
      projectPicker.setOptions(p.value.map((x) => ({ value: x.key, name: `${x.key}\n${x.name}`, label: `${x.key} — ${x.name}` })));
    } else {
      problems.push(errText(p.reason));
    }
    const people: MultiOption[] = [];
    if (u.status === 'fulfilled') {
      userAvatars = new Map(u.value.flatMap((x) => (x.avatarUrl ? [[x.accountId, x.avatarUrl] as const] : [])));
      userNames = new Map(u.value.map((x) => [x.accountId, x.displayName]));
      people.push(...u.value.filter((x) => x.active).map((x) => ({ value: userValue(x.accountId), name: x.displayName, label: x.displayName })));
    } else {
      problems.push(errText(u.reason));
    }
    if (g.status === 'fulfilled') {
      people.push(...g.value.map((x) => ({ value: groupValue(x.groupId), name: x.name, label: `${x.name} (group)` })));
    } else {
      problems.push(`Groups are not available: ${errText(g.reason)}`);
    }
    peoplePicker.setOptions(people);
    // Like Jira's "Current User": the signed-in user is selected to start with (remove the chip for everyone).
    if (me.status === 'fulfilled' && me.value) deps.rememberAccountId(me.value.accountId);
    const mine = deps.accountId();
    if (mine && people.some((o) => o.value === userValue(mine))) peoplePicker.setValues([userValue(mine)]);
    onPeopleChanged();
    showMsg(
      metaError,
      problems.length ? `${problems.join(' ')}${choices.length ? '' : ' — Team Reports needs the field list; reload the page to try again.'}` : undefined,
    );
    updateButtons();
  }

  function applyFields(fields: FieldInfo[]): void {
    choices = groupChoices(fields);
    groupPicker.setOptions(choices.map((c) => ({ value: c.fieldId, name: c.name, label: c.name })));
  }

  // ---- run ----

  function startLoading(): { stop: () => void; setStage: (text: string) => void; watch: (id: string) => void } {
    busy = true;
    loading.hidden = false;
    cancelBtn.disabled = false;
    setSiteLock(deps.siteSelect, 'team', true);
    updateButtons();

    const started = Date.now();
    let stage: string | undefined;
    let stopProgress = () => {};
    loadingBar.hidden = true;
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
      watch(id) {
        stopProgress = watchProgress(
          id,
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
      },
      stop() {
        window.clearInterval(timer);
        stopProgress();
        busy = false;
        loading.hidden = true;
        setSiteLock(deps.siteSelect, 'team', false);
        updateButtons();
      },
    };
  }

  /** Generate Report (and every automatic refresh): reads the form, expands groups, posts, shows the table. */
  async function generate(): Promise<void> {
    if (busy) return;
    window.clearTimeout(autoTimer);
    showMsg(formError, undefined);
    showMsg(formInfo, undefined);
    const groupBy = selectedGroups();
    const query = { from: fromInput.value, to: toInput.value, groupBy };
    const problem = teamQueryProblem(query, deps.maxRangeDays());
    if (problem) return showMsg(formError, problem);

    const id = newRequestId();
    const controller = new AbortController();
    inFlight = { id, controller };
    const loadingState = startLoading();
    try {
      const { users, groups } = splitPeople(peoplePicker.values);
      let authors = users;
      if (groups.length) {
        loadingState.setStage(groups.length === 1 ? 'Loading the group’s members…' : `Loading members of ${groups.length} groups…`);
        const lists = await Promise.all(groups.map((g) => getGroupMembers(g, deps.site())));
        if (controller.signal.aborted) throw new CancelledError();
        authors = mergeAuthors(users, lists.map((l) => l.map((m) => m.accountId)));
        if (authors.length === 0) throw new Error('The selected user(s) and group(s) have no members to report on.');
        loadingState.setStage('Starting…');
      }
      loadingState.watch(id);
      const body = buildTeamRequest({
        site: deps.site(),
        from: query.from,
        to: query.to,
        projects: projectPicker.values,
        authors,
        groupBy,
        period: period(),
        zone: zoneSelect.value as ZoneChoice,
        browserZone: browserZone(),
        jql: jqlInput.value,
        extraJql: extraJqlInput.value,
      });
      const report = await postCustomReport({ ...body, requestId: id }, controller.signal);
      show(report, period());
    } catch (err) {
      if (err instanceof CancelledError) showMsg(formInfo, current ? 'Report cancelled. The previous report is still shown.' : 'Report cancelled.');
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
    cancelReport(inFlight.id, '/api/custom-report');
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
      siteUrl: deps.siteUrl(report.site),
      avatars: userAvatars,
      issueTypes,
    });
  }

  function clearResult(): void {
    window.clearTimeout(autoTimer);
    current = undefined;
    table.replaceChildren();
    result.hidden = true;
    incomplete.hidden = true;
    warnings.hidden = true;
    emptyHint.hidden = false;
    closeExportMenu();
    updateButtons();
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
      const file = await postTeamExport({ site: s.report.site, from: s.report.from, to: s.report.to, complete: s.report.complete, grid });
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
      visible = true;
      if (loadedFor === null) void loadLists();
    },
    hidden() {
      visible = false;
    },
    siteChanged() {
      if (favDialog.open) favDialog.close();
      showMsg(favNotice, undefined);
      clearResult();
      showMsg(formError, undefined);
      showMsg(formInfo, undefined);
      loadedFor = null;
      loadSeq++; // drop answers for the old site
      if (visible) void loadLists();
    },
  };
}
