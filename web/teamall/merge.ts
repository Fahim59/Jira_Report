// Team Reports for several sites: each site answers its own POST /api/custom-report; this merges the answers into one
// report the Team Reports table can draw. Pure rules, no DOM.
import type { Tree, TreeNode } from '../../src/services/custom/engine.js';
import type { GroupSheetResult } from '../../src/services/custom/sheets.js';
import type { TemplateReport } from '../../src/services/custom/result.js';

/** The "Site" choice in Group By: not a Jira field, so it is added to the tree here, never sent to a server. */
export const SITE_FIELD = 'site';

/** Ready-made Group By choices (field ids): the All Sites tab's modes, plus ones with the Site level. */
export const GROUP_PRESETS: ReadonlyArray<{ id: string; label: string; groupBy: readonly string[] }> = [
  { id: 'user-project', label: 'User & Project', groupBy: ['worklog.author', 'project'] },
  { id: 'project-user', label: 'Project & User', groupBy: ['project', 'worklog.author'] },
  { id: 'user', label: 'User', groupBy: ['worklog.author'] },
  { id: 'project', label: 'Project', groupBy: ['project'] },
  { id: 'site-user', label: 'Site & User', groupBy: [SITE_FIELD, 'worklog.author'] },
  { id: 'user-site', label: 'User & Site', groupBy: ['worklog.author', SITE_FIELD] },
  { id: 'site-user-project', label: 'Site & User & Project', groupBy: [SITE_FIELD, 'worklog.author', 'project'] },
  { id: 'user-site-project', label: 'User & Site & Project', groupBy: ['worklog.author', SITE_FIELD, 'project'] },
];
export const DEFAULT_PRESET = 'user-project';
export const CUSTOM_PRESET = 'custom';

/** The preset whose fields are exactly `groupBy` (same order), else "custom". */
export function presetFor(groupBy: readonly string[]): string {
  return GROUP_PRESETS.find((p) => p.groupBy.length === groupBy.length && p.groupBy.every((g, i) => g === groupBy[i]))?.id ?? CUSTOM_PRESET;
}

/** A tree node that remembers its site where its value is only unique inside one site (issues). */
export type SiteNode = TreeNode & { site?: string };

export interface SitePart {
  site: string;
  report: TemplateReport;
}

export interface SiteFailure {
  site: string;
  error: string;
}

/** Values that only mean something inside one site: two sites can both have issue "WEB-1" or project "WEB". */
const SITE_SCOPED: ReadonlySet<string> = new Set(['issue.key', 'issue.keySummary', 'issue.id', 'parent', 'parent.key', 'parent.id', 'parent.summary', 'epic', 'project']);

const sumInto = (target: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) target[k] = (target[k] ?? 0) + v;
};

interface Plan {
  /** Where the Site level goes among the final levels (-1 = no Site level). */
  siteDepth: number;
  /** Number of levels the servers answered with. */
  levels: number;
  /** Add " (site)" to project labels (more than one site). */
  multi: boolean;
}

function siteLeaf(site: string, member: TreeNode): SiteNode {
  return { ...member, fieldId: SITE_FIELD, value: site, label: site, children: [], columns: {} };
}

function mergeLevel(parts: ReadonlyArray<{ site: string; nodes: readonly TreeNode[] }>, depth: number, plan: Plan): SiteNode[] {
  if (depth === plan.siteDepth && depth < plan.levels) {
    // The Site level sits here: one node per site, holding that site's nodes (merged on their own from here down).
    return parts
      .filter((p) => p.nodes.length > 0)
      .map((p) => {
        const children = mergeLevel([p], depth, { ...plan, siteDepth: -1 });
        const total = children.reduce((s, c) => s + c.total, 0);
        const periods: Record<string, number> = {};
        for (const c of children) sumInto(periods, c.periods);
        return {
          fieldId: SITE_FIELD,
          value: p.site,
          label: p.site,
          total,
          periods,
          columns: {},
          worklogIds: children.flatMap((c) => c.worklogIds),
          issueCount: children.reduce((s, c) => s + c.issueCount, 0),
          worklogCount: children.reduce((s, c) => s + c.worklogCount, 0),
          children,
        };
      });
  }

  const groups = new Map<string, Array<{ site: string; node: TreeNode }>>();
  for (const p of parts) {
    for (const node of p.nodes) {
      const scoped = SITE_SCOPED.has(node.fieldId);
      const key = `${node.fieldId}\u0000${scoped ? p.site : ''}\u0000${node.value}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ site: p.site, node });
    }
  }

  const merged: SiteNode[] = [];
  for (const members of groups.values()) {
    const first = members[0]!.node;
    const periods: Record<string, number> = {};
    for (const m of members) sumInto(periods, m.node.periods);
    const scoped = SITE_SCOPED.has(first.fieldId);
    let children: SiteNode[];
    if (depth + 1 < plan.levels) {
      children = mergeLevel(
        members.map((m) => ({ site: m.site, nodes: m.node.children })),
        depth + 1,
        plan,
      );
    } else if (plan.siteDepth === plan.levels) {
      // Site is the last level: under each leaf, one line per site with that site's time.
      children = members.map((m) => siteLeaf(m.site, m.node));
    } else {
      children = [];
    }
    merged.push({
      fieldId: first.fieldId,
      value: first.value,
      label: first.fieldId === 'project' && plan.multi ? `${first.label} (${members[0]!.site})` : first.label,
      total: members.reduce((s, m) => s + m.node.total, 0),
      periods,
      columns: {},
      worklogIds: members.flatMap((m) => m.node.worklogIds),
      issueCount: members.reduce((s, m) => s + m.node.issueCount, 0),
      worklogCount: members.reduce((s, m) => s + m.node.worklogCount, 0),
      children,
      ...(scoped ? { site: members[0]!.site } : {}),
    });
  }
  return merged.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

const groupSheet = (r: TemplateReport): GroupSheetResult => {
  const s = r.sheets[0];
  if (!s || s.mode !== 'group') throw new Error('The server answered with an unexpected report shape.');
  return s;
};

/**
 * One report from the sites' reports. `groupBy` = the Group By choices as the user picked them (field ids, "site" included):
 * the servers were asked without "site", which is put back at its place here. `failures` = sites that could not be read.
 */
export function mergeReports(parts: readonly SitePart[], groupBy: readonly string[], failures: readonly SiteFailure[] = []): TemplateReport {
  if (parts.length === 0) throw new Error('No site answered.');
  const sheets = parts.map((p) => groupSheet(p.report));
  const siteDepth = groupBy.indexOf(SITE_FIELD);
  const serverLevels = groupBy.filter((g) => g !== SITE_FIELD).length;
  const siteOnly = siteDepth === 0 && serverLevels === 0;
  // With only "Site" chosen the servers still answered with their default level; it is not shown.
  const plan: Plan = { siteDepth, levels: siteOnly ? 0 : serverLevels, multi: parts.length > 1 };

  let nodes: SiteNode[];
  if (siteOnly) {
    nodes = parts.map((p, i) => ({
      fieldId: SITE_FIELD,
      value: p.site,
      label: p.site,
      total: sheets[i]!.tree.total,
      periods: { ...sheets[i]!.tree.periods },
      columns: {},
      worklogIds: sheets[i]!.worklogIds,
      issueCount: sheets[i]!.tree.issueCount,
      worklogCount: sheets[i]!.worklogIds.length,
      children: [],
    }));
    nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  } else {
    nodes = mergeLevel(parts.map((p, i) => ({ site: p.site, nodes: sheets[i]!.tree.nodes })), 0, plan);
  }

  const periods: Record<string, number> = {};
  for (const s of sheets) sumInto(periods, s.tree.periods);
  const tree: Tree = {
    periodKeys: [...new Set(sheets.flatMap((s) => s.tree.periodKeys))].sort(),
    nodes,
    total: sheets.reduce((s, x) => s + x.tree.total, 0),
    periods,
    issueCount: sheets.reduce((s, x) => s + x.tree.issueCount, 0),
    worklogCount: sheets.reduce((s, x) => s + x.tree.worklogCount, 0),
  };

  const base = sheets[0]!;
  const names = siteOnly ? [] : [...base.headers.groupBy];
  if (siteDepth >= 0) names.splice(Math.min(siteDepth, names.length), 0, 'Site');
  const sheet: GroupSheetResult = {
    ...base,
    total: tree.total,
    headers: { ...base.headers, groupBy: names },
    worklogIds: sheets.flatMap((s) => s.worklogIds),
    tree,
  };

  const first = parts[0]!.report;
  const label = (site: string, text: string) => (parts.length > 1 ? `${site}: ${text}` : text);
  const complete = parts.every((p) => p.report.complete) && failures.length === 0;
  const reasons = [
    ...parts.flatMap((p) => (p.report.failureReasons ?? []).map((r) => label(p.site, r))),
    ...failures.map((f) => `${f.site}: could not be read (${f.error})`),
  ];
  const { site: _site, ...rest } = first;
  return {
    ...rest,
    sheets: [sheet],
    worklogs: parts.flatMap((p) => p.report.worklogs),
    issues: parts.flatMap((p) => p.report.issues),
    retrievedAt: parts.map((p) => p.report.retrievedAt).sort().at(-1)!,
    complete,
    failedIssueKeys: parts.flatMap((p) => p.report.failedIssueKeys.map((k) => (parts.length > 1 ? `${p.site}:${k}` : k))),
    ...(reasons.length ? { failureReasons: reasons } : {}),
    warnings: parts.flatMap((p) => p.report.warnings.map((w) => label(p.site, w))),
  };
}
