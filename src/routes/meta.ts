import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { SiteAccessCache } from '../jira/access.js';
import { currentCredentials } from '../jira/auth.js';
import { jiraErrorResponse } from '../jira/errors.js';
import { listGroupMembers, listGroups } from '../jira/groups.js';
import { listProjects } from '../jira/projects.js';
import type { SiteRegistry } from '../jira/sites.js';
import { listUsers } from '../jira/users.js';
import { requireSite, siteQuery } from './site.js';

export async function metaRoutes(
  app: FastifyInstance,
  opts: { sites: SiteRegistry; cfg: Pick<Config, 'MAX_RANGE_DAYS' | 'REPORT_TIMEOUT_SEC'>; access?: SiteAccessCache },
): Promise<void> {
  const { sites } = opts;

  // The sites this user can use: the configured ones (first = default) that accept their email + API token. URLs only.
  // Without `access` (tests) every configured site is listed.
  app.get('/api/sites', async (_req, reply) => {
    const creds = currentCredentials();
    if (!opts.access || !creds) return sites.list();
    const access = await opts.access.get(creds);
    if (access.sites.length) return access.sites;
    const unchecked = access.unchecked[0];
    if (unchecked) {
      const { status, error } = jiraErrorResponse(unchecked.err, unchecked.site.url);
      return reply.code(status === 401 ? 502 : status).send({ error });
    }
    // Not a 401: the token itself may be fine, and a 401 would sign the user out.
    return reply.code(403).send({ error: `Your Jira account has no access to any of the configured sites (${sites.keys.join(', ')}).` });
  });

  // Who the signed-in credentials belong to (the browser keeps the account id to preselect "the current user").
  app.get('/api/me', async (_req, reply) => {
    const creds = currentCredentials();
    const access = opts.access && creds ? await opts.access.get(creds) : undefined;
    if (!creds || !access?.user) return reply.code(404).send({ error: 'Could not find out who you are in Jira. Sign in again.' });
    return { email: creds.email, displayName: access.user.displayName, accountId: access.user.accountId };
  });

  // Public, non-secret settings the browser needs (issue links, range check). Never add credentials here.
  app.get('/api/config', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    return {
      site: site.key,
      jiraBaseUrl: site.url,
      maxRangeDays: opts.cfg.MAX_RANGE_DAYS,
      reportTimeoutSec: opts.cfg.REPORT_TIMEOUT_SEC,
    };
  });

  app.get('/api/projects', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    try {
      return await listProjects(site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'project list failed');
      const { status, error } = jiraErrorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load projects. ${error}` });
    }
  });

  // Groups for the Team Reports "Users & Groups" field; the browser expands a chosen group with the members route.
  app.get('/api/groups', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    try {
      return await listGroups(site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'group list failed');
      const { status, error } = jiraErrorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load groups. ${error}` });
    }
  });

  app.get('/api/groups/:groupId/members', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    const { groupId } = req.params as { groupId: string };
    if (!/^[\w-]{1,64}$/.test(groupId)) return reply.code(400).send({ error: 'Invalid group id' });
    try {
      return await listGroupMembers(site.jira, groupId);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'group members failed');
      const { status, error } = jiraErrorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load the group's members. ${error}` });
    }
  });

  app.get('/api/users', async (req, reply) => {
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    try {
      return await listUsers(site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'user list failed');
      const { status, error } = jiraErrorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load users. ${error}` });
    }
  });
}
