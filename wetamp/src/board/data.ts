// board 数据层：ledger + `workflow get` → BoardRow 与汇总。不渲染；判定与计数全部复用 cli.ts。
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getRunAsync, tail, type RunView } from '../archon';
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
  started_at: string;
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

/** 读 ledger；坏 JSON 或缺字段返回原因而不抛错（一个坏 ledger 不能拖垮整张表）。 */
export function readLedger(id: string): Ledger | string {
  let l: Partial<Record<string, unknown>>;
  try {
    l = loadLedger(id) as unknown as Partial<Record<string, unknown>>;
  } catch (e) {
    return tail((e as Error).message, 200);
  }
  const missing: string[] = STRINGS.filter(k => typeof l[k] !== 'string');
  if (!Array.isArray(l.recoveries)) missing.push('recoveries');
  return missing.length ? `ledger missing ${missing.join(', ')}` : (l as unknown as Ledger);
}

export type Role = 'coder' | 'reviewer' | 'human' | 'script';

/**
 * 生成的工作流里每个节点的角色（按节点定义：@sa-coder/@sa-reviewer 别名、wait 事件门，其余为脚本）；节点总数也取自这里，
 * 因为 run 的 nodes 只列已调度的节点。gen 目录缺失或解析失败返回 undefined：表格退回 run 的节点数、角色显示 `?`。
 */
export function workflowRoles(l: Ledger): Map<string, Role> | undefined {
  const file = join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`);
  try {
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
  const started = run.started_at ?? l.started_at;
  const end = run.completed_at ? Date.parse(run.completed_at) : opts.now;
  const elapsed = Math.round((end - Date.parse(started)) / 1000);
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
    elapsed_s: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
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

const TERMINAL = new Set<RunView['status']>(['completed', 'cancelled', 'failed']);
export const PARALLEL = 3;

/**
 * 带缓存的加载器（一个 board 进程一个）。终态 run 在 ledger mtime 不变时不再查（decide retry/resume 经 recover 写 ledger，
 * mtime 必变）；非终态每次刷新都查；查询失败沿用上一次的 run 并标 stale，从未查到过则为 unreadable 行。
 */
export function createLoader(): (limit: number) => Promise<Snapshot> {
  const cache = new Map<string, { run: RunView; mtimeMs: number }>();
  const roles = new Map<string, Map<string, Role> | undefined>();
  return async limit => {
    const now = Date.now();
    const ids = ledgerIds()
      .map(id => ({ id, mtimeMs: statSync(ledgerPath(id)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
    const results = await mapPool(ids, PARALLEL, async ({ id, mtimeMs }) => {
      const l = readLedger(id);
      if (typeof l === 'string') return { row: unreadableRow(id, l) };
      const hit = cache.get(id);
      if (hit?.mtimeMs === mtimeMs && TERMINAL.has(hit.run.status))
        return { l, run: hit.run, stale: false };
      try {
        const run = await getRunAsync(l.archon_run_id, l.repo);
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
    return { summary: s, rows, at: new Date(now).toISOString() };
  };
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
