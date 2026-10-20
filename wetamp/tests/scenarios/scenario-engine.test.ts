import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promote, rollback } from '../../src/engine';
import { completedOutput, expectOutcome, restore, runInProcess, scenario } from './framework';
import { sh, tmp } from '../helpers';

const SHIM = join(import.meta.dir, '../../bin/superagent-shim');
// prettier-ignore
const fixture = (id: 'S12' | 'S15') => scenario({ id, risk: 'G1', passRound: 1, plan: { goal: `${id} engine scenario`, accept: `test "$(cat scenario.txt)" = ${id}` }, agents: { code: { path: 'scenario.txt', content: `${id}\n` } }, expected: { terminal: 'completed', publishCount: 1 } });

// prettier-ignore
test('S12: promotion and rollback keep old runs on their pinned engine', async () => {
  const root = tmp(),
    source = join(root, 'source'),
    home = join(root, 'home'),
    marker = join(root, 'engines.jsonl'),
    evidence = join(root, 'evidence.json'),
    saved = { ...process.env };
  sh(`git clone -q --no-hardlinks '${join(import.meta.dir, '../../..')}' '${source}'`, root);
  sh('git config user.name test && git config user.email test@example.com && git branch -M 1.0.0', source);
  writeFileSync(evidence, '{}');
  const cliPath = join(source, 'wetamp/src/cli.ts'),
    cli = readFileSync(cliPath, 'utf8'),
    probe = `const argv = process.argv.slice(2);\n    if (process.env.S12_PROBE) {\n      const fs = require('node:fs'), path = require('node:path'), snapshot = import.meta.dir.split('/wetamp/src')[0].split('/').at(-1);\n      fs.appendFileSync(process.env.S12_PROBE, JSON.stringify({ snapshot, args: argv }) + '\\n');\n      if (argv.includes('--schedule')) { const run = JSON.parse(fs.readFileSync(path.join(process.env.SUPERAGENT_HOME, 'runs/running.json'), 'utf8')); console.log(JSON.stringify({ groups: [{ snapshot: run.engine_snapshot, runs: ['running'] }] })); } else console.log('{}');\n      return;\n    }`;
  writeFileSync(cliPath, cli.replace('const argv = process.argv.slice(2);', probe));
  writeFileSync(join(source, 'wetamp/scripts/engine-acceptance.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(source, 'wetamp/scripts/engine-acceptance.sh'), 0o755);
  sh('git add wetamp && git commit -qm engine-A', source);
  Object.assign(process.env, { HOME: root, SUPERAGENT_HOME: home, ARCHON_HOME: join(root, 'archon'), SA_ENGINE_SOURCE: source });
  try {
    const a = sh('git rev-parse HEAD', source).trim();
    promote(a, evidence);
    writeFileSync(join(source, 'engine-b'), 'B');
    sh('git add engine-b && git commit -qm engine-B', source);
    const b = sh('git rev-parse HEAD', source).trim(),
      aPath = join(home, 'engine', a);
    promote(b);
    mkdirSync(join(home, 'runs'), { recursive: true });
    for (const [run, status] of [['running', 'running'], ['paused', 'paused'], ['crashed', 'failed']])
      writeFileSync(join(home, 'runs', `${run}.json`), JSON.stringify({ status, engine_snapshot: aPath }));
    const drive = () => {
      for (const args of [['supervise-tick'], ['resume', 'paused'], ['recover', 'crashed']]) {
        const out = Bun.spawnSync([SHIM, ...args], { env: { ...process.env, SUPERAGENT_HOME: home, S12_PROBE: marker }, stdout: 'pipe', stderr: 'pipe' });
        expect(out.exitCode, out.stderr.toString()).toBe(0);
      }
    };
    drive();
    expect(rollback()).toEqual({ from: b, to: a });
    drive();
    const calls = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.args.includes('--schedule')).map(call => call.snapshot)).toEqual([b, a]);
    expect(calls.filter(call => !call.args.includes('--schedule')).every(call => call.snapshot === a)).toBeTrue();
    const f = fixture('S12');
    try {
      f.engineSnapshot = aPath;
      const result = await runInProcess(f);
      expectOutcome(f, result, { terminal: 'completed', counts: { 'code-p': 1, 'integrate-m1.publish-m1': 1 }, published: true });
    } finally { restore(f); }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 180_000);

// prettier-ignore
test('S15: adopted carried acceptance emits the hash of its persisted bytes', async () => {
  const f = fixture('S15');
  try {
    writeFileSync(join(f.worker, 'scenario.txt'), 'S15\n');
    sh('git add scenario.txt && git commit -qm carried-S15', f.worker);
    const head = sh('git rev-parse HEAD', f.worker).trim(),
      evidence = join(f.root, 'carried.json');
    writeFileSync(
      evidence,
      JSON.stringify({ ok: true, failed: [], log: '/old.log', patch: '/old.patch', delta: '/old.delta', diff_hash: 'old', same: false, reviewed: false, base_pass: null, head, checkout_fingerprint: '/old.fingerprint', disposition: 'advance', reason: null, risk: 'G1', out_of_scope: [], tag: 'verify-old', artifact_sha256: 'old', decision: { kind: 'advance', reason: null, evidence: ['/old.log'], debt: [] } })
    );
    f.carried = { from: 'old-run', packages: ['p'], evidence: { p: evidence } };
    const result = await runInProcess(f);
    expectOutcome(f, result, { terminal: 'completed', counts: { 'code-p': 0, 'verify-p': 1, 'integrate-m1.publish-m1': 1 }, published: true });
    const output = completedOutput(result, 'verify-p'),
      artifact = readFileSync(join(result.artifactsDir, 'verify-p.json'));
    expect(output).toMatchObject({ log: '/old.log', diff_hash: 'old' });
    expect(output.artifact_sha256).toBe(new Bun.CryptoHasher('sha256').update(artifact).digest('hex'));
  } finally { restore(f); }
}, 120_000);
