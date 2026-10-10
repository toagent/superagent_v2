import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldEpisode, injectMemory, lessonText, lintPlan, maintainLessons, memoryData, memoryState, memoryTick, memoryWrite, priorKey, privateProject, saveEpisode, selectLessons, taskTag, triage, triggered, type Episode, type Lesson } from '../src/memory';
import { curate, reflectOne, reflectionInput, reflectionUsage } from '../src/memory-reflect';
import { artifactsOf, main, type Ledger } from '../src/cli';
import { lock, type RunView } from '../src/archon';
import { engineHash, generate } from '../src/generate';
import { install, loadTiers } from '../src/config';
import { type Plan } from '../src/plan';
import { inspectBase } from '../src/preflight';
import { cockpitSignals, type Asks } from '../src/cockpit-signals';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import e1 from './incidents/e1-settle.json';
import e2 from './incidents/e2-asks.json';
import replay from './incidents/ev1-memory.json';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const zeros = { engine_suspect: 0, dup_ask: 0, orphan_hold: 0, stale_answer: 0 };
let root: string, sa: string, plan: Plan, ledger: Ledger, raw: RunView;
const saved = new Map<string, string | undefined>();
const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_MEMORY', 'SUPERAGENT_REFLECT_CMD', 'SA_ARCHON_BIN', 'SUPERAGENT_WRITE_ROOTS', 'FAKE_MEMORY_STARTED', 'FAKE_MEMORY_DELAY', 'FAKE_MEMORY_OVERSIZE', 'FAKE_EV1_RUN'];
beforeEach(() => {
  for (const k of keys) saved.set(k, process.env[k]);
  root = tmp(); sa = join(root, 'home'); mkdirSync(sa);
  process.env.SUPERAGENT_HOME = sa; process.env.ARCHON_HOME = join(sa, 'archon'); process.env.SUPERAGENT_MEMORY = 'on'; delete process.env.SUPERAGENT_REFLECT_CMD; delete process.env.FAKE_MEMORY_DELAY; delete process.env.FAKE_MEMORY_OVERSIZE;
  plan = JSON.parse(readFileSync(fixturePlan(root, root, p => { p.packages = (p.packages as unknown[]).slice(0, 1); }), 'utf8')) as Plan;
  plan.packages[0].scope.write = ['src/cli.ts']; plan.packages[0].accept = [{ cmd: 'bun test --port 39890', timeout_s: 30 }];
  ledger = { run_id: 'incident', archon_run_id: '00000000-0000-4000-8000-000000000001', repo: root, gen_dir: join(sa, 'gen', 'incident'), plan: join(root, 'plan.json'), branch: 'sa/incident', workflow: 'sa-incident', console: 'codex', started_at: new Date(NOW - 60000).toISOString(), transcript: '/forbidden-transcript', log: '', recoveries: [], engine_hash: 'fingerprint' };
  mkdirSync(ledger.gen_dir, { recursive: true }); writeFileSync(join(ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
  raw = { id: ledger.archon_run_id, status: 'failed', started_at: ledger.started_at, completed_at: new Date(NOW).toISOString(), output_root: sa, nodes: [{ nodeId: 'verify-core', state: 'failed' }] };
  mkdirSync(artifactsOf(raw), { recursive: true });
  writeFileSync(join(artifactsOf(raw), 'verify-core.json'), JSON.stringify(replay['project-port']));
});
afterEach(() => { for (const k of keys) { const v = saved.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const episode = (patch: Partial<Episode> = {}): Episode => ({ ...foldEpisode(ledger, plan, raw, [], {}, NOW), ...patch });
const lesson = (id: string, patch: Partial<Lesson> = {}): Lesson => ({ id, tier: 'project', scope: root, tag: 'ts-cli', category: 'project', reasons: ['acceptance_failed'], when: 'port', do: 'free', dont: 'busy', why: 'test', evidence: ['incident'], mechanizable: false, status: 'trial', helpful: 0, harmful: 0, created_at: new Date(NOW).toISOString(), last_hit: new Date(NOW).toISOString(), ...patch });
const seed = (...lessons: Lesson[]): void => memoryWrite(() => ({ lessons }));
const fake = (): void => { process.env.SUPERAGENT_REFLECT_CMD = JSON.stringify([process.execPath, join(import.meta.dir, 'fixtures/fake-memory-reflector.ts')]); process.env.FAKE_MEMORY_STARTED = join(root, 'started'); };

describe('EV1 incident replay', () => {
  test('E1 actual settle evidence wins over task self-report, mechanizes without reflection', async () => {
    fake();
    for (const [i, sample] of e1.entries()) {
      raw.nodes = [{ nodeId: sample.node, state: 'failed' }];
      writeFileSync(join(artifactsOf(raw), `${sample.node}.json`), JSON.stringify(sample.settle));
      writeFileSync(join(artifactsOf(raw), `${sample.node}.coder.json`), JSON.stringify({ ...sample.coder, prompt: 'SECRET-PROMPT', transcript: 'SECRET-TRANSCRIPT' }));
      const e = episode({ id: `e1-${i}` }); expect(e.category).toBe('engine'); expect(saveEpisode(e)).toBe(true); expect(saveEpisode(e)).toBe(false);
      expect(existsSync(join(sa, 'memory/mechanize', `e1-${i}.json`))).toBe(true);
    }
    expect(await reflectOne(NOW)).toBe(false); expect(existsSync(process.env.FAKE_MEMORY_STARTED!)).toBe(false);
  });
  test('E2 real duplicate-ask shape and deterministic retries classify engine', () => {
    const asks: Asks = Object.fromEntries(e2.attempts.map(n => [`incident:auto_retry_exhausted:${n}`, { status: 'pending', hold: e2.hold, sent_at: new Date(NOW).toISOString() }])); const signals = cockpitSignals([], asks, NOW);
    ledger.auto_retries = [1, 2].map(i => ({ at: new Date(NOW + i).toISOString(), milestone: 'm1', reason: 'coder:task', deterministic: true, engine_hash: ledger.engine_hash })); expect(episode().category).toBe('engine');
    expect(signals.dup_ask).toBeGreaterThan(0);
    expect(triage({ reasons: ['auto_retry_exhausted'], signals })).toBe('engine');
    const e = episode({ id: 'e2', reasons: ['auto_retry_exhausted'], signals, category: triage({ reasons: ['auto_retry_exhausted'], signals }) });
    saveEpisode(e); expect(existsSync(join(sa, 'memory/mechanize/e2.json'))).toBe(true);
  });
  test('M2-01 and xiaopan 57e6 become mechanisms', async () => {
    fake();
    for (const key of ['M2-01', 'xiaopan-57e6'] as const) {
      const sample = replay[key], e = episode({ id: key, status: sample.status, reasons: [sample.reason] }); e.category = triage(e);
      expect(String(e.category)).toBe(sample.classification); saveEpisode(e); expect(existsSync(join(sa, 'memory/mechanize', `${key}.json`))).toBe(true);
    }
    expect(await reflectOne(NOW)).toBe(false);
  });
  test('E5 is refused before the next run, with an explicit base fix', async () => {
    sh('git init -q -b feature-no-base', root);
    await expect(inspectBase(root)).rejects.toThrow('worktree.baseBranch');
    process.env.SUPERAGENT_WRITE_ROOTS = root; const path = fixturePlan(root, root);
    // loadPlan requires a descendant of the write root. Use a real second repo without a remote HEAD.
    const child = join(root, 'bare-project'); mkdirSync(child); sh('git init -q -b feature-no-base', child);
    const next = { ...plan, repo: child }; writeFileSync(path, JSON.stringify(next));
    expect(main(['run', path, '--fake', '--skip-selftest', '--json'])).toBe(1);
    const failure = JSON.parse(readFileSync(join(sa, 'launch-failures', readdirSync(join(sa, 'launch-failures'))[0]), 'utf8'));
    expect(failure.phase).toBe('preflight'); expect(failure.reason).toContain('worktree.baseBranch'); expect(existsSync(join(sa, 'runs'))).toBe(false);
  });
  test('project fake reflection enters the matching next brief, repeats retire it and request mechanism', async () => {
    fake(); const e = episode(); expect(e.category).toBe('project'); saveEpisode(e);
    expect(await reflectOne(NOW)).toBe(true); const learned = memoryState().lessons[0]; expect(learned.scope).toBe(root); expect(learned.status).toBe('trial');
    const generated = generate(plan, 'next', true); expect(readFileSync(join(generated.dir, 'briefs/core.md'), 'utf8')).toContain('选取空闲端口');
    const metadata = JSON.parse(readFileSync(join(generated.dir, 'engine.json'), 'utf8')); expect(metadata.lessons['code-core']).toContain(learned.id);
    const other = generate({ ...plan, repo: join(root, 'other') }, 'other', true); expect(readFileSync(join(other.dir, 'briefs/core.md'), 'utf8')).not.toContain('选取空闲端口');
    maintainLessons({ id: 'next', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] }, NOW);
    maintainLessons({ id: 'next', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] }, NOW);
    expect(memoryState().lessons[0].harmful).toBe(1);
    maintainLessons({ id: 'third', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] }, NOW);
    expect(memoryState().lessons[0]).toMatchObject({ harmful: 2, status: 'retired' }); expect(existsSync(join(sa, 'memory/mechanize', `${learned.id}.json`))).toBe(true);
    expect(selectLessons(root, 'ts-cli')).toHaveLength(0);
  });
});

describe('EV1 budgets and deterministic matching', () => {
  test('daily ceiling queues then resumes next day, counts cached input once', async () => {
    fake(); mkdirSync(join(sa, 'memory')); writeFileSync(join(sa, 'memory/config.json'), JSON.stringify({ daily_tokens: 9216 }));
    saveEpisode(episode({ id: 'first' })); saveEpisode(episode({ id: 'second' }));
    expect(await reflectOne(NOW)).toBe(true); expect(memoryData(NOW)).toMatchObject({ reflection: { tokens: 9216, limit: 9216, yellow: true }, queued: 1 });
    expect(await reflectOne(NOW)).toBe(false); expect(await reflectOne(NOW + 86400000)).toBe(true); expect(memoryData(NOW + 86400000).queued).toBe(0);
    expect(reflectionUsage(JSON.stringify(replay['codex-usage']))).toBe(9216);
    expect(reflectionUsage('{"type":"item.completed","item":{"text":"never kept"}}')).toBeNull();
    expect(readFileSync(process.env.FAKE_MEMORY_STARTED!, 'utf8').trim().split('\n')).toHaveLength(2);
    const jobs = readdirSync(join(sa, 'jobs')).map(f => JSON.parse(readFileSync(join(sa, 'jobs', f), 'utf8'))); expect(jobs.every(j => j.role === 'general' && j.kind === 'other' && j.state === 'done')).toBe(true);
  });
  test('oversized reflection output is discarded but its actual usage is charged', async () => {
    fake(); process.env.FAKE_MEMORY_OVERSIZE = '1'; saveEpisode(episode()); expect(await reflectOne(NOW)).toBe(true);
    expect(memoryState().lessons).toHaveLength(0); expect(memoryData(NOW)).toMatchObject({ reflection: { tokens: 9216 }, queued: 0 }); expect(memoryData(NOW).recent[0].result).toContain('不合格');
  });
  test('the worker lock prevents a concurrent reflection', async () => {
    fake(); saveEpisode(episode()); const held = lock(join(sa, 'memory/reflect.lock')); expect(held.ok).toBe(true);
    try { expect(await reflectOne(NOW)).toBe(false); expect(existsSync(process.env.FAKE_MEMORY_STARTED!)).toBe(false); } finally { if (held.ok) held.release(); }
  });
  test('five lessons maximum, two trials maximum, Chinese byte estimate <=600', () => {
    const stable = Array.from({ length: 6 }, (_, i) => lesson(`s${i}`, { status: 'stable' }));
    expect(lessonText(stable).ids).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(lessonText([lesson('t1'), lesson('t2'), lesson('t3')]).ids).toEqual(['t1', 't2']);
    const long = lessonText(stable.map(l => ({ ...l, when: '中'.repeat(70), do: '中'.repeat(70) }))); expect(Buffer.byteLength(long.text)).toBeLessThanOrEqual(600); expect(long.ids.length).toBeLessThan(5);
    expect(lessonText([lesson('giant', { do: '中'.repeat(240) })]).ids).toHaveLength(0);
  });
  test('multi-package briefs plus role command jointly respect node budgets', () => {
    const second = { ...plan.packages[0], id: 'two', scope: { write: ['docs/help.md'] } }; const many = { ...plan, packages: [...plan.packages, second] };
    seed(...Array.from({ length: 5 }, (_, i) => lesson(`p${i}`, { status: 'stable' })), ...Array.from({ length: 5 }, (_, i) => lesson(`d${i}`, { tag: 'docs', status: 'stable' })), lesson('role-general', { tier: 'role', scope: 'general', status: 'stable' }));
    const dir = join(root, 'injection'); mkdirSync(join(dir, 'briefs'), { recursive: true }); mkdirSync(join(dir, '.archon/commands'), { recursive: true });
    for (const p of many.packages) writeFileSync(join(dir, 'briefs', `${p.id}.md`), `brief ${p.id}`);
    writeFileSync(join(dir, '.archon/commands/sa-fix.md'), 'command');
    const nodes = [{ id: 'fix-m1-r2', command: 'sa-fix', model: '@sa-coder', with: { briefs: many.packages.map(p => join(dir, 'briefs', `${p.id}.md`)).join(' ') } }];
    const hits = injectMemory(many, dir, nodes); expect(hits['fix-m1-r2'].length).toBeLessThanOrEqual(5);
    const text = nodes[0].with.briefs.split(' ').map(f => readFileSync(f, 'utf8').replace(/^brief \w+/, '')).join('') + readFileSync(join(dir, '.archon/commands', nodes[0].command + '.md'), 'utf8').replace(/^command/, '');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(600); expect(new Set(text.match(/\[(?:p|d)\d\]/g)).size).toBeLessThanOrEqual(5);
    expect(hits['fix-m1-r2'].every(id => text.includes(`[${id}]`))).toBe(true);
  });
  test('role experiences target their mapped role; exact tags and project prevent leakage', () => {
    seed(lesson('project'), lesson('type', { tier: 'type', scope: 'ts-cli', status: 'stable' }), lesson('role', { tier: 'role', scope: 'strategist', status: 'stable' }));
    expect(selectLessons('/another-project', 'ts-cli').map(l => l.id)).toEqual(['type']); expect(selectLessons(root, 'docs').map(l => l.id)).toEqual([]);
    expect(selectLessons(root, 'ts-cli', 'general').map(l => l.id)).not.toContain('role'); expect(selectLessons(root, 'ts-cli', 'strategist').map(l => l.id)).toContain('role');
  });
  test('BT9 role mapping injects reviewer and alternate-reviewer command only', () => {
    seed(lesson('review-role', { tier: 'role', scope: 'strategist' })); const dir = join(root, 'roles'); mkdirSync(join(dir, 'briefs'), { recursive: true }); mkdirSync(join(dir, '.archon/commands'), { recursive: true });
    writeFileSync(join(dir, 'briefs/core.md'), 'brief'); writeFileSync(join(dir, '.archon/commands/sa-review.md'), 'principles');
    const nodes = ['@sa-reviewer', '@sa-reviewer-alt', '@sa-coder'].map((model, i) => ({ id: `n${i}`, command: 'sa-review', model })); const hits = injectMemory(plan, dir, nodes);
    for (const n of nodes.slice(0, 2)) { expect(hits[n.id]).toEqual(['review-role']); expect(readFileSync(join(dir, '.archon/commands', n.command + '.md'), 'utf8')).toContain('[review-role]'); } expect(hits.n2).toEqual([]);
  });
  test('memory off means no injection or reflection, and data does not change engine hash', async () => {
    fake(); seed(lesson('x')); saveEpisode(episode()); const before = engineHash();
    process.env.SUPERAGENT_MEMORY = 'off'; const off = generate(plan, 'off', true); expect(readFileSync(join(off.dir, 'briefs/core.md'), 'utf8')).not.toContain('经验（自动'); expect(JSON.parse(readFileSync(join(off.dir, 'engine.json'), 'utf8')).lessons).toEqual({}); expect(await reflectOne(NOW)).toBe(false);
    process.env.SUPERAGENT_MEMORY = 'on'; const on = generate(plan, 'on', true); expect(readFileSync(join(on.dir, 'briefs/core.md'), 'utf8')).toContain('[x]'); expect(on.engine_hash).toBe(off.engine_hash); expect(engineHash()).toBe(before);
  });
  test('lesson retrieval failures are fail-open', () => {
    mkdirSync(join(sa, 'memory')); writeFileSync(join(sa, 'memory/lessons.jsonl'), '{broken\n');
    const gen = generate(plan, 'broken', true); expect(existsSync(join(gen.dir, 'engine.json'))).toBe(true); expect(JSON.parse(readFileSync(join(gen.dir, 'engine.json'), 'utf8')).lessons).toEqual({});
  });
});

describe('EV1 lifecycle, privacy and priors', () => {
  test('episode projection is <=8KB and excludes source prompt, transcript and credentials', () => {
    writeFileSync(join(artifactsOf(raw), 'verify-core.json'), JSON.stringify({ ...replay['project-port'], prompt: 'PRIVATE-PROMPT', transcript: 'PRIVATE-TRANSCRIPT', credentials: 'PRIVATE-CREDENTIAL' }));
    const e = episode({ timeline: Array.from({ length: 400 }, () => ({ node: 'verify-core', state: 'failed', started_at: null, duration_ms: null })) });
    saveEpisode(e); const output = readFileSync(join(sa, 'memory/episodes/incident.json'), 'utf8'); expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    for (const word of ['prompt', 'transcript', 'credentials', 'PRIVATE-', '/forbidden-transcript']) expect(output).not.toContain(word);
    expect(JSON.parse(output).acceptance).toEqual([{ cmd: 'bun test --port 39890', ok: false }]);
    raw.status = 'completed'; ledger.recoveries = [new Date(NOW).toISOString()]; expect(triggered(episode(), undefined, undefined, NOW)).toBe(true);
    expect(Buffer.byteLength(reflectionInput(episode()))).toBeLessThanOrEqual(8000);
  });
  test('private and iCloud projects only triage, never invoke reflection', async () => {
    fake(); for (const p of ['/repo/_private-client', '/repo/_private/client', '/Users/operator/Library/Mobile Documents/com~apple~CloudDocs/repo']) { expect(privateProject(p)).toBe(true); saveEpisode(episode({ id: `private-${p.includes('_private') ? 'a' : 'b'}`, project: p })); }
    expect(await reflectOne(NOW)).toBe(false); expect(existsSync(process.env.FAKE_MEMORY_STARTED!)).toBe(false); expect(memoryData(NOW).queued).toBe(0);
  });
  test('each trigger and five categories use evidence and registered policy', () => {
    const base = episode({ status: 'running', reasons: [], category: 'project', signals: zeros }); expect(triggered(base, undefined, undefined, NOW)).toBe(false);
    for (const e of [episode({ status: 'cancelled' }), episode({ status: 'completed', asks: [{ hold: 'signoff', status: 'approved' }] }), episode({ p50_ratio: 2.1 }), episode({ findings: ['| f | high | src/cli.ts:1 | open | proof |'] }), episode({ signals: { ...zeros, engine_suspect: 1 } })]) expect(triggered(e, undefined, undefined, NOW)).toBe(true);
    expect(triggered(base, new Date(NOW - 1800001).toISOString(), undefined, NOW)).toBe(true); expect(triggered(base, undefined, 30000, NOW)).toBe(true);
    expect(triage({ reasons: ['budget_tokens_exceeded'], signals: zeros })).toBe('plan'); expect(triage({ reasons: ['review_failed'], signals: zeros })).toBe('role'); expect(triage({ reasons: ['coder_output_invalid'], signals: zeros })).toBe('role'); expect(triage({ reasons: ['coder_error:env'], signals: zeros })).toBe('transient'); expect(triage({ reasons: ['acceptance_failed'], signals: zeros })).toBe('project');
    expect(taskTag(['docs/a.md', 'src/b.ts', 'a.vue', 'c.ts'])).toBe('docs+ts-cli');
  });
  test('outcomes promote, expire and cap scope deterministically', () => {
    seed(lesson('winner'), lesson('old', { last_hit: new Date(NOW - 31 * 86400000).toISOString() }));
    for (const id of ['win1', 'win2']) maintainLessons({ id, reasons: [], failed: false, ids: ['winner'] }, NOW);
    expect(memoryState().lessons.find(l => l.id === 'winner')).toMatchObject({ helpful: 2, status: 'stable' }); expect(memoryState().lessons.find(l => l.id === 'old')?.status).toBe('retired');
    seed(...Array.from({ length: 32 }, (_, i) => lesson(`scope${i}`, { helpful: i }))); maintainLessons(undefined, NOW); const all = memoryState().lessons; expect(all.filter(l => ['trial', 'stable'].includes(l.status))).toHaveLength(30); expect(all.find(l => l.id === 'scope0')?.status).toBe('retired');
  });
  test('curator rejects oversize and foreign edits, deduplicates ADD, UPVOTE does not fake outcome success', () => {
    const e = episode(), valid = { tier: 'project', scope: root, when: 'port', do: 'free', dont: 'busy', why: 'evidence', evidence: ['incident'], mechanizable: false };
    expect(curate(e, { operations: [{ op: 'ADD', lesson: { ...valid, do: 'x'.repeat(241) } }, { op: 'ADD', lesson: valid }] }, NOW).lessons).toHaveLength(1);
    seed(lesson('existing')); expect(curate(e, { operations: [{ op: 'ADD', lesson: valid }] }, NOW).lessons[0].id).toBe('existing');
    expect(curate(e, { operations: [{ op: 'EDIT', id: 'existing', lesson: { ...valid, scope: '/foreign' } }] }, NOW).lessons).toHaveLength(0);
    expect(curate(e, { operations: [{ op: 'UPVOTE', id: 'existing' }] }, NOW).lessons[0]).toMatchObject({ helpful: 0, votes: 1 });
    expect(curate(e, { operations: [], reason: '无可复用经验' }, NOW).result).toContain('未提炼');
  });
  test('plan prior warnings reject only enough samples and record a reasoned override', () => {
    const key = priorKey(root, plan.packages[0], loadTiers().tiers.general.pools.chatgpt[0]); mkdirSync(join(sa, 'memory'));
    const prior = { n: 5, duration: { p50: 600000, p90: 900000 }, tokens: { n: 5, p50: 5000000, p90: 7000000 } };
    writeFileSync(join(sa, 'memory/priors.json'), JSON.stringify({ [key]: prior }));
    const next = { ...plan, deadline: new Date(NOW + 10000).toISOString(), budget: { weighted_tokens: 1000000 } };
    expect(lintPlan(next, undefined, NOW)).toMatchObject({ rejected: true }); expect(lintPlan(next, '人工确认验收使用缓存', NOW)).toMatchObject({ rejected: false, override: '人工确认验收使用缓存' }); expect(lintPlan(next, ' ', NOW).rejected).toBe(true);
    expect(lintPlan(next, undefined, NOW).warnings.join(' ')).toContain('5000000'); expect(lintPlan(next, undefined, NOW).warnings.join(' ')).toContain(new Date(NOW + 600000).toISOString());
    writeFileSync(join(sa, 'memory/priors.json'), JSON.stringify({ [key]: { ...prior, n: 4 } })); expect(lintPlan(next, undefined, NOW).rejected).toBe(false);
    seed(lesson('plan', { category: 'plan', do: '预算至少一个验收周期' })); expect(lintPlan(plan, undefined, NOW).warnings.join(' ')).toContain('预算至少一个验收周期');
  });
  test('run lint refusal and override are recorded in the real CLI ledgers', () => {
    const repo = gitRepo(root); process.env.SUPERAGENT_WRITE_ROOTS = root; const next = { ...plan, repo, deadline: new Date(Date.now() + 60000).toISOString(), budget: { weighted_tokens: 1000000 } }; const path = join(root, 'next.json'); writeFileSync(path, JSON.stringify(next));
    mkdirSync(join(sa, 'memory')); writeFileSync(join(sa, 'memory/priors.json'), JSON.stringify({ [priorKey(repo, next.packages[0], loadTiers().tiers.general.pools.chatgpt[0])]: { n: 5, duration: { p50: 600000, p90: 600000 }, tokens: { n: 5, p50: 5000000, p90: 5000000 } } }));
    expect(main(['run', path, '--fake', '--skip-selftest'])).toBe(1); const failures = readdirSync(join(sa, 'launch-failures')); expect(JSON.parse(readFileSync(join(sa, 'launch-failures', failures[0]), 'utf8')).plan_lint.rejected).toBe(true);
    install();
    const stub = join(root, 'ack'); writeFileSync(stub, '#!/bin/sh\necho \'{"ok":true,"runId":"fixture"}\'\n', { mode: 0o755 }); process.env.SA_ARCHON_BIN = stub;
    expect(main(['run', path, '--fake', '--skip-selftest', '--lint-override', '明确的小样本验收'])).toBe(0); const runs = readdirSync(join(sa, 'runs')); expect(JSON.parse(readFileSync(join(sa, 'runs', runs[0]), 'utf8')).plan_lint).toMatchObject({ override: '明确的小样本验收', rejected: false });
  });
  test('read-only memory API reports ten recent episodes and changes no files', () => {
    for (let i = 0; i < 12; i++) saveEpisode(episode({ id: `run${i}`, at: new Date(NOW + i).toISOString() })); seed(lesson('stable', { status: 'stable' }));
    const before = readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8'); expect(memoryData(NOW)).toMatchObject({ states: { stable: 1 }, categories: { project: 12 }, queued: 12 }); expect(memoryData(NOW).recent).toHaveLength(10); expect(main(['memory', '--json'])).toBe(0); expect(readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8')).toBe(before);
  });
  test('a paused archive folds once while terminal scoring reads final evidence', () => {
    seed(lesson('injected')); writeFileSync(join(ledger.gen_dir, 'engine.json'), JSON.stringify({ lessons: { 'code-core': ['injected'] } }));
    const held = { ...raw, status: 'paused', nodes: undefined, metadata: { wait: { nodeId: 'human', kind: 'event', event: 'sa.human', resumeAt: new Date(NOW + 600000).toISOString(), waitingSince: new Date(NOW - 31 * 60000).toISOString() } }, events: [] };
    const stub = join(root, 'archon-held'); writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 }); const file = join(root, 'held.json'); writeFileSync(file, JSON.stringify(held)); process.env.SA_ARCHON_BIN = stub; process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs')); writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger)); memoryTick({}, NOW, false);
    const path = join(sa, 'memory/episodes/incident.json'), archive = readFileSync(path, 'utf8'); expect(memoryState().lessons[0].harmful).toBe(0);
    writeFileSync(join(artifactsOf(raw), 'verify-core.json'), JSON.stringify({ ok: false, reason: 'review_failed' }));
    writeFileSync(file, JSON.stringify({ ...held, status: 'failed', completed_at: new Date(NOW).toISOString(), events: [{ event_type: 'node_failed', step_name: 'verify-core', created_at: new Date(NOW).toISOString(), data: { error: 'review_failed', duration_ms: 60000 } }] }));
    memoryTick({}, NOW + 5000, false); memoryTick({}, NOW + 10000, false); expect(readFileSync(path, 'utf8')).toBe(archive); expect(memoryState().lessons[0]).toMatchObject({ helpful: 1, harmful: 0 });
  });
  test('event CLI shape produces timeline and tick folds once, recomputes real history priors', () => {
    const model = loadTiers().tiers.general.pools.chatgpt[0], unavailable = { source: 'unavailable', reason: 'not_reported' };
    const data = { node: { id: 'code-core', kind: 'agent', source: { kind: 'command', name: 'sa-code' } }, invocation: { id: 'invoke', startedAt: ledger.started_at, loopPath: [] }, attempt: { id: 'one', startedAt: ledger.started_at }, binding: { provider: 'codex', model: { requested: model, resolved: { source: 'provider', value: model } } }, timing: { startedAt: ledger.started_at }, spend: { tokens: unavailable, costUsd: unavailable, stopReason: unavailable, numTurns: unavailable }, accounting: 'node' };
    const events = [{ event_type: 'node_started', step_name: 'code-core', created_at: ledger.started_at, data }, { event_type: 'node_completed', step_name: 'code-core', created_at: new Date(NOW).toISOString(), data: { ...data, timing: { startedAt: ledger.started_at, durationMs: 60000 }, spend: { ...data.spend, tokens: { source: 'provider', value: { input: 100, output: 10 } } } } }];
    const eventRun = { ...raw, nodes: undefined, events }; expect(foldEpisode(ledger, plan, eventRun, events, {}, NOW).timeline).toContainEqual({ node: 'code-core', state: 'completed', started_at: ledger.started_at, duration_ms: 60000 });
    const stub = join(root, 'archon-stub'); writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 }); const file = join(root, 'run.json'); writeFileSync(file, JSON.stringify(eventRun)); process.env.SA_ARCHON_BIN = stub; process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs')); writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger)); memoryTick({}, NOW, false);
    const episodePath = join(sa, 'memory/episodes/incident.json'), original = readFileSync(episodePath, 'utf8'); memoryTick({}, NOW + 5000, false); expect(readFileSync(episodePath, 'utf8')).toBe(original);
    const priors = JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8')); expect(priors[priorKey(root, plan.packages[0], model)]).toMatchObject({ n: 1, duration: { p50: 60000 }, tokens: { n: 1, p50: 110 } });
    const unknownEvents = events.map(e => ({ ...e, data: { ...e.data, spend: { ...e.data.spend, tokens: unavailable } } })); writeFileSync(file, JSON.stringify({ ...eventRun, events: unknownEvents })); memoryTick({}, NOW + 10000, false);
    expect(readFileSync(episodePath, 'utf8')).toBe(original);
    const unknownPriors = JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8')); expect(unknownPriors[priorKey(root, plan.packages[0], model)].tokens.n).toBe(0);
    expect(foldEpisode(ledger, plan, eventRun, unknownEvents, {}, NOW).tokens[0].total).toBeNull();
    delete process.env.FAKE_EV1_RUN;
  });
});
