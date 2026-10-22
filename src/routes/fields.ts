import type { FastifyInstance } from 'fastify';
import { jiraErrorResponse } from '../jira/errors.js';
import type { FieldCache } from '../jira/fields.js';
import type { SiteRegistry } from '../jira/sites.js';
import { requireSite, siteQuery } from './site.js';

export async function fieldRoutes(app: FastifyInstance, opts: { sites: SiteRegistry; fields: FieldCache }): Promise<void> {
  const { sites, fields } = opts;

  // Jira fields (custom included) + Custom Report pseudo-fields, sorted by name. Cached per site for 10 min.
  app.get('/api/fields', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    try {
      return await fields.get(site.key, site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'field list failed');
      const { status, error } = jiraErrorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load fields. ${error}` });
    }
  });
}
