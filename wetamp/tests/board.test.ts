import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render, renderToString } from 'ink';
import type { RunView } from '../src/archon';
import { report, summarize, intervention, loadLedger, type Ledger } from '../src/cli';
import {
  bar,
  createLoader,
  elapsedAt,
  fmtClock,
  fmtElapsed,
  readLedger,
  rowOf,
  snapshotOf,
  workflowRoles,
} from '../src/board/data';
import { detailOf, detailLines, redact } from '../src/board/detail';
import { BucketedFrame, Frame } from '../src/board/App';
import { cockpit } from '../src/board/cockpit';
import * as cockpitModule from '../src/board/cockpit';
import { boardInterval } from '../src/board/index';
import { metricsOf } from '../src/ledger-metrics';
import { gitRepo, sh, tmp } from './helpers';
import { caller, coord, Coordination, repoScope, runScope } from '../src/coord';

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

/** archon 查询桩；sleep 孙进程用来验证超时或取消会杀掉整个进程组。 */
beforeEach(() => {
  root = tmp();
  stubDir = join(root, 'stub');
  mkdirSync(stubDir, { recursive: true });
  const bin = join(stubDir, 'archon');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "${stubDir}/calls"
[ "$2" = runs ] && {
  fail=$(find "${stubDir}" -name 'fail-*' -print -quit); [ -n "$fail" ] && { echo "archon down" >&2; exit 1; }
  hang=$(find "${stubDir}" -name 'hang-*' -print -quit); [ -n "$hang" ] && { sleep 31.7 & child=$!; echo "$child" >> "${stubDir}/children"; wait "$child"; }
  bun -e 'import {readdirSync,readFileSync} from "node:fs"; const d=process.argv[1]; console.log(JSON.stringify({runs:readdirSync(d).filter(x=>x.startsWith("get-")).map(x=>JSON.parse(readFileSync(d+"/"+x,"utf8")))}))' "${stubDir}"; exit;
}
[ -f "${stubDir}/fail-$3" ] && { echo "archon down" >&2; exit 1; }
[ -f "${stubDir}/hang-$3" ] && { sleep 31.7 & child=$!; echo "$child" >> "${stubDir}/children"; wait "$child"; }
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
const callLines = (): string[] =>
  existsSync(join(stubDir, 'calls'))
    ? readFileSync(join(stubDir, 'calls'), 'utf8').trim().split('\n')
    : [];
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
  mkdirSync(l.gen_dir, { recursive: true });
  writeFileSync(join(l.gen_dir, 'plan.json'), JSON.stringify({ deadline: '2099-01-01T00:00:00Z' }));
  writeFileSync(ledgerFile(id), JSON.stringify(l));
  writeFileSync(
    join(stubDir, `get-a-${id}.json`),
    JSON.stringify({
      id: `a-${id}`,
      ...(run.status === 'running'
        ? { metadata: { execution_owner: { host: hostname(), pid: process.pid } } }
        : {}),
      ...run,
    })
  );
  return l;
}

describe('data rows', () => {
  test('delivery receipts override ancestry; automatic landing is not an intervention', () => {
    const run: RunView = { id: 'a-delivery', status: 'completed' };
    const l = ledger('delivery', run, {
      intervention_events: [],
      delivery_result: { status: 'blocked', reason: 'dirty\nmore' },
    });
    const row = () => rowOf(loadLedger(l.run_id), run, { now: Date.now() });
    expect(row().landed).toBe(false);
    intervention(l, 'land', () => 0, undefined, undefined, undefined, 'engine');
    expect(row()).toMatchObject({ interventions: 0, intervened: false });
    intervention(l, 'land', () => 0);
    expect(row()).toMatchObject({ interventions: 1, intervened: true });
    expect(report()).toMatchObject({
      delivery: { blocked: 1 },
      undelivered: [{ run: 'delivery', repo: root, status: 'blocked', reason: 'dirty' }],
      interventions: { by_run: { delivery: 1 } },
    });
    const integrated: NonNullable<Ledger['delivery_result']> = {
      status: 'integrated',
      task: 'delivery',
      source: 'source',
      target: { checkout: root, branch: 'target', head: 'base' },
      contract: 'contract',
      evidence: root,
      accepted: 'accepted',
      integrated: 'integrated',
      target_tip: 'tip',
      push: 'manual',
    };
    const now = Date.now();
    const auto = rowOf(
      {
        ...l,
        delivery_result: integrated,
        intervention_events: loadLedger(l.run_id).intervention_events?.slice(0, 1),
      },
      { ...run, completed_at: new Date(now).toISOString() },
      { now }
    );
    expect(metricsOf([auto], {}, now).completed).toBe(1);
    // No plan or Git ancestry evidence: the durable receipt is sufficient.
    expect(rowOf({ ...l, delivery_result: integrated }, run, { now: Date.now() }).landed).toBe(
      true
    );
    const repo = gitRepo(tmp()),
      output = join(repo, 'artifacts/runs', run.id);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'land.json'),
      JSON.stringify({ head: sh('git rev-parse HEAD', repo).trim() })
    );
    writeFileSync(join(repo, 'plan.json'), JSON.stringify({ base_ref: 'main', packages: [] }));
    const legacy = { ...l, repo, delivery_result: undefined };
    const landedRun = { ...run, output_root: repo };
    expect(rowOf(legacy, landedRun, { now }).landed).toBe(true);
    expect(
      rowOf({ ...legacy, delivery_result: l.delivery_result }, landedRun, { now }).landed
    ).toBe(false);
    writeFileSync(
      join(output, 'publish-m1.json'),
      JSON.stringify({
        ...integrated,
        status: 'published',
      })
    );
    expect(
      rowOf(
        { ...legacy, delivery: integrated.target },
        { ...landedRun, nodes: [{ nodeId: 'integrate-m1.publish-m1', state: 'completed' }] },
        { now }
      ).landed
    ).toBe(true);
  });
  test('interventions use explicit events, never automatic asks or legacy booleans', () => {
    const run: RunView = { id: 'a-sa1', status: 'failed' };
    const l = ledger('sa1', run, {
      intervened: true,
      recoveries: ['a'],
      dispositions: [{ at: '2026-10-12T00:00:00Z', action: 'ask', reason: 'needs', ok: true }],
    });
    const count = () => cockpit(snapshotOf([{ ledger: l, run }])).runs[0]?.interventions;
    expect(count()).toBeUndefined();
    l.intervention_events = [];
    expect(count()).toBe(0);
    l.intervention_events.push({
      at: '2026-10-12T00:00:00Z',
      action: 'cancel',
      source: 'cli',
      ok: false,
    });
    expect(count()).toBe(1);
  });
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
        { nodeId: 'review-m1-r6', state: 'pending' },
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
      engine: { round: 1 },
      repo: root.split('/').at(-1),
      branch: 'sa/sa1',
      stale: false,
    });
  });

  test('abandoned paused runs are terminal while an ordinary held gate stays unverified', () => {
    const run: RunView = { id: 'a-abandoned', status: 'paused' };
    const l = ledger('abandoned', run, {
      rejected: run.id,
      intervention_events: [
        { at: '2026-10-20T00:00:00Z', action: 'abandon', source: 'cli', ok: true },
      ],
    });
    const abandoned = rowOf(l, run, { now: Date.now() });
    const held = { ...abandoned, run_id: 'held', state: 'held:gate', exit: 3 };
    const snap = { at: new Date().toISOString(), summary: {}, rows: [abandoned, held] };
    const frame = renderToString(
      createElement(Frame, { snap, width: 80, height: 20, now: new Date() })
    );

    expect(abandoned).toMatchObject({
      state: 'abandoned',
      exit: 2,
      held: null,
      humanDecision: undefined,
      askReason: undefined,
    });
    expect(cockpit(snap)).toMatchObject({ active: [], needs: [] });
    expect(frame).toContain('待核实 1 项');
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
    expect(byId.thin?.error).toContain('archon_run_id');
    expect(snap.summary.runs).toBe(3);
    expect((snap.summary.unreadable as string[]).length).toBe(2);
  });

  test('terminal runs are cached until the ledger changes; active runs are queried every refresh', async () => {
    const repo = gitRepo(tmp());
    ledger('done', { status: 'completed' }, { repo });
    ledger(
      'live',
      {
        status: 'running',
        metadata: { execution_owner: { host: hostname(), pid: process.pid } },
      },
      { repo }
    );
    const unchanged = new Date(100_000);
    for (const id of ['done', 'live']) utimesSync(ledgerFile(id), unchanged, unchanged);
    let owners = 0;
    const ownerOf = (l: Ledger) => {
      owners++;
      return coord().owner(runScope(l));
    };
    const load = createLoader(undefined, ownerOf);
    const first = await load(50);
    expect(first.rows.find(r => r.run_id === 'done')?.branch).toBe('sa/done');
    expect(callLines()).toEqual(['workflow runs --all --limit 2147483647 --verbose --json']);
    expect(owners).toBe(2);

    for (const id of ['done', 'live']) {
      const file = ledgerFile(id);
      writeFileSync(file, readFileSync(file, 'utf8').replace(`sa/${id}`, `sa/${id.toUpperCase()}`));
      utimesSync(file, unchanged, unchanged);
    }
    const second = await load(50);
    expect(second.rows.find(r => r.run_id === 'done')?.branch).toBe('sa/done');
    expect(second.rows.find(r => r.run_id === 'live')?.branch).toBe('sa/LIVE');
    expect(callLines().slice(1)).toEqual(['workflow get a-live --verbose --json']);
    expect(owners).toBe(3);

    const later = new Date(Date.now() + 5000);
    utimesSync(ledgerFile('done'), later, later); // recover/decide 写 ledger → 缓存失效
    const third = await load(50);
    expect(third.rows.find(r => r.run_id === 'done')?.branch).toBe('sa/DONE');
    expect(callLines().slice(2).sort()).toEqual([
      'workflow get a-done --verbose --json',
      'workflow get a-live --verbose --json',
    ]);
    expect(owners).toBe(5);
  });

  test('stable terminal rows and summaries are reused while active elapsed time is rebuilt', async () => {
    const done = ledger('done', { status: 'completed' });
    ledger('live', { status: 'running' });
    const unchanged = new Date(100_000);
    for (const id of ['done', 'live']) utimesSync(ledgerFile(id), unchanged, unchanged);
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(Date.parse('2026-10-10T00:01:00Z'));
      const load = createLoader();
      const first = await load(50);
      writeFileSync(
        join(done.gen_dir, 'plan.json'),
        JSON.stringify({ packages: [{ id: 'done', title: 'updated title' }] })
      );
      now.mockReturnValue(Date.parse('2026-10-10T00:02:00Z'));
      const second = await load(50);
      const firstDone = first.rows.find(r => r.run_id === 'done');
      const firstLive = first.rows.find(r => r.run_id === 'live');
      expect(second.rows.find(r => r.run_id === 'done')).toBe(firstDone);
      expect(second.rows.find(r => r.run_id === 'done')?.engine?.title).toBe('任务标题未知');
      expect(second.rows.find(r => r.run_id === 'live')).not.toBe(firstLive);
      expect(second.rows.find(r => r.run_id === 'live')?.elapsed_s).toBe(120);
      expect(second.summary).not.toBe(first.summary); // active rows prevent summary reuse

      writeFileSync(
        join(stubDir, 'get-a-live.json'),
        JSON.stringify({ id: 'a-live', status: 'completed' })
      );
      for (const id of ['done', 'live'])
        utimesSync(ledgerFile(id), new Date(200_000), new Date(200_000));
      const settled = await load(50);
      expect(settled.rows.find(r => r.run_id === 'done')?.engine?.title).toBe('updated title');
      const stable = await load(50);
      expect(stable.summary).toBe(settled.summary);
      ledger('new', { status: 'completed' });
      expect((await load(50)).summary).not.toBe(stable.summary);
    } finally {
      now.mockRestore();
    }
  });

  test('stable failed rows and summaries are reused, excluded from activity, and refresh on revision change', async () => {
    ledger('failed', { status: 'failed' });
    let revision = 'r1';
    const load = createLoader(
      undefined,
      undefined,
      undefined,
      () => new Map([['a-failed', revision]])
    );
    const first = await load(50);
    expect(calls()).toBe(1);
    expect(first.activity?.runs).toEqual([]);
    const stable = await load(50);
    expect(calls()).toBe(1);
    expect(stable.rows[0]).toBe(first.rows[0]);
    expect(stable.summary).toBe(first.summary);
    revision = 'r2';
    const changed = await load(50);
    expect(callLines().at(-1)).toBe('workflow get a-failed --verbose --json');
    expect(changed.rows[0]).not.toBe(stable.rows[0]);
    expect(changed.summary).not.toBe(stable.summary);
    expect(changed.activity?.runs).toEqual([]);
  });

  test('one refresh probes a shared process identity once', async () => {
    const repo = gitRepo(tmp());
    const controller = {
      client: 'codex',
      host: hostname(),
      pid: process.pid,
      pid_start: 'fixture-start',
      generation: 1,
    };
    for (const id of ['one', 'two']) ledger(id, { status: 'running' }, { controller, repo });
    let probes = 0;
    const snap = await createLoader(undefined, undefined, () => {
      probes++;
      return { state: 'online', activity: 'active' };
    })(50);
    expect(snap.rows.map(r => r.coordination?.presence.state)).toEqual(['online', 'online']);
    expect(probes).toBe(1);
  });

  test('board refresh defaults to 30 seconds and accepts an explicit interval', () => {
    expect(boardInterval()).toBe(30);
    expect(boardInterval('7.5')).toBe(7.5);
  });

  test('one refresh batches run projection and scans inbox once regardless of run count', async () => {
    for (let i = 0; i < 8; i++) ledger(`done-${String(i)}`, { status: 'completed' });
    ledger('live', { status: 'running' });
    const messages = spyOn(Coordination.prototype, 'messages');
    try {
      expect((await createLoader()(50)).rows).toHaveLength(9);
      expect(calls()).toBe(1);
      expect(messages).toHaveBeenCalledTimes(1);
    } finally {
      messages.mockRestore();
    }
  });

  test('a failed query keeps the previous run and marks the row stale; never-seen runs are unreadable', async () => {
    ledger('live', {
      status: 'running',
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
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

  test('--limit keeps every nonterminal and unreadable ledger plus the newest terminal history', async () => {
    ledger('live', { status: 'running' });
    utimesSync(ledgerFile('live'), new Date(1), new Date(1));
    writeFileSync(ledgerFile('bad'), '{');
    for (const i of Array.from({ length: 21 }, (_, n) => n)) {
      const id = `done-${String(i).padStart(2, '0')}`;
      ledger(id, { status: 'completed' });
      const t = new Date(Date.now() + i * 1000);
      utimesSync(ledgerFile(id), t, t);
    }
    expect((await createLoader()(2)).rows.map(r => r.run_id).sort()).toEqual([
      'bad',
      'done-19',
      'done-20',
      'live',
    ]);
  });
});

describe('loader robustness', () => {
  const live = (id: string): Ledger =>
    ledger(id, {
      status: 'running',
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    });
  const orphans = (): string => {
    // Concurrent suites also start sleeps: only this stub's children belong to this assertion.
    const file = join(stubDir, 'children');
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(pid => {
        try {
          process.kill(Number(pid), 0);
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
          return false;
        }
      })
      .join('\n');
  };
  const waitForReap = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (orphans() !== '' && Date.now() < deadline) await Bun.sleep(50);
    expect(orphans()).toBe('');
  };

  test('R2-D01 an external land.json symlink isolates one row across refreshes and report snapshots', async () => {
    const output = join(root, 'out'),
      art = join(output, 'artifacts/runs/a-bad');
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(root, 'plan.json'),
      JSON.stringify({
        base_ref: 'origin/main',
        packages: [{ id: 'p', title: 'p', risk: 'G0', accept: [] }],
      })
    );
    const run: RunView = {
      id: 'a-bad',
      status: 'completed',
      output_root: output,
      nodes: [{ nodeId: 'land', state: 'completed' }],
    };
    const l = ledger('bad', run);
    ledger('ok', { status: 'completed' });
    const outside = join(tmp(), 'land.json');
    writeFileSync(outside, JSON.stringify({ head: 'a'.repeat(40) }));
    symlinkSync(outside, join(art, 'land.json'));
    expect(() => rowOf(l, run, { now: Date.now() })).toThrow('路径越界');
    const load = createLoader();
    for (let i = 0; i < 2; i++) {
      const snap = await load(50);
      const byId = Object.fromEntries(snap.rows.map(r => [r.run_id, r]));
      expect(byId.ok?.state).toBe('completed');
      expect(byId.bad).toMatchObject({
        state: 'unreadable',
        error: expect.stringContaining('路径越界'),
      });
      expect(snap.summary.runs).toBe(2);
      expect(snap.summary.unreadable).toEqual([expect.stringContaining('bad:')]);
      const report = snapshotOf([{ ledger: l, run }]);
      expect(report.rows[0]).toEqual(byId.bad!);
      expect(report.summary.unreadable).toEqual(snap.summary.unreadable);
    }
  });

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
    const schedule = globalThis.setTimeout;
    const ac = new AbortController();
    let expire = (): void => {
      throw new Error('query timeout was not scheduled');
    };
    // Advance only the query deadline after the subprocess is ready; CPU load cannot expire cache seeding.
    const controlledTimer = Object.assign(
      (...input: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
        const [callback, ms, ...args] = input;
        if (ms !== 300) return schedule(callback, ms, ...args);
        expire = () => callback(...args);
        return schedule(() => undefined, ms);
      },
      { __promisify__: schedule.__promisify__ }
    );
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(controlledTimer);
    try {
      const load = createLoader(ac.signal);
      expect((await load(50)).rows[0]).toMatchObject({ state: 'running', stale: false });
      writeFileSync(join(stubDir, 'hang-a-hang'), '');
      const pending = load(50);
      const deadline = Date.now() + 5000;
      while (!existsSync(join(stubDir, 'children')) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(stubDir, 'children'))).toBe(true);
      expire();
      const row = (await pending).rows[0];
      expect(row?.stale).toBe(true);
      expect(row?.state).toBe('running');
      await waitForReap();
    } finally {
      ac.abort(); // Also reap the query if readiness/assertion fails.
      timer.mockRestore();
    }
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
    await waitForReap();
  });

  test('a cached failed or held:gate run that gets cancelled shows cancelled on the next round', async () => {
    ledger('f', { status: 'failed', nodes: [{ nodeId: 'verify-a', state: 'failed' }] });
    ledger('g', { status: 'failed', nodes: [{ nodeId: 'gate-m1-r1', state: 'failed' }] });
    const load = createLoader();
    const states = async (): Promise<string[]> =>
      (await load(50)).rows.map(r => `${r.run_id}:${r.state}`).sort();
    expect(await states()).toEqual(['f:held:engine_suspect', 'g:held:engine_suspect']);
    expect(calls()).toBe(1);
    // cancel/reject 只改 archon，不写 ledger（mtime 不变）
    for (const id of ['f', 'g'])
      writeFileSync(
        join(stubDir, `get-a-${id}.json`),
        JSON.stringify({ id: `a-${id}`, status: 'cancelled' })
      );
    expect(await states()).toEqual(['f:cancelled', 'g:cancelled']);
    expect(calls()).toBe(3); // revision 不可用时 failed 仍实时查询
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

  test('running and held rows tick with the injected now; the header keeps decision information', () => {
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
          width: 160,
          height: 20,
          now: new Date(now),
        }),
        { columns: 160 }
      );
    for (const instant of ['2026-10-10T00:00:50Z', '2026-10-10T00:02:05Z'])
      expect(text(instant).split('\n')[0]).toContain('ETA 未知');
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
    writeFileSync(join(l.gen_dir, 'plan.json'), JSON.stringify({ packages: [] }));
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
    writeFileSync(join(art, 'a.json'), JSON.stringify({ disposition: 'suspend' }));
    const old = JSON.stringify({
      status: 'blocked',
      error_class: 'redline',
      needs: [{ cap: 'approval', why: 'historical', minimal_ask: 'obsolete request' }],
    });
    writeFileSync(join(art, 'old.coder.json'), old);
    writeFileSync(join(art, 'old.json'), JSON.stringify({ disposition: 'advance' }));
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
      { milestone: 'm1', round: 1, verdict: 'unknown', reason: null, debt: 0 },
      { milestone: 'm1', round: 2, verdict: 'unknown', reason: null, debt: 0 },
    ]);
    expect(d.events).toHaveLength(8);
    const last = d.events.at(-1);
    expect(last?.type).toBe('exec_output');
    expect(last?.out?.length).toBeLessThanOrEqual(120);
    expect(last?.out).toEndWith('secret: ***');
    expect(d.next[0]).toBe('superagent decide sa1 approve|reject|retry [--pkg id]');
    expect(detailLines(d, Date.now()).join('\n')).not.toContain('need services');
    expect(d.needs).toEqual([]);
    expect(detailLines(d, Date.now()).join('\n')).not.toContain('obsolete request');
    expect(readFileSync(join(art, 'old.coder.json'), 'utf8')).toBe(old);
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
    const asksPath = join(root, 'home', 'asks.json'),
      id = 'b'.repeat(64);
    const inboxDir = join(root, 'home', 'coord', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const messagePath = join(inboxDir, `${id}.json`);
    const message = JSON.stringify({
      id,
      state: 'done',
      scope: { kind: 'repo', id: '/repo/acknowledged/.git' },
      title: 'acknowledged event',
      sender: { client: 'codex', pid: 1 },
      at: new Date().toISOString(),
    });
    writeFileSync(messagePath, message);
    const asks = JSON.stringify(
      Object.fromEntries([
        ...Array.from({ length: 30 }, (_, i) => [
          `coord:missing-${String(i)}`,
          { status: 'pending' },
        ]),
        [`coord:${id}:1:0`, { status: 'pending' }],
      ])
    );
    writeFileSync(asksPath, asks);
    const r = cli(['--once']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split('\n').length).toBeLessThanOrEqual(20);
    expect(r.out).toContain('异常 30'); // 30 unresolved asks; the unreadable ledger is unverified
    expect(r.out).toContain('待核实 1 项');
    expect(r.out).toContain('暂无活跃任务');
    expect(r.out).toContain('等你 0');
    expect(r.out).not.toContain('acknowledged event');
    expect(readFileSync(asksPath, 'utf8')).toBe(asks);
    expect(readFileSync(messagePath, 'utf8')).toBe(message);
    expect(r.out).toContain('跑 0');
    expect(r.out).toContain('无法解析：coord:missing-0');
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
});

test('summarize, report and the board share one summary', async () => {
  const out = join(root, 'out');
  const art = join(out, 'artifacts', 'runs', 'a-g');
  mkdirSync(art, { recursive: true });
  writeFileSync(
    join(art, 'gate-m1-r1.json'),
    JSON.stringify({ decision: { kind: 'debt', reason: null, evidence: [], debt: ['d1'] } })
  );
  const g = ledger(
    'g',
    {
      status: 'completed',
      completed_at: new Date(Date.now() - 1000).toISOString(),
      output_root: out,
      nodes: [{ nodeId: 'code-a', state: 'completed', durationMs: 4000 }],
    },
    {
      started_at: '2026-10-12T00:00:00.000Z',
      recoveries: ['t'],
      dispositions: [
        {
          at: new Date(Date.now() - 1000).toISOString(),
          action: 'ask',
          reason: 'approval',
          ok: true,
        },
      ],
    }
  );
  const f = ledger(
    'f',
    {
      status: 'failed',
      completed_at: new Date(Date.now() - 1000).toISOString(),
      nodes: [{ nodeId: 'verify-a', state: 'failed' }],
    },
    { started_at: '2026-10-12T00:00:00.000Z' }
  );
  // Report-only metadata is separate from the shared summarize/board counters.
  const {
    usage,
    metrics,
    interventions,
    repo_missing,
    decisions,
    requirements,
    cancellations,
    token_value,
    demands,
    critical_path,
    measurement,
    provider_timing,
    agent_ran_acceptance,
    slow_nodes,
    jobs,
    recorded_blockers,
    human_decisions,
    delivery,
    undelivered,
    ...expected
  } = report();
  expect(decisions).toEqual({});
  expect(human_decisions).toMatchObject({ decisions: [], unknown: expect.any(Array) });
  expect(requirements).toEqual({ g: {}, f: {} });
  expect(measurement).toMatchObject({ 'g/a-g': expect.anything(), 'f/a-f': expect.anything() });
  expect(provider_timing).toMatchObject({ 'g/a-g': expect.anything(), 'f/a-f': expect.anything() });
  expect(agent_ran_acceptance).toBe(0);
  expect(slow_nodes).toEqual([]);
  expect(recorded_blockers).toEqual([]);
  expect(delivery).toEqual({ legacy: 2 });
  expect(undelivered).toMatchObject([{ run: 'g', status: 'legacy' }]);
  expect(cancellations).toEqual({});
  expect(token_value).toEqual({ anomalies: [], packages: [] });
  expect(demands).toMatchObject({
    denominator: 0,
    completed: 0,
    unknown_runs: ['g', 'f'],
    by_request: {},
    elapsed: { coverage: '0/0', p50_ms: 'unknown', p90_ms: 'unknown' },
  });
  expect(critical_path).toEqual({
    'g/a-g': {
      status: 'unknown',
      elapsed_ms: 'unknown',
      reason: 'missing_graph_clock_or_attempt_mapping',
    },
    'f/a-f': {
      status: 'unknown',
      elapsed_ms: 'unknown',
      reason: 'missing_graph_clock_or_attempt_mapping',
    },
  });
  expect(jobs).toEqual({
    receipts: [],
    unreadable: [],
    phase_coverage: { queue_ms: '0/0', prepare_ms: '0/0', exec_ms: '0/0' },
  });
  expect(repo_missing).toEqual([]);
  expect(interventions).toMatchObject({ by_run: { g: 'unknown', f: 'unknown' }, unknown: 2 });
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
  expect(metrics).toEqual(cockpit(await createLoader()(50)).metrics);
  expect(metrics).toMatchObject({ decided: 2, asks: 1 });
});

test('R1-05: actual board loader projects takeover owner rather than launcher, including cross-host unknown', async () => {
  const repo = gitRepo(tmp()),
    l = ledger(
      'owner-ref',
      { status: 'paused' },
      { repo, launcher: { client: 'codex', pid: 999999, tty: null, cwd: repo } }
    );
  const c = coord(),
    scope = runScope(l),
    a = caller(true);
  c.claim(repoScope(repo), a, true, 'fixture repository contact');
  c.claim(scope, a, true, 'fixture initial controller');
  const b = { ...a, client: 'claude', session_id: 'new-owner', host: 'remote-host' };
  c.claim(scope, b, true, 'fixture takeover');
  const snap = await createLoader()(50);
  expect(snap.rows[0]?.coordination).toMatchObject({ owner: b, presence: { state: 'unknown' } });
  expect(snap.activity?.runs?.find(r => r.run_id === l.run_id)).toMatchObject({
    controller: b,
    owner: null,
    inferred: false,
  });
});

test('pending asks follow real engine hold mapping, including failed coder nodes', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  for (const [reason, expectedReason, expectedNeeds] of [
    ['review_limit', undefined, []],
    ['approval', 'approval', ['approval']],
    ['coder', 'coder', []],
    ['signoff', 'signoff', ['signoff']],
  ] as const) {
    const node =
      reason === 'coder'
        ? 'code-a'
        : reason === 'approval'
          ? 'approval-a'
          : reason === 'signoff'
            ? 'human-m1'
            : 'gate-m1-r1';
    const paused = reason === 'approval' || reason === 'signoff';
    const run: RunView = {
      id: `a-${reason}`,
      status: paused ? 'paused' : 'failed',
      nodes: [{ nodeId: node, state: paused ? 'running' : 'failed' }],
      ...(paused ? { metadata: { approval: { nodeId: node } } } : {}),
      output_root: join(root, 'out'),
    };
    const l = ledger(reason, run);
    if (reason === 'review_limit') {
      const art = join(run.output_root!, 'artifacts', 'runs', run.id);
      mkdirSync(art, { recursive: true });
      writeFileSync(
        join(art, `${node}.json`),
        JSON.stringify({
          decision: {
            kind: 'block',
            reason: 'acceptance_failed+review_limit',
            evidence: [],
            debt: [],
          },
        })
      );
    }
    const snap = snapshotOf([{ ledger: l, run }], now);
    expect(snap.rows[0]?.askReason).toBe(expectedReason);
    snap.asks = { [`${reason}:${reason}`]: { status: 'pending' } };
    expect(cockpit(snap, now).needs.map(r => r.id)).toEqual([...expectedNeeds]);
    for (const status of ['completed', 'cancelled', 'running'] as const) {
      const resumed = snapshotOf(
        [{ ledger: l, run: { ...run, status, metadata: {}, nodes: [] } }],
        now
      );
      resumed.asks = snap.asks;
      expect(cockpit(resumed, now).needs).toEqual([]);
    }
  }
});

test('P1 deleted repository uses the same report and board fallback', async () => {
  ledger(
    'gone',
    {
      status: 'completed',
      nodes: [{ nodeId: 'code-core', state: 'completed', durationMs: 19387000 }],
    },
    { repo: join(root, 'deleted') }
  );
  const snapshot = await createLoader()(50);
  const summary = report();
  expect(snapshot.summary.unreadable).toEqual([]);
  expect(summary.unreadable).toEqual([]);
  expect(snapshot.summary['state:completed']).toBe(summary['state:completed']);
  expect(snapshot.summary['node_s:code']).toBe(summary['node_s:code']);
  expect(snapshot.summary['node_s:code']).toBe(19387);
});

test('cockpit view changes by snapshot or ten-second bucket while freshness ticks', async () => {
  const snap = { at: '2026-10-23T00:00:00Z', summary: {}, rows: [] };
  const first = new Date('2026-10-23T00:00:01Z');
  const project = spyOn(cockpitModule, 'cockpit');
  const node = (snapshot: typeof snap, now: Date) =>
    createElement(BucketedFrame, { snap: snapshot, width: 80, height: 20, now });
  const app = render(node(snap, first), { stdout: new PassThrough(), interactive: false });
  await app.waitUntilRenderFlush();
  app.rerender(node(snap, new Date(first.getTime() + 1000)));
  await app.waitUntilRenderFlush();
  expect(project).toHaveBeenCalledTimes(1);
  app.rerender(node({ ...snap }, new Date(first.getTime() + 2000)));
  await app.waitUntilRenderFlush();
  app.rerender(node(snap, new Date(first.getTime() + 10_000)));
  await app.waitUntilRenderFlush();
  expect(project).toHaveBeenCalledTimes(3);
  expect(renderToString(node(snap, first))).toContain('1s前');
  expect(renderToString(node(snap, new Date(first.getTime() + 1000)))).toContain('2s前');
  app.unmount();
  project.mockRestore();
});

test('R1-1 loader and report retain unknown human needs and malformed asks, without duplicates', async () => {
  const gate = { nodeId: 'human-m1', pauseId: 'p', message: '当前签收问题' };
  const run: RunView = {
    id: 'a-human',
    status: 'paused',
    metadata: {
      approval: gate,
    },
  };
  const l = ledger('human', run, { repo: gitRepo(tmp()) });
  writeFileSync(join(l.gen_dir, 'plan.json'), JSON.stringify({ packages: [{ title: '测试' }] }));
  const asks = {
    'human:signoff': { status: 'pending' },
    malformed: { status: 'pending' },
    'orphan:signoff': { status: 'unknown' },
  };
  writeFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), JSON.stringify(asks));
  const load = createLoader();
  const fresh = await load(50);
  const reportSnapshot = snapshotOf([{ ledger: l, run }]);
  reportSnapshot.asks = asks;
  const projected = cockpit(fresh);
  expect(projected.needs).toHaveLength(1);
  expect(projected.needs[0].question).toContain('当前签收问题');
  expect(projected.needs.map(n => n.question)).toEqual(
    cockpit(reportSnapshot).needs.map(n => n.question)
  );
  expect(projected.anomalies).toEqual(['无法解析：malformed', '无法解析：orphan:signoff']);
  writeFileSync(join(stubDir, 'fail-a-human'), '1');
  const stale = await load(50);
  expect(stale.rows[0].stale).toBe(true);
  expect(cockpit(stale).needs).toHaveLength(1);
  expect(cockpit(stale).needs[0].question).toContain('未知');
  expect(cockpit(stale).needs[0].decision).toBeUndefined();
  // The loader catches descriptor failures (e.g. an unreadable frozen plan).
  writeFileSync(join(l.gen_dir, 'plan.json'), '{');
  const broken = snapshotOf([{ ledger: l, run }]);
  broken.asks = asks;
  expect(broken.rows[0].humanDecision).toBeUndefined();
  expect(cockpit(broken).needs.map(n => n.id)).toEqual(['human']);
});
