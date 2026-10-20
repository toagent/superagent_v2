import { expect, test } from 'bun:test';
import { expectOutcome, restore, runInProcess, scenario, type ScenarioId } from './framework';

const fixture = (id: ScenarioId, passRound: 1 | 2 = 1) =>
  scenario({
    id,
    risk: 'G2',
    passRound,
    plan: { goal: `${id} generated delivery`, accept: `test "$(cat scenario.txt)" = ${id}` },
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

test('S4/S5/S7/S9/S10: generated scenarios use executor facts, never local counters', async () => {
  for (const id of ['S4', 'S5', 'S7', 'S9', 'S10'] as const) {
    const f = fixture(id);
    try {
      const result = await runInProcess(f);
      expectOutcome(f, result, {
        terminal: 'completed',
        counts: { 'code-p': 1, 'gate-m1-r1': 1, 'integrate-m1.publish-m1': 1 },
        published: true,
      });
      if (id === 'S4')
        expect(
          result.events.some(
            event => event.event_type === 'node_completed' && event.step_name === 'sync-review-m1'
          )
        ).toBeTrue();
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
