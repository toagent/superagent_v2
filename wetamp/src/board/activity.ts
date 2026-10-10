// board 活动区：登记作业（jobs.ts）、未登记的无头 AI 进程与终端会话（ps，见 terminals.ts）、twin-agent 远端队列。三个来源
// 并发、各自 ≤3s，互不拖累：失败只记一行 notes（远端队列不可用时静默省略）。进程绝不留 prompt 或 --model 外的 argv。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { tail } from '../archon';
import { home, loadTiers, type Tiers } from '../config';
import { modelOf, readJobs, type Job, type Kind, type Tier } from '../jobs';
import type { Launcher } from '../launcher';
import * as term from './terminals';
import { sessionModel } from '../models';

export interface Proc {
  pid: number;
  kind: Kind;
  model: string | null;
  cwd: string | null;
  started_ms: number;
}
export interface Remote {
  id: string;
  state: string;
  host: string;
  agent: string;
}
export interface Owned {
  tier: Tier | null;
  inferred?: boolean; // owner inferred from unique cwd
  guess: boolean; // tier 是按模型池推断的
  owner: number | null; // 祖先终端会话的 pid（Term.pid）
}
export interface RunRef {
  run_id: string;
  cwd: string;
  launcher?: Launcher;
}
export interface Ownership {
  owner: number | null;
  inferred: boolean;
}
export interface Activity {
  jobHistory?: Job[];
  runs?: (RunRef & Ownership)[];
  jobs: (Job & Owned)[];
  procs: (Proc & Owned)[];
  terms: term.Term[];
  remote: Remote[];
  notes: string[];
}

export const SOURCE_TIMEOUT_MS = 3000;
const CWD_MAX = 24;
// twin-agent-remote 的 state_of：其余（finished/failed/cancelled/abandoned/unknown）不算活动
const REMOTE_ACTIVE = new Set(['running', 'queued', 'preparing', 'cancelling']);

/** 跑一个短命令取 stdout；超时或 abort 杀整个进程组（ssh 之类可能有孙进程握着管道）。非零退出由调用方判断。 */
async function capture(
  cmd: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ code: number; out: string }> {
  signal?.throwIfAborted();
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', detached: true });
  let onAbort = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killed = new Promise<never>((_, reject) => {
    const kill = (why: string): void => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          reject(e as Error);
          return;
        }
      }
      reject(new Error(`${basename(cmd[0])}: ${why}`));
    };
    timer = setTimeout(() => {
      kill(`timed out after ${String(timeoutMs)}ms`);
    }, timeoutMs);
    onAbort = () => {
      kill('aborted');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const [out, code] = await Promise.race([
      Promise.all([new Response(p.stdout).text(), p.exited]),
      killed,
    ]);
    return { code, out };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** ps 的 etime `[[dd-]hh:]mm:ss` → 秒。 */
export function etimeS(s: string): number {
  const [d, hms] = s.includes('-') ? s.split('-') : ['0', s];
  return hms.split(':').reduce((a, x) => a * 60 + Number(x), 0) + Number(d) * 86400;
}

const isArchon = (argv: string[]): boolean =>
  argv.slice(0, 2).some(t => basename(t) === 'archon' || t.endsWith('/packages/cli/src/cli.ts'));

const PS_FIELDS = 'pid=,ppid=,tty=,%cpu=,etime=,command=';
/** 解析 `ps -axo PS_FIELDS`。argv 按空白切分，只用来判种类、交互与否与 --model。 */
export function psRows(out: string): Map<number, term.PsRow> {
  const rows = new Map<number, term.PsRow>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m)
      rows.set(Number(m[1]), {
        ppid: Number(m[2]),
        tty: m[3],
        cpu: Number(m[4]),
        etime: etimeS(m[5]),
        argv: m[6].split(/\s+/),
      });
  }
  return rows;
}

/**
 * 无头 AI 进程。祖先里有 archon（ledger run 的节点，表格已显示）、已登记作业的 wrapper
 * 或另一个命中的 AI 进程（codex 的 node 启动器 → 原生二进制）的不再单列。
 */
export function parsePs(rows: term.Rows, now: number, wrappers: ReadonlySet<number>): Proc[] {
  const kinds = new Map<number, Kind>();
  for (const [pid, r] of rows) {
    const c = term.cliOf(r.argv);
    if (c?.headless) kinds.set(pid, c.kind);
  }
  const owned = (ppid: number): boolean => {
    for (let p = ppid, n = 0; n < 64; n++) {
      if (kinds.has(p) || wrappers.has(p)) return true;
      const up = rows.get(p);
      if (!up) return false;
      if (isArchon(up.argv)) return true;
      p = up.ppid;
    }
    return false;
  };
  const procs: Proc[] = [];
  for (const [pid, kind] of kinds) {
    const r = rows.get(pid);
    if (r && !owned(r.ppid))
      procs.push({
        pid,
        kind,
        model: modelOf(r.argv),
        cwd: null,
        started_ms: now - r.etime * 1000,
      });
  }
  return procs.sort((a, b) => b.started_ms - a.started_ms);
}

/** `lsof -Fn` 输出里的 cwd：`p<pid>`、`fcwd` 后跟 `n<path>`。 */
export function parseLsof(out: string): Map<number, string> {
  const cwd = new Map<number, string>();
  let [pid, fd] = [0, ''];
  for (const l of out.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1));
    else if (l.startsWith('f')) fd = l.slice(1);
    else if (l.startsWith('n') && fd === 'cwd') cwd.set(pid, l.slice(1));
  }
  return cwd;
}

/** twin-agent `list` 的 TSV：`job_id\tstate\thost agent mode workspace_mode path`（元数据缺失时只有前两列）。 */
export function parseQueue(out: string): Remote[] {
  return out
    .split('\n')
    .map(l => l.split('\t'))
    .filter(([, state]) => REMOTE_ACTIVE.has(state))
    .map(([id, state, meta = '']) => {
      const [host = '?', agent = '?'] = meta.split(/\s+/).filter(Boolean);
      return { id, state, host, agent };
    });
}

type Pools = Tiers['tiers'] | null;
type Rank = Pick<Owned, 'tier' | 'guess'>;
/** 显式角色原样用；否则模型只落在将军/军师之一的池里时推断为该档，两边都有或都没有为 null。 */
export function rankOf(role: Tier | null | undefined, model: string | null, pools: Pools): Rank {
  if (role) return { tier: role, guess: false };
  const hit = (['general', 'strategist'] as const).filter(t =>
    Object.values(pools?.[t]?.pools ?? {}).some(ms => model !== null && ms.includes(model))
  );
  return hit.length === 1 ? { tier: hit[0], guess: true } : { tier: null, guess: false };
}

// 心跳先归到最近的锚点（会话/作业/进程）：派生会话的心跳归它的作业或进程，不会顶替祖先元帅会话的心跳。
// 作业角色取 --role，其次心跳 role，最后按模型池推断；owner 从 wrapper（已退出则作业 pid）沿 ppid 找会话。
export function attach(
  rows: term.Rows,
  sessions: term.Session[],
  jobs: Job[],
  procs: Proc[],
  lives: term.Live[],
  pools: Pools
): Pick<Activity, 'jobs' | 'procs'> & { bound: Map<object, term.Live> } {
  const leaders = new Map(sessions.flatMap(s => s.pids.map(p => [p, s.pids[0]] as const)));
  const anchors = new Map<number, object>([
    ...sessions.flatMap(s => s.pids.map(p => [p, s] as const)),
    ...jobs.flatMap(j => [[j.wrapper_pid, j] as const, [j.pid, j] as const]),
    ...procs.map(p => [p.pid, p] as const),
  ]);
  const bound = term.bindLive(anchors, lives, rows);
  const own = (x: Job | Proc, role: Tier | null | undefined, ...pids: number[]): Owned => ({
    ...rankOf(role ?? bound.get(x)?.role, x.model, pools),
    owner: pids.map(p => term.up(leaders, p, rows)).find(o => o !== undefined) ?? null,
  });
  return {
    bound,
    jobs: jobs.map(j => ({ ...j, model: j.model ?? bound.get(j)?.model ?? sessionModel(bound.get(j)?.transcript_path ?? null, j.kind), ...own(j, j.role, j.wrapper_pid, j.pid) })),
    procs: procs.map(p => ({ ...p, model: p.model ?? bound.get(p)?.model ?? sessionModel(bound.get(p)?.transcript_path ?? null, p.kind), ...own(p, null, p.pid) })),
  };
}

/** One snapshot, one owner: recorded launcher, watcher/parent chain, unique legacy cwd, directory. */
export function ownership(
  x: RunRef, rows: term.Rows, sessions: term.Session[], terms: term.Term[], pids: number[] = []
): Ownership {
  const leaders = new Map(sessions.flatMap(s => s.pids.map(p => [p, s.pids[0]] as const)));
  const known = (pid: number): number | undefined => {
    const leader = leaders.get(pid);
    return terms.some(t => t.pid === leader) ? leader : undefined;
  };
  if (x.launcher && rows.has(x.launcher.pid)) {
    const owner = known(x.launcher.pid);
    const t = terms.find(t => t.pid === owner);
    if (t?.kind === x.launcher.client && t.tty === x.launcher.tty) return { owner: t.pid, inferred: false };
  }
  const watchers = [...rows].filter(([, r]) => {
    const a = ['bun', 'node'].includes(basename(r.argv[0])) ? r.argv.slice(1) : r.argv;
    return (basename(a[0] ?? '') === 'superagent' || a[0]?.endsWith('/wetamp/src/cli.ts'))
      && ['wait', 'status', 'board'].includes(a[1])
      && a.slice(2).find(arg => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(arg)) === x.run_id;
  }).map(([pid]) => pid);
  const owners = [...new Set(
    [...watchers, ...pids].map(p => term.up(leaders, p, rows))
      .filter(p => p !== undefined && terms.some(t => t.pid === p))
  )];
  if (owners.length === 1) return { owner: owners[0] ?? null, inferred: false };
  if (!x.launcher) {
    const cwd = resolve(x.cwd);
    const inside = (root: string): boolean => cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
    const hits = terms.filter(t => t.cwd && inside(resolve(t.cwd)));
    if (hits.length === 1) return { owner: hits[0].pid, inferred: true };
  }
  return { owner: null, inferred: false };
}
export const visible = (ended: string | number | null | undefined, now: number): boolean =>
  ended === null || (ended !== undefined && now - (typeof ended === 'number' ? ended : Date.parse(ended)) <= 30 * 60_000);

type Procs = Pick<Activity, 'jobs' | 'procs' | 'terms' | 'runs'>;
async function scan(
  now: number, jobs: Job[], pools: Pools, signal?: AbortSignal, runs: RunRef[] = []
): Promise<Procs> {
  const t0 = Date.now();
  const ps = await capture(['ps', '-axo', PS_FIELDS], SOURCE_TIMEOUT_MS, signal);
  if (ps.code !== 0) throw new Error(`ps exited ${String(ps.code)}`);
  const rows = psRows(ps.out);
  const wrappers = new Set(jobs.filter(j => ['queued', 'running'].includes(j.state)).map(j => j.wrapper_pid));
  const procs = parsePs(rows, now, wrappers);
  const sessions = term.findSessions(rows);
  const lives = term.readLive(join(home().sa, 'live'), now, true);
  const own = attach(rows, sessions, jobs, procs, lives, pools);
  // 一次 lsof 取全部 fd：cwd，以及 codex 握着的 rollout（只在回合中写入时打开）。
  // 已退出的 pid 让 lsof 返回 1，其余照常输出：只看输出；与 ps 共用 3s 额度
  const pids = [...procs.map(p => p.pid), ...sessions.flatMap(s => s.pids)].slice(0, CWD_MAX);
  const left = Math.max(1, SOURCE_TIMEOUT_MS - (Date.now() - t0));
  const out = pids.length
    ? (await capture(['lsof', '-p', pids.join(','), '-Fn'], left, signal)).out
    : '';
  const cwd = parseLsof(out);
  const terms = term.settle(sessions, own.bound, cwd, term.parseRollouts(out), now);
  return {
    runs: runs.map(r => ({ run_id: r.run_id, cwd: r.cwd, ...ownership(r, rows, sessions, terms) })),
    jobs: own.jobs.map(j => ({
      ...j, ...ownership(
        {run_id: j.id, cwd: j.cwd, launcher: j.launcher}, rows, sessions, terms, [j.wrapper_pid, j.pid]
      ),
    })),
    procs: own.procs.map(p => ({ ...p, cwd: cwd.get(p.pid) ?? null })),
    terms,
  };
}

async function remoteOf(signal?: AbortSignal): Promise<Remote[]> {
  const bin =
    process.env.TWIN_AGENT_QUEUE_CLIENT ??
    join(homedir(), 'work/_mcp_workspace/tools/twin-agent/twin-agent-queue-client');
  if (!existsSync(bin)) return [];
  const r = await capture([bin, 'list'], SOURCE_TIMEOUT_MS, signal);
  return r.code === 0 ? parseQueue(r.out) : [];
}

export async function loadActivity(now: number, signal?: AbortSignal, runs: RunRef[] = []): Promise<Activity> {
  const notes: string[] = [];
  const note = (src: string, e: unknown): void => {
    notes.push(`${src}: ${tail((e as Error).message, 120)}`);
  };
  let jobs: Job[] = [], jobHistory: Job[] = [];
  try {
    const r = readJobs(now, true);
    jobHistory = r.jobs;
    jobs = r.jobs.filter(j => ['queued', 'running'].includes(j.state) || visible(j.ended_at, now)); // 活动作业都保留：scan 从这里认 wrapper
    for (const b of r.bad) note('jobs', new Error(b));
  } catch (e) {
    note('jobs', e);
  }
  let pools: Pools = null;
  try {
    pools = loadTiers().tiers;
  } catch (e) {
    note('tiers', e); // 只影响角色推断：显式角色照常
  }
  const [act, remote] = await Promise.all([
    scan(now, jobs, pools, signal, runs).catch((e: unknown): Procs => {
      note('procs', e);
      return {
        jobs: attach(new Map(), [], jobs, [], [], pools).jobs, procs: [], terms: [],
        runs: runs.map(r => ({run_id: r.run_id, cwd: r.cwd, owner: null, inferred: false})),
      };
    }),
    remoteOf(signal).catch(() => []), // 远端不可达不是看板的问题：静默省略
  ]);
  return { ...act, remote, notes, jobHistory };
}
