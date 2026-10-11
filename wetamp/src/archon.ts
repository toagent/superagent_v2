// Archon CLI 调用与崩溃恢复。全部经 wetamp/bin/archon，状态只在 $ARCHON_HOME。
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WETAMP, home, writeAtomic } from './config';
import type { NodeExecutionMetadata } from '../../packages/workflows/src/schemas/node-execution';
import type { ExecutionOwnerRecord } from '../../packages/workflows/src/schemas/workflow-run';
import {
  ownershipUnknown,
  recoveryAdmissionUnknown,
  recoverySnapshot,
  unknownEffects,
  type RecoveryAdmission,
} from './recovery';

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
    execution_owner?: ExecutionOwnerRecord;
    superagent_recovery?: RecoveryAdmission;
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
  nodes?: {
    nodeId: string;
    state: string;
    startedAt?: string;
    error?: string | null;
    durationMs?: number;
    execution?: NodeExecutionMetadata;
  }[];
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
  const code = Number.isInteger(p.exitCode) ? p.exitCode : -1;
  const err = code === -1 ? `timed out after ${String(QUERY_TIMEOUT_MS / 1000)}s` : '';
  return { code, out: p.stdout.toString(), err: err || p.stderr.toString() };
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

/** Cheap change detector only; CLI still owns the run/event projection. No DB is created.
 * PostgreSQL and test stubs without a registry use the existing CLI query path. */
export function runRevision(id: string): string | null {
  const path = join(home().archon, 'archon.db');
  if (process.env.DATABASE_URL || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT status, last_activity_at, completed_at, metadata,
      (SELECT COUNT(*) FROM remote_agent_workflow_events WHERE workflow_run_id = r.id) AS events
      FROM remote_agent_workflow_runs r WHERE id = ?`
      )
      .get(id);
    return row ? new Bun.CryptoHasher('sha256').update(JSON.stringify(row)).digest('hex') : null;
  } finally {
    db.close();
  }
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
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 本机且 pid 已死的 running run 才算可证实的 owner-lost；其余一律不动。 */
export function ownerLost(run: RunView): boolean {
  const o = run.metadata?.execution_owner;
  return run.status === 'running' && !!o && o.host === hostname() && !pidAlive(o.pid);
}

/** ps exposes process birth, so a newly reused PID cannot masquerade as the old owner. */
export function reusedOwnerPid(run: RunView): boolean {
  const owner = run.metadata?.execution_owner;
  if (ownershipUnknown(run) || !owner || !run.started_at || !pidAlive(owner.pid)) return false;
  const p = spawnSync('ps', ['-p', String(owner.pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const birth = Date.parse(p.stdout.trim());
  return p.status === 0 && Number.isFinite(birth) && birth > Date.parse(run.started_at);
}

/** Reuse Archon's exact-run owner endpoint before changing lifecycle state. */
function liveOwnerAnswering(id: string): boolean | undefined {
  const source = join(WETAMP, '..', 'packages/core/src/services/run-live-owner.ts');
  const p = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { isRunOwnerAnswering } from ${JSON.stringify(source)}; console.log(await isRunOwnerAnswering(process.argv[1]));`,
      id,
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 5000 }
  );
  const out = p.stdout.toString().trim();
  return p.exitCode === 0 && ['true', 'false'].includes(out) ? out === 'true' : undefined;
}

/** busy：recover 锁被另一进程持有（它正在恢复同一 run）。不是业务失败：调用方重读状态再定，不计次、不记处置。 */
export type RecoverResult =
  | { ok: true; resumed: Json }
  | {
      ok: false;
      reason: string;
      busy?: true;
      held?: true;
      action?: string;
      snapshot?: string;
      nodes?: string[];
      evidence?: string;
    };

export type Lock = { ok: true; release: () => void } | { ok: false; reason: 'locked' };

export type Admission =
  | { ok: true; capacity: number; active: number; release: () => void }
  | { ok: false; capacity: number; active?: number; reason: 'admission_busy' | 'run_capacity' };

/**
 * Hold the shared launch lock until Archon has persisted its pending row. Other CLIs refuse
 * immediately, before creating a worker/worktree. Paused and owner-ambiguous runs retain
 * capacity; only the engine's terminal status frees it. The kernel releases a dead launcher.
 */
export function admitRun(capacity: number): Admission {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid run capacity');
  const root = home().archon;
  mkdirSync(root, { recursive: true });
  const lease = lock(join(root, 'run-admission.lock'));
  if (!lease.ok) return { ok: false, capacity, reason: 'admission_busy' };
  try {
    const path = join(root, 'archon.db');
    let active = 0;
    if (existsSync(path)) {
      const db = new Database(path, { readonly: true });
      try {
        const row = db
          .query(
            "select count(*) as n from remote_agent_workflow_runs where status not in ('completed','failed','cancelled')"
          )
          .get() as { n: number };
        active = row.n;
      } finally {
        db.close();
      }
    }
    if (active >= capacity) {
      lease.release();
      return { ok: false, capacity, active, reason: 'run_capacity' };
    }
    return { ok: true, capacity, active, release: lease.release };
  } catch (e) {
    lease.release();
    throw e;
  }
}

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
  done?: (ack: Json) => void,
  prepare?: () => void,
  strategy?: {
    lockId: string;
    operatorId?: string;
    resolveId: () => string;
    adopt: (run: RunView) => string[] | undefined;
  },
  reconciled?: string
): RecoverResult {
  mkdirSync(join(home().sa, 'runs'), { recursive: true });
  const path = join(home().sa, 'runs', `${strategy?.lockId ?? id}.lock`);
  const l = lock(path);
  if (!l.ok) return { ok: false, reason: 'recover_locked', busy: true };
  try {
    const run = getRun(strategy?.resolveId() ?? id, cwd);
    const veto = guard?.(run);
    if (veto) return { ok: false, reason: veto };
    const journalPath = join(home().sa, 'runs', `${run.id}.recovery`);
    const held = (reason: string): Extract<RecoverResult, { ok: false }> => ({
      ok: false,
      held: true,
      reason,
      action: `Inspect archon workflow get ${run.id} --verbose and its exact-run owner; resolve ownership or explicitly run archon workflow abandon ${run.id}.`,
    });
    if (recoveryAdmissionUnknown(run)) return held('recovery_admission_unknown');
    if (ownershipUnknown(run) || reusedOwnerPid(run)) return held('owner_unknown');
    const effects = unknownEffects(run);
    if (effects.length && reconciled !== recoverySnapshot(run))
      return {
        ok: false,
        held: true,
        reason: 'effects_unknown',
        nodes: effects,
        snapshot: recoverySnapshot(run),
        action: `Reconcile external effects and stop surviving node processes, then superagent recover ${strategy?.operatorId ?? id} --reconciled ${recoverySnapshot(run)}`,
      };
    if (run.status === 'running') {
      const live = liveOwnerAnswering(run.id);
      if (live !== false) return held(live ? 'live_owner_answering' : 'owner_probe_unknown');
    }
    const adoption = strategy?.adopt(run);
    if (adoption) {
      // Relaunching on a newer engine has the same lost-ack window as resume.
      // Keep the old run fenced until the ledger records the new run identity.
      writeAtomic(
        journalPath,
        JSON.stringify({
          token: randomUUID(),
          owner: run.metadata?.execution_owner,
          started_at: run.started_at ?? null,
        } satisfies RecoveryAdmission)
      );
      prepare?.();
      const result = archon([...adoption, '--json'], cwd);
      const ack = lastJson(result.out);
      if (result.code !== 0 || ack?.ok !== true || typeof ack.runId !== 'string') {
        const evidence = `${journalPath}-result`;
        writeAtomic(evidence, JSON.stringify(result));
        return { ...held('recovery_admission_unknown'), evidence };
      }
      done?.(ack);
      return { ok: true, resumed: ack };
    }
    const claim: RecoveryAdmission = {
      token: randomUUID(),
      owner: run.metadata?.execution_owner,
      started_at: run.started_at ?? null,
      ...(effects.length ? { reconciled_snapshot: reconciled, reconciled_nodes: effects } : {}),
    };
    if (run.status === 'running') {
      const o = run.metadata?.execution_owner;
      if (!o || !ownerLost(run)) return { ok: false, reason: 'owner alive or on another host' };
      const db = new Database(join(home().archon, 'archon.db'), { create: false, readwrite: true });
      try {
        const r = db.run(
          `update remote_agent_workflow_runs set status='failed',
             metadata=json_set(metadata,'$.superagent_recovery',json(?))
             where id=? and status='running'
             and json_extract(metadata,'$.execution_owner.pid')=?
             and json_extract(metadata,'$.execution_owner.host')=?
             and json_extract(metadata,'$.execution_owner.uid') is ?
             and (started_at is ? or julianday(started_at)=julianday(?))
             and json_extract(metadata,'$.superagent_recovery.token') is ?`,
          [
            JSON.stringify(claim),
            run.id,
            o.pid,
            o.host,
            o.uid ?? null,
            run.started_at ?? null,
            run.started_at ?? null,
            run.metadata?.superagent_recovery?.token ?? null,
          ]
        );
        if (r.changes !== 1) return { ok: false, reason: 'owner_changed' };
      } finally {
        db.close();
      }
    } else if (run.status !== 'failed' && run.status !== 'paused') {
      return { ok: false, reason: `status ${run.status} is not resumable` };
    }
    // Published before launch: an interrupted caller or lost ack leaves an explicit
    // unknown admission. Neither a second CLI nor old owner metadata can re-admit it.
    writeAtomic(journalPath, JSON.stringify(claim));
    prepare?.(); // 已持锁且确认可恢复；attempt/预算不得在锁忙或 owner 存活时变化
    const result = archon(['workflow', 'resume', run.id, '--detach', '--json'], cwd);
    const resumed = lastJson(result.out);
    if (
      result.code === 0 &&
      resumed?.ok === false &&
      resumed.executed === false &&
      run.status !== 'running'
    ) {
      // A structured pre-admission refusal guarantees no worker was launched.
      // Any other failure (including a lost acknowledgement) retains the fence.
      unlinkSync(journalPath);
      return { ok: false, reason: tail(JSON.stringify(resumed)) };
    }
    if (result.code !== 0 || resumed?.ok !== true) {
      const evidence = `${journalPath}-result`;
      writeAtomic(evidence, JSON.stringify(result));
      return { ...held('recovery_admission_unknown'), evidence };
    }
    done?.(resumed);
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
