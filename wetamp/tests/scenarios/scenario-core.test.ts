import { expect, test } from 'bun:test';
import { expectOutcome, restore, runInProcess, scenario } from './framework';

const fixture = (id: 'S1' | 'S2', risk: 'G1' | 'G2') =>
  scenario({
    id,
    risk,
    passRound: 1,
    plan: { goal: `${id} generated delivery`, accept: `test "$(cat scenario.txt)" = ${id}` },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  });

test('S1/S2/S11: generated workflows execute real engine nodes and publish once', async () => {
  for (const [id, risk] of [
    ['S1', 'G1'],
    ['S2', 'G2'],
  ] as const) {
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
      expect(process.env.SUPERAGENT_ROLE).toBe(f.saved.SUPERAGENT_ROLE);
    } finally {
      restore(f);
    }
  }
}, 120_000);
