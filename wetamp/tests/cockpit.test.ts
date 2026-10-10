import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { HOLD_POLICY, type Ledger } from '../src/cli';
import { rowOf, type BoardRow, type Snapshot } from '../src/board/data';
import { cockpit, stages, reasonText, REASONS } from '../src/board/cockpit';
import { Frame } from '../src/board/App';
import { handler, overview } from '../src/web/server';
import { tmp } from './helpers';
import { refreshUsage } from '../src/usage';

const now = new Date('2026-10-10T12:00:00+08:00').getTime();
const iso = (delta = 0): string => new Date(now + delta).toISOString();
const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'TZ'] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeEach(() => { process.env.TZ = 'Asia/Taipei'; });
afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const row = (id: string, state = 'running', current = 'review-m1-r2'): BoardRow => ({
  run_id: id, repo: 'sinan', state, exit: null, model: 'gpt-6-astra', nodes: { done: 3, total: 5, current, currentRole: 'reviewer' },
  started_at: iso(-600000), span: { started_ms: now - 600000, ended_ms: state === 'running' ? null : now - 60000 }, elapsed_s: 600, held: state.startsWith('held:') ? { node: current, event: null } : null,
  recoveries: 0, auto_retries: 0, console: 'codex', branch: 'branch', evidence: '', plan: '', stale: false,
  engine: { title: '题目清单报告：补修订前版本和节分布排序', milestones: ['m1'], currentMilestone: 'm1', states: [{ id: 'code-a', state: 'completed' }, { id: 'verify-a', state: 'completed' }, { id: 'review-m1-r1', state: 'failed' }, { id: current, state: state === 'running' ? 'running' : 'completed' }, { id: 'review-m1-r3', state: 'skipped' }], firstPass: false, reason: '', dispositions: [] },
});
const snapshot = (rows: BoardRow[] = []): Snapshot => ({ rows, summary: { debt: 22 }, at: iso(), heartbeat_ms: now - 12000,
  usage: { at: iso(), status: 'ok', sources: {}, sessions: [], daily: [{ day: new Date(now).toLocaleDateString('sv-SE'), client: 'codex', input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3, sessions: null }] },
  activity: { terms: [{ kind: 'codex', model: 'gpt-6.1-sol', tier: 'general', pid: 1, tty: 's002', state: 'unknown', cwd: '/repo', tool: null, since_ms: null, bound: false }], jobs: [], procs: [], remote: [], notes: [] },
});
const render = (s: Snapshot, width = 62, view: 'cockpit' | 'terminals' = 'cockpit', all = false): string => renderToString(createElement(Frame, { snap: s, width, height: 100, interval: 5, home: '/sa', sel: -1, activeOnly: false, detail: null, now: new Date(now), footer: true, view, all }), { columns: width });

test('local-day achievement, first-pass run count, ask actions across run days and report debt', () => {
  const done = row('done', 'completed'); done.engine!.firstPass = true;
  const fail = row('fail', 'failed'), cancel = row('cancel', 'cancelled'), old = row('old', 'completed'); old.started_at = iso(-86400000);
  old.engine!.dispositions = [{ at: iso(-86400000), action: 'ask', reason: 'budget', ok: true }, { at: iso(-1000), action: 'ask', reason: 'budget', ok: true }, { at: iso(-1000), action: 'retry', reason: 'budget', ok: true }];
  expect(cockpit(snapshot([done, fail, cancel, old]), now).metrics).toEqual({ completed: 1, decided: 2, firstPass: 1, asks: 1, debt: 22 });
  expect(cockpit(snapshot([old]), now).results).toHaveLength(1);
});
test('midnight is local, future starts and missing endings never enter today counts', () => {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const before = row('before', 'completed'); before.started_at = new Date(midnight.getTime() - 1).toISOString(); before.span = null;
  const edge = row('edge', 'completed'); edge.started_at = midnight.toISOString();
  const future = row('future', 'completed'); future.started_at = iso(1000);
  expect(cockpit(snapshot([before, edge, future]), now).metrics.completed).toBe(1);
  expect(cockpit(snapshot([before]), now).results).toEqual([]);
  const active = snapshot([row('a'), row('b')]); active.eta = { a: { weight: 600, progress: { pct: 50, eta_s: 20, overrun_s: 180, basis: 'history' } }, b: { weight: 1200, progress: { pct: 20, eta_s: 600, overrun_s: 0, basis: 'history' } } };
  expect(cockpit(active, now).total).toMatchObject({ eta_s: 600, overrun_s: 180 }); expect(cockpit(active, now).totalText).toContain('剩~10m'); expect(cockpit(active, now).active[0].progressText).toContain('超~3m');
});
test('R2 ignores skipped R3 and prior R1 failure; land and failed nodes retain their phase', () => {
  expect(stages(row('r'))).toBe('M1/1 编✓ 验✓ 评R2◐ 门· 合·');
  const land = row('land', 'running', 'land'); land.engine!.states = [{ id: 'gate-m1-r2', state: 'completed' }, { id: 'land', state: 'running' }];
  expect(stages(land)).toContain('门✓ 合◐');
  const fail = row('fail', 'failed', 'verify-a'); fail.engine!.states = [{ id: 'verify-a', state: 'failed' }]; expect(stages(fail)).toContain('验✗');
  const repaired = row('repaired'); repaired.engine!.states = [{ id: 'code-a', state: 'failed' }, { id: 'repair-a', state: 'completed' }, { id: 'verify-a', state: 'failed' }, { id: 'settle-a', state: 'completed' }, { id: 'review-m1-r2', state: 'running' }];
  expect(stages(repaired)).toBe('M1/1 编✓ 验✓ 评R2◐ 门· 合·');
  for (const [node, mark] of [['repair-a', '编◐'], ['settle-a', '验◐'], ['fix-m1-r2', '评R2◐'], ['environment', '准备◐']]) {
    const r = row(node, 'running', node); r.engine!.states = [{ id: node, state: 'running' }]; expect(stages(r)).toContain(mark);
  }
});
test('every S3 reason translates, unknown reason survives unchanged, needs comes from held and asks', () => {
  expect(Object.keys(REASONS).sort()).toEqual(Object.keys(HOLD_POLICY).sort());
  for (const k of Object.keys(HOLD_POLICY)) expect(reasonText(k)).not.toBe(k);
  expect(reasonText('coder_error:task')).toBe('coder_error:task');
  const r = row('pending'); r.engine!.dispositions = [{ at: iso(-180000), reason: 'auto_retry_exhausted', action: 'ask', ok: true }];
  const c = cockpit({ ...snapshot([r, row('held', 'held:human')]), asks: { 'pending:reason:1': { status: 'pending' } } }, now);
  expect(c.needs).toHaveLength(2); expect(c.active).toHaveLength(0); expect(c.needs[0].question).toBe('重试已用尽：是=再跑 否=终止'); expect(c.needs[0].waiting).toBe('3m00s');
  expect(render(snapshot())).not.toContain('需要你');
});
test('token daily total does not masquerade session cumulative as role/day, unavailable stays unknown', () => {
  const s = snapshot([row('r')]); s.usage!.sessions = [{ id: 'session', client: 'codex', model: 'gpt-6.1-sol', at: iso(), input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 900, sessions: 1, cost: null, owner: { client: 'codex', role: 'general', model: 'gpt-6.1-sol', cwd: '/repo', kind: 'run', run_id: 'r' } }];
  expect(cockpit(s, now)).toMatchObject({ tokens: '3', roleTokens: ['角色今日用量未知'] }); expect(cockpit(s, now).active[0].tokens).toBe('900');
  s.usage!.since = new Date(now).toLocaleDateString('sv-SE').replaceAll('-', ''); expect(cockpit(s, now).roleTokens).toEqual(['将军·sol 900']);
  s.usage!.status = 'unavailable'; expect(cockpit(s, now).tokens).toBe('未知'); expect(cockpit(s, now).active[0].tokens).toBe('未知');
});
test('existing usage collector keeps lifetime and day sessions separate, day failure remains unknown', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const day = new Date().toLocaleDateString('sv-SE'), date = day.replaceAll('-', '');
  const c = await refreshUsage(undefined, (client, mode, since) => Promise.resolve(mode === 'daily' ? { daily: [{ date: day, period: day, totalTokens: 40 }] } : { [client === 'codex' ? 'sessions' : 'session']: [{ sessionId: 's', period: 's', inputTokens: 20, outputTokens: 20, totalTokens: since === date ? 40 : 900, modelsUsed: ['gpt-6.1-sol'] }] }));
  expect(c.sessions.map(s => s.total)).toEqual([900, 900]); expect(c.today?.sessions.map(s => s.total)).toEqual([40, 40]);
  expect(c.today?.day).toBe(day); expect(c.today?.status).toBe('ok');
  c.today!.sessions.forEach(s => { s.owner!.role = 'general'; s.model = 'gpt-6.1-sol'; });
  expect(cockpit({ ...snapshot(), usage: c }, Date.now()).roleTokens).toEqual(['将军·sol 80']);
  const failed = await refreshUsage(undefined, (_client, _mode, since) => since === date ? Promise.reject(new Error('timeout')) : Promise.resolve(_mode === 'daily' ? { daily: [] } : { [_client === 'codex' ? 'sessions' : 'session']: [] }));
  expect(failed.status).toBe('ok'); expect(failed.today?.status).toBe('unavailable');
});
test('62/120 snapshots preserve stages, truncate Chinese titles, keep old terminals on t, expand results', () => {
  const s = snapshot([row('active'), ...Array.from({ length: 7 }, (_, i) => row(`done${String(i)}`, 'completed'))]);
  s.eta = { active: { weight: 660, progress: { pct: 47, eta_s: 720, overrun_s: 0, basis: 'history' } } };
  for (const width of [62, 120]) {
    const out = render(s, width); for (const line of out.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    expect(out).not.toMatch(/s002|未知\?|无主|remote/); expect(out).toContain('军师·astra'); expect(out).toContain('47% 剩~12m'); expect(out).toContain('… 另 2 条'); expect(out).toMatchSnapshot();
  }
  expect(render(s)).not.toContain('active'); expect(render(s, 120)).toContain('active');
  expect(render(s, 62, 'terminals')).toContain('s002'); expect(render(s, 62, 'terminals')).toContain('未知?'); expect(render(s, 62, 'cockpit', true)).not.toContain('另 2 条');
  expect(cockpit({ ...s, heartbeat_ms: now - 181000 }, now).heartbeat).toContain('✗');
});
test('row source resolves relative plan, milestone and first-pass from actual gate artifacts; repairs invalidate', () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const l: Ledger = { run_id: 'sa', archon_run_id: 'a', repo: root, gen_dir: root, plan: 'plan.json', branch: 'b', workflow: 'w', console: 'codex', started_at: iso(-600000), transcript: '', log: '', recoveries: [] };
  writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [{ id: 'a', title: '任务一', milestone: 'm1' }, { id: 'b', title: '任务二', milestone: 'm2' }] }));
  const art = join(root, 'artifacts/runs/a'); mkdirSync(art, { recursive: true });
  for (const m of ['m1', 'm2']) writeFileSync(join(art, `gate-${m}-r1.json`), JSON.stringify({ verdict: 'pass', debt: [], reason: null }));
  const run = { id: 'a', status: 'completed' as const, output_root: root, completed_at: iso(), nodes: [{ nodeId: 'verify-b', state: 'completed' }, { nodeId: 'repair-b', state: 'skipped' }] };
  expect(rowOf(l, run, { now }).engine).toMatchObject({ title: '任务一 +1', milestones: ['m1', 'm2'], firstPass: true });
  run.nodes[1].state = 'completed'; expect(rowOf(l, run, { now }).engine!.firstPass).toBe(false);
  expect(rowOf(l, { ...run, status: 'running', nodes: [{ nodeId: 'code-b', state: 'running' }] }, { now }).engine!.currentMilestone).toBe('m2');
});
test('overview endpoint includes shared cockpit and never leaks prompt or argv', async () => {
  const s = snapshot([row('a')]); s.summary.prompt = 'SECRET';
  const response = handler(39890, 'token', () => overview(s))(new Request('http://127.0.0.1:39890/api/overview?t=token', { headers: { host: '127.0.0.1:39890' } }));
  const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain('"cockpit"'); expect(text).toContain('"progress"'); expect(text).not.toMatch(/prompt|argv|SECRET/);
  expect(JSON.parse(text).cockpit).toEqual(cockpit(s, Date.parse(s.at)));
});
