import { describe, expect, test } from 'bun:test';
import type { Plan } from '../src/plan';
import { callsOf, rollup } from '../src/report';

const plan = {
  packages: [{ id: 'core' }, { id: 'api', milestone: 'm2' }],
} as unknown as Plan;

const ev = (
  type: string,
  node: string,
  data: Record<string, unknown> = {}
): { event_type: string; step_name: string; data: Record<string, unknown> } => ({
  event_type: type,
  step_name: node,
  data: {
    invocation: { startedAt: '2026-10-10T00:00:00.000Z' },
    attempt: { id: `${node}-a`, startedAt: '2026-10-10T00:00:02.000Z' },
    binding: { model: { requested: 'm-req', resolved: { source: 'unavailable' } }, effort: 'high' },
    timing: { durationMs: 1000 },
    spend: { tokens: { source: 'unavailable', reason: 'not_reported' } },
    ...data,
  },
});
const provider = (model: string, value: Record<string, number>): Record<string, unknown> => ({
  binding: {
    model: { requested: model, resolved: { source: 'provider', value: model } },
    effort: 'xhigh',
  },
  spend: { tokens: { source: 'provider', value } },
});

describe('F-22 report', () => {
  const events = [
    ev('node_started', 'code-core'),
    ev('node_completed', 'code-core'),
    ev('node_failed', 'review-m2-r1', { provider_failure: { class: 'vendor_unavailable' } }),
    ev(
      'node_completed',
      'review-m2-r1',
      provider('claude-x', { input: 100, output: 10, cacheRead: 60 })
    ),
    ev('node_completed', 'repair-api'),
    // 条件跳过（无 binding.model）与 resume 沿用的 prior_success（无 attempt）不是调用
    {
      event_type: 'node_completed',
      step_name: 'fix-m1-r2',
      data: { attempt: { id: 'x' }, binding: {} },
    },
    { event_type: 'node_completed', step_name: 'code-api', data: { reason: 'prior_success' } },
    ev('node_completed', 'verify-core'),
  ];
  const calls = callsOf('r1', events, plan);

  test('one call per terminal AI event with milestone, role, attempt, model identity and failure class', () => {
    expect(calls.map(c => [c.node, c.milestone, c.role, c.attempt, c.model, c.failure])).toEqual([
      ['code-core', 'm1', 'code', 1, 'm-req(pinned)', null],
      ['review-m2-r1', 'm2', 'review', 1, 'm-req(pinned)', 'vendor_unavailable'],
      ['review-m2-r1', 'm2', 'review', 2, 'claude-x', null],
      ['repair-api', 'm2', 'repair', 1, 'm-req(pinned)', null],
    ]);
    expect(calls[0]).toMatchObject({ queue_ms: 2000, exec_ms: 1000, effort: 'high', tokens: null });
    expect(callsOf('r1', events, null)[0].milestone).toBe('?');
  });

  test('unreported usage is unknown, never 0; coverage says how much is known', () => {
    expect(rollup(calls.filter(c => c.role !== 'review'))).toMatchObject({
      calls: 2,
      coverage: '0/2',
      input: 'unknown',
      output: 'unknown',
      cacheRead: 'unknown',
      cacheWrite: 'unknown',
    });
    expect(rollup(calls)).toMatchObject({
      calls: 4,
      coverage: '1/4',
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 'unknown',
      infra_retries: 1,
      repair_rounds: 1,
      queue_ms: 8000,
      exec_ms: 4000,
      models: { 'm-req(pinned)': 3, 'claude-x': 1 },
      efforts: { high: 3, xhigh: 1 },
      failures: { vendor_unavailable: 1 },
    });
    expect(rollup([])).toMatchObject({ calls: 0, input: 'unknown', exec_ms: 'unknown' });
    expect(JSON.stringify(rollup(calls))).not.toMatch(/cost|usd/i);
  });
});
