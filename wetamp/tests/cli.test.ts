import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as archonMod from '../src/archon';
import type { RunView } from '../src/archon';
import {
  classify,
  EXIT,
  EXIT_ALIAS_DRIFT,
  EXIT_USAGE,
  loadLedger,
  main,
  parseArgs,
  waitRun,
  type Ledger,
} from '../src/cli';
import { renderAliases, loadTiers } from '../src/config';
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
  test('main: unknown flag exits 64 with usage; --json is an accepted no-op on any verb', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['status', 'x', '--frob'])).toBe(EXIT_USAGE);
      expect(String(err.mock.calls[0]?.[0])).toContain('usage: superagent');
    } finally {
      err.mockRestore();
    }
    expect(parseArgs(['report', '--json']).flags).toEqual({ json: true });
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
 * 全部调用记入 calls。cancel/abandon 按引擎契约对桩内当前状态（下一次 get 返回的那份）执行：cancel 只接受
 * running，abandon 拒绝 completed/cancelled，拒绝时与真 CLI 一样回 {"ok":false,"error":<文本>}。
 * ledger 的 gen_dir 含 plan.json（core、api 两包）与 hints/。
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
cur=$(ls "${dir}"/get-*.json 2>/dev/null | head -1)
st=$([ -n "$cur" ] && grep -o '"status":"[a-z]*"' "$cur" | head -1 | cut -d'"' -f4)
case "$1 $2:$st" in
  "workflow cancel:running") ;;
  "workflow cancel:"*) echo "{\\"ok\\":false,\\"action\\":\\"cancel\\",\\"error\\":\\"Cannot cancel run with status '$st'. Only a running run has live work to stop; abandon a paused or failed run instead.\\"}"; exit 0;;
  "workflow abandon:completed"|"workflow abandon:cancelled") echo "{\\"ok\\":false,\\"action\\":\\"abandon\\",\\"error\\":\\"Cannot abandon run with status '$st'.\\"}"; exit 0;;
esac
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
    AGENT_SUPERVISOR_STATE: join(root, 'sv-state'),
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

const LOST = { host: hostname(), pid: 2 ** 22 + 1 };
/** archon.db 的 runs 表（只含 recover 读写的列），行 r 处于 running、metadata 记着 owner。 */
function runsDb(owner: { host: string; pid: number }): Database {
  const db = new Database(join(process.env.ARCHON_HOME ?? '', 'archon.db'));
  db.run('create table remote_agent_workflow_runs (id text, status text, metadata text)');
  db.run("insert into remote_agent_workflow_runs values ('r', 'running', ?)", [
    JSON.stringify({ execution_owner: owner }),
  ]);
  return db;
}

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
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost, lost, run('completed')]);
    const db = runsDb(LOST);
    const out = waitRun(s.ledger, 30);
    expect(out).toMatchObject({ state: 'completed', recoveries: 1 });
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'failed',
    });
    expect(s.calls()).toContain('workflow resume r --detach --json');
    expect(loadLedger('sa1').recoveries).toHaveLength(1);
    expect(loadLedger('sa1').stalled).toBe(1);
    db.close();
  });
  test('owner taken over between get and flip → owner_changed, row untouched, no resume', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost]);
    const db = runsDb({ host: hostname(), pid: process.pid });
    expect(waitRun(s.ledger, 5)).toMatchObject({ reason: 'owner_changed', exit: EXIT.failed });
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'running',
    });
    expect(s.calls().some(c => c.startsWith('workflow resume'))).toBe(false);
    db.close();
  });
  test('a held recover lock serializes: second recover is refused without touching the run', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    stub([lost]);
    const db = runsDb(LOST);
    const held = archonMod.lock(join(process.env.SUPERAGENT_HOME ?? '', 'runs', 'r.lock'));
    if (!held.ok) throw new Error('lock not taken');
    try {
      const { code, out } = captured(() => main(['resume', 'sa1']));
      expect(code).toBe(1);
      expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'recover_locked' });
    } finally {
      held.release();
    }
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'running',
    });
    db.close();
  });
  test('a leftover lock file nobody holds (empty, junk, or a dead pid) does not block recover', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    for (const junk of ['', '{"pid":', JSON.stringify({ ...LOST, at: '' })]) {
      const s = stub([lost, lost, run('completed')]);
      runsDb(LOST).close();
      writeFileSync(join(s.root, 'home', 'runs', 'r.lock'), junk);
      expect(waitRun(s.ledger, 30)).toMatchObject({ state: 'completed', recoveries: 1 });
    }
  });
  test('3 recoveries without new completed nodes → held:recover_no_progress, no 4th resume', () => {
    const lost = run('running', {
      metadata: { execution_owner: LOST },
      nodes: [{ nodeId: 'a', state: 'completed' }],
    });
    // 每次 recover 后桩 DB 的行复位为 running，模拟恢复出的进程又死在同一位置
    const s = stub([lost]);
    const db = runsDb(LOST);
    const again = (): void => {
      db.run("update remote_agent_workflow_runs set status='running'");
    };
    for (let i = 0; i < 3; i++) {
      expect(main(['resume', 'sa1'])).toBe(0);
      again();
    }
    expect(loadLedger('sa1')).toMatchObject({ stalled: 3 });
    const out = waitRun(loadLedger('sa1'), 5);
    expect(out).toMatchObject({ state: 'held:recover_no_progress', exit: EXIT.held });
    expect(main(['resume', 'sa1'])).toBe(1);
    expect(s.calls().filter(c => c.startsWith('workflow resume'))).toHaveLength(3);
    // decide retry 是元帅的显式决定：清零重计，恢复一次
    expect(main(['decide', 'sa1', 'retry'])).toBe(0);
    expect(loadLedger('sa1')).toMatchObject({ stalled: 1 });
    db.close();
  });
  test('interleaved recovers at stalled=2: the count is on disk before the lock is released, so only one resumes', () => {
    const lost = run('running', {
      metadata: { execution_owner: LOST },
      nodes: [{ nodeId: 'a', state: 'completed' }],
    });
    const s = stub([lost]);
    const db = runsDb(LOST);
    const ledgerFile = join(process.env.SUPERAGENT_HOME ?? '', 'runs', 'sa1.json');
    expect(main(['resume', 'sa1'])).toBe(0);
    const fp = loadLedger('sa1').progress_fp;
    writeFileSync(ledgerFile, JSON.stringify({ ...s.ledger, progress_fp: fp, stalled: 2 }));
    db.run("update remote_agent_workflow_runs set status='running'");
    // 第二次 recover 恰在第一次释放锁之后、返回调用方之前进入
    const real = archonMod.recover;
    let second: unknown;
    const spy = spyOn(archonMod, 'recover').mockImplementation((...args) => {
      const r = real(...args);
      if (second === undefined) {
        second = null;
        db.run("update remote_agent_workflow_runs set status='running'");
        second = captured(() => main(['resume', 'sa1']));
      }
      return r;
    });
    try {
      expect(main(['resume', 'sa1'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(second).toMatchObject({ code: 1, out: expect.stringContaining('recover_no_progress') });
    expect(loadLedger('sa1')).toMatchObject({ stalled: 3 });
    expect(s.calls().filter(c => c.startsWith('workflow resume'))).toHaveLength(2);
    db.close();
  });
  test('progress between recoveries resets the stall count', () => {
    const at = (done: string[]): RunView =>
      run('running', {
        metadata: { execution_owner: LOST },
        nodes: done.map(nodeId => ({ nodeId, state: 'completed' })),
      });
    const s = stub([at(['a'])]);
    const db = runsDb(LOST);
    writeFileSync(
      join(process.env.SUPERAGENT_HOME ?? '', 'runs', 'sa1.json'),
      JSON.stringify({ ...s.ledger, progress_fp: 'older', stalled: 3 })
    );
    expect(main(['resume', 'sa1'])).toBe(0);
    expect(loadLedger('sa1')).toMatchObject({ stalled: 1 });
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
  test('cancel: a running run goes through archon workflow cancel with the archon run id', () => {
    const s = stub([run('running')]);
    expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
    expect(s.calls()).toContain('workflow cancel r --json');
    expect(s.calls().some(c => c.startsWith('workflow abandon'))).toBe(false);
  });
  test('cancel: a paused or failed run is abandoned (the engine refuses cancel for them)', () => {
    for (const r of [humanWait(), run('failed')]) {
      const s = stub([r]);
      expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
      expect(s.calls()).toContain('workflow abandon r --json');
      expect(s.calls().some(c => c.startsWith('workflow cancel'))).toBe(false);
    }
  });
  test('cancel: a run that paused between get and cancel is re-read and abandoned', () => {
    const s = stub([run('running'), humanWait()]);
    expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
    expect(s.calls().filter(c => /^workflow (cancel|abandon)/.test(c))).toEqual([
      'workflow cancel r --json',
      'workflow abandon r --json',
    ]);
  });
  test('cancel: a completed run is refused by abandon and exits 1', () => {
    const s = stub([run('completed')]);
    const { code, out } = captured(() => main(['cancel', 'sa1']));
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ run_id: 'sa1', ok: false });
    expect(s.calls()).toContain('workflow abandon r --json');
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
  /** workflow run 的 --config 文件里钉住的别名。 */
  const pinned = (call: string): Record<string, unknown> => {
    const m = /--config (\S+)/.exec(call);
    expect(m).not.toBeNull();
    return (
      Bun.YAML.parse(readFileSync(m?.[1] ?? '', 'utf8')) as { aliases: Record<string, unknown> }
    ).aliases;
  };
  const want = renderAliases(loadTiers());
  test('console=codex pins @sa-reviewer to the codex-console pool via the run config layer', () => {
    const call = start('codex')[0];
    expect(call).not.toContain('--model');
    expect(pinned(call)).toEqual({
      '@sa-coder': want['@sa-coder'],
      '@sa-reviewer': want['@sa-reviewer-codex'],
      '@sa-reviewer-alt': want['@sa-reviewer-alt-codex'],
    });
  });
  test('console=claude pins the concrete claude-console models, effort included', () => {
    const a = pinned(start()[0]);
    expect(a['@sa-reviewer']).toEqual(want['@sa-reviewer']);
    expect(a['@sa-coder']).toMatchObject({ effort: 'high' });
  });
  const drifted = (where: 'global' | 'repo'): { code: number; out: string; calls: string[] } => {
    const s = stub([]);
    const repo = gitRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const dir = where === 'global' ? join(s.root, 'home', 'archon') : join(repo, '.archon');
    mkdirSync(dir, { recursive: true });
    const alias = { ...want['@sa-reviewer'], model: 'other-model' };
    writeFileSync(
      join(dir, 'config.yaml'),
      Bun.YAML.stringify({ aliases: { '@sa-reviewer': alias } })
    );
    const r = captured(() => main(['run', fixturePlan(s.root, repo), '--skip-selftest']));
    return { ...r, calls: s.calls() };
  };
  test('a target repo @sa-* alias that differs from tiers refuses to start with exit 5', () => {
    const r = drifted('repo');
    expect(r.code).toBe(EXIT_ALIAS_DRIFT);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, reason: 'alias_drift' });
    expect(r.calls.some(c => c.startsWith('workflow run'))).toBe(false);
  });
  test('a drifted global alias also refuses; health --cwd runs the same check', () => {
    expect(drifted('global').code).toBe(EXIT_ALIAS_DRIFT);
    const repo = join(process.env.SUPERAGENT_HOME ?? '', '..', 'repo');
    const h = captured(() => main(['health', '--cwd', repo]));
    expect(h.code).toBe(EXIT_ALIAS_DRIFT);
    expect((JSON.parse(h.out) as { alias_drift: string[] }).alias_drift).toHaveLength(1);
  }, 30000);
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
  test('approve past the plan deadline is refused without signalling', () => {
    const s = stub([humanWait(), run('running')]);
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2020-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    const { code, out } = captured(() => main(['decide', 'sa1', 'approve']));
    expect(code).toBe(1);
    expect(out).toContain('deadline');
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
  });
  test('reject ends the paused run through abandon', () => {
    const s = stub([humanWait()]);
    expect(captured(() => main(['decide', 'sa1', 'reject'])).code).toBe(0);
    expect(s.calls()).toContain('workflow abandon r --json');
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
    const { usage, ...counts } = JSON.parse(out) as Record<string, unknown>;
    // 桩输出没有事件：没有调用，用量是 unknown 而不是 0（F-22 细节见 report.test.ts）
    expect(usage).toMatchObject({ total: { calls: 0, input: 'unknown' }, unreadable: [] });
    expect(counts).toEqual({
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
    expect(sup()[0]).toMatch(/^ask --question superagent sa1:m2:0 红线签收.* --ttl-hours 72$/);
    expect(tick()[0]).toMatchObject({ action: 'approve', ok: true });
    expect(await eventually(s.calls, 'workflow signal r --event sa.human.m2')).toBeDefined();
    expect(await eventually(s.calls, 'workflow wake --json')).toBeDefined();
    expect(sup()).toEqual([expect.stringMatching(/^ask /), 'ask-status ask-1']);
  });
  test('pending keeps waiting; no abandons the paused run', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    tick();
    expect(tick()[0]).toMatchObject({ action: 'none', ask: 'pending' });
    writeFileSync(join(s.root, 'answer'), 'no');
    expect(tick()[0]).toMatchObject({ action: 'reject', ok: true });
    expect(s.calls()).toContain('workflow abandon r --json');
  });
  test('ttl follows the wait deadline (≥1h)', () => {
    const s = stub([humanWait(new Date(Date.now() + 5 * 3600e3).toISOString())]);
    const sup = supervisor(s.root, 'pending');
    tick();
    expect(sup()[0]).toEndWith('--ttl-hours 5');
  });
  test('ask key is run:milestone:round: a re-wait after recover (new resumeAt) does not ask again', () => {
    const s = stub([humanWait('2099-01-01T00:00:00.000Z'), humanWait('2099-02-01T00:00:00.000Z')]);
    const sup = supervisor(s.root, 'pending');
    tick();
    expect(tick()[0]).toMatchObject({ action: 'none', ask: 'pending' });
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
    const asks = JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8')) as object;
    expect(Object.keys(asks)).toEqual(['sa1:m2:0']);
  });
  test('the ledger holds an unknown entry before supervisor ask runs; an id-less entry with no supervisor record is re-asked', () => {
    const s = stub([humanWait()]);
    const py = join(s.root, 'sup-snap.py');
    writeFileSync(
      py,
      `import os, shutil, sys\nshutil.copy('${s.root}/home/asks.json', '${s.root}/at-ask.json')\nprint('ask-1')\n`
    );
    process.env.SA_SUPERVISOR = py;
    tick();
    expect(JSON.parse(readFileSync(join(s.root, 'at-ask.json'), 'utf8'))).toEqual({
      'sa1:m2:0': { status: 'unknown' },
    });
    // 模拟上次 tick 在 ask 期间死掉且 supervisor 没有落下记录：重投
    writeFileSync(join(s.root, 'home', 'asks.json'), '{"sa1:m2:0":{"status":"unknown"}}');
    rmSync(join(s.root, 'at-ask.json'));
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true, ask: 'ask-1' });
    expect(existsSync(join(s.root, 'at-ask.json'))).toBe(true);
  });
  test('an ask that saved its record then exited non-zero stays unknown; the next tick reconciles via ask-status instead of asking again', () => {
    const s = stub([humanWait()]);
    const sup = supervisor(s.root, 'pending');
    const state = join(s.root, 'sv-state', 'asks');
    // 桩 ask：像 supervisor create() 一样先落记录，再在投递阶段失败
    writeFileSync(
      join(s.root, 'supervisor.py'),
      `import json, os, sys\nd = os.path.dirname(os.path.abspath(__file__))\nopen(os.path.join(d, 'sup-calls'), 'a').write(' '.join(sys.argv[1:]) + '\\n')\nif sys.argv[1] == 'ask':\n    os.makedirs('${state}', exist_ok=True)\n    json.dump({'id': 'abc', 'question': sys.argv[3], 'status': 'pending'}, open('${state}/abc.json', 'w'))\n    sys.exit(3)\nprint(open(os.path.join(d, 'answer')).read().strip())\n`
    );
    expect(captured(() => main(['supervise-tick'])).code).toBe(1);
    const asks = (): unknown => JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'));
    expect(asks()).toEqual({ 'sa1:m2:0': { status: 'unknown' } });
    expect(tick()[0]).toMatchObject({ action: 'none', ok: true, ask: 'pending' });
    expect(sup().filter(c => c.startsWith('ask '))).toHaveLength(1);
    expect(sup().at(-1)).toBe('ask-status abc');
    expect(asks()).toEqual({ 'sa1:m2:0': { id: 'abc', status: 'pending' } });
  });
  test('a held supervise.lock makes a concurrent tick skip with exit 0 and touch nothing', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    const held = archonMod.lock(join(s.root, 'home', 'supervise.lock'));
    if (!held.ok) throw new Error('lock not taken');
    const { code, out } = captured(() => main(['supervise-tick']));
    held.release();
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ skipped: 'locked' });
    expect(s.calls()).toEqual([]);
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true });
  });
  test('held:human past the plan deadline: tick cancels (reason deadline), ask expired, supervisor untouched, brief says so', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'yes');
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2020-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      JSON.stringify({ 'sa1:m2:0': { id: 'ask-1', status: 'pending' } })
    );
    expect(tick()).toEqual([
      { run_id: 'sa1', event: 'sa.human.m2', action: 'cancel', ok: true, reason: 'deadline' },
    ]);
    expect(s.calls()).toContain('workflow abandon r --json');
    expect(existsSync(join(s.root, 'sup-calls'))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'))).toEqual({
      'sa1:m2:0': { id: 'ask-1', status: 'expired' },
    });
    expect(loadLedger('sa1')).toMatchObject({ state: 'failed', reason: 'deadline' });
    const lines = captured(() => main(['brief', 'sa1'])).out.split('\n');
    expect(lines).toContain('plan 截止已过，已取消');
    expect(lines).toContain('ask sa1:m2:0: expired');
  });
  test('a yes that arrives after the plan deadline passed is not signalled: the run is abandoned and the ask expired', () => {
    const s = stub([humanWait()]);
    const plan = join(s.root, 'gen', 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({ deadline: '2099-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    writeFileSync(
      join(s.root, 'home', 'asks.json'),
      JSON.stringify({ 'sa1:m2:0': { id: 'ask-1', status: 'pending' } })
    );
    // 桩 ask-status：截止恰在用户答“是”的期间过去
    const py = join(s.root, 'sup-late.py');
    writeFileSync(
      py,
      `import json\njson.dump({'deadline': '2020-01-01T00:00:00Z', 'packages': [{'id': 'core'}]}, open('${plan}', 'w'))\nprint('yes')\n`
    );
    process.env.SA_SUPERVISOR = py;
    expect(tick()).toEqual([
      { run_id: 'sa1', event: 'sa.human.m2', action: 'cancel', ok: true, reason: 'deadline' },
    ]);
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
    expect(s.calls()).toContain('workflow abandon r --json');
    expect(JSON.parse(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8'))).toEqual({
      'sa1:m2:0': { id: 'ask-1', status: 'expired' },
    });
    expect(loadLedger('sa1')).toMatchObject({ state: 'failed', reason: 'deadline' });
  });
  test('held:human before the plan deadline still asks; nothing is cancelled', () => {
    const s = stub([humanWait()]);
    supervisor(s.root, 'pending');
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2099-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    expect(tick()[0]).toMatchObject({ action: 'ask', ok: true });
    expect(s.calls().some(c => /^workflow (cancel|abandon)/.test(c))).toBe(false);
    expect(loadLedger('sa1').reason).toBeUndefined();
  });
  test('a null or malformed supervisor ask record is skipped and counted; the valid one is still reconciled', () => {
    const s = stub([humanWait()]);
    const sup = supervisor(s.root, 'pending');
    const state = join(s.root, 'sv-state', 'asks');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'a-null.json'), 'null');
    writeFileSync(join(state, 'b-bad.json'), '{"id":');
    writeFileSync(
      join(state, 'c-ok.json'),
      JSON.stringify({ id: 'abc', question: 'superagent sa1:m2:0 红线签收：批准合入 x？' })
    );
    writeFileSync(join(s.root, 'home', 'asks.json'), '{"sa1:m2:0":{"status":"unknown"}}');
    expect(tick()[0]).toMatchObject({
      action: 'none',
      ok: true,
      ask: 'pending',
      reason: '2 anomalous ask records',
    });
    expect(sup()).toEqual(['ask-status abc']);
  });
  test('owner_lost run is recovered and recorded', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost, run('failed')]);
    supervisor(s.root, 'pending');
    runsDb(LOST).close();
    expect(tick()[0]).toMatchObject({ action: 'recover', ok: true });
    expect(loadLedger('sa1').recoveries).toHaveLength(1);
  });
});

describe('auto retry (supervise-tick, archon stub)', () => {
  /** 失败在 failedNode 的 run；gen 带 attempt-m1 节点；artifacts 按 files 写入。 */
  const held = (failedNode: string, files: Record<string, unknown> = {}, attempt = true) => {
    const s = stub([]);
    const art = join(s.root, 'out', 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    for (const [f, v] of Object.entries(files)) writeFileSync(join(art, f), JSON.stringify(v));
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(
        run('failed', {
          output_root: join(s.root, 'out'),
          nodes: [{ nodeId: failedNode, state: 'failed' }],
        })
      )
    );
    const pkg = { accept: [], risk: 'G1', milestone: 'm1' };
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({
        deadline: '2099-01-01T00:00:00Z',
        packages: [
          { ...pkg, id: 'core' },
          { ...pkg, id: 'api' },
        ],
      })
    );
    const wf = join(s.root, 'gen', '.archon', 'workflows', 'sa-sa1');
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, 'sa-sa1.yaml'),
      attempt ? 'nodes:\n  - id: attempt-m1\n' : 'nodes: []\n'
    );
    return { ...s, art };
  };
  const tick = (): Record<string, unknown>[] => {
    const { code, out } = captured(() => main(['supervise-tick']));
    expect(code).toBe(0);
    return JSON.parse(out) as Record<string, unknown>[];
  };
  const resumes = (calls: string[]): number =>
    calls.filter(c => c.startsWith('workflow resume')).length;
  const gate = (reason: string) => ({ verdict: 'escalate', reason, milestone: 'm1', debt: [] });

  test('held:gate: writes hints for every package of the milestone, bumps the attempt, resumes; stops after N', () => {
    const log = join(tmp(), 'diff.log');
    writeFileSync(log, Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`).join('\n'));
    const s = held('gate-m1-r3', {
      'gate-m1-r3.json': gate('acceptance_failed+review_limit'),
      'gate-m1-r3.review.json': {
        status: 'FAIL',
        findings: [
          { id: 'R1-1', severity: 'high', file: 'a.ts', line: 3, status: 'open', evidence: 'boom' },
        ],
      },
      'diff-m1-r3.json': { failed: ['bun test'], base_pass: false, log },
    });
    expect(tick()[0]).toMatchObject({
      action: 'auto_retry',
      ok: true,
      state: 'held:gate',
      milestone: 'm1',
      reason: 'gate:acceptance_failed+review_limit',
      attempt: 1,
    });
    const hint = readFileSync(join(s.root, 'gen', 'hints', 'core.md'), 'utf8');
    for (const x of [
      '`bun test`',
      '此失败在基线已存在',
      '- R1-1 [high] a.ts:3 boom',
      'line 100',
      'gate reason：acceptance_failed+review_limit',
    ])
      expect(hint).toContain(x);
    expect(hint).not.toContain('line 40\n');
    expect(readFileSync(join(s.root, 'gen', 'hints', 'api.md'), 'utf8')).toBe(hint);
    expect(readFileSync(join(s.root, 'gen', 'attempts', 'm1'), 'utf8')).toBe('1');
    expect(resumes(s.calls())).toBe(1);
    expect(tick()[0]).toMatchObject({ action: 'auto_retry', attempt: 2 });
    // 追加不覆盖
    expect(
      readFileSync(join(s.root, 'gen', 'hints', 'core.md'), 'utf8').match(/## 自动重试/g)
    ).toHaveLength(2);
    expect(tick()[0]).toMatchObject({
      action: 'none',
      reason: 'auto_retry_exhausted',
      auto_retries: 2,
    });
    expect(resumes(s.calls())).toBe(2);
    const l = loadLedger('sa1');
    expect(l.auto_retries?.map(r => r.reason)).toEqual([
      'gate:acceptance_failed+review_limit',
      'gate:acceptance_failed+review_limit',
    ]);
    // 自动重试与 recover 停滞计数互不影响
    expect([l.recoveries.length, l.stalled ?? 0]).toEqual([0, 0]);
    const { out } = captured(() => main(['status', 'sa1']));
    expect(JSON.parse(out)).toMatchObject({ auto_retries: 2 });
  });
  test('two no_change gates in a row stop retrying', () => {
    const s = held('gate-m1-r2', { 'gate-m1-r2.json': gate('no_change') });
    expect(tick()[0]).toMatchObject({ action: 'auto_retry', attempt: 1 });
    expect(tick()[0]).toMatchObject({ action: 'none', reason: 'no_change' });
    expect(resumes(s.calls())).toBe(1);
  });
  test('needs[] or a red line keeps the run held and surfaces the needs', () => {
    const need = { cap: 'network', why: 'registry', minimal_ask: 'allow npm registry' };
    const s = held('gate-m1-r1', {
      'gate-m1-r1.json': gate('acceptance_failed'),
      'verify-core.coder.json': {
        status: 'blocked',
        error_class: 'env',
        needs: [need],
        milestone: 'm1',
      },
    });
    expect(tick()[0]).toMatchObject({
      action: 'none',
      reason: 'needs',
      needs: [{ tag: 'verify-core', ...need }],
    });
    const { out } = captured(() => main(['brief', 'sa1']));
    expect(out).toContain('need network (verify-core): allow npm registry');
    expect(resumes(s.calls())).toBe(0);
    const r = held('gate-m1-r1', {
      'gate-m1-r1.json': gate('acceptance_failed'),
      'verify-core.coder.json': {
        status: 'blocked',
        error_class: 'redline',
        needs: [],
        milestone: 'm1',
      },
    });
    expect(tick()[0]).toMatchObject({ action: 'none', reason: 'redline' });
    expect(resumes(r.calls())).toBe(0);
  });
  test('held:environment and a failed coder node are retried once without hints', () => {
    const e = held('environment');
    expect(tick()[0]).toMatchObject({ action: 'auto_retry', reason: 'environment' });
    expect(tick()[0]).toMatchObject({ action: 'none', reason: 'auto_retry_exhausted' });
    expect(resumes(e.calls())).toBe(1);
    const c = held('code-api');
    expect(tick()[0]).toMatchObject({
      action: 'auto_retry',
      milestone: 'm1',
      reason: 'coder:code-api',
    });
    expect(tick()[0]).toMatchObject({ action: 'none', reason: 'auto_retry_exhausted' });
    expect(existsSync(join(c.root, 'gen', 'hints', 'api.md'))).toBe(false);
    // 其他节点失败（验收脚本等）不自动重试
    held('verify-core');
    expect(tick()).toEqual([]);
  });
  test('a workflow generated before attempt nodes stays held; decide retry still refuses the gate', () => {
    const s = held('gate-m1-r3', { 'gate-m1-r3.json': gate('review_failed+review_limit') }, false);
    expect(tick()[0]).toMatchObject({ action: 'none', reason: 'no_attempt_node' });
    expect(() => main(['decide', 'sa1', 'retry'])).toThrow(/gate-m1-r3 escalated/);
    expect(resumes(s.calls())).toBe(0);
  });
  test('decide retry on held:gate bumps the attempt and resumes; --all-held retries every held run', () => {
    const s = held('gate-m1-r3', { 'gate-m1-r3.json': gate('review_failed+review_limit') });
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(0);
    expect(readFileSync(join(s.root, 'gen', 'attempts', 'm1'), 'utf8')).toBe('1');
    const { code, out } = captured(() => main(['decide', '--all-held', 'retry']));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([
      expect.objectContaining({ run_id: 'sa1', state: 'held:gate', ok: true }),
    ]);
    expect(readFileSync(join(s.root, 'gen', 'attempts', 'm1'), 'utf8')).toBe('2');
    expect(resumes(s.calls())).toBe(2);
    expect(() => main(['decide', '--all-held', 'approve'])).toThrow(/--all-held retry/);
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
    SA_LAUNCHD_DIR: join(root, 'LaunchAgents'),
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
  expect(sa('land', id).out).toMatchObject({ branch: `sa/${id}`, debt: [] });
  expect(sh(`git log --format=%s sa/${id}`, repo)).toContain('fake fix m1 r2');
  expect(existsSync(String(waited.out.evidence))).toBe(true);
}, 240000);

describe('lock (flock, real processes)', () => {
  const SRC = JSON.stringify(join(import.meta.dir, '..', 'src', 'archon.ts'));
  /** 子进程：取锁后打印 ok，再执行 body；readLine 读子进程 stdout 的下一行。 */
  function child(path: string, body: string, pre = '') {
    const p = Bun.spawn(
      [
        'bun',
        '-e',
        `const { lock } = await import(${SRC}); ${pre} const l = lock(${JSON.stringify(path)}); console.log(l.ok); ${body}`,
      ],
      { stdout: 'pipe', stderr: 'inherit' }
    );
    const reader = p.stdout.getReader();
    let buf = '';
    const readLine = async (): Promise<string> => {
      while (!buf.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`child exited before a line: ${buf}`);
        buf += new TextDecoder().decode(value);
      }
      const line = buf.slice(0, buf.indexOf('\n'));
      buf = buf.slice(line.length + 1);
      return line;
    };
    return { p, readLine };
  }
  test('while a child process holds the lock, the parent gets locked', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, 'await Bun.sleep(60_000);');
    try {
      expect(await c.readLine()).toBe('true');
      expect(archonMod.lock(path)).toEqual({ ok: false, reason: 'locked' });
    } finally {
      c.p.kill('SIGKILL');
      await c.p.exited;
    }
  });
  test('once the holder is SIGKILLed the parent gets the lock immediately', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, 'await Bun.sleep(60_000);');
    expect(await c.readLine()).toBe('true');
    c.p.kill('SIGKILL');
    await c.p.exited;
    const l = archonMod.lock(path);
    expect(l.ok).toBe(true);
    if (l.ok) l.release();
  });
  test('three concurrent processes each holding 300ms: exactly one gets the lock', async () => {
    const root = tmp();
    const path = join(root, 'x.lock');
    const go = join(root, 'go');
    // 三个子进程都就绪后同时放行，持锁 300ms 覆盖其余两个的尝试
    const wait = `console.log('ready'); while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);`;
    const cs = [0, 1, 2].map(() => child(path, 'await Bun.sleep(300);', wait));
    for (const c of cs) expect(await c.readLine()).toBe('ready');
    writeFileSync(go, '');
    const got = await Promise.all(cs.map(c => c.readLine()));
    await Promise.all(cs.map(c => c.p.exited));
    expect(got.filter(x => x === 'true')).toHaveLength(1);
    expect(got.filter(x => x === 'false')).toHaveLength(2);
  });
  test('after release (holder still alive) another process gets the lock', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, "l.release(); console.log('released'); await Bun.sleep(60_000);");
    try {
      expect(await c.readLine()).toBe('true');
      expect(await c.readLine()).toBe('released');
      const l = archonMod.lock(path);
      expect(l.ok).toBe(true);
      if (l.ok) l.release();
    } finally {
      c.p.kill('SIGKILL');
      await c.p.exited;
    }
  });
});
