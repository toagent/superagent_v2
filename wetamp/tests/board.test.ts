import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import type { RunView } from '../src/archon';
import { report, summarize, type Ledger } from '../src/cli';
import {
  bar,
  createLoader,
  elapsedAt,
  fmtClock,
  fmtElapsed,
  readLedger,
  rowOf,
  workflowRoles,
} from '../src/board/data';
import { detailOf, detailLines, redact } from '../src/board/detail';
import { Frame } from '../src/board/App';
import { tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const ENV_KEYS = [
  'SA_ARCHON_BIN',
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SA_BOARD_QUERY_TIMEOUT_MS',
  'TWIN_AGENT_QUEUE_CLIENT',
  'COLUMNS',
] as const;
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

/**
 * archon 桩：`workflow get <id>` 返回 get-<id>.json；有 fail-<id> 标记时非零退出；有 hang-<id> 标记时挂起
 * （sleep 是孙进程、握着 stdout，用来验证整组被杀）；每次调用记一行。
 */
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
[ -f "${stubDir}/hang-$3" ] && sleep 31.7
cat "${stubDir}/get-$3.json"
`
  );
  chmodSync(bin, 0o755);
  mkdirSync(join(root, 'home', 'runs'), { recursive: true });
  Object.assign(process.env, {
    SA_ARCHON_BIN: bin,
    SA_BOARD_QUERY_TIMEOUT_MS: '10000',
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home', 'archon'),
    TWIN_AGENT_QUEUE_CLIENT: join(root, 'no-twin'), // 不去连真实远端队列
    COLUMNS: '', // --once 管道输出按宽屏（160）出帧
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

describe('loader robustness', () => {
  const live = (id: string): Ledger =>
    ledger(id, { status: 'running', metadata: { execution_owner: { host: 'elsewhere', pid: 1 } } });
  const orphans = (): string =>
    Bun.spawnSync(['pgrep', '-f', 'sleep 31.7'], { stdout: 'pipe' }).stdout.toString().trim();

  test('JSON null, array, string and {} ledgers are unreadable rows; the round does not throw', async () => {
    ledger('ok', { status: 'completed' });
    for (const [id, body] of [
      ['n', 'null'],
      ['arr', '[]'],
      ['str', '"x"'],
      ['empty', '{}'],
    ])
      writeFileSync(ledgerFile(id), body);
    expect(readLedger('n')).toContain('null');
    expect(readLedger('arr')).toContain('array');
    expect(readLedger('str')).toContain('string');
    expect(readLedger('empty')).toContain('run_id');
    const byId = Object.fromEntries((await createLoader()(50)).rows.map(r => [r.run_id, r]));
    expect(byId.ok?.state).toBe('completed');
    for (const id of ['n', 'arr', 'str', 'empty']) expect(byId[id]?.state).toBe('unreadable');
  });

  test('a hung query is killed at the timeout with its process group; the row goes stale', async () => {
    live('hang');
    process.env.SA_BOARD_QUERY_TIMEOUT_MS = '300';
    const load = createLoader();
    expect((await load(50)).rows[0]?.stale).toBe(false);
    writeFileSync(join(stubDir, 'hang-a-hang'), '');
    const t0 = Date.now();
    const row = (await load(50)).rows[0];
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(row?.stale).toBe(true);
    expect(row?.state).toBe('running');
    await Bun.sleep(100);
    expect(orphans()).toBe('');
  });

  test('aborting the loader kills in-flight queries', async () => {
    live('hang');
    writeFileSync(join(stubDir, 'hang-a-hang'), '');
    const ac = new AbortController();
    const pending = createLoader(ac.signal)(50);
    await Bun.sleep(200);
    const t0 = Date.now();
    ac.abort();
    const row = (await pending).rows[0];
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(row?.error).toContain('aborted');
    await Bun.sleep(100);
    expect(orphans()).toBe('');
  });

  test('a cached failed or held:gate run that gets cancelled shows cancelled on the next round', async () => {
    ledger('f', { status: 'failed', nodes: [{ nodeId: 'verify-a', state: 'failed' }] });
    ledger('g', { status: 'failed', nodes: [{ nodeId: 'gate-m1-r1', state: 'failed' }] });
    const load = createLoader();
    const states = async (): Promise<string[]> =>
      (await load(50)).rows.map(r => `${r.run_id}:${r.state}`).sort();
    expect(await states()).toEqual(['f:held:engine_suspect', 'g:held:gate']);
    // cancel/reject 只改 archon，不写 ledger（mtime 不变）
    for (const id of ['f', 'g'])
      writeFileSync(
        join(stubDir, `get-a-${id}.json`),
        JSON.stringify({ id: `a-${id}`, status: 'cancelled' })
      );
    expect(await states()).toEqual(['f:cancelled', 'g:cancelled']);
    const n = calls();
    await load(50);
    expect(calls()).toBe(n); // cancelled 不可逆，此后走缓存
  });

  test('a non-positive SA_BOARD_QUERY_TIMEOUT_MS is rejected', () => {
    process.env.SA_BOARD_QUERY_TIMEOUT_MS = '0';
    expect(() => createLoader()).toThrow('SA_BOARD_QUERY_TIMEOUT_MS');
  });
});

describe('time', () => {
  const at = (iso: string): number => Date.parse(iso);

  test('resume: start and sort come from the ledger, not the reset Archon started_at', async () => {
    // 实例 20261010-033000-d01a：03:50:49 resume 后 Archon 的 started_at 被重置
    const l = ledger(
      'resumed',
      {
        status: 'completed',
        started_at: '2026-10-10T03:50:49.000Z',
        completed_at: '2026-10-10T03:53:29.000Z',
      },
      { started_at: '2026-10-10T03:30:02.550Z' }
    );
    const row = rowOf(l, JSON.parse(readFileSync(join(stubDir, 'get-a-resumed.json'), 'utf8')), {
      now: at('2026-10-10T05:00:00Z'),
    });
    expect(row.started_at).toBe('2026-10-10T03:30:02.550Z');
    expect(fmtElapsed(row.elapsed_s)).toBe('23m26s');
    // 后提交、未 resume 的 run 的 Archon started_at 早于上面那个被重置的值，排序仍按提交时刻
    ledger(
      'later',
      { status: 'completed', started_at: '2026-10-10T03:40:00.000Z' },
      { started_at: '2026-10-10T03:40:00.000Z' }
    );
    expect((await createLoader()(50)).rows.map(r => r.run_id)).toEqual(['later', 'resumed']);
  });

  test('a terminal run without completed_at ends at last_activity_at, else shows -, never growing with now', () => {
    const l = ledger('t', { status: 'failed' });
    const base: RunView = {
      id: 'a-t',
      status: 'failed',
      nodes: [{ nodeId: 'land', state: 'failed' }],
    };
    for (const now of [at('2026-10-10T01:00:00Z'), at('2026-10-11T01:00:00Z')]) {
      expect(
        rowOf(l, { ...base, last_activity_at: '2026-10-10T00:05:00.000Z' }, { now }).elapsed_s
      ).toBe(300);
      const bare = rowOf(l, base, { now });
      expect(bare.elapsed_s).toBeNull();
      expect(elapsedAt(bare, now + 60_000)).toBeNull();
    }
  });

  test('running and held rows tick with the injected now; the frame re-renders elapsed from it', () => {
    const l = ledger('live', { status: 'running' });
    const run: RunView = {
      id: 'a-live',
      status: 'running',
      started_at: '2026-10-10T00:09:00.000Z',
    };
    const row = rowOf(l, run, { now: at('2026-10-10T00:00:45Z') });
    expect(row.elapsed_s).toBe(45);
    expect(elapsedAt(row, at('2026-10-10T00:00:46Z'))).toBe(46);
    const held = rowOf(l, { ...run, status: 'paused' }, { now: at('2026-10-10T00:01:00Z') });
    expect(held.state).toStartWith('held:');
    expect(elapsedAt(held, at('2026-10-10T00:02:00Z'))).toBe(120);
    const text = (now: string): string =>
      renderToString(
        createElement(Frame, {
          snap: { summary: {}, rows: [row], at: '2026-10-10T00:00:45.000Z' },
          home: '/h',
          width: 160,
          height: 20,
          interval: 5,
          sel: -1,
          activeOnly: false,
          detail: null,
          now: new Date(now),
          footer: false,
        }),
        { columns: 160 }
      );
    expect(text('2026-10-10T00:00:50Z')).toMatch(/ 50s /);
    expect(text('2026-10-10T00:02:05Z')).toMatch(/ 2m05s /);
  });

  test('fmtClock uses the process time zone: HH:MM:SS today, MM-DD HH:MM otherwise', () => {
    const saved = process.env.TZ;
    try {
      const t = '2026-10-10T03:53:29.000Z';
      process.env.TZ = 'Asia/Shanghai';
      expect(fmtClock(t, at('2026-10-10T03:54:00Z'))).toBe('11:53:29');
      expect(fmtClock(at(t), at('2026-10-10T17:00:00Z'))).toBe('10-10 11:53'); // 上海已是 10-11
      expect(fmtClock('x', Date.now())).toBe('--:--:--');
      process.env.TZ = 'UTC';
      expect(fmtClock(t, at('2026-10-10T03:54:00Z'))).toBe('03:53:29');
      expect(fmtClock(t, at('2026-10-10T17:00:00Z'))).toBe('03:53:29');
      expect(fmtClock(t, at('2026-10-11T00:00:01Z'))).toBe('10-10 03:53');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test('detail shows local start and elapsed on its first line and local event times', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Shanghai';
      const l = ledger('d', { status: 'running' }, { started_at: '2026-10-10T03:30:02.550Z' });
      writeFileSync(
        l.transcript,
        JSON.stringify({ type: 'node_start', step: 'code-a', ts: '2026-10-10T03:53:10.000Z' })
      );
      const row = rowOf(l, { id: 'a-d', status: 'running' }, { now: at('2026-10-10T03:54:00Z') });
      const lines = detailLines(detailOf(l, row), at('2026-10-10T03:54:00Z'), row);
      expect(lines[0]).toContain('开始 11:30:02 · 耗时 23m57s');
      expect(lines).toContain('11:53:10 node_start code-a');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
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
      'Authorization: Bearer abc.def\ntoken=xyz123 "api_key": "s3cr3t" PASSWORD=hunter2 ok=1'
    );
    for (const secret of ['abc.def', 'xyz123', 's3cr3t', 'hunter2'])
      expect(s).not.toContain(secret);
    expect(s).toContain('token=***');
    expect(s).toContain('ok=1');
  });

  test('redacts whole values: every Authorization scheme, quoted values with spaces and escaped quotes', () => {
    const cases: [string, string][] = [
      ['Authorization: ApiKey synthetic_credential', 'Authorization: ***'],
      ['Authorization: Bearer x.y.z', 'Authorization: ***'],
      ['password="alpha beta"', 'password=***'],
      ["secret='a b'", 'secret=***'],
      ['{"api_key":"k k"}', '{"api_key":***}'],
      ['token=xyz rest', 'token=*** rest'],
      ['"token":"a \\"b\\" c" tail', '"token":*** tail'],
      ['{"h":"Authorization: Basic zz\\"q","n":1}', '{"h":"Authorization: ***","n":1}'],
      ['run Bearer abc.def now', 'run Bearer *** now'],
    ];
    expect(cases.map(([raw]) => redact(raw))).toEqual(cases.map(([, out]) => out));
  });

  test('the 120-char tail is taken after redaction and leaves no plaintext at the cut', () => {
    const l = ledger('cut', { status: 'running' });
    const secret = 'alpha beta gamma delta';
    // 值跨过截尾边界：先截尾会丢掉 password= 只剩裸值
    const stdout = `password="${secret}"${'.'.repeat(110)}`;
    writeFileSync(
      l.transcript,
      JSON.stringify({ type: 'exec_output', step: 'x', stdout_tail: stdout })
    );
    const run: RunView = { id: 'a-cut', status: 'running' };
    const out = detailOf(l, rowOf(l, run, { now: Date.now() })).events[0]?.out ?? '';
    expect(out.length).toBeLessThanOrEqual(120);
    for (const part of secret.split(' ')) expect(out).not.toContain(part);
  });

  test('plan, transcript and evidence paths outside the repo and $SUPERAGENT_HOME are skipped unread', () => {
    const outside = tmp();
    writeFileSync(
      join(outside, 'plan.json'),
      JSON.stringify({ packages: [{ id: 'x', risk: 'G1' }] })
    );
    writeFileSync(join(outside, 't.jsonl'), JSON.stringify({ type: 'node_start', step: 'leak' }));
    writeFileSync(
      join(outside, 'gate-m1-r1.json'),
      JSON.stringify({ verdict: 'pass', reason: null, debt: [] })
    );
    const l = ledger(
      'esc',
      { status: 'failed', output_root: join(root, 'out') },
      { plan: `../${basename(outside)}/plan.json`, transcript: join(outside, 't.jsonl') }
    );
    const art = join(root, 'out', 'artifacts', 'runs', 'a-esc');
    mkdirSync(art, { recursive: true });
    symlinkSync(join(outside, 'gate-m1-r1.json'), join(art, 'gate-m1-r1.json'));
    const run = JSON.parse(readFileSync(join(stubDir, 'get-a-esc.json'), 'utf8')) as RunView;
    const d = detailOf(l, rowOf(l, run, { now: Date.now() }));
    expect(d.packages).toEqual([]);
    expect(d.events).toEqual([]);
    expect(d.gates).toEqual([]);
    expect(d.errors).toHaveLength(3);
    for (const e of d.errors) expect(e).toContain('（路径越界，已跳过）');
    expect(detailLines(d, Date.now()).join('\n')).not.toContain('leak');
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
    writeFileSync(
      join(art, 'a.coder.json'),
      JSON.stringify({ needs: [{ cap: 'services', why: 'pg', minimal_ask: '起本机 postgres' }] })
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
    expect(detailLines(d, Date.now())).toContain('need services (a): 起本机 postgres');
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
    expect(r.out).toContain('superagent');
    expect(r.out).toContain('今日结果');
    expect(r.out).not.toContain('remote');
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

  test('bin entry routes board --view without expanding the shared CLI parser', () => {
    const run = (view: string): number => Bun.spawnSync(['bash', 'bin/superagent', 'board', '--view', view, '--once'], { cwd: WETAMP, env: { ...process.env }, stdout: 'ignore', stderr: 'ignore' }).exitCode;
    expect(run('terminals')).toBe(0);
    expect(run('invalid')).toBe(64);
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
  // report 另带 usage（F-22，report.test.ts 覆盖）；计数摘要部分与 summarize、board 同源
  const { usage, ...expected } = report();
  expect(usage).toMatchObject({ total: { calls: 0, coverage: '0/0', input: 'unknown' } });
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
