import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortModel, sessionModel } from '../src/models';
import { attribute, jobSession, parseUsage, readUsage, refreshUsage, sessionKey, usageSummary, usageText, type Owner, type UsageCache } from '../src/usage';
import { handler, overview } from '../src/web/server';
import { tmp } from './helpers';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Frame } from '../src/board/App';
import type { BoardRow, Snapshot } from '../src/board/data';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const setup = (): string => { const r = tmp(); Object.assign(process.env, { SUPERAGENT_HOME: r, ARCHON_HOME: join(r, 'archon'), CODEX_HOME: join(r, 'codex'), CLAUDE_CONFIG_DIR: join(r, 'claude') }); return r; };
const numbers = { inputTokens: 20, outputTokens: 8, reasoningOutputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 2, totalTokens: 40 };
const uuid = '12345678-1234-1234-1234-123456789abc';
const claude = { session: [{ period: uuid, modelsUsed: ['claude-opus-5-5'], ...numbers, totalCost: 2, metadata: { lastActivity: '2026-10-10T00:00:00Z' }, modelBreakdowns: [{ modelName: 'claude-opus-5-5', ...numbers }] }] };
const codex = { sessions: [{ sessionId: `rollout-2026-10-10T12-00-00-${uuid}`, models: { 'gpt-6.1-sol': numbers }, ...numbers, costUSD: 1, lastActivity: '2026-10-10T00:00:00Z' }] };
const owner = (kind: Owner['kind']): Owner => ({ kind, client: 'codex', role: 'general', model: 'gpt-6.1-sol', cwd: '/repo' });

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

describe('WP-BT6 accounting', () => {
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

describe('WP-BT6 HTTP and board boundary', () => {
  const get = handler(39890, 'token', () => ({ safe: true }));
  const req = (path = '/', headers: Record<string, string> = {}, method = 'GET'): Request => new Request(`http://127.0.0.1:39890${path}`, { method, headers: { Host: '127.0.0.1:39890', ...headers } });
  test('Host/token/method guards; cookies and security headers apply also to errors', async () => {
    expect(get(req('/?t=token', { Host: 'evil.test' })).status).toBe(403); expect(get(req())).toHaveProperty('status', 401); expect(get(req('/?t=wrong')).status).toBe(401); expect(get(req('/?t=token', {}, 'POST')).status).toBe(405);
    const page = get(req('/?t=token')); expect(page.status).toBe(200); expect(page.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict'); expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'self'"); expect(page.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(get(req('/api/overview', { Cookie: 'sa_web=token' })).status).toBe(200); expect(await get(req('/api/overview?t=token')).json()).toEqual({ safe: true }); expect(await get(req('/?t=token', {}, 'HEAD')).text()).toBe('');
  });
  test('explicit API projection drops nested prompt/argv/artifacts', () => {
    setup(); const s = { summary: { prompt: 'SECRET' }, rows: [], at: 'now', activity: { jobs: [], procs: [], terms: [{ kind: 'codex', tier: 'general', model: 'gpt-6.1-sol', pid: 1, state: 'busy', cwd: '/repo', argv: ['SECRET'], prompt: 'SECRET' }], remote: [], notes: ['SECRET'] } } as unknown as Snapshot;
    const o = JSON.stringify(overview(s)); expect(o).not.toMatch(/prompt|argv|SECRET/); expect(o).toContain('sol6.1');
    expect(overview(s).estimate).toMatchObject({ dollars: null });
  });
  test('wide and compact show mapped models and today header without overflow', () => {
    setup(); const s: Snapshot = { summary: {}, rows: [], at: new Date().toISOString(), usage: { at: 'now', status: 'ok', sources: {}, sessions: [], daily: [] }, activity: { terms: [{ kind: 'codex', tier: 'general', model: 'gpt-6.1-sol', pid: 1, state: 'busy', tty: 'tty1', cwd: '/repo', tool: null, since_ms: null, bound: true }], jobs: [], procs: [], remote: [], notes: [] } };
    for (const width of [59, 140]) { const out = renderToString(createElement(Frame, { snap: s, home: '/sa', width, height: 100, interval: 5, sel: -1, activeOnly: false, detail: null, now: new Date(), footer: false }), { columns: width }); expect(out).toContain('角色今日用量未知'); expect(out).toContain('tok 今日'); for (const line of out.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width); }
  });
  test('run token column preserves full role/model at 120 and 140 columns', () => {
    setup(); const row: BoardRow = { run_id: '20261010-000000-abcd', model: 'gpt-6.1-sol', state: 'running', exit: null, nodes: { done: 1, total: 3, current: 'code-long-node-name', currentRole: 'coder' }, started_at: '2026-10-10T00:00:00Z', span: null, elapsed_s: null, held: null, recoveries: 0, auto_retries: 0, console: 'codex', repo: 'repo', branch: 'branch', evidence: '', plan: '', stale: false };
    const sessions = parseUsage(codex, 'codex'); attribute(sessions, [{ id: uuid, owner: { ...owner('run'), run_id: row.run_id } }]);
    const snap: Snapshot = { summary: {}, at: 'now', rows: [row], usage: { at: 'now', status: 'ok', sources: {}, sessions, daily: [] } };
    expect(overview({ ...snap, rows: [{ ...row, nodes: { ...row.nodes, current: 'review-m1-r2' }, recoveries: 3 }] }).runs).toMatchObject([{ rounds: 2, recoveries: 3 }]);
    for (const width of [100, 120, 140]) { const out = renderToString(createElement(Frame, { snap, home: '/sa', width, height: 100, interval: 5, sel: -1, activeOnly: false, detail: null, now: new Date(), footer: false }), { columns: width }); expect(out).toContain('将军·sol6.1'); if (width >= 120) expect(out).toContain(' 40'); for (const line of out.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width); }
  });
});
