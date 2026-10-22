import type { JiraProjectSearchPage, ProjectOption } from '../types.js';
import type { JiraClient, RequestOptions } from './client.js';

const PAGE_SIZE = 100;

/** All projects visible to the API user (startAt/maxResults/isLast pagination), sorted by name. */
export async function listProjects(client: JiraClient, opts: RequestOptions = {}): Promise<ProjectOption[]> {
  const out: ProjectOption[] = [];
  let startAt = 0;
  for (;;) {
    const page = await client.get<JiraProjectSearchPage>('/rest/api/3/project/search', {
      startAt,
      maxResults: PAGE_SIZE,
      orderBy: 'name',
    }, opts);
    const batch = page.values ?? [];
    out.push(...batch.map((p) => ({ key: p.key, name: p.name })));
    startAt += batch.length;
    if (page.isLast || batch.length === 0) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Canonical key of the project matching `key` (case-insensitive), or undefined if Jira has no such project. */
export async function resolveProjectKey(client: JiraClient, key: string, opts: RequestOptions = {}): Promise<string | undefined> {
  const wanted = key.trim().toUpperCase();
  return (await listProjects(client, opts)).find((p) => p.key.toUpperCase() === wanted)?.key;
}
