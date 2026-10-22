# Phase 8b — Report Templates + single Generate (xlsx)

This phase replaces Phase 8 Steps 6–7 (the export buttons and saved views). Steps 1–5 stay: the field discovery, the filter compiler, the engine, the routes and the UI. The Team Matrix tab and its export must not change.

Work step by step. After each step, run `npm test` and `npm run typecheck`, then stop and report. Record every decision in "Agreed clarifications" at the end of this file.

## Why
Each new format added a new button, which is static. Instead, every format becomes **configuration**: a template made of sheets, and one **Generate** button that produces one `.xlsx` and an on-screen preview.

## Concepts

**Global filter** (top of the page, chosen each run)
- `{ site, from, to, projects[], authors[] }`
- Applies to every sheet.
- Drives the single Jira fetch.

**Template** (saved, shared, no auth)
```
Template { id, site, name, isDefault, updatedAt,
  defaults: { projects: string[], authors: string[] },   // pre-fill the global filter; editable before Generate
  sheets: Sheet[] }                                       // 1..10
```

**Sheet**
```
Sheet { name,                                   // unique in the template, max 31 chars, no : \ / ? * [ ]
  rows: { mode: 'group', groupBy: fieldId[1..3] } | { mode: 'eachWorklog' } | { mode: 'eachIssue' },
  columns: fieldId[],                           // ordered, any Jira or pseudo field, including 'metric.hours'
  totals: boolean,                              // group subtotals and a grand total row
  period: 'none'|'day'|'week'|'month',          // group mode only
  format: 'hours'|'days', sumSubtasksToParent: boolean, sort: 'value'|'totalDesc',
  filter: { conditions: Condition[], jql?: string } }   // per-sheet; can only narrow the global filter
```

**New pseudo-field `metric.hours`**
- In each-worklog mode: that worklog's time.
- In each-issue mode: the issue's total time in the range.
- In group mode the hours are already shown, so this field is not offered there.

## Rules
- **One fetch per Generate.**
  - The global filter builds the JQL.
  - The requested fields are the union of the fields used by all sheets.
  - Worklogs are fetched once, with the existing concurrency, timeout, cancel, progress, `complete` and `failedIssueKeys` handling.
- **Per-sheet conditions** are evaluated in code on the fetched values. Reuse and extend `matchesCondition` so it covers every operator. User fields compare by accountId. `contains` is a case-insensitive substring match.
- **Per-sheet JQL**
  - Run one extra search for keys only: `(global JQL) AND (sheet JQL)` with `fields=key`.
  - Intersect the result with the fetched issues. There are no extra worklog calls.
  - Validate with `/jql/parse`, using the same guard as Step 2.
- Per-sheet filters only narrow the data. A sheet can never add a project, user or date.
- Each sheet runs the existing engine on its own filtered subset. Warnings and incompleteness apply to the whole workbook.

## Step A — Template model + sheet engine (pure, `src/services/custom/`)
- zod schemas for Template, Sheet and the global filter, with the limits above.
- `runTemplate(data, template)` returns one `SheetResult` per sheet:
  - **group mode:** the existing tree.
  - **eachWorklog:** one row per worklog, in the order Author, then started.
  - **eachIssue:** one row per issue with time in the range, newest key first. With rollup on, rows are the parent issues.
- Totals row:
  - group mode: as now
  - each-worklog / each-issue: sums `metric.hours` when that column is present
- Tests:
  - every mode
  - per-sheet conditions (every operator)
  - per-sheet JQL intersection
  - narrowing only
  - field union
  - one fetch for N sheets

## Step B — Route
- `POST /api/custom-report` body: `{ filter (global), template (inline, saved or unsaved), requestId? }`.
- Returns `{ sheets: SheetResult[], worklogs, issues, complete, failedIssueKeys, warnings }`.
- Keep SSE progress, cancel, 504, 409 and MAX_RANGE_DAYS.
- Remove the old single-layout body. Update the tests.

## Step C — Excel writer (one workbook)
- One worksheet per template sheet, in order, using the sheet's name.
- Every worksheet starts with the existing header block in rows 1–6:
  - From / To
  - Projects
  - Filters (global and this sheet's filters, in words)
  - Time Zone (REPORT_TZ)
  - Generated on
  - Report Time Format
- Row 7 is blank, or holds the red incomplete warning. The table starts at row 8.
- Table layout by mode:
  - **group:** the existing Report layout (Level / Total Level pairs, parent values only on the first row, extra columns, period columns, Total row).
  - **eachWorklog:** columns as configured. Times are Excel dates in REPORT_TZ.
  - **eachIssue:** columns as configured.
- Formatting: frozen panes at row 8, bold header, auto widths up to 60.
- Filename: `<Template name>_<from>_<to>.xlsx`, plus `_INCOMPLETE` when the report is incomplete.
- **Remove** the CSV export, the Issues CSV export and the separate Export Excel button, together with their code.
- Convert their fixture tests into sheet presets instead:
  - The sample "Work logs" sheet becomes an eachWorklog sheet with the 8 sample columns.
  - Jira.csv becomes an eachIssue sheet with the same 10 columns, in xlsx. Assert the header and cell values, not bytes.
  - The group test stays against the Report fixture.

## Step D — Template store (replaces Step 7 views)
- If any Step 7 views code exists, convert it to templates rather than keeping both.
- Store: `data/templates.json`, path set by `TEMPLATES_FILE`. Use a `TemplateStore` interface, atomic writes (temp file + rename), and handle a missing or corrupt file.
- Routes:
  - `GET /api/templates?site=`
  - `POST /api/templates`
  - `PUT /api/templates/:id`
  - `DELETE /api/templates/:id`
  - `POST /api/templates/:id/default`
- Name rules: unique per site, at most one default per site.
- **Built-in starter templates**, available on every site. They are read-only, but "Save as" makes an editable copy. Fields are referenced by **name** and resolved against `/api/fields` when loaded; a missing field gives a warning and that column is skipped.
  1. **Time Reports style**
     - Sheet "Report": group by Issue → Issue (Key Summary) → Status, totals on.
     - Sheet "Work logs": each worklog with Author, Issue, Issue Summary, Work log started, Work log created, Work log time zone, `metric.hours`, Work log comment.
  2. **Team Client Report**
     - group by Worklog Author → Issue, column Client Reference, totals on.
  3. **Issue list**
     - each issue with the 10 Jira.csv columns.
- Tests: CRUD, uniqueness, single default, atomic write, corrupt file, starter resolution with a missing field.

## Step E — UI (Custom Report tab)
**Top bar**
- Site, From/To, Projects, Users (the global filter).
- Template dropdown with: Save, Save as, Rename, Delete, Set default. Built-in templates only allow Save as.
- An unsaved-changes dot.

**Sheet editor**
- Sheet list: add, duplicate, delete, rename, reorder.
- The selected sheet's panel:
  - Rows mode, with 1–3 group levels in group mode.
  - Columns: ordered, searchable.
  - Totals, Period, Format, Rollup (keep the existing ⓘ tooltip), Sort.
  - Sheet filters: conditions rows and a JQL box.

**Generate**
- **One button: Generate.**
- It runs the report, shows the **preview**, and automatically downloads the `.xlsx`.
- The preview has one tab per sheet: a tree for group mode, a table for the flat modes. Drill-down works as now.
- Generate is disabled while running, and Cancel is shown.
- Incomplete reports and warnings are shown as now.

**Layout**
- The default template loads when the tab opens.
- Switching site clears the tab and reloads the templates.

## Acceptance
1. Template "Time Reports style": FFN, 2026-09-01..29.
   - One click on Generate shows a preview with 2 tabs and downloads one xlsx with the sheets "Report" and "Work logs".
   - The Report sheet total equals the preview total.
2. Template "Team Client Report": IOIA shows Author → Issue rows with Client Reference and per-user subtotals.
3. A custom template with 3 sheets:
   - "All": no filter.
   - "Billable": Client Reference is not empty.
   - "Done": JQL `status = Done`.
   - Each sheet's total is ≤ the "All" total, and Jira worklog calls happen only once.
4. There are no CSV or extra export buttons anywhere in the Custom Report tab. The Team Matrix tab is unchanged.
5. All old tests still pass, apart from the removed export ones, which are replaced as described in Step C.

## Out of scope (Phase 8c, later)
Uploading an `.xlsx` to create a template: detect the header row, map columns to fields, review on a mapping screen, save. The uploaded file defines the layout only; filters are always chosen when generating.

## Agreed clarifications
- Preview stays; xlsx only.
- Global filter = date range, projects, users. Per-sheet filters = conditions and JQL, and they only narrow.
- Team Matrix tab untouched.

### Step A (implementation decisions)
- **Files:** `src/services/custom/template.ts` (GlobalFilterSchema, SheetSchema, TemplateBodySchema, `Template`,
  sheetFieldIds/templateFieldIds), `src/services/custom/sheets.ts` (runTemplate/runSheet, sheetAcceptsIssue,
  sheetWorklogs, SheetResult), `generateTemplateReport` in `src/services/customReport.ts`, `validateSheetJql` in
  `src/jira/jql.ts`, `TemplateReport` in `src/services/custom/result.ts`. The old `generateCustomReport` stays until Step B.
- **TemplateBody vs Template:** `TemplateBody = { name, defaults, sheets }` is what the user edits and what the route will
  take inline; `Template` adds `id, site, isDefault, updatedAt` (Step D store).
- **Schema rules beyond the spec:** sheet names are unique case-insensitively (Excel's rule) and must not start or end
  with `'` (Excel rejects them). Flat sheets need at least one column. `period` other than `none` on a flat sheet is a
  validation error (not silently ignored). Each-issue sheets reject `worklog.*` columns (no single value per issue).
  `metric.hours` is rejected in group by, as a group-sheet column and in conditions. `totals` defaults to true.
  Sheet JQL gets the Step 2 structural check (balanced parentheses, closed strings, no ORDER BY) in the schema.
- **New pseudo-fields** (in `/api/fields`): `metric.hours` "Hours", `worklog.started` "Worklog Started",
  `worklog.timeZone` "Worklog Time Zone" (= REPORT_TZ), `issue.id` "Issue id", `parent.id` "Parent id",
  `parent.key` "Parent key", `parent.summary` "Parent summary", `assignee.id` "Assignee Id". They need no extra Jira
  fields (computed from the base fields `parent`, `assignee`, or the worklog).
- **Cells in flat sheets:** display text, except `metric.hours` = seconds (number) and `worklog.started` /
  `worklog.created` = the raw Jira timestamp (the Excel writer turns them into REPORT_TZ dates). In group sheets
  `worklog.created` still groups by its REPORT_TZ date.
- **Sheet conditions are all evaluated in code** (none compiled into JQL), on the issue the time was logged on (rollup
  does not change that, as in Phase 8). Matching is trimmed and case-insensitive; user fields (`assignee`, user custom
  fields, `worklog.author`) compare by accountId only; list fields match if any item matches; object fields match their
  display value or their key (e.g. project "FFN" or "Fun Fun"); issue links match the key or "KEY Summary".
- **Fewer worklog calls:** an issue gets a worklog call only if at least one sheet can use it (its JQL matched and its
  issue-level conditions pass). Identical sheet JQL is searched once. All sheet JQL is validated in one `/jql/parse`
  call (each alone and as `(global) AND (sheet)`); errors name the sheet.
- **Rollup is per sheet:** worklogs are fetched with `attributedTo` = the issue itself; each sheet re-attributes.
  Parents/epic chains are loaded once if any sheet needs them.
- **Each-worklog order:** author display name, then start instant (offsets compared as instants), then issue key and
  worklog id for a stable order. **Each-issue order:** key number descending (as Jira's navigator).
- **`showTotals`:** group sheets = `totals`; flat sheets = `totals` and an Hours column present. Every SheetResult also
  carries `total` (seconds of all its worklogs) for the preview/acceptance checks.
- **Response worklogs:** only worklogs that appear in at least one sheet; `issues` = the issues they were logged on.
- **Warnings:** one list for the workbook, built from how each sheet attributes its time, so a missing parent used by
  two sheets gives one warning.

### Header labels (agreed after Step A)
- `columns` and `rows.groupBy` take `fieldId | { fieldId, label }`. The schema normalises both to
  `FieldRef = { fieldId, label? }` (label trimmed, max 100 chars, blank = no label, unknown keys rejected). The per-mode
  rules (no `metric.hours` in group sheets, no `worklog.*` in each-issue, a field once in group by) check the field id
  in either form. A repeated column keeps its first occurrence and label.
- Header = label, else the field name from `/api/fields`, else the field id (`refHeader`). Group subtotal columns are
  "Total <header>" (`totalHeader`). Used by the Excel header (Step C) and the preview header (Step E).
- Every `SheetResult` carries `headers: { groupBy: string[], columns: string[] }` (resolved on the server).
  `FlatSheetResult.columns` stays the field ids (parallel to cells); tree nodes key extra columns by field id.
- Starter presets (Step D) use labels matching the fixtures exactly (Author, Issue key, Parent, ...); Team Client Report
  uses "User" for the worklog author level.
- **Step E:** the sheet editor needs a label input on each column and each group level (placeholder = the field name).

### Step B (implementation decisions)
- `POST /api/custom-report` body = `{ filter: GlobalFilter, template: TemplateBody, requestId? }`; the site comes from
  `filter.site` or `?site=`. The old `{ filter, layout }` body is a 400 ("template" required). Response =
  `{ site, ...TemplateReport }` (sheets, worklogs, issues, complete, failedIssueKeys, failureReasons?, warnings, plus
  from/to/filter/template/fields/jql/timeZone/hoursPerDay/retrievedAt). Progress SSE, cancel, 409, 499, 504 and
  MAX_RANGE_DAYS are unchanged (shared `runs.ts`). The log line records the template name, sheet count and how many
  sheets have JQL.
- `generateCustomReport` and `issueFieldsToFetch` are removed. Their tests (`tests/custom-report.test.ts`) now run the
  same cases as one-sheet templates; the old global conditions/JQL cases moved to sheet conditions/JQL.
- Response worklogs keep `attributedTo` = the issue they were logged on (rollup is per sheet; tree nodes/rows carry the
  worklog ids for drill-down).
- The `CustomReport` type stays only for the old export route and the current UI; both go in Steps C/E. Until Step E
  the Custom Report tab still posts the old body and gets a 400 (Team Matrix unaffected).

### Sheet options (agreed after Step B)

**Group sheets**

New options:
- `totalColumns: 'everyLevel' | 'lastLevel'` (default `everyLevel`)
- `totalLabel` (default "Total"; blank = "Total"; max 100 chars)
- `subtotalRows: boolean` (default false)

Column layouts:
- `everyLevel` = the existing layout: Level / "Total <level>" pairs, extra columns, period columns, and a trailing
  total column only when there are period columns. That trailing column is headed `totalLabel`.
- `lastLevel` = level columns, extra columns, period columns, then one total column headed `totalLabel`.

Subtotal rows:
- Allowed only with `lastLevel` and `totals` on. Any other combination is a validation error.
- A bold row follows the last row of each parent group, deepest group first.
- Its first cell is in the parent's level column and reads "<label> Total" (Excel pivot style, fixed word).
- Extra columns stay empty. The period and total cells hold the group's sums.

Rows and totals:
- In every layout, parent values appear only on the first row of their group. The first row after a subtotal row
  shows only the levels that start a new group there.
- `totals: false` drops the grand Total row. It is not allowed together with subtotal rows.
- The grand Total row's first cell is always "Total"; `totalLabel` only names columns.

Other rules:
- On a flat sheet, `totalColumns`, `subtotalRows` and a non-default `totalLabel` are validation errors (same rule as `period`).
- `SheetResult.headers.total` = `totalLabel`.
- The pure table layout for every mode is in `src/services/custom/table.ts` (`groupTable` / `flatTable` / `sheetTable`;
  amounts in seconds). The Excel writer uses it now; the preview will use it in Step E.

**Each-issue sheets**

`includeIssuesWithoutWorklogs: boolean` (default false). Setting it to true on any other mode is a validation error.

The extra search:
- When the option is true, one extra search runs:
  `project in (<global projects>) [AND (<sheet JQL>)] ORDER BY key DESC`, with the same `fields=` as the main search.
- It has no date or author clause and makes no worklog calls.
- With no global projects, it uses every project the API user can see (`/project/search`), because Jira rejects
  unbounded JQL.
- Identical queries (same projects and JQL) run once per workbook.

Conditions:
- The sheet's conditions are applied **in code**, like all sheet conditions (Step A). They are not compiled into the
  extra JQL, so the extra search cannot fail on a condition that JQL does not support.
- Consequence: the 5000 cap counts issues before the conditions are applied.
- Issue-level conditions decide which extra issues are listed. Worklog-level conditions only narrow time: an issue
  with no matching time is still listed, with 0 hours.

Merging and the cap:
- Extra issues that pass are added with 0 hours, unless the sheet already has time on them.
- With rollup, an extra sub-task adds its parent's row.
- `MAX_ISSUES_WITHOUT_WORKLOGS` = 5000 issues per extra search, newest keys first (`searchIssuesLimited`).
- Hitting the cap adds a workbook warning naming the sheet. `complete` is unaffected.

Unchanged:
- The response `issues[]` is still only the issues time was logged on.
- Rollup / epic ancestor loading also covers the extra issues.

**Starter presets**

They live in `src/services/custom/presets.ts`:
- Fields are referenced by name. `resolveStarter` maps names to ids using the site's field list.
- A missing field gives a warning and its column is skipped.
- Step D wires them into the store.

The presets:
1. **"Time Reports style"**
   - Sheet "Report": group by Issue → Issue (Key Summary) → Status, with labels Issue / Summary / Status (as in
     Report 2.xlsx), totals on.
   - Sheet "Work logs": the 8 sample columns (`WORK_LOGS_SHEET`).
2. **"Team Client Report"**
   - Group by Worklog Author (label "User") → Issue (Key Summary) (label "Issue", as in the accepted Report 1.xlsx).
   - Column Client Reference.
   - `totalColumns: 'lastLevel'`, `totalLabel: 'Hours'`, `subtotalRows: false`.
3. **"Issue list"**
   - One each-issue sheet with the 10 Jira.csv columns (`ISSUE_LIST_SHEET`; "Parent" = Parent id).
   - `includeIssuesWithoutWorklogs: true`.

### Step C (implementation decisions)

**Route**
- `POST /api/custom-report/export` takes `{ report: <POST /api/custom-report response>, labels?: { projects, users } }`
  and returns one `.xlsx`.
- The workbook is built from the posted result only: no Jira calls, nothing written to disk.
- `?format=` and `view` are gone. A `?format=` in the URL is ignored.
- Validation (zod):
  - Each sheet result's `sheet` is re-parsed with `SheetSchema`, and the template with `TemplateBodySchema`.
  - Results must match the template sheets one-to-one: same name and mode, in order.
  - Only author names are read from `worklogs` (for the "Users:" line). Unknown keys (`issues`, `jql`, ...) are dropped.

**Worksheet layout**
- One worksheet per template sheet, named after it.
- Rows 1–6: the header block, with the same merges as Report 1.xlsx.
  - "Filters" = the global users, then this sheet's conditions and JQL in words, plus "Issues without time included"
    when that option is set.
  - "Report Time Format" follows the sheet's own `format`.
- Row 7 is blank, or holds the red incomplete warning (on every sheet).
- Row 8 is the table header. Panes are frozen at row 8 on every sheet, so flat sheets no longer freeze at row 1.

**Formatting**
- Header, subtotal and Total rows are bold.
- Columns are auto-sized, up to 60.
- Amounts are in the sheet's format, rounded to 2 decimal places.
- `worklog.started` / `worklog.created` data cells are Excel dates showing REPORT_TZ wall-clock time
  (`m/d/yyyy h:mm:ss AM/PM`).
- On flat sheets, the Total row (when shown) puts "Total" in the first column that is not Hours.

**Filename**
- `<Template name>_<from>_<to>[_INCOMPLETE].xlsx`.
- The template name keeps spaces and Unicode. These characters become "-": `\ / : * ? " < > |` and control characters.
- Leading and trailing dots and spaces are trimmed. An empty name becomes "Report".
- `Content-Disposition` carries an ASCII fallback plus `filename*=UTF-8''…`, so the browser should read `filename*`.

**Removed**
- Functions: `buildCsv`, `buildIssuesCsv`, `csvCell`, `jiraCsvCell`, `customExportFilename`, `exportFilenameFor`, `viewSlug`.
- The old `reportSheet` / `worklogSheet`, which were built on `CustomReport`.
- `buildCustomWorkbook`, replaced by `buildTemplateWorkbook`.
- In the Custom Report tab: the Export Excel / Export CSV / Export Issues CSV buttons and `postCustomExport`.
  Step E's Generate will post to the export route.

**Fixture tests**
- The group sheet is still compared cell for cell with Report 1.xlsx.
- The "Work logs" preset is compared with the Work logs sheets of Report 1 / Report 2. Their header row (row 1) is now
  our row 8; cell kinds and the date format are the same.
- Jira.csv becomes the "Issue list" preset. The xlsx header and cell values equal the CSV rows, newest key first, all
  with 0 hours via `includeIssuesWithoutWorklogs`.

### After Step C (agreed changes to "issues without time")
- **At least one global project is required.** A run with an each-issue sheet that has `includeIssuesWithoutWorklogs`
  and no global projects is rejected with 400 before any Jira call (`InvalidTemplateRunError`, from
  `checkIssuesWithoutWorklogs`): `Sheet "<name>" also lists issues without time, which needs at least one project.
  Pick one or more projects in the filter.` The "every visible project" fallback is removed.
- **JQL-expressible sheet conditions narrow the extra search.** This replaces "not compiled into the extra JQL" above.
  - Candidates (`jqlNarrowingConditions`): conditions on real Jira fields, compiled with the Step 2 `compileCondition`.
    Pseudo-fields (worklog.*, epic, issue.keySummary, parent.*, assignee.id, ...) stay code-only. `contains` stays
    code-only too: JQL `~` is a word search and can miss substrings the in-code check accepts.
  - All candidates of all such sheets are checked in one strict `/jql/parse` call (`acceptedJqlClauses`). A clause Jira
    rejects (e.g. `=` on a text field, an unknown value) is left out of the JQL and stays code-only. If Jira rejects the
    whole call with 400, all stay code-only. No call when there are no candidates.
  - Extra JQL = `project in (...) [AND (<clause>)]... [AND (<sheet JQL>)] ORDER BY key DESC`. Identical queries still run once.
  - Every condition is still re-checked in code, so the result is exact. The 5000 cap now counts issues after the
    JQL-compiled conditions, i.e. (mostly) issues that will be listed.
- Step C's (3) and (4): accepted as is.

### Step D (implementation decisions)

**Files**
- `src/services/templateStore.ts`: `TemplateStore` interface, `FileTemplateStore`, errors (404 / 409 / 403), `checkName`.
- `src/routes/templates.ts`: the five routes. Starter ids in `src/services/custom/presets.ts` (`builtin:<slug>`, `isBuiltinId`).
- Config `TEMPLATES_FILE` (default `data/templates.json`, relative to the working directory). `data/` is git-ignored.
  This file is the app's only disk write.
- No Step 7 views code existed, so there was nothing to convert.

**File and store**
- File = `{ "version": 1, "templates": Template[] }`, all sites in one file, pretty-printed.
- Atomic write: a temp file `.templates.json.<pid>.<uuid>.tmp` in the same folder, then rename over the target. A
  failed write or rename removes the temp file and leaves the old file untouched. On Windows a rename refused with
  EPERM / EACCES / EBUSY (antivirus, indexer) is retried up to 5 times. The folder is created on first write.
- Every store operation (reads too) runs in one in-process queue, so read-modify-write cannot interleave. The file is
  read on every operation (no cache), so a hand edit is picked up. One server process per file is assumed.
- Missing file = no templates; reads never create it.
- Corrupt file (not JSON, or not `{ version: 1, templates: [] }`; a UTF-8 BOM is fine): moved aside to
  `<file>.corrupt-<timestamp>`, a warning is logged, and the store starts empty. Nothing is deleted.
- An entry that does not validate (schema change, hand edit, duplicate id, a `builtin:` id) is not listed, is logged,
  and is written back unchanged on the next save.

**Rules**
- Names are unique per site, trimmed and case-insensitive (409). A saved template cannot take a built-in's name (409),
  so the dropdown never shows two with the same name.
- At most one default per site: `POST /:id/default` clears the others on that site. There is no "unset default";
  deleting the default leaves the site with none. Built-ins cannot be the default. With no default, Step E loads the
  first built-in.
- At most 200 saved templates per site (409).
- Conflict guard: `PUT` may send the `updatedAt` it loaded. If the stored one differs (someone else saved), 409
  "changed by someone else" (reload, or Save as). Without it, last write wins. Every save moves `updatedAt` on
  (strictly later, even within the same millisecond). Setting the default does not change `updatedAt`.
- Fields are not checked against `/api/fields` on save (no Jira call). Generate still rejects unknown fields with a 400
  naming the sheet.

**Routes**
- `GET /api/templates?site=` → `{ site, templates, warnings }`. `templates` = the 3 built-ins (preset order, resolved
  against the site's fields, `builtIn: true`, `isDefault: false`, `warnings` = fields the site lacks, no `updatedAt`),
  then the site's saved templates by name (`builtIn: false`). If the field list cannot be loaded, the saved templates
  are still returned, the built-ins are left out, and `warnings` says why.
- `POST /api/templates` body = `TemplateBody` plus optional `site` (else `?site=`, else the first site; unknown → 400)
  → 201 with the saved template. "Save as" from a built-in is this call with the built-in's body and a new name.
- `PUT /api/templates/:id` body = `TemplateBody` plus optional `updatedAt` → 200. The site cannot change.
- `DELETE /api/templates/:id` → 204. `POST /api/templates/:id/default` → 200 with the template.
- By-id routes ignore `?site=`. Unknown id → 404; a `builtin:` id → 403 "Built-in templates are read-only. Use "Save as"
  to make an editable copy."; invalid body → 400 (zod message). Store errors are sent as `{ error }` by the routes
  themselves.

### Step D changes (agreed after Step D)
These replace the Step D points above about the error handler, "no unset default", "built-ins cannot be the
default" and "fields are not checked on save".

**(1) Error handler**
- The root error handler is in `src/routes/errors.ts` (`installErrorHandler`). `buildServer` (moved to `src/app.ts`;
  `src/server.ts` only loads the config and listens) installs it **before** registering any route plugin, so it
  applies inside every plugin.
- A thrown error with a 4xx `statusCode` → that status and `{ error: message }`. A 5xx with `expose: true` (a message
  written for the user, e.g. Jira unavailable while checking fields) → that status and its message. Anything else →
  500 `{ error: 'Internal server error' }`, logged, message not sent. Fastify's own errors (bad JSON body, body too
  large) now have the same `{ error }` shape.
- The template routes' `storeCall` workaround is removed: they throw, and the handler answers.
- Tests: `buildServer` with a fake site client: a 400 thrown in a route plugin, store 404/403/409, bad JSON and an
  unexpected error. All existing route error tests pass unchanged.

**(2) Default = per-site pointer**
- Templates file v2: `{ "version": 2, "defaults": { "<site>": "<id>" }, "templates": [...] }`. Templates no longer
  carry `isDefault` on disk; the API computes it from the pointer.
- The pointer can name a saved template or a built-in (`builtin:*`), so a built-in can be the site default.
- A v1 file is read as before; its (first) flagged template per site becomes the pointer, and the next save writes v2.
- A pointer to a template that no longer exists (hand edit) is ignored. Deleting the default template clears the
  pointer. Setting a default does not change any `updatedAt`.
- `POST /api/templates/:id/default` → 200 `{ site, defaultId }`. A saved template uses its own site (`?site=`
  ignored). A built-in uses `?site=` (else the first site; unknown site → 400; unknown `builtin:` id → 404).
- `GET /api/templates` adds `defaultId` (when set) and marks the matching item, built-in or saved, `isDefault: true`.

**(3) Unset default**
- `DELETE /api/templates/:id/default` → 204, with the same site rule as setting it. It clears the site's pointer only
  if it is `id`; otherwise it changes nothing. Unknown saved id → 404.
- With no default, the tab opens the first built-in.

**(4) Field ids checked on save**
- `POST` and `PUT /api/templates` check every field the body uses (group levels, columns, conditions) against the
  site's `/api/fields` list (the 10-minute FieldCache). An unknown field → 400
  `Sheet "<name>": unknown field(s): <ids>. Pick fields from the list.` This is the same check and message as Generate
  (`checkTemplateFields` in `src/services/customReport.ts`).
- If the field list cannot be loaded, the save is refused with Jira's status (502/503/...) and
  `Could not check the template's fields. <reason>`. Nothing is saved.
- `PUT` checks against the template's own site. It answers 403 (built-in) or 404 (unknown id) before any Jira call. A
  template whose site is no longer configured is saved without the check.

### Step E (implementation decisions)

**Files**
- `web/custom/tab.ts`: orchestration (lists, template bar, Generate, preview, download).
- `web/custom/editor.ts`: the sheet editor (DOM).
- `web/custom/preview.ts`: the preview (DOM).
- `web/custom/template-logic.ts`: pure rules (draft ⇄ TemplateBody, validation, request body, filename).
- `web/custom/logic.ts` keeps fields, conditions, tree helpers and amounts. `buildRequest` / `FormState` are removed,
  and `nodeDrilldown(worklogs, ids, period, periodKey?)` now works per sheet.
- `web/api.ts`: template CRUD/default calls, `postCustomReport` (new body), `postCustomExport`.
- Tests: `tests/custom-template-ui.test.ts`. `tests/custom-ui.test.ts` was updated, and its limits are synced with
  template.ts.
- The old `CustomReport` type (single layout) is removed from `result.ts`.

**Top bar**
- Filter: From/To, Projects, Users. The site is in the header, as before.
- Template dropdown: "Built-in (read-only)" group, "Saved" group, then "+ New template". The default is marked
  "★ default". A blue dot next to the dropdown means unsaved changes.
- Buttons: Save, Save as…, Rename…, Delete, Set default / Unset default.
  - On a built-in, only Save as and Set/Unset default are enabled.
  - Save on a new template asks for a name (it acts as Save as).
  - Save sends the loaded `updatedAt`, so a 409 "changed by someone else" is shown as is.
  - Rename renames the saved version only. Unsaved edits stay unsaved.
  - Delete asks for confirmation, then opens the default template (else the first built-in).
  - Names are asked with `prompt()` and deletes confirmed with `confirm()`, like Favourite Groups.
- **Projects and Users are the template's `defaults`.** Opening a template fills them in. Save / Save as store the
  current Projects and Users. Changing them therefore lights the unsaved dot. The note under the bar says so.
- Switching template (or to "New") with unsaved changes asks for confirmation. Leaving the page with unsaved changes
  triggers the browser's "leave site?" prompt.
- A site switch clears everything without asking, including unsaved changes. The site switcher is locked only while
  generating.

**Sheet editor**
- Left: the sheet list (name and row mode), with "+ Add sheet" (max 10).
- Right: the selected sheet.
  - Name, with live Excel-rule errors and a duplicate-name warning.
  - Rows mode: Grouped (tree) / One row per worklog / One row per issue.
  - ↑ ↓ reorder, Duplicate (copy right after it, with a free name such as "Report (2)"), Delete (asks; the last
    sheet cannot be deleted).
- Group by: 1–3 levels. Columns: up to 20.
  - Each row: searchable field picker, label input (placeholder = the field name; blank = the field name), ↑ ↓ ×.
  - Pickers only offer fields the mode allows: no Hours in group sheets, no `worklog.*` in each-issue sheets, no
    Hours in conditions. A field is used once per list.
- Mode switch: columns the new mode cannot show are removed, with a notice. An empty flat sheet gets Hours. Group
  levels are kept for switching back.
- Options per mode:
  - All modes: Totals, Format, Sum sub-tasks into parent (ⓘ tooltip as before).
  - Group: Period, Sort, Total columns, Total label (placeholder "Total"), and Subtotal rows. Subtotal rows is
    disabled unless Total columns is "One total column" and Totals is on.
  - Each-issue: Include issues without time.
- Options that do not apply to the mode are sent as their defaults, so a hidden option never fails validation.
- Sheet filters: condition rows (as in Phase 8: user picker for user fields, comma lists for "is one of") and a
  "Sheet JQL" box.
- The editor is locked while generating.

**Generate**
- The browser checks the global filter and the template first, and names the sheet in its messages:
  - From/To and MAX_RANGE_DAYS.
  - Sheet names and duplicates.
  - Group levels, flat columns, and condition values.
  - Issues without time need a project.
- It posts `{ filter, template: <the editor's draft> }`. Unsaved edits are used, and the summary says "(unsaved
  changes)".
- Then it posts the result to `/api/custom-report/export` and downloads the file, named from `filename*`.
  - `labels` = names of the selected projects and users only.
  - If the export fails, the preview stays and the error says so.
- Progress, Cancel, incomplete + Retry (generates and downloads again), and warnings work as before.

**Preview**
- One tab per sheet, showing the sheet name and its total (←/→ switch).
- Group sheets show the tree.
  - Header = level headers joined with ›, the extra columns, the periods, and the total column (headed with the
    total label).
  - The Total row appears only with totals on.
  - Expand/Collapse all.
- Flat sheets show a table built by `flatTable` from `src/services/custom/table.ts`, the same layout as the .xlsx.
  - Hours are formatted in the sheet's format.
  - `worklog.started` / `created` are shown as dd-MMM-yyyy HH:mm:ss in REPORT_TZ.
  - Issue key / Parent key cells link to Jira.
  - At most 2000 rows are shown, with a note. The .xlsx has them all.
- Drill-down: any non-zero amount opens the shared modal.
  - Tree: the node, or the node × period.
  - Flat: that row; the title is the row's first two text cells.
  - Total row: the sheet's worklogs (not the whole workbook's).

**Other**
- `web/combobox.ts` `onOutside`: once its picker has been removed from the page (editor re-renders), the
  document listener removes itself.

### Summary sheet options (agreed after Step E)

The team added a "Summary" sheet to the Team Client Report. Their sample is `tests/fixtures/Report_1.xlsx`. The older
`Report 1.xlsx` fixture stays as the accepted format of the standard layout.
Code: `src/services/custom/text.ts` (pure; used by the server and the preview), `template.ts`, `engine.ts`,
`sheets.ts`, `table.ts`, `export.ts`, `customExcel.ts`, `presets.ts`, `web/custom/*`.
Tests: `tests/custom-sheet-options.test.ts`.

**1. Count columns (group sheets)**
- `metric.issueCount` ("Issue Count") counts the distinct issues in the row. It counts after rollup, so a sub-task
  rolled into its parent counts as the parent.
- `metric.worklogCount` ("Worklog Count") counts the worklogs in the row.
- Both are extra columns: they sit in the `columns` list, in order, and can have a label.
- Group sheets only, the same as Hours, which is for flat sheets only. They can't be a group level, a condition, or
  have `extract`.
- Every tree node carries `issueCount` and `worklogCount`, and so does the tree itself.
  - Subtotal rows show the group's counts.
  - The Total row shows the tree's counts. Its issue count is the number of distinct issues overall, not the sum of
    the rows.
  - Text extra columns stay blank in subtotal and Total rows.
- In Excel, counts are plain numbers, never converted to hours or days. In the preview they are right-aligned.

**2. Header style** (`headerStyle`, default `standard`)
- `standard`: no change. Rows 1–6 are the block, row 7 is blank or the warning, and the table starts at row 8.
- `title`:
  - Row 1 is the title (bold, 14 pt). Row 2 is the subtitle (9 pt), or empty.
  - Row 3 is blank, or the red incomplete warning.
  - The table header is row 4, and the sheet is frozen there.
  - A title is required for this style. Title and subtitle are ≤200 chars each.
  - Title and subtitle are rejected with any other style. The editor keeps them in the draft but doesn't send them.
- `none`: the table header is row 1. If the report is incomplete, row 1 is the warning, row 2 is blank, and the table
  starts at row 3. A partial report is never shown without the warning.
- Placeholders in the title and subtitle:
  - `{projects}`: the project names (labels, as in the Projects row), or "All projects".
  - `{from}`, `{to}`: yyyy-MM-dd.
  - `{tz}`: REPORT_TZ.
  - `{site}`: the host of the report's Jira site (for example `pm23.atlassian.net`). If no URL is known, the site key.
  - `{generated}`: retrievedAt in REPORT_TZ, as `dd-MMM-yyyy HH:mm`.
  - `{users}`: the selected users' names, or "All users".
  - Anything else in braces is left as typed.
- The preview shows the filled title and subtitle above the table. The export route passes the site URL.

**3. Notes** (`notes: string[]`)
- ≤10 lines, each ≤500 chars. Lines are trimmed, and blank lines are dropped.
- Excel, after the last table row: one blank row, a bold "Notes" heading in column A, then one line per row in column A.
  Notes are not merged, and they don't count toward column widths.
- The preview shows the notes under the table. The editor uses one textarea, one note per line.
- The sample's "•" bullets are not added. Type them if you want them.

**4. Extract** (`{ fieldId, label?, extract? }` on a column or group level)
- The pattern is a JavaScript regex, with no flags. It is trimmed, and blank means none. ≤200 chars.
- Server and browser reject a pattern that doesn't compile, and the error names the sheet and the column.
- Result rules:
  - If the pattern has a group 1 and it matched, the value is group 1.
  - Otherwise the value is the whole first match.
  - No match, or an empty match, leaves the value unchanged.
- It applies to the displayed value (the label) before grouping.
  - For a group level, the extracted text becomes both the group identity and its label. So a URL and the plain
    `TPX-1378` land in one group.
  - For a group sheet's extra column, it applies before the "(multiple)" check.
  - In flat sheets, it applies to text cells only. Hours stays a number.
- Conditions still match the original values.

**5. `mergeGroupCells`** (group sheets, default false)
- Excel only; the preview is a tree.
- Each parent level's value is merged vertically down its group's rows, top-aligned. With everyLevel, its
  "Total <level>" cell is merged the same way.
- Groups of one row are not merged.
- With subtotal rows, the merge covers the group's data rows and any inner subtotal rows. Its own "<group> Total" row
  is outside the merge.

**Team Client Report starter**
- Sheet "Report":
  - Worklog Author "User" → Issue (Key Summary) "Issue".
  - Column Client Reference "Client Reference", with extract `TPX-\d+`.
  - lastLevel, total label "Hours".
  - Standard header, no subtotal rows, no merge.
- Sheet "Summary":
  - Worklog Author "User". Column Issue Count "Issues".
  - lastLevel, total label "Spent Hours".
  - Title style: "{projects} — Worklog Summary". Subtitle: "Period: {from} – {to} · Time zone: {tz} · Source: {site},
    worklog started date · Generated {generated}".
  - The two agreed notes.
- On a site without "Client Reference", the Report column is skipped with a warning, as before. Summary is unaffected.

**"Field names instead of labels" check**
- The report in question showed "Worklog Author" / "Total Worklog Author". Its Report sheet has the same
  "Generated on" (2026-10-07T06:09:19-04:00) as `tests/fixtures/Report 1.xlsx`. It was made by the Phase 8 exporter,
  before labels and totalColumns existed, so it was never a template run.
- A template run uses the labels: the saved "IIA Report" run of 2026-10-08 shows User | Issue | Client Reference |
  Hours.
- A regression test runs the starter through `runTemplate` and the Excel layout:
  `custom-sheet-options.test.ts` › "labels are applied".
- No code change was needed for labels.
