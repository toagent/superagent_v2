import { expect, test } from 'bun:test';
import { providerTiming } from '../src/provider-timing';
import type { ProviderEventEnvelope } from '../../packages/workflows/src/schemas/provider-event';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 14) + ms).toISOString();
const row = (seq: number, ms: number, event: ProviderEventEnvelope['event'], attemptId = 'a', run = 'r') => ({
  workflow_run_id: run, event_type: 'provider_event', step_name: 'code-p',
  data: { attemptId, seq, observedAt: at(ms), event },
});
const start = (id: string): ProviderEventEnvelope['event'] => ({ type: 'tool_call', toolCallId: id, name: 'shell' });
const end = (id: string): ProviderEventEnvelope['event'] => ({ type: 'tool_call_update', toolCallId: id, status: 'completed' });
const message: ProviderEventEnvelope['event'] = { type: 'agent_message_chunk', text: 'content' };
const terminal = (type = 'node_completed', attempt = 'a') => ({
  workflow_run_id: 'r', step_name: 'code-p', event_type: type, created_at: at(100), data: { attempt: { id: attempt } },
});
const fixture = () => [row(0, 0, message), row(1, 10, start('x')), row(2, 20, start('y')),
  row(3, 40, end('x')), row(4, 50, end('y')), row(5, 60, message)];

test('PROVIDER_TIMING parallel tool union and client content clocks, never inferred request', () => {
  const projection = providerTiming('r', [...fixture().reverse(), terminal()])[0];
  expect(projection).toMatchObject({
    window: { start: at(0), end: at(60), duration_ms: 60 },
    tool_union_ms: 40, known_tool_union_ms: 40, non_tool_gap_ms: 20,
    first_content_at: at(0), final_answer_at: at(60), node_settled_at: at(100),
    request_at: 'unknown', first_token_ms: 'unknown',
    tool_intervals: [{ start: at(10), end: at(50) }],
  });
});

test('PROVIDER_TIMING duplicates and seq gaps make totals unknown but preserve other proven pairs', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, message)];
  for (const damaged of [[...rows, rows[2]!], [...rows, row(4, 30, message)]]) {
    expect(providerTiming('r', damaged)[0]).toMatchObject({
      tool_union_ms: 'unknown', non_tool_gap_ms: 'unknown', window: 'unknown',
      known_tool_union_ms: 10, tool_intervals: [{ start: at(0), end: at(10) }],
    });
  }
  expect(providerTiming('r', [rows[0]!, rows[1]!, rows[1]!])[0]?.known_tool_union_ms).toBe(0);
  expect(providerTiming('r', [row(0, 0, start('x')), row(2, 10, end('x'))])[0]?.tool_union_ms).toBe('unknown');
});

test('PROVIDER_TIMING identical tool IDs stay isolated across attempts, nodes and runs', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')),
    row(0, 20, start('x'), 'b'), row(1, 50, end('x'), 'b'),
    row(0, 0, start('x'), 'a', 'other'), row(1, 40, end('x'), 'a', 'other'),
    { ...row(0, 0, start('x')), step_name: 'code-other' },
    { ...row(1, 70, end('x')), step_name: 'code-other' }];
  expect(providerTiming('r', rows).map(p => p.tool_union_ms)).toEqual([10, 30, 40, 70]);
});

test('PROVIDER_TIMING unclosed and reused tools preserve known intervals without invented totals', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, start('y'))];
  expect(providerTiming('r', [...rows, terminal()])[0]).toMatchObject({
    known_tool_union_ms: 10, tool_union_ms: 'unknown', non_tool_gap_ms: 'unknown', final_answer_at: 'unknown',
  });
  expect(providerTiming('r', [...rows, row(3, 30, start('x'))])[0]?.known_tool_union_ms).toBe(0);
});

test('PROVIDER_TIMING invalid and regressing clocks invalidate affected pairs only', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, start('y'))];
  const invalid = row(3, 30, end('y'));
  invalid.data.observedAt = 'invalid';
  for (const bad of [invalid, row(3, 15, end('y'))]) {
    expect(providerTiming('r', [...rows, bad])[0]).toMatchObject({
      tool_union_ms: 'unknown', known_tool_union_ms: 10, non_tool_gap_ms: 'unknown',
    });
  }
});

test('PROVIDER_TIMING failed or absent terminal cannot claim final answer; no events stay unknown', () => {
  for (const terminals of [[], [terminal('node_failed')]]) {
    expect(providerTiming('r', [...fixture(), ...terminals])[0]).toMatchObject({
      first_content_at: at(0), final_answer_at: 'unknown', tool_union_ms: 40,
    });
  }
  expect(providerTiming('r', [terminal()])[0]).toMatchObject({
    window: 'unknown', tool_union_ms: 'unknown', request_at: 'unknown', final_answer_at: 'unknown',
  });
});
