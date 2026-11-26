import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DeliveryDecision } from '../templates/.archon/scripts/sa-check';
import { getRun, tail, type RunView } from './archon';
import type { Ledger } from './cli';
import {
  classifyRun,
  decisionOf,
  decisionVerdict,
  evidenceGates,
  ledgers,
  loadAsks,
  print,
} from './cli-classify';
import { WETAMP } from './config';
import type { Controller } from './coord';
import { canonicalRepo, debtMetrics, debtSnapshot } from './debt';
import type { DecisionInbox } from './decisions';
import { artifactsOf, evidenceJson } from './ledger';
// Reporting and memory consume CLI projections. Resolve them after module initialization.
const load = createRequire(import.meta.url);

export interface Retro {
  at: string;
  by: Controller;
  effect: string[];
  improve: string[];
  revision: number;
}

const retroItems = (values: string[] | undefined, name: string): string[] => {
  const items = values?.map(value => value.trim()) ?? [];
  if (items.length < 1 || items.length > 3) throw new Error(`--${name} requires 1-3 entries`);
  if (items.some(value => !value)) throw new Error(`--${name} entries must not be empty`);
  return items;
};

export function validateRetro(effect: string[] | undefined, improve: string[] | undefined) {
  const normalized = {
    effect: retroItems(effect, 'effect'),
    improve: retroItems(improve, 'improve'),
  };
  // User rule (2026-11-06): pros and cons are each limited to 200 Unicode code points.
  for (const name of ['effect', 'improve'] as const) {
    const length = normalized[name].reduce((n, value) => n + Array.from(value).length, 0);
    if (length > 200)
      throw new Error(`--${name} exceeds 200 characters by ${String(length - 200)}`);
  }
  return normalized;
}

export function applyRetro(
  ledger: Ledger,
  values: Pick<Retro, 'effect' | 'improve'>,
  by: Controller,
  terminal: boolean,
  at = new Date().toISOString()
): void {
  if (!terminal) throw new Error(`retro: run ${ledger.run_id} is not terminal`);
  const previous = ledger.retro;
  if (previous) ledger.retro_history = [...(ledger.retro_history ?? []), previous].slice(-5);
  ledger.retro = { at, by, ...values, revision: (previous?.revision ?? 0) + 1 };
}

export function retroHints(repo: string): { run_id: string; improve: string }[] {
  const { privateProject } = load('./memory') as typeof import('./memory');
  if (privateProject(repo)) return [];
  let canonical: string;
  try {
    canonical = canonicalRepo(repo);
  } catch {
    return [];
  }
  const recent = ledgers()
    .flatMap(value => {
      if ('error' in value || privateProject(value.repo)) return [];
      const retro = value.retro;
      if (!retro) return [];
      try {
        return canonicalRepo(value.repo) === canonical ? [{ run_id: value.run_id, retro }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.retro.at.localeCompare(a.retro.at))
    .slice(0, 5);
  const seen = new Set<string>(),
    hints: { run_id: string; improve: string }[] = [];
  for (const ledger of recent)
    for (const improve of ledger.retro.improve)
      if (!seen.has(improve) && hints.length < 3) {
        seen.add(improve);
        hints.push({ run_id: ledger.run_id, improve });
      }
  return hints;
}

export function retroCommand(
  updateLedger: (ledger: Ledger, f: (cur: Ledger) => void) => void,
  l: Ledger,
  effect?: string[],
  improve?: string[],
  by?: Controller
): number {
  if (effect === undefined && improve === undefined) {
    print(l.retro ?? null);
    return 0;
  }
  const values = validateRetro(effect, improve),
    run = getRun(l.archon_run_id, l.repo);
  const terminal = !!l.rejected || ['completed', 'failed', 'cancelled'].includes(run.status);
  if (!terminal) throw new Error(`retro: run ${l.run_id} is not terminal (${run.status})`);
  if (!by) throw new Error('retro: controller identity missing');
  updateLedger(l, current => {
    applyRetro(current, values, by, terminal);
  });
  print(l.retro);
  return 0;
}

type Count = Partial<Record<string, number>>;
const bump = (o: Count, k: string, n = 1): void => {
  o[k] = (o[k] ?? 0) + n;
};

/** 一个 run 的 ledger 与 `workflow get` 结果；查询失败时 run 是那次的错误。 */
export interface Pair {
  ledger: Ledger;
  run: RunView | Error;
}

/** 计数（token 用量后置）：state:*、各里程碑末轮 rounds:*、first_pass（首轮即 pass 的里程碑）、failed:<节点 id 前缀>、
 *  escalate:<原因>、node_s:<前缀>（累计秒）、debt（末轮评审债条数）、recoveries。读不到的 run 单列，不吞错。report 与 board 共用。 */
export function reportSince(argv: readonly string[] = process.argv): string {
  const flag =
    argv.find(a => a.startsWith('--since='))?.slice(8) ?? argv[argv.indexOf('--since') + 1];
  const since = argv.some(a => a === '--since' || a.startsWith('--since='))
    ? /^\d{8}$/.test(flag)
      ? `${flag.slice(0, 4)}-${flag.slice(4, 6)}-${flag.slice(6, 8)}T00:00:00.000Z`
      : flag
    : '';
  if (since && !Number.isFinite(Date.parse(since)))
    throw new Error('--since must be YYYYMMDD or an ISO timestamp');
  return since;
}

export function summarize(pairs: Pair[], includeConsolidation = true): Record<string, unknown> {
  const n: Count = {};
  const unreadable: string[] = [];
  for (const { ledger: l, run } of pairs) {
    bump(n, 'recoveries', l.recoveries?.length ?? 0);
    try {
      if (run instanceof Error) throw run;
      const c = classifyRun(l, run);
      bump(n, `state:${c.state}`);
      for (const x of run.nodes ?? [])
        bump(n, `node_s:${x.nodeId.split('-')[0]}`, Math.round((x.durationMs ?? 0) / 1e3));
      if (run.status === 'failed' && !c.node?.startsWith('gate-'))
        bump(n, `failed:${c.node?.split('-')[0] ?? '?'}`);
      const last = new Map<string, { decision: DeliveryDecision | undefined; round: string }>();
      for (const f of evidenceGates(l, artifactsOf(run))) {
        const [, m, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
        last.set(m, { decision: decisionOf(evidenceJson(l, artifactsOf(run), f)), round });
        if (round === '1' && decisionVerdict(last.get(m)?.decision) === 'pass')
          bump(n, 'first_pass');
      }
      for (const g of last.values()) {
        bump(n, `rounds:${g.round}`);
        bump(n, 'debt', g.decision?.debt.length ?? 0);
        if (g.decision?.kind === 'block') bump(n, `escalate:${g.decision.reason ?? '?'}`);
      }
    } catch (e) {
      unreadable.push(`${l.run_id}: ${tail((e as Error).message, 200)}`);
    }
  }
  const summary = {
    runs: pairs.length,
    ...Object.fromEntries(Object.entries(n).sort()),
    ...debtMetrics(debtSnapshot(pairs)),
    unreadable,
  };
  if (!includeConsolidation) return summary;
  const since = reportSince();
  const titles = Bun.spawnSync(
    [
      'git',
      'log',
      ...(since ? [`--since=${since}`] : []),
      '--until=now',
      '--format=%s',
      '--',
      'wetamp',
    ],
    { cwd: join(WETAMP, '..'), stdout: 'pipe', stderr: 'pipe' }
  );
  const { consolidationMetrics } = load('./report') as typeof import('./report');
  return {
    ...summary,
    consolidation: consolidationMetrics(
      pairs,
      titles.exitCode === 0 ? titles.stdout.toString().trim().split('\n').filter(Boolean) : null,
      { since: since || 'all', until: 'now' }
    ),
  };
}

/** 全部登记 run 的计数摘要与用量台账（F-22，见 report.ts）。 */
export function report(engine?: { commit: string; baselineDays: number }): Record<string, unknown> {
  // F-02：坏 ledger 不进报表计算，单列在 unreadable，其余照常。
  const all = ledgers();
  const { buildReport } = load('./report') as typeof import('./report');
  const r = buildReport(
    all.flatMap(l => ('error' in l ? [] : [l])),
    engine,
    { humanDecisions: !engine }
  );
  if (engine) return { ...r, unreadable_ledgers: all.filter(l => 'error' in l).length };
  const bad = all.flatMap(l => ('error' in l ? [`${l.run_id}: ${l.error}`] : []));
  return {
    ...r,
    decisions: loadAsks(),
    human_decisions: {
      ...(r.human_decisions as DecisionInbox),
      unknown: [
        ...(r.human_decisions as DecisionInbox).unknown,
        ...all.flatMap(l => ('error' in l ? [l.run_id] : [])),
      ],
    },
    recorded_blockers: all.flatMap(l =>
      'error' in l
        ? []
        : (l.dispositions ?? [])
            .filter(d => d.action === 'blocked')
            .map(d => ({ run_id: l.run_id, initiator: l.launcher ?? 'unknown', ...d }))
    ),
    runs: all.length,
    unreadable: [...(r.unreadable as string[]), ...bad],
  };
}
