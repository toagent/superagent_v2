// Read-only reconciliation for historical nodes; execution admission belongs to Archon.
import { authoredNodeId, captureDelivery, landEvidence, publishRecoverable } from './land';
import { inspectProcess } from './launcher';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from './archon';
import {
  executionOwnership as ownership,
  ownershipUnknown as unknown,
  unknownEffects as engineUnknownEffects,
} from '@archon/workflows/execution-lifecycle';
export {
  recoverySnapshot,
  recoveryAdmissionUnknown,
  sameRecoveryOwner,
  type RecoveryAdmission,
} from '@archon/workflows/execution-lifecycle';
export const executionOwnership = (run: RunView) => ownership(run, inspectProcess);
export const ownershipUnknown = (run: RunView) => unknown(run, inspectProcess);

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
