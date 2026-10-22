import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { FieldCache } from '../jira/fields.js';
import type { SiteRegistry } from '../jira/sites.js';
import { GlobalFilterSchema, TemplateBodySchema } from '../services/custom/template.js';
import { generateTemplateReport } from '../services/customReport.js';
import { RUN_ID, type RunRegistry } from '../services/runs.js';
import { errorResponse, runControlRoutes, runReport, zodMessage } from './runs.js';
import { requireSite, siteQuery } from './site.js';

const CustomReportBody = z.object({
  // Global filter (every sheet): filter.site or ?site=<key>; missing = first configured site.
  filter: GlobalFilterSchema,
  // Inline template, saved or not: its sheets narrow the one fetch in code.
  template: TemplateBodySchema,
  // Optional: progress via GET /api/custom-report/progress/:id (or /api/report/progress/:id), cancel by id.
  requestId: z.string().regex(RUN_ID, 'invalid requestId').optional(),
});

export async function customReportRoutes(
  app: FastifyInstance,
  opts: {
    sites: SiteRegistry;
    fields: FieldCache;
    cfg: Pick<Config, 'REPORT_TZ' | 'JIRA_CONCURRENCY' | 'MAX_RANGE_DAYS' | 'REPORT_TIMEOUT_SEC' | 'HOURS_PER_DAY'>;
    /** Shared with /api/report, so the double-submit guard and progress/cancel ids span both reports. */
    runs: RunRegistry;
  },
): Promise<void> {
  const { sites, fields, cfg, runs } = opts;

  app.post('/api/custom-report', async (req, reply) => {
    const parsed = CustomReportBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error.issues) });
    const { filter, template, requestId } = parsed.data;
    const site = requireSite(sites, filter.site ?? siteQuery(req), reply);
    if (!site) return reply;

    let siteFields;
    try {
      siteFields = await fields.get(site.key, site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'field list failed');
      const { status, error } = errorResponse(err, site.url);
      return reply.code(status).send({ error: `Could not load fields. ${error}` });
    }

    const report = await runReport(req, reply, {
      runs,
      cfg,
      requestId,
      siteUrl: site.url,
      what: 'custom report',
      log: {
        site: site.key,
        from: filter.from,
        to: filter.to,
        projects: filter.projects.length || 'all',
        users: filter.authors.length || 'all',
        template: template.name,
        sheets: template.sheets.length,
        sheetJql: template.sheets.filter((s) => s.filter.jql).length,
      },
      generate: (hooks, o) => generateTemplateReport(site.jira, cfg, siteFields, filter, template, hooks, o),
      summarize: (r) => ({ worklogs: r.worklogs.length, failedIssues: r.failedIssueKeys.length, warnings: r.warnings.length, complete: r.complete }),
    });
    return report ? { site: site.key, ...report } : reply;
  });

  runControlRoutes(app, '/api/custom-report', { sites, cfg, runs });
}
