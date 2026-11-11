import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { home } from './config';
import { coord, repoScope, same, type Identity, type Presence } from './coord';
import { elapsedAt, type Snapshot } from './board/data';
import { reasonText, roleTag, type Cockpit } from './board/cockpit';
import { unknownProgress, type Progress } from './board/eta';
import { HOLD_POLICY, holdAction, reasonOf } from './reasons';
import { generalKey, type GeneralAssessment } from './stall';

// prettier-ignore
interface Item { id: string; kind: 'run' | 'job'; title: string; stage: string; node?: string; coder?: boolean; role: string; model?: string | null; state: string; elapsed_s: number | null; last_activity_s: number | null; estimate: Progress; attention?: string; general?: GeneralAssessment }
// prettier-ignore
export interface Responsibility { id: string; kind?: 'run' | 'coord' | 'decision' | 'job'; since?: string; what: string; code: string; waiting_for: string; waited_s: number; next?: string; actionable?: boolean }
// prettier-ignore
interface Marshal { owner: Identity | 'unknown'; owner_key: (string | number | null)[] | 'unknown'; cwd: string; project: string; running: Item[]; waiting: Responsibility[]; line: string }
// prettier-ignore
export interface Heartbeat { at: string; reclaim_pending: number; legacy?: number; unowned: number; unreadable: number; heavy_queue?: Snapshot['heavy_queue']; marshals: Marshal[] }
export const HEARTBEAT_INTERVAL_MS = 900_000;
const age = (at: string | null | undefined, now: number): number | null => {
  const value = Date.parse(at ?? '');
  return Number.isFinite(value) ? Math.max(0, Math.floor((now - value) / 1000)) : null;
};
const { key: ownerKey } = createRequire(import.meta.url)('../hooks/identity.cjs') as {
  key: (owner: Identity) => (string | number | null)[];
};
const ownerId = (owner: Identity | null): string =>
  owner ? JSON.stringify(ownerKey(owner)) : 'unknown';

export function historicalReclaimRuns(
  path = join(home().sa, 'reclaim', 'observations.json')
): Set<string> {
  try {
    const observations = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(observations)) return new Set();
    return new Set(
      observations.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const row = value as {
          kind?: unknown;
          run?: unknown;
          count?: unknown;
          first_offline_at?: unknown;
          last_offline_at?: unknown;
          last_online_at?: unknown;
        };
        return row.kind !== 'job' &&
          typeof row.run === 'string' &&
          typeof row.count === 'number' &&
          row.count >= 2 &&
          typeof row.first_offline_at === 'number' &&
          typeof row.last_offline_at === 'number' &&
          row.last_offline_at - row.first_offline_at >= 120_000 &&
          row.last_online_at === undefined
          ? [row.run]
          : [];
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

export function adoptedRuns(path = join(home().sa, 'runs')): Set<string> {
  return new Set(
    (existsSync(path) ? readdirSync(path) : []).flatMap(file => {
      if (!file.endsWith('.json')) return [];
      try {
        const ledger = JSON.parse(readFileSync(join(path, file), 'utf8')) as {
          adoptions?: { from?: unknown }[];
        };
        return (ledger.adoptions ?? []).flatMap(a => (typeof a.from === 'string' ? [a.from] : []));
      } catch {
        return [];
      }
    })
  );
}

/** Historical evidence is injectable for deterministic projections and tests. */
// prettier-ignore
export function heartbeat(snapshot: Snapshot, cockpit: Cockpit, now: number, presenceOf: (owner: Identity) => Presence, historical = historicalReclaimRuns(), adopted = adoptedRuns()): Heartbeat {
  const groups = new Map<string, Marshal>();
  const coordination = new Map<string, { count: number; oldest: string }>();
  for (const message of snapshot.coordMessages ?? []) if (!message.type && ['queued', 'surfaced', 'escalated'].includes(message.state)) {
    const key = `${message.scope.kind}:${message.scope.id}`, found = coordination.get(key);
    coordination.set(key, { count: (found?.count ?? 0) + 1, oldest: found && found.oldest < message.at ? found.oldest : message.at });
  }
  let reclaim = 0, legacy = 0, unowned = 0, unreadable = 0;
  const group = (owner: Identity, cwd: string): Marshal | undefined => {
    if (presenceOf(owner).state !== 'online') return;
    const key = `${ownerId(owner)}\0${cwd}`, found = groups.get(key);
    if (found) return found;
    const value: Marshal = { owner, owner_key: ownerKey(owner), cwd, project: basename(cwd), running: [], waiting: [], line: '' };
    groups.set(key, value);
    return value;
  };
  const orphan = (cwd: string, item: Responsibility): void => {
    const key = `unknown\0${cwd}`, found = groups.get(key), value = found ?? { owner: 'unknown' as const, owner_key: 'unknown' as const, cwd, project: basename(cwd), running: [], waiting: [], line: '无人负责' };
    value.waiting.push(item); groups.set(key, value); unowned++;
  };
  const projected = new Map(cockpit.runs.map(run => [run.id, run])), active = new Set(cockpit.active.map(run => run.id));
  for (const row of snapshot.rows) {
    if (row.archon_id && adopted.has(row.archon_id)) continue;
    if (['completed', 'cancelled', 'abandoned'].includes(row.state)) continue;
    if (row.state === 'unreadable') { unreadable++; continue; }
    const owner = row.coordination?.owner;
    if (!owner) { unowned++; continue; }
    if (presenceOf(owner).state !== 'online') {
      if (row.state === 'failed') { if (historical.has(row.run_id)) legacy++; else reclaim++; }
      else {
        let repoOnline = false; try { repoOnline = coord().owner(repoScope(row.repo)).presence.state === 'online'; } catch { /* Historical repository may be gone. */ }
        if (repoOnline) reclaim++;
        else orphan(row.repo, { id: row.run_id, kind: 'run', since: row.lastEvent ?? row.started_at, what: row.state, code: 'unowned', waiting_for: '无人负责', waited_s: age(row.lastEvent ?? row.started_at, now) ?? 0, next: `superagent claim ${row.run_id}` });
      }
      continue;
    }
    const marshal = group(owner, row.repo);
    if (!marshal) continue;
    const run = projected.get(row.run_id), nodes = row.activeNodes?.length ? row.activeNodes : [{ id: row.nodes.current ?? '', role: row.nodes.currentRole, model: row.model }];
    if (row.state === 'running' && active.has(row.run_id)) for (const node of nodes) marshal.running.push({
      id: row.run_id, kind: 'run', title: row.engine?.title ?? '任务标题未知', stage: run?.stage ?? row.state,
      ...(node.id ? { node: node.id } : {}), coder: node.role === 'coder', role: roleTag(node.role, node.model), model: node.model, state: row.state,
      elapsed_s: elapsedAt(row, now), last_activity_s: age(row.lastEvent, now),
      estimate: snapshot.eta?.[row.run_id]?.nodes?.[node.id] ?? snapshot.eta?.[row.run_id]?.progress ?? unknownProgress(),
      ...(run?.reason ? { attention: run.reason } : {}),
      ...(snapshot.general?.[generalKey(row.run_id, node.id)] ? { general: snapshot.general[generalKey(row.run_id, node.id)] } : {}),
    });
    const runPending = coordination.get(`run:${row.run_id}`);
    if (row.state !== 'running') {
      const code = row.engine?.reason.trim() ? row.engine.reason : row.askReason ?? row.state.replace('held:', ''), registered = reasonOf(code), hold = registered?.hold ?? code, translated = reasonText(code), policy = (HOLD_POLICY as Partial<Record<string, { next?: string }>>)[hold];
      const next = policy?.next ? `${policy.next}；${holdAction(row.run_id, hold)}` : hold === 'acceptance_adjudication' ? holdAction(row.run_id, hold) : undefined;
      const since = row.lastEvent ?? row.started_at;
      marshal.waiting.push({ id: row.run_id, kind: row.humanDecision ? 'decision' : 'run', since, what: run?.stage ?? row.state, code, waiting_for: translated !== code ? translated : registered?.description ?? '需要决策', waited_s: age(since, now) ?? 0, next: next ?? `superagent wait ${row.run_id} --timeout 7000` });
    } else if (runPending) marshal.waiting.push({ id: row.run_id, kind: 'coord', since: runPending.oldest, what: run?.stage ?? row.state, code: 'coordination_pending', waiting_for: `${String(runPending.count)} 条协调消息`, waited_s: age(runPending.oldest, now) ?? 0, next: 'superagent inbox' });
  }
  for (const marshal of groups.values()) {
    const pending = coordination.get(`repo:${marshal.cwd}`);
    if (pending) marshal.waiting.push({ id: `repo:${marshal.cwd}`, kind: 'coord', since: pending.oldest, what: '仓库交接', code: 'coordination_pending', waiting_for: `${String(pending.count)} 条协调消息`, waited_s: age(pending.oldest, now) ?? 0, next: 'superagent inbox' });
  }
  for (const job of snapshot.activity?.jobs.filter(j => ['queued', 'running', 'lost'].includes(j.state)) ?? []) {
    if (!job.launcher) { unowned++; continue; }
    let owner: Identity = job.launcher;
    if (presenceOf(owner).state !== 'online') try { owner = coord().owner(repoScope(job.cwd)).owner ?? owner; } catch { /* Historical cwd may no longer resolve. */ }
    const marshal = group(owner, job.cwd), run = cockpit.active.find(item => item.id === job.id);
    if (!marshal) { if (job.state === 'lost') reclaim++; else orphan(job.cwd, { id: job.id, kind: 'job', since: job.started_at, what: job.state, code: 'unowned', waiting_for: '无人负责', waited_s: age(job.started_at, now) ?? 0, next: `superagent job clean ${job.id}` }); continue; }
    if (job.state === 'running' && active.has(job.id)) marshal.running.push({ id: job.id, kind: 'job', title: job.title, stage: run?.stage ?? job.state, role: roleTag(job.tier, job.model), model: job.model, state: job.state, elapsed_s: age(job.started_at, now), last_activity_s: null, estimate: run?.progress ?? unknownProgress() });
    if (job.state === 'lost' && !job.ended_at) marshal.waiting.push({ id: job.id, kind: 'job', since: job.started_at, what: '作业丢失', code: 'lost', waiting_for: job.title, waited_s: age(job.started_at, now) ?? 0, next: `superagent job clean ${job.id}` });
  }
  for (const marshal of groups.values()) {
    const roles = marshal.running.map(item => `${item.role} ${item.general ? ({ working: '干活', idle: `空转 ${String(Math.floor(item.general.idle_s / 60))}m${item.general.waiting_command ? '（在等命令）' : ''}`, stalled: `停滞 ${String(Math.floor(item.general.idle_s / 60))}m`, handed_back: '已交回', unknown: `观测未知${item.general.reason ? `（${item.general.reason}）` : ''}` }[item.general.state]) : item.stage} ${item.last_activity_s === null ? '活动未知' : `活动${String(Math.floor(item.last_activity_s / 60))}m前`} ${item.estimate.basis === 'history' ? `历史耗时估算~${String(item.estimate.pct ?? '?')}%` : '估算未知'}`);
    marshal.line = `${marshal.project} 元帅｜${roles.join('｜') || '无执行'}${marshal.waiting.length ? `｜等待${String(marshal.waiting.length)}：${marshal.waiting.slice(0, 2).map(item => item.waiting_for).join('、')}` : ''}`;
  }
  return { at: new Date(now).toISOString(), reclaim_pending: reclaim, legacy, unowned, unreadable, ...(snapshot.heavy_queue?.length ? { heavy_queue: snapshot.heavy_queue } : {}), marshals: [...groups.values()] };
}
// prettier-ignore
const semantic = (value: Heartbeat): unknown => JSON.parse(JSON.stringify(value, (key: string, item: unknown): unknown => ['at', 'elapsed_s', 'last_activity_s', 'waited_s', 'line', 'idle_s', 'cpu', 'root'].includes(key) ? undefined : item)) as unknown;
// prettier-ignore
export const heartbeatBatch = (value: Heartbeat): string => createHash('sha256').update(JSON.stringify(semantic(value))).digest('hex');
// prettier-ignore
export const shouldWriteHeartbeat = (previous: Heartbeat | undefined, next: Heartbeat, now: number): boolean => !previous || heartbeatBatch(previous) !== heartbeatBatch(next) || now - Date.parse(previous.at) >= HEARTBEAT_INTERVAL_MS;

export const responsibilities = (value: Heartbeat, who: Identity): Responsibility[] =>
  value.marshals
    .find(item => item.owner !== 'unknown' && same(who, item.owner))
    ?.waiting.filter(item => item.actionable !== false) ?? [];

// prettier-ignore
export interface TickStage { ok: boolean; duration_ms?: number; error?: string; skipped?: string }
type Stage = 'collect' | 'publish' | 'reclaim' | 'orca' | 'console' | 'failover' | 'actions';
export type TickRecord = { at: string } & Partial<Record<Stage, TickStage>>;
export interface TickStaleAlert {
  id: string;
  message: string;
  minutes: number;
}
// prettier-ignore
export function tickStaleAlert(tick: TickRecord | undefined, now: number): TickStaleAlert | undefined {
  const parsed = Date.parse(tick?.at ?? '');
  if (!Number.isFinite(parsed)) return;
  const elapsed = now - parsed, minutes = Math.floor(elapsed / 60_000);
  if (elapsed <= 5 * 60_000) return;
  return { id: `tick-stale:${String(Math.floor(parsed / 60_000))}`, minutes, message: `supervise-tick 已停 ${String(minutes)} 分钟：launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wetamp.superagent.supervise-tick.plist` };
}
// prettier-ignore
export function queueTickStaleAlert(alert: TickStaleAlert | undefined, previousId: string | undefined, queue: (alert: TickStaleAlert) => void): string | undefined {
  if (!alert) return;
  if (alert.id !== previousId) queue(alert);
  return alert.id;
}
// prettier-ignore
export function tickHealth(tick: TickRecord | undefined, now: number): { ok: boolean; alive: boolean; messages: string[]; failedStages: Stage[]; stale?: TickStaleAlert } {
  const parsed = Date.parse(tick?.at ?? ''), minutes = Number.isFinite(parsed) ? Math.floor((now - parsed) / 60_000) : Infinity;
  const messages = minutes > 3 ? [`未收到巡检心跳${Number.isFinite(minutes) ? ` ${String(minutes)}m` : ''}`] : [];
  const failedStages: Stage[] = [];
  if (tick) for (const stage of ['collect', 'publish', 'reclaim', 'orca', 'console', 'failover', 'actions'] as const) { const record = tick[stage]; if (record && !record.ok) { failedStages.push(stage); messages.push(stage === 'collect' ? `巡检采集失败：${record.error ?? 'unknown'}` : `${stage}异常：${record.error ?? 'unknown'}`); } }
  const stale = tickStaleAlert(tick, now);
  return { ok: messages.length === 0, alive: minutes <= 3, messages, failedStages, ...(stale ? { stale } : {}) };
}
