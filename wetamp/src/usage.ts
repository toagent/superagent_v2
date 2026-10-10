import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { archonJson, lock } from './archon';
import { home, WETAMP, writeAtomic } from './config';
import { ledgerIds, loadLedger, parseArgs } from './cli';
import type { Job } from './jobs';
import { isTier, type Tier } from './roles';
import { shortModel } from './models';
import { sessionModel } from './models';
import type { SerializedNodeData } from '../../packages/workflows/src/node-record-serialization';
import { etaInput, refreshEta, type EtaInput } from './board/eta';
import type { RunView } from './archon';
import type { WorkflowEventRow } from '../../packages/workflows/src/schemas/workflow-event';
import { workflowRoles } from './board/workflow';

export type Client = 'claude' | 'codex';
export interface Counts { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; sessions: number }
export interface Owner { client: Client; role: Tier | null; model: string | null; cwd: string | null; kind: 'run' | 'job' | 'interactive' | 'inferred' | 'unknown'; run_id?: string; job_id?: string }
export interface UsageSession extends Counts { id: string; client: Client; model: string | null; at: string; cost: number | null; owner?: Owner; parts?: (Counts & { model: string })[] }
export interface UsageCache { at: string | null; since?: string; source_at?: Partial<Record<Client, string | null>>; status: string; sources: Partial<Record<Client, string>>; sessions: UsageSession[]; today?: { day: string; status: string; sessions: UsageSession[] }; daily: (Omit<Counts, 'sessions'> & { day: string; client: Client; sessions: null })[] }
type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null;
const n = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const root = (): string => join(home().sa, 'usage');
export const sessionKey = (id: string): string => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id)?.[0].toLowerCase() ?? id;
const key = (client: Client, id: string): string => `${client}:${sessionKey(id)}`;
const empty = (): Counts => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, sessions: 0 });
const counts = (r: ObjectValue): Counts => ({ input: n(r.inputTokens), output: n(r.outputTokens), reasoning: n(r.reasoningOutputTokens), cacheRead: n(r.cacheReadTokens), cacheWrite: n(r.cacheCreationTokens), total: n(r.totalTokens), sessions: 1 });
export function parseUsage(value: unknown, client: Client): UsageSession[] {
  const o = obj(value), rows = o.sessions ?? (client === 'claude' ? o.session : undefined);
  if (!Array.isArray(rows)) throw new Error('invalid_json_shape');
  const seen = new Map<string, UsageSession>();
  for (const raw of rows) {
    const r = obj(raw), id = str(r.sessionId ?? r.period);
    if (!id || ['inputTokens', 'outputTokens', 'totalTokens'].some(k => typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0)) throw new Error('invalid_json_shape');
    const models = client === 'claude' ? arr(r.modelsUsed) : Object.keys(obj(r.models));
    const parts = client === 'claude' ? arr(r.modelBreakdowns).map(v => { const p = obj(v); return { ...counts(p), total: n(p.inputTokens) + n(p.outputTokens) + n(p.cacheReadTokens) + n(p.cacheCreationTokens), model: str(p.modelName) ?? '?' }; }) : Object.entries(obj(r.models)).map(([model, v]) => ({ ...counts(obj(v)), model }));
    const cost = r.totalCost ?? r.costUSD;
    seen.set(key(client, id), { ...counts(r), id: sessionKey(id), client, model: str(models.at(-1)), at: str(r.lastActivity ?? obj(r.metadata).lastActivity) ?? '', cost: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null, parts });
  }
  return [...seen.values()];
}
const priority: Record<Owner['kind'], number> = { run: 5, job: 4, interactive: 3, inferred: 2, unknown: 1 };
export function attribute(sessions: UsageSession[], claims: { id: string; owner: Owner }[], prior: Partial<Record<string, Owner>> = {}): Partial<Record<string, Owner>> {
  const index = { ...prior };
  for (const { id, owner } of claims) {
    const k = key(owner.client, id), old = index[k];
    if (!old || priority[owner.kind] >= priority[old.kind]) index[k] = { ...owner, role: owner.role ?? old?.role ?? null };
    else if (!old.role && owner.role) index[k] = { ...old, role: owner.role };
  }
  for (const s of sessions) { const k = key(s.client, s.id); s.owner = index[k] ??= { client: s.client, role: null, model: s.model, cwd: null, kind: 'unknown' }; }
  return index;
}
const json = (file: string): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return null; } };
function files(dir: string): string[] { try { return readdirSync(dir).map(f => join(dir, f)); } catch { return []; } }
/** Only the bounded first JSONL line is interpreted for identity/cwd/time. */
function first(file: string): ObjectValue {
  let fd: number | undefined;
  try { fd = openSync(file, 'r'); const b = Buffer.alloc(Math.min(65536, fstatSync(fd).size)); readSync(fd, b, 0, b.length, 0); return obj(JSON.parse(b.toString('utf8').split('\n')[0])); }
  catch { return {}; } finally { if (fd !== undefined) closeSync(fd); }
}
export function logSessionId(file: string | null, client: string): string | null { const r = file ? first(file) : {}, p = client === 'codex' ? obj(r.payload) : r; return str(p.id ?? p.sessionId); }
export function jobSession(job: Pick<Job, 'kind' | 'cwd' | 'started_at'>, node = false): string | null {
  const start = Date.parse(job.started_at), hits = new Set<string>();
  if (!Number.isFinite(start)) return null;
  const dirs = job.kind === 'codex' ? [-60000, 0, 60000].map(d => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions', ...new Date(start + d).toLocaleDateString('sv-SE').split('-'))) : job.kind === 'claude' ? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', job.cwd.replace(/[^a-zA-Z0-9]/g, '-'))] : [];
  for (const dir of new Set(dirs)) for (const file of files(dir).filter(f => f.endsWith('.jsonl'))) {
    const r = first(file), p = job.kind === 'codex' ? obj(r.payload) : r;
    const delta = Date.parse(String(p.timestamp ?? r.timestamp ?? obj(r.snapshot).timestamp)) - start;
    if ((job.kind !== 'codex' || r.type === 'session_meta') && (job.kind !== 'codex' || p.cwd === job.cwd) && Math.abs(delta) <= 60000 && (!node || delta >= 0)) {
      const id = str(p.id ?? p.sessionId) ?? (/^[0-9a-f-]{36}\.jsonl$/i.test(basename(file)) ? basename(file, '.jsonl') : null); if (id) hits.add(id);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}
/** Read-only evidence collection; cache writes belong to refreshUsage. */
export function usageEvidence(): { claims: { id: string; owner: Owner }[]; eta: EtaInput[] } {
  const claims: { id: string; owner: Owner }[] = [];
  const eta: EtaInput[] = [];
  for (const id of ledgerIds()) {
    try {
      const l = loadLedger(id), j = archonJson(['workflow', 'get', l.archon_run_id, '--verbose', '--events'], l.repo);
      // --events replaces nodes in the CLI response. Reuse its canonical fold, including retry resets and cached success.
      const events = arr(j.events) as WorkflowEventRow[];
      const input = etaInput(l, j as unknown as RunView, events); eta.push(input);
      const roles = workflowRoles(l);
      const history = (l.adoptions ?? []).flatMap(a => { try { return [archonJson(['workflow', 'get', a.from, '--verbose', '--events'], l.repo)]; } catch { return []; } });
      for (const run of [j, ...history]) for (const raw of arr(run.events)) {
        const e = obj(raw), d = obj(e.data) as Partial<SerializedNodeData>, m = d.binding?.model;
        const client = d.binding?.provider ?? d.provider;
        if (client !== 'codex' && client !== 'claude') continue;
        const role = roles?.get(String(e.step_name));
        const cwd = str(run.working_path), started = d.invocation?.startedAt;
        // Only the latest active launch may use bounded metadata matching; terminal/history nodes require a session id.
        const active = run === j && input.run.status === 'running' && input.run.nodes?.some(n => n.nodeId === e.step_name && n.state === 'running') && arr(run.events).slice().reverse().find(v => obj(v).step_name === e.step_name && obj(v).event_type === 'node_started') === raw;
        const session = d.session_id ?? (active && cwd && started ? jobSession({ kind: client, cwd, started_at: started }, true) : null);
        if (!session) continue;
        claims.push({ id: session, owner: { client, role: role === 'reviewer' ? 'strategist' : role === 'coder' ? 'general' : null, model: m?.resolved.source === 'provider' ? m.resolved.value : m?.requested ?? d.model ?? null, cwd: cwd ?? l.repo, kind: 'run', run_id: id } });
      }
    } catch { /* A missing run provides no ownership proof; existing index survives. */ }
  }
  const jobs: Job[] = files(join(home().sa, 'jobs')).flatMap(f => { const j = obj(json(f)); return typeof j.cwd === 'string' && typeof j.started_at === 'string' ? [j as unknown as Job] : []; });
  for (const j of jobs) {
    const id = j.session_id ?? jobSession(j);
    if (id && (j.kind === 'claude' || j.kind === 'codex')) claims.push({ id, owner: { client: j.kind, role: j.role ?? null, model: j.model, cwd: j.cwd, kind: 'job', job_id: j.id } });
  }
  for (const f of files(join(home().sa, 'live'))) {
    const l = obj(json(f)), client = l.client, id = str(l.session_id);
    if (!id || (client !== 'claude' && client !== 'codex')) continue;
    const hits = jobs.filter(j => j.cwd === l.cwd && j.kind === client && Math.abs(Date.parse(String(l.turn_at ?? l.at)) - Date.parse(j.started_at)) <= 60000);
    const role = isTier(l.role) ? l.role : l.derived === true ? 'general' : l.derived === false ? 'commander' : null;
    claims.push({ id, owner: hits.length === 1 ? { client, role: hits[0].role ?? role, model: hits[0].model, cwd: hits[0].cwd, kind: 'inferred', job_id: hits[0].id } : { client, role, model: str(l.model) ?? sessionModel(str(l.transcript_path), client), cwd: str(l.cwd), kind: 'interactive' } });
  }
  return { claims, eta };
}
export function readUsage(): UsageCache {
  const c = obj(json(join(root(), 'cache.json')));
  return Array.isArray(c.sessions) && Array.isArray(c.daily) ? c as unknown as UsageCache : { at: null, status: '用量未知（ccusage 不可用：未刷新）', sources: {}, sessions: [], daily: [] };
}
export const usageCommand = (client: Client, mode: 'session' | 'daily', since?: string): string[] => ['nice', '-n', '10', 'bunx', 'ccusage@20.0.28', client, mode, '--json', ...(since ? ['--since', since] : [])];
async function capture(client: Client, mode: 'session' | 'daily', since?: string): Promise<unknown> {
  const cmd = usageCommand(client, mode, since);
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', detached: true });
  const timeout = { expired: false };
  const timer = setTimeout(() => { timeout.expired = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { /* Child already exited. */ } }, 120000);
  try {
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(timeout.expired ? 'timeout' : 'exit_nonzero');
    try { return JSON.parse(out) as unknown; } catch { throw new Error('invalid_json'); }
  } finally { clearTimeout(timer); }
}
export async function refreshUsage(since?: string, collect = capture): Promise<UsageCache> {
  mkdirSync(root(), { recursive: true });
  const held = lock(join(root(), 'refresh.lock'));
  if (!held.ok) return readUsage();
  try {
    const day = new Date().toLocaleDateString('sv-SE');
    const today: NonNullable<UsageCache['today']> = { day, status: 'ok', sessions: [] };
    const old = readUsage(), cache: UsageCache = { at: new Date().toISOString(), since, status: 'ok', sources: {}, source_at: {}, sessions: [], today, daily: [] };
    await Promise.all((['claude', 'codex'] as const).map(async client => {
      try {
        cache.sessions.push(...parseUsage(await collect(client, 'session', since), client));
        const d = obj(await collect(client, 'daily', since));
        if (!Array.isArray(d.daily)) throw new Error('invalid_json_shape');
        cache.daily.push(...d.daily.map(r => ({ ...counts(obj(r)), sessions: null, day: String(obj(r).date ?? obj(r).period), client })));
        cache.sources[client] = 'ok';
        cache.source_at = { ...cache.source_at, [client]: new Date().toISOString() };
      } catch (e) {
        const reason = (e as Error).message;
        cache.sources[client] = ['timeout', 'exit_nonzero', 'invalid_json', 'invalid_json_shape'].includes(reason) ? reason : 'unavailable';
        cache.source_at = { ...cache.source_at, [client]: old.source_at?.[client] ?? old.at };
        cache.sessions = cache.sessions.filter(s => s.client !== client).concat(old.sessions.filter(s => s.client === client));
        cache.daily.push(...old.daily.filter(d => d.client === client));
      }
      // Reuse the same ccusage collector/cache, scoped to the local day; lifetime sessions cannot prove role/day totals.
      try { today.sessions.push(...(since === day.replaceAll('-', '') && cache.sources[client] === 'ok' ? cache.sessions.filter(s => s.client === client) : parseUsage(await collect(client, 'session', day.replaceAll('-', '')), client))); }
      catch { today.status = 'unavailable'; }
    }));
    if (Object.values(cache.sources).some(s => s !== 'ok')) cache.status = `用量未知（ccusage 不可用：${Object.entries(cache.sources).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}:${v}`).join(', ')}）；保留旧缓存`;
    const evidence = usageEvidence(); refreshEta(evidence.eta);
    const index = attribute(cache.sessions, evidence.claims, obj(json(join(root(), 'sessions.json'))) as Record<string, Owner>);
    attribute(today.sessions, [], index);
    writeAtomic(join(root(), 'sessions.json'), JSON.stringify(index));
    writeAtomic(join(root(), 'cache.json'), JSON.stringify(cache));
    return cache;
  } finally { held.release(); }
}
export function requestUsageRefresh(): void {
  const c = readUsage();
  if (c.at && Date.now() - Date.parse(c.at) < 300000) return;
  const p = spawn(process.execPath, [join(WETAMP, 'src/cli.ts'), 'usage', '--refresh', '--json'], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
}
export function usageSummary(c: UsageCache): Record<string, unknown> {
  const group = (f: (s: UsageSession) => string, xs = c.sessions): Partial<Record<string, Counts>> => {
    const out: Partial<Record<string, Counts>> = {};
    for (const s of xs) { const k = f(s), a = out[k] ??= empty(); for (const field of Object.keys(a) as (keyof Counts)[]) a[field] += s[field]; }
    return out;
  };
  return { status: c.status, at: c.at, since: c.since, coverage: '仅本机日志；开发机 / mini 不含；会话合计覆盖筛选日期内日志，daily 为实际每日消耗，reasoning 已含在 output 中', sources: c.sources, source_at: c.source_at, total: c.status === 'ok' ? group(() => 'all').all ?? empty() : null, by_role_model: group(s => `${s.owner?.role ?? '?'}·${shortModel(s.model) || '?'}${s.owner?.kind === 'inferred' ? '?' : ''}`, c.sessions.flatMap(s => s.parts?.length ? s.parts.map(p => ({ ...s, ...p })) : [s])), by_kind: group(s => s.owner?.kind ?? 'unknown'), daily: c.daily, top: [...c.sessions].sort((a, b) => b.total - a.total).slice(0, 20).map(s => ({ id: s.id, client: s.client, model: s.model, short_model: shortModel(s.model), at: s.at, owner: s.owner, input: s.input, output: s.output, reasoning: s.reasoning, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: s.total, sessions: 1 })) };
}
export function usageText(c: UsageCache): string {
  const summary = usageSummary(c);
  const row = (k: string, v: Counts): string => [k, v.input, v.output, v.reasoning, v.cacheRead, v.cacheWrite, v.total, v.sessions].join(' ');
  return ['全量（ccusage） · 仅本机日志；开发机 / mini 不含', `${c.status} · 缓存 ${c.at ?? '无'}`, 'kind input output reasoning cacheRead cacheWrite 合计 会话数', ...Object.entries(summary.by_kind as Record<string, Counts>).map(([k, v]) => row(k, v)), '角色×模型', ...Object.entries(summary.by_role_model as Record<string, Counts>).map(([k, v]) => row(k, v)), 'Top 会话（其余汇总见 --json / Web）', ...[...c.sessions].sort((a, b) => b.total - a.total).slice(0, 5).map(s => `${s.id} ${s.owner?.kind ?? 'unknown'} ${fmtTokens(s.total)}`)].join('\n');
}
export const fmtTokens = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
export async function usageCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv), since = a.flags.since;
  const date = since ? new Date(`${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6, 8)}`) : null;
  if (since && (!/^\d{8}$/.test(since) || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll('-', '') !== since)) throw new Error('--since must be YYYYMMDD');
  const cached = readUsage(), c = a.flags.refresh || (since && cached.since !== since) ? await refreshUsage(since) : cached;
  console.log(a.flags.json ? JSON.stringify(usageSummary(c), null, 2) : usageText(c));
  return c.status === 'ok' ? 0 : 1;
}
