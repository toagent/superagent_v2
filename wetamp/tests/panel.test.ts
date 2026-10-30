import { expect, test } from 'bun:test';
import { allMarshals, cwdFilter, panelModel, renderPanel } from '../src/panel';
import type { Heartbeat, TickRecord } from '../src/heartbeat';
import { unknownProgress } from '../src/board/eta';

const now = Date.parse('2026-10-30T12:10:00Z');
const tick = (minutes = 0): TickRecord => ({ at: new Date(now - minutes * 60_000).toISOString() });
const heartbeat = (at = now): Heartbeat => ({
  at: new Date(at).toISOString(),
  reclaim_pending: 2,
  legacy: 3,
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
      cwd: '/',
      project: 'demo',
      line: '',
      running: [
        {
          id: '20261030-114127-582a',
          kind: 'run',
          title: '实现心跳面板',
          stage: '编码',
          role: '将军·gpt',
          state: 'running',
          elapsed_s: 120,
          last_activity_s: 60,
          estimate: unknownProgress(),
          general: { state: 'idle', idle_s: 300, waiting_command: true, cpu: 8 },
        },
      ],
      waiting: [
        {
          id: 'run-2',
          what: '评审',
          code: 'review_limit',
          waiting_for: '评审轮次用尽',
          waited_s: 120,
          next: '重新确认 blocker',
        },
      ],
    },
  ],
});

test('问题置顶并显示空转、挂起处置和运行详情', () => {
  const output = renderPanel(heartbeat(), tick(), now, allMarshals, 120);
  expect(output.indexOf('需要处理')).toBeLessThan(output.indexOf('进行中'));
  expect(output).toContain('空转 5m（在等命令）');
  expect(output).toContain('114127-582a｜demo｜实现心跳面板｜空转 5m（在等命令）');
  expect(output).toContain('run-2｜demo｜评审轮次用尽｜已等 2m｜下一步：重新确认 blocker');
  expect(output).toContain('阶段 编码｜执行者 将军·gpt');
  const withoutNext = heartbeat();
  delete withoutNext.marshals[0]!.waiting[0]!.next;
  expect(renderPanel(withoutNext, tick(), now, allMarshals, 120)).not.toContain('下一步');
});

test('用 tick 判断新鲜度并按 heartbeat.at 漂移时长', () => {
  const old = heartbeat(now - 10 * 60_000);
  const fresh = renderPanel(old, tick(), now, allMarshals, 120);
  expect(fresh).toContain('巡检正常');
  expect(fresh).toContain('已用 12m');
  expect(fresh).toContain('最近活动 ≥11m 前');
  expect(renderPanel(old, tick(4), now, allMarshals, 120)).toContain('⚠️ 巡检可能停了');
  const current = heartbeat();
  current.marshals[0]!.running[0]!.last_activity_s = 0;
  current.marshals[0]!.running[0]!.coder = false;
  expect(renderPanel(current, tick(), now, allMarshals, 30)).toContain('114127-582a｜demo');
  const output = renderPanel(current, tick(), now, allMarshals, 120);
  expect(output).toContain('最近活动 刚刚｜将军 已交回');
});

test('--cwd 优先匹配 owner.cwd，无 cwd 时回退 marshal.cwd', () => {
  const value = heartbeat();
  expect(renderPanel(value, tick(), now, cwdFilter('/tmp'), 120)).toContain('实现心跳面板');
  value.marshals[0]!.owner = { client: 'shell', pid: 2 };
  expect(renderPanel(value, tick(), now, cwdFilter('/'), 120)).toContain('实现心跳面板');
  expect(renderPanel(value, tick(), now, cwdFilter('/tmp'), 120)).not.toContain('实现心跳面板');
});

test('中文按显示宽度截断且空数据明确显示无', () => {
  const narrow = renderPanel(heartbeat(), tick(), now, allMarshals, 20);
  for (const line of narrow.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
  expect(narrow).toContain('…');
  const empty = renderPanel(undefined, tick(), now, allMarshals, 80, false, 'BestIFA');
  expect(empty).toContain('心跳面板｜BestIFA');
  expect(empty).toContain('暂无在跑任务');
  expect(empty).toContain('统计｜在跑 0｜等待 0｜待回收 0');
  expect(renderPanel(heartbeat(), tick(), now, allMarshals, 100)).toContain('历史遗留 3（需确认）');
});

test('panelModel 集中结构化统计、阶段键与原始时长', () => {
  const value = heartbeat(now - 10 * 60_000);
  value.marshals[0]!.running[0]!.node = 'verify-m1';
  const model = panelModel(value, tick(), now);
  expect(model.stats).toEqual({ running: 1, waiting: 1, reclaimPending: 2, legacy: 3 });
  expect(model.runs[0]).toMatchObject({ stageKind: 'verify', elapsed_s: 120 });
  expect(model.attention).toHaveLength(2);
});
