// prettier-ignore
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { archonJson, archonRunIds, lock } from './archon';
import { home, WETAMP, writeAtomic } from './config';
import { ledgerIds, ledgerPath, loadLedger, parseArgs } from './cli';
import type { Job } from './jobs';
import { isTier, type Tier } from './roles';
import { shortModel } from './models';
import { sessionModel } from './models';
import type { SerializedNodeData } from '../../packages/workflows/src/node-record-serialization';
import { etaInput, refreshEta, type EtaInput } from './board/eta';
import type { RunView } from './archon';
import type { WorkflowEventRow } from '../../packages/workflows/src/schemas/workflow-event';
import { workflowRoles } from './board/workflow';
import type { TokenUsage } from '../../packages/provider-contract/src/result';
import { redact } from './redact';
import { repoScope } from './coord';

export type ReportTokens = Partial<TokenUsage> & {
  basis?: 'gross' | 'raw-exclusive' | 'unknown';
  reason?: string;
  raw?: Partial<TokenUsage>;
};
export const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
/** Engine receipts have a gross contract; cumulative sessions need a structured total equation. */
// prettier-ignore
export function normalizeTokens(raw: ReportTokens, basis: 'gross' | 'claude-raw' | 'session' = 'gross'): ReportTokens {
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const unknown = (reason: string): ReportTokens => ({ cost: raw.cost, basis: 'unknown', reason, raw });
  if (!valid(raw.input) || !valid(raw.output) || tokenFields.some(f => raw[f] !== undefined && !valid(raw[f]))) return unknown('invalid_token_fields');
  const cache = (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0);
  let exclusive = basis === 'claude-raw';
  if (basis === 'session') {
    if (![raw.total, raw.cacheRead, raw.cacheWrite].every(valid)) return unknown('missing_or_invalid_session_fields');
    const gross = raw.total === raw.input + raw.output;
    exclusive = raw.total === raw.input + raw.output + cache;
    if (gross === exclusive) return unknown('ambiguous_or_inconsistent_total');
  }
  const input = raw.input + (exclusive ? cache : 0);
  if (!valid(input) || cache > input) return unknown('cache_exceeds_input');
  return { ...raw, input, ...(basis === 'session' ? { basis: exclusive ? 'raw-exclusive' as const : 'gross' as const, raw } : {}) };
}
// prettier-ignore
export function tokenTotals(rows: ReportTokens[]): Record<string, number | 'unknown' | string[]> {
  const reasons = [...new Set(rows.flatMap(r => r.basis === 'unknown' ? [r.reason ?? 'unknown_basis'] : []))];
  return { ...(reasons.length ? { reasons } : {}), ...Object.fromEntries(tokenFields.map(field => {
    const values = rows.map(r => r[field]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    return [field, rows.some(r => r.basis === 'unknown') ? 'unknown' : values.length ? values.reduce((a, b) => a + b, 0) : 'unknown'];
  })) };
}
// prettier-ignore
export function sessionTokens(s: UsageSession): ReportTokens {
  return normalizeTokens({ input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: s.total, ...(s.cost !== null ? { cost: s.cost } : {}) }, 'session');
}
// prettier-ignore
export function tokenFees(rows: ReportTokens[]): number | 'unknown' {
  return rows.length && rows.every(r => typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0)
    ? rows.reduce((sum, r) => sum + (r.cost ?? 0), 0) : 'unknown';
}

/** Session snapshots carry no invocation watermark; overlap cannot prove coverage. */
// prettier-ignore
export function investmentOf(calls: { provider: string | null; session: string | null; identity: string | null; tokens: ReportTokens | null }[], sessions: UsageSession[], missing = 0) {
  const snapshots = new Map<string, UsageSession>();
  let conflict = sessions.some(s => s.owner?.conflict);
  for (const s of sessions) {
    const k = key(s.client, s.id), old = snapshots.get(k);
    if (old?.owner?.request_ref && s.owner?.request_ref && old.owner.request_ref !== s.owner.request_ref) conflict = true;
    if (!old || s.total >= old.total) snapshots.set(k, s);
  }
  const receipts = new Map<string, typeof calls[number] & { provider: string; session: string }>();
  let unknown = missing;
  for (const c of calls) {
    if (!c.identity || !c.provider || !c.session) { unknown++; continue; }
    const old = receipts.get(c.identity);
    if (old && JSON.stringify(old) !== JSON.stringify(c)) conflict = true;
    receipts.set(c.identity, { ...c, provider: c.provider, session: c.session });
  }
  const rows = [...snapshots.values()].map(sessionTokens);
  let sources = rows.length + unknown;
  for (const c of receipts.values()) {
    if (snapshots.has(key(c.provider, c.session))) { sources++; unknown++; continue; }
    sources++;
    if (c.tokens) rows.push(c.tokens); else unknown++;
  }
  const known = tokenTotals(rows);
  const covered = rows.filter(r => r.basis !== 'unknown').length;
  const complete = !conflict && !unknown && covered === sources;
  return { ...tokenTotals(complete ? rows : []), fees: complete ? tokenFees(rows) : 'unknown',
    known_tokens: known, coverage: `${String(covered)}/${String(sources)}`, deduplication: conflict || unknown ? 'unknown' : 'covered',
    status: complete && sources > 0 ? 'known' : 'unknown' };
}

export type Client = 'claude' | 'codex';
// prettier-ignore
export interface Counts { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; sessions: number }
// prettier-ignore
export interface Owner { client: Client; role: Tier | null; model: string | null; cwd: string | null; kind: 'run' | 'job' | 'interactive' | 'inferred' | 'unknown'; run_id?: string; job_id?: string; request_ref?: string; conflict?: boolean }
// prettier-ignore
export interface UsageSession extends Counts { id: string; client: Client; model: string | null; at: string; cost: number | null; owner?: Owner; parts?: (Counts & { model: string })[] }
// prettier-ignore
export interface UsageCache { at: string | null; since?: string; repo?: string; source_at?: Partial<Record<Client, string | null>>; status: string; sources: Partial<Record<Client, string>>; sessions: UsageSession[]; today?: { day: string; status: string; sessions: UsageSession[] }; daily: (Omit<Counts, 'sessions'> & { day: string; client: Client; sessions: null })[] }
type ObjectValue = Record<string, unknown>;
// prettier-ignore
const obj = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const root = (): string => join(home().sa, 'usage');
// prettier-ignore
export const sessionKey = (id: string): string => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id)?.[0].toLowerCase() ?? id;
const key = (client: string, id: string): string => `${client}:${sessionKey(id)}`;
// prettier-ignore
const empty = (): Counts => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, sessions: 0 });
// prettier-ignore
const counts = (r: ObjectValue): Counts => ({ input: n(r.inputTokens), output: n(r.outputTokens), reasoning: n(r.reasoningOutputTokens), cacheRead: typeof r.cacheReadTokens === 'number' ? r.cacheReadTokens : NaN, cacheWrite: typeof r.cacheCreationTokens === 'number' ? r.cacheCreationTokens : NaN, total: n(r.totalTokens), sessions: 1 });
// prettier-ignore
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
    const session = { ...counts(r), id: sessionKey(id), client, model: str(models.at(-1)), at: str(r.lastActivity ?? obj(r.metadata).lastActivity) ?? '', cost: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null, parts };
    const prior = seen.get(key(client, id));
    if (!prior || Date.parse(session.at) >= Date.parse(prior.at) || session.total >= prior.total && (!Number.isFinite(Date.parse(session.at)) || !Number.isFinite(Date.parse(prior.at)))) seen.set(key(client, id), session);
  }
  return [...seen.values()];
}
// prettier-ignore
const priority: Record<Owner['kind'], number> = { run: 5, job: 4, interactive: 3, inferred: 2, unknown: 1 };
// prettier-ignore
export function attribute(sessions: UsageSession[], claims: { id: string; owner: Owner }[], prior: Partial<Record<string, Owner>> = {}): Partial<Record<string, Owner>> {
  const index = { ...prior };
  for (const { id, owner } of claims) {
    const k = key(owner.client, id), old = index[k];
    const conflict = (old?.conflict ?? false) || !!(old?.request_ref && owner.request_ref && old.request_ref !== owner.request_ref) || !!(old?.run_id && owner.run_id && old.run_id !== owner.run_id && (!old.request_ref || old.request_ref !== owner.request_ref));
    const request_ref = owner.request_ref ?? old?.request_ref;
    const next = !old || priority[owner.kind] >= priority[old.kind] ? { ...owner, role: owner.role ?? old?.role ?? null }
      : !old.role && owner.role ? { ...old, role: owner.role } : old;
    index[k] = { ...next, ...(request_ref ? { request_ref } : {}), ...(conflict ? { conflict: true } : {}) };
  }
  for (const s of sessions) { const k = key(s.client, s.id); s.owner = index[k] ??= { client: s.client, role: null, model: s.model, cwd: null, kind: 'unknown' }; }
  return index;
}
// prettier-ignore
const json = (file: string): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return null; } };
// prettier-ignore
function files(dir: string): string[] { try { return readdirSync(dir).map(f => join(dir, f)); } catch { return []; } }
/** Only the bounded first JSONL line is interpreted for identity/cwd/time. */
// prettier-ignore
function first(file: string): ObjectValue {
  let fd: number | undefined;
  try { fd = openSync(file, 'r'); const b = Buffer.alloc(Math.min(65536, fstatSync(fd).size)); readSync(fd, b, 0, b.length, 0); return obj(JSON.parse(b.toString('utf8').split('\n')[0])); }
  catch { return {}; } finally { if (fd !== undefined) closeSync(fd); }
}
// prettier-ignore
export function logSessionId(file: string | null, client: string): string | null { const r = file ? first(file) : {}, p = client === 'codex' ? obj(r.payload) : r; return str(p.id ?? p.sessionId); }
// prettier-ignore
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
interface RunEvidence {
  fingerprint: string;
  status: RunView['status'];
  claims: { id: string; owner: Owner }[];
  eta: EtaInput;
}
// prettier-ignore
const compactEta = ({ ledger: l, run: r, samples }: EtaInput): EtaInput => ({ ledger: { run_id: l.run_id, gen_dir: l.gen_dir, repo: l.repo, workflow: l.workflow, started_at: l.started_at } as EtaInput['ledger'], run: { id: r.id, status: r.status, last_activity_at: r.last_activity_at, nodes: r.nodes?.map(n => ({ nodeId: n.nodeId, state: n.state, ...(n.startedAt ?? n.execution?.timing.startedAt ? { startedAt: n.startedAt ?? n.execution?.timing.startedAt } : {}), ...(n.durationMs !== undefined ? { durationMs: n.durationMs } : {}) })) }, samples });
// prettier-ignore
const compactEvidence = (e: RunEvidence): RunEvidence => ({ fingerprint: e.fingerprint, status: e.status, claims: e.claims, eta: compactEta(e.eta) });
const eventsKey = Buffer.from('"events"');
/** Legacy events are already reduced into nodes/samples; skip their payload before JSON.parse allocates it. */
// prettier-ignore
function stripEvents(raw: Buffer): [string, boolean] {
  const parts: Buffer[] = []; let start = 0, quoted = false, escaped = false;
  for (let i = 0; i <= raw.length - eventsKey.length; i++) {
    const c = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (c === 92) escaped = true; else if (c === 34) quoted = false; continue; }
    if (c !== 34) continue;
    if (!raw.subarray(i, i + eventsKey.length).equals(eventsKey)) { quoted = true; continue; }
    let j = i + eventsKey.length; while ([9, 10, 13, 32].includes(raw[j])) j++;
    if (raw[j++] !== 58) { i += eventsKey.length - 1; continue; } while ([9, 10, 13, 32].includes(raw[j])) j++;
    if (raw[j] !== 91) { i += eventsKey.length - 1; continue; }
    let depth = 1, nestedQuoted = false, nestedEscaped = false, k = j + 1;
    for (; k < raw.length && depth; k++) { const c = raw[k]; if (nestedQuoted) { if (nestedEscaped) nestedEscaped = false; else if (c === 92) nestedEscaped = true; else if (c === 34) nestedQuoted = false; } else if (c === 34) nestedQuoted = true; else if (c === 91) depth++; else if (c === 93) depth--; }
    if (depth) break;
    parts.push(raw.subarray(start, j + 1), raw.subarray(k - 1, k)); start = k; i = k - 1;
  }
  if (!parts.length) return [raw.toString('utf8'), false];
  parts.push(raw.subarray(start)); return [Buffer.concat(parts).toString('utf8'), true];
}
/** Stream top-level entries so a legacy multi-GB cache never exists as one parsed object. */
// prettier-ignore
function priorEvidence(file: string): Partial<Record<string, RunEvidence>> {
  let fd: number | undefined, depth = 0, quoted = false, escaped = false, start = 0, migrated = 0;
  const out: Record<string, RunEvidence> = {}, parts: Buffer[] = [], b = Buffer.alloc(65536);
  const accept = (): boolean => { try { const [entry, legacy] = stripEvents(Buffer.concat(parts)); for (const [k, v] of Object.entries(JSON.parse(`{${entry}}`) as Record<string, RunEvidence>)) out[k] = compactEvidence(v); return legacy; } catch { return false; /* Ignore a malformed cache entry. */ } finally { parts.length = 0; } };
  try {
    fd = openSync(file, 'r'); let size = 0;
    while ((size = readSync(fd, b, 0, b.length, null)) > 0) {
      for (let i = 0; i < size; i++) {
        const c = b[i];
        if (!depth) { if (c === 123) { depth = 1; start = i + 1; } continue; }
        if (!quoted && depth === 1 && (c === 44 || c === 125)) { if (i > start || parts.length) { parts.push(Buffer.from(b.subarray(start, i))); if (accept() && ++migrated % 16 === 0) Bun.gc(true); } start = i + 1; if (c === 125) depth = 0; continue; }
        if (quoted) { if (escaped) escaped = false; else if (c === 92) escaped = true; else if (c === 34) quoted = false; }
        else if (c === 34) quoted = true; else if (c === 123 || c === 91) depth++; else if (c === 125 || c === 93) depth--;
      }
      if (depth && start < size) parts.push(Buffer.from(b.subarray(start, size)));
      start = 0;
    }
  } catch { return {}; } finally { if (fd !== undefined) closeSync(fd); }
  return out;
}
/** Read-only evidence collection; cache writes belong to refreshUsage. */
// prettier-ignore
export function usageEvidence(query = archonJson): { claims: { id: string; owner: Owner }[]; eta: EtaInput[]; runs: Record<string, RunEvidence> } {
  const prior = priorEvidence(join(root(), 'runs.json'));
  const runs: Record<string, RunEvidence> = {};
  const claims: { id: string; owner: Owner }[] = [];
  const eta: EtaInput[] = [];
  for (const id of ledgerIds()) {
    try {
      const l = loadLedger(id), stamp = statSync(ledgerPath(id));
      const fingerprint = JSON.stringify([l.repo, stamp.mtimeMs, stamp.size]);
      const roles = workflowRoles(l);
      const ref = str(obj(json(join(l.gen_dir, 'plan.json'))).request_ref);
      for (const runId of [l.archon_run_id, ...archonRunIds(l).filter(runId => runId !== l.archon_run_id)]) {
        const cacheKey = JSON.stringify([id, runId]), hit = prior[cacheKey];
        if (hit?.fingerprint === fingerprint && ['completed', 'cancelled'].includes(hit.status)) {
          runs[cacheKey] = hit;
          claims.push(...hit.claims.map(c => ({ ...c, owner: { ...c.owner, ...(ref ? { request_ref: ref } : {}) } })));
          if (runId === l.archon_run_id) eta.push(hit.eta);
          continue;
        }
        try {
          const run = query(['workflow', 'get', runId, '--verbose', '--events'], l.repo);
          const events = arr(run.events) as WorkflowEventRow[];
          const input = compactEta(etaInput(l, run as unknown as RunView, events));
          const runClaims: RunEvidence['claims'] = [];
          for (const raw of arr(run.events)) {
            const e = obj(raw), d = obj(e.data) as Partial<SerializedNodeData>, m = d.binding?.model;
            const client = d.binding?.provider ?? d.provider;
            if (client !== 'codex' && client !== 'claude') continue;
            const role = roles?.get(String(e.step_name));
            const cwd = str(run.working_path), started = d.invocation?.startedAt;
            // Only the latest active launch may use bounded metadata matching; terminal/history nodes require a session id.
            const active = runId === l.archon_run_id && input.run.status === 'running' && input.run.nodes?.some(n => n.nodeId === e.step_name && n.state === 'running') && arr(run.events).slice().reverse().find(v => obj(v).step_name === e.step_name && obj(v).event_type === 'node_started') === raw;
            const session = d.session_id ?? (active && cwd && started ? jobSession({ kind: client, cwd, started_at: started }, true) : null);
            if (!session) continue;
            runClaims.push({ id: session, owner: { client, role: role === 'reviewer' ? 'strategist' : role === 'coder' ? 'general' : null, model: m?.resolved.source === 'provider' ? m.resolved.value : m?.requested ?? d.model ?? null, cwd: cwd ?? l.repo, kind: d.session_id ? 'run' : 'inferred', run_id: id, ...(ref && d.session_id ? { request_ref: ref } : {}) } });
          }
          runs[cacheKey] = { fingerprint, status: input.run.status, claims: runClaims, eta: input };
          claims.push(...runClaims);
          if (runId === l.archon_run_id) eta.push(input);
        } catch { /* Retry unavailable evidence next time; never freeze an unknown lifecycle. */ }
      }
    } catch { /* A missing run provides no ownership proof; existing index survives. */ }
  }
  const jobs: Job[] = files(join(home().sa, 'jobs')).flatMap(f => { const j = obj(json(f)); return typeof j.cwd === 'string' && typeof j.started_at === 'string' ? [j as unknown as Job] : []; });
  for (const j of jobs) {
    if (j.pid === 0) continue; // 内存准入等待/失败的作业从未拥有 provider 会话。
    const id = j.session_id ?? jobSession(j);
    // Persisted job session_id is also produced by cwd/time matching, not a provider receipt.
    if (id && (j.kind === 'claude' || j.kind === 'codex')) claims.push({ id, owner: { client: j.kind, role: j.role ?? null, model: j.model, cwd: j.cwd, kind: 'inferred', job_id: j.id } });
  }
  for (const f of files(join(home().sa, 'live'))) {
    const l = obj(json(f)), client = l.client, id = str(l.session_id);
    if (!id || (client !== 'claude' && client !== 'codex')) continue;
    const hits = jobs.filter(j => j.pid !== 0 && j.cwd === l.cwd && j.kind === client && Math.abs(Date.parse(String(l.turn_at ?? l.at)) - Date.parse(j.started_at)) <= 60000);
    const role = isTier(l.role) ? l.role : l.derived === true ? 'general' : l.derived === false ? 'commander' : null;
    claims.push({ id, owner: hits.length === 1 ? { client, role: hits[0].role ?? role, model: hits[0].model, cwd: hits[0].cwd, kind: 'inferred', job_id: hits[0].id } : { client, role, model: str(l.model) ?? sessionModel(str(l.transcript_path), client), cwd: str(l.cwd), kind: 'interactive' } });
  }
  return { claims, eta, runs };
}
// prettier-ignore
export function readUsage(): UsageCache {
  const c = obj(json(join(root(), 'cache.json')));
  return Array.isArray(c.sessions) && Array.isArray(c.daily) ? c as unknown as UsageCache : { at: null, status: '用量未知（ccusage 不可用：未刷新）', sources: {}, sessions: [], daily: [] };
}
// prettier-ignore
export const usageCommand = (client: Client, mode: 'session' | 'daily', since?: string): string[] => ['nice', '-n', '10', 'bunx', 'ccusage@20.0.28', client, mode, '--json', ...(since ? ['--since', since] : [])];
// prettier-ignore
export async function capture(client: Client, mode: 'session' | 'daily', since?: string, cmd = usageCommand(client, mode, since)): Promise<unknown> {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  const timeout = { expired: false };
  const timer = setTimeout(() => { timeout.expired = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { /* Child already exited. */ } }, 120000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${timeout.expired ? 'timeout' : `exit_nonzero:${String(code)}`}${err ? `\n${redact(err)}` : ''}`);
    try { return JSON.parse(out) as unknown; } catch { throw new Error('invalid_json'); }
  } finally { clearTimeout(timer); }
}
// prettier-ignore
export async function refreshUsage(since?: string, collect = capture): Promise<UsageCache> {
  mkdirSync(root(), { recursive: true });
  const held = lock(join(root(), 'refresh.lock'));
  if (!held.ok) return readUsage();
  try {
    const day = new Date().toLocaleDateString('sv-SE');
    const today: NonNullable<UsageCache['today']> = { day, status: 'ok', sessions: [] };
    const old = readUsage(), cache: UsageCache = { at: new Date().toISOString(), since, status: 'ok', sources: {}, source_at: {}, sessions: [], today, daily: [] };
    // bunx installs/links both clients from the same package cache; serialize under refresh.lock.
    for (const client of ['claude', 'codex'] as const) {
      try {
        cache.sessions.push(...parseUsage(await collect(client, 'session', since), client));
        const d = obj(await collect(client, 'daily', since));
        if (!Array.isArray(d.daily)) throw new Error('invalid_json_shape');
        cache.daily.push(...d.daily.map(r => ({ ...counts(obj(r)), sessions: null, day: String(obj(r).date ?? obj(r).period), client })));
        cache.sources[client] = 'ok';
        cache.source_at = { ...cache.source_at, [client]: new Date().toISOString() };
      } catch (e) {
        cache.sources[client] = e instanceof Error ? redact(e.message) : 'unavailable';
        cache.source_at = { ...cache.source_at, [client]: old.source_at?.[client] ?? old.at };
        cache.sessions = cache.sessions.filter(s => s.client !== client).concat(old.sessions.filter(s => s.client === client));
        cache.daily.push(...old.daily.filter(d => d.client === client));
      }
      // Reuse the same ccusage collector/cache, scoped to the local day; lifetime sessions cannot prove role/day totals.
      try { today.sessions.push(...(since === day.replaceAll('-', '') && cache.sources[client] === 'ok' ? cache.sessions.filter(s => s.client === client) : parseUsage(await collect(client, 'session', day.replaceAll('-', '')), client))); }
      catch { today.status = 'unavailable'; }
    }
    if (Object.values(cache.sources).some(s => s !== 'ok')) cache.status = `用量未知（ccusage 不可用：${Object.entries(cache.sources).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}:${v}`).join(', ')}）；保留旧缓存`;
    const evidence = usageEvidence(); refreshEta(evidence.eta);
    writeAtomic(join(root(), 'runs.json'), JSON.stringify(evidence.runs));
    const index = attribute(cache.sessions, evidence.claims, obj(json(join(root(), 'sessions.json'))) as Record<string, Owner>);
    attribute(today.sessions, [], index);
    writeAtomic(join(root(), 'sessions.json'), JSON.stringify(index));
    writeAtomic(join(root(), 'cache.json'), JSON.stringify(cache));
    return cache;
  } finally { held.release(); }
}
// prettier-ignore
export function requestUsageRefresh(): void {
  const c = readUsage();
  if (c.at && Date.now() - Date.parse(c.at) < 300000) return;
  const p = spawn(process.execPath, [join(WETAMP, 'src/cli.ts'), 'usage', '--refresh', '--json'], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
}
// prettier-ignore
export function usageForRepo(c: UsageCache, repo: string): UsageCache {
  const target = repoScope(repo).id;
  const belongs = (s: UsageSession): boolean => {
    try {
      const path = s.owner?.run_id ? loadLedger(s.owner.run_id).repo : s.owner?.cwd;
      return !!path && repoScope(path).id === target;
    } catch { return false; }
  };
  return { ...c, repo, sessions: c.sessions.filter(belongs), ...(c.today ? { today: { ...c.today, sessions: c.today.sessions.filter(belongs) } } : {}), daily: [] };
}
// prettier-ignore
export function usageSummary(c: UsageCache): Record<string, unknown> {
  const group = (f: (s: UsageSession) => string, xs = c.sessions): Partial<Record<string, Counts>> => {
    const out: Partial<Record<string, Counts>> = {};
    for (const s of xs) { const k = f(s), a = out[k] ??= empty(); for (const field of Object.keys(a) as (keyof Counts)[]) a[field] += s[field]; }
    return out;
  };
  return { ...(c.repo ? { repo: c.repo } : {}), attribution: 'unknown = no matching ownership evidence; may include engine sessions without receipts, interactive sessions or other tools; ? = unknown role', status: c.status, at: c.at, since: c.since, coverage: c.repo ? '仅本机日志；只含有仓库归属证据的会话，daily 无法按仓库归属而省略；reasoning 已含在 output 中' : '仅本机日志；开发机 / mini 不含；会话合计覆盖筛选日期内日志，daily 为实际每日消耗，reasoning 已含在 output 中', sources: c.sources, source_at: c.source_at, total: c.status === 'ok' ? group(() => 'all').all ?? empty() : null, by_role_model: group(s => `${s.owner?.role ?? '?'}·${shortModel(s.model) || '?'}${s.owner?.kind === 'inferred' ? '?' : ''}`, c.sessions.flatMap(s => s.parts?.length ? s.parts.map(p => ({ ...s, ...p })) : [s])), by_kind: group(s => s.owner?.kind ?? 'unknown'), daily: c.daily, top: [...c.sessions].sort((a, b) => b.total - a.total).slice(0, 20).map(s => ({ id: s.id, client: s.client, model: s.model, short_model: shortModel(s.model), at: s.at, owner: s.owner, input: s.input, output: s.output, reasoning: s.reasoning, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: s.total, sessions: 1 })) };
}
// prettier-ignore
export function usageText(c: UsageCache): string {
  const summary = usageSummary(c);
  const row = (k: string, v: Counts): string => [k, v.input, v.output, v.reasoning, v.cacheRead, v.cacheWrite, v.total, v.sessions].join(' ');
  return [c.repo ? `仓库 ${c.repo}（ccusage） · 仅有归属证据的本机会话` : '全量（ccusage） · 仅本机日志；开发机 / mini 不含', `${c.status} · 缓存 ${c.at ?? '无'}`, String(summary.attribution), 'kind input output reasoning cacheRead cacheWrite 合计 会话数', ...Object.entries(summary.by_kind as Record<string, Counts>).map(([k, v]) => row(k, v)), '角色×模型', ...Object.entries(summary.by_role_model as Record<string, Counts>).map(([k, v]) => row(k, v)), 'Top 会话（其余汇总见 --json / Web）', ...[...c.sessions].sort((a, b) => b.total - a.total).slice(0, 5).map(s => `${s.id} ${s.owner?.kind ?? 'unknown'} ${fmtTokens(s.total)}`)].join('\n');
}
// prettier-ignore
export const fmtTokens = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
// prettier-ignore
export async function usageCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv), since = a.flags.since;
  const date = since ? new Date(`${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6, 8)}`) : null;
  if (since && (!/^\d{8}$/.test(since) || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll('-', '') !== since)) throw new Error('--since must be YYYYMMDD');
  const cached = readUsage(), all = a.flags.refresh || (since && cached.since !== since) ? await refreshUsage(since) : cached, c = a.flags.repo ? usageForRepo(all, a.flags.repo) : all;
  console.log(a.flags.json ? JSON.stringify(usageSummary(c), null, 2) : usageText(c));
  return c.status === 'ok' ? 0 : 1;
}
