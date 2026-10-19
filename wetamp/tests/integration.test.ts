import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publish, sync, type PublishRun } from '../src/integration';
import { diffHash } from '../templates/.archon/scripts/sa-check';
import { gitRepo, sh, tmp } from './helpers';

const fixture = () => {
  const root = tmp();
  const target = gitRepo(root);
  sh('git config user.name t && git config user.email t@l && git branch -m wetamp', target);
  const worktree = join(root, 'run');
  sh(`git worktree add -qb sa/run '${worktree}'`, target);
  const targetSpec = { checkout: target, branch: 'wetamp' };
  const expected = () => ({ target_tip: sh('git rev-parse wetamp', target).trim() });
  const run = (path = worktree): PublishRun => ({
    worktree: path,
    target: targetSpec,
    task: 'r1',
    contract: 'contract',
    evidence: root,
    receipt: join(root, `${path === worktree ? 'run' : 'run-2'}-publish.json`),
    review: { required: false },
    fence: () => undefined,
  });
  return { root, target, worktree, targetSpec, expected, run };
};

const commit = (cwd: string, file: string, value: string): string => {
  writeFileSync(join(cwd, file), value);
  sh(`git add '${file}' && git commit -qm '${file}'`, cwd);
  return sh('git rev-parse HEAD', cwd).trim();
};

const gitDiffHash = (cwd: string, base: string): string => {
  const result = Bun.spawnSync(
    ['git', '-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base, 'HEAD', '--'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return diffHash(result.stdout);
};

test('sync reports noop when the target tip is already present', () => {
  const f = fixture();
  const result = sync(f.worktree, f.targetSpec);
  expect(result).toEqual({
    status: 'noop',
    target_tip: f.expected().target_tip,
    merge_base: f.expected().target_tip,
    head: f.expected().target_tip,
  });
});

test('sync merges the current local target tip into the run worktree', () => {
  const f = fixture();
  const targetTip = commit(f.target, 'target.txt', 'target\n');
  const result = sync(f.worktree, f.targetSpec);
  expect(result.status).toBe('merged');
  if (result.status !== 'merged') throw new Error('expected merged');
  expect(result.target_tip).toBe(targetTip);
  expect(result.merge_base).toBe(targetTip);
  expect(readFileSync(join(f.worktree, 'target.txt'), 'utf8')).toBe('target\n');
});

test('sync aborts an unresolved conflict and leaves the worktree clean', () => {
  const f = fixture();
  commit(f.target, 'README.md', 'target\n');
  commit(f.worktree, 'README.md', 'run\n');
  const unavailable = spyOn(Bun, 'which').mockReturnValue(null);
  const result = sync(f.worktree, f.targetSpec);
  unavailable.mockRestore();
  expect(result.status).toBe('conflict');
  if (result.status !== 'conflict') throw new Error('expected conflict');
  expect(result.files).toEqual(['README.md']);
  expect(sh('git status --porcelain', f.worktree)).toBe('');
  expect(existsSync(join(f.worktree, '.git/MERGE_HEAD'))).toBe(false);

  const solved = fixture();
  commit(solved.target, 'README.md', 'target\n');
  commit(solved.worktree, 'README.md', 'run\n');
  const bin = join(solved.root, 'bin');
  mkdirSync(bin);
  const solver = join(bin, 'mergiraf');
  writeFileSync(solver, '#!/bin/sh\nprintf "resolved\\n" > "$2"\n', { mode: 0o755 });
  const available = spyOn(Bun, 'which').mockReturnValue(solver);
  try {
    expect(sync(solved.worktree, solved.targetSpec).status).toBe('merged');
  } finally {
    available.mockRestore();
  }
  expect(readFileSync(join(solved.worktree, 'README.md'), 'utf8')).toBe('resolved\n');
});

test('publish advances the target with CAS and writes its receipt', () => {
  const f = fixture();
  const head = commit(f.worktree, 'feature.txt', 'feature\n');
  const receipt = join(f.root, 'publish.json');
  const result = publish({ ...f.run(), receipt }, f.expected());
  expect(result.status).toBe('published');
  if (result.status !== 'published') throw new Error('expected published');
  expect(result.receipt.integrated).toBe(head);
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual(result.receipt);
  expect(sh('git rev-parse wetamp', f.target).trim()).toBe(head);
  expect(sh('git status --porcelain', f.target)).toBe('');
});

test('publish reports an advanced target without changing it', () => {
  const f = fixture();
  const expected = f.expected();
  commit(f.worktree, 'feature.txt', 'feature\n');
  const advanced = commit(f.target, 'target.txt', 'target\n');
  expect(publish(f.run(), expected)).toEqual({ status: 'advanced', target_tip: advanced });
  expect(sh('git rev-parse wetamp', f.target).trim()).toBe(advanced);
});

test('publish reports a dirty target without changing history', () => {
  const f = fixture();
  commit(f.worktree, 'feature.txt', 'feature\n');
  writeFileSync(join(f.target, 'dirty.txt'), 'dirty\n');
  const before = f.expected().target_tip;
  expect(publish(f.run(), f.expected())).toEqual({
    status: 'dirty',
    paths: ['untracked: "dirty.txt"'],
  });
  expect(sh('git rev-parse wetamp', f.target).trim()).toBe(before);

  const raced = fixture();
  commit(raced.worktree, 'feature.txt', 'feature\n');
  const racedBefore = raced.expected().target_tip;
  expect(() =>
    publish(
      {
        ...raced.run(),
        fence: () => writeFileSync(join(raced.target, 'feature.txt'), 'operator\n'),
      },
      raced.expected()
    )
  ).toThrow();
  expect(readFileSync(join(raced.target, 'feature.txt'), 'utf8')).toBe('operator\n');
  expect(sh('git rev-parse wetamp', raced.target).trim()).toBe(racedBefore);
  expect(existsSync(raced.run().receipt)).toBe(false);
});

test('two runs racing the same expected tip publish only the first', () => {
  const f = fixture();
  const second = join(f.root, 'run-2');
  sh(`git worktree add -qb sa/run-2 '${second}' wetamp`, f.target);
  const expected = f.expected();
  const firstHead = commit(f.worktree, 'first.txt', 'first\n');
  const secondHead = commit(second, 'second.txt', 'second\n');
  expect(publish(f.run(), expected).status).toBe('published');
  expect(publish(f.run(second), expected)).toEqual({ status: 'advanced', target_tip: firstHead });
  expect(sh('git rev-parse wetamp', f.target).trim()).toBe(firstHead);
  expect(
    Bun.spawnSync(['git', '-C', f.target, 'merge-base', '--is-ancestor', secondHead, 'wetamp'])
      .exitCode
  ).toBe(1);
});

test('publish rejects protected targets and non-descendant history', () => {
  const protectedFixture = fixture();
  sh('git branch -m main', protectedFixture.target);
  expect(
    publish(
      {
        worktree: protectedFixture.worktree,
        target: { checkout: protectedFixture.target, branch: 'main' },
        task: 'r1',
        contract: 'contract',
        evidence: protectedFixture.root,
        receipt: join(protectedFixture.root, 'publish.json'),
        review: { required: false },
        fence: () => undefined,
      },
      { target_tip: sh('git rev-parse main', protectedFixture.target).trim() }
    )
  ).toMatchObject({ status: 'rejected', reason: 'protected_target' });

  const f = fixture();
  commit(f.worktree, 'feature.txt', 'feature\n');
  const targetTip = commit(f.target, 'target.txt', 'target\n');
  expect(publish(f.run(), { target_tip: targetTip })).toMatchObject({
    status: 'rejected',
    reason: 'not_descendant',
  });
  expect(sh('git rev-parse wetamp', f.target).trim()).toBe(targetTip);

  const review = fixture();
  const reviewHead = commit(review.worktree, 'feature.txt', 'feature\n');
  const reviewBefore = review.expected().target_tip;
  expect(
    publish(
      {
        ...review.run(),
        review: {
          required: true,
          reviewed_head: reviewHead,
          reviewed_diff_hash: gitDiffHash(review.worktree, reviewBefore),
        },
      },
      review.expected()
    )
  ).toMatchObject({ status: 'published' });

  const drifted = fixture();
  const driftedHead = commit(drifted.worktree, 'feature.txt', 'feature\n');
  const driftedBefore = drifted.expected().target_tip;
  expect(
    publish(
      {
        ...drifted.run(),
        review: {
          required: true,
          reviewed_head: driftedHead,
          reviewed_diff_hash: 'reviewed',
        },
      },
      drifted.expected()
    )
  ).toMatchObject({ status: 'rejected', reason: 'review_stale' });
  expect(sh('git rev-parse wetamp', drifted.target).trim()).toBe(driftedBefore);
  expect(existsSync(drifted.run().receipt)).toBe(false);

  const fenced = fixture();
  commit(fenced.worktree, 'feature.txt', 'feature\n');
  const fencedBefore = fenced.expected().target_tip;
  expect(() =>
    publish(
      {
        ...fenced.run(),
        fence: () => {
          throw new Error('owner generation changed');
        },
      },
      fenced.expected()
    )
  ).toThrow('owner generation changed');
  expect(sh('git rev-parse wetamp', fenced.target).trim()).toBe(fencedBefore);
  expect(existsSync(fenced.run().receipt)).toBe(false);

  const switched = fixture();
  commit(switched.worktree, 'feature.txt', 'feature\n');
  const switchedBefore = switched.expected().target_tip;
  sh('git switch -qc operator', switched.target);
  expect(publish(switched.run(), { target_tip: switchedBefore })).toMatchObject({
    status: 'rejected',
    reason: 'target_checkout_changed',
  });
  expect(sh('git rev-parse wetamp', switched.target).trim()).toBe(switchedBefore);
  expect(existsSync(switched.run().receipt)).toBe(false);
});
