import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { lock, QUERY_TIMEOUT_MS } from './archon';
import { diffHash } from '../templates/.archon/scripts/sa-check';
import type { PublishReceipt, PublishResult, SyncResult } from './contract';

export type { PublishReceipt, PublishResult, SyncResult } from './contract';

/** Fixed codes are safe for intervention persistence; diagnostics stay in message. */
export class LandError extends Error {
  constructor(
    code: 'codegraph_exclude_failed' | 'delivery_git_failed' | 'git_failed',
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

export interface DeliveryReceipt {
  task: string;
  source: string;
  target: DeliveryTarget;
  contract: string;
  evidence: string;
  accepted: string;
  reused?: { paths: string[]; tree: string };
  integrated: string;
  target_tip: string;
  status: 'manual_push';
  push: string;
}

export type DeliveryOutcome =
  | DeliveryReceipt
  | (Omit<DeliveryReceipt, 'accepted' | 'target_tip' | 'status'> & {
      status: 'unknown';
      reason: string;
    });

/** Capture the immutable target identity stored in a run ledger. */
export function captureDelivery(checkout: string): DeliveryTarget {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', checkout, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0)
      throw new LandError('delivery_git_failed', `delivery: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  };
  return {
    checkout: realpathSync(git('rev-parse', '--show-toplevel')),
    branch: git('symbolic-ref', '--short', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
  };
}

/** Shared Git metadata keeps the main index out of every worktree's clean checks. */
export function excludeCodegraph(repo: string): void {
  const result = Bun.spawnSync(
    ['git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0)
    throw new LandError(
      'codegraph_exclude_failed',
      'codegraph: cannot resolve common info/exclude'
    );
  const file = result.stdout.toString().trim();
  if (!existsSync(file) || !readFileSync(file, 'utf8').split('\n').includes('.codegraph/'))
    appendFileSync(file, '\n.codegraph/\n');
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

export const INTEGRATION_RECLAIM_TIMEOUT_MS = 10 * 60_000;
// Covers both reclaim waits and two bounded Git passes when reauthorization retries publish.
export const integrationNodeTimeout = (): number =>
  integrationLockTimeout() + 2 * INTEGRATION_RECLAIM_TIMEOUT_MS + 30 * QUERY_TIMEOUT_MS;

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
    public readonly code:
      | 'git_failed'
      | 'git_lock_held'
      | 'reclaim_pending'
      | 'lock_timeout'
      | 'publish_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = `integration_${code}`;
  }
}

const worktreeIndexLock = (cwd: string): string | undefined => {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return;
  const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  return match ? join(realpathSync(resolve(cwd, match[1])), 'index.lock') : undefined;
};

const gitResult = (cwd: string, args: string[]) => {
  const started = Date.now();
  const run = () =>
    Bun.spawnSync(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: QUERY_TIMEOUT_MS,
    });
  let result = run();
  const lockPath = worktreeIndexLock(cwd);
  if (
    result.exitCode === 0 ||
    !lockPath ||
    !existsSync(lockPath) ||
    !result.stderr.toString().includes(lockPath)
  )
    return result;

  const lsof = Bun.which('lsof', { PATH: process.env.PATH });
  if (!lsof)
    throw new IntegrationError(
      'git_lock_held',
      `git lock ${lockPath}; holder unknown (lsof unavailable)`
    );
  const holders = Bun.spawnSync([lsof, '-t', lockPath], { stdout: 'pipe', stderr: 'pipe' });
  const pids = holders.stdout.toString().trim().split(/\s+/).filter(Boolean);
  if (holders.exitCode === 0 && pids.length)
    throw new IntegrationError(
      'git_lock_held',
      `git lock ${lockPath}; holder pid ${pids.join(',')}`
    );
  const artifacts = process.env.ARTIFACTS_DIR;
  if (
    holders.exitCode !== 1 ||
    holders.stderr.length > 0 ||
    statSync(lockPath).mtimeMs >= started ||
    !artifacts ||
    !existsSync(artifacts)
  )
    throw new IntegrationError('git_lock_held', `git lock ${lockPath}; holder unknown`);

  renameSync(
    lockPath,
    join(realpathSync(artifacts), `stale-index-lock-${String(started)}-${String(process.pid)}`)
  );
  result = run();
  return result;
};

const gitFailure = (args: string[], result: ReturnType<typeof gitResult>): IntegrationError => {
  const excerpt = (output: Uint8Array): string => {
    const text = Buffer.from(output).toString().trim();
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text || '(empty)';
  };
  return new IntegrationError(
    'git_failed',
    `git ${args.join(' ')} failed with exit code ${String(result.exitCode)}\nstderr:\n${excerpt(result.stderr)}\nstdout:\n${excerpt(result.stdout)}`
  );
};

const git = (cwd: string, ...args: string[]): string => {
  const result = gitResult(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(args, result);
  return result.stdout.toString().trimEnd();
};

const gitBytes = (cwd: string, ...args: string[]): Buffer => {
  const result = gitResult(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(args, result);
  return result.stdout;
};

const diffBytes = (cwd: string, base: string, head: string): Buffer =>
  gitBytes(
    cwd,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--find-renames',
    base,
    head,
    '--'
  );

const normalizedChange = (diff: Buffer): string => {
  const kept: string[] = [];
  let hunk = false,
    binary = false;
  for (const line of diff.toString().split('\n')) {
    if (line.startsWith('diff --git ')) {
      hunk = false;
      binary = false;
      kept.push(line);
    } else if (line.startsWith('@@')) hunk = true;
    else if (line === 'GIT binary patch') {
      binary = true;
      kept.push(line);
    } else if (
      binary ||
      (hunk && /^[+-]/.test(line)) ||
      line === '\\ No newline at end of file' ||
      /^(?:old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to|Binary files )/.test(
        line
      )
    )
      kept.push(line);
  }
  return kept.join('\n');
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
  if (gitResult(worktree, ['merge-base', '--is-ancestor', targetTip, before]).exitCode === 0)
    return {
      status: 'noop',
      target_tip: targetTip,
      merge_base: git(worktree, 'merge-base', before, targetTip),
      head: before,
    };

  const mergeArgs = ['merge', '--no-edit', targetTip];
  const merged = gitResult(worktree, mergeArgs);
  if (merged.exitCode !== 0) {
    const mergeHead = gitResult(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
    if (mergeHead.exitCode !== 0) throw gitFailure(mergeArgs, merged);
    const files = conflicts(worktree);
    if (!files.length) throw gitFailure(mergeArgs, merged);
    git(worktree, 'merge', '--abort');
    return { status: 'conflict', target_tip: targetTip, files };
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
    const currentDiff = diffBytes(run.worktree, targetTip, 'HEAD');
    const currentDiffHash = diffHash(currentDiff);
    let reviewPath = 'not_required';
    if (run.review.required) {
      reviewPath = 'diff_hash';
      if (run.review.reviewed_diff_hash !== currentDiffHash) {
        reviewPath = 'normalized_diff';
        const reviewedBase = git(run.worktree, 'merge-base', run.review.reviewed_head, targetTip);
        const reviewedDiff = diffBytes(run.worktree, reviewedBase, run.review.reviewed_head);
        if (
          diffHash(reviewedDiff) !== run.review.reviewed_diff_hash ||
          normalizedChange(reviewedDiff) !== normalizedChange(currentDiff)
        )
          return {
            status: 'rejected',
            reason: 'review_stale',
            evidence: 'review=normalized_diff; reviewed and current changes differ',
          };
      }
    }

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
      evidence: `review=${reviewPath}; artifacts=${run.evidence}`,
      integrated: head,
      status: 'published',
    };
    writeReceipt(run.receipt, receipt);
    return { status: 'published', receipt };
  } finally {
    lease.release();
  }
}
