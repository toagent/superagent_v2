import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promote, rollback } from '../../src/engine';
import { completedOutput, expectOutcome, recoverCarriedScenario, scenario } from './framework';
import { sh, tmp } from '../helpers';
import { createWorkflowStore } from '../../../packages/core/src/workflows/store-adapter';
import { resetDatabase } from '../../../packages/core/src/db/connection';

// prettier-ignore
const fixture = (id: 'S12' | 'S15') => scenario({ id, risk: 'G1', passRound: 1, plan: { goal: `${id} engine scenario`, accept: `test "$(cat scenario.txt)" = ${id}` }, agents: { code: { path: 'scenario.txt', content: `${id}\n` } }, expected: { terminal: 'completed', publishCount: 1 } });

// prettier-ignore
test('S12: promotion and rollback keep old runs on their pinned engine', async () => {
  const root = tmp(),
    source = join(root, 'source'),
    home = join(root, 'home'),
    evidence = join(root, 'evidence.json'),
    repo = join(import.meta.dir, '../../..'),
    saved = { ...process.env }, children: ReturnType<typeof Bun.spawn>[] = [];
  cpSync(repo, source, { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/.git/') && !path.endsWith('/.git') });
  sh('git init -q -b 1.0.0 && git config core.hooksPath /dev/null && git config user.name test && git config user.email test@example.com && git add packages wetamp package.json bun.lock && git commit -qm engine-A', source);
  symlinkSync(join(repo, 'node_modules'), join(source, 'node_modules'));
  symlinkSync(join(repo, 'wetamp/node_modules'), join(source, 'wetamp/node_modules'));
  for (const name of readdirSync(join(repo, 'packages'))) if (existsSync(join(repo, 'packages', name, 'node_modules'))) symlinkSync(join(repo, 'packages', name, 'node_modules'), join(source, 'packages', name, 'node_modules'));
  writeFileSync(evidence, '{}');
  writeFileSync(join(source, 'wetamp/scripts/engine-acceptance.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(source, 'wetamp/scripts/engine-acceptance.sh'), 0o755);
  sh('git add wetamp/scripts/engine-acceptance.sh && git commit --amend --no-edit -q', source);
  Object.assign(process.env, { HOME: home, SUPERAGENT_HOME: home, ARCHON_HOME: join(home, 'archon'), SA_ENGINE_SOURCE: source, DATABASE_URL: '' });
  try {
    const a = sh('git rev-parse HEAD', source).trim();
    promote(a, evidence);
    const aPath = join(home, 'engine', a), runner = join(source, 'wetamp/tests/scenarios/detached-runner.ts'), states: string[] = [];
    for (const [i, kind] of ['running', 'paused', 'crashed'].entries()) {
      const state = join(root, `${kind}.json`), marker = join(root, `${kind}.blocked`), release = join(root, `${kind}.release`), runId = `5ce0-0012-${String(i)}`;
      states.push(state);
      children.push(Bun.spawn([process.execPath, 'test', runner], { env: { ...process.env, SCENARIO_ID: 'S12', SCENARIO_HOME: home, SCENARIO_RUN_ID: runId, SCENARIO_SUFFIX: kind, SCENARIO_READY: state, SCENARIO_RESULT: join(root, `${kind}.result`), SCENARIO_BLOCK_AFTER_COMPLETED_NODE: 'code-p', SCENARIO_BLOCK_MARKER: marker, SCENARIO_BLOCK_RELEASE: release, SCENARIO_ENGINE_SNAPSHOT: aPath }, stdout: 'ignore', stderr: 'pipe' }));
      for (const end = Date.now() + 60_000; !existsSync(marker) && Date.now() < end; ) await Bun.sleep(25);
      expect(existsSync(marker)).toBeTrue();
    }
    children[1].kill('SIGKILL'); children[2].kill('SIGKILL'); await Promise.all([children[1].exited, children[2].exited]);
    resetDatabase(); const store = createWorkflowStore();
    await store.pauseWorkflowRun('5ce0-0012-1', { nodeId: 'code-p', message: 'scenario pause', type: 'approval', pauseId: 'scenario' });
    await store.failWorkflowRun('5ce0-0012-2', 'scenario crash');
    writeFileSync(join(source, 'engine-b'), 'B');
    sh('git add engine-b && git commit -qm engine-B', source);
    const b = sh('git rev-parse HEAD', source).trim();
    promote(b);
    writeFileSync(join(root, 'running.release'), 'go'); await children[0].exited;
    for (const [i, kind] of ['paused', 'crashed'].entries()) {
      const child = Bun.spawn([process.execPath, 'test', runner], { env: { ...process.env, SCENARIO_ID: 'S12', SCENARIO_RESUME_STATE: states[i + 1], SCENARIO_RESULT: join(root, `${kind}.result`) }, stdout: 'ignore', stderr: 'pipe' });
      children.push(child); expect(await child.exited, (await new Response(child.stderr).text()).slice(-1000)).toBe(0);
    }
    expect(rollback()).toEqual({ from: b, to: a });
    for (const kind of ['running', 'paused', 'crashed']) expect(JSON.parse(readFileSync(join(root, `${kind}.result`), 'utf8')).ledger.engine_snapshot).toBe(aPath);
    expect((await Promise.all(['5ce0-0012-0', '5ce0-0012-1', '5ce0-0012-2'].map(id => store.getWorkflowRun(id)))).map(run => run?.status)).toEqual(['completed', 'completed', 'completed']);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 180_000);

// prettier-ignore
test('S15: recover adopts accepted work and hashes the carried persisted bytes', async () => {
  const spec = { ...fixture('S15').spec, risk: 'G2' as const, passRound: 2 as const },
    { f, result, adopted, engineAdoption, oldSnapshot, root, originalRunId } = await recoverCarriedScenario(spec);
    expect(engineAdoption).toMatchObject({ from: oldSnapshot, to: root });
    expect(adopted.engine_adoptions?.at(-1)).toMatchObject({ from: oldSnapshot, to: root });
    expect(adopted.adoptions?.at(-1)).toMatchObject({
      from: originalRunId,
      to: result.runId,
      carried: ['p'],
    });
    expectOutcome(f, result, { terminal: 'completed', counts: { 'code-p': 0, 'verify-p': 1, 'integrate-m1.publish-m1': 1 }, published: true });
    const output = completedOutput(result, 'verify-p'),
      artifact = readFileSync(join(result.artifactsDir, 'verify-p.json'));
    expect(output.artifact_sha256).toBe(new Bun.CryptoHasher('sha256').update(artifact).digest('hex'));
}, 240_000);
