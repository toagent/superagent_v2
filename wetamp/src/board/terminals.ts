// board 的“终端”行：用户在终端里交互运行的 claude / codex / opencode 会话。进程来自活动区那次 ps；状态优先取
// hooks/live.cjs 的心跳文件，过期时读 transcript / rollout 尾部（≤64KB，只看事件类型与 stop_reason），
// 都没有就按 %CPU 粗判并标 `?`。只留 client/角色/状态/tool_name/cwd/tty/时长：不取 prompt、argv 或 transcript 正文。
import { cliOf } from '../launcher';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alive, isTier, type Kind, type Tier } from '../jobs';

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
  role: Tier | null; // guard 的 sessionRole；旧心跳只有 derived 布尔
}
export interface Term {
  kind: Kind;
  tier: Tier;
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
  etime: number; // 最外层进程已运行的秒数
}
type Raw = Partial<Record<keyof Live | 'derived', unknown>>;
type Tail = { state: 'busy' | 'idle'; mtime: number } | null;
interface Entry {
  type?: unknown;
  isMeta?: unknown;
  message?: { stop_reason?: unknown; content?: unknown };
}

const FRESH_MS = 120_000;
const TAIL_BYTES = 64 * 1024;
const GC_MS = 86_400_000;
const BUSY_CPU = 3;

/**
 * argv 跑的 AI CLI（也认 `node …/codex` 这种经解释器启动的）：headless 为 `claude -p/--print`、`codex exec`、
 * `opencode run`；mcp / app-server / serve 这类服务进程两者都不是，为 null。
 */
export { cliOf };
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
    const etime = rows.get(leader)?.etime ?? r.etime;
    const s = byLeader.get(leader) ?? { kind, pids: [leader], tty: r.tty, cpu: 0, etime };
    if (pid !== leader) s.pids.push(pid);
    s.cpu += r.cpu;
    byLeader.set(leader, s);
  }
  return [...byLeader.values()];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** 读心跳目录；坏文件跳过。跳过 pid 已死且 24h 没更新的；非 readonly 时清理。目录不存在为空。 */
export function readLive(dir: string, now: number, readonly = false): Live[] {
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
        if (!readonly) fs.unlinkSync(join(dir, n));
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
        role: isTier(o.role) ? o.role : o.derived === true ? 'general' : null,
      });
    } catch {
      continue; // 写到一半被读、或刚被 GC：下轮再看
    }
  }
  return out;
}

// 心跳 → 锚点（会话/作业/无头进程的 pid 映射到的键）：心跳 pid 沿 ppid 往上第一个锚点即归属，多个取最新。作业与
// 无头进程也必须是锚点：元帅派出的无头 AI 是元帅会话的后代，否则它的派生心跳会顶替元帅自己的心跳。
export function bindLive<K>(of: ReadonlyMap<number, K>, lives: Live[], rows: Rows): Map<K, Live> {
  const bound = new Map<K, Live>();
  for (const l of lives) {
    const k = up(of, l.pid ?? 0, rows);
    const prev = k === undefined ? undefined : bound.get(k);
    if (k !== undefined && (!prev || Date.parse(l.at) > Date.parse(prev.at))) bound.set(k, l);
  }
  return bound;
}

/** 从 pid（含自身）沿 ppid 往上第一个在 of 里的值。 */
export function up<K>(of: ReadonlyMap<number, K>, pid: number, rows: Rows): K | undefined {
  for (let p = pid, n = 0; p > 1 && n < 64; n++, p = rows.get(p)?.ppid ?? 0) {
    const k = of.get(p);
    if (k !== undefined) return k;
  }
  return undefined;
}

// Claude 被 Esc 中断时不发 Stop：transcript 里补一条以此开头的 user 文本块
const INTERRUPTED = '[Request interrupted by user';
type Block = { text?: unknown } | null;
const interrupted = (c: unknown): boolean =>
  Array.isArray(c) && c.some((b: Block) => String(b?.text).startsWith(INTERRUPTED));

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
      if (e.type === 'user' && e.isMeta !== true)
        return interrupted(e.message?.content) ? 'idle' : 'busy';
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

/** 文件头部或尾部 ≤64KB（尾部被截断的首行丢掉）；读不了为 null。 */
function readChunk(file: string, head: boolean): { text: string; mtime: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs: mtime } = fs.fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, head ? 0 : size - len);
    const text = buf.toString('utf8');
    return { text: head || size === len ? text : text.slice(text.indexOf('\n') + 1), mtime };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readTail(file: string, kind: Kind): Tail {
  const c = readChunk(file, false);
  const state = c ? tailState(c.text, kind) : null;
  return c && state ? { state, mtime: c.mtime } : null;
}

const DAY_MS = 86_400_000;
/** 本地时间 `YYYY-MM-DDTHH-MM-SS`：Codex 的日期目录与 rollout 文件名都按它，字典序即时间序。 */
const localStamp = (ms: number): string =>
  new Date(ms).toLocaleString('sv-SE').replace(' ', 'T').replaceAll(':', '-');
interface Meta {
  type?: unknown;
  payload?: { cwd?: unknown; source?: unknown };
}
// Codex 会话没有心跳、空闲时也不握 rollout：在 sessions 的本地日期目录（最近 8 天）里找进程启动后才建的交互
// rollout（session_meta.source 为 cli），cwd 相同的取最新。只读候选首行，最多 20 个；匹配不上为 null。
export function matchRollout(root: string, cwd: string, start: number, now: number): string | null {
  const floor = `rollout-${localStamp(start - 60_000)}`;
  const found: string[] = [];
  for (let t = Math.max(start, now - 7 * DAY_MS) - DAY_MS; t < now + DAY_MS; t += DAY_MS) {
    const dir = join(root, ...localStamp(t).slice(0, 10).split('-'));
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []; // 那天没有会话就没有目录
    for (const n of names) if (n >= floor && n.endsWith('.jsonl')) found.push(join(dir, n));
  }
  for (const f of found.sort().reverse().slice(0, 20)) {
    const head = readChunk(f, true)?.text ?? '';
    try {
      const o = JSON.parse(head.slice(0, head.indexOf('\n'))) as Meta;
      if (o.type === 'session_meta' && o.payload?.source === 'cli' && o.payload.cwd === cwd)
        return f;
    } catch {
      continue; // 首行超过 64KB 或不是 JSON：不算匹配
    }
  }
  return null;
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
    if (live.event === 'PreToolUse') {
      // 工具没等到 PostToolUse 就被中断：尾部在心跳之后已判为结束，就是在等输入
      const t = tail();
      return t?.state === 'idle' && t.mtime >= at ? is('idle', t.mtime) : is('busy', at, live.tool);
    }
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

/** 绑定 + 分类 + 排序（执行中在前）。codexSessions 为 Codex rollout 根目录（测试注入）。 */
export function settle(
  sessions: Session[],
  bound: ReadonlyMap<unknown, Live>,
  cwd: ReadonlyMap<number, string>,
  rollouts: ReadonlyMap<number, string>,
  now: number,
  codexSessions = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
): Term[] {
  const terms: Term[] = [];
  for (const s of sessions) {
    const live = bound.get(s) ?? null;
    const dir = live?.cwd ?? s.pids.map(p => cwd.get(p)).find(Boolean) ?? null;
    const file =
      live?.transcript_path ??
      s.pids.map(p => rollouts.get(p)).find(Boolean) ??
      (s.kind === 'codex' && !live && dir
        ? matchRollout(codexSessions, dir, now - s.etime * 1000, now)
        : null);
    const c = classify(live, () => (file ? readTail(file, s.kind) : null), s.cpu, now);
    const tier = live?.role ?? 'commander'; // 没有心跳的交互顶层会话按元帅
    terms.push({ kind: s.kind, tier, pid: s.pids[0], tty: s.tty, cwd: dir, ...c });
  }
  // 执行中 → 活跃?（CPU 粗判）→ 其余
  const rank = (t: Term): number => (t.state !== 'busy' ? 2 : t.bound ? 0 : 1);
  return terms.sort((a, b) => rank(a) - rank(b) || a.tty.localeCompare(b.tty));
}
