// superagent report（F-22）：run 计数摘要 + 执行层用量台账。用量只来自 Archon 事件里的 spend/binding/timing，
// 未回执的用量记 unknown，从不当 0；不折算金额。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonJson, archonRunIds, getRun, tail } from './archon';
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
import { snapshotOf } from './board/data';
import { cockpit } from './board/cockpit';
import { Intake, intakeRoot } from './intake';
import type { Plan } from './plan';
import { readJobs, type Job } from './jobs';
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
import { capturedSourceRoots, DEFAULT_WORKFLOW_SOURCE_CONFIG } from '../../packages/workflows/src/workflow-source';

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
    identity_coverage: `${calls.filter(c => c.identity).length}/${calls.length}`,
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
        `${calls.filter(c => c[field as 'queue_ms' | 'exec_ms'] !== null).length}/${calls.length}`,
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
    if (deps.some(d => !rows.has(d) || rows.get(d)!.end > row.start - row.queue)) return false;
    const pred = [...deps].sort((a, b) => rows.get(b)!.end - rows.get(a)!.end)[0];
    if (pred && !walk(pred)) return false;
    path.push(id);
    return true;
  };
  const last = [...rows].sort((a, b) => b[1].end - a[1].end)[0]![0];
  if (!walk(last)) return unknown;
  let cursor = Date.parse(run.started_at!);
  const end = Date.parse(run.completed_at!);
  const segments: { phase: string; node?: string; ms: number }[] = [];
  for (const id of path) {
    const row = rows.get(id)!;
    if (row.start - row.queue < cursor || row.end > end) return unknown;
    segments.push({ phase: 'unclassified_wait', ms: row.start - row.queue - cursor }, { phase: 'queue', node: id, ms: row.queue }, { phase: nodes.get(id)?.wait ? 'human_wait' : (/^(code|review|repair|fix|verify)-/.exec(id)?.[1] ?? 'script'), node: id, ms: row.end - row.start, } );
    cursor = row.end;
  }
  segments.push({ phase: 'unclassified_wait', ms: end - cursor });
  return { status: 'measured', elapsed_ms: elapsed, path, segments, reconciled_ms: segments.reduce((s, r) => s + r.ms, 0), unclassified_wait: 'unknown_cause', };
}

// prettier-ignore
export function demandStats( pairs: Pair[], calls: Call[], sessions: UsageSession[] = [], jobs: Job[] = [], unreadable: Record<string, number> = {} ): Record<string, unknown> {
  const current_tasks = Object.fromEntries([...new Set(pairs.map(p => p.ledger.repo))].map(repo => {
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
  const sessionId = (provider: string, id: string) => `${provider}:${sessionKey(id)}`;
  const claims = new Map<string, Set<string>>();
  const claim = (provider: string, id: string, ref: string) => { const k = sessionId(provider, id); claims.set(k, (claims.get(k) ?? new Set()).add(ref)); };
  for (const [ref, attempts] of by) for (const c of calls)
    if (c.provider && c.session && attempts.some(p => p.ledger.run_id === c.run)) claim(c.provider, c.session, ref);
  for (const s of sessions) {
    if (s.owner?.request_ref) claim(s.client, s.id, s.owner.request_ref);
    for (const [ref, attempts] of by) if (s.owner?.kind === 'run' && attempts.some(p => p.ledger.run_id === s.owner?.run_id)) claim(s.client, s.id, ref);
  }
  for (const j of jobs) if (j.request_ref && j.session_id) claim(j.kind, j.session_id, j.request_ref);
  const disputed = (provider: string, id: string) => (claims.get(sessionId(provider, id))?.size ?? 0) > 1 || sessions.some(s => sessionId(s.client, s.id) === sessionId(provider, id) && s.owner?.conflict);
  const demands = Object.fromEntries(
    [...by].map(([ref, attempts]) => {
      const completion = attempts.map(({ ledger, run }) =>
        run instanceof Error ? null : requirementCoverage(ledger, run)
      );
      const complete = completion.some(
        c => c && Object.keys(c).length > 0 && Object.values(c).every(v => v.status === 'verified')
      );
      const own = calls.filter(c => attempts.some(p => p.ledger.run_id === c.run));
      const extra = sessions.filter(
        s => !disputed(s.client, s.id) && (s.owner?.kind === 'run' && (s.owner.request_ref === ref || attempts.some(p => p.ledger.run_id === s.owner?.run_id)) || own.some(c => c.provider === s.client && c.session && sessionKey(c.session) === sessionKey(s.id)))
      );
      const trusted = own.filter(c => !c.provider || !c.session || !disputed(c.provider, c.session));
      const conflicting = [...claims].some(([k, refs]) => refs.has(ref) && (refs.size > 1 || sessions.some(s => sessionId(s.client, s.id) === k && s.owner?.conflict)));
      // Jobs have an explicit demand ref but no verified provider-session receipt.
      const missing = Number(conflicting) + jobs.filter(j => j.request_ref === ref).length + sessions.filter(s => s.owner?.kind !== 'run' && (s.owner?.request_ref === ref || attempts.some(p => p.ledger.run_id === s.owner?.run_id)) && !jobs.some(j => j.request_ref === ref && j.id === s.owner?.job_id)).length + attempts.reduce((n, p) => n + Math.max(Number(p.run instanceof Error), unreadable[p.ledger.run_id] ?? 0), 0);
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
      coverage: `${durations.length}/${by.size}`,
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
    median: n ? (counts[Math.floor((n - 1) / 2)]! + counts[Math.floor(n / 2)]!) / 2 : 'unknown',
    max: counts.at(-1) ?? 'unknown',
    zero_share: n ? counts.filter(c => c === 0).length / n : 'unknown',
  };
}

/**
 * 全部登记 run：summarize 计数 + usage（总计、按 run / 里程碑 / 角色 / 第几次调用）。`--events` 的输出不带 nodes，
 * 所以当前代际 getRun 供 summarize，全部代际事件流供用量；事件查不到的代际记入 usage.unreadable，不吞错。
 */
export function buildReport(ls: Ledger[]): Record<string, unknown> {
  const jobs = readJobs(Date.now(), true);
  const receipts = jobs.jobs.map(jobReceipt);
  const calls: Call[] = [];
  const unreadable: string[] = [];
  const missingGenerations: Record<string, number> = {};
  const paths: Record<string, unknown> = {};
  const repo_missing = ls.filter(l => !existsSync(l.repo)).map(l => l.run_id);
  const cwdOf = (l: Ledger): string => (repo_missing.includes(l.run_id) ? WETAMP : l.repo);
  const pairs: Pair[] = ls.map(l => {
    try {
      return { ledger: l, run: getRun(l.archon_run_id, cwdOf(l)) };
    } catch (e) {
      return { ledger: l, run: e as Error };
    }
  });
  for (const l of ls) {
    const events: Event[] = [];
    for (const id of archonRunIds(l)) {
      try {
        const j = archonJson(['workflow', 'get', id, '--verbose', '--events'], cwdOf(l));
        const rows = (j.events ?? []) as Event[];
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
      } catch (e) {
        paths[`${l.run_id}/${id}`] = { status: 'unknown', reason: 'unreadable_generation' };
        missingGenerations[l.run_id] = (missingGenerations[l.run_id] ?? 0) + 1;
        unreadable.push(`${l.run_id}/${id}: ${tail((e as Error).message, 200)}`);
      }
    }
    calls.push(...callsOf(l.run_id, events, planOf(l)));
  }
  const snapshot = snapshotOf(pairs);
  // ccusage snapshots are cumulative per session. Never add one to its engine turn receipts.
  const sessions = readUsage();
  const engineSessions = new Set(
    calls.filter(c => c.provider && c.session).map(c => `${c.provider}:${sessionKey(c.session!)}`)
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
    metrics: cockpit(snapshot).metrics,
    interventions: interventionStats(ls),
    demands: { ...demandStats(pairs, calls, sessions.sessions.filter(s => !learning.includes(s)), jobs.jobs.filter(j => !j.title.startsWith('memory-reflect:')), missingGenerations), shared_learning: investmentOf([], learning, jobs.jobs.filter(j => j.title.startsWith('memory-reflect:') && !learning.some(s => s.owner?.job_id === j.id)).length) },
    critical_path: paths,
    jobs: {
      receipts,
      unreadable: jobs.bad,
      phase_coverage: Object.fromEntries(
        ['queue_ms', 'prepare_ms', 'exec_ms'].map(field => [
          field,
          `${receipts.filter(r => typeof r[field] === 'number').length}/${receipts.length}`,
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
      learning: { ...tokenTotals(learning.map(sessionTokens)), fees: tokenFees(learning.map(sessionTokens)), policy: snapshot.reflection ?? 'unknown',
        basis: 'explicit memory-reflect job tag; period only; no per-demand allocation' },
      window: { scope: 'all_retained_events_for_recorded_generations', generated_at: snapshot.at },
      receipts: calls.map(({ session: _session, ...receipt }) => receipt),
      total: rollup(calls),
      by_run: group(calls, c => c.run),
      by_milestone: group(calls, c => `${c.run}/${c.milestone}`),
      by_role: group(calls, c => c.role),
      by_attempt: group(calls, c => `attempt:${String(c.attempt)}`),
      unreadable,
    },
  };
}
