import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { executionAdmissionLock } from '@archon/workflows/execution-lifecycle';
import { getRun, lastJson, lock, runStatuses } from '../archon';
import { WETAMP, home, writeAtomic } from '../config';
import { inspectProcess } from '../launcher';
import { SCRATCH_ROOT } from '../plan';
import { runProbe, type ProbeEvidence } from '../probe';

export const ENGINE_PROTOCOL_VERSION = 1;

export interface EngineReceipt {
  sha: string;
  protocol_version: number;
  acceptance_hash: string;
  results: { command: string; exit: number; duration_ms?: number; run_id?: string }[];
  at: string;
  bootstrap_evidence?: string;
}

const root = (): string => join(home().sa, 'engine');
const receiptsDir = (): string => join(root(), 'receipts');
const currentLink = (): string => join(root(), 'current');
const promotionDir = (): string => join(root(), 'promotions');
const holdPath = (): string => join(root(), 'hold.json');
interface EngineHold {
  by: string;
  at: string;
}
const engineHold = (): EngineHold | null => {
  if (!existsSync(holdPath())) return null;
  try {
    const value = JSON.parse(readFileSync(holdPath(), 'utf8')) as EngineHold;
    if (typeof value.by === 'string' && typeof value.at === 'string') return value;
  } catch {
    // A damaged marker must keep automatic promotion paused.
  }
  return { by: 'unknown', at: 'unknown' };
};
const sourceRoot = (): string =>
  resolve(
    process.env.SA_ENGINE_SOURCE !== undefined && process.env.SA_ENGINE_SOURCE !== ''
      ? process.env.SA_ENGINE_SOURCE
      : join(WETAMP, '..')
  );
export const runningEngineSnapshot = (): string => {
  const path = resolve(WETAMP, '..');
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function currentEngineSnapshotAt(sa: string): string | undefined {
  try {
    return realpathSync(join(sa, 'engine', 'current'));
  } catch {
    return undefined;
  }
}

export function currentEngineSnapshot(): string | undefined {
  return currentEngineSnapshotAt(home().sa);
}

export type EngineSnapshotIdentity = 'current' | 'served' | 'candidate';

export function runEngineSnapshot(): { path: string; identity: EngineSnapshotIdentity } {
  const current = currentEngineSnapshot();
  const running = runningEngineSnapshot();
  const served = receipt(basename(running)) !== undefined;
  return {
    path: current && current === running ? current : running,
    identity: current === running ? 'current' : served ? 'served' : 'candidate',
  };
}

const git = (args: string[], cwd = sourceRoot()): string => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
};
const canonicalSha = (value: string): string => git(['rev-parse', '--verify', `${value}^{commit}`]);
const releaseHead = (): string => git(['rev-parse', '--verify', 'refs/heads/1.0.0^{commit}']);

const receiptPath = (sha: string): string => join(receiptsDir(), `${sha}.json`);
const receipt = (sha: string): EngineReceipt | undefined => {
  try {
    return JSON.parse(readFileSync(receiptPath(sha), 'utf8')) as EngineReceipt;
  } catch {
    return undefined;
  }
};
const receipts = (): EngineReceipt[] =>
  (existsSync(receiptsDir()) ? readdirSync(receiptsDir()).filter(x => x.endsWith('.json')) : [])
    .flatMap(file => {
      try {
        return [JSON.parse(readFileSync(join(receiptsDir(), file), 'utf8')) as EngineReceipt];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));

interface EngineLedger {
  run_id: string;
  archon_run_id: string;
  repo: string;
  engine_snapshot?: string;
  engine_snapshot_identity?: EngineSnapshotIdentity;
  rejected?: string;
  engine_adoptions?: { at: string; from: string | null; to: string }[];
}

const ledgerPaths = (): string[] => {
  const runs = join(home().sa, 'runs');
  return (existsSync(runs) ? readdirSync(runs).filter(x => x.endsWith('.json')) : []).map(file =>
    join(runs, file)
  );
};

const readEngineLedger = (path: string): EngineLedger => {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<EngineLedger>;
  if (typeof value.run_id !== 'string' || typeof value.archon_run_id !== 'string')
    throw new Error('ledger missing run identity');
  return value as EngineLedger;
};

const runLedgers = (): EngineLedger[] => {
  return ledgerPaths().flatMap(path => {
    try {
      return [readEngineLedger(path)];
    } catch {
      return [];
    }
  });
};

export function bootstrapEngineSnapshot(): string | undefined {
  const first = receipts().at(0);
  if (first === undefined) return undefined;
  const snapshot = join(root(), first.sha);
  return existsSync(snapshot) ? realpathSync(snapshot) : undefined;
}

export const fixedEngineSnapshot = (ledger: { engine_snapshot?: string }): string | undefined =>
  ledger.engine_snapshot ?? bootstrapEngineSnapshot();

const rejected = (): string[] => {
  try {
    const value = JSON.parse(readFileSync(join(root(), 'rejected.json'), 'utf8')) as unknown;
    return Array.isArray(value) && value.every(x => typeof x === 'string') ? value : [];
  } catch {
    return [];
  }
};
const isRejected = (sha: string): boolean =>
  rejected().some(value => {
    try {
      return canonicalSha(value) === sha;
    } catch {
      return value === sha;
    }
  });

const shaOfSnapshot = (path: string): string => basename(path);
const isAncestor = (older: string, newer: string): boolean =>
  Bun.spawnSync(['git', '-C', sourceRoot(), 'merge-base', '--is-ancestor', older, newer], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const switchCurrent = (snapshot: string): void => {
  const temporary = join(root(), `.current.${String(process.pid)}.${crypto.randomUUID()}`);
  symlinkSync(snapshot, temporary);
  renameSync(temporary, currentLink());
};

const makeReadonly = (path: string): void => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeReadonly(child);
    if (!entry.isSymbolicLink())
      chmodSync(child, entry.isDirectory() ? 0o555 : lstatSync(child).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(path, 0o555);
};

export const makeWritable = (path: string): void => {
  chmodSync(path, lstatSync(path).mode | 0o200);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeWritable(child);
    else if (!entry.isSymbolicLink()) chmodSync(child, lstatSync(child).mode | 0o200);
  }
};

const snapshotReferenced = (snapshot: string): boolean =>
  ledgerPaths().some(path => {
    try {
      const value = readEngineLedger(path);
      if (!value.engine_snapshot) return false;
      try {
        return realpathSync(value.engine_snapshot) === realpathSync(snapshot);
      } catch {
        return resolve(value.engine_snapshot) === resolve(snapshot);
      }
    } catch {
      return true;
    }
  });

function prepareSnapshot(sha: string, retryingFailedCandidate: boolean): string {
  const snapshot = join(root(), sha);
  if (existsSync(snapshot)) {
    const current = currentEngineSnapshot();
    if (
      !retryingFailedCandidate ||
      (current && realpathSync(snapshot) === current) ||
      existsSync(receiptPath(sha)) ||
      snapshotReferenced(snapshot)
    )
      throw new Error('engine promote: snapshot_in_service');
    makeWritable(snapshot);
    return snapshot;
  }
  mkdirSync(root(), { recursive: true });
  git(['worktree', 'add', '--detach', snapshot, sha]);
  const install = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], {
    cwd: snapshot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (install.exitCode !== 0) throw new Error(`bun install: ${install.stderr.toString().trim()}`);
  return snapshot;
}

function removeAcceptanceScratch(scratch: string): void {
  try {
    if (lstatSync(scratch).isSymbolicLink())
      throw new Error('engine acceptance scratch symlink retained');
    makeWritable(scratch);
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

class AcceptanceFailed extends Error {
  constructor(
    readonly evidencePath: string,
    message: string
  ) {
    super(message);
  }
}

export function runAcceptance(
  snapshot: string,
  timeoutMs = 40 * 60_000
): EngineReceipt['results'][number] {
  const script = join(snapshot, 'wetamp', 'scripts', 'engine-acceptance.sh');
  const scratch = join(tmpdir(), `sa-engine-${crypto.randomUUID()}`);
  mkdirSync(promotionDir(), { recursive: true });
  const evidencePath = join(promotionDir(), `${basename(snapshot)}.acceptance.log`);
  const output = openSync(evidencePath, 'w');
  const started = Date.now();
  try {
    const result = Bun.spawnSync(['bash', script], {
      cwd: join(snapshot, 'wetamp'),
      env: {
        ...process.env,
        SA_ENGINE_PROMOTER_TOKEN: '',
        SA_SERVED_RUN: '',
        SA_HISTORICAL_RUN: '',
        SUPERAGENT_HOME: join(scratch, 'sa'),
        ARCHON_HOME: join(scratch, 'sa', 'archon'),
      },
      stdout: output,
      stderr: output,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (result.exitCode !== 0)
      throw new AcceptanceFailed(
        evidencePath,
        `engine acceptance failed (${String(result.exitCode)}), see ${evidencePath}: ${readFileSync(evidencePath, 'utf8').trim().slice(-500)}`
      );
    return {
      command: 'wetamp/scripts/engine-acceptance.sh',
      exit: 0,
      duration_ms: Date.now() - started,
    };
  } finally {
    closeSync(output);
    removeAcceptanceScratch(scratch);
  }
}

interface PromotionMarker {
  sha: string;
  status: 'running' | 'promoted' | 'failed';
  pid: number;
  pid_start: string;
  host: string;
  at: string;
  token?: string;
  error?: string;
  evidence_path?: string;
}

const markerPath = (sha: string): string => join(promotionDir(), `${sha}.json`);
const writeMarker = (marker: PromotionMarker): void => {
  mkdirSync(promotionDir(), { recursive: true });
  writeAtomic(markerPath(marker.sha), JSON.stringify(marker) + '\n');
};

function beginPromotion(sha: string): PromotionMarker {
  const expected = process.env.SA_ENGINE_PROMOTER_TOKEN;
  if (expected) {
    for (let i = 0; i < 500; i++) {
      try {
        const marker = JSON.parse(readFileSync(markerPath(sha), 'utf8')) as PromotionMarker;
        const identity = inspectProcess(process.pid);
        if (
          marker.status === 'running' &&
          marker.token === expected &&
          marker.pid === process.pid &&
          identity.state === 'online' &&
          identity.start === marker.pid_start
        )
          return marker;
      } catch {
        // Parent publishes the detached process identity immediately after spawning it.
      }
      Bun.sleepSync(10);
    }
    throw new Error('engine promote: promoter identity mismatch');
  }
  const identity = inspectProcess(process.pid);
  if (identity.state !== 'online') throw new Error('engine promote: process identity unavailable');
  const marker: PromotionMarker = {
    sha,
    status: 'running',
    pid: process.pid,
    pid_start: identity.start,
    host: hostname(),
    at: new Date().toISOString(),
  };
  writeMarker(marker);
  return marker;
}

class ProbeFailed extends Error {
  constructor(readonly evidence: ProbeEvidence) {
    super(`probe_failed: ${evidence.reason ?? 'unknown'}`);
  }
}

export interface PromotionDependencies {
  probe?: (snapshot: string) => ProbeEvidence;
}

export function runSnapshotProbe(snapshot: string, scratchRoot = SCRATCH_ROOT): ProbeEvidence {
  const scratch = join(scratchRoot, `sa-engine-probe-${crypto.randomUUID()}`),
    evidencePath = join(scratch, 'evidence.json'),
    started = Date.now();
  mkdirSync(scratch, { recursive: true });
  const result = Bun.spawnSync(
    [process.execPath, join(snapshot, 'wetamp', 'src', 'cli.ts'), 'engine', 'probe', 'G1'],
    {
      cwd: join(snapshot, 'wetamp'),
      env: {
        ...process.env,
        SA_ENGINE_PROMOTER_TOKEN: '',
        DATABASE_URL: '',
        SUPERAGENT_HOME: join(scratch, 'sa'),
        ARCHON_HOME: join(scratch, 'sa', 'archon'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15 * 60_000,
      killSignal: 'SIGKILL',
    }
  );
  const output = result.stdout.toString() + result.stderr.toString(),
    value = lastJson(output);
  if (
    result.exitCode === 0 &&
    value &&
    typeof value.ok === 'boolean' &&
    value.level === 'G1' &&
    typeof value.duration_ms === 'number' &&
    typeof value.evidence_path === 'string'
  ) {
    if (value.ok) {
      makeWritable(scratch);
      rmSync(scratch, { recursive: true, force: true });
    }
    return value as unknown as ProbeEvidence;
  }
  const elapsed = Date.now() - started,
    evidence: ProbeEvidence = {
      ok: false,
      level: 'G1',
      duration_ms: elapsed,
      reason: elapsed >= 15 * 60_000 ? 'timeout' : 'probe_process_failed',
      error: output.trim().slice(-500) || `probe process exit ${String(result.exitCode)}`,
      evidence_path: evidencePath,
    };
  writeAtomic(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

export function promote(
  sha: string,
  bootstrapEvidence?: string,
  dependencies: PromotionDependencies = {}
): EngineReceipt {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('engine promote: invalid sha');
  mkdirSync(receiptsDir(), { recursive: true });
  const held = lock(join(root(), 'engine.lock'));
  if (!held.ok) throw new Error('engine promote: locked');
  let marker: PromotionMarker | undefined;
  try {
    sha = canonicalSha(sha);
    let retryingFailedCandidate = false;
    try {
      retryingFailedCandidate =
        (JSON.parse(readFileSync(markerPath(sha), 'utf8')) as PromotionMarker).status === 'failed';
    } catch {
      // No prior attempt.
    }
    marker = beginPromotion(sha);
    const current = currentEngineSnapshot();
    if (bootstrapEvidence && current)
      throw new Error('engine promote: bootstrap evidence is first-use only');
    if (isRejected(sha)) throw new Error('engine promote: sha is rejected');
    if (sha !== releaseHead()) throw new Error('engine promote: candidate is not 1.0.0 HEAD');
    const snapshot = prepareSnapshot(sha, retryingFailedCandidate);
    const next = bootstrapEvidence
      ? (() => {
          const evidence = resolve(bootstrapEvidence);
          if (!existsSync(evidence)) throw new Error('engine promote: bootstrap evidence missing');
          return {
            sha,
            protocol_version: ENGINE_PROTOCOL_VERSION,
            acceptance_hash: createHash('sha256').update(readFileSync(evidence)).digest('hex'),
            results: [],
            at: new Date().toISOString(),
            bootstrap_evidence: evidence,
          } satisfies EngineReceipt;
        })()
      : (() => {
          const acceptance = runAcceptance(snapshot);
          makeReadonly(snapshot);
          const probe = (dependencies.probe ?? runSnapshotProbe)(snapshot);
          if (!probe.ok) throw new ProbeFailed(probe);
          return {
            sha,
            protocol_version: ENGINE_PROTOCOL_VERSION,
            acceptance_hash: createHash('sha256')
              .update(readFileSync(join(snapshot, 'wetamp', 'scripts', 'engine-acceptance.sh')))
              .digest('hex'),
            results: [
              acceptance,
              {
                command: 'superagent engine probe G1',
                exit: 0,
                duration_ms: probe.duration_ms,
                ...(probe.run_id ? { run_id: probe.run_id } : {}),
              },
            ],
            at: new Date().toISOString(),
          } satisfies EngineReceipt;
        })();
    if (bootstrapEvidence) makeReadonly(snapshot);
    const currentSha = current && shaOfSnapshot(current);
    if (currentSha && !isAncestor(currentSha, sha))
      throw new Error('engine promote: candidate is not a current descendant');
    const newer = receipts().find(r => r.sha !== sha && isAncestor(sha, r.sha));
    if (newer) throw new Error(`engine promote: newer verified sha exists (${newer.sha})`);
    const currentReceipt = currentSha && receipt(currentSha);
    if (currentReceipt && next.protocol_version < currentReceipt.protocol_version)
      throw new Error('engine promote: protocol downgrade');
    if (!isAncestor(sha, releaseHead()))
      throw new Error('engine promote: 1.0.0 was rewritten during acceptance');
    writeAtomic(receiptPath(sha), JSON.stringify(next, null, 2) + '\n');
    switchCurrent(snapshot);
    writeMarker({ ...marker, status: 'promoted', at: new Date().toISOString() });
    return next;
  } catch (error) {
    if (marker) {
      writeMarker({
        ...marker,
        status: 'failed',
        error: error instanceof ProbeFailed ? 'probe_failed' : (error as Error).message,
        ...(error instanceof ProbeFailed
          ? { evidence_path: error.evidence.evidence_path }
          : error instanceof AcceptanceFailed
            ? { evidence_path: error.evidencePath }
            : {}),
        at: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    held.release();
  }
}

export function rollback(): { from: string; to: string } {
  mkdirSync(root(), { recursive: true });
  const held = lock(join(root(), 'engine.lock'));
  if (!held.ok) throw new Error('engine rollback: locked');
  try {
    const current = currentEngineSnapshot();
    if (!current) throw new Error('engine rollback: current is unset');
    const from = shaOfSnapshot(current);
    const protocol = receipt(from)?.protocol_version ?? ENGINE_PROTOCOL_VERSION;
    const denied = new Set(rejected());
    const previous = receipts()
      .filter(
        r =>
          r.sha !== from &&
          !denied.has(r.sha) &&
          r.protocol_version >= protocol &&
          existsSync(join(root(), r.sha))
      )
      .at(-1);
    if (!previous) throw new Error('engine rollback: no previous verified snapshot');
    switchCurrent(join(root(), previous.sha));
    writeAtomic(
      join(root(), 'rejected.json'),
      JSON.stringify([...new Set([...rejected(), from])], null, 2) + '\n'
    );
    return { from, to: previous.sha };
  } finally {
    held.release();
  }
}

export function adoptEngineSnapshot(
  run: string,
  value: string
): {
  run: string;
  from: string | null;
  to: string;
} {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error('engine adopt: invalid sha');
  const sha = canonicalSha(value);
  if (!receipt(sha)) throw new Error('engine adopt: snapshot was never served');
  const snapshot = join(root(), sha);
  if (!existsSync(snapshot)) throw new Error('engine adopt: snapshot is unavailable');
  const path = join(home().sa, 'runs', `${run}.json`);
  if (!existsSync(path)) throw new Error(`engine adopt: unknown run ${run}`);
  const initial = JSON.parse(readFileSync(path, 'utf8')) as EngineLedger;
  if (initial.run_id !== run || typeof initial.archon_run_id !== 'string')
    throw new Error('engine adopt: invalid ledger identity');
  if (initial.rejected === initial.archon_run_id)
    throw new Error('engine adopt: rejected run cannot be adopted');
  const held = executionAdmissionLock(home().archon, initial.archon_run_id);
  if (!held.ok) throw new Error('engine adopt: locked');
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as EngineLedger;
    if (ledger.run_id !== run || ledger.archon_run_id !== initial.archon_run_id)
      throw new Error('engine adopt: ledger identity changed');
    const from = fixedEngineSnapshot(ledger) ?? null;
    const to = realpathSync(snapshot);
    if (from !== to) {
      (ledger.engine_adoptions ??= []).push({ at: new Date().toISOString(), from, to });
      ledger.engine_snapshot = to;
      ledger.engine_snapshot_identity = currentEngineSnapshot() === to ? 'current' : 'served';
      writeAtomic(path, JSON.stringify(ledger, null, 2) + '\n');
    }
    return { run, from, to };
  } finally {
    held.release();
  }
}

export interface LegacyGateResult {
  ok: boolean;
  count: number;
  runs: { run_id: string; status: string; path?: string; reason?: string }[];
}

export function gateLegacyRuns(): LegacyGateResult {
  const runs: LegacyGateResult['runs'] = [];
  for (const path of ledgerPaths()) {
    let ledger: EngineLedger;
    try {
      ledger = readEngineLedger(path);
    } catch (error) {
      runs.push({
        run_id: basename(path, '.json'),
        status: 'unknown',
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (ledger.engine_snapshot || ledger.rejected === ledger.archon_run_id) continue;
    try {
      const run = getRun(ledger.archon_run_id, ledger.repo);
      if (run.status !== 'completed') runs.push({ run_id: ledger.run_id, status: run.status });
    } catch (error) {
      runs.push({
        run_id: ledger.run_id,
        status: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: runs.length === 0, count: runs.length, runs };
}

export function engineStatus(): Record<string, unknown> {
  const current = currentEngineSnapshot();
  const counts: Record<string, Record<string, number>> = {};
  const statuses = runStatuses();
  for (const value of runLedgers()) {
    const key = value.engine_snapshot ? basename(value.engine_snapshot) : 'bootstrap';
    let state = 'unknown';
    try {
      state =
        value.rejected === value.archon_run_id
          ? 'rejected'
          : statuses
            ? (statuses.get(value.archon_run_id) ?? 'unknown')
            : getRun(value.archon_run_id, value.repo).status;
    } catch {
      // Unknown is executable by policy and must remain visible.
    }
    counts[key] ??= {};
    counts[key][state] = (counts[key][state] ?? 0) + 1;
  }
  const currentSha = current && basename(current);
  const verified = receipts();
  return {
    current,
    hold: engineHold(),
    protocol_version: ENGINE_PROTOCOL_VERSION,
    snapshots: verified.map(item => ({
      sha: item.sha,
      identity: item.sha === currentSha ? 'current' : 'served',
      receipt: item,
      rejected: rejected().includes(item.sha),
      runs: counts[item.sha] ?? {},
    })),
    receipts: verified,
    rejected: rejected(),
    runs: counts,
  };
}

export function engineCommand(args: string[]): unknown {
  const action = args[0],
    sha = args.at(1);
  if (action === 'promote')
    return promote(sha ?? '', args[2] === '--bootstrap-evidence' ? args[3] : undefined);
  if (action === 'rollback') return rollback();
  if (action === 'status') return engineStatus();
  if (action === 'hold') {
    if (sha === 'status') return { hold: engineHold() };
    if (sha === 'off') {
      rmSync(holdPath(), { force: true });
      return { hold: null };
    }
    if (sha === 'on') {
      mkdirSync(root(), { recursive: true });
      const hold = {
        by: `${process.env.USER ?? process.env.LOGNAME ?? 'unknown'}@${hostname()}`,
        at: new Date().toISOString(),
      };
      writeAtomic(holdPath(), JSON.stringify(hold, null, 2) + '\n');
      return { hold };
    }
    throw new Error('usage: superagent engine hold <on|off|status>');
  }
  if (action === 'adopt') return adoptEngineSnapshot(sha ?? '', args[2] ?? '');
  if (action === 'gate-legacy') return gateLegacyRuns();
  if (action === 'probe') {
    const level = sha ?? 'G1';
    if (level !== 'G1' && level !== 'G2') throw new Error('usage: superagent engine probe [G1|G2]');
    return runProbe(level);
  }
  throw new Error(
    'usage: superagent engine promote <sha> [--bootstrap-evidence <path>] | probe [G1|G2] | rollback | status | hold <on|off|status> | adopt <run> <sha> | gate-legacy'
  );
}

export interface AutoPromoteDependencies {
  spawn?: (
    command: string[],
    env: Record<string, string | undefined>
  ) => { pid: number; unref(): void };
  inspect?: typeof inspectProcess;
}

export function autoPromote(
  dependencies: AutoPromoteDependencies = {}
): { sha: string; promoted: boolean; held?: boolean; error?: string } | undefined {
  const current = currentEngineSnapshot();
  if (process.env.SA_ENGINE_AUTO_PROMOTE === '0' || current === undefined) return undefined;
  const hold = engineHold();
  if (hold) return { sha: releaseHead(), promoted: false, held: true };
  mkdirSync(promotionDir(), { recursive: true });
  try {
    const sha = releaseHead();
    if (shaOfSnapshot(current) === sha) return { sha, promoted: false };
    const marker = join(promotionDir(), `${sha}.json`);
    if (existsSync(marker)) {
      const prior = JSON.parse(readFileSync(marker, 'utf8')) as PromotionMarker;
      if (prior.status === 'running') {
        const identity =
          prior.host === hostname()
            ? (dependencies.inspect ?? inspectProcess)(prior.pid)
            : undefined;
        if (!identity || identity.state === 'unknown') return { sha, promoted: false };
        if (identity.state === 'online' && identity.start === prior.pid_start)
          return { sha, promoted: false };
        const failed = {
          ...prior,
          status: 'failed' as const,
          error: 'promoter_lost',
          at: new Date().toISOString(),
        };
        writeMarker(failed);
        return {
          sha,
          promoted: false,
          error: `promoter_lost; retry: superagent engine promote ${sha}`,
        };
      }
      if (prior.status === 'promoted') return { sha, promoted: false };
      return {
        sha,
        promoted: false,
        error: `${prior.error ?? 'promotion failed'}; retry: superagent engine promote ${sha}`,
      };
    }
    const promotionLock = lock(join(root(), 'engine.lock'));
    if (!promotionLock.ok) return { sha, promoted: false };
    promotionLock.release();
    const token = crypto.randomUUID(),
      command = [
        process.execPath,
        join(current, 'wetamp', 'src', 'cli.ts'),
        'engine',
        'promote',
        sha,
      ],
      spawned = dependencies.spawn
        ? dependencies.spawn(command, { ...process.env, SA_ENGINE_PROMOTER_TOKEN: token })
        : Bun.spawn(command, {
            cwd: current,
            env: { ...process.env, SA_ENGINE_PROMOTER_TOKEN: token },
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
            detached: true,
          });
    const identity = (dependencies.inspect ?? inspectProcess)(spawned.pid);
    if (identity.state !== 'online')
      throw new Error('engine auto-promote: process identity unavailable');
    writeMarker({
      sha,
      status: 'running',
      pid: spawned.pid,
      pid_start: identity.start,
      host: hostname(),
      token,
      at: new Date().toISOString(),
    });
    spawned.unref();
    return { sha, promoted: false };
  } catch (error) {
    const result = {
      sha: 'unknown',
      promoted: false,
      error: error instanceof Error ? error.message : String(error),
    };
    try {
      const sha = releaseHead();
      writeAtomic(
        join(promotionDir(), `${sha}.json`),
        JSON.stringify({
          sha,
          status: 'failed',
          pid: process.pid,
          pid_start:
            inspectProcess(process.pid).state === 'online' ? inspectProcess(process.pid).start : '',
          host: hostname(),
          error: result.error,
          at: new Date().toISOString(),
        }) + '\n'
      );
      result.sha = sha;
    } catch {
      // A missing release ref is already preserved in result.error.
    }
    return result;
  }
}

const READ_ONLY = new Set([
  'help',
  'models',
  'wait',
  'status',
  'brief',
  'report',
  'health',
  'quota',
]);

/** Fence production writes by the identity of the checkout executing this CLI. */
export function assertEngineAccess(argv: string[]): void {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const defaults = join(process.env.HOME ?? homedir(), '.superagent');
  const state = home();
  const saProduction = canonical(state.sa) === canonical(defaults);
  const archonProduction = canonical(state.archon) === canonical(join(defaults, 'archon'));
  if (!saProduction && !archonProduction) return;
  const engineSa = saProduction ? state.sa : defaults;
  const current = currentEngineSnapshotAt(engineSa);
  if (!current) return;
  const running = runningEngineSnapshot();
  const verb = argv[0] ?? 'help';
  const mutatingRun = new Set(['resume', 'recover', 'decide', 'cancel', 'accept']);
  if (verb === 'land' && argv.includes('--apply')) mutatingRun.add('land');
  if (running === current) {
    const run = argv[1],
      path = run && join(home().sa, 'runs', `${run}.json`);
    if (mutatingRun.has(verb) && path && existsSync(path)) {
      const ledger = JSON.parse(readFileSync(path, 'utf8')) as { engine_snapshot?: string };
      const pinned = fixedEngineSnapshot(ledger);
      if (!pinned || resolve(pinned) !== running)
        throw new Error(`engine snapshot unavailable; run superagent engine adopt ${run} <sha>`);
    }
    return;
  }
  const served = process.env.SA_SERVED_RUN;
  const isServedSnapshot = existsSync(
    join(engineSa, 'engine', 'receipts', `${basename(running)}.json`)
  );
  if (!isServedSnapshot)
    throw new Error('engine identity: candidate checkout cannot access production state');
  if (!served) throw new Error('engine identity: non-current snapshot requires SA_SERVED_RUN');
  const requested =
    verb === 'supervise-tick' && argv.includes('--no-global')
      ? argv.flatMap((arg, index) => (arg === '--runs' ? [argv[index + 1]] : [])).filter(Boolean)
      : [argv[1]];
  const runVerbs = new Set([
    ...READ_ONLY,
    'resume',
    'recover',
    'decide',
    'land',
    'cancel',
    'accept',
    'supervise-tick',
  ]);
  if (
    !runVerbs.has(verb) ||
    !requested.length ||
    requested.some(id => id !== served && verb !== 'supervise-tick')
  )
    throw new Error('engine identity: non-current snapshot cannot execute an unscoped write');
  for (const id of requested) {
    const ledger = JSON.parse(readFileSync(join(home().sa, 'runs', `${id}.json`), 'utf8')) as {
      engine_snapshot?: string;
    };
    const pinned = fixedEngineSnapshot(ledger);
    if (!pinned || resolve(pinned) !== running)
      throw new Error('engine identity: SA_SERVED_RUN snapshot mismatch');
  }
}
