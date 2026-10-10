// board 的 Ink 界面。Frame 是纯渲染（--once 用 renderToString 出同一帧），App 只加刷新循环与按键。
import { basename } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { type Tier } from '../jobs';
import { shortModel } from '../models';
import { fmtTokens, sessionKey, type UsageCache } from '../usage';
import { visible, type Activity, type Owned } from './activity';
import type { Term } from './terminals';
import { fmtClock, fmtElapsed, type BoardRow, type Snapshot } from './data';
import { cockpit, fit, runLine } from './cockpit';
import { ProgressBar } from './ProgressBar';
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
const shortState = (s: string): string => s.startsWith('held:') ? '⏸held' : ({ running: '▶run', completed: '✓done', failed: '✗fail', cancelled: '⊘canc' }[s] ?? s.slice(0, 5));
/** 按显示宽度截断/补齐到 n 列（中文等宽字符算 2 列）。 */
function pad(s: string, n: number): string {
  const w = Bun.stringWidth;
  let out = s;
  const chars = Array.from(s);
  for (let k = chars.length; w(out) > n && k > 0; k--) out = `${chars.slice(0, k - 1).join('')}…`;
  return out + ' '.repeat(Math.max(0, n - w(out)));
}
// 四档的英文键只在这里译成中文；run 节点按工作流角色：确定性节点归引擎，wait 门归人工
const TIER_ZH: Record<Tier, string> = { commander: '元帅', general: '将军', strategist: '军师' };
const NODE_ZH: Partial<Record<string, string>> = { coder: '将军', reviewer: '军师', script: '引擎', human: '人工' };
const modelTag = (m?: string | null, compact = false): string => shortModel(m, compact) ? `·${shortModel(m, compact)}` : '';
const tierTag = (o: Pick<Owned, 'tier' | 'guess'> & { model?: string | null }, compact = false): string =>
  o.tier ? `${TIER_ZH[o.tier]}${modelTag(o.model, compact)}${o.guess ? '?' : ''}` : `?${modelTag(o.model, compact)}`;
const nodeRole = (r: BoardRow, compact = false): string => (NODE_ZH[r.nodes.currentRole ?? ''] ?? '?') + modelTag(r.model, compact);
const totalFor = (c: UsageCache | undefined, field: 'id' | 'job_id' | 'run_id', id?: string | null): string => { const xs = c?.sessions.filter(s => field === 'id' ? id && s.id === sessionKey(id) : s.owner?.[field] === id) ?? []; return xs.length ? ` tok ${fmtTokens(xs.reduce((n, s) => n + s.total, 0))}` : ''; };

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
/** 活动按唯一会话归属挂接；其余按工作目录分组。只显示身份和状态元数据；紧凑布局仅显示模型族名。 */
function activityLines(a: Activity, now: number, compact: boolean, rows: BoardRow[], width: number, usage?: UsageCache, wide = false): Line[] {
  const since = (ms: number, end = now): string =>
    fmtElapsed(Math.max(0, Math.floor((end - ms) / 1000)));
  const job = (j: Activity['jobs'][number]): Line => {
    const [mark, color] = JOB_MARK[j.state];
    const end = j.ended_at ? Date.parse(j.ended_at) : now;
    const how =
      j.state === 'running' || j.state === 'lost' ? '' : ` ${j.signal ?? `exit ${String(j.exit_code)}`}`;
    return {
      text: `${j.inferred ? '~' : ''}${mark} ${tierTag(j, compact)} job ${since(Date.parse(j.started_at), end)}${how} ${j.kind} · ${j.title}${wide ? totalFor(usage, 'job_id', j.id) : ''}`,
      color,
    };
  };
  const proc = (p: Activity['procs'][number]): Line => ({
    text: `▶ ${tierTag(p, compact)} proc ${since(p.started_ms)} ${p.kind} · ${p.cwd ? basename(p.cwd) : '?'} pid ${String(p.pid)}`,
    color: 'blue',
  });
  const runs = (a.runs ?? []).flatMap(ref => {
    const r = rows.find(r => r.run_id === ref.run_id);
    const ended = r && ['completed', 'failed', 'cancelled'].includes(r.state) ? r.span?.ended_ms ?? undefined : null;
    if (!r || !visible(ended, now)) return [];
    const role = `(${nodeRole(r)})`;
    const prefix = `▶ run ${r.run_id.replace(/^\d{8}-/, '')} ${ref.inferred ? '~' : ''}${shortState(r.state)} ${String(r.nodes.done)}/${String(r.nodes.total)} `;
    const node = pad(r.nodes.current ?? '-', Math.max(1, width - 4 - Bun.stringWidth(prefix + role))).trimEnd();
    return [{...ref, line: {text: prefix + node + role, color: colorOf(r.state)}}];
  });
  const entries = [
    ...a.jobs.filter(j => j.state === 'running' || visible(j.ended_at, now))
      .map(j => ({owner: j.owner, cwd: j.cwd, line: job(j)})),
    ...a.procs.map(p => ({owner: p.owner, cwd: p.cwd, line: proc(p)})), ...runs,
  ];
  const sub = (l: Line): Line => ({ ...l, text: `  └ ${l.text}` });
  const groups = new Map<string, Line[]>();
  for (const e of entries.filter(e => e.owner === null)) {
    const key = e.cwd ?? '?';
    groups.set(key, [...(groups.get(key) ?? []), e.line]);
  }
  return [
    ...a.terms.flatMap(t => [
      { text: termText(t, now, compact) + (wide ? totalFor(usage, 'id', t.session_id) : ''), color: t.state === 'busy' ? 'green' : t.state === 'idle' ? 'white' : 'gray' },
      ...entries.filter(e => e.owner === t.pid).map(e => sub(e.line)),
    ]),
    ...[...groups].flatMap(([cwd, lines]) => [{text: basename(cwd) || cwd}, ...lines.map(sub)]),
    ...(a.remote.length ? [{text: 'remote'}, ...a.remote.map(r => sub({text: `◆ remote ${r.host} ${r.agent} ${shortRemoteId(r.id)} ${r.state}`, color: 'magenta'}))] : []),
    ...a.notes.map(n => ({ text: `! ${n}` })),
  ];
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
  view?: 'cockpit' | 'terminals';
  all?: boolean;
}

export function Frame(p: FrameProps): ReactElement {
  const now = p.now.getTime(), c = cockpit(p.snap, now), lines: { text: string; id?: string; content?: ReactElement }[] = [];
  const add = (text: string, id?: string): void => { lines.push({ text: fit(text, p.width), id }); };
  const section = (title: string): void => add(`━ ${title} ${'━'.repeat(Math.max(0, p.width - Bun.stringWidth(title) - 4))}`);
  if (p.view === 'terminals') {
    section('终端');
    for (const l of p.snap.activity ? activityLines(p.snap.activity, now, p.width < 80, p.snap.rows, p.width, p.snap.usage, p.width >= 120) : []) add(l.text);
  } else {
    const m = c.metrics;
    add(`今日 达成 ${String(m.completed)}/${String(m.decided)} · 一次通过 ${String(m.firstPass)} · 人工介入 ${String(m.asks)} · 评审债 ${String(m.debt)}`);
    if (c.total) lines.push({ text: c.totalText, content: <Text>总 <ProgressBar progress={c.total} width={Math.min(p.width - 3, p.width >= 100 ? 30 : p.width)} prefix={`${String(c.active.length)} run · `}/></Text> });
    add(`tok 今日 ${c.tokens}  ${c.roleTokens.join('  ')}`);
    if (c.needs.length) {
      section(`需要你 ${String(c.needs.length)}`);
      for (const r of c.needs) { const suffix = ` ${r.question} ${r.waiting}`; add(`${fit(`? ${r.project} ${r.title}`, Math.max(1, p.width - Bun.stringWidth(suffix)))}${suffix}`, r.id); }
    }
    section(`进行中 ${String(c.active.length)}`);
    for (const r of c.active) {
      add(runLine(r, p.width), r.id);
      const before = `  ${r.stage} `, after = ` ${r.role}`, available = p.width - Bun.stringWidth(before + after);
      lines.push({ text: '', id: r.id, content: <Text>{before}<ProgressBar progress={r.progress} width={Math.min(p.width >= 100 ? 30 : available, available)} />{after}</Text> });
    }
    if (c.jobs) add(c.jobs);
    section('今日结果');
    for (const r of c.results.slice(0, p.all ? undefined : 5)) add(runLine(r, p.width, true), r.id);
    if (!p.all && c.results.length > 5) add(`… 另 ${String(c.results.length - 5)} 条（a 展开）`);
    add(c.terminals);
  }
  if (typeof p.snap.summary.load_error === 'string') add(`载入失败：${p.snap.summary.load_error}`);
  if (p.detail) for (const l of detailLines(p.detail, now, p.snap.rows.find(r => r.run_id === p.detail?.run_id))) add(l);
  if (p.help) add('j/k ↑/↓ 选择 · r 刷新 · ? 帮助');
  const selected = p.snap.rows[p.sel]?.run_id;
  const room = Math.max(1, p.height - 1 - (p.footer ? 1 : 0));
  const index = lines.findIndex(l => l.id === selected), top = Math.max(0, index - room + 2);
  return <Box flexDirection="column" width={p.width}>
    <Text wrap="truncate">{`superagent ${fmtClock(now, now)} · 心跳 ${c.heartbeat} · `}{p.snap.web_url ? `\x1b]8;;${p.snap.web_url}\x1b\\大看板↗\x1b]8;;\x1b\\` : '大看板'}</Text>
    {lines.slice(top, top + room).map((l, i) => <Text key={i} wrap="truncate" inverse={!!l.id && l.id === selected}>{l.content ?? l.text}</Text>)}
    {p.footer ? <Text dimColor wrap="truncate">⏎详情 t终端 a全部 w大看板 q退出</Text> : null}
  </Box>;
}

export interface AppProps {
  load: () => Promise<Snapshot>;
  detailFor: (row: BoardRow) => Detail | null;
  first: Snapshot;
  home: string;
  interval: number;
  view?: 'cockpit' | 'terminals';
}

export function App(p: AppProps): ReactElement {
  const { exit } = useApp();
  // ink 把它声明成 WritableStream；render() 默认就是 process.stdout（TTY），columns/rows 与 resize 都在
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ w: stdout.columns || 120, h: stdout.rows || 30 });
  const [snap, setSnap] = useState(p.first);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [view, setView] = useState(p.view ?? 'cockpit');
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

  const c = cockpit(snap, now.getTime());
  const rows = [...c.needs, ...c.active, ...c.results.slice(0, all ? undefined : 5)].flatMap(x => { const r = snap.rows.find(r => r.run_id === x.id); return r ? [r] : []; });
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
    else if (input === 't') setView(v => v === 'cockpit' ? 'terminals' : 'cockpit');
    else if (input === 'w' && snap.web_url) { const child = Bun.spawn(['open', snap.web_url], { stdout: 'ignore', stderr: 'ignore' }); void child.exited; }
    else if (input === 'a') {
      setAll(a => !a);
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
      sel={selected ? snap.rows.indexOf(selected) : -1}
      activeOnly={false}
      view={view}
      all={all}
      detail={detail}
      now={now}
      footer
      help={help}
    />
  );
}
