// Archon CLI 调用与崩溃恢复。全部经 wetamp/bin/archon，状态只在 $ARCHON_HOME。
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WETAMP, home } from './config';

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
  metadata?: {
    execution_owner?: { host: string; pid: number };
    wait?: { nodeId: string; kind: string; event?: string; resumeAt: string };
  } | null;
  nodes?: { nodeId: string; state: string; error?: string | null; durationMs?: number }[];
}

// SA_ARCHON_BIN：测试桩；空串视同未设（子进程靠空串屏蔽继承值）
const archonBin = (): string => {
  const stub = process.env.SA_ARCHON_BIN;
  return stub !== undefined && stub !== '' ? stub : join(WETAMP, 'bin', 'archon');
};

/** 拉起 worker 的进程环境：Claude/Codex 子进程及其 hooks 据此判定为派生会话（N-1 禁再派生）。 */
const workerEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  SUPERAGENT_ROLE: 'worker',
  SUPERAGENT_HOME: home().sa,
});

export function archon(args: string[], cwd?: string): Exec {
  // 只有 run/resume --detach 拉起 worker；status/get/doctor 等查询保持调用方环境
  const launches = ['run', 'resume'].includes(args[1]) && args.includes('--detach');
  const p = Bun.spawnSync([archonBin(), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: launches ? workerEnv() : process.env,
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
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

export function archonJson(args: string[], cwd?: string): Json {
  const r = archon([...args, '--json'], cwd);
  const j = lastJson(r.out);
  if (!j)
    throw new Error(
      `archon ${args.slice(0, 2).join(' ')} exit ${String(r.code)}: ${tail(r.err || r.out)}`
    );
  return j;
}

export const tail = (s: string, n = 400): string => s.trim().slice(-n);

/** Archon 要求 cwd 在 git 仓库内；传 run 的目标 repo，避免把别的仓库登记成 codebase。 */
export function getRun(id: string, cwd?: string): RunView {
  const j = archonJson(['workflow', 'get', id, '--verbose'], cwd);
  if (typeof j.id !== 'string' || typeof j.status !== 'string')
    throw new Error(`workflow get ${id}: ${JSON.stringify(j).slice(0, 300)}`);
  return j as unknown as RunView;
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

export type RecoverResult = { ok: true; resumed: Json } | { ok: false; reason: string };

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
  if (!l.ok) return { ok: false, reason: 'recover_locked' };
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
