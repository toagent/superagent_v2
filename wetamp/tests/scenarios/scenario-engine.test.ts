import { expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promote, rollback } from '../../src/engine';
import {
  completedOutput,
  copyableFixtureEntry,
  expectOutcome,
  recoverCarriedScenario,
  scenario,
} from './framework';
import { gitRepo, sh, tmp, trackTestChild } from '../helpers';
import { createWorkflowStore } from '../../../packages/core/src/workflows/store-adapter';
import { resetDatabase } from '../../../packages/core/src/db/connection';
import * as coordination from '../../src/coord';

const SHIM = join(import.meta.dir, '../../bin/superagent-shim');
// prettier-ignore
const passedProbe = () => ({ ok: true, level: 'G1' as const, run_id: 'scenario-probe', duration_ms: 1, evidence_path: '/scenario-probe.json' });

// prettier-ignore
const fixture = (id: 'S12' | 'S15') => scenario({ id, risk: 'G1', passRound: 1, plan: { goal: `${id} engine scenario`, accept: `test "$(cat scenario.txt)" = ${id}` }, agents: { code: { path: 'scenario.txt', content: `${id}\n` } }, expected: { terminal: 'completed', publishCount: 1 } });

// prettier-ignore
test('S12: promotion and rollback keep old runs on their pinned engine', async () => {
  const root = tmp(),
    source = join(root, 'source'),
    home = join(root, 'home'),
    evidence = join(root, 'evidence.json'),
    probe = join(root, 'engine-paths.jsonl'),
    repo = join(import.meta.dir, '../../..'),
    saved = { ...process.env }, children: ReturnType<typeof Bun.spawn>[] = [];
  cpSync(repo, source, { recursive: true, filter: copyableFixtureEntry });
  const cliPath = join(source, 'wetamp/src/cli.ts'), cli = readFileSync(cliPath, 'utf8');
  writeFileSync(cliPath, cli.replace('const argv = process.argv.slice(2);', `const argv = process.argv.slice(2);\n    if (process.env.S12_PROBE) require('node:fs').appendFileSync(process.env.S12_PROBE, JSON.stringify({ snapshot: require('node:fs').realpathSync(require('node:path').join(import.meta.dir, '../..')), args: argv }) + '\\n');`));
  const frameworkPath = join(source, 'wetamp/tests/scenarios/framework.ts'), framework = readFileSync(frameworkPath, 'utf8');
  writeFileSync(frameworkPath, framework.replace('export async function resumeInProcess(f: ScenarioFixture): Promise<ScenarioEvidence> {', `export async function resumeInProcess(f: ScenarioFixture): Promise<ScenarioEvidence> {\n  if (process.env.S12_PROBE) require('node:fs').appendFileSync(process.env.S12_PROBE, JSON.stringify({ snapshot: require('node:fs').realpathSync(require('node:path').join(import.meta.dir, '../../..')), executor: f.runId }) + '\\n');`));
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
    const aPath = join(home, 'engine', a), runner = join(aPath, 'wetamp/tests/scenarios/detached-runner.ts'), archon = join(root, 'archon-fixture');
    sh('chmod -R u+w .', aPath);
    writeFileSync(archon, `#!/bin/sh
set -eu
if [ "$1 $2" = "workflow resume" ] || [ "$1 $2" = "workflow approve" ]; then
  case "$3" in
    *-1) kind=paused ;;
    *-2) kind=crashed ;;
    *) exit 64 ;;
  esac
  (SCENARIO_ID=S12 SCENARIO_RISK=G2 SCENARIO_PASS_ROUND=2 SCENARIO_RESUME_STATE="$S12_STATE_DIR/$kind.json" SCENARIO_RESULT="$S12_STATE_DIR/$kind.result" "$S12_BUN" test "$S12_RUNNER") </dev/null >"$S12_STATE_DIR/$kind.log" 2>&1 &
  printf '%s\n' "$!" >"$S12_STATE_DIR/$kind.pid"
  printf '{"ok":true,"runId":"%s"}\n' "$3"
  exit 0
fi
exec "$S12_REAL_ARCHON" "$@"
`);
    chmodSync(archon, 0o755);
    const waitForDetachedResult = async (kind: 'paused' | 'crashed'): Promise<string> => {
      const result = join(root, `${kind}.result`), log = join(root, `${kind}.log`), pidFile = join(root, `${kind}.pid`);
      for (const end = Date.now() + 90_000; !existsSync(result) && Date.now() < end; ) {
        if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          if (existsSync(result)) break;
          throw new Error(`${kind} resume exited before result: ${existsSync(log) ? readFileSync(log, 'utf8').slice(-4000) : 'missing log'}`);
        }
        await Bun.sleep(25);
      }
      expect(existsSync(result), existsSync(log) ? readFileSync(log, 'utf8').slice(-4000) : 'missing log').toBeTrue();
      return result;
    };
    for (const [i, kind] of ['running', 'paused', 'crashed'].entries()) {
      const state = join(root, `${kind}.json`), marker = join(root, `${kind}.blocked`), release = join(root, `${kind}.release`), runId = `5ce0-0012-${String(i)}`, target = gitRepo(tmp());
      sh('git branch -m scenario-target && git config user.name t && git config user.email t@l', target);
      children.push(trackTestChild(Bun.spawn([process.execPath, 'test', runner], { env: { ...process.env, S12_PROBE: probe, SCENARIO_ID: 'S12', SCENARIO_RISK: 'G2', SCENARIO_PASS_ROUND: '2', SCENARIO_HOME: home, SCENARIO_TARGET: target, SCENARIO_RUN_ID: runId, SCENARIO_SUFFIX: kind, SCENARIO_READY: state, SCENARIO_RESULT: join(root, `${kind}.result`), SCENARIO_BLOCK_AFTER_COMPLETED_NODE: 'fix-m1-r2', SCENARIO_BLOCK_MARKER: marker, SCENARIO_BLOCK_RELEASE: release, SCENARIO_ENGINE_SNAPSHOT: aPath }, stdout: 'ignore', stderr: 'pipe' })));
      for (const end = Date.now() + 60_000; !existsSync(marker) && Date.now() < end; ) await Bun.sleep(25);
      expect(existsSync(marker)).toBeTrue();
    }
    children[1].kill('SIGKILL'); children[2].kill('SIGKILL');
    await Promise.all([children[1].exited, children[2].exited]);
    resetDatabase(); const store = createWorkflowStore();
    await store.pauseWorkflowRun('5ce0-0012-1', { nodeId: 'code-p', message: 'scenario pause', type: 'approval', pauseId: 'scenario' });
    const runIds = ['5ce0-0012-0', '5ce0-0012-1', '5ce0-0012-2'], eventBaselines = new Map(await Promise.all(runIds.map(async id => [id, (await store.listWorkflowEvents(id)).length] as const)));
    expect(await store.getWorkflowRunStatus('5ce0-0012-0')).toBe('running');
    expect(children[0].exitCode).toBeNull();
    writeFileSync(join(source, 'engine-b'), 'B');
    sh('git add engine-b && git commit -qm engine-B', source);
    const b = sh('git rev-parse HEAD', source).trim();
    promote(b, undefined, { probe: passedProbe });
    Object.assign(process.env, { SA_ARCHON_BIN: archon, S12_BUN: process.execPath, S12_PROBE: probe, S12_REAL_ARCHON: join(aPath, 'wetamp/bin/archon'), S12_RUNNER: runner, S12_STATE_DIR: root });
    const who = coordination.caller(), launcherPreload = join(root, 'launcher.cjs'), supervisor = join(root, 'supervisor.py');
    writeFileSync(launcherPreload, `require(${JSON.stringify(join(aPath, 'wetamp/hooks/live.cjs'))}).launcher = () => (${JSON.stringify(who)});\n`);
    writeFileSync(supervisor, 'import sys\nprint("yes" if "ask-status" in sys.argv else "scenario-ask")\n');
    for (const run of ['5ce0-0012-0', '5ce0-0012-1', '5ce0-0012-2']) {
      const path = join(home, 'runs', `${run}.json`), ledger = JSON.parse(readFileSync(path, 'utf8'));
      coordination.coord().claim(coordination.repoScope(ledger.repo), who, true, 'scenario continuation');
      ledger.controller = coordination.coord().claim(coordination.runScope(ledger), who, true, 'scenario continuation').controller;
      coordination.coord().reauthorize(ledger, who);
      writeFileSync(path, JSON.stringify(ledger));
    }
    const invoke = (...args: string[]) => Bun.spawnSync([SHIM, ...args], { env: { ...process.env, BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${launcherPreload}`.trim(), SA_SUPERVISOR: supervisor, S12_PROBE: probe }, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
    const promotedTick = invoke('supervise-tick');
    expect(promotedTick.exitCode, promotedTick.stdout.toString() + promotedTick.stderr.toString()).toBe(0);
    expect(await store.getWorkflowRunStatus('5ce0-0012-0')).toBe('running');
    expect(children[0].exitCode).toBeNull();
    const promotedCalls = readFileSync(probe, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(promotedCalls.some(call => Array.isArray(call.args) && call.args.includes('--no-global') && call.args.some((arg: string, i: number) => arg === '5ce0-0012-0' && call.args[i - 1] === '--runs'))).toBeTrue();
    const crashedResult = await waitForDetachedResult('crashed');
    expect(
      await store.getWorkflowRunStatus('5ce0-0012-2'),
      promotedTick.stdout.toString() + readFileSync(crashedResult, 'utf8')
    ).toBe('completed');
    writeFileSync(join(root, 'running.release'), 'continue');
    await children[0].exited;
    expect(await store.getWorkflowRunStatus('5ce0-0012-0')).toBe('completed');
    expect(rollback()).toEqual({ from: b, to: a });
    const rolledBackTick = invoke('supervise-tick');
    expect(rolledBackTick.exitCode, rolledBackTick.stdout.toString() + rolledBackTick.stderr.toString()).toBe(0);
    await waitForDetachedResult('paused');
    const calls = readFileSync(probe, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const ticks = calls.filter(call => Array.isArray(call.args) && call.args[0] === 'supervise-tick');
    expect(ticks.filter(call => call.args.includes('--schedule')).map(call => call.snapshot)).toEqual([join(home, 'engine', b), aPath]);
    expect(ticks.filter(call => call.args.includes('--no-global')).map(call => [call.snapshot, new Set(call.args.filter((_arg: string, i: number) => call.args[i - 1] === '--runs'))])).toEqual([[aPath, new Set(['5ce0-0012-0', '5ce0-0012-1', '5ce0-0012-2'])], [aPath, new Set(['5ce0-0012-0', '5ce0-0012-1', '5ce0-0012-2'])]]);
    expect(new Set(calls.filter(call => call.executor).map(call => `${call.snapshot}:${call.executor}`)), rolledBackTick.stdout.toString()).toEqual(new Set(['5ce0-0012-1', '5ce0-0012-2'].map(id => `${aPath}:${id}`)));
    const runs = await Promise.all(runIds.map(id => store.getWorkflowRun(id)));
    expect(runs.map(run => run?.status)).toEqual(['completed', 'completed', 'completed']);
    for (const run of runs) {
      const resumedEvents = (await store.listWorkflowEvents(run!.id)).slice(eventBaselines.get(run!.id));
      expect(resumedEvents.filter(event => event.event_type === 'node_completed' && event.step_name === 'fix-m1-r2')).toHaveLength(0);
      expect(resumedEvents.some(event => event.event_type === 'node_completed' && event.step_name === 'gate-m1-r2')).toBeTrue();
      expect(resumedEvents.some(event => event.event_type === 'node_completed' && event.step_name === 'integrate-m1.publish-m1')).toBeTrue();
    }
    expect(runIds.map(id => JSON.parse(readFileSync(join(home, 'runs', `${id}.json`), 'utf8')).engine_snapshot)).toEqual([aPath, aPath, aPath]);
  } finally {
    for (const kind of ['paused', 'crashed']) {
      const pidFile = join(root, `${kind}.pid`);
      try { if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (existsSync(home)) sh('chmod -R u+w .', home);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 240_000);

// prettier-ignore
test('S15: recover adopts accepted work and hashes the carried persisted bytes', async () => {
  const spec = { ...fixture('S15').spec, risk: 'G2' as const, passRound: 2 as const },
    { f, result, adopted, oldSnapshot, root, oldGenDir, originalRunId } = await recoverCarriedScenario(spec);
    expect(adopted.engine_adoptions?.at(-1)).toMatchObject({ from: oldSnapshot, to: root });
    expect(realpathSync(join(adopted.gen_dir, 'archon'))).toBe(join(root, 'wetamp/bin/archon'));
    expect(readFileSync(join(adopted.gen_dir, 'hints', 'p.md'), 'utf8')).toBe('retry hint\n');
    expect(readFileSync(join(adopted.gen_dir, 'attempts', 'm1'), 'utf8')).toBe(readFileSync(join(oldGenDir, 'attempts', 'm1'), 'utf8'));
    expect(adopted.adoptions?.at(-1)).toMatchObject({
      from: originalRunId,
      to: result.runId,
      carried: ['p'],
    });
    expectOutcome(f, result, { terminal: 'completed', counts: { 'code-p': 0, 'verify-p': 1, 'integrate-m1.publish-m1': 1 }, published: true });
    const gate = completedOutput(result, 'gate-m1-r2') as { identity: { authors: { model: string }[]; reviewer: { model: string } } };
    expect(gate).toMatchObject({ risk: 'G2', grade: 'PASS', identity: { reviewer: { model: 'fixture/reviewer' } } });
    expect(gate.identity.authors.every(author => author.model === 'fixture/coder')).toBeTrue();
    const output = completedOutput(result, 'verify-p'),
      artifact = readFileSync(join(result.artifactsDir, 'verify-p.json'));
    expect(output.artifact_sha256).toBe(new Bun.CryptoHasher('sha256').update(artifact).digest('hex'));
}, 240_000);
