import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SiteAccessCache } from '../jira/access.js';
import { parseBasicAuth, runWithCredentials } from '../jira/auth.js';
import { jiraErrorResponse } from '../jira/errors.js';
import type { SiteRegistry } from '../jira/sites.js';
import { zodMessage } from './runs.js';

/**
 * Routes that need no sign-in: the login itself, and the progress streams. EventSource cannot send an Authorization
 * header; a progress stream is addressed by the request's random 128-bit id and carries only stage names and counters.
 */
function isPublic(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/login') return true;
  return method === 'GET' && /^\/api\/(report|custom-report)\/progress\/[^/]+$/.test(path);
}

/**
 * Every other /api call must carry `Authorization: Basic base64(email:apiToken)`: a missing or malformed header is a 401,
 * a valid-looking one runs the rest of the request with those credentials (src/jira/auth.ts), so the Jira clients act as
 * that user. Whether Jira accepts them is found out by the first Jira call (a 401 from Jira is passed on as a 401).
 * Install before registering the route plugins.
 */
export function installAuth(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || isPublic(req.method, path)) return done();
    const creds = parseBasicAuth(req.headers.authorization);
    if (!creds) return void reply.code(401).send({ error: 'Sign in required.' });
    runWithCredentials(creds, done);
  });
}

const LoginBody = z.object({
  email: z.string().trim().email('Enter the email address of your Atlassian account.').max(254),
  token: z.string().min(1, 'Enter your Atlassian API token.').max(1024),
});

export async function loginRoutes(app: FastifyInstance, opts: { sites: SiteRegistry; access: SiteAccessCache }): Promise<void> {
  // Checks the email + API token with Jira: tried on every configured site, the ones that accept it are the user's sites.
  // Nothing is stored: the browser keeps the credentials and sends them with every request.
  app.post('/api/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error.issues) });
    const creds = { email: parsed.data.email, token: parsed.data.token };
    const access = await opts.access.get(creds, true);
    const first = access.sites[0];
    if (first && access.user) {
      return { email: creds.email, displayName: access.user.displayName, accountId: access.user.accountId, site: first.key, sites: access.sites };
    }

    const unchecked = access.unchecked[0];
    req.log.warn({ sites: opts.sites.keys, unchecked: access.unchecked.map((u) => u.site.key) }, 'login failed');
    if (unchecked) {
      // Some site could not be asked (down, timed out): that is not a wrong token, so do not say it is.
      const { status, error } = jiraErrorResponse(unchecked.err, unchecked.site.url);
      return reply.code(status === 401 ? 502 : status).send({ error });
    }
    return reply.code(401).send({
      error: `Jira did not accept this email and API token on ${opts.sites.keys.length > 1 ? 'any of the configured Jira sites' : 'the configured Jira site'} (${opts.sites.keys.join(', ')}). Check both, and that the token has not been revoked (create one at id.atlassian.com → Security → API tokens).`,
    });
  });
}
