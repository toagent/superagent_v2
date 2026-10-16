import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { tmp } from './helpers';
import { describeDecision } from '../src/decisions';
import type { Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import type { Coordination } from '../src/coord';

function fixture() {
  const dir = tmp();
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ packages: [{ title: '真实工作包' }] }));
  const ledger: Ledger = {
    run_id: 'unit',
    archon_run_id: 'engine',
    repo: dir,
    gen_dir: dir,
    plan: '',
    branch: '',
    workflow: '',
    console: '',
    transcript: '',
    log: '',
    started_at: '',
  };
  const gate = {
    nodeId: 'choose',
    pauseId: 'occurrence',
    message: '选择哪份报告？',
    decisionsAuthored: true,
    decisions: [
      { id: 'approve', label: '生成摘要' },
      { id: 'detail', label: '生成明细' },
      { id: 'stop', label: '结束本次测试' },
    ],
  };
  const run: RunView = { id: 'engine', status: 'paused', metadata: { approval: gate } };
  const ownership: ReturnType<Coordination['owner']> = {
    scope: { kind: 'run', id: 'unit', repo: dir },
    owner: { client: 'shell', host: hostname(), pid: process.pid, pid_start: 'birth' },
    generation: 1,
    next: '',
    conflicts: [],
    evidence: [],
    presence: { state: 'online', activity: 'idle' },
  };
  return { ledger, run, ownership, gate };
}
test('native authored n-choice owner preserves identifiers, labels, context and occurrence', () => {
  const f = fixture(),
    d = describeDecision(f.ledger, f.run, f.ownership)!;
  expect(d.disabled).toBeUndefined();
  expect(d.options.map(o => o.id)).toEqual(['approve', 'detail', 'stop']);
  expect(d.question).toBe('选择哪份报告？');
  expect(d.context).toBe('真实工作包');
  f.gate.pauseId = 'next-occurrence';
  expect(describeDecision(f.ledger, f.run, f.ownership)!.id).not.toBe(d.id);
  f.ownership.generation++;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.id).not.toBe(d.id);
});
test('automatic, terminal, resolved and stale lifecycle never become actionable human work', () => {
  const f = fixture();
  for (const status of ['running', 'pending', 'completed', 'cancelled', 'failed'] as const) {
    expect(describeDecision(f.ledger, { ...f.run, status }, f.ownership)).toBeUndefined();
  }
  expect(describeDecision(f.ledger, { ...f.run, id: 'different' }, f.ownership)).toBeUndefined();
  f.run.metadata!.approval = { ...f.gate, resolved: 'approved' } as typeof f.gate;
  expect(describeDecision(f.ledger, f.run, f.ownership)).toBeUndefined();
});
test('owner ambiguity, missing labels/occurrence, capture and incompatible gate disable mobile', () => {
  const f = fixture();
  f.ownership.presence = { state: 'unknown' };
  expect(describeDecision(f.ledger, f.run, f.ownership)!.disabled).toContain('未知');
  f.ownership.presence = { state: 'online', activity: 'idle' };
  f.gate.decisions[0].label = '';
  expect(describeDecision(f.ledger, f.run, f.ownership)!.disabled).toBeTruthy();
  f.gate.decisions[0].label = '摘要';
  f.run.metadata!.approval = { ...f.gate, captureResponse: true } as typeof f.gate;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.disabled).toContain('额外上下文');
  f.gate.pauseId = '';
  f.run.metadata!.approval = f.gate;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.disabled).toBeTruthy();
});
test('legacy native signoff retains approve/terminate semantics; no invented choices', () => {
  const f = fixture();
  f.run.metadata!.approval = {
    nodeId: 'human-m1',
    pauseId: 'p',
    message: '交付签收',
  } as typeof f.gate;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.options.map(o => o.id)).toEqual([
    'approve',
    'reject',
  ]);
  f.run.metadata!.approval = {
    nodeId: 'choose',
    pauseId: 'p',
    message: '未知语义',
  } as typeof f.gate;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.disabled).toBeTruthy();
});
