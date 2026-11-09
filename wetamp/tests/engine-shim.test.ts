import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertEngineAccess, runningEngineSnapshot } from '../src/engine';
import { tmp } from './helpers';

const SHIM = join(import.meta.dir, '..', 'bin', 'superagent-shim');
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function fakeEngine(
  root: string,
  name: string,
  marker: string,
  schedule?: object,
  failExecutor = false
): string {
  const engine = join(root, name);
  mkdirSync(join(engine, 'wetamp', 'src'), { recursive: true });
  writeFileSync(
    join(engine, 'wetamp', 'src', 'cli.ts'),
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ engine: ${JSON.stringify(name)}, args, served: process.env.SA_SERVED_RUN || undefined, historical: process.env.SA_HISTORICAL_RUN || undefined }) + '\\n');
if (args[0] === 'engine' && args[1] === 'continuation') {
  if (args[2] === 'unsupported') process.exit(2);
  console.log(JSON.stringify({ current: args[2] === 'stale' }));
} else if (args[0] === 'status') console.log(JSON.stringify({ state: args[1] === 'archived' || args[1]?.startsWith('done-') ? 'completed' : 'running' }));
else if (args.includes('--schedule')) console.log(JSON.stringify(${JSON.stringify(schedule ?? {})}));
else console.log(JSON.stringify({ ok: true }));
if (${String(failExecutor)} && args.includes('--no-global')) process.exit(1);
`
  );
  return engine;
}

test('shim dispatches wait, current commands, and grouped tick without scheduler lock reentry', () => {
  const root = tmp(),
    home = join(root, 'home'),
    marker = join(root, 'calls.jsonl');
  mkdirSync(join(home, 'engine'), { recursive: true });
  mkdirSync(join(home, 'runs'), { recursive: true });
  const pinned = fakeEngine(root, 'pinned', marker);
  const other = fakeEngine(root, 'other', marker);
  const failed = fakeEngine(root, 'failed', marker, undefined, true);
  const bootstrap = fakeEngine(root, 'bootstrap', marker);
  const current = fakeEngine(root, 'current', marker, {
    groups: [
      { snapshot: failed, runs: ['run-failed'] },
      { snapshot: pinned, runs: ['run-1'] },
    ],
  });
  symlinkSync(current, join(home, 'engine', 'current'));
  mkdirSync(join(home, 'engine', 'receipts'));
  writeFileSync(
    join(home, 'engine', 'receipts', 'bootstrap.json'),
    JSON.stringify({ sha: 'bootstrap', at: '2026-01-01T00:00:00.000Z' })
  );
  symlinkSync(bootstrap, join(home, 'engine', 'bootstrap'));
  writeFileSync(join(home, 'runs', 'run-1.json'), JSON.stringify({ engine_snapshot: pinned }));
  writeFileSync(join(home, 'runs', 'stale.json'), JSON.stringify({ engine_snapshot: pinned }));
  writeFileSync(join(home, 'runs', 'run-other.json'), JSON.stringify({ engine_snapshot: other }));
  writeFileSync(join(home, 'runs', 'done-other.json'), JSON.stringify({ engine_snapshot: other }));
  writeFileSync(
    join(home, 'runs', 'unsupported.json'),
    JSON.stringify({ engine_snapshot: pinned })
  );
  writeFileSync(join(home, 'runs', 'legacy.json'), '{}');
  writeFileSync(
    join(home, 'runs', 'archived.json'),
    JSON.stringify({ engine_snapshot: join(root, 'collected') })
  );
  const invoke = (...args: string[]) =>
    Bun.spawnSync([SHIM, ...args], {
      env: {
        ...process.env,
        SUPERAGENT_HOME: home,
        SA_SERVED_RUN: '',
        SA_HISTORICAL_RUN: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  const defaultEnv: Record<string, string | undefined> = { ...process.env, HOME: root };
  delete defaultEnv.SUPERAGENT_HOME;
  delete defaultEnv.ARCHON_HOME;
  expect(Bun.spawnSync([SHIM, 'help'], { env: defaultEnv }).exitCode).toBe(0);
  expect(invoke('models').exitCode).toBe(0);
  expect(invoke('status', 'run-1').exitCode).toBe(0);
  expect(invoke('status', 'legacy').exitCode).toBe(0);
  expect(invoke('status', 'archived').exitCode).toBe(0);
  expect(invoke('wait', 'archived').exitCode).toBe(0);
  expect(invoke('wait', 'run-1', 'stale', '--timeout', '1').exitCode).toBe(0);
  const conflict = invoke('wait', 'run-1', 'run-other', '--timeout', '1');
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr.toString()).toContain(`${pinned}\trun-1`);
  expect(conflict.stderr.toString()).toContain(`${other}\trun-other`);
  expect(invoke('wait', 'archived', 'done-other', '--timeout', '1').exitCode).toBe(0);
  expect(invoke('resume', 'archived').exitCode).toBe(1);
  expect(invoke('resume', 'stale').exitCode).toBe(0);
  expect(invoke('resume', 'run-1').exitCode).toBe(0);
  expect(invoke('decide', 'run-1', 'approve').exitCode).toBe(0);
  expect(invoke('recover', 'unsupported').exitCode).toBe(0);
  expect(invoke('supervise-tick').exitCode).toBe(1);
  const calls = readFileSync(marker, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(calls).toEqual([
    { engine: 'current', args: ['models'] },
    { engine: 'pinned', args: ['status', 'run-1'], served: 'run-1' },
    { engine: 'bootstrap', args: ['status', 'legacy'], served: 'legacy' },
    { engine: 'current', args: ['status', 'archived'], historical: 'archived' },
    { engine: 'current', args: ['status', 'archived'], historical: 'archived' },
    { engine: 'current', args: ['wait', 'archived'], historical: 'archived' },
    { engine: 'pinned', args: ['wait', 'run-1', 'stale', '--timeout', '1'], served: 'run-1' },
    { engine: 'current', args: ['status', 'run-1'], historical: 'run-1' },
    { engine: 'current', args: ['status', 'archived'], historical: 'archived' },
    { engine: 'current', args: ['status', 'done-other'], historical: 'done-other' },
    {
      engine: 'current',
      args: ['wait', 'archived', 'done-other', '--timeout', '1'],
      historical: 'archived',
    },
    { engine: 'current', args: ['engine', 'continuation', 'archived'] },
    { engine: 'current', args: ['engine', 'continuation', 'stale'] },
    { engine: 'current', args: ['resume', 'stale'] },
    { engine: 'current', args: ['engine', 'continuation', 'run-1'] },
    { engine: 'pinned', args: ['resume', 'run-1'], served: 'run-1' },
    { engine: 'pinned', args: ['decide', 'run-1', 'approve'], served: 'run-1' },
    { engine: 'current', args: ['engine', 'continuation', 'unsupported'] },
    { engine: 'pinned', args: ['recover', 'unsupported'], served: 'unsupported' },
    { engine: 'current', args: ['supervise-tick', '--schedule'] },
    {
      engine: 'failed',
      args: ['supervise-tick', '--no-global', '--runs', 'run-failed'],
      served: 'run-failed',
    },
    {
      engine: 'pinned',
      args: ['supervise-tick', '--no-global', '--runs', 'run-1'],
      served: 'run-1',
    },
  ]);
});

test('installed jail re-enters before the superagent CLI', () => {
  const root = tmp(),
    jail = join(root, '.wetamp', 'jail'),
    marker = join(root, 'jail-args.json');
  mkdirSync(jail, { recursive: true });
  writeFileSync(join(jail, 'installed'), '');
  writeFileSync(join(jail, '.probe'), '');
  writeFileSync(
    join(jail, 'ai-jail'),
    `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(marker)}\n`,
    { mode: 0o755 }
  );
  const result = Bun.spawnSync([SHIM, 'models'], {
    env: { ...process.env, HOME: root },
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe(`${SHIM} models`);
});

test('installed shim injects synthetic managed secrets before entering jail', () => {
  const root = tmp(),
    jail = join(root, '.wetamp/jail'),
    bin = join(root, 'bin'),
    shim = join(root, 'superagent'),
    probe = crypto.randomUUID();
  mkdirSync(jail, { recursive: true });
  mkdirSync(bin);
  symlinkSync(SHIM, shim);
  writeFileSync(join(jail, 'installed'), '');
  writeFileSync(join(jail, '.probe'), '');
  writeFileSync(join(root, '.wetamp/secrets.list'), 'SF4_SYNTH\nSF4_MISSING\n');
  writeFileSync(
    join(bin, 'security'),
    `#!/bin/sh\n[ "$3" = SF4_SYNTH ] || exit 1\nprintf %s ${JSON.stringify(probe)}\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(jail, 'ai-jail'),
    `#!/bin/sh\n[ "$SF4_SYNTH" = ${JSON.stringify(probe)} ] && printf set || printf unset\n`,
    { mode: 0o755 }
  );
  const result = Bun.spawnSync([shim, 'models'], {
    env: { ...process.env, HOME: root, SECURITY_BIN: join(bin, 'security') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('set');
  expect(result.stderr.toString()).toContain('凭据 SF4_MISSING 不可用');
  expect(result.stderr.toString()).not.toContain(probe);
});

test('secret-env executable injects managed secrets before its command', () => {
  const root = tmp(),
    bin = join(root, 'security'),
    probe = crypto.randomUUID();
  mkdirSync(join(root, '.wetamp'), { recursive: true });
  writeFileSync(join(root, '.wetamp/secrets.list'), 'SF5_SYNTH\n');
  writeFileSync(bin, `#!/bin/sh\nprintf %s ${JSON.stringify(probe)}\n`, { mode: 0o755 });
  const result = Bun.spawnSync(
    [
      join(import.meta.dir, '..', 'bin', 'secret-env.sh'),
      '/bin/sh',
      '-c',
      'printf %s "$SF5_SYNTH"',
    ],
    {
      env: { ...process.env, HOME: root, SECURITY_BIN: bin },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(probe);
  expect(result.stderr.toString()).not.toContain(probe);
});

test('real continuation CLI emits the JSON contract consumed by the shim', () => {
  const root = tmp(),
    result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'engine',
        'continuation',
        'missing',
      ],
      {
        env: { ...process.env, HOME: root, SUPERAGENT_HOME: join(root, '.superagent') },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ current: false });
});

test('candidate access checks the real path of Archon state independently', () => {
  const root = tmp(),
    sa = join(root, 'isolated-sa'),
    candidate = join(root, 'candidate'),
    productionSa = join(root, '.superagent'),
    productionArchon = join(productionSa, 'archon'),
    archonAlias = join(root, 'archon-alias');
  mkdirSync(sa);
  mkdirSync(join(productionSa, 'engine'), { recursive: true });
  mkdirSync(candidate);
  mkdirSync(productionArchon, { recursive: true });
  symlinkSync(candidate, join(productionSa, 'engine', 'current'));
  symlinkSync(productionArchon, archonAlias);
  Object.assign(process.env, { HOME: root, SUPERAGENT_HOME: sa, ARCHON_HOME: archonAlias });
  expect(() => assertEngineAccess(['run', 'plan.json'])).toThrow('candidate checkout');
});

test('candidate and mismatched served snapshot writes are refused', () => {
  const root = tmp(),
    sa = join(root, '.superagent'),
    engine = join(sa, 'engine');
  mkdirSync(join(engine, 'receipts'), { recursive: true });
  mkdirSync(join(sa, 'runs'), { recursive: true });
  mkdirSync(join(root, 'other-engine'));
  symlinkSync(join(root, 'other-engine'), join(engine, 'current'));
  Object.assign(process.env, {
    HOME: root,
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: join(root, 'archon'),
  });
  expect(() => assertEngineAccess(['run', 'plan.json'])).toThrow('candidate checkout');

  const running = runningEngineSnapshot(),
    runningName = basename(running);
  writeFileSync(
    join(engine, 'receipts', `${runningName}.json`),
    JSON.stringify({ sha: runningName, at: '2026-01-01T00:00:00.000Z' })
  );
  symlinkSync(running, join(engine, runningName));
  writeFileSync(
    join(sa, 'runs', 'served.json'),
    JSON.stringify({ engine_snapshot: join(root, 'wrong') })
  );
  process.env.SA_SERVED_RUN = 'served';
  expect(() => assertEngineAccess(['resume', 'served'])).toThrow('snapshot mismatch');

  writeFileSync(join(sa, 'runs', 'served.json'), JSON.stringify({ engine_snapshot: running }));
  expect(() => assertEngineAccess(['resume', 'other'])).toThrow('unscoped write');
  expect(() => assertEngineAccess(['run', 'plan.json'])).toThrow('unscoped write');
  writeFileSync(join(sa, 'runs', 'legacy.json'), '{}');
  process.env.SA_SERVED_RUN = 'legacy';
  expect(() => assertEngineAccess(['resume', 'legacy'])).not.toThrow();

  unlinkSync(join(engine, 'current'));
  symlinkSync(running, join(engine, 'current'));
  delete process.env.SA_SERVED_RUN;
  writeFileSync(
    join(sa, 'runs', 'archived.json'),
    JSON.stringify({ engine_snapshot: join(root, 'collected') })
  );
  expect(() => assertEngineAccess(['status', 'archived'])).not.toThrow();
  expect(() => assertEngineAccess(['resume', 'archived'])).not.toThrow();
  expect(() => assertEngineAccess(['decide', 'archived', 'approve'])).toThrow(
    'engine adopt archived'
  );
});
