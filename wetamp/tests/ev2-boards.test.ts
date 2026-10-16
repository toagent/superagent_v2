import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Frame } from '../src/board/App';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';
import { unknownProgress } from '../src/board/eta';
import { memoryData, type Episode, type Lesson } from '../src/memory';
import { memoryOverview, memoryPanel } from '../src/web/memory';
import { handler } from '../src/web/server';
import { attach } from '../src/board/activity';
import { tmp } from './helpers';

const at = '2026-10-10T04:00:00Z',
  now = new Date(at),
  ms = now.getTime();
const saved = {
  SUPERAGENT_HOME: process.env.SUPERAGENT_HOME,
  ARCHON_HOME: process.env.ARCHON_HOME,
  TZ: process.env.TZ,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const iso = (seconds: number): string => new Date(ms + seconds * 1000).toISOString();
function row(id: string, state = 'running'): BoardRow {
  return {
    run_id: id,
    archon_id: `native-${id}`,
    repo: id,
    state,
    nativeState: 'running',
    lastEvent: iso(-30),
    nodes: { done: 2, total: 4, current: 'code-a', currentRole: 'coder' },
    activeNodes: [],
    started_at: iso(-600),
    span: null,
    elapsed_s: null,
    exit: null,
    held: null,
    recoveries: 0,
    auto_retries: 0,
    console: 'codex',
    branch: 'b',
    evidence: '',
    plan: '',
    stale: false,
    engine: {
      title: `${id}交付`,
      milestones: [],
      currentMilestone: null,
      states: [],
      firstPass: id === 'complete',
      reason: '',
      dispositions: [],
    },
  };
}
function snapshot(): Snapshot {
  const a = row('active'),
    held = { ...row('held', 'held:gate'), askReason: 'approval' as const },
    dead = row('zombie');
  dead.lastEvent = iso(-1800);
  a.activeNodes = [
    { id: 'code-a', role: 'coder', model: 'gpt-6.1-sol' },
    { id: 'review-b', role: 'reviewer', model: 'gpt-6-astra' },
  ];
  const progress = { pct: 62, eta_s: 840, overrun_s: 0, basis: 'history' as const };
  return {
    at,
    summary: {},
    rows: [a, held, dead],
    reflection: { day: '2026-10-10', tokens: 5000000, limit: 5000000, yellow: true },
    asks: {
      'held:approval:1': { status: 'pending' },
      'active:approval:0': { status: 'superseded' },
    },
    eta: { active: { progress, weight: 1200, nodes: { 'code-a': progress } } },
    activity: {
      terms: [],
      procs: [],
      remote: [],
      notes: [],
      jobs: ['j1', 'j2'].map(id => ({
        id,
        title: id,
        cwd: '/repo/interactive',
        kind: 'codex',
        card: null,
        log: null,
        model: 'gpt-6.1-sol',
        role: 'general',
        tier: 'general',
        wrapper_pid: 1,
        pid: 2,
        started_at: iso(-600),
        state: 'running',
        owner: null,
        guess: false,
        pidAlive: true,
        heartbeatAt: iso(-10),
      })),
    },
  };
}
for (const width of [120, 56])
  test(`EV2 alive tree ${String(width)} columns`, () => {
    process.env.TZ = 'Asia/Taipei';
    const s = snapshot(),
      c = cockpit(s, ms),
      text = renderToString(createElement(Frame, { snap: s, width, height: 100, now }), {
        columns: width,
      });
    expect(c.tree.map(r => [r.project, r.children.length])).toEqual([
      ['active', 2],
      ['interactive', 2],
    ]);
    const frame = Frame({ snap: s, width, height: 100, now });
    const header = (frame.props as { children: { props: { color?: string } }[] }).children[0];
    expect(header.props.color).toBeUndefined();
    expect(c.zombies).toBe(1);
    expect(c.reflection?.yellow).toBe(true);
    expect(c.needs).toHaveLength(1);
    expect(text.split('\n')[0]).toContain('等你 1');
    expect(text).not.toContain('反思');
    expect(text).not.toContain('今日');
    expect(text).toContain('zombie'); // stale runs remain visible, never silently completed
    expect(text).not.toContain('?%');
    if (width >= 100) expect(text).toContain('62% 剩~14m');
    expect(text).toContain('需要你');
    if (width >= 100) {
      expect(text).toContain('第1轮');
      expect(text).toContain('code-a');
    }
    for (const line of text.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  });
test('activity projects exact bound heartbeat and observed child PID; stale/future heartbeats fail closed', () => {
  const s = snapshot(),
    j = s.activity!.jobs[0],
    live = {
      pid: j.pid,
      at: iso(-1),
      role: 'general' as const,
      event: 'tool',
      tool: null,
      turn_at: at,
      transcript_path: null,
      cwd: j.cwd,
    };
  const a = attach(
    new Map([[j.pid, { ppid: 0, tty: '??', cpu: 1, etime: 1, argv: ['codex'] }]]),
    [],
    [j],
    [],
    [live],
    null
  );
  expect(a.jobs[0]).toMatchObject({ pidAlive: true, heartbeatAt: iso(-1) });
  for (const heartbeatAt of [iso(-600), iso(1), null]) {
    const x = snapshot();
    x.activity!.jobs[0].heartbeatAt = heartbeatAt;
    expect(cockpit(x, ms).tree.at(-1)?.children).toHaveLength(1);
  }
  const x = snapshot();
  x.rows[0].lastEvent = iso(-600);
  expect(cockpit(x, ms).zombies).toBe(2);
});
function setupMemory() {
  const root = tmp();
  Object.assign(process.env, {
    SUPERAGENT_HOME: root,
    ARCHON_HOME: join(root, 'archon'),
    TZ: 'Asia/Taipei',
  });
  mkdirSync(join(root, 'memory/episodes'), { recursive: true });
  const episodes: Episode[] = ['failed', 'paused', 'completed', 'completed'].map((status, i) => ({
    id: ['failure', 'held', 'long', 'complete'][i],
    at: iso(-i * 60),
    source: 'run',
    status,
    project: '/repo/demo',
    tag: 'ts-cli',
    risk: 'G1',
    size: 'S',
    model: 'gpt-6.1-sol',
    fake: false,
    packages: [{ id: 'p', tag: 'ts-cli', risk: 'G1', size: 'S' }],
    duration_ms: i === 2 ? 240000 : 60000,
    p50_ratio: i === 2 ? 4 : 1,
    reasons: i === 0 ? ['review_failed'] : [],
    category: 'project',
    signature: 'review_failed',
    fingerprint: null,
    incidents: [],
    timeline: [],
    acceptance: [],
    findings: i === 0 ? ['high:missing'] : [],
    diff: null,
    tokens: [{ role: 'general', model: 'gpt-6.1-sol', total: (i + 1) * 100 }],
    asks: [],
    dispositions: i === 1 ? [{ at, action: 'ask', reason: 'approval', ok: true }] : [],
    signals: { engine_suspect: 0, dup_ask: 0, orphan_hold: 0, stale_answer: 0 },
  }));
  episodes.forEach(e =>
    writeFileSync(join(root, 'memory/episodes', e.id + '.json'), JSON.stringify(e))
  );
  writeFileSync(
    join(root, 'memory/fold-index.json'),
    JSON.stringify({
      deliveries: Object.fromEntries(
        episodes
          .filter(e => ['completed', 'failed', 'cancelled'].includes(e.status))
          .map(e => [
            e.id,
            { status: e.status, packages: e.packages.length, tokens: e.tokens[0].total },
          ])
      ),
    })
  );
  const lessons: Lesson[] = ['trial', 'stable', 'retired', 'mechanized'].map((status, i) => ({
    id: `l${String(i)}`,
    tier: 'project',
    scope: '/repo/demo',
    tag: 'ts-cli',
    when: '启动前',
    do: `确认条件${String(i)}`,
    dont: '',
    why: '已验证',
    evidence: [episodes[i].id],
    mechanizable: false,
    category: 'project',
    reasons: ['review_failed'],
    status: status as Lesson['status'],
    helpful: i === 1 ? 3 : 0,
    harmful: i === 2 ? 1 : 0,
    created_at: iso(-86400),
    last_hit: at,
  }));
  const entries = [
    { lessons, day: '2026-10-10', tokens: 5000000 },
    { lessons: [], reflected: 'failure', result: '提炼 1 条' },
    { lessons: [], scored: 'complete', hit_ids: ['l1'] },
    { lessons: [], scored: 'long', hit_ids: [] },
  ];
  writeFileSync(
    join(root, 'memory/lessons.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  );
  const s = snapshot();
  s.rows = episodes.map(e => ({
    ...row(e.id, e.status),
    nativeState: e.status as BoardRow['nativeState'],
    interventions: e.id === 'held' ? 1 : 0,
  }));
  return { root, s };
}
test('EV2 default/all history and evolution metrics match hand-calculated fixture', () => {
  const { s } = setupMemory(),
    data = memoryData(ms),
    d = memoryOverview(s, data);
  expect(d.rows.map(r => r.id)).toEqual(['failure', 'held', 'long']);
  expect(memoryOverview(s, data, true).rows).toHaveLength(4);
  expect(d.metrics).toEqual({
    '同类失败复发率（近7天 / 前7天）': '0% / —',
    一次通过率: '33%',
    人工干预次数: 1,
    '每个交付包 token': '267',
    经验命中率: '50%',
    经验有效率: '75%',
    引擎自修复次数: 0,
  });
  s.rows[0].interventions = undefined;
  expect(memoryOverview(s, data).metrics.人工干预次数).toBe('未知');
  expect(d.queued).toBe(0);
  expect(d.reflection.yellow).toBe(true);
  const page = memoryPanel(d, false);
  expect(page).toMatchSnapshot();
  expect(page.match(/data-episode=/g)).toHaveLength(3);
  expect(page).toContain('/console/r/native-failure');
  expect(page).toContain('<details><summary>退役');
  expect(page).toContain('?filter=all');
});
test('week recurrence keys require both project and reason; empty samples stay unknown', () => {
  const { s } = setupMemory(),
    d = memoryData(ms),
    first = d.all[0];
  d.all = [
    { ...first, id: 'old', at: iso(-8 * 86400) },
    { ...first, id: 'new', at: iso(-86400) },
    { ...first, id: 'other', project: '/repo/other', at: at },
  ];
  expect(memoryOverview(s, d).metrics['同类失败复发率（近7天 / 前7天）']).toBe('50% / 0%');
  d.all = [];
  d.deliveries = {};
  expect(memoryOverview(s, d).metrics['每个交付包 token']).toBe('—');
});
test('history and episode routes are authenticated, read-only and confined with no writes', async () => {
  const { root, s } = setupMemory(),
    file = join(root, 'memory/lessons.jsonl'),
    before = readFileSync(file, 'utf8');
  const h = handler(
    39900,
    'fixture-auth',
    () => ({}),
    'http://localhost',
    fetch,
    undefined,
    () => s
  );
  const request = (path: string, method = 'GET', auth = true) =>
    h(
      new Request(`http://127.0.0.1:39900${path}`, {
        method,
        headers: { host: '127.0.0.1:39900', ...(auth ? { cookie: 'sa_web=fixture-auth' } : {}) },
      })
    );
  expect((await request('/sa/memory')).status).toBe(200);
  expect((await request('/sa/memory', 'POST')).status).toBe(403);
  expect((await request('/sa/memory', 'GET', false)).status).toBe(401);
  const json = await request('/sa/memory/episode?id=failure');
  expect(json.status).toBe(200);
  expect(await json.json()).toMatchObject({ id: 'failure' });
  expect((await request('/sa/memory/episode?id=../lessons')).status).toBe(404);
  const outside = tmp();
  writeFileSync(join(outside, 'secret.json'), '{}');
  symlinkSync(join(outside, 'secret.json'), join(root, 'memory/episodes/outside.json'));
  expect((await request('/sa/memory/episode?id=outside')).status).toBe(404);
  expect(() => memoryData(ms)).toThrow('路径越界');
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(unknownProgress().pct).toBeNull();
});

test('history excludes short running episodes, escapes text, and keeps missing token/p50 unknown', () => {
  const { s } = setupMemory(),
    data = memoryData(ms);
  data.all.push({
    ...data.all[0],
    id: 'short-running',
    status: 'running',
    p50_ratio: null,
    tokens: [],
  });
  expect(memoryOverview(s, data).rows).toHaveLength(3);
  const d = memoryOverview(s, data, true),
    missing = d.rows.find(r => r.id === 'short-running')!;
  expect(missing.tokenText).toBe('—');
  missing.title = '<script>private</script>';
  const page = memoryPanel(d, true);
  expect(page).not.toContain('<script>private');
  expect(page).toContain('&lt;script&gt;private');
});

test('EV-R1-06 delivery token metric includes ordinary terminal runs without episodes', () => {
  const { root, s } = setupMemory();
  writeFileSync(
    join(root, 'memory/fold-index.json'),
    JSON.stringify({
      deliveries: {
        failure: { status: 'failed', packages: 1, tokens: 100 },
        long: { status: 'completed', packages: 1, tokens: 300 },
        complete: { status: 'completed', packages: 1, tokens: 400 },
        ordinary: { status: 'completed', packages: 2, tokens: 1200 },
        unknown: { status: 'cancelled', packages: 1, tokens: null },
      },
    })
  );
  const data = memoryData(ms);
  expect(data.all.some(e => e.id === 'ordinary')).toBe(false);
  expect(memoryOverview(s, data).metrics['每个交付包 token']).toBe('400');
});

test('EV-R1-04 episode JSON route reads current projection and keeps first archive', async () => {
  const { root, s } = setupMemory();
  mkdirSync(join(root, 'memory/projections'));
  const before = readFileSync(join(root, 'memory/episodes/held.json'), 'utf8');
  writeFileSync(
    join(root, 'memory/projections/held.json'),
    JSON.stringify({
      ...JSON.parse(before),
      status: 'failed',
      category: 'engine',
      signature: 'engine_suspect',
    })
  );
  const h = handler(
    39900,
    'fixture-auth',
    () => ({}),
    'http://localhost',
    fetch,
    undefined,
    () => s
  );
  const response = await h(
    new Request('http://127.0.0.1:39900/sa/memory/episode?id=held', {
      headers: { host: '127.0.0.1:39900', cookie: 'sa_web=fixture-auth' },
    })
  );
  expect(await response.json()).toMatchObject({
    status: 'failed',
    category: 'engine',
    signature: 'engine_suspect',
  });
  expect(readFileSync(join(root, 'memory/episodes/held.json'), 'utf8')).toBe(before);
});

test('board-v2 resolves coord wire keys, suppresses acknowledgements and deduplicates read-only', () => {
  const message = {
    id: 'a'.repeat(64),
    scope: { kind: 'repo' as const, id: '/repo/payments/.git' },
    sender: { client: 'codex', session_id: 'sender-session', pid: 1 },
    recipient: null,
    generation: 2,
    kind: 'task' as const,
    title: '修复付款节点',
    body: '',
    evidence: [],
    severity: 'urgent' as const,
    state: 'escalated' as const,
    at: iso(-120),
    ask: { status: 'pending', question: 'opaque prose', generation: 2, owner: null },
  };
  const s = snapshot();
  s.coordMessages = [message];
  s.asks = {
    [`coord:${message.id}:2:0`]: { status: 'pending' },
    [`coord:${message.id}`]: { status: 'unknown' },
    [`coord:${message.id}:1:0`]: { status: 'pending' },
    'coord:missing:2:0': { status: 'pending' },
    unparseable: { status: 'pending' },
    'held:approval:1': { status: 'pending' },
    'held:approval:2': { status: 'pending' },
  };
  const before = JSON.stringify(s),
    c = cockpit(s, ms);
  expect(c.needs).toHaveLength(2);
  expect(c.anomalies).toEqual(['无法解析：coord:missing:2:0', '无法解析：unparseable']);
  expect(c.needs[0]).toMatchObject({
    project: 'payments',
    title: message.title,
    stage: 'sender-s',
    waiting: '2m00s',
  });
  const text = renderToString(createElement(Frame, { snap: s, width: 200, height: 20, now }), {
    columns: 200,
  });
  expect(text).toContain('等你 2');
  expect(text).toContain('异常 2');
  const needs = text.split('\n').filter(line => line.startsWith('?'));
  expect(needs).toHaveLength(2);
  for (const line of needs) expect(line).toMatch(/.+·.+\/.+·.+是=.+否=.+ 已等/);
  expect(needs[0]).toContain('payments');
  expect(needs[0]).toContain('修复付款节点');
  expect(JSON.stringify(s)).toBe(before);
  s.coordMessages = [{ ...message, title: '修复付款节点'.repeat(30) }];
  const longTitle = renderToString(createElement(Frame, { snap: s, width: 160, height: 20, now }), {
    columns: 160,
  });
  expect(longTitle.split('\n').find(line => line.startsWith('? payments'))).toContain('否=继续等');
  for (const width of [38, 56, 62, 80]) {
    const narrow = renderToString(createElement(Frame, { snap: s, width, height: 20, now }), {
      columns: width,
    });
    const line = narrow.split('\n').find(line => line.startsWith('?'))!;
    if (width === 38) {
      expect(narrow).toContain('是=发现者接管 否=继续等');
      expect(narrow).toContain('已等2m00s');
    } else {
      expect(line).toContain('是=发现者接管 否=继续等 已等2m00s');
      expect(line).toMatch(/.+·.+\/.+·.+是=/);
    }
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  }
  for (const state of ['accepted', 'done', 'rejected'] as const) {
    s.coordMessages = [{ ...message, state }];
    expect(cockpit(s, ms).needs.map(r => r.id)).toEqual(['held']);
  }
});

for (const width of [38, 54, 82, 120])
  for (const height of [20, 32])
    test(`pane ${width}x${height}: bounded cards, alerts and snapshot freshness`, () => {
      const s = snapshot();
      s.rows[0].engine!.title = '\x1b[31m长中文任务标题\x1b[0m'.repeat(10);
      s.summary.load_error = 'offline';
      const done = {
        ...row('delivered', 'completed'),
        nativeState: 'completed' as const,
        completed_at: iso(-5),
      };
      s.rows.push(done, row('unknown', 'unknown'));
      s.activity!.jobs.push(
        ...Array.from({ length: 8 }, (_, i) => ({
          ...s.activity!.jobs[0],
          id: `job-${i}`,
          title: `登记任务${i}`,
        }))
      );
      const before = JSON.stringify(s);
      const text = renderToString(createElement(Frame, { snap: s, width, height, now }), {
        columns: width,
      });
      const lines = text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(height);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      expect(text).not.toContain('\x1b');
      for (const value of [
        '载入失败：offline',
        '数据 ',
        '长中文任务标题',
        '编码',
        '62%',
        '还有 ',
        '近期完成',
        'delivered交付',
        '是=批准',
        '否=终止',
        '已等',
      ])
        expect(text).toContain(value);
      expect(JSON.stringify(s)).toBe(before);
    });

test('pane prioritizes unresolved runs and live jobs over terminal history', () => {
  const s = snapshot();
  s.rows.unshift(
    ...Array.from({ length: 20 }, (_, i) => {
      const state = i % 2 ? ('cancelled' as const) : ('failed' as const);
      return { ...row(`history-${i}`, state), nativeState: state };
    })
  );
  s.rows.push(
    row('unknown', 'unknown'),
    row('lost', 'owner_lost'),
    { ...row('cached', 'failed'), nativeState: 'failed', stale: true },
    row('conflict', 'failed')
  );
  const text = renderToString(createElement(Frame, { snap: s, width: 50, height: 47, now }), {
    columns: 50,
  });
  const titles = [
    'active交付',
    'held交付',
    'zombie交付',
    'unknown交付',
    'lost交付',
    'cached交付',
    'conflict交付',
    'j1 ·',
    'j2 ·',
    'history-0交付',
  ];
  for (const title of titles) expect(text).toContain(title);
  for (let i = 1; i < titles.length; i++)
    expect(text.indexOf(titles[i])).toBeGreaterThan(text.indexOf(titles[i - 1]));
  expect(text).toContain('任务 · 29');
  expect(text).toContain('项任务未显示');
});

test('pane separates process exit from run completion and preserves missing/stale evidence', () => {
  const s = snapshot();
  s.rows = [
    row('unknown', 'unknown'),
    { ...row('cached'), stale: true },
    row('lost', 'owner_lost'),
  ];
  s.asks = {};
  s.activity!.jobs[0].state = 'done';
  s.activity!.jobs[0].ended_at = iso(-1);
  s.activity!.jobs[1].pidAlive = false;
  const render = (now: Date) =>
    renderToString(createElement(Frame, { snap: s, width: 82, height: 32, now }), { columns: 82 });
  const text = render(now);
  for (const value of [
    'unknown',
    '数据陈旧',
    'owner_lost',
    '心跳失联',
    '进程结束·未验收',
    '查询失败',
  ])
    expect(text).toContain(value);
  expect(text).not.toContain('完成 ·');
  expect(
    render(new Date(ms + 60000))
      .split('\n')
      .at(-1)
  ).toContain('1m00s前');
  expect(render(now).split('\n').at(-1)).toContain('0s前');
});

test('empty pane and tiny heights keep data freshness without invented completion', () => {
  const s: Snapshot = { at: 'invalid', rows: [], summary: {} };
  for (const height of [1, 2, 3, 20]) {
    const text = renderToString(createElement(Frame, { snap: s, width: 38, height, now }), {
      columns: 38,
    });
    expect(text.split('\n').length).toBeLessThanOrEqual(height);
    expect(text).toContain('时效未知');
    expect(text).not.toContain('完成');
    if (height === 20) expect(text).toContain('无进行中任务');
  }
});
