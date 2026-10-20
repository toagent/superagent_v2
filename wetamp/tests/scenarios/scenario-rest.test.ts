import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryReviewCheckpoint, type Ledger } from '../../src/cli';
import { publish, sync, type PublishRun } from '../../src/integration';
import { diffHash } from '../../templates/.archon/scripts/sa-check';
import { sh } from '../helpers';
import {
  restore,
  runInProcess,
  scenario,
  type ScenarioFixture,
  type ScenarioId,
} from './framework';

const fixture = (id: ScenarioId, risk: 'G1' | 'G2' = 'G1', passRound: 1 | 2 = 1) =>
  scenario({
    id,
    risk,
    passRound,
    plan: { goal: id, accept: `test "$(cat scenario.txt)" = ${id}` },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  });
const commit = (cwd: string, file: string, content: string): string => {
  writeFileSync(join(cwd, file), content);
  sh(
    `git add '${file}' && git -c user.name=scenario -c user.email=scenario@local commit -qm '${file}'`,
    cwd
  );
  return sh('git rev-parse HEAD', cwd).trim();
};
const tip = (f: ScenarioFixture): string => sh('git rev-parse scenario-target', f.target).trim();
const head = (cwd: string): string => sh('git rev-parse HEAD', cwd).trim();
const receipt = (f: ScenarioFixture, name: string): string => join(f.root, `${name}.json`);
const run = (
  f: ScenarioFixture,
  name: string,
  worktree = f.worker,
  patch: Partial<PublishRun> = {}
): PublishRun => ({
  worktree,
  target: { checkout: f.target, branch: 'scenario-target' },
  task: f.spec.id,
  contract: 'contract',
  evidence: f.root,
  receipt: receipt(f, name),
  review: { required: false },
  fence: () => undefined,
  ...patch,
});
const flow = (f: ScenarioFixture) => {
  const counts: Record<string, number> = {};
  const nodeFailed: string[] = [];
  let terminal: 'running' | 'completed' | 'failed' = 'running';
  const call = <T>(node: string, action: () => T, expectedFailure = false): T => {
    counts[node] = (counts[node] ?? 0) + 1;
    try {
      return action();
    } catch (error) {
      if (!expectedFailure) nodeFailed.push(node);
      throw error;
    }
  };
  return {
    mark: (node: string) => call(node, () => undefined),
    sync: (worktree = f.worker) => call('sync', () => sync(worktree, run(f, 'unused').target)),
    publish: (
      name: string,
      expected: string,
      worktree = f.worker,
      patch: Partial<PublishRun> = {},
      expectedFailure = false
    ) =>
      call(
        'publish',
        () => {
          const result = publish(run(f, name, worktree, patch), { target_tip: expected });
          if (result.status === 'published') terminal = 'completed';
          return result;
        },
        expectedFailure
      ),
    fail: () => (terminal = 'failed'),
    expect: (expectedTerminal: 'completed' | 'failed', expected: Record<string, number>) => {
      expect(terminal).toBe(expectedTerminal);
      expect(nodeFailed).toEqual([]);
      expect(counts).toEqual(expected);
    },
  };
};
const hash = (f: ScenarioFixture, base: string): string => {
  // prettier-ignore
  const out = Bun.spawnSync(['git', '-C', f.worker, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base, 'HEAD', '--'], { stdout: 'pipe', stderr: 'pipe' });
  expect(out.exitCode, out.stderr.toString()).toBe(0);
  return diffHash(out.stdout);
};
test('S3: G2 passes r2 and publishes once without node failure', async () => {
  const f = fixture('S3', 'G2', 2);
  try {
    const { events, terminal } = await runInProcess(f);
    expect(terminal).toEqual({ completed: ['scenario-s3'], failed: [] });
    expect(events.filter(e => e.event_type === 'node_failed')).toEqual([]);
    for (const node of ['code', 'accept-r1', 'accept-r2', 'publish'])
      expect(
        events.filter(e => e.event_type === 'node_completed' && e.step_name === node)
      ).toHaveLength(1);
    expect(tip(f)).toBe(head(f.worker));
    expect(
      events.some(e => e.step_name === 'publish' && JSON.stringify(e.data).includes('published'))
    ).toBeTrue();
  } finally {
    restore(f);
  }
});
test('S4: concurrent runs resync after advanced and both publish in order', () => {
  const f = fixture('S4');
  try {
    const trace = flow(f);
    const second = join(f.root, 'worker-2');
    sh(`git worktree add -qb scenario-s4-2 '${second}' scenario-target`, f.target);
    const expected = { target_tip: f.initial };
    const first = commit(f.worker, 'first.txt', 'first\n');
    commit(second, 'second.txt', 'second\n');
    expect(trace.publish('first', expected.target_tip).status).toBe('published');
    expect(trace.publish('second-stale', expected.target_tip, second)).toEqual({
      status: 'advanced',
      target_tip: first,
    });
    expect(trace.sync(second).status).toBe('merged');
    const secondHead = head(second);
    expect(trace.publish('second', first, second).status).toBe('published');
    expect(tip(f)).toBe(secondHead);
    expect(existsSync(receipt(f, 'first')) && existsSync(receipt(f, 'second'))).toBeTrue();
    trace.expect('completed', { publish: 3, sync: 1 });
  } finally {
    restore(f);
  }
});
test('S5/S6: conflict can be resolved, while a post-merge regression fails closed', () => {
  const conflict = fixture('S5');
  try {
    const trace = flow(conflict);
    const targetTip = commit(conflict.target, 'README.md', 'target\n');
    commit(conflict.worker, 'README.md', 'worker\n');
    expect(trace.sync()).toMatchObject({ status: 'conflict' });
    expect(
      Bun.spawnSync(['git', '-C', conflict.worker, 'merge', '--no-edit', targetTip]).exitCode
    ).not.toBe(0);
    commit(conflict.worker, 'README.md', 'resolved\n');
    expect(trace.publish('resolved', targetTip).status).toBe('published');
    expect(tip(conflict)).toBe(head(conflict.worker));
    expect(readFileSync(receipt(conflict, 'resolved'), 'utf8')).toContain('published');
    trace.expect('completed', { sync: 1, publish: 1 });
  } finally {
    restore(conflict);
  }

  const regression = fixture('S6');
  try {
    const trace = flow(regression);
    commit(regression.worker, 'feature.txt', 'feature\n');
    const targetTip = commit(regression.target, 'regression.txt', 'break\n');
    expect(trace.sync().status).toBe('merged');
    expect(existsSync(join(regression.worker, 'regression.txt'))).toBeTrue();
    expect(tip(regression)).toBe(targetTip);
    expect(existsSync(receipt(regression, 'blocked'))).toBeFalse();
    trace.fail();
    trace.expect('failed', { sync: 1 });
  } finally {
    restore(regression);
  }
});
test('S7: dirty target retries only publish after cleanup', () => {
  const f = fixture('S7');
  try {
    const trace = flow(f);
    const feature = commit(f.worker, 'feature.txt', 'feature\n');
    writeFileSync(join(f.target, 'dirty.txt'), 'dirty\n');
    expect(trace.publish('dirty', f.initial)).toEqual({
      status: 'dirty',
      paths: ['untracked: "dirty.txt"'],
    });
    rmSync(join(f.target, 'dirty.txt'));
    expect(trace.publish('retry', f.initial).status).toBe('published');
    expect(tip(f)).toBe(feature);
    expect(existsSync(receipt(f, 'dirty'))).toBeFalse();
    expect(existsSync(receipt(f, 'retry'))).toBeTrue();
    trace.expect('completed', { publish: 2 });
  } finally {
    restore(f);
  }
});
test('S8: tampered gate artifact with unchanged review fields fails closed', () => {
  const f = fixture('S8', 'G2');
  try {
    const trace = flow(f);
    const art = join(f.home, 'artifacts');
    mkdirSync(art, { recursive: true });
    const ledgerFile = join(art, 'gate-m1-r1.ledger.json');
    writeFileSync(ledgerFile, '{}');
    const gate = {
      decision: { kind: 'advance', reason: null, evidence: [], debt: [] },
      head_trusted: true,
      reviewed_head: f.initial,
      reviewed_diff_hash: 'd'.repeat(16),
      ledger_file: ledgerFile,
    };
    const diff = { head: f.initial, diff_hash: 'd'.repeat(16), contract_hash: 'c'.repeat(64) };
    const gateRaw = JSON.stringify(gate),
      diffRaw = JSON.stringify(diff);
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    writeFileSync(join(art, 'gate-m1-r1.json'), JSON.stringify({ ...gate, note: 'tampered' }));
    writeFileSync(join(art, 'diff-m1-r1.json'), diffRaw);
    // prettier-ignore
    const ledger: Ledger = { run_id: 'S8', archon_run_id: 'S8', plan: join(f.home, 'plan.json'), gen_dir: f.home, repo: f.target, branch: 'scenario-s8', workflow: 'scenario-s8', console: 'codex', started_at: '', transcript: '', log: '' };
    // prettier-ignore
    expect(recoveryReviewCheckpoint(ledger, art, 'gate-m1-r1.json', f.initial, { 'gate-m1-r1': sha(gateRaw), 'diff-m1-r1': sha(diffRaw) })).toEqual({ milestone: 'm1', reason: 'gate_hash_mismatch' });
    expect(tip(f)).toBe(f.initial);
    expect(existsSync(receipt(f, 'blocked'))).toBeFalse();
    trace.fail();
    trace.expect('failed', {});
  } finally {
    restore(f);
  }
});
test('S9: interrupted delivery recovers by replaying the fenced publish', () => {
  const f = fixture('S9');
  try {
    const trace = flow(f);
    const feature = commit(f.worker, 'feature.txt', 'feature\n');
    expect(tip(f)).toBe(f.initial);
    expect(existsSync(receipt(f, 'recover'))).toBeFalse();
    trace.mark('recover');
    expect(trace.publish('recover', f.initial).status).toBe('published');
    expect(tip(f)).toBe(feature);
    expect(JSON.parse(readFileSync(receipt(f, 'recover'), 'utf8')).integrated).toBe(feature);
    trace.expect('completed', { recover: 1, publish: 1 });
  } finally {
    restore(f);
  }
});

test('S10: milestone two is based on the newly published milestone one tip', () => {
  const f = fixture('S10');
  try {
    const trace = flow(f);
    const m1 = commit(f.worker, 'm1.txt', 'm1\n');
    expect(trace.publish('m1', f.initial).status).toBe('published');
    const m2 = commit(f.worker, 'm2.txt', 'm2\n');
    expect(trace.sync()).toMatchObject({ status: 'noop', target_tip: m1 });
    expect(
      Bun.spawnSync(['git', '-C', f.worker, 'merge-base', '--is-ancestor', m1, m2]).exitCode
    ).toBe(0);
    expect(trace.publish('m2', m1).status).toBe('published');
    expect(tip(f)).toBe(m2);
    expect(existsSync(receipt(f, 'm1')) && existsSync(receipt(f, 'm2'))).toBeTrue();
    trace.expect('completed', { publish: 2, sync: 1 });
  } finally {
    restore(f);
  }
});

test('S13: takeover after authorization is rejected by the publish fence', () => {
  const f = fixture('S13');
  try {
    const trace = flow(f);
    commit(f.worker, 'feature.txt', 'feature\n');
    let generation = 1;
    const authorized = generation;
    generation = 2;
    // prettier-ignore
    expect(() => trace.publish('fenced', f.initial, f.worker, {
      review: { required: true, reviewed_head: head(f.worker), reviewed_diff_hash: hash(f, f.initial) },
      fence: () => { if (generation !== authorized) throw new Error('owner generation changed'); },
    }, true)).toThrow('owner generation changed');
    expect(tip(f)).toBe(f.initial);
    expect(existsSync(receipt(f, 'fenced'))).toBeFalse();
    trace.fail();
    trace.expect('failed', { publish: 1 });
  } finally {
    restore(f);
  }
});
