import { Box, Text, type TextProps } from 'ink';
import type { ReactElement } from 'react';
import {
  attentionWait,
  panelDuration,
  shortRunId,
  type PanelAttention,
  type PanelGeneralState,
  type PanelModel,
  type PanelRun,
} from '../panel';
import { fit } from './cockpit';
import { ProgressBar } from './ProgressBar';

const driftAt = (model: PanelModel, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(model.heartbeatAt)) / 1000));
const ntfyPauseNotice = (model: PanelModel): string => {
  if (!model.ntfyPaused) return '';
  const time = new Date(model.ntfyPaused.at).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return ` · ⏸ ntfy 已暂停 ${time} ${model.ntfyPaused.by ?? '来源未知'}`;
};
const age = (seconds: number | null, drift: number, recent = false): string => {
  if (seconds === null) return '未知';
  const value = seconds + drift;
  if (recent && value < 60) return '刚刚';
  return `${recent ? '≥' : ''}${panelDuration(value)}${recent ? ' 前' : ''}`;
};
const generalLabel = (run: PanelRun, drift: number): string => {
  const idle = panelDuration((run.generalDetails?.idle_s ?? 0) + drift);
  if (run.general === 'working' && run.generalDetails?.spinning) return `空转 ${idle}（在跑命令）`;
  return {
    working: '干活',
    idle: `空转 ${idle}${run.generalDetails?.waiting_command ? '（在等命令）' : ''}`,
    stalled: `停滞 ${idle}`,
    handed_back: '已交回',
    unknown: '未知',
  }[run.general];
};
const attentionLabel = (item: PanelAttention, drift: number): string =>
  item.run
    ? `${shortRunId(item.id)} · ${item.project} · ${item.text} · ${generalLabel(item.run, drift)}`
    : `${shortRunId(item.id)} · ${item.project} · ${item.text} · ${attentionWait(item, drift, ' · ')}${item.next ? ` · 下一步：${item.next}` : ''}`;
type PipelineKind = 'code' | 'verify' | 'repair' | 'review' | 'land' | 'other';
const pipelineKind = (run: PanelRun): PipelineKind => {
  if (run.stageKind === 'settle') return 'verify';
  if (run.stageKind === 'fix') return 'repair';
  if (['diff', 'gate', 'human'].includes(run.stageKind)) return 'review';
  return ['code', 'verify', 'repair', 'review', 'land'].includes(run.stageKind)
    ? (run.stageKind as PipelineKind)
    : 'other';
};
const pipeline = (run: PanelRun): { icon: string; label: string; color?: string }[] => {
  const current = pipelineKind(run);
  const base: { kind: PipelineKind; label: string }[] = [
    { kind: 'code', label: '编码' },
    { kind: 'verify', label: '验收' },
    { kind: 'review', label: '评审' },
    { kind: 'land', label: '合入' },
  ];
  if (current === 'repair') {
    const round = /-r(\d+)(?:-|$)/.exec(run.node ?? '')?.[1];
    base.splice(2, 0, { kind: 'repair', label: `修复${round ? ` r${round}` : ''}` });
  }
  const currentIndex = base.findIndex(step => step.kind === current);
  return base.map((step, index) =>
    index < currentIndex
      ? { icon: '✓', label: step.label, color: 'green' }
      : index === currentIndex
        ? { icon: '●', label: step.label, color: 'cyan' }
        : { icon: '○', label: step.label, color: 'gray' }
  );
};

function StatusMessage({
  children,
  success = false,
}: {
  children: string;
  success?: boolean;
}): ReactElement {
  return (
    <Text color={success ? 'green' : 'yellow'} wrap="truncate-end">
      {success ? '✓' : '⚠'} {children}
    </Text>
  );
}
function StateIcon({ state, now }: { state: PanelGeneralState; now: number }): ReactElement {
  if (state === 'working')
    return (
      <Text color="cyan" wrap="truncate-end">
        {['⠋', '⠙', '⠹', '⠸'][Math.floor(now / 500) % 4]}
      </Text>
    );
  const values: Record<Exclude<PanelGeneralState, 'working'>, [string, TextProps['color']]> = {
    idle: ['◐', 'yellow'],
    stalled: ['■', 'red'],
    handed_back: ['↩', 'blue'],
    unknown: ['○', 'gray'],
  };
  const [icon, color] = values[state];
  return (
    <Text color={color} wrap="truncate-end">
      {icon}
    </Text>
  );
}

function RunCard({
  run,
  width,
  compact,
  drift,
  now,
}: {
  run: PanelRun;
  width: number;
  compact: boolean;
  drift: number;
  now: number;
}): ReactElement {
  const body = (
    <>
      <Box height={1}>
        <Box flexShrink={0}>
          <StateIcon state={run.general} now={now} />
          <Text wrap="truncate-end"> </Text>
          <Text bold color="cyan" wrap="truncate-end">
            {shortRunId(run.id)}
          </Text>
        </Box>
        <Text wrap="truncate-end">
          {' '}
          · {run.project} · {run.title}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        {pipeline(run).map((step, index) => (
          <Text key={step.label} color={step.color} wrap="truncate-end">
            {index ? ' ─ ' : ''}
            {step.icon} {step.label}
          </Text>
        ))}
      </Text>
      {run.estimate.pct !== null && (
        <ProgressBar progress={run.estimate} width={Math.max(10, width - (compact ? 0 : 4))} />
      )}
      <Text wrap="truncate-end">
        已用 {age(run.elapsed_s, drift)} · 最近活动 {age(run.last_activity_s, drift, true)} · 执行者{' '}
        {run.roles.join('、')}
      </Text>
    </>
  );
  return compact ? (
    <Box width={width} flexDirection="column">
      {body}
    </Box>
  ) : (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {body}
    </Box>
  );
}

export interface HeartbeatFrameProps {
  model: PanelModel;
  quota?: string;
  now: number;
  width: number;
  rows: number;
}
const displayLines = (value: string, width: number, limit: number): string[] => {
  const lines: string[] = [];
  let rest = value;
  while (rest && lines.length < limit) {
    if (lines.length === limit - 1) return [...lines, fit(rest, width)];
    let line = '',
      offset = 0;
    for (const character of rest) {
      if (Bun.stringWidth(line + character) > width) break;
      line += character;
      offset += character.length;
    }
    if (!line) return [...lines, fit(rest, width)];
    lines.push(line);
    rest = rest.slice(offset);
  }
  return lines;
};
const wrappedLines = (value: string, width: number): string[] => {
  const lines: string[] = [];
  let rest = value;
  while (rest) {
    let line = '',
      offset = 0;
    for (const character of rest) {
      if (Bun.stringWidth(line + character) > width) break;
      line += character;
      offset += character.length;
    }
    if (!line) return [...lines, fit(rest, width)];
    lines.push(line);
    rest = rest.slice(offset);
  }
  return lines;
};
function MobileHeartbeatFrame({ model, now, width, rows }: HeartbeatFrameProps): ReactElement {
  const drift = driftAt(model, now),
    availableRows = Math.max(0, rows - 1),
    staleLines = model.health.stale ? wrappedLines(model.health.stale.message, width) : [],
    staleRows = Math.min(availableRows, staleLines.length),
    bodyBudget = Math.max(0, availableRows - staleRows),
    attention = model.attention.at(0),
    current = model.attention.find(item => item.run)?.run ?? model.runs.at(0),
    checkedAge = Math.max(0, Math.floor((now - Date.parse(model.checkedAt)) / 1000)),
    clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
    health = !model.health.alive
      ? '⚠ 巡检可能停了'
      : model.health.failedStages.length
        ? `⚠ 巡检运行中·${model.health.failedStages.join('、')}异常`
        : '● 巡检正常',
    headerSuffix = `${clock} · ${health}${ntfyPauseNotice(model)}`,
    projectWidth = Math.max(1, width - Bun.stringWidth(headerSuffix) - Bun.stringWidth('◆  · '));
  return (
    <Box flexDirection="column" width={width}>
      {staleLines.slice(0, staleRows).map((line, index) => (
        <Text
          key={`tick-stale-${String(index)}`}
          backgroundColor="red"
          color="white"
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
      {bodyBudget >= 1 && (
        <Text bold color="cyan" wrap="truncate-end">
          {fit(`◆ ${fit(model.projects, projectWidth)} · ${headerSuffix}`, width)}
        </Text>
      )}
      {bodyBudget >= 2 && (
        <Text
          color={
            !model.health.alive ? 'red' : model.health.failedStages.length ? 'yellow' : undefined
          }
          wrap="truncate-end"
        >
          {fit(
            `异常${String(model.health.failedStages.length)} · 数据${String(checkedAge)}s前 · 跑${String(model.stats.running)} · 等${String(model.stats.waiting)}`,
            width
          )}
        </Text>
      )}
      {bodyBudget >= 3 && (
        <Text color={attention ? 'yellow' : 'green'} wrap="truncate-end">
          {fit(
            attention ? `需处理 ⚠ ${shortRunId(attention.id)} · ${attention.text}` : '需处理 ✓ 无',
            width
          )}
        </Text>
      )}
      {bodyBudget >= 4 && model.attention.length > 1 && (
        <Text color="yellow" wrap="truncate-end">
          +{String(model.attention.length - 1)} 条需处理
        </Text>
      )}
      {bodyBudget >= 5 && (
        <Text wrap="truncate-end">
          {fit(
            current
              ? `当前 ${shortRunId(current.id)} · ${current.stage} · 已用 ${age(current.elapsed_s, drift)}`
              : '当前 暂无在跑任务',
            width
          )}
        </Text>
      )}
      {bodyBudget >= 6 && model.runs.length > 1 && (
        <Text dimColor wrap="truncate-end">
          +{String(model.runs.length - 1)} 个 run
        </Text>
      )}
    </Box>
  );
}
export function HeartbeatFrame({
  model,
  quota,
  now,
  width,
  rows,
}: HeartbeatFrameProps): ReactElement {
  width = Math.max(1, Math.floor(width));
  rows = Math.max(1, Math.floor(rows));
  if (width < 60)
    return <MobileHeartbeatFrame model={model} quota={quota} now={now} width={width} rows={rows} />;
  const drift = driftAt(model, now),
    availableRows = Math.max(0, rows - 1),
    staleLines = model.health.stale ? wrappedLines(model.health.stale.message, width) : [],
    staleRows = Math.min(availableRows, staleLines.length),
    compact = width < 60,
    columns = width >= 120 ? 2 : 1,
    cardWidth = columns === 2 ? Math.floor(width / 2) : width,
    attention = model.attention.slice(0, 5),
    attentionRows = Math.max(1, attention.length + (model.attention.length > 5 ? 1 : 0)),
    quotaPrefix = '额度：',
    quotaIndent = ' '.repeat(Bun.stringWidth(quotaPrefix)),
    quotaLines = displayLines(
      quota ?? '未配置',
      Math.max(1, width - Bun.stringWidth(quotaPrefix)),
      Math.min(2, Math.max(0, availableRows - 1))
    ).map((line, index) => fit((index ? quotaIndent : quotaPrefix) + line, width)),
    footerRows = Math.min(availableRows, 1 + quotaLines.length),
    bodyBudget = Math.max(0, availableRows - footerRows - staleRows),
    runningRows = model.runs.length ? 1 : 2,
    shownAttentionRows = Math.min(attentionRows, Math.max(0, bodyBudget - 3 - runningRows)),
    fixedBodyRows = Math.min(bodyBudget, 3 + shownAttentionRows + runningRows),
    cardRows = compact ? 4 : 6,
    cardBudget = Math.max(0, bodyBudget - fixedBodyRows - (model.runs.length ? 1 : 0)),
    capacity = width < 20 ? 0 : Math.floor(cardBudget / cardRows) * columns,
    shown = model.runs.slice(0, capacity),
    hidden = model.runs.length - shown.length,
    checkedAge = Math.max(0, Math.floor((now - Date.parse(model.checkedAt)) / 1000)),
    clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false }),
    health = !model.health.alive
      ? `⚠ 巡检可能停了：${model.health.messages.join('；')}`
      : model.health.failedStages.length
        ? `⚠ 巡检运行中 · ${model.health.failedStages.join('、')} 异常`
        : `● 巡检正常 · 巡检 ${String(checkedAge)}s 前`,
    status = `${clock} · ${health}${ntfyPauseNotice(model)}`,
    titleWidth = Math.max(0, width - Bun.stringWidth(status) - 1),
    header = titleWidth
      ? `${fit(`◆ 心跳 · ${model.projects}`, titleWidth)} ${status}`
      : fit(status, width),
    footer = fit(
      `在跑 ${String(model.stats.running)} · 等待 ${String(model.stats.waiting)} · 待回收 ${String(model.stats.reclaimPending)} · 历史遗留 ${String(model.stats.legacy)} · 巡检 ${String(checkedAge)}s 前`,
      width
    );
  return (
    <Box flexDirection="column" width={width}>
      {staleLines.slice(0, staleRows).map((line, index) => (
        <Text
          key={`tick-stale-${String(index)}`}
          backgroundColor="red"
          color="white"
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
      {bodyBudget >= 1 && (
        <Text bold color="cyan" wrap="truncate-end">
          {header}
        </Text>
      )}
      {bodyBudget >= 2 && (
        <Text wrap="truncate-end">
          <Text backgroundColor="green" color="black" wrap="truncate-end">
            {' '}
            在跑 {String(model.stats.running)}{' '}
          </Text>{' '}
          <Text backgroundColor="blue" color="black" wrap="truncate-end">
            {' '}
            等待 {String(model.stats.waiting)}{' '}
          </Text>{' '}
          <Text
            backgroundColor={model.attention.length ? 'yellow' : 'gray'}
            color="black"
            wrap="truncate-end"
          >
            {' '}
            需处理 {String(model.attention.length)}{' '}
          </Text>{' '}
          <Text backgroundColor="gray" color="black" wrap="truncate-end">
            {' '}
            待回收 {String(model.stats.reclaimPending)}{' '}
          </Text>{' '}
          <Text backgroundColor="gray" color="black" wrap="truncate-end">
            {' '}
            历史遗留 {String(model.stats.legacy)}{' '}
          </Text>
        </Text>
      )}
      {bodyBudget >= 3 && (
        <Text bold wrap="truncate-end">
          需要处理
        </Text>
      )}
      {model.heavyQueue.map(item => (
        <Text key={item.command} color="yellow" wrap="truncate-end">
          {fit(
            `⏳ 排队等重型名额 ${panelDuration(item.queued_s + drift)} · 持有者 ${item.holders.length ? item.holders.map(holder => `${fit(holder.command, 24)} (${panelDuration(holder.running_s + drift)})`).join('、') : '未知'}`,
            width
          )}
        </Text>
      ))}
      {shownAttentionRows > 0 &&
        (attention.length ? (
          attention
            .slice(0, shownAttentionRows)
            .map((item, index) => (
              <StatusMessage key={`${item.project}-${String(index)}`}>
                {attentionLabel(item, drift)}
              </StatusMessage>
            ))
        ) : (
          <StatusMessage success>无需处理</StatusMessage>
        ))}
      {model.attention.length > 5 && shownAttentionRows > attention.length && (
        <Text color="yellow" wrap="truncate-end">
          +{String(model.attention.length - 5)} 条
        </Text>
      )}
      {bodyBudget >= 4 + shownAttentionRows && (
        <Text bold wrap="truncate-end">
          进行中
        </Text>
      )}
      {!model.runs.length && bodyBudget >= 5 + shownAttentionRows && (
        <Text dimColor wrap="truncate-end">
          暂无在跑任务
        </Text>
      )}
      <Box flexWrap="wrap">
        {shown.map(run => (
          <RunCard
            key={`${run.project}-${run.id}`}
            run={run}
            width={cardWidth}
            compact={compact}
            drift={drift}
            now={now}
          />
        ))}
      </Box>
      {hidden > 0 && bodyBudget > fixedBodyRows && (
        <Text dimColor wrap="truncate-end">
          +{String(hidden)} 个 run 未显示
        </Text>
      )}
      {availableRows > 0 && (
        <Text backgroundColor="cyan" color="black" wrap="truncate-end">
          {footer}
        </Text>
      )}
      {quotaLines.map((line, index) => (
        <Text key={index} backgroundColor="cyan" color="black" wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
