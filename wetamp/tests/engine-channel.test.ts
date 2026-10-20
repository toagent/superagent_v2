import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import * as archon from '../src/archon';
import {
  adoptEngineSnapshot,
  assertEngineAccess,
  engineStatus,
  gateLegacyRuns,
  runningEngineSnapshot,
  type EngineReceipt,
} from '../src/engine';
import { collectEngineSnapshots } from '../src/gc';
import { gitRepo, sh, tmp } from './helpers';

const saved = { ...process.env };
let query: ReturnType<typeof spyOn<typeof archon, 'getRun'>> | undefined;
afterEach(() => {
  query?.mockRestore();
  query = undefined;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function engineHome() {
  const root = tmp(),
    sa = join(root, '.superagent'),
    engine = join(sa, 'engine');
  mkdirSync(join(engine, 'receipts'), { recursive: true });
  mkdirSync(join(sa, 'runs'), { recursive: true });
  Object.assign(process.env, {
    HOME: root,
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: join(root, 'archon'),
  });
  return { root, sa, engine };
}

function receipt(engine: string, sha: string, at: string): void {
  const value: EngineReceipt = {
    sha,
    protocol_version: 1,
    acceptance_hash: 'accepted',
    results: [],
    at,
  };
  writeFileSync(join(engine, 'receipts', `${sha}.json`), JSON.stringify(value));
}

function ledger(
  sa: string,
  run: string,
  options: { snapshot?: string; rejected?: boolean } = {}
): void {
  writeFileSync(
    join(sa, 'runs', `${run}.json`),
    JSON.stringify({
      run_id: run,
      archon_run_id: `archon-${run}`,
      repo: '/repo',
      plan: '/plan.json',
      gen_dir: '/gen',
      branch: `sa/${run}`,
      workflow: `sa-${run}`,
      console: 'codex',
      started_at: '',
      transcript: '',
      log: '',
      recoveries: [],
      engine_snapshot: options.snapshot,
      rejected: options.rejected ? `archon-${run}` : undefined,
    })
  );
}

test('status exposes current and served identities with live run-state groups', () => {
  const { sa, engine } = engineHome(),
    first = '1'.repeat(40),
    second = '2'.repeat(40),
    firstPath = join(engine, first),
    secondPath = join(engine, second);
  mkdirSync(firstPath);
  mkdirSync(secondPath);
  receipt(engine, first, '2026-01-01T00:00:00.000Z');
  receipt(engine, second, '2026-01-02T00:00:00.000Z');
  symlinkSync(secondPath, join(engine, 'current'));
  ledger(sa, 'failed', { snapshot: firstPath });
  ledger(sa, 'done', { snapshot: secondPath });
  query = spyOn(archon, 'getRun').mockImplementation(id => ({
    id,
    status: id.endsWith('failed') ? 'failed' : 'completed',
  }));

  const status = engineStatus() as {
    snapshots: { sha: string; identity: string; runs: Record<string, number> }[];
  };
  expect(status.snapshots).toEqual([
    expect.objectContaining({ sha: first, identity: 'served', runs: { failed: 1 } }),
    expect.objectContaining({ sha: second, identity: 'current', runs: { completed: 1 } }),
  ]);
});

test('explicit adopt is the only operation that changes a run snapshot', () => {
  const { root, sa, engine } = engineHome(),
    source = gitRepo(root),
    sha = sh('git rev-parse HEAD', source).trim(),
    target = join(engine, sha),
    old = join(engine, 'old');
  process.env.SA_ENGINE_SOURCE = source;
  mkdirSync(target);
  mkdirSync(old);
  receipt(engine, sha, '2026-01-01T00:00:00.000Z');
  symlinkSync(target, join(engine, 'current'));
  ledger(sa, 'run', { snapshot: old });

  expect(JSON.parse(readFileSync(join(sa, 'runs', 'run.json'), 'utf8')).engine_snapshot).toBe(old);
  expect(adoptEngineSnapshot('run', sha)).toMatchObject({ run: 'run', from: old, to: target });
  expect(JSON.parse(readFileSync(join(sa, 'runs', 'run.json'), 'utf8'))).toMatchObject({
    engine_snapshot: target,
    engine_snapshot_identity: 'current',
    engine_adoptions: [{ from: old, to: target }],
  });
  unlinkSync(join(engine, 'current'));
  symlinkSync(runningEngineSnapshot(), join(engine, 'current'));
  expect(() => assertEngineAccess(['recover', 'run'])).toThrow('engine adopt run');
});

test('served runs remain scoped across promotion rejection and rollback', () => {
  const { sa, engine } = engineHome(),
    running = runningEngineSnapshot(),
    sha = basename(running),
    other = join(engine, 'f'.repeat(40));
  mkdirSync(other);
  receipt(engine, sha, '2026-01-01T00:00:00.000Z');
  symlinkSync(running, join(engine, sha));
  symlinkSync(other, join(engine, 'current'));
  writeFileSync(join(engine, 'rejected.json'), JSON.stringify([sha]));
  for (const run of ['running', 'paused', 'crashed']) {
    ledger(sa, run, { snapshot: running });
    process.env.SA_SERVED_RUN = run;
    expect(() => assertEngineAccess(['resume', run])).not.toThrow();
  }
  unlinkSync(join(engine, 'current'));
  symlinkSync(running, join(engine, 'current'));
  delete process.env.SA_SERVED_RUN;
  for (const run of ['running', 'paused', 'crashed'])
    expect(() => assertEngineAccess(['resume', run])).not.toThrow();
});

test('legacy gate counts every executable or unknown run and excludes completed and rejected', () => {
  const { sa } = engineHome();
  const statuses = {
    online: 'running',
    pending: 'pending',
    ownerUnknown: 'running',
    failed: 'failed',
    paused: 'paused',
    cancelled: 'cancelled',
    completed: 'completed',
  } as const;
  for (const run of [...Object.keys(statuses), 'unknown']) ledger(sa, run);
  ledger(sa, 'rejected', { rejected: true });
  writeFileSync(join(sa, 'runs', 'broken.json'), '{');
  writeFileSync(join(sa, 'runs', 'identityless.json'), '{}');
  query = spyOn(archon, 'getRun').mockImplementation(id => {
    const name = id.slice('archon-'.length) as keyof typeof statuses;
    if (name === ('unknown' as keyof typeof statuses)) throw new Error('state unavailable');
    return { id, status: statuses[name] };
  });

  expect(gateLegacyRuns()).toMatchObject({
    ok: false,
    count: 9,
    runs: expect.arrayContaining([
      { run_id: 'cancelled', status: 'cancelled' },
      expect.objectContaining({ run_id: 'unknown', status: 'unknown' }),
      expect.objectContaining({
        run_id: 'broken',
        status: 'unknown',
        path: join(sa, 'runs', 'broken.json'),
      }),
      expect.objectContaining({
        run_id: 'identityless',
        status: 'unknown',
        path: join(sa, 'runs', 'identityless.json'),
      }),
    ]),
  });
});

test('snapshot gc keeps current, previous and recoverable references, then collects completed history', () => {
  const { sa, engine } = engineHome(),
    first = '1'.repeat(40),
    second = '2'.repeat(40),
    third = '3'.repeat(40);
  for (const [index, sha] of [first, second, third].entries()) {
    mkdirSync(join(engine, sha));
    receipt(engine, sha, `2026-01-0${String(index + 1)}T00:00:00.000Z`);
  }
  symlinkSync(join(engine, third), join(engine, 'current'));
  ledger(sa, 'history', { snapshot: join(engine, first) });
  ledger(sa, 'legacy');
  query = spyOn(archon, 'getRun').mockImplementation(id => ({
    id,
    status: id.endsWith('legacy') ? 'failed' : 'completed',
  }));

  expect(collectEngineSnapshots(true)).toEqual([]);
  ledger(sa, 'legacy', { rejected: true });
  expect(collectEngineSnapshots(true)).toEqual([
    expect.objectContaining({
      object: 'engine',
      action: 'would_remove',
      path: join(engine, first),
    }),
  ]);
  expect(collectEngineSnapshots(false)[0]).toMatchObject({ action: 'removed' });
  expect(existsSync(join(engine, first))).toBe(false);
  expect(existsSync(join(engine, second))).toBe(true);
  expect(existsSync(join(engine, third))).toBe(true);
  expect(engineStatus()).toMatchObject({ runs: { [first]: { completed: 1 } } });
});

test('snapshot gc resolves symlinked homes and fails closed on an unreadable ledger', () => {
  const { root, sa, engine } = engineHome(),
    first = '1'.repeat(40),
    second = '2'.repeat(40),
    third = '3'.repeat(40);
  for (const [index, sha] of [first, second, third].entries()) {
    mkdirSync(join(engine, sha));
    receipt(engine, sha, `2026-01-0${String(index + 1)}T00:00:00.000Z`);
  }
  symlinkSync(join(engine, first), join(engine, 'current'));
  ledger(sa, 'history', { snapshot: join(engine, first) });
  query = spyOn(archon, 'getRun').mockImplementation(id => ({ id, status: 'completed' }));
  const alias = join(root, 'sa-alias');
  symlinkSync(sa, alias);
  process.env.SUPERAGENT_HOME = alias;
  expect(collectEngineSnapshots(true)).toEqual([]);

  unlinkSync(join(engine, 'current'));
  symlinkSync(join(engine, third), join(engine, 'current'));
  writeFileSync(join(sa, 'runs', 'broken.json'), '{');
  expect(collectEngineSnapshots(false)[0]).toMatchObject({
    run_id: 'broken',
    object: 'engine',
    action: 'skipped',
  });
  expect(existsSync(join(engine, first))).toBe(true);
});
