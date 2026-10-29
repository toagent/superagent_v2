import { inspectProcess } from './launcher';
// Archon CLI 调用与崩溃恢复。全部经 wetamp/bin/archon，状态只在 $ARCHON_HOME。
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { archonMutation, coord } from './coord';
import { WETAMP, home } from './config';
import type { Ledger } from './cli';
import { executionOwnership, unknownEffects } from './recovery';
import type { RunWaitResult } from '../../packages/core/src/services/run-attention-watch';

export interface Exec {
  code: number;
  out: string;
  err: string;
}
export type Json = Record<string, unknown>;

export class RunQueryError extends Error {
  constructor(
    public readonly kind: 'not_found',
    id: string
  ) {
    super(`workflow get ${id}: ${kind}`);
  }
}

/** `workflow get --json --verbose` 中本层读取的字段（PoC 实测）。 */
export type { ExecutionRunView as RunView } from '@archon/workflows/execution-lifecycle';
import type { ExecutionRunView as RunView } from '@archon/workflows/execution-lifecycle';
// SA_ARCHON_BIN：测试桩；空串视同未设（子进程靠空串屏蔽继承值）
const archonBin = (): string => {
  const stub = process.env.SA_ARCHON_BIN;
  return stub !== undefined && stub !== '' ? stub : join(WETAMP, 'bin', 'archon');
};

/**
 * 拉起 worker 的进程环境：Claude/Codex 子进程及其 hooks 据此判定为派生会话（N-1 禁再派生）。
 * Archon 不支持按节点注入 env，一个进程跑全部节点；调用方已是 general/reviewer 时保留该角色，
 * 不把 reviewer 降成可写的 worker。reviewer 节点的只读边界在执行层（generate 逐节点生成）：
 * 评审节点允许测试写入，以 mutates_checkout:false 在结束时检查 checkout 污染；
 * hooks 白名单只是纵深防御。
 */
const workerEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  // Routing identity belongs to the CLI entrypoint; child CLIs derive their own via the shim.
  SA_SERVED_RUN: '',
  SA_HISTORICAL_RUN: '',
  SUPERAGENT_ROLE: ['general', 'reviewer'].includes(process.env.SUPERAGENT_ROLE ?? '')
    ? process.env.SUPERAGENT_ROLE
    : 'worker',
  SUPERAGENT_HOME: home().sa,
});

/** 同步子进程（archon 查询、--detach 启动、supervisor）的期限：挂死的子进程不能卡住 tick 或 wait。 */
export const QUERY_TIMEOUT_MS = 120_000;

interface LaunchIntent {
  path: string;
  token: string;
}
// The shell registers its own identity before exec: the PID then belongs to the actual Archon CLI.
const registerLaunch = (): string => `
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const [path, token, pid] = process.argv.slice(1);
const intent = JSON.parse(readFileSync(path, 'utf8'));
if (intent.token !== token) throw new Error('launch reservation changed');
const {createRequire} = await import('node:module');
const birth = createRequire(import.meta.path)(${JSON.stringify(join(WETAMP, 'hooks/identity.cjs'))}).inspect(Number(pid));
if (birth.state !== 'online') throw new Error('launch identity unavailable');
intent.pid = Number(pid); intent.pid_start = birth.start;
const tmp = path + '.' + token; writeFileSync(tmp, JSON.stringify(intent)); renameSync(tmp, path);
`;
export function archon(
  args: string[],
  cwd?: string,
  intent?: LaunchIntent,
  timeoutMs = QUERY_TIMEOUT_MS
): Exec {
  // 只有 run/resume/approve --detach 拉起 worker；status/get/doctor 等查询保持调用方环境
  const launches = ['run', 'resume', 'approve'].includes(args[1]) && args.includes('--detach');
  const cmd = intent
    ? [
        'bash',
        '-c',
        '"$1" -e "$2" "$3" "$4" "$$" || exit 1; shift 4; exec "$@"',
        'sa-admission',
        process.execPath,
        registerLaunch(),
        intent.path,
        intent.token,
        archonBin(),
        ...args,
      ]
    : [archonBin(), ...args];
  const p = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...(launches ? workerEnv() : process.env),
      ...(archonMutation(args) ? coord().admissionEnv(true) : {}),
    },
    timeout: timeoutMs,
  });
  const code = Number.isInteger(p.exitCode) ? p.exitCode : -1;
  const err = code === -1 ? `timed out after ${String(timeoutMs / 1000)}s` : '';
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
      `archon ${args.slice(0, 2).join(' ')} exit ${String(r.code)}: ${errorExcerpt(r.err || r.out)}`
    );
  return j;
};

export function archonJson(args: string[], cwd?: string, intent?: LaunchIntent): Json {
  return jsonOf(args, archon([...args, '--json'], cwd, intent));
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

/** One SQLite pass for report caches; null keeps PostgreSQL and test stubs on the live path. */
export function reportRunRevisions(ids?: string[]): Map<string, string> | null {
  const path = join(home().archon, 'archon.db');
  if (process.env.DATABASE_URL || !existsSync(path)) return null;
  if (ids?.length === 0) return new Map();
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT id, status, last_activity_at, completed_at, metadata,
      (SELECT COUNT(*) FROM remote_agent_workflow_events WHERE workflow_run_id = r.id) AS events
      FROM remote_agent_workflow_runs r${ids ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : ''}`
      )
      .all(...(ids ?? [])) as Record<string, unknown>[];
    return new Map(
      rows.map(row => [
        String(row.id),
        new Bun.CryptoHasher('sha256').update(JSON.stringify(row)).digest('hex'),
      ])
    );
  } finally {
    db.close();
  }
}

export function runStatuses(): Map<string, RunView['status']> | null {
  const path = join(home().archon, 'archon.db');
  if (process.env.DATABASE_URL || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    // prettier-ignore
    const rows = db.query<{ id: string; status: RunView['status'] }, []>('SELECT id, status FROM remote_agent_workflow_runs').all();
    return new Map(rows.map(row => [row.id, row.status]));
  } finally {
    db.close();
  }
}

/** Report snapshot: read-only SQLite, complete histories of runs selected by started_at.
 * No provider/CLI processes, and no truncation of attempts crossing the window boundary. */
// prettier-ignore
export function reportRuns(since: string, until: string) {
  const db = new Database(join(home().archon, 'archon.db'), { readonly: true });
  try {
    return db.transaction(() => {
      const runs = db.query<Omit<RunView, 'metadata'> & Pick<import('../../packages/workflows/src/schemas/workflow-run').WorkflowRun, 'workflow_name'> & { metadata: string | null }, [string, string]>(
        'SELECT * FROM remote_agent_workflow_runs WHERE julianday(started_at) >= julianday(?) AND julianday(started_at) < julianday(?)'
      ).all(since || '0001-01-01', until);
      const rows = db.query<Omit<import('../../packages/workflows/src/schemas/workflow-event').WorkflowEventRow, 'data'> & { data: string }, [string, string]>(
        `SELECT e.* FROM remote_agent_workflow_events e JOIN remote_agent_workflow_runs r
         ON r.id = e.workflow_run_id WHERE julianday(r.started_at) >= julianday(?) AND julianday(r.started_at) < julianday(?)
         ORDER BY e.workflow_run_id, e.event_order, e.created_at, e.rowid`
      ).all(since || '0001-01-01', until);
      const by = new Map<string, import('../../packages/workflows/src/schemas/workflow-event').WorkflowEventRow[]>();
      for (const row of rows) {
        const events = by.get(row.workflow_run_id) ?? [];
        if (!by.has(row.workflow_run_id)) by.set(row.workflow_run_id, events);
        events.push({ ...row, data: JSON.parse(row.data) as import('../../packages/workflows/src/schemas/workflow-event').WorkflowEventRow['data'] });
      }
      return new Map(runs.map(row => [row.id, { ...row, metadata: JSON.parse(row.metadata ?? '{}') as RunView['metadata'], events: by.get(row.id) ?? [] }]));
    })();
  } finally { db.close(); }
}

export const tail = (s: string, n = 400): string => s.trim().slice(-n);

export const errorExcerpt = (s: string, n = 400): string => {
  s = s.trim();
  if (s.length <= n) return s;
  const head = Math.min(n - 1, Math.max(s.indexOf('\n'), Math.ceil((n - 1) / 2)));
  return s.slice(0, head) + '…' + s.slice(s.length - (n - head - 1));
};

/** Ledger order preserves generation chronology; each engine run contributes once. */
export const archonRunIds = (l: Pick<Ledger, 'archon_run_id' | 'adoptions'>): string[] => [
  ...new Set([...(l.adoptions ?? []).flatMap(a => [a.from, a.to]), l.archon_run_id]),
];

/** Archon 要求 cwd 在 git 仓库内；传 run 的目标 repo，避免把别的仓库登记成 codebase。 */
export function getRun(id: string, cwd?: string): RunView {
  return runOf(id, archonJson(['workflow', 'get', id, '--verbose'], cwd));
}

/** Native attention is a notification, not a verbose RunView: classification still needs one get.
 * Native wait owns the remaining business deadline; the existing query budget separately
 * bounds CLI startup/shutdown overhead so a cold start cannot consume the wait's margin. */
export function waitNotification(id: string, cwd: string, seconds: number): RunWaitResult {
  const timeoutMs = Math.ceil(seconds * 1000) + QUERY_TIMEOUT_MS;
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(timeoutMs))
    throw new Error('workflow wait timeout must be a positive finite number of seconds');
  const args = ['workflow', 'wait', id, '--json', '--timeout', String(seconds)];
  const r = archon(args, cwd, undefined, timeoutMs);
  const j = jsonOf(args, r);
  const kinds: RunWaitResult['kind'][] = [
    'attention',
    'owner_lost',
    'deadline',
    'aborted',
    'not_found',
  ];
  const kind = kinds.find(k => k === j.result);
  if (
    ![0, 3].includes(r.code) ||
    j.ok !== true ||
    j.action !== 'wait' ||
    j.runId !== id ||
    !kind ||
    (kind === 'attention' && (typeof j.attention !== 'object' || j.attention === null)) ||
    (['deadline', 'owner_lost'].includes(kind) && typeof j.observedStatus !== 'string')
  )
    throw new Error(`workflow wait ${id}: ${errorExcerpt(r.err || r.out)}`);
  if (kind === 'aborted' || kind === 'not_found') throw new Error(`workflow wait ${id}: ${kind}`);
  return {
    kind,
    ...(kind === 'attention'
      ? { attention: j.attention }
      : { runId: id, observedStatus: j.observedStatus }),
  } as RunWaitResult;
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
async function archonJsonAsync(
  args: string[],
  cwd: string | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<Json> {
  opts.signal?.throwIfAborted();
  const p = Bun.spawn([archonBin(), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env: { ...process.env },
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
      reject(new Error(`archon ${args.slice(0, 2).join(' ')}: ${why}`));
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
    return jsonOf(args, { code, out, err });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function getRunAsync(
  id: string,
  cwd: string | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<RunView> {
  const result = await archonJsonAsync(['workflow', 'get', id, '--verbose', '--json'], cwd, opts);
  if (result.error === 'not_found') throw new RunQueryError('not_found', id);
  return runOf(id, result);
}

/** One CLI/database query supplies the full node projection for every board ledger. */
export async function getRunsAsync(
  ids: string[],
  cwd: string | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<Map<string, RunView>> {
  const result = await archonJsonAsync(
    ['workflow', 'runs', '--ids', ids.join(','), '--verbose', '--json'],
    cwd,
    opts
  );
  if (!Array.isArray(result.runs)) throw new Error('archon workflow runs: invalid runs payload');
  return new Map(
    result.runs.map(value => {
      const run = runOf('batch', value as Json);
      return [run.id, run];
    })
  );
}

export function pidAlive(pid: number): boolean {
  return inspectProcess(pid).state !== 'offline';
}

/** Only a confirmed dead executor can enter REC recovery; COORD owns controller admission. */
export function ownerLost(run: RunView): boolean {
  return run.status === 'running' && executionOwnership(run).state === 'offline';
}
export function reusedOwnerPid(run: RunView): boolean {
  return executionOwnership(run).reused === true;
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
export type {
  ResumeExecutionResult as RecoverResult,
  Lock,
} from '@archon/workflows/execution-lifecycle';
import {
  resumeExecution,
  admitExecution,
  type Admission,
  executionLock as lock,
} from '@archon/workflows/execution-lifecycle';
import { claimInterruptedExecution } from '../../packages/core/src/workflows/execution-lifecycle';
export { lock };
/** The engine owns launch reservations; the adapter supplies a read-only registry count. */
export function admitRun(): Admission {
  return admitExecution({
    root: home().archon,
    inspectProcess,
    countActive: () => {
      const path = join(home().archon, 'archon.db');
      if (!existsSync(path)) return 0;
      const db = new Database(path, { readonly: true });
      try {
        return (
          db
            .query<
              { n: number },
              []
            >("select count(*) as n from remote_agent_workflow_runs where status not in ('completed','failed','cancelled','paused')")
            .get()?.n ?? 0
        );
      } finally {
        db.close();
      }
    },
    launch: archonJson,
  });
}

/** Transport adapter only; Archon owns continuation fences and interrupted-run transitions. */
export function recover(
  ...args: Parameters<typeof resumeExecution> extends [unknown, ...infer Rest] ? Rest : never
): ReturnType<typeof resumeExecution> {
  return resumeExecution(
    {
      root: home().archon,
      inspectProcess,
      getRun,
      liveOwnerAnswering,
      reconcileEffects: unknownEffects,
      claimInterrupted: (run, claim) => claimInterruptedExecution(home().archon, run, claim),
      launch: archon,
      parseAck: lastJson,
    },
    ...args
  );
}

/** 脱离本进程的 archon 子进程（signal/wake 会在调用进程内执行剩余 DAG）；输出追加到 log。 */
export function archonDetached(
  args: string[],
  log: string,
  cwd?: string,
  inheritLock = false,
  engineSnapshot?: string
): number {
  const fd = openSync(log, 'a');
  const p = spawn(
    engineSnapshot ? join(engineSnapshot, 'wetamp', 'bin', 'archon') : archonBin(),
    args,
    {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...workerEnv(), ...(archonMutation(args) ? coord().admissionEnv(inheritLock) : {}) },
    }
  );
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
  cwd: string,
  engineSnapshot?: string
): { ok: true; pid: number; log: string } | { ok: false; reason: string } {
  const w = run.metadata?.wait;
  if (run.status !== 'paused' || !w?.event?.startsWith('sa.human.'))
    return { ok: false, reason: `run ${run.id} is not waiting for a human signoff` };
  const args = ['workflow', 'signal', run.id, '--event', w.event, '--resume-at', w.resumeAt];
  // This parent waits for the signal acknowledgement while holding admission; verify and inherit its lock.
  const pid = archonDetached(
    [...args, '--data', JSON.stringify(data), '--json'],
    log,
    cwd,
    true,
    engineSnapshot
  );
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

export function dueWorkflowContinuations(): string[] {
  const result = archonJson(['workflow', 'due']);
  if (result.ok !== true)
    throw new Error(typeof result.error === 'string' ? result.error : 'workflow due failed');
  if (!Array.isArray(result.runs) || result.runs.some(id => typeof id !== 'string'))
    throw new Error('workflow due returned invalid run ids');
  return result.runs as string[];
}
