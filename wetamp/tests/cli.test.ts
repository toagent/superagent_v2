import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RunView } from '../src/archon';
import { classify, EXIT, loadLedger, main, parseArgs, waitRun, type Ledger } from '../src/cli';
import { fixturePlan, gitRepo, tmp } from './helpers';

const BIN = join(import.meta.dir, '..', 'bin', 'superagent');
const run = (status: RunView['status'], extra: Partial<RunView> = {}): RunView => ({
  id: 'r',
  status,
  ...extra,
});

describe('parseArgs', () => {
  test('positionals, --k v, --k=v and bare flags', () => {
    expect(parseArgs(['wait', 'x', '--timeout', '5', '--a=b', '--fake'])).toEqual({
      _: ['wait', 'x'],
      flags: { timeout: '5', a: 'b', fake: true },
    });
  });
});

describe('classify', () => {
  test('completed → 0', () =>
    expect(classify(run('completed'))).toEqual({ state: 'completed', exit: EXIT.completed }));
  test('cancelled → 2', () => expect(classify(run('cancelled')).exit).toBe(EXIT.cancelled));
  test('paused at sa.human.* → held:human with event', () => {
    const c = classify(
      run('paused', {
        metadata: {
          wait: { nodeId: 'human-m1', kind: 'event', event: 'sa.human.m1', resumeAt: 't' },
        },
      })
    );
    expect(c).toEqual({
      state: 'held:human',
      exit: EXIT.held,
      node: 'human-m1',
      event: 'sa.human.m1',
    });
  });
  test('paused elsewhere → held:paused', () =>
    expect(classify(run('paused')).state).toBe('held:paused'));
  test('failed environment → held:environment', () => {
    expect(
      classify(run('failed', { nodes: [{ nodeId: 'environment', state: 'failed' }] })).state
    ).toBe('held:environment');
  });
  test('failed gate → held:gate', () => {
    expect(
      classify(
        run('failed', {
          nodes: [
            { nodeId: 'verify-a', state: 'completed' },
            { nodeId: 'gate-m1', state: 'failed' },
          ],
        })
      )
    ).toEqual({ state: 'held:gate', exit: EXIT.held, node: 'gate-m1' });
  });
  test('other failure → failed with node', () => {
    expect(classify(run('failed', { nodes: [{ nodeId: 'code-a', state: 'failed' }] }))).toEqual({
      state: 'failed',
      exit: EXIT.failed,
      node: 'code-a',
    });
  });
  test('running with live owner → running', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: hostname(), pid: process.pid } } })
      )
    ).toEqual({ state: 'running', exit: EXIT.running });
  });
  test('running with dead local owner → owner_lost', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: hostname(), pid: 2 ** 22 + 1 } } })
      ).state
    ).toBe('owner_lost');
  });
  test('dead pid on another host is not owner_lost (ownership unknowable)', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: 'elsewhere', pid: 2 ** 22 + 1 } } })
      ).state
    ).toBe('running');
  });
});

/** archon 桩：get 依次返回 stub/get-<n>.json（最后一份重复），其余调用回 {"ok":true}；全部调用记入 calls。 */
function stub(responses: RunView[]): { dir: string; ledger: Ledger; calls: () => string[] } {
  const root = tmp();
  const dir = join(root, 'stub');
  mkdirSync(join(dir, 'used'), { recursive: true });
  responses.forEach((r, i) =>
    writeFileSync(join(dir, `get-${String(i).padStart(3, '0')}.json`), JSON.stringify(r))
  );
  const bin = join(dir, 'archon');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
if [ "$1 $2" = "workflow get" ]; then
  f=$(ls "${dir}"/get-*.json | head -1); cat "$f"
  [ "$(ls "${dir}"/get-*.json | wc -l)" -gt 1 ] && mv "$f" "${dir}/used/"
  exit 0
fi
echo '{"ok":true}'
`
  );
  chmodSync(bin, 0o755);
  const home = join(root, 'home');
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(home, 'archon'), { recursive: true });
  Object.assign(process.env, {
    SA_ARCHON_BIN: bin,
    SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'),
  });
  const ledger: Ledger = {
    run_id: 'sa1',
    archon_run_id: 'r',
    plan: '',
    gen_dir: '',
    repo: root,
    branch: 'sa/sa1',
    workflow: 'sa-sa1',
    console: 'claude',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
  };
  writeFileSync(join(home, 'runs', 'sa1.json'), JSON.stringify(ledger));
  return { dir, ledger, calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') };
}

describe('waitRun (archon stub)', () => {
  test('running then completed: waits in slices, returns 0 with land commands', () => {
    const s = stub([
      run('running', { nodes: [{ nodeId: 'a', state: 'running' }] }),
      run('completed', { output_root: '/none', nodes: [{ nodeId: 'a', state: 'completed' }] }),
    ]);
    const out = waitRun(s.ledger, 60);
    expect(out).toMatchObject({
      run_id: 'sa1',
      state: 'completed',
      exit: 0,
      nodes: '1/1 completed',
    });
    expect(s.calls().filter(c => c.startsWith('workflow wait'))).toHaveLength(1);
  });
  test('timeout while running returns 4 without blocking past deadline', () => {
    const s = stub([run('running')]);
    expect(waitRun(s.ledger, 0)).toMatchObject({ state: 'running', exit: EXIT.running });
  });
  test('held gate surfaces the gate verdict file', () => {
    const s = stub([
      run('failed', { output_root: '/x', nodes: [{ nodeId: 'gate-m1', state: 'failed' }] }),
    ]);
    const art = join('/x', 'artifacts', 'runs', 'r');
    expect(waitRun(s.ledger, 5)).toMatchObject({
      state: 'held:gate',
      exit: EXIT.held,
      node: 'gate-m1',
      evidence: art,
    });
  });
  test('owner_lost: flips row to failed, resumes, records recovery, then completes', () => {
    const lost = run('running', {
      metadata: { execution_owner: { host: hostname(), pid: 2 ** 22 + 1 } },
    });
    const s = stub([lost, lost, run('completed')]);
    const db = new Database(join(process.env.ARCHON_HOME ?? '', 'archon.db'));
    db.run('create table remote_agent_workflow_runs (id text, status text)');
    db.run("insert into remote_agent_workflow_runs values ('r', 'running')");
    const out = waitRun(s.ledger, 30);
    expect(out).toMatchObject({ state: 'completed', recoveries: 1 });
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'failed',
    });
    expect(s.calls()).toContain('workflow resume r --detach --json');
    expect(loadLedger('sa1').recoveries).toHaveLength(1);
    db.close();
  });
});

describe('verbs (archon stub)', () => {
  test('status prints summary and exits with the classified code', () => {
    stub([
      run('paused', {
        metadata: {
          wait: { nodeId: 'human-m1', kind: 'event', event: 'sa.human.m1', resumeAt: 't' },
        },
      }),
    ]);
    expect(main(['status', 'sa1'])).toBe(EXIT.held);
  });
  test('cancel calls archon workflow cancel with the archon run id', () => {
    const s = stub([run('running')]);
    expect(main(['cancel', 'sa1'])).toBe(0);
    expect(s.calls()).toContain('workflow cancel r --json');
  });
  test('get returns ledger and archon view', () => {
    stub([run('completed')]);
    expect(main(['get', 'sa1'])).toBe(0);
  });
  test('resume refuses a run whose owner may be alive', () => {
    stub([run('running', { metadata: { execution_owner: { host: 'elsewhere', pid: 1 } } })]);
    expect(main(['resume', 'sa1'])).toBe(1);
  });
  test('unknown run id fails clearly', () => {
    stub([]);
    expect(() => main(['wait', 'nope'])).toThrow(/unknown run nope/);
  });
  test('unknown verb prints usage and exits 64', () => {
    expect(main(['frobnicate'])).toBe(64);
  });
});

test('run --fake end to end: real archon executes the generated DAG to completion', () => {
  const root = tmp();
  const repo = gitRepo(root);
  const plan = fixturePlan(root, repo);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home', 'archon'),
    SUPERAGENT_WRITE_ROOTS: root,
    SA_ARCHON_BIN: '',
  };
  const sa = (...args: string[]): { code: number; out: Record<string, unknown>; err: string } => {
    const p = Bun.spawnSync([BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    return {
      code: p.exitCode,
      out: JSON.parse(p.stdout.toString() || '{}') as Record<string, unknown>,
      err: p.stderr.toString(),
    };
  };
  expect(
    Bun.spawnSync([join(import.meta.dir, '..', 'scripts', 'install.sh')], { env }).exitCode
  ).toBe(0);
  expect(sa('run', plan).err).toContain('no passing selftest'); // 无 selftest.json：preflight 拒绝
  const started = sa('run', plan, '--fake', '--skip-selftest');
  expect(started.err).toBe('');
  expect(started.code).toBe(0);
  const id = String(started.out.run_id);
  const waited = sa('wait', id, '--timeout', '180');
  expect(waited.out).toMatchObject({ state: 'completed', exit: 0, nodes: '8/8 completed' });
  expect((waited.out.land as string[])[1]).toContain(`merge --ff-only 'sa/${id}'`);
  expect(readdirSync(join(root, 'home', 'runs'))).toEqual([`${id}.json`]);
  expect(sa('status', id).code).toBe(0);
  expect(existsSync(String(waited.out.evidence))).toBe(true);
}, 240000);
