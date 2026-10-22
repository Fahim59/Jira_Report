import type { FastifyInstance, FastifyRequest } from 'fastify';
import { jiraErrorResponse } from '../jira/errors.js';
import { ALL_SITES, type SiteEntry, type SiteRegistry } from '../jira/sites.js';
import type { JiraUserRef } from '../types.js';
import { requireSite, siteQuery } from './site.js';

interface SiteHealth {
  site: string;
  baseUrl: string;
  ok: boolean;
  user: string | null;
  error?: string;
  /** HTTP status this check maps to (200 when ok). */
  status: number;
}

async function checkSite(site: SiteEntry, req: FastifyRequest): Promise<SiteHealth> {
  try {
    const me = await site.jira.get<JiraUserRef>('/rest/api/3/myself');
    return { site: site.key, baseUrl: site.url, ok: true, user: me.displayName, status: 200 };
  } catch (err) {
    req.log.warn({ site: site.key, err: (err as Error).message }, 'Jira health check failed');
    const { status, error } = jiraErrorResponse(err, site.url);
    return { site: site.key, baseUrl: site.url, ok: false, user: null, error, status };
  }
}

export async function healthRoutes(app: FastifyInstance, opts: { sites: SiteRegistry }): Promise<void> {
  // ?site=<key> checks one site (default: the first); ?site=all checks every site in parallel.
  app.get('/api/health/jira', async (req, reply) => {
    const key = siteQuery(req);
    if (typeof key === 'string' && key.trim().toLowerCase() === ALL_SITES) {
      const results = await Promise.all(opts.sites.entries.map((s) => checkSite(s, req)));
      const ok = results.every((r) => r.ok);
      return reply.code(ok ? 200 : 502).send({ ok, sites: results.map(({ status: _, ...r }) => r) });
    }
    const site = requireSite(opts.sites, key, reply);
    if (!site) return reply;
    const { status, ...result } = await checkSite(site, req);
    return reply.code(status).send(result);
  });
}
