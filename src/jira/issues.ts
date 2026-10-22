import { DateTime } from 'luxon';
import type { IssueInfo, JiraSearchJqlResponse, ReportFilter } from '../types.js';
import type { JiraClient, RequestOptions } from './client.js';

const PAGE_SIZE = 100;
/** Above this many selected users, worklogAuthor is left out of the JQL (length limits) and filtering happens in code only. */
export const JQL_MAX_AUTHORS = 20;

/** Quotes a value for JQL, escaping backslashes and double quotes. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shiftDay(isoDate: string, days: number): string {
  const d = DateTime.fromISO(isoDate, { zone: 'utc' });
  if (!d.isValid) throw new Error(`Invalid date: ${isoDate}`);
  return d.plus({ days }).toISODate()!;
}

/**
 * Jira evaluates worklogDate in the API user's profile timezone, which may differ from REPORT_TZ,
 * so the JQL window is widened by one day on each side. Exact filtering happens after worklogs
 * are fetched and converted to REPORT_TZ.
 */
export function buildWorklogJql(filter: ReportFilter): string {
  const clauses = [
    `worklogDate >= ${jqlString(shiftDay(filter.from, -1))}`,
    `worklogDate <= ${jqlString(shiftDay(filter.to, 1))}`,
  ];
  if (filter.project) clauses.push(`project = ${jqlString(filter.project)}`);
  const ids = filter.accountIds ?? [];
  if (ids.length > 0 && ids.length <= JQL_MAX_AUTHORS) clauses.push(`worklogAuthor in (${ids.map(jqlString).join(', ')})`);
  return clauses.join(' AND ') + ' ORDER BY key ASC';
}

/** All issues with any worklog in the (widened) range. Uses nextPageToken pagination. */
export async function searchIssuesWithWorklogs(client: JiraClient, filter: ReportFilter, opts: RequestOptions = {}): Promise<IssueInfo[]> {
  const jql = buildWorklogJql(filter);
  const out: IssueInfo[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;

  do {
    const page = await client.get<JiraSearchJqlResponse>('/rest/api/3/search/jql', {
      jql,
      fields: 'summary,project',
      maxResults: PAGE_SIZE,
      nextPageToken,
    }, opts);
    for (const issue of page.issues ?? []) {
      if (seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push({
        key: issue.key,
        summary: issue.fields?.summary ?? '',
        projectKey: issue.fields?.project?.key ?? '',
        projectName: issue.fields?.project?.name ?? '',
      });
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);

  return out;
}
