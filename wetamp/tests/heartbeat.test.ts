import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';
// prettier-ignore
import { adoptedRuns, heartbeat, heartbeatSummary, responsibilities, queueTickStaleAlert, shouldWriteHeartbeat, tickHealth, type TickRecord } from '../src/heartbeat';
import { coord, repoScope, same, type Identity, type Presence } from '../src/coord';
import { EXIT } from '../src/cli';
import { generalKey } from '../src/stall';
import { gitRepo, tmp } from './helpers';
const now = Date.parse('2026-10-29T10:00:00Z');
// prettier-ignore
const owner = (pid: number): Identity => ({ client: 'codex', host: 'host', pid, pid_start: `start-${String(pid)}` });
const row = (id: string, who: Identity | null, state = 'running'): BoardRow => ({
  run_id: id,
  archon_id: id,
  repo: `/repo/${id}`,
  state,
  exit: 4,
  nativeState: 'running',
  nodes: { done: 0, total: 2, current: 'code-core', currentRole: 'coder' },
  activeNodes: [
    { id: 'code-core', role: 'coder', model: 'gpt' },
    { id: 'review-core', role: 'reviewer', model: 'opus' },
  ],
  coordination: {
    owner: who,
    presence: who ? { state: 'online', activity: 'active' } : { state: 'unknown' },
    pending: 0,
  },
  started_at: '2026-10-29T09:00:00Z',
  span: { started_ms: now - 3_600_000, ended_ms: null },
  elapsed_s: 3600,
  held: null,
  lastEvent: '2026-10-29T09:55:00Z',
  recoveries: 0,
  auto_retries: 0,
  console: 'codex',
  branch: 'sa/x',
  evidence: '',
  plan: '',
  stale: false,
});

test('heartbeat groups only online owners and counts unreadable and unowned rows', () => {
  const a = owner(1),
    b = owner(2),
    dead = owner(3);
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [
      row('a', a),
      row('b', b),
      row('dead', dead, 'failed'),
      row('orphan', dead, 'held:gate'),
      ...Array.from({ length: 100 }, (_, i) => row(`unowned-${String(i)}`, null)),
      ...Array.from({ length: 100 }, (_, i) => row(`unreadable-${String(i)}`, a, 'unreadable')),
    ],
  };
  const presence = (who: Identity): Presence =>
    who.pid === 3 ? { state: 'offline' } : { state: 'online', activity: 'active' };
  const result = heartbeat(snap, cockpit(snap, now), now, presence, new Set(['dead']));
  expect(result.marshals.map(m => m.owner_key)).toEqual([
    ['codex', null, 'host', 1, 'start-1'],
    ['codex', null, 'host', 2, 'start-2'],
    'unknown',
  ]);
  expect(result).toMatchObject({ unowned: 101, unreadable: 100, reclaim_pending: 0, legacy: 1 });
  expect(JSON.stringify(result).length).toBeLessThan(3000);
  expect(result.marshals[0]?.running.map(item => item.role)).toEqual(['将军·gpt', '军师·opus']);
  expect(result.reclaim_pending).toBe(0);
  expect(JSON.stringify(result)).not.toContain('dead');
  expect(result.marshals.find(item => item.owner === 'unknown')?.waiting[0]).toMatchObject({
    id: 'orphan',
    waiting_for: '无人负责',
  });
  const selected = heartbeatSummary(result, b, now + 19 * 60_000);
  expect(selected).toMatchObject({
    available: true,
    warnings: ['心跳过期 19m'],
  });
  expect(selected.available && selected.running.map(item => item.id)).toEqual(['b', 'b']);
  expect(heartbeatSummary(result, owner(9), now)).toEqual({
    available: false,
    reason: 'caller heartbeat unavailable',
  });
});

test('heartbeat omits cleaned lost jobs from responsibilities', () => {
  const launcher = { ...owner(1), tty: null, cwd: '/missing/project', client: 'codex' as const },
    job = {
      id: 'lost',
      title: 'lost',
      card: null,
      log: null,
      cwd: launcher.cwd,
      kind: 'codex' as const,
      model: null,
      launcher,
      wrapper_pid: 0,
      pid: 0,
      started_at: new Date(now - 59 * 60_000).toISOString(),
      state: 'lost' as const,
      tier: 'general' as const,
      guess: false,
      owner: null,
    };
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [],
    activity: {
      jobs: [job, { ...job, id: 'cleaned', ended_at: new Date(now).toISOString() }],
      terms: [],
      procs: [],
      remote: [],
      notes: [],
    },
  };
  const result = heartbeat(snap, cockpit(snap, now), now, () => ({
    state: 'online',
    activity: 'active',
  }));
  expect(result.marshals[0]?.waiting.map(item => item.id)).toEqual(['lost']);
});

// prettier-ignore
test('heartbeat keeps online job launchers and falls back to the repository owner', () => {
  const root = tmp(), repo = gitRepo(root), sa = join(root, 'sa'), previous = process.env.SUPERAGENT_HOME;
  mkdirSync(sa); process.env.SUPERAGENT_HOME = sa;
  const launcher = { ...owner(1), client: 'codex' as const, cwd: repo, tty: null }, repositoryOwner = owner(2);
  try {
    coord().claim(repoScope(repo), repositoryOwner);
    for (const [launcherPresence, repositoryOwnerPresence, state, expected, unowned] of [
      ['online', 'offline', 'running', launcher, false],
      ['offline', 'online', 'lost', repositoryOwner, false],
      ['unknown', 'online', 'running', repositoryOwner, false],
      ['online', 'online', 'running', launcher, false],
      ['offline', 'offline', 'lost', null, false],
      ['offline', 'offline', 'running', null, true],
    ] as const) {
      const job = { id: `job-${state}`, title: 'job', card: null, log: null, cwd: repo, kind: 'codex' as const, model: null, launcher, wrapper_pid: 0, pid: 0, started_at: new Date(now).toISOString(), state, tier: 'general' as const, guess: false, owner: null, pidAlive: true, heartbeatAt: new Date(now).toISOString() };
      const snap: Snapshot = { at: new Date(now).toISOString(), summary: {}, rows: [], activity: { jobs: [job], terms: [], procs: [], remote: [], notes: [] } };
      const presence = (who: Identity): Presence => { const value = same(who, launcher) ? launcherPresence : repositoryOwnerPresence; return value === 'online' ? { state: value, activity: 'active' } : { state: value }; };
      const result = heartbeat(snap, cockpit(snap, now), now, presence), marshal = expected && result.marshals.find(m => m.owner !== 'unknown' && same(m.owner, expected));
      if (expected) expect((state === 'lost' ? marshal?.waiting : marshal?.running)?.map(item => item.id)).toEqual([job.id]);
      expect(result.reclaim_pending).toBe(!expected && state === 'lost' ? 1 : 0);
      expect(result.marshals.some(m => m.owner === 'unknown')).toBe(unowned);
    }
  } finally { if (previous === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = previous; }
});

test('heartbeat separates active runs from typed waits and reports coordination once', () => {
  const who = owner(1),
    failed = row('failed', who, 'failed'),
    held = row('held', who, 'held:gate'),
    needs = row('needs', who, 'held:gate'),
    running = row('running', who),
    unknown = row('unknown', who, 'unreadable');
  unknown.exit = null;
  for (const item of [failed, held, needs, running, unknown]) item.repo = '/repo/project';
  // prettier-ignore
  failed.engine = { title: 'failed', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: 'repair_exhausted:scope_violation', dispositions: [] };
  // prettier-ignore
  held.engine = { title: 'held', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: 'review_limit', dispositions: [] };
  // prettier-ignore
  needs.engine = { title: 'needs', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: 'coder_needs', dispositions: [] };
  running.coordination!.pending = 2;
  failed.waiting_on = { run: 'unknown', reason: '等修复包', since: '2026-10-29T09:54:00Z' };
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [failed, held, needs, running, unknown, row('other', who)],
    coordMessages: [
      {
        id: 'run-queued',
        scope: { kind: 'run', id: 'running', repo: '/repo/project' },
        state: 'queued',
        at: '2026-10-29T09:58:00Z',
      },
      {
        id: 'run-accepted',
        scope: { kind: 'run', id: 'running', repo: '/repo/project' },
        state: 'accepted',
        at: '2026-10-29T09:57:00Z',
      },
      {
        id: 'repo-surfaced',
        scope: { kind: 'repo', id: '/repo/project' },
        state: 'surfaced',
        at: '2026-10-29T09:56:00Z',
      },
    ] as Snapshot['coordMessages'],
  };
  snap.rows.push(row('adopted', who, 'failed'));
  const runs = join(tmp(), 'runs');
  mkdirSync(runs);
  writeFileSync(join(runs, 'next.json'), JSON.stringify({ adoptions: [{ from: 'adopted' }] }));
  snap.rows[5]!.repo = '/repo/project';
  const result = heartbeat(
    snap,
    cockpit(snap, now),
    now,
    () => ({ state: 'online', activity: 'active' }),
    new Set(),
    adoptedRuns(runs)
  );
  const marshal = result.marshals[0]!;
  expect([...new Set(marshal.running.map(item => item.id))]).toEqual(['running', 'other']);
  expect(marshal.waiting.map(item => [item.id, item.waiting_for])).toEqual([
    ['failed', '等待 unknown：等修复包'],
    ['held', '评审轮次用尽'],
    ['needs', '编码端需要补充能力'],
    ['running', '1 条协调消息'],
    ['repo:/repo/project', '1 条协调消息'],
  ]);
  expect(marshal.waiting[0]).toMatchObject({ code: 'waiting_on', actionable: false });
  expect(marshal.waiting[1]).toMatchObject({
    kind: 'run',
    since: '2026-10-29T09:55:00Z',
    code: 'review_limit',
    next: '重新确认遗留blocker和工作包范围；superagent decide held retry',
  });
  expect(marshal.waiting[2]).toMatchObject({
    code: 'coder_needs',
    next: '在brief中检查needs并补齐明确能力或输入；superagent decide needs retry',
  });
  expect(marshal.waiting[3]).toMatchObject({ code: 'coordination_pending' });
  expect(marshal.waiting.filter(item => item.id.startsWith('repo:'))).toHaveLength(1);
  expect(responsibilities(result, who)).toEqual(marshal.waiting.slice(1));
  expect(marshal.line).toContain('等待5：等待 unknown：等修复包、评审轮次用尽');
  unknown.exit = EXIT.completed;
  unknown.state = 'completed';
  expect(
    heartbeat(snap, cockpit(snap, now), now, () => ({ state: 'online', activity: 'active' }))
      .marshals[0]?.waiting[0]?.waiting_for
  ).toBe('交付包含 scope.write 之外的路径');
});

test('heartbeat persistence ignores clocks, refreshes at 900s, and health classifies stages', () => {
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [row('a', owner(1))],
    general: {
      [generalKey('a', 'code-core')]: {
        state: 'working',
        spinning: true,
        idle_s: 420,
        waiting_command: true,
        cpu: 50,
        root: { pid: 7, command: 'bun test' },
        episode: { id: 'episode', since: new Date(now).toISOString() },
      },
    },
  };
  const online = (): Presence => ({ state: 'online', activity: 'active' });
  const first = heartbeat(snap, cockpit(snap, now), now, online);
  const later = heartbeat(snap, cockpit(snap, now + 60_000), now + 60_000, online);
  expect(first.marshals[0]?.running[0]?.general).toMatchObject({
    state: 'working',
    spinning: true,
  });
  expect(shouldWriteHeartbeat(first, later, now + 60_000)).toBe(false);
  const volatile = structuredClone(later);
  volatile.marshals[0]!.running[0]!.general = {
    ...volatile.marshals[0]!.running[0]!.general!,
    idle_s: 999,
    cpu: 1,
    root: { pid: 8, command: 'changed' },
  };
  expect(shouldWriteHeartbeat(first, volatile, now + 60_000)).toBe(false);
  volatile.marshals[0]!.running[0]!.general!.spinning = false;
  expect(shouldWriteHeartbeat(first, volatile, now + 60_000)).toBe(true);
  expect(shouldWriteHeartbeat(first, { ...later, unowned: 1 }, now + 60_000)).toBe(true);
  expect(shouldWriteHeartbeat(first, later, now + 900_000)).toBe(true);
  const tick = {
    at: new Date(now - 4 * 60_000).toISOString(),
    collect: { ok: true },
    publish: { ok: true },
    reclaim: { ok: true },
    orca: { ok: false, error: 'down' },
    console: { ok: true },
    failover: { ok: true },
    actions: { ok: true },
  } satisfies TickRecord;
  expect(tickHealth(tick, now).messages).toEqual(['未收到巡检心跳 4m', 'orca异常：down']);
  const stale = tickHealth({ at: new Date(now - 6 * 60_000).toISOString() }, now).stale;
  const queued: string[] = [];
  let queuedId = queueTickStaleAlert(stale, undefined, alert => queued.push(alert.id));
  queuedId = queueTickStaleAlert(stale, queuedId, alert => queued.push(alert.id));
  expect(queued).toEqual([`tick-stale:${String(Math.floor((now - 6 * 60_000) / 60_000))}`]);
  expect(stale?.message).toContain(
    'launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wetamp.superagent.supervise-tick.plist'
  );
  expect(queueTickStaleAlert(undefined, queuedId, () => undefined)).toBeUndefined();
  // prettier-ignore
  expect(tickHealth({ at: new Date(now).toISOString(), collect: { ok: true }, publish: { ok: true } }, now)).toEqual({ ok: true, messages: [] });
  expect(
    tickHealth(
      {
        ...tick,
        at: new Date(now).toISOString(),
        collect: { ok: false, error: 'bad ledger' },
        reclaim: { ok: false, error: 'broken' },
        orca: { ok: true },
      },
      now
    ).messages
  ).toEqual(['巡检采集失败：bad ledger', 'reclaim异常：broken']);
});
