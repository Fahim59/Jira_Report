# jira-worklog-report

## Goal
Internal web app: on-demand Jira Cloud worklog report (team/day matrix, drill-down, Excel export). No database, no cache. All data in memory per request.
Only disk write: saved Custom Report templates in TEMPLATES_FILE (atomic JSON, Phase 8b Step D). Every user signs in with their own Atlassian email + API token (sign-in screen); nothing about a user is stored on the server.

## Stack
Node 20+, TypeScript (strict), Fastify, @fastify/static, native fetch, luxon, exceljs, zod, vitest. Frontend: Vite vanilla-ts, built into static files served by Fastify.

## Structure
src/server.ts (entry: config + listen), app.ts (buildServer; root error handler src/routes/errors.ts installed before
  any route plugin: 4xx / expose → { error: message }, else 500), config.ts (zod-validated env), types.ts (shared types)
src/jira/sites.ts (JIRA_SITES parsing + SiteRegistry)
src/jira/client.ts (basic auth email+token, fetch wrapper, timeout 30s, retry on 429 honoring Retry-After and on 5xx with backoff, max 3 retries)
src/jira/issues.ts, worklogs.ts, projects.ts, users.ts
src/services/normalize.ts, report.ts, excel.ts
src/routes/health.ts, meta.ts, report.ts, export.ts
web/index.html, main.ts, api.ts, render.ts (drill-down dialog table, retrieved time), style.css; web/team, web/teamall, web/advance, web/list (one folder per tab)
tests/normalize.test.ts, report.test.ts
scripts/probe.ts
.env.example, .gitignore (must include .env), README.md

## Config (.env)
JIRA_SITES, REPORT_TZ=Asia/Dhaka, JIRA_CONCURRENCY=5, MAX_RANGE_DAYS=31, REPORT_TIMEOUT_SEC=120, HOURS_PER_DAY=8 (Custom Report days format), TEMPLATES_FILE=data/templates.json, PORT=8000

## Multiple Jira sites
- JIRA_SITES = comma-separated https://<sub>.atlassian.net URLs (trailing slashes trimmed, lower-cased, validated; duplicates
  and the reserved key "all" rejected). Replaces JIRA_BASE_URL (config error points at the rename). First site = default.
- Site key = subdomain. The signed-in user's email + API token work for all sites they can access; src/jira/sites.ts SiteRegistry holds one credential-less client per site.
- Every /api route takes `site` (?site=<key>; POST /api/report also body.site; /api/export uses report.site). Missing = first
  site, case-insensitive, unknown → 400 "Unknown site". Helper: src/routes/site.ts requireSite().

## Security
- Sign-in (replaces the old shared JIRA_EMAIL / JIRA_API_TOKEN): the user types their Atlassian email + API token; POST /api/login checks them
  with Jira (GET /myself on the default site) and answers { email, displayName, accountId, site }; nothing is stored server-side. The browser keeps
  them (localStorage with "Keep me signed in", else sessionStorage; web/auth-logic.ts, web/session.ts) and sends `Authorization: Basic base64(email:token)`
  on every /api call. src/routes/auth.ts installAuth (onRequest hook, before all routes): missing/malformed header → 401 `{ error: 'Sign in required.' }`,
  else the request runs in AsyncLocalStorage (src/jira/auth.ts) and the Jira clients (createJiraClient without credentials) use that user's token per call;
  no credentials in context → NotSignedInError (401). Public: POST /api/login and GET /api/(report|custom-report)/progress/:id (EventSource cannot send
  a header; the id is random and the stream has counters only). A Jira 401 is passed on as HTTP 401 → web/api.ts signs the user out and shows why.
  FieldCache is per site + user (userKey = hash of the email). JIRA_EMAIL / JIRA_API_TOKEN in .env are optional and used ONLY by scripts/probe.ts.
- The token is never logged (Fastify redacts req.headers.authorization) and never put in a URL. It is readable by scripts on this page's origin and travels
  on every request: serve the app over HTTPS when it is not on localhost.
- Do NOT read, print, or modify .env. Use .env.example only.

## Jira API (Cloud, REST v3)
- Health: GET /rest/api/3/myself
- Projects: GET /rest/api/3/project/search (paginated)
- Users: GET /rest/api/3/users/search (paginated, accountType=atlassian)
- Issues: GET /rest/api/3/search/jql with nextPageToken pagination, fields=summary,project.
  JQL: worklogDate >= "<from-1d>" AND worklogDate <= "<to+1d>" [AND project = X] [AND worklogAuthor in ("id1", "id2", ...)]
  worklogAuthor is included only for 1–20 accountIds; with >20 it is omitted (JQL length limits) and filtering is code-only.
- Worklogs: GET /rest/api/3/issue/{key}/worklog?startedAfter=<ms>&startedBefore=<ms>, paginated via startAt/maxResults/total.
- Fetch worklogs with concurrency limited to JIRA_CONCURRENCY.
- Do NOT rely on worklogs embedded in search results (truncated).

## Rules
- Use worklog "started", never "created".
- Convert started to REPORT_TZ, then take the calendar date; filter to exact [from, to].
- Identify users by accountId; display displayName.
- Report rows come from worklogs (anyone who logged time), not a team list.
- accountIds filter is always applied in code to normalized worklogs too (exact results, whatever the JQL did).
- If any issue's worklog fetch fails after retries: complete=false, include failedIssueKeys. Never present a partial report as complete.
- Reject ranges > MAX_RANGE_DAYS or from > to.

## Normalized worklog
{ id, date (yyyy-MM-dd in REPORT_TZ), accountId, user, issueKey, summary, project, seconds }

## Endpoints
All take ?site=<key> (default = first site; unknown → 400).
POST /api/login { email, token } -> { email, displayName, accountId, site (their default = first accessible), sites[] } | 400 bad input |
  401 no configured site accepted them | 502 sites unreachable (not a wrong token). Tries EVERY site in JIRA_SITES with the user's token
  (src/jira/access.ts probeSites: GET /myself per site, 8 s each, in parallel; 401/403 = no access, anything else = "could not check").
GET  /api/sites -> [{ key, url }] = only the configured sites that accept THIS user's token, in JIRA_SITES order (first = their default);
  cached per email+token hash for 5 min (30 s when a site could not be checked; sign-in always asks Jira again); none → 403 (not 401),
  all unreachable → 502. (this and every route below need the Authorization header)
  JIRA_SITES is the company-wide catalogue (an API token cannot list a user's sites, only OAuth can): a new site must be added there + server restart;
  a user already signed in sees the change after a page reload (within the 5 min cache), no sign-out needed.
GET  /api/health/jira?site=<key> -> { site, baseUrl, ok, user[, error] }
GET  /api/health/jira?site=all -> { ok, sites: [{ site, baseUrl, ok, user, error? }] } (200 if all ok, else 502)
GET  /api/projects
GET  /api/users
GET  /api/config -> { site, jiraBaseUrl, maxRangeDays, reportTimeoutSec } (browser needs these; never the token)
POST /api/report { site?, from, to, project?, accountIds?: string[] (max 50; empty/missing = all users), requestId? } ->
  { site, from, to, project?, dates[], rows[{accountId,user,byDate{date:seconds},total}], dateTotals{}, grandTotal, worklogs[], retrievedAt, complete, failedIssueKeys[], failureReasons?[] }
  Errors: 400 invalid input/unknown project, 409 duplicate requestId, 502/503 Jira (auth, rate limit, network), 504 timeout, 499 cancelled.
POST /api/custom-report { filter (global), template (inline), requestId? } -> sheets[] (SheetResult, headers) + worklogs + issues
  + complete/failedIssueKeys/warnings[] (Phase 8b; old { filter, layout } body removed)
GET  /api/templates?site= -> { site, defaultId?, templates[] (3 read-only builtin:* starters resolved per site, then saved by name), warnings[] }
POST /api/templates { site?, name, defaults, sheets } -> 201 | PUT /api/templates/:id { ..., updatedAt? (409 if stale) }
  (both: every field id checked against the site's /api/fields → 400 naming sheet + field; field list down → 502/503)
DELETE /api/templates/:id -> 204. builtin:* → 403, unknown → 404, name taken → 409
POST /api/templates/:id/default -> { site, defaultId } | DELETE /api/templates/:id/default -> 204 (unset; no-op if not the default)
  Default = per-site pointer in the file (v2 "defaults"), may be a built-in (then ?site= picks the site); saved = its own site
POST /api/custom-report/export { report (the /api/custom-report response), labels? } -> one .xlsx, a worksheet per template
  sheet: <Template name>_<from>_<to>[_INCOMPLETE].xlsx (Phase 8b Step C; CSV / Issues CSV removed); progress/cancel at /api/custom-report/progress/:id and /:id/cancel
  Team Reports additions: filter.zone = server (REPORT_TZ, default) | user (+ filter.userZone = the browser's IANA zone) | author
  (each worklog dated in its author's Jira profile zone, REPORT_TZ if none; worklog window widened by a day; response `zoneMode`);
  sheet.period also quarter (2026-Q3) | year; group sheet `extraJql` (extra issue search `project in (...) AND (<extra>) ORDER BY key DESC`,
  cap 5000, shown as 0-hour rows); filter.authors up to MAX_RUN_AUTHORS=300 (groups expand to members); CustomWorklog.zone;
  "Worklog Time Zone" group-by/column = that zone.
GET  /api/groups?site= -> [{ groupId, name }] (Jira /group/bulk) | GET /api/groups/:groupId/members?site= -> [{ accountId, displayName, active, avatarUrl? }]
GET  /api/users items also carry avatarUrl (24x24) when Jira sends one
POST /api/team-reports/export { site?, from, to, complete?, grid } -> team-report_<site>_<from>_<to>[_INCOMPLETE].xlsx
  (grid = positioned cells from web/team/logic.ts pivotGrid; src/services/teamExcel.ts writes merges, yellow total / blue banner / grey
  weekend fills, frozen header; hours/days stay numbers with format General"h" / General"d"; no Jira calls)
GET  /api/report/progress/:requestId -> SSE: data {stage: validating|searching|worklogs|processing|done|failed, issues?, done?, total?}
POST /api/report/:requestId/cancel -> 204 | 404
POST /api/export (body = report JSON from /api/report) -> .xlsx streamed, generated in memory.
  report.site (missing = first site, unknown → 400) gives issue links and the filename
  worklog-report_<site>_<from>_<to>[_<project>].xlsx
  Sheet1 "Team Summary": User | dates... | Total, plus TOTAL row.
  Sheet2 "Detailed Worklogs": Date | User | Issue | Summary | Project | Hours

## UI
**Tabs: Team Reports | Advance Report | List.** "Team Reports" is web/teamall (all your sites) when the signed-in user can open more than one Jira site,
  else web/team (one site); main.ts applySiteTabs shows one of the two buttons once /api/sites answered. The old Team Matrix and Custom Report tabs are gone
  (their endpoints POST /api/report and POST /api/export remain and are covered by tests and scripts/probe.ts, but no page calls them).
  Team Reports for several sites (web/teamall/tab.ts, merge.ts; tests/team-all.test.ts): a copy of the Team Reports tab that reads every chosen site (Sites picker,
  none = all) with one POST /api/custom-report per site and merges the answers in the browser (mergeReports: the same person on two sites = one row; issues and
  projects stay per site; "Site" is an extra Group By choice that can sit at any level). Group By offers the fields every site has; projects are "site|KEY";
  Users & Groups lists the union (a group is looked up on its own site, its members then count on every site); JQL boxes run on every site; failed sites are named in
  the Incomplete notice. Own favourites list (scope "all-sites"). Excel file name team-report_all-sites_<from>_<to>.xlsx (teamExport `fileSite`).
  Users pickers list active users only; the List tab narrows them to people with work updated in the last 90 days (GET /api/list/users).
Sign-in screen first (web/login.ts, #login): Atlassian email, API token (password field, "Show token"), "Keep me signed in on this browser" (default on),
  Sign in, then "Don't have API Key Token? Generate from here" (link to https://id.atlassian.com/manage-profile/security/api-tokens) and a note that the
  token stays in this browser. Nothing else loads until sign-in; the app (#app) is hidden before. Header shows the Jira display name + "Sign out"
  (clears storage and reloads). A stored sign-in that Jira no longer accepts → back to the sign-in screen with a note.
Header: "Jira site" dropdown (hidden if only one site); last choice in localStorage "worklog-report:site"
  (web/sites-logic.ts; falls back to first site if no longer configured). Disabled while a report is generating.
  Switching: clears the report (and Retry), closes modals, clears project + user selection, reloads projects/users
  for the new site (stale responses dropped). Issue links use the report's site URL.
Tabs (role=tablist, ←/→ switch among the visible ones; last tab in localStorage "worklog-report:tab"; an unknown / removed tab falls back to Team Reports).
Pickers: web/multiselect.ts (searchable multi-select with chips, keys ↑/↓ Enter/Space Esc Backspace; pure rules in multiselect-logic.ts) and
  web/singleselect.ts (searchable single select; singleselect-logic.ts). Users lists are active users only.
Favourites (browser-only, per site; web/favourites-logic.ts + favourites.ts, tests/favourites.test.ts): localStorage "worklog-report:favourites"
  { version: 2, sites: { <siteKey>: [{ name, accountIds[], names[], savedAt, filters? }] } } (v1 is migrated). Used by the Team Reports tabs.
Advance Report tab (web/advance/: tab.ts, editor.ts, preview.ts, pure template-logic.ts + logic.ts; tests/custom-*.test.ts): the report-template builder.
  Filter From/To + Projects + Users (= the template's defaults). Template dropdown: the user's saved templates and "+ New Report Template" (no built-ins; opens the
  saved default, else a new one) + Save, Save as…, Rename…, Delete, Make default. Sheet editor: sheet list (≤10) + name, rows mode, Duplicate/Delete; Group by
  up to 5 levels (label + Extract regex each); collapsible cards "Extra columns" and "Totals & format" (Total row, Period, Format, Sort, Total columns, Total label,
  Subtotal rows, Merge group cells, Sum sub-tasks into parent). Header style, notes and sheet filters/JQL are kept on a loaded template but have no editor.
  One Generate: posts { filter, template }, shows the preview (a tab per sheet; tree with Expand/Collapse all; keys link to Jira; amounts open a drill-down dialog),
  then posts the result to /api/custom-report/export and downloads the .xlsx. Progress/Cancel, "⚠ Incomplete report" + Retry, warnings.
Team Reports tab (look-alike of the Jira Team Reports add-on page; web/team/tab.ts, logic.ts, render.ts; tests/team-reports.test.ts):
  left panel (collapsible): From/To, Projects, Users & Groups (users + Jira groups, a group expands to its members at Generate; the signed-in user is preselected like Jira's "Current User":
  account id kept with the sign-in, or fetched with GET /api/me for older saved sign-ins; remove the chip = everyone; re-selected on site switch),
  JQL Issue Filter (= the sheet's JQL), Extra JQL (= sheet extraJql), Generate Report. Top bar: Group By (optional, any number, selection order = level order, none = one Total column;
  empty by default, "Work Log Started" = worklog.date), Period Grouping Day/Week/Month/Quarter/Year, Time Format Hours / Hours & Minutes /
  hh:mm / Days (re-renders only), Time Zone Current User (browser zone) / Jira Server (REPORT_TZ) / Work Log Author (default here: Jira's
  "Current User" is the logged-in profile zone and this app has no login; per-author zone gives Jira's days for a person's own time).
  Changing Group By / Period / Time Zone refreshes by itself once a report is shown. One group sheet via POST /api/custom-report
  (totalColumns everyLevel, no per-sheet template saved). Table: each level + yellow "Total <level>" column, month banner over day/week
  columns (weekend columns grey, week = "29-05" over ISO week number), zero cells blank, parent cells merged down their rows, Total row;
  user avatars (initials when none), issue type icons drawn in CSS, issue keys link to Jira. Export menu → "To Excel File". No drill-down (Jira has none).
  "Save Favourite" / "Favourite List" sit above Generate Report (own dialog #tr-fav; same localStorage favourites as the Team Matrix tab, per site).
  A favourite saved here also keeps `filters` { projects, jql, extraJql } (web/favourites-logic.ts FavouriteFilters; optional, so Team Matrix
  favourites and old ones are users-only): Save is enabled by users OR a project / JQL; a favourite may have no users; the list has an "Also saved"
  column; Select replaces users and, when the favourite has `filters`, projects + both JQL boxes (projects that no longer exist are reported).
  Jira groups in Users & Groups are not saved. Team Matrix ignores `filters`.
  Site switch clears the result and selections like the other tabs; the site dropdown is locked while it generates (lock owner "team").

List tab (look-alike of Jira's List view; web/list/tab.ts, logic.ts; src/routes/list.ts; tests/list.test.ts): Projects + Users pickers, then Filter
  (Basic: Parent / Assignee / Status / Work type / Labels + "Add field", values from the loaded rows, client-side; JQL: server-side, combined with the pickers),
  Group (one field, searchable, "Clear selection"), "..." menu (Hide done work items = server `statusCategory != Done`, Show hierarchy = client, Export to Excel)
  and Configure columns (saved in localStorage "worklog-report:list-columns"; default Original Estimate / Time Spent / Status). No ticket checkboxes, no row menus.
  POST /api/list { site?, projects[], assignees[], jql, hideDone, fields[] } -> { rows[{key,summary,type,subtask,status,statusCategory,parent?,values{}}], truncated, limit (1000), jql };
  needs a project, user or JQL (400 otherwise). POST /api/list/export { site?, headers[], rows[{cells[],level,group}] } -> work-items_<site>_<date>.xlsx (no Jira calls).

## Phases (one at a time, stop after each for user check)
1. Scaffold + config + jira client + health route + scripts/probe.ts
2. normalize.ts + report.ts + unit tests (midnight TZ edge, 0h days, totals)
3. /api/report + UI matrix
4. Drill-down modal
5. Excel export
6. Hardening: progress/loading, incomplete-report UI, range limits, error messages;
   validate project key against the project list (/api/projects), unknown key → 400
7. README: setup + internal deployment

## Phase status
- [x] Phase 1 — health check + probe
- [x] Phase 2 — normalize.ts + report.ts + tests; probe now uses services/report.ts generateReport (same pipeline as /api/report)
- [x] Phase 3 — /api/projects, /api/users, /api/report + UI matrix — verified
- [x] Phase 4 — drill-down modal (web/drilldown.ts pure grouping + tests/drilldown.test.ts) — verified
- [x] Users multi-select (accountIds[] in /api/report, JQL in-clause ≤20, tests/user-filter.test.ts) — verified
- [x] Phase 5 — Excel export (services/excel.ts, routes/export.ts zod-validated, tests/excel.test.ts; report JSON now carries optional `project` for the filename) — verified
- [x] Phase 6 — hardening: project key validated (case-insensitive → canonical), REPORT_TIMEOUT_SEC deadline (504, no partial data), Cancel (AbortController → Jira fetch; disconnect or POST /api/report/:id/cancel), SSE progress with elapsed-counter fallback, friendly Jira errors (src/jira/errors.ts), failureReasons on incomplete reports, per-request log line, tests/hardening.test.ts — awaiting user verification
- [ ] Favourite Groups for the Users filter (localStorage only; web/favourites-logic.ts, web/favourites.ts, MultiSelect.setValues, tests/favourites.test.ts) — awaiting user verification
- [ ] Multiple Jira sites (JIRA_SITES, SiteRegistry, ?site on all routes, /api/sites, health ?site=all, site in report/export, header dropdown, per-site favourites + v1 migration, probe --site; tests/sites.test.ts, excel/favourites tests) — awaiting user verification

- [ ] Phase 8 — Custom Report builder. Spec: docs/phase8-custom-report.md (with agreed clarifications at the end).
  Pure logic in src/services/custom/ (no Node/Fastify imports).
  - [x] Step 1 — GET /api/fields (src/jira/fields.ts FieldCache: per-site, 10-min TTL, failures not cached; pseudo-fields +
    normalizeFieldValue/adfToText in src/services/custom/fields.ts; tests/custom-fields.test.ts) — awaiting user verification
    Epic = nearest Epic ancestor via parent chain (sub-task → story → epic), resolved in Step 3 with batched
    parent/grandparent fetches; no Epic Link support. Normalizer also: booleans Yes/No, cascading "Parent - Child", empty array items dropped.
  - [x] Step 2 — src/services/custom/filter.ts (CustomFilterSchema, compileFilter, checkUserJql, matchesCondition);
    src/jira/jql.ts validateCustomJql (POST /jql/parse?validation=strict); JiraClient.post (optional on the interface);
    tests/custom-filter.test.ts — awaiting user verification
  - [x] Step 3 — src/services/custom/layout.ts (LayoutSchema, toUnit/formatAmount), engine.ts (findEpic: issue itself if Epic,
    else nearest Epic up the parent chain; attributionKey rollup; ValueResolver; issuePasses re-checks "contains";
    buildTree, periods: day/ISO week/month; totals in seconds); src/jira/custom.ts (search with fields=, key-in batches of 100,
    400 → per-key retry → unavailable); src/services/customReport.ts generateCustomReport (unloadable parent/epic →
    grouped as "KEY (unavailable)" + warnings[], complete unaffected; startDeadline shared with generateReport);
    tests/custom-engine.test.ts, custom-report.test.ts — awaiting user verification
  - [x] Step 4 — POST /api/custom-report { filter, layout, requestId? } (src/routes/customReport.ts); run plumbing
    (409 guard, abort on disconnect, progress, 504/499, log line, SSE + cancel routes) shared with /api/report in
    src/routes/runs.ts; one RunRegistry + FieldCache in server.ts; tests/custom-report-route.test.ts — awaiting user verification
  - [x] Step 5 — UI tab: web/custom/tab.ts (DOM), web/custom/logic.ts (pure: field options, operators/value kinds,
    buildConditions/buildRequest, visibleRows/findNode/parentPaths, nodeDrilldown, isoWeekKey/periodOf/periodLabel,
    formatAmount — browser copies kept in sync by tests/custom-ui.test.ts; no zod/luxon in the bundle);
    web/site-lock.ts (site switcher locked while either tab generates); tabs in index.html/main.ts — awaiting user verification
  - [x] Step 6 (superseded by Phase 8b Step C: CSV / Issues CSV and the three buttons removed) — POST /api/custom-report/export?format=xlsx|csv { report, view?, labels?{projects,users} } (src/routes/customExport.ts,
    zod-validated, no Jira calls). Pure sheet/CSV layout in src/services/custom/export.ts; exceljs in src/services/customExcel.ts.
    Fixtures: Report 1.xlsx = the accepted format (kept cell for cell), Report 2.xlsx = team sample (table structure),
    Jira.csv = Issues CSV format (rebuilt byte for byte). Layout: header block rows 1–6 (A:B labels, values C:I+), table header row 8,
    Level/Total Level pairs, parent values on a group's first row only, Total row; trailing Total column only with periods.
    Amounts rounded to 2 dp, General format. Incomplete: red row 7 + "_INCOMPLETE" filename. CSV: leaf rows, BOM, CRLF,
    formula-like text prefixed with '. Worklogs carry `columns` (per-worklog extra column values). UI: Export Excel / Export CSV
    / Export Issues CSV buttons in the result bar. Issues CSV (format=issues): Jira issue-export columns (Issue Type, Issue key,
    Issue id, Summary, Status, Assignee, Assignee Id, Parent, Parent key, Parent summary), one row per issue time was logged on,
    key descending, no BOM, LF, Jira quoting; report.issues[] (assignee added to BASE_ISSUE_FIELDS). tests/custom-export.test.ts — awaiting user verification
  - [ ] Step 7: saved views — superseded by Phase 8b templates

- [ ] Phase 8b — Report Templates + single Generate (xlsx). Spec: docs/phase8b-templates.md (decisions at the end).
  Replaces Phase 8 Steps 6–7; Team Matrix untouched.
  - [x] Step A — src/services/custom/template.ts (GlobalFilter/Sheet/TemplateBody schemas), sheets.ts (runTemplate:
    group / eachWorklog / eachIssue, per-sheet conditions in code, sheet JQL keys intersection, per-sheet rollup),
    generateTemplateReport (one search with the field union, keys-only search per distinct sheet JQL, worklogs once),
    validateSheetJql; new pseudo-fields metric.hours, worklog.started/timeZone, issue.id, parent.id/key/summary,
    assignee.id; tests/custom-template.test.ts, custom-template-report.test.ts — awaiting user verification
  - [x] Header labels: columns/groupBy take fieldId | { fieldId, label } (normalised to FieldRef), refHeader/totalHeader,
    SheetResult.headers — awaiting user verification
  - [x] Step B — POST /api/custom-report { filter, template, requestId? } → generateTemplateReport; generateCustomReport
    removed (tests/custom-report.test.ts runs its cases as one-sheet templates); custom tab UI 400s until Step E — awaiting user verification
  - [x] Sheet options: group totalColumns everyLevel|lastLevel, totalLabel, subtotalRows (lastLevel + totals only);
    each-issue includeIssuesWithoutWorklogs (extra search: global projects or all visible + sheet JQL, conditions in code,
    0 hours, no worklog calls, cap 5000 + warning; searchIssuesLimited); headers.total; pure table layout in
    src/services/custom/table.ts; starter presets in src/services/custom/presets.ts (by field name, resolveStarter) — awaiting user verification
  - [x] Step C — Excel writer: src/services/custom/export.ts (templateSheet/workbookLayout, header block per sheet, row 8
    frozen, filename + Content-Disposition), customExcel.ts buildTemplateWorkbook, routes/customExport.ts validates a
    TemplateReport; tab export buttons + postCustomExport removed; tests/custom-export.test.ts rewritten (fixtures as presets) — awaiting user verification
  - [x] After Step C: includeIssuesWithoutWorklogs needs ≥1 global project (400); JQL-expressible sheet conditions
    (not contains, not pseudo-fields, accepted by one /jql/parse) narrow the extra search, all re-checked in code — awaiting user verification
  - [x] Step D — src/services/templateStore.ts (TemplateStore, FileTemplateStore: one queue, temp file + rename, corrupt
    file moved aside, invalid entries kept), src/routes/templates.ts, starter ids builtin:*, TEMPLATES_FILE;
    tests/templates.test.ts — awaiting user verification
  - [x] Step D changes: setErrorHandler before routes (src/app.ts, src/routes/errors.ts; storeCall workaround removed);
    default = per-site pointer (file v2, may be a built-in; v1 migrated); DELETE /:id/default (unset); field ids checked
    on POST/PUT (checkTemplateFields) — awaiting user verification
  - [x] Step E — UI: template bar, sheet editor (labels, all sheet options, sheet filters), one Generate (preview + xlsx
    download); tests/custom-template-ui.test.ts — awaiting user verification
  - [x] Summary sheet options (docs/phase8b-templates.md "Summary sheet options"): group count columns metric.issueCount /
    metric.worklogCount (Total = distinct overall), headerStyle standard|title|none + title/subtitle placeholders,
    notes below the table, column/level `extract` regex (before grouping), mergeGroupCells; pure helpers in
    src/services/custom/text.ts; Team Client Report starter = Report + Summary; fixture tests/fixtures/Report_1.xlsx;
    tests/custom-sheet-options.test.ts — awaiting user verification

- [ ] Team Reports tab (third tab, Jira "Team Reports" look-alike; see UI section): quarter/year periods, time-zone modes, extra JQL,
  groups routes, avatars, /api/team-reports/export — awaiting user verification. Not copied from Jira: the add-on vendor's "?" menu (support request / documentation / contact).

## Version constraints
Dev machine runs Node 20.15. Do not bump these without upgrading Node to ≥20.19:
- @fastify/static pinned to ^8 (v10 needs require(esm), so it crashes on 20.15)
- vite ^6, vitest ^3 (vite 8 / vitest 5 need Node ≥20.19)
- Node ≥20.12 is required for process.loadEnvFile() (used in config.ts)

## Commands
- `npm run dev` — server with watch (tsx); serves dist/web if built
- `npm run dev:web` — Vite dev server on :5173, proxies /api to :PORT (run alongside `npm run dev`)
- `npm run build` / `npm start` — compile server to dist/server + web to dist/web, and run
- vite.config.ts has root web/, so vitest uses its own vitest.config.ts
- `npm test` — vitest
- `npm run typecheck`
- `npm run probe -- --from YYYY-MM-DD --to YYYY-MM-DD [--site KEY] [--project KEY] [--user ID1[,ID2,...]]`
