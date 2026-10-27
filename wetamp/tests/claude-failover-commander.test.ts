import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCommanderFailover } from '../src/cli';
import { Coordination, type Controller, type RunRef } from '../src/coord';
import { gitRepo, tmp } from './helpers';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
const owner: Controller = {
  client: 'claude',
  session_id: 'claude-1',
  host: 'test',
  pid: 7,
  generation: 3,
};
const health = (changed_at = '2026-10-27T01:02:00.000Z') => ({
  state: 'down' as const,
  changed_at,
  observed_at: changed_at,
  next_probe_at: '2099-01-01T00:00:00.000Z',
  cause: { source: 'dispatch' as const, class: 'overloaded', retries: 10 },
  probe_failures: 0,
});
const run = (id: string, repo: string): RunRef => ({
  run_id: id,
  archon_run_id: `archon-${id}`,
  repo,
  controller: owner,
});

function fixture(answer: 'pending' | 'yes' | 'no', runs = [run('run-a', '/repo/a')]) {
  const root = tmp(),
    sa = join(root, 'sa'),
    archon = join(root, 'archon'),
    calls = join(root, 'calls'),
    py = join(root, 'supervisor.py');
  mkdirSync(sa);
  mkdirSync(archon);
  writeFileSync(
    py,
    `#!/usr/bin/env python3\nimport json,sys\nopen(${JSON.stringify(calls)},'a').write(json.dumps(sys.argv[1:])+'\\n')\nprint('a'*32 if sys.argv[1]=='ask' else ${JSON.stringify(answer === 'pending' ? 'pending' : answer === 'yes' ? 'yes' : 'no')})\n`
  );
  chmodSync(py, 0o755);
  Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: archon, SA_SUPERVISOR: py });
  const launches: string[][] = [];
  const deps = {
    health,
    runs: () => runs.map(r => ({ ...r, status: 'running', owner, generation: owner.generation })),
    bin: () => '/orca',
    model: () => 'gpt-test',
    now: () => new Date('2026-10-27T03:00:00Z'),
    launch: async (_bin: string, args: string[]) => {
      launches.push(args);
      return { kind: 'launched' as const, outcome: {} };
    },
  };
  return {
    root,
    calls,
    launches,
    deps,
    readCalls: () =>
      readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[]),
  };
}

test('coord query keeps only nonterminal runs owned by the requested client', () => {
  const root = tmp(),
    repos = [gitRepo(root), gitRepo(tmp()), gitRepo(tmp())];
  const refs = [
    run('live', repos[0]),
    run('done', repos[1]),
    { ...run('codex', repos[2]), controller: { ...owner, client: 'codex' } },
  ];
  const c = new Coordination({
    sa: tmp(),
    runs: () => refs,
    status: r => (r.run_id === 'done' ? 'completed' : 'running'),
    presence: () => ({ state: 'unknown' }),
  });
  expect(c.ownedNonterminalRuns('claude').map(r => r.run_id)).toEqual(['live']);
});

test('down episode asks once, stays pending, and a new changed_at asks again', async () => {
  const f = fixture('pending');
  await claudeCommanderFailover(f.deps);
  await claudeCommanderFailover(f.deps);
  await claudeCommanderFailover({ ...f.deps, health: () => health('2026-10-27T02:02:00.000Z') });
  expect(f.readCalls().filter(c => c[0] === 'ask')).toHaveLength(2);
  expect(f.launches).toHaveLength(0);
});

test('no consumes the answer without launch or ownership mutation', async () => {
  const ref = run('run-a', '/repo/a'),
    f = fixture('no', [ref]);
  await claudeCommanderFailover(f.deps);
  await claudeCommanderFailover(f.deps);
  expect(f.launches).toHaveLength(0);
  expect(ref.controller).toEqual(owner);
  expect(
    f.readCalls().some(c => c[0] === 'ask-ack' && c.join(' ').includes('ownership 未变'))
  ).toBeTrue();
});

test('yes launches once per repo with fenced brief-claim-reauthorize prompt; missing Orca returns manual commands', async () => {
  const f = fixture('yes', [run('a1', '/repo/a'), run('a2', '/repo/a'), run('b1', '/repo/b')]);
  await claudeCommanderFailover(f.deps);
  await claudeCommanderFailover(f.deps);
  expect(f.launches).toHaveLength(2);
  for (const args of f.launches) {
    const p = args[args.indexOf('--prompt') + 1];
    expect(p).toContain('superagent brief');
    expect(p).toContain('generation=3');
    expect(p).toContain('claim');
    expect(p).toContain('--takeover --reason');
    expect(p).toContain('reauthorize');
  }
  const missing = fixture('yes'),
    unavailable = { ...missing.deps, bin: () => undefined };
  await claudeCommanderFailover(unavailable);
  await claudeCommanderFailover(unavailable);
  expect(
    missing
      .readCalls()
      .some(
        c =>
          c[0] === 'ask-ack' &&
          JSON.parse(c[c.indexOf('--receipt-json') + 1]).body.includes('人工执行')
      )
  ).toBeTrue();
});
