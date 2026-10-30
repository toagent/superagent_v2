import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { HeartbeatFrame, registerHeartbeatResizeClear } from '../src/board/HeartbeatView';
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
const frame = (
  value: Heartbeat | undefined,
  width: number,
  rows: number,
  quota?: string,
  scopeLabel?: string,
  currentTick: TickRecord | null = tick
): string =>
  renderToString(
    createElement(HeartbeatFrame, {
      model: panelModel(value, currentTick ?? undefined, now, undefined, scopeLabel),
      quota,
      now,
      width,
      rows,
    }),
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
  expect(output.split('\n').find(line => line.includes('任务1'))).toContain('run-1');
  expect(output.trimEnd().split('\n').at(-1)).toContain('额度：Claude 今日 $1.23');
  expect(frame(heartbeat([]), 100, 20).trimEnd().split('\n').at(-1)).toContain('额度：未配置');
});

test('标题与状态栏按巡检时间显示新鲜度，tick 缺失时回退心跳时间', () => {
  const old = heartbeat([]);
  old.at = new Date(now - 6 * 60_000).toISOString();
  const fresh = frame(old, 100, 20, undefined, undefined, {
    at: new Date(now - 30_000).toISOString(),
  });
  expect(fresh.match(/巡检 30s 前/g)).toHaveLength(2);
  expect(fresh).not.toContain('数据 360s 前');
  expect(frame(old, 100, 20, undefined, undefined, null)).toContain('巡检 360s 前');
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

test('长项目名与额度在各尺寸下不超宽高预算', () => {
  const value = heartbeat(['working', 'idle', 'stalled']);
  value.marshals[0]!.project = '.bestifa-land-wt-项目'.repeat(8);
  const quota =
    '⚠️ Codex 超 $500 · Claude 今日 $423.10 · （2/2 可用） | Codex 今日 $810.46 · 5h 余 100% · 7d 余 36% · （3/4 可用）'.repeat(
      2
    );
  const clock = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
  for (const columns of [50, 78, 100, 140]) {
    for (const rows of [16, 30]) {
      const lines = frame(value, columns, rows, quota).split('\n');
      expect(lines.every(line => Bun.stringWidth(Bun.stripANSI(line)) <= columns)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows - 1);
      if (columns < 60) {
        expect(lines[1]).toContain(clock.slice(0, 5));
        expect(lines[1]).toContain('巡检');
      } else {
        expect(lines[0]).toContain(clock);
        expect(lines[0]).toContain('巡检正常');
      }
      expect(lines.slice(-2).filter(line => line.includes('额度：'))).toHaveLength(1);
    }
  }
  const realQuota =
    '⚠️ Codex 超 $500 · Claude 今日 $425.48 · （2/2 可用） | Codex 今日 $814.83 · 5h 余 100% · 7d 余 36% · （3/4 可用）';
  const quotaLines = frame(value, 78, 30, realQuota).trimEnd().split('\n').slice(-2);
  expect(quotaLines[1]).not.toContain('额度：');
  expect(quotaLines.map(line => Bun.stringWidth(line) <= 78)).toEqual([true, true]);
  expect(quotaLines[0]!.replace('额度：', '') + quotaLines[1]!.trimStart()).toBe(realQuota);
  const empty = frame(undefined, 100, 20, undefined, 'BestIFA');
  expect(empty).toContain('◆ 心跳 · BestIFA');
  expect(empty).toContain('暂无在跑任务');
});

test('手机宽度使用两行标题、短徽标、两行提醒、三行卡片与无损额度折行', () => {
  const value = heartbeat(['idle']);
  value.marshals[0]!.project = 'superagent_v2';
  value.marshals[0]!.running[0]!.title = '编码未在预期时间内完成';
  const quota = '⚠️ Codex 超 $500 · Claude 今日 $80.12 · （2/2 可用） | Codex 今日 $810.46';
  for (const columns of [36, 40, 50]) {
    for (const rows of [24, 40]) {
      const lines = frame(value, columns, rows, quota).split('\n').map(Bun.stripANSI);
      expect(lines[0]).toContain('◆ 心跳 · superagent_v2');
      expect(lines[1]).toContain('巡检');
      expect(lines.find(line => /跑1.*等1.*需2.*收2.*遗0/.test(line))).toBeDefined();
      const attention = lines.findIndex(line => line.includes('run-1 · superagent_v2'));
      expect(attention).toBeGreaterThan(0);
      expect(lines[attention + 1]).toContain('编码未在预期时间内完成');
      const card = lines.findIndex(line => line.includes('◐ run-1 · 已用'));
      expect(card).toBeGreaterThan(attention);
      expect(lines[card + 1]).toContain('编码未在预期时间内完成');
      expect(lines[card + 2]).toContain('✓编 ●验 ○评 ○合 · 将军');
      const quotaStart = lines.findIndex(line => line.startsWith('额度：'));
      expect(quotaStart).toBeGreaterThan(card);
      expect(
        lines
          .slice(quotaStart)
          .map((line, index) =>
            index ? line.slice(Bun.stringWidth('额度：')) : line.slice('额度：'.length)
          )
          .join('')
      ).toBe(quota);
      expect(lines.every(line => Bun.stringWidth(line) <= columns)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows - 1);
    }
  }
  value.marshals[0]!.running[0]!.node = 'fix-m1-r2';
  expect(frame(value, 40, 24, quota)).toContain('✓编 ●修r2 ○评 ○合');
  expect(
    frame(value, 40, 24, quota, undefined, { at: new Date(now - 240_000).toISOString() })
  ).toContain('⚠ 巡检可能停了');
});

test('resize 先清屏再触发组件重渲染', () => {
  const stdout = new EventEmitter();
  const calls: string[] = [];
  const unregister = registerHeartbeatResizeClear(stdout, () => calls.push('clear'));
  stdout.on('resize', () => calls.push('render'));
  stdout.emit('resize');
  expect(calls).toEqual(['clear', 'render']);
  unregister();
});
