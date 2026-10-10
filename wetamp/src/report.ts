// superagent report（F-22）：run 计数摘要 + 执行层用量台账。用量只来自 Archon 事件里的 spend/binding/timing，
// 未回执的用量记 unknown，从不当 0；不折算金额。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonJson, getRun, tail } from './archon';
import { type Ledger, type Pair } from './cli';
import { snapshotOf } from './board/data';
import { cockpit } from './board/cockpit';
import type { Plan } from './plan';

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Tokens = Partial<Record<(typeof FIELDS)[number], number>>;
interface Event {
  event_type: string;
  step_name?: string | null;
  data?: {
    invocation?: { startedAt?: string };
    attempt?: { id?: string; startedAt?: string };
    binding?: {
      model?: { requested?: string; resolved?: { source: string; value?: string } };
      effort?: string;
    };
    timing?: { durationMs?: number };
    spend?: { tokens?: { source: string; value?: Tokens } };
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
  tokens: Tokens | null;
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

const ms = (a?: string, b?: string): number | null =>
  a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null;

export function callsOf(runId: string, events: Event[], plan: Plan | null): Call[] {
  const seen = new Map<string, number>();
  const out: Call[] = [];
  for (const e of events) {
    if (e.event_type !== 'node_completed' && e.event_type !== 'node_failed') continue;
    const [node, role, rest] = AI_NODE.exec(e.step_name ?? '') ?? [];
    if (!node || !role || !e.data?.attempt?.id || !e.data.binding?.model) continue;
    const n = (seen.get(node) ?? 0) + 1;
    seen.set(node, n);
    const t = e.data.spend?.tokens;
    out.push({
      run: runId,
      milestone: milestoneOf(role, rest, plan),
      role: role as Call['role'],
      node,
      attempt: n,
      model: modelOf(e),
      effort: e.data.binding.effort ?? null,
      tokens: t?.source === 'provider' && t.value ? t.value : null,
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
  const tokens = Object.fromEntries(
    FIELDS.map(f => {
      const vs = covered.map(c => c.tokens?.[f]).filter((v): v is number => typeof v === 'number');
      return [f, vs.length ? vs.reduce((a, b) => a + b, 0) : 'unknown'];
    })
  );
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
    models: tally(calls.map(c => c.model)),
    efforts: tally(calls.map(c => c.effort)),
    failures: tally(calls.map(c => c.failure)),
    infra_retries: calls.filter(c => c.attempt > 1).length,
    repair_rounds: new Set(
      calls.filter(c => c.role === 'repair' || c.role === 'fix').map(c => `${c.run}/${c.node}`)
    ).size,
    queue_ms: sum(calls.map(c => c.queue_ms)),
    exec_ms: sum(calls.map(c => c.exec_ms)),
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

/**
 * 全部登记 run：summarize 计数 + usage（总计、按 run / 里程碑 / 角色 / 第几次调用）。`--events` 的输出不带 nodes，
 * 所以每个 run 查两次：getRun 供 summarize，事件流供用量；事件查不到的 run 记入 usage.unreadable，不吞错。
 */
export function buildReport(ls: Ledger[]): Record<string, unknown> {
  const calls: Call[] = [];
  const unreadable: string[] = [];
  const pairs: Pair[] = ls.map(l => {
    try {
      return { ledger: l, run: getRun(l.archon_run_id, l.repo) };
    } catch (e) {
      return { ledger: l, run: e as Error };
    }
  });
  for (const l of ls) {
    try {
      const j = archonJson(['workflow', 'get', l.archon_run_id, '--verbose', '--events'], l.repo);
      calls.push(...callsOf(l.run_id, (j.events ?? []) as Event[], planOf(l)));
    } catch (e) {
      unreadable.push(`${l.run_id}: ${tail((e as Error).message, 200)}`);
    }
  }
  const snapshot = snapshotOf(pairs);
  return {
    ...snapshot.summary,
    metrics: cockpit(snapshot).metrics,
    usage: {
      total: rollup(calls),
      by_run: group(calls, c => c.run),
      by_milestone: group(calls, c => `${c.run}/${c.milestone}`),
      by_role: group(calls, c => c.role),
      by_attempt: group(calls, c => `attempt:${String(c.attempt)}`),
      unreadable,
    },
  };
}
