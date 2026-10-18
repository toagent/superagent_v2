import { expect, test } from 'bun:test';
import { unknownEffects, type ExecutionRunView } from './execution-lifecycle';

test('only the current engine-owned paused node has known effects', () => {
  const nodes = [
    { nodeId: 'gate', state: 'running' },
    { nodeId: 'prompt', state: 'running' },
  ];
  for (const metadata of [
    { approval: { nodeId: 'gate' } },
    { wait: { nodeId: 'gate', kind: 'time', resumeAt: '2026-10-19T00:00:00Z' } },
  ] satisfies NonNullable<ExecutionRunView['metadata']>[])
    expect(unknownEffects({ id: 'r', status: 'paused', metadata, nodes })).toEqual(['prompt']);
  expect(
    unknownEffects({
      id: 'r',
      status: 'running',
      metadata: { approval: { nodeId: 'gate' } },
      nodes,
    })
  ).toEqual(['gate', 'prompt']);
});
