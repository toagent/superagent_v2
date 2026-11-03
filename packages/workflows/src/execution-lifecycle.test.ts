import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  admitExecution,
  executionOwnership,
  unknownEffects,
  type ExecutionRunView,
} from './execution-lifecycle';
const trackTempRoot = trackTempRoots();
test('execution ownership distinguishes binding latency from PID reuse', () => {
  const base = {
    id: 'r',
    status: 'running' as const,
    started_at: '2026-11-03T00:23:20.000Z',
  };
  for (const [bound_at, start, state] of [
    ['2026-11-03T00:23:21.900Z', '2026-11-03T00:23:21.000Z', 'online'],
    ['2026-11-03T00:23:21.000Z', '2026-11-03T00:23:21.000Z', 'online'],
    ['2026-11-03T00:23:21.000Z', '2026-11-03T00:23:22.000Z', 'unknown'],
    [undefined, '2026-11-03T00:23:21.000Z', 'online'],
    [undefined, '2026-11-03T00:23:22.000Z', 'unknown'],
  ] as const) {
    const ownership = executionOwnership(
      { ...base, metadata: { execution_owner: { host: hostname(), pid: 42, bound_at } } },
      () => ({ state: 'online', start })
    );
    expect(ownership.state).toBe(state);
    expect(ownership.reused).toBe(state === 'unknown' ? true : undefined);
  }
});
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

test('back-to-back admission waits for a live launch reservation to publish', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'execution-admission-'))),
    active = { value: 0 },
    host = {
      root,
      inspectProcess: () => ({ state: 'online' as const, start: 'owner' }),
      countActive: () => active.value,
      launch: () => ({}),
    };
  const first = admitExecution(host);
  if (!first.ok) throw new Error('first admission refused');
  first.launch([]);
  const path = join(root, 'run-admission.json'),
    reservation = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...reservation, pid: 42, pid_start: 'owner' }));
  first.release();
  let now = 0;
  const second = admitExecution(host, {
    now: () => now,
    sleep: ms => {
      now += ms;
      active.value = 1;
    },
  });
  expect(second).toMatchObject({ ok: true, active: 1 });
  if (second.ok) second.release();
});
