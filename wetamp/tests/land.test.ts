import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import {
  deliveryProjection,
  landEvidence,
  runDeliveryEntry,
  type DeliveryReceipt,
} from '../src/land';
import type { Ledger } from '../src/cli';
import { fixtureEnv } from './helpers';

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

test('delivery entry reports failures without a stack trace', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(
      runDeliveryEntry(() => {
        throw new Error('legacy delivery removed; run is terminal');
      })
    ).toBe(false);
    expect(error).toHaveBeenCalledWith('Error: legacy delivery removed; run is terminal');
  } finally {
    error.mockRestore();
  }
});
