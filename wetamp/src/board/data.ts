import { describeDecision, type Decision } from '../decisions';
import { abandoned, clock, firstPassOf, planOf, cwdOf, interventionCount } from '../ledger-metrics';
// board 数据层：ledger + `workflow get` → BoardRow 与汇总。不渲染；判定与计数全部复用 cli.ts。
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  getRunAsync,
  getRunsAsync,
  reportRunRevisions,
  RunQueryError,
  tail,
  type RunView,
} from '../archon';
import { home } from '../config';
import {
  runScope,
  coord,
  Coordination,
  presence,
  type Identity,
  type Presence,
  type Message,
} from '../coord';
import { loadActivity, type Activity } from './activity';
import { landEvidence, publishProjection } from '../land';
import { milestones } from '../plan';
import { readUsage, type UsageCache } from '../usage';
import { readEta, type Estimate } from './eta';
import { confined, workflowRoles, type Role } from './workflow';
import { memoryData } from '../memory';
import {
  EXIT,
  artifactsOf,
  classifyRun,
  holdOf,
  ledgerIds,
  ledgerPath,
  loadLedger,
  summarize,
  evidenceJson,
  decisionOf,
  type Ledger,
  type Pair,
} from '../cli';

export interface BoardRow {
  humanDecision?: Decision;
  askReason?: ReturnType<typeof holdOf>;
  nativeState?: RunView['status'];
  completed_at?: RunView['completed_at'];
  lastEvent?: string | null;
  activeNodes?: { id: string; role: string | null; model: string | null }[];
  coordination?: { owner: Identity | null; presence: Presence; pending: number; error?: string };
  landed?: boolean;
  intervened?: boolean;
  interventions?: number;
  archon_id?: string;
  coderModel?: string | null;
  engine?: {
    title: string;
    milestones: string[];
    currentMilestone: string | null;
    states: { id: string; state: string }[];
    firstPass: boolean | 'unknown';
    round?: number;
    reason: string;
    dispositions: NonNullable<Ledger['dispositions']>;
  };
  model?: string | null;
  run_id: string;
  state: string;
  exit: number | null;
  nodes: { done: number; total: number; current: string | null; currentRole: string | null };
  /** ledger 的提交时刻（resume 不变），ledger 里不可解析才退回 Archon 的（每次 resume 重置）；排序同口径。 */
  started_at: string;
  /** 耗时起止（ms）：ended_ms 为 null 表示非终态、随 now 增长；整体 null 表示算不出（显示 `-`）。 */
  span: { started_ms: number; ended_ms: number | null } | null;
  /** 取数时刻的 elapsedAt（--json 用）；界面按自己的 now 重算。 */
  elapsed_s: number | null;
  held: { node: string | null; event: string | null } | null;
  recoveries: number;
  /** 引擎自动重试次数（ledger.auto_retries），与 recoveries 分开计。 */
  auto_retries: number;
  console: string;
  repo: string;
  branch: string;
  evidence: string;
  plan: string;
  /** 本轮查询失败，沿用上一轮的 run。 */
  stale: boolean;
  /** The engine confirmed that this historical run no longer exists. */
  missing?: boolean;
  error?: string;
}

export interface Snapshot {
  reflection?: ReturnType<typeof memoryData>['reflection'];
  eta?: Record<string, Estimate>;
  heartbeat_ms?: number;
  asks?: Record<string, { status: string }>;
  coordMessages?: Message[];
  usage?: UsageCache;
  web_url?: string;
  summary: Record<string, unknown>;
  rows: BoardRow[];
  at: string;
  /** 加载器总会带上；手工构造的帧（测试）可省略，此时不画活动区。 */
  activity?: Activity;
}

const STRINGS = [
  'run_id',
  'archon_run_id',
  'plan',
  'gen_dir',
  'repo',
  'branch',
  'workflow',
  'console',
  'started_at',
] as const;

/** 读 ledger；坏 JSON、非对象（null/数组/字符串）或缺字段返回原因而不抛错（一个坏 ledger 不能拖垮整张表）。 */
export function readLedger(id: string): Ledger | string {
  try {
    const l = loadLedger(id) as unknown;
    if (typeof l !== 'object' || l === null || Array.isArray(l))
      return `ledger is not a JSON object (${l === null ? 'null' : Array.isArray(l) ? 'array' : typeof l})`;
    const o = l as Partial<Record<string, unknown>>;
    const missing: string[] = STRINGS.filter(k => typeof o[k] !== 'string');
    if (o.recoveries !== undefined && !Array.isArray(o.recoveries)) missing.push('recoveries');
    return missing.length ? `ledger missing ${missing.join(', ')}` : (l as Ledger);
  } catch (e) {
    return tail((e as Error).message, 200);
  }
}

export { OUTSIDE, confined, workflowRoles, type Role } from './workflow';

export function rowOf(
  l: Ledger,
  run: RunView,
  opts: {
    now: number;
    stale?: boolean;
    roles?: Map<string, Role>;
    pending?: number;
    includeCoordination?: boolean;
    coordination?: Omit<NonNullable<BoardRow['coordination']>, 'pending'>;
  }
): BoardRow {
  const classified = classifyRun(l, run);
  const c = abandoned(l) ? { ...classified, state: 'abandoned', exit: EXIT.cancelled } : classified;
  const nodes = run.nodes ?? [];
  const current = nodes.find(n => n.state === 'running')?.nodeId ?? c.node ?? null;
  const started = Number.isFinite(clock(l.started_at))
    ? l.started_at
    : (run.started_at ?? l.started_at);
  const startedMs = clock(started);
  // 终态缺 completed_at 时取最后活动时刻；都缺则不显示，不能随 now 无限增长
  const end =
    c.exit === EXIT.held || c.exit === EXIT.running
      ? null
      : clock(run.completed_at ?? run.last_activity_at ?? '');
  const span =
    Number.isFinite(startedMs) && (end === null || Number.isFinite(end))
      ? { started_ms: startedMs, ended_ms: end }
      : null;
  let plan = planOf(l) ?? undefined;
  let ms: string[] = [];
  try {
    if (plan) ms = milestones(plan).map(m => m.id);
  } catch {
    plan = undefined;
  }
  const pkg = plan?.packages.find(p =>
    ['code', 'verify', 'repair', 'settle'].some(k => current === `${k}-${p.id}`)
  );
  const currentMs = pkg
    ? (pkg.milestone ?? 'm1')
    : (ms.find(m =>
        ['diff', 'review', 'fix', 'gate', 'human', 'attempt', 'start'].some(
          k => current === `${k}-${m}` || current?.startsWith(`${k}-${m}-`)
        )
      ) ?? (current === 'land' ? ms.at(-1) : null));
  const stats = summarize([{ ledger: l, run }], false);
  let nodeReason = '';
  try {
    const file = current ? confined(l, join(artifactsOf(run), current + '.json')) : null;
    const value: unknown = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
    nodeReason = decisionOf(value)?.reason ?? '';
  } catch {
    /* Missing outcome provides no reason. */
  }
  return {
    humanDecision:
      c.state === 'abandoned'
        ? undefined
        : (() => {
            try {
              return describeDecision(l, run);
            } catch {
              return undefined;
            }
          })(),
    askReason: c.state === 'abandoned' ? undefined : holdOf(l, run, c),
    ...(opts.includeCoordination === false
      ? {}
      : {
          coordination: (() => {
            if (opts.coordination) return { ...opts.coordination, pending: opts.pending ?? 0 };
            try {
              const c = coord(),
                scope = runScope(l),
                view = c.owner(scope);
              return {
                owner: view.owner,
                presence: view.presence,
                pending:
                  opts.pending ?? c.pending(scope) + c.pending({ kind: 'repo', id: scope.repo }),
              };
            } catch (e) {
              return {
                owner: null,
                presence: { state: 'unknown' as const },
                pending: 0,
                error: (e as Error).message,
              };
            }
          })(),
        }),
    engine: {
      title: plan?.packages[0]?.title
        ? `${plan.packages[0].title}${plan.packages.length > 1 ? ` +${String(plan.packages.length - 1)}` : ''}`
        : '任务标题未知',
      milestones: ms,
      currentMilestone: currentMs ?? null,
      states: nodes
        .filter(
          n =>
            !plan ||
            !currentMs ||
            !['code', 'verify', 'repair', 'settle'].some(k => n.nodeId.startsWith(k + '-')) ||
            plan.packages.some(
              p =>
                (p.milestone ?? 'm1') === currentMs &&
                ['code', 'verify', 'repair', 'settle'].some(k => n.nodeId === `${k}-${p.id}`)
            )
        )
        .filter(
          n =>
            !['diff', 'review', 'fix', 'gate', 'human'].some(k => n.nodeId.startsWith(k + '-')) ||
            !currentMs ||
            n.nodeId.startsWith(`${n.nodeId.split('-')[0]}-${currentMs}-`) ||
            n.nodeId === `human-${currentMs}`
        )
        .map(n => ({ id: n.nodeId, state: n.state })),
      firstPass: firstPassOf({ ledger: l, run }, stats),
      round: Math.max(
        0,
        ...Object.keys(stats)
          .filter(k => k.startsWith('rounds:'))
          .map(k => Number(k.slice(7))),
        ...nodes
          .filter(n => n.state !== 'skipped' && n.state !== 'pending')
          .map(n => Number(/-r(\d+)$/.exec(n.nodeId)?.[1] ?? 0))
      ),
      reason:
        l.reason ??
        (nodeReason || undefined) ??
        l.dispositions?.at(-1)?.reason ??
        run.metadata?.stop_reason?.reason ??
        '',
      dispositions: l.dispositions ?? [],
    },
    landed: (() => {
      if (publishProjection(l, run)) return true;
      if (l.delivery_result) return l.delivery_result.status === 'integrated';
      if (c.state !== 'completed' || !plan?.base_ref) return false;
      const evidence = landEvidence(run);
      const land =
        evidence &&
        (evidenceJson(l, artifactsOf(run), evidence.file) as { head?: string } | undefined);
      return (
        !!land?.head &&
        /^[a-f0-9]{40,64}$/.test(land.head) &&
        spawnSync(
          'git',
          [
            'merge-base',
            '--is-ancestor',
            land.head,
            `refs/heads/${plan.base_ref.replace(/^origin\//, '')}`,
          ],
          { cwd: l.repo, timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
        ).status === 0
      );
    })(),
    interventions: interventionCount(l),
    intervened: nodes.some(n => n.nodeId.startsWith('human-') && n.state === 'completed')
      ? true
      : l.intervention_events
        ? (interventionCount(l) ?? 0) > 0
        : undefined,
    nativeState: run.status,
    completed_at: run.completed_at,
    lastEvent: run.last_activity_at,
    activeNodes: nodes
      .filter(n => n.state === 'running')
      .map(n => {
        const m = n.execution?.binding.model;
        return {
          id: n.nodeId,
          role: opts.roles?.get(n.nodeId) ?? null,
          model: m?.resolved.source === 'provider' ? m.resolved.value : (m?.requested ?? null),
        };
      }),
    archon_id: l.archon_run_id,
    coderModel: (() => {
      const m = nodes.find(n => opts.roles?.get(n.nodeId) === 'coder' && n.execution?.binding.model)
        ?.execution?.binding.model;
      return m?.resolved.source === 'provider' ? m.resolved.value : (m?.requested ?? null);
    })(),
    model: (() => {
      const m = nodes.find(n => n.nodeId === current)?.execution?.binding.model;
      return m?.resolved.source === 'provider' ? m.resolved.value : (m?.requested ?? null);
    })(),
    run_id: l.run_id,
    state: c.state,
    exit: c.exit,
    nodes: {
      done: nodes.filter(n => n.state === 'completed' || n.state === 'skipped').length,
      total: Math.max(nodes.length, opts.roles?.size ?? 0),
      current,
      currentRole: current === null ? null : (opts.roles?.get(current) ?? null),
    },
    started_at: started,
    span,
    elapsed_s: elapsedAt({ span }, opts.now),
    held: c.exit === EXIT.held ? { node: c.node ?? null, event: c.event ?? null } : null,
    recoveries: l.recoveries?.length ?? 0,
    auto_retries: l.auto_retries?.length ?? 0,
    console: l.console,
    repo: basename(l.repo),
    branch: l.branch,
    evidence: artifactsOf(run),
    plan: l.plan,
    stale: opts.stale ?? false,
  };
}

export function unreadableRow(id: string, error: string, l?: Ledger, missing = false): BoardRow {
  return {
    run_id: id,
    state: 'unreadable',
    exit: null,
    nodes: { done: 0, total: 0, current: null, currentRole: null },
    started_at: l?.started_at ?? '',
    span: null,
    elapsed_s: null,
    held: null,
    recoveries: l?.recoveries?.length ?? 0,
    auto_retries: l?.auto_retries?.length ?? 0,
    console: l?.console ?? '',
    repo: l ? basename(l.repo) : '',
    branch: l?.branch ?? '',
    evidence: '',
    plan: l?.plan ?? '',
    stale: false,
    missing,
    error,
  };
}

function safeRowOf(
  l: Ledger,
  run: RunView | Error,
  opts: Parameters<typeof rowOf>[2],
  unreadable: string[]
): BoardRow {
  try {
    if (run instanceof Error) throw run;
    return rowOf(l, run, opts);
  } catch (e) {
    const error = tail((e as Error).message, 200);
    if (!unreadable.some(s => s.startsWith(`${l.run_id}:`)))
      unreadable.push(`${l.run_id}: ${error}`);
    return unreadableRow(l.run_id, error, l);
  }
}

/** 不可逆的终态：failed（含 held:gate/environment）仍可 resume/decide/cancel，不能仅按状态缓存。 */
const FINAL = new Set<RunView['status']>(['completed', 'cancelled']);
const ACTIVITY = new Set<RunView['status']>(['running', 'paused']);
export const QUERY_TIMEOUT_MS = 10_000;
const QUERY_CONCURRENCY = 8;

async function queryRuns(
  entries: { id: string; ledger: Ledger }[],
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<Map<string, RunView | Error>> {
  const queried = new Map<string, RunView | Error>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(QUERY_CONCURRENCY, entries.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          queried.set(
            entry.id,
            await getRunAsync(entry.ledger.archon_run_id, entry.ledger.repo, { timeoutMs, signal })
          );
        } catch (e) {
          queried.set(entry.id, e as Error);
        }
      }
    })
  );
  return queried;
}

/**
 * 带缓存的加载器（一个 board 进程一个）。首轮批查，之后只单查非终态或 ledger 已变化的 run；
 * completed/cancelled 在 ledger mtime 不变时不再查；failed 还需引擎 revision 不变。
 * 查询超过 SA_BOARD_QUERY_TIMEOUT_MS（默认 10s）即杀掉；
 * 查询失败沿用上一次的 run 并标 stale，从未查到过则为
 * unreadable 行。signal 中止时杀掉在途查询（board 退出时用）。
 */
// prettier-ignore
export function createLoader(signal?: AbortSignal, ownerOf?: (l: Ledger) => ReturnType<Coordination['owner']>, probe: (who: Identity) => Presence = who => presence(who, home().sa), revisionsOf: (ids: string[]) => Map<string, string> | null = reportRunRevisions, ledgerReader: (id: string) => Ledger | string = readLedger): (limit: number) => Promise<Snapshot> {
  const env = process.env.SA_BOARD_QUERY_TIMEOUT_MS;
  const timeoutMs = env === undefined ? QUERY_TIMEOUT_MS : Number(env);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`SA_BOARD_QUERY_TIMEOUT_MS must be a positive number of ms, got ${env ?? ''}`);
  const cache = new Map<string, { run: RunView; mtimeMs: number; revision?: string }>();
  const rowCache = new Map<string, BoardRow>();
  const ledgerCache = new Map<string, Ledger>();
  const coordCache = new Map<string, { scope?: ReturnType<typeof runScope>; value: Omit<NonNullable<BoardRow['coordination']>, 'pending'> }>();
  const roles = new Map<string, Map<string, Role> | undefined>();
  let summaryCache: { ids: string; value: Record<string, unknown> } | undefined;
  let first = true;
  return async limit => {
    const now = Date.now();
    const ids = ledgerIds()
      // 读目录与 stat 之间被删的 ledger 排到最后，随后由 readLedger 报成 unreadable
      .map(id => ({
        id,
        mtimeMs: statSync(ledgerPath(id), { throwIfNoEntry: false })?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    // prettier-ignore
    const initialLedgers = new Map(ids.map(({ id, mtimeMs }) => { const hit = cache.get(id), saved = ledgerCache.get(id); return [id, hit?.mtimeMs === mtimeMs && saved ? saved : ledgerReader(id)] as const; }));
    const archonIds = [...initialLedgers.entries()].flatMap(([id, l]) => typeof l === 'string' || FINAL.has(cache.get(id)?.run.status ?? 'pending') ? [] : [l.archon_run_id]);
    let revisions: Map<string, string> | null = null;
    try { revisions = revisionsOf(archonIds); } catch { /* Revision cache unavailable: keep mutable runs live. */ }
    // prettier-ignore
    const reusable = new Map(ids.flatMap(({ id, mtimeMs }) => { const hit = cache.get(id), archonId = ledgerCache.get(id)?.archon_run_id, revision = archonId ? revisions?.get(archonId) : undefined; return hit?.mtimeMs === mtimeMs && (FINAL.has(hit.run.status) || (!!hit.revision && hit.revision === revision)) ? [[id, hit] as const] : []; }));
    // A mutable run may rewrite its ledger while preserving mtime, so only reusable rows keep the saved parse.
    const ledgers = new Map(ids.map(({ id }) => { const hit = cache.get(id); return [id, reusable.has(id) || !hit || FINAL.has(hit.run.status) ? (initialLedgers.get(id) ?? ledgerReader(id)) : ledgerReader(id)] as const; }));
    const scopes = new Map<string, ReturnType<typeof runScope>>();
    const owners = new Map<string, Omit<NonNullable<BoardRow['coordination']>, 'pending'>>();
    const presenceCache = new Map<string, Presence>();
    const validLedgers = [...ledgers.values()].filter((l): l is Ledger => typeof l !== 'string');
    const coordinator = new Coordination({ runs: id => id ? validLedgers.filter(l => l.run_id === id) : validLedgers, presence: who => {
      const key = JSON.stringify([who.host ?? null, who.pid, who.pid_start ?? null]);
      const hit = presenceCache.get(key);
      if (hit) return hit;
      const value = probe(who);
      presenceCache.set(key, value);
      return value;
    } });
    const findOwner = ownerOf ?? (l => coordinator.owner(runScope(l)));
    for (const [id, l] of ledgers) {
      if (typeof l === 'string') continue;
      const saved = coordCache.get(id);
      if (reusable.has(id) && saved) {
        if (saved.scope) scopes.set(id, saved.scope);
        owners.set(id, saved.value);
        continue;
      }
      try {
        const scope = runScope(l),
          view = findOwner(l);
        scopes.set(l.run_id, scope);
        owners.set(l.run_id, { owner: view.owner, presence: view.presence });
      } catch (e) {
        owners.set(l.run_id, {
          owner: null,
          presence: { state: 'unknown' },
          error: (e as Error).message,
        });
      }
    }
    const uncached = ids.filter(({ id }) => !reusable.has(id));
    let queried = new Map<string, RunView | Error>();
    const queryEntries = uncached.flatMap(({ id }) => { const ledger = ledgers.get(id); return typeof ledger === 'string' || !ledger ? [] : [{ id, ledger }]; });
    const firstLedger = [...ledgers.values()].find((l): l is Ledger => typeof l !== 'string');
    if (uncached.length && firstLedger) {
      if (first) {
        try {
          const batch = await getRunsAsync(queryEntries.map(entry => entry.ledger.archon_run_id), cwdOf(firstLedger), { timeoutMs, signal });
          for (const { id } of uncached) {
            const l = ledgers.get(id);
            if (typeof l !== 'string' && l !== undefined)
              queried.set(
                id,
                batch.get(l.archon_run_id) ?? new RunQueryError('not_found', l.archon_run_id)
              );
          }
        } catch {
          queried = await queryRuns(queryEntries, timeoutMs, signal);
        }
      } else {
        queried = await queryRuns(queryEntries, timeoutMs, signal);
      }
    }
    first = false;
    let terminal = 0;
    const results = ids.map(({ id, mtimeMs }) => {
      const l = ledgers.get(id);
      if (l === undefined) throw new Error(`ledger ${id}: missing from snapshot`);
      if (typeof l === 'string') return { row: unreadableRow(id, l) };
      const hit = cache.get(id);
      if (reusable.has(id) && hit)
        return { l, run: hit.run, stale: false };
      try {
        const run = queried.get(id);
        if (run instanceof Error) throw run;
        if (!run) throw new RunQueryError('not_found', l.archon_run_id);
        cache.set(id, { run, mtimeMs, revision: revisions?.get(l.archon_run_id) });
        ledgerCache.set(id, l);
        const value = owners.get(id);
        if (!value) throw new Error(`coordination ${id}: missing projection`);
        coordCache.set(id, { scope: scopes.get(id), value });
        return { l, run, stale: false };
      } catch (e) {
        const err = e as Error;
        return hit ? { l, run: hit.run, stale: true, err } : { l, err };
      }
    }).filter(r => !r.run || !FINAL.has(r.run.status) || terminal++ < limit);
    const coordMessages = coordinator.messages();
    const pending = new Map<string, number>();
    for (const message of coordMessages)
      if (
        !message.type &&
        ['queued', 'surfaced', 'accepted', 'escalated'].includes(message.state)
      ) {
        const key = `${message.scope.kind}:${message.scope.id}`;
        pending.set(key, (pending.get(key) ?? 0) + 1);
      }
    const rows: BoardRow[] = [];
    const pairs: Pair[] = [];
    const bad: string[] = [];
    let reusedRows = 0;
    for (const r of results) {
      if (r.row) {
        rows.push(r.row);
        bad.push(`${r.row.run_id}: ${r.row.error ?? ''}`);
        continue;
      }
      const { l } = r;
      pairs.push({ ledger: l, run: r.run ?? r.err });
      if (!r.run) {
        rows.push(
          unreadableRow(l.run_id, tail(r.err.message, 200), l, r.err instanceof RunQueryError)
        );
        continue;
      }
      if (!roles.has(l.run_id)) roles.set(l.run_id, workflowRoles(l));
      const scope = scopes.get(l.run_id);
      let pendingCount = 0;
      if (scope)
        pendingCount =
          (pending.get(`run:${scope.id}`) ?? 0) + (pending.get(`repo:${scope.repo}`) ?? 0);
      const saved = reusable.has(l.run_id) ? rowCache.get(l.run_id) : undefined;
      if (saved) {
        const row = saved.coordination && saved.coordination.pending !== pendingCount
          ? { ...saved, coordination: { ...saved.coordination, pending: pendingCount } }
          : saved;
        rowCache.set(l.run_id, row);
        rows.push(row);
        reusedRows++;
        continue;
      }
      const row = safeRowOf(
          l,
          r.run,
          {
            now,
            stale: r.stale,
            roles: roles.get(l.run_id),
            pending: pendingCount,
            coordination: owners.get(l.run_id),
          },
          bad
        );
      rows.push(row);
      if (
        (FINAL.has(r.run.status) || r.run.status === 'failed') &&
        !r.stale &&
        row.state !== 'unreadable'
      )
        rowCache.set(l.run_id, row);
    }
    const pairIds = pairs.map(p => p.ledger.run_id).sort().join('\0');
    const s = reusedRows === pairs.length && rows.length === pairs.length && summaryCache?.ids === pairIds
      ? summaryCache.value
      : summarize(pairs);
    // prettier-ignore
    const activity = loadActivity(now, signal, results.flatMap(r => 'l' in r && r.run && ACTIVITY.has(r.run.status) ? [{ run_id: r.l.run_id, cwd: r.l.repo, controller: owners.get(r.l.run_id)?.owner ?? null }] : []));
    // 读不出的 ledger 不进 summarize（没有可计的 ledger），但计入 runs 与 unreadable，口径与 report 的“单列不吞错”一致
    s.runs = results.length;
    s.unreadable = [...new Set([...bad, ...(s.unreadable as string[])])];
    summaryCache = { ids: pairIds, value: s };
    rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
    let asks: Snapshot['asks'];
    try {
      asks = JSON.parse(readFileSync(join(home().sa, 'asks.json'), 'utf8')) as Snapshot['asks'];
    } catch {
      /* Missing asks is not proof of a decision. */
    }
    let reflection: Snapshot['reflection'];
    try {
      reflection = memoryData(now).reflection;
    } catch {
      /* Missing memory remains unknown. */
    }
    return {
      reflection,
      heartbeat_ms: statSync(join(home().sa, 'supervise-tick.log'), { throwIfNoEntry: false })
        ?.mtimeMs,
      asks,
      coordMessages,
      summary: s,
      rows,
      at: new Date(now).toISOString(),
      activity: await activity,
      usage: readUsage(),
      eta: readEta(),
    };
  };
}

export function elapsedAt(r: Pick<BoardRow, 'span'>, now: number): number | null {
  if (!r.span) return null;
  return Math.max(0, Math.round(((r.span.ended_ms ?? now) - r.span.started_ms) / 1000));
}

/** 进程本地时区（尊重 TZ）的时刻：与 now 同一天 `HH:MM:SS`，否则 `MM-DD HH:MM`；不可解析为 `--:--:--`。 */
export function fmtClock(t: string | number, now: Date | number): string {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '--:--:--';
  const n = new Date(now);
  const p = (x: number): string => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === n.toDateString()
    ? `${hm}:${p(d.getSeconds())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 45s / 12m05s / 3h04m / 2d03h。 */
export function fmtElapsed(s: number | null): string {
  if (s === null) return '-';
  const p = (n: number): string => String(n).padStart(2, '0');
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m${p(s % 60)}s`;
  if (s < 86400) return `${String(Math.floor(s / 3600))}h${p(Math.floor((s % 3600) / 60))}m`;
  return `${String(Math.floor(s / 86400))}d${p(Math.floor((s % 86400) / 3600))}h`;
}

/** ████░░ 4/6（width 格字符条，总数为 0 时全空）。 */
export function bar(done: number, total: number, width = 6): string {
  const full = total > 0 ? Math.round((Math.min(done, total) / total) * width) : 0;
  return `${'█'.repeat(full)}${'░'.repeat(width - full)} ${String(done)}/${String(total)}`;
}

export function snapshotOf(
  pairs: Pair[],
  now = Date.now(),
  options: { includeCoordination?: boolean } = {}
): Snapshot {
  const summary = summarize(pairs);
  const rows = pairs.map(p =>
    safeRowOf(
      p.ledger,
      p.run,
      { now, includeCoordination: options.includeCoordination },
      summary.unreadable as string[]
    )
  );
  return { at: new Date(now).toISOString(), summary, rows };
}
