import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, trackTestChild } from '../helpers';
import { expectOutcome, expectPublishedGate, restore, runInProcess, scenario } from './framework';

const fixture = (id: 'S1' | 'S2', risk: 'G1' | 'G2') =>
  scenario({
    id,
    risk,
    passRound: 1,
    plan: { goal: `${id} generated delivery`, accept: `test "$(cat scenario.txt)" = ${id}` },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  });

test('S1: detached process persists engine terminal state, receipt, and target ref', async () => {
  const output = join(tmp(), 's1-result.json');
  const child = Bun.spawn([process.execPath, 'test', join(import.meta.dir, 'detached-runner.ts')], {
    detached: true,
    env: { ...process.env, SCENARIO_RESULT: output },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  trackTestChild(child, true);
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  const result = JSON.parse(readFileSync(output, 'utf8')) as {
    terminal: { completed: string[]; failed: string[] };
    ledger: { archon_run_id: string };
    receipt: { status: string };
    target: string;
    worker: string;
  };
  expect(result.terminal).toEqual({ completed: ['5ce0-0001'], failed: [] });
  expect(result.ledger.archon_run_id).toBe('5ce0-0001');
  expect(result.receipt.status).toBe('published');
  expect(result.target).toBe(result.worker);
}, 120_000);

test('S2/S11: generated G2 workflow binds gate evidence without preset role', async () => {
  for (const [id, risk] of [['S2', 'G2']] as const) {
    const f = fixture(id, risk);
    try {
      const result = await runInProcess(f);
      expectOutcome(f, result, {
        terminal: 'completed',
        counts: {
          'code-p': 1,
          'integrate-m1.resync-m1': 1,
          'integrate-m1.final-accept-m1': 1,
          'integrate-m1.publish-m1': 1,
        },
        published: true,
      });
      expectPublishedGate(result, 1);
      expect(f.roles.length).toBeGreaterThan(0);
      expect(new Set(f.roles)).toEqual(new Set(['']));
      expect(process.env.SUPERAGENT_ROLE).toBe('');
    } finally {
      restore(f);
    }
  }
}, 120_000);
