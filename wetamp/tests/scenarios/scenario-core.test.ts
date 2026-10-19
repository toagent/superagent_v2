import { expect, test } from 'bun:test';
import { restore, runDetached, runInProcess, scenario } from './framework';
import { sh } from '../helpers';

test('S1: detached G1 uses the installed provider, accepts, syncs, and publishes', () => {
  const f = scenario({
    id: 'S1',
    risk: 'G1',
    passRound: 1,
    plan: { goal: 'Detached G1 publish', accept: 'test "$(cat scenario.txt)" = S1' },
    agents: { code: { path: 'scenario.txt', content: 'S1\n' } },
    expected: { terminal: 'completed', publishCount: 1 },
  });
  try {
    const run = runDetached(f);
    expect(
      run.status,
      JSON.stringify(run.events.filter(event => event.event_type === 'node_failed'))
    ).toBe(f.spec.expected.terminal);
    expect(run.events.filter(event => event.event_type === 'node_failed')).toEqual([]);
    for (const node of ['code', 'accept', 'sync', 'publish'])
      expect(
        run.events.filter(
          event => event.event_type === 'node_completed' && event.step_name === node
        )
      ).toHaveLength(node === 'publish' ? f.spec.expected.publishCount : 1);
    expect(sh('git rev-parse scenario-target', f.target).trim()).toBe(
      sh('git rev-parse HEAD', f.worker).trim()
    );
    expect(
      run.events.some(
        event => event.step_name === 'publish' && JSON.stringify(event.data).includes('published')
      )
    ).toBeTrue();
  } finally {
    restore(f);
  }
}, 90_000);

test('S2/S11: G2 passes r1, skips later rounds, publishes once, and runs as worker', async () => {
  const f = scenario({
    id: 'S2',
    risk: 'G2',
    passRound: 1,
    plan: { goal: 'G2 passes review round one', accept: 'test "$(cat scenario.txt)" = S2' },
    agents: { code: { path: 'scenario.txt', content: 'S2\n' } },
    expected: { terminal: 'completed', publishCount: 1 },
  });
  try {
    const { events, terminal } = await runInProcess(f);
    expect(terminal).toEqual({ completed: ['scenario-s2'], failed: [] });
    expect(events.filter(event => event.event_type === 'node_failed')).toEqual([]);
    expect(
      events.filter(event => event.event_type === 'node_skipped' && event.step_name === 'accept-r2')
    ).toHaveLength(1);
    for (const node of ['code', 'accept-r1', 'publish'])
      expect(
        events.filter(event => event.event_type === 'node_completed' && event.step_name === node)
      ).toHaveLength(node === 'publish' ? f.spec.expected.publishCount : 1);
    expect(
      events.some(
        event => event.step_name === 'publish' && JSON.stringify(event.data).includes('published')
      )
    ).toBeTrue();
    expect(sh('git rev-parse scenario-target', f.target).trim()).toBe(
      sh('git rev-parse HEAD', f.worker).trim()
    );
  } finally {
    restore(f);
  }
}, 60_000);
