import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { RunView } from './archon';
import { home, writeAtomic } from './config';
import type { StallRecord } from './stall';

export const NODE_LEASE = Object.freeze({ progress_window_ms: 5 * 60_000, extension_factor: 1.5 });

// prettier-ignore
export interface NodeLeaseRecord { engine_run: string; node: string; started_at: string; budget_s: number; extended_at?: string; stopped_at?: string; evidence?: string }
// prettier-ignore
export type NodeLeaseDecision = { action: 'none' } | { action: 'extend'; lease: NodeLeaseRecord } | { action: 'stop'; lease: NodeLeaseRecord; elapsed_s: number };

export function nodeLeaseProgress(runId: string): StallRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home().sa, 'stall.json'), 'utf8')) as {
      runs?: Record<string, StallRecord>;
    };
    return value.runs?.[runId];
  } catch {
    return undefined;
  }
}

export function nodeLeaseDecision(
  run: RunView,
  node: { nodeId: string; startedAt?: string; budget_s: number },
  prior: NodeLeaseRecord | undefined,
  progress: StallRecord | undefined,
  now = Date.now()
): NodeLeaseDecision {
  const startedMs = Date.parse(node.startedAt ?? '');
  if (!Number.isFinite(startedMs)) return { action: 'none' };
  const elapsed_s = Math.max(0, Math.floor((now - startedMs) / 1000));
  const same =
    prior?.engine_run === run.id &&
    prior.node === node.nodeId &&
    prior.started_at === node.startedAt;
  const lease: NodeLeaseRecord = same
    ? prior
    : {
        engine_run: run.id,
        node: node.nodeId,
        started_at: node.startedAt ?? '',
        budget_s: node.budget_s,
      };
  if (lease.stopped_at || elapsed_s < node.budget_s) return { action: 'none' };
  if (lease.extended_at)
    return elapsed_s < node.budget_s * NODE_LEASE.extension_factor
      ? { action: 'none' }
      : { action: 'stop', lease, elapsed_s };
  const progressAge = progress ? now - progress.progressAt : Infinity;
  const recentProgress =
    progress?.node === node.nodeId &&
    progress.startedAt === node.startedAt &&
    progressAge >= 0 &&
    progressAge <= NODE_LEASE.progress_window_ms;
  return recentProgress
    ? { action: 'extend', lease: { ...lease, extended_at: new Date(now).toISOString() } }
    : { action: 'stop', lease, elapsed_s };
}

const eventSummaries = (
  run: RunView
): { type: string; node: string | null; at: string | null }[] => {
  let events = (run as RunView & { events?: Record<string, unknown>[] }).events ?? [];
  if (!events.length)
    try {
      events = readFileSync(join(run.output_root ?? '', 'logs', `${run.id}.jsonl`), 'utf8')
        .trimEnd()
        .split('\n')
        .flatMap(line => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
    } catch {
      /* missing logs remain explicit as an empty summary */
    }
  // prettier-ignore
  return events.slice(-10).map(event => ({ type: typeof event.event_type === 'string' ? event.event_type : typeof event.type === 'string' ? event.type : 'unknown', node: typeof event.step_name === 'string' ? event.step_name : typeof event.step === 'string' ? event.step : null, at: typeof event.created_at === 'string' ? event.created_at : typeof event.observedAt === 'string' ? event.observedAt : typeof event.ts === 'string' ? event.ts : null }));
};

export function writeNodeLeaseReport(
  runId: string,
  run: RunView,
  lease: NodeLeaseRecord,
  elapsed_s: number,
  artifacts: string,
  worktree: string,
  pkg: string
): string {
  const stat = spawnSync('git', ['diff', '--stat', 'HEAD', '--'], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const report = join(
    artifacts,
    `node-lease-${lease.node.replaceAll(/[^0-9A-Za-z._-]/g, '_')}.json`
  );
  mkdirSync(artifacts, { recursive: true });
  writeAtomic(
    report,
    JSON.stringify(
      {
        reason: 'budget_exceeded',
        node: lease.node,
        elapsed_s,
        budget_s: lease.budget_s,
        extended: lease.extended_at !== undefined,
        diff_stat: stat.status === 0 ? stat.stdout.trim() : 'unavailable',
        recent_events: eventSummaries(run),
        next_action: `superagent decide ${runId} retry --pkg ${pkg} --hint "根据租约交回证据继续"`,
      },
      null,
      2
    ) + '\n'
  );
  return report;
}
