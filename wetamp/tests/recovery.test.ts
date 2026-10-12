import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { lastJson, recover, reusedOwnerPid, type RunView } from '../src/archon';
import { classify, EXIT } from '../src/cli';
import { recoverySnapshot, unknownEffects } from '../src/recovery';
import { WETAMP } from '../src/config';
import { gitRepo, sh, tmp } from './helpers';

async function until(check: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error('barrier timed out');
    await Bun.sleep(50);
  }
}

describe('recovery ownership and effects', () => {
  test('missing owner, remote owner, and reused PID are held with no guessed terminal transition', () => {
    // Detached launch before the child claims the row: still starting, wait keeps waiting.
    expect(classify({ id: 'r', status: 'pending' })).toEqual({
      state: 'pending',
      exit: EXIT.running,
    });
    for (const r of [
      { id: 'r', status: 'running' },
      { id: 'r', status: 'running', metadata: { execution_owner: { host: 'remote', pid: 10 } } },
    ] satisfies RunView[])
      expect(classify(r)).toEqual({ state: 'held:owner_unknown', exit: EXIT.held });
    const reused: RunView = {
      id: 'r',
      status: 'running',
      started_at: '2000-01-01T00:00:00Z',
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    expect(reusedOwnerPid(reused)).toBe(true);
    expect(classify(reused).state).toBe('held:owner_unknown');
  });

  test('land is instruction generation: missing or mismatched output is unknown; matching checkout output reconciles', () => {
    const root = tmp(),
      repo = gitRepo(root),
      artifacts = join(root, 'artifacts/runs/r');
    mkdirSync(artifacts, { recursive: true });
    const run: RunView = {
      id: 'r',
      status: 'running',
      output_root: root,
      working_path: repo,
      nodes: [{ nodeId: 'land', state: 'running' }],
    };
    expect(unknownEffects(run)).toEqual(['land']);
    const receipt = {
      branch: 'main',
      head: sh('git rev-parse HEAD', repo).trim(),
      commands: ['switch main', 'merge branch'],
    };
    writeFileSync(join(artifacts, 'land.json'), JSON.stringify({ ...receipt, head: 'old' }));
    expect(unknownEffects(run)).toEqual(['land']);
    writeFileSync(join(artifacts, 'land.json'), JSON.stringify(receipt));
    expect(unknownEffects(run)).toEqual([]);
    run.nodes?.push(
      { nodeId: 'code-W1', state: 'running' },
      { nodeId: 'verify-W2', state: 'running' }
    );
    expect(unknownEffects(run)).toEqual(['code-W1', 'verify-W2']);
  });

  test('unknown land effects require the exact snapshot before any mutation or resume', () => {
    const root = tmp(),
      sa = join(root, 'sa'),
      ah = join(sa, 'archon'),
      bin = join(root, 'archon');
    mkdirSync(ah, { recursive: true });
    const run: RunView = {
      id: 'r',
      status: 'running',
      metadata: { execution_owner: { host: hostname(), pid: 4194305 } },
      nodes: [{ nodeId: 'land', state: 'running', startedAt: '2026-10-11T00:00:00Z' }],
    };
    writeFileSync(
      bin,
      `#!/usr/bin/env bash\nif [ "$2" = get ]; then cat '${join(root, 'run.json')}'; else echo resume >> '${join(root, 'calls')}'; echo '{"ok":true}'; fi\n`
    );
    chmodSync(bin, 0o755);
    writeFileSync(join(root, 'run.json'), JSON.stringify(run));
    const db = new Database(join(ah, 'archon.db'));
    db.run(
      'create table remote_agent_workflow_runs(id text, status text, metadata text, started_at text)'
    );
    db.run('insert into remote_agent_workflow_runs values (?, ?, ?, null)', [
      'r',
      'running',
      JSON.stringify(run.metadata),
    ]);
    const env = { ...process.env };
    Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: ah, SA_ARCHON_BIN: bin });
    try {
      expect(recover('r')).toMatchObject({
        held: true,
        reason: 'effects_unknown',
        nodes: ['land'],
      });
      expect(
        recover('r', undefined, undefined, undefined, undefined, undefined, 'old')
      ).toMatchObject({ reason: 'effects_unknown' });
      expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
        status: 'running',
      });
      expect(existsSync(join(root, 'calls'))).toBe(false);
      expect(
        recover('r', undefined, undefined, undefined, undefined, undefined, recoverySnapshot(run))
          .ok
      ).toBe(true);
      expect(recover('r')).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
    } finally {
      process.env = env;
      db.close();
    }
  });

  test('lost launch acknowledgements fence both resume and engine adoption without repeating launch', () => {
    for (const adopt of [false, true]) {
      const root = tmp(),
        sa = join(root, 'sa'),
        ah = join(sa, 'archon'),
        bin = join(root, 'archon');
      mkdirSync(ah, { recursive: true });
      const run: RunView = {
        id: 'r',
        status: 'failed',
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid },
          superagent_recovery: {
            token: 'previous-generation',
            owner: { host: hostname(), pid: 4194305 },
            started_at: null,
          },
        },
      };
      writeFileSync(
        bin,
        `#!/usr/bin/env bash\nif [ "$2" = get ]; then echo '${JSON.stringify(run)}'; else echo launch >> '${join(root, 'calls')}'; fi\n`
      );
      chmodSync(bin, 0o755);
      const env = { ...process.env };
      Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: ah, SA_ARCHON_BIN: bin });
      try {
        const strategy = adopt
          ? {
              lockId: 'r',
              resolveId: () => 'r',
              adopt: () => ['workflow', 'run', 'fixture', '--detach', '--json'],
            }
          : undefined;
        const first = recover('r', undefined, undefined, undefined, undefined, strategy);
        expect(first).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
        if (!first.ok) expect(existsSync(first.evidence ?? '')).toBe(true);
        expect(classify(run).state).toBe('held:recovery_admission_unknown');
        expect(recover('r', undefined, undefined, undefined, undefined, strategy)).toMatchObject({
          held: true,
          reason: 'recovery_admission_unknown',
        });
        expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
        writeFileSync(join(ah, 'execution-admissions/r.json'), '{broken');
        expect(classify(run).state).toBe('held:recovery_admission_unknown');
        expect(recover('r')).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
      } finally {
        process.env = env;
      }
    }
  });
});

describe('stop-gate kernel lock (Node processes)', () => {
  const hook = join(WETAMP, 'hooks/stop-gate.cjs');
  const child = (file: string, body: string) =>
    Bun.spawn(
      [
        'node',
        '-e',
        `const {withState}=require(${JSON.stringify(hook)}); try {withState(${JSON.stringify(file)}, s=>{${body}})} catch(e) {console.error(e.message); process.exit(2)}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );

  test('a slow live owner outlives the former 15s stale threshold without losing its lock', async () => {
    const root = tmp(),
      file = join(root, 'state.json'),
      ready = join(root, 'ready');
    const first = child(
      file,
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,16000); s.count=(s.count||0)+1;`
    );
    try {
      await until(() => existsSync(ready));
      const ino = statSync(`${file}.lock`).ino;
      utimesSync(`${file}.lock`, new Date(0), new Date(0));
      const second = child(file, 's.count=(s.count||0)+1;');
      expect(await second.exited).toBe(2);
      expect(await new Response(second.stderr).text()).toContain('状态锁忙');
      expect(statSync(`${file}.lock`).ino).toBe(ino);
      expect(await first.exited).toBe(0);
      expect(await child(file, 's.count=(s.count||0)+1;').exited).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 2 });
      expect(statSync(`${file}.lock`).ino).toBe(ino);
    } finally {
      first.kill();
      await first.exited;
    }
  }, 30000);

  test('SIGKILL releases the lock, and an old lock file remains a single inode', async () => {
    const root = tmp(),
      file = join(root, 'state.json'),
      ready = join(root, 'ready');
    const first = child(
      file,
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);`
    );
    try {
      await until(() => existsSync(ready));
      first.kill('SIGKILL');
      await first.exited;
      expect(await child(file, 's.recovered=true;').exited).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ recovered: true });
    } finally {
      first.kill();
      await first.exited;
    }
  });
});

test('real Archon CAS/new-owner barrier fences two complete recover CLI processes', async () => {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa'),
    gen = join(root, 'gen');
  const barrier = join(root, 'owner-barrier'),
    release = join(root, 'owner-release');
  mkdirSync(join(gen, '.archon/workflows'), { recursive: true });
  writeFileSync(
    join(gen, '.archon/workflows/fence.yaml'),
    `name: fence\ndescription: deterministic recovery ownership barrier fixture\nnodes:\n  - id: start\n    bash: echo ready\n  - id: work\n    depends_on: [start]\n    bash: echo $$ > "$ARTIFACTS_DIR/child.pid"; exec sleep 60\n`
  );
  sh(
    'git init -q && git add .archon && git -c user.name=t -c user.email=t@l commit -qm fixture',
    gen
  );
  const driver = join(root, 'archon-driver.ts');
  const dbSource = join(WETAMP, '../packages/core/src/db/workflows.ts');
  const cliSource = join(WETAMP, '../packages/cli/src/cli.ts');
  writeFileSync(
    driver,
    `import {spyOn} from 'bun:test';
    import * as db from ${JSON.stringify(dbSource)};
    import {existsSync, writeFileSync} from 'node:fs';
    const update=db.updateWorkflowRun;
    if (process.env.REC_BARRIER === '1' && !process.argv.includes('--detach')) spyOn(db,'updateWorkflowRun').mockImplementation(async (id, input)=>{
      if (input.metadata?.execution_owner) {writeFileSync(${JSON.stringify(barrier)}, String(process.pid));
        for (const end=Date.now()+30000; !existsSync(${JSON.stringify(release)});) {if(Date.now()>end) throw Error('owner barrier deadline'); await Bun.sleep(20);}}
      return update(id,input);
    });
    await import(${JSON.stringify(cliSource)});`
  );
  const shim = join(root, 'archon');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec '${process.execPath}' '${driver}' "$@"\n`);
  chmodSync(shim, 0o755);
  const env = {
    ...process.env,
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: join(sa, 'archon'),
    SA_ARCHON_BIN: shim,
    XDG_STATE_HOME: join(root, 'state'),
    DATABASE_URL: '',
    SA_SKIP_DOCTOR: '1',
    SA_LAUNCHD_DIR: join(root, 'LaunchAgents'),
    REC_BARRIER: '0',
  };
  const call = (args: string[]) => {
    const p = Bun.spawnSync([shim, ...args], {
      cwd: repo,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    });
    if (p.exitCode !== 0)
      throw new Error(`archon fixture ${args[1]}: ${p.stderr.toString()} ${p.stdout.toString()}`);
    return lastJson(p.stdout.toString());
  };
  let owner: number | undefined, nodePid: number | undefined, runId: string | undefined;
  try {
    const install = Bun.spawnSync(['bash', join(WETAMP, 'scripts/install.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    });
    if (install.exitCode !== 0) {
      throw new Error(`install fixture: ${install.stderr.toString()} ${install.stdout.toString()}`);
    }
    expect(install.exitCode).toBe(0);
    const ack = call([
      'workflow',
      'run',
      'fence',
      '--workflow-source',
      gen,
      '--cwd',
      repo,
      '--detach',
      '--json',
    ]);
    runId = String(ack?.runId);
    let view: RunView | undefined;
    await until(() => {
      view = call(['workflow', 'get', runId ?? '', '--verbose', '--json']) as unknown as RunView;
      return view.nodes?.some(n => n.nodeId === 'work' && n.state === 'running') ?? false;
    });
    owner = view?.metadata?.execution_owner?.pid;
    expect(owner).toBeDefined();
    const pidPath = join(view?.output_root ?? '', 'artifacts/runs', runId, 'child.pid');
    await until(() => existsSync(pidPath));
    nodePid = Number(readFileSync(pidPath, 'utf8'));
    process.kill(owner ?? -1, 'SIGKILL');
    await until(() => {
      try {
        process.kill(owner ?? -1, 0);
        return false;
      } catch {
        return true;
      }
    });
    process.kill(nodePid, 'SIGKILL');
    const before = call(['workflow', 'get', runId, '--verbose', '--json']) as unknown as RunView;
    const recoverCli = (reconciled?: string) =>
      Bun.spawn(
        [
          join(WETAMP, 'bin/superagent'),
          'recover',
          runId ?? '',
          ...(reconciled ? ['--reconciled', reconciled] : []),
        ],
        { cwd: repo, env: { ...env, REC_BARRIER: '1' }, stdout: 'pipe', stderr: 'pipe' }
      );
    const first = recoverCli(recoverySnapshot(before));
    const firstOut = new Response(first.stdout).text(),
      firstErr = new Response(first.stderr).text();
    const firstCode = await first.exited;
    if (firstCode !== 0) {
      const result = lastJson(await firstOut);
      const evidence =
        typeof result?.evidence === 'string' ? readFileSync(result.evidence, 'utf8') : '';
      throw new Error(`first recover: ${await firstOut} ${await firstErr} ${evidence}`);
    }
    expect(lastJson(await firstOut)?.ok).toBe(true);
    await until(() => existsSync(barrier));
    const second = recoverCli();
    expect(await second.exited).toBe(EXIT.held);
    expect(lastJson(await new Response(second.stdout).text())).toMatchObject({
      ok: false,
      held: true,
      reason: 'recovery_admission_unknown',
    });
    const between = call(['workflow', 'get', runId, '--verbose', '--json']) as unknown as RunView;
    expect(between.status).toBe('running');
    expect(between.metadata?.execution_owner?.pid).toBe(owner);
    writeFileSync(release, 'release');
    await until(() => {
      const current = call([
        'workflow',
        'get',
        runId ?? '',
        '--verbose',
        '--json',
      ]) as unknown as RunView;
      return current.metadata?.execution_owner?.pid !== owner;
    });
  } finally {
    writeFileSync(release, 'release');
    if (runId) call(['workflow', 'abandon', runId, '--json']);
    for (const pid of [owner, nodePid])
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
  }
}, 120000);
