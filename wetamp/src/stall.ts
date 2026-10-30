import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { BoardRow, Snapshot } from './board/data';
import { home, writeAtomic } from './config';
import { nodePackages } from './execution';
import { loadLedger } from './ledger';
import { planOf } from './ledger-metrics';
import { covered } from './plan-precheck';
import { redact } from './redact';

const LIMIT_MS = 300_000;
const STALE_MS = 180_000;
export type GeneralState = 'working' | 'idle' | 'stalled' | 'handed_back' | 'unknown';
export interface GeneralAssessment {
  state: GeneralState;
  idle_s: number;
  waiting_command: boolean;
  cpu: number;
  root?: { pid: number; command: string };
  episode?: { id: string; since: string };
  reason?: string;
}
export interface StallRecord extends GeneralAssessment {
  node: string;
  startedAt: string;
  entries: string;
  mtime: number;
  progressAt: number;
}
export interface GeneralAttention {
  kind: 'general_idle' | 'general_stalled';
  node: string;
  idle_s: number;
  waiting_command: boolean;
  cpu: number;
  root?: { pid: number; command: string };
  episode_id: string;
  actions: string[];
}
export interface GeneralObservation {
  run: string;
  node: string;
  startedAt: string;
  coder: boolean;
  lastActivityAt?: string | null;
  entries?: string;
  mtime?: number;
  cpu?: number;
  root?: { pid: number; command: string };
  error?: string;
}
export interface ProcessSnapshot {
  error?: string;
  at(path: string): { cpu: number; root?: { pid: number; command: string } };
}
type Run = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithBufferEncoding
) => ReturnType<typeof spawnSync>;
const command: Run = (name, args, options) => spawnSync(name, args, options);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const generalKey = (run: string, node: string): string => `${run}\0${node}`;

// prettier-ignore
export function assessGeneral(prev: StallRecord | undefined, o: GeneralObservation, now: number): StallRecord {
  const same = prev?.node === o.node && prev.startedAt === o.startedAt;
  const start = Date.parse(o.startedAt), cpu = o.cpu ?? 0, entries = o.entries ?? '', mtime = o.mtime ?? 0;
  const base = { node: o.node, startedAt: o.startedAt, entries, mtime, progressAt: same ? prev.progressAt : now, idle_s: 0, waiting_command: false, cpu, ...(o.root ? { root: o.root } : {}) };
  if (!o.coder) return { ...base, state: 'handed_back' };
  const activity = Date.parse(o.lastActivityAt ?? '');
  if (o.error || !Number.isFinite(start) || !Number.isFinite(activity)) return { ...base, state: 'unknown', reason: o.error ?? 'invalid observation time', ...(same && prev.episode ? { episode: prev.episode } : {}) };
  if (prev && !same) return { ...base, state: 'working' };
  const progressed = same && (prev.entries !== entries || mtime > prev.mtime);
  const progressAt = same ? (progressed ? now : prev.progressAt) : Math.max(start, mtime);
  const idle_s = Math.max(0, Math.floor((now - Math.max(start, progressAt)) / 1000));
  const state: GeneralState = progressed ? 'working' : now - Math.max(activity, start) >= LIMIT_MS && cpu < 5 ? 'stalled' : idle_s * 1000 >= LIMIT_MS ? 'idle' : 'working';
  if (state === 'working') return { ...base, progressAt, idle_s, state };
  const since = same && prev.episode ? prev.episode.since : new Date(now).toISOString();
  return { ...base, progressAt, idle_s, state, waiting_command: state === 'idle' && cpu >= 5, episode: { since, id: digest([o.run, o.node, o.startedAt, since].join('\0')) } };
}

// prettier-ignore
export function generalAttention(run: string, ownerKey: readonly unknown[], now = Date.now()): GeneralAttention | undefined {
  const stallPath = join(home().sa, 'stall.json'); let snapshot: { at?: string; runs?: Record<string, StallRecord> };
  try { snapshot = JSON.parse(readFileSync(stallPath, 'utf8')) as typeof snapshot; } catch { return undefined; }
  const observedAt = Date.parse(snapshot.at ?? '');
  if (!Number.isFinite(observedAt) || now - observedAt > STALE_MS) return undefined;
  const active = new Set(Object.values(snapshot.runs ?? {}).flatMap(record => record.episode?.id ? [record.episode.id] : []));
  const record = snapshot.runs?.[run], episode = record?.episode;
  const ackPath = join(home().sa, 'stall-acks', `${digest(JSON.stringify(ownerKey))}.json`); let acknowledged: string[] = [];
  try { const value = JSON.parse(readFileSync(ackPath, 'utf8')) as { episodes?: unknown }; if (Array.isArray(value.episodes)) acknowledged = value.episodes.filter((id): id is string => typeof id === 'string'); } catch { /* first acknowledgement */ }
  const retained = acknowledged.filter(id => active.has(id));
  const wake = !!record && !!episode && ['idle', 'stalled'].includes(record.state) && !retained.includes(episode.id);
  if (wake) retained.push(episode.id);
  if (wake || retained.length !== acknowledged.length) { mkdirSync(dirname(ackPath), { recursive: true }); writeAtomic(ackPath, JSON.stringify({ episodes: retained }, null, 2) + '\n'); }
  if (!wake) return undefined;
  return { kind: record.state === 'idle' ? 'general_idle' : 'general_stalled', node: record.node, idle_s: record.idle_s, waiting_command: record.waiting_command, cpu: record.cpu,
    ...(record.root ? { root: record.root } : {}), episode_id: episode.id,
    actions: [`继续等待：superagent wait ${run}`, `处置：superagent cancel ${run} 后 superagent recover ${run}`] };
}

// prettier-ignore
export function processSnapshot(run: Run = command): ProcessSnapshot {
  const ps = run('ps', ['-axo', 'pid=,ppid=,%cpu=,command='], { encoding: 'buffer' }), cwd = run('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'buffer' });
  if (ps.status !== 0 || cwd.status !== 0) return { error: `process observation failed: ps=${String(ps.status)} lsof=${String(cwd.status)}`, at: () => ({ cpu: 0 }) };
  const rows = new Map<number, { ppid: number; cpu: number; command: string }>();
  for (const line of ps.stdout.toString().split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line); if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), cpu: Number(m[3]), command: m[4] }); }
  const paths = new Map<number, string>(); let pid = 0;
  for (const line of cwd.stdout.toString().split('\n')) { if (line.startsWith('p')) pid = Number(line.slice(1)); else if (line.startsWith('n') && pid) paths.set(pid, line.slice(1)); }
  return { at(path) { const target = resolve(path), inside = new Set([...paths].filter(([, p]) => p === target || p.startsWith(target + sep)).map(([p]) => p));
    const roots = [...inside].filter(p => !inside.has(rows.get(p)?.ppid ?? -1)); let total = 0, best: { pid: number; command: string } | undefined, bestCpu = -1;
    for (const root of roots) { let sum = 0; for (const [candidate, row] of rows) { let p = candidate; while (p && p !== root) p = rows.get(p)?.ppid ?? 0; if (p === root) sum += row.cpu; }
      total += sum; if (sum > bestCpu) { bestCpu = sum; best = { pid: root, command: redact(rows.get(root)?.command ?? '').slice(0, 160) }; } }
    return { cpu: total, ...(best ? { root: best } : {}) }; } };
}

// prettier-ignore
export function observeGeneral(row: BoardRow, node: NonNullable<BoardRow['activeNodes']>[number], scope: string[] | undefined, processes: ProcessSnapshot, run: Run = command): GeneralObservation {
  const base = { run: row.run_id, node: node.id, startedAt: node.startedAt ?? '', coder: node.role === 'coder', lastActivityAt: row.lastEvent };
  if (!base.coder) return base;
  if (!row.working_path) return { ...base, error: 'working_path unavailable' };
  if (!scope) return { ...base, error: 'node package mapping unavailable' };
  if (processes.error) return { ...base, error: processes.error };
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: row.working_path, encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (status.status !== 0) return { ...base, error: `git status failed: ${redact(status.stderr.toString()).trim().slice(0, 160) || String(status.status)}` };
  const raw = status.stdout.toString().split('\0'), changed: { mark: string; path: string }[] = [];
  for (let i = 0; i < raw.length; i++) { const x = raw[i]; if (x.length <= 3 || x[2] !== ' ') continue; const mark = x.slice(0, 2); changed.push({ mark, path: x.slice(3) }); if (/[RC]/.test(mark) && raw[i + 1]) changed.push({ mark: `${mark}>`, path: raw[++i] }); }
  const items = changed.filter(x => covered(x.path, scope)); let mtime = 0;
  for (const item of items) try { mtime = Math.max(mtime, statSync(resolve(row.working_path, item.path)).mtimeMs); } catch { /* deletion remains in entries */ }
  return { ...base, entries: digest(items.map(x => `${x.mark} ${x.path}`).sort().join('\0')), mtime, ...processes.at(row.working_path) };
}

// prettier-ignore
export function collectGenerals(snapshot: Snapshot, now = Date.now(), run: Run = command): Record<string, GeneralAssessment> {
  const path = `${home().sa}/stall.json`; let previous: { runs?: Record<string, StallRecord> } = {};
  try { previous = JSON.parse(readFileSync(path, 'utf8')) as typeof previous; } catch { /* fresh observation */ }
  const processes = processSnapshot(run), runs: Record<string, StallRecord> = {}, result: Record<string, GeneralAssessment> = {};
  for (const row of snapshot.rows.filter(x => x.state === 'running')) for (const node of row.activeNodes ?? []) { let scope: string[] | undefined;
    if (node.role === 'coder') try { const plan = planOf(loadLedger(row.run_id)); scope = plan ? nodePackages(plan).get(node.id) : undefined; } catch { scope = undefined; }
    const record = assessGeneral(previous.runs?.[row.run_id], observeGeneral(row, node, scope, processes, run), now);
    result[generalKey(row.run_id, node.id)] = record; if (node.role === 'coder') runs[row.run_id] = record;
  }
  writeAtomic(path, JSON.stringify({ at: new Date(now).toISOString(), runs }, null, 2) + '\n'); return result;
}
