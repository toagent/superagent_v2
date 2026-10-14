// superagent report（F-22）：run 计数摘要 + 执行层用量台账。用量只来自 Archon 事件里的 spend/binding/timing，
// 未回执的用量记 unknown，从不当 0；不折算金额。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonJson, archonRunIds, getRun, tail, reportRuns } from './archon';
import { readNodeRecordEvent } from '../../packages/workflows/src/node-record-reader';
import { home, WETAMP } from './config';
import {
  type Ledger,
  type Pair,
  artifactsOf,
  evidenceJson,
  evidenceGates,
  decisionOf,
  intakeEvidence,
  summarize,
} from './cli';
import { Intake, intakeRoot } from './intake';
import type { Plan } from './plan';
import { readJobs, type Job } from './jobs';
import { providerTiming, slowNodes } from './provider-timing';
import {
  normalizeTokens,
  investmentOf,
  tokenTotals,
  tokenFees,
  sessionTokens,
  sessionKey,
  readUsage,
  type ReportTokens,
  type UsageSession,
} from './usage';
import type { SerializedNodeData } from '../../packages/workflows/src/node-record-serialization';
import type { RunView } from './archon';
import { workflowSourceMetadataSchema } from '../../packages/workflows/src/schemas/workflow-run';
import {
  capturedSourceRoots,
  DEFAULT_WORKFLOW_SOURCE_CONFIG,
} from '../../packages/workflows/src/workflow-source';

/** Only project engine decisions; green commands and model reports are not coverage. */
export function requirementCoverage(l: Ledger, run: Parameters<typeof artifactsOf>[0]) {
  const art = artifactsOf(run);
  const gates = evidenceGates(l, art);
  return Object.fromEntries(
    (planOf(l)?.packages ?? []).map(p => {
      const gate = gates.filter(f => f.startsWith(`gate-${p.milestone ?? 'm1'}-r`)).at(-1);
      const value = gate
        ? evidenceJson(l, art, gate)
        : (evidenceJson(l, art, `settle-${p.id}.json`) ??
          evidenceJson(l, art, `verify-${p.id}.json`));
      return [p.id, decisionOf(value)?.requirements ?? { status: 'legacy', items: [] }];
    })
  );
}
interface Event {
  workflow_run_id?: string;
  created_at?: string;
  event_type: string;
  step_name?: string | null;
  data?: {
    invocation?: {
      id?: string;
      startedAt?: string;
      loopPath?: NonNullable<SerializedNodeData['invocation']>['loopPath'];
    };
    attempt?: { id?: string; startedAt?: string };
    binding?: {
      provider?: string;
      model?: { requested?: string; resolved?: { source: string; value?: string } };
      effort?: string;
    };
    timing?: { durationMs?: number; startedAt?: string };
    spend?: {
      tokens?: { source: string; value?: ReportTokens };
      costUsd?: NonNullable<SerializedNodeData['spend']>['costUsd'];
    };
    session_id?: string;
    provider?: string;
    provider_failure?: { class?: string };
    failure_kind?: string;
  };
}
/** 一次 AI 节点调用（node_completed/node_failed 各一条；条件跳过与 resume 沿用的 prior_success 不算调用）。 */
export interface Call {
  run: string;
  milestone: string;
  role: 'code' | 'repair' | 'fix' | 'review';
  node: string;
  /** 同一节点的第几次调用：>1 即基础设施重试或 recover 后重跑 */
  attempt: number;
  model: string;
  effort: string | null;
  tokens: ReportTokens | null;
  raw: ReportTokens | null;
  provider: string | null;
  session: string | null;
  identity: string | null;
  failure: string | null;
  queue_ms: number | null;
  exec_ms: number | null;
}

const AI_NODE = /^(code|repair|fix|review)-(.+)$/;

/** 节点所属里程碑：code/repair-<pkg> 按 plan 快照的 milestone（缺省 m1）；fix/review-<m>-r<n> 取 <m>。 */
function milestoneOf(role: string, rest: string, plan: Plan | null): string {
  if (role === 'fix' || role === 'review') return rest.replace(/-r\d+$/, '');
  const p = plan?.packages.find(k => k.id === rest);
  return p ? (p.milestone ?? 'm1') : '?';
}

/** 实际模型：provider 回执的名字；只有请求名（Codex 不回执）记 `<请求名>(pinned)`；都没有记 unknown。 */
function modelOf(e: Event): string {
  const m = e.data?.binding?.model;
  if (m?.resolved?.source === 'provider' && m.resolved.value) return m.resolved.value;
  return m?.requested ? `${m.requested}(pinned)` : 'unknown';
}

const ms = (a?: string, b?: string): number | null => {
  const delta = a && b ? Date.parse(b) - Date.parse(a) : NaN;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
};

/** No prompt, argv or session body; policy is the resolved execution owner receipt. */
export function jobReceipt(j: Job): Record<string, unknown> {
  const r = j.receipt;
  return {
    id: j.id,
    role: j.role ?? 'unknown',
    state: j.state,
    policy: j.execution ?? 'unknown',
    context_ref: j.card ?? 'unknown',
    phases: r ?? 'unknown',
    queue_ms: ms(r?.enqueued_at, r?.admitted_at) ?? 'unknown',
    prepare_ms: ms(r?.admitted_at, r?.spawned_at) ?? 'unknown',
    exec_ms: ms(r?.spawned_at, r?.settled_at) ?? 'unknown',
    context_bytes: 'unknown',
    first_token_ms: 'unknown',
    model_calls: 'unknown',
    tool_calls: 'unknown',
    provider_timing: 'unknown',
  };
}

export function callsOf(runId: string, events: Event[], plan: Plan | null): Call[] {
  const seen = new Map<string, number>();
  const identities = new Set<string>();
  const out: Call[] = [];
  for (const e of events) {
    if (e.event_type !== 'node_completed' && e.event_type !== 'node_failed') continue;
    const [node, role, rest] = AI_NODE.exec(e.step_name ?? '') ?? [];
    if (!node || !role || !e.data?.attempt?.id || !e.data.binding?.model) continue;
    const identity = e.data.invocation?.id
      ? JSON.stringify([e.workflow_run_id ?? runId, e.data.invocation.id, e.data.attempt.id])
      : null;
    if (identity && identities.has(identity)) continue;
    if (identity) identities.add(identity);
    const n = (seen.get(node) ?? 0) + 1;
    seen.set(node, n);
    const t = e.data.spend?.tokens;
    const fee = e.data.spend?.costUsd;
    const raw =
      t?.source === 'provider' && t.value
        ? { ...t.value, ...(fee?.source === 'provider' ? { cost: fee.value } : {}) }
        : null;
    out.push({
      run: runId,
      milestone: milestoneOf(role, rest, plan),
      role: role as Call['role'],
      node,
      attempt: n,
      model: modelOf(e),
      effort: e.data.binding.effort ?? null,
      tokens: raw ? normalizeTokens(raw) : null,
      raw,
      provider: e.data.binding.provider ?? e.data.provider ?? null,
      session: e.data.session_id ?? null,
      identity,
      failure:
        e.event_type === 'node_failed'
          ? (e.data.provider_failure?.class ?? e.data.failure_kind ?? 'unknown')
          : null,
      queue_ms: ms(e.data.invocation?.startedAt, e.data.attempt.startedAt),
      exec_ms: e.data.timing?.durationMs ?? null,
    });
  }
  return out;
}

/**
 * 一组调用的合计。tokens 各字段只加有回执的调用，一个都没有就是 'unknown'；coverage = 有回执调用/总调用，
 * <1 时合计是下界。infra_retries = attempt>1 的调用数；repair_rounds = 实际跑过的 repair/fix 节点数。
 */
export function rollup(calls: Call[]): Record<string, unknown> {
  const covered = calls.filter(c => c.tokens);
  const tokens = tokenTotals(covered.flatMap(c => (c.tokens ? [c.tokens] : [])));
  const tally = (xs: (string | null)[]): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const x of xs) if (x) o[x] = (o[x] ?? 0) + 1;
    return o;
  };
  const sum = (xs: (number | null)[]): number | 'unknown' =>
    xs.some(x => x !== null) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : 'unknown';
  return {
    calls: calls.length,
    coverage: `${String(covered.length)}/${String(calls.length)}`,
    ...tokens,
    raw: tokenTotals(covered.flatMap(c => (c.raw ? [c.raw] : []))),
    providers: tally(calls.map(c => c.provider ?? 'unknown')),
    identity_coverage: `${String(calls.filter(c => c.identity).length)}/${String(calls.length)}`,
    models: tally(calls.map(c => c.model)),
    efforts: tally(calls.map(c => c.effort)),
    failures: tally(calls.map(c => c.failure)),
    infra_retries: calls.filter(c => c.attempt > 1).length,
    repair_rounds: new Set(
      calls.filter(c => c.role === 'repair' || c.role === 'fix').map(c => `${c.run}/${c.node}`)
    ).size,
    queue_ms: sum(calls.map(c => c.queue_ms)),
    exec_ms: sum(calls.map(c => c.exec_ms)),
    phase_coverage: Object.fromEntries(
      ['queue_ms', 'exec_ms'].map(field => [
        field,
        `${String(calls.filter(c => c[field as 'queue_ms' | 'exec_ms'] !== null).length)}/${String(calls.length)}`,
      ])
    ),
  };
}

const group = (calls: Call[], key: (c: Call) => string): Record<string, unknown> => {
  const by = new Map<string, Call[]>();
  for (const c of calls) by.set(key(c), [...(by.get(key(c)) ?? []), c]);
  return Object.fromEntries(
    [...by].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, rollup(v)])
  );
};

function planOf(l: Ledger): Plan | null {
  try {
    return JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;
  } catch {
    // 旧 run 的 gen 目录可能已被 gc：包级节点的里程碑记 '?'，用量照常统计
    return null;
  }
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
    const start = Date.parse(
      skipped
        ? (e.created_at ?? '')
        : (e.data?.timing?.startedAt ?? e.data?.attempt?.startedAt ?? '')
    );
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
    if (deps.some(d => !rows.has(d) || (rows.get(d)?.end ?? Infinity) > row.start - row.queue)) return false;
    const pred = [...deps].sort((a, b) => (rows.get(b)?.end ?? 0) - (rows.get(a)?.end ?? 0))[0];
    if (pred && !walk(pred)) return false;
    path.push(id);
    return true;
  };
  const last = [...rows].sort((a, b) => b[1].end - a[1].end)[0]?.[0];
  if (!last || !walk(last)) return unknown;
  let cursor = Date.parse(run.started_at ?? '');
  const end = Date.parse(run.completed_at ?? '');
  const segments: { phase: string; node?: string; ms: number }[] = [];
  for (const id of path) {
    const row = rows.get(id);
    if (!row) return unknown;
    if (row.start - row.queue < cursor || row.end > end) return unknown;
    segments.push({ phase: 'unclassified_wait', ms: row.start - row.queue - cursor }, { phase: 'queue', node: id, ms: row.queue }, { phase: nodes.get(id)?.wait ? 'human_wait' : (/^(code|review|repair|fix|verify)-/.exec(id)?.[1] ?? 'script'), node: id, ms: row.end - row.start, } );
    cursor = row.end;
  }
  segments.push({ phase: 'unclassified_wait', ms: end - cursor });
  return { status: 'measured', elapsed_ms: elapsed, path, segments, reconciled_ms: segments.reduce((s, r) => s + r.ms, 0), unclassified_wait: 'unknown_cause', };
}

// prettier-ignore
export function demandStats( pairs: Pair[], calls: Call[], sessions: UsageSession[] = [], jobs: Job[] = [], unreadable: Record<string, number> = {} ): Record<string, unknown> {
  const current_tasks = Object.fromEntries<unknown>([...new Set(pairs.map(p => p.ledger.repo))].map(repo => {
    try {
      const root = intakeRoot(home().sa, repo);
      if (!existsSync(join(root, 'state.json'))) return [repo, 'unknown'];
      const view = new Intake(root).backlog(repo, intakeEvidence(repo));
      return [repo, { obligations: view.obligations, tasks: view.tasks.map(({ id, revision, requirements, completion, covered, reason, children }) => ({ id, revision, obligations: requirements.length, completion, covered, reason, children })) }];
    } catch { return [repo, 'unknown']; }
  }));
  const by = new Map<string, Pair[]>();
  const unknown: string[] = [];
  for (const pair of pairs) {
    const ref = planOf(pair.ledger)?.request_ref;
    if (typeof ref !== 'string' || !ref.trim()) {
      unknown.push(pair.ledger.run_id);
      continue;
    }
    by.set(ref, [...(by.get(ref) ?? []), pair]);
  }
  for (const ref of [...sessions.map(s => s.owner?.conflict ? undefined : s.owner?.request_ref), ...jobs.map(j => j.request_ref)])
    if (ref && !by.has(ref)) by.set(ref, []);
  const sessionKeys = new Map<string, string>();
  const sessionId = (provider: string, id: string) => { const key = `${provider}:${id}`, cached = sessionKeys.get(key); if (cached !== undefined) return cached; const value = `${provider}:${sessionKey(id)}`; sessionKeys.set(key, value); return value; };
  const claims = new Map<string, Set<string>>();
  const claim = (provider: string, id: string, ref: string) => { const k = sessionId(provider, id); claims.set(k, (claims.get(k) ?? new Set()).add(ref)); };
  for (const [ref, attempts] of by) for (const c of calls)
    if (c.provider && c.session && attempts.some(p => p.ledger.run_id === c.run)) claim(c.provider, c.session, ref);
  const refsByRun = new Map<string, string>();
  for (const [ref, attempts] of by) for (const p of attempts) refsByRun.set(p.ledger.run_id, ref);
  const sessionIndex = new Map<string, UsageSession[]>();
  for (const s of sessions) {
    if (s.owner?.request_ref) claim(s.client, s.id, s.owner.request_ref);
    const ref = s.owner?.kind === 'run' && s.owner.run_id ? refsByRun.get(s.owner.run_id) : undefined;
    if (ref) claim(s.client, s.id, ref);
    for (const key of [s.owner?.request_ref && `ref:${s.owner.request_ref}`, s.owner?.run_id && `run:${s.owner.run_id}`, `session:${sessionId(s.client, s.id)}`]) {
      if (key) { const rows = sessionIndex.get(key) ?? []; rows.push(s); sessionIndex.set(key, rows); }
    }
  }
  for (const j of jobs) if (j.request_ref && j.session_id) claim(j.kind, j.session_id, j.request_ref);
  const conflicts = new Set(sessions.filter(s => s.owner?.conflict).map(s => sessionId(s.client, s.id)));
  const disputed = (provider: string, id: string) => (claims.get(sessionId(provider, id))?.size ?? 0) > 1 || conflicts.has(sessionId(provider, id));
  const demands = Object.fromEntries(
    [...by].map(([ref, attempts]) => {
      const completion = attempts.map(({ ledger, run }) =>
        run instanceof Error ? null : requirementCoverage(ledger, run)
      );
      const complete = completion.some(
        c => c && Object.keys(c).length > 0 && Object.values(c).every(v => v.status === 'verified')
      );
      const runIds = new Set(attempts.map(p => p.ledger.run_id));
      const own = calls.filter(c => runIds.has(c.run));
      const ownedSessions = new Set(own.flatMap(c => c.provider && c.session ? [sessionId(c.provider, c.session)] : []));
      const candidates = [...new Set([`ref:${ref}`, ...[...runIds].map(id => `run:${id}`), ...[...ownedSessions].map(id => `session:${id}`)].flatMap(key => sessionIndex.get(key) ?? []))];
      const extra = candidates.filter(
        s => !disputed(s.client, s.id) && (s.owner?.kind === 'run' && (s.owner.request_ref === ref || (!!s.owner.run_id && runIds.has(s.owner.run_id))) || ownedSessions.has(sessionId(s.client, s.id)))
      );
      const trusted = own.filter(c => !c.provider || !c.session || !disputed(c.provider, c.session));
      const conflicting = [...claims].some(([k, refs]) => refs.has(ref) && (refs.size > 1 || conflicts.has(k)));
      // Jobs have an explicit demand ref but no verified provider-session receipt.
      const missing = Number(conflicting) + jobs.filter(j => j.request_ref === ref).length + candidates.filter(s => s.owner?.kind !== 'run' && (s.owner?.request_ref === ref || (!!s.owner?.run_id && runIds.has(s.owner.run_id))) && !jobs.some(j => j.request_ref === ref && j.id === s.owner?.job_id)).length + attempts.reduce((n, p) => n + Math.max(Number(p.run instanceof Error), unreadable[p.ledger.run_id] ?? 0), 0);
      const starts = attempts.map(p => Date.parse(p.ledger.started_at));
      const ends = attempts.map(p =>
        p.run instanceof Error ? NaN : Date.parse(p.run.completed_at ?? '')
      );
      const elapsed = [...starts, ...ends].every(Number.isFinite)
        ? Math.max(...ends) - Math.min(...starts)
        : NaN;
      return [ref, { attempts: attempts.map(({ ledger, run }) => ({ run: ledger.run_id, status: run instanceof Error ? 'unknown' : run.status, })), completion, complete: complete ? true : completion.length > 0 && completion.every(c => c && Object.values(c).some(v => v.status === 'unmet')) ? false : 'unknown', elapsed_ms: elapsed >= 0 ? elapsed : 'unknown', investment: { ...rollup(own), ...investmentOf(trusted, extra, missing) }, }, ];
    })
  );
  const durations = Object.values(demands)
    .map(d => d.elapsed_ms)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  return {
    current_tasks,
    unattributed: { ...investmentOf([], sessions.filter(s => disputed(s.client, s.id) || s.owner?.kind !== 'run' || !s.owner.request_ref && ![...by.values()].some(ps => ps.some(p => p.ledger.run_id === s.owner?.run_id)))), attribution: 'unknown' },
    denominator: by.size,
    completed: Object.values(demands).filter(d => d.complete === true).length,
    unknown_runs: unknown,
    by_request: demands,
    elapsed: {
      coverage: `${String(durations.length)}/${String(by.size)}`,
      p50_ms: durations[Math.ceil(durations.length * 0.5) - 1] ?? 'unknown',
      p90_ms: durations[Math.ceil(durations.length * 0.9) - 1] ?? 'unknown',
    },
  };
}
export function interventionStats(ls: Ledger[]): Record<string, unknown> {
  const by_run = Object.fromEntries(
    ls.map(l => [l.run_id, l.intervention_events?.length ?? 'unknown'])
  );
  const counts = Object.values(by_run)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const n = counts.length;
  return {
    by_run,
    known: n,
    unknown: ls.length - n,
    median: n ? (counts[Math.floor((n - 1) / 2)] + counts[Math.floor(n / 2)]) / 2 : 'unknown',
    max: counts.at(-1) ?? 'unknown',
    zero_share: n ? counts.filter(c => c === 0).length / n : 'unknown',
  };
}

/** Cumulative sums explicit attempt receipts, never min-start/max-end pairing.
 * Critical wall clock is the run lifecycle (parallel work counted once), not engine overhead.
 * Hold is only engine-recorded wait/approval pairs; idle is uncovered inter-node time.
 * Missing wait history cannot prove zero holds; external dispatch is outside this boundary. */
// prettier-ignore
export function measurementOf(run: RunView, events: Event[], plan: Plan | null, timings: ReturnType<typeof providerTiming> = providerTiming(run.id, events)) {
  const terminals = events.filter(e => ['node_completed', 'node_failed'].includes(e.event_type) && (e.data as SerializedNodeData | undefined)?.reason !== 'prior_success');
  const seen = new Set<string>(), intervals: { start: number; end: number }[] = [];
  const nodes = terminals.flatMap(e => {
    const d = e.data, identity = d?.invocation?.id && d.attempt?.id ? JSON.stringify([e.workflow_run_id ?? run.id, e.step_name, d.invocation.id, d.attempt.id]) : null;
    if (identity && seen.has(identity)) return [];
    if (identity) seen.add(identity);
    const duration = d?.timing?.durationMs, start = Date.parse(d?.timing?.startedAt ?? d?.attempt?.startedAt ?? '');
    const measured = !!identity && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && Number.isFinite(start);
    if (measured) intervals.push({ start, end: start + duration });
    const timing = timings.find(t => t.run === (e.workflow_run_id ?? run.id) && t.node === e.step_name && t.attempt_id === d?.attempt?.id && t.invocation_id === d.invocation?.id);
    const node = e.step_name ?? 'unknown', milestone = node.replace(/^review-/, '').replace(/-r\d+$/, '');
    const packages = plan?.packages.filter(p => (p.milestone ?? 'm1') === milestone);
    const check = events.filter(x => x.step_name === `diff-${milestone}-r1` && x.event_type === 'node_completed').at(-1)?.data as (Event['data'] & { structured_output?: { risk?: string; out_of_scope?: string[] } }) | undefined;
    const triggers = node.startsWith('review-') ? [
      ...(packages?.some(p => p.risk === 'G2') ? ['plan G2'] : []), ...(plan?.mode === 'strict' ? ['strict'] : []),
      ...(packages?.some(p => p.review) ? ['review:true'] : []),
      ...(check?.structured_output?.risk === 'G2' && packages && !packages.some(p => p.risk === 'G2') ? [check.structured_output.out_of_scope?.length ? 'runtime:out_of_scope' : 'runtime:other'] : [])] : [];
    return [{ node, type: node.split('-')[0], invocation: (d?.invocation?.id ?? '').length ? d?.invocation?.id : 'unknown', attempt: (d?.attempt?.id ?? '').length ? d?.attempt?.id : 'unknown', terminal: e.event_type,
      cumulative_ms: measured ? duration : 'unknown', cmds: timing?.cmds ?? 'unknown', explore_ratio: timing?.explore_ratio ?? 'unknown', mcp_calls: timing?.mcp_calls ?? 'unknown', model_turns: timing?.model_turns ?? 'unknown', think_gap_ms: timing?.think_gap_ms ?? 'unknown',
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
      const start = waits.get(key)?.created_at, end = e.created_at, duration = ms(start, end); if (duration === null || !start || !end) waitUnknown = true; else holds.push({ start: Date.parse(start), end: Date.parse(end) }); waits.delete(key);
    }
  }
  const holdUnion: typeof intervals = [];
  for (const i of holds.sort((a,b) => a.start - b.start)) {
    const last = holdUnion.at(-1); if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else holdUnion.push({ ...i });
  }
  const hold = !waitUnknown && !waits.size && holds.length ? holdUnion.reduce((sum,i) => sum + i.end - i.start, 0) : 'unknown';
  return { k1: run.started_at && Number.isFinite(Date.parse(run.started_at)) ? (Date.parse(run.started_at) < Date.parse('2026-10-14T16:01:23+08:00') ? 'pre' : 'post') : 'unknown', status: run.status,
    cumulative_ms: nodes.length && nodes.every(n => typeof n.cumulative_ms === 'number') ? nodes.reduce((a,n) => a + Number(n.cumulative_ms), 0) : 'unknown',
    critical_path_ms: intervals.some(i => i.start < Date.parse(run.started_at ?? '') || i.end > Date.parse(run.completed_at ?? '')) ? 'unknown' : ms(run.started_at ?? undefined, run.completed_at ?? undefined) ?? 'unknown', hold_ms: hold,
    idle_ms: nodes.length && intervals.length === nodes.length && typeof hold === 'number' ? union.slice(1).reduce((sum,i,k) => sum + i.start - union[k].end - holdUnion.reduce((covered,h) => covered + Math.max(0, Math.min(i.start,h.end) - Math.max(union[k].end,h.start)), 0), 0) : 'unknown',
    nodes: nodes.map(n => ({ ...n, execution: n.attempt === 'unknown' || n.invocation === 'unknown' ? 'unknown' : (counts.get(n.node) ?? 0) > 1 ? 'multiple' : 'single' })) };
}

/**
 * 全部登记 run：summarize 计数 + usage（总计、按 run / 里程碑 / 角色 / 第几次调用）。`--events` 的输出不带 nodes，
 * 所以当前代际 getRun 供 summarize，全部代际事件流供用量；事件查不到的代际记入 usage.unreadable，不吞错。
 */
// prettier-ignore
export function buildReport(ls: Ledger[]): Record<string, unknown> {
  const flag = process.argv.find(a => a.startsWith('--since='))?.slice(8) ?? process.argv[process.argv.indexOf('--since') + 1];
  const since = process.argv.some(a => a === '--since' || a.startsWith('--since=')) ? (/^\d{8}$/.test(flag) ? `${flag.slice(0,4)}-${flag.slice(4,6)}-${flag.slice(6,8)}T00:00:00.000Z` : flag) : '';
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('--since must be YYYYMMDD or an ISO timestamp');
  const batch = process.env.SA_ARCHON_BIN && process.env.SA_ARCHON_BIN !== '' ? null : reportRuns(since, '9999-12-31T23:59:59.999Z');
  if (batch && since) ls = ls.filter(l => archonRunIds(l).some(id => batch.has(id)));
  const views = new Map<string, RunView & { events: Event[] }>();
  const view = (id: string) => {
    const cached = views.get(id); if (cached) return cached;
    const run = batch?.get(id);
    if (!run) throw new Error(`run ${id} outside report window or missing`);
    const nodes = new Map<string, NonNullable<RunView['nodes']>[number]>();
    for (const e of run.events) {
      const record = readNodeRecordEvent(e);
      if (!record) continue;
      const state = ({ node_started: 'running', node_suspended: 'running', node_completed: 'completed', node_failed: 'failed', node_skipped: 'skipped', node_skipped_prior_success: 'completed', node_always_run_reset: 'pending', node_prior_cache_invalidated: 'pending' } as Record<string, string>)[e.event_type];
      if (state) nodes.set(record.path, { nodeId: record.path, state, execution: record.metadata, durationMs: record.metadata?.timing.durationMs, error: record.data.error });
    }
    const result = { ...run, nodes: [...nodes.values()] }; views.set(id, result); return result;
  };
  const jobs = readJobs(Date.now(), true);
  const receipts = jobs.jobs.map(jobReceipt);
  const calls: Call[] = [];
  const unreadable: string[] = [];
  const missingGenerations: Record<string, number> = {};
  const paths: Record<string, unknown> = {};
  const timings: Record<string, unknown> = {};
  const measurement: Record<string, unknown> = {};
  const attempts: ReturnType<typeof providerTiming> = [];
  const repo_missing = ls.filter(l => !existsSync(l.repo)).map(l => l.run_id);
  const cwdOf = (l: Ledger): string => (repo_missing.includes(l.run_id) ? WETAMP : l.repo);
  const pairs: Pair[] = ls.map(l => {
    try {
      return { ledger: l, run: batch ? view(l.archon_run_id) : getRun(l.archon_run_id, cwdOf(l)) };
    } catch (e) {
      return { ledger: l, run: e as Error };
    }
  });
  for (const l of ls) {
    const events: Event[] = [];
    for (const id of archonRunIds(l)) {
      try {
        const j = batch ? view(id) : archonJson(['workflow', 'get', id, '--verbose', '--events'], cwdOf(l));
        const rows = (j.events ?? []) as Event[];
        const timing = providerTiming(id, rows);
        timings[`${l.run_id}/${id}`] = timing;
        attempts.push(...timing);
        events.push(...rows.map(e => ({ ...e, workflow_run_id: e.workflow_run_id ?? id })));
        let graph;
        const source = workflowSourceMetadataSchema.safeParse(
          (j.metadata as Record<string, unknown> | undefined)?.workflow_source
        );
        try {
          const project = source.success ? capturedSourceRoots({ ...source.data, config: source.data.source_config ?? DEFAULT_WORKFLOW_SOURCE_CONFIG }).project : null;
          // prettier-ignore
          if (project) graph = (Bun.YAML.parse(readFileSync(join(project, '.archon/workflows', l.workflow, `${l.workflow}.yaml`), 'utf8')) as { nodes?: Parameters<typeof criticalPath>[2] }).nodes;
        } catch { /* Missing captured source leaves the path unknown. */ }
        paths[`${l.run_id}/${id}`] = criticalPath(j as unknown as RunView, rows, graph);
        measurement[`${l.run_id}/${id}`] = measurementOf(j as RunView, rows, planOf(l), timing);
      } catch (e) {
        timings[`${l.run_id}/${id}`] = 'unknown';
        paths[`${l.run_id}/${id}`] = { status: 'unknown', reason: 'unreadable_generation' };
        missingGenerations[l.run_id] = (missingGenerations[l.run_id] ?? 0) + 1;
        unreadable.push(`${l.run_id}/${id}: ${tail((e as Error).message, 200)}`);
      }
    }
    calls.push(...callsOf(l.run_id, events, planOf(l)));
  }
  for (const [id, run] of batch ?? []) if (!Object.keys(measurement).some(k => k.endsWith(`/${id}`))) {
    const timing = providerTiming(id, run.events); timings[id] = timing; attempts.push(...timing);
    measurement[id] = measurementOf(run, run.events, null, timing);
  }
  const snapshot = { summary: summarize(pairs), at: new Date().toISOString(), reflection: 'unknown' };
  // ccusage snapshots are cumulative per session. Never add one to its engine turn receipts.
  const sessions = readUsage();
  const engineSessions = new Set(
    calls.flatMap(c => c.provider && c.session ? [`${c.provider}:${sessionKey(c.session)}`] : [])
  );
  const supplemental = sessions.sessions.filter(s => !engineSessions.has(`${s.client}:${s.id}`));
  const inputs = [
    ...calls.flatMap(c => (c.tokens ? [c.tokens] : [])),
    ...supplemental.map(sessionTokens),
  ];
  const dedupKnown = calls.every(c => c.provider && c.session && c.identity);
  const learning = supplemental.filter(
    s =>
      s.owner?.kind === 'job' &&
      jobs.jobs.some(j => j.id === s.owner?.job_id && j.title.startsWith('memory-reflect:'))
  );
  return {
    ...snapshot.summary,
    repo_missing,
    requirements: Object.fromEntries(
      pairs.map(({ ledger, run }) => [
        ledger.run_id,
        run instanceof Error ? 'unknown' : requirementCoverage(ledger, run),
      ])
    ),
    // Board-only metrics need live coordination/ancestry probes; this snapshot does not claim them.
    metrics: { completed: snapshot.summary['state:completed'] ?? 0, decided: 'unknown', firstPass: 'unknown', asks: 'unknown', debt: snapshot.summary.debt ?? 'unknown' },
    interventions: interventionStats(ls),
    demands: { ...demandStats(pairs, calls, sessions.sessions.filter(s => !learning.includes(s)), jobs.jobs.filter(j => !j.title.startsWith('memory-reflect:')), missingGenerations), shared_learning: investmentOf([], learning, jobs.jobs.filter(j => j.title.startsWith('memory-reflect:') && !learning.some(s => s.owner?.job_id === j.id)).length) },
    critical_path: paths,
    measurement,
    provider_timing: timings,
    slow_nodes: slowNodes(attempts),
    jobs: {
      receipts,
      unreadable: jobs.bad,
      phase_coverage: Object.fromEntries(
        ['queue_ms', 'prepare_ms', 'exec_ms'].map(field => [
          field,
          `${String(receipts.filter(r => typeof r[field] === 'number').length)}/${String(receipts.length)}`,
        ])
      ),
    },
    usage: {
      // prettier-ignore
      investment: { ...tokenTotals(dedupKnown ? inputs : []), fees: dedupKnown ? tokenFees(inputs) : 'unknown', deduplication: dedupKnown ? 'covered' : 'unknown' },
      // prettier-ignore
      supplemental: { status: sessions.status, investment: tokenTotals(supplemental.map(sessionTokens)),
        raw: tokenTotals(supplemental.map(s => ({ input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite }))),
        attribution: 'explicit run owner only; other sessions unknown', overlap_excluded: sessions.sessions.length - supplemental.length },
      // prettier-ignore
      learning: { ...tokenTotals(learning.map(sessionTokens)), fees: tokenFees(learning.map(sessionTokens)), policy: snapshot.reflection,
        basis: 'explicit memory-reflect job tag; period only; no per-demand allocation' },
      window: { scope: 'all_retained_events_for_recorded_generations', generated_at: snapshot.at },
      receipts: calls.map(c => Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'session'))),
      total: rollup(calls),
      by_run: group(calls, c => c.run),
      by_milestone: group(calls, c => `${c.run}/${c.milestone}`),
      by_role: group(calls, c => c.role),
      by_attempt: group(calls, c => `attempt:${String(c.attempt)}`),
      unreadable,
    },
  };
}
