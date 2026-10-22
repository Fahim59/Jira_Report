// ---- Jira REST v3 shapes (only the fields we use) ----

export interface JiraUserRef {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  accountType?: string;
  active?: boolean;
  /** IANA zone of the user's Jira profile (present on worklog authors). */
  timeZone?: string;
  /** Profile picture URLs by size ("24x24", "48x48", ...). */
  avatarUrls?: Record<string, string>;
}

export interface JiraProjectRef {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    project: JiraProjectRef;
  };
}

export interface JiraSearchJqlResponse {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

export interface JiraWorklog {
  id: string;
  issueId: string;
  author?: JiraUserRef;
  started: string; // e.g. 2026-10-01T09:00:00.000+0600
  timeSpentSeconds: number;
}

export interface JiraWorklogPage {
  startAt: number;
  maxResults: number;
  total: number;
  worklogs: JiraWorklog[];
}

// ---- App-level shapes ----

/** Issue reduced to what the report needs. */
export interface IssueInfo {
  key: string;
  summary: string;
  projectKey: string;
  projectName: string;
}

export interface IssueWorklogs {
  issue: IssueInfo;
  worklogs: JiraWorklog[];
}

export interface WorklogFetchResult {
  issues: IssueWorklogs[];
  failedIssueKeys: string[];
}

export interface ReportFilter {
  from: string; // yyyy-MM-dd (REPORT_TZ)
  to: string; // yyyy-MM-dd (REPORT_TZ), inclusive
  project?: string;
  /** Empty/undefined = all users. */
  accountIds?: string[];
}

export interface NormalizedWorklog {
  id: string;
  date: string; // yyyy-MM-dd in REPORT_TZ
  accountId: string;
  user: string;
  issueKey: string;
  summary: string;
  project: string;
  seconds: number;
}

export interface ReportRow {
  accountId: string;
  user: string;
  byDate: Record<string, number>; // date -> seconds
  total: number;
}

export interface Report {
  /** Jira site key (subdomain) the report came from. Set by POST /api/report; absent = default site. */
  site?: string;
  from: string;
  to: string;
  /** Project key filter the report was generated with (absent = all projects). */
  project?: string;
  dates: string[];
  rows: ReportRow[];
  dateTotals: Record<string, number>;
  grandTotal: number;
  worklogs: NormalizedWorklog[];
  retrievedAt: string;
  complete: boolean;
  failedIssueKeys: string[];
  /** Why issues failed, e.g. "3 issue(s): Jira rate limit (HTTP 429) persisted after retries". Only when incomplete. */
  failureReasons?: string[];
}

export interface JiraProjectSearchPage {
  startAt: number;
  maxResults: number;
  total?: number;
  isLast?: boolean;
  values: JiraProjectRef[];
}

/** GET /api/projects item. */
export interface ProjectOption {
  key: string;
  name: string;
}

/** GET /api/users item. */
export interface UserOption {
  accountId: string;
  displayName: string;
  active: boolean;
  /** 24×24 profile picture (Team Reports table); absent when Jira sent none. */
  avatarUrl?: string;
}
