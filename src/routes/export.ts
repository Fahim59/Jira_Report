import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { SiteRegistry } from '../jira/sites.js';
import { buildWorkbook, exportFilename } from '../services/excel.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-MM-dd');
const seconds = z.number().finite().nonnegative();
const text = (max: number) => z.string().max(max);

/** Generous caps: the body is a report this server produced, but anyone on the network can post. */
const MAX_ROWS = 5_000;
const MAX_WORKLOGS = 200_000;
const BODY_LIMIT = 64 * 1024 * 1024;

/** The report JSON returned by POST /api/report. Unknown keys are dropped. */
export function reportSchema(maxRangeDays: number) {
  return z
    .object({
      // Site key: resolved against the configured sites (unknown -> 400), then used for links and the filename.
      site: z.string().max(100).optional(),
      from: isoDate,
      to: isoDate,
      // Ends up in the filename, so only Jira-key characters are allowed.
      project: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, 'must be a Jira project key').optional(),
      dates: z.array(isoDate).min(1).max(maxRangeDays),
      rows: z
        .array(
          z.object({
            accountId: text(128),
            user: text(256),
            byDate: z.record(z.string(), seconds),
            total: seconds,
          }),
        )
        .max(MAX_ROWS),
      dateTotals: z.record(z.string(), seconds),
      grandTotal: seconds,
      worklogs: z
        .array(
          z.object({
            id: text(64),
            date: isoDate,
            accountId: text(128),
            user: text(256),
            issueKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, 'must be an issue key'),
            summary: text(2000),
            project: text(64),
            seconds,
          }),
        )
        .max(MAX_WORKLOGS),
      retrievedAt: text(64),
      complete: z.boolean(),
      failedIssueKeys: z.array(text(64)).max(MAX_WORKLOGS),
    })
    .refine((r) => r.from <= r.to, { message: 'from must be on or before to', path: ['from'] });
}

export async function exportRoutes(app: FastifyInstance, opts: { sites: SiteRegistry; cfg: Pick<Config, 'MAX_RANGE_DAYS'> }): Promise<void> {
  const schema = reportSchema(opts.cfg.MAX_RANGE_DAYS);

  // Builds the .xlsx from the posted report only: no Jira calls, nothing written to disk.
  app.post('/api/export', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send({ error: `Invalid report: ${msg}` });
    }
    const report = parsed.data;
    const site = opts.sites.resolve(report.site);
    if (!site) return reply.code(400).send({ error: `Invalid report: ${opts.sites.unknownSiteMessage(report.site)}` });

    const wb = buildWorkbook(report, site.url);
    const out = new PassThrough();
    // exceljs zips into the stream and ends it; a failure aborts the download instead of sending a corrupt file.
    wb.xlsx.write(out).catch((err: Error) => {
      req.log.error({ err: err.message }, 'excel export failed');
      out.destroy(err);
    });

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${exportFilename(report, site.key)}"`)
      .header('Cache-Control', 'no-store')
      .send(out);
  });
}
