// board 的“终端”行：用户在终端里交互运行的 claude / codex / opencode 会话。进程来自活动区那次 ps；状态优先取
// hooks/live.cjs 的心跳文件，过期时读 transcript / rollout 尾部（≤64KB，只看事件类型与 stop_reason），
// 都没有就按 %CPU 粗判并标 `?`。只留 client/状态/tool_name/cwd/tty/时长：不取 prompt、argv 或 transcript 正文。
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { alive, type Kind } from '../jobs';

export interface PsRow {
  ppid: number;
  tty: string;
  cpu: number;
  etime: number;
  argv: string[];
}
export type Rows = ReadonlyMap<number, PsRow>;
/** live.cjs 写的心跳（只取看板要用的键）。 */
export interface Live {
  pid: number | null;
  cwd: string | null;
  transcript_path: string | null;
  event: string;
  tool: string | null;
  turn_at: string | null;
  at: string;
  derived: boolean;
}
export interface Term {
  kind: Kind;
  pid: number;
  tty: string;
  cwd: string | null;
  state: 'busy' | 'idle' | 'unknown';
  tool: string | null;
  /** 当前状态从何时起；null 为不知道。 */
  since_ms: number | null;
  /** false：没有心跳/transcript 为据，state 是 %CPU 粗判。 */
  bound: boolean;
}
/** ps 里的一个交互会话：pids[0] 为最外层进程，其后是同 tty 下合并进来的同类子进程（codex 的 node 启动器 → 原生二进制）。 */
export interface Session {
  kind: Kind;
  pids: number[];
  tty: string;
  cpu: number;
}
type Raw = Partial<Record<keyof Live, unknown>>;
type Tail = { state: 'busy' | 'idle'; mtime: number } | null;
interface Entry {
  type?: unknown;
  isMeta?: unknown;
  message?: { stop_reason?: unknown };
}

const FRESH_MS = 120_000;
const TAIL_BYTES = 64 * 1024;
const GC_MS = 86_400_000;
const BUSY_CPU = 3;

/**
 * argv 跑的 AI CLI（也认 `node …/codex` 这种经解释器启动的）：headless 为 `claude -p/--print`、`codex exec`、
 * `opencode run`；mcp / app-server / serve 这类服务进程两者都不是，为 null。
 */
export function cliOf(argv: string[]): { kind: Kind; headless: boolean } | null {
  const a = ['node', 'bun'].includes(basename(argv[0])) ? argv.slice(1) : argv;
  const [k, sub] = [a.length ? basename(a[0]) : '', a[1] ?? ''];
  if (k === 'claude' && sub !== 'mcp')
    return { kind: k, headless: a.some(t => t === '-p' || t === '--print') };
  if (k === 'codex' && !['app-server', 'mcp', 'mcp-server'].includes(sub))
    return { kind: k, headless: sub === 'exec' };
  if (k === 'opencode' && sub !== 'serve') return { kind: k, headless: sub === 'run' };
  return null;
}
export const interactiveKind = (argv: string[]): Kind | null => {
  const c = cliOf(argv);
  return c && !c.headless ? c.kind : null;
};

/** 有 tty 的交互进程；同 tty 祖先里有同类会话的并进最外层那个。 */
export function findSessions(rows: Rows): Session[] {
  const byLeader = new Map<number, Session>();
  for (const [pid, r] of rows) {
    const kind = r.tty === '??' ? null : interactiveKind(r.argv);
    if (!kind) continue;
    let leader = pid;
    for (let p = r.ppid, n = 0; n < 64; n++) {
      const up = rows.get(p);
      if (up?.tty !== r.tty) break;
      if (interactiveKind(up.argv) === kind) leader = p;
      p = up.ppid;
    }
    const s = byLeader.get(leader) ?? { kind, pids: [leader], tty: r.tty, cpu: 0 };
    if (pid !== leader) s.pids.push(pid);
    s.cpu += r.cpu;
    byLeader.set(leader, s);
  }
  return [...byLeader.values()];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** 读心跳目录；坏文件跳过。顺手删 pid 已死且 24h 没更新的。目录不存在为空。 */
export function readLive(dir: string, now: number): Live[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Live[] = [];
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(join(dir, n), 'utf8')) as Raw;
      const at = str(o.at);
      const event = str(o.event);
      if (!at || !event) continue;
      const pid = typeof o.pid === 'number' ? o.pid : null;
      if (now - Date.parse(at) > GC_MS && !(pid && alive(pid))) {
        fs.unlinkSync(join(dir, n));
        continue;
      }
      out.push({
        pid,
        cwd: str(o.cwd),
        transcript_path: str(o.transcript_path),
        event,
        tool: str(o.tool),
        turn_at: str(o.turn_at),
        at,
        derived: o.derived === true,
      });
    } catch {
      continue; // 写到一半被读、或刚被 GC：下轮再看
    }
  }
  return out;
}

/** 会话 → 心跳：心跳的 pid 是会话里的进程或其后代；多个取最新。 */
export function bindLive(sessions: Session[], lives: Live[], rows: Rows): Map<Session, Live> {
  const of = new Map(sessions.flatMap(s => s.pids.map(p => [p, s] as const)));
  const bound = new Map<Session, Live>();
  for (const l of lives) {
    let s: Session | undefined;
    for (let p = l.pid ?? 0, n = 0; p > 1 && !s && n < 64; n++) {
      s = of.get(p);
      p = rows.get(p)?.ppid ?? 0;
    }
    const prev = s && bound.get(s);
    if (s && (!prev || Date.parse(l.at) > Date.parse(prev.at))) bound.set(s, l);
  }
  return bound;
}

/** transcript（Claude）或 rollout（Codex）尾部的回合状态；判不出为 null。 */
export function tailState(text: string, kind: Kind): 'busy' | 'idle' | null {
  const lines = text.split('\n');
  let parsed = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry & { payload?: Entry };
    try {
      e = JSON.parse(lines[i]) as typeof e;
    } catch {
      continue;
    }
    parsed = true;
    if (kind === 'claude') {
      if (e.type === 'user' && e.isMeta !== true) return 'busy';
      // stop_reason 为空是还在流式输出；tool_use 是在等工具结果
      if (e.type === 'assistant')
        return [null, undefined, 'tool_use'].includes(e.message?.stop_reason as string)
          ? 'busy'
          : 'idle';
    } else if (e.type === 'event_msg') {
      if (e.payload?.type === 'task_started') return 'busy';
      if (e.payload?.type === 'task_complete' || e.payload?.type === 'turn_aborted') return 'idle';
    }
  }
  // 回合结束时 task_complete 必在末尾：64KB 内一条回合标记都没有，是一个长回合还在跑
  return kind === 'codex' && parsed ? 'busy' : null;
}

export function readTail(file: string, kind: Kind): Tail {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const state = tailState(size > len ? text.slice(text.indexOf('\n') + 1) : text, kind);
    return state ? { state, mtime: mtimeMs } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 状态优先级：心跳 Stop → 等待；PreToolUse → 工具执行中；2 分钟内的其他心跳 → 执行中；再看尾部；最后 %CPU。 */
export function classify(
  live: Live | null,
  tail: () => Tail,
  cpu: number,
  now: number
): Pick<Term, 'state' | 'tool' | 'since_ms' | 'bound'> {
  const turn = live?.turn_at ? Date.parse(live.turn_at) : null;
  const is = (state: Term['state'], since_ms: number | null, tool: string | null = null) =>
    ({ state, tool, since_ms, bound: true }) as const;
  if (live) {
    const at = Date.parse(live.at);
    if (live.event === 'Stop') return is('idle', at);
    if (live.event === 'PreToolUse') return is('busy', at, live.tool);
    if (now - at < FRESH_MS) return is('busy', turn ?? at);
  }
  const t = tail();
  if (t) return t.state === 'idle' ? is('idle', t.mtime) : is('busy', turn);
  return { state: cpu > BUSY_CPU ? 'busy' : 'unknown', tool: null, since_ms: null, bound: false };
}

/** lsof `-Fn` 全部 fd 里 Codex 的 rollout 文件：pid → 路径。 */
export function parseRollouts(out: string): Map<number, string> {
  const found = new Map<number, string>();
  let pid = 0;
  for (const l of out.split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1));
    else if (l.startsWith('n') && /\/sessions\/.*\/rollout-[^/]*\.jsonl$/.test(l))
      found.set(pid, l.slice(1));
  }
  return found;
}

/** 绑定 + 分类 + 排序（执行中在前）；派生会话（心跳 derived）已在活动区别处显示，不进终端行。 */
export function settle(
  sessions: Session[],
  bound: Map<Session, Live>,
  cwd: ReadonlyMap<number, string>,
  rollouts: ReadonlyMap<number, string>,
  now: number
): Term[] {
  const terms: Term[] = [];
  for (const s of sessions) {
    const live = bound.get(s) ?? null;
    if (live?.derived) continue;
    const file = live?.transcript_path ?? s.pids.map(p => rollouts.get(p)).find(Boolean);
    const c = classify(live, () => (file ? readTail(file, s.kind) : null), s.cpu, now);
    const dir = live?.cwd ?? s.pids.map(p => cwd.get(p)).find(Boolean) ?? null;
    terms.push({ kind: s.kind, pid: s.pids[0], tty: s.tty, cwd: dir, ...c });
  }
  // 执行中 → 活跃?（CPU 粗判）→ 其余
  const rank = (t: Term): number => (t.state !== 'busy' ? 2 : t.bound ? 0 : 1);
  return terms.sort((a, b) => rank(a) - rank(b) || a.tty.localeCompare(b.tty));
}
