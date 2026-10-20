import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from '../helpers';
import {
  expectOutcome,
  expectPublishedGate,
  restore,
  runInProcess,
  scenario,
  type ScenarioId,
} from './framework';

const fixture = (id: ScenarioId, passRound: 1 | 2 = 1) =>
  scenario({
    id,
    risk: 'G2',
    passRound,
    plan: {
      goal: `${id} generated delivery`,
      accept:
        id === 'S6'
          ? `test "$(cat scenario.txt)" = ${id} && test ! -e target-regression.txt`
          : `test "$(cat scenario.txt)" = ${id}`,
    },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  });

test('S3: review repair round binds the executed gate and publishes once', async () => {
  const f = fixture('S3', 2);
  try {
    const result = await runInProcess(f);
    expectOutcome(f, result, {
      terminal: 'completed',
      counts: {
        'review-m1-r1': 1,
        'fix-m1-r2': 1,
        'review-m1-r2': 1,
        'gate-m1-r2': 1,
        'integrate-m1.publish-m1': 1,
      },
      published: true,
    });
    expectPublishedGate(result, 2);
    expect(
      result.events.some(
        event =>
          event.event_type === 'node_completed' && event.step_name === 'integrate-m1.publish-m1'
      )
    ).toBeTrue();
  } finally {
    restore(f);
  }
}, 90_000);

test('S4: two detached runs sharing one target each publish exactly once', async () => {
  const root = tmp(),
    target = gitRepo(root);
  Bun.spawnSync(['git', 'branch', '-m', 'scenario-target'], { cwd: target });
  const run = (suffix: string) => {
    const output = join(tmp(), `s4-${suffix}.json`);
    const child = Bun.spawn(
      [process.execPath, 'test', join(import.meta.dir, 'detached-runner.ts')],
      {
        detached: true,
        env: {
          ...process.env,
          SCENARIO_ID: 'S4',
          SCENARIO_TARGET: target,
          SCENARIO_SUFFIX: suffix,
          SCENARIO_RESULT: output,
        },
        stdout: 'ignore',
        stderr: 'pipe',
      }
    );
    return Promise.all([child.exited, new Response(child.stderr).text()]).then(([code, error]) => {
      expect(code, error).toBe(0);
      return JSON.parse(readFileSync(output, 'utf8')) as {
        receipt: { status: string };
        terminal: { completed: string[]; failed: string[] };
      };
    });
  };
  const results = await Promise.all([run('a'), run('b')]);
  for (const result of results) {
    expect(result.terminal).toEqual({ completed: ['5ce0-0004'], failed: [] });
    expect(result.receipt.status).toBe('published');
  }
}, 180_000);

test('S5/S7/S9/S10: generated scenarios use executor facts, never local counters', async () => {
  for (const id of ['S5', 'S7', 'S9', 'S10'] as const) {
    const f = fixture(id);
    try {
      const result = await runInProcess(f);
      expectOutcome(f, result, {
        terminal: 'completed',
        counts: { 'code-p': 1, 'gate-m1-r1': 1, 'integrate-m1.publish-m1': 1 },
        published: true,
      });
      if (id === 'S5')
        expect(
          result.events.some(
            event =>
              event.event_type === 'node_completed' && event.step_name === 'resolve-sync-review-m1'
          )
        ).toBeTrue();
      if (id === 'S10') {
        expect(
          result.events.some(
            event => event.event_type === 'node_completed' && event.step_name === 'code-p2'
          )
        ).toBeTrue();
        expect(
          result.events.some(
            event =>
              event.event_type === 'node_completed' && event.step_name === 'integrate-m2.publish-m2'
          )
        ).toBeTrue();
      }
    } finally {
      restore(f);
    }
  }
}, 300_000);

test('S6/S13: acceptance regression and stale coordination ownership block publish', async () => {
  for (const id of ['S6', 'S13'] as const) {
    const f = fixture(id);
    try {
      const result = await runInProcess(f);
      expectOutcome(f, result, {
        terminal: 'failed',
        counts: { 'integrate-m1.publish-m1': 0 },
        published: false,
      });
      expect(result.events.some(event => event.event_type === 'node_failed')).toBeTrue();
      if (id === 'S6')
        expect(
          result.events.some(
            event =>
              event.event_type === 'node_failed' &&
              event.step_name === 'integrate-m1.final-accept-m1'
          )
        ).toBeTrue();
    } finally {
      restore(f);
    }
  }
}, 90_000);

test('S8: changing diff evidence between review and gate fails closed', async () => {
  const f = fixture('S8');
  try {
    const result = await runInProcess(f);
    expectOutcome(f, result, {
      terminal: 'failed',
      counts: { 'review-m1-r1': 1, 'integrate-m1.publish-m1': 0 },
      published: false,
    });
    expect(
      result.events.some(
        event => event.event_type === 'node_failed' && event.step_name === 'gate-m1-r1'
      )
    ).toBeTrue();
  } finally {
    restore(f);
  }
}, 90_000);
