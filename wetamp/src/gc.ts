import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isPathInside } from '@archon/paths';
import { getRun, QUERY_TIMEOUT_MS } from './archon';
import { home } from './config';
import { ledgerIds, loadLedger, updateLedger, type Ledger } from './cli';
import type { Plan } from './plan';
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
  return scratch.clean(session, dryRun, path =>
    ledgerIds().some(id => {
      const l = loadLedger(id);
      // l.plan keeps the launch argument verbatim; a relative one only resolves in the launch
      // cwd, so the absolute gen copy (same parsed plan) stands in for it.
      const plans = [join(l.gen_dir, 'plan.json'), ...(isAbsolute(l.plan) ? [l.plan] : [])];
      if (!plans.some(file => readFileSync(file, 'utf8').includes(path))) return false;
      const run = getRun(l.archon_run_id, l.repo);
      if (run.id !== l.archon_run_id) throw new Error('Archon run identity mismatch');
      return !['completed', 'failed', 'cancelled'].includes(run.status);
    })
  );
}

export interface GcAction {
  run_id: string;
  object: 'run' | 'worktree' | 'branch';
  action: 'removed' | 'skipped' | 'would_remove';
  reason: string;
  path?: string;
  at?: string;
  record_error?: string;
}

/** Only registered runs enter GC; the recovery lock covers observation, removal and recording. */
export function gc(dryRun = false): GcAction[] {
  const out: GcAction[] = [];
  try {
    for (const id of ledgerIds()) {
      const events: GcAction[] = [];
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
          const git = (...args: string[]): string => {
            const p = Bun.spawnSync(['git', '-C', plan.repo, ...args], {
              stdout: 'pipe',
              stderr: 'pipe',
              timeout: QUERY_TIMEOUT_MS,
            });
            if (p.exitCode !== 0)
              throw new Error(
                p.stderr.toString() || `git ${args.join(' ')} exit ${String(p.exitCode)}`
              );
            return p.stdout.toString();
          };
          const trees = (): string[][] =>
            git('worktree', 'list', '--porcelain', '-z')
              .split('\0\0')
              .map(r => r.split('\0'));
          const listed = trees();
          const refs = git('for-each-ref', '--format=%(refname) %(objectname)', ref)
            .trim()
            .split('\n');
          const sha = refs.find(r => r.startsWith(`${ref} `))?.slice(ref.length + 1);
          if (
            !sha &&
            l.gc?.some(
              ({ object, action, path: p }) =>
                object === 'worktree' &&
                action === 'removed' &&
                !!p &&
                !existsSync(p) &&
                !listed.some(t => t.includes(`worktree ${p}`))
            )
          )
            return;
          const run = getRun(l.archon_run_id, plan.repo);
          if (run.id !== l.archon_run_id) throw new Error('Archon run identity mismatch');
          if (!['completed', 'failed', 'cancelled'].includes(run.status))
            throw new Error(`run ${run.status} remains recoverable`);
          const path = run.working_path,
            root = join(home().archon, 'workspaces');
          object = 'worktree';
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
          if (tree ? !tree.includes(`branch ${ref}`) : !removed || existsSync(path))
            throw new Error('worktree path/branch registration mismatch');
          if (!sha) {
            if (!tree && removed) return;
            throw new Error('registered branch missing');
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
          if (!merged && !disposable && l.rejected !== run.id)
            throw new Error(`run ${run.status} branch not merged; remains recoverable`);
          if (tree) {
            if (!dryRun) git('worktree', 'remove', path);
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
          event('skipped', e instanceof Error ? e.message : String(e));
        }
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
      };
      try {
        const l = loadLedger(id);
        if (dryRun) collect(l);
        else updateLedger(l, collect);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        events.push({ run_id: id, object: 'run', action: 'skipped', reason, record_error: reason });
      }
      out.push(...events);
    }
  } catch (e) {
    out.push({ run_id: '*', object: 'run', action: 'skipped', reason: String(e) });
  }
  return out;
}
