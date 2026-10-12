import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Snapshot } from './data';
import { cockpit, decisionHeader, fit } from './cockpit';
import { residentHash } from '../generate';

export const ENGINE_CHANGED = 75;
export const boardExitCode = (started: string, current = residentHash()): number => started === current ? 0 : ENGINE_CHANGED;
export interface FrameProps { snap: Snapshot; width: number; height: number; now: Date }
export function Frame({ snap, width, height, now }: FrameProps): ReactElement {
  const c = cockpit(snap, now.getTime()), lines: ReactElement[] = [];
  const text = (value: string, color?: string): void => { lines.push(<Text key={lines.length} color={color} wrap="truncate">{fit(value.replace(/[\r\n]+/g, ' '), width)}</Text>); };
  text(decisionHeader(c));
  if (c.needs.length) {
    text('需要你');
    for (const r of c.needs) {
      if (!r.decision) { text(r.question, 'yellow'); continue; }
      // R1-2: reserve decisions and wait time before shortening identity/event labels.
      const suffix = ` 是=${r.decision.yes} 否=${r.decision.no} 已等${r.waiting}`;
      const columns = Math.max(1, Math.floor((width - Bun.stringWidth(suffix) - 4) / 3));
      const idWidth = Math.max(1, Math.floor((columns - 1) / 2));
      const node = `${fit(r.id, idWidth)}/${fit(r.node ?? r.stage, Math.max(1, columns - idWidth - 1))}`;
      text(`? ${fit(r.project, columns)}·${node}·${fit(r.decision.event, columns)}${suffix}`, 'yellow');
    }
  }
  for (const anomaly of c.anomalies) text(anomaly, 'yellow');
  if (c.active.length) {
    text('进行中');
    for (const r of c.active) text(`${r.project} · ${r.title} · ${r.node ? `${r.node} (${r.stage})` : r.stage} · 已用 ${r.elapsed} · ${r.progressText} · 第${r.round}轮`);
  } else text('无进行中任务');
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
