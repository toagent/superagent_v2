import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { lock } from '../src/archon';
import { inspectProcess } from '../src/launcher';
import {
  autoPromote,
  currentEngineSnapshot,
  promote,
  rollback,
  runSnapshotProbe,
} from '../src/engine';
import type { ProbeEvidence } from '../src/probe';
import { sh, tmp } from './helpers';

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

function sourceFixture(): { root: string; source: string; evidence: string; sha: () => string } {
  const root = tmp(),
    source = join(root, 'source');
  sh(`git clone -q --no-hardlinks '${join(import.meta.dir, '..', '..')}' '${source}'`, root);
  sh('git config user.name test && git config user.email test@example.com', source);
  sh('git branch -M 1.0.0', source);
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

// prettier-ignore
test('snapshot probe executes the candidate with isolated homes and preserves failed output', () => {
  const root = tmp(),
    snapshot = join(root, 'candidate'),
    cli = join(snapshot, 'wetamp', 'src', 'cli.ts'),
    trace = join(root, 'trace.json');
  mkdirSync(join(snapshot, 'wetamp', 'src'), { recursive: true });
  process.env.SA_ENGINE_PROBE_TRACE = trace;
  process.env.SA_ENGINE_PROMOTER_TOKEN = 'leaked';
  writeFileSync(cli, `import { mkdirSync, writeFileSync } from 'node:fs'; const home = process.env.SUPERAGENT_HOME!; mkdirSync(home, { recursive: true }); const evidence = home + '/candidate-evidence.json'; writeFileSync(evidence, '{}'); writeFileSync(process.env.SA_ENGINE_PROBE_TRACE!, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home, archon: process.env.ARCHON_HOME, token: process.env.SA_ENGINE_PROMOTER_TOKEN })); console.log(JSON.stringify({ ok: true, level: 'G1', duration_ms: 1, evidence_path: evidence }));`);
  const evidence = runSnapshotProbe(snapshot),
    invoked = JSON.parse(readFileSync(trace, 'utf8'));
  expect(evidence.ok).toBe(true); expect(invoked.argv).toEqual(['engine', 'probe', 'G1']); expect(invoked.cwd).toBe(join(snapshot, 'wetamp'));
  expect(invoked.home).not.toBe(process.env.SUPERAGENT_HOME);
  expect(invoked.archon).toBe(join(invoked.home, 'archon')); expect(invoked.token).toBe('');
  writeFileSync(cli, `console.log(JSON.stringify({ ok: true, level: 'G1', duration_ms: 1, evidence_path: '/forged' }));
console.error('candidate probe stderr');
process.exit(7);
`);
  const failed = runSnapshotProbe(snapshot);
  expect(failed).toMatchObject({ ok: false, reason: 'probe_process_failed' });
  expect(failed.error).toContain('candidate probe stderr');
  expect(JSON.parse(readFileSync(failed.evidence_path, 'utf8'))).toMatchObject({ ok: false, reason: 'probe_process_failed' });
});

// prettier-ignore
test('bootstrap, descendant promotion, rollback rejection, and a newer descendant', () => {
  const f = sourceFixture(),
    first = f.sha();
  expect(promote(first, f.evidence).bootstrap_evidence).toBe(f.evidence);
  expect(() => promote(first, f.evidence)).toThrow('first-use only');
  const second = commit(f.source, 'second');
  expect(promote(second, undefined, { probe: successfulProbe })).toMatchObject({
    sha: second,
    results: [{ command: 'wetamp/scripts/engine-acceptance.sh' }, { run_id: 'probe-run' }],
  });
  expect(JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${second}.json`), 'utf8')).status).toBe('promoted');
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
});

test('promotion lock and protocol downgrade fail closed without publishing a receipt', () => {
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
});

// prettier-ignore
test('failed read-only candidate retries explicitly while in-service snapshots stay locked', () => {
  const f = sourceFixture(),
    first = f.sha();
  promote(first, f.evidence);
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
});

// prettier-ignore
test('auto promotion detaches once and marks a lost promoter with an explicit retry', async () => {
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
  const h = sourceFixture(), sha = h.sha(), token = 'handshake', child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'engine', 'promote', sha, '--bootstrap-evidence', h.evidence], { env: { ...process.env, SA_ENGINE_PROMOTER_TOKEN: token }, stdout: 'pipe', stderr: 'pipe' }), identity = inspectProcess(child.pid);
  if (identity.state !== 'online') throw new Error('fixture promoter unavailable');
  const childMarker = join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions', `${sha}.json`); mkdirSync(join(process.env.SUPERAGENT_HOME!, 'engine', 'promotions'), { recursive: true });
  writeFileSync(childMarker, JSON.stringify({ sha, status: 'running', pid: child.pid, pid_start: identity.start, host: 'fixture', token, at: new Date().toISOString() }));
  expect(await child.exited, (await new Response(child.stderr).text())).toBe(0); expect(JSON.parse(readFileSync(childMarker, 'utf8')).status).toBe('promoted');
});
