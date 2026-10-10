import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { fmtClock, type Snapshot } from './data';
import { cockpit, fit } from './cockpit';
import { ProgressBar } from './ProgressBar';
import { engineHash } from '../generate';

export const ENGINE_CHANGED = 75;
export const boardExitCode = (started: string, current = engineHash()): number => started === current ? 0 : ENGINE_CHANGED;
export interface FrameProps { snap: Snapshot; width: number; height: number; now: Date }
export function Frame({ snap, width, height, now }: FrameProps): ReactElement {
  const c = cockpit(snap, now.getTime()), lines: ReactElement[] = [];
  const text = (value: string, color?: string): void => { lines.push(<Text key={lines.length} color={color} wrap="truncate">{fit(value, width)}</Text>); };
  text(`superagent ${fmtClock(now.getTime(), now).slice(0, 5)} · 跑 ${String(c.active.length)} · 等你 ${String(c.needs.length)} · 今日 ${String(c.metrics.completed)}/${String(c.metrics.decided)}`);
  text('─'.repeat(width));
  for (const r of c.active) {
    text(`${fit(r.project, 12)}  ${r.title}`);
    text(`  ${r.role}  ${r.stage}`);
    lines.push(<Text key={lines.length}>  <ProgressBar progress={r.progress} width={width - 2}/></Text>);
  }
  if (!c.active.length) text('无进行中任务');
  if (c.needs.length) {
    text('─'.repeat(width));
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
