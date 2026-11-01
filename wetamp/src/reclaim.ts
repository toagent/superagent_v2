import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
// prettier-ignore
import { Coordination, coord, identityKey, runScope, same, type Identity, type RunRef } from './coord';
import { getRun, runStatuses } from './archon';
import { writeAtomic } from './config';
import { loadLedger, mutateLedger } from './ledger';
import { cleanJob, readJobs } from './jobs';
import { queueNtfyAlert } from './ntfy';

const OFFLINE_CLEANUP_MS = 24 * 60 * 60_000; // Cross one night before terminal cleanup.
const LOST_JOB_CLEANUP_MS = 60 * 60_000;
const RESPONSIBILITY_ESCALATION_MS = 30 * 60_000; // PagerDuty-style second escalation.
const abandoned = (run: RunRef): boolean =>
  run.rejected === run.archon_run_id &&
  !!run.intervention_events?.some(event => event.action === 'abandon' && event.ok);

// prettier-ignore
interface Observation { kind?: 'job'; run: string; repo: string; first_offline_at?: number; last_offline_at?: number; last_online_at?: number; count: number; owner: Identity; generation: number }
// prettier-ignore
interface Entry { id: string; run: string; from: Identity; to: Identity; expected_generation: number; observation?: Pick<Observation, 'first_offline_at' | 'last_offline_at' | 'count'>; state: 'transferring' | 'transferred' | 'reauthorized' | 'abandoned_attempt'; at: string }
// prettier-ignore
export interface ReclaimResult { transferred: string[]; unclaimed: string[]; skipped: string[]; skip_reasons: Record<string, 'repository_unavailable'>; pending: string[]; historical: string[] }
// prettier-ignore
const values = <T>(path: string): T[] => { try { const value = JSON.parse(readFileSync(path, 'utf8')) as unknown; return (Array.isArray(value) ? value : Object.values(value ?? {})) as T[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
// prettier-ignore
const json = (path: string): unknown => { try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } };
// prettier-ignore
const records = <T>(path: string): T[] => { try { return readdirSync(path).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(path, file), 'utf8')) as T); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };

// prettier-ignore
export class Reclaimer {
  private root: string; private observations: string; private journal: string;
  private unavailable = new Set<string>();
  constructor(private c: Coordination = coord(), private now = Date.now, private run = getRun) { this.root = join(c.d.sa, 'reclaim'); this.observations = join(this.root, 'observations.json'); this.journal = join(this.root, 'journal.json'); }
  private write(path: string, value: unknown): void { mkdirSync(this.root, { recursive: true }); writeAtomic(path, JSON.stringify(value, null, 2) + '\n'); }
  private append(entry: Entry): void { this.c.locked(() => { this.write(this.journal, [...values<Entry>(this.journal), entry]); }); }
  private latest(): Map<string, Entry> { const out = new Map<string, Entry>(); for (const e of values<Entry>(this.journal)) out.set(e.run, e); return out; }
  private event(run: RunRef, action: string, ok: boolean, evidence: Record<string, unknown>): void {
    const ledger = loadLedger(run.run_id);
    mutateLedger(ledger, cur => (cur.intervention_events ??= []).push({ at: new Date(this.now()).toISOString(), action, reason: action, origin: 'engine', source: 'superagent', ok, ...(!ok ? { error: 'Error' } : {}), evidence }));
  }
  private acceptedAt(o: Observation, scope: ReturnType<typeof runScope>): number | undefined {
    // prettier-ignore
    interface Claim { scope: ReturnType<typeof runScope>; owner: Identity | null; generation: number; history: { owner: Identity | null; generation: number; reason: string }[] }
    // prettier-ignore
    interface Rollover { token: string; state: string; to: Identity | null; accepted_at: string | null }
    const claim = records<Claim>(join(this.c.d.sa, 'coord', 'claims')).find(value => JSON.stringify(value.scope) === JSON.stringify(scope));
    if (!claim || !same(claim.owner, o.owner) || claim.generation !== o.generation) return;
    for (const r of records<Rollover>(join(this.c.d.sa, 'coord', 'rollovers'))) {
      const at = Date.parse(r.accepted_at ?? '');
      if (r.state === 'accepted' && same(r.to, o.owner) && at < (o.first_offline_at ?? 0) && claim.history.some(h => h.generation === o.generation && same(h.owner, o.owner) && h.reason === `rollover:${r.token}`)) return at;
    }
    return undefined;
  }
  private successorOnline(owner: Identity, since: number): boolean { return records<{ state: string; from: Identity; to: Identity | null; accepted_at: string | null }>(join(this.c.d.sa, 'coord', 'rollovers')).some(r => r.state === 'accepted' && same(r.from, owner) && Date.parse(r.accepted_at ?? '') >= since && !!r.to && this.c.d.presence(r.to).state === 'online'); }
  private abandon(run: RunRef, o: Observation): void {
    this.c.scoped(runScope(run), () => { this.c.locked(() => {
      const view = this.c.owner(runScope(run)), repo = this.c.owner({ kind: 'repo', id: runScope(run).repo });
      if (!same(view.owner, o.owner) || view.generation !== o.generation || view.presence.state !== 'offline' || repo.presence.state === 'online' || this.successorOnline(o.owner, o.first_offline_at ?? this.now())) return;
      const ledger = loadLedger(run.run_id);
      mutateLedger(ledger, cur => {
        if (cur.rejected === cur.archon_run_id) return;
        (cur.intervention_events ??= []).push({ at: new Date(this.now()).toISOString(), action: 'abandon', reason: 'offline_owner_cleanup', origin: 'engine', source: 'superagent', ok: true, evidence: { owner: o.owner, generation: o.generation } });
        cur.rejected = cur.archon_run_id;
      });
    }); });
  }
  private maintain(observations: Observation[]): void {
    const now = this.now();
    const offlineJobs = new Map(observations.filter(o => o.kind === 'job').map(o => [o.run, o]));
    const cleanedJobs = new Set<string>();
    for (const job of readJobs().jobs) if (job.state === 'lost' && job.launcher) {
      const observed = offlineJobs.get(job.id);
      if (observed?.first_offline_at !== undefined && now - observed.first_offline_at >= LOST_JOB_CLEANUP_MS) try { cleanJob(job.id); cleanedJobs.add(job.id); } catch { /* A dirty or unintegrated worktree remains recoverable. */ }
    }
    interface Waiting { id: string; kind?: string; since?: string; waited_s: number; waiting_for: string; next?: string }
    const heartbeat = json(join(this.c.d.sa, 'heartbeat.json')) as { marshals?: { owner: Identity | 'unknown'; project: string; waiting: Waiting[] }[] } | undefined;
    const groups = new Map<string, { owner: Identity | 'unknown'; project: string; waiting: Waiting[] }>();
    for (const marshal of heartbeat?.marshals ?? []) for (const item of marshal.waiting) {
      if (item.kind === 'job' && cleanedJobs.has(item.id)) continue;
      const since = Date.parse(item.since ?? ''), waited = Number.isFinite(since) ? now - since : item.waited_s * 1000;
      if (marshal.owner !== 'unknown' && (waited < RESPONSIBILITY_ESCALATION_MS || this.c.d.presence(marshal.owner).state !== 'online')) continue;
      const key = JSON.stringify([marshal.owner === 'unknown' ? 'unknown' : identityKey(marshal.owner), marshal.project]), group = groups.get(key) ?? { owner: marshal.owner, project: marshal.project, waiting: [] };
      group.waiting.push(item); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const ids = group.waiting.map(item => item.id).sort(), digest = createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 16), shown = group.waiting.slice(0, 5);
      const message = [...shown.map(item => `${item.id.slice(0, 15)} ${item.waiting_for} → ${item.next ?? '需要处理'}`), ...(group.waiting.length > 5 ? [`等 ${String(group.waiting.length - 5)} 项`] : [])].join('\n');
      const title = group.owner === 'unknown' ? `${group.project} 无人负责有 ${String(group.waiting.length)} 项未处理` : `${group.project} 元帅（${group.owner.client} ${group.owner.session_id?.slice(0, 8) ?? `pid:${String(group.owner.pid)}`}）有 ${String(group.waiting.length)} 项超 30 分钟未处理`;
      queueNtfyAlert(`responsibility:${createHash('sha256').update(JSON.stringify([group.owner === 'unknown' ? 'unknown' : identityKey(group.owner), group.project])).digest('hex').slice(0, 12)}:${digest}`, message, {}, title);
    }
  }
  observe(): Observation[] {
    this.unavailable.clear();
    const prior = new Map(values<Observation>(this.observations).flatMap(o => {
      try { return [[o.kind === 'job' ? this.jobKey(o.run, o.owner) : this.key(runScope({ run_id: o.run, repo: o.repo }), o.owner, o.generation), o] as const]; }
      catch { return []; }
    }));
    const next: Observation[] = [], at = this.now(), statuses = this.c.d.statuses();
    for (const run of this.c.d.runs()) {
      let status = run.state === 'failed' ? 'failed' : statuses?.get(run.archon_run_id) ?? 'unknown';
      if (!statuses) try { status = this.c.d.status(run); } catch { /* Unknown remains ownership evidence. */ }
      if (!this.c.isRunOwnershipEvidence(run, statuses ?? new Map([[run.archon_run_id, status]])) && (abandoned(run) || !['failed', 'cancelled'].includes(status))) continue;
      let scope: ReturnType<typeof runScope>;
      try { scope = runScope(run); } catch { this.unavailable.add(run.run_id); continue; }
      const view = this.c.owner(scope);
      if (!view.owner) continue;
      const key = this.key(scope, view.owner, view.generation), old = prior.get(key);
      if (view.presence.state === 'online') next.push({ run: run.run_id, repo: run.repo, owner: view.owner, generation: view.generation, last_online_at: at, count: 0 });
      else if (view.presence.state === 'offline') next.push({ run: run.run_id, repo: run.repo, owner: view.owner, generation: view.generation, last_online_at: old?.last_online_at, first_offline_at: old?.first_offline_at ?? at, last_offline_at: at, count: (old?.count ?? 0) + 1 });
    }
    for (const job of readJobs().jobs) if (job.state === 'lost' && job.launcher && !job.ended_at) {
      const key = this.jobKey(job.id, job.launcher), old = prior.get(key); next.push({ kind: 'job', run: job.id, repo: job.cwd, owner: job.launcher, generation: 0, first_offline_at: old?.first_offline_at ?? at, last_offline_at: at, count: (old?.count ?? 0) + 1 });
    }
    this.write(this.observations, next); return next;
  }
  private key(scope: ReturnType<typeof runScope>, owner: Identity, generation: number): string { return JSON.stringify([scope, identityKey(owner), generation]); }
  private jobKey(id: string, owner: Identity): string { return JSON.stringify(['job', id, identityKey(owner)]); }
  private finish(run: RunRef, entry: Entry): 'transferred' | 'pending' | 'skipped' {
    return this.c.scoped(runScope(run), () => {
      let view = this.c.owner(runScope(run));
      if (!same(view.owner, entry.to)) {
        const moved = this.c.reclaimRun(runScope(run), { key: identityKey(entry.from), generation: entry.expected_generation }, entry.to);
        if (moved.status === 'skipped') { this.append({ ...entry, state: 'abandoned_attempt', at: new Date(this.now()).toISOString() }); return 'skipped'; }
        this.append({ ...entry, state: 'transferred', at: new Date(this.now()).toISOString() }); view = this.c.owner(runScope(run));
      } else if (entry.state === 'transferring') this.append({ ...entry, state: 'transferred', at: new Date(this.now()).toISOString() });
      if (run.gen_dir && existsSync(join(run.gen_dir, 'delivery-authorization.json'))) {
        try { this.c.reauthorize(run, entry.to); }
        catch { this.event(run, 'reclaim:reauthorize_failed', false, { from: entry.from, observation: entry.observation }); this.c.handoff(runScope(run), entry.from, { kind: 'task', title: '回收续授权失败', body: `run ${run.run_id} 需要重试 reauthorize`, evidence: [], severity: 'normal' }, 0, false); return 'pending'; }
      }
      this.event(run, 'reclaim:owner_offline', true, { from: entry.from, observation: entry.observation, generation: view.generation });
      this.append({ ...entry, state: 'reauthorized', at: new Date(this.now()).toISOString() }); return 'transferred';
    }, 0);
  }
  complete(): ReclaimResult {
    const out: ReclaimResult = { transferred: [], unclaimed: [], skipped: [], skip_reasons: {}, pending: [], historical: [] };
    for (const entry of this.latest().values()) if (['transferring', 'transferred'].includes(entry.state)) {
      const run = this.c.resolveRun(entry.run); if (!run) { out.pending.push(entry.run); continue; }
      try { const state = this.finish(run, entry); out[state === 'transferred' ? 'transferred' : state === 'pending' ? 'pending' : 'skipped'].push(entry.run); } catch { out.pending.push(entry.run); }
    }
    return out;
  }
  reclaim(observations = values<Observation>(this.observations)): ReclaimResult {
    const out: ReclaimResult = { transferred: [], unclaimed: [], skipped: [...this.unavailable], skip_reasons: Object.fromEntries([...this.unavailable].map(run => [run, 'repository_unavailable'])), pending: [], historical: [] }, pending = this.latest();
    for (const o of observations) {
      if (o.kind === 'job') continue;
      if (o.count < 2 || o.first_offline_at === undefined || o.last_offline_at === undefined || o.last_offline_at - o.first_offline_at < 120_000) continue;
      if (['transferring', 'transferred'].includes(pending.get(o.run)?.state ?? '')) { out.pending.push(o.run); continue; }
      const run = this.c.resolveRun(o.run); if (!run) { out.skipped.push(o.run); continue; }
      let scope: ReturnType<typeof runScope>; try { scope = runScope(run); } catch { if (!out.skipped.includes(o.run)) out.skipped.push(o.run); out.skip_reasons[o.run] = 'repository_unavailable'; continue; }
      const target = this.c.owner({ kind: 'repo', id: scope.repo });
      const lastOnline = o.last_online_at ?? this.acceptedAt(o, scope);
      let status = 'unknown'; try { status = this.c.d.status(run); } catch { /* Unknown is not terminal. */ }
      if (['failed', 'cancelled'].includes(status)) { if (!abandoned(run) && this.now() - o.first_offline_at >= OFFLINE_CLEANUP_MS && target.presence.state !== 'online') this.abandon(run, o); else out.skipped.push(o.run); continue; }
      if (lastOnline === undefined) { out.historical.push(o.run); continue; }
      if (!target.owner || target.presence.state !== 'online' || same(target.owner, o.owner)) { out.unclaimed.push(o.run); continue; }
      let current; try { current = this.run(run.archon_run_id, run.repo); } catch { out.skipped.push(o.run); continue; }
      if (current.nodes?.some(n => n.state === 'running' && /^(?:resync|sync|integrate|publish)-/.test(n.nodeId))) { out.skipped.push(o.run); continue; }
      const entry: Entry = { id: crypto.randomUUID(), run: o.run, from: o.owner, to: target.owner, expected_generation: o.generation, observation: { first_offline_at: o.first_offline_at, last_offline_at: o.last_offline_at, count: o.count }, state: 'transferring', at: new Date(this.now()).toISOString() };
      try { this.c.scoped(scope, () => { this.append(entry); const state = this.finish(run, entry); out[state === 'transferred' ? 'transferred' : state === 'pending' ? 'pending' : 'skipped'].push(o.run); }, 0); } catch { out.skipped.push(o.run); }
    }
    return out;
  }
  tick(): void {
    this.complete(); const observed = this.observe(), now = this.now(), path = join(this.root, 'schedule.json');
    const state = values<number>(path);
    if (!state.length || now - state[0] >= 300_000) { this.reclaim(observed); this.write(path, { last_reclaim_at: now }); }
    this.maintain(observed);
  }
}

// prettier-ignore
export const reclaimCoord = (statuses = runStatuses(), base = coord()): Coordination => {
  if (!statuses) return base;
  const presences = new Map<string, ReturnType<typeof base.d.presence>>();
  return new Coordination({ ...base.d,
    status: run => run.state === 'failed' ? 'failed' : statuses.get(run.archon_run_id) ?? 'unknown',
    presence: who => { const key = JSON.stringify(identityKey(who)), found = presences.get(key); if (found) return found; const value = base.d.presence(who); presences.set(key, value); return value; },
  });
};
export function reclaimOnce(): ReclaimResult {
  const r = new Reclaimer(reclaimCoord()),
    completed = r.complete(),
    observed = r.observe(),
    reclaimed = r.reclaim(observed);
  return {
    transferred: [...completed.transferred, ...reclaimed.transferred],
    unclaimed: reclaimed.unclaimed,
    skipped: [...completed.skipped, ...reclaimed.skipped],
    skip_reasons: { ...completed.skip_reasons, ...reclaimed.skip_reasons },
    pending: [...completed.pending, ...reclaimed.pending],
    historical: reclaimed.historical,
  };
}
export function reclaimTick(now = Date.now(), r = new Reclaimer(reclaimCoord(), () => now)): void {
  r.tick();
}
export const observe = (now = Date.now()): Observation[] =>
  new Reclaimer(reclaimCoord(), () => now).observe();
export const complete = (now = Date.now()): ReclaimResult =>
  new Reclaimer(reclaimCoord(), () => now).complete();
export const reclaim = (now = Date.now()): ReclaimResult =>
  new Reclaimer(reclaimCoord(), () => now).reclaim();
