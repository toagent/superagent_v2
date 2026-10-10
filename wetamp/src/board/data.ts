// board 数据层：ledger + `workflow get` → BoardRow 与汇总。不渲染；判定与计数全部复用 cli.ts。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { getRunAsync, tail, type RunView } from '../archon';
import { home } from '../config';
import { loadActivity, type Activity } from './activity';
import {
  EXIT,
  artifactsOf,
  classifyRun,
  ledgerIds,
  ledgerPath,
  loadLedger,
  summarize,
  type Ledger,
  type Pair,
} from '../cli';

export interface BoardRow {
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
  console: string;
  repo: string;
  branch: string;
  evidence: string;
  plan: string;
  /** 本轮查询失败，沿用上一轮的 run。 */
  stale: boolean;
  error?: string;
}

export interface Snapshot {
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
    if (!Array.isArray(o.recoveries)) missing.push('recoveries');
    return missing.length ? `ledger missing ${missing.join(', ')}` : (l as Ledger);
  } catch (e) {
    return tail((e as Error).message, 200);
  }
}

export const OUTSIDE = '（路径越界，已跳过）';

/**
 * ledger 里的路径（plan、gen_dir、transcript、evidence 及其下文件）解析 realpath 后只允许落在 ledger.repo 或
 * $SUPERAGENT_HOME 之内：ledger 是本地可写文件，不能让它把看板引去读任意文件。不存在返回 null；越界抛错，调用方只丢该项。
 */
export function confined(l: Ledger, p: string): string | null {
  if (!existsSync(p)) return null;
  const real = realpathSync(p);
  const inside = [l.repo, home().sa].some(r => {
    if (!existsSync(r)) return false;
    const root = realpathSync(r);
    return real === root || real.startsWith(root + sep);
  });
  if (!inside) throw new Error(`${p}${OUTSIDE}`);
  return real;
}

export type Role = 'coder' | 'reviewer' | 'human' | 'script';

/**
 * 生成的工作流里每个节点的角色（按节点定义：@sa-coder/@sa-reviewer 别名、wait 事件门，其余为脚本）；节点总数也取自这里，
 * 因为 run 的 nodes 只列已调度的节点。gen 目录缺失或解析失败返回 undefined：表格退回 run 的节点数、角色显示 `?`。
 */
export function workflowRoles(l: Ledger): Map<string, Role> | undefined {
  try {
    const file = confined(
      l,
      join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`)
    );
    if (!file) return undefined;
    const wf = Bun.YAML.parse(readFileSync(file, 'utf8')) as {
      nodes?: { id: string; model?: string; wait?: unknown }[];
    };
    return new Map(
      (wf.nodes ?? []).map(n => [
        n.id,
        n.model === '@sa-coder'
          ? 'coder'
          : n.model === '@sa-reviewer'
            ? 'reviewer'
            : n.wait
              ? 'human'
              : 'script',
      ])
    );
  } catch {
    return undefined;
  }
}

export function rowOf(
  l: Ledger,
  run: RunView,
  opts: { now: number; stale?: boolean; roles?: Map<string, Role> }
): BoardRow {
  const c = classifyRun(l, run);
  const nodes = run.nodes ?? [];
  const current = nodes.find(n => n.state === 'running')?.nodeId ?? c.node ?? null;
  const started = Number.isFinite(Date.parse(l.started_at))
    ? l.started_at
    : (run.started_at ?? l.started_at);
  const startedMs = Date.parse(started);
  // 终态缺 completed_at 时取最后活动时刻；都缺则不显示，不能随 now 无限增长
  const end =
    c.exit === EXIT.held || c.exit === EXIT.running
      ? null
      : Date.parse(run.completed_at ?? run.last_activity_at ?? '');
  const span =
    Number.isFinite(startedMs) && (end === null || Number.isFinite(end))
      ? { started_ms: startedMs, ended_ms: end }
      : null;
  return {
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
    recoveries: l.recoveries.length,
    console: l.console,
    repo: basename(l.repo),
    branch: l.branch,
    evidence: artifactsOf(run),
    plan: l.plan,
    stale: opts.stale ?? false,
  };
}

export function unreadableRow(id: string, error: string, l?: Ledger): BoardRow {
  return {
    run_id: id,
    state: 'unreadable',
    exit: null,
    nodes: { done: 0, total: 0, current: null, currentRole: null },
    started_at: l?.started_at ?? '',
    span: null,
    elapsed_s: null,
    held: null,
    recoveries: l?.recoveries.length ?? 0,
    console: l?.console ?? '',
    repo: l ? basename(l.repo) : '',
    branch: l?.branch ?? '',
    evidence: '',
    plan: l?.plan ?? '',
    stale: false,
    error,
  };
}

/** 并行度 ≤n 的 map，保持输入顺序。 */
async function mapPool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(xs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

/** 不可逆的终态：resume 只接受 failed/paused，failed（含 held:gate/environment）可经 decide/cancel 再变，每轮都查。 */
const FINAL = new Set<RunView['status']>(['completed', 'cancelled']);
export const PARALLEL = 3;
export const QUERY_TIMEOUT_MS = 10_000;

/**
 * 带缓存的加载器（一个 board 进程一个）。completed/cancelled 在 ledger mtime 不变时不再查；其余每次刷新都查，
 * 单次查询超过 SA_BOARD_QUERY_TIMEOUT_MS（默认 10s）即杀掉；查询失败沿用上一次的 run 并标 stale，从未查到过则为
 * unreadable 行。signal 中止时杀掉在途查询（board 退出时用）。
 */
export function createLoader(signal?: AbortSignal): (limit: number) => Promise<Snapshot> {
  const env = process.env.SA_BOARD_QUERY_TIMEOUT_MS;
  const timeoutMs = env === undefined ? QUERY_TIMEOUT_MS : Number(env);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`SA_BOARD_QUERY_TIMEOUT_MS must be a positive number of ms, got ${env ?? ''}`);
  const cache = new Map<string, { run: RunView; mtimeMs: number }>();
  const roles = new Map<string, Map<string, Role> | undefined>();
  return async limit => {
    const now = Date.now();
    const activity = loadActivity(now, signal); // 与 ledger 查询并发；自身不抛错
    const ids = ledgerIds()
      // 读目录与 stat 之间被删的 ledger 排到最后，随后由 readLedger 报成 unreadable
      .map(id => ({
        id,
        mtimeMs: statSync(ledgerPath(id), { throwIfNoEntry: false })?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
    const results = await mapPool(ids, PARALLEL, async ({ id, mtimeMs }) => {
      const l = readLedger(id);
      if (typeof l === 'string') return { row: unreadableRow(id, l) };
      const hit = cache.get(id);
      if (hit?.mtimeMs === mtimeMs && FINAL.has(hit.run.status))
        return { l, run: hit.run, stale: false };
      try {
        const run = await getRunAsync(l.archon_run_id, l.repo, { timeoutMs, signal });
        cache.set(id, { run, mtimeMs });
        return { l, run, stale: false };
      } catch (e) {
        const err = e as Error;
        return hit ? { l, run: hit.run, stale: true, err } : { l, err };
      }
    });
    const rows: BoardRow[] = [];
    const pairs: Pair[] = [];
    const bad: string[] = [];
    for (const r of results) {
      if (r.row) {
        rows.push(r.row);
        bad.push(`${r.row.run_id}: ${r.row.error ?? ''}`);
        continue;
      }
      const { l } = r;
      pairs.push({ ledger: l, run: r.run ?? r.err });
      if (!r.run) {
        rows.push(unreadableRow(l.run_id, tail(r.err.message, 200), l));
        continue;
      }
      if (!roles.has(l.run_id)) roles.set(l.run_id, workflowRoles(l));
      rows.push(rowOf(l, r.run, { now, stale: r.stale, roles: roles.get(l.run_id) }));
    }
    const s = summarize(pairs);
    // 读不出的 ledger 不进 summarize（没有可计的 ledger），但计入 runs 与 unreadable，口径与 report 的“单列不吞错”一致
    s.runs = results.length;
    s.unreadable = [...bad, ...(s.unreadable as string[])];
    rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return { summary: s, rows, at: new Date(now).toISOString(), activity: await activity };
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
