import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { completedOutput, expectOutcome, restore, runInProcess, scenario } from './framework';
import { sh, tmp } from '../helpers';

const SHIM = join(import.meta.dir, '../../bin/superagent-shim');

function fakeEngine(root: string, name: string, marker: string): string {
  const path = join(root, name);
  mkdirSync(join(path, 'wetamp/src'), { recursive: true });
  writeFileSync(
    join(path, 'wetamp/src/cli.ts'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + '\\n');\nconsole.log('{}');\n`
  );
  return path;
}

test('S12: promotion and rollback keep old runs on their pinned engine', () => {
  const root = tmp(),
    home = join(root, 'home'),
    marker = join(root, 'engines'),
    engine = join(home, 'engine'),
    a = fakeEngine(root, 'A', marker),
    b = fakeEngine(root, 'B', marker);
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(engine, { recursive: true });
  symlinkSync(a, join(engine, 'current'));
  for (const [run, status] of [
    ['running', 'running'],
    ['paused', 'paused'],
    ['crashed', 'failed'],
  ] as const)
    writeFileSync(
      join(home, 'runs', `${run}.json`),
      JSON.stringify({ run_id: run, archon_run_id: run, status, engine_snapshot: a })
    );
  const drive = () => {
    for (const run of ['running', 'paused', 'crashed']) {
      const result = Bun.spawnSync([SHIM, 'resume', run], {
        env: { ...process.env, SUPERAGENT_HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
  };
  unlinkSync(join(engine, 'current'));
  symlinkSync(b, join(engine, 'current'));
  drive();
  unlinkSync(join(engine, 'current'));
  symlinkSync(a, join(engine, 'current'));
  drive();
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(Array(6).fill('A'));
});

test('S15: adopted carried acceptance emits the hash of its persisted bytes', async () => {
  const f = scenario({
    id: 'S15',
    risk: 'G1',
    passRound: 1,
    plan: { goal: 'S15 carried delivery', accept: 'test "$(cat scenario.txt)" = S15' },
    agents: { code: { path: 'scenario.txt', content: 'S15\n' } },
    expected: { terminal: 'completed', publishCount: 1 },
  });
  try {
    writeFileSync(join(f.worker, 'scenario.txt'), 'S15\n');
    sh('git add scenario.txt && git commit -qm carried-S15', f.worker);
    const head = sh('git rev-parse HEAD', f.worker).trim(),
      evidence = join(f.root, 'carried.json');
    writeFileSync(
      evidence,
      JSON.stringify({
        ok: true,
        failed: [],
        log: '/old.log',
        patch: '/old.patch',
        delta: '/old.delta',
        diff_hash: 'old',
        same: false,
        reviewed: false,
        base_pass: null,
        head,
        checkout_fingerprint: '/old.fingerprint',
        disposition: 'advance',
        reason: null,
        risk: 'G1',
        out_of_scope: [],
        tag: 'verify-old',
        artifact_sha256: 'old',
        decision: { kind: 'advance', reason: null, evidence: ['/old.log'], debt: [] },
      })
    );
    f.carried = { from: 'old-run', packages: ['p'], evidence: { p: evidence } };
    const result = await runInProcess(f);
    expectOutcome(f, result, {
      terminal: 'completed',
      counts: { 'code-p': 0, 'verify-p': 1, 'integrate-m1.publish-m1': 1 },
      published: true,
    });
    const output = completedOutput(result, 'verify-p'),
      artifact = readFileSync(join(result.artifactsDir, 'verify-p.json'));
    expect(output.artifact_sha256).not.toBe('old');
    expect(output.artifact_sha256).toBe(
      new Bun.CryptoHasher('sha256').update(artifact).digest('hex')
    );
  } finally {
    restore(f);
  }
}, 120_000);
