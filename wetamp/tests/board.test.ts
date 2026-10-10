import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from '../src/archon';
import { report, summarize, type Ledger } from '../src/cli';
import { bar, createLoader, fmtElapsed, readLedger, rowOf, workflowRoles } from '../src/board/data';
import { detailOf, redact } from '../src/board/detail';
import { tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const ENV_KEYS = ['SA_ARCHON_BIN', 'SUPERAGENT_HOME', 'ARCHON_HOME'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
// 同一进程里后跑的测试文件不能继承这里的桩与临时 home
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
let root = '';
let stubDir = '';

/** archon 桩：`workflow get <id>` 返回 get-<id>.json；有 fail-<id> 标记时非零退出；每次调用记一行。 */
beforeEach(() => {
  root = tmp();
  stubDir = join(root, 'stub');
  mkdirSync(stubDir, { recursive: true });
  const bin = join(stubDir, 'archon');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "${stubDir}/calls"
[ -f "${stubDir}/fail-$3" ] && { echo "archon down" >&2; exit 1; }
cat "${stubDir}/get-$3.json"
`
  );
  chmodSync(bin, 0o755);
  mkdirSync(join(root, 'home', 'runs'), { recursive: true });
  Object.assign(process.env, {
    SA_ARCHON_BIN: bin,
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home', 'archon'),
  });
});

const calls = (): number =>
  existsSync(join(stubDir, 'calls'))
    ? readFileSync(join(stubDir, 'calls'), 'utf8').trim().split('\n').length
    : 0;
const ledgerFile = (id: string): string => join(root, 'home', 'runs', `${id}.json`);

function ledger(
  id: string,
  run: Partial<RunView> & Pick<RunView, 'status'>,
  extra: Partial<Ledger> = {}
): Ledger {
  const l: Ledger = {
    run_id: id,
    archon_run_id: `a-${id}`,
    plan: 'plan.json',
    gen_dir: join(root, 'gen', id),
    repo: root,
    branch: `sa/${id}`,
    workflow: `sa-${id}`,
    console: 'claude',
    started_at: '2026-10-10T00:00:00.000Z',
    transcript: join(root, `${id}.jsonl`),
    log: join(root, `${id}.log`),
    recoveries: [],
    ...extra,
  };
  writeFileSync(ledgerFile(id), JSON.stringify(l));
  writeFileSync(join(stubDir, `get-a-${id}.json`), JSON.stringify({ id: `a-${id}`, ...run }));
  return l;
}

describe('data rows', () => {
  test('normal row: progress, current node and role from the generated workflow, elapsed, held', () => {
    const l = ledger('sa1', { status: 'paused' });
    mkdirSync(join(l.gen_dir, '.archon', 'workflows', l.workflow), { recursive: true });
    writeFileSync(
      join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`),
      'nodes:\n  - id: code-a\n    model: "@sa-coder"\n  - id: review-m1-r1\n    model: "@sa-reviewer"\n  - id: human-m1\n    wait: { event: sa.human.m1 }\n  - id: land\n    script: land\n'
    );
    const run: RunView = {
      id: 'a-sa1',
      status: 'paused',
      started_at: '2026-10-10T00:00:00.000Z',
      metadata: {
        wait: { nodeId: 'human-m1', kind: 'event', event: 'sa.human.m1', resumeAt: 't' },
      },
      nodes: [
        { nodeId: 'code-a', state: 'completed' },
        { nodeId: 'review-m1-r1', state: 'completed' },
        { nodeId: 'human-m1', state: 'running' },
      ],
    };
    const loaded = readLedger('sa1');
    if (typeof loaded === 'string') throw new Error(loaded);
    const row = rowOf(loaded, run, {
      now: Date.parse('2026-10-10T00:12:05.000Z'),
      roles: workflowRoles(loaded),
    });
    expect(row).toMatchObject({
      run_id: 'sa1',
      state: 'held:human',
      exit: 3,
      nodes: { done: 2, total: 4, current: 'human-m1', currentRole: 'human' },
      elapsed_s: 725,
      held: { node: 'human-m1', event: 'sa.human.m1' },
      repo: root.split('/').at(-1),
      branch: 'sa/sa1',
      stale: false,
    });
  });

  test('bad JSON and missing fields become unreadable rows; the good run still renders', async () => {
    ledger('ok', { status: 'completed' });
    writeFileSync(ledgerFile('broken'), '{not json');
    writeFileSync(ledgerFile('thin'), JSON.stringify({ run_id: 'thin', repo: root }));
    expect(readLedger('broken')).toBeString();
    expect(readLedger('thin')).toContain('archon_run_id');
    const snap = await createLoader()(50);
    const byId = Object.fromEntries(snap.rows.map(r => [r.run_id, r]));
    expect(byId.ok?.state).toBe('completed');
    expect(byId.broken?.state).toBe('unreadable');
    expect(byId.thin?.state).toBe('unreadable');
    expect(byId.thin?.error).toContain('recoveries');
    expect(snap.summary.runs).toBe(3);
    expect((snap.summary.unreadable as string[]).length).toBe(2);
  });

  test('terminal runs are cached until the ledger changes; active runs are queried every refresh', async () => {
    ledger('done', { status: 'completed' });
    ledger('live', {
      status: 'running',
      metadata: { execution_owner: { host: 'elsewhere', pid: 1 } },
    });
    const load = createLoader();
    await load(50);
    expect(calls()).toBe(2);
    await load(50);
    expect(calls()).toBe(3); // 只有 live 再查
    const later = new Date(Date.now() + 5000);
    utimesSync(ledgerFile('done'), later, later); // recover/decide 写 ledger → 缓存失效
    await load(50);
    expect(calls()).toBe(5);
  });

  test('a failed query keeps the previous run and marks the row stale; never-seen runs are unreadable', async () => {
    ledger('live', {
      status: 'running',
      metadata: { execution_owner: { host: 'elsewhere', pid: 1 } },
    });
    const load = createLoader();
    expect((await load(50)).rows[0]?.stale).toBe(false);
    writeFileSync(join(stubDir, 'fail-a-live'), '');
    const row = (await load(50)).rows[0];
    expect(row?.stale).toBe(true);
    expect(row?.state).toBe('running');
    const fresh = await createLoader()(50);
    expect(fresh.rows[0]?.state).toBe('unreadable');
    expect(fresh.rows[0]?.error).toContain('archon down');
  });

  test('--limit keeps the newest ledgers by mtime', async () => {
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      ledger(id, { status: 'completed' });
      const t = new Date(Date.now() + i * 1000);
      utimesSync(ledgerFile(id), t, t);
    }
    expect((await createLoader()(2)).rows.map(r => r.run_id).sort()).toEqual(['b', 'c']);
  });
});

describe('format', () => {
  test('elapsed', () => {
    expect([
      fmtElapsed(null),
      fmtElapsed(45),
      fmtElapsed(725),
      fmtElapsed(11040),
      fmtElapsed(183600),
    ]).toEqual(['-', '45s', '12m05s', '3h04m', '2d03h']);
  });
  test('progress bar', () => {
    expect(bar(4, 6)).toBe('████░░ 4/6');
    expect(bar(0, 0)).toBe('░░░░░░ 0/0');
    expect(bar(5, 5)).toBe('██████ 5/5');
  });
});

describe('detail', () => {
  test('redacts credential values in exec output before taking the tail', () => {
    const s = redact(
      'Authorization: Bearer abc.def token=xyz123 "api_key": "s3cr3t" PASSWORD=hunter2 ok=1'
    );
    for (const secret of ['abc.def', 'xyz123', 's3cr3t', 'hunter2'])
      expect(s).not.toContain(secret);
    expect(s).toContain('token=***');
    expect(s).toContain('ok=1');
  });

  test('plan packages, gate rounds, last events, held hints', () => {
    const l = ledger('sa1', { status: 'failed' });
    writeFileSync(
      join(root, 'plan.json'),
      JSON.stringify({
        packages: [
          { id: 'a', risk: 'G1' },
          { id: 'b', risk: 'G2', milestone: 'm2', signoff: 'human' },
        ],
      })
    );
    const art = join(root, 'out', 'artifacts', 'runs', 'a-sa1');
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(art, 'gate-m1-r1.json'),
      JSON.stringify({ verdict: 'fix', reason: 'review_failed', debt: [] })
    );
    writeFileSync(
      join(art, 'gate-m1-r2.json'),
      JSON.stringify({ verdict: 'pass', reason: null, debt: ['d'] })
    );
    const ev = (i: number): string =>
      JSON.stringify({ type: 'node_start', step: `n${String(i)}`, ts: 't' });
    writeFileSync(
      l.transcript,
      [
        ...Array.from({ length: 10 }, (_, i) => ev(i)),
        JSON.stringify({ type: 'provider_event', step: 'n9' }),
        JSON.stringify({
          type: 'exec_output',
          step: 'x',
          ts: 't',
          stdout_tail: `${'.'.repeat(200)} secret: hunter2`,
        }),
        '{"type":"node_comp', // 写到一半的末行
      ].join('\n')
    );
    const run: RunView = {
      id: 'a-sa1',
      status: 'failed',
      output_root: join(root, 'out'),
      nodes: [{ nodeId: 'gate-m1-r2', state: 'failed' }],
    };
    const d = detailOf(l, rowOf(l, run, { now: Date.now() }));
    expect(d.packages.map(p => `${p.id}:${p.milestone}:${p.signoff}`)).toEqual([
      'a:m1:auto',
      'b:m2:human',
    ]);
    expect(d.gates).toEqual([
      { milestone: 'm1', round: 1, verdict: 'fix', reason: 'review_failed', debt: 0 },
      { milestone: 'm1', round: 2, verdict: 'pass', reason: null, debt: 1 },
    ]);
    expect(d.events).toHaveLength(8);
    const last = d.events.at(-1);
    expect(last?.type).toBe('exec_output');
    expect(last?.out?.length).toBeLessThanOrEqual(120);
    expect(last?.out).toEndWith('secret: ***');
    expect(d.next[0]).toBe('superagent decide sa1 approve|reject|retry [--pkg id]');
    expect(d.errors).toEqual([]);
  });
});

describe('end to end', () => {
  const cli = (args: string[]): { code: number; out: string; err: string } => {
    const p = Bun.spawnSync(['bun', 'src/cli.ts', 'board', ...args], {
      cwd: WETAMP,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test('--once renders one text frame and exits 0', () => {
    ledger('sa1', { status: 'completed', nodes: [{ nodeId: 'land', state: 'completed' }] });
    writeFileSync(ledgerFile('broken'), '{');
    const r = cli(['--once']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('superagent board');
    expect(r.out).toMatch(/sa1\s+completed\s+█+ 1\/1/);
    expect(r.out).toContain('unreadable');
  });

  test('--json prints {summary, rows, selected}; bad flags exit 64', () => {
    ledger('sa1', { status: 'completed' });
    const r = cli(['sa1', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as {
      summary: { runs: number };
      rows: { run_id: string }[];
      selected: { run_id: string };
    };
    expect(j.summary.runs).toBe(1);
    expect(j.rows.map(x => x.run_id)).toEqual(['sa1']);
    expect(j.selected.run_id).toBe('sa1');
    expect(cli(['--interval', '0']).code).toBe(64);
  });
});

test('summarize, report and the board share one summary', async () => {
  const out = join(root, 'out');
  const art = join(out, 'artifacts', 'runs', 'a-g');
  mkdirSync(art, { recursive: true });
  writeFileSync(
    join(art, 'gate-m1-r1.json'),
    JSON.stringify({ verdict: 'pass', reason: null, debt: ['d1'] })
  );
  const g = ledger(
    'g',
    {
      status: 'completed',
      output_root: out,
      nodes: [{ nodeId: 'code-a', state: 'completed', durationMs: 4000 }],
    },
    { recoveries: ['t'] }
  );
  const f = ledger('f', { status: 'failed', nodes: [{ nodeId: 'verify-a', state: 'failed' }] });
  const expected = report();
  expect(expected).toMatchObject({
    runs: 2,
    first_pass: 1,
    debt: 1,
    'failed:verify': 1,
    recoveries: 1,
  });
  const runs = [g, f].map(l => ({
    ledger: l,
    run: JSON.parse(readFileSync(join(stubDir, `get-${l.archon_run_id}.json`), 'utf8')) as RunView,
  }));
  expect(summarize(runs)).toEqual(expected);
  expect((await createLoader()(50)).summary).toEqual(expected);
});
