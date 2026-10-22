import type { UserOption } from '../types.js';
import type { JiraClient, RequestOptions } from './client.js';

const GROUP_PAGE = 50; // /group/bulk and /group/member cap maxResults at 50 (member: 50 by default, 50 max)
/** Safety stop: nobody has this many groups or members; it only keeps a misbehaving response from looping forever. */
const MAX_PAGES = 200;

/** GET /api/groups item. */
export interface GroupOption {
  groupId: string;
  name: string;
}

interface Page<T> {
  values?: T[];
  isLast?: boolean;
}

/** All Jira groups, sorted by name (GET /rest/api/3/group/bulk, paginated). */
export async function listGroups(client: JiraClient, opts: RequestOptions = {}): Promise<GroupOption[]> {
  const out = new Map<string, GroupOption>();
  for (let page = 0, startAt = 0; page < MAX_PAGES; page++) {
    const res = await client.get<Page<{ groupId?: string; name?: string }>>('/rest/api/3/group/bulk', { startAt, maxResults: GROUP_PAGE }, opts);
    const values = res.values ?? [];
    for (const g of values) if (g.groupId && g.name) out.set(g.groupId, { groupId: g.groupId, name: g.name });
    startAt += values.length;
    if (values.length === 0 || res.isLast !== false) break;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Members of one group (active and inactive: inactive users may still have worklogs), sorted by name. */
export async function listGroupMembers(client: JiraClient, groupId: string, opts: RequestOptions = {}): Promise<UserOption[]> {
  const out = new Map<string, UserOption>();
  for (let page = 0, startAt = 0; page < MAX_PAGES; page++) {
    const res = await client.get<Page<{ accountId?: string; displayName?: string; active?: boolean; accountType?: string }>>(
      '/rest/api/3/group/member',
      { groupId, includeInactiveUsers: true, startAt, maxResults: GROUP_PAGE },
      opts,
    );
    const values = res.values ?? [];
    for (const u of values) {
      if (!u.accountId || (u.accountType !== undefined && u.accountType !== 'atlassian')) continue;
      out.set(u.accountId, { accountId: u.accountId, displayName: u.displayName ?? u.accountId, active: u.active !== false });
    }
    startAt += values.length;
    if (values.length === 0 || res.isLast !== false) break;
  }
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
