import {
  existsSync,
  readFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isPathInside } from '@archon/paths';
// prettier-ignore
import { archonJson, getRun, lock, QUERY_TIMEOUT_MS, reportRunRevisions, runStatuses, type RunView } from './archon';
import { home, writeAtomic } from './config';
import {
  artifactsOf,
  consoleLaunchdPlist,
  ledgerIds,
  ledgerPath,
  loadLedger,
  updateLedger,
  type Ledger,
} from './cli';
import type { Plan } from './plan';
import { makeWritable } from './engine';
import { inspectProcess } from './launcher';
import { createRequire } from 'node:module';
export interface ScratchAction {
  path: string;
  action: 'removed' | 'skipped' | 'would_remove';
  reason: string;
}
const scratch = createRequire(import.meta.url)('../hooks/scratch.cjs') as {
  clean: (
    session: string | undefined,
    dryRun: boolean,
    referenced: (path: string) => boolean
  ) => ScratchAction[];
};
export function scratchClean(session?: string, dryRun = false): ScratchAction[] {
  let ledgers: Ledger[] | undefined;
  const cachedPlans = new Map<string, string[]>();
  let statuses: Map<string, RunView['status']> | null = null;
  try {
    statuses = runStatuses();
  } catch {
    statuses = null;
  }
  return scratch.clean(session, dryRun, path =>
    (ledgers ??= ledgerIds().map(loadLedger)).some(l => {
      // l.plan keeps the launch argument verbatim; a relative one only resolves in the launch
      // cwd, so the absolute gen copy (same parsed plan) stands in for it.
      const plans = [
        ...new Set([join(l.gen_dir, 'plan.json'), ...(isAbsolute(l.plan) ? [l.plan] : [])]),
      ];
      let texts = cachedPlans.get(l.run_id);
      if (!texts) {
        texts = plans.flatMap(file => {
          try {
            return [readFileSync(file, 'utf8')];
          } catch (e) {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return [];
            throw e;
          }
        });
        cachedPlans.set(l.run_id, texts);
      }
      if (texts.length && !texts.some(text => text.includes(path))) return false;
      const status = statuses?.get(l.archon_run_id) ?? getRun(l.archon_run_id, l.repo).status;
      return !['completed', 'failed', 'cancelled'].includes(status);
    })
  );
}

export interface GcAction {
  run_id: string;
  object: 'run' | 'worktree' | 'branch' | 'gen' | 'engine';
  action: 'removed' | 'skipped' | 'would_remove';
  reason: string;
  path?: string;
  at?: string;
  record_error?: string;
}

class GcSkip extends Error {}
// prettier-ignore
function liveAdoptions(): Map<string, string> {
  const postgres = !!process.env.DATABASE_URL, path = postgres ? '' : join(home().archon, 'archon.db'); let rows: { id: string; status: RunView['status']; adopted_from_run_id: string | null }[];
  if (postgres || !existsSync(path)) { const result = archonJson(['workflow', 'runs', '--all', '--limit', String(2 ** 31 - 1), '--verbose']); if (!Array.isArray(result.runs)) throw new Error('archon workflow runs: invalid runs payload'); rows = result.runs as typeof rows; }
  else { const { Database } = createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite'), db = new Database(path, { readonly: true }); try { rows = db.query<typeof rows[number], []>('SELECT id, status, adopted_from_run_id FROM remote_agent_workflow_runs').all(); } finally { db.close(); } }
  const parent = new Map(rows.flatMap(r => r.adopted_from_run_id ? [[r.id, r.adopted_from_run_id]] : [])), live = new Map<string, string>();
  for (const run of rows) if (!['completed', 'failed', 'cancelled'].includes(run.status)) for (let id = run.id, left = rows.length; left-- && (id = parent.get(id) ?? ''); ) live.set(id, run.id);
  return live;
}
type RepoState = [git: (...args: string[]) => string, trees: string[][], refs: string];
interface GcInput {
  fingerprint: string;
  rule_version: string;
  working_path: string;
}

const gcRuleVersion = (): string =>
  new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex');

function consoleEngineSnapshot(engineRoot: string, configuredRoot: string) {
  const plist = consoleLaunchdPlist();
  if (!existsSync(plist)) return {};
  const cmd = ['plutil', '-extract', 'ProgramArguments', 'json', '-o', '-', plist];
  const parsed = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  try {
    if (parsed.exitCode !== 0) throw new Error(parsed.stderr.toString().trim());
    const args = JSON.parse(parsed.stdout.toString()) as string[];
    for (const argument of args)
      for (const root of [engineRoot, configuredRoot]) {
        const absolute = resolve(argument),
          sha = absolute.startsWith(root + '/')
            ? absolute.slice(root.length + 1).split('/')[0]
            : '';
        if (/^[0-9a-f]{7,40}$/i.test(sha)) return { path: join(engineRoot, sha) };
      }
    return {};
  } catch (error) {
    return { error: String(error) };
  }
}
// prettier-ignore
export function collectEngineSnapshots(dryRun: boolean, statuses: Map<string, RunView['status']> | null = null): GcAction[] {
  const configuredRoot = resolve(home().sa, 'engine');
  if (!existsSync(configuredRoot)) return [];
  let engineRoot: string, current: string;
  try {
    engineRoot = realpathSync(configuredRoot);
    current = realpathSync(join(configuredRoot, 'current'));
  } catch (error) {
    return [
      {
        run_id: '*',
        object: 'engine',
        action: 'skipped',
        reason: `engine identity unavailable: ${String(error)}`,
      },
    ];
  }
  const receiptRoot = join(engineRoot, 'receipts');
  const receipts = (
    existsSync(receiptRoot) ? readdirSync(receiptRoot).filter(file => file.endsWith('.json')) : []
  )
    .flatMap(file => {
      try {
        const value = JSON.parse(readFileSync(join(receiptRoot, file), 'utf8')) as {
          sha?: unknown;
          at?: unknown;
        };
        return typeof value.sha === 'string' && typeof value.at === 'string'
          ? [{ sha: value.sha, at: value.at }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const currentSha = current.startsWith(engineRoot + '/')
    ? current.slice(engineRoot.length + 1)
    : undefined;
  if (!currentSha)
    return [
      {
        run_id: '*',
        object: 'engine',
        action: 'skipped',
        reason: 'current engine snapshot is outside engine root',
      },
    ];
  const consoleSnapshot = consoleEngineSnapshot(engineRoot, configuredRoot);
  if (consoleSnapshot.error) return [{ run_id: '*', object: 'engine', action: 'skipped', reason: `console plist unreadable; all engine snapshots retained: ${consoleSnapshot.error}` }];
  const previous = receipts.filter(value => value.sha !== currentSha).at(-1)?.sha;
  const ledgers: Ledger[] = [];
  for (const id of ledgerIds()) {
    try {
      ledgers.push(loadLedger(id));
    } catch (error) {
      return [
        {
          run_id: id,
          object: 'engine',
          action: 'skipped',
          reason: `ledger unreadable; all engine snapshots retained: ${String(error)}`,
        },
      ];
    }
  }
  const bootstrap = receipts.at(0)?.sha;
  return readdirSync(engineRoot, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[0-9a-f]{7,40}$/i.test(entry.name)) return [];
    const path = join(engineRoot, entry.name);
    if (entry.name === currentSha || entry.name === previous) return [];
    if (path === consoleSnapshot.path) return [{ run_id: '*', object: 'engine', action: 'skipped', reason: 'console snapshot retained', path }];
    const references = ledgers.filter(ledger => {
      const pinned = ledger.engine_snapshot ?? (bootstrap && join(engineRoot, bootstrap));
      if (!pinned) return false;
      try {
        return realpathSync(pinned) === path;
      } catch {
        return resolve(pinned) === path;
      }
    });
    let reason = 'completed or rejected run snapshots';
    // prettier-ignore
    if (!references.length) {
      let marker: { status?: string; pid?: number; pid_start?: string; host?: string };
      try {
        marker = JSON.parse(readFileSync(join(engineRoot, 'promotions', `${entry.name}.json`), 'utf8')) as typeof marker;
      } catch {
        return [{ run_id: '*', object: 'engine', action: 'skipped', reason: 'unreferenced snapshot has no promotion record', path }];
      }
      if (marker.status === 'running') {
        const identity = marker.host === hostname() && typeof marker.pid === 'number' ? inspectProcess(marker.pid) : undefined;
        if (!identity || identity.state === 'unknown' || identity.state === 'online' && identity.start === marker.pid_start) return [];
      }
      reason = 'unreferenced promotion candidate';
    }
    for (const ledger of references) {
      if (ledger.rejected === ledger.archon_run_id) continue;
      try {
        const status =
          statuses?.get(ledger.archon_run_id) ?? getRun(ledger.archon_run_id, ledger.repo).status;
        if (['completed', 'cancelled'].includes(status)) continue;
      } catch {
        return [];
      }
      return [];
    }
    const action: GcAction = {
      run_id: references.map(ledger => ledger.run_id).join(',') || '*',
      object: 'engine',
      action: dryRun ? 'would_remove' : 'removed',
      reason,
      path,
    };
    if (dryRun) return [action];
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('engine snapshot symlink retained');
      makeWritable(path);
      const common = Bun.spawnSync(
        ['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
      );
      if (common.exitCode === 0) {
        const removed = Bun.spawnSync(
          [
            'git',
            '--git-dir',
            common.stdout.toString().trim(),
            'worktree',
            'remove',
            '--force',
            path,
          ],
          { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
        );
        if (removed.exitCode !== 0) throw new Error(removed.stderr.toString().trim());
      }
      rmSync(path, { recursive: true, force: true });
      return [action];
    } catch (error) {
      return [
        {
          ...action,
          action: 'skipped',
          reason: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  });
}

// Only engine probe directories enter this path; run/user worktrees keep their existing guards.
// prettier-ignore
function collectProbe(path: string, id: string, dryRun: boolean, repo?: string, engine = false): GcAction {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('probe symlink retained');
    if (!repo && !engine) {
      const status = Bun.spawnSync(
        ['git', '-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
      );
      // Legacy probes have no run ledger: retain anything except clean trees or tracked deletions.
      if (
        status.exitCode !== 0 ||
        status.stdout
          .toString()
          .split('\0')
          .filter(Boolean)
          .some(row => ![' D ', 'D  '].includes(row.slice(0, 3)))
      )
        throw new Error('legacy probe is not clean or tracked-deletions-only');
    }
    if (!dryRun) {
      makeWritable(path);
      const options = { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS } as const;
      const common = Bun.spawnSync(
        ['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        options
      );
      const owner = repo
        ? ['-C', repo]
        : common.exitCode === 0
          ? ['--git-dir', common.stdout.toString().trim()]
          : [];
      if (owner.length && common.exitCode === 0) {
        const removed = Bun.spawnSync(
          ['git', ...owner, 'worktree', 'remove', '--force', path],
          options
        );
        if (removed.exitCode !== 0) throw new Error(removed.stderr.toString());
      }
      rmSync(path, { recursive: true, force: true });
    }
    return {
      run_id: id,
      object: 'worktree',
      action: dryRun ? 'would_remove' : 'removed',
      reason: engine ? 'stale engine probe' : 'terminal probe',
      path,
    };
  } catch (e) {
    return { run_id: id, object: 'worktree', action: 'skipped', reason: String(e), path };
  }
}

const GEN_RETENTION_MS = 30 * 24 * 60 * 60_000;
function collectGen(dryRun: boolean): GcAction[] {
  const out: GcAction[] = [],
    root = resolve(home().sa, 'gen');
  try {
    if (!existsSync(root)) return out;
    if (lstatSync(root).isSymbolicLink()) throw new Error('gen root symlink retained');
    const genRoot = realpathSync(root);
    // Every ledger remains a reader, including terminal runs used by report/usage/memory.
    const refs = ledgerIds().flatMap(id => {
      const path = loadLedger(id).gen_dir;
      if (!isAbsolute(path)) throw new Error(`ambiguous gen_dir in ledger ${id}`);
      return [resolve(path), ...(existsSync(path) ? [realpathSync(path)] : [])];
    });
    for (const entry of readdirSync(genRoot, { withFileTypes: true })) {
      const path = resolve(genRoot, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let action: GcAction['action'] = 'skipped',
        reason = '';
      try {
        if (!isPathInside(genRoot, path)) throw new Error('gen path outside root');
        const st = lstatSync(path);
        if (st.isSymbolicLink()) reason = 'gen symlink retained';
        else if (
          refs.some(
            ref => isPathInside(path, ref, { includeRoot: true }) || isPathInside(ref, path)
          )
        )
          reason = 'ledger reference retained';
        else if (Date.now() - st.mtimeMs <= GEN_RETENTION_MS) reason = 'gen younger than 30 days';
        else {
          if (!dryRun) rmSync(path, { recursive: true, force: true });
          action = dryRun ? 'would_remove' : 'removed';
          reason = 'unreferenced gen older than 30 days';
        }
      } catch (e) {
        reason = String(e);
      }
      out.push({ run_id: entry.name, object: 'gen', action, reason, path });
    }
  } catch (e) {
    out.push({ run_id: '*', object: 'gen', action: 'skipped', reason: String(e), path: root });
  }
  return out;
}

/** Registered runs use the recovery lock; unreferenced gen snapshots use age and path guards. */
export function gc(
  dryRun = false,
  probeRoots = [tmpdir(), '/tmp'],
  ruleVersion = gcRuleVersion()
): GcAction[] {
  const out: GcAction[] = [];
  let statuses: Map<string, RunView['status']> | null = null;
  let revisions: Map<string, string> | null = null;
  let adoptions: Map<string, string> | null = null;
  try {
    adoptions = liveAdoptions();
  } catch (e) {
    console.error(`gc live adoption state unavailable: ${(e as Error).message}`);
  }
  try {
    if (!dryRun) {
      statuses = runStatuses();
      revisions = reportRunRevisions();
    }
  } catch (e) {
    console.error(`gc revision cache unavailable: ${(e as Error).message}`);
  }
  let cached: Partial<Record<string, GcInput>> = {};
  if (!dryRun)
    try {
      cached = JSON.parse(
        readFileSync(join(home().sa, 'gc-inputs.json'), 'utf8')
      ) as unknown as Partial<Record<string, GcInput>>;
    } catch {
      cached = {};
    }
  const next: Partial<Record<string, GcInput>> = {},
    repos = new Map<string, RepoState>(),
    successors = new Map<string, string>();
  for (const ledgerId of ledgerIds()) {
    try {
      for (const adoption of loadLedger(ledgerId).adoptions ?? [])
        successors.set(adoption.from, adoption.to);
    } catch {
      // The owning ledger will report its own read failure below.
    }
  }
  const repoState = (repo: string): RepoState => {
    const hit = repos.get(repo);
    if (hit) return hit;
    const git = (...args: string[]): string => {
      const p = Bun.spawnSync(['git', '-C', repo, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: QUERY_TIMEOUT_MS,
      });
      if (p.exitCode !== 0)
        throw new Error(p.stderr.toString() || `git ${args.join(' ')} exit ${String(p.exitCode)}`);
      return p.stdout.toString();
    };
    const rawTrees = git('worktree', 'list', '--porcelain', '-z'),
      rawRefs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
      state: RepoState = [git, rawTrees.split('\0\0').map(r => r.split('\0')), rawRefs];
    repos.set(repo, state);
    return state;
  };
  const fingerprint = (
    id: string,
    l: Ledger,
    state: RepoState,
    path?: string | null
  ): string | undefined => {
    const revision = revisions?.get(l.archon_run_id);
    if (!revision || !path) return undefined;
    const { mtimeMs, size } = statSync(ledgerPath(id));
    const ref = `refs/heads/sa/${id}`,
      refs = state[2].trim().split('\n'),
      tree = state[1].find(t => t.includes(`worktree ${path}`) || t.includes(`branch ${ref}`)),
      sha = refs.find(r => r.startsWith(`${ref} `)),
      landed = sha
        ? refs.filter(r => r.startsWith('refs/heads/') && !r.startsWith('refs/heads/sa/')).sort()
        : [];
    return JSON.stringify([l.archon_run_id, mtimeMs, size, revision, tree, sha, landed]);
  };
  try {
    for (const id of ledgerIds()) {
      const events: GcAction[] = [];
      const failures: unknown[] = [];
      let workingPath: string | null | undefined = cached[id]?.working_path;
      const collect = (l: Ledger): void => {
        let object: GcAction['object'] = 'run';
        const event = (action: GcAction['action'], reason: string, path?: string): void => {
          events.push({ run_id: id, object, action, reason, ...(path ? { path } : {}) });
        };
        try {
          const plan = JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;
          let engine: { fake?: boolean } = {};
          try {
            engine = JSON.parse(readFileSync(join(l.gen_dir, 'engine.json'), 'utf8')) as {
              fake?: boolean;
            };
          } catch (e) {
            if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
          }
          if (plan.repo !== l.repo || l.branch !== `sa/${id}`)
            throw new Error('ledger/plan identity mismatch');
          const ref = `refs/heads/sa/${id}`;
          const state = repoState(plan.repo),
            git = state[0];
          const trees = (): string[][] =>
            git('worktree', 'list', '--porcelain', '-z')
              .split('\0\0')
              .map(r => r.split('\0'));
          const listed = state[1];
          const refs = state[2].trim().split('\n');
          const sha = refs.find(r => r.startsWith(`${ref} `))?.slice(ref.length + 1);
          const knownStatus = statuses?.get(l.archon_run_id);
          if (knownStatus && !['completed', 'failed', 'cancelled'].includes(knownStatus))
            throw new GcSkip(`run ${knownStatus} remains recoverable`);
          const run = getRun(l.archon_run_id, plan.repo);
          if (run.id !== l.archon_run_id) throw new Error('Archon run identity mismatch');
          workingPath = run.working_path;
          if (!['completed', 'failed', 'cancelled'].includes(run.status))
            throw new GcSkip(`run ${run.status} remains recoverable`);
          if (run.output_root) {
            const art = artifactsOf(run),
              trash = join(art, '.trash');
            const candidates = existsSync(art)
              ? readdirSync(art, { withFileTypes: true })
                  .filter(e => e.isDirectory() && e.name.startsWith('probe-'))
                  .map(e => join(art, e.name))
              : [];
            if (existsSync(trash) && lstatSync(trash).isDirectory())
              candidates.push(...readdirSync(trash).map(e => join(trash, e)), trash);
            events.push(...candidates.map(p => collectProbe(p, id, dryRun, plan.repo)));
          }
          const path = run.working_path,
            root = join(home().archon, 'workspaces');
          object = 'worktree';
          let finalReason: 'superseded' | 'resources_collected' | undefined;
          const finalize = (
            reason: NonNullable<typeof finalReason>,
            evidence: Record<string, unknown>
          ): void => {
            finalReason = reason;
            if (run.status !== 'failed' || l.rejected === run.id || dryRun) return;
            l.rejected = run.id;
            (l.intervention_events ??= []).push({
              at: new Date().toISOString(),
              action: 'abandon',
              reason,
              origin: 'engine',
              source: 'superagent',
              ok: true,
              evidence,
            });
          };
          const successor = successors.get(run.id);
          if (successor) finalize('superseded', { successor });
          if (
            !path ||
            !isPathInside(root, path) ||
            (existsSync(path) && !isPathInside(realpathSync(root), realpathSync(path)))
          )
            throw new Error('Archon working_path outside workspaces');
          const tree = listed.find(t => t.includes(`worktree ${path}`));
          const removed = l.gc?.some(
            e => e.object === 'worktree' && e.action === 'removed' && e.path === path
          );
          const resourcesCollected = !tree && !sha && !existsSync(path);
          if (resourcesCollected)
            finalize('resources_collected', { missing: { branch: ref, worktree: path } });
          if (resourcesCollected) return;
          const adoptedBy = adoptions?.get(l.archon_run_id);
          // prettier-ignore
          if (!adoptions || adoptedBy) throw new GcSkip(adoptedBy ? `adopted by live run ${adoptedBy}` : 'live adoption state unavailable');
          let halfDeleted = false;
          if (!tree && !removed && existsSync(path)) {
            if (!sha) throw new GcSkip('half-deleted worktree branch ref missing');
            if (lstatSync(path).isSymbolicLink())
              throw new GcSkip('half-deleted worktree path is a symlink');
            if (existsSync(join(path, '.git')))
              throw new GcSkip('half-deleted worktree still contains .git');
            const entries = readdirSync(path);
            if (entries.length)
              throw new GcSkip(
                `half-deleted worktree contains unknown entries: ${entries.slice(0, 3).join(',')}`
              );
            if (!dryRun) rmdirSync(path);
            event(dryRun ? 'would_remove' : 'removed', 'terminal half-deleted worktree', path);
            halfDeleted = true;
          }
          if (
            tree ? !tree.includes(`branch ${ref}`) : !halfDeleted && (!removed || existsSync(path))
          )
            throw new GcSkip('worktree path/branch registration mismatch');
          if (!sha) {
            if (!tree && removed) return;
            throw new GcSkip('registered branch missing');
          }
          const merged = git(
            'for-each-ref',
            '--contains',
            sha,
            '--format=%(refname)',
            'refs/heads/'
          )
            .trim()
            .split('\n')
            .some(r => r.startsWith('refs/heads/') && !r.startsWith('refs/heads/sa/'));
          // A failed run stays retryable through tick/decide whether or not it is fake.
          const disposable = engine.fake === true && run.status !== 'failed';
          if (run.status === 'failed' && l.rejected !== run.id && !finalReason)
            throw new GcSkip(
              merged
                ? 'run failed remains recoverable'
                : 'run failed branch not merged; remains recoverable'
            );
          if (
            !merged &&
            !disposable &&
            l.rejected !== run.id &&
            !finalReason &&
            run.status !== 'completed'
          )
            throw new GcSkip(`run ${run.status} branch not merged; remains recoverable`);
          if (tree) {
            if (
              git(
                '-C',
                path,
                'status',
                '--porcelain=v1',
                '--untracked-files=all',
                '--ignore-submodules=none'
              ) !== ''
            )
              throw new GcSkip('worktree dirty');
            if (!dryRun) git('worktree', 'remove', '--force', path);
            event(dryRun ? 'would_remove' : 'removed', 'terminal run worktree', path);
          }
          object = 'branch';
          if (!merged && !disposable)
            event('skipped', 'branch not merged into a local non-sa branch');
          else if (
            trees().some(
              t => t.includes(`branch ${ref}`) && !(dryRun && t.includes(`worktree ${path}`))
            )
          )
            event('skipped', 'branch checked out in a worktree');
          else {
            if (!dryRun) git('update-ref', '-d', ref, sha);
            event(dryRun ? 'would_remove' : 'removed', 'terminal run branch');
          }
        } catch (e) {
          if (!(e instanceof GcSkip)) failures.push(e);
          event('skipped', e instanceof Error ? e.message : String(e));
        } finally {
          if (!dryRun)
            for (const e of events) {
              if (
                e.action === 'skipped' &&
                l.gc?.some(
                  p => p.action === e.action && p.object === e.object && p.reason === e.reason
                )
              )
                continue;
              (l.gc ??= []).push({ ...e, at: new Date().toISOString() });
            }
        }
      };
      try {
        const l = loadLedger(id);
        const state = (() => {
            try {
              return repoState(l.repo);
            } catch {
              return undefined;
            }
          })(),
          fp = state && fingerprint(id, l, state, workingPath);
        if (fp && cached[id]?.rule_version === ruleVersion && cached[id].fingerprint === fp)
          next[id] = cached[id];
        else if (dryRun) collect(l);
        else {
          updateLedger(l, collect);
          const after = state && fingerprint(id, l, state, workingPath);
          // prettier-ignore
          if (!failures.length && after && workingPath && adoptions && !adoptions.has(l.archon_run_id) && events.every(e => e.action === 'skipped'))
            next[id] = { fingerprint: after, rule_version: ruleVersion, working_path: workingPath };
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        events.push({ run_id: id, object: 'run', action: 'skipped', reason, record_error: reason });
      }
      out.push(...events);
    }
  } catch (e) {
    out.push({ run_id: '*', object: 'run', action: 'skipped', reason: String(e) });
  }
  if (!dryRun && revisions) writeAtomic(join(home().sa, 'gc-inputs.json'), JSON.stringify(next));
  try {
    for (const root of new Set(probeRoots.filter(existsSync).map(p => realpathSync(p)))) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (!entry.isDirectory() || Date.now() - statSync(path).mtimeMs <= 24 * 60 * 60_000)
          continue;
        if (entry.name.startsWith('sa-probe-')) out.push(collectProbe(path, '*', dryRun));
        else if (entry.name.startsWith('sa-engine-probe-')) {
          const engineRoot = resolve(home().sa, 'engine'),
            held = existsSync(engineRoot) ? lock(join(engineRoot, 'engine.lock')) : undefined;
          try {
            if (held?.ok !== false) out.push(collectProbe(path, '*', dryRun, undefined, true));
          } finally {
            if (held?.ok) held.release();
          }
        }
      }
    }
  } catch (e) {
    out.push({ run_id: '*', object: 'worktree', action: 'skipped', reason: String(e) });
  }
  return [...out, ...collectGen(dryRun), ...collectEngineSnapshots(dryRun, statuses)];
}
