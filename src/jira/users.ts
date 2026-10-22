import type { JiraUserRef, UserOption } from '../types.js';
import type { JiraClient } from './client.js';

const PAGE_SIZE = 1000;

/**
 * All human (accountType=atlassian) users, sorted by name. /users/search returns a bare array and no
 * total, and pages may come back short after Jira's own filtering, so paging stops on an empty page.
 * Inactive users are kept (flagged) because they may still have worklogs in the requested range.
 */
export async function listUsers(client: JiraClient): Promise<UserOption[]> {
  const byId = new Map<string, UserOption>();
  let startAt = 0;
  for (;;) {
    const batch = await client.get<JiraUserRef[]>('/rest/api/3/users/search', { startAt, maxResults: PAGE_SIZE });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const u of batch) {
      if (u.accountType !== 'atlassian') continue;
      const avatarUrl = u.avatarUrls?.['24x24'];
      byId.set(u.accountId, { accountId: u.accountId, displayName: u.displayName, active: u.active !== false, ...(avatarUrl ? { avatarUrl } : {}) });
    }
    startAt += batch.length;
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
