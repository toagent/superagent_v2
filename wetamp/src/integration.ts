import { createHash } from 'node:crypto';
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock, QUERY_TIMEOUT_MS } from './archon';
import { diffHash } from '../templates/.archon/scripts/sa-check';
import type { PublishReceipt, PublishResult, SyncResult } from './contract';

export type { PublishReceipt, PublishResult, SyncResult } from './contract';

/** Fixed codes are safe for intervention persistence; diagnostics stay in message. */
export class LandError extends Error {
  constructor(
    code:
      | 'codegraph_exclude_failed'
      | 'delivery_git_failed'
      | 'not_ready'
      | 'repository_missing'
      | 'target_missing'
      | 'target_protected'
      | 'git_failed'
      | 'integration_lock_timeout'
      | 'delivery_target_changed'
      | 'target_dirty'
      | 'source_head_drifted'
      | 'source_tree_changed'
      | 'target_history_changed'
      | 'target_history_check_failed'
      | 'integration_ancestry_failed'
      | 'candidate_ancestry_failed'
      | 'merge_conflicts'
      | 'submodule_init_failed'
      | 'environment_failed'
      | 'acceptance_failed'
      | 'candidate_changed'
      | 'target_checkout_changed'
      | 'target_advanced'
      | 'integration_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = `land_${code}`;
  }
}

export interface DeliveryTarget {
  checkout: string;
  branch: string;
  head: string;
}

export const protectedTarget = (branch: string): boolean =>
  /^(main|master|dev|develop|release-.*)$/.test(branch);

// prettier-ignore
export function checkoutChanges(checkout: string): string[] {
  const p = Bun.spawnSync(['git', '-C', checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
  if (p.exitCode !== 0) throw new LandError('git_failed', `land: ${p.stderr.toString().trim()}`);
  const records = p.stdout.toString().split('\0'), paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i]; if (!row) continue;
    paths.push(`${row.startsWith('??') ? 'untracked' : 'tracked'}: ${JSON.stringify(row.slice(3))}`);
    if (/[RC]/.test(row.slice(0, 2))) i++;
  }
  return paths;
}

export const integrationLockTimeout = (): number =>
  (process.env.NODE_ENV === 'test' && Number(process.env.SA_INTEGRATION_LOCK_TIMEOUT_MS)) ||
  20 * 60_000;

export const integrationLockPath = (commonDir: string, branch: string): string =>
  join(commonDir, `sa-land-${createHash('sha256').update(branch).digest('hex')}.lock`);

export const targetCheckout = (worktrees: string, branch: string): string | undefined =>
  worktrees
    .split('\0\0')
    .find(record => record.split('\0').includes(`branch refs/heads/${branch}`))
    ?.split('\0')
    .find(line => line.startsWith('worktree '))
    ?.slice(9);

export interface PublishRun {
  worktree: string;
  target: Pick<DeliveryTarget, 'checkout' | 'branch'>;
  task: string;
  contract: string;
  evidence: string;
  receipt: string;
  review:
    | { required: false }
    | { required: true; reviewed_head: string; reviewed_diff_hash: string };
  /** Revalidates owner/generation immediately before the ref mutation and receipt write. */
  fence: () => void;
}

export interface PublishExpected {
  target_tip: string;
}

export class IntegrationError extends Error {
  constructor(
    public readonly code: 'git_failed' | 'lock_timeout' | 'publish_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = `integration_${code}`;
  }
}

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new IntegrationError('git_failed', result.stderr.toString().trim() || args.join(' '));
  return result.stdout.toString().trimEnd();
};

const gitBytes = (cwd: string, ...args: string[]): Buffer => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0)
    throw new IntegrationError('git_failed', result.stderr.toString().trim() || args.join(' '));
  return result.stdout;
};

const conflicts = (worktree: string): string[] =>
  git(worktree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);

export function sync(
  worktree: string,
  target: Pick<DeliveryTarget, 'checkout' | 'branch'>
): SyncResult {
  git(worktree, 'fetch', '--quiet', '--no-tags', target.checkout, `refs/heads/${target.branch}`);
  const targetTip = git(worktree, 'rev-parse', 'FETCH_HEAD');
  const before = git(worktree, 'rev-parse', 'HEAD');
  if (
    Bun.spawnSync(['git', '-C', worktree, 'merge-base', '--is-ancestor', targetTip, before], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: QUERY_TIMEOUT_MS,
    }).exitCode === 0
  )
    return {
      status: 'noop',
      target_tip: targetTip,
      merge_base: git(worktree, 'merge-base', before, targetTip),
      head: before,
    };

  const merged = Bun.spawnSync(['git', '-C', worktree, 'merge', '--no-edit', targetTip], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  if (merged.exitCode !== 0) {
    let files = conflicts(worktree);
    const solver = Bun.which('mergiraf', { PATH: process.env.PATH });
    if (solver)
      for (const file of files) {
        const solved = Bun.spawnSync([solver, 'solve', file], {
          cwd: worktree,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: QUERY_TIMEOUT_MS,
        });
        rmSync(join(worktree, `${file}.orig`), { force: true });
        if (solved.exitCode === 0) git(worktree, 'add', '--', file);
      }
    files = conflicts(worktree);
    if (files.length) {
      git(worktree, 'merge', '--abort');
      return { status: 'conflict', target_tip: targetTip, files };
    }
    git(worktree, 'commit', '--no-edit');
  }
  const head = git(worktree, 'rev-parse', 'HEAD');
  return {
    status: 'merged',
    target_tip: targetTip,
    merge_base: git(worktree, 'merge-base', head, targetTip),
    head,
  };
}

const writeReceipt = (file: string, receipt: PublishReceipt): void => {
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, JSON.stringify(receipt, null, 2));
  renameSync(temp, file);
};

export function publish(run: PublishRun, expected: PublishExpected): PublishResult {
  const repo = realpathSync(run.target.checkout);
  if (protectedTarget(run.target.branch))
    return {
      status: 'rejected',
      reason: 'protected_target',
      evidence: `target branch ${run.target.branch} is protected`,
    };
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const lockfile = integrationLockPath(common, run.target.branch);
  let lease = lock(lockfile);
  const deadline = Date.now() + integrationLockTimeout();
  while (!lease.ok && Date.now() < deadline) {
    Bun.sleepSync(50);
    lease = lock(lockfile);
  }
  if (!lease.ok)
    throw new IntegrationError('lock_timeout', 'timed out waiting for integration lock');
  try {
    const ref = `refs/heads/${run.target.branch}`;
    const targetTip = git(repo, 'rev-parse', ref);
    if (targetTip !== expected.target_tip) return { status: 'advanced', target_tip: targetTip };
    const checkout = targetCheckout(
      git(repo, 'worktree', 'list', '--porcelain', '-z'),
      run.target.branch
    );
    if (
      !checkout ||
      realpathSync(checkout) !== repo ||
      git(repo, 'symbolic-ref', '--short', 'HEAD') !== run.target.branch
    )
      return {
        status: 'rejected',
        reason: 'target_checkout_changed',
        evidence: checkout
          ? `target branch is checked out at ${checkout}`
          : `target checkout is no longer on ${run.target.branch}`,
      };
    const paths = checkoutChanges(checkout);
    if (paths.length) return { status: 'dirty', paths };
    const head = git(run.worktree, 'rev-parse', 'HEAD');
    const ancestor = Bun.spawnSync(
      ['git', '-C', repo, 'merge-base', '--is-ancestor', targetTip, head],
      { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
    );
    if (ancestor.exitCode !== 0)
      return {
        status: 'rejected',
        reason: 'not_descendant',
        evidence:
          ancestor.exitCode === 1
            ? `${head} is not a descendant of ${targetTip}`
            : ancestor.stderr.toString().trim(),
      };
    const currentDiffHash = diffHash(
      gitBytes(
        run.worktree,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        targetTip,
        'HEAD',
        '--'
      )
    );
    if (run.review.required && run.review.reviewed_diff_hash !== currentDiffHash)
      return {
        status: 'rejected',
        reason: 'review_stale',
        evidence: 'current diff hash does not match the reviewed gate evidence',
      };

    run.fence();
    if (head !== targetTip) {
      const merged = Bun.spawnSync(['git', '-C', checkout, 'merge', '--ff-only', head], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: QUERY_TIMEOUT_MS,
      });
      if (merged.exitCode !== 0) {
        const current = git(repo, 'rev-parse', ref);
        if (current !== targetTip) return { status: 'advanced', target_tip: current };
        throw new IntegrationError('git_failed', merged.stderr.toString().trim());
      }
      if (git(repo, 'rev-parse', ref) !== head)
        throw new IntegrationError(
          'publish_outcome_unknown',
          'target ref does not match the published head'
        );
    }
    const receipt: PublishReceipt = {
      task: run.task,
      source: head,
      target: run.target,
      target_tip: targetTip,
      contract: run.contract,
      evidence: run.evidence,
      integrated: head,
      status: 'published',
    };
    writeReceipt(run.receipt, receipt);
    run.fence();
    return { status: 'published', receipt };
  } finally {
    lease.release();
  }
}
