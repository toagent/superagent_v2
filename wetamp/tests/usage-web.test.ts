import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortModel, sessionModel } from '../src/models';
// prettier-ignore
import { attribute, jobSession, parseUsage, readUsage, refreshUsage, sessionKey, usageSummary, usageText, usageEvidence, type Owner, type UsageCache } from '../src/usage';
import { overview } from '../src/web/server';
import { tmp } from './helpers';
import type { BoardRow, Snapshot } from '../src/board/data';
import { normalizeTokens, sessionTokens, tokenTotals, tokenFees, investmentOf } from '../src/usage';
import { buildReport, criticalPath, demandStats } from '../src/report';
import { intakeRoot } from '../src/intake';
import { jobCli, readJobs } from '../src/jobs';
import type { Ledger } from '../src/cli';
import { capturedSourceRoots, DEFAULT_WORKFLOW_SOURCE_CONFIG } from '../../packages/workflows/src/workflow-source';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SA_ARCHON_BIN', 'SUPERAGENT_RELAY_QUOTA_URL', 'SUPERAGENT_RELAY_QUOTA'] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
// prettier-ignore
afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
// prettier-ignore
const setup = (): string => { const r = tmp(); Object.assign(process.env, { SUPERAGENT_HOME: r, ARCHON_HOME: join(r, 'archon'), CODEX_HOME: join(r, 'codex'), CLAUDE_CONFIG_DIR: join(r, 'claude') }); return r; };
// prettier-ignore
const numbers = { inputTokens: 20, outputTokens: 8, reasoningOutputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 2, totalTokens: 40 };
const uuid = '12345678-1234-1234-1234-123456789abc';
// prettier-ignore
const claude = { session: [{ period: uuid, modelsUsed: ['claude-opus-5-5'], ...numbers, totalCost: 2, metadata: { lastActivity: '2026-10-10T00:00:00Z' }, modelBreakdowns: [{ modelName: 'claude-opus-5-5', ...numbers }] }] };
// prettier-ignore
const codex = { sessions: [{ sessionId: `rollout-2026-10-10T12-00-00-${uuid}`, models: { 'gpt-6.1-sol': numbers }, ...numbers, costUSD: 1, lastActivity: '2026-10-10T00:00:00Z' }] };
// prettier-ignore
const owner = (kind: Owner['kind']): Owner => ({ kind, client: 'codex', role: 'general', model: 'gpt-6.1-sol', cwd: '/repo' });

// prettier-ignore
describe('WP-BT6 naming and metadata', () => {
  test('one family/version rule including unknown and compact models', () => {
    const cases = { 'claude-opus-5-5': 'opus5.5', 'claude-opus-5': 'opus5', 'claude-opus-4-8': 'opus4.8', 'claude-fable-5-1': 'fable5.1', 'gpt-6.1-sol': 'sol6.1', 'gpt-6-sol': 'sol6', 'gpt-6-astra': 'astra', 'claude-haiku-4-5': 'haiku4.5', 'claude-sonnet-4-6': 'sonnet4.6', 'qwen3.8': 'qwen3.8', 'openai/unfamiliar-model': 'unfamiliar' };
    for (const [a, b] of Object.entries(cases)) expect(shortModel(a)).toBe(b);
    expect(shortModel('gpt-6.1-sol', true)).toBe('sol'); expect(shortModel('claude-opus-5-5', true)).toBe('opus');
    expect(shortModel('anthropic/claude-opus-5-5')).toBe('opus5.5');
    expect(shortModel(null)).toBe(''); expect(shortModel('unknown')).toBe('');
    expect(Bun.stringWidth(shortModel('openai/中文中文中文中文'))).toBeLessThanOrEqual(10);
  });
  test('tail metadata takes last assistant/turn_context, ignoring prose and truncated lines', () => {
    const r = setup(), f = join(r, 'tail.jsonl');
    writeFileSync(f, 'x'.repeat(70000) + '\n' + [JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: 'DO_NOT_RETURN' } }), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }), '{partial'].join('\n'));
    expect(sessionModel(f, 'claude')).toBe('claude-opus-5-5'); expect(sessionModel(f, 'codex')).toBe('gpt-6.1-sol'); expect(sessionModel('/missing', 'codex')).toBeNull();
  });
  test('unique job metadata; ambiguity never guesses; Claude reads first metadata only', () => {
    const r = setup(), date = new Date('2026-10-10T00:00:00Z'), day = date.toLocaleDateString('sv-SE').split('-');
    const d = join(r, 'codex', 'sessions', ...day); mkdirSync(d, { recursive: true });
    const line = (id: string): string => JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo', timestamp: date.toISOString() } });
    writeFileSync(join(d, 'rollout-a.jsonl'), line(uuid) + '\nPRIVATE');
    const job = { kind: 'codex' as const, cwd: '/repo', started_at: date.toISOString() };
    expect(jobSession(job)).toBe(uuid); writeFileSync(join(d, 'rollout-b.jsonl'), line('other')); expect(jobSession(job)).toBeNull();
    const c = join(r, 'claude', 'projects', '-repo'); mkdirSync(c, { recursive: true });
    writeFileSync(join(c, 'session.jsonl'), JSON.stringify({ sessionId: uuid, timestamp: date.toISOString() }) + '\nPRIVATE');
    expect(jobSession({ ...job, kind: 'claude' })).toBe(uuid);
  });
});

// prettier-ignore
describe('WP-BT6 accounting', () => {
  test('METRICS_CONSISTENCY normalizes raw sessions and gross engine; cumulative snapshots are not summed', () => {
    const raw = { input: 20, output: 8, cacheRead: 10, cacheWrite: 2 };
    expect(normalizeTokens(raw, 'claude-raw')).toMatchObject({ input: 32, output: 8 });
    expect(normalizeTokens(raw)).toEqual(raw);
    const c = parseUsage(claude, 'claude')[0], x = parseUsage(codex, 'codex')[0];
    expect(tokenTotals([sessionTokens(c), sessionTokens(x)])).toMatchObject({ input: 64, output: 16 });
    expect(tokenFees([raw])).toBe('unknown');
    expect(tokenFees([{ ...raw, cost: 0 }])).toBe(0);
    const later = { ...codex.sessions[0], inputTokens: 30, totalTokens: 50, lastActivity: '2026-10-11T00:00:00Z' };
    expect(parseUsage({ sessions: [later, codex.sessions[0]] }, 'codex')).toMatchObject([{ input: 30, total: 50 }]);
  });
  test('METRICS_CONSISTENCY structured equations preserve raw fields and propagate unknown', () => {
    const s = parseUsage(codex, 'codex')[0];
    expect(sessionTokens(s)).toMatchObject({ basis: 'raw-exclusive', input: 32, output: 8, total: 40, raw: { input: 20, cacheRead: 10, cacheWrite: 2 } });
    expect(sessionTokens({ ...s, total: 28 })).toMatchObject({ basis: 'gross', input: 20, output: 8 });
    expect(sessionTokens({ ...s, client: 'claude', total: 28 })).toMatchObject({ basis: 'gross', input: 20 });
    const observed = sessionTokens({ ...s, input: 55316824, output: 8017576, cacheRead: 1186724837, cacheWrite: 8512347, total: 1258571584 });
    expect(observed).toMatchObject({ basis: 'raw-exclusive', input: 1250554008, output: 8017576 });
    expect(observed.input! + observed.output! - observed.cacheRead! - observed.cacheWrite!).toBe(63334400);
    for (const bad of [{ ...s, total: 39 }, { ...s, input: -1 }, { ...s, cacheRead: NaN }, { ...s, input: 1, total: 9 }, { ...s, cacheRead: 0, cacheWrite: 0, total: 28 }]) {
      const normalized = sessionTokens(bad);
      expect(normalized).toMatchObject({ basis: 'unknown', raw: { total: bad.total } });
      expect(normalized.reason).toBeDefined(); expect(normalized.input).toBeUndefined();
      expect(tokenTotals([sessionTokens(s), normalized])).toMatchObject({ input: 'unknown', output: 'unknown', cacheRead: 'unknown', cacheWrite: 'unknown', reasons: [normalized.reason] });
    }
    const missing = parseUsage({ sessions: [{ ...codex.sessions[0], cacheReadTokens: undefined }] }, 'codex')[0];
    expect(sessionTokens(missing).basis).toBe('unknown');
    expect(tokenFees([sessionTokens({ ...s, cost: null })])).toBe('unknown');
  });
  test('METRICS_CONSISTENCY report uses captured owner roots; missing clocks and repeated attempts remain unknown', () => {
    const root = setup(), capture = join(root, 'capture'), bin = join(root, 'archon-stub');
    const anchor = { root: capture, digest: 'fixture', config: DEFAULT_WORKFLOW_SOURCE_CONFIG };
    const project = capturedSourceRoots(anchor).project;
    if (!project) throw new Error('missing_captured_project');
    const dir = join(project, '.archon/workflows/fixture');
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'fixture.yaml'), 'nodes:\n  - id: code-a\n');
    const start = '2026-10-10T00:00:00Z';
    const event = { event_type: 'node_completed', step_name: 'code-a', data: { invocation: { startedAt: start }, attempt: { startedAt: start }, timing: { startedAt: start, durationMs: 1000 } } };
    const run = { id: 'engine', status: 'completed' as const, started_at: start, completed_at: '2026-10-10T00:00:01Z', output_root: root, nodes: [], events: [event], metadata: { workflow_source: { version: 1, root: capture, origin: root, captured_at: start, digest: anchor.digest, file_count: 1, byte_count: 1 } } };
    writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n', { mode: 0o755 });
    process.env.SA_ARCHON_BIN = bin;
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [] }));
    const ledger = { run_id: 'r', archon_run_id: 'engine', repo: root, gen_dir: root, plan: join(root, 'plan.json'), workflow: 'fixture', console: 'codex', started_at: start, branch: 'task', recoveries: [] } as unknown as Ledger;
    expect(buildReport([ledger]).critical_path).toMatchObject({ 'r/engine': { status: 'measured', elapsed_ms: 1000 } });
    const graph = [{ id: 'code-a' }];
    expect(criticalPath({ ...run, metadata: undefined }, [{ ...event, data: {} }], graph).status).toBe('unknown');
    expect(criticalPath({ ...run, metadata: undefined }, [event, event], graph).status).toBe('unknown');
  });
  test('both vendor shapes, thread suffix and duplicates', () => {
    expect(parseUsage(claude, 'claude')[0]).toMatchObject({ id: uuid, input: 20, output: 8, cacheWrite: 2, total: 40 });
    const sessions = parseUsage({ sessions: [...codex.sessions, ...codex.sessions] }, 'codex');
    expect(sessions).toHaveLength(1); expect(sessions[0]).toMatchObject({ id: uuid, reasoning: 3, model: 'gpt-6.1-sol' });
    expect(sessionKey(codex.sessions[0].sessionId)).toBe(uuid); expect(() => parseUsage({}, 'codex')).toThrow('invalid_json_shape');
  });
  test('five ownership levels and durable priority, same session counted once', () => {
    const kinds = ['run', 'job', 'interactive', 'inferred', 'unknown'] as const;
    const sessions = kinds.map((_, i) => ({ ...parseUsage(codex, 'codex')[0], id: `id${i}` }));
    const claims = kinds.slice(0, 4).flatMap((k, i) => [{ id: `id${i}`, owner: owner('unknown') }, { id: `id${i}`, owner: owner(k) }]);
    const index = attribute(sessions, claims);
    expect(sessions.map(s => s.owner?.kind)).toEqual([...kinds]);
    attribute(sessions, [{ id: 'id0', owner: owner('interactive') }], index); expect(sessions[0].owner?.kind).toBe('run');
    const c: UsageCache = { at: 'now', status: 'ok', sources: {}, sessions, daily: [] }; expect(usageSummary(c).total).toMatchObject({ sessions: 5, total: 200 });
  });
  test('multi-model sessions split role/model tokens without double counting session total', () => {
    const s = parseUsage({ session: [{ ...claude.session[0], modelBreakdowns: [{ modelName: 'claude-opus-5-5', ...numbers }, { modelName: 'claude-fable-5-1', ...numbers }] }] }, 'claude');
    attribute(s, [{ id: uuid, owner: { ...owner('interactive'), client: 'claude', role: 'commander' } }]);
    const g = usageSummary({ at: null, status: 'ok', sources: {}, sessions: s, daily: [] });
    expect(Object.keys(g.by_role_model as object)).toContain('commander·opus5.5'); expect(Object.keys(g.by_role_model as object)).toContain('commander·fable5.1'); expect(g.total).toMatchObject({ sessions: 1 });
  });
  test('failed collector is unknown instead of zero, cache/index atomic and amounts absent from CLI', async () => {
    const r = setup();
    const failed = await refreshUsage(undefined, () => Promise.reject(new Error('timeout')));
    expect(failed.status).toContain('用量未知'); expect(usageSummary(failed).total).toBeNull(); expect(usageText(failed)).not.toContain('≈$');
    const good = await refreshUsage('20261010', (client, mode) => Promise.resolve(mode === 'session' ? client === 'claude' ? claude : codex : { daily: [{ ...numbers, ...(client === 'claude' ? { period: '2026-10-10' } : { date: '2026-10-10' }) }] }));
    expect(good.daily.map(d => d.day)).toEqual(['2026-10-10', '2026-10-10']); expect(readUsage().status).toBe('ok'); expect(Object.keys(JSON.parse(readFileSync(join(r, 'usage/sessions.json'), 'utf8')))).toHaveLength(2);
    expect(JSON.stringify(usageSummary(good))).not.toContain('"cost"');
    const stale = await refreshUsage(undefined, () => Promise.reject(new Error('exit_nonzero'))); expect(stale.sessions).toHaveLength(2); expect(usageSummary(stale).total).toBeNull();
  });
});

// prettier-ignore
test('supplementary panel preserves role/model/token and excludes terminal details', () => {
  setup(); const row: BoardRow = { run_id: 'r', model: 'gpt-6.1-sol', state: 'running', exit: null, nodes: { done: 1, total: 3, current: 'code-a', currentRole: 'coder' }, started_at: '2026-10-10T00:00:00Z', span: null, elapsed_s: null, held: null, recoveries: 0, auto_retries: 0, console: 'codex', repo: 'repo', branch: 'branch', evidence: '', plan: '', stale: false };
  const sessions = parseUsage(codex, 'codex'); attribute(sessions, [{ id: uuid, owner: { ...owner('run'), run_id: row.run_id } }]);
  const snap: Snapshot = { summary: { prompt: 'SECRET' }, at: row.started_at, rows: [row], usage: { at: 'now', status: 'ok', sources: {}, sessions, daily: [] } };
  expect(overview(snap).runs).toMatchObject([{ role: '将军·sol6.1', tokens: '40' }]);
  expect(JSON.stringify(overview(snap))).not.toMatch(/SECRET|argv|prompt/);
});

// prettier-ignore
test('usage refresh reuses durable historical evidence and queries only active or changed runs', () => {
  const r = setup();
  mkdirSync(join(r, 'runs'), { recursive: true });
  mkdirSync(join(r, 'usage'), { recursive: true });
  const ledger = (id: string, extra = {}) => writeFileSync(join(r, 'runs', `${id}.json`), JSON.stringify({
    run_id: id, archon_run_id: id, repo: r, branch: 'fixture', gen_dir: r, workflow: 'test', started_at: '2026-10-10T00:00:00Z', ...extra,
  }));
  ledger('done');
  ledger('live', { adoptions: [{ from: 'history', to: 'live' }] });
  const calls: string[] = [];
  let liveStatus = 'running';
  const query = (args: string[]) => {
    const id = args[2]!;
    calls.push(id);
    return { id, status: id === 'live' ? liveStatus : 'completed', working_path: r,
      events: [{ step_name: 'code', event_type: 'node_completed', data: { provider: 'codex', session_id: id } }] };
  };
  const refresh = () => {
    const evidence = usageEvidence(query);
    writeFileSync(join(r, 'usage/runs.json'), JSON.stringify(evidence.runs));
    return evidence;
  };
  const first = refresh();
  expect(calls.sort()).toEqual(['done', 'history', 'live']);
  calls.length = 0;
  expect(refresh().claims).toEqual(first.claims);
  expect(calls).toEqual(['live']);
  calls.length = 0;
  ledger('new');
  const changed = new Date(Date.now() + 5000);
  utimesSync(join(r, 'runs/done.json'), changed, changed);
  refresh();
  expect(calls.sort()).toEqual(['done', 'live', 'new']);
  liveStatus = 'cancelled';
  refresh();
  calls.length = 0;
  refresh();
  expect(calls).toEqual([]);
});

// prettier-ignore
describe('DEMAND_INVESTMENT', () => {
  test('same invocation and cumulative continuation are counted once; conflicts and missing usage stay unknown', () => {
    setup();
    const session = { ...parseUsage(codex, 'codex')[0], owner: { ...owner('job'), job_id: 'j', request_ref: 'ticket:42' } };
    const call = { provider: 'codex', session: uuid, identity: 'turn-1', tokens: { input: 10, output: 1, cost: 0.5 } };
    expect(investmentOf([call, call], [])).toMatchObject({ input: 10, fees: 0.5, coverage: '1/1' });
    expect(investmentOf([call, call, { ...call, identity: 'turn-2' }], [session, session])).toMatchObject({ input: 'unknown', fees: 'unknown', coverage: '1/3', status: 'unknown' });
    expect(investmentOf([call], [{ ...session, input: 30, total: 50 }, session])).toMatchObject({ input: 'unknown', known_tokens: { input: 42 }, deduplication: 'unknown' });
    expect(investmentOf([{ ...call, tokens: { input: 200, output: 20, cost: 2 } }], [session])).toMatchObject({ status: 'unknown', input: 'unknown', fees: 'unknown', coverage: '1/2' });
    expect(investmentOf([{ ...call, tokens: null }], [])).toMatchObject({ input: 'unknown', coverage: '0/1' });
    expect(investmentOf([{ ...call, identity: null }], [])).toMatchObject({ deduplication: 'unknown' });
    const index = attribute([session], [{ id: uuid, owner: session.owner }, { id: uuid, owner: { ...session.owner, request_ref: 'ticket:other' } }]);
    expect(index[`codex:${uuid}`]?.conflict).toBe(true);
    expect(investmentOf([], [session])).toMatchObject({ input: 'unknown', status: 'unknown' });
  });
  test('failed/cancelled attempts, unverified jobs and current revision obligations', () => {
    const root = setup();
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [], request_ref: 'ticket:42' }));
    const pairs = ['failed', 'cancelled'].map((status, i) => ({ ledger: { run_id: `r${i}`, gen_dir: root, repo: root, started_at: '2026-10-10T00:00:00Z' }, run: { id: `r${i}`, status } })) as Parameters<typeof demandStats>[0];
    const sessions = parseUsage(codex, 'codex');
    attribute(sessions, [{ id: uuid, owner: { ...owner('run'), run_id: 'r0', request_ref: 'ticket:42' } }]);
    const jobs = [{ id: 'commander', request_ref: 'ticket:42', session_id: uuid, kind: 'codex' }, { id: 'support', request_ref: 'ticket:42' }] as NonNullable<Parameters<typeof demandStats>[3]>;
    const dir = intakeRoot(root, root); mkdirSync(dir, { recursive: true });
    const task = (id: string) => ({ id, repo: root, revision: 2, revisions: [{ requirements: [{ id: 'old', text: 'old' }] }, { requirements: [{ id: 'now', text: 'now' }, { id: 'next', text: 'next' }] }], runs: [], dependencies: [], questions: [], cancellations: [] });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, inputs: [], tasks: [task('a'), task('b')] }));
    const result = demandStats(pairs, [], [...sessions, { ...sessions[0]!, id: 'unassigned', owner: owner('unknown') }], jobs);
    expect(result).toMatchObject({ denominator: 1, completed: 0, by_request: { 'ticket:42': { attempts: [{ status: 'failed' }, { status: 'cancelled' }], complete: 'unknown', investment: { input: 'unknown', coverage: '1/3', known_tokens: { input: 32 } } } }, current_tasks: { [root]: { obligations: 4, tasks: [{ id: 'a', revision: 2, obligations: 2, completion: 'unknown' }, { id: 'b', revision: 2, obligations: 2 }] } }, unattributed: { input: 32 } });
    expect(demandStats(pairs, [], sessions, jobs.slice(0, 1))).toMatchObject({ by_request: { 'ticket:42': { investment: { status: 'unknown', input: 'unknown', coverage: '1/2' } } } });
    expect(demandStats(pairs, [], [{ ...sessions[0]!, owner: { ...sessions[0]!.owner!, conflict: true } }], jobs.slice(0, 1))).toMatchObject({ by_request: { 'ticket:42': { investment: { status: 'unknown' } } } });
  });
  test('cross-source demand conflicts and unreadable generations cannot report known investment', () => {
    const root = setup(), other = join(root, 'other'); mkdirSync(other);
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [], request_ref: 'A' }));
    writeFileSync(join(other, 'plan.json'), JSON.stringify({ packages: [], request_ref: 'B' }));
    const pairs = [root, other].map((gen_dir, i) => ({ ledger: { run_id: `r${i}`, gen_dir, repo: root, started_at: '2026-10-10T00:00:00Z' }, run: { id: `r${i}`, status: 'failed' } })) as Parameters<typeof demandStats>[0];
    const calls = [{ run: 'r0', provider: 'codex', session: uuid, identity: 'turn', tokens: { input: 200, output: 20, cost: 2 } }] as Parameters<typeof demandStats>[1];
    const session: Parameters<typeof investmentOf>[1][number] = { ...parseUsage(codex, 'codex')[0]!, owner: { ...owner('job'), job_id: 'commander', request_ref: 'B' } };
    const jobs = [{ id: 'commander', request_ref: 'B', session_id: uuid, kind: 'codex' }] as NonNullable<Parameters<typeof demandStats>[3]>;
    const investment = { status: 'unknown', input: 'unknown', fees: 'unknown', known_tokens: { input: 'unknown' } };
    expect(demandStats(pairs, calls, [session], jobs)).toMatchObject({ by_request: { A: { investment }, B: { investment } }, unattributed: { input: 32 } });
    session.owner = { ...owner('run'), run_id: 'r0', request_ref: 'A' };
    expect(demandStats([{ ...pairs[0]!, run: new Error('unreadable') }], [], [session])).toMatchObject({ by_request: { A: { investment: { status: 'unknown', coverage: '1/2', known_tokens: { input: 32 } } } } });
    expect(demandStats(pairs.slice(0, 1), [], [session], [], { r0: 2 })).toMatchObject({ by_request: { A: { investment: { status: 'unknown', coverage: '1/3' } } } });
  });
  test('job entrance persists only explicit request reference; learning remains shared', async () => {
    const root = setup(); process.env.SUPERAGENT_RELAY_QUOTA_URL = ''; process.env.SUPERAGENT_RELAY_QUOTA = '';
    try {
      expect(await jobCli(['job', 'exec', '--title', 'support', '--request-ref', 'ticket:42', '--', 'true'], () => ({ pressure: 1, free: 90, source: 'sysctl' }))).toBe(0);
      const job = readJobs(Date.now(), true).jobs[0]!; expect(job.request_ref).toBe('ticket:42');
      const guessed = { ...job, pid: 123, kind: 'codex' as const, role: 'commander' as const };
      const logs = join(root, 'codex/sessions', ...new Date(job.started_at).toLocaleDateString('sv-SE').split('-')); mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'unrelated.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: job.cwd, timestamp: job.started_at } }));
      expect(jobSession(guessed)).toBe(uuid);
      for (const session_id of [undefined, jobSession(guessed)]) {
        writeFileSync(join(root, 'jobs', `${job.id}.json`), JSON.stringify({ ...guessed, session_id }));
        expect(usageEvidence().claims).toContainEqual({ id: uuid, owner: { client: 'codex', role: 'commander', model: null, cwd: job.cwd, kind: 'inferred', job_id: job.id } });
      }
      mkdirSync(join(root, 'usage'), { recursive: true }); mkdirSync(join(root, 'jobs'), { recursive: true });
      const session = { ...parseUsage(codex, 'codex')[0], owner: { ...owner('job'), job_id: 'learn', request_ref: 'ticket:42' } };
      writeFileSync(join(root, 'usage/cache.json'), JSON.stringify({ at: 'now', status: 'ok', sources: {}, sessions: [session], daily: [] }));
      writeFileSync(join(root, 'jobs/learn.json'), JSON.stringify({ id: 'learn', title: 'memory-reflect:fixture', cwd: root, kind: 'codex', pid: 0, wrapper_pid: 0, started_at: '2026-10-10T00:00:00Z', state: 'failed' }));
      expect(buildReport([]).demands).toMatchObject({ by_request: { 'ticket:42': { investment: { input: 'unknown' } } }, shared_learning: { input: 32 } });
    } finally { delete process.env.SUPERAGENT_RELAY_QUOTA_URL; delete process.env.SUPERAGENT_RELAY_QUOTA; }
  });
});
