import { expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import { gitRepo, sh, tmp } from '../helpers';
import { resetDatabase } from '../../../packages/core/src/db/connection';
import { superviseTick, loadLedger, ledgerPath } from '../../src/cli';
import * as archonModule from '../../src/archon';
import {
  expectOutcome,
  expectPublishedGate,
  restore,
  resumeInProcess,
  runInProcess,
  scenario,
  type ScenarioId,
  type ScenarioFixture,
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

const waitFor = async (path: string): Promise<void> => {
  for (const end = Date.now() + 60_000; Date.now() < end; ) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`scenario marker timeout: ${path}`);
};

const interruptedScenario = async (
  id: 'S14a' | 'S14b' | 'S14c',
  block: { node?: string; afterCompletedNode?: string } = { node: 'fix-m1-r2' }
) => {
  const root = tmp(),
    ready = join(root, 'ready.json'),
    marker = join(root, 'blocked'),
    output = join(root, 'unused-result.json');
  const child = Bun.spawn([process.execPath, 'test', join(import.meta.dir, 'detached-runner.ts')], {
    env: {
      ...process.env,
      SCENARIO_ID: id,
      SCENARIO_RESULT: output,
      SCENARIO_READY: ready,
      SCENARIO_BLOCK_NODE: block.node,
      SCENARIO_BLOCK_AFTER_COMPLETED_NODE: block.afterCompletedNode,
      SCENARIO_BLOCK_MARKER: marker,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  await waitFor(ready);
  for (const end = Date.now() + 60_000; !existsSync(marker) && Date.now() < end; ) {
    if (child.exitCode !== null) {
      const error = await new Response(child.stderr).text();
      throw new Error(
        `scenario executor exited ${String(child.exitCode)} ${readFileSync(ready, 'utf8')} ${existsSync(output) ? readFileSync(output, 'utf8').slice(-2000) : ''}: ${error.slice(-2000)}`
      );
    }
    await Bun.sleep(25);
  }
  if (!existsSync(marker)) {
    child.kill('SIGKILL');
    const error = await new Response(child.stderr).text();
    throw new Error(`scenario barrier timeout: ${error.slice(-2000)}`);
  }
  child.kill('SIGKILL');
  await child.exited;
  const state = JSON.parse(readFileSync(ready, 'utf8')) as {
    root: string;
    home: string;
    archonHome: string;
    target: string;
    worker: string;
    runId: string;
  };
  return { ...state, child };
};

const withInterruptedHome = async <T>(
  state: Awaited<ReturnType<typeof interruptedScenario>>,
  body: () => T | Promise<T>
): Promise<T> => {
  const keys = ['HOME', 'SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_SUPERVISOR'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const supervisor = join(state.home, 'supervisor.py');
  writeFileSync(
    supervisor,
    "import sys\nprint('scenario-ask' if len(sys.argv) > 1 and sys.argv[1] == 'ask' else 'pending')\n"
  );
  Object.assign(process.env, {
    HOME: state.home,
    SUPERAGENT_HOME: state.home,
    ARCHON_HOME: state.archonHome,
    SA_SUPERVISOR: supervisor,
  });
  resetDatabase();
  try {
    const snapshot = realpathSync(join(import.meta.dir, '../../..')),
      engine = join(state.home, 'engine');
    mkdirSync(engine, { recursive: true });
    symlinkSync(snapshot, join(engine, 'current'));
    const ledger = loadLedger(state.runId);
    ledger.engine_snapshot = snapshot;
    writeFileSync(ledgerPath(state.runId), JSON.stringify(ledger));
    return await body();
  } finally {
    resetDatabase();
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

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
        failures: Array<{ step: string | null; data: unknown }>;
        receipt: { status: string };
        terminal: { completed: string[]; failed: string[] };
      };
    });
  };
  const results = await Promise.all([run('a'), run('b')]);
  for (const result of results) {
    expect(result.terminal, JSON.stringify(result.failures)).toEqual({
      completed: ['5ce0-0004'],
      failed: [],
    });
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

test('S14a: kill after durable fix completion, tick recovery, and publish without replay', async () => {
  const state = await interruptedScenario('S14a', { afterCompletedNode: 'fix-m1-r2' });
  await withInterruptedHome(state, async () => {
    const original = archonModule.archon;
    const launch = spyOn(archonModule, 'archon').mockImplementation((args, cwd, input, timeout) =>
      args[0] === 'workflow' && args[1] === 'resume'
        ? { code: 0, out: JSON.stringify({ ok: true, runId: state.runId }), err: '' }
        : original(args, cwd, input, timeout)
    );
    try {
      const tick = superviseTick({ runs: [state.runId], noGlobal: true });
      expect(tick).toMatchObject({
        actions: [{ run_id: state.runId, action: 'auto_recover', ok: true }],
      });
    } finally {
      launch.mockRestore();
    }
    const f: ScenarioFixture = {
      root: state.root,
      home: state.home,
      archonHome: state.archonHome,
      target: state.target,
      worker: state.worker,
      initial: sh('git rev-parse scenario-target', state.target).trim(),
      saved: { ...process.env },
      roles: [],
      spec: {
        id: 'S14a',
        risk: 'G2',
        passRound: 2,
        plan: {
          goal: 'S14a generated delivery recovers after a persisted fix',
          accept: 'test "$(cat scenario.txt)" = S14a',
        },
        agents: { code: { path: 'scenario.txt', content: 'S14a\n' } },
        expected: { terminal: 'completed', publishCount: 1 },
      },
    };
    const result = await resumeInProcess(f);
    expectOutcome(f, result, {
      terminal: 'completed',
      counts: {
        'fix-m1-r2': 1,
        'review-m1-r2': 1,
        'gate-m1-r2': 1,
        'integrate-m1.publish-m1': 1,
      },
      published: true,
    });
    expectPublishedGate(result, 2);
  });
}, 120_000);

test('S14b: killing a real executor during fix holds effects_unknown without replay', async () => {
  const state = await interruptedScenario('S14b');
  await withInterruptedHome(state, () => {
    const result = superviseTick({ runs: [state.runId], noGlobal: true });
    expect(result).toMatchObject({
      actions: [{ run_id: state.runId, action: 'ask', reason: 'auto_recover', ok: true }],
    });
    expect(loadLedger(state.runId).auto_recover_paused).toBe('effects_unknown');
    expect(
      loadLedger(state.runId).intervention_events?.filter(e => e.action === 'auto_recover')
    ).toHaveLength(1);
    const db = new Database(join(state.archonHome, 'archon.db'), { readonly: true });
    try {
      expect(
        db
          .query<
            { n: number },
            [string, string]
          >("select count(*) as n from remote_agent_workflow_events where workflow_run_id = ? and event_type = 'node_completed' and step_name = ?")
          .get(state.runId, 'fix-m1-r2')?.n
      ).toBe(0);
    } finally {
      db.close();
    }
  });
}, 120_000);

test('S14c: a reused owner pid on a real generated run performs zero recovery', async () => {
  const state = await interruptedScenario('S14c');
  await withInterruptedHome(state, () => {
    const db = new Database(join(state.archonHome, 'archon.db'));
    try {
      const row = db
        .query<
          { metadata: string },
          [string]
        >('select metadata from remote_agent_workflow_runs where id = ?')
        .get(state.runId);
      const metadata = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
      metadata.execution_owner = { host: hostname(), pid: process.pid };
      db.query(
        'update remote_agent_workflow_runs set started_at = ?, metadata = ? where id = ?'
      ).run('2020-01-01T00:00:00.000Z', JSON.stringify(metadata), state.runId);
    } finally {
      db.close();
    }
    const result = superviseTick({ runs: [state.runId], noGlobal: true });
    expect(result).toMatchObject({
      actions: [
        {
          run_id: state.runId,
          action: 'none',
          state: 'held:owner_unknown',
          held: true,
          ok: false,
        },
      ],
    });
    expect(loadLedger(state.runId).intervention_events).toBeUndefined();
  });
}, 120_000);
