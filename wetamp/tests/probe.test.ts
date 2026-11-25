import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  judgeProbe,
  runProbe,
  runScenarioProbe,
  runProbeMatrix,
  scenarioFor,
  type ProbeJudgement,
} from '../src/probe';
import { tmp } from './helpers';

// prettier-ignore
const valid = JSON.parse('{"launch_exit":0,"launch_run_id":"run-1","wait_exit":0,"wait_run_id":"run-1","state":"completed","delivery_state":"published","ledger_run_id":"run-1","engine_commit":"abc","engine_snapshot":"/engine/abc","expected_commit":"abc","expected_snapshot":"/engine/abc"}') as ProbeJudgement;

// prettier-ignore
test('judgeProbe accepts exact real-run evidence and rejects every missing identity boundary', () => {
  expect(judgeProbe(valid)).toEqual({ ok: true });
  for (const [patch, reason] of [[{ launch_exit: 1 }, 'launch_failed'], [{ launch_run_id: undefined }, 'launch_run_id_missing'], [{ wait_run_id: 'other' }, 'wait_run_id_mismatch'], [{ delivery_state: 'integrated' }, 'not_published'], [{ engine_commit: 'old' }, 'engine_commit_mismatch'], [{ engine_snapshot: '/engine/old' }, 'engine_snapshot_mismatch'], [{ timed_out: true }, 'timeout']] as const)
    expect(judgeProbe({ ...valid, ...patch })).toEqual({ ok: false, reason });
  const held = { ...valid, wait_exit: 3, state: 'held:scope', delivery_state: 'not_reached' };
  expect(judgeProbe(held, true)).toEqual({ ok: true });
  expect(judgeProbe(held).ok).toBe(false);
  expect(judgeProbe({ ...held, delivery_state: 'published' }, true).ok).toBe(false);
  expect(judgeProbe({ ...held, delivery_state: undefined }, true).ok).toBe(false);
  expect(judgeProbe({ ...held, state: 'held:gate' }, true).ok).toBe(false);
});

const fakeProbe = (missingRunId = false): ReturnType<typeof runProbe> => {
  const root = tmp(),
    shim = join(root, 'shim'),
    permission = join(root, 'permission.ts'),
    snapshot = resolve(import.meta.dir, '../..');
  writeFileSync(
    permission,
    `import { isWithinWriteRoots } from ${JSON.stringify(join(import.meta.dir, '../src/plan.ts'))};
require(${JSON.stringify(join(import.meta.dir, '../hooks/scratch.cjs'))}).LEGACY_ROOT = ${JSON.stringify(join(root, 'legacy-scratch'))};
if (!isWithinWriteRoots(process.cwd()) || isWithinWriteRoots(process.env.SUPERAGENT_HOME!))
  process.exit(93);`
  );
  mkdirSync(join(root, 'sa', 'archon'), { recursive: true });
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$1" = quick ]; then
  "${process.execPath}" "${permission}" || exit $?
  printf '%s\n' '{"event":"started"}' '${missingRunId ? '{"ok":true}' : '{"run_id":"run-1"}'}'
  printf '%s\n' '{"code":"superagent.disk_observed","token":"raw-secret"}' >&2
  ${missingRunId ? ':' : `mkdir -p "$SUPERAGENT_HOME/runs"; printf '%s\n' '${JSON.stringify({ run_id: 'run-1', engine_commit: Bun.spawnSync(['git', '-C', snapshot, 'rev-parse', 'HEAD']).stdout.toString().trim(), engine_snapshot: snapshot })}' > "$SUPERAGENT_HOME/runs/run-1.json"`}
else printf '%s\n' '{"run_id":"run-1","state":"completed","delivery_state":"published"}'; printf '%s\n' '{"code":"superagent.disk_observed"}' >&2; fi
`
  );
  chmodSync(shim, 0o755);
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'sa', 'archon');
  return runProbe('G1', shim);
};

test('probe parses quick and wait JSON only from stdout', () => {
  const evidence = fakeProbe();
  expect(evidence).toMatchObject({ ok: true, run_id: 'run-1' });
  expect(evidence).not.toHaveProperty('console');
  expect(JSON.parse(readFileSync(evidence.evidence_path, 'utf8'))).not.toHaveProperty('attempts');
});

test('probe failure preserves redacted stdout and stderr tails', () => {
  const evidence = fakeProbe(true),
    saved = JSON.parse(readFileSync(evidence.evidence_path, 'utf8')) as {
      judgement: ProbeJudgement;
    };
  expect(saved.judgement.diagnostic).toContain(
    'stdout:\n{"event":"started"}\n{"ok":true}\nstderr:\n'
  );
  expect(saved.judgement.diagnostic).toContain('"token":***');
  expect(saved.judgement.diagnostic).not.toContain('raw-secret');
});

test('repair acceptance rejects the first candidate even with both markers and accepts the repair', () => {
  const root = tmp();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ['git', '-c', 'user.name=probe', '-c', 'user.email=probe@local', ...args],
      { cwd: root }
    );
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  writeFileSync(join(root, 'README.md'), '# probe\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  const accept = scenarioFor('G1', 'repair', join(root, 'first-head')).accept;
  const check = (engine: boolean) =>
    Bun.spawnSync(['sh', '-c', accept], {
      cwd: root,
      env: { ...process.env, SA_ACCEPTANCE: engine ? '1' : '' },
    });
  expect(check(true).exitCode).toBe(0);
  writeFileSync(join(root, 'README.md'), '# probe\nprobe-first\nprobe-repaired\n');
  git('commit', '-qam', 'first candidate');
  expect(check(false).exitCode).toBe(0);
  for (let i = 0; i < 2; i++) {
    const first = check(true);
    expect(first.exitCode).toBe(1);
    expect(first.stderr.toString()).toContain('probe-repaired');
  }
  git('commit', '--allow-empty', '-qm', 'repair');
  expect(check(true).exitCode).toBe(0);
  expect(scenarioFor('G2', 'simple').accept).toBe('grep -q probe-g1 README.md');
  expect(scenarioFor('G1', 'review').accept).toContain('src/auth/probe.ts');
  expect(scenarioFor('G1', 'scope').scope).toBe('README.md');
});

// prettier-ignore
test('scope probe abandons after reading held run evidence and records cleanup failure', async () => {
  const snapshot = resolve(import.meta.dir, '../..');
  const commit = Bun.spawnSync(['git', '-C', snapshot, 'rev-parse', 'HEAD']).stdout.toString().trim();
  for (const [scenario, state, runId, exit] of [
    ['scope', 'held:scope', 'run-1', 0],
    ['scope', 'held:scope', 'run-1', 7],
    ['scope', 'held:gate', 'run-1', 0],
    ['scope', 'held:scope', '', 0],
    ['simple', 'held:scope', 'run-1', 0],
  ] as const) {
    const root = tmp(), shim = join(root, 'shim'), trace = join(root, 'commands');
    const sa = join(root, 'sa'), art = join(sa, 'archon/artifacts/runs/archon-1');
    const ledger = join(sa, 'runs/run-1.json'), attempts = join(art, 'policy-attempts.json');
    mkdirSync(art, { recursive: true });
    mkdirSync(join(sa, 'runs'));
    writeFileSync(ledger, JSON.stringify({ run_id: runId, engine_commit: commit, engine_snapshot: snapshot, console: 'claude', archon_run_id: 'archon-1' }));
    writeFileSync(attempts, JSON.stringify([{ id: '1', node: 'code-quick', provider: 'codex', model: 'test', status: 'completed' }]));
    writeFileSync(shim, `#!/bin/sh
printf '%s\\n' "$1" >> '${trace}'
case "$1" in
quick) echo '${JSON.stringify({ run_id: runId })}' ;;
wait) echo '${JSON.stringify({ run_id: runId, state, delivery_state: 'not_reached', evidence: art })}'; exit 3 ;;
abandon) [ "$#" = 4 ] && [ "$2" = run-1 ] && [ "$3" = --reason ] && [ "$4" = 'engine probe scope scenario evidence collected' ] || exit 9
  : > '${ledger}'; : > '${attempts}'; echo 'fixture cleanup' >&2; exit ${exit} ;;
esac
`, { mode: 0o755 });
    Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: join(sa, 'archon') });
    const evidence = await runScenarioProbe('G1', 'claude', scenario, shim);
    const shouldAbandon = scenario === 'scope' && state === 'held:scope' && !!runId;
    const commands = ['quick', ...(runId ? ['wait'] : []), ...(shouldAbandon ? ['abandon'] : [])];
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(commands);
    expect(evidence.ok).toBe(shouldAbandon);
    if (shouldAbandon) expect(evidence.state).toBe('held:scope');
    if (exit) expect(evidence.error).toContain('fixture cleanup');
    if (exit) expect(JSON.parse(readFileSync(evidence.evidence_path, 'utf8'))).toMatchObject({ judgement: { diagnostic: evidence.error } });
    else if (shouldAbandon) expect(evidence.error).toBeUndefined();
  }
});

test('outage serves loopback 503 and saves provider failover evidence, then closes the port', async () => {
  const root = tmp(),
    shim = join(root, 'shim'),
    snapshot = resolve(import.meta.dir, '../..');
  const commit = Bun.spawnSync(['git', '-C', snapshot, 'rev-parse', 'HEAD'])
    .stdout.toString()
    .trim();
  const ledger = {
    run_id: 'run-1',
    engine_commit: commit,
    engine_snapshot: snapshot,
    console: 'gemini',
    archon_run_id: 'archon-1',
  };
  const attempts = [
    { id: '1', node: 'code-quick', provider: 'agy', model: 'neon', status: 'failed' },
    {
      id: '2',
      node: 'code-quick',
      provider: 'codex',
      model: 'alias',
      resolved: 'actual',
      status: 'completed',
      reassignment: {
        node: 'code-quick',
        from: 'agy',
        to: 'codex',
        reason: 'vendor_failure',
        failure: 'transient',
      },
    },
  ];
  writeFileSync(
    shim,
    `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sa = process.env.SUPERAGENT_HOME;
const art = join(sa, 'archon', 'artifacts/runs/archon-1');
if (process.argv[2] === 'quick') {
  if (process.argv[process.argv.indexOf('--console') + 1] !== 'gemini') process.exit(5);
  const url = process.env.AGY_LLM_GATEWAY_URL;
  const response = await fetch(url);
  if (response.status !== 503 || (await response.json()).error.status !== 'UNAVAILABLE') process.exit(6);
  mkdirSync(join(sa, 'runs'), { recursive: true });
  mkdirSync(art, { recursive: true });
  writeFileSync(join(sa, 'gateway'), url);
  writeFileSync(join(sa, 'runs/run-1.json'), JSON.stringify(${JSON.stringify(ledger)}));
  writeFileSync(join(art, 'policy-attempts.json'), JSON.stringify(${JSON.stringify(attempts)}));
  console.log(JSON.stringify({run_id:'run-1'}));
} else console.log(JSON.stringify({run_id:'run-1',state:'completed',delivery_state:'published',evidence:art}));
`,
    { mode: 0o755 }
  );
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'sa', 'archon');
  const evidence = await runScenarioProbe('G1', 'gemini', 'outage', shim);
  expect(evidence).toMatchObject({
    ok: true,
    console: 'gemini',
    scenario: 'outage',
    rounds: 1,
    state: 'completed',
    delivery_state: 'published',
    duration_ms: expect.any(Number),
    attempts: [
      { provider: 'agy', model: 'neon' },
      { provider: 'codex', model: 'actual' },
    ],
  });
  expect(JSON.parse(readFileSync(evidence.evidence_path, 'utf8'))).toMatchObject(evidence);
  await expect(fetch(readFileSync(join(root, 'sa/gateway'), 'utf8'))).rejects.toThrow();
});

test('matrix compares shared outcomes and requires the Gemini-only outage to pass', async () => {
  const calls: string[] = [];
  let failRepair = true,
    failOutage = true;
  const run = () =>
    runProbeMatrix('G1', 1, async (level, console, scenario) => {
      calls.push(`${console}/${scenario}`);
      const ok =
        !(failOutage && scenario === 'outage') &&
        !(failRepair && console === 'gemini' && scenario === 'repair');
      return {
        ok,
        level,
        console,
        scenario,
        duration_ms: 0,
        evidence_path: 'fixture',
        attempts: [],
        rounds: 0,
        state: ok ? 'completed' : 'failed',
        delivery_state: null,
      };
    });
  const matrix = await run();
  expect(calls).toEqual([
    'claude/simple',
    'claude/repair',
    'claude/review',
    'claude/scope',
    'gemini/simple',
    'gemini/repair',
    'gemini/review',
    'gemini/scope',
    'gemini/outage',
  ]);
  expect(matrix).toMatchObject({
    ok: false,
    consistent: false,
    comparisons: [
      { scenario: 'simple', consistent: true },
      { scenario: 'repair', consistent: false },
      { scenario: 'review', consistent: true },
      { scenario: 'scope', consistent: true },
      { scenario: 'outage', consistent: null },
    ],
  });
  failRepair = false;
  expect(await run()).toMatchObject({ ok: false, consistent: true });
  failOutage = false;
  expect(await run()).toMatchObject({ ok: true, consistent: true });
});
