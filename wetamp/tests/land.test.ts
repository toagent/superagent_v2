import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliveryProjection,
  gateHashes,
  IntegrationError,
  landEvidence,
  reclaimAdmission,
  retryAdvancedFence,
  runDeliveryEntry,
  waitForReclaim,
  type DeliveryReceipt,
} from '../src/land';
import { classifyRun, decisionQuestion, holdOf, type Ledger } from '../src/cli';
import { inputEnvVars, type ShellInputContext } from '../../packages/workflows/src/dag-executor';
import { fixtureEnv, tmp } from './helpers';

test('1.0.0 gate hash bindings remain readable by publish', () => {
  const ctx: ShellInputContext = {
    workflowRun: { id: 'legacy', user_message: '', metadata: {} },
    artifactsDir: '/art',
    stateDir: '/state',
    baseBranch: 'dev',
    docsDir: '/docs',
    nodeOutputs: new Map(),
  };
  const env = inputEnvVars(
    {
      id: 'publish-m1',
      kind: 'exec',
      script: 'land',
      runtime: 'bun',
      with: { gate_1_sha256: 'legacy-sha', gate_1_carried_sha256: 'carried-sha' },
    },
    ctx
  );
  expect(gateHashes('1', env)).toEqual(['legacy-sha', 'carried-sha']);
  expect(gateHashes('2', env)).toEqual([]);
});

// prettier-ignore
test('reclaim admission waits through transfer, passes without a journal, and times out bounded', async () => {
  let now = 0, reads = 0, attempts = 0;
  const states = ['transferring', 'transferred', 'reauthorized'], read = () => [{ run: 'r', state: states[Math.min(reads++, states.length - 1)] }];
  const deps = { read, now: () => now, sleep: (ms: number) => { now += ms; } };
  expect(reclaimAdmission('r', () => ++attempts, deps)).toBe(1);
  expect([now, reads, attempts]).toEqual([30_000, 3, 1]);
  now = reads = attempts = 0;
  expect(reclaimAdmission('r', () => { if (!attempts++) throw new IntegrationError('reclaim_pending', 'race'); return 'renewed'; },
    { ...deps, read: () => reads++ ? [{ run: 'r', state: reads === 2 ? 'transferred' : 'reauthorized' }] : [] })).toBe('renewed');
  expect([now, attempts]).toEqual([15_000, 2]);
  now = 0; const artifacts = tmp();
  expect(() => waitForReclaim('r', { ...deps, read: () => [{ run: 'r', state: 'transferred' }] })).toThrow('reclaim authorization is still pending');
  expect(now).toBe(600_000);
  runDeliveryEntry(() => { throw new IntegrationError('reclaim_pending', 'pending'); }, fixtureEnv({ ARTIFACTS_DIR: artifacts, INPUTS_OUTPUT: 'publish-m1' }));
  expect(await Bun.file(join(artifacts, 'publish-m1.json')).json()).toMatchObject({ reason: 'reclaim_pending' });
});
// prettier-ignore
test('generation fencing refreshes only for a newer owner and retries once', () => {
  let attempts = 0, refreshes = 0;
  const reject = () => { attempts++; throw new Error('stale'); };
  retryAdvancedFence(true, [1, 1], () => [2, 1], reject, () => refreshes++);
  expect([attempts, refreshes]).toEqual([1, 1]);
  expect(() => retryAdvancedFence(true, [1], () => [2], () => { throw new IntegrationError('reclaim_pending', 'pending'); }, () => refreshes++)).toThrow('pending');
  expect(refreshes).toBe(1);
  const root = tmp(), art = join(root, 'artifacts/runs/r'); mkdirSync(art, { recursive: true });
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ deadline: '2099-01-01T00:00:00Z' })); writeFileSync(join(art, 'publish-m1.json'), JSON.stringify({ reason: 'reclaim_pending' }));
  const ledger = { repo: root, gen_dir: root, run_id: 'r', started_at: '2026-01-01T00:00:00Z' } as Ledger, run = { id: 'r', status: 'failed' as const, output_root: root, nodes: [{ nodeId: 'publish-m1', state: 'failed' }] };
  const classified = classifyRun(ledger, run); expect(classified.state).toBe('held:reclaim_pending');
  expect(holdOf(ledger, run, classified)).toBe('auto_recover'); expect(decisionQuestion(ledger, run, classified, 'auto_recover')).toContain('回收续授权尚未完成');
});

test('completed legacy land evidence remains readable', () => {
  expect(landEvidence({ status: 'completed', nodes: [] })).toEqual({
    node: 'land',
    file: 'land.json',
  });
  expect(
    landEvidence({
      nodes: [
        { nodeId: 'land-m1', state: 'completed' },
        { nodeId: 'land-m2', state: 'skipped' },
      ],
    })
  ).toEqual({ node: 'land-m1', file: 'land-m1.json' });
  expect(landEvidence({ nodes: [] })).toBeUndefined();
});

test('historical delivery projection reads only the persisted ledger receipt', () => {
  const persisted = {
    status: 'integrated' as const,
    task: 'old',
    source: 'a'.repeat(40),
    target: { checkout: '/gone', branch: 'target', head: 'b'.repeat(40) },
    contract: 'contract',
    evidence: '/gone/artifacts',
    accepted: 'c'.repeat(40),
    integrated: 'c'.repeat(40),
    target_tip: 'c'.repeat(40),
    push: 'git push',
  };
  const ledger = { delivery_result: persisted } as Ledger;
  expect(deliveryProjection(ledger)).toEqual({
    ...persisted,
    status: 'manual_push',
  } satisfies DeliveryReceipt);
  expect(deliveryProjection({} as Ledger)).toBeUndefined();
});

test('legacy delivery entry fails clearly without loading a run', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/land.ts')], {
    env: fixtureEnv({ INPUTS_ACTION: '', INPUTS_RUN: '' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('legacy delivery removed; run is terminal');
});

test('delivery entry reports failures without a stack trace', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const artifacts = tmp();
  try {
    runDeliveryEntry(
      () => {
        throw new IntegrationError('git_lock_held', 'holder unknown');
      },
      fixtureEnv({ ARTIFACTS_DIR: artifacts, INPUTS_OUTPUT: 'sync-m1' })
    );
    expect(error).toHaveBeenCalledWith('integration_git_lock_held: holder unknown');
    expect(await Bun.file(join(artifacts, 'sync-m1.json')).text()).toContain(
      '"reason": "git_lock_held"'
    );
  } finally {
    error.mockRestore();
  }
});
