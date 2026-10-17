import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Frame } from '../src/board/App';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';

test('a classified running run stays active without a recent event', () => {
  const now = new Date('2026-10-17T12:08:00Z');
  const row = {
    run_id: '20261017-033747-7d8a',
    repo: 'BestIFA',
    state: 'running',
    exit: 4,
    nativeState: 'running',
    lastEvent: '2026-10-17T11:00:00Z',
    activeNodes: [{ id: 'code-c1', role: 'coder', model: 'gpt-6.1-sol' }],
    nodes: { done: 0, total: 1, current: 'code-c1', currentRole: 'coder' },
    started_at: '2026-10-17T10:00:00Z',
    span: { started_ms: Date.parse('2026-10-17T10:00:00Z'), ended_ms: null },
    stale: false,
  } as BoardRow;
  const snap = { at: now.toISOString(), summary: {}, rows: [row] } as Snapshot;

  expect(cockpit(snap, now.getTime()).active.map(run => run.id)).toEqual([row.run_id]);
  const frame = renderToString(createElement(Frame, { snap, width: 80, height: 20, now }));
  expect(frame).toContain('code-c1');
  expect(frame).not.toContain('暂无活跃任务');
});
