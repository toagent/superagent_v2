import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { same, type Identity, type Presence } from './coord';
import { elapsedAt, type Snapshot } from './board/data';
import { reasonText, roleTag, type Cockpit } from './board/cockpit';
import { unknownProgress, type Progress } from './board/eta';
import { reasonOf } from './reasons';

// prettier-ignore
interface Item { id: string; kind: 'run' | 'job'; title: string; stage: string; node?: string; role: string; model?: string | null; state: string; elapsed_s: number | null; last_activity_s: number | null; estimate: Progress; attention?: string }
// prettier-ignore
interface Marshal { owner: Identity | 'unknown'; owner_key: (string | number | null)[] | 'unknown'; cwd: string; project: string; running: Item[]; waiting: { id: string; what: string; waiting_for: string; waited_s: number }[]; line: string }
// prettier-ignore
export interface Heartbeat { at: string; reclaim_pending: number; unowned: number; unreadable: number; marshals: Marshal[] }
export const HEARTBEAT_INTERVAL_MS = 900_000;
// prettier-ignore
export type HeartbeatSummary = { available: true; line: string; running: Item[]; waiting: Marshal['waiting']; warnings?: string[] } | { available: false; reason: string };
const age = (at: string | null | undefined, now: number): number | null => {
  const value = Date.parse(at ?? '');
  return Number.isFinite(value) ? Math.max(0, Math.floor((now - value) / 1000)) : null;
};
const { key: ownerKey } = createRequire(import.meta.url)('../hooks/identity.cjs') as {
  key: (owner: Identity) => (string | number | null)[];
};
const ownerId = (owner: Identity | null): string =>
  owner ? JSON.stringify(ownerKey(owner)) : 'unknown';

/** Pure projection: the caller supplies presence so collection owns all I/O. */
// prettier-ignore
export function heartbeat(snapshot: Snapshot, cockpit: Cockpit, now: number, presenceOf: (owner: Identity) => Presence): Heartbeat {
  const groups = new Map<string, Marshal>();
  let reclaim = 0, unowned = 0, unreadable = 0;
  const group = (owner: Identity, cwd: string): Marshal | undefined => {
    if (presenceOf(owner).state !== 'online') { reclaim++; return; }
    const key = `${ownerId(owner)}\0${cwd}`, found = groups.get(key);
    if (found) return found;
    const value: Marshal = { owner, owner_key: ownerKey(owner), cwd, project: basename(cwd), running: [], waiting: [], line: '' };
    groups.set(key, value);
    return value;
  };
  const projected = new Map(cockpit.runs.map(run => [run.id, run])), active = new Set(cockpit.active.map(run => run.id));
  for (const row of snapshot.rows) {
    if (['completed', 'cancelled', 'abandoned'].includes(row.state)) continue;
    if (row.state === 'unreadable') { unreadable++; continue; }
    const owner = row.coordination?.owner;
    if (!owner) { unowned++; continue; }
    const marshal = group(owner, row.repo);
    if (!marshal) continue;
    const run = projected.get(row.run_id), nodes = row.activeNodes?.length ? row.activeNodes : [{ id: row.nodes.current ?? '', role: row.nodes.currentRole, model: row.model }];
    if (row.state === 'running' && active.has(row.run_id)) for (const node of nodes) marshal.running.push({
      id: row.run_id, kind: 'run', title: row.engine?.title ?? '任务标题未知', stage: run?.stage ?? row.state,
      ...(node.id ? { node: node.id } : {}), role: roleTag(node.role, node.model), model: node.model, state: row.state,
      elapsed_s: elapsedAt(row, now), last_activity_s: age(row.lastEvent, now),
      estimate: snapshot.eta?.[row.run_id]?.nodes?.[node.id] ?? snapshot.eta?.[row.run_id]?.progress ?? unknownProgress(),
      ...(run?.reason ? { attention: run.reason } : {}),
    });
    const pending = row.coordination?.pending ?? 0;
    if (row.state !== 'running') {
      const code = row.engine?.reason.trim() ? row.engine.reason : row.askReason ?? row.state.replace('held:', ''), translated = reasonText(code);
      marshal.waiting.push({ id: row.run_id, what: run?.stage ?? row.state, waiting_for: translated !== code ? translated : reasonOf(code)?.description ?? '需要决策', waited_s: age(row.lastEvent ?? row.started_at, now) ?? 0 });
    } else if (pending) marshal.waiting.push({ id: row.run_id, what: run?.stage ?? row.state, waiting_for: `${String(pending)} 条协调消息`, waited_s: age(row.lastEvent ?? row.started_at, now) ?? 0 });
  }
  for (const job of snapshot.activity?.jobs.filter(j => ['queued', 'running'].includes(j.state)) ?? []) {
    if (!job.launcher) { unowned++; continue; }
    const marshal = group(job.launcher, job.cwd), run = cockpit.active.find(item => item.id === job.id);
    if (!marshal) continue;
    if (job.state === 'running' && active.has(job.id)) marshal.running.push({ id: job.id, kind: 'job', title: job.title, stage: run?.stage ?? job.state, role: roleTag(job.tier, job.model), model: job.model, state: job.state, elapsed_s: age(job.started_at, now), last_activity_s: null, estimate: run?.progress ?? unknownProgress() });
    if (job.state === 'queued') marshal.waiting.push({ id: job.id, what: '作业排队', waiting_for: '执行槽位', waited_s: age(job.started_at, now) ?? 0 });
  }
  for (const marshal of groups.values()) {
    const roles = marshal.running.map(item => `${item.role} ${item.stage} ${item.last_activity_s === null ? '活动未知' : `活动${String(Math.floor(item.last_activity_s / 60))}m前`} ${item.estimate.basis === 'history' ? `历史耗时估算~${String(item.estimate.pct ?? '?')}%` : '估算未知'}`);
    marshal.line = `${marshal.project} 元帅｜${roles.join('｜') || '无执行'}${marshal.waiting.length ? `｜等待${String(marshal.waiting.length)}：${marshal.waiting.slice(0, 2).map(item => item.waiting_for).join('、')}` : ''}`;
  }
  return { at: new Date(now).toISOString(), reclaim_pending: reclaim, unowned, unreadable, marshals: [...groups.values()] };
}
// prettier-ignore
const semantic = (value: Heartbeat): unknown => JSON.parse(JSON.stringify(value, (key: string, item: unknown): unknown => ['at', 'elapsed_s', 'last_activity_s', 'waited_s', 'line'].includes(key) ? undefined : item)) as unknown;
// prettier-ignore
export const heartbeatBatch = (value: Heartbeat): string => createHash('sha256').update(JSON.stringify(semantic(value))).digest('hex');
// prettier-ignore
export const shouldWriteHeartbeat = (previous: Heartbeat | undefined, next: Heartbeat, now: number): boolean => !previous || heartbeatBatch(previous) !== heartbeatBatch(next) || now - Date.parse(previous.at) >= HEARTBEAT_INTERVAL_MS;

// prettier-ignore
export function heartbeatSummary(value: Heartbeat, who: Identity, now: number): HeartbeatSummary {
  const marshal = value.marshals.find(item => item.owner !== 'unknown' && same(who, item.owner));
  if (!marshal) return { available: false, reason: 'caller heartbeat unavailable' };
  const minutes = Math.floor((now - Date.parse(value.at)) / 60_000), warnings = minutes > 18 ? [`心跳过期 ${String(minutes)}m`] : [];
  return { available: true, line: marshal.line, running: marshal.running, waiting: marshal.waiting, ...(warnings.length ? { warnings } : {}) };
}

// prettier-ignore
export interface TickStage { ok: boolean; duration_ms?: number; error?: string; skipped?: string }
type Stage = 'collect' | 'publish' | 'reclaim' | 'orca' | 'console' | 'failover' | 'actions';
export type TickRecord = { at: string } & Partial<Record<Stage, TickStage>>;
// prettier-ignore
export function tickHealth(tick: TickRecord | undefined, now: number): { ok: boolean; messages: string[] } {
  const parsed = Date.parse(tick?.at ?? ''), minutes = Number.isFinite(parsed) ? Math.floor((now - parsed) / 60_000) : Infinity;
  const messages = minutes > 3 ? [`未收到巡检心跳${Number.isFinite(minutes) ? ` ${String(minutes)}m` : ''}`] : [];
  if (tick?.collect && !tick.collect.ok) messages.push(`巡检采集失败：${tick.collect.error ?? 'unknown'}`);
  if (tick) for (const stage of ['publish', 'reclaim', 'orca', 'console', 'failover', 'actions'] as const) { const record = tick[stage]; if (record && !record.ok) messages.push(`${stage}异常：${record.error ?? 'unknown'}`); }
  return { ok: messages.length === 0, messages };
}
