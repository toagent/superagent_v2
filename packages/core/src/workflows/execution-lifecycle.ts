import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type {
  ExecutionRunView,
  RecoveryAdmission,
} from '../../../workflows/src/execution-lifecycle';

/** SQLite CLI host adapter. The engine validated liveness and reconciliation before this CAS. */
export function claimInterruptedExecution(
  root: string,
  run: ExecutionRunView,
  claim: RecoveryAdmission
): boolean {
  if (process.env.DATABASE_URL)
    throw new Error('interrupted execution: SQLite adapter cannot mutate a PostgreSQL run');
  const o = run.metadata?.execution_owner;
  if (!o) return false;
  const db = new Database(join(root, 'archon.db'), { create: false, readwrite: true });
  try {
    const r = db.run(
      `update remote_agent_workflow_runs set status='failed',
             metadata=json_set(metadata,'$.execution_admission',json(?))
             where id=? and status='running'
             and json_extract(metadata,'$.execution_owner.pid')=?
             and json_extract(metadata,'$.execution_owner.host')=?
             and json_extract(metadata,'$.execution_owner.uid') is ?
             and (started_at is ? or julianday(started_at)=julianday(?))
             and json_extract(metadata,'$.execution_admission.token') is ?`,
      [
        JSON.stringify(claim),
        run.id,
        o.pid,
        o.host,
        o.uid ?? null,
        run.started_at ?? null,
        run.started_at ?? null,
        run.metadata?.execution_admission?.token ?? null,
      ]
    );
    return r.changes === 1;
  } finally {
    db.close();
  }
}
