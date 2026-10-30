import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { integrationLockPath, publish, sync, type PublishRun } from '../src/integration';
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
const indexLock = (cwd: string): string =>
  join(sh('git rev-parse --absolute-git-dir', cwd).trim(), 'index.lock');
const withArtifacts = <T>(value: string | undefined, action: () => T): T => {
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = value ?? '';
  try {
    return action();
  } finally {
    process.env.ARTIFACTS_DIR = previous ?? '';
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
  }
};
const holdIntegrationLock = (path: string, marker: string, milliseconds: number) =>
  Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { writeFileSync } from 'node:fs'; import { executionLock } from ${JSON.stringify(join(import.meta.dir, '../../packages/workflows/src/execution-lifecycle.ts'))}; const lease = executionLock(process.env.LOCK_PATH!); if (!lease.ok) throw new Error('lock unavailable'); writeFileSync(process.env.LOCK_MARKER!, 'held'); Bun.sleepSync(Number(process.env.LOCK_MS)); lease.release();`,
    ],
    {
      env: {
        ...process.env,
        LOCK_PATH: path,
        LOCK_MARKER: marker,
        LOCK_MS: String(milliseconds),
      },
      stdout: 'ignore',
      stderr: 'pipe',
    }
  );
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

test('sync preserves a dirty worktree when merge fails before creating conflicts', () => {
  const f = fixture();
  commit(f.target, 'README.md', 'target\n');
  const before = commit(f.worktree, 'README.md', 'run\n');
  writeFileSync(join(f.worktree, 'README.md'), 'local\n');

  expect(() => sync(f.worktree, f.targetSpec)).toThrow(/exit code 2[\s\S]*would be overwritten/);
  expect(readFileSync(join(f.worktree, 'README.md'), 'utf8')).toBe('local\n');
  expect(sh('git rev-parse HEAD', f.worktree).trim()).toBe(before);
  expect(existsSync(join(f.worktree, '.git/MERGE_HEAD'))).toBe(false);
});

test('sync preserves and recovers an unheld stale worktree index lock', () => {
  const f = fixture();
  commit(f.target, 'target.txt', 'target\n');
  const lock = indexLock(f.worktree);
  writeFileSync(lock, '');
  utimesSync(lock, new Date(0), new Date(0));
  withArtifacts(f.root, () => {
    expect(sync(f.worktree, f.targetSpec).status).toBe('merged');
  });
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(f.root).filter(name => name.startsWith('stale-index-lock-'))).toHaveLength(1);
});

test('sync reports the pid holding a worktree index lock without moving it', async () => {
  const f = fixture();
  commit(f.target, 'target.txt', 'target\n');
  const lock = indexLock(f.worktree);
  const holder = Bun.spawn(['sh', '-c', 'exec 9>"$1"; sleep 30', 'holder', lock]);
  try {
    for (let i = 0; i < 40 && !existsSync(lock); i++) Bun.sleepSync(10);
    expect(() => sync(f.worktree, f.targetSpec)).toThrow(
      new RegExp(`holder pid ${String(holder.pid)}`)
    );
    expect(existsSync(lock)).toBe(true);
  } finally {
    holder.kill();
    await holder.exited;
  }
  for (const artifacts of [f.root, '']) {
    const guarded = fixture();
    commit(guarded.target, 'target.txt', 'target\n');
    const guardedLock = indexLock(guarded.worktree);
    writeFileSync(guardedLock, '');
    const mtime = artifacts ? new Date(Date.now() + 60_000) : new Date(0);
    utimesSync(guardedLock, mtime, mtime);
    withArtifacts(artifacts || undefined, () => {
      expect(() => sync(guarded.worktree, guarded.targetSpec)).toThrow('holder unknown');
      expect(existsSync(guardedLock)).toBe(true);
    });
  }
});

test('sync returns conflicts without invoking mergiraf and leaves the worktree clean', () => {
  const f = fixture();
  commit(f.target, 'README.md', 'target\n');
  const before = commit(f.worktree, 'README.md', 'run\n');
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const solver = join(bin, 'mergiraf');
  const marker = join(f.root, 'mergiraf-called');
  writeFileSync(solver, `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  let result: ReturnType<typeof sync>;
  try {
    result = sync(f.worktree, f.targetSpec);
  } finally {
    process.env.PATH = path ?? '';
    if (path === undefined) delete process.env.PATH;
  }
  expect(result.status).toBe('conflict');
  if (result.status !== 'conflict') throw new Error('expected conflict');
  expect(result.head).toBe(before);
  expect(result.files).toEqual(['README.md']);
  expect(sh('git status --porcelain', f.worktree)).toBe('');
  expect(existsSync(join(f.worktree, '.git/MERGE_HEAD'))).toBe(false);
  expect(existsSync(marker)).toBe(false);
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

test('publish outlives a released integration lock and times out structurally when it stays held', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'test', SA_INTEGRATION_LOCK_TIMEOUT_MS: '1000' });
    const released = fixture(),
      marker = join(released.root, 'held');
    commit(released.worktree, 'feature.txt', 'feature\n');
    const lockPath = integrationLockPath(
      sh('git rev-parse --path-format=absolute --git-common-dir', released.target).trim(),
      'wetamp'
    );
    const holder = holdIntegrationLock(lockPath, marker, 300);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(10);
    expect(publish(released.run(), released.expected()).status).toBe('published');
    expect(await holder.exited, await new Response(holder.stderr).text()).toBe(0);

    const timedOut = fixture(),
      held = join(timedOut.root, 'held');
    process.env.SA_INTEGRATION_LOCK_TIMEOUT_MS = '100';
    const stuck = holdIntegrationLock(
      integrationLockPath(
        sh('git rev-parse --path-format=absolute --git-common-dir', timedOut.target).trim(),
        'wetamp'
      ),
      held,
      2000
    );
    for (let i = 0; i < 100 && !existsSync(held); i++) await Bun.sleep(10);
    expect(() => publish(timedOut.run(), timedOut.expected())).toThrow(
      'timed out waiting for integration lock'
    );
    stuck.kill();
    await stuck.exited;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('publish accepts reviewed changes after sync changes the full diff', () => {
  const f = fixture();
  const base = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
  commit(f.target, 'lines.txt', base);
  sync(f.worktree, f.targetSpec);
  const reviewedBase = f.expected().target_tip;
  const reviewedHead = commit(f.worktree, 'lines.txt', base.replace('3\n', 'feature\n'));
  const reviewedHash = gitDiffHash(f.worktree, reviewedBase);
  commit(f.target, 'lines.txt', base.replace('6\n', 'target\n'));
  expect(sync(f.worktree, f.targetSpec).status).toBe('merged');
  const result = publish(
    {
      ...f.run(),
      review: { required: true, reviewed_head: reviewedHead, reviewed_diff_hash: reviewedHash },
    },
    f.expected()
  );
  expect(result).toMatchObject({ status: 'published' });
  if (result.status === 'published')
    expect(result.receipt.evidence).toContain('review=normalized_diff');
});

test('publish rejects changed additions after a reviewed candidate is resynced', () => {
  const f = fixture();
  const reviewedBase = f.expected().target_tip;
  const reviewedHead = commit(f.worktree, 'feature.txt', 'reviewed\n');
  const reviewedHash = gitDiffHash(f.worktree, reviewedBase);
  commit(f.target, 'target.txt', 'target\n');
  sync(f.worktree, f.targetSpec);
  commit(f.worktree, 'feature.txt', 'changed\n');
  expect(
    publish(
      {
        ...f.run(),
        review: { required: true, reviewed_head: reviewedHead, reviewed_diff_hash: reviewedHash },
      },
      f.expected()
    )
  ).toMatchObject({
    status: 'rejected',
    reason: 'review_stale',
    evidence: expect.stringContaining('normalized_diff'),
  });
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
});

test('publish accepts matching review evidence and rejects drift or a stale owner', () => {
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
});

test('publish rejects a target checkout switched to another branch', () => {
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
