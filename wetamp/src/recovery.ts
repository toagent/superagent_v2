// Reconciliation for historical nodes and the cancelled-run recovery CAS.
import { authoredNodeId, captureDelivery, landEvidence, publishRecoverable } from './land';
import { inspectProcess } from './launcher';
import { home } from './config';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from './archon';
import {
  executionOwnership as ownership,
  ownershipUnknown as unknown,
  unknownEffects as engineUnknownEffects,
  type RecoveryAdmission,
} from '@archon/workflows/execution-lifecycle';
export {
  recoverySnapshot,
  recoveryAdmissionUnknown,
  sameRecoveryOwner,
  type RecoveryAdmission,
} from '@archon/workflows/execution-lifecycle';
export const executionOwnership = (run: RunView) => ownership(run, inspectProcess);
export const ownershipUnknown = (run: RunView) => unknown(run, inspectProcess);

/** Claim the already-reconciled cancelled row without widening native resume semantics. */
export function claimCancelledExecution(run: RunView, claim: RecoveryAdmission): boolean {
  if (process.env.DATABASE_URL)
    throw new Error('cancelled execution: SQLite adapter cannot mutate a PostgreSQL run');
  const owner = run.metadata?.execution_owner;
  if (!owner || run.status !== 'cancelled') return false;
  const db = new Database(join(home().archon, 'archon.db'), { create: false, readwrite: true });
  try {
    const result = db.run(
      `update remote_agent_workflow_runs set status='failed',
             metadata=json_set(metadata,'$.execution_admission',json(?))
             where id=? and status='cancelled'
             and json_extract(metadata,'$.execution_owner.pid')=?
             and json_extract(metadata,'$.execution_owner.host')=?
             and json_extract(metadata,'$.execution_owner.uid') is ?
             and (started_at is ? or julianday(started_at)=julianday(?))
             and json_extract(metadata,'$.execution_admission.token') is ?`,
      [
        JSON.stringify(claim),
        run.id,
        owner.pid,
        owner.host,
        owner.uid ?? null,
        run.started_at ?? null,
        run.started_at ?? null,
        run.metadata?.execution_admission?.token ?? null,
      ]
    );
    return result.changes === 1;
  } finally {
    db.close();
  }
}

/** Legacy instruction output must still agree with its checkout. */
function landReconciled(run: RunView, node: string): boolean {
  if (!run.working_path || !run.output_root) return false;
  try {
    const evidence = landEvidence(run, node);
    if (!evidence) return false;
    const data = JSON.parse(
      readFileSync(join(run.output_root, 'artifacts', 'runs', run.id, evidence.file), 'utf8')
    ) as { head?: unknown; branch?: unknown; commands?: unknown };
    const checkout = captureDelivery(run.working_path);
    return (
      data.head === checkout.head &&
      data.branch === checkout.branch &&
      Array.isArray(data.commands) &&
      data.commands.length === 2 &&
      data.commands.every((c: unknown) => typeof c === 'string')
    );
  } catch {
    return false;
  }
}

/** Read-only delivery reconciliation; admission and transitions stay in Archon. */
export const unknownEffects = (run: RunView): string[] =>
  engineUnknownEffects(run).filter(node =>
    authoredNodeId(node).startsWith('publish-')
      ? !publishRecoverable(run)
      : node.startsWith('deliver')
        ? true
        : !node.startsWith('land') || !landReconciled(run, node)
  );
