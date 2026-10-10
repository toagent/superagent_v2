import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Frame, boardExitCode, ENGINE_CHANGED } from '../src/board/App';
import { cockpit } from '../src/board/cockpit';
import { jobProgress } from '../src/board/eta';
import type { BoardRow, Snapshot } from '../src/board/data';
import type { Job } from '../src/jobs';

const savedTZ = process.env.TZ;
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ; });
const now = new Date('2026-10-10T16:58:00+08:00');
const iso = (seconds: number): string => new Date(now.getTime() + seconds * 1000).toISOString();
function row(id: string, repo: string, title: string, current: string, model: string): BoardRow {
  return { run_id: id, repo, model, state: 'running', exit: null, nodes: { done: 4, total: 10, current, currentRole: current.startsWith('review') ? 'reviewer' : 'coder' }, started_at: iso(-3600), span: { started_ms: now.getTime() - 3600000, ended_ms: null }, elapsed_s: 3600, held: null, recoveries: 0, auto_retries: 0, console: 'codex', branch: 'b', evidence: '', plan: '', stale: false,
    engine: { title, milestones: ['m1', 'm2', 'm3'], currentMilestone: 'm2', states: [], firstPass: false, reason: '', dispositions: [] } };
}
const job: Job = { id: 'job', title: '启动配置烘焙', cwd: '/repo/xiaopan', kind: 'codex', model: 'gpt-6.1-sol', role: 'general', card: null, log: null, wrapper_pid: 1, pid: 2, started_at: iso(-600), state: 'running' };
const history = [1200, 1800, 2400].map((seconds, i) => ({ ...job, id: String(i), state: 'done' as const, started_at: iso(-86400 - seconds), ended_at: iso(-86400) }));
const snap: Snapshot = {
  at: now.toISOString(), summary: {}, rows: [row('sinan-run', 'sinan', 'IIQE 题目清单报告', 'code-a', 'gpt-6.1-sol'), row('xiaopan-run', 'xiaopan', '启动配置烘焙', 'review-m2-r1', 'gpt-6-astra')],
  eta: { 'sinan-run': { weight: 1000, progress: { pct: 62, eta_s: 840, overrun_s: 0, basis: 'history' } }, 'xiaopan-run': { weight: 2000, progress: { pct: 31, eta_s: 2400, overrun_s: 0, basis: 'history' } } },
  asks: { 'xiaopan-run:auto_retry_exhausted': { status: 'pending' }, 'sinan-run:budget': { status: 'superseded' } },
  activity: { jobs: [{ ...job, tier: 'general', owner: null, guess: false }], jobHistory: history, terms: [], procs: [], remote: [], notes: [] },
};
snap.rows[1].engine!.dispositions = [{ at: iso(-3720), reason: 'auto_retry_exhausted', action: 'ask', ok: true }];
for (const width of [62, 46]) test(`${String(width)} columns: 2 runs + job + pending/superseded ask snapshot`, () => {
  const frame = renderToString(createElement(Frame, { snap, width, height: 100, now }), { columns: width });
  expect(frame).toMatchSnapshot();
  expect(frame.split('\n')).toHaveLength(13);
  expect(frame).toContain('跑 3 · 等你 1'); expect(frame).toContain('将军·sol6.1  编码 m2/3');
  expect(frame).toContain('军师·astra  评审 r1'); expect(frame).toContain('? xiaopan 重试已用尽 是=再跑 否=终止 1h02m');
  expect(frame).not.toMatch(/心跳|token|tok |今日结果|终端|预算|q退出/);
  for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
});
test('registered jobs use same-role median and expose history basis; missing/other-role history stays unknown', () => {
  expect(jobProgress(job, history, now.getTime())).toEqual({ pct: 33, eta_s: 1200, overrun_s: 0, basis: 'history' });
  expect(jobProgress(job, [], now.getTime()).pct).toBeNull();
  expect(jobProgress(job, history.map(j => ({ ...j, role: 'strategist' })), now.getTime()).pct).toBeNull();
  expect(cockpit(snap, now.getTime()).active.at(-1)?.progress.basis).toBe('history');
});
test('needs never infer questions from held states; unanswered asks remain visible across run states', () => {
  expect(cockpit({ ...snap, asks: {} }, now.getTime()).needs).toEqual([]);
  for (const state of ['completed', 'running', 'held:human', 'failed']) expect(cockpit({ ...snap, rows: snap.rows.map(r => ({ ...r, state })) }, now.getTime()).needs).toHaveLength(1);
  const empty = renderToString(createElement(Frame, { snap: { at: now.toISOString(), summary: {}, rows: [] }, width: 46, height: 100, now }), { columns: 46 });
  expect(empty).toEndWith('无进行中任务');
});
test('board exits with the wrapper restart code when its recorded engine changes', () => {
  expect(boardExitCode('original', 'original')).toBe(0); expect(boardExitCode('original', 'upgraded')).toBe(ENGINE_CHANGED); expect(ENGINE_CHANGED).toBe(75);
});
