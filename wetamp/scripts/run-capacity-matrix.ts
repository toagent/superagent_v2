// Isolated real-engine / fake-provider capacity and failure replay. No install or supervisor.
// Usage: bun scripts/run-capacity-matrix.ts [--quick]; JSON goes to stdout.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { lastJson } from '../src/archon';
import { WETAMP, loadTiers, mergeConfig, runCapacity } from '../src/config';
import { EXIT_ADMISSION } from '../src/cli';
import type { Plan } from '../src/plan';

interface Row {
  id: string;
  status: string;
  metadata: string | null;
  working_path: string | null;
}
interface Sample {
  at_ms: number;
  pids: number[];
  rss_kb: number;
  fd: number;
}
const terminal = (r: Row): boolean => ['completed', 'failed', 'cancelled'].includes(r.status);

export async function capacityMatrix(quick = false): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'sa-capacity-'));
  const repo = join(root, 'repo'),
    ah = join(root, 'sa/archon');
  mkdirSync(ah, { recursive: true });
  const env = {
    ...process.env,
    SUPERAGENT_HOME: join(root, 'sa'),
    ARCHON_HOME: ah,
    SUPERAGENT_WRITE_ROOTS: root,
    SA_ARCHON_BIN: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    ARCHON_DETACHED_RUN_OWNER: '',
    BUN_OPTIONS: '',
    DATABASE_URL: '',
    XDG_STATE_HOME: join(root, 'state'),
  };
  const started = Date.now();
  const exec = (
    args: string[],
    extra: Record<string, string> = {}
  ): { code: number; out: string } => {
    const p = Bun.spawnSync(args, {
      env: { ...env, ...extra },
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    assert.equal(p.exitCode, 0, p.stderr.toString());
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  const archon = (...args: string[]): ReturnType<typeof lastJson> =>
    lastJson(exec([join(WETAMP, 'bin/archon'), 'workflow', ...args, '--json']).out);
  const rows = (): Row[] => {
    const db = new Database(join(ah, 'archon.db'), { readonly: true });
    try {
      return db
        .query('select id,status,metadata,working_path from remote_agent_workflow_runs')
        .all() as Row[];
    } finally {
      db.close();
    }
  };
  const until = async (check: () => boolean, timeout = 45_000): Promise<void> => {
    for (const deadline = Date.now() + timeout; !check(); ) {
      assert(Date.now() < deadline, 'matrix timed out');
      await Bun.sleep(250);
    }
  };
  const sample = (pids: number[]): Sample => {
    const rss = exec(['ps', '-o', 'rss=', '-p', pids.join(',')]).out;
    let fd = 0;
    if (process.platform === 'linux') {
      for (const pid of pids) fd += readdirSync(`/proc/${String(pid)}/fd`).length;
    } else {
      // Machine records only; no filenames or open-file contents enter the report.
      const p = Bun.spawnSync(['lsof', '-a', '-p', pids.join(','), '-d', '0-4096', '-Ff'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(p.exitCode, 0, 'FD sampling failed');
      fd = p.stdout
        .toString()
        .split('\n')
        .filter(x => /^f\d/.test(x)).length;
    }
    return {
      at_ms: Date.now() - started,
      pids,
      rss_kb: rss
        .trim()
        .split(/\s+/)
        .reduce((s, n) => s + Number(n), 0),
      fd,
    };
  };
  const launch = async (
    plan: string,
    extra: Record<string, string> = {}
  ): Promise<{ code: number; ack: ReturnType<typeof lastJson> }> => {
    const p = Bun.spawn(
      [
        process.execPath,
        join(WETAMP, 'src/cli.ts'),
        'run',
        plan,
        '--fake',
        '--skip-selftest',
        '--json',
      ],
      { env: { ...env, ...extra }, cwd: repo, stdout: 'pipe', stderr: 'pipe' }
    );
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const ack = lastJson(out);
    assert(ack, err || out);
    return { code, ack };
  };
  try {
    mkdirSync(repo);
    exec(['git', 'init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), 'capacity matrix\n');
    exec(['git', 'add', 'README.md']);
    exec([
      'git',
      '-c',
      'user.name=matrix',
      '-c',
      'user.email=matrix@localhost',
      'commit',
      '-qm',
      'init',
    ]);
    exec(['git', 'clone', '-q', '--bare', repo, join(root, 'origin.git')]);
    exec(['git', 'remote', 'add', 'origin', join(root, 'origin.git')]);
    exec(['git', 'fetch', '-q', 'origin']);
    writeFileSync(join(ah, 'config.yaml'), Bun.YAML.stringify(mergeConfig({}, loadTiers())));
    const release = join(root, 'release');
    const plan = JSON.parse(
      readFileSync(join(WETAMP, 'tests/fixtures/plan-two-pkgs.json'), 'utf8')
    ) as Plan;
    plan.repo = repo;
    plan.packages = [plan.packages[0]];
    plan.packages[0].accept = [
      { cmd: `while [ ! -f '${release}' ]; do sleep 0.2; done; test -f core.txt`, timeout_s: 120 },
    ];
    const path = join(root, 'plan.json');
    writeFileSync(path, JSON.stringify(plan));
    const beforeRuns = sample([process.pid]);
    const capacity = runCapacity(),
      n = quick ? 8 : 20;
    const storm = await Promise.all(Array.from({ length: n }, () => launch(path)));
    assert(
      storm.every(r => r.code === 0 || (r.code === EXIT_ADMISSION && r.ack?.status === 'rejected')),
      JSON.stringify(storm)
    );
    const accepted = storm.filter(r => r.code === 0).length;
    assert(accepted > 0 && accepted <= capacity);
    for (let i = accepted; i < capacity; i++) assert.equal((await launch(path)).code, 0);
    assert.equal(rows().filter(r => !terminal(r)).length, capacity);
    const genBefore = readdirSync(join(root, 'sa/gen')).length;
    const saturated = await launch(path);
    assert.equal(saturated.code, EXIT_ADMISSION);
    assert.equal(saturated.ack?.reason, 'run_capacity');
    assert.equal(readdirSync(join(root, 'sa/gen')).length, genBefore);
    await until(() => rows().every(r => r.status === 'running' && r.working_path));
    const workers = rows().map(
      r =>
        (JSON.parse(r.metadata ?? '{}') as { execution_owner: { pid: number } }).execution_owner.pid
    );
    const samples = [sample([process.pid, ...workers])];
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(quick ? 250 : 10_000);
      samples.push(sample([process.pid, ...workers]));
    }
    writeFileSync(release, 'ready');
    await until(() => rows().every(terminal));
    assert(
      rows().every(r => r.status === 'completed'),
      JSON.stringify(rows())
    );
    const afterRuns = sample([process.pid]);

    // Inject an OS spawn failure only at the real engine's detached worker boundary.
    const preload = join(root, 'fail-worker.ts');
    writeFileSync(
      preload,
      `import {mock} from 'bun:test';
import * as cp from 'node:child_process';
const original=cp.spawn;
mock.module('node:child_process',()=>({...cp,spawn:(cmd,args,opts)=>original(
  opts?.env?.ARCHON_DETACHED_RUN_OWNER==='1' ? ${JSON.stringify(join(root, 'missing-worker'))} : cmd,args,opts)}));\n`
    );
    const failShim = join(root, 'fail-archon');
    writeFileSync(
      failShim,
      `#!/bin/sh\nexec '${process.execPath}' --preload '${preload}' '${join(WETAMP, '../packages/cli/src/cli.ts')}' "$@"\n`,
      { mode: 0o755 }
    );
    const failure = await launch(path, { SA_ARCHON_BIN: failShim });
    assert.equal(failure.code, 1);
    const failedRows = rows().filter(r => r.status === 'failed');
    assert.equal(failedRows.length, 1);
    // A later submission can use the freed capacity; accepted runs were not cancelled.
    assert.equal((await launch(path)).code, 0);
    await until(() => rows().every(terminal));

    // Real event continuation lasts beyond an ordinary tick interval (30s).
    const source = join(root, 'continuation'),
      wf = join(source, '.archon/workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, 'matrix-cont.yaml'),
      Bun.YAML.stringify({
        name: 'matrix-cont',
        description: 'Isolated long continuation',
        nodes: [
          { id: 'gate', wait: { event: 'matrix.cont', deadline_ms: 120_000 } },
          { id: 'long', depends_on: ['gate'], bash: `sleep ${quick ? '1' : '35'}; echo done` },
        ],
      })
    );
    exec(['git', '-C', source, 'init', '-q']);
    exec(['git', '-C', source, 'add', '.archon']);
    exec([
      'git',
      '-C',
      source,
      '-c',
      'user.name=matrix',
      '-c',
      'user.email=matrix@localhost',
      'commit',
      '-qm',
      'continuation',
    ]);
    const ack = archon(
      'run',
      'matrix-cont',
      '--workflow-source',
      source,
      '--cwd',
      repo,
      '--detach'
    );
    assert.equal(ack?.ok, true);
    const id = String(ack?.runId);
    await until(() => rows().find(r => r.id === id)?.status === 'paused');
    const gate = archon('get', id, '--verbose') as { metadata: { wait: { resumeAt: string } } };
    const t0 = Date.now();
    const p = Bun.spawn(
      [
        join(WETAMP, 'bin/archon'),
        'workflow',
        'signal',
        id,
        '--event',
        'matrix.cont',
        '--resume-at',
        gate.metadata.wait.resumeAt,
        '--json',
      ],
      { env, cwd: repo, stdout: 'pipe', stderr: 'pipe' }
    );
    const continuationSamples = [sample([process.pid, p.pid])];
    await Bun.sleep(quick ? 250 : 31_000);
    assert.equal(p.exitCode, null, 'long continuation must still be live');
    continuationSamples.push(sample([process.pid, p.pid]));
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    assert.equal(code, 0, err || out);
    await until(() => rows().find(r => r.id === id)?.status === 'completed');
    return {
      ok: true,
      synthetic: true,
      engine: 'real Archon',
      providers: 'fake bash nodes',
      elapsed_ms: Date.now() - started,
      capacity,
      storm: {
        submitted: n,
        accepted,
        rejected: n - accepted,
        exits: storm.map(r => r.code),
        saturated: saturated.ack,
        no_generated_directory_on_refusal: true,
      },
      resources: { before_runs: beforeRuns, samples, after_runs: afterRuns },
      worker_start_failure: {
        exit: failure.code,
        failed_rows: failedRows.length,
        later_submission: 'completed',
      },
      continuation: {
        elapsed_ms: Date.now() - t0,
        samples: continuationSamples,
        status: 'completed',
      },
      cancelled_accepted_runs: rows().filter(r => r.status === 'cancelled').length,
    };
  } finally {
    // Every row and worktree here belongs to this scratch repo/home. Engine owns cancellation.
    if (Bun.file(join(ah, 'archon.db')).size) {
      for (const r of rows().filter(r => !terminal(r)))
        archon(r.status === 'running' ? 'cancel' : 'abandon', r.id);
      const pids = rows().flatMap(r => {
        const m = JSON.parse(r.metadata ?? '{}') as { execution_owner?: { pid: number } };
        return m.execution_owner ? [m.execution_owner.pid] : [];
      });
      await until(
        () =>
          pids.every(pid => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          }),
        15_000
      );
    }
    await removeTempTree(root);
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await capacityMatrix(process.argv.includes('--quick')), null, 2));
  } catch (e) {
    console.error((e as Error).stack);
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exitCode = 1;
  }
}
