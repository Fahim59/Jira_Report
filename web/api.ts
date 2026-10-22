import type { FieldInfo } from '../src/services/custom/fields.js';
import type { TemplateReport } from '../src/services/custom/result.js';
import type { Template, TemplateBody } from '../src/services/custom/template.js';
import type { ProjectOption, UserOption } from '../src/types.js';
import type { ListRowData } from './list/logic.js';
import { filenameFromDisposition } from './advance/template-logic.js';
import { authorization, signOut } from './session.js';

export type { FieldInfo, TemplateReport };

export interface SiteInfo {
  key: string;
  url: string;
}

export interface AppConfig {
  site: string;
  jiraBaseUrl: string;
  maxRangeDays: number;
  reportTimeoutSec: number;
}

/** Thrown when the user cancelled the request (AbortController). */
export class CancelledError extends Error {
  override readonly name = 'CancelledError';
  constructor() {
    super('Report cancelled.');
  }
}

/** Used when the response has no JSON error (e.g. a proxy in front of the server answered). */
function statusMessage(status: number): string {
  if (status === 502 || status === 503) return `The report server or Jira is unavailable (HTTP ${status}). Try again shortly.`;
  if (status === 504) return 'The request timed out before the report finished (HTTP 504). Try a shorter range or one project.';
  return `Request failed (HTTP ${status})`;
}

/** The request with the signed-in user's email + API token (every /api call needs them). */
function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...authorization() } };
}

const SESSION_ENDED = 'Jira did not accept your email and API token any more (revoked or expired, or you lost access to the site). Please sign in again.';

/** A 401 means the stored sign-in no longer works: back to the sign-in screen. */
function checkSignedIn(res: Response): void {
  if (res.status === 401) signOut(SESSION_ENDED);
}

/** Throws with the server's `error` message when the response is not 2xx. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, authed(init));
  } catch (err) {
    if (init?.signal?.aborted) throw new CancelledError();
    throw new Error('Cannot reach the report server: check your network connection, or the server may be down.');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (init?.signal?.aborted) throw new CancelledError();
    throw err;
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  checkSignedIn(res);
  if (!res.ok) {
    const msg = (body as { error?: string } | undefined)?.error;
    throw new Error(msg || statusMessage(res.status));
  }
  return body as T;
}

/** `?site=<key>`, or '' for the server's default site. */
const siteQuery = (site: string | undefined) => (site ? `?site=${encodeURIComponent(site)}` : '');

/** POST /api/login response: who the email + API token belong to. */
export interface LoginResult {
  email: string;
  displayName: string;
  accountId: string;
  /** The user's default site, and every configured site that accepted the credentials. */
  site: string;
  sites: SiteInfo[];
}

/**
 * Checks an email + API token with Jira (nothing is stored on the server). Not through `request`: a wrong token
 * here is an ordinary error message, not "your session ended".
 */
export async function postLogin(email: string, token: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, token }) });
  } catch {
    throw new Error('Cannot reach the report server: check your network connection, or the server may be down.');
  }
  let body: { error?: string } | undefined;
  try {
    body = (await res.json()) as { error?: string };
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new Error(body?.error || statusMessage(res.status));
  return body as unknown as LoginResult;
}

export const getSites = () => request<SiteInfo[]>('/api/sites');
/** Who the stored credentials belong to (for sign-ins saved before the account id was kept). */
export const getMe = () => request<{ email: string; displayName: string; accountId: string }>('/api/me');
export const getProjects = (site?: string) => request<ProjectOption[]>(`/api/projects${siteQuery(site)}`);
export const getUsers = (site?: string) => request<UserOption[]>(`/api/users${siteQuery(site)}`);
export const getConfig = (site?: string) => request<AppConfig>(`/api/config${siteQuery(site)}`);

/** GET /api/groups item (Jira group). */
export interface GroupOption {
  groupId: string;
  name: string;
}
export const getGroups = (site?: string) => request<GroupOption[]>(`/api/groups${siteQuery(site)}`);
export const getGroupMembers = (groupId: string, site?: string) =>
  request<UserOption[]>(`/api/groups/${encodeURIComponent(groupId)}/members${siteQuery(site)}`);

/** Report endpoints: the matrix (/api/report) or the Custom Report (/api/custom-report). */
export type ReportBase = '/api/report' | '/api/custom-report';

/** Best effort: aborting the POST already stops the server; this also covers proxies that keep the upstream open. */
export function cancelReport(requestId: string, base: ReportBase = '/api/report'): void {
  fetch(`${base}/${encodeURIComponent(requestId)}/cancel`, authed({ method: 'POST' })).catch(() => {});
}

export const getFields = (site?: string) => request<FieldInfo[]>(`/api/fields${siteQuery(site)}`);

/** POST /api/custom-report body: the global filter and the template (saved or not) as edited. */
export interface CustomReportRequest {
  filter: Record<string, unknown>;
  template: Record<string, unknown>;
  requestId?: string;
}

/** POST /api/custom-report response. */
export type CustomReport = TemplateReport & { site: string };

export const postCustomReport = (body: CustomReportRequest, signal?: AbortSignal) =>
  request<CustomReport>('/api/custom-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

// ---- List tab (POST /api/list, /api/list/export) ----

export type { ListRowData };

export interface ListResult {
  site: string;
  jql: string;
  rows: ListRowData[];
  truncated: boolean;
  limit: number;
  retrievedAt: string;
}

export const postList = (
  body: { site?: string; projects: string[]; assignees: string[]; jql: string; hideDone: boolean; fields: string[]; all?: boolean },
  signal?: AbortSignal,
) => request<ListResult>('/api/list', { ...json('POST', body), signal });

/** Account ids with recent activity (assignee / reporter / creator of a work item updated in the last `days` days). */
export const getActiveUserIds = (site: string | undefined, days: number) =>
  request<{ accountIds: string[]; days: number; issues: number; truncated: boolean }>(`/api/list/users?${new URLSearchParams({ ...(site ? { site } : {}), days: String(days) })}`);

/** The List table as shown → one .xlsx (no Jira calls). */
export async function postListExport(body: {
  site?: string;
  /** File name stem (letters, digits, - and _). */
  name?: string;
  headers: string[];
  rows: { cells: string[]; level: number; group: boolean }[];
}): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch('/api/list/export', authed(json('POST', body)));
  } catch {
    throw new Error('Cannot reach the report server to build the .xlsx. Check your connection and try again.');
  }
  checkSignedIn(res);
  if (!res.ok) {
    let msg: string | undefined;
    try {
      msg = ((await res.json()) as { error?: string }).error;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(`The .xlsx could not be built: ${msg || `HTTP ${res.status}`}`);
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get('Content-Disposition'), 'work-items.xlsx') };
}

// ---- Templates (GET/POST/PUT/DELETE /api/templates) ----

/** A template in the list: a saved one (builtIn false, has updatedAt) or a read-only built-in starter. */
export type TemplateItem =
  | (Template & { builtIn: false })
  | (TemplateBody & { id: string; site: string; isDefault: boolean; builtIn: true; warnings: string[] });

export interface TemplateList {
  site: string;
  defaultId?: string;
  templates: TemplateItem[];
  warnings: string[];
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const templateUrl = (id: string, rest = '') => `/api/templates/${encodeURIComponent(id)}${rest}`;

export const getTemplates = (site?: string) => request<TemplateList>(`/api/templates${siteQuery(site)}`);
export const createTemplate = (site: string | undefined, body: Record<string, unknown>) =>
  request<Template>('/api/templates', json('POST', { ...body, ...(site ? { site } : {}) }));
/** `updatedAt` = the version loaded: someone else's save in between gives a 409 instead of being overwritten. */
export const updateTemplate = (id: string, body: Record<string, unknown>, updatedAt?: string) =>
  request<Template>(templateUrl(id), json('PUT', { ...body, ...(updatedAt ? { updatedAt } : {}) }));
export const deleteTemplate = (id: string) => request<void>(templateUrl(id), json('DELETE'));
/** A built-in becomes the default of `site`; a saved template, of its own site. */
export const setDefaultTemplate = (id: string, site?: string) => request<{ site: string; defaultId: string }>(templateUrl(id, `/default${siteQuery(site)}`), json('POST'));
export const unsetDefaultTemplate = (id: string, site?: string) => request<void>(templateUrl(id, `/default${siteQuery(site)}`), json('DELETE'));

/**
 * The displayed result → one .xlsx (POST /api/custom-report/export; no Jira calls). `labels` = display names the
 * browser has for project keys / accountIds (the header block).
 */
export async function postCustomExport(
  report: CustomReport,
  labels: { projects: Record<string, string>; users: Record<string, string> },
): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch('/api/custom-report/export', authed(json('POST', { report, labels })));
  } catch {
    throw new Error('Cannot reach the report server to build the .xlsx. Check your connection and press Generate again.');
  }
  checkSignedIn(res);
  if (!res.ok) {
    let msg: string | undefined;
    try {
      msg = ((await res.json()) as { error?: string }).error;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(`The .xlsx could not be built: ${msg || `HTTP ${res.status}`}`);
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get('Content-Disposition'), 'Report.xlsx') };
}

/** The Team Reports table (positioned cells, see web/team/logic.ts pivotGrid) → one .xlsx; no Jira calls. */
export async function postTeamExport(body: {
  site?: string;
  /** File name part instead of the site key (several sites): letters, digits, - and _. */
  fileSite?: string;
  from: string;
  to: string;
  complete: boolean;
  grid: unknown;
}): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch('/api/team-reports/export', authed(json('POST', body)));
  } catch {
    throw new Error('Cannot reach the report server to build the .xlsx. Check your connection and try again.');
  }
  checkSignedIn(res);
  if (!res.ok) {
    let msg: string | undefined;
    try {
      msg = ((await res.json()) as { error?: string }).error;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(`The .xlsx could not be built: ${msg || `HTTP ${res.status}`}`);
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get('Content-Disposition'), 'team-report.xlsx') };
}

/** Progress event from GET /api/report/progress/:id (see src/services/runs.ts). */
export type ProgressEvent =
  | { stage: 'validating' | 'searching' | 'worklogs' | 'processing'; issues?: number; done?: number; total?: number }
  | { stage: 'done' }
  | { stage: 'failed'; message: string };

/**
 * Follows a report's progress over SSE. `onFail` fires once if the stream cannot be used
 * (the caller then falls back to the elapsed-time counter). Call the returned function to stop.
 */
export function watchProgress(
  requestId: string,
  onEvent: (e: ProgressEvent) => void,
  onFail: () => void,
  base: ReportBase = '/api/report',
): () => void {
  if (typeof EventSource === 'undefined') {
    onFail();
    return () => {};
  }
  const es = new EventSource(`${base}/progress/${encodeURIComponent(requestId)}`);
  let stopped = false;
  const stop = () => {
    stopped = true;
    es.close();
  };
  es.onmessage = (m) => {
    let e: ProgressEvent;
    try {
      e = JSON.parse(m.data as string) as ProgressEvent;
    } catch {
      return;
    }
    onEvent(e);
    if (e.stage === 'done' || e.stage === 'failed') stop();
  };
  es.onerror = () => {
    if (stopped) return;
    stop();
    onFail();
  };
  return stop;
}

/** Posts the displayed report (it carries its site); the server builds the .xlsx from it without calling Jira. */
