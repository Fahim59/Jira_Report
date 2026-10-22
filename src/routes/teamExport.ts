import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SiteRegistry } from '../jira/sites.js';
import { contentDisposition } from '../services/custom/export.js';
import { buildTeamWorkbook, teamFilename, type TeamGrid } from '../services/teamExcel.js';
import { zodMessage } from './runs.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-MM-dd');
const BODY_LIMIT = 32 * 1024 * 1024;
/** Caps on what one export may contain (the grid is a table this server's page produced, but anyone on the network can post). */
const MAX_ROWS = 20_000;
const MAX_COLS = 400;
const MAX_CELLS = 400_000;

const STYLES = ['level', 'totalHead', 'banner', 'period', 'periodWeekend', 'label', 'total', 'amount', 'amountWeekend', 'sumLabel'] as const;

const Cell = z
  .object({
    r: z.number().int().min(0).max(MAX_ROWS),
    c: z.number().int().min(0).max(MAX_COLS),
    rowSpan: z.number().int().min(1).max(MAX_ROWS),
    colSpan: z.number().int().min(1).max(MAX_COLS),
    text: z.string().max(2000),
    value: z.number().finite().optional(),
    // Only the two formats the page produces: General with an h / d suffix.
    numFmt: z.enum(['General"h"', 'General"d"']).optional(),
    style: z.enum(STYLES),
  })
  .refine((c) => c.r + c.rowSpan <= MAX_ROWS + 1 && c.c + c.colSpan <= MAX_COLS + 1, 'cell outside the sheet');

const Body = z
  .object({
    site: z.string().max(100).optional(),
    /** File name part instead of the site key (a report over several sites). */
    fileSite: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'invalid fileSite').optional(),
    from: isoDate,
    to: isoDate,
    complete: z.boolean().default(true),
    grid: z.object({
      rows: z.number().int().min(1).max(MAX_ROWS),
      cols: z.number().int().min(1).max(MAX_COLS),
      headRows: z.number().int().min(1).max(2),
      levelCols: z.number().int().min(1).max(100),
      cells: z.array(Cell).max(MAX_CELLS),
    }),
  })
  .refine((b) => b.from <= b.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((b) => b.grid.cells.every((c) => c.r + c.rowSpan <= b.grid.rows && c.c + c.colSpan <= b.grid.cols), {
    message: 'a cell lies outside the table',
    path: ['grid', 'cells'],
  });

export async function teamExportRoutes(app: FastifyInstance, opts: { sites: SiteRegistry }): Promise<void> {
  // The Team Reports table as one .xlsx, from the posted cells only: no Jira calls, nothing written to disk.
  app.post('/api/team-reports/export', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `Invalid table: ${zodMessage(parsed.error.issues.slice(0, 5))}` });
    const { site: siteKey, fileSite, from, to, complete, grid } = parsed.data;
    const site = opts.sites.resolve(siteKey);
    if (!site) return reply.code(400).send({ error: `Invalid table: ${opts.sites.unknownSiteMessage(siteKey)}` });

    const wb = buildTeamWorkbook(grid as TeamGrid);
    const out = new PassThrough();
    // exceljs zips into the stream and ends it; a failure aborts the download instead of sending a corrupt file.
    wb.xlsx.write(out).catch((err: Error) => {
      req.log.error({ err: err.message }, 'team excel export failed');
      out.destroy(err);
    });
    return reply
      .header('Content-Disposition', contentDisposition(teamFilename(fileSite ?? site.key, from, to, complete)))
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(out);
  });
}
