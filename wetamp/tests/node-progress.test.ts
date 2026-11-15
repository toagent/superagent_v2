import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from '../src/archon';
import { budgetSeconds, nodeProgress } from '../src/node-progress';
import type { Plan } from '../src/plan';
import { tmp } from './helpers';

const plan = (budget_min?: number): Plan => ({
  repo: '/repo',
  base_ref: 'dev',
  budget: { weighted_tokens: 0 },
  packages: [
    {
      id: 'core',
      title: 'core',
      goal: 'g',
      scope: { write: ['src/**'] },
      accept: [{ cmd: 'true', timeout_s: 1 }],
      risk: 'G1',
      size: 'S',
      ...(budget_min === undefined ? {} : { budget_min }),
    },
  ],
});

test('从持久化 JSONL 投影在跑将军的时间预算与事件活跃度', () => {
  const root = tmp(),
    logs = join(root, 'logs'),
    now = Date.parse('2026-11-15T10:12:00Z'),
    run: RunView = {
      id: 'run-1',
      status: 'running',
      output_root: root,
      nodes: [
        { nodeId: 'code-core', state: 'running', startedAt: '2026-11-15T10:00:00Z' },
        { nodeId: 'verify-core', state: 'running', startedAt: '2026-11-15T10:00:00Z' },
      ],
    };
  mkdirSync(logs);
  const line = (step: string, seq: number, observedAt: string) =>
    JSON.stringify({
      type: 'provider_event',
      workflow_id: run.id,
      ts: observedAt,
      step,
      attemptId: 'attempt',
      seq,
      observedAt,
      event: { type: 'agent_message_chunk', text: 'ok' },
    });
  writeFileSync(
    join(logs, `${run.id}.jsonl`),
    [
      line('code-core', 0, '2026-11-15T10:10:00Z'),
      line('code-core', 1, '2026-11-15T10:11:20Z'),
    ].join('\n')
  );
  expect(nodeProgress(run, plan(), now)).toEqual({
    'code-core': {
      started_at: '2026-11-15T10:00:00Z',
      elapsed_s: 720,
      budget_s: 1800,
      last_event_at: '2026-11-15T10:11:20Z',
      last_event_s: 40,
      event_count: 2,
    },
  });
});

test('缺失时钟和日志保持显式，覆盖值只改变预算', () => {
  const p = plan(7),
    run: RunView = {
      id: 'missing',
      status: 'running',
      nodes: [{ nodeId: 'code-core', state: 'running' }],
    };
  expect(budgetSeconds(p.packages[0])).toBe(420);
  expect(nodeProgress(run, p, 0)['code-core']).toEqual({
    started_at: null,
    elapsed_s: null,
    budget_s: 420,
    last_event_at: null,
    last_event_s: null,
    event_count: 0,
  });
});
