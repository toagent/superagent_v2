import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HeartbeatFrame } from '../src/board/HeartbeatView';
import { heartbeatEngineExitCode } from '../src/cli';
import { unknownProgress } from '../src/board/eta';
import { panelModel } from '../src/panel';
import type { Heartbeat, TickRecord } from '../src/heartbeat';
import { tmp } from './helpers';

const now = Date.parse('2026-10-30T12:10:00Z');
const tick: TickRecord = { at: new Date(now).toISOString() };
const heartbeat = (
  states: ('working' | 'idle' | 'stalled' | 'handed_back' | 'unknown')[]
): Heartbeat => ({
  at: new Date(now).toISOString(),
  reclaim_pending: 2,
  unowned: 0,
  unreadable: 0,
  marshals: [
    {
      owner: {
        client: 'codex',
        host: 'host',
        pid: 1,
        cwd: '/tmp',
      } as Heartbeat['marshals'][number]['owner'],
      owner_key: [],
      cwd: '/tmp',
      project: 'demo',
      line: '',
      waiting: [
        { id: 'wait', what: 'review', code: 'gate', waiting_for: '等待裁决', waited_s: 60 },
      ],
      running: states.map((state, index) => ({
        id: `20261030-run-${String(index + 1)}`,
        kind: 'run' as const,
        title: `任务${String(index + 1)}`,
        stage: '验收',
        node: 'verify-m1',
        coder: state === 'handed_back' ? false : true,
        role: '将军·gpt',
        state: 'running',
        elapsed_s: 120,
        last_activity_s: 30,
        estimate: { ...unknownProgress(), pct: 50, eta_s: 120, basis: 'linear' as const },
        ...(state === 'unknown'
          ? {}
          : { general: { state, idle_s: 120, waiting_command: false, cpu: 1 } }),
      })),
    },
  ],
});
const frame = (value: Heartbeat, width: number, rows: number, quota?: string): string =>
  renderToString(
    createElement(HeartbeatFrame, { model: panelModel(value, tick, now), quota, now, width, rows }),
    { columns: width }
  );

test('engine/current 切换返回重启码，路径缺失时不触发', () => {
  const root = tmp(),
    current = join(root, 'current'),
    a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  symlinkSync(a, current);
  const resolveCurrent = (): string | undefined => {
    try {
      return realpathSync(current);
    } catch {
      return undefined;
    }
  };
  const started = resolveCurrent();
  expect(heartbeatEngineExitCode(started, resolveCurrent)).toBe(0);
  unlinkSync(current);
  symlinkSync(b, current);
  expect(heartbeatEngineExitCode(started, resolveCurrent)).toBe(75);
  unlinkSync(current);
  expect(heartbeatEngineExitCode(started, resolveCurrent)).toBe(0);
});

test('问题置顶、验收流水线与 quota 状态栏', () => {
  const output = frame(heartbeat(['idle']), 100, 40, 'Claude 今日 $1.23');
  expect(output.indexOf('需要处理')).toBeLessThan(output.indexOf('run-1'));
  expect(output).toContain('✓ 编码');
  expect(output).toContain('● 验收');
  expect(output).toContain('○ 评审');
  expect(output.trimEnd().split('\n').at(-1)).toContain('额度：Claude 今日 $1.23');
  expect(frame(heartbeat([]), 100, 20).trimEnd().split('\n').at(-1)).toContain('额度：未配置');
});

test('状态图标完整且宽屏双列、普通宽度单列', () => {
  const states = heartbeat(['working', 'idle', 'stalled', 'handed_back', 'unknown']);
  const icons = frame(states, 100, 80);
  for (const icon of ['◐', '■', '↩', '○']) expect(icons).toContain(icon);
  const two = heartbeat(['working', 'working']);
  expect(
    frame(two, 140, 40)
      .split('\n')
      .some(line => line.includes('run-1') && line.includes('run-2'))
  ).toBe(true);
  expect(
    frame(two, 100, 40)
      .split('\n')
      .some(line => line.includes('run-1') && line.includes('run-2'))
  ).toBe(false);
});

test('长标题只截标题且未知进度不渲染进度条', () => {
  const value = heartbeat(['idle']);
  const run = value.marshals[0]!.running[0]!;
  run.id = '20261030-131700-aa87';
  run.title = '长'.repeat(80);
  for (const width of [140, 90]) {
    expect(
      frame(value, width, 40)
        .split('\n')
        .some(line => line.includes('◐ 131700-aa87'))
    ).toBe(true);
  }
  expect(frame(value, 90, 40)).toContain('▕');
  run.estimate = unknownProgress();
  const unknown = frame(value, 90, 40);
  expect(unknown).not.toContain('▕');
  expect(unknown).not.toContain('剩—');
});

test('行数不足裁剪卡片且窄屏去掉边框，状态栏仍在末尾', () => {
  const value = heartbeat(['working', 'working', 'working']);
  const short = frame(value, 100, 12, 'quota');
  expect(short).toMatch(/\+\d+ 个 run 未显示/);
  expect(short.trimEnd().split('\n').at(-1)).toContain('额度：quota');
  const narrow = frame(value, 50, 40);
  expect(narrow).not.toContain('╭');
  expect(narrow).not.toContain('╰');
});
