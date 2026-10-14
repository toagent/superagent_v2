import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecutionOwnerRecord } from './schemas/workflow-run';
import type { NodeExecutionMetadata } from './schemas/node-execution';

type Json = Record<string, unknown>;
export type ProcessProbe = (
  pid: number
) => { state: 'online'; start: string } | { state: 'offline' | 'unknown'; start?: undefined };
export interface ExecutionLifecycleHost {
  root: string;
  inspectProcess: ProcessProbe;
  getRun(id: string, cwd?: string): ExecutionRunView;
  liveOwnerAnswering(id: string): boolean | undefined;
  reconcileEffects?: (run: ExecutionRunView) => string[];
  /** Adapter CAS must bind status, owner, started_at and the prior admission token. */
  claimInterrupted(run: ExecutionRunView, claim: RecoveryAdmission): boolean;
  launch(args: string[], cwd?: string): { code: number; out: string; err: string };
  parseAck(text: string): Json | null;
}
function writeAdmission(path: string, value: string): void {
  const tmp = `${path}.${randomUUID()}`;
  writeFileSync(tmp, value, { flag: 'wx' });
  renameSync(tmp, path);
}
export interface ExecutionRunView {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  working_path?: string | null;
  output_root?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_activity_at?: string | null;
  metadata?: {
    execution_owner?: ExecutionOwnerRecord;
    /** Legacy admission records remain readable; new executions use execution_admission. */
    superagent_recovery?: RecoveryAdmission;
    execution_admission?: RecoveryAdmission;
    wait?: {
      nodeId: string;
      kind: string;
      event?: string;
      resumeAt: string;
      /** attention 类等待只有这个，没有可用的 resumeAt。 */
      waitingSince?: string;
    };
    approval?: { nodeId: string; pauseId?: string; type?: string };
    error?: string | null;
    stop_reason?: { reason?: string; signal?: string } | null;
  } | null;
  terminal_record?: { error?: string | null } | null;
  transcript_path?: string | null;
  nodes?: {
    nodeId: string;
    state: string;
    startedAt?: string;
    error?: string | null;
    durationMs?: number;
    execution?: NodeExecutionMetadata;
  }[];
}

/** A reconciliation is valid for exactly the observed execution and incomplete nodes. */
export function recoverySnapshot(run: ExecutionRunView): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: run.id,
        status: run.status,
        started_at: run.started_at ?? null,
        owner: run.metadata?.execution_owner ?? null,
        nodes: run.nodes ?? [],
      })
    )
    .digest('hex');
}

export interface RecoveryAdmission {
  token: string;
  owner?: ExecutionOwnerRecord;
  started_at: string | null;
  reconciled_snapshot?: string;
  reconciled_nodes?: string[];
}

export function sameRecoveryOwner(run: ExecutionRunView, claim: RecoveryAdmission): boolean {
  const owner = run.metadata?.execution_owner;
  return (
    owner?.host === claim.owner?.host &&
    owner?.pid === claim.owner?.pid &&
    owner?.uid === claim.owner?.uid
  );
}

/** Both fences matter: failed/paused resume cannot atomically replace the DB marker. */
export function recoveryAdmissionUnknown(run: ExecutionRunView): boolean {
  const recorded = run.metadata?.execution_admission ?? run.metadata?.superagent_recovery;
  if (recorded && sameRecoveryOwner(run, recorded)) return true;
  // Pure callers can classify a ExecutionRunView without a configured runtime home.
  const root = process.env.ARCHON_HOME;
  const legacy = process.env.SUPERAGENT_HOME;
  const paths = [
    ...(root ? [join(root, 'execution-admissions', `${run.id}.json`)] : []),
    ...(legacy ? [join(legacy, 'runs', `${run.id}.recovery`)] : []),
  ];
  return paths.some(path => admissionAt(run, path));
}

function admissionAt(run: ExecutionRunView, path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const claim = JSON.parse(readFileSync(path, 'utf8')) as
      | (Omit<RecoveryAdmission, 'owner'> & { owner?: RecoveryAdmission['owner'] | null })
      | null;
    if (
      !claim ||
      typeof claim.token !== 'string' ||
      !(claim.started_at === null || typeof claim.started_at === 'string') ||
      (claim.owner !== undefined &&
        (!claim.owner ||
          typeof claim.owner.pid !== 'number' ||
          typeof claim.owner.host !== 'string'))
    )
      return true;
    return sameRecoveryOwner(run, { ...claim, owner: claim.owner ?? undefined });
  } catch {
    return true;
  }
}

/** Execution liveness never determines controller presence or permission. */
export function executionOwnership(
  run: ExecutionRunView,
  inspectProcess: ProcessProbe
): {
  state: 'online' | 'offline' | 'unknown';
  reused?: true;
} {
  const owner = run.metadata?.execution_owner;
  if (run.status === 'pending' || owner?.host !== hostname()) return { state: 'unknown' };
  const probe = inspectProcess(owner.pid);
  if (probe.state !== 'online') return probe;
  if (run.started_at && Date.parse(probe.start) > Date.parse(run.started_at))
    return { state: 'unknown', reused: true };
  return { state: 'online' };
}
export function ownershipUnknown(run: ExecutionRunView, inspectProcess: ProcessProbe): boolean {
  return (
    ['pending', 'running'].includes(run.status) &&
    executionOwnership(run, inspectProcess).state === 'unknown'
  );
}

export function unknownEffects(run: ExecutionRunView): string[] {
  // Prompt, bash and script bodies can all write external state; a missing completion
  // record is not evidence of rollback. Engine-recorded failures keep their ordinary
  // retry contract; an interrupted execution has no such settled outcome.
  return (run.nodes ?? []).filter(n => n.state === 'running').map(n => n.nodeId);
}

export type ResumeExecutionResult =
  | { ok: true; resumed: Json }
  | {
      ok: false;
      reason: string;
      busy?: true;
      refused?: true;
      held?: true;
      action?: string;
      snapshot?: string;
      nodes?: string[];
      evidence?: string;
    };

export type Lock = { ok: true; release: () => void } | { ok: false; reason: 'locked' };

const DARWIN = process.platform === 'darwin';
const ERRNO = DARWIN ? '__error' : '__errno_location';
const libc = dlopen(DARWIN ? 'libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  [ERRNO]: { args: [], returns: FFIType.ptr },
});
const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = DARWIN ? 35 : 11;

/** Kernel releases dead holders; never unlink the inode, which would split mutual exclusion. */
export function executionLock(path: string): Lock {
  const fd = openSync(path, 'a');
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const errno = read.i32(libc.symbols[ERRNO]() as Pointer);
    closeSync(fd);
    if (errno === EWOULDBLOCK) return { ok: false, reason: 'locked' };
    throw new Error(`flock ${path}: errno ${String(errno)}`);
  }
  ftruncateSync(fd, 0);
  writeSync(
    fd,
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })
  );
  return {
    ok: true,
    release: (): void => {
      closeSync(fd);
    },
  };
}

export function executionAdmissionLock(root: string, id: string): Lock {
  mkdirSync(join(root, 'execution-admissions'), { recursive: true });
  return executionLock(join(root, 'execution-admissions', `${id}.lock`));
}

/** Explicit continuation admission; never infer permission from an elapsed timeout. */
export function resumeExecution(
  host: ExecutionLifecycleHost,
  id: string,
  cwd?: string,
  guard?: (run: ExecutionRunView) => string | undefined,
  done?: (ack: Json) => void,
  prepare?: () => void,
  strategy?: {
    lockId: string;
    operatorId?: string;
    resolveId: () => string;
    adopt: (run: ExecutionRunView) => string[] | undefined;
  },
  reconciled?: string
): ResumeExecutionResult {
  const l = executionAdmissionLock(host.root, strategy?.lockId ?? id);
  if (!l.ok) return { ok: false, reason: 'recover_locked', busy: true };
  try {
    const run = host.getRun(strategy?.resolveId() ?? id, cwd);
    const veto = guard?.(run);
    if (veto) return { ok: false, reason: veto };
    const journalPath = join(host.root, 'execution-admissions', `${run.id}.json`);
    const held = (reason: string): Extract<ResumeExecutionResult, { ok: false }> => ({
      ok: false,
      held: true,
      reason,
      action: `Inspect archon workflow get ${run.id} --verbose and its exact-run owner; resolve ownership or explicitly run archon workflow abandon ${run.id}.`,
    });
    if (recoveryAdmissionUnknown(run) || admissionAt(run, journalPath))
      return held('recovery_admission_unknown');
    if (ownershipUnknown(run, host.inspectProcess)) return held('owner_unknown');
    const effects = host.reconcileEffects?.(run) ?? unknownEffects(run);
    if (effects.length && reconciled !== recoverySnapshot(run))
      return {
        ok: false,
        held: true,
        reason: 'effects_unknown',
        nodes: effects,
        snapshot: recoverySnapshot(run),
        action: `Reconcile external effects and stop surviving node processes before explicitly continuing ${strategy?.operatorId ?? id} with snapshot ${recoverySnapshot(run)}`,
      };
    if (run.status === 'running') {
      const live = host.liveOwnerAnswering(run.id);
      if (live !== false) return held(live ? 'live_owner_answering' : 'owner_probe_unknown');
    }
    const adoption = strategy?.adopt(run);
    if (adoption) {
      // Relaunching on a newer engine has the same lost-ack window as resume.
      // Keep the old run fenced until the ledger records the new run identity.
      writeAdmission(
        journalPath,
        JSON.stringify({
          token: randomUUID(),
          owner: run.metadata?.execution_owner,
          started_at: run.started_at ?? null,
        } satisfies RecoveryAdmission)
      );
      prepare?.();
      const result = host.launch([...adoption, '--json'], cwd);
      const ack = host.parseAck(result.out);
      if (result.code !== 0 || ack?.ok !== true || typeof ack.runId !== 'string') {
        const evidence = `${journalPath}-result`;
        writeAdmission(evidence, JSON.stringify(result));
        return { ...held('recovery_admission_unknown'), evidence };
      }
      done?.(ack);
      return { ok: true, resumed: ack };
    }
    const claim: RecoveryAdmission = {
      token: randomUUID(),
      owner: run.metadata?.execution_owner,
      started_at: run.started_at ?? null,
      ...(effects.length ? { reconciled_snapshot: reconciled, reconciled_nodes: effects } : {}),
    };
    if (run.status === 'running') {
      if (executionOwnership(run, host.inspectProcess).state !== 'offline')
        return { ok: false, reason: 'owner alive or on another host' };
      if (!host.claimInterrupted(run, claim)) return { ok: false, reason: 'owner_changed' };
    } else if (run.status !== 'failed' && run.status !== 'paused') {
      return { ok: false, reason: `status ${run.status} is not resumable` };
    }
    // Published before launch: an interrupted caller or lost ack leaves an explicit
    // unknown admission. Neither a second CLI nor old owner metadata can re-admit it.
    writeAdmission(journalPath, JSON.stringify(claim));
    prepare?.(); // 已持锁且确认可恢复；attempt/预算不得在锁忙或 owner 存活时变化
    const result = host.launch(['workflow', 'resume', run.id, '--detach', '--json'], cwd);
    const resumed = host.parseAck(result.out);
    if (
      result.code === 0 &&
      resumed?.ok === false &&
      resumed.executed === false &&
      run.status !== 'running'
    ) {
      // A structured pre-admission refusal guarantees no worker was launched.
      // Any other failure (including a lost acknowledgement) retains the fence.
      unlinkSync(journalPath);
      return { ok: false, refused: true, reason: JSON.stringify(resumed).slice(-400) };
    }
    if (result.code !== 0 || resumed?.ok !== true) {
      const evidence = `${journalPath}-result`;
      writeAdmission(evidence, JSON.stringify(result));
      return { ...held('recovery_admission_unknown'), evidence };
    }
    done?.(resumed);
    return { ok: true, resumed };
  } finally {
    l.release();
  }
}

export interface ExecutionAdmissionHost {
  root: string;
  inspectProcess: ProcessProbe;
  countActive(): number;
  launch(args: string[], cwd: string | undefined, intent: { path: string; token: string }): Json;
}
export type Admission =
  | {
      ok: true;
      active: number;
      launch: (args: string[], cwd?: string) => Json;
      release: () => void;
    }
  | { ok: false; reason: 'admission_busy' };

/** Lock through pending-row publication; durable reservations retain ambiguous launch ownership. */
export function admitExecution(host: ExecutionAdmissionHost): Admission {
  const root = host.root;
  mkdirSync(root, { recursive: true });
  const lease = executionLock(join(root, 'run-admission.lock'));
  if (!lease.ok) return { ok: false, reason: 'admission_busy' };
  try {
    const reservation = join(root, 'run-admission.json');
    if (existsSync(reservation)) {
      const old = JSON.parse(readFileSync(reservation, 'utf8')) as {
        host?: unknown;
        pid?: unknown;
        pid_start?: unknown;
      };
      // Only confirmed death clears a launch reservation. Missing identity, remote host and PID reuse stay conservative.
      if (
        old.host !== hostname() ||
        typeof old.pid !== 'number' ||
        !Number.isSafeInteger(old.pid) ||
        old.pid < 1 ||
        typeof old.pid_start !== 'string' ||
        !old.pid_start ||
        host.inspectProcess(old.pid).state !== 'offline'
      ) {
        lease.release();
        return { ok: false, reason: 'admission_busy' };
      }
      unlinkSync(reservation);
    }
    const active = host.countActive();
    return {
      ok: true,
      active,
      release: lease.release,
      launch: (args, cwd): Json => {
        const token = randomUUID();
        writeAdmission(reservation, JSON.stringify({ token, host: hostname() }) + '\n');
        return host.launch(args, cwd, { path: reservation, token });
      },
    };
  } catch (e) {
    lease.release();
    throw e;
  }
}

/** Invalidate the always_run scope input before the admitted native continuation. */
export function advanceExecutionAttempt(path: string): number {
  const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '0';
  const prior = Number(raw);
  if (
    !Number.isSafeInteger(prior) ||
    prior < 0 ||
    String(prior) !== raw ||
    !Number.isSafeInteger(prior + 1)
  )
    throw new Error(`invalid attempt counter: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeAdmission(path, String(prior + 1));
  return prior + 1;
}
