import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { tickHealth, type Heartbeat, type TickRecord } from './heartbeat';
import { stageKind, type StageKind } from './board/cockpit';
import type { Progress } from './board/eta';

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

export const panelDuration = (seconds: number): string => {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes === 0) return '刚刚';
  return minutes < 60
    ? `${String(minutes)}m`
    : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};
export const shortRunId = (id: string): string => id.replace(/^\d{8}-/, '');
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
export type PanelGeneralState = 'working' | 'idle' | 'stalled' | 'handed_back' | 'unknown';
const generalKind = (item: Marshal['running'][number]): PanelGeneralState => {
  if (item.kind === 'run' && item.coder === false) return 'handed_back';
  return item.general?.state ?? 'unknown';
};
const generalState = (item: PanelRun, drift: number): string => {
  if (item.general === 'handed_back') return '已交回';
  if (!item.generalDetails) return '未知';
  const idle = panelDuration(item.generalDetails.idle_s + drift);
  return {
    working: '干活',
    idle: `空转 ${idle}${item.generalDetails.waiting_command ? '（在等命令）' : ''}`,
    stalled: `停滞 ${idle}`,
    handed_back: '已交回',
    unknown: '未知',
  }[item.general];
};

export interface PanelRun {
  id: string;
  project: string;
  title: string;
  stage: string;
  stageKind: StageKind;
  node?: string;
  roles: string[];
  elapsed_s: number | null;
  last_activity_s: number | null;
  estimate: Progress;
  general: PanelGeneralState;
  generalDetails?: Marshal['running'][number]['general'];
}
export interface PanelAttention {
  id: string;
  project: string;
  text: string;
  waited_s?: number;
  next?: string;
  run?: PanelRun;
}
export interface PanelModel {
  heartbeatAt: string;
  health: ReturnType<typeof tickHealth>;
  projects: string;
  attention: PanelAttention[];
  runs: PanelRun[];
  stats: { running: number; waiting: number; reclaimPending: number; legacy: number };
}

export function panelModel(
  heartbeat: Heartbeat | undefined,
  tick: TickRecord | undefined,
  now: number,
  filter: PanelFilter = allMarshals,
  scopeLabel = '全部项目'
): PanelModel {
  const selected = heartbeat?.marshals.filter(filter) ?? [];
  const grouped = new Map<string, { marshal: Marshal; items: Marshal['running'] }>();
  for (const marshal of selected)
    for (const item of marshal.running) {
      const key = `${marshal.project}\0${item.id}`;
      const found = grouped.get(key);
      if (found) found.items.push(item);
      else grouped.set(key, { marshal, items: [item] });
    }
  const runs = [...grouped.values()].map(({ marshal, items }): PanelRun => {
    const first = items[0];
    return {
      id: first.id,
      project: marshal.project,
      title: first.title,
      stage: first.stage,
      stageKind: stageKind(first.node),
      ...(first.node ? { node: first.node } : {}),
      roles: items.map(item => item.role),
      elapsed_s: first.elapsed_s,
      last_activity_s: first.last_activity_s,
      estimate: first.estimate,
      general: generalKind(first),
      ...(first.general ? { generalDetails: first.general } : {}),
    };
  });
  const byRun = new Map(runs.map(run => [`${run.project}\0${run.id}`, run]));
  const attention: PanelAttention[] = [];
  for (const marshal of selected) {
    for (const item of marshal.running)
      if (
        item.coder !== false &&
        item.general &&
        ['idle', 'stalled'].includes(item.general.state)
      ) {
        const run = byRun.get(`${marshal.project}\0${item.id}`);
        if (!run) continue;
        attention.push({ id: item.id, project: marshal.project, text: item.title, run });
      }
    for (const wait of marshal.waiting)
      attention.push({
        id: wait.id,
        project: marshal.project,
        text: wait.waiting_for,
        waited_s: wait.waited_s,
        ...(wait.next ? { next: wait.next } : {}),
      });
  }
  return {
    heartbeatAt: heartbeat?.at ?? new Date(now).toISOString(),
    health: tickHealth(tick, now),
    projects: selected.map(item => item.project).join('、') || scopeLabel,
    attention,
    runs,
    stats: {
      running: runs.length,
      waiting: selected.reduce((sum, item) => sum + item.waiting.length, 0),
      reclaimPending: heartbeat?.reclaim_pending ?? 0,
      legacy: heartbeat?.legacy ?? 0,
    },
  };
}

const driftAt = (model: PanelModel, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(model.heartbeatAt)) / 1000));

/*
 * Keep the text projection byte-compatible: scripts consume it while the TTY view uses the
 * same structured model below.
 */
export function renderPanel(
  heartbeat: Heartbeat | undefined,
  tick: TickRecord | undefined,
  now: number,
  filter: PanelFilter = allMarshals,
  width = 100,
  color = false,
  scopeLabel = '全部项目'
): string {
  const model = panelModel(heartbeat, tick, now, filter, scopeLabel),
    drift = driftAt(model, now),
    lines = [
      `心跳面板｜${model.projects}｜${new Date(now).toLocaleString('zh-CN', { hour12: false })}｜${model.health.ok ? '巡检正常' : `⚠️ 巡检可能停了：${model.health.messages.join('；')}`}`,
      '',
      '需要处理',
    ];
  lines.push(
    ...(model.attention.length
      ? model.attention.map(item =>
          item.run
            ? `! ${shortRunId(item.id)}｜${item.project}｜${item.text}｜${generalState(item.run, drift)}`
            : `! ${shortRunId(item.id)}｜${item.project}｜${item.text}｜已等 ${panelDuration((item.waited_s ?? 0) + drift)}${item.next ? `｜下一步：${item.next}` : ''}`
        )
      : ['无']),
    '',
    '进行中'
  );
  if (!model.runs.length) lines.push('暂无在跑任务');
  for (const run of model.runs) {
    const elapsed = run.elapsed_s === null ? '未知' : panelDuration(run.elapsed_s + drift),
      activity =
        run.last_activity_s === null
          ? '未知'
          : run.last_activity_s + drift < 60
            ? '刚刚'
            : `≥${panelDuration(run.last_activity_s + drift)} 前`;
    lines.push(
      `${shortRunId(run.id)}｜${run.project}｜${run.title}`,
      `  阶段 ${run.stage}｜执行者 ${run.roles.join('、')}`,
      `  已用 ${elapsed}｜最近活动 ${activity}｜将军 ${generalState(run, drift)}`
    );
  }
  lines.push(
    '',
    `统计｜在跑 ${String(model.stats.running)}｜等待 ${String(model.stats.waiting)}｜待回收 ${String(model.stats.reclaimPending)}｜历史遗留 ${String(model.stats.legacy)}（需确认）`
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
