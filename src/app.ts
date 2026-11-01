import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Config } from './config.js';
import { SiteAccessCache } from './jira/access.js';
import { FieldCache } from './jira/fields.js';
import { SiteRegistry, type SiteEntry } from './jira/sites.js';
import { installAuth, loginRoutes } from './routes/auth.js';
import { customExportRoutes } from './routes/customExport.js';
import { customReportRoutes } from './routes/customReport.js';
import { installErrorHandler } from './routes/errors.js';
import { exportRoutes } from './routes/export.js';
import { listRoutes } from './routes/list.js';
import { teamExportRoutes } from './routes/teamExport.js';
import { fieldRoutes } from './routes/fields.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';
import { reportRoutes } from './routes/report.js';
import { templateRoutes } from './routes/templates.js';
import { settingsRoutes } from './routes/settings.js';
import { RunRegistry } from './services/runs.js';
import { FileTemplateStore } from './services/templateStore.js';

const WEB_DIST = resolve(process.cwd(), 'dist/web');

/** The Fastify app with every route. `sites` overrides the registry built from cfg (tests). */
export async function buildServer(cfg: Config, opts: { sites?: SiteEntry[]; logger?: boolean } = {}) {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Every request carries the user's Jira token in `Authorization`: never log it (or cookies).
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
  });
  // Before any route plugin: plugins keep the handler that was set when they were registered.
  installErrorHandler(app);
  // Sign-in: every /api route but the login and the progress streams needs the user's email + API token.
  installAuth(app);

  const sites = opts.sites ? new SiteRegistry(opts.sites) : SiteRegistry.fromConfig(cfg);
  // Which configured sites accept each user's token (their dropdown); shared by the login and GET /api/sites.
  const access = new SiteAccessCache(sites);
  await app.register(loginRoutes, { sites, access });
  await app.register(healthRoutes, { sites });
  await app.register(metaRoutes, { sites, cfg, access });
  // One registry for both reports: a requestId is unique across them (double-submit guard, progress, cancel).
  const runs = new RunRegistry();
  const fields = new FieldCache();
  await app.register(reportRoutes, { sites, cfg, runs });
  await app.register(exportRoutes, { sites, cfg });
  await app.register(fieldRoutes, { sites, fields });
  await app.register(customReportRoutes, { sites, fields, cfg, runs });
  await app.register(customExportRoutes, { sites, cfg });
  await app.register(teamExportRoutes, { sites });
  await app.register(listRoutes, { sites, fields });
  const store = new FileTemplateStore(resolve(cfg.TEMPLATES_FILE), { onWarn: (msg) => app.log.warn(msg) });
  await app.register(templateRoutes, { sites, fields, store });
  await app.register(settingsRoutes, { store });

  // Frontend (built by `npm run build:web`). Served only if the build output exists.
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  return app;
}
