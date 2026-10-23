import { confined, OUTSIDE } from './board/workflow';
// Ledger-derived measurements shared by report, board and cockpit.
import { existsSync, readFileSync } from 'node:fs';
import { WETAMP } from './config';
import { join, resolve } from 'node:path';
import { archonRunIds, type RunView } from './archon';
import {
  artifactsOf,
  evidenceGates,
  decisionOf,
  evidenceJson,
  summarize,
  type Ledger,
  type Pair,
} from './cli';
import { milestones, type Plan } from './plan';
import { providerTiming, providerMetricMissing } from './provider-timing';
import type { SerializedNodeData } from '../../packages/workflows/src/node-record-serialization';
import type { Event } from './report';
import type { BoardRow } from './board/data';

// SQLite CURRENT_TIMESTAMP is UTC, despite carrying no zone suffix.
export const clock = (value = ''): number =>
  Date.parse(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  );
export const ms = (a?: string, b?: string): number | null => {
  const delta = a && b ? clock(b) - clock(a) : NaN;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
};

/** Historical events without origin remain operator interventions; never infer from prose. */
export const interventionCount = (l: Ledger): number | undefined =>
  l.intervention_events?.filter(e => !(e.action === 'land' && e.origin === 'engine')).length;

export const abandoned = (l: Ledger): boolean =>
  l.rejected === l.archon_run_id &&
  !!l.intervention_events?.some(event => event.action === 'abandon' && event.ok);

export const cwdOf = (l: Ledger): string => (existsSync(l.repo) ? l.repo : WETAMP);
const precisionOf = (value?: string): number => (value?.includes(' ') ? 1000 : 0);

export function planFileOf(l: Ledger): string | null {
  const locate = (path: string): string | null => {
    try {
      return confined(l, path);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith(OUTSIDE)) return null;
      throw error;
    }
  };
  return (
    (typeof l.plan === 'string' ? locate(resolve(l.repo, l.plan)) : null) ??
    locate(join(l.gen_dir, 'plan.json'))
  );
}

export function planOf(l: Ledger): Plan | null {
  try {
    const file = planFileOf(l);
    if (file) {
      const value = JSON.parse(readFileSync(file, 'utf8')) as {
        packages?: (Partial<Plan['packages'][number]> | null)[];
      };
      if (
        Array.isArray(value.packages) &&
        value.packages.every(
          p =>
            p &&
            typeof p.id === 'string' &&
            (p.title === undefined || typeof p.title === 'string') &&
            (p.milestone === undefined || typeof p.milestone === 'string')
        )
      )
        return value as Plan;
    }
  } catch {
    /* Unavailable plan stays explicit. */
  }
  return null;
}

/** Only a captured executable graph can explain blocking; authoring YAML is not evidence. */
// prettier-ignore
export function criticalPath( run: RunView, events: Event[], graph?: { id: string; depends_on?: string[]; wait?: unknown }[] ): Record<string, unknown> {
  const elapsed = ms(run.started_at ?? undefined, run.completed_at ?? undefined);
  const unknown = { status: 'unknown', elapsed_ms: elapsed ?? 'unknown', reason: 'missing_graph_clock_or_attempt_mapping', };
  if (!graph?.length || elapsed === null) return unknown;
  const rows = new Map<string, { start: number; end: number; queue: number }>();
  for (const e of events) {
    if (!['node_completed', 'node_failed', 'node_skipped'].includes(e.event_type) || !e.step_name)
      continue;
    if (rows.has(e.step_name) || e.data?.invocation?.loopPath?.length) return unknown;
    const skipped = e.event_type === 'node_skipped';
    const start = clock(e.data?.timing?.startedAt ?? e.data?.attempt?.startedAt ?? (skipped ? e.created_at : '') ?? '');
    const end = skipped ? start : start + (e.data?.timing?.durationMs ?? NaN);
    const queue = skipped ? 0 : ms(e.data?.invocation?.startedAt, e.data?.attempt?.startedAt);
    if (![start, end].every(Number.isFinite) || end < start || queue === null) return unknown;
    rows.set(e.step_name, { start, end, queue });
  }
  if (graph.some(n => !rows.has(n.id)) || rows.size !== graph.length) return unknown;
  const nodes = new Map(graph.map(n => [n.id, n]));
  const path: string[] = [],
    visiting = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false;
    visiting.add(id);
    const n = nodes.get(id),
      row = rows.get(id);
    if (!n || !row) return false;
    const deps = n.depends_on ?? [];
    if (deps.some(d => !rows.has(d) || (row.end > row.start && (rows.get(d)?.end ?? Infinity) > row.start + 1000))) return false;
    const pred = [...deps].sort((a, b) => (rows.get(b)?.end ?? 0) - (rows.get(a)?.end ?? 0))[0];
    if (pred && !walk(pred)) return false;
    path.push(id);
    return true;
  };
  const last = [...rows].sort((a, b) => b[1].end - a[1].end)[0]?.[0];
  if (!last || !walk(last)) return unknown;
  let cursor = clock(run.started_at ?? '');
  const recordedEnd = clock(run.completed_at ?? '');
  // SQL terminal clocks truncate milliseconds; node persistence may finish after dispatch.
  const precision = precisionOf(run.completed_at ?? undefined);
  const end = Math.max(recordedEnd, ...[...rows.values()].map(r => r.end));
  if (end > recordedEnd + precision) return unknown;
  const segments: { phase: string; node?: string; ms: number }[] = [];
  for (const id of path) {
    const row = rows.get(id);
    if (!row) return unknown;
    if (row.start < clock(run.started_at ?? '')) return unknown;
    const queued = Math.max(cursor, row.start - row.queue), started = Math.max(queued, row.start);
    segments.push({ phase: 'unclassified_wait', ms: queued - cursor }, { phase: 'queue', node: id, ms: started - queued }, { phase: nodes.get(id)?.wait ? 'human_wait' : (/^(code|review|repair|fix|verify)-/.exec(id)?.[1] ?? 'script'), node: id, ms: Math.max(0, row.end - started), } );
    cursor = Math.max(cursor, row.end);
  }
  segments.push({ phase: 'unclassified_wait', ms: end - cursor });
  return { status: 'measured', elapsed_ms: end - clock(run.started_at ?? ''), recorded_elapsed_ms: elapsed, clock_precision_ms: precision, path, segments, critical_path_ms: segments.filter(s => s.phase !== 'unclassified_wait').reduce((s,r) => s + r.ms, 0), reconciled_ms: segments.reduce((s, r) => s + r.ms, 0), unclassified_wait: 'unknown_cause', };
}

export function firstPassOf(
  pair: Pair,
  stats: Record<string, unknown> = summarize([pair], false)
): boolean | 'unknown' {
  const { ledger, run } = pair;
  if (run instanceof Error) return 'unknown';
  if (run.status !== 'completed') return false;
  if (
    ledger.auto_retries?.length ||
    ledger.recoveries?.length ||
    archonRunIds(ledger).length > 1 ||
    (run.nodes ?? []).some(n => /^(repair|fix)-/.test(n.nodeId) && n.state !== 'skipped')
  )
    return false;
  const plan = planOf(ledger);
  if (!plan || !run.nodes?.length) return 'unknown';
  let count: number;
  try {
    count = milestones(plan).length;
  } catch {
    return 'unknown';
  }
  try {
    const art = artifactsOf(run);
    if (evidenceGates(ledger, art).some(g => !decisionOf(evidenceJson(ledger, art, g))))
      return 'unknown';
  } catch {
    return 'unknown';
  }
  const gates = Object.entries(stats).filter(([k]) => k.startsWith('rounds:'));
  if (
    !count ||
    (stats.unreadable as string[]).length ||
    gates.reduce((sum, [, n]) => sum + Number(n), 0) !== count
  )
    return 'unknown';
  return stats.first_pass === count;
}

/** Cumulative sums explicit attempt receipts, never min-start/max-end pairing.
 * Critical wall clock is the run lifecycle (parallel work counted once), not engine overhead.
 * Hold/idle fold captured critical-path segments, falling back to explicit wait pairs.
 * Missing wait history cannot prove zero holds; external dispatch is outside this boundary. */
// prettier-ignore
export function measurementOf(run: RunView, events: Event[], plan: Plan | null, timings: ReturnType<typeof providerTiming> = providerTiming(run.id, events), graph?: Parameters<typeof criticalPath>[2], path = criticalPath(run, events, graph)) {
  const terminals = events.filter(e => ['node_completed', 'node_failed'].includes(e.event_type) && (e.data as SerializedNodeData | undefined)?.reason !== 'prior_success');
  const seen = new Set<string>(), intervals: { start: number; end: number }[] = [];
  const nodes = terminals.flatMap(e => {
    const d = e.data, identity = d?.invocation?.id && d.attempt?.id ? JSON.stringify([e.workflow_run_id ?? run.id, e.step_name, d.invocation.id, d.attempt.id]) : null;
    if (identity && seen.has(identity)) return [];
    if (identity) seen.add(identity);
    const duration = d?.timing?.durationMs, start = clock(d?.timing?.startedAt ?? d?.attempt?.startedAt ?? '');
    const measured = !!identity && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && Number.isFinite(start);
    if (measured) intervals.push({ start, end: start + duration });
    const candidate = timings.find(t => t.run === (e.workflow_run_id ?? run.id) && t.node === e.step_name && t.attempt_id === d?.attempt?.id);
    const timing = candidate?.invocation_id === d?.invocation?.id ? candidate : undefined;
    const missing = candidate && candidate.explore_ratio !== 'n/a' ? 'unknown' : providerMetricMissing(d);
    const node = e.step_name ?? 'unknown', milestone = node.replace(/^review-/, '').replace(/-r\d+$/, '');
    const packages = plan?.packages.filter(p => (p.milestone ?? 'm1') === milestone);
    const check = events.filter(x => x.step_name === `diff-${milestone}-r1` && x.event_type === 'node_completed').at(-1)?.data as (Event['data'] & { structured_output?: { risk?: string; out_of_scope?: string[] } }) | undefined;
    const triggers = node.startsWith('review-') ? [
      ...(packages?.some(p => p.risk === 'G2') ? ['plan G2'] : []), ...(plan?.mode === 'strict' ? ['strict'] : []),
      ...(packages?.some(p => p.review) ? ['review:true'] : []),
      ...(check?.structured_output?.risk === 'G2' && packages && !packages.some(p => p.risk === 'G2') ? ['runtime:other'] : [])] : [];
    return [{ node, type: node.split('-')[0], invocation: (d?.invocation?.id ?? '').length ? d?.invocation?.id : 'unknown', attempt: (d?.attempt?.id ?? '').length ? d?.attempt?.id : 'unknown', terminal: e.event_type,
      cumulative_ms: measured ? duration : 'unknown', cmds: timing?.cmds ?? missing, explore_ratio: timing?.explore_ratio ?? missing, mcp_calls: timing?.mcp_calls ?? missing, model_turns: timing?.model_turns ?? missing, think_gap_ms: timing?.think_gap_ms ?? missing,
      review_trigger: node.startsWith('review-') ? { reasons: triggers.length ? triggers : ['unknown'], glob: 'unknown', symlink: 'unknown', gitlink: 'unknown' } : undefined }];
  });
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.node, (counts.get(n.node) ?? 0) + 1);
  const union: typeof intervals = [];
  for (const i of intervals.sort((a,b) => a.start - b.start)) {
    const last = union.at(-1); if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else union.push({ ...i });
  }
  const waits = new Map<string, Event>(), holds: typeof intervals = [];
  let waitUnknown = false;
  for (const e of events) {
    const kind = e.event_type.startsWith('approval_') ? 'approval' : e.event_type.startsWith('wait_') ? 'wait' : null;
    if (!kind) continue;
    const key = JSON.stringify([kind, e.step_name]);
    if (['approval_requested', 'wait_started'].includes(e.event_type)) { if (waits.has(key)) waitUnknown = true; waits.set(key, e); }
    else if (['approval_received', 'wait_completed', 'wait_expired'].includes(e.event_type)) {
      const start = waits.get(key)?.created_at, end = e.created_at, duration = ms(start, end); if (duration === null || !start || !end) waitUnknown = true; else holds.push({ start: clock(start), end: clock(end) }); waits.delete(key);
    }
  }
  const holdUnion: typeof intervals = [];
  for (const i of holds.sort((a,b) => a.start - b.start)) {
    const last = holdUnion.at(-1); if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else holdUnion.push({ ...i });
  }
  const segments = path.status === 'measured' ? path.segments as { phase: string; ms: number }[] : null;
  const hold = segments ? segments.filter(s => s.phase === 'human_wait').reduce((sum,s) => sum + s.ms, 0) : !waitUnknown && !waits.size && holds.length ? holdUnion.reduce((sum,i) => sum + i.end - i.start, 0) : 'unknown';
  return { k1: run.started_at && Number.isFinite(clock(run.started_at)) ? (clock(run.started_at) < clock('2026-10-14T16:01:23+08:00') ? 'pre' : 'post') : 'unknown', status: run.status,
    cumulative_ms: nodes.length && nodes.every(n => typeof n.cumulative_ms === 'number') ? nodes.reduce((a,n) => a + Number(n.cumulative_ms), 0) : 'unknown',
    wall_clock_ms: intervals.some(i => i.start < clock(run.started_at ?? '') || i.end > clock(run.completed_at ?? '') + precisionOf(run.completed_at ?? undefined)) ? 'unknown' : ms(run.started_at ?? undefined, run.completed_at ?? undefined) ?? 'unknown', hold_ms: hold,
    idle_ms: segments ? segments.filter(s => s.phase === 'unclassified_wait').reduce((sum,s) => sum + s.ms, 0) : nodes.length && intervals.length === nodes.length && typeof hold === 'number' ? union.slice(1).reduce((sum,i,k) => sum + i.start - union[k].end - holdUnion.reduce((covered,h) => covered + Math.max(0, Math.min(i.start,h.end) - Math.max(union[k].end,h.start)), 0), 0) : 'unknown',
    nodes: nodes.map(n => ({ ...n, execution: n.attempt === 'unknown' || n.invocation === 'unknown' ? 'unknown' : (counts.get(n.node) ?? 0) > 1 ? 'multiple' : 'single' })) };
}

// Today is an operator-local calendar window; persisted SQL clocks remain UTC.
// prettier-ignore
export function metricsOf(rows: readonly BoardRow[], summary: Record<string, unknown>, now = Date.now(), unreadable = false) {
  unreadable ||= rows.some(r => r.state === 'unreadable' || r.stale);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = (at: number) => at >= start.getTime() && at <= now;
  const terminal = (r: BoardRow) => r.state === 'abandoned' || ['completed', 'failed', 'cancelled'].includes(r.nativeState ?? r.state) || r.state.startsWith('failed:');
  const end = (r: BoardRow) => r.completed_at ? clock(r.completed_at) : r.span?.ended_ms ?? NaN;
  const ended = rows.filter(r => terminal(r) && today(end(r)));
  const intervened = (r: BoardRow) => r.intervened === true || (r.interventions ?? 0) > 0;
  const achieved = ended.filter(r => r.state === 'completed' && r.landed && !intervened(r) && r.interventions === 0);
  return { completed: unreadable || ended.some(r => r.state === 'completed' && r.landed !== false && !intervened(r) && (r.landed === undefined || r.interventions === undefined)) ? 'unknown' : achieved.length, decided: unreadable || rows.some(r => terminal(r) && !Number.isFinite(end(r))) ? 'unknown' : ended.length,
    firstPass: unreadable || achieved.some(r => !r.engine || r.engine.firstPass === 'unknown') ? 'unknown' : achieved.filter(r => r.engine?.firstPass === true).length,
    firstPass_unknown: achieved.filter(r => !r.engine || r.engine.firstPass === 'unknown').length,
    asks: unreadable || rows.some(r => !r.engine) ? 'unknown' : rows.reduce((n,r) => n + (r.engine?.dispositions.filter(d => d.action === 'ask' && today(clock(d.at))).length ?? 0), 0),
    debt: typeof summary.debt === 'number' ? summary.debt : 'unknown' };
}
