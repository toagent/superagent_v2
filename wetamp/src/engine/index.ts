import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { executionAdmissionLock } from '@archon/workflows/execution-lifecycle';
import { getRun, lock } from '../archon';
import { WETAMP, home, writeAtomic } from '../config';

export const ENGINE_PROTOCOL_VERSION = 1;

export interface EngineReceipt {
  sha: string;
  protocol_version: number;
  acceptance_hash: string;
  results: { command: string; exit: number }[];
  at: string;
  bootstrap_evidence?: string;
}

const root = (): string => join(home().sa, 'engine');
const receiptsDir = (): string => join(root(), 'receipts');
const currentLink = (): string => join(root(), 'current');
const promotionDir = (): string => join(root(), 'promotions');
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

function prepareSnapshot(sha: string): string {
  const snapshot = join(root(), sha);
  if (existsSync(snapshot)) return snapshot;
  mkdirSync(root(), { recursive: true });
  git(['worktree', 'add', '--detach', snapshot, sha]);
  const install = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], {
    cwd: snapshot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (install.exitCode !== 0) throw new Error(`bun install: ${install.stderr.toString().trim()}`);
  makeReadonly(snapshot);
  return snapshot;
}

function automaticReceipt(sha: string, snapshot: string): EngineReceipt {
  const script = join(snapshot, 'wetamp', 'scripts', 'engine-acceptance.sh');
  const scratch = join(tmpdir(), `sa-engine-${crypto.randomUUID()}`);
  const result = Bun.spawnSync(['bash', script], {
    cwd: join(snapshot, 'wetamp'),
    env: {
      ...process.env,
      SUPERAGENT_HOME: join(scratch, 'sa'),
      ARCHON_HOME: join(scratch, 'archon'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0)
    throw new Error(
      `engine acceptance failed (${String(result.exitCode)}): ${result.stderr.toString().trim().slice(-500)}`
    );
  return {
    sha,
    protocol_version: ENGINE_PROTOCOL_VERSION,
    acceptance_hash: createHash('sha256').update(readFileSync(script)).digest('hex'),
    results: [{ command: 'wetamp/scripts/engine-acceptance.sh', exit: 0 }],
    at: new Date().toISOString(),
  };
}

export function promote(sha: string, bootstrapEvidence?: string): EngineReceipt {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('engine promote: invalid sha');
  mkdirSync(receiptsDir(), { recursive: true });
  const held = lock(join(root(), 'engine.lock'));
  if (!held.ok) throw new Error('engine promote: locked');
  try {
    sha = canonicalSha(sha);
    const current = currentEngineSnapshot();
    if (bootstrapEvidence && current)
      throw new Error('engine promote: bootstrap evidence is first-use only');
    if (isRejected(sha)) throw new Error('engine promote: sha is rejected');
    if (sha !== releaseHead()) throw new Error('engine promote: candidate is not 1.0.0 HEAD');
    const snapshot = prepareSnapshot(sha);
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
      : automaticReceipt(sha, snapshot);
    const currentSha = current && shaOfSnapshot(current);
    if (currentSha && !isAncestor(currentSha, sha))
      throw new Error('engine promote: candidate is not a current descendant');
    const newer = receipts().find(r => r.sha !== sha && isAncestor(sha, r.sha));
    if (newer) throw new Error(`engine promote: newer verified sha exists (${newer.sha})`);
    const currentReceipt = currentSha && receipt(currentSha);
    if (currentReceipt && next.protocol_version < currentReceipt.protocol_version)
      throw new Error('engine promote: protocol downgrade');
    if (sha !== releaseHead())
      throw new Error('engine promote: 1.0.0 HEAD changed during acceptance');
    writeAtomic(receiptPath(sha), JSON.stringify(next, null, 2) + '\n');
    switchCurrent(snapshot);
    return next;
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
    const from = ledger.engine_snapshot ?? bootstrapEngineSnapshot() ?? null;
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
  for (const value of runLedgers()) {
    const key = value.engine_snapshot ? basename(value.engine_snapshot) : 'bootstrap';
    let state = 'unknown';
    try {
      state =
        value.rejected === value.archon_run_id
          ? 'rejected'
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
  if (action === 'adopt') return adoptEngineSnapshot(sha ?? '', args[2] ?? '');
  if (action === 'gate-legacy') return gateLegacyRuns();
  throw new Error(
    'usage: superagent engine promote <sha> [--bootstrap-evidence <path>] | rollback | status | adopt <run> <sha> | gate-legacy'
  );
}

export function autoPromote(): { sha: string; promoted: boolean; error?: string } | undefined {
  const current = currentEngineSnapshot();
  if (process.env.SA_ENGINE_AUTO_PROMOTE === '0' || current === undefined) return undefined;
  mkdirSync(promotionDir(), { recursive: true });
  try {
    const sha = releaseHead();
    if (shaOfSnapshot(current) === sha) return { sha, promoted: false };
    const marker = join(promotionDir(), `${sha}.json`);
    if (existsSync(marker)) {
      const prior = JSON.parse(readFileSync(marker, 'utf8')) as { error?: string };
      return { sha, promoted: false, error: prior.error ?? 'promotion already attempted' };
    }
    promote(sha);
    writeAtomic(
      marker,
      JSON.stringify({ sha, status: 'promoted', at: new Date().toISOString() }) + '\n'
    );
    return { sha, promoted: true };
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
      const pinned = ledger.engine_snapshot ?? bootstrapEngineSnapshot();
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
    const pinned = ledger.engine_snapshot ?? bootstrapEngineSnapshot();
    if (!pinned || resolve(pinned) !== running)
      throw new Error('engine identity: SA_SERVED_RUN snapshot mismatch');
  }
}
