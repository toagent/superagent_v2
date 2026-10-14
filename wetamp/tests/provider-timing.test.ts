import { expect, test } from 'bun:test';
import { providerTiming } from '../src/provider-timing';
import type { ProviderEventEnvelope } from '../../packages/workflows/src/schemas/provider-event';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 14) + ms).toISOString();
const row = (
  seq: number,
  ms: number,
  event: ProviderEventEnvelope['event'],
  attemptId = 'a',
  run = 'r'
) => ({
  workflow_run_id: run,
  event_type: 'provider_event',
  step_name: 'code-p',
  data: { attemptId, seq, observedAt: at(ms), event },
});
const start = (id: string): ProviderEventEnvelope['event'] => ({
  type: 'tool_call',
  toolCallId: id,
  name: 'shell',
});
const end = (id: string): ProviderEventEnvelope['event'] => ({
  type: 'tool_call_update',
  toolCallId: id,
  status: 'completed',
});
const message: ProviderEventEnvelope['event'] = { type: 'agent_message_chunk', text: 'content' };
const terminal = (type = 'node_completed', attempt = 'a') => ({
  workflow_run_id: 'r',
  step_name: 'code-p',
  event_type: type,
  created_at: at(100),
  data: { attempt: { id: attempt } },
});
const fixture = () => [
  row(0, 0, message),
  row(1, 10, start('x')),
  row(2, 20, start('y')),
  row(3, 40, end('x')),
  row(4, 50, end('y')),
  row(5, 60, message),
];
const command = (
  id: string,
  status: 'started' | 'completed' | 'failed'
): ProviderEventEnvelope['event'] => ({
  type: 'subtask',
  taskId: id,
  taskType: 'command_execution',
  status,
});

test.each(['completed', 'failed'] as const)(
  'PROVIDER_TIMING Codex command %s merges overlap with distinct tool IDs',
  status => {
    const rows = [
      row(0, 0, message),
      row(1, 10, command('x', 'started')),
      row(2, 20, start('x')),
      row(3, 40, command('x', status)),
      row(4, 50, end('x')),
      row(5, 60, message),
      terminal(),
    ];
    expect(providerTiming('r', rows)[0]).toMatchObject({
      tool_union_ms: 40,
      known_tool_union_ms: 40,
      non_tool_gap_ms: 20,
      tool_intervals: [{ start: at(10), end: at(50) }],
      final_answer_at: at(60),
    });
  }
);

test('PROVIDER_TIMING Codex command pairs retain the same completeness rules', () => {
  const valid = [row(0, 0, command('x', 'started')), row(1, 10, command('x', 'failed'))];
  const invalid = row(3, 30, command('y', 'completed'));
  invalid.data.observedAt = 'invalid';
  for (const damaged of [
    [...valid, row(2, 20, command('y', 'started'))],
    [...valid, row(2, 20, command('x', 'started'))],
    [valid[0]!, valid[1]!, valid[1]!],
    [valid[0]!, row(2, 10, command('x', 'completed'))],
    [...valid, row(2, 20, command('y', 'started')), invalid],
    [...valid, row(2, 20, command('y', 'started')), row(3, 15, command('y', 'completed'))],
    [row(0, 0, command('x', 'completed')), row(1, 10, command('x', 'started'))],
  ]) {
    expect(providerTiming('r', damaged)[0]).toMatchObject({
      tool_union_ms: 'unknown',
      non_tool_gap_ms: 'unknown',
    });
  }
  expect(
    providerTiming('r', [...valid, row(2, 20, command('y', 'started'))])[0]?.known_tool_union_ms
  ).toBe(10);
  const rows = [
    ...valid,
    row(0, 20, command('x', 'started'), 'b'),
    row(1, 50, command('x', 'completed'), 'b'),
  ];
  expect(providerTiming('r', rows).map(p => p.tool_union_ms)).toEqual([10, 30]);
  expect(
    providerTiming('r', [
      row(0, 0, { type: 'subtask', taskId: 'agent', taskType: 'local_agent', status: 'started' }),
    ])[0]?.tool_union_ms
  ).toBe(0);
});

test('PROVIDER_TIMING parallel tool union and client content clocks, never inferred request', () => {
  const projection = providerTiming('r', [...fixture().reverse(), terminal()])[0];
  expect(projection).toMatchObject({
    window: { start: at(0), end: at(60), duration_ms: 60 },
    tool_union_ms: 40,
    known_tool_union_ms: 40,
    non_tool_gap_ms: 20,
    first_content_at: at(0),
    final_answer_at: at(60),
    node_settled_at: at(100),
    request_at: 'unknown',
    first_token_ms: 'unknown',
    tool_intervals: [{ start: at(10), end: at(50) }],
  });
});

test('PROVIDER_TIMING duplicates and seq gaps make totals unknown but preserve other proven pairs', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, message)];
  for (const damaged of [
    [...rows, rows[2]!],
    [...rows, row(4, 30, message)],
  ]) {
    expect(providerTiming('r', damaged)[0]).toMatchObject({
      tool_union_ms: 'unknown',
      non_tool_gap_ms: 'unknown',
      window: 'unknown',
      known_tool_union_ms: 10,
      tool_intervals: [{ start: at(0), end: at(10) }],
    });
  }
  expect(providerTiming('r', [rows[0]!, rows[1]!, rows[1]!])[0]?.known_tool_union_ms).toBe(0);
  expect(providerTiming('r', [row(0, 0, start('x')), row(2, 10, end('x'))])[0]?.tool_union_ms).toBe(
    'unknown'
  );
});

test('PROVIDER_TIMING identical tool IDs stay isolated across attempts, nodes and runs', () => {
  const rows = [
    row(0, 0, start('x')),
    row(1, 10, end('x')),
    row(0, 20, start('x'), 'b'),
    row(1, 50, end('x'), 'b'),
    row(0, 0, start('x'), 'a', 'other'),
    row(1, 40, end('x'), 'a', 'other'),
    { ...row(0, 0, start('x')), step_name: 'code-other' },
    { ...row(1, 70, end('x')), step_name: 'code-other' },
  ];
  expect(providerTiming('r', rows).map(p => p.tool_union_ms)).toEqual([10, 30, 40, 70]);
});

test('PROVIDER_TIMING unclosed and reused tools preserve known intervals without invented totals', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, start('y'))];
  expect(providerTiming('r', [...rows, terminal()])[0]).toMatchObject({
    known_tool_union_ms: 10,
    tool_union_ms: 'unknown',
    non_tool_gap_ms: 'unknown',
    final_answer_at: 'unknown',
  });
  expect(providerTiming('r', [...rows, row(3, 30, start('x'))])[0]?.known_tool_union_ms).toBe(0);
});

test('PROVIDER_TIMING invalid and regressing clocks invalidate affected pairs only', () => {
  const rows = [row(0, 0, start('x')), row(1, 10, end('x')), row(2, 20, start('y'))];
  const invalid = row(3, 30, end('y'));
  invalid.data.observedAt = 'invalid';
  for (const bad of [invalid, row(3, 15, end('y'))]) {
    expect(providerTiming('r', [...rows, bad])[0]).toMatchObject({
      tool_union_ms: 'unknown',
      known_tool_union_ms: 10,
      non_tool_gap_ms: 'unknown',
    });
  }
});

test('PROVIDER_TIMING failed or absent terminal cannot claim final answer; no events stay unknown', () => {
  for (const terminals of [[], [terminal('node_failed')]]) {
    expect(providerTiming('r', [...fixture(), ...terminals])[0]).toMatchObject({
      first_content_at: at(0),
      final_answer_at: 'unknown',
      tool_union_ms: 40,
    });
  }
  expect(providerTiming('r', [terminal()])[0]).toMatchObject({
    window: 'unknown',
    tool_union_ms: 'unknown',
    request_at: 'unknown',
    final_answer_at: 'unknown',
  });
});

test('EFFICIENCY_BUDGET parallel batches, edit clock and longest gap include window edges', () => {
  const read = (id: string): ProviderEventEnvelope['event'] => ({
    type: 'tool_call',
    toolCallId: id,
    name: 'shell',
    rawInput: { command: 'ls' },
  });
  const rows = [
    row(0, 0, message),
    row(1, 10, read('x')),
    row(2, 10, read('y')),
    row(3, 20, end('x')),
    row(4, 30, end('y')),
    row(5, 200031, { type: 'tool_call', toolCallId: 'edit', name: 'file_change' }),
    row(6, 200041, end('edit')),
    row(7, 200051, message),
  ];
  expect(providerTiming('r', rows)[0]).toMatchObject({
    model_turns: 1,
    first_edit_ms: 200031,
    longest_gap_ms: 200001,
    longest_gap_at: at(30),
    budget: { over: true, reasons: ['longest_gap_ms 200001 > 180000'] },
    request_at: 'unknown',
    first_token_ms: 'unknown',
  });
  expect(providerTiming('r', [row(0, 0, read('x')), row(1, 10, end('x'))])[0]).toMatchObject({
    model_turns: 0,
    first_edit_ms: null,
  });
  expect(providerTiming('r', [row(0, 0, message), row(1, 180000, message)])[0]).toMatchObject({
    longest_gap_ms: 180000,
    model_turns: 'unknown',
    budget: { over: false, reasons: [] },
  });
});

const editTools: Pick<
  Extract<ProviderEventEnvelope['event'], { type: 'tool_call' }>,
  'name' | 'rawInput'
>[] = [
  { name: 'apply_patch' },
  { name: 'fileChange' },
  { name: 'command_execution', rawInput: { command: "printf 'x' > source.ts" } },
  { name: 'shell', rawInput: { cmd: 'sed -i s/x/y/ source.ts' } },
];
test.each(editTools)('EFFICIENCY_BUDGET recognizes edit tool or command %j', tool => {
  expect(
    providerTiming('r', [
      row(0, 0, message),
      row(1, 10, { type: 'tool_call', toolCallId: 'x', ...tool }),
      row(2, 20, end('x')),
    ])[0]
  ).toMatchObject({ first_edit_ms: 10 });
});

test('EFFICIENCY_BUDGET missing or unclosed events do not invent metrics', () => {
  for (const rows of [
    [terminal()],
    [row(0, 0, start('x'))],
    [row(0, 0, message), row(2, 100, message)],
  ]) {
    expect(providerTiming('r', rows)[0]).toMatchObject({
      model_turns: 'unknown',
      longest_gap_ms: 'unknown',
      longest_gap_at: 'unknown',
    });
  }
  expect(providerTiming('r', [terminal()])[0]?.first_edit_ms).toBe('unknown');
  expect(
    providerTiming('r', [
      row(0, 0, {
        type: 'tool_call',
        toolCallId: 'x',
        name: 'shell',
        rawInput: { command: "printf 'unterminated" },
      }),
      row(1, 10, end('x')),
    ])[0]?.first_edit_ms
  ).toBe('unknown');
});

test.each([
  ['code', 1092000, 63],
  ['repair', 156000, 19],
  ['fix', 498000, 46],
  ['review', 444000, 43],
] as const)('EFFICIENCY_BUDGET %s p90 thresholds are strict', (role, wall, turns) => {
  const rows = Array.from({ length: turns + 2 }, (_, i) => [
    row(i * 2, i * 2, start(String(i))),
    row(i * 2 + 1, i * 2 + 1, end(String(i))),
  ])
    .flat()
    .map(r => ({ ...r, step_name: `${role}-p` }));
  const timing = providerTiming('r', rows)[0]!;
  expect(timing.model_turns).toBe(turns + 1);
  expect(timing.budget.reasons).toContain(`model_turns ${turns + 1} > p90 ${turns}`);
  const clockRows = [row(0, 0, start('x')), row(1, wall, end('x'))].map(r => ({
    ...r,
    step_name: `${role}-p`,
  }));
  expect(providerTiming('r', clockRows)[0]?.budget.over).toBe(false);
  clockRows[1]!.data.observedAt = at(wall + 1);
  expect(providerTiming('r', clockRows)[0]?.budget.reasons).toEqual([
    `wall_clock_ms ${wall + 1} > p90 ${wall}`,
  ]);
});
