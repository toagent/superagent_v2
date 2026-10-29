import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import { estimate } from '../src/board/eta';
import {
  attribute,
  usageCli,
  usageForRepo,
  usageEvidence,
  usageSummary,
  type Owner,
  type UsageCache,
  type UsageSession,
} from '../src/usage';

const saved = {
  SUPERAGENT_HOME: process.env.SUPERAGENT_HOME,
  ARCHON_HOME: process.env.ARCHON_HOME,
};
afterEach(() => {
  for (const key of ['SUPERAGENT_HOME', 'ARCHON_HOME'] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
const owner = (kind: Owner['kind'], role: Owner['role'], cwd: string): Owner => ({
  client: 'claude',
  kind,
  role,
  cwd,
  model: 'claude-opus-5-5',
});
const session = (id: string, owner: Owner): UsageSession => ({
  id,
  owner,
  client: owner.client,
  model: owner.model,
  at: '2026-10-17T00:00:00Z',
  cost: 1,
  input: 10,
  output: 2,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 12,
  sessions: 1,
});

describe('usage --repo', () => {
  test('filters run, job and interactive sessions by repository identity including worktrees', async () => {
    const root = tmp(),
      repo = join(root, 'repo'),
      worktree = join(root, 'worktree'),
      other = join(root, 'other');
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root });
    mkdirSync(join(repo, '.git/worktrees/fixture'), { recursive: true });
    mkdirSync(join(worktree, 'nested'), { recursive: true });
    mkdirSync(join(other, '.git'), { recursive: true });
    mkdirSync(join(root, 'runs'));
    mkdirSync(join(root, 'usage'));
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git/worktrees/fixture')}\n`);
    writeFileSync(join(repo, '.git/worktrees/fixture/commondir'), '../..\n');
    writeFileSync(
      join(root, 'runs/run-id.json'),
      JSON.stringify({
        run_id: 'run-id',
        archon_run_id: 'archon-id',
        gen_dir: root,
        repo,
        branch: 'task',
        workflow: 'fixture',
      })
    );
    const sessions = [
      session('run', { ...owner('run', 'general', '/removed-worktree'), run_id: 'run-id' }),
      session('job', owner('job', 'strategist', repo)),
      session('interactive', owner('interactive', 'commander', join(worktree, 'nested'))),
      session('other', owner('interactive', 'commander', other)),
      session('unknown', owner('unknown', null, '/missing')),
    ];
    const cache: UsageCache = {
      at: 'now',
      status: 'ok',
      sources: {},
      sessions,
      daily: [
        {
          day: '2026-10-17',
          client: 'claude',
          input: 50,
          output: 10,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 60,
          sessions: null,
        },
      ],
    };
    expect(usageForRepo(cache, repo).sessions.map(s => s.id)).toEqual([
      'run',
      'job',
      'interactive',
    ]);
    writeFileSync(join(root, 'usage/cache.json'), JSON.stringify(cache));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    expect(await usageCli(['usage', '--repo', repo, '--json'])).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)![0]));
    log.mockRestore();
    expect(output).toMatchObject({ repo, total: { sessions: 3, total: 36 }, daily: [] });
  });

  test('claim evidence replaces unknown role without guessing', () => {
    const s = session('claimed', owner('unknown', null, '/repo')),
      unknown = session('unknown', owner('unknown', null, '/repo'));
    attribute([s], [{ id: s.id, owner: owner('run', 'general', '/repo') }]);
    expect(
      usageSummary({ at: 'now', status: 'ok', sources: {}, sessions: [s, unknown], daily: [] })
        .by_role_model
    ).toMatchObject({ 'general·opus5.5': { sessions: 1 }, '?·opus5.5': { sessions: 1 } });
  });
});

// prettier-ignore
test('run evidence compacts events and reuses legacy cache without changing ETA input', () => {
  const root = tmp();
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root });
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'usage'));
  writeFileSync(join(root, 'runs/run.json'), JSON.stringify({ run_id: 'run', archon_run_id: 'archon', gen_dir: root, repo: root, branch: 'task', workflow: 'fixture', started_at: '2026-10-17T00:00:00Z' }));
  const events = Array.from({ length: 2000 }, (_, i) => ({ step_name: `code-${String(i)}`, event_type: 'node_completed', created_at: '2026-10-17T00:00:01Z', data: { duration_ms: 1000, payload: 'x'.repeat(1000) } }));
  let calls = 0;
  const first = usageEvidence(() => { calls++; return { id: 'archon', status: 'completed', events }; });
  expect(first.eta[0].samples).toHaveLength(events.length);
  const beforeEta = estimate(first.eta[0].run.nodes!, first.eta[0].samples, 2000, Date.now());
  expect(beforeEta).toMatchObject({ weight: 2000, progress: { pct: 100, basis: 'history' } });
  const file = join(root, 'usage/runs.json'), compact = JSON.stringify(first.runs);
  expect(compact).not.toContain('events');
  expect(compact.length).toBeLessThan(200_000);
  const legacy = structuredClone(first.runs) as unknown as Record<string, { eta: { run: Record<string, unknown> } }>;
  Object.values(legacy)[0].eta.run.events = events;
  writeFileSync(file, JSON.stringify(legacy));
  const second = usageEvidence(() => { throw new Error('terminal cache should be reused'); });
  expect(calls).toBe(1);
  expect(second.eta).toEqual(first.eta);
  expect(estimate(second.eta[0].run.nodes!, second.eta[0].samples, 2000, Date.now())).toEqual(beforeEta);
  writeFileSync(file, JSON.stringify(second.runs));
  expect(readFileSync(file, 'utf8')).not.toContain('events');
});
