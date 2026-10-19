import { createHash } from 'node:crypto';
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock, QUERY_TIMEOUT_MS } from './archon';
import {
  checkoutChanges,
  integrationLockTimeout,
  protectedTarget,
  type DeliveryTarget,
} from './land-legacy';

export type SyncResult =
  | {
      status: 'noop' | 'merged';
      target_tip: string;
      merge_base: string;
      head: string;
    }
  | { status: 'conflict'; target_tip: string; files: string[] };

export interface PublishRun {
  worktree: string;
  target: Pick<DeliveryTarget, 'checkout' | 'branch'>;
  task: string;
  contract: string;
  evidence: string;
  receipt: string;
  review:
    | { required: false }
    | { required: true; reviewed_head: string; reviewed_diff_hash: string; diff_hash: string };
  /** Revalidates owner/generation immediately before the ref mutation and receipt write. */
  fence: () => void;
}

export interface PublishExpected {
  target_tip: string;
}

export interface PublishReceipt {
  task: string;
  source: string;
  target: Pick<DeliveryTarget, 'checkout' | 'branch'>;
  target_tip: string;
  contract: string;
  evidence: string;
  integrated: string;
  status: 'published';
}

export type PublishResult =
  | { status: 'published'; receipt: PublishReceipt }
  | { status: 'advanced'; target_tip: string }
  | { status: 'dirty'; paths: string[] }
  | {
      status: 'rejected';
      reason: 'protected_target' | 'not_descendant' | 'review_drift' | 'target_checkout_changed';
      evidence: string;
    };

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

const targetCheckout = (repo: string, branch: string): string | undefined =>
  git(repo, 'worktree', 'list', '--porcelain', '-z')
    .split('\0\0')
    .find(record => record.split('\0').includes(`branch refs/heads/${branch}`))
    ?.split('\0')
    .find(line => line.startsWith('worktree '))
    ?.slice(9);

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
  const lockfile = join(
    common,
    `sa-land-${createHash('sha256').update(run.target.branch).digest('hex')}.lock`
  );
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
    const checkout = targetCheckout(repo, run.target.branch);
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
    if (
      run.review.required &&
      (run.review.reviewed_head !== head || run.review.reviewed_diff_hash !== run.review.diff_hash)
    )
      return {
        status: 'rejected',
        reason: 'review_drift',
        evidence: 'current head or diff hash does not match the reviewed gate evidence',
      };

    run.fence();
    if (head !== targetTip) {
      const updated = Bun.spawnSync(['git', '-C', repo, 'update-ref', ref, head, targetTip], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: QUERY_TIMEOUT_MS,
      });
      if (updated.exitCode !== 0) {
        const current = git(repo, 'rev-parse', ref);
        if (current !== targetTip) return { status: 'advanced', target_tip: current };
        throw new IntegrationError('git_failed', updated.stderr.toString().trim());
      }
      const aligned = Bun.spawnSync(['git', '-C', checkout, 'reset', '--hard', head], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: QUERY_TIMEOUT_MS,
      });
      if (aligned.exitCode !== 0)
        throw new IntegrationError(
          'publish_outcome_unknown',
          `target ref advanced but checkout alignment failed: ${aligned.stderr.toString().trim()}`
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
