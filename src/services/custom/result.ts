// Custom Report response shape (POST /api/custom-report). Pure types: the browser imports them too.
import type { CustomWorklog, IssueRow } from './engine.js';
import type { FieldInfo } from './fields.js';
import type { SheetResult } from './sheets.js';
import type { GlobalFilter, TemplateBody } from './template.js';

/** POST /api/custom-report response (Phase 8b): one result per template sheet, from one Jira fetch. */
export interface TemplateReport {
  site?: string;
  from: string;
  to: string;
  filter: Omit<GlobalFilter, 'site' | 'zone' | 'userZone'> & Partial<Pick<GlobalFilter, 'zone' | 'userZone'>>;
  template: TemplateBody;
  /** Name + type of every field the template uses. */
  fields: FieldInfo[];
  /** Global JQL sent to Jira (without ORDER BY). */
  jql: string;
  sheets: SheetResult[];
  /** Every worklog that appears in at least one sheet (drill-down). */
  worklogs: CustomWorklog[];
  /** Issues those worklogs were logged on, newest key first. */
  issues: IssueRow[];
  /** The zone dates were computed in (REPORT_TZ, or the browser's zone); with zoneMode "author" the fallback zone. */
  timeZone: string;
  /** Which calendar decided each worklog's day: REPORT_TZ ("server"), the browser's ("user") or the author's own. */
  zoneMode?: 'server' | 'user' | 'author';
  hoursPerDay: number;
  retrievedAt: string;
  complete: boolean;
  failedIssueKeys: string[];
  failureReasons?: string[];
  warnings: string[];
}
