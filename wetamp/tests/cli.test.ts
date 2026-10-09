import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  cpSync,
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
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const BIN = join(import.meta.dir, '..', 'bin', 'superagent');
const run = (status: RunView['status'], extra: Partial<RunView> = {}): RunView => ({
  id: 'r',
  status,
  ...extra,
});

describe('parseArgs', () => {
  test('positionals, --k v, --k=v and boolean flags', () => {
    expect(parseArgs(['wait', 'x', '--timeout', '5', '--pkg=core', '--fake'])).toEqual({
      _: ['wait', 'x'],
      flags: { timeout: '5', pkg: 'core', fake: true },
    });
  });
  test('unknown flags fail instead of being ignored', () => {
    expect(() => parseArgs(['run', 'p.json', '--skip-selftests'])).toThrow(/Unknown option/);
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

/**
 * archon 桩：get 依次返回 stub/get-<n>.json（最后一份重复）；run 回 runId=r；其余调用回 {"ok":true}；
 * 全部调用记入 calls。ledger 的 gen_dir 含 plan.json（core、api 两包）与 hints/。
 */
function stub(responses: RunView[]): {
  dir: string;
  root: string;
  ledger: Ledger;
  calls: () => string[];
} {
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
[ "$1 $2" = "workflow run" ] && { echo '{"ok":true,"runId":"r"}'; exit 0; }
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
    gen_dir: join(root, 'gen'),
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
  mkdirSync(join(root, 'gen', 'hints'), { recursive: true });
  writeFileSync(
    join(root, 'gen', 'plan.json'),
    JSON.stringify({ packages: [{ id: 'core' }, { id: 'api' }] })
  );
  const calls = (): string[] =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
      : [];
  return { dir, root, ledger, calls };
}

const humanWait = (resumeAt = '2099-01-01T00:00:00.000Z'): RunView =>
  run('paused', {
    metadata: { wait: { nodeId: 'human-m2', kind: 'event', event: 'sa.human.m2', resumeAt } },
  });

/** 后台子进程（signal/wake）异步写 calls：轮询到出现为止。 */
async function eventually(calls: () => string[], prefix: string): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    const hit = calls().find(c => c.startsWith(prefix));
    if (hit) return hit;
    await Bun.sleep(50);
  }
  return undefined;
}

/** main() 打印的 stdout 文本。 */
function captured(fn: () => number): { code: number; out: string } {
  const spy = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const code = fn();
    return { code, out: spy.mock.calls.map(c => String(c[0])).join('\n') };
  } finally {
    spy.mockRestore();
  }
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

describe('run (archon stub)', () => {
  const start = (console?: string): string[] => {
    const s = stub([]);
    const repo = gitRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const plan = fixturePlan(s.root, repo, p => (console ? (p.console = console) : undefined));
    expect(captured(() => main(['run', plan, '--skip-selftest'])).code).toBe(0);
    return s.calls().filter(c => c.startsWith('workflow run'));
  };
  test('console=codex rebinds @sa-reviewer to the codex-console pool', () => {
    expect(start('codex')[0]).toEndWith('--model @sa-reviewer=@sa-reviewer-codex --json');
  });
  test('console=claude keeps the default reviewer alias', () => {
    expect(start()[0]).not.toContain('--model');
  });
});

describe('decide (archon stub)', () => {
  test('approve signals the exact wait occurrence in the background', async () => {
    const s = stub([humanWait(), run('running')]);
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(0);
    expect(await eventually(s.calls, 'workflow signal')).toBe(
      'workflow signal r --event sa.human.m2 --resume-at 2099-01-01T00:00:00.000Z --data {"decision":"approve"} --json'
    );
  });
  test('approve refuses a run that is not at a signoff gate', () => {
    const s = stub([run('running')]);
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(1);
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
  });
  test('reject cancels the run', () => {
    const s = stub([humanWait()]);
    expect(captured(() => main(['decide', 'sa1', 'reject'])).code).toBe(0);
    expect(s.calls()).toContain('workflow cancel r --json');
  });
  test('retry --hint writes the package hint, then resumes', () => {
    const failed = run('failed', { nodes: [{ nodeId: 'code-core', state: 'failed' }] });
    const s = stub([failed, failed]);
    expect(
      captured(() => main(['decide', 'sa1', 'retry', '--pkg', 'core', '--hint', 'use X'])).code
    ).toBe(0);
    expect(readFileSync(join(s.root, 'gen', 'hints', 'core.md'), 'utf8')).toBe('use X\n');
    expect(s.calls()).toContain('workflow resume r --detach --json');
  });
  test('retry --hint rejects a package outside the plan (no path from user text)', () => {
    stub([run('failed')]);
    expect(() => main(['decide', 'sa1', 'retry', '--pkg', '../x', '--hint', 'h'])).toThrow(/--pkg/);
  });
  test('retry on an escalated gate fails clearly instead of re-running the same verdict', () => {
    stub([run('failed', { nodes: [{ nodeId: 'gate-m1-r3', state: 'failed' }] })]);
    expect(() => main(['decide', 'sa1', 'retry'])).toThrow(/gate-m1-r3 escalated/);
  });
});

describe('brief / land (archon stub)', () => {
  const withArtifacts = (status: RunView['status'], files: Record<string, unknown>): string => {
    const s = stub([]);
    const art = join(s.root, 'out', 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    for (const [f, v] of Object.entries(files)) writeFileSync(join(art, f), JSON.stringify(v));
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(run(status, { output_root: join(s.root, 'out') }))
    );
    return art;
  };
  test('brief: one line per gate round with verdict, reason and debt count, ≤20 lines', () => {
    const art = withArtifacts('completed', {
      'gate-m1-r1.json': { verdict: 'fix', reason: 'review_failed', debt: [] },
      'gate-m1-r1.review.json': {},
      'gate-m1-r2.json': { verdict: 'pass', reason: null, debt: ['d1'] },
      'land.json': { commands: ['git switch main', 'git merge --ff-only sa/sa1'] },
    });
    const { code, out } = captured(() => main(['brief', 'sa1']));
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toStartWith('sa1 completed');
    expect(lines).toContain('gate-m1-r1: fix (review_failed) debt=0');
    expect(lines).toContain('gate-m1-r2: pass debt=1');
    expect(lines).toContain('git merge --ff-only sa/sa1');
    expect(lines).toContain(`evidence: ${art}`);
    expect(lines.length).toBeLessThanOrEqual(20);
  });
  test('report: states, review rounds, first pass, escalations, node seconds, debt, recoveries', () => {
    const art = withArtifacts('failed', {
      'gate-m1-r1.json': { verdict: 'pass', reason: null, debt: ['d1', 'd2'] },
      'gate-m2-r1.json': { verdict: 'fix', reason: 'review_failed', debt: [] },
      'gate-m2-r2.json': { verdict: 'fix', reason: 'review_failed', debt: [] },
      'gate-m2-r3.json': { verdict: 'escalate', reason: 'review_failed+review_limit', debt: [] },
    });
    const nodes = [
      { nodeId: 'code-core', state: 'completed', durationMs: 61_400 },
      { nodeId: 'review-m1-r1', state: 'completed', durationMs: 30_000 },
      { nodeId: 'gate-m2-r3', state: 'failed', durationMs: 100 },
    ];
    const root = join(art, '..', '..', '..', '..');
    writeFileSync(
      join(root, 'stub', 'get-000.json'),
      JSON.stringify(run('failed', { output_root: join(root, 'out'), nodes }))
    );
    const home = process.env.SUPERAGENT_HOME ?? '';
    const l = JSON.parse(readFileSync(join(home, 'runs', 'sa1.json'), 'utf8')) as Ledger;
    writeFileSync(join(home, 'runs', 'sa1.json'), JSON.stringify({ ...l, recoveries: ['t'] }));
    const { code, out } = captured(() => main(['report']));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      runs: 1,
      debt: 2,
      'escalate:review_failed+review_limit': 1,
      first_pass: 1,
      'node_s:code': 61,
      'node_s:gate': 0,
      'node_s:review': 30,
      recoveries: 1,
      'rounds:1': 1,
      'rounds:3': 1,
      'state:held:gate': 1,
      unreadable: [],
    });
    // 读不到的 run 单列并以 1 退出，不吞错
    writeFileSync(
      join(home, 'runs', 'gone.json'),
      JSON.stringify({ ...l, run_id: 'gone', repo: join(root, 'nope') })
    );
    const bad = captured(() => main(['report']));
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.out) as { unreadable: string[] }).unreadable[0]).toStartWith('gone: ');
  });
  test('land prints land.json; exits 1 before the land node ran', () => {
    withArtifacts('completed', { 'land.json': { commands: ['c'] } });
    expect(captured(() => main(['land', 'sa1'])).out).toContain('"c"');
    withArtifacts('running', {});
    expect(captured(() => main(['land', 'sa1'])).code).toBe(1);
  });
});

test('accept runs the plan acceptance in the run worktree; --pkg narrows it', () => {
  const s = stub([]);
  const wt = gitRepo(s.root);
  writeFileSync(
    join(s.dir, 'get-000.json'),
    JSON.stringify(run('completed', { working_path: wt }))
  );
  const scripts = join(s.root, 'gen', '.archon', 'scripts');
  cpSync(join(import.meta.dir, '..', 'templates', '.archon', 'scripts'), scripts, {
    recursive: true,
  });
  const check = (cmd: string): unknown => [{ cmd, timeout_s: 10 }];
  writeFileSync(
    join(s.root, 'gen', 'plan.json'),
    JSON.stringify({
      packages: [
        { id: 'core', accept: check('test -f README.md') },
        { id: 'api', accept: check('false') },
      ],
    })
  );
  expect(captured(() => main(['accept', 'sa1', '--pkg', 'core'])).code).toBe(0);
  expect(captured(() => main(['accept', 'sa1'])).code).toBe(1);
  expect(() => main(['accept', 'sa1', '--pkg', 'nope'])).toThrow(/unknown package/);
});

describe('supervise-tick (archon + supervisor stubs)', () => {
  /** supervisor.py 桩：ask 回固定 id；ask-status 回 answer 文件内容；调用记入 sup-calls。 */
  const supervisor = (root: string, answer: string): (() => string[]) => {
    const py = join(root, 'supervisor.py');
    writeFileSync(
      py,
      `import os, sys\nd = os.path.dirname(os.path.abspath(__file__))\nopen(os.path.join(d, 'sup-calls'), 'a').write(' '.join(sys.argv[1:]) + '\\n')\nprint('ask-1' if sys.argv[1] == 'ask' else open(os.path.join(d, 'answer')).read().strip())\n`
    );
    writeFileSync(join(root, 'answer'), answer);
    process.env.SA_SUPERVISOR = py;
    return () => readFileSync(join(root, 'sup-calls'), 'utf8').trim().split('\n');
  };
  const tick = (): Record<string, unknown>[] => {
    const { code, out } = captured(() => main(['supervise-tick']));
    expect(code).toBe(0);
    return JSON.parse(out) as Record<string, unknown>[];
  };
  test('held:human: asks once, then approves on yes (signal) and wakes due waits', async () => {
    const s = stub([humanWait(), humanWait(), run('running')]);
    const sup = supervisor(s.root, 'yes');
    expect(tick()).toEqual([
      { run_id: 'sa1', event: 'sa.human.m2', action: 'ask', ok: true, ask: 'ask-1' },
    ]);
    expect(sup()[0]).toMatch(/^ask --question superagent sa1 m2 红线签收.* --ttl-hours 72$/);
    expect(tick()[0]).toMatchObject({ action: 'approve', ok: true });
    expect(await eventually(s.calls, 'workflow signal r --event sa.human.m2')).toBeDefined();
    expect(await eventually(s.calls, 'workflow wake --json')).toBeDefined();
    expect(sup()).toEqual([expect.stringMatching(/^ask /), 'ask-status ask-1']);
  });
  test('pending keeps waiting; no cancels the run', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    tick();
    expect(tick()[0]).toMatchObject({ action: 'none', ask: 'pending' });
    writeFileSync(join(s.root, 'answer'), 'no');
    expect(tick()[0]).toMatchObject({ action: 'reject', ok: true });
    expect(s.calls()).toContain('workflow cancel r --json');
  });
  test('ttl follows the wait deadline (≥1h)', () => {
    const s = stub([humanWait(new Date(Date.now() + 5 * 3600e3).toISOString())]);
    const sup = supervisor(s.root, 'pending');
    tick();
    expect(sup()[0]).toEndWith('--ttl-hours 5');
  });
  test('owner_lost run is recovered and recorded', () => {
    const lost = run('running', {
      metadata: { execution_owner: { host: hostname(), pid: 2 ** 22 + 1 } },
    });
    const s = stub([lost, run('failed')]);
    supervisor(s.root, 'pending');
    const db = new Database(join(process.env.ARCHON_HOME ?? '', 'archon.db'));
    db.run('create table remote_agent_workflow_runs (id text, status text)');
    db.run("insert into remote_agent_workflow_runs values ('r', 'running')");
    db.close();
    expect(tick()[0]).toMatchObject({ action: 'recover', ok: true });
    expect(loadLedger('sa1').recoveries).toHaveLength(1);
  });
});

test('run --fake end to end: fix loop in m1, human signoff in m2, approve, land', () => {
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
  const sa = (
    ...args: string[]
  ): { code: number; out: Record<string, unknown>; text: string; err: string } => {
    const p = Bun.spawnSync([BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const text = p.stdout.toString();
    const json = text.startsWith('{') || text === '';
    return {
      code: p.exitCode,
      out: json ? (JSON.parse(text || '{}') as Record<string, unknown>) : {},
      text,
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
  const held = sa('wait', id, '--timeout', '180');
  expect(held.out).toMatchObject({ state: 'held:human', exit: EXIT.held, node: 'human-m2' });
  // m1：首轮评审 FAIL → fix-m1-r2 → 第 2 轮 PASS；第 3 轮被条件跳过，汇合节点仍放行 m2
  const brief = sa('brief', id).text.split('\n');
  expect(brief).toContain('gate-m1-r1: fix (review_failed) debt=0');
  expect(brief).toContain('gate-m1-r2: pass debt=0');
  expect(brief).toContain('gate-m2-r2: pass debt=0');
  expect(sa('land', id).code).toBe(1);
  expect(sa('decide', id, 'approve').code).toBe(0);
  const waited = sa('wait', id, '--timeout', '120');
  expect(waited.out).toMatchObject({ state: 'completed', exit: 0 });
  expect((waited.out.land as string[])[1]).toContain(`merge --ff-only 'sa/${id}'`);
  expect(readdirSync(join(root, 'home', 'runs'))).toEqual([`${id}.json`]);
  expect(sa('status', id).code).toBe(0);
  expect(sa('land', id).out).toMatchObject({ branch: `sa/${id}` });
  expect(sh(`git log --format=%s sa/${id}`, repo)).toContain('fake fix m1 r2');
  expect(existsSync(String(waited.out.evidence))).toBe(true);
}, 240000);
