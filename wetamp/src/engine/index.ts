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
import { lock } from '../archon';
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

export function currentEngineSnapshot(): string | undefined {
  try {
    return realpathSync(currentLink());
  } catch {
    return undefined;
  }
}

export function runEngineSnapshot(): { path: string; identity: 'current' | 'candidate' } {
  const current = currentEngineSnapshot();
  const running = runningEngineSnapshot();
  return {
    path: current && current === running ? current : running,
    identity: current === running ? 'current' : 'candidate',
  };
}

const git = (args: string[], cwd = sourceRoot()): string => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
};

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

export function bootstrapEngineSnapshot(): string | undefined {
  const first = receipts().at(0);
  if (first === undefined) return undefined;
  return existsSync(join(root(), first.sha)) ? join(root(), first.sha) : undefined;
}

const rejected = (): string[] => {
  try {
    const value = JSON.parse(readFileSync(join(root(), 'rejected.json'), 'utf8')) as unknown;
    return Array.isArray(value) && value.every(x => typeof x === 'string') ? value : [];
  } catch {
    return [];
  }
};

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
  git(['rev-parse', '--verify', `${sha}^{commit}`]);
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
    const current = currentEngineSnapshot();
    if (bootstrapEvidence && current)
      throw new Error('engine promote: bootstrap evidence is first-use only');
    if (rejected().includes(sha)) throw new Error('engine promote: sha is rejected');
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
    writeAtomic(receiptPath(sha), JSON.stringify(next, null, 2) + '\n');
    const currentSha = current && shaOfSnapshot(current);
    if (currentSha && !isAncestor(currentSha, sha))
      throw new Error('engine promote: candidate is not a current descendant');
    const newer = receipts().find(r => r.sha !== sha && isAncestor(sha, r.sha));
    if (newer) throw new Error(`engine promote: newer verified sha exists (${newer.sha})`);
    const currentReceipt = currentSha && receipt(currentSha);
    if (currentReceipt && next.protocol_version < currentReceipt.protocol_version)
      throw new Error('engine promote: protocol downgrade');
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

export function engineStatus(): Record<string, unknown> {
  const current = currentEngineSnapshot();
  const counts: Record<string, Record<string, number>> = {};
  const runs = join(home().sa, 'runs');
  for (const file of existsSync(runs) ? readdirSync(runs).filter(x => x.endsWith('.json')) : []) {
    try {
      const value = JSON.parse(readFileSync(join(runs, file), 'utf8')) as {
        engine_snapshot?: string;
        state?: string;
      };
      const key = value.engine_snapshot ?? 'bootstrap';
      const state = value.state ?? 'active';
      counts[key] ??= {};
      counts[key][state] = (counts[key][state] ?? 0) + 1;
    } catch {
      continue;
    }
  }
  return {
    current,
    protocol_version: ENGINE_PROTOCOL_VERSION,
    receipts: receipts(),
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
  throw new Error(
    'usage: superagent engine promote <sha> [--bootstrap-evidence <path>] | rollback | status'
  );
}

export function autoPromote(): { sha: string; promoted: boolean; error?: string } | undefined {
  const current = currentEngineSnapshot();
  if (process.env.SA_ENGINE_AUTO_PROMOTE === '0' || current === undefined) return undefined;
  try {
    const sha = git(['rev-parse', 'HEAD']);
    if (shaOfSnapshot(current) === sha) return { sha, promoted: false };
    promote(sha);
    return { sha, promoted: true };
  } catch (error) {
    return {
      sha: 'unknown',
      promoted: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
  const current = currentEngineSnapshot();
  if (!current) return;
  const running = runningEngineSnapshot();
  const verb = argv[0] ?? 'help';
  const mutating = !READ_ONLY.has(verb) && !(verb === 'land' && !argv.includes('--apply'));
  if (running === current) return;
  const production = resolve(home().sa) === resolve(process.env.HOME ?? homedir(), '.superagent');
  const served = process.env.SA_SERVED_RUN;
  const isServedSnapshot = existsSync(receiptPath(basename(running)));
  if (mutating && production && !isServedSnapshot)
    throw new Error('engine identity: candidate checkout cannot write production state');
  if (!mutating || (verb === 'supervise-tick' && argv.includes('--no-global'))) return;
  if (!served) throw new Error('engine identity: non-current snapshot requires SA_SERVED_RUN');
  const ledger = JSON.parse(readFileSync(join(home().sa, 'runs', `${served}.json`), 'utf8')) as {
    engine_snapshot?: string;
  };
  if (!ledger.engine_snapshot || resolve(ledger.engine_snapshot) !== running)
    throw new Error('engine identity: SA_SERVED_RUN snapshot mismatch');
}
