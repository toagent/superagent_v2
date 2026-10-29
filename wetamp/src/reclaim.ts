import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// prettier-ignore
import { coord, identityKey, runScope, same, type Coordination, type Identity, type RunRef } from './coord';
import { getRun } from './archon';
import { writeAtomic } from './config';

// prettier-ignore
interface Observation { run: string; repo: string; first_offline_at: number; last_offline_at: number; count: number; owner: Identity; generation: number }
// prettier-ignore
interface Entry { id: string; run: string; from: Identity; to: Identity; expected_generation: number; state: 'transferring' | 'transferred' | 'reauthorized' | 'abandoned_attempt'; at: string }
// prettier-ignore
export interface ReclaimResult { transferred: string[]; unclaimed: string[]; skipped: string[]; pending: string[] }
const operator = () => createRequire(import.meta.url)('./cli.ts') as typeof import('./cli');
// prettier-ignore
const values = <T>(path: string): T[] => { try { const value = JSON.parse(readFileSync(path, 'utf8')) as unknown; return (Array.isArray(value) ? value : Object.values(value ?? {})) as T[]; } catch { return []; } };

// prettier-ignore
export class Reclaimer {
  private root: string; private observations: string; private journal: string;
  constructor(private c: Coordination = coord(), private now = Date.now, private run = getRun) { this.root = join(c.d.sa, 'reclaim'); this.observations = join(this.root, 'observations.json'); this.journal = join(this.root, 'journal.json'); }
  private write(path: string, value: unknown): void { mkdirSync(this.root, { recursive: true }); writeAtomic(path, JSON.stringify(value, null, 2) + '\n'); }
  private append(entry: Entry): void { this.c.locked(() => { this.write(this.journal, [...values<Entry>(this.journal), entry]); }); }
  private latest(): Map<string, Entry> { const out = new Map<string, Entry>(); for (const e of values<Entry>(this.journal)) out.set(e.run, e); return out; }
  private event(run: RunRef, action: string, ok: boolean, evidence: Record<string, unknown>): void {
    const ledger = operator().loadLedger(run.run_id);
    operator().updateLedger(ledger, cur => (cur.intervention_events ??= []).push({ at: new Date(this.now()).toISOString(), action, reason: action, origin: 'engine', source: 'superagent', ok, ...(!ok ? { error: 'Error' } : {}), evidence }));
  }
  observe(): Observation[] {
    const prior = new Map(values<Observation>(this.observations).map(o => [this.key(runScope({ run_id: o.run, repo: o.repo }), o.owner, o.generation), o]));
    const next: Observation[] = [], at = this.now();
    for (const run of this.c.d.runs()) {
      if (!this.c.isRunOwnershipEvidence(run)) continue;
      const scope = runScope(run), view = this.c.owner(scope);
      if (!view.owner || view.presence.state !== 'offline') continue;
      const key = this.key(scope, view.owner, view.generation), old = prior.get(key);
      next.push({ run: run.run_id, repo: run.repo, owner: view.owner, generation: view.generation, first_offline_at: old?.first_offline_at ?? at, last_offline_at: at, count: (old?.count ?? 0) + 1 });
    }
    this.write(this.observations, next); return next;
  }
  private key(scope: ReturnType<typeof runScope>, owner: Identity, generation: number): string { return JSON.stringify([scope, identityKey(owner), generation]); }
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
        catch { this.event(run, 'reclaim:reauthorize_failed', false, { from: entry.from, observation: entry.expected_generation }); this.c.handoff(runScope(run), entry.from, { kind: 'task', title: '回收续授权失败', body: `run ${run.run_id} 需要重试 reauthorize`, evidence: [], severity: 'normal' }, 0, false); return 'pending'; }
      }
      this.event(run, 'reclaim:owner_offline', true, { from: entry.from, observation: entry.expected_generation, generation: view.generation });
      this.append({ ...entry, state: 'reauthorized', at: new Date(this.now()).toISOString() }); return 'transferred';
    }, 0);
  }
  complete(): ReclaimResult {
    const out: ReclaimResult = { transferred: [], unclaimed: [], skipped: [], pending: [] };
    for (const entry of this.latest().values()) if (['transferring', 'transferred'].includes(entry.state)) {
      const run = this.c.resolveRun(entry.run); if (!run) { out.pending.push(entry.run); continue; }
      try { const state = this.finish(run, entry); out[state === 'transferred' ? 'transferred' : state === 'pending' ? 'pending' : 'skipped'].push(entry.run); } catch { out.pending.push(entry.run); }
    }
    return out;
  }
  reclaim(observations = values<Observation>(this.observations)): ReclaimResult {
    const out: ReclaimResult = { transferred: [], unclaimed: [], skipped: [], pending: [] }, pending = this.latest();
    for (const o of observations) {
      if (o.count < 2 || o.last_offline_at - o.first_offline_at < 120_000) continue;
      if (['transferring', 'transferred'].includes(pending.get(o.run)?.state ?? '')) { out.pending.push(o.run); continue; }
      const run = this.c.resolveRun(o.run); if (!run) { out.skipped.push(o.run); continue; }
      const scope = runScope(run), target = this.c.owner({ kind: 'repo', id: scope.repo });
      if (!target.owner || target.presence.state !== 'online' || same(target.owner, o.owner)) { out.unclaimed.push(o.run); continue; }
      if (this.run(run.archon_run_id, run.repo).nodes?.some(n => n.state === 'running' && /^(?:resync|sync|integrate|publish)-/.test(n.nodeId))) { out.skipped.push(o.run); continue; }
      const entry: Entry = { id: crypto.randomUUID(), run: o.run, from: o.owner, to: target.owner, expected_generation: o.generation, state: 'transferring', at: new Date(this.now()).toISOString() };
      try { this.c.scoped(scope, () => { this.append(entry); const state = this.finish(run, entry); out[state === 'transferred' ? 'transferred' : state === 'pending' ? 'pending' : 'skipped'].push(o.run); }, 0); } catch { out.skipped.push(o.run); }
    }
    return out;
  }
}

// prettier-ignore
export function reclaimOnce(): ReclaimResult { const r = new Reclaimer(), completed = r.complete(), observed = r.observe(), reclaimed = r.reclaim(observed); return { transferred: [...completed.transferred, ...reclaimed.transferred], unclaimed: reclaimed.unclaimed, skipped: [...completed.skipped, ...reclaimed.skipped], pending: [...completed.pending, ...reclaimed.pending] }; }
export const observe = (now = Date.now()): Observation[] =>
  new Reclaimer(coord(), () => now).observe();
export const complete = (now = Date.now()): ReclaimResult =>
  new Reclaimer(coord(), () => now).complete();
export const reclaim = (now = Date.now()): ReclaimResult =>
  new Reclaimer(coord(), () => now).reclaim();
