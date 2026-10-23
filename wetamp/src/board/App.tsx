import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { fmtClock, fmtElapsed, type Snapshot } from './data';
import { cockpit, decisionHeader, fit } from './cockpit';
import { residentHash } from '../generate';

export const ENGINE_CHANGED = 75;
export const boardExitCode = (started: string, current = residentHash()): number =>
  started === current ? 0 : ENGINE_CHANGED;
export interface FrameProps {
  snap: Snapshot;
  width: number;
  height: number;
  now: Date;
}
export function Frame({ snap, width, height, now }: FrameProps): ReactElement {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const c = cockpit(snap, now.getTime()),
    lines: ReactElement[] = [];
  // Strip vendor styling before fit: ANSI escapes must never be split or leak into the pane.
  const clean = (s: string): string => Bun.stripANSI(s).replace(/[\r\n\t]+/g, ' ');
  const text = (value: string, color?: string, bold = false, dim = false): void => {
    lines.push(
      <Text key={lines.length} color={color} bold={bold} dimColor={dim} wrap="truncate">
        {fit(clean(value), width)}
      </Text>
    );
  };
  const jobs = snap.activity?.jobs ?? [];
  const active = c.active;
  const unverified =
    snap.rows.filter(
      r =>
        !active.some(x => x.id === r.run_id) &&
        !c.needs.some(x => x.id === r.run_id) &&
        !['completed', 'failed', 'cancelled', 'abandoned'].includes(r.state)
    ).length +
    jobs.filter(j => !active.some(r => r.id === j.id) && !['done', 'failed'].includes(j.state))
      .length;
  const alerts = [
    ...(typeof snap.summary.load_error === 'string'
      ? [`载入失败：${snap.summary.load_error}`]
      : []),
    ...c.anomalies,
    ...(snap.activity?.notes ?? []),
  ];
  const cards = active.map(r => {
    const row = snap.rows.find(x => x.run_id === r.id);
    const job = jobs.find(j => j.id === r.id);
    const disposition = row?.engine?.dispositions.at(-1);
    return {
      title: `${r.title} · ${r.project}`,
      status: `${r.stage} · ${r.progressText}`,
      detail: row
        ? `${r.node ?? r.stage} · ${disposition ? `${disposition.action} · ${disposition.reason}` : `已用 ${r.elapsed} · 第${r.round}轮`}`
        : job?.reason || `最近心跳 ${fmtClock(job?.heartbeatAt ?? '', now.getTime())}`,
      color: 'cyan',
    };
  });
  const header = { ...c, active, anomalies: alerts };
  const age = now.getTime() - Date.parse(snap.at);
  const footer = `数据 ${fmtClock(snap.at, now.getTime())} · ${Number.isFinite(age) && age >= 0 ? `${fmtElapsed(Math.floor(age / 1000))}前` : '时效未知'}`;
  // Reserve data freshness first, then alerts, decisions and live cards.
  const end = height - 1;
  if (lines.length < end)
    text(
      width >= 54
        ? decisionHeader(header)
        : `跑 ${active.length} · 等你 ${c.needs.length} · 僵死 ${c.zombies}`,
      undefined,
      true
    );
  if (width < 54 && lines.length < end)
    text(
      `${decisionHeader(header).split(' · ')[3]} · 异常 ${alerts.length}`,
      undefined,
      false,
      true
    );
  const alertSlots = Math.min(2, end - lines.length, alerts.length);
  for (let i = 0; i < alertSlots; i++) {
    const suffix =
      i === alertSlots - 1 && alerts.length > alertSlots
        ? ` (+${alerts.length - alertSlots}条)`
        : '';
    text(
      `${fit(clean(alerts[i]), Math.max(0, width - Bun.stringWidth(suffix)))}${suffix}`,
      'yellow'
    );
  }
  if (unverified && lines.length < end) text(`待核实 ${unverified} 项`, undefined, false, true);
  const bodyEnd = end;
  if (c.needs.length && lines.length < bodyEnd) {
    text('需要你', 'yellow', true);
    let shown = 0;
    for (const r of c.needs) {
      const suffix = r.decision ? ` 是=${r.decision.yes} 否=${r.decision.no} 已等${r.waiting}` : '';
      const columns = Math.floor((width - Bun.stringWidth(suffix) - 4) / 3);
      const compact = r.decision && columns >= 1;
      const decisionLines = compact
        ? 1
        : r.decision
          ? Bun.stringWidth(suffix.trim()) <= width
            ? 2
            : 3
          : 2;
      if (lines.length + decisionLines + 1 + (cards.length ? 4 : 0) > bodyEnd) break;
      if (compact) {
        const idWidth = Math.max(1, Math.floor((columns - 1) / 2));
        text(
          `? ${fit(clean(r.project), columns)}·${fit(clean(r.id), idWidth)}/${fit(clean(r.node ?? r.stage), Math.max(1, columns - idWidth - 1))}·${fit(clean(r.decision!.event), columns)}${suffix}`,
          'yellow'
        );
      } else {
        text(`? ${r.project} · ${r.decision?.event ?? r.title}`, 'yellow', true);
        if (r.decision) {
          text(
            `是=${r.decision.yes} 否=${r.decision.no}${decisionLines === 2 ? ` 已等${r.waiting}` : ''}`,
            'yellow'
          );
          if (decisionLines === 3) text(`已等${r.waiting}`, 'yellow');
        } else text(r.question, 'yellow');
      }
      shown++;
    }
    if (shown < c.needs.length && lines.length < bodyEnd)
      text(`还有 ${c.needs.length - shown} 项待决策`, 'yellow');
  }
  if (lines.length < bodyEnd)
    text(cards.length ? `任务 · ${cards.length}` : '暂无活跃任务', undefined, false, true);
  let shown = 0;
  for (const card of cards) {
    if (lines.length + 3 + (shown + 1 < cards.length ? 1 : 0) > bodyEnd) break;
    text(card.title, card.color, true);
    text(`  ${card.status}`, card.color);
    text(`  ${card.detail}`, undefined, false, true);
    shown++;
  }
  if (shown < cards.length && lines.length < bodyEnd)
    text(`还有 ${cards.length - shown} 项任务未显示`, undefined, false, true);
  text(footer, undefined, false, true);
  return (
    <Box flexDirection="column" width={width}>
      {lines}
    </Box>
  );
}

export interface AppProps {
  load: () => Promise<Snapshot>;
  first: Snapshot;
  interval: number;
  fingerprint: string;
}
export function App(p: AppProps): ReactElement {
  const { exit } = useApp(),
    stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ w: stdout.columns || 62, h: stdout.rows || 30 });
  const [snap, setSnap] = useState(p.first),
    [now, setNow] = useState(new Date()),
    busy = useRef(false);
  const refresh = useCallback(() => {
    const code = boardExitCode(p.fingerprint);
    if (code) {
      process.exitCode = code;
      exit();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    void p
      .load()
      .then(setSnap)
      .catch((e: unknown) => {
        setSnap(s => ({ ...s, summary: { ...s.summary, load_error: (e as Error).message } }));
      })
      .finally(() => {
        busy.current = false;
      });
  }, [p, exit]);
  useEffect(() => {
    const timer = setInterval(refresh, p.interval * 1000),
      clock = setInterval(() => {
        setNow(new Date());
      }, 1000);
    const resize = (): void => {
      setSize({ w: stdout.columns || 62, h: stdout.rows || 30 });
    };
    stdout.on('resize', resize);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      stdout.off('resize', resize);
    };
  }, [refresh, p.interval, stdout]);
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    else if (input === 'w' && snap.web_url) {
      const child = Bun.spawn(['open', snap.web_url], { stdout: 'ignore', stderr: 'ignore' });
      void child.exited;
    }
  });
  return <Frame snap={snap} width={size.w} height={size.h} now={now} />;
}
