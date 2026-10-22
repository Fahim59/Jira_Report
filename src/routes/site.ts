import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SiteEntry, SiteRegistry } from '../jira/sites.js';

/** The `site` query parameter (?site=<key>), if any. */
export function siteQuery(req: FastifyRequest): unknown {
  return (req.query as { site?: unknown } | undefined)?.site;
}

/**
 * Resolves the requested site (missing = default). On an unknown key it sends 400 and returns
 * undefined, so the caller just returns.
 */
export function requireSite(sites: SiteRegistry, key: unknown, reply: FastifyReply): SiteEntry | undefined {
  const site = sites.resolve(key);
  if (!site) reply.code(400).send({ error: sites.unknownSiteMessage(key) });
  return site;
}
