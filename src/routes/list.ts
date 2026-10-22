import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { searchIssuesLimited } from '../jira/custom.js';
import type { FieldCache } from '../jira/fields.js';
import type { SiteRegistry } from '../jira/sites.js';
import { contentDisposition } from '../services/custom/export.js';
import { normalizeFieldValue } from '../services/custom/fields.js';
import { jqlString } from '../services/custom/filter.js';
import { errorResponse, zodMessage } from './runs.js';
import { requireSite, siteQuery } from './site.js';

/** Most work items one list request returns (Jira's own List view pages lazily; this one loads them in one go). */
export const LIST_LIMIT = 1000;
/** Most work items one export reads (`all: true`): every match, like Jira's export, up to this safety cap. */
export const EXPORT_LIMIT = 20_000;
/** Work items looked at to find the people with recent activity. */
const ACTIVITY_LIMIT = 2000;
const MAX_COLUMNS = 60;
const MAX_ROWS = 20_000;
const MAX_EXPORT_COLS = 100;

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** Columns the list computes from the issue itself (they are not Jira fields to request). */
export const LIST_PSEUDO: ReadonlySet<string> = new Set(['issue.key', 'issue.id', 'assignee.id', 'parent.id', 'parent.key', 'parent.summary']);

const ListBody = z.object({
  site: z.string().max(100).optional(),
  projects: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'invalid project key')).max(50).default([]),
  assignees: z.array(z.string().min(1).max(128)).max(100).default([]),
  /** Optional JQL (conditions, with an optional ORDER BY at the end). */
  jql: z.string().max(2000).default(''),
  hideDone: z.boolean().default(false),
  /** Read every match (up to EXPORT_LIMIT) instead of the first LIST_LIMIT: for the Excel export. */
  all: z.boolean().default(false),
  /** Jira field ids to return values for (the table's columns, the group field, filter fields). */
  fields: z.array(z.string().regex(FIELD_ID, 'invalid field id')).max(MAX_COLUMNS).default([]),
});

/** "conditions ORDER BY x" → [conditions, "ORDER BY x"]. A quoted "order by" inside a string is not looked for. */
export function splitOrderBy(jql: string): { conditions: string; order: string } {
  const m = /\border\s+by\b/i.exec(jql);
  if (!m) return { conditions: jql.trim(), order: '' };
  return { conditions: jql.slice(0, m.index).trim(), order: jql.slice(m.index).trim() };
}

/** The JQL for one list request, or undefined when nothing narrows it (Jira refuses unbounded searches). */
export function listJql(b: { projects: string[]; assignees: string[]; jql: string; hideDone: boolean }): string | undefined {
  const { conditions, order } = splitOrderBy(b.jql);
  const parts = [
    b.projects.length ? `project in (${b.projects.map(jqlString).join(', ')})` : '',
    b.assignees.length ? `assignee in (${b.assignees.map(jqlString).join(', ')})` : '',
    conditions ? `(${conditions})` : '',
  ].filter(Boolean);
  if (parts.length === 0) return undefined;
  if (b.hideDone) parts.push('statusCategory != Done');
  return `${parts.join(' AND ')} ${order || 'ORDER BY created DESC'}`;
}

interface RawIssue {
  id?: string;
  key: string;
  fields?: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const ExportBody = z.object({
  site: z.string().max(100).optional(),
  /** File name stem (default "work-items_<site>"). */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, 'invalid name').optional(),
  headers: z.array(z.string().max(200)).min(1).max(MAX_EXPORT_COLS),
  rows: z
    .array(
      z.object({
        cells: z.array(z.string().max(2000)).max(MAX_EXPORT_COLS),
        /** Hierarchy depth (indent of the first column). */
        level: z.number().int().min(0).max(20).default(0),
        /** A group heading row (bold, spans the table). */
        group: z.boolean().default(false),
      }),
    )
    .max(MAX_ROWS),
});

export async function listRoutes(app: FastifyInstance, opts: { sites: SiteRegistry; fields: FieldCache }): Promise<void> {
  const { sites, fields } = opts;

  // Work items of a Jira List view: one row per issue with the requested field values, parent key for the hierarchy.
  app.post('/api/list', async (req, reply) => {
    const parsed = ListBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error.issues) });
    const body = parsed.data;
    const site = requireSite(sites, body.site ?? siteQuery(req), reply);
    if (!site) return reply;

    const limit = body.all ? EXPORT_LIMIT : LIST_LIMIT;
    const jql = listJql(body);
    if (!jql) return reply.code(400).send({ error: 'Pick a project or a user, or type a JQL filter.' });

    try {
      const known = new Map((await fields.get(site.key, site.jira)).map((f) => [f.id, f]));
      const unknown = body.fields.filter((id) => !known.has(id) || (id.includes('.') && !LIST_PSEUDO.has(id)));
      if (unknown.length) return reply.code(400).send({ error: `Unknown field(s): ${unknown.join(', ')}` });

      const wanted = [...new Set(['summary', 'issuetype', 'status', 'parent', ...(body.fields.includes('assignee.id') ? ['assignee'] : []), ...body.fields.filter((id) => !LIST_PSEUDO.has(id))])];
      const { issues, truncated } = await searchIssuesLimited(site.jira, jql, wanted, limit);
      const rows = (issues as RawIssue[]).map((issue) => {
        const f = obj(issue.fields);
        const type = obj(f.issuetype);
        const status = obj(f.status);
        const values: Record<string, string> = {};
        const parentField = obj(f.parent);
        const pseudo: Record<string, string> = {
          'issue.key': issue.key,
          'issue.id': str(issue.id),
          'assignee.id': str(obj(f.assignee).accountId),
          'parent.id': str(parentField.id),
          'parent.key': str(parentField.key),
          'parent.summary': str(obj(parentField.fields).summary),
        };
        for (const id of body.fields) values[id] = LIST_PSEUDO.has(id) ? (pseudo[id] ?? '') : normalizeFieldValue(f[id], known.get(id)?.schemaType);
        return {
          key: issue.key,
          summary: str(f.summary),
          type: str(type.name),
          subtask: type.subtask === true,
          status: str(status.name),
          statusCategory: str(obj(status.statusCategory).key),
          parent: str(obj(f.parent).key) || undefined,
          values,
        };
      });
      return { site: site.key, jql, rows, truncated, limit, retrievedAt: new Date().toISOString() };
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'list failed');
      const { status, error } = errorResponse(err, site.url);
      return reply.code(status).send({ error });
    }
  });

  // People with recent activity: assignee, reporter or creator of a work item updated in the last `days` days. Jira has no
  // "invited, not accepted" flag, so this stands in for it (an invited person has no work yet).
  app.get('/api/list/users', async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: zodMessage(q.error.issues) });
    const site = requireSite(sites, siteQuery(req), reply);
    if (!site) return reply;
    try {
      const { issues, truncated } = await searchIssuesLimited(site.jira, `updated >= -${q.data.days}d ORDER BY updated DESC`, ['assignee', 'reporter', 'creator'], ACTIVITY_LIMIT);
      const ids = new Set<string>();
      for (const issue of issues as RawIssue[]) {
        const f = obj(issue.fields);
        for (const role of ['assignee', 'reporter', 'creator']) {
          const id = str(obj(f[role]).accountId);
          if (id) ids.add(id);
        }
      }
      return { site: site.key, days: q.data.days, accountIds: [...ids], issues: issues.length, truncated };
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'list users failed');
      const { status, error } = errorResponse(err, site.url);
      return reply.code(status).send({ error });
    }
  });

  // The table as shown (hierarchy, groups, chosen columns) as one .xlsx. No Jira calls.
  app.post('/api/list/export', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ExportBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `Invalid table: ${zodMessage(parsed.error.issues.slice(0, 5))}` });
    const { headers, rows } = parsed.data;
    const site = sites.resolve(parsed.data.site);
    if (!site) return reply.code(400).send({ error: `Invalid table: ${sites.unknownSiteMessage(parsed.data.site)}` });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Work items', { views: [{ state: 'frozen', ySplit: 1 }] });
    const head = ws.addRow(headers);
    head.font = { bold: true };
    head.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F5F7' } };
    });
    const widths = headers.map((h) => Math.min(60, Math.max(10, h.length + 2)));
    for (const r of rows) {
      if (r.group) {
        const row = ws.addRow([r.cells[0] ?? '']);
        row.font = { bold: true };
        ws.mergeCells(row.number, 1, row.number, headers.length);
        continue;
      }
      const row = ws.addRow(headers.map((_, i) => r.cells[i] ?? ''));
      if (r.level) row.getCell(1).alignment = { indent: r.level };
      r.cells.forEach((v, i) => {
        if (i < widths.length) widths[i] = Math.min(60, Math.max(widths[i]!, v.length + 2 + (i === 0 ? r.level * 2 : 0)));
      });
    }
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    const out = new PassThrough();
    wb.xlsx.write(out).catch((err: Error) => {
      req.log.error({ err: err.message }, 'list excel export failed');
      out.destroy(err);
    });
    return reply
      .header('Content-Disposition', contentDisposition(`${parsed.data.name ?? `work-items_${site.key}`}_${new Date().toISOString().slice(0, 10)}.xlsx`))
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(out);
  });
}
