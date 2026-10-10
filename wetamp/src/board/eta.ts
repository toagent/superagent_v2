import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from '../archon';
import type { Ledger } from '../cli';
import { home, writeAtomic } from '../config';
import { workflowRoles } from './workflow';

export interface Progress { pct: number | null; eta_s: number | null; overrun_s: number; basis: 'history' | 'linear' | 'unknown' }
export interface Estimate { progress: Progress; weight: number }
export const unknownProgress = (): Progress => ({ pct: null, eta_s: null, overrun_s: 0, basis: 'unknown' });
type Nodes = NonNullable<RunView['nodes']>;
export interface EtaInput { ledger: Ledger; run: RunView; samples: { id: string; seconds: number }[] }
const kind = (id: string): string => /^(code|verify|repair|settle|diff|review|fix|gate|land)(?:-|$)/.exec(id)?.[1] ?? 'other';
const median = (xs: number[]): number => { const sorted = [...xs].sort((a, b) => a - b), i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
/** Time weights are measured durations, never node counts. Sparse classes use observed run throughput. */
export function estimate(nodes: Nodes, samples: EtaInput['samples'], elapsed: number, now: number): Estimate {
  const history = new Map<string, number[]>();
  for (const s of samples) if (Number.isFinite(s.seconds) && s.seconds > 0) history.set(kind(s.id), [...(history.get(kind(s.id)) ?? []), s.seconds]);
  const observed = nodes.filter(n => n.state === 'completed' && (n.durationMs ?? 0) > 0).map(n => n.durationMs! / 1000);
  const fallback = observed.length ? median(observed) : null;
  const active = nodes.filter(n => n.state !== 'skipped');
  const weights = active.map(n => { const xs = history.get(kind(n.nodeId)) ?? []; return xs.length >= 3 ? median(xs) : fallback; });
  if (!active.length || weights.some(w => w === null)) return { progress: unknownProgress(), weight: 0 };
  const ws = weights.map(w => w ?? 0), total = ws.reduce((a, b) => a + b, 0);
  const done = active.reduce((sum, n, i) => sum + (n.state === 'completed' ? ws[i] : 0), 0);
  const linear = active.some(n => (history.get(kind(n.nodeId))?.length ?? 0) < 3);
  const scale = linear && done > 0 && elapsed > 0 ? elapsed / done : 1;
  if (linear && !(done > 0 && elapsed > 0)) return { progress: unknownProgress(), weight: total };
  let worked = done * scale, remaining = 0, overrun = 0;
  active.forEach((n, i) => {
    if (n.state === 'completed') return;
    const expected = ws[i] * scale;
    const start = Date.parse(n.startedAt ?? n.execution?.timing.startedAt ?? '');
    if (n.state === 'running' && !Number.isFinite(start)) { remaining = NaN; return; }
    const spent = n.state === 'running' ? Math.max(0, (now - start) / 1000) : 0;
    worked += Math.min(spent, expected); remaining += Math.max(expected - spent, 0);
    overrun = Math.max(overrun, spent - expected);
  });
  return { weight: total * scale, progress: { pct: Number.isFinite(remaining) ? Math.round(100 * worked / (total * scale)) : null, eta_s: Number.isFinite(remaining) ? Math.ceil(remaining - 1e-9) : null, overrun_s: Math.max(0, Math.ceil(overrun)), basis: Number.isFinite(remaining) ? linear ? 'linear' : 'history' : 'unknown' } };
}
export function totalProgress(xs: Estimate[]): Progress {
  if (!xs.length || xs.some(x => x.progress.pct === null || x.progress.eta_s === null || x.weight <= 0)) return unknownProgress();
  const weight = xs.reduce((n, x) => n + x.weight, 0);
  return { pct: Math.round(xs.reduce((n, x) => n + (x.progress.pct ?? 0) * x.weight, 0) / weight), eta_s: Math.max(...xs.map(x => x.progress.eta_s ?? 0)), overrun_s: Math.max(...xs.map(x => x.progress.overrun_s)), basis: xs.some(x => x.progress.basis === 'linear') ? 'linear' : 'history' };
}
export function refreshEta(inputs: EtaInput[], now = Date.now()): void {
  const samples = inputs.flatMap(x => x.samples), runs: Record<string, Estimate> = {};
  for (const { ledger, run } of inputs) {
    if (run.status !== 'running') continue;
    const ids = workflowRoles(ledger);
    runs[ledger.run_id] = ids ? estimate([...ids.keys()].map(id => run.nodes?.find(n => n.nodeId === id) ?? { nodeId: id, state: 'pending' }), samples, Math.max(0, (now - Date.parse(ledger.started_at)) / 1000), now) : { progress: unknownProgress(), weight: 0 };
  }
  writeAtomic(join(home().sa, 'usage', 'eta.json'), JSON.stringify({ at: new Date(now).toISOString(), runs }));
}
export function readEta(): Record<string, Estimate> {
  try {
    const c = JSON.parse(readFileSync(join(home().sa, 'usage', 'eta.json'), 'utf8')) as { at: string; runs: Record<string, Estimate> };
    return Date.now() - Date.parse(c.at) < 600000 ? Object.fromEntries(Object.entries(c.runs).filter(([, x]) => x && Number.isFinite(x.weight) && x.weight >= 0 && x.progress && ['history', 'linear', 'unknown'].includes(x.progress.basis) && (x.progress.pct === null || Number.isFinite(x.progress.pct) && x.progress.pct >= 0 && x.progress.pct <= 100) && (x.progress.eta_s === null || Number.isFinite(x.progress.eta_s) && x.progress.eta_s >= 0) && Number.isFinite(x.progress.overrun_s) && x.progress.overrun_s >= 0)) : {};
  } catch { return {}; }
}
export const progressLabel = (p: Progress): string => `${p.pct === null ? '?' : String(p.pct)}% ${p.overrun_s > 0 ? `超~${String(Math.ceil(p.overrun_s / 60))}m` : p.eta_s === null ? '剩?' : `剩~${p.basis === 'linear' ? '?' : ''}${String(Math.ceil(p.eta_s / 60))}m`}`;
