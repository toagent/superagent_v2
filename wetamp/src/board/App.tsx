// board 的 Ink 界面。Frame 是纯渲染（--once 用 renderToString 出同一帧），App 只加刷新循环与按键。
import { basename } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { TIERS, type Tier } from '../jobs';
import { shortModel } from '../models';
import { fmtTokens, sessionKey, type UsageCache } from '../usage';
import type { Activity, Owned } from './activity';
import type { Term } from './terminals';
import { bar, elapsedAt, fmtClock, fmtElapsed, type BoardRow, type Snapshot } from './data';
import { detailLines, type Detail } from './detail';

const COLOR: Record<string, string> = {
  completed: 'green',
  running: 'cyan',
  failed: 'red',
  cancelled: 'gray',
  owner_lost: 'magenta',
  unreadable: 'red',
};
const colorOf = (s: string): string => (s.startsWith('held:') ? 'yellow' : (COLOR[s] ?? 'white'));
const ACTIVE = (r: BoardRow): boolean => r.state === 'running' || r.state.startsWith('held:');
/** 按显示宽度截断/补齐到 n 列（中文等宽字符算 2 列）。 */
function pad(s: string, n: number): string {
  const w = Bun.stringWidth;
  let out = s;
  const chars = Array.from(s);
  for (let k = chars.length; w(out) > n && k > 0; k--) out = `${chars.slice(0, k - 1).join('')}…`;
  return out + ' '.repeat(Math.max(0, n - w(out)));
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
// 四档的英文键只在这里译成中文；run 节点按工作流角色：确定性节点归引擎，wait 门归人工
const TIER_ZH: Record<Tier, string> = { commander: '元帅', general: '将军', strategist: '军师' };
const NODE_ZH: Partial<Record<string, string>> = { coder: '将军', reviewer: '军师', script: '引擎', human: '人工' };
const modelTag = (m?: string | null, compact = false): string => shortModel(m, compact) ? `·${shortModel(m, compact)}` : '';
const tierTag = (o: Pick<Owned, 'tier' | 'guess'> & { model?: string | null }, compact = false): string =>
  o.tier ? `${TIER_ZH[o.tier]}${modelTag(o.model, compact)}${o.guess ? '?' : ''}` : `?${modelTag(o.model, compact)}`;
const nodeRole = (r: BoardRow, compact = false): string => (NODE_ZH[r.nodes.currentRole ?? ''] ?? '?') + modelTag(r.model, compact);
const totalFor = (c: UsageCache | undefined, field: 'id' | 'job_id' | 'run_id', id?: string | null): string => { const xs = c?.sessions.filter(s => field === 'id' ? id && s.id === sessionKey(id) : s.owner?.[field] === id) ?? []; return xs.length ? ` tok ${fmtTokens(xs.reduce((n, s) => n + s.total, 0))}` : ''; };

function reason(r: BoardRow): string {
  if (r.state === 'unreadable') return r.error ?? '';
  if (r.held) return r.held.event ?? r.held.node ?? '';
  return r.exit === null
    ? ''
    : `exit ${String(r.exit)}${r.nodes.current && r.exit !== 0 ? ` @${r.nodes.current}` : ''}`;
}

/**
 * <80 列为紧凑：id 缩短、state 用短标、nodes 只留 n/m、去掉 current/rec 列（选中或 running 行另起一行灰字），
 * exit/held 吃剩余宽度。80–120 为中等（下面的 narrow），放得下全部列时为宽屏。
 *
 * 列宽含 1 格分隔：内容截到 w−1 再补一个空格，相邻列永不粘连。宽屏放不下 current 与 repo@branch 的最小宽度时转窄屏：隐藏 console 与 repo@branch、
 * nodes 只留 4/5、state 与 exit/held 收窄，80 列下 elapsed/exit/rec 仍完整；current(role) 吃剩余宽度（5–30）。
 */
type Widths = Record<'id' | 'state' | 'nodes' | 'elapsed' | 'reason' | 'rec' | 'console', number>;
const WIDTHS: Record<'wide' | 'narrow', Widths> = {
  wide: { id: 21, state: 19, nodes: 13, elapsed: 8, reason: 22, rec: 4, console: 9 },
  narrow: { id: 21, state: 17, nodes: 6, elapsed: 8, reason: 18, rec: 4, console: 0 },
};
const REPO_MIN = 20;
const CURRENT_MIN = 5;
const sum = (w: Widths): number => Object.values(w).reduce((a, b) => a + b, 0);
const WIDE_MIN = sum(WIDTHS.wide) + CURRENT_MIN + REPO_MIN;
const cell = (s: string, w: number): string => `${pad(s, w - 1)} `;

const COMPACT_MAX = 79;
// id 当天 `HHMMSS-xxxx`、否则 `MMDD-HHMMSS-xxxx`（+1 分隔）；reason 由 Frame 按实际 id 列宽补足
const COMPACT: Widths = { id: 17, state: 7, nodes: 6, elapsed: 8, reason: 0, rec: 0, console: 0 };

interface Layout {
  compact: boolean;
  wide: boolean;
  w: Widths;
  current: number;
}
export function layout(width: number): Layout {
  if (width <= COMPACT_MAX) return { compact: true, wide: false, w: COMPACT, current: 0 };
  const wide = width >= WIDE_MIN;
  const w = wide ? WIDTHS.wide : WIDTHS.narrow;
  const fixed = sum(w) + (wide ? REPO_MIN : 0);
  return { compact: false, wide, w, current: Math.max(CURRENT_MIN, Math.min(30, width - fixed)) };
}

/** run id 由 newRunId 按 UTC 生成：与 now 的 UTC 日期比“当天”，数字原样保留（它是标识，不换算时区）。 */
export function shortId(id: string, now: number): string {
  const m = /^(\d{4})(\d{4})-(\d{6}-\w+)$/.exec(id);
  if (!m) return id;
  return `${m[1]}${m[2]}` === new Date(now).toISOString().slice(0, 10).replaceAll('-', '')
    ? m[3]
    : `${m[2]}-${m[3]}`;
}
const SHORT: Record<string, string> = {
  running: '▶run',
  failed: '✗fail',
  completed: '✓done',
  cancelled: '⊘canc',
};
const shortState = (s: string): string =>
  s.startsWith('held:') ? '⏸held' : (SHORT[s] ?? s.slice(0, 5));

function CompactRow({
  r,
  sel,
  w,
  now,
}: {
  r: BoardRow;
  sel: boolean;
  w: Widths;
  now: number;
}): ReactElement {
  const nodes = r.nodes.total ? `${String(r.nodes.done)}/${String(r.nodes.total)}` : '-';
  return (
    <Box flexDirection="column">
      <Text inverse={sel} wrap="truncate">
        {cell(shortId(r.run_id, now), w.id)}
        <Text color={colorOf(r.state)} dimColor={r.state === 'unreadable'}>
          {cell(`${r.stale ? '~' : ''}${shortState(r.state)}`, w.state)}
        </Text>
        {cell(nodes, w.nodes)}
        {cell(fmtElapsed(elapsedAt(r, now)), w.elapsed)}
        {w.reason > 0 ? pad(reason(r), w.reason) : ''}
      </Text>
      {r.nodes.current && (sel || r.state === 'running') ? (
        <Text dimColor wrap="truncate">
          {`  cur: ${r.nodes.current} · ${nodeRole(r, true)}`}
        </Text>
      ) : null}
    </Box>
  );
}

const JOB_MARK = {
  running: ['▶', 'cyan'],
  done: ['✓', 'green'],
  failed: ['✗', 'red'],
  lost: ['?', 'magenta'],
} as const;

/** 远端队列的 job id `YYYYMMDDHHMMSS-xxxxxx` 只显示 `HHMMSS-xxxxxx`；其他形状截前 13 位。 */
export const shortRemoteId = (id: string): string =>
  /^\d{8}(\d{6}-\w+)$/.exec(id)?.[1] ?? id.slice(0, 13);

const IDLE_MS = 30 * 60_000;
/** 终端会话：client、状态、tool_name、cwd basename、tty 短名、时长；`?` 标出没有心跳/transcript 为据的粗判。 */
function termText(t: Term, now: number, compact: boolean): string {
  const dur =
    t.since_ms === null ? '' : ` ${fmtElapsed(Math.max(0, Math.floor((now - t.since_ms) / 1000)))}`;
  const state =
    t.state === 'busy'
      ? t.bound
        ? `执行中${t.tool ? ` ${t.tool}` : ''}${dur}`
        : '活跃?'
      : t.state === 'idle'
        ? `${t.since_ms !== null && now - t.since_ms > IDLE_MS ? '空闲' : '等待输入'}${dur}`
        : '未知?';
  const dir = t.cwd ? pad(basename(t.cwd), 20).trimEnd() : '?';
  return `${t.state === 'busy' ? '●' : '○'} ${TIER_ZH[t.tier]}${modelTag(t.model, compact)} ${t.kind} ${state} · ${dir} · ${t.tty.replace(/^tty/, '')}`;
}

interface Line {
  text: string;
  color?: string;
}
/**
 * 活动区：每个终端会话下缩进挂它 ppid 链上的作业与无头进程；挂不上的（父会话已退出、run 节点之外的后台进程）
 * 与远端队列归“无主”组。不含 prompt/argv（来源本就没有）；紧凑布局仅显示模型族名。
 */
function activityLines(a: Activity, now: number, compact: boolean, usage?: UsageCache, wide = false): Line[] {
  const since = (ms: number, end = now): string =>
    fmtElapsed(Math.max(0, Math.floor((end - ms) / 1000)));
  const job = (j: Activity['jobs'][number]): Line => {
    const [mark, color] = JOB_MARK[j.state];
    const end = j.ended_at ? Date.parse(j.ended_at) : now;
    const how =
      j.state === 'running' || j.state === 'lost' ? '' : ` ${j.signal ?? `exit ${String(j.exit_code)}`}`;
    return {
      text: `${mark} ${tierTag(j, compact)} job ${since(Date.parse(j.started_at), end)}${how} ${j.kind} · ${j.title}${wide ? totalFor(usage, 'job_id', j.id) : ''}`,
      color,
    };
  };
  const proc = (p: Activity['procs'][number]): Line => ({
    text: `▶ ${tierTag(p, compact)} proc ${since(p.started_ms)} ${p.kind} · ${p.cwd ? basename(p.cwd) : '?'} pid ${String(p.pid)}`,
    color: 'blue',
  });
  const under = (owner: number | null): Line[] => [
    ...a.jobs.filter(j => j.owner === owner).map(job),
    ...a.procs.filter(p => p.owner === owner).map(proc),
  ];
  const sub = (l: Line): Line => ({ ...l, text: `  └ ${l.text}` });
  // owner 只会是某个终端的 pid（同一次 ps 的会话）：挂不上的就是 null
  const orphans = [
    ...under(null),
    ...a.remote.map(r => ({
      text: `◆ remote ${r.host} ${r.agent} ${shortRemoteId(r.id)} ${r.state}`,
      color: 'magenta',
    })),
  ];
  return [
    ...a.terms.flatMap(t => [
      { text: termText(t, now, compact) + (wide ? totalFor(usage, 'id', t.session_id) : ''), color: t.state === 'busy' ? 'green' : t.state === 'idle' ? 'white' : 'gray' },
      ...under(t.pid).map(sub),
    ]),
    ...(orphans.length ? [{ text: '无主' }, ...orphans.map(sub)] : []),
    ...a.notes.map(n => ({ text: `! ${n}` })),
  ];
}

/** flexWrap 下 chips 占几行（与 ink 的贪心换行同口径，算表格还剩几行用）。 */
function wrapLines(items: string[], width: number): number {
  let lines = 1;
  let x = 0;
  for (const it of items) {
    const w = Bun.stringWidth(it);
    if (x > 0 && x + 1 + w > width) {
      lines++;
      x = w;
    } else x += (x > 0 ? 1 : 0) + w;
  }
  return lines;
}

const HELP = [
  'q 退出',
  'r 立即刷新',
  'j/k 或 ↑/↓ 选择',
  'Enter(⏎) 打开/关闭详情',
  'a 只看活动(running/held)',
  '? 打开/关闭本说明',
];

function Row({
  r,
  sel,
  lay,
  now,
  tokens = '',
}: {
  r: BoardRow;
  sel: boolean;
  lay: Layout;
  now: number;
  tokens?: string;
}): ReactElement {
  const { w } = lay;
  const role = `(${nodeRole(r)})`; // 角色后缀总要留下：只截节点名（cell 自身另占 1 格分隔）
  const room = Math.max(1, lay.current - 1 - Bun.stringWidth(role));
  const current = r.nodes.current ? `${pad(r.nodes.current, room).trimEnd()}${role}` : '-';
  const nodes = !r.nodes.total
    ? '-'
    : lay.wide
      ? bar(r.nodes.done, r.nodes.total)
      : `${String(r.nodes.done)}/${String(r.nodes.total)}`;
  const rest = [
    cell(nodes, w.nodes),
    cell(current, lay.current),
    cell(fmtElapsed(elapsedAt(r, now)), w.elapsed),
    cell(reason(r), w.reason),
    cell(r.auto_retries ? `${String(r.recoveries)}+${String(r.auto_retries)}` : String(r.recoveries), w.rec),
  ];
  return (
    <Box flexDirection="column">
      <Text inverse={sel} wrap="truncate">
        {cell(r.run_id, w.id)}
        <Text color={colorOf(r.state)} dimColor={r.state === 'unreadable'}>
          {cell(`${r.stale ? '~' : ''}${r.state}`, w.state)}
        </Text>
        {rest.join('')}
        {lay.wide ? `${cell(r.console, w.console)}${pad(`${r.repo}@${r.branch}`, REPO_MIN)}` : ''}
        {tokens}
      </Text>
      {r.nodes.current && lay.current < Bun.stringWidth(role) + 3 ? <Text dimColor wrap="truncate">{`  cur: ${nodeRole(r)} · ${r.nodes.current}`}</Text> : null}
    </Box>
  );
}

export interface FrameProps {
  snap: Snapshot;
  home: string;
  width: number;
  height: number;
  interval: number;
  sel: number;
  activeOnly: boolean;
  detail: Detail | null;
  now: Date;
  footer: boolean;
  /** 完整按键说明（`?`）。 */
  help?: boolean;
}

export function Frame(p: FrameProps): ReactElement {
  const rows = p.activeOnly ? p.snap.rows.filter(ACTIVE) : p.snap.rows;
  const reserved = p.width >= 120 ? Math.max(0, ...rows.map(r => Bun.stringWidth(totalFor(p.snap.usage, 'run_id', r.run_id)))) : 0;
  let lay = layout(p.width - reserved);
  if (reserved && lay.current < Math.max(0, ...rows.map(r => Bun.stringWidth(nodeRole(r)) + 7)))
    lay = { compact: false, wide: false, w: WIDTHS.narrow, current: Math.min(30, p.width - reserved - sum(WIDTHS.narrow)) };
  const now = p.now.getTime();
  let { w } = lay;
  if (lay.compact) {
    const id = rows.every(r => shortId(r.run_id, now).length <= 11) ? 12 : 17;
    w = { ...w, id, reason: Math.max(0, p.width - sum({ ...w, id })) };
  }
  const count = (f: (r: BoardRow) => boolean): number => p.snap.rows.filter(f).length;
  const act = p.snap.activity;
  const chips: [string, string][] = [
    [`[running ${String(count(r => r.state === 'running'))}]`, 'cyan'],
    [`[held ${String(count(r => r.state.startsWith('held:')))}]`, 'yellow'],
    [`[failed ${String(count(r => r.state === 'failed'))}]`, 'red'],
    [`[completed ${String(count(r => r.state === 'completed'))}]`, 'green'],
    [`[cancelled ${String(count(r => r.state === 'cancelled'))}]`, 'gray'],
  ];
  const s = p.snap.summary;
  // 各档运行中的数目：执行中的终端 + 运行中的作业 + 无头进程（推断的也算）
  const busy = act
    ? [...act.terms.filter(t => t.state === 'busy'), ...act.jobs.filter(j => j.state === 'running'), ...act.procs]
    : [];
  if (act)
    chips.push(
      ...TIERS.map((k): [string, string] => { const models = busy.filter(x => x.tier === k).map(x => shortModel(x.model, true)).filter(Boolean); const ms = [...new Set(models)].sort((a, b) => models.filter(m => m === b).length - models.filter(m => m === a).length); return [`[${TIER_ZH[k]} ${String(busy.filter(x => x.tier === k).length)}${ms.length ? `·${ms[0]}${ms.length > 1 ? `+${String(ms.length - 1)}` : ''}` : ''}]`, 'green']; }),
      [`[remote ${String(act.remote.length)}]`, 'magenta']
    );
  chips.push(
    [`debt ${String(num(s.debt))}`, ''],
    [`· first_pass ${String(num(s.first_pass))}`, ''],
    [`· every ${String(p.interval)}s`, ''],
    [`· last ${fmtClock(p.snap.at, now)}`, '']
  );
  if (p.activeOnly) chips.push(['· active only', '']);
  const usage = p.snap.usage, today = new Date(now).toLocaleDateString('sv-SE');
  if (usage) chips.push([usage.status === 'ok' ? `tok 今日 ${fmtTokens(usage.daily.filter(d => d.day === today).reduce((n, d) => n + d.total, 0))}` : 'tok 用量未知', '']);
  const alines = act ? activityLines(act, now, lay.compact, usage, p.width >= 120) : [];
  if (act && !busy.length && !act.remote.length && !p.snap.rows.some(ACTIVE))
    alines.push({ text: `空闲 · 无运行中的 run/作业 · 刷新 ${fmtClock(p.snap.at, now)}` });
  const d = p.detail;
  const dlines = d
    ? detailLines(
        d,
        now,
        p.snap.rows.find(r => r.run_id === d.run_id)
      )
    : [];
  const help = p.help ? HELP : [];
  const loadError = typeof s.load_error === 'string' ? s.load_error : null;
  // 标题 1 行 + chips（会换行）+ 活动区 + 列名 1 行 + footer；其余给表格、详情与帮助
  const fixed =
    3 +
    wrapLines(
      chips.map(([t]) => t),
      p.width
    ) +
    (loadError ? 1 : 0) +
    alines.length +
    (p.footer ? 1 : 0) +
    dlines.length +
    help.length;
  let room = Math.max(3, p.height - fixed);
  // 紧凑模式下 running 行与选中行多占一行（cur: …）：按最坏情况预留
  if (lay.compact)
    room = Math.max(
      3,
      room - Math.min(Math.floor(room / 2), count(r => r.state === 'running') + 1)
    );
  const top = Math.min(Math.max(0, p.sel - room + 1), Math.max(0, rows.length - room));
  return (
    <Box flexDirection="column" width={p.width}>
      <Text wrap="truncate">
        <Text bold>superagent board</Text> {fmtClock(now, now)} · {p.home}
      </Text>
      {p.snap.web_url ? <Text>{`\x1b]8;;${p.snap.web_url}\x1b\\大看板\x1b]8;;\x1b\\${p.width >= 120 ? ` ${p.snap.web_url}` : ''}`}</Text> : null}
      {/* chips 超宽时整项换行，不截断 */}
      <Box flexWrap="wrap" columnGap={1}>
        {chips.map(([t, c]) => (
          <Text key={t} color={c || undefined}>
            {t}
          </Text>
        ))}
      </Box>
      {loadError ? (
        <Text color="red" wrap="truncate">
          {`load error: ${loadError}`}
        </Text>
      ) : null}
      {alines.map((l, i) => (
        <Text key={i} color={l.color} dimColor={!l.color} wrap="truncate">
          {l.text}
        </Text>
      ))}
      <Text bold wrap="truncate">
        {cell('id', w.id)}
        {cell('state', w.state)}
        {cell('nodes', w.nodes)}
        {lay.compact ? '' : cell('current(role)', lay.current)}
        {cell('elapsed', w.elapsed)}
        {!lay.compact
          ? cell('exit/held', w.reason)
          : w.reason > 0
            ? pad('exit/held', w.reason)
            : ''}
        {lay.compact ? '' : cell('rec', w.rec)}
        {lay.wide ? `${cell('console', w.console)}repo@branch` : ''}
      </Text>
      {rows.length === 0 ? <Text dimColor>(no runs)</Text> : null}
      {rows
        .slice(top, top + room)
        .map((r, i) =>
          lay.compact ? (
            <CompactRow key={r.run_id} r={r} sel={top + i === p.sel} w={w} now={now} />
          ) : (
            <Row key={r.run_id} r={r} sel={top + i === p.sel} lay={lay} now={now} tokens={p.width >= 120 ? totalFor(usage, 'run_id', r.run_id) : ''} />
          )
        )}
      {dlines.map((l, i) => (
        <Text key={i} wrap="truncate" dimColor={i > 0}>
          {l}
        </Text>
      ))}
      {help.map(l => (
        <Text key={l} wrap="truncate">
          {l}
        </Text>
      ))}
      {p.footer ? (
        <Text dimColor wrap="truncate">
          {lay.compact
            ? 'q r j/k ⏎ a ?'
            : 'q 退出 · r 刷新 · j/k 或 ↑/↓ 选择 · Enter 详情 · a 只看活动(running/held) · ? 帮助'}
        </Text>
      ) : null}
    </Box>
  );
}

export interface AppProps {
  load: () => Promise<Snapshot>;
  detailFor: (row: BoardRow) => Detail | null;
  first: Snapshot;
  home: string;
  interval: number;
}

export function App(p: AppProps): ReactElement {
  const { exit } = useApp();
  // ink 把它声明成 WritableStream；render() 默认就是 process.stdout（TTY），columns/rows 与 resize 都在
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ w: stdout.columns || 120, h: stdout.rows || 30 });
  const [snap, setSnap] = useState(p.first);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(new Date());
  const busy = useRef(false);

  const refresh = useCallback(() => {
    if (busy.current) return; // 上一轮查询未回不叠加：慢的 archon 不会堆出并发子进程
    busy.current = true;
    p.load()
      .then(setSnap)
      .catch((e: unknown) => {
        // 加载器已把单个 run 的失败折进行；到这里说明 runs 目录本身读不了，留在上一帧并在 summary 里可见
        setSnap(s => ({ ...s, summary: { ...s.summary, load_error: (e as Error).message } }));
      })
      .finally(() => {
        busy.current = false;
      });
  }, [p]);

  useEffect(() => {
    const t = setInterval(refresh, p.interval * 1000);
    const clock = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [refresh, p.interval]);

  useEffect(() => {
    const onResize = (): void => {
      setSize({ w: stdout.columns, h: stdout.rows });
    };
    stdout.on('resize', onResize); // Node 在 SIGWINCH 时对 TTY stdout 发 resize
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const rows = activeOnly ? snap.rows.filter(ACTIVE) : snap.rows;
  const cur = Math.min(sel, Math.max(0, rows.length - 1));
  const selected = rows.at(cur);
  const detail = useMemo(
    () => (open && selected ? p.detailFor(selected) : null),
    // snap.at：每次刷新重读详情（transcript 在长）
    [open, selected, snap.at, p]
  );

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    else if (input === 'r') refresh();
    else if (input === 'j' || key.downArrow)
      setSel(Math.min(cur + 1, Math.max(0, rows.length - 1)));
    else if (input === 'k' || key.upArrow) setSel(Math.max(cur - 1, 0));
    else if (key.return) setOpen(o => !o);
    else if (input === '?') setHelp(h => !h);
    else if (input === 'a') {
      setActiveOnly(a => !a);
      setSel(0);
    }
  });

  return (
    <Frame
      snap={snap}
      home={p.home}
      width={size.w}
      height={size.h}
      interval={p.interval}
      sel={cur}
      activeOnly={activeOnly}
      detail={detail}
      now={now}
      footer
      help={help}
    />
  );
}
