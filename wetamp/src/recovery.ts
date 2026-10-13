// Compatibility imports for old callers; execution admission belongs to Archon.
import { inspectProcess } from './launcher';
import { existsSync, readFileSync } from 'node:fs';
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

/** land produces instructions only. Its durable output must agree with the checkout. */
function landReconciled(run: RunView): boolean {
  if (!run.working_path || !run.output_root) return false;
  const file = join(run.output_root, 'artifacts', 'runs', run.id, 'land.json');
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      head?: unknown;
      branch?: unknown;
      commands?: unknown;
    };
    const git = (args: string[]): string | undefined => {
      const p = Bun.spawnSync(['git', '-C', run.working_path ?? '', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
    };
    return (
      typeof data.head === 'string' &&
      typeof data.branch === 'string' &&
      data.head === git(['rev-parse', 'HEAD']) &&
      data.branch === git(['branch', '--show-current']) &&
      Array.isArray(data.commands) &&
      data.commands.length === 2 &&
      data.commands.every(c => typeof c === 'string')
    );
  } catch {
    return false;
  }
}

/** Read-only delivery reconciliation; admission and transitions stay in Archon. */
export const unknownEffects = (run: RunView): string[] =>
  engineUnknownEffects(run).filter(node => node !== 'land' || !landReconciled(run));
