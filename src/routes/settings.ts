// Browser-side saved choices (List columns, favourites) kept in the templates file (TEMPLATES_FILE, key "settings"),
// so one committed file ships everything to another deployment. Shared by everyone who uses this server.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TemplateStore } from '../services/templateStore.js';

/** The only localStorage keys the server keeps. */
export const SYNCED_KEYS = ['worklog-report:list-columns-2', 'worklog-report:favourites', 'worklog-report:list-views'] as const;

const PutBody = z.object({
  key: z.enum(SYNCED_KEYS),
  value: z.string().max(500_000),
});

export async function settingsRoutes(app: FastifyInstance, opts: { store: TemplateStore }): Promise<void> {
  const { store } = opts;

  app.get('/api/settings', async () => {
    const all = await store.settings();
    const values: Record<string, string> = {};
    for (const key of SYNCED_KEYS) if (all[key] !== undefined) values[key] = all[key];
    return { values };
  });

  app.put('/api/settings', async (req, reply) => {
    const body = PutBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid setting.' });
    await store.setSetting(body.data.key, body.data.value);
    return reply.code(204).send();
  });
}
