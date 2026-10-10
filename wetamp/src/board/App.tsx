import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { fmtClock, type Snapshot } from './data';
import { cockpit, fit, type Cockpit } from './cockpit';
import { ProgressBar } from './ProgressBar';
import { engineHash } from '../generate';
import { fmtTokens } from '../usage';

export const ENGINE_CHANGED = 75;
export const boardExitCode = (started: string, current = engineHash()): number => started === current ? 0 : ENGINE_CHANGED;
export interface FrameProps { snap: Snapshot; width: number; height: number; now: Date }
export function Frame({ snap, width, height, now }: FrameProps): ReactElement {
  const c = cockpit(snap, now.getTime()), lines: ReactElement[] = [];
  const text = (value: string, color?: string): void => { lines.push(<Text key={lines.length} color={color} wrap="truncate">{fit(value, width)}</Text>); };
  const budget = c.reflection ? `${fmtTokens(c.reflection.tokens)}/${fmtTokens(c.reflection.limit)}` : '—/—';
  text(width < 100 ? `跑${String(c.tree.length)} 等你${String(c.needs.length)} 僵死${String(c.zombies)} 今日${String(c.metrics.completed)}/${String(c.metrics.decided)} 反思${budget} ${fmtClock(now.getTime(), now).slice(0, 5)}` : `跑 ${String(c.tree.length)} · 等你 ${String(c.needs.length)} · 僵死 ${String(c.zombies)} · 今日 ${String(c.metrics.completed)}/${String(c.metrics.decided)} · 反思 token ${budget} · ${fmtClock(now.getTime(), now).slice(0, 5)}`, c.reflection?.yellow ? 'yellow' : undefined);
  const entry = (name: string, progress: Cockpit['tree'][number]['progress']): void => {
    const label = fit(name, Math.max(1, Math.min(36, Math.floor(width / 2))));
    lines.push(<Text key={lines.length} wrap="truncate">{label} <ProgressBar progress={progress} width={width - Bun.stringWidth(label) - 1}/></Text>);
  };
  for (const r of c.tree) {
    entry(r.project, r.progress);
    for (const [i, child] of r.children.entries()) entry(`  ${i === r.children.length - 1 ? '└─' : '├─'} ${width < 60 ? child.role.split('·')[0] : child.role} ${child.id}`, child.progress);
  }
  if (!c.tree.length) text('无进行中任务');
  if (c.needs.length) {
    text('需要你');
    for (const r of c.needs) {
      const suffix = ` ${r.question} ${r.waiting}`;
      text(`? ${fit(r.project, Math.max(1, width - Bun.stringWidth(suffix) - 3))}${suffix}`, 'yellow');
    }
  }
  if (typeof snap.summary.load_error === 'string') text(`载入失败：${snap.summary.load_error}`);
  return <Box flexDirection="column" width={width}>{lines.slice(0, Math.max(1, height))}</Box>;
}

export interface AppProps { load: () => Promise<Snapshot>; first: Snapshot; interval: number; fingerprint: string }
export function App(p: AppProps): ReactElement {
  const { exit } = useApp(), stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ w: stdout.columns || 62, h: stdout.rows || 30 });
  const [snap, setSnap] = useState(p.first), [now, setNow] = useState(new Date()), busy = useRef(false);
  const refresh = useCallback(() => {
    const code = boardExitCode(p.fingerprint);
    if (code) { process.exitCode = code; exit(); return; }
    if (busy.current) return;
    busy.current = true;
    void p.load().then(setSnap).catch((e: unknown) => {
      setSnap(s => ({ ...s, summary: { ...s.summary, load_error: (e as Error).message } }));
    }).finally(() => { busy.current = false; });
  }, [p, exit]);
  useEffect(() => {
    const timer = setInterval(refresh, p.interval * 1000), clock = setInterval(() => { setNow(new Date()); }, 1000);
    const resize = (): void => { setSize({ w: stdout.columns || 62, h: stdout.rows || 30 }); };
    stdout.on('resize', resize);
    return () => { clearInterval(timer); clearInterval(clock); stdout.off('resize', resize); };
  }, [refresh, p.interval, stdout]);
  useInput((input, key) => {
    if (input === 'q' || key.ctrl && input === 'c') exit();
    else if (input === 'w' && snap.web_url) {
      const child = Bun.spawn(['open', snap.web_url], { stdout: 'ignore', stderr: 'ignore' }); void child.exited;
    }
  });
  return <Frame snap={snap} width={size.w} height={size.h} now={now}/>;
}
