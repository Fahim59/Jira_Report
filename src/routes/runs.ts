import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { jiraErrorResponse } from '../jira/errors.js';
import type { SiteRegistry } from '../jira/sites.js';
import { RangeValidationError, ReportAbortedError, UnknownProjectError, type GenerateHooks } from '../services/report.js';
import { RUN_ID, type ProgressEvent, type RunRegistry } from '../services/runs.js';
import { siteQuery } from './site.js';

// Shared by POST /api/report and POST /api/custom-report: double-submit guard, abort on disconnect,
// throttled progress, timeout/cancel status codes, one log line per request, SSE progress and cancel routes.

/** Worklog progress is throttled to this interval (the last update always goes out). */
const PROGRESS_INTERVAL_MS = 150;
const SSE_HEARTBEAT_MS = 15_000;

type RunCfg = Pick<Config, 'REPORT_TIMEOUT_SEC'>;

/** A request error that is the user's to fix (HTTP 400 with its message). */
function isInvalidInput(err: unknown): boolean {
  return (
    err instanceof RangeValidationError ||
    err instanceof UnknownProjectError ||
    (err instanceof Error && (err as { statusCode?: unknown }).statusCode === 400)
  );
}

/** Status + message for anything a report generator can throw. */
export function errorResponse(err: unknown, baseUrl: string): { status: number; error: string; outcome: string } {
  if (isInvalidInput(err)) return { status: 400, error: (err as Error).message, outcome: 'invalid' };
  if (err instanceof ReportAbortedError) {
    // 499 (client closed request): normally nobody is left to read it.
    return err.reason === 'timeout' ? { status: 504, error: err.message, outcome: 'timeout' } : { status: 499, error: err.message, outcome: 'cancelled' };
  }
  return { ...jiraErrorResponse(err, baseUrl), outcome: 'error' };
}

export interface RunSpec<T> {
  runs: RunRegistry;
  cfg: RunCfg;
  requestId: string | undefined;
  siteUrl: string;
  /** Fields for the per-request log line (site, range, filter summary). */
  log: Record<string, unknown>;
  /** Log message stem: "<what> generated" / "<what> not generated". */
  what: string;
  generate: (hooks: GenerateHooks, opts: { signal: AbortSignal; timeoutMs: number }) => Promise<T>;
  /** Result fields for the success log line. */
  summarize: (result: T) => Record<string, unknown>;
}

/** Runs one report request with progress, cancel, timeout and logging. Returns the result, or undefined once the error reply is sent. */
export async function runReport<T>(req: FastifyRequest, reply: FastifyReply, spec: RunSpec<T>): Promise<T | undefined> {
  const { runs, cfg } = spec;
  const id = spec.requestId ?? randomUUID();
  const controller = runs.start(id);
  if (!controller) {
    return runs.isRunning(id)
      ? void reply.code(409).send({ error: 'This report is already being generated.' })
      : void reply.code(503).send({ error: 'The server is busy with too many reports. Try again shortly.' });
  }
  // Browser gone (Cancel, tab closed, network drop): stop the Jira work.
  const onClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.on('close', onClose);

  const t0 = Date.now();
  let issues: number | undefined;
  let lastProgress = 0;
  const logBase = () => ({ ...spec.log, issues, elapsedMs: Date.now() - t0 });

  try {
    const result = await spec.generate(
      {
        onStage: (stage) => runs.publish(id, stage === 'worklogs' ? { stage, done: 0, total: issues } : { stage }),
        onIssues: (n) => {
          issues = n;
          runs.publish(id, { stage: 'searching', issues: n });
        },
        onWorklogProgress: (done, total) => {
          const now = Date.now();
          if (done < total && now - lastProgress < PROGRESS_INTERVAL_MS) return;
          lastProgress = now;
          runs.publish(id, { stage: 'worklogs', done, total });
        },
        onWorklogError: (key, err) => req.log.warn({ issueKey: key, err: (err as Error).message }, 'worklog fetch failed'),
        onInvalidWorklog: (w) => req.log.warn(w, 'unparseable worklog started'),
      },
      { signal: controller.signal, timeoutMs: cfg.REPORT_TIMEOUT_SEC * 1000 },
    );
    req.log.info({ report: { ...logBase(), ...spec.summarize(result), outcome: 'ok' } }, `${spec.what} generated`);
    runs.finish(id, { stage: 'done' });
    return result;
  } catch (err) {
    const { status, error, outcome } = errorResponse(err, spec.siteUrl);
    const level = outcome === 'invalid' || outcome === 'cancelled' ? 'info' : 'warn';
    req.log[level]({ report: { ...logBase(), complete: false, outcome, err: (err as Error).message } }, `${spec.what} not generated`);
    runs.finish(id, { stage: 'failed', message: error });
    reply.code(status).send({ error });
    return undefined;
  } finally {
    reply.raw.off('close', onClose);
  }
}

/**
 * POST <base>/:id/cancel and GET <base>/progress/:id (SSE). Run ids are unique across sites and report kinds
 * (one shared RunRegistry); ?site is accepted for consistency and only validated.
 */
export function runControlRoutes(app: FastifyInstance, base: string, opts: { sites: SiteRegistry; cfg: RunCfg; runs: RunRegistry }): void {
  const { sites, cfg, runs } = opts;

  // Explicit cancel (in addition to the browser aborting its request), e.g. when a proxy keeps the upstream open.
  app.post(`${base}/:id/cancel`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!sites.resolve(siteQuery(req))) return reply.code(400).send({ error: sites.unknownSiteMessage(siteQuery(req)) });
    if (!RUN_ID.test(id)) return reply.code(400).send({ error: 'invalid id' });
    return runs.cancel(id) ? reply.code(204).send() : reply.code(404).send({ error: 'No report with this id is being generated.' });
  });

  // Server-Sent Events: stage updates for one run. Ends after "done" / "failed".
  app.get(`${base}/progress/:id`, (req, reply) => {
    const { id } = req.params as { id: string };
    if (!sites.resolve(siteQuery(req))) {
      reply.code(400).send({ error: sites.unknownSiteMessage(siteQuery(req)) });
      return;
    }
    if (!RUN_ID.test(id)) {
      reply.code(400).send({ error: 'invalid id' });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer
    });

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    // A stream whose report never starts (or already ended) must not live forever.
    const maxLife = setTimeout(() => close(), (cfg.REPORT_TIMEOUT_SEC + 60) * 1000);
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(maxLife);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
    }
    const send = (e: ProgressEvent) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.stage === 'done' || e.stage === 'failed') close();
    };

    res.on('close', close);
    res.write('retry: 5000\n\n');
    unsubscribe = runs.subscribe(id, send);
    if (!unsubscribe) close();
    else if (closed) unsubscribe();
  });
}

/** zod issues → "path: message; ..." (400 body). */
export function zodMessage(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; ');
}
