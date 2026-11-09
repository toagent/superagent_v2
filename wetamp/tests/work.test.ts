import { expect, test } from 'bun:test';
import type { Cockpit } from '../src/board/cockpit';
import type { Snapshot } from '../src/board/data';
import { findWork, queueWork, runWork, type WorkDeps } from '../src/work';
const record = (id: string, title: string, observed = '2026-11-10T00:00:00Z') => ({
  repo_id: 'repo-1',
  source_kind: 'package',
  source_id: id,
  revision: `sha256:${id}`,
  observed_at: observed,
  title,
  evidence: [{ id: 'source', locator: `package/${id}`, availability: 'available' }],
});
const exportView = (records: Record<string, unknown>[] = []) => ({
  status: 'partial',
  coverage: { run: { history: { status: 'unknown' } } },
  errors: [{ code: 'HISTORY_UNKNOWN' }],
  records,
});
const deps = (view = exportView()): WorkDeps => ({
  collect: () => ({ exit: 3, output: view }),
  load: () => Promise.reject(new Error('unused')),
});
test('find 保留稳定 identity/evidence/boundary，并按 OR 分数和确定顺序返回', () => {
  const view = exportView([
    record('b', 'alpha beta', '2026-11-10T01:00:00Z'),
    record('a', 'alpha beta', '2026-11-10T01:00:00Z'),
    record('c', 'alpha only', '2026-11-10T02:00:00Z'),
  ]);
  const before = JSON.stringify(view);
  const output = findWork(view, ['alpha', 'beta'], 10);
  expect(output).toMatchObject({ status: 'partial', coverage: view.coverage, errors: view.errors });
  expect((output.candidates as Record<string, unknown>[]).map(item => item.identity)).toEqual([
    { repo_id: 'repo-1', source_kind: 'package', source_id: 'a' },
    { repo_id: 'repo-1', source_kind: 'package', source_id: 'b' },
    { repo_id: 'repo-1', source_kind: 'package', source_id: 'c' },
  ]);
  expect((output.candidates as Record<string, unknown>[])[0]).toMatchObject({
    revision: 'sha256:a',
    matched_terms: ['alpha', 'beta'],
    evidence: [{ locator: 'package/a' }],
  });
  expect(JSON.stringify(view)).toBe(before);
});
test('find 输入边界用法错误，无命中仍成功', async () => {
  for (const terms of [[], [1], Array(9).fill('x'), ['x'.repeat(81)]])
    expect(
      (await runWork(['work', 'find', '--terms-json', JSON.stringify(terms), '--json'], deps()))
        .exit
    ).toBe(64);
  expect(
    await runWork(['work', 'find', '--terms-json', '["missing"]', '--json'], deps())
  ).toMatchObject({
    exit: 0,
    output: { candidates: [] },
  });
  expect(
    (await runWork(['work', 'find', '--terms-json', '["x"]', '--limit', '101', '--json'], deps()))
      .exit
  ).toBe(64);
});

test('queue 合并 run ask 与 COORD inbox，无法证明的动作保持为空并报告异常', () => {
  const decision = {
    id: 'ask-1',
    run: 'r1',
    engine: 'e1',
    node: 'human',
    pause: 'p',
    question: '批准？',
    reason: 'signoff',
    context: 'ctx',
    options: [{ id: 'yes', label: '批准', consequence: '续跑' }],
  };
  const snapshot = {
    at: '2026-11-10T00:00:00Z',
    summary: {},
    rows: [{ run_id: 'r1', humanDecision: decision }],
    coordMessages: [{ id: 'm1', state: 'pending' }],
  } as unknown as Snapshot;
  const need = (id: string, role: string, decisionValue: unknown) => ({
    id,
    role,
    decision: decisionValue,
    project: 'p',
    title: id,
    state: 'held',
    reason: 'x',
    question: '?',
  });
  const view = {
    needs: [need('r1', '元帅', {}), need('m1', '', {}), need('u1', '元帅', undefined)],
    anomalies: [],
  } as unknown as Cockpit;
  const output = queueWork(snapshot, view);
  expect((output.needs as Record<string, unknown>[]).map(item => item.actions)).toEqual([
    [{ kind: 'ask_answer', command: 'ask', args: ['answer', 'ask-1'], options: decision.options }],
    [
      {
        kind: 'inbox_ack',
        command: 'inbox',
        args: ['--ack', 'm1'],
        options: ['accepted', 'rejected'],
        note_supported: true,
      },
    ],
    [],
  ]);
  expect(output.anomalies).toEqual(['无法证明动作：run/u1']);
});

test('数据读取失败返回 1，queue 加载失败返回 1', async () => {
  const failed = deps({ ...exportView(), errors: [{ code: 'SOURCE_UNREADABLE' }] });
  expect((await runWork(['work', 'find', '--terms-json', '["x"]', '--json'], failed)).exit).toBe(1);
  expect(await runWork(['work', 'queue', '--json'], deps())).toMatchObject({
    exit: 1,
    error: 'unused',
  });
});
