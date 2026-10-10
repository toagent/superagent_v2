import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import { attribute, parseUsage, refreshUsage, usageCommand, usageEvidence, type UsageSession } from '../src/usage';
import { overview, panel } from '../src/web/server';
import { cockpit } from '../src/board/cockpit';
import { rowOf, type BoardRow, type Snapshot } from '../src/board/data';
import type { Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { archonJson } from '../src/archon';
import { etaInput } from '../src/board/eta';
import type { WorkflowEventRow } from '../../packages/workflows/src/schemas/workflow-event';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TZ'] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const at = '2026-10-10T04:00:00Z', now = Date.parse(at);
const session = (id: string, total = 40): UsageSession => ({ id, client: 'codex', model: 'gpt-6.1-sol', at, cost: null, input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total, sessions: 1 });
const metadata = (id: string) => ({ node: { id, kind: 'agent', source: { kind: 'inline' } }, invocation: { id: 'v', startedAt: at, loopPath: [] }, attempt: { id: 'a', startedAt: at }, timing: { startedAt: at }, accounting: 'node', spend: Object.fromEntries(['tokens', 'costUsd', 'stopReason', 'numTurns'].map(k => [k, { source: 'unavailable', reason: 'not_reported' }])) });
function setup() {
  const root = tmp(); Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: join(root, 'archon'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), TZ: 'Asia/Taipei' });
  for (const d of ['runs', 'jobs', 'live', '.archon/workflows/w']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, '.archon/workflows/w/w.yaml'), Bun.YAML.stringify({ nodes: [{ id: 'code-a', model: '@sa-coder' }, { id: 'review-a', model: '@sa-reviewer' }] }));
  const ledger: Ledger = { run_id: 'r', archon_run_id: 'new', repo: root, gen_dir: root, workflow: 'w', plan: '', branch: 'b', console: 'codex', started_at: at, transcript: '', log: '', recoveries: [], adoptions: [{ at, from: 'old', to: 'new', engine_from: null, engine_to: 'h', reason: 'upgrade' }, { at, from: 'missing', to: 'new', engine_from: null, engine_to: 'h', reason: 'upgrade' }] };
  writeFileSync(join(root, 'runs/r.json'), JSON.stringify(ledger));
  const binding = (model: string) => ({ provider: 'codex', model: { requested: '@sa-coder', resolved: { source: 'provider', value: model } } });
  const event = (step_name: string, session_id: string, model: string) => ({ event_type: 'node_completed', step_name, data: { ...metadata(step_name), session_id, binding: binding(model) } });
  writeFileSync(join(root, 'new.json'), JSON.stringify({ id: 'new', status: 'completed', working_path: root, events: [event('review-a', 'review-session', 'gpt-6-astra')] }));
  writeFileSync(join(root, 'old.json'), JSON.stringify({ id: 'old', status: 'completed', working_path: root, events: [event('code-a', 'code-session', 'gpt-6.1-sol')] }));
  writeFileSync(join(root, 'jobs/j.json'), JSON.stringify({ id: 'j', cwd: root, kind: 'codex', started_at: at, session_id: 'job-session', role: 'strategist', model: 'gpt-6-astra', state: 'done' }));
  writeFileSync(join(root, 'live/i.json'), JSON.stringify({ session_id: 'interactive', client: 'codex', cwd: '/other', model: 'gpt-6-astra', at }));
  const stub = join(root, 'query'); writeFileSync(stub, `#!/bin/sh\ncat '${root}/'"$3"'.json'\n`, { mode: 0o755 }); process.env.SA_ARCHON_BIN = stub;
  return { root, ledger, binding };
}
test('explicit client collector avoids unified duplicates and accepts Claude 20 sessions shape', () => {
  for (const client of ['claude', 'codex'] as const) expect(usageCommand(client, 'session', '20261010')).toEqual(['nice', '-n', '10', 'bunx', 'ccusage@20.0.28', client, 'session', '--json', '--since', '20261010']);
  expect(parseUsage({ sessions: [{ sessionId: 'claude-only', inputTokens: 1, outputTokens: 2, totalTokens: 3, modelsUsed: ['claude-opus-5'], lastActivity: at }] }, 'claude')[0]).toMatchObject({ id: 'claude-only', client: 'claude', model: 'claude-opus-5', total: 3 });
});
test('current and adopted Archon, explicit job and interactive ownership survive a missing history run', async () => {
  const { root, ledger } = setup(); const sessions = ['code-session', 'review-session', 'job-session', 'interactive'].map(id => session(id));
  const queried = archonJson(['workflow', 'get', 'new', '--verbose', '--events'], root);
  expect(etaInput(ledger, queried as unknown as RunView, queried.events as WorkflowEventRow[]).run.nodes).toHaveLength(1);
  attribute(sessions, usageEvidence().claims);
  expect(sessions.map(s => [s.owner?.kind, s.owner?.role, s.owner?.model])).toEqual([['run', 'general', 'gpt-6.1-sol'], ['run', 'strategist', 'gpt-6-astra'], ['job', 'strategist', 'gpt-6-astra'], ['interactive', null, 'gpt-6-astra']]);
  const c = await refreshUsage('20261010', (client, mode) => Promise.resolve(mode === 'daily' ? { daily: [{ date: '2026-10-10', totalTokens: 160 }] } : { sessions: client === 'claude' ? [] : sessions.map(s => ({ sessionId: s.id, inputTokens: 40, outputTokens: 0, totalTokens: 40 })) }));
  expect(c.status).toBe('ok'); expect(c.sessions.map(s => s.owner?.role)).toEqual(['general', 'strategist', 'strategist', null]);
});
test('active node matches unique exact worktree/start metadata, terminal and ambiguous launches do not guess', () => {
  const { root, binding } = setup(), dir = join(root, 'codex/sessions/2026/10/10'); mkdirSync(dir, { recursive: true });
  const meta = (id: string, cwd = root) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-10T04:00:01Z' } });
  writeFileSync(join(dir, 'a.jsonl'), meta('inflight') + '\nPRIVATE');
  writeFileSync(join(dir, 'other.jsonl'), meta('other', '/other'));
  const run = { id: 'new', status: 'running', working_path: root, events: [{ step_name: 'code-a', event_type: 'node_started', created_at: at, data: { ...metadata('code-a'), binding: binding('gpt-6.1-sol') } }] };
  const file = join(root, 'new.json'); writeFileSync(file, JSON.stringify(run));
  expect(usageEvidence().claims.find(c => c.id === 'inflight')?.owner).toMatchObject({ kind: 'run', role: 'general', model: 'gpt-6.1-sol', cwd: root });
  writeFileSync(join(dir, 'b.jsonl'), meta('ambiguous')); expect(usageEvidence().claims.some(c => c.id === 'inflight')).toBe(false);
  run.status = 'completed'; writeFileSync(file, JSON.stringify(run)); expect(usageEvidence().claims.some(c => c.id === 'inflight')).toBe(false);
});
function fixture(): Snapshot {
  const row = (id: string, state: string, started_at: string): BoardRow => ({ run_id: id, archon_id: `archon-${id}`, repo: 'demo', state, started_at, coderModel: 'gpt-6.1-sol', model: 'gpt-6-astra', nodes: { done: 2, total: 3, current: 'review-a', currentRole: 'reviewer' }, exit: null, span: { started_ms: Date.parse(started_at), ended_ms: state === "running" ? null : now - 60000 }, elapsed_s: 600, held: null, recoveries: 0, auto_retries: 0, console: 'codex', branch: 'b', evidence: '', plan: '', stale: false, engine: { title: id === 'a' ? '完成任务' : '<script>任务</script>', milestones: [], currentMilestone: null, states: [], firstPass: false, reason: '', dispositions: [{ at: '2026-10-10T03:55:00Z', action: 'ask', reason: 'budget', ok: true }] } });
  const sessions = [session('general', 4000), session('strategist', 3000), session('commander', 2000), session('interactive', 1000)];
  sessions.forEach((s, i) => { s.model = ['gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5', 'gpt-6-astra'][i]; s.owner = { client: 'codex', role: (['general', 'strategist', 'commander', null] as const)[i], kind: i === 3 ? 'interactive' : 'run', model: s.model, cwd: '/demo', run_id: 'a' }; });
  return { at, summary: {}, rows: [row('a', 'completed', '2026-10-10T02:00:00Z'), row('b', 'running', '2026-10-10T03:00:00Z')], asks: { 'b:budget:1': { status: 'pending' }, 'a:budget:1': { status: 'superseded' } }, activity: { terms: [], procs: [], remote: [], notes: [], jobs: [{ id: 'j', title: '独立作业', cwd: '/demo', kind: 'codex', model: 'gpt-6.1-sol', tier: 'general', pid: 1, wrapper_pid: 1, guess: false, owner: null, card: null, log: null, state: 'running', started_at: '2026-10-10T03:50:00Z' }] }, usage: { at, status: 'ok', sources: {}, sessions, today: { day: '2026-10-10', status: 'ok', sessions }, daily: [{ day: '2026-10-10', client: 'codex', input: 10000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10000, sessions: null }] } };
}
test('2 runs, 1 job, pending/superseded and all four token roles render the shared dark panel snapshot', () => {
  setup(); const s = fixture(), d = overview(s), html = panel(d);
  expect(d).toMatchObject({ at: '12:00', running: 2, metrics: { completed: 0, decided: 1 }, needs: [{ project: 'demo', question: '预算已用尽 是=放宽预算再跑 否=终止', waiting: '5m00s' }] });
  expect(d.runs.map(r => [r.id, r.role, r.state, r.url])).toEqual([['b', '军师·astra', '进行中', '/console/r/archon-b'], ['a', '将军·sol6.1', '完成', '/console/r/archon-a']]);
  expect(d.tokenRows?.map(r => [r.role, r.total])).toEqual([['将军', 4000], ['军师', 3000], ['元帅', 2000], ['未归属', 1000]]);
  expect(d.metrics).toEqual(cockpit(s, now).metrics); expect(html).not.toContain('<script>任务'); expect(html).toContain('&lt;script&gt;任务');
  expect(html).toContain('15000'); expect(html).toMatchSnapshot();
  s.asks = {}; expect(panel(overview(s))).not.toContain('id="needs"'); s.usage!.status = 'unavailable'; expect(overview(s).runs.every(r => r.tokens === '—')).toBe(true);
});
test('panel local midnight, future rows, Chinese terminal states and unknown token budget', () => {
  setup(); const s = fixture(), original = s.rows[0];
  s.rows = ['cancelled', 'failed', 'held:human'].map((state, i) => ({ ...original, run_id: String(i), state }));
  s.rows.push({ ...original, run_id: 'yesterday', started_at: '2026-10-09T15:59:59Z' }, { ...original, run_id: 'future', started_at: '2026-10-10T04:00:01Z' });
  expect(overview(s).runs.map(r => r.state)).toEqual(['取消', '失败', '挂起']);
});
test('ended row keeps the actual coding model when current node is a script', () => {
  const { ledger, binding } = setup();
  const run = { id: 'new', status: 'completed', nodes: [{ nodeId: 'code-a', state: 'completed', execution: { binding: binding('gpt-6.1-sol') } }, { nodeId: 'land', state: 'completed' }] } as unknown as RunView;
  const row = rowOf(ledger, run, { now, roles: new Map([['code-a', 'coder'], ['land', 'script']]) });
  expect(row).toMatchObject({ archon_id: 'new', coderModel: 'gpt-6.1-sol' });
  expect(overview({ at, rows: [row], summary: {} }).runs[0].role).toBe('将军·sol6.1');
});
