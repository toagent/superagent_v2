import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import {
  attribute,
  usageCli,
  usageForRepo,
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
