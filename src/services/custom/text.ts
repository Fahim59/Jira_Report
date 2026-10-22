// Text helpers shared by the server and the browser (preview): column value extraction and sheet title placeholders.
// Pure: no imports (no zod / luxon), so web/ can import it as is.

/** Longest `extract` pattern a column / group level may have. */
export const MAX_EXTRACT = 200;
/** Sheet title / subtitle and each note line. */
export const MAX_TITLE = 200;
export const MAX_NOTE = 500;
export const MAX_NOTES = 10;

/** Why `pattern` cannot be used as an `extract` regex, or undefined. */
export function extractProblem(pattern: string): string | undefined {
  if (pattern.length > MAX_EXTRACT) return `extract pattern must be at most ${MAX_EXTRACT} characters`;
  try {
    new RegExp(pattern);
  } catch (err) {
    return `extract pattern is not a valid regular expression (${(err as Error).message})`;
  }
  return undefined;
}

/** Compiled `extract` pattern, or undefined without one (callers validated it already). */
export const compileExtract = (pattern: string | undefined): RegExp | undefined => (pattern ? new RegExp(pattern) : undefined);

/**
 * `extract` applied to a value: group 1 of the first match if the pattern has one (and it matched), else the whole
 * first match. No match (or an empty match) → the value unchanged.
 */
export function applyExtract(re: RegExp | undefined, value: string): string {
  if (!re || !value) return value;
  const m = re.exec(value);
  const hit = m ? (m[1] ?? m[0]) : '';
  return hit || value;
}

// ---- Sheet title placeholders ----

export const PLACEHOLDERS = ['projects', 'from', 'to', 'tz', 'site', 'generated', 'users'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PlaceholderValues = Readonly<Record<Placeholder, string>>;

/** Replaces {projects} {from} {to} {tz} {site} {generated} {users}; anything else in braces is left as typed. */
export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (Object.hasOwn(values, name) ? values[name as Placeholder] : all));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** {generated}: an ISO timestamp as "dd-MMM-yyyy HH:mm" in `timeZone` (Intl, same in Node and the browser). */
export function formatGenerated(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.day}-${MONTHS[Number(parts.month) - 1]}-${parts.year} ${parts.hour}:${parts.minute}`;
  } catch {
    return iso; // unknown time zone
  }
}

/** {site}: the host of a Jira site URL ("pm23.atlassian.net"); the input as is if it is not a URL. */
export function siteHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Project A, Project B" (display names when known), or "All projects". */
export function projectsText(projects: readonly string[], names: Readonly<Record<string, string>> = {}): string {
  return projects.length ? projects.map((k) => names[k] ?? k).join(', ') : 'All projects';
}

/** Selected worklog authors' names (labels, else `known`, else the accountId), or "All users". */
export function usersText(
  authors: readonly string[],
  names: Readonly<Record<string, string>> = {},
  known: ReadonlyMap<string, string> = new Map(),
): string {
  return authors.length ? authors.map((a) => names[a] ?? known.get(a) ?? a).join(', ') : 'All users';
}

export interface PlaceholderInput {
  projects: readonly string[];
  authors: readonly string[];
  from: string;
  to: string;
  timeZone: string;
  retrievedAt: string;
  /** Jira site URL ({site} = its host); else `site` (the key) is used. */
  siteUrl?: string;
  site?: string;
  labels?: { projects?: Readonly<Record<string, string>>; users?: Readonly<Record<string, string>> };
  /** accountId → display name from the worklogs (users without a label). */
  knownUsers?: ReadonlyMap<string, string>;
}

/** Values of the title placeholders for one report (same in the .xlsx and the preview). */
export function placeholderValues(p: PlaceholderInput): PlaceholderValues {
  return {
    projects: projectsText(p.projects, p.labels?.projects),
    from: p.from,
    to: p.to,
    tz: p.timeZone,
    site: siteHost(p.siteUrl) || p.site || '',
    generated: formatGenerated(p.retrievedAt, p.timeZone),
    users: usersText(p.authors, p.labels?.users, p.knownUsers),
  };
}
