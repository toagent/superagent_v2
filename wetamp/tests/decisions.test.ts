import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { gitRepo, tmp } from './helpers';
import { coordinationDecisions, describeDecision } from '../src/decisions';
import type { Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import type { Coordination } from '../src/coord';
import { Coordination as CoordinationRegistry, repoScope } from '../src/coord';

function fixture() {
  const dir = tmp();
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({ packages: [{ title: '真实工作包', goal: '交付可验证结果' }] })
  );
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
  expect(d.purpose).toBe('真实工作包：交付可验证结果');
  f.gate.pauseId = 'next-occurrence';
  expect(describeDecision(f.ledger, f.run, f.ownership)!.id).not.toBe(d.id);
  f.ownership.generation++;
  expect(describeDecision(f.ledger, f.run, f.ownership)!.id).not.toBe(d.id);
});
test('COORD decision consequences name repository, finder, and ownership effects', () => {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa');
  mkdirSync(sa);
  const c = new CoordinationRegistry({
      sa,
      runs: () => [],
      presence: () => ({ state: 'offline' }),
    }),
    scope = repoScope(repo),
    owner = { client: 'codex', host: hostname(), pid: 1, pid_start: 'owner' },
    finder = { ...owner, client: 'claude', pid: 2, pid_start: 'finder' };
  c.claim(scope, owner);
  c.handoff(scope, finder, {
    kind: 'task',
    title: 'private handoff text',
    body: 'private body',
    evidence: [],
    severity: 'urgent',
  });
  c.tick(() => ({ status: 'pending' }));
  expect(coordinationDecisions(c)[0]!.options.map(option => option.consequence)).toEqual([
    'claude 成为 repo 负责人，可直接修改该仓库代码',
    '继续等待当前负责人，不转移 repo 归属',
  ]);
  expect(coordinationDecisions(c)[0]).toMatchObject({
    project: expect.any(String),
    purpose: expect.stringContaining('private handoff text'),
    source: { ref: expect.any(String) },
  });
});
test('owner-null COORD decisions answer yes/no and reject a stale generation', () => {
  const escalated = () => {
    let now = Date.now();
    const root = tmp(),
      repo = gitRepo(root),
      sa = join(root, 'sa'),
      scope = repoScope(repo),
      finder = { client: 'claude', host: hostname(), pid: 2, pid_start: 'finder' },
      c = new CoordinationRegistry({
        sa,
        runs: () => [],
        now: () => now,
        presence: () => ({ state: 'unknown' }),
      });
    mkdirSync(sa);
    c.handoff(
      scope,
      finder,
      {
        kind: 'task',
        title: 'unowned work',
        body: 'body',
        evidence: [],
        severity: 'urgent',
      },
      0,
      false
    );
    now += 16 * 60_000;
    c.tick(() => ({ status: 'pending' }));
    const message = c.messages().find(m => !m.type)!;
    return { c, scope, finder, message };
  };

  const yes = escalated();
  expect(coordinationDecisions(yes.c)).toHaveLength(1);
  let yesStatus = 'pending';
  expect(
    yes.c.answerEscalation(yes.message.id, yes.message.generation, () => (yesStatus = 'yes'))
  ).toBeTrue();
  yes.c.tick(() => ({ status: yesStatus }));
  expect(yes.c.owner(yes.scope).owner).toEqual(yes.finder);

  const no = escalated();
  let noStatus = 'pending';
  expect(no.c.answerEscalation(no.message.id, 0, () => (noStatus = 'no'))).toBeTrue();
  no.c.tick(() => ({ status: noStatus }));
  expect(no.c.owner(no.scope).owner).toBeNull();
  expect(no.c.messages().find(m => m.id === no.message.id)?.state).toBe('queued');

  const stale = escalated();
  stale.c.claim(stale.scope, stale.finder);
  expect(stale.c.answerEscalation(stale.message.id, 0, () => undefined)).toBeFalse();
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
