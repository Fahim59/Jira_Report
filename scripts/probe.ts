/**
 * Probe: hits Jira directly and prints a per-user, per-day hours matrix so it can be compared
 * against a known timesheet (and against the UI). Uses the same pipeline as POST /api/report.
 *
 *   npm run probe -- --from 2026-10-01 --to 2026-10-06 [--site <key>] [--project TPX] [--user <accountId>[,<accountId>...]]
 *
 * --site is the site's subdomain (from JIRA_SITES); default = the first site.
 */
import { parseArgs } from 'node:util';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { createJiraClient } from '../src/jira/client.js';
import { SiteRegistry } from '../src/jira/sites.js';
import { dateRange, generateReport, MAX_ACCOUNT_IDS, RangeValidationError } from '../src/services/report.js';

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error('Usage: npm run probe -- --from YYYY-MM-DD --to YYYY-MM-DD [--site KEY] [--project KEY] [--user ACCOUNT_ID[,ACCOUNT_ID...]]');
  process.exit(1);
}

function fmtHours(seconds: number): string {
  const h = Math.round((seconds / 3600) * 100) / 100;
  return `${h}h`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      site: { type: 'string' },
      project: { type: 'string' },
      user: { type: 'string' },
    },
    strict: true,
  });

  const cfg = loadConfig();
  const zone = cfg.REPORT_TZ;
  if (!values.from || !values.to) fail('--from and --to are required');

  const accountIds = values.user ? [...new Set(values.user.split(',').map((s) => s.trim()).filter(Boolean))] : [];
  if (accountIds.length > MAX_ACCOUNT_IDS) fail(`--user accepts at most ${MAX_ACCOUNT_IDS} account ids`);
  const filter = { from: values.from, to: values.to, project: values.project, accountIds };
  const sites = SiteRegistry.fromConfig(cfg);
  const site = sites.resolve(values.site);
  if (!site) fail(sites.unknownSiteMessage(values.site));
  // The web app asks each user for their own credentials; the probe is a CLI and uses the ones in .env.
  if (!cfg.JIRA_EMAIL || !cfg.JIRA_API_TOKEN) fail('the probe needs JIRA_EMAIL and JIRA_API_TOKEN in .env (the web app does not).');
  const client = createJiraClient(site.url, cfg);

  try {
    dateRange(filter.from, filter.to, cfg.MAX_RANGE_DAYS);
  } catch (err) {
    if (err instanceof RangeValidationError) fail(err.message);
    throw err;
  }

  console.log(`Jira:   ${site.url} (site ${site.key})`);
  console.log(`Range:  ${filter.from} .. ${filter.to} (${zone})${filter.project ? `  project=${filter.project}` : ''}${accountIds.length ? `  users=${accountIds.join(',')}` : ''}`);

  const t0 = Date.now();
  const report = await generateReport(client, cfg, filter, {
    onIssues: (n) => console.log(`Issues: ${n} matched JQL (window widened ±1 day)`),
    onWorklogError: (key, err) => console.error(`  ! worklog fetch failed for ${key}: ${(err as Error).message}`),
    onInvalidWorklog: (w) => console.error(`  ! unparseable started "${w.started}" on ${w.issueKey} worklog ${w.worklogId}`),
  }, { timeoutMs: cfg.REPORT_TIMEOUT_SEC * 1000 });

  // --- print matrix ---
  const { dates, rows } = report;
  const header = ['User', ...dates.map((d) => DateTime.fromISO(d).toFormat('dd-MMM')), 'Total'];
  const body = rows.map((u) => [u.user, ...dates.map((d) => fmtHours(u.byDate[d] ?? 0)), fmtHours(u.total)]);
  const totalRow = ['TOTAL', ...dates.map((d) => fmtHours(report.dateTotals[d] ?? 0)), fmtHours(report.grandTotal)];
  const table = [header, ...body, totalRow];
  const widths = header.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  const line = (r: string[]) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log('');
  console.log(line(header));
  console.log(sep);
  body.forEach((r) => console.log(line(r)));
  console.log(sep);
  console.log(line(totalRow));
  console.log('');
  console.log(`Users with time: ${rows.length}`);
  console.log(`Worklogs in range: ${report.worklogs.length} across ${new Set(report.worklogs.map((w) => w.issueKey)).size} issue(s)`);
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!report.complete) {
    console.log('');
    console.log(`⚠ INCOMPLETE: worklog fetch failed for ${report.failedIssueKeys.length} issue(s): ${report.failedIssueKeys.join(', ')}`);
    process.exit(2);
  }
  console.log('Complete: yes (no failed issues)');
}

main().catch((err) => {
  console.error(`Probe failed: ${(err as Error).message}`);
  process.exit(1);
});
