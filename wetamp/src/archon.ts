// Archon CLI 调用与崩溃恢复。全部经 wetamp/bin/archon，状态只在 $ARCHON_HOME。
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

export function archon(args: string[], cwd?: string): Exec {
  const p = Bun.spawnSync([archonBin(), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
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

const LOCK_TTL_MS = 10 * 60_000;

/**
 * O_EXCL 锁文件，内容 {pid,host,at}；拿不到返回 null。持有者是本机已死进程，或文件超过 TTL（recover、tick
 * 都是秒级操作）才夺取一次。返回的 release 只删除仍是自己写的锁。
 */
export function lock(path: string): (() => void) | null {
  const me = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, me, { flag: 'wx' });
      return () => {
        if (readFileSync(path, 'utf8') === me) rmSync(path);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt > 0 || !lockStale(path)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

function lockStale(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > LOCK_TTL_MS) return true;
    const o = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; host: string };
    return o.host === hostname() && !pidAlive(o.pid);
  } catch {
    return false; // 刚被释放或正在写入：本次不夺取，调用方按“被占用”处理
  }
}

/**
 * PoC #8–#11：upstream 的 resume 只接受 failed/paused。把可证实 owner-lost 的 run 由 running 回拨为 failed，
 * 再 resume --detach；已完成节点走缓存。upstream 支持后删除回拨。
 * 同一 run 的 recover 经 `$SUPERAGENT_HOME/runs/<id>.lock` 串行；回拨 SQL 绑定观察到的 owner，期间被别的进程
 * 接手（owner 变了）就不动。guard 在锁内拿到最新 run，返回非空字符串即拒绝（停滞检查用）。
 */
export function recover(
  id: string,
  cwd?: string,
  guard?: (run: RunView) => string | undefined
): RecoverResult {
  mkdirSync(join(home().sa, 'runs'), { recursive: true });
  const release = lock(join(home().sa, 'runs', `${id}.lock`));
  if (!release) return { ok: false, reason: 'recover_locked' };
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
    return resumed.ok === false
      ? { ok: false, reason: tail(JSON.stringify(resumed)) }
      : { ok: true, resumed };
  } finally {
    release();
  }
}

/** 脱离本进程的 archon 子进程（signal/wake 会在调用进程内执行剩余 DAG）；输出追加到 log。 */
export function archonDetached(args: string[], log: string, cwd?: string): number {
  const fd = openSync(log, 'a');
  const p = spawn(archonBin(), args, { cwd, detached: true, stdio: ['ignore', fd, fd] });
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
