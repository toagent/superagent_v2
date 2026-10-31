import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCommanderFailover } from '../src/cli';
import { type Controller, type RunRef } from '../src/coord';
import {
  answerNtfyDecision,
  applyCoordIntents,
  DecisionStore,
  failoverDecisions,
} from '../src/decisions';
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
async function answerAsk(
  f: ReturnType<typeof fixture>,
  patch: Parameters<typeof execute>[1] = {},
  outcome: 'yes' | 'no' = 'yes'
): Promise<Record<string, unknown>> {
  await execute(f, patch);
  const asksPath = join(process.env.SUPERAGENT_HOME!, 'asks.json');
  const asks = JSON.parse(readFileSync(asksPath, 'utf8')) as Record<string, { status: string }>;
  Object.values(asks)[0]!.status = outcome;
  writeFileSync(asksPath, JSON.stringify(asks, null, 2) + '\n');
  return execute(f, patch);
}

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
  const asks = JSON.parse(
    readFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), 'utf8')
  ) as Record<string, unknown>;
  expect(Object.keys(asks)).toHaveLength(2);
  expect(existsSync(f.calls)).toBeFalse();
  expect(f.launches).toHaveLength(0);
});

test('no consumes the answer without launch or ownership mutation', async () => {
  const ref = run('run-a', '/repo/a'),
    f = fixture('pending', [ref]);
  await answerAsk(f, {}, 'no');
  expect(f.launches).toHaveLength(0);
  expect(ref.controller).toEqual(owner);
  expect(readFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), 'utf8')).toContain(
    'ownership 未变'
  );
});

test('yes launches once per repo with fenced brief-claim-reauthorize prompt; missing Orca returns manual commands', async () => {
  const f = fixture('yes', [run('a1', '/repo/a'), run('a2', '/repo/a'), run('b1', '/repo/b')]);
  await answerAsk(f);
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
  await answerAsk(recovered, recovery);
  expect(recovered.launches).toHaveLength(0);
  expect(readFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), 'utf8')).toContain(
    '恢复，未接管'
  );
  const missing = fixture('yes');
  await answerAsk(missing, { bin: () => undefined });
  expect(readFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), 'utf8')).toContain(
    '人工执行'
  );
});

test('ntfy answers yes/no and rejects takeover when Claude recovered', async () => {
  for (const outcome of ['yes', 'no', 'recovered'] as const) {
    const f = fixture('pending');
    await execute(f);
    expect(existsSync(f.calls)).toBeFalse();
    const decision = failoverDecisions()[0];
    expect(decision.options.map(option => option.label)).toEqual([
      '启动 Codex 元帅接手',
      '保持现状',
    ]);
    const store = new DecisionStore();
    expect(
      (await answerNtfyDecision(decision.id, outcome === 'no' ? 'no' : 'yes', store)).stage
    ).toBe('intent');
    const asksPath = join(process.env.SUPERAGENT_HOME!, 'asks.json'),
      asks = JSON.parse(readFileSync(asksPath, 'utf8')) as Record<
        string,
        { status: string; context?: unknown }
      >;
    applyCoordIntents(asks);
    writeFileSync(asksPath, JSON.stringify(asks, null, 2) + '\n');
    expect(store.transaction(state => state.receipts[0].stage)).toBe('accepted');
    await execute(
      f,
      outcome === 'recovered'
        ? {
            health: () => ({
              state: 'up' as const,
              observed_at: '2026-10-27T02:46:00Z',
              probe_failures: 0,
            }),
          }
        : {}
    );
    expect(f.launches).toHaveLength(outcome === 'yes' ? 1 : 0);
    const ask = Object.values(
      JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'asks.json'), 'utf8')) as Record<
        string,
        { receipt?: { body?: string } }
      >
    )[0];
    if (outcome === 'recovered') expect(ask.receipt?.body).toContain('恢复，未接管');
  }
});

test('ntfy rejects an answer from an older failover episode', async () => {
  const f = fixture('pending');
  await execute(f);
  const stale = failoverDecisions()[0];
  await execute(f, { health: () => health('2026-10-27T02:02:00.000Z') });
  const store = new DecisionStore();
  await expect(answerNtfyDecision(stale.id, 'yes', store)).rejects.toThrow('决定已变化');
});
