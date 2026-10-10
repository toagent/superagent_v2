// Archon CLI 调用与崩溃恢复。全部经 wetamp/bin/archon，状态只在 $ARCHON_HOME。
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WETAMP, home } from './config';
import type { NodeExecutionMetadata } from '../../packages/workflows/src/schemas/node-execution';

export interface Exec {
  code: number;
  out: string;
  err: string;
}
export type Json = Record<string, unknown>;

/** `workflow get --json --verbose` 中本层读取的字段（PoC 实测）。 */
export interface RunView {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  working_path?: string | null;
  output_root?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_activity_at?: string | null;
  metadata?: {
    execution_owner?: { host: string; pid: number };
    wait?: {
      nodeId: string;
      kind: string;
      event?: string;
      resumeAt: string;
      /** attention 类等待只有这个，没有可用的 resumeAt。 */
      waitingSince?: string;
    };
    /** Archon 审批门（approval / interactive_loop 等）暂停时的元数据。 */
    approval?: { nodeId: string; pauseId?: string; type?: string };
    /** 引擎在节点之外失败时写的 run 级错误（executor 捕获、启动失败等）。 */
    error?: string | null;
    /** 停止原因类别（runExitReasonSchema 枚举，如 launch_failed、process_terminated），由 run 的 owner 写。 */
    stop_reason?: { reason?: string; signal?: string } | null;
  } | null;
  /** 终局记录（事件日志折叠而来）：error 同 metadata.error 的终局快照。resume 中的 run 没有。 */
  terminal_record?: { error?: string | null } | null;
  transcript_path?: string | null;
  nodes?: { nodeId: string; state: string; error?: string | null; durationMs?: number; execution?: NodeExecutionMetadata }[];
}

// SA_ARCHON_BIN：测试桩；空串视同未设（子进程靠空串屏蔽继承值）
const archonBin = (): string => {
  const stub = process.env.SA_ARCHON_BIN;
  return stub !== undefined && stub !== '' ? stub : join(WETAMP, 'bin', 'archon');
};

/**
 * 拉起 worker 的进程环境：Claude/Codex 子进程及其 hooks 据此判定为派生会话（N-1 禁再派生）。
 * Archon 不支持按节点注入 env，一个进程跑全部节点；调用方已是 general/reviewer 时保留该角色，
 * 不把 reviewer 降成可写的 worker。reviewer 节点的只读边界在执行层（generate 逐节点生成）：
 * Claude 节点 SDK sandbox（denyWrite "/"），Codex 节点 mcp: 哨兵经 codex-readonly-proxy 改成只读沙箱；
 * hooks 白名单只是纵深防御。
 */
const workerEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  SUPERAGENT_ROLE: ['general', 'reviewer'].includes(process.env.SUPERAGENT_ROLE ?? '')
    ? process.env.SUPERAGENT_ROLE
    : 'worker',
  SUPERAGENT_HOME: home().sa,
});

/** 同步子进程（archon 查询、--detach 启动、supervisor）的期限：挂死的子进程不能卡住 tick 或 wait。 */
export const QUERY_TIMEOUT_MS = 120_000;

export function archon(args: string[], cwd?: string): Exec {
  // 只有 run/resume/approve --detach 拉起 worker；status/get/doctor 等查询保持调用方环境
  const launches = ['run', 'resume', 'approve'].includes(args[1]) && args.includes('--detach');
  const p = Bun.spawnSync([archonBin(), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: launches ? workerEnv() : process.env,
    timeout: QUERY_TIMEOUT_MS,
  });
  const err = p.exitCode === null ? `timed out after ${String(QUERY_TIMEOUT_MS / 1000)}s` : '';
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: err || p.stderr.toString() };
}

/** `--json` 可能输出多段 JSON（PoC #16）：取最后一个从行首开始的完整对象。 */
export function lastJson(text: string): Json | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n')) as Json;
    } catch {
      /* 不是对象起点，继续向前 */
    }
  }
  return null;
}

const jsonOf = (args: string[], r: Exec): Json => {
  const j = lastJson(r.out);
  if (!j)
    throw new Error(
      `archon ${args.slice(0, 2).join(' ')} exit ${String(r.code)}: ${tail(r.err || r.out)}`
    );
  return j;
};

export function archonJson(args: string[], cwd?: string): Json {
  return jsonOf(args, archon([...args, '--json'], cwd));
}

export const tail = (s: string, n = 400): string => s.trim().slice(-n);

/** Archon 要求 cwd 在 git 仓库内；传 run 的目标 repo，避免把别的仓库登记成 codebase。 */
export function getRun(id: string, cwd?: string): RunView {
  return runOf(id, archonJson(['workflow', 'get', id, '--verbose'], cwd));
}

function runOf(id: string, j: Json): RunView {
  if (typeof j.id !== 'string' || typeof j.status !== 'string')
    throw new Error(`workflow get ${id}: ${JSON.stringify(j).slice(0, 300)}`);
  return j as unknown as RunView;
}

/**
 * getRun 的异步版（board 并行查询用）：同一子命令、同一解析，外加超时与取消。子进程自成进程组（detached），
 * 超时或 abort 时整组 SIGKILL：只杀直接子进程的话，它派生的进程仍握着 stdout 管道，读管道会一直挂到它们退出。
 */
export async function getRunAsync(
  id: string,
  cwd: string | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<RunView> {
  opts.signal?.throwIfAborted();
  const args = ['workflow', 'get', id, '--verbose', '--json'];
  const p = Bun.spawn([archonBin(), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let onAbort = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killed = new Promise<never>((_, reject) => {
    const kill = (why: string): void => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch (e) {
        // ESRCH：整组已退出；其余错误（如 EPERM）原样交给调用方
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          reject(e as Error);
          return;
        }
      }
      reject(new Error(`archon workflow get ${id}: ${why}`));
    };
    timer = setTimeout(() => {
      kill(`timed out after ${String(opts.timeoutMs)}ms`);
    }, opts.timeoutMs);
    onAbort = () => {
      kill('aborted');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const [out, err, code] = await Promise.race([
      Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]),
      killed,
    ]);
    return runOf(id, jsonOf(args, { code, out, err }));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 本机且 pid 已死的 running run 才算可证实的 owner-lost；其余一律不动。 */
export function ownerLost(run: RunView): boolean {
  const o = run.metadata?.execution_owner;
  return run.status === 'running' && !!o && o.host === hostname() && !pidAlive(o.pid);
}

/** busy：recover 锁被另一进程持有（它正在恢复同一 run）。不是业务失败：调用方重读状态再定，不计次、不记处置。 */
export type RecoverResult =
  | { ok: true; resumed: Json }
  | { ok: false; reason: string; busy?: true };

export type Lock = { ok: true; release: () => void } | { ok: false; reason: 'locked' };

const DARWIN = process.platform === 'darwin';
const ERRNO = DARWIN ? '__error' : '__errno_location';
const libc = dlopen(DARWIN ? 'libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  [ERRNO]: { args: [], returns: FFIType.ptr },
});
const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = DARWIN ? 35 : 11;

/**
 * 内核 flock(LOCK_EX|LOCK_NB)：持锁进程死亡（含 SIGKILL）时内核随 fd 一起释放，无需判死或夺锁。
 * 写入的 {pid,host,at} 仅供人工诊断，不参与判定。release 只关 fd、不删文件：删掉后别的进程可能
 * 锁住一个已脱离路径的 inode，与新建同名文件的进程同时“持锁”。
 */
export function lock(path: string): Lock {
  const fd = openSync(path, 'a');
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const errno = read.i32(libc.symbols[ERRNO]() as Pointer);
    closeSync(fd);
    if (errno === EWOULDBLOCK) return { ok: false, reason: 'locked' };
    throw new Error(`flock ${path}: errno ${String(errno)}`);
  }
  ftruncateSync(fd, 0);
  writeSync(
    fd,
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })
  );
  return {
    ok: true,
    release: () => {
      closeSync(fd);
    },
  };
}

/**
 * PoC #8–#11：upstream 的 resume 只接受 failed/paused。把可证实 owner-lost 的 run 由 running 回拨为 failed，
 * 再 resume --detach；已完成节点走缓存。upstream 支持后删除回拨。
 * 同一 run 的 recover 经 `$SUPERAGENT_HOME/runs/<id>.lock`（lock()）串行；回拨 SQL 绑定观察到的 owner，期间被别的进程
 * 接手（owner 变了）就不动。guard 在锁内拿到最新 run，返回非空字符串即拒绝（停滞检查用）；resume 成功后
 * done 也在锁内执行，让恢复计数在下一个 recover 拿到锁之前落盘。
 */
export function recover(
  id: string,
  cwd?: string,
  guard?: (run: RunView) => string | undefined,
  done?: () => void
): RecoverResult {
  mkdirSync(join(home().sa, 'runs'), { recursive: true });
  const path = join(home().sa, 'runs', `${id}.lock`);
  const l = lock(path);
  if (!l.ok) return { ok: false, reason: 'recover_locked', busy: true };
  try {
    const run = getRun(id, cwd);
    const veto = guard?.(run);
    if (veto) return { ok: false, reason: veto };
    if (run.status === 'running') {
      const o = run.metadata?.execution_owner;
      if (!o || !ownerLost(run)) return { ok: false, reason: 'owner alive or on another host' };
      const db = new Database(join(home().archon, 'archon.db'));
      try {
        const r = db.run(
          `update remote_agent_workflow_runs set status='failed' where id=? and status='running'
             and json_extract(metadata,'$.execution_owner.pid')=?
             and json_extract(metadata,'$.execution_owner.host')=?`,
          [run.id, o.pid, o.host]
        );
        if (r.changes !== 1) return { ok: false, reason: 'owner_changed' };
      } finally {
        db.close();
      }
    } else if (run.status !== 'failed' && run.status !== 'paused') {
      return { ok: false, reason: `status ${run.status} is not resumable` };
    }
    const resumed = archonJson(['workflow', 'resume', run.id, '--detach'], cwd);
    if (resumed.ok === false) return { ok: false, reason: tail(JSON.stringify(resumed)) };
    done?.();
    return { ok: true, resumed };
  } finally {
    l.release();
  }
}

/** 脱离本进程的 archon 子进程（signal/wake 会在调用进程内执行剩余 DAG）；输出追加到 log。 */
export function archonDetached(args: string[], log: string, cwd?: string): number {
  const fd = openSync(log, 'a');
  const p = spawn(archonBin(), args, {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: workerEnv(),
  });
  closeSync(fd); // 子进程已继承 fd；不关的话 tick/wait 每次调用泄漏一个
  p.unref();
  return p.pid ?? -1;
}

const SIGNAL_ACK_MS = 30_000;

/** 对 sa.human.* 事件门发 signal；引擎清掉这次暂停（状态离开 paused 或换了 resumeAt）即视为接受。 */
export function signalHuman(
  run: RunView,
  data: unknown,
  log: string,
  cwd: string
): { ok: true; pid: number; log: string } | { ok: false; reason: string } {
  const w = run.metadata?.wait;
  if (run.status !== 'paused' || !w?.event?.startsWith('sa.human.'))
    return { ok: false, reason: `run ${run.id} is not waiting for a human signoff` };
  const args = ['workflow', 'signal', run.id, '--event', w.event, '--resume-at', w.resumeAt];
  const pid = archonDetached([...args, '--data', JSON.stringify(data), '--json'], log, cwd);
  for (const end = Date.now() + SIGNAL_ACK_MS; Date.now() < end; ) {
    const now = getRun(run.id, cwd);
    if (now.status !== 'paused' || now.metadata?.wait?.resumeAt !== w.resumeAt)
      return { ok: true, pid, log };
    Bun.sleepSync(500);
  }
  return {
    ok: false,
    reason: `signal not admitted within ${String(SIGNAL_ACK_MS / 1000)}s; see ${log}`,
  };
}
