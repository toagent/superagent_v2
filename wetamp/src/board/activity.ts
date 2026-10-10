// board 活动区：登记作业（jobs.ts）、未登记的无头 AI 进程（ps）、twin-agent 远端队列。三个来源并发、各自 ≤3s，
// 互不拖累：失败只记一行 notes（远端队列不可用时静默省略）。进程只取 pid/kind/--model/cwd/耗时，绝不留 prompt 或其余 argv。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { tail } from '../archon';
import { modelOf, readJobs, recent, type Job, type Kind } from '../jobs';

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
export interface Activity {
  jobs: Job[];
  procs: Proc[];
  remote: Remote[];
  notes: string[];
}

export const SOURCE_TIMEOUT_MS = 3000;
const CWD_MAX = 8;
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

/** 无头 AI 调用：`claude -p/--print`、`codex exec`、`opencode run`（也认 `node …/codex exec` 这种经解释器启动的）。 */
function aiKind(argv: string[]): Kind | null {
  const a = ['node', 'bun'].includes(basename(argv[0])) ? argv.slice(1) : argv;
  const k = a.length ? basename(a[0]) : '';
  if (k === 'claude' && a.some(t => t === '-p' || t === '--print')) return 'claude';
  if (k === 'codex' && a[1] === 'exec') return 'codex';
  if (k === 'opencode' && a[1] === 'run') return 'opencode';
  return null;
}
const isArchon = (argv: string[]): boolean =>
  argv.slice(0, 2).some(t => basename(t) === 'archon' || t.endsWith('/packages/cli/src/cli.ts'));

/**
 * 解析 `ps -axo pid=,ppid=,etime=,command=`。祖先里有 archon（ledger run 的节点，表格已显示）、已登记作业的 wrapper
 * 或另一个命中的 AI 进程（codex 的 node 启动器 → 原生二进制）的不再单列。argv 按空白切分，只用来判种类与 --model。
 */
export function parsePs(out: string, now: number, wrappers: ReadonlySet<number>): Proc[] {
  const rows = new Map<number, { ppid: number; etime: number; argv: string[] }>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m)
      rows.set(Number(m[1]), { ppid: Number(m[2]), etime: etimeS(m[3]), argv: m[4].split(/\s+/) });
  }
  const kinds = new Map<number, Kind>();
  for (const [pid, r] of rows) {
    const k = aiKind(r.argv);
    if (k) kinds.set(pid, k);
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

/** `lsof -Fn` 输出：`p<pid>` 后跟 `n<path>`。 */
export function parseLsof(out: string): Map<number, string> {
  const cwd = new Map<number, string>();
  let pid = 0;
  for (const l of out.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1));
    else if (l.startsWith('n')) cwd.set(pid, l.slice(1));
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

async function procsOf(now: number, wrappers: Set<number>, signal?: AbortSignal): Promise<Proc[]> {
  const t0 = Date.now();
  const ps = await capture(['ps', '-axo', 'pid=,ppid=,etime=,command='], SOURCE_TIMEOUT_MS, signal);
  if (ps.code !== 0) throw new Error(`ps exited ${String(ps.code)}`);
  const procs = parsePs(ps.out, now, wrappers);
  const pids = procs.slice(0, CWD_MAX).map(p => p.pid);
  if (!pids.length) return procs;
  // 已退出的 pid 让 lsof 返回 1，其余照常输出：只看输出；与 ps 共用 3s 额度
  const left = Math.max(1, SOURCE_TIMEOUT_MS - (Date.now() - t0));
  const cwd = parseLsof(
    (await capture(['lsof', '-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], left, signal)).out
  );
  return procs.map(p => ({ ...p, cwd: cwd.get(p.pid) ?? null }));
}

async function remoteOf(signal?: AbortSignal): Promise<Remote[]> {
  const bin =
    process.env.TWIN_AGENT_QUEUE_CLIENT ??
    join(homedir(), 'work/_mcp_workspace/tools/twin-agent/twin-agent-queue-client');
  if (!existsSync(bin)) return [];
  const r = await capture([bin, 'list'], SOURCE_TIMEOUT_MS, signal);
  return r.code === 0 ? parseQueue(r.out) : [];
}

export async function loadActivity(now: number, signal?: AbortSignal): Promise<Activity> {
  const notes: string[] = [];
  const note = (src: string, e: unknown): void => {
    notes.push(`${src}: ${tail((e as Error).message, 120)}`);
  };
  let jobs: Job[] = [];
  const wrappers = new Set<number>();
  try {
    const r = readJobs(now);
    jobs = r.jobs.filter(j => recent(j, now));
    for (const j of r.jobs) if (j.state === 'running') wrappers.add(j.wrapper_pid);
    for (const b of r.bad) note('jobs', new Error(b));
  } catch (e) {
    note('jobs', e);
  }
  const [procs, remote] = await Promise.all([
    procsOf(now, wrappers, signal).catch((e: unknown) => {
      note('procs', e);
      return [];
    }),
    remoteOf(signal).catch(() => []), // 远端不可达不是看板的问题：静默省略
  ]);
  return { jobs, procs, remote, notes };
}
