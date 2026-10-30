import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { lock } from '../src/archon';
import { isWithinWriteRoots } from '../src/plan';
import {
  autoPromote,
  currentEngineSnapshot,
  engineCommand,
  engineStatus,
  followCurrentConsole,
  promote,
  rollback,
  runAcceptance,
  runSnapshotProbe,
} from '../src/engine';
import type { ProbeEvidence } from '../src/probe';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { sh, tmp } from './helpers';

const makeWritable = (path: string): void => {
  chmodSync(path, statSync(path).mode | 0o200);
  for (const entry of readdirSync(path, { withFileTypes: true }))
    if (entry.isDirectory()) makeWritable(join(path, entry.name));
};

const original = { ...process.env };
afterEach(async () => {
  const engine = process.env.SUPERAGENT_HOME && join(process.env.SUPERAGENT_HOME, 'engine');
  if (engine && existsSync(engine)) {
    makeWritable(engine);
    await removeTempTree(engine);
  }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}, testTimeout(120_000));

function sourceFixture(): { root: string; source: string; evidence: string; sha: () => string } {
  const root = tmp(),
    source = join(root, 'source');
  sh(`git clone -q --no-hardlinks '${join(import.meta.dir, '..', '..')}' '${source}'`, root);
  sh('git config user.name test && git config user.email test@example.com', source);
  sh('git checkout -q -B 1.0.0', source);
  const acceptance = join(source, 'wetamp', 'scripts', 'engine-acceptance.sh');
  writeFileSync(
    acceptance,
    '#!/usr/bin/env bash\nprobe=.acceptance-writable\n: > "$probe"\nrm "$probe"\n'
  );
  chmodSync(acceptance, 0o755);
  sh('git add wetamp/scripts/engine-acceptance.sh && git commit -qm acceptance', source);
  const evidence = join(root, 'evidence.json');
  writeFileSync(evidence, '{"accepted":true}\n');
  Object.assign(process.env, {
    HOME: root,
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'archon'),
    SA_ENGINE_SOURCE: source,
    SA_ENGINE_AUTO_PROMOTE: '0',
    SA_ENGINE_PROMOTER_TOKEN: '',
    SA_HEAVY_LOCK_FILE: join(root, 'heavy.lock'),
  });
  return { root, source, evidence, sha: () => sh('git rev-parse HEAD', source).trim() };
}

const commit = (source: string, name: string): string => {
  writeFileSync(join(source, name), name);
  sh(`git add '${name}' && git commit -qm '${name}'`, source);
  return sh('git rev-parse HEAD', source).trim();
};

// prettier-ignore
const successfulProbe = (): ProbeEvidence => JSON.parse('{"ok":true,"level":"G1","run_id":"probe-run","duration_ms":7,"evidence_path":"/probe/evidence.json"}');

test('engine acceptance removes success, failure, and timeout scratch but refuses a symlink', () => {
  const root = tmp(),
    snapshot = join(root, 'snapshot'),
    script = join(snapshot, 'wetamp/scripts/engine-acceptance.sh'),
    trace = join(root, 'trace');
  mkdirSync(join(snapshot, 'wetamp/scripts'), { recursive: true });
  writeFileSync(
    join(snapshot, 'wetamp/scripts/heavy-slot.sh'),
    readFileSync(join(import.meta.dir, '../scripts/heavy-slot.sh'))
  );
  process.env.TMPDIR = root;
  process.env.SUPERAGENT_HOME = join(root, 'home');
  process.env.TRACE = trace;
  process.env.SA_SERVED_RUN = 'served';
  process.env.SA_HISTORICAL_RUN = 'historical';
  process.env.SA_HEAVY_LOCK_FILE = join(root, 'heavy.lock');
  process.env.SA_ENGINE_ACCEPTANCE_KILL_GRACE_MS = '50';
  const log = join(root, 'home/engine/promotions/snapshot.acceptance.log');
  for (const body of ['exit 0', 'exit 7', 'sleep 2']) {
    writeFileSync(
      script,
      `mkdir -p "$SUPERAGENT_HOME"\nprintf '%s' "${'$'}{SUPERAGENT_HOME%/sa}" > "$TRACE"\nprintf 'body=${body} served=%s historical=%s\\n' "$SA_SERVED_RUN" "$SA_HISTORICAL_RUN"\nprintf 'stderr=${body}\\n' >&2\n${body}\n`
    );
    const invoke = () => runAcceptance(snapshot, body === 'sleep 2' ? 100 : 1_000);
    if (body === 'exit 0') expect(invoke().exit).toBe(0);
    else expect(invoke).toThrow(log);
    expect(readFileSync(log, 'utf8')).toBe(`body=${body} served= historical=\nstderr=${body}\n`);
    expect(existsSync(readFileSync(trace, 'utf8'))).toBe(false);
  }
  const target = join(root, 'target');
  mkdirSync(target);
  process.env.TARGET = target;
  writeFileSync(
    script,
    `mkdir -p "$SUPERAGENT_HOME"\nscratch="${'$'}{SUPERAGENT_HOME%/sa}"\nrmdir "$SUPERAGENT_HOME" "$scratch"\nln -s "$TARGET" "$scratch"\n`
  );
  expect(() => runAcceptance(snapshot, 1_000)).toThrow('scratch symlink retained');
  expect(existsSync(target)).toBe(true);
});

test('engine acceptance waits outside its timeout and reports holder exhaustion', async () => {
  const root = tmp(),
    snapshot = join(root, 'snapshot'),
    scripts = join(snapshot, 'wetamp/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['engine-acceptance.sh', 'heavy-slot.sh'])
    writeFileSync(join(scripts, name), readFileSync(join(import.meta.dir, '../scripts', name)));
  process.env.SUPERAGENT_HOME = join(root, 'home');
  process.env.SA_HEAVY_LOCK_FILE = join(root, 'heavy.lock');
  process.env.SA_HEAVY_LOCK_HELD = '';
  const holder = Bun.spawn(
    ['sh', '-c', '. "$1"; heavy_exec sleep 2', '_', join(scripts, 'heavy-slot.sh')],
    { env: { ...process.env, SA_HEAVY_LOCK_HELD: '' } }
  );
  for (let i = 0; i < 100 && !existsSync(`${process.env.SA_HEAVY_LOCK_FILE}.holder`); i++)
    await Bun.sleep(10);
  writeFileSync(join(scripts, 'engine-acceptance.sh'), '#!/bin/sh\nsleep 0.05\n');
  expect(runAcceptance(snapshot, 200, 4_000, 1_000).exit).toBe(0);
  expect(
    readFileSync(join(root, 'home/engine/promotions/snapshot.acceptance.log'), 'utf8')
  ).toContain('heavy slot wait: holder');
  expect(await holder.exited).toBe(0);

  const blocker = Bun.spawn(
    ['sh', '-c', '. "$1"; heavy_exec sleep 3', '_', join(scripts, 'heavy-slot.sh')],
    { env: { ...process.env, SA_HEAVY_LOCK_HELD: '' } }
  );
  for (let i = 0; i < 100 && !existsSync(`${process.env.SA_HEAVY_LOCK_FILE}.holder`); i++)
    await Bun.sleep(10);
  process.env.SA_HEAVY_LOCK_HELD = '1';
  expect(runAcceptance(snapshot, 200, 1_000, 1_000).exit).toBe(0);
  process.env.SA_HEAVY_LOCK_HELD = '';
  expect(() => runAcceptance(snapshot, 200, 1_000, 1_000)).toThrow('heavy_slot_wait_exhausted');
  blocker.kill('SIGKILL');
  await blocker.exited;
});

test('engine acceptance timeout kills its descendant process group', () => {
  const root = tmp(),
    snapshot = join(root, 'snapshot'),
    scripts = join(snapshot, 'wetamp/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['engine-acceptance.sh', 'heavy-slot.sh'])
    writeFileSync(join(scripts, name), readFileSync(join(import.meta.dir, '../scripts', name)));
  const descendant = join(root, 'descendant.pid');
  writeFileSync(
    join(scripts, 'engine-acceptance.sh'),
    `#!/bin/sh\nsleep 30 & echo $! > '${descendant}'\nwait\n`
  );
  process.env.SUPERAGENT_HOME = join(root, 'home');
  process.env.SA_HEAVY_LOCK_FILE = join(root, 'heavy.lock');
  process.env.SA_ENGINE_ACCEPTANCE_KILL_GRACE_MS = '50';
  expect(() => runAcceptance(snapshot, 100, 1_000, 1_000)).toThrow('engine acceptance failed');
  const pid = Number(readFileSync(descendant, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

test('current console follows only a loaded launchd job', () => {
  const root = tmp(),
    snapshot = join(root, 'snapshot'),
    restarted: string[] = [];
  process.env.SUPERAGENT_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'web.json'), JSON.stringify({ label: 'fixture' }));
  followCurrentConsole(
    snapshot,
    () => ({ status: 1, signal: null, stdout: '', stderr: '', pid: 1 }),
    path => restarted.push(path)
  );
  expect(restarted).toEqual([]);
  followCurrentConsole(
    snapshot,
    () => ({ status: 0, signal: null, stdout: '', stderr: '', pid: 1 }),
    path => restarted.push(path)
  );
  expect(restarted).toEqual([snapshot]);
});

test('engine acceptance script isolates files and stops at the first failure', () => {
  const root = tmp(),
    wetamp = join(root, 'wetamp'),
    bin = join(root, 'bin'),
    trace = join(root, 'trace');
  mkdirSync(join(wetamp, 'scripts'), { recursive: true });
  mkdirSync(join(wetamp, 'tests/scenarios'), { recursive: true });
  mkdirSync(bin);
  for (const script of ['engine-acceptance.sh', 'heavy-slot.sh'])
    writeFileSync(
      join(wetamp, 'scripts', script),
      readFileSync(join(import.meta.dir, '../scripts', script))
    );
  for (const file of [
    'tests/scenarios/a.test.ts',
    'tests/scenarios/b.test.ts',
    'tests/engine-c.test.ts',
  ])
    writeFileSync(join(wetamp, file), '');
  const bun = join(bin, 'bun');
  writeFileSync(
    bun,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\n[ "$4" != tests/scenarios/b.test.ts ]\n'
  );
  chmodSync(bun, 0o755);
  const result = Bun.spawnSync(['bash', 'scripts/engine-acceptance.sh'], {
    cwd: wetamp,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRACE: trace,
      SA_HEAVY_LOCK_FILE: join(root, 'heavy.lock'),
      SA_HEAVY_LOCK_HELD: '',
    },
  });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
    'run type-check',
    'test --timeout 900000 tests/scenarios/a.test.ts',
    'test --timeout 900000 tests/scenarios/b.test.ts',
  ]);
});

// prettier-ignore
test('snapshot probe removes successful scratch and preserves failed output', () => {
  const root = tmp(),
    snapshot = join(root, 'candidate'),
    cli = join(snapshot, 'wetamp', 'src', 'cli.ts'),
    trace = join(root, 'trace.json');
  mkdirSync(join(snapshot, 'wetamp', 'src'), { recursive: true });
  process.env.TMPDIR = '/var/folders/launchd-not-allowed';
  process.env.SUPERAGENT_WRITE_ROOTS = root;
  process.env.SA_ENGINE_PROBE_TRACE = trace;
  process.env.SA_ENGINE_PROMOTER_TOKEN = 'leaked';
  writeFileSync(cli, `import { mkdirSync, writeFileSync } from 'node:fs'; const home = process.env.SUPERAGENT_HOME!; mkdirSync(home, { recursive: true }); const evidence = home + '/candidate-evidence.json'; writeFileSync(evidence, '{}'); writeFileSync(process.env.SA_ENGINE_PROBE_TRACE!, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home, archon: process.env.ARCHON_HOME, token: process.env.SA_ENGINE_PROMOTER_TOKEN })); console.log(JSON.stringify({ ok: true, level: 'G1', duration_ms: 1, evidence_path: evidence }));`);
  const scratch = join(root, 'scratch'),
    evidence = runSnapshotProbe(snapshot, scratch),
    invoked = JSON.parse(readFileSync(trace, 'utf8'));
  expect(evidence.ok).toBe(true); expect(invoked.argv).toEqual(['engine', 'probe', 'G1']); expect(invoked.cwd).toBe(join(snapshot, 'wetamp'));
  expect(invoked.home).not.toBe(process.env.SUPERAGENT_HOME);
  expect(isWithinWriteRoots(scratch)).toBe(true); expect(invoked.home.startsWith(scratch)).toBe(true);
  expect(invoked.archon).toBe(join(invoked.home, 'archon')); expect(invoked.token).toBe('');
  expect(existsSync(join(invoked.home, '..'))).toBe(false);
  writeFileSync(cli, `import { mkdirSync, writeFileSync } from 'node:fs'; const home = process.env.SUPERAGENT_HOME!; mkdirSync(home, { recursive: true }); const evidence = home + '/failed.json'; writeFileSync(evidence, '{}'); console.log(JSON.stringify({ ok: false, level: 'G1', duration_ms: 1, reason: 'not_published', evidence_path: evidence }));`);
  const failed = runSnapshotProbe(snapshot, scratch);
  expect(failed).toMatchObject({ ok: false, reason: 'not_published' });
  expect(existsSync(failed.evidence_path)).toBe(true);
});

// prettier-ignore
// Each promote runs a real bun install; under load, one install can take over 10 seconds.
test('bootstrap, descendant promotion, rollback rejection, and a newer descendant', () => {
  const f = sourceFixture(),
    first = f.sha();
  expect(promote(first, f.evidence).bootstrap_evidence).toBe(f.evidence);
  expect(() => promote(first, f.evidence)).toThrow('first-use only');
  const second = commit(f.source, 'second');
  engineCommand(['hold', 'on']);
  let follows = 0;
  expect(promote(second, undefined, { probe: successfulProbe, followConsole: () => { follows++; throw new Error('restart failed'); } })).toMatchObject({
    sha: second,
    results: [{ command: 'wetamp/scripts/engine-acceptance.sh' }, { run_id: 'probe-run' }],
  });
  expect(follows).toBe(1);
  expect(JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${second}.json`), 'utf8'))).toMatchObject({ status: 'promoted', console_follow_error: 'Error: restart failed' });
  const installedAcceptance = join(
    process.env.SUPERAGENT_HOME!,
    'engine',
    second,
    'wetamp/scripts/engine-acceptance.sh'
  );
  expect(statSync(installedAcceptance).mode & 0o111).not.toBe(0);
  expect(statSync(installedAcceptance).mode & 0o222).toBe(0);
  expect(Bun.spawnSync(['bash', '-n', installedAcceptance]).exitCode).toBe(0);
  sh(`git switch -qc side '${first}'`, f.source);
  const divergent = commit(f.source, 'divergent');
  expect(() => promote(divergent, undefined, { probe: successfulProbe })).toThrow('not 1.0.0 HEAD');
  expect(
    existsSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'receipts', `${divergent}.json`))
  ).toBe(false);
  sh('git switch -q 1.0.0', f.source);
  expect(rollback()).toEqual({ from: second, to: first });
  expect(() => promote(second.slice(0, 8), undefined, { probe: successfulProbe })).toThrow(
    'sha is rejected'
  );
  const third = commit(f.source, 'third');
  expect(promote(third, undefined, { probe: successfulProbe }).sha).toBe(third);
  expect(currentEngineSnapshot()).toEndWith(third);
}, testTimeout(120_000));

// prettier-ignore
test('promotion keeps its verified candidate when 1.0.0 advances during the probe', () => {
  const f = sourceFixture(), first = f.sha();
  promote(first, f.evidence);
  const candidate = commit(f.source, 'candidate');
  const receipt = promote(candidate, undefined, { probe: () => (commit(f.source, 'advanced'), successfulProbe()) });
  expect(receipt.sha).toBe(candidate);
  expect(JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'receipts', `${candidate}.json`), 'utf8')).sha).toBe(candidate);
  expect(currentEngineSnapshot()).toEndWith(candidate);
}, testTimeout(120_000));

// prettier-ignore
test('promotion rejects a rewritten 1.0.0 and preserves current', () => {
  const f = sourceFixture(), first = f.sha();
  promote(first, f.evidence);
  const candidate = commit(f.source, 'candidate');
  expect(() => promote(candidate, undefined, { probe: () => {
    sh(`git switch -q --detach '${first}'`, f.source);
    sh(`git branch -f 1.0.0 '${commit(f.source, 'rewritten')}'`, f.source);
    return successfulProbe();
  } })).toThrow('1.0.0 was rewritten during acceptance');
  expect(currentEngineSnapshot()).toEndWith(first);
  expect(existsSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'receipts', `${candidate}.json`))).toBe(false);
}, testTimeout(120_000));

test(
  'promotion lock and protocol downgrade fail closed without publishing a receipt',
  () => {
    const f = sourceFixture(),
      first = f.sha();
    promote(first, f.evidence);
    const engine = join(process.env.SUPERAGENT_HOME!, 'engine');
    const held = lock(join(engine, 'engine.lock'));
    expect(held.ok).toBe(true);
    try {
      expect(() => promote(first)).toThrow('locked');
    } finally {
      if (held.ok) held.release();
    }

    const second = commit(f.source, 'second');
    const receipts = join(engine, 'receipts');
    const firstReceipt = JSON.parse(readFileSync(join(receipts, `${first}.json`), 'utf8'));
    firstReceipt.protocol_version = 2;
    writeFileSync(join(receipts, `${first}.json`), JSON.stringify(firstReceipt));
    expect(() => promote(second, undefined, { probe: successfulProbe })).toThrow(
      'protocol downgrade'
    );
    expect(existsSync(join(receipts, `${second}.json`))).toBe(false);
  },
  testTimeout(120_000)
);

// prettier-ignore
test('failed read-only candidate retries explicitly while in-service snapshots stay locked', () => {
  const f = sourceFixture(),
    first = f.sha();
  promote(first, f.evidence);
  const acceptance = join(f.source, 'wetamp/scripts/engine-acceptance.sh');
  writeFileSync(acceptance, '#!/bin/sh\necho full-failure-output\nexit 7\n');
  sh('git add wetamp/scripts/engine-acceptance.sh && git commit -qm failed-acceptance', f.source);
  const failed = f.sha(), failedLog = join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${failed}.acceptance.log`);
  expect(() => promote(failed, undefined, { probe: successfulProbe })).toThrow(failedLog);
  expect(JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${failed}.json`), 'utf8'))).toMatchObject({ status: 'failed', evidence_path: failedLog });
  writeFileSync(acceptance, '#!/bin/sh\nexit 0\n'); sh('git add wetamp/scripts/engine-acceptance.sh && git commit -qm restored-acceptance', f.source);
  const second = commit(f.source, 'second');
  expect(() => promote(second, undefined, { probe: path => { expect(statSync(path).mode & 0o222).toBe(0); return { ...successfulProbe(), ok: false, reason: 'not_published' }; } })).toThrow('probe_failed');
  const snapshot = join(process.env.SUPERAGENT_HOME!, 'engine', second),
    receipt = join(process.env.SUPERAGENT_HOME!, 'engine', 'receipts', `${second}.json`),
    mode = statSync(snapshot).mode;
  expect(statSync(snapshot).mode & 0o222).toBe(0); expect(existsSync(receipt)).toBe(false); expect(currentEngineSnapshot()).toEndWith(first);
  expect(JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${second}.json`), 'utf8'))).toMatchObject({ status: 'failed', error: 'probe_failed', evidence_path: '/probe/evidence.json' });
  const ledger = join(process.env.SUPERAGENT_HOME!, 'runs', 'referenced.json');
  mkdirSync(join(process.env.SUPERAGENT_HOME!, 'runs'));
  writeFileSync(ledger, JSON.stringify({ run_id: 'referenced', archon_run_id: 'a', repo: f.source, engine_snapshot: snapshot }));
  expect(() => promote(second, undefined, { probe: successfulProbe })).toThrow('snapshot_in_service');
  rmSync(ledger);
  writeFileSync(receipt, '{}');
  expect(() => promote(second, undefined, { probe: successfulProbe })).toThrow('snapshot_in_service');
  rmSync(receipt);
  expect(statSync(snapshot).mode).toBe(mode);
  expect(promote(second, undefined, { probe: successfulProbe }).sha).toBe(second);
  expect(() => promote(second, undefined, { probe: successfulProbe })).toThrow('snapshot_in_service');
  expect(statSync(snapshot).mode).toBe(mode);
}, testTimeout(120_000));

// prettier-ignore
test('auto promotion detaches once and marks a lost promoter with an explicit retry', () => {
  const f = sourceFixture(),
    first = f.sha();
  promote(first, f.evidence);
  delete process.env.SA_ENGINE_AUTO_PROMOTE;
  const second = commit(f.source, 'second'),
    marker = join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${second}.json`);
  let state: 'online' | 'offline' = 'online',
    detached = 0;
  const deps = { spawn: () => ({ pid: 424242, unref: () => detached++ }), inspect: () => state === 'online' ? ({ state, start: 'Mon Oct 20 00:00:00 2026' } as const) : ({ state } as const) };
  expect(autoPromote(deps)).toEqual({ sha: second, promoted: false });
  expect(detached).toBe(1);
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ status: 'running', pid: 424242, pid_start: 'Mon Oct 20 00:00:00 2026' });
  expect(autoPromote(deps)).toEqual({ sha: second, promoted: false });
  state = 'offline';
  expect(autoPromote(deps)).toMatchObject({ sha: second, error: expect.stringContaining('superagent engine promote') });
  expect(JSON.parse(readFileSync(marker, 'utf8')).status).toBe('failed');
}, testTimeout(60_000));

// prettier-ignore
test('engine hold is visible, idempotent, and pauses only automatic promotion', () => {
  const f = sourceFixture(), first = f.sha();
  promote(first, f.evidence);
  delete process.env.SA_ENGINE_AUTO_PROMOTE;
  const second = commit(f.source, 'second'), engine = join(process.env.SUPERAGENT_HOME!, 'engine'), marker = join(engine, 'promotions', `${second}.json`);
  let spawned = 0;
  const deps = { spawn: () => (spawned++, { pid: 424242, unref: () => {} }), inspect: () => ({ state: 'online', start: 'Mon Oct 20 00:00:00 2026' } as const) };
  expect(engineCommand(['hold', 'on'])).toMatchObject({ hold: { by: expect.any(String), at: expect.any(String) } });
  expect(engineCommand(['hold', 'on'])).toMatchObject({ hold: { by: expect.any(String), at: expect.any(String) } });
  expect(engineCommand(['hold', 'status'])).toEqual({ hold: (engineStatus() as { hold: unknown }).hold });
  expect(autoPromote(deps)).toEqual({ sha: second, promoted: false, held: true });
  expect(spawned).toBe(0); expect(existsSync(marker)).toBe(false);
  expect(engineCommand(['hold', 'off'])).toEqual({ hold: null });
  expect(engineCommand(['hold', 'off'])).toEqual({ hold: null });
  expect(autoPromote(deps)).toEqual({ sha: second, promoted: false });
  expect(spawned).toBe(1); expect(existsSync(marker)).toBe(true);
}, testTimeout(60_000));

// prettier-ignore
test('auto promotion waits for the promotion lock before spawning', () => {
  const f = sourceFixture(), first = f.sha();
  promote(first, f.evidence);
  delete process.env.SA_ENGINE_AUTO_PROMOTE;
  const second = commit(f.source, 'second'),
    engine = join(process.env.SUPERAGENT_HOME!, 'engine'),
    marker = join(engine, 'promotions', `${second}.json`),
    held = lock(join(engine, 'engine.lock'));
  expect(held.ok).toBe(true);
  let spawned = 0;
  const deps = { spawn: () => (spawned++, { pid: 424242, unref: () => {} }), inspect: () => ({ state: 'online', start: 'Mon Oct 20 00:00:00 2026' } as const) };
  try {
    expect(autoPromote(deps)).toEqual({ sha: second, promoted: false });
    expect(spawned).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally { if (held.ok) held.release(); }
  expect(autoPromote(deps)).toEqual({ sha: second, promoted: false });
  expect(spawned).toBe(1);
  expect(JSON.parse(readFileSync(marker, 'utf8')).status).toBe('running');
}, testTimeout(60_000));
