// board 的 Ink 界面。Frame 是纯渲染（--once 用 renderToString 出同一帧），App 只加刷新循环与按键。
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { bar, fmtElapsed, type BoardRow, type Snapshot } from './data';
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
/** 宽度不足时先隐藏 console 与 repo@branch。 */
export const NARROW = 100;

const pad = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const hhmmss = (d: Date): string => d.toTimeString().slice(0, 8);

function reason(r: BoardRow): string {
  if (r.state === 'unreadable') return r.error ?? '';
  if (r.held) return r.held.event ?? r.held.node ?? '';
  return r.exit === null
    ? ''
    : `exit ${String(r.exit)}${r.nodes.current && r.exit !== 0 ? ` @${r.nodes.current}` : ''}`;
}

const COLS = [
  ['id', 21],
  ['state', 23],
  ['nodes', 13],
  ['current(role)', 24],
  ['elapsed', 8],
  ['exit/held', 20],
  ['rec', 4],
] as const;
const WIDE = [['console', 8]] as const;

function Row({ r, sel, wide }: { r: BoardRow; sel: boolean; wide: boolean }): ReactElement {
  const current = r.nodes.current ? `${r.nodes.current}(${r.nodes.currentRole ?? '?'})` : '-';
  const cells = [
    pad(r.run_id, COLS[0][1]),
    null, // state 单独着色
    pad(r.nodes.total ? bar(r.nodes.done, r.nodes.total) : '-', COLS[2][1]),
    pad(current, COLS[3][1]),
    pad(fmtElapsed(r.elapsed_s), COLS[4][1]),
    pad(reason(r), COLS[5][1]),
    pad(String(r.recoveries), COLS[6][1]),
  ];
  return (
    <Box>
      <Text inverse={sel} wrap="truncate">
        {cells[0]}
        <Text color={colorOf(r.state)} dimColor={r.state === 'unreadable'}>
          {pad(`${r.stale ? '~' : ''}${r.state}`, COLS[1][1])}
        </Text>
        {cells.slice(2).join('')}
        {wide ? `${pad(r.console, WIDE[0][1])}${r.repo}@${r.branch}` : ''}
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
}

export function Frame(p: FrameProps): ReactElement {
  const rows = p.activeOnly ? p.snap.rows.filter(ACTIVE) : p.snap.rows;
  const wide = p.width >= NARROW;
  const count = (f: (r: BoardRow) => boolean): number => p.snap.rows.filter(f).length;
  const chips: [string, number, string][] = [
    ['running', count(r => r.state === 'running'), 'cyan'],
    ['held', count(r => r.state.startsWith('held:')), 'yellow'],
    ['failed', count(r => r.state === 'failed'), 'red'],
    ['completed', count(r => r.state === 'completed'), 'green'],
    ['cancelled', count(r => r.state === 'cancelled'), 'gray'],
  ];
  const s = p.snap.summary;
  const dlines = p.detail ? detailLines(p.detail) : [];
  // 表头 2 行 + 列名 1 行 + footer 1 行；其余给表格与详情
  const room = Math.max(3, p.height - 4 - (p.footer ? 1 : 0) - dlines.length);
  const top = Math.min(Math.max(0, p.sel - room + 1), Math.max(0, rows.length - room));
  return (
    <Box flexDirection="column" width={p.width}>
      <Text wrap="truncate">
        <Text bold>superagent board</Text> {hhmmss(p.now)} · {p.home}
      </Text>
      <Text wrap="truncate">
        {chips.map(([k, n, c]) => (
          <Text key={k} color={c}>
            {`[${k} ${String(n)}] `}
          </Text>
        ))}
        {`debt ${String(num(s.debt))} · first_pass ${String(num(s.first_pass))} · every ${String(p.interval)}s · last ${p.snap.at.slice(11, 19)}Z`}
        {p.activeOnly ? ' · active only' : ''}
        {typeof s.load_error === 'string' ? (
          <Text color="red">{` · load error: ${s.load_error}`}</Text>
        ) : null}
      </Text>
      <Text bold wrap="truncate">
        {[...COLS, ...(wide ? WIDE : [])].map(([k, n]) => pad(k, n)).join('')}
        {wide ? 'repo@branch' : ''}
      </Text>
      {rows.length === 0 ? <Text dimColor>(no runs)</Text> : null}
      {rows.slice(top, top + room).map((r, i) => (
        <Row key={r.run_id} r={r} sel={top + i === p.sel} wide={wide} />
      ))}
      {dlines.map((l, i) => (
        <Text key={i} wrap="truncate" dimColor={i > 0}>
          {l}
        </Text>
      ))}
      {p.footer ? (
        <Text dimColor wrap="truncate">
          q 退出 · r 刷新 · j/k 或 ↑/↓ 选择 · Enter 详情 · a 只看活动(running/held)
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
    />
  );
}
