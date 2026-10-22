import type { FastifyInstance } from 'fastify';

/**
 * Root error handler: a thrown error with a 4xx statusCode → `{ error: message }` with that status; a 5xx with
 * `expose: true` (a message written for the user, e.g. Jira unavailable) → that status and message; anything else →
 * 500 `{ error: 'Internal server error' }` (logged, message not sent). Call it before registering any route plugin:
 * a plugin keeps the error handler that was set when it was registered.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: Error & { statusCode?: number; expose?: boolean }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const show = status < 500 || err.expose === true;
    if (!show) req.log.error({ err: err.message }, 'request failed');
    return reply.code(status).send({ error: show ? err.message : 'Internal server error' });
  });
}
