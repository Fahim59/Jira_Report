import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { SiteRegistry } from '../jira/sites.js';
import type { TreeNode } from '../services/custom/engine.js';
import { contentDisposition, templateFilename, type WorkbookReport } from '../services/custom/export.js';
import { MAX_PROJECTS, MAX_RUN_AUTHORS } from '../services/custom/filter.js';
import { SheetSchema, TemplateBodySchema } from '../services/custom/template.js';
import { buildTemplateWorkbook } from '../services/customExcel.js';
import { zodMessage } from './runs.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-MM-dd');
const seconds = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max);
const amounts = z.record(z.string().max(16), seconds);

/** Generous caps: the body is a report this server produced, but anyone on the network can post. */
const MAX_NODES = 50_000;
const MAX_ROWS = 200_000;
const MAX_WORKLOGS = 200_000;
const BODY_LIMIT = 96 * 1024 * 1024;
const MAX_LABELS = 5_000;

const worklogIds = z.array(text(64)).max(MAX_WORKLOGS);

const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    fieldId: text(100),
    value: text(2000),
    label: text(2000),
    total: seconds,
    periods: amounts,
    columns: z.record(text(100), text(10_000)),
    worklogIds,
    issueCount: count,
    worklogCount: count,
    children: z.array(TreeNodeSchema).max(MAX_NODES),
  }),
);

const sheetBase = {
  name: text(31),
  sheet: SheetSchema,
  total: seconds,
  showTotals: z.boolean(),
  headers: z.object({ groupBy: z.array(text(200)).max(3), columns: z.array(text(200)).max(20), total: text(100) }),
  worklogIds,
};
const flatSheet = {
  ...sheetBase,
  columns: z.array(text(100)).max(20),
  rows: z
    .array(z.object({ key: text(64), cells: z.array(z.union([text(50_000), seconds])).max(20), seconds, worklogIds }))
    .max(MAX_ROWS),
};

function sheetResultSchema(maxRangeDays: number) {
  return z
    .discriminatedUnion('mode', [
      z.object({
        ...sheetBase,
        mode: z.literal('group'),
        tree: z.object({
          // Week / month buckets are fewer than days, so the range limit caps every period kind.
          periodKeys: z.array(text(16)).max(maxRangeDays),
          nodes: z.array(TreeNodeSchema).max(MAX_NODES),
          total: seconds,
          periods: amounts,
          issueCount: count,
          worklogCount: count,
        }),
      }),
      z.object({ ...flatSheet, mode: z.literal('eachWorklog') }),
      z.object({ ...flatSheet, mode: z.literal('eachIssue') }),
    ])
    .refine((s) => s.sheet.rows.mode === s.mode && s.sheet.name === s.name, 'sheet result does not match its sheet');
}

/** The result JSON of POST /api/custom-report (as displayed). Unknown keys (issues, jql, ...) are dropped. */
function templateReportSchema(maxRangeDays: number) {
  return z
    .object({
      site: z.string().max(100).optional(),
      from: isoDate,
      to: isoDate,
      filter: z.object({
        from: isoDate,
        to: isoDate,
        projects: z.array(text(128)).max(MAX_PROJECTS),
        authors: z.array(text(128)).max(MAX_RUN_AUTHORS),
      }),
      template: TemplateBodySchema,
      fields: z.array(z.object({ id: text(100), name: text(500), custom: z.boolean(), schemaType: text(100) })).max(500),
      sheets: z.array(sheetResultSchema(maxRangeDays)).min(1).max(10),
      // Only the author names are used (the "Users:" filter line).
      worklogs: z.array(z.object({ accountId: text(128), user: text(256) })).max(MAX_WORKLOGS),
      timeZone: z.string().max(64).refine((tz) => DateTime.local().setZone(tz).isValid, 'is not a valid time zone'),
      hoursPerDay: z.number().positive().max(24),
      retrievedAt: text(64),
      complete: z.boolean(),
      failedIssueKeys: z.array(text(64)).max(MAX_WORKLOGS),
      failureReasons: z.array(text(500)).max(50).optional(),
    })
    .refine((r) => r.from <= r.to, { message: 'from must be on or before to', path: ['from'] })
    .refine((r) => r.sheets.length === r.template.sheets.length, { message: 'one sheet result per template sheet', path: ['sheets'] })
    .refine((r) => r.sheets.every((s, i) => s.name === r.template.sheets[i]?.name && s.mode === r.template.sheets[i]?.rows.mode), {
      message: 'sheet results do not match the template sheets',
      path: ['sheets'],
    });
}

const labelMap = z
  .record(text(128), text(500))
  .refine((m) => Object.keys(m).length <= MAX_LABELS, `at most ${MAX_LABELS} labels`)
  .optional();

export async function customExportRoutes(app: FastifyInstance, opts: { sites: SiteRegistry; cfg: Pick<Config, 'MAX_RANGE_DAYS'> }): Promise<void> {
  const Body = z.object({
    report: templateReportSchema(opts.cfg.MAX_RANGE_DAYS),
    // Display names the browser has (the report carries keys/accountIds only).
    labels: z.object({ projects: labelMap, users: labelMap }).optional(),
  });

  // One .xlsx (a worksheet per template sheet) from the posted result only: no Jira calls, nothing written to disk.
  app.post('/api/custom-report/export', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `Invalid report: ${zodMessage(parsed.error.issues.slice(0, 5))}` });
    const { labels } = parsed.data;
    const report = parsed.data.report as WorkbookReport;
    const site = opts.sites.resolve(report.site);
    if (!site) return reply.code(400).send({ error: `Invalid report: ${opts.sites.unknownSiteMessage(report.site)}` });

    const wb = buildTemplateWorkbook(report, labels, { siteUrl: site.url });
    const out = new PassThrough();
    // exceljs zips into the stream and ends it; a failure aborts the download instead of sending a corrupt file.
    wb.xlsx.write(out).catch((err: Error) => {
      req.log.error({ err: err.message }, 'custom excel export failed');
      out.destroy(err);
    });
    return reply
      .header('Content-Disposition', contentDisposition(templateFilename(report)))
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(out);
  });
}
