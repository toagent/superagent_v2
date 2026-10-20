import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restore, runInProcess, scenario } from './scenarios/framework';

test('S14a: completed fix evidence survives executor recovery without replay', async () => {
  const f = scenario({
    id: 'S14a',
    risk: 'G2',
    passRound: 2,
    plan: {
      goal: 'S14a generated delivery recovers after a persisted fix',
      accept: 'test "$(cat scenario.txt)" = S14a',
    },
    agents: { code: { path: 'scenario.txt', content: 'S14a\n' } },
    expected: { terminal: 'completed', publishCount: 1 },
  });
  try {
    const result = await runInProcess(f);
    expect(result.terminal.completed).toEqual(['5ce0-014a']);
    expect(
      result.events.filter(
        event => event.event_type === 'node_completed' && event.step_name === 'fix-m1-r2'
      )
    ).toHaveLength(1);

    const review = 'review-m1-r1';
    const pointer = JSON.parse(
      readFileSync(join(result.artifactsDir, `${review}.context.json`), 'utf8')
    ) as { attempt: number };
    const counter = join(f.root, 'recovered-attempt');
    writeFileSync(counter, String(pointer.attempt));
    const env: NodeJS.ProcessEnv = { ...process.env, ARTIFACTS_DIR: result.artifactsDir };
    delete env.INPUTS_COUNTER;
    const script = join(result.generated.dir, '.archon/scripts/sa-context.ts');
    // prettier-ignore
    const args = [process.execPath, script, counter, result.generated.dir, '', review, 'gate-m1-r1'];
    const resumed = Bun.spawnSync(args, { cwd: f.worker, env, stdout: 'pipe', stderr: 'pipe' });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
  } finally {
    restore(f);
  }
}, 90_000);
