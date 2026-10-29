import { expect, test } from 'bun:test';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';
// prettier-ignore
import { heartbeat, heartbeatSummary, shouldWriteHeartbeat, tickHealth, type TickRecord } from '../src/heartbeat';
import type { Identity, Presence } from '../src/coord';
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

test('heartbeat groups complete identities, isolates pid-only sessions, and excludes offline owners', () => {
  const a = owner(1),
    b = owner(2),
    dead = owner(3);
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [row('a', a), row('b', b), row('dead', dead), row('unknown', null)],
  };
  const presence = (who: Identity): Presence =>
    who.pid === 3 ? { state: 'offline' } : { state: 'online', activity: 'active' };
  const result = heartbeat(snap, cockpit(snap, now), now, presence);
  expect(result.marshals.map(m => m.owner_key)).toEqual([
    ['codex', null, 'host', 1, 'start-1'],
    ['codex', null, 'host', 2, 'start-2'],
    'unknown',
  ]);
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

test('heartbeat persistence ignores clocks, refreshes at 900s, and health classifies stages', () => {
  const snap: Snapshot = {
    at: new Date(now).toISOString(),
    summary: {},
    rows: [row('a', owner(1))],
  };
  const online = (): Presence => ({ state: 'online', activity: 'active' });
  const first = heartbeat(snap, cockpit(snap, now), now, online);
  const later = heartbeat(snap, cockpit(snap, now + 60_000), now + 60_000, online);
  expect(shouldWriteHeartbeat(first, later, now + 60_000)).toBe(false);
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
