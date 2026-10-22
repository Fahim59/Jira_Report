# Phase 8 — Custom Report Builder

Read CLAUDE.md first. Add a new **Custom Report** tab next to the existing matrix. The existing matrix, its routes, and its Excel export must not change. Work step by step. After each step: run `npm test` and `npx tsc --noEmit`, then stop and report what changed. Windows/PowerShell: no `&&`.

## Goal
Users build any worklog report without code changes. They:
- filter by any Jira field (custom fields included) or raw JQL
- group by 1–3 fields
- add extra columns
- optionally split time by day, week or month
- save views shared with everyone
- export to Excel and CSV

No auth or permissions: views are visible and editable by everyone.

## Design rules
- Pure logic (JQL compiler, value normalizer, tree builder, Excel layout) lives in `src/services/custom/` with **no Node or Fastify imports**, so it can move to the browser later (Forge port).
- Reuse the existing pieces:
  - Jira client, pagination, concurrency
  - `started` → REPORT_TZ date logic
  - SSE progress, timeout (504), cancel, `complete=false` + `failedIssueKeys`
  - safe logging and friendly errors
  - drill-down modal and searchable pickers
- No hard-coded field IDs. Resolve fields by ID from `/rest/api/3/field` per site.
- Strict TypeScript and zod for every request body. No new dependencies unless unavoidable (say why).

## Step 1 — Field discovery + value normalizer
- `GET /api/fields?site=`
  - Calls `/rest/api/3/field` and returns `{id, name, custom, schemaType}[]`, sorted by name.
  - Cached in memory per site with a 10-minute TTL.
  - Also returns these pseudo-fields:
    - Worklog: `worklog.author`, `worklog.date`, `worklog.comment`, `worklog.created`
    - Issue: `issue.key`, `issue.keySummary` (displays "KEY Summary", as in the team's sample export)
    - Standard fields: `parent`, `epic`, `project`, `issuetype`, `status`, `assignee`
- `normalizeFieldValue(raw, schemaType): string`:
  - null → `""`
  - string or number → as is
  - option → `.value`
  - user → `.displayName`
  - array → items joined with `", "`
  - other objects → `name` / `key` / `value` / `displayName` fallback
  - ADF → plain text
- Tests: every branch above.

## Step 2 — Filter model + JQL compiler
Filter (zod):
```
{ site, from, to, projects: string[], authors: string[],
  conditions: { fieldId, op: 'is'|'isNot'|'in'|'notIn'|'contains'|'isEmpty'|'isNotEmpty', value?: string|string[] }[],
  jql?: string }
```
- Issue-field conditions compile to JQL:
  - Custom fields use `cf[12345]`.
  - Escape quotes and backslashes.
  - `contains` maps to `~`.
  - Empty checks map to `is EMPTY` / `is not EMPTY`.
- Worklog-level conditions (`worklog.author`, `worklog.date`) are applied after fetching.
- Final JQL = existing worklogDate/project/author JQL `AND (compiled conditions) AND (user jql)`.
- Validate the user's JQL with `POST /rest/api/3/jql/parse`. Invalid JQL returns 400 with Jira's message.
- Tests: escaping, `cf[]` IDs, every operator, combined output, injection attempts (`") OR project = X`).

## Step 3 — Report engine (tree builder)
Layout (zod):
```
{ groupBy: fieldId[1..3], columns: fieldId[], period: 'none'|'day'|'week'|'month',
  format: 'hours'|'days', sumSubtasksToParent: boolean, sort: 'value'|'totalDesc' }
```
**Retrieval**
- Add `fields=` to the issue search: union of groupBy, columns, condition fields, plus `parent`, `issuetype`, `summary`, `status`.
- No extra calls per issue.

**Sub-task rollup** (when `sumSubtasksToParent` is on)
- Attribute sub-task worklogs to the parent issue.
- Fetch missing parents in one batch (`key in (...)`, chunked).
- Use the parent's field values.

**Output tree**
```
Node { fieldId, value, label, total, periods: Record<periodKey, number>,
       columns: Record<fieldId, string>, worklogIds: string[], children: Node[] }
```
- Grand total plus `periodKeys` (dates are REPORT_TZ calendar dates; weeks are ISO weeks).
- Extra column value per node: the shared value if all issues under the node agree, otherwise `"(multiple)"`.
- Days format: `HOURS_PER_DAY` env, default 8. Add it to `.env.example`.
- Tests:
  - 1, 2 and 3 levels
  - subtotals add up to the grand total
  - periods
  - TZ day boundaries
  - rollup
  - `(multiple)`
  - empty values grouped as `"(none)"`

## Step 4 — Routes
- `POST /api/custom-report`: filter + layout. Returns the tree, the worklogs, `complete`, `failedIssueKeys`.
- SSE progress, timeout, cancel, MAX_RANGE_DAYS and the double-submit guard all behave exactly like `/api/report`.

## Step 5 — UI (`web/custom/*.ts`)
**Tabs**
- Tabs: "Team Matrix" (existing) | "Custom Report".
- Site switcher, date range and pickers are shared or reused.

**Filter panel**
- Projects (multi-select) and users (multi-select).
- "+ Add filter" rows: searchable field picker → operator → value. User-type fields reuse the user picker.
- "Advanced JQL" toggle with a textarea.
- **Search** button.

**Layout panel**
- Group by: up to 3 searchable selects, reorderable.
- Extra columns: searchable multi-select.
- Period, format, "Sum sub-tasks into parent", sort.

**Results**
- Collapsible tree table showing level value, subtotal, extra columns, period columns and total.
- Grand total row.
- Issue keys link to Jira.
- Clicking any total opens the existing drill-down modal with that node's worklogs.
- Partial results show the same warning as the matrix.

## Step 6 — Export (built in memory from the displayed result, like the existing export)
**Excel, sheet "Report"** (match the team's sample `Worklog-Report_1.xlsx`)
- Header block in rows 1–6, labels in merged A:B, values from C:
  - From / To
  - Projects
  - Filters (human-readable conditions + JQL)
  - Time Zone
  - Generated on (ISO with offset)
  - Report Time Format
- Blank row, then the table header.
- Each group level gets 2 columns: `<Level name>`, `Total <Level name>`.
- Then the extra columns, then the period columns (if any), then Total.
- A parent level's value and total appear only on the first row of its group.
- Last row is `Total` with the grand totals.
- Formatting: bold header, frozen panes below the header, number format `0.##`, auto column widths (max 60).

**Excel, sheet "Work logs"**
- Columns: Author, Issue, Issue Summary, Work log started, Work log created, Work log time zone, Time spent, Work log comment, then the selected extra columns.

**CSV**
- Flat leaf rows with every level value filled in.
- UTF-8 with BOM.

**General**
- Filename: `Custom-Report_<view>_<from>_<to>.xlsx|csv`.
- Tests: cell positions and values for a 3-level fixture.

## Step 7 — Saved views (shared, no auth)
- Store: `data/views.json`. Path set by `VIEWS_FILE`; add it to `.env.example`, and add `data/` to `.gitignore`.
- Behind a `ViewStore` interface (a Forge storage implementation comes later).
- Writes are atomic: temp file, then rename. Handle a missing or corrupt file gracefully.
- View: `{ id, site, name, filter (without from/to), layout, isDefault, updatedAt }`. The name must be unique per site, and there is at most one default per site.
- Routes:
  - `GET /api/views?site=`
  - `POST /api/views`
  - `PUT /api/views/:id`
  - `DELETE /api/views/:id`
  - `POST /api/views/:id/default`
- UI views bar: dropdown, Save, Save as, Rename, Delete, Set default. The default view loads when the tab opens.
- Tests: CRUD, uniqueness, single default, atomic write, corrupt file.

## Acceptance
1. **View A** = Project FFN, 2026-09-01..2026-09-29, group by Issue → keySummary → Status, period none, Excel export.
   - The table equals the sample `Worklog-Report_1.xlsx`, grand total 600h, when the same TZ is used.
2. **View B** = group by worklog.author → issue.key, columns Client Reference, Hours.
   - Shows User → issue rows with the Client Reference value and per-user subtotals.
3. Filter `Client Reference contains "TPX-65"` returns only matching issues.
4. Invalid JQL shows Jira's error message. A partial failure is never shown as complete.
5. The existing matrix, its export, and all old tests are unchanged and passing.

---

## Agreed clarifications (added during implementation)
- **Epic** = nearest Epic ancestor via the parent chain (sub-task → story → epic), resolved in Step 3 with batched
  parent/grandparent fetches. No "Epic Link" custom field support for now.
- **Normalizer extras:** booleans → "Yes"/"No"; cascading select → "Parent - Child"; empty array items dropped.
- **isNot / notIn** compile to `(field != X OR field is EMPTY)` / `(field not in (...) OR field is EMPTY)` so empty values
  are not silently dropped.
- **JQL validation** is strict (`/jql/parse?validation=strict`): unknown fields or values → 400 with Jira's message.
- **User JQL** must have balanced parentheses and closed strings, and no ORDER BY, before it is embedded as `AND (...)`.
- **contains** uses Jira's text search (`~`) to narrow the search, then is re-checked in code (case-insensitive substring)
  on the fetched value, so Jira's fuzzy/word matching cannot add false positives.
- Post-fetch pseudo-fields (`worklog.*`, `issue.keySummary`, `epic`) are filtered in code, not JQL.
- **An Epic counts as its own epic:** time logged directly on an Epic groups under that Epic, not "(none)".
- **Unloadable parent/epic** (deleted, moved or no permission): the time is not dropped. It is grouped under
  "KEY (unavailable)" (KEY = the issue that could not be loaded) for every issue field taken from it, the response gets a
  `warnings[]` entry naming it and the affected issues, and `complete` stays true. Only failed worklog fetches (or
  unparseable worklog dates) make a report incomplete. A parent chain deeper than 5 levels is treated the same way.
- **Conditions apply to the issue the time was logged on** (as Jira's JQL sees it), not the rollup parent: with rollup on,
  "Status = Done" keeps a Done sub-task even if its parent is not Done. Step 5: explain this in a tooltip on
  "Sum sub-tasks into parent".
- **Tree totals are in seconds;** hours/days conversion happens only for display/export, so subtotals add up exactly.
  The response carries `hoursPerDay`.
- **`worklog.created`** groups by its calendar date in REPORT_TZ, not the full timestamp.
- **Step 4 request shape:** `POST /api/custom-report { filter, layout, requestId? }` (site = `filter.site` or `?site=`).
  Progress/cancel: `/api/custom-report/progress/:id` and `/api/custom-report/:id/cancel`. One run registry is shared with
  `/api/report`, so a requestId is unique across both reports.
- **Step 5 UI choices:** From/To are the tab's own inputs (same defaults as the matrix); the site switcher is shared and
  locked while either tab is generating. `warnings[]` shows as a non-blocking "Note" list above the results; incomplete
  reports use the matrix's "⚠ Incomplete report" + Retry. The rollup checkbox has an ⓘ tooltip with the decision-3 rule.
  Drill-down from a node lists all worklogs under it (the original issue keys, so rolled-up sub-tasks are visible).
- **Step 6 export choices:** route `POST /api/custom-report/export?format=xlsx|csv` with `{ report, view?, labels? }`
  (`labels` = project/user display names from the browser; the report carries keys/accountIds only). Like the sample, there
  is no trailing Total column when period = none (the deepest "Total <level>" is the row total). Amounts are rounded to
  2 decimals with General format instead of `0.##` (Excel shows `6.` for whole numbers with `0.##`). Work log dates are
  real Excel dates showing REPORT_TZ wall-clock time. An incomplete report gets a red warning in row 7 and `_INCOMPLETE`
  in the filename. CSV text starting with = + - @ is prefixed with `'` (formula injection).
- **Step 6 fixtures (tests/fixtures):** `Report 1.xlsx` is the accepted Excel format (our output; kept cell for cell),
  `Report 2.xlsx` the original team sample (table structure only), `Jira.csv` the format of a third export,
  **Issues CSV** (`format=issues`): Jira's issue-export columns, one row per issue time was logged on in the report,
  key descending, no BOM, LF line ends, Jira's quoting (no formula escaping, to stay identical to Jira's file).
