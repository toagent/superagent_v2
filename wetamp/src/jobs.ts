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
import { basename, join, resolve } from 'node:path';
import { EXIT_USAGE, parseArgs } from './cli';
import { home } from './config';
import { newRunId } from './generate';

export type Kind = 'claude' | 'codex' | 'opencode' | 'other';
export interface Job {
  id: string;
  title: string;
  card: string | null;
  log: string | null;
  cwd: string;
  kind: Kind;
  model: string | null;
  wrapper_pid: number;
  pid: number;
  started_at: string;
  state: 'running' | 'done' | 'failed' | 'lost';
  ended_at?: string;
  exit_code?: number;
  signal?: string;
}

const USAGE =
  'usage: superagent job exec --title <t> [--card <path>] [--log <path>] -- <cmd...> | jobs [--json] [--all]';
const DAY_MS = 86_400_000;
export const RECENT_MS = 3_600_000;

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

const dir = (): string => join(home().sa, 'jobs');

/** tmp + rename：board 与 `jobs` 读到的要么是旧版本要么是新版本，不会是半个文件。 */
function save(j: Job): void {
  const f = join(dir(), `${j.id}.json`);
  writeFileSync(`${f}.${String(process.pid)}.tmp`, JSON.stringify(j, null, 2) + '\n');
  renameSync(`${f}.${String(process.pid)}.tmp`, f);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 全部登记作业（新的在前）。已结束超过 24h 的删除；running 但子进程与 wrapper 都不在了的改记 lost 并回写
 * （ended_at=发现时刻，24h 后同样回收）。wrapper 还在就不判：它会写终态。坏文件不抛错，单列在 bad。
 */
export function readJobs(now = Date.now()): { jobs: Job[]; bad: string[] } {
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
      if (j.state === 'running' && !alive(j.pid) && !alive(j.wrapper_pid)) {
        j = { ...j, state: 'lost', ended_at: new Date(now).toISOString() };
        if (load().state === 'running') save(j); // 重读一次：wrapper 可能刚写完终态才退出
      }
    } catch (e) {
      bad.push(`${f}: ${(e as Error).message}`);
      continue;
    }
    if (j.ended_at && now - Date.parse(j.ended_at) > DAY_MS) unlinkSync(file);
    else jobs.push(j);
  }
  return { jobs: jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)), bad };
}

/** running 的，以及 1h 内结束的（board 的活动区与 `jobs` 默认口径）。 */
export const recent = (j: Job, now: number): boolean =>
  j.state === 'running' || now - Date.parse(j.ended_at ?? '') <= RECENT_MS;

/**
 * 继承 stdio 前台跑子进程，转发 SIGINT/SIGTERM/SIGHUP；退出码与子进程一致，信号退出为 128+n（Bun 的 exited 即此值）。
 * 起不来（ENOENT 等）直接抛错、不登记。
 */
async function exec(
  cmd: string[],
  f: { title: string; card?: string; log?: string }
): Promise<number> {
  mkdirSync(dir(), { recursive: true });
  const child = Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] });
  const job: Job = {
    id: newRunId(),
    title: f.title,
    card: f.card ? resolve(f.card) : null,
    log: f.log ? resolve(f.log) : null,
    cwd: process.cwd(),
    kind: kindOf(cmd[0]),
    model: modelOf(cmd.slice(1)),
    wrapper_pid: process.pid,
    pid: child.pid,
    started_at: new Date().toISOString(),
    state: 'running',
  };
  const forward = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(s => {
    const h = (): void => {
      child.kill(s);
    };
    process.on(s, h);
    return () => process.off(s, h);
  });
  try {
    save(job);
  } catch (e) {
    child.kill('SIGTERM'); // 登记不了就不让它成为看板看不见的作业
    throw e;
  }
  const code = await child.exited;
  for (const off of forward) off();
  const sig = child.signalCode;
  save({
    ...job,
    state: code === 0 ? 'done' : 'failed',
    ended_at: new Date().toISOString(),
    ...(sig ? { signal: sig } : { exit_code: code }),
  });
  return code;
}

export async function jobCli(argv: string[]): Promise<number> {
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
          `${j.id} ${j.state}${j.signal ? ` ${j.signal}` : j.exit_code === undefined ? '' : ` exit ${String(j.exit_code)}`} ${j.kind} ${j.model ?? '-'} ${j.title}`
        );
    for (const b of bad) console.error(`jobs: unreadable ${b}`);
    return bad.length ? 1 : 0;
  }
  if (a._[1] !== 'exec' || a._.length !== 2 || !a.flags.title || !cmd.length) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  return exec(cmd, { title: a.flags.title, card: a.flags.card, log: a.flags.log });
}
