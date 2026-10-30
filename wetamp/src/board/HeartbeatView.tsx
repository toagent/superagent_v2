import { Box, Text, useStdout, type TextProps } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
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
const age = (seconds: number | null, drift: number, recent = false): string => {
  if (seconds === null) return '未知';
  const value = seconds + drift;
  if (recent && value < 60) return '刚刚';
  return `${recent ? '≥' : ''}${panelDuration(value)}${recent ? ' 前' : ''}`;
};
const generalLabel = (run: PanelRun, drift: number): string => {
  const idle = panelDuration((run.generalDetails?.idle_s ?? 0) + drift);
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
    : `${shortRunId(item.id)} · ${item.project} · ${item.text} · 已等 ${panelDuration((item.waited_s ?? 0) + drift)}${item.next ? ` · 下一步：${item.next}` : ''}`;
const attentionReason = (item: PanelAttention, drift: number): string =>
  item.run
    ? `${item.text} · ${generalLabel(item.run, drift)}`
    : `${item.text} · 已等 ${panelDuration((item.waited_s ?? 0) + drift)}${item.next ? ` · 下一步：${item.next}` : ''}`;

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
const mobilePipeline = (run: PanelRun): string => {
  const current = pipelineKind(run),
    currentPhase = current === 'repair' ? 'verify' : current,
    phases: { kind: PipelineKind; label: string }[] = [
      { kind: 'code', label: '编' },
      { kind: 'verify', label: '验' },
      { kind: 'review', label: '评' },
      { kind: 'land', label: '合' },
    ],
    currentIndex = phases.findIndex(phase => phase.kind === currentPhase),
    round = /-r(\d+)(?:-|$)/.exec(run.node ?? '')?.[1];
  return phases
    .map((phase, index) => {
      const icon = index < currentIndex ? '✓' : index === currentIndex ? '●' : '○';
      const label = current === 'repair' && phase.kind === 'verify' ? `修${round ? `r${round}` : ''}` : phase.label;
      return `${icon}${label}`;
    })
    .join(' ');
};
const shortRoles = (roles: string[]): string =>
  [...new Set(roles.map(role => role.split('·')[0] ?? role))].join('、');

function MobileRunCard({
  run,
  width,
  drift,
  now,
}: {
  run: PanelRun;
  width: number;
  drift: number;
  now: number;
}): ReactElement {
  return (
    <Box width={width} flexDirection="column">
      <Box height={1}>
        <StateIcon state={run.general} now={now} />
        <Text wrap="truncate-end">
          {' '}
          {shortRunId(run.id)} · 已用 {age(run.elapsed_s, drift)}
        </Text>
      </Box>
      <Text wrap="truncate-end">{fit(run.title, width)}</Text>
      <Text wrap="truncate-end">
        {fit(`${mobilePipeline(run)} · ${shortRoles(run.roles)}`, width)}
      </Text>
    </Box>
  );
}

function MobileHeartbeatFrame({
  model,
  quota,
  now,
  width,
  rows,
}: HeartbeatFrameProps): ReactElement {
  const drift = driftAt(model, now),
    availableRows = Math.max(0, rows - 1),
    quotaPrefix = '额度：',
    quotaIndent = ' '.repeat(Bun.stringWidth(quotaPrefix)),
    quotaWidth = Math.max(1, width - Bun.stringWidth(quotaPrefix)),
    completeQuotaLines = wrappedLines(quota ?? '未配置', quotaWidth),
    quotaLimit = Math.min(3, Math.max(0, availableRows - 1)),
    quotaValueLines =
      completeQuotaLines.length <= quotaLimit
        ? completeQuotaLines
        : displayLines(quota ?? '未配置', quotaWidth, Math.min(2, quotaLimit)),
    quotaLines = quotaValueLines.map((line, index) =>
      fit((index ? quotaIndent : quotaPrefix) + line, width)
    ),
    footerRows = Math.min(availableRows, 1 + quotaLines.length),
    bodyBudget = Math.max(0, availableRows - footerRows),
    attention = model.attention.slice(0, 5),
    runningReserve = 1 + (model.runs.length ? 3 : 1),
    attentionBudget = Math.max(0, bodyBudget - 4 - runningReserve),
    attentionCount = attention.length ? Math.min(attention.length, Math.floor(attentionBudget / 2)) : 0,
    attentionOverflow =
      model.attention.length > attentionCount && attentionBudget - attentionCount * 2 > 0,
    shownAttentionRows = attention.length
      ? attentionCount * 2 + (attentionOverflow ? 1 : 0)
      : Math.min(1, attentionBudget),
    fixedRows = 4 + shownAttentionRows + 1 + (model.runs.length ? 0 : 1),
    cardBudget = Math.max(0, bodyBudget - fixedRows),
    capacity = Math.floor(cardBudget / 3),
    shown = model.runs.slice(0, capacity),
    hidden = model.runs.length - shown.length,
    showHidden = hidden > 0 && cardBudget - shown.length * 3 > 0,
    checkedAge = Math.max(0, Math.floor((now - Date.parse(model.checkedAt)) / 1000)),
    clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
    health = model.health.ok ? `● 正常 · 巡检 ${String(checkedAge)}s 前` : '⚠ 巡检可能停了';
  return (
    <Box flexDirection="column" width={width}>
      {bodyBudget >= 1 && (
        <Text bold color="cyan" wrap="truncate-end">
          {fit(`◆ 心跳 · ${model.projects}`, width)}
        </Text>
      )}
      {bodyBudget >= 2 && (
        <Text color={model.health.ok ? undefined : 'red'} wrap="truncate-end">
          {fit(`${clock} ${health}`, width)}
        </Text>
      )}
      {bodyBudget >= 3 && (
        <Text wrap="truncate-end">
          跑{String(model.stats.running)} 等{String(model.stats.waiting)}{' '}
          <Text color={model.attention.length ? 'yellow' : undefined} wrap="truncate-end">
            需{String(model.attention.length)}
          </Text>{' '}
          收{String(model.stats.reclaimPending)} 遗{String(model.stats.legacy)}
        </Text>
      )}
      {bodyBudget >= 4 && (
        <Text bold wrap="truncate-end">
          需要处理
        </Text>
      )}
      {attention.length ? (
        attention.slice(0, attentionCount).map((item, index) => (
          <Box key={`${item.project}-${String(index)}`} flexDirection="column" height={2}>
            <Text color="yellow" wrap="truncate-end">
              {fit(`⚠ ${shortRunId(item.id)} · ${item.project}`, width)}
            </Text>
            <Text color="yellow" wrap="truncate-end">
              {fit(`  ${attentionReason(item, drift)}`, width)}
            </Text>
          </Box>
        ))
      ) : shownAttentionRows ? (
        <StatusMessage success>无需处理</StatusMessage>
      ) : null}
      {attentionOverflow && (
        <Text color="yellow" wrap="truncate-end">
          +{String(model.attention.length - attentionCount)} 条
        </Text>
      )}
      {bodyBudget >= 5 + shownAttentionRows && (
        <Text bold wrap="truncate-end">
          进行中
        </Text>
      )}
      {!model.runs.length && bodyBudget >= 6 + shownAttentionRows && (
        <Text dimColor wrap="truncate-end">
          暂无在跑任务
        </Text>
      )}
      {shown.map(run => (
        <MobileRunCard key={`${run.project}-${run.id}`} run={run} width={width} drift={drift} now={now} />
      ))}
      {showHidden && (
        <Text dimColor wrap="truncate-end">
          +{String(hidden)} 个 run 未显示
        </Text>
      )}
      {availableRows > 0 && (
        <Text backgroundColor="cyan" color="black" wrap="truncate-end">
          {fit(`巡检 ${String(checkedAge)}s 前`, width)}
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
export function HeartbeatFrame({
  model,
  quota,
  now,
  width,
  rows,
}: HeartbeatFrameProps): ReactElement {
  width = Math.max(1, Math.floor(width));
  rows = Math.max(1, Math.floor(rows));
  if (width < 60) return <MobileHeartbeatFrame model={model} quota={quota} now={now} width={width} rows={rows} />;
  const drift = driftAt(model, now),
    availableRows = Math.max(0, rows - 1),
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
    bodyBudget = Math.max(0, availableRows - footerRows),
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
    health = model.health.ok
      ? `● 巡检正常 · 巡检 ${String(checkedAge)}s 前`
      : `⚠ 巡检可能停了：${model.health.messages.join('；')}`,
    status = `${clock} · ${health}`,
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

interface ResizeSource {
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}
export const registerHeartbeatResizeClear = (
  stdout: ResizeSource,
  clear: () => void
): (() => void) => {
  stdout.on('resize', clear);
  return () => stdout.off('resize', clear);
};

export interface HeartbeatViewProps {
  initial: PanelModel;
  load: () => PanelModel;
  initialQuota?: string;
  loadQuota: () => string | undefined;
}
export function HeartbeatView({
  initial,
  load,
  initialQuota,
  loadQuota,
}: HeartbeatViewProps): ReactElement {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [model, setModel] = useState(initial),
    [quota, setQuota] = useState(initialQuota),
    [now, setNow] = useState(Date.now()),
    [size, setSize] = useState({ width: stdout.columns || 100, rows: stdout.rows || 30 }),
    fingerprint = useRef(JSON.stringify(initial));
  const refresh = useCallback(() => {
    const next = load(),
      serialized = JSON.stringify(next);
    if (serialized !== fingerprint.current) {
      fingerprint.current = serialized;
      setModel(next);
    }
  }, [load]);
  useEffect(() => {
    const dataTimer = setInterval(refresh, 15_000),
      clockTimer = setInterval(() => setNow(Date.now()), 500),
      quotaTimer = setInterval(() => setQuota(loadQuota()), 300_000),
      resize = (): void => setSize({ width: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', resize);
    return () => {
      clearInterval(dataTimer);
      clearInterval(clockTimer);
      clearInterval(quotaTimer);
      stdout.off('resize', resize);
    };
  }, [loadQuota, refresh, stdout]);
  return (
    <HeartbeatFrame model={model} quota={quota} now={now} width={size.width} rows={size.rows} />
  );
}
