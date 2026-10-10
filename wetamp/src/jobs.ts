// `superagent job exec` / `superagent jobs`：登记不经 superagent run、直接派出的作业（后台 `claude -p`、`codex exec`…），
// 让 board 看得见。只记标题、可执行文件种类与 --model，不记完整 argv/prompt。
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { launcher, type Launcher } from './launcher';
import { basename, join, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_USAGE, parseArgs } from './cli';
import { home } from './config';
import { newRunId } from './generate';
import { jobSession } from './usage';
import { isTier, type Tier } from './roles';
export { TIERS, isTier, type Tier } from './roles';

export type Kind = 'claude' | 'codex' | 'opencode' | 'other';
/** tiers.json 的档位键（元帅/将军/军师）；中文只在展示层。 */
export interface Job {
  id: string;
  title: string;
  card: string | null;
  log: string | null;
  cwd: string;
  kind: Kind;
  model: string | null;
  launcher?: Launcher;
  role?: Tier | null; // 旧记录没有
  session_id?: string | null;
  wrapper_pid: number;
  pid: number;
  started_at: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'lost';
  reason?: 'memory';
  memory?: MemoryReading;
  ended_at?: string;
  exit_code?: number;
  signal?: string;
}

const USAGE =
  'usage: superagent job exec --title <t> [--card <path>] [--log <path>] [--role commander|general|strategist] -- <cmd...> | jobs [--json] [--all]';
const DAY_MS = 86_400_000;
export const RECENT_MS = 3_600_000;
export interface MemoryReading { pressure: number | null; free: number; source: 'sysctl' | 'os' }
/** macOS 内核信号；不可读时显式退回 os，绝不把未知压力伪装成 normal。 */
export function memoryReading(sysctl = (): number[] => {
  const p = Bun.spawnSync(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'], { stderr: 'ignore' });
  if (p.exitCode !== 0) throw new Error('sysctl unavailable');
  return p.stdout.toString().trim().split(/\s+/).map(Number);
}, available = (): number => freemem() / totalmem() * 100): MemoryReading {
  try {
    const [pressure, free] = sysctl();
    if (![1, 2, 4].includes(pressure) || !Number.isFinite(free) || free < 0 || free > 100) throw new Error('invalid sysctl reading');
    return { pressure, free, source: 'sysctl' };
  } catch { return { pressure: null, free: available(), source: 'os' }; }
}
type AdmissionWait = (ms: number, signal: AbortSignal) => Promise<unknown>;
const admissionWait: AdmissionWait = (ms, signal) => delay(ms, undefined, { signal });

export const kindOf = (argv0: string): Kind => {
  const b = basename(argv0);
  return b === 'claude' || b === 'codex' || b === 'opencode' ? b : 'other';
};

/** 只认 `--model x`、`--model=x`、`-m x`；其余 argv 一概不看。 */
export function modelOf(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--model=')) return argv[i].slice('--model='.length);
    if ((argv[i] === '--model' || argv[i] === '-m') && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

const ENV_TIER: Partial<Record<string, Tier>> = { general: 'general', reviewer: 'strategist' };
/** --role 缺省按派发环境：SUPERAGENT_ROLE=general 为将军、reviewer 为军师，其余不记。 */
export const roleOf = (flag: Tier | undefined, env = process.env): Tier | null =>
  flag ?? ENV_TIER[env.SUPERAGENT_ROLE ?? ''] ?? null;

const dir = (): string => join(home().sa, 'jobs');

/** tmp + rename：board 与 `jobs` 读到的要么是旧版本要么是新版本，不会是半个文件。 */
function save(j: Job): void {
  const f = join(dir(), `${j.id}.json`);
  writeFileSync(`${f}.${String(process.pid)}.tmp`, JSON.stringify(j, null, 2) + '\n');
  renameSync(`${f}.${String(process.pid)}.tmp`, f);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 全部登记作业（新的在前）。已结束超过 24h 的删除；queued/running 的子进程与 wrapper 都不在了的改记 lost 并回写
 * （ended_at=发现时刻，24h 后同样回收）。readonly 不回写/删除、不伪造 ended_at。wrapper 还在就不判；坏文件单列 bad。
 */
export function readJobs(now = Date.now(), readonly = false): { jobs: Job[]; bad: string[] } {
  const jobs: Job[] = [];
  const bad: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir()).filter(f => f.endsWith('.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { jobs, bad };
    throw e;
  }
  for (const f of files) {
    const file = join(dir(), f);
    const load = (): Job => JSON.parse(readFileSync(file, 'utf8')) as Job;
    let j: Job;
    try {
      j = load();
      if (typeof j.state !== 'string' || typeof j.started_at !== 'string')
        throw new Error('not a job record');
      if (['queued', 'running'].includes(j.state) && !alive(j.wrapper_pid) && (j.pid === 0 || !alive(j.pid))) {
        const state = j.state;
        j = { ...j, state: 'lost', ...(!readonly ? { ended_at: new Date(now).toISOString() } : {}) };
        if (!readonly && load().state === state) save(j); // 重读一次：wrapper 可能刚写完终态才退出
      }
    } catch (e) {
      bad.push(`${f}: ${(e as Error).message}`);
      continue;
    }
    if (!readonly && j.ended_at && now - Date.parse(j.ended_at) > DAY_MS) unlinkSync(file);
    else jobs.push(j);
  }
  return { jobs: jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)), bad };
}

/** queued/running 的，以及 1h 内结束的（board 的活动区与 `jobs` 默认口径）。 */
export const recent = (j: Job, now: number): boolean =>
  ['queued', 'running'].includes(j.state) || now - Date.parse(j.ended_at ?? '') <= RECENT_MS;

/**
 * 继承 stdio 前台跑子进程，转发 SIGINT/SIGTERM/SIGHUP；wrapper 被中断时以首次信号的 128+n 失败，优先于子进程退出码。
 * 先登记 queued 并按内存准入；超时/信号不启动子进程，启动失败登记 failed 并抛错。
 */
async function exec(
  cmd: string[],
  f: { title: string; card?: string; log?: string; role: Tier | null },
  probe: () => MemoryReading, wait: AdmissionWait
): Promise<number> {
  mkdirSync(dir(), { recursive: true });
  const launched = launcher(home().sa);
  const job: Job = {
    id: newRunId(),
    title: f.title,
    card: f.card ? resolve(f.card) : null,
    log: f.log ? resolve(f.log) : null,
    cwd: process.cwd(),
    kind: kindOf(cmd[0]),
    model: modelOf(cmd.slice(1)),
    role: f.role,
    ...(launched ? { launcher: launched } : {}),
    wrapper_pid: process.pid,
    pid: 0,
    started_at: new Date().toISOString(),
    state: 'queued',
  };
  let child: ReturnType<typeof Bun.spawn> | undefined, identity: ReturnType<typeof setInterval> | undefined, code = 0;
  const stop = new AbortController();
  let interrupted = 0;
  const forward = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(s => {
    const h = (): void => {
      if (!interrupted) { interrupted = 128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[s]; job.signal = s; }
      if (child) child.kill(s);
      else { code = interrupted; stop.abort(); }
    };
    process.on(s, h);
    return () => process.off(s, h);
  });
  try {
    save(job);
    let waited = false;
    const min = Number(process.env.SA_ADMIT_MIN_FREE ?? 25), max = Number(process.env.SA_ADMIT_MAX_WAIT ?? 1800), deadline = Date.now() + max * 1000;
    if (process.env.SA_ADMIT === 'off') console.error('job: SA_ADMIT=off; memory admission skipped');
    else {
      if (![min, max].every(n => Number.isFinite(n) && n >= 0)) throw new Error('invalid SA_ADMIT_MIN_FREE/SA_ADMIT_MAX_WAIT');
      while (!stop.signal.aborted) {
        job.memory = probe(); job.reason = 'memory'; save(job);
        const m = job.memory, reading = `pressure=${String(m.pressure)} free=${String(m.free)}% source=${m.source}`;
        if (m.source === 'os') console.error(`job: sysctl unavailable; fallback os.freemem()/os.totalmem(); ${reading}`);
        if ((!waited || Date.now() < deadline) && (m.pressure === 1 || m.source === 'os') && m.free >= min) break;
        if (Date.now() >= deadline) { code = 75; console.error(`job: memory admission timed out; ${reading}`); break; }
        console.error(`job: queued 等内存; ${reading}; min=${String(min)}%; retry in 15s`);
        await wait(Math.min(15000, Math.max(0, deadline - Date.now())), stop.signal).catch((e: unknown) => { if (!stop.signal.aborted) throw e; }); waited = true;
      }
    }
    if (!code) {
      child = Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] });
      job.pid = child.pid; job.state = 'running'; delete job.reason; job.started_at = new Date().toISOString(); save(job);
      identity = setInterval(() => { if (!job.session_id) { job.session_id = jobSession(job); if (job.session_id) save(job); } }, 5000);
      code = await child.exited;
      code = interrupted || code;
    }
    save({ ...job, session_id: child ? job.session_id ?? jobSession(job) : null, state: code === 0 ? 'done' : 'failed', ended_at: new Date().toISOString(), ...(child?.signalCode ? { signal: job.signal ?? child.signalCode } : { exit_code: code }) });
    return code;
  } catch (e) {
    child?.kill('SIGTERM'); // 登记不了就不让它成为看板看不见的作业
    save({ ...job, state: 'failed', ended_at: new Date().toISOString(), exit_code: 1 });
    throw e;
  } finally {
    clearInterval(identity);
    for (const off of forward) off();
  }
}

export async function jobCli(argv: string[], probe = memoryReading, wait = admissionWait): Promise<number> {
  const cut = argv.indexOf('--');
  const cmd = cut < 0 ? [] : argv.slice(cut + 1);
  let a: ReturnType<typeof parseArgs>;
  try {
    a = parseArgs(cut < 0 ? argv : argv.slice(0, cut));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (a._[0] === 'jobs' && a._.length === 1 && !cmd.length) {
    const now = Date.now();
    const { jobs, bad } = readJobs(now);
    const shown = a.flags.all ? jobs : jobs.filter(j => recent(j, now));
    if (a.flags.json) console.log(JSON.stringify({ jobs: shown, bad }, null, 2));
    else
      for (const j of shown)
        console.log(
          `${j.id} ${j.state}${j.signal ? ` ${j.signal}` : j.exit_code === undefined ? '' : ` exit ${String(j.exit_code)}`} ${j.kind} ${j.model ?? '-'} ${j.role ?? '-'} ${j.title}`
        );
    for (const b of bad) console.error(`jobs: unreadable ${b}`);
    return bad.length ? 1 : 0;
  }
  const { title, card, log, role } = a.flags;
  const badRole = role !== undefined && !isTier(role);
  if (a._[1] !== 'exec' || a._.length !== 2 || !title || !cmd.length || badRole) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  return exec(cmd, { title, card, log, role: roleOf(role) }, probe, wait);
}
