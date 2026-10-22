import { resolve } from 'node:path';
import { buildServer } from './app.js';
import { loadConfig, type Config } from './config.js';

async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const app = await buildServer(cfg);
  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
  app.log.info(`Jira sites: ${cfg.JIRA_SITES.map((s) => s.url).join(', ')} (default ${cfg.JIRA_SITES[0]!.key}) | REPORT_TZ=${cfg.REPORT_TZ} | concurrency=${cfg.JIRA_CONCURRENCY} | timeout=${cfg.REPORT_TIMEOUT_SEC}s | templates=${resolve(cfg.TEMPLATES_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
