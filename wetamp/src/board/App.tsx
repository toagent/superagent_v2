// board 的 Ink 界面。Frame 是纯渲染（--once 用 renderToString 出同一帧），App 只加刷新循环与按键。
import { basename } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Activity } from './activity';
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
const pad = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

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
          {`  cur: ${r.nodes.current} · ${r.nodes.currentRole ?? '?'}`}
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

/** 活动区：登记作业、未登记的无头 AI 进程、远端队列各一行；不含 prompt/argv（来源本就没有）。 */
function activityLines(a: Activity, now: number): { text: string; color?: string }[] {
  const since = (ms: number, end = now): string =>
    fmtElapsed(Math.max(0, Math.floor((end - ms) / 1000)));
  const model = (m: string | null): string => (m ? ` ${m}` : '');
  return [
    ...a.jobs.map(j => {
      const [mark, color] = JOB_MARK[j.state];
      const end = j.ended_at ? Date.parse(j.ended_at) : now;
      const how =
        j.state === 'running' || j.state === 'lost'
          ? ''
          : ` ${j.signal ?? `exit ${String(j.exit_code)}`}`;
      return {
        text: `${mark} job ${since(Date.parse(j.started_at), end)}${how} ${j.kind}${model(j.model)} · ${j.title}`,
        color,
      };
    }),
    ...a.procs.map(p => ({
      text: `▶ proc ${since(p.started_ms)} ${p.kind}${model(p.model)} · ${p.cwd ? basename(p.cwd) : '?'} pid ${String(p.pid)}`,
      color: 'blue',
    })),
    ...a.remote.map(r => ({
      text: `◆ remote ${r.host} ${r.agent} ${r.id.slice(0, 8)} ${r.state}`,
      color: 'magenta',
    })),
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
}: {
  r: BoardRow;
  sel: boolean;
  lay: Layout;
  now: number;
}): ReactElement {
  const { w } = lay;
  const current = r.nodes.current ? `${r.nodes.current}(${r.nodes.currentRole ?? '?'})` : '-';
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
    <Box>
      <Text inverse={sel} wrap="truncate">
        {cell(r.run_id, w.id)}
        <Text color={colorOf(r.state)} dimColor={r.state === 'unreadable'}>
          {cell(`${r.stale ? '~' : ''}${r.state}`, w.state)}
        </Text>
        {rest.join('')}
        {lay.wide ? `${cell(r.console, w.console)}${r.repo}@${r.branch}` : ''}
      </Text>
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
  const lay = layout(p.width);
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
  const busyJobs = act ? act.jobs.filter(j => j.state === 'running').length + act.procs.length : 0;
  if (act)
    chips.push(
      [`[jobs ${String(busyJobs)}]`, 'cyan'],
      [`[remote ${String(act.remote.length)}]`, 'magenta']
    );
  chips.push(
    [`debt ${String(num(s.debt))}`, ''],
    [`· first_pass ${String(num(s.first_pass))}`, ''],
    [`· every ${String(p.interval)}s`, ''],
    [`· last ${fmtClock(p.snap.at, now)}`, '']
  );
  if (p.activeOnly) chips.push(['· active only', '']);
  const alines = act ? activityLines(act, now) : [];
  if (act && !busyJobs && !act.remote.length && !p.snap.rows.some(ACTIVE))
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
            <Row key={r.run_id} r={r} sel={top + i === p.sel} lay={lay} now={now} />
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
