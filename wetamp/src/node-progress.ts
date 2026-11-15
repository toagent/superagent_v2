import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { providerEventLineSchema } from '../../packages/workflows/src/schemas/provider-event';
import type { RunView } from './archon';
import type { Plan, Pkg } from './plan';

const BUDGET_MINUTES: Record<Pkg['size'], number> = { S: 20, M: 40, L: 60 };

export interface NodeProgress {
  started_at: string | null;
  elapsed_s: number | null;
  budget_s: number;
  last_event_at: string | null;
  last_event_s: number | null;
  event_count: number;
}

const activityCache = new Map<
  string,
  { mtimeMs: number; size: number; value: Map<string, { count: number; last: string | null }> }
>();

const activityFor = (run: RunView): Map<string, { count: number; last: string | null }> => {
  const path = join(run.output_root ?? '', 'logs', `${run.id}.jsonl`);
  try {
    const stat = statSync(path),
      saved = activityCache.get(path);
    if (saved?.mtimeMs === stat.mtimeMs && saved.size === stat.size) return saved.value;
    const activity = new Map<string, { count: number; last: string | null }>();
    for (const text of readFileSync(path, 'utf8').split('\n')) {
      if (!text) continue;
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      const parsed = providerEventLineSchema.safeParse(value);
      if (!parsed.success || parsed.data.workflow_id !== run.id) continue;
      const found = activity.get(parsed.data.step) ?? { count: 0, last: null };
      found.count++;
      if (found.last === null || parsed.data.observedAt > found.last)
        found.last = parsed.data.observedAt;
      activity.set(parsed.data.step, found);
    }
    activityCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value: activity });
    return activity;
  } catch {
    return new Map();
  }
};

const packageForNode = (plan: Plan, node: string): Pkg | undefined => {
  const direct = plan.packages.find(pkg =>
    ['code', 'repair'].some(prefix => node === `${prefix}-${pkg.id}`)
  );
  if (direct) return direct;
  const milestone = plan.packages.find(pkg =>
    ['fix', 'resolve'].some(prefix => node.startsWith(`${prefix}-${pkg.milestone ?? 'm1'}-`))
  )?.milestone;
  return plan.packages.find(pkg => (pkg.milestone ?? 'm1') === milestone);
};

export const budgetSeconds = (pkg: Pkg): number =>
  (pkg.budget_min ?? BUDGET_MINUTES[pkg.size]) * 60;

export function nodeProgress(
  run: RunView,
  plan: Plan | null,
  now = Date.now(),
  generalNodes?: ReadonlySet<string>
): Partial<Record<string, NodeProgress>> {
  if (!plan) return {};
  const nodes = (run.nodes ?? []).flatMap(node => {
    if (node.state !== 'running' || (generalNodes && !generalNodes.has(node.nodeId))) return [];
    const pkg = packageForNode(plan, node.nodeId) ?? (generalNodes ? plan.packages[0] : undefined);
    return pkg ? [{ node, pkg }] : [];
  });
  if (!nodes.length) return {};
  const activity = activityFor(run);
  return Object.fromEntries(
    nodes.map(({ node, pkg }) => {
      const started = node.startedAt ?? null,
        startedMs = Date.parse(started ?? ''),
        found = activity.get(node.nodeId) ?? { count: 0, last: null },
        eventMs = Date.parse(found.last ?? '');
      return [
        node.nodeId,
        {
          started_at: started,
          elapsed_s: Number.isFinite(startedMs)
            ? Math.max(0, Math.floor((now - startedMs) / 1000))
            : null,
          budget_s: budgetSeconds(pkg),
          last_event_at: found.last,
          last_event_s: Number.isFinite(eventMs)
            ? Math.max(0, Math.floor((now - eventMs) / 1000))
            : null,
          event_count: found.count,
        },
      ] as const;
    })
  );
}
