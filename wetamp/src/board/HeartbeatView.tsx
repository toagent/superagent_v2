import { Box, Text, useStdout, type TextProps } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  panelDuration,
  type PanelAttention,
  type PanelGeneralState,
  type PanelModel,
  type PanelRun,
} from '../panel';
import { ProgressBar } from './ProgressBar';

const shortRunId = (id: string): string => id.replace(/^\d{8}-/, '');
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
    ? `${item.project} · ${item.text} · ${generalLabel(item.run, drift)}`
    : `${item.project} · ${item.text} · 已等 ${panelDuration((item.waited_s ?? 0) + drift)}${item.next ? ` · 下一步：${item.next}` : ''}`;

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

function Badge({
  children,
  color,
}: {
  children: ReactNode;
  color: TextProps['color'];
}): ReactElement {
  return (
    <Text backgroundColor={color} color="black">
      {' '}
      {children}{' '}
    </Text>
  );
}
function StatusMessage({
  children,
  success = false,
}: {
  children: string;
  success?: boolean;
}): ReactElement {
  return (
    <Text color={success ? 'green' : 'yellow'}>
      {success ? '✓' : '⚠'} {children}
    </Text>
  );
}
function StateIcon({ state, now }: { state: PanelGeneralState; now: number }): ReactElement {
  if (state === 'working')
    return <Text color="cyan">{['⠋', '⠙', '⠹', '⠸'][Math.floor(now / 500) % 4]}</Text>;
  const values: Record<Exclude<PanelGeneralState, 'working'>, [string, TextProps['color']]> = {
    idle: ['◐', 'yellow'],
    stalled: ['■', 'red'],
    handed_back: ['↩', 'blue'],
    unknown: ['○', 'gray'],
  };
  const [icon, color] = values[state];
  return <Text color={color}>{icon}</Text>;
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
        <StateIcon state={run.general} now={now} />
        <Text> </Text>
        <Text bold color="cyan">
          {shortRunId(run.id)}
        </Text>
        <Text wrap="truncate">
          {' '}
          · {run.project} · {run.title}
        </Text>
      </Box>
      <Box>
        {pipeline(run).map((step, index) => (
          <Text key={step.label} color={step.color}>
            {index ? ' ─ ' : ''}
            {step.icon} {step.label}
          </Text>
        ))}
      </Box>
      <ProgressBar progress={run.estimate} width={Math.max(10, width - (compact ? 0 : 4))} />
      <Text wrap="truncate">
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
export function HeartbeatFrame({
  model,
  quota,
  now,
  width,
  rows,
}: HeartbeatFrameProps): ReactElement {
  width = Math.max(1, Math.floor(width));
  rows = Math.max(1, Math.floor(rows));
  const drift = driftAt(model, now),
    compact = width < 60,
    columns = width >= 120 ? 2 : 1,
    cardWidth = columns === 2 ? Math.floor(width / 2) : width,
    attention = model.attention.slice(0, 5),
    fixedRows =
      1 + 1 + 1 + Math.max(1, attention.length + (model.attention.length > 5 ? 1 : 0)) + 2,
    cardRows = compact ? 4 : 6,
    capacity = Math.max(0, Math.floor((rows - fixedRows - 1) / cardRows) * columns),
    shown = model.runs.slice(0, capacity),
    hidden = model.runs.length - shown.length,
    dataAge = Math.max(0, Math.floor((now - Date.parse(model.heartbeatAt)) / 1000));
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          ◆ 心跳 · {model.projects}
        </Text>
        <Text>
          {new Date(now).toLocaleTimeString('zh-CN', { hour12: false })} ·{' '}
          {model.health.ok ? (
            <Text color="green">● 巡检正常 · 数据 {String(dataAge)}s 前</Text>
          ) : (
            <Text color="red">⚠ 巡检可能停了：{model.health.messages.join('；')}</Text>
          )}
        </Text>
      </Box>
      <Box gap={1}>
        <Badge color="green">在跑 {String(model.stats.running)}</Badge>
        <Badge color="blue">等待 {String(model.stats.waiting)}</Badge>
        <Badge color={model.attention.length ? 'yellow' : 'gray'}>
          需处理 {String(model.attention.length)}
        </Badge>
        <Badge color="gray">待回收 {String(model.stats.reclaimPending)}</Badge>
      </Box>
      <Text bold>需要处理</Text>
      {attention.length ? (
        attention.map((item, index) => (
          <StatusMessage key={`${item.project}-${String(index)}`}>
            {attentionLabel(item, drift)}
          </StatusMessage>
        ))
      ) : (
        <StatusMessage success>无需处理</StatusMessage>
      )}
      {model.attention.length > 5 && (
        <Text color="yellow">+{String(model.attention.length - 5)} 条</Text>
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
      {hidden > 0 && <Text dimColor>+{String(hidden)} 个 run 未显示</Text>}
      <Box flexDirection="column">
        <Text backgroundColor="cyan" color="black">
          在跑 {String(model.stats.running)} · 等待 {String(model.stats.waiting)} · 待回收{' '}
          {String(model.stats.reclaimPending)} · 数据 {String(dataAge)}s 前
        </Text>
        <Text backgroundColor="cyan" color="black">
          {quota ? `额度：${quota}` : '额度：未配置'}
        </Text>
      </Box>
    </Box>
  );
}

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
