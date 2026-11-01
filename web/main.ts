import { getConfig, getSites, type SiteInfo } from './api.js';
import { setupAdvanceReport } from './advance/tab.js';
import { setupTeamAll } from './teamall/tab.js';
import { closeOnOutsideClick, migrateStoredFavourites } from './favourites.js';
import { setupList } from './list/tab.js';
import { isSiteLocked } from './site-lock.js';
import { setupLogin } from './login.js';
import { syncSettings } from './settings-sync.js';
import { currentAuth, rememberAccountId, signOut } from './session.js';
import { setupTeamReports } from './team/tab.js';
import { chooseSite, loadLastSite, saveLastSite } from './sites-logic.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** window.localStorage, or undefined where touching it throws. */
function browserStore(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const siteField = $<HTMLLabelElement>('site-field');
const siteSelect = $<HTMLSelectElement>('site');
/** Configured Jira sites from /api/sites (first = default); empty if that request failed. */
let sites: SiteInfo[] = [];
/** Selected site key; undefined = the server's default (site list not loaded). */
let currentSite: string | undefined;
/** Favourite groups are kept per Jira site (used by the Team Reports tab). */
const favouriteScope = () => (currentSite && sites[0] ? { site: currentSite, legacySite: sites[0].key } : undefined);

/** Default site's URL from /api/config; used for issue links only if /api/sites failed to load. */
let fallbackBaseUrl: string | undefined;
/** Server limit; replaced by /api/config once loaded. The server enforces it either way. */
let maxRangeDays = 31;

// The drill-down dialog (opened from the Advance Report preview) closes with its button, Esc, or a click outside.
const drill = $<HTMLDialogElement>('drill');
$<HTMLButtonElement>('drill-close').addEventListener('click', () => drill.close());
closeOnOutsideClick(drill);

/** Issue-link base for a report: its own site's URL (falls back to the selected/default site). */
function siteUrl(key: string | undefined): string | undefined {
  return sites.find((s) => s.key === (key ?? currentSite))?.url ?? fallbackBaseUrl;
}

function populateSites(list: SiteInfo[]): void {
  sites = list;
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.key;
    opt.textContent = s.url.replace(/^https:\/\//, '');
    siteSelect.append(opt);
  }
  currentSite = chooseSite(list.map((s) => s.key), loadLastSite(browserStore()));
  if (currentSite) siteSelect.value = currentSite;
  siteField.hidden = list.length <= 1;
}

/** Switching site: every tab clears its result and reloads its lists for the new site. */
siteSelect.addEventListener('change', () => {
  const key = siteSelect.value;
  if (isSiteLocked() || key === currentSite) {
    if (currentSite) siteSelect.value = currentSite;
    return;
  }
  currentSite = key;
  saveLastSite(browserStore(), key);
  if (drill.open) drill.close();
  advanceTab.siteChanged();
  listTab.siteChanged();
  teamTab.siteChanged();
});

// ---- Tabs: "Team Reports" | "Advance Report" | "List" (last choice remembered in this browser) ----
// "Team Reports" is the all-sites version (web/teamall) for someone who can open more than one Jira site, else the one-site version (web/team).

const TAB_KEY = 'worklog-report:tab';
const TABS = ['team', 'teamall', 'advance', 'list'] as const;
type Tab = (typeof TABS)[number];
const advanceTab = setupAdvanceReport({
  siteSelect,
  site: () => currentSite,
  siteUrl,
  maxRangeDays: () => maxRangeDays,
});
const teamAllTab = setupTeamAll({
  sites: () => sites,
  siteUrl,
  maxRangeDays: () => maxRangeDays,
  accountId: () => currentAuth()?.accountId,
  rememberAccountId,
});
const listTab = setupList({
  siteSelect,
  site: () => currentSite,
  siteUrl,
});
const teamTab = setupTeamReports({
  siteSelect,
  site: () => currentSite,
  accountId: () => currentAuth()?.accountId,
  rememberAccountId,
  favouriteScope,
  siteUrl,
  maxRangeDays: () => maxRangeDays,
});
const tabButtons: Record<Tab, HTMLButtonElement> = { team: $('tabbtn-team'), teamall: $('tabbtn-teamall'), advance: $('tabbtn-advance'), list: $('tabbtn-list') };
const tabPanels: Record<Tab, HTMLElement> = { team: $('tab-team'), teamall: $('tab-teamall'), advance: $('tab-advance'), list: $('tab-list') };
const tabs: Record<Tab, { shown(): void; hidden(): void }> = { team: teamTab, teamall: teamAllTab, advance: advanceTab, list: listTab };
let currentTab: Tab = 'team';
/** The tabs load their lists only once the site list has settled (so they use the remembered site). */
let sitesSettled = false;

function selectTab(tab: Tab, focus = false): void {
  currentTab = tab;
  for (const t of TABS) {
    const on = t === tab;
    tabButtons[t].setAttribute('aria-selected', String(on));
    tabButtons[t].tabIndex = on ? 0 : -1;
    tabPanels[t].hidden = !on;
    if (on) {
      if (sitesSettled) tabs[t].shown();
    } else {
      tabs[t].hidden();
    }
  }
  if (focus) tabButtons[tab].focus();
  try {
    browserStore()?.setItem(TAB_KEY, tab);
  } catch {
    // Storage unavailable: the tab is just not remembered.
  }
}

for (const t of TABS) {
  tabButtons[t].addEventListener('click', () => selectTab(t));
  tabButtons[t].addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const shown = TABS.filter((x) => !tabButtons[x].hidden);
    selectTab(shown[(shown.indexOf(t) + step + shown.length) % shown.length]!, true);
  });
}

/** One "Team Reports" tab: the all-sites one when this user can open several Jira sites, else the one-site one. */
function applySiteTabs(): void {
  const multi = sites.length > 1;
  tabButtons.team.hidden = multi;
  tabButtons.teamall.hidden = !multi;
  if (multi && currentTab === 'team') selectTab('teamall');
  else if (!multi && currentTab === 'teamall') selectTab('team');
}

function sitesReady(): void {
  sitesSettled = true;
  tabs[currentTab].shown();
}

let storedTab: string | null = null;
try {
  storedTab = browserStore()?.getItem(TAB_KEY) ?? null;
} catch {
  storedTab = null;
}
// An earlier choice of a tab that no longer exists (Team Matrix, Custom Report, All Sites) falls back to Team Reports.
selectTab(TABS.find((t) => t === storedTab) ?? 'team');

/** Loads the site list. Runs once the user is signed in (every call needs their credentials). */
function bootstrap(): void {
  // Saved List columns / favourites come from the server file; the tabs read them at start-up, so reload once if they changed.
  syncSettings().then(
    (changed) => {
      if (changed) window.location.reload();
    },
    () => {},
  );
  getSites().then(
    (list) => {
      populateSites(list);
      if (list[0]) {
        const problem = migrateStoredFavourites(list[0].key);
        if (problem) console.warn(problem);
      }
      applySiteTabs();
      sitesReady();
    },
    (err: unknown) => {
      // No fallback to "the default site": it may be one this user cannot use. The tabs stay empty until the page is reloaded.
      const note = document.createElement('p');
      note.className = 'notice notice-warn';
      note.textContent = `Could not load your Jira sites: ${err instanceof Error ? err.message : String(err)}`;
      $('tab-team').parentElement?.prepend(note);
      applySiteTabs(); // no site list: the one-site Team Reports tab
    },
  );
  getConfig().then(
    (c) => {
      fallbackBaseUrl = c.jiraBaseUrl;
      maxRangeDays = c.maxRangeDays;
    },
    () => {},
  );
}

// ---- Sign-in: nothing is loaded until the user has signed in (their email + API token ride on every request) ----

const appRoot = $<HTMLElement>('app');
const whoLabel = $<HTMLSpanElement>('who');
$<HTMLButtonElement>('signout').addEventListener('click', () => signOut());

function showApp(): void {
  const auth = currentAuth();
  whoLabel.textContent = auth ? auth.name || auth.email : '';
  whoLabel.title = auth?.email ?? '';
  appRoot.hidden = false;
}

if (currentAuth()) {
  showApp();
  bootstrap();
} else {
  setupLogin(() => {
    showApp();
    bootstrap();
  });
}
