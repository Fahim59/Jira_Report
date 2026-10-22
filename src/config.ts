import { IANAZone } from 'luxon';
import { z } from 'zod';
import { parseSites } from './jira/sites.js';

const ConfigSchema = z.object({
  /** Comma-separated https://<sub>.atlassian.net URLs; the first is the default site. */
  JIRA_SITES: z.string().transform((raw, ctx) => {
    try {
      return parseSites(raw);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  }),
  /** Optional: only the probe script (`npm run probe`) uses them. The web app asks every user for their own email + API token. */
  JIRA_EMAIL: z.string().email().optional(),
  JIRA_API_TOKEN: z.string().min(1).optional(),
  REPORT_TZ: z
    .string()
    .default('Asia/Dhaka')
    .refine((tz) => IANAZone.isValidZone(tz), 'must be a valid IANA timezone'),
  JIRA_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  MAX_RANGE_DAYS: z.coerce.number().int().min(1).max(366).default(31),
  /** Whole-report deadline (search + all worklog fetches). */
  REPORT_TIMEOUT_SEC: z.coerce.number().int().min(10).max(3600).default(120),
  /** Custom Report "days" format: hours in one working day. */
  HOURS_PER_DAY: z.coerce.number().positive().max(24).default(8),
  /** Saved Custom Report templates (JSON, written atomically). Relative paths resolve against the working directory. */
  TEMPLATES_FILE: z.string().default('data/templates.json'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Loads .env (if present) into process.env without overriding already-set variables. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment.
  }
}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;
  if (env === process.env) loadDotEnv();

  // Treat empty strings as unset so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Only field names and messages are reported, never values (the token must not leak).
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    const renamed =
      cleaned.JIRA_BASE_URL && !cleaned.JIRA_SITES
        ? '\n  (JIRA_BASE_URL was replaced by JIRA_SITES: rename it, e.g. JIRA_SITES=https://your-site.atlassian.net)'
        : '';
    throw new Error(`Invalid configuration (see .env.example):\n${problems}${renamed}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}
