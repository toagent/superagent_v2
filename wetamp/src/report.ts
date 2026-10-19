import {
  cwdOf,
  interventionCount,
  clock,
  ms,
  planOf,
  criticalPath,
  measurementOf,
  metricsOf,
  firstPassOf,
} from './ledger-metrics';
export {
  clock,
  ms,
  planOf,
  criticalPath,
  firstPassOf,
  measurementOf,
  metricsOf,
} from './ledger-metrics';
import { snapshotOf } from './board/data';
import { decisionsFromSnapshot } from './decisions';
// superagent report（F-22）：run 计数摘要 + 执行层用量台账。用量只来自 Archon 事件里的 spend/binding/timing，
// 未回执的用量记 unknown，从不当 0；不折算金额。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { confined } from './board/workflow';
import { join } from 'node:path';
import { archonJson, archonRunIds, getRun, tail, reportRuns } from './archon';
import { buildNodeSummaries } from '../../packages/cli/src/commands/workflow';
import { home, WETAMP } from './config';
import {
  type Ledger,
  type Pair,
  artifactsOf,
  evidenceJson,
  evidenceGates,
  decisionOf,
  intakeEvidence,
} from './cli';
import { Intake, intakeRoot } from './intake';
import { type Plan } from './plan';
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
import { publishProjection } from './land';
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
export interface Event {
  workflow_run_id?: string;
  created_at?: string;
  event_type: string;
  step_name?: string | null;
  data?: {
    node?: SerializedNodeData['node'];
    type?: SerializedNodeData['type'];
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

/** Compact CLI projection; internal consumers keep the complete report contract. */
// prettier-ignore
export function reportSummary(report: Record<string, unknown>): Record<string, unknown> {
  const unknown_counts: Record<string, number> = {};
  const maps = new Set(['measurement', 'provider_timing', 'critical_path', 'requirements', 'by_run', 'by_milestone', 'by_role', 'by_attempt', 'by_request', 'current_tasks']);
  const count = (value: unknown, path: string, field = ''): void => {
    if (value === 'unknown') unknown_counts[path] = (unknown_counts[path] ?? 0) + 1;
    else if (Array.isArray(value)) value.forEach(v => { count(v, `${path}[]`); });
    else if (value && typeof value === 'object')
      for (const [key, v] of Object.entries(value)) count(v, path ? `${path}.${maps.has(field) ? '*' : key}` : key, key);
  };
  count(report, '');
  const usage = report.usage as Record<string, unknown>;
  const jobs = report.jobs as { unreadable: unknown[]; phase_coverage: unknown };
  const interventions = Object.fromEntries(Object.entries(report.interventions as Record<string, unknown>).filter(([k]) => k !== 'by_run'));
  const demands = report.demands as Record<string, unknown>;
  return {
    ...Object.fromEntries(Object.entries(report).filter(([, v]) => typeof v === 'number' || typeof v === 'string')),
    delivery: report.delivery, undelivered: report.undelivered,
    metrics: report.metrics, cancellations: report.cancellations, interventions,
    demands: { denominator: demands.denominator, completed: demands.completed, elapsed: demands.elapsed, unknown_runs: (demands.unknown_runs as unknown[]).length, by_request: demands.by_request, unattributed: demands.unattributed },
    usage: Object.fromEntries(['total', 'investment', 'supplemental', 'learning', 'window'].map(k => [k, usage[k]])),
    jobs: { phase_coverage: jobs.phase_coverage }, repo_missing: (report.repo_missing as unknown[]).length,
    ...(report.full_usage ? { full_usage: Object.fromEntries(Object.entries(report.full_usage as Record<string, unknown>).filter(([k]) => ['label', 'status', 'at', 'since', 'coverage', 'total'].includes(k))) } : {}),
    unknown_counts,
    unreadable: { runs: (report.unreadable as unknown[]).length, usage: (usage.unreadable as unknown[]).length, jobs: jobs.unreadable.length },
    next_steps: ['superagent report --full --json: inspect details and unreadable evidence', 'For missing AI measurements, inspect provider event capture; n/a is excluded from unknown counts'],
  };
}
/** 一次 AI attempt；started 与终态按身份合并，未终结时 failure/成本保持 unknown。 */
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
  const attempts = new Map<string, Event>();
  for (const e of events) {
    if (
      !['node_started', 'node_completed', 'node_failed'].includes(e.event_type) ||
      !e.data?.attempt?.id
    )
      continue;
    const key = JSON.stringify([
      e.workflow_run_id ?? runId,
      e.step_name,
      e.data.invocation?.id,
      e.data.attempt.id,
    ]);
    const prior = attempts.get(key);
    if (!prior || prior.event_type === 'node_started') attempts.set(key, e);
  }
  const out: Call[] = [];
  for (const e of attempts.values()) {
    const [node, role, rest] = AI_NODE.exec(e.step_name ?? '') ?? [];
    if (!node || !role || !e.data?.attempt?.id) continue;
    // Native node kind owns classification; legacy receipts only expose model binding.
    if (e.data.node ? e.data.node.kind !== 'agent' : !e.data.binding?.model) continue;
    const identity = e.data.invocation?.id
      ? JSON.stringify([e.workflow_run_id ?? runId, e.data.invocation.id, e.data.attempt.id])
      : null;
    const n = (seen.get(node) ?? 0) + 1;
    seen.set(node, n);
    const t = e.event_type === 'node_started' ? undefined : e.data.spend?.tokens;
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
      effort: e.data.binding?.effort ?? null,
      tokens: raw ? normalizeTokens(raw) : null,
      raw,
      provider: e.data.binding?.provider ?? e.data.provider ?? null,
      session: e.data.session_id ?? null,
      identity,
      failure:
        e.event_type === 'node_failed'
          ? (e.data.provider_failure?.class ?? e.data.failure_kind ?? 'unknown')
          : e.event_type === 'node_started'
            ? 'unknown'
            : null,
      queue_ms: ms(e.data.invocation?.startedAt, e.data.attempt.startedAt),
      exec_ms: e.event_type === 'node_started' ? null : (e.data.timing?.durationMs ?? null),
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

function capturedGraph(run: RunView, workflow: string): Parameters<typeof criticalPath>[2] {
  const source = workflowSourceMetadataSchema.safeParse(
    (run.metadata as Record<string, unknown> | undefined)?.workflow_source
  );
  if (!source.success) return undefined;
  try {
    const project = capturedSourceRoots({
      ...source.data,
      config: source.data.source_config ?? DEFAULT_WORKFLOW_SOURCE_CONFIG,
    }).project;
    if (project)
      return (
        Bun.YAML.parse(
          readFileSync(join(project, '.archon/workflows', workflow, `${workflow}.yaml`), 'utf8')
        ) as { nodes?: Parameters<typeof criticalPath>[2] }
      ).nodes;
  } catch {
    /* Missing frozen graph stays unknown. */
  }
  return undefined;
}

const REASON_RECORDING_SINCE = Date.parse('2026-10-11T17:56:55.000Z');
const missingReason = (at?: string | null): 'legacy' | 'unrecorded' =>
  at != null && Date.parse(at) < REASON_RECORDING_SINCE ? 'legacy' : 'unrecorded';

export function cancellationStats(pairs: Pair[]): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const { ledger, run } of pairs) {
    if (run instanceof Error || run.status !== 'cancelled') continue;
    const reason =
      ledger.intervention_events?.filter(e => e.action === 'cancel' && e.ok).at(-1)?.reason ??
      (ledger.reason === 'deadline'
        ? 'deadline'
        : ledger.rejected
          ? 'rejected'
          : missingReason(ledger.started_at));
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return reasons;
}

// prettier-ignore
export function demandStats( pairs: Pair[], calls: Call[], sessions: UsageSession[] = [], jobs: Job[] = [], unreadable: Record<string, number> = {}, evidenceFor: typeof intakeEvidence = intakeEvidence ): Record<string, unknown> {
  jobs = jobs.map(j => {
    const inferred = sessions.filter(
      s => s.client === j.kind && s.owner?.kind === 'inferred' && s.owner.job_id === j.id
    );
    return {
      ...j,
      request_ref: j.request_ref ?? 'plan-external',
      session_id: j.session_id ?? (inferred.length === 1 ? inferred[0].id : null),
    };
  });
  const allocatedJobs = new Set<UsageSession>();
  const allocated = new Set<UsageSession>();
  const current_tasks = Object.fromEntries<unknown>([...new Set(pairs.map(p => p.ledger.repo))].map(repo => {
    try {
      const root = intakeRoot(home().sa, repo);
      if (!existsSync(join(root, 'state.json'))) return [repo, 'unknown'];
      const view = new Intake(root).backlog(repo, evidenceFor(repo));
      return [repo, { obligations: view.obligations, tasks: view.tasks.map(({ id, revision, requirements, completion, covered, reason, children }) => ({ id, revision, obligations: requirements.length, completion, covered, reason, children })) }];
    } catch { return [repo, 'unknown']; }
  }));
  const by = new Map<string, Pair[]>();
  const unknown: string[] = [];
  for (const pair of pairs) {
    const ref = planOf(pair.ledger)?.request_ref;
    if (typeof ref !== 'string' || !ref.trim() || ref === 'plan-external') {
      unknown.push(pair.ledger.run_id);
      continue;
    }
    by.set(ref, [...(by.get(ref) ?? []), pair]);
  }
  for (const ref of [...sessions.map(s => s.owner?.conflict ? undefined : s.owner?.request_ref), ...jobs.map(j => j.request_ref)])
    if (ref?.trim() && ref !== 'plan-external' && !by.has(ref)) by.set(ref, []);
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
      const demandJobs = jobs.filter(j => j.request_ref === ref);
      const jobSessions = new Set(
        demandJobs.flatMap(j => j.session_id ? [sessionId(j.kind, j.session_id)] : [])
      );
      const candidates = [...new Set([`ref:${ref}`, ...[...runIds].map(id => `run:${id}`), ...[...ownedSessions, ...jobSessions].map(id => `session:${id}`)].flatMap(key => sessionIndex.get(key) ?? []))];
      const extra = candidates.filter(
        s => !disputed(s.client, s.id) && (s.owner?.kind === 'run' && (s.owner.request_ref === ref || (!!s.owner.run_id && runIds.has(s.owner.run_id))) || ownedSessions.has(sessionId(s.client, s.id)) || s.owner?.kind !== 'run' && jobSessions.has(sessionId(s.client, s.id)))
      );
      for (const s of extra) allocated.add(s);
      for (const s of extra)
        if (jobSessions.has(sessionId(s.client, s.id)) && s.owner?.kind !== 'run') allocatedJobs.add(s);
      const inferred = demandJobs.filter(j => j.session_id && !disputed(j.kind, j.session_id)).length;
      const attribution = { inferred, unknown: demandJobs.length - inferred };
      const trusted = own.filter(c => !c.provider || !c.session || !disputed(c.provider, c.session));
      const conflicting = [...claims].some(([k, refs]) => refs.has(ref) && (refs.size > 1 || conflicts.has(k)));
      // Job session ownership remains inferred; missing snapshots and engine overlap stay unknown.
      const missingJobs = demandJobs.filter(j => {
        const id = j.session_id;
        return !id || !extra.some(
          s => s.owner?.kind !== 'run' && sessionId(s.client, s.id) === sessionId(j.kind, id)
        );
      }).length;
      const missing = Number(conflicting) + missingJobs + candidates.filter(s => !allocatedJobs.has(s) && s.owner?.kind !== 'run' && (s.owner?.request_ref === ref || (!!s.owner?.run_id && runIds.has(s.owner.run_id))) && !jobs.some(j => j.request_ref === ref && j.id === s.owner?.job_id)).length + attempts.reduce((n, p) => n + Math.max(Number(p.run instanceof Error), unreadable[p.ledger.run_id] ?? 0), 0);
      const starts = attempts.map(p => clock(p.ledger.started_at));
      const ends = attempts.map(p =>
        p.run instanceof Error ? NaN : clock(p.run.completed_at ?? '')
      );
      const elapsed = [...starts, ...ends].every(Number.isFinite)
        ? Math.max(...ends) - Math.min(...starts)
        : NaN;
      return [ref, { attempts: attempts.map(({ ledger, run }) => ({ run: ledger.run_id, status: run instanceof Error ? 'unknown' : run.status, })), completion, complete: complete ? true : completion.length > 0 && completion.every(c => c && Object.values(c).some(v => v.status === 'unmet')) ? false : 'unknown', elapsed_ms: elapsed >= 0 ? elapsed : 'unknown', jobs: attribution, investment: { ...rollup(own), ...investmentOf(trusted, extra, missing) }, }, ];
    })
  );
  const durations = Object.values(demands)
    .map(d => d.elapsed_ms)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const unownedJobs = jobs.filter(j => !j.request_ref?.trim() || j.request_ref === 'plan-external');
  const unownedSessions = sessions.filter(s => !allocated.has(s));
  const missingUnowned = unownedJobs.filter(j => { const id = j.session_id; return !id || !unownedSessions.some(s => s.client === j.kind && sessionId(s.client, s.id) === sessionId(j.kind, id)); }).length;
  return {
    current_tasks,
    unattributed: { ...rollup(calls.filter(c => !refsByRun.has(c.run))), ...investmentOf(calls.filter(c => !refsByRun.has(c.run)), unownedSessions, missingUnowned), jobs: unownedJobs.length, attribution: 'unknown' },
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
/** Delivery receipts are independent of execution status; missing legacy evidence stays explicit. */
export function deliveryStats(pairs: Pair[]) {
  const counts: Record<string, number> = {};
  const undelivered: { run: string; repo: string; status: string; reason: string }[] = [];
  for (const { ledger: l, run } of pairs) {
    const receipt = l.delivery_result;
    const published = run instanceof Error ? undefined : publishProjection(l, run);
    const status = published?.status ?? receipt?.status ?? (l.delivery ? 'missing' : 'legacy');
    counts[status] = (counts[status] ?? 0) + 1;
    if (
      !(run instanceof Error) &&
      run.status === 'completed' &&
      !['integrated', 'published'].includes(status)
    )
      undelivered.push({
        run: l.run_id,
        repo: l.repo,
        status,
        reason:
          receipt && 'reason' in receipt
            ? receipt.reason.split(/\r?\n/)[0]
            : receipt
              ? 'delivery not integrated'
              : 'delivery receipt missing',
      });
  }
  return { delivery: counts, undelivered };
}

export function interventionStats(ls: Ledger[]): Record<string, unknown> {
  const by_run = Object.fromEntries(
    ls.map(l => [
      l.run_id,
      interventionCount(l) ?? (missingReason(l.started_at) === 'legacy' ? 'legacy' : 'unknown'),
    ])
  );
  const counts = Object.values(by_run)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const n = counts.length;
  return {
    by_run,
    known: n,
    legacy: Object.values(by_run).filter(v => v === 'legacy').length,
    unknown: Object.values(by_run).filter(v => v === 'unknown').length,
    median: n ? (counts[Math.floor((n - 1) / 2)] + counts[Math.floor(n / 2)]) / 2 : 'unknown',
    max: counts.at(-1) ?? 'unknown',
    zero_share: n ? counts.filter(c => c === 0).length / n : 'unknown',
  };
}

/**
 * 全部登记 run：summarize 计数 + usage（总计、按 run / 里程碑 / 角色 / 第几次调用）。`--events` 的输出不带 nodes，
 * 所以当前代际 getRun 供 summarize，全部代际事件流供用量；事件查不到的代际记入 usage.unreadable，不吞错。
 */
// prettier-ignore
export function buildReport(
  ls: Ledger[],
  engine?: { commit: string; baselineDays: number },
  options: { humanDecisions?: boolean } = {}
): Record<string, unknown> {
  const flag = process.argv.find(a => a.startsWith('--since='))?.slice(8) ?? process.argv[process.argv.indexOf('--since') + 1];
  const since = process.argv.some(a => a === '--since' || a.startsWith('--since=')) ? (/^\d{8}$/.test(flag) ? `${flag.slice(0,4)}-${flag.slice(4,6)}-${flag.slice(6,8)}T00:00:00.000Z` : flag) : '';
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('--since must be YYYYMMDD or an ISO timestamp');
  const decisionLedgers = ls;
  const batch = process.env.SA_ARCHON_BIN && process.env.SA_ARCHON_BIN !== '' ? null : reportRuns(since, '9999-12-31T23:59:59.999Z');
  const decisionBatch = options.humanDecisions && batch && since ? reportRuns('', '9999-12-31T23:59:59.999Z') : batch;
  if (batch && since) ls = ls.filter(l => archonRunIds(l).some(id => batch.has(id)));
  const views = new Map<string, RunView & { events: Event[] }>();
  const view = (id: string, source = batch) => {
    const cached = views.get(id); if (cached) return cached;
    const run = source?.get(id);
    if (!run) throw new Error(`run ${id} outside report window or missing`);
    const result = { ...run, nodes: buildNodeSummaries(run.events) }; views.set(id, result); return result;
  };
  const jobs = readJobs();
  const receipts = jobs.jobs.map(jobReceipt);
  const calls: Call[] = [];
  const unreadable: string[] = [];
  const missingGenerations: Record<string, number> = {};
  const paths: Record<string, unknown> = {};
  const timings: Record<string, unknown> = {};
  const measurement: Record<string, unknown> = {};
  const attempts: ReturnType<typeof providerTiming> = [];
  const repo_missing = ls.filter(l => !existsSync(l.repo)).map(l => l.run_id);
  const pairsOf = (ledgers: Ledger[], source: typeof batch): Pair[] => ledgers.map(l => {
    try {
      return { ledger: l, run: source ? view(l.archon_run_id, source) : getRun(l.archon_run_id, cwdOf(l)) };
    } catch (e) {
      return { ledger: l, run: e as Error };
    }
  });
  const pairs = pairsOf(ls, batch);
  const decisionPairs = options.humanDecisions
    ? decisionLedgers === ls && decisionBatch === batch
      ? pairs
      : pairsOf(decisionLedgers, decisionBatch)
    : [];
  const pairRuns = new Map(
    pairs.map(({ ledger, run }) => [JSON.stringify([ledger.repo, ledger.archon_run_id]), run])
  );
  const evidenceFor = (repo: string) =>
    intakeEvidence(repo, (id, cwd) => {
      const key = JSON.stringify([cwd, id]);
      if (!pairRuns.has(key)) return getRun(id, cwd);
      const run = pairRuns.get(key);
      if (run instanceof Error) throw run;
      if (!run) throw new Error(`run ${id} missing from report snapshot`);
      return run;
    });
  for (const l of ls) {
    const events: Event[] = [];
    const reportPlan = planOf(l) as {
      packages?: { accept?: { cmd: string }[] }[];
    } | null;
    const acceptCommands = reportPlan?.packages?.flatMap(p => p.accept?.map(c => c.cmd) ?? []) ?? [];
    for (const id of archonRunIds(l)) {
      try {
        const j = batch ? view(id) : archonJson(['workflow', 'get', id, '--verbose', '--events'], cwdOf(l));
        const rows = (j.events ?? []) as Event[];
        const timing = providerTiming(id, rows, acceptCommands);
        timings[`${l.run_id}/${id}`] = timing;
        attempts.push(...timing);
        events.push(...rows.map(e => ({ ...e, workflow_run_id: e.workflow_run_id ?? id })));
        const graph = capturedGraph(j as RunView, l.workflow);
        paths[`${l.run_id}/${id}`] = criticalPath(j as unknown as RunView, rows, graph);
        measurement[`${l.run_id}/${id}`] = measurementOf(j as RunView, rows, planOf(l), timing, graph, paths[`${l.run_id}/${id}`] as ReturnType<typeof criticalPath>);
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
    const graph = capturedGraph(run, run.workflow_name);
    paths[id] = criticalPath(run, run.events, graph);
    measurement[id] = measurementOf(run, run.events, null, timing, graph, paths[id] as ReturnType<typeof criticalPath>);
    calls.push(...callsOf(id, run.events, null));
  }
  const boardSnapshot = snapshotOf(pairs, Date.now(), { includeCoordination: false });
  const snapshot = {
    ...boardSnapshot,
    reflection: 'unknown' as const,
  };
  // ccusage snapshots are cumulative per session. Never add one to its engine turn receipts.
  const sessions = readUsage();
  const engineSessions = new Set(
    calls.flatMap(c => c.provider && c.session ? [`${c.provider}:${sessionKey(c.session)}`] : [])
  );
  const supplemental = sessions.sessions.filter(s => !engineSessions.has(`${s.client}:${s.id}`));
  // Per-attempt provider receipts are primary. Session snapshots have no turn watermark.
  const inputs = calls.flatMap(c => c.tokens ? [c.tokens] : []);
  const dedupKnown = calls.every(c => c.identity);
  const cancellations = cancellationStats(pairs);
  for (const [id, run] of batch ?? []) {
    if (run.status !== 'cancelled' || pairs.some(p => !(p.run instanceof Error) && p.run.id === id)) continue;
    let reason: string = missingReason(run.started_at);
    try {
      const receipt = JSON.parse(readFileSync(join(home().sa, 'cancellations', `${encodeURIComponent(id)}.json`), 'utf8')) as { reason?: string };
      if (typeof receipt.reason === 'string') reason = receipt.reason;
    } catch { /* No historical reason is inferred from provider errors or run titles. */ }
    cancellations[reason] = (cancellations[reason] ?? 0) + 1;
  }
  const learning = supplemental.filter(
    s =>
      s.owner?.kind === 'job' &&
      jobs.jobs.some(j => j.id === s.owner?.job_id && j.title.startsWith('memory-reflect:'))
  );
  const report = {
    ...snapshot.summary,
    ...(options.humanDecisions
      ? {
          human_decisions: decisionsFromSnapshot(
            decisionPairs === pairs
              ? boardSnapshot
              : snapshotOf(decisionPairs, Date.now(), { includeCoordination: false })
          ),
        }
      : {}),
    ...deliveryStats(pairs),
    repo_missing,
    requirements: Object.fromEntries(
      pairs.map(({ ledger, run }) => [
        ledger.run_id,
        run instanceof Error ? 'unknown' : requirementCoverage(ledger, run),
      ])
    ),
    metrics: metricsOf(snapshot.rows, snapshot.summary, Date.now()),
    cancellations,
    interventions: interventionStats(ls),
    demands: { ...demandStats(pairs, calls, sessions.sessions.filter(s => !learning.includes(s)), jobs.jobs.filter(j => !j.title.startsWith('memory-reflect:')), missingGenerations, evidenceFor), shared_learning: investmentOf([], learning, jobs.jobs.filter(j => j.title.startsWith('memory-reflect:') && !learning.some(s => s.owner?.job_id === j.id)).length) },
    critical_path: paths,
    measurement,
    provider_timing: timings,
    agent_ran_acceptance: attempts.reduce((sum, attempt) => sum + attempt.agent_ran_acceptance, 0),
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
      investment: { ...tokenTotals(dedupKnown ? inputs : []), fees: dedupKnown ? tokenFees(inputs) : 'unknown', deduplication: dedupKnown ? 'covered' : 'unknown', source: 'provider_attempt_receipts', coverage: `${String(inputs.length)}/${String(calls.length)}`, completeness: unreadable.length || inputs.length !== calls.length ? 'partial' : 'complete' },
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
  if (!engine) return report;
  const ancestry = new Map<string, boolean | 'unknown'>();
  const rows = pairs.map(pair => {
    const l = pair.ledger, run = pair.run, plan = planOf(l), ids = archonRunIds(l);
    const commit = l.engine_commit;
    if (commit && !ancestry.has(commit)) {
      const result = spawnSync('git', ['merge-base', '--is-ancestor', engine.commit, commit], { cwd: WETAMP, timeout: 5000 });
      ancestry.set(commit, result.status === 0 ? true : result.status === 1 ? false : 'unknown');
    }
    const timing = ids.flatMap(id => Array.isArray(timings[`${l.run_id}/${id}`]) ? timings[`${l.run_id}/${id}`] as ReturnType<typeof providerTiming> : []);
    const intervals = timing.flatMap(t =>
      typeof t.longest_silence_ms === 'number' && t.longest_silence_ms >= ENGINE_SILENCE_MS &&
      typeof t.longest_silence_closed_by === 'object' &&
      t.longest_silence_closed_by.type === 'warning' && t.longest_silence_closed_by.code === 'codex.will_retry'
      ? [{ start: clock(t.longest_silence_at), end: clock(t.longest_silence_at) + t.longest_silence_ms }] : []);
    const elapsed = run instanceof Error ? 'unknown' : ms(l.started_at, run.completed_at ?? undefined) ?? 'unknown';
    const completeTiming = ids.every(id => Array.isArray(timings[`${l.run_id}/${id}`])) && timing.length > 0 && timing.every(t => t.longest_silence_ms !== 'unknown');
    const union: typeof intervals = [];
    for (const i of intervals.sort((a, b) => a.start - b.start)) {
      const last = union.at(-1);
      if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else union.push({ ...i });
    }
    const silence = completeTiming ? union.reduce((sum, i) => sum + i.end - i.start, 0) : 'unknown';
    const usage = report.usage.by_run[l.run_id] as Record<string, unknown> | undefined;
    const tokens = usage && !missingGenerations[l.run_id] && typeof usage.calls === 'number' && usage.calls > 0 &&
      usage.coverage === `${String(usage.calls)}/${String(usage.calls)}` &&
      usage.identity_coverage === usage.coverage &&
      typeof usage.input === 'number' && typeof usage.output === 'number' ? usage.input + usage.output : 'unknown';
    let diff: number | 'unknown' = 'unknown';
    try {
      const patches = new Map<string, string>();
      for (const id of ids) {
        const v = batch ? view(id) : id === l.archon_run_id && !(run instanceof Error) ? run : getRun(id, cwdOf(l));
        if (!v.output_root) throw new Error('missing_artifacts');
        const art = confined(l, artifactsOf(v));
        if (!art) throw new Error('missing_artifacts');
        const files = readdirSync(art).filter(f => /^diff-.+\.json$/.test(f));
        if (!files.length) throw new Error('missing_diff');
        for (const file of files) {
          const meta = evidenceJson(l, art, file) as { delta?: string } | undefined;
          const path = meta?.delta && confined(l, meta.delta);
          if (!path) throw new Error('missing_delta');
          patches.set(file, path);
        }
      }
      let lines = 0;
      for (const patch of new Set(patches.values())) {
        const stat = spawnSync('git', ['apply', '--numstat', '--', patch], { encoding: 'utf8', timeout: 5000 });
        if (stat.status !== 0) throw new Error('numstat_failed');
        for (const line of stat.stdout.trim().split('\n').filter(Boolean)) {
          const [added, removed] = line.split('\t');
          if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw new Error('binary_diff');
          lines += Number(added) + Number(removed);
        }
      }
      diff = lines;
    } catch { /* Missing or binary deltas cannot be size matched. */ }
    return {
      id: l.run_id, repo: l.repo,
      risk: plan?.packages.map(p => p.risk).sort().at(-1) ?? 'unknown',
      started: clock(l.started_at), newer: commit ? ancestry.get(commit) ?? 'unknown' : 'unknown',
      status: run instanceof Error ? 'unknown' : run.status, elapsed,
      adjusted: typeof elapsed === 'number' && typeof silence === 'number' && silence <= elapsed ? elapsed - silence : 'unknown',
      tokens, first: firstPassOf(pair), diff, silence, disruptions: completeTiming ? intervals.length : 'unknown'
    } satisfies EngineRow;
  });
  return { engine_commit: engine.commit, baseline_days: engine.baselineDays, ...engineComparison(rows, engine.baselineDays) };
}

// Thresholds are the report --by-engine task card's decision policy, not runtime controls.
const ENGINE_MIN_COMPLETED = 15,
  ENGINE_IMPROVEMENT = 0.25,
  ENGINE_REGRESSION = 0.05,
  ENGINE_SILENCE_MS = 180_000;
type Measure = number | 'unknown';
export interface EngineRow {
  id: string;
  repo: string;
  risk: string;
  started: number;
  newer: boolean | 'unknown';
  status: string;
  elapsed: Measure;
  adjusted: Measure;
  tokens: Measure;
  first: boolean | 'unknown';
  diff: Measure;
  silence: Measure;
  disruptions: Measure;
}
const median = (values: Measure[]): Measure => {
  const xs = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  return xs.length
    ? (xs[Math.floor((xs.length - 1) / 2)] + xs[Math.floor(xs.length / 2)]) / 2
    : 'unknown';
};
export function engineComparison(rows: EngineRow[], baselineDays = 7) {
  const newer = rows.filter(r => r.newer === true),
    earliest = Math.min(...newer.map(r => r.started).filter(Number.isFinite));
  const older = rows.filter(
    r =>
      r.newer === false && r.started < earliest && r.started >= earliest - baselineDays * 86400000
  );
  const summary = (rs: EngineRow[]) => {
    const done = rs.filter(r => r.status === 'completed');
    const terminal = rs.filter(r => ['completed', 'failed', 'cancelled'].includes(r.status));
    const known = terminal.filter(r => r.first !== 'unknown');
    const sum = (field: 'silence' | 'disruptions' | 'tokens'): Measure =>
      rs.length && rs.every(r => typeof r[field] === 'number')
        ? rs.reduce((n, r) => n + Number(r[field]), 0)
        : 'unknown';
    return {
      runs: rs.length,
      completed: done.length,
      terminal: terminal.length,
      elapsed_ms: median(terminal.map(r => r.elapsed)),
      adjusted_ms: median(terminal.map(r => r.adjusted)),
      tokens:
        done.length && typeof sum('tokens') === 'number'
          ? Number(sum('tokens')) / done.length
          : ('unknown' as const),
      completion_rate: rs.length ? done.length / rs.length : ('unknown' as const),
      first_pass: known.length
        ? known.filter(r => r.first === true).length / known.length
        : ('unknown' as const),
      disruptions: sum('disruptions'),
      disruption_seconds:
        typeof sum('silence') === 'number' ? Number(sum('silence')) / 1000 : 'unknown',
      missing: Object.fromEntries(
        [
          'elapsed',
          'adjusted',
          'tokens',
          'first',
          'diff',
          'silence',
          'disruptions',
          'risk',
          'status',
        ].map(k => [k, rs.filter(r => r[k as keyof EngineRow] === 'unknown').length])
      ),
    };
  };
  const matched = (old: EngineRow[], fresh: EngineRow[]) => {
    const selected = new Map<string, EngineRow>(),
      chosen: EngineRow[] = [];
    for (const r of fresh.filter(r => r.status === 'completed')) {
      if (r.diff === 'unknown' || r.risk === 'unknown') continue;
      const size = r.diff;
      const distance = (o: EngineRow) => Math.abs(Math.log((Number(o.diff) + 1) / (size + 1)));
      const candidates = old
        .filter(
          o =>
            !selected.has(o.id) &&
            o.status === 'completed' &&
            o.repo === r.repo &&
            o.risk === r.risk &&
            typeof o.diff === 'number'
        )
        .sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))
        .slice(0, 3);
      if (candidates.length) chosen.push(r);
      candidates.forEach(o => selected.set(o.id, o));
    }
    return {
      old: summary([...selected.values()]),
      new: summary(chosen),
      unmatched: fresh.filter(r => r.status === 'completed').length - chosen.length,
    };
  };
  const size_matched = matched(older, newer),
    a = summary(older),
    b = summary(newer);
  const comparable = (x: Measure, y: Measure) => typeof x === 'number' && typeof y === 'number';
  const regressed = (x: Measure, y: Measure, higher: boolean) =>
    comparable(x, y) &&
    (higher
      ? Number(y) < Number(x) * (1 - ENGINE_REGRESSION)
      : Number(y) > Number(x) * (1 + ENGINE_REGRESSION));
  const verdict =
    a.completed < ENGINE_MIN_COMPLETED || b.completed < ENGINE_MIN_COMPLETED
      ? 'insufficient_sample'
      : regressed(a.elapsed_ms, b.elapsed_ms, false) ||
          regressed(a.completion_rate, b.completion_rate, true) ||
          regressed(a.tokens, b.tokens, false) ||
          regressed(a.first_pass, b.first_pass, true)
        ? 'regressed'
        : a.terminal === a.runs &&
            b.terminal === b.runs &&
            !a.missing.elapsed &&
            !b.missing.elapsed &&
            !a.missing.first &&
            !b.missing.first &&
            Number(b.completion_rate) >= Number(a.completion_rate) &&
            comparable(a.elapsed_ms, b.elapsed_ms) &&
            Number(a.elapsed_ms) > 0 &&
            Number(b.elapsed_ms) <= Number(a.elapsed_ms) * (1 - ENGINE_IMPROVEMENT) &&
            comparable(a.first_pass, b.first_pass) &&
            Number(b.first_pass) >= Number(a.first_pass) &&
            comparable(a.tokens, b.tokens) &&
            Number(b.tokens) <= Number(a.tokens)
          ? 'improved'
          : 'unproven';
  const compact = (s: ReturnType<typeof summary>) => ({
    completed: s.completed,
    tokens: s.tokens,
    adjusted_ms: s.adjusted_ms,
    first_pass: s.first_pass,
  });
  return {
    groups: { old: summary(older), new: summary(newer) },
    size_matched,
    verdict,
    excluded: {
      unknown_engine_commit: rows.filter(r => r.newer === 'unknown').length,
      outside_baseline: rows.filter(r => r.newer === false).length - older.length,
      invalid_started_at: rows.filter(r => !Number.isFinite(r.started)).length,
    },
    strata: [...new Set([...older, ...newer].map(r => JSON.stringify([r.repo, r.risk])))].map(
      key => {
        const [repo, risk] = JSON.parse(key) as string[];
        const m = matched(
          older.filter(r => r.repo === repo && r.risk === risk),
          newer.filter(r => r.repo === repo && r.risk === risk)
        );
        return { repo, risk, unmatched: m.unmatched, old: compact(m.old), new: compact(m.new) };
      }
    ),
  };
}
