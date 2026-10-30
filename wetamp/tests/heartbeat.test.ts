import { expect, test } from 'bun:test';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';
// prettier-ignore
import { heartbeat, heartbeatSummary, shouldWriteHeartbeat, tickHealth, type TickRecord } from '../src/heartbeat';
import type { Identity, Presence } from '../src/coord';
import { generalKey } from '../src/stall';
const now = Date.parse('2026-10-29T10:00:00Z');
// prettier-ignore
const owner = (pid: number): Identity => ({ client: 'codex', host: 'host', pid, pid_start: `start-${String(pid)}` });
const row = (id: string, who: Identity | null, state = 'running'): BoardRow => ({
  run_id: id,
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
      row('dead', dead),
      ...Array.from({ length: 100 }, (_, i) => row(`unowned-${String(i)}`, null)),
      ...Array.from({ length: 100 }, (_, i) => row(`unreadable-${String(i)}`, a, 'unreadable')),
    ],
  };
  const presence = (who: Identity): Presence =>
    who.pid === 3 ? { state: 'offline' } : { state: 'online', activity: 'active' };
  const result = heartbeat(snap, cockpit(snap, now), now, presence);
  expect(result.marshals.map(m => m.owner_key)).toEqual([
    ['codex', null, 'host', 1, 'start-1'],
    ['codex', null, 'host', 2, 'start-2'],
  ]);
  expect(result).toMatchObject({ unowned: 100, unreadable: 100, reclaim_pending: 1 });
  expect(JSON.stringify(result).length).toBeLessThan(3000);
  expect(result.marshals[0]?.running.map(item => item.role)).toEqual(['将军·gpt', '军师·opus']);
  expect(result.reclaim_pending).toBe(1);
  expect(JSON.stringify(result)).not.toContain('dead');
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

test('heartbeat separates active runs from typed waits and reports coordination once', () => {
  const who = owner(1),
    failed = row('failed', who, 'failed'),
    held = row('held', who, 'held:gate'),
    running = row('running', who);
  for (const item of [failed, held, running]) item.repo = '/repo/project';
  // prettier-ignore
  failed.engine = { title: 'failed', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: 'repair_exhausted:scope_violation', dispositions: [] };
  // prettier-ignore
  held.engine = { title: 'held', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: 'review_limit', dispositions: [] };
  running.coordination!.pending = 2;
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [failed, held, running],
  };
  const result = heartbeat(snap, cockpit(snap, now), now, () => ({
    state: 'online',
    activity: 'active',
  }));
  const marshal = result.marshals[0]!;
  expect([...new Set(marshal.running.map(item => item.id))]).toEqual(['running']);
  expect(marshal.waiting.map(item => [item.id, item.waiting_for])).toEqual([
    ['failed', '交付包含 scope.write 之外的路径'],
    ['held', '评审轮次用尽'],
    ['running', '2 条协调消息'],
  ]);
  expect(marshal.line).toContain('等待3：交付包含 scope.write 之外的路径、评审轮次用尽');
});

test('heartbeat persistence ignores clocks, refreshes at 900s, and health classifies stages', () => {
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [row('a', owner(1))],
    general: {
      [generalKey('a', 'code-core')]: {
        state: 'idle',
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
  expect(first.marshals[0]?.line).toContain('将军·gpt 空转 7m（在等命令）');
  expect(shouldWriteHeartbeat(first, later, now + 60_000)).toBe(false);
  const volatile = structuredClone(later);
  volatile.marshals[0]!.running[0]!.general = {
    ...volatile.marshals[0]!.running[0]!.general!,
    idle_s: 999,
    cpu: 1,
    root: { pid: 8, command: 'changed' },
  };
  expect(shouldWriteHeartbeat(first, volatile, now + 60_000)).toBe(false);
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
