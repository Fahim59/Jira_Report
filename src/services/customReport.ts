import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { JiraClient } from '../jira/client.js';
import { fetchIssuesByKeys, searchIssuesLimited, searchIssuesWithFields } from '../jira/custom.js';
import { shortFailureReason } from '../jira/errors.js';
import { acceptedJqlClauses, validateSheetJql } from '../jira/jql.js';
import { listProjects } from '../jira/projects.js';
import { fetchAllWorklogs, startedWindow } from '../jira/worklogs.js';
import type { IssueInfo, JiraWorklog } from '../types.js';
import {
  compareIssueKeysDesc,
  findEpic,
  issueRow,
  missingAncestorKeys,
  summaryOf,
  ValueResolver,
  type CustomIssue,
  type CustomWorklog,
  unavailableLabel,
} from './custom/engine.js';
import { adfToText, type FieldInfo } from './custom/fields.js';
import { compileCondition, compileFilter, jiraFieldId, jqlNarrowingConditions, jqlString } from './custom/filter.js';
import type { TemplateReport } from './custom/result.js';
import { runTemplate, sheetAcceptsIssue, sheetWorklogs, type TemplateData } from './custom/sheets.js';
import {
  isTimeZone,
  MAX_ISSUES_WITHOUT_WORKLOGS,
  sheetFieldIds,
  templateFieldIds,
  type GlobalFilter,
  type Sheet,
  type TemplateBody,
} from './custom/template.js';
import { reportDate } from './normalize.js';
import { dateRange, startDeadline, summarizeFailures, UnknownProjectError, type GenerateHooks, type GenerateOptions } from './report.js';

/** Always requested: hierarchy (epic, rollup), display (summary), worklog project, Issues CSV (assignee). */
export const BASE_ISSUE_FIELDS = ['summary', 'parent', 'issuetype', 'status', 'project', 'assignee'] as const;
/** Parent-chain depth limit when looking for an Epic (sub-task → story → epic needs 2). */
const MAX_ANCESTOR_ROUNDS = 5;

/** A field id that is not in the site's /api/fields list (HTTP 400). */
export class UnknownFieldError extends Error {
  override readonly name = 'UnknownFieldError';
  readonly statusCode = 400;
}

/** Every field the template uses must be in the site's field list; else UnknownFieldError naming the sheet and field. */
export function checkTemplateFields(template: Pick<TemplateBody, 'sheets'>, siteFields: readonly FieldInfo[]): void {
  const known = new Set(siteFields.map((f) => f.id));
  for (const sheet of template.sheets) {
    const unknown = sheetFieldIds(sheet).filter((id) => !known.has(id));
    if (unknown.length) throw new UnknownFieldError(`Sheet "${sheet.name}": unknown field(s): ${unknown.join(', ')}. Pick fields from the list.`);
  }
}

/** A template run the global filter cannot support (HTTP 400). */
export class InvalidTemplateRunError extends Error {
  override readonly name = 'InvalidTemplateRunError';
  readonly statusCode = 400;
}

/** Issue keys listed per warning before "and N more". */
const WARNING_KEYS = 10;

function listKeys(keys: readonly string[]): string {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shown = sorted.slice(0, WARNING_KEYS).join(', ');
  return sorted.length > WARNING_KEYS ? `${shown} and ${sorted.length - WARNING_KEYS} more` : shown;
}

type Cfg = Pick<Config, 'REPORT_TZ' | 'JIRA_CONCURRENCY' | 'MAX_RANGE_DAYS' | 'HOURS_PER_DAY'>;

/** Base fields plus the Jira fields behind `used` (pseudo-fields are computed from the base fields or worklogs). */
export function jiraFieldsFor(used: Iterable<string>): string[] {
  const real = [...used].map(jiraFieldId).filter((id): id is string => id !== undefined);
  return [...new Set([...BASE_ISSUE_FIELDS, ...real])];
}

function zoned(iso: string | undefined, zone: string): string {
  return (iso && reportDate(iso, zone)) || '';
}

/** One warning per unloadable parent/epic that some reported time depends on, naming the issues affected. */
function unavailableWarnings(
  entries: ReadonlyArray<{ w: CustomWorklog; epic: boolean }>,
  issues: ReadonlyMap<string, CustomIssue>,
  unavailable: ReadonlySet<string>,
): string[] {
  if (!unavailable.size) return [];
  const affected = new Map<string, Set<string>>();
  const note = (missing: string | undefined, issueKey: string) => {
    if (!missing || !unavailable.has(missing)) return;
    if (!affected.has(missing)) affected.set(missing, new Set());
    affected.get(missing)!.add(issueKey);
  };
  for (const { w, epic } of entries) {
    note(issues.has(w.attributedTo) ? undefined : w.attributedTo, w.issueKey);
    if (epic && issues.has(w.attributedTo)) note(findEpic(w.attributedTo, issues).missing, w.issueKey);
  }
  return [...affected]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(
      ([key, from]) =>
        `${key} could not be loaded (deleted, moved or no permission). Time logged on ${listKeys([...from])} is grouped under "${unavailableLabel(key)}".`,
    );
}

// ---- Phase 8b: templates (one fetch, N sheets) ----

/** JQL that narrows the global search for a sheet (keys only). */
export function sheetSearchJql(globalWhere: string, sheetJql: string): string {
  return `${globalWhere} AND (${sheetJql}) ORDER BY key ASC`;
}

/**
 * Extra issue search of an each-issue sheet with includeIssuesWithoutWorklogs: the global projects, the sheet's
 * conditions that JQL can express (`conditionClauses`, each already accepted by Jira's parser) and the sheet's JQL;
 * no date or author restriction. Newest first, so the cap keeps the newest issues. Every condition is still
 * re-checked in code, so the clauses only make the cap count (mostly) issues that will be listed.
 */
export function issuesWithoutWorklogsJql(
  projectKeys: readonly string[],
  sheetJql: string | undefined,
  conditionClauses: readonly string[] = [],
): string {
  const where = [
    `project in (${projectKeys.map(jqlString).join(', ')})`,
    ...conditionClauses.map((c) => `(${c})`),
    ...(sheetJql ? [`(${sheetJql})`] : []),
  ];
  return `${where.join(' AND ')} ORDER BY key DESC`;
}

/** Issues without time are searched in the global projects only: an unbounded issue search is not allowed. */
export function checkIssuesWithoutWorklogs(filter: Pick<GlobalFilter, 'projects'>, sheets: readonly Sheet[]): void {
  const sheet = sheets.find((s) => s.includeIssuesWithoutWorklogs);
  if (sheet && !filter.projects.length) {
    throw new InvalidTemplateRunError(
      `Sheet "${sheet.name}" also lists issues without time, which needs at least one project. Pick one or more projects in the filter.`,
    );
  }
}

const issueCapWarning = (sheet: string) =>
  `Sheet "${sheet}": more than ${MAX_ISSUES_WITHOUT_WORKLOGS} issues match without the date range, so only the newest ${MAX_ISSUES_WITHOUT_WORKLOGS} are listed. Narrow the projects or the sheet's JQL.`;

/**
 * Template pipeline, one Jira fetch for all sheets:
 * validate → global JQL search (fields = union of every sheet's fields) → one keys-only search per distinct sheet JQL →
 * batched ancestor loads (epic / rollup) → worklogs (bounded concurrency) for issues at least one sheet can use →
 * REPORT_TZ dates + author filter → each sheet narrows the result in code and runs the engine on its subset.
 * Incompleteness and warnings apply to the whole workbook.
 */
export async function generateTemplateReport(
  client: JiraClient,
  cfg: Cfg,
  siteFields: readonly FieldInfo[],
  filter: GlobalFilter,
  template: TemplateBody,
  hooks: GenerateHooks = {},
  opts: GenerateOptions = {},
): Promise<TemplateReport> {
  const zone = filter.zone === 'user' ? filter.userZone! : cfg.REPORT_TZ;
  dateRange(filter.from, filter.to, cfg.MAX_RANGE_DAYS);
  checkIssuesWithoutWorklogs(filter, template.sheets);

  checkTemplateFields(template, siteFields);
  const byId = new Map(siteFields.map((f) => [f.id, f]));
  const usedIds = templateFieldIds(template);
  const schemaTypes = new Map(siteFields.map((f) => [f.id, f.schemaType]));

  const deadline = startDeadline(opts);
  const { signal } = deadline;
  try {
    signal.throwIfAborted();

    hooks.onStage?.('validating');
    let projects = filter.projects;
    if (projects.length) {
      const known = new Map((await listProjects(client, { signal })).map((p) => [p.key.toUpperCase(), p.key]));
      const bad = projects.find((p) => !known.has(p.toUpperCase()));
      if (bad) throw new UnknownProjectError(bad);
      projects = [...new Set(projects.map((p) => known.get(p.toUpperCase())!))];
    }
    const effective: GlobalFilter = { ...filter, projects };
    const compiled = compileFilter({ ...effective, conditions: [], jql: undefined });
    await validateSheetJql(client, compiled.where, template.sheets.map((s) => ({ name: s.name, jql: s.filter.jql })), { signal });

    hooks.onStage?.('searching');
    const fields = jiraFieldsFor(usedIds);
    const found = await searchIssuesWithFields(client, compiled.jql, fields, { signal });
    const jqlKeys = new Map<string, Set<string>>();
    for (const jql of new Set(template.sheets.map((s) => s.filter.jql).filter((j): j is string => !!j))) {
      const hits = await searchIssuesWithFields(client, sheetSearchJql(compiled.where, jql), ['key'], { signal });
      jqlKeys.set(jql, new Set(hits.map((i) => i.key)));
    }
    const issues = new Map<string, CustomIssue>(found.map((i) => [i.key, i]));
    const extra = await searchIssuesWithoutWorklogs(client, template.sheets, projects, fields, signal);
    for (const i of extra.issues) if (!issues.has(i.key)) issues.set(i.key, i);
    const additional = await searchExtraJqlIssues(client, template.sheets, projects, fields, signal);
    for (const i of additional.issues) if (!issues.has(i.key)) issues.set(i.key, i);
    hooks.onIssues?.(found.length);

    const need = { epic: usedIds.includes('epic'), rollup: template.sheets.some((s) => s.sumSubtasksToParent) };
    const unavailable = await loadAncestors(client, [...issues.values()], issues, fields, need, signal);
    const resolver = new ValueResolver(issues, schemaTypes, unavailable);

    // Issues no sheet can use (sheet JQL / issue-level conditions) get no worklog calls.
    const wanted = found.filter((i) => template.sheets.some((s) => sheetAcceptsIssue(s, i.key, { jqlKeys, resolver })));

    hooks.onStage?.('worklogs');
    const reasons: string[] = [];
    // Each author's own calendar can put a worklog a day either side of REPORT_TZ's: ask Jira for a wider window.
    const window =
      filter.zone === 'author'
        ? startedWindow(shiftDate(filter.from, -1), shiftDate(filter.to, 1), zone)
        : startedWindow(filter.from, filter.to, zone);
    const fetched = await fetchAllWorklogs(client, wanted.map(issueInfo), window, {
      concurrency: cfg.JIRA_CONCURRENCY,
      signal,
      onProgress: hooks.onWorklogProgress,
      onError: (key, err) => {
        reasons.push(shortFailureReason(err));
        hooks.onWorklogError?.(key, err);
      },
    });
    const failed = new Set(fetched.failedIssueKeys);

    hooks.onStage?.('processing');
    const all = toCustomWorklogs(fetched.issues, filter, zone, filter.zone === 'author', hooks, failed, reasons);
    signal.throwIfAborted();

    const fieldNames = new Map(siteFields.map((f) => [f.id, f.name]));
    const data: TemplateData = {
      from: filter.from,
      to: filter.to,
      timeZone: zone,
      worklogs: all,
      resolver,
      fieldNames,
      jqlKeys,
      issuesWithoutWorklogs: extra.bySheet,
      extraIssues: additional.bySheet,
    };
    const sheets = runTemplate(data, template);
    const used = new Set(sheets.flatMap((s) => s.worklogIds));
    const worklogs = all.filter((w) => used.has(w.id));

    // Unloadable parents/epics, as each sheet attributes its time (rollup is per sheet).
    const attributed = template.sheets.flatMap((s) => {
      const epic = sheetFieldIds(s).includes('epic');
      return sheetWorklogs(s, data).map((w) => ({ w, epic }));
    });
    const warnings = [
      ...unavailableWarnings(attributed, issues, unavailable),
      ...extra.capped.map(issueCapWarning),
      ...additional.capped.map(extraCapWarning),
    ];

    const issueRows = [...new Set(worklogs.map((w) => w.issueKey))]
      .sort(compareIssueKeysDesc)
      .map((k) => issueRow(issues.get(k) ?? { key: k }, issues));
    const failedIssueKeys = [...failed].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const { site: _site, ...filterOut } = effective;

    return {
      from: filter.from,
      to: filter.to,
      filter: filterOut,
      template,
      fields: usedIds.map((id) => byId.get(id)!),
      jql: compiled.where,
      sheets,
      worklogs,
      issues: issueRows,
      timeZone: zone,
      zoneMode: filter.zone,
      hoursPerDay: cfg.HOURS_PER_DAY,
      retrievedAt: DateTime.now().setZone(zone).startOf('second').toISO({ suppressMilliseconds: true })!,
      complete: failedIssueKeys.length === 0,
      failedIssueKeys,
      ...(failedIssueKeys.length ? { failureReasons: summarizeFailures(reasons) } : {}),
      warnings,
    };
  } finally {
    deadline.dispose();
  }
}

/**
 * Runs the extra issue search of every each-issue sheet with includeIssuesWithoutWorklogs (identical queries once),
 * at most MAX_ISSUES_WITHOUT_WORKLOGS issues each. The sheets' JQL-expressible conditions are checked with one
 * /jql/parse call; those Jira accepts go into the JQL, the rest are applied in code only (all of them are re-checked
 * in code anyway). No worklog calls: these issues get 0 hours unless the main search found time on them.
 * `capped` = names of the sheets whose search hit the cap. `projects` is never empty (checkIssuesWithoutWorklogs).
 */
async function searchIssuesWithoutWorklogs(
  client: JiraClient,
  sheets: readonly Sheet[],
  projects: readonly string[],
  fields: readonly string[],
  signal: AbortSignal,
): Promise<{ issues: CustomIssue[]; bySheet: Map<string, string[]>; capped: string[] }> {
  const out = { issues: [] as CustomIssue[], bySheet: new Map<string, string[]>(), capped: [] as string[] };
  const wanting = sheets.filter((s) => s.rows.mode === 'eachIssue' && s.includeIssuesWithoutWorklogs);
  if (!wanting.length) return out;
  const clausesOf = new Map(wanting.map((s) => [s, jqlNarrowingConditions(s.filter.conditions).map(compileCondition)]));
  const accepted = await acceptedJqlClauses(client, [...clausesOf.values()].flat(), { signal });
  const byJql = new Map<string, { issues: CustomIssue[]; truncated: boolean }>();
  for (const sheet of wanting) {
    const clauses = clausesOf.get(sheet)!.filter((c) => accepted.has(c));
    const jql = issuesWithoutWorklogsJql(projects, sheet.filter.jql, clauses);
    let result = byJql.get(jql);
    if (!result) {
      byJql.set(jql, (result = await searchIssuesLimited(client, jql, fields, MAX_ISSUES_WITHOUT_WORKLOGS, { signal })));
      out.issues.push(...result.issues);
    }
    out.bySheet.set(sheet.name, result.issues.map((i) => i.key));
    if (result.truncated) out.capped.push(sheet.name);
  }
  return out;
}

const extraCapWarning = (sheet: string) =>
  `Sheet "${sheet}": the extra JQL matches more than ${MAX_ISSUES_WITHOUT_WORKLOGS} issues, so only the newest ${MAX_ISSUES_WITHOUT_WORKLOGS} are added. Narrow the extra JQL.`;

/** The extra issue search of a group sheet with extraJql: the global projects (if any) and the sheet's extra JQL, newest first. */
export function extraIssuesJql(projectKeys: readonly string[], extraJql: string): string {
  const where = [...(projectKeys.length ? [`project in (${projectKeys.map(jqlString).join(', ')})`] : []), `(${extraJql})`];
  return `${where.join(' AND ')} ORDER BY key DESC`;
}

/**
 * Issues of group sheets' extra JQL ("additional issues without work logs"), at most MAX_ISSUES_WITHOUT_WORKLOGS each
 * (identical queries once). No worklog calls: they get 0 hours unless the main search found time on them.
 */
async function searchExtraJqlIssues(
  client: JiraClient,
  sheets: readonly Sheet[],
  projects: readonly string[],
  fields: readonly string[],
  signal: AbortSignal,
): Promise<{ issues: CustomIssue[]; bySheet: Map<string, string[]>; capped: string[] }> {
  const out = { issues: [] as CustomIssue[], bySheet: new Map<string, string[]>(), capped: [] as string[] };
  const byJql = new Map<string, { issues: CustomIssue[]; truncated: boolean }>();
  for (const sheet of sheets) {
    if (sheet.rows.mode !== 'group' || !sheet.extraJql) continue;
    const jql = extraIssuesJql(projects, sheet.extraJql);
    let result = byJql.get(jql);
    if (!result) {
      byJql.set(jql, (result = await searchIssuesLimited(client, jql, fields, MAX_ISSUES_WITHOUT_WORKLOGS, { signal })));
      out.issues.push(...result.issues);
    }
    out.bySheet.set(sheet.name, result.issues.map((i) => i.key));
    if (result.truncated) out.capped.push(sheet.name);
  }
  return out;
}

/** yyyy-MM-dd ± `days`. */
function shiftDate(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate()!;
}

/** Loads rollup parents and epic chains level by level in batches; returns the keys that could not be loaded. */
async function loadAncestors(
  client: JiraClient,
  found: readonly CustomIssue[],
  issues: Map<string, CustomIssue>,
  fields: readonly string[],
  need: { epic: boolean; rollup: boolean },
  signal: AbortSignal,
): Promise<Set<string>> {
  const unavailable = new Set<string>();
  if (!need.epic && !need.rollup) return unavailable;
  const keys = found.map((i) => i.key);
  for (let round = 0; round < MAX_ANCESTOR_ROUNDS; round++) {
    const missing = missingAncestorKeys(keys, issues, need, unavailable);
    if (!missing.length) break;
    const loaded = await fetchIssuesByKeys(client, missing, fields, { signal });
    for (const i of loaded.issues) if (!issues.has(i.key)) issues.set(i.key, i);
    loaded.unavailable.forEach((k) => unavailable.add(k));
  }
  // Still missing after the rounds (chain deeper than MAX_ANCESTOR_ROUNDS): treated like an unloadable issue.
  missingAncestorKeys(keys, issues, need, unavailable).forEach((k) => unavailable.add(k));
  return unavailable;
}

function issueInfo(i: CustomIssue): IssueInfo {
  const project = (i.fields?.project ?? {}) as { key?: string; name?: string };
  return { key: i.key, summary: summaryOf(i), projectKey: project.key ?? '', projectName: project.name ?? '' };
}

/**
 * Fetched worklogs → CustomWorklog (REPORT_TZ date, exact [from, to], author filter). attributedTo = the issue itself;
 * sheets re-attribute per their rollup setting. An undatable worklog marks its issue as failed (same rule as the matrix).
 */
function toCustomWorklogs(
  fetched: ReadonlyArray<{ issue: IssueInfo; worklogs: JiraWorklog[] }>,
  filter: Pick<GlobalFilter, 'from' | 'to' | 'authors'>,
  zone: string,
  /** true = each worklog is dated in its author's own Jira time zone (`zone` when the author has none). */
  byAuthorZone: boolean,
  hooks: GenerateHooks,
  failed: Set<string>,
  reasons: string[],
): CustomWorklog[] {
  const authors = filter.authors.length ? new Set(filter.authors) : undefined;
  const out: CustomWorklog[] = [];
  for (const { issue, worklogs: raw } of fetched) {
    for (const w of raw as Array<JiraWorklog & { created?: string; comment?: unknown }>) {
      const own = byAuthorZone ? w.author?.timeZone : undefined;
      const wz = own && isTimeZone(own) ? own : zone;
      const date = reportDate(w.started, wz);
      if (date === undefined) {
        failed.add(issue.key);
        reasons.push('unparseable worklog start time');
        hooks.onInvalidWorklog?.({ issueKey: issue.key, worklogId: w.id, started: w.started });
        continue;
      }
      if (date < filter.from || date > filter.to) continue;
      const accountId = w.author?.accountId ?? 'unknown';
      if (authors && !authors.has(accountId)) continue;
      out.push({
        id: w.id,
        date,
        accountId,
        user: w.author?.displayName ?? accountId,
        issueKey: issue.key,
        summary: issue.summary,
        project: issue.projectKey,
        seconds: w.timeSpentSeconds,
        started: w.started,
        created: w.created ?? '',
        createdDate: zoned(w.created, wz),
        comment: typeof w.comment === 'string' ? w.comment : adfToText(w.comment),
        attributedTo: issue.key,
        zone: wz,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.user.localeCompare(b.user) ||
      a.issueKey.localeCompare(b.issueKey, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}
