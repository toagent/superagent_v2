import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCommanderFailover } from '../src/cli';
import { type Controller, type RunRef } from '../src/coord';
import { tmp } from './helpers';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
const owner: Controller = { client: 'claude', pid: 7, generation: 3 };
const health = (changed_at = '2026-10-27T01:02:00.000Z') => ({
  state: 'down' as const,
  changed_at,
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
const execute = (f: ReturnType<typeof fixture>, patch = {}) => {
  const d = { ...f.deps, ...patch };
  return claudeCommanderFailover(d.health, d.runs, d.bin, d.launch, d.now);
};

test('no eligible Claude-owned nonterminal run does not ask', async () => {
  const f = fixture('pending', []);
  expect(await execute(f)).toEqual({ skipped: 'no_claude_commander_runs' });
  expect(existsSync(f.calls)).toBeFalse();
});

test('down episode asks once, stays pending, and a new changed_at asks again', async () => {
  const f = fixture('pending');
  process.env.TZ = 'Asia/Shanghai';
  await execute(f);
  await execute(f);
  await execute(f, { health: () => health('2026-10-27T02:02:00.000Z') });
  expect(f.readCalls().filter(c => c[0] === 'ask')).toHaveLength(2);
  expect(f.readCalls()[0].join(' ')).toContain('自 09:02');
  expect(f.launches).toHaveLength(0);
});

test('no consumes the answer without launch or ownership mutation', async () => {
  const ref = run('run-a', '/repo/a'),
    f = fixture('no', [ref]);
  await execute(f);
  await execute(f);
  expect(f.launches).toHaveLength(0);
  expect(ref.controller).toEqual(owner);
  expect(
    f.readCalls().some(c => c[0] === 'ask-ack' && c.join(' ').includes('ownership 未变'))
  ).toBeTrue();
});

test('yes launches once per repo with fenced brief-claim-reauthorize prompt; missing Orca returns manual commands', async () => {
  const f = fixture('yes', [run('a1', '/repo/a'), run('a2', '/repo/a'), run('b1', '/repo/b')]);
  await execute(f);
  await execute(f);
  expect(f.launches).toHaveLength(2);
  for (const args of f.launches) {
    const p = args[args.indexOf('--prompt') + 1];
    expect(p).toContain('superagent brief');
    expect(p).toContain('generation=3');
    expect(p).toContain('claim');
    expect(p).toContain('--takeover --reason');
    expect(p).toContain('reauthorize');
  }
  const recovered = fixture('yes');
  let checks = 0;
  const recovery = {
    health: () =>
      ++checks <= 2
        ? health()
        : { state: 'up' as const, observed_at: '2026-10-27T02:46:00Z', probe_failures: 0 },
  };
  await execute(recovered, recovery);
  await execute(recovered, recovery);
  expect(recovered.launches).toHaveLength(0);
  expect(recovered.readCalls().some(c => c.join(' ').includes('恢复，未接管'))).toBeTrue();
  const missing = fixture('yes');
  await execute(missing, { bin: () => undefined });
  await execute(missing, { bin: () => undefined });
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
