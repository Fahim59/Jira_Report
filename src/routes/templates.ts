import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jiraErrorResponse } from '../jira/errors.js';
import type { FieldCache } from '../jira/fields.js';
import type { SiteEntry, SiteRegistry } from '../jira/sites.js';
import { isBuiltinId, resolveStarter, STARTER_TEMPLATES } from '../services/custom/presets.js';
import { TemplateBodySchema, type Template, type TemplateBody } from '../services/custom/template.js';
import { checkTemplateFields } from '../services/customReport.js';
import { ReadOnlyTemplateError, type TemplateStore } from '../services/templateStore.js';
import { errorResponse, zodMessage } from './runs.js';
import { siteQuery } from './site.js';

/** A built-in starter resolved for one site: read-only; `warnings` = fields the site lacks. */
export interface BuiltinTemplate extends TemplateBody {
  id: string;
  site: string;
  isDefault: boolean;
  builtIn: true;
  warnings: string[];
}

export type TemplateListItem = (Template & { builtIn: false }) | BuiltinTemplate;

// POST takes the site from body.site or ?site=; PUT keeps the template's site.
const CreateBody = TemplateBodySchema.extend({ site: z.string().max(100).optional() });
// updatedAt = the version the editor loaded: if someone saved in between, 409 instead of overwriting their change.
const UpdateBody = TemplateBodySchema.extend({ updatedAt: z.string().max(40).optional() });
const idOf = (params: unknown): string => (params as { id: string }).id;

/** An error with a message for the user; the root error handler sends it as `{ error }` with this status. */
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, expose: true });

export async function templateRoutes(
  app: FastifyInstance,
  opts: { sites: SiteRegistry; fields: FieldCache; store: TemplateStore },
): Promise<void> {
  const { sites, fields, store } = opts;

  /** ?site= (or `key`) resolved; unknown → 400. Store errors (404 / 403 / 409) are thrown to the root error handler. */
  const siteOf = (req: FastifyRequest, key: unknown = siteQuery(req)): SiteEntry => {
    const site = sites.resolve(key);
    if (!site) throw httpError(400, sites.unknownSiteMessage(key));
    return site;
  };

  /** Every field the body uses must exist on the site (400 naming the sheet and field); Jira errors → 502/503. */
  async function checkFields(req: FastifyRequest, site: SiteEntry, body: TemplateBody): Promise<void> {
    let siteFields;
    try {
      siteFields = await fields.get(site.key, site.jira);
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'field list failed (template save)');
      const { status, error } = errorResponse(err, site.url);
      throw httpError(status, `Could not check the template's fields. ${error}`);
    }
    checkTemplateFields(body, siteFields);
  }

  // Built-in starters first (preset order, resolved against the site's fields), then the site's saved templates by name.
  // Saved templates are listed even when Jira is unreachable; the starters are then left out with a warning.
  // defaultId = the site's default (saved or built-in), if any.
  app.get('/api/templates', async (req) => {
    const site = siteOf(req);
    const [saved, defaultId] = await Promise.all([store.list(site.key), store.defaultId(site.key)]);
    const warnings: string[] = [];
    let builtins: BuiltinTemplate[] = [];
    try {
      const siteFields = await fields.get(site.key, site.jira);
      builtins = STARTER_TEMPLATES.map((s) => {
        const { template, warnings: missing } = resolveStarter(s, siteFields);
        return { ...template, id: s.id, site: site.key, isDefault: s.id === defaultId, builtIn: true, warnings: missing };
      });
    } catch (err) {
      req.log.warn({ site: site.key, err: (err as Error).message }, 'field list failed (built-in templates)');
      warnings.push(`Built-in templates are unavailable: could not load fields. ${jiraErrorResponse(err, site.url).error}`);
    }
    const templates: TemplateListItem[] = [...builtins, ...saved.map((t) => ({ ...t, builtIn: false as const }))];
    return { site: site.key, ...(defaultId ? { defaultId } : {}), templates, warnings };
  });

  app.post('/api/templates', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw httpError(400, zodMessage(parsed.error.issues));
    const { site: bodySite, ...body } = parsed.data;
    const site = siteOf(req, bodySite ?? siteQuery(req));
    await checkFields(req, site, body);
    const template = await store.create(site.key, body);
    req.log.info({ site: site.key, id: template.id, name: template.name }, 'template created');
    return reply.code(201).send(template);
  });

  app.put('/api/templates/:id', async (req) => {
    const id = idOf(req.params);
    if (isBuiltinId(id)) throw new ReadOnlyTemplateError();
    const parsed = UpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw httpError(400, zodMessage(parsed.error.issues));
    const { updatedAt, ...body } = parsed.data;
    const existing = await store.get(id); // 404 before any Jira call
    const site = sites.resolve(existing.site);
    // A template of a site that is no longer configured cannot be checked; the store still accepts the edit.
    if (site) await checkFields(req, site, body);
    const template = await store.update(id, body, updatedAt);
    req.log.info({ site: template.site, id, name: template.name }, 'template updated');
    return template;
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const id = idOf(req.params);
    await store.delete(id);
    req.log.info({ id }, 'template deleted');
    return reply.code(204).send();
  });

  // Default pointer per site. A saved template's own site is used; a built-in (builtin:*) is the default of ?site=.
  app.post('/api/templates/:id/default', async (req) => {
    const id = idOf(req.params);
    const pointer = await store.setDefault(id, isBuiltinId(id) ? siteOf(req).key : undefined);
    req.log.info({ site: pointer.site, id }, 'template set as default');
    return { site: pointer.site, defaultId: id };
  });

  // Unset default: the site has no default afterwards if it was `id` (no-op otherwise).
  app.delete('/api/templates/:id/default', async (req, reply) => {
    const id = idOf(req.params);
    const pointer = await store.clearDefault(id, isBuiltinId(id) ? siteOf(req).key : undefined);
    req.log.info({ site: pointer.site, id }, 'template default unset');
    return reply.code(204).send();
  });
}
