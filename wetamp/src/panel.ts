import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { tickHealth, type Heartbeat, type TickRecord } from './heartbeat';

type Marshal = Heartbeat['marshals'][number];
export type PanelFilter = (marshal: Marshal) => boolean;
export const allMarshals: PanelFilter = () => true;

export function cwdFilter(cwd: string): PanelFilter {
  if (!isAbsolute(cwd)) throw new Error('heartbeat --cwd requires an absolute path');
  const target = realpathSync(cwd);
  return marshal => {
    const owner = marshal.owner === 'unknown' ? undefined : (marshal.owner as { cwd?: string }).cwd;
    try {
      return realpathSync(owner ?? marshal.cwd) === target;
    } catch {
      return resolve(owner ?? marshal.cwd) === target;
    }
  };
}

const duration = (seconds: number): string => {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes === 0) return '刚刚';
  return minutes < 60
    ? `${String(minutes)}m`
    : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};
const fit = (text: string, width: number): string => {
  if (Bun.stringWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? '…' : '';
  let value = '';
  for (const character of text) {
    if (Bun.stringWidth(value + character) > width - 1) break;
    value += character;
  }
  return `${value}…`;
};
const generalState = (item: Marshal['running'][number], drift: number): string => {
  if (item.kind === 'run' && item.coder === false) return '已交回';
  const state = item.general;
  if (!state) return '未知';
  const idle = duration(state.idle_s + drift);
  return {
    working: '干活',
    idle: `空转 ${idle}${state.waiting_command ? '（在等命令）' : ''}`,
    stalled: `停滞 ${idle}`,
    handed_back: '已交回',
    unknown: '未知',
  }[state.state];
};
const shortRunId = (id: string): string => id.replace(/^\d{8}-/, '');

export function renderPanel(
  heartbeat: Heartbeat | undefined,
  tick: TickRecord | undefined,
  now: number,
  filter: PanelFilter = allMarshals,
  width = 100,
  color = false
): string {
  const health = tickHealth(tick, now),
    selected = heartbeat?.marshals.filter(filter) ?? [],
    drift = Math.max(
      0,
      Math.floor((now - Date.parse(heartbeat?.at ?? new Date(now).toISOString())) / 1000)
    ),
    projects = selected.map(item => item.project).join('、') || '无数据',
    lines = [
      `心跳面板｜${projects}｜${new Date(now).toLocaleString('zh-CN', { hour12: false })}｜${health.ok ? '巡检正常' : `⚠️ 巡检可能停了：${health.messages.join('；')}`}`,
      '',
      '需要处理',
    ];
  const attention: string[] = [];
  for (const marshal of selected) {
    for (const item of marshal.running)
      if (item.coder !== false && item.general && ['idle', 'stalled'].includes(item.general.state))
        attention.push(`${marshal.project}｜${item.title}｜${generalState(item, drift)}`);
    for (const wait of marshal.waiting)
      attention.push(
        `${marshal.project}｜${wait.waiting_for}｜已等 ${duration(wait.waited_s + drift)}${wait.next ? `｜下一步：${wait.next}` : ''}`
      );
  }
  lines.push(...(attention.length ? attention.map(item => `! ${item}`) : ['无']), '', '进行中');
  const runs = new Map<string, { marshal: Marshal; items: Marshal['running'] }>();
  for (const marshal of selected)
    for (const item of marshal.running) {
      const key = `${marshal.project}\0${item.id}`,
        found = runs.get(key);
      if (found) found.items.push(item);
      else runs.set(key, { marshal, items: [item] });
    }
  if (!runs.size) lines.push('无');
  for (const { marshal, items } of runs.values()) {
    const first = items[0],
      elapsed = first.elapsed_s === null ? '未知' : duration(first.elapsed_s + drift),
      activity =
        first.last_activity_s === null
          ? '未知'
          : first.last_activity_s + drift < 60
            ? '刚刚'
            : `≥${duration(first.last_activity_s + drift)} 前`;
    lines.push(
      `${shortRunId(first.id)}｜${marshal.project}｜${first.title}`,
      `  阶段 ${first.stage}｜执行者 ${items.map(item => item.role).join('、')}`,
      `  已用 ${elapsed}｜最近活动 ${activity}｜将军 ${generalState(first, drift)}`
    );
  }
  const running = [...runs.values()].length,
    waiting = selected.reduce((sum, item) => sum + item.waiting.length, 0);
  lines.push(
    '',
    `统计｜在跑 ${String(running)}｜等待 ${String(waiting)}｜待回收 ${String(heartbeat?.reclaim_pending ?? 0)}`
  );
  const output = lines.map(line => fit(line, Math.max(1, width)));
  return color
    ? output
        .map(line =>
          /^(?:心跳面板|需要处理|进行中|统计)/.test(line)
            ? `\x1b[1;36m${line}\x1b[0m`
            : line.startsWith('! ')
              ? `\x1b[33m${line}\x1b[0m`
              : line
        )
        .join('\n')
    : output.join('\n');
}
