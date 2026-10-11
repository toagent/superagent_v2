import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RunView } from './archon';
import type { ExecutionOwnerRecord } from '../../packages/workflows/src/schemas/workflow-run';

/** A reconciliation is valid for exactly the observed execution and incomplete nodes. */
export function recoverySnapshot(run: RunView): string {
  return createHash('sha256').update(JSON.stringify({
    id: run.id, status: run.status, started_at: run.started_at ?? null,
    owner: run.metadata?.execution_owner ?? null,
    nodes: run.nodes ?? [],
  })).digest('hex');
}

export interface RecoveryAdmission {
  token: string;
  owner?: ExecutionOwnerRecord;
  started_at: string | null;
  reconciled_snapshot?: string;
  reconciled_nodes?: string[];
}

export function sameRecoveryOwner(run: RunView, claim: RecoveryAdmission): boolean {
  const owner = run.metadata?.execution_owner;
  return owner?.host === claim.owner?.host && owner?.pid === claim.owner?.pid &&
    owner?.uid === claim.owner?.uid;
}

/** Both fences matter: failed/paused resume cannot atomically replace the DB marker. */
export function recoveryAdmissionUnknown(run: RunView): boolean {
  const recorded = run.metadata?.superagent_recovery;
  if (recorded && sameRecoveryOwner(run, recorded)) return true;
  // Pure callers can classify a RunView without a configured runtime home.
  const sa = process.env.SUPERAGENT_HOME;
  if (!sa) return false;
  const path = join(sa, 'runs', `${run.id}.recovery`);
  if (!existsSync(path)) return false;
  try {
    const claim = JSON.parse(readFileSync(path, 'utf8')) as (Omit<RecoveryAdmission, 'owner'> &
      { owner?: RecoveryAdmission['owner'] | null }) | null;
    if (!claim || typeof claim.token !== 'string' ||
      !(claim.started_at === null || typeof claim.started_at === 'string') ||
      (claim.owner !== undefined && (!claim.owner || typeof claim.owner.pid !== 'number' || typeof claim.owner.host !== 'string')))
      return true;
    return sameRecoveryOwner(run, { ...claim, owner: claim.owner ?? undefined });
  } catch { return true; }
}

/** Missing/remote owners cannot be called dead. A reused PID is held for inspection. */
export function ownershipUnknown(run: RunView): boolean {
  if (!['pending', 'running'].includes(run.status)) return false;
  const owner = run.metadata?.execution_owner;
  return run.status === 'pending' || owner?.host !== hostname();
}

/** land produces instructions only. Its durable output must agree with the checkout. */
function landReconciled(run: RunView): boolean {
  if (!run.working_path || !run.output_root) return false;
  const file = join(run.output_root, 'artifacts', 'runs', run.id, 'land.json');
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { head?: unknown; branch?: unknown; commands?: unknown };
    const git = (args: string[]): string | undefined => {
      const p = Bun.spawnSync(['git', '-C', run.working_path ?? '', ...args], { stdout: 'pipe', stderr: 'pipe' });
      return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
    };
    return typeof data.head === 'string' && typeof data.branch === 'string' &&
      data.head === git(['rev-parse', 'HEAD']) && data.branch === git(['branch', '--show-current']) &&
      Array.isArray(data.commands) && data.commands.length === 2 && data.commands.every(c => typeof c === 'string');
  } catch { return false; }
}

export function unknownEffects(run: RunView): string[] {
  // Prompt, bash and script bodies can all write external state; a missing completion
  // record is not evidence of rollback. Engine-recorded failures keep their ordinary
  // retry contract; an interrupted execution has no such settled outcome.
  return (run.nodes ?? []).filter(n => n.state === 'running' &&
    !(n.nodeId === 'land' && landReconciled(run))).map(n => n.nodeId);
}
