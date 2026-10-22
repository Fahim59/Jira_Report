import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { SiteRegistry } from '../jira/sites.js';
import { generateReport, MAX_ACCOUNT_IDS } from '../services/report.js';
import { RUN_ID, RunRegistry } from '../services/runs.js';
import { runControlRoutes, runReport, zodMessage } from './runs.js';
import { requireSite, siteQuery } from './site.js';

const optionalId = z
  .string()
  .trim()
  .max(128)
  .optional()
  .transform((s) => (s ? s : undefined));

const ReportBody = z.object({
  // Site key (subdomain); missing = first configured site. ?site=<key> works too.
  site: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-MM-dd'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-MM-dd'),
  project: optionalId,
  // Empty or missing = all users. Duplicates are dropped.
  accountIds: z
    .array(z.string().trim().min(1).max(128))
    .max(MAX_ACCOUNT_IDS, `at most ${MAX_ACCOUNT_IDS} users can be selected`)
    .optional()
    .transform((ids) => (ids?.length ? [...new Set(ids)] : undefined)),
  // Optional: lets the browser follow progress (GET /api/report/progress/:id) and cancel by id.
  requestId: z.string().regex(RUN_ID, 'invalid requestId').optional(),
});

export async function reportRoutes(
  app: FastifyInstance,
  opts: { sites: SiteRegistry; cfg: Pick<Config, 'REPORT_TZ' | 'JIRA_CONCURRENCY' | 'MAX_RANGE_DAYS' | 'REPORT_TIMEOUT_SEC'>; runs?: RunRegistry },
): Promise<void> {
  const { sites, cfg } = opts;
  const runs = opts.runs ?? new RunRegistry();

  app.post('/api/report', async (req, reply) => {
    const parsed = ReportBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error.issues) });
    const { requestId, site: siteKey, ...filter } = parsed.data;
    const site = requireSite(sites, siteKey ?? siteQuery(req), reply);
    if (!site) return reply;

    const report = await runReport(req, reply, {
      runs,
      cfg,
      requestId,
      siteUrl: site.url,
      what: 'report',
      log: { site: site.key, from: filter.from, to: filter.to, project: filter.project ?? 'all', users: filter.accountIds?.length ?? 'all' },
      generate: (hooks, o) => generateReport(site.jira, cfg, filter, hooks, o),
      summarize: (r) => ({ worklogs: r.worklogs.length, failedIssues: r.failedIssueKeys.length, complete: r.complete }),
    });
    return report ? { site: site.key, ...report } : reply;
  });

  runControlRoutes(app, '/api/report', { sites, cfg, runs });
}
