import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { admitRun, lock, lastJson, pidAlive as archonPidAlive } from '../src/archon';
import { EXIT_ADMISSION } from '../src/cli';
import { home, loadTiers, runCapacity, WETAMP } from '../src/config';
import { fixturePlan, gitRepo, tmp } from '../tests/helpers';

function withHome(fn: (db: Database) => void): void {
  const root = tmp();
  const previous = {
    SUPERAGENT_HOME: process.env.SUPERAGENT_HOME,
    ARCHON_HOME: process.env.ARCHON_HOME,
  };
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'archon');
  mkdirSync(home().archon);
  const db = new Database(join(home().archon, 'archon.db'));
  db.run('create table remote_agent_workflow_runs(id text, status text)');
  try {
    fn(db);
  } finally {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('run admission', () => {
  test('capacity derives from vendor budgets and invalid budgets fail closed', () => {
    const tiers = loadTiers();
    expect(runCapacity(tiers)).toBe(
      Object.values(tiers.health.vendor_concurrency).reduce((a, b) => a + b, 0)
    );
    const invalid: Record<string, number>[] = [
      {},
      { codex: 0 },
      { codex: -1 },
      { codex: NaN },
      { codex: 1.5 },
    ];
    for (const caps of invalid)
      expect(() => runCapacity({ ...tiers, health: { vendor_concurrency: caps } })).toThrow();
  });
  test('pending, paused and ambiguous ownership occupy capacity; terminal runs free it', () =>
    withHome(db => {
      for (const [i, status] of [
        'pending',
        'running',
        'paused',
        'completed',
        'failed',
        'cancelled',
      ].entries())
        db.run('insert into remote_agent_workflow_runs values (?,?)', [String(i), status]);
      expect(admitRun(3)).toEqual({ ok: false, capacity: 3, active: 3, reason: 'run_capacity' });
      const accepted = admitRun(4);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw new Error('admission failed');
      expect(accepted.active).toBe(3);
      expect(admitRun(4)).toEqual({ ok: false, capacity: 4, reason: 'admission_busy' });
      accepted.release();
      db.run("update remote_agent_workflow_runs set status='completed' where id='0'");
      const next = admitRun(3);
      expect(next.ok).toBe(true);
      if (next.ok) next.release();
      expect(db.query('select status from remote_agent_workflow_runs where id=?').get('1')).toEqual(
        { status: 'running' }
      );
    }));
  test('schema/read failure releases the launch lock without treating the DB as empty', () =>
    withHome(db => {
      db.run('drop table remote_agent_workflow_runs');
      expect(() => admitRun(3)).toThrow();
      const lease = lock(join(home().archon, 'run-admission.lock'));
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }));
  test('launch reservations retain unknown/live effects and clear only confirmed dead children', () =>
    withHome(() => {
      const path = join(home().archon, 'run-admission.json');
      for (const old of [{ host: hostname() }, { host: hostname(), pid: process.pid, pid_start: 'known' }]) {
        writeFileSync(path, JSON.stringify(old));
        expect(admitRun(3)).toMatchObject({ ok: false, reason: 'admission_busy' });
        expect(existsSync(path)).toBe(true);
      }
      writeFileSync(path, JSON.stringify({ host: hostname(), pid: 2 ** 22 + 1, pid_start: 'known' }));
      const next = admitRun(3);
      expect(next.ok).toBe(true);
      if (next.ok) next.release();
      expect(existsSync(path)).toBe(false);
    }));
  test('a killed launcher releases its kernel lock', async () => {
    const root = tmp(),
      path = join(root, 'lease'),
      ready = join(root, 'ready');
    const script = join(root, 'hold.ts');
    writeFileSync(
      script,
      `import {lock} from ${JSON.stringify(join(WETAMP, 'src/archon.ts'))};
import {writeFileSync} from 'node:fs';
const l=lock(${JSON.stringify(path)}); if(!l.ok) process.exit(1);
writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`
    );
    const p = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
    try {
      for (const deadline = Date.now() + 5000; !existsSync(ready); ) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(25);
      }
      expect(lock(path).ok).toBe(false);
    } finally {
      p.kill('SIGKILL');
      await p.exited;
    }
    const next = lock(path);
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
  test('killed CLI cannot free admission while its pre-pending child is alive', async () => {
    const root = tmp(), repo = gitRepo(root), ah = join(root, 'archon');
    mkdirSync(ah); mkdirSync(join(root, 'sa'));
    const db = new Database(join(ah, 'archon.db'));
    db.run('create table remote_agent_workflow_runs(id text primary key, status text)');
    const capacity = runCapacity();
    for (let i = 0; i < capacity - 1; i++)
      db.run('insert into remote_agent_workflow_runs values (?,?)', [`old${String(i)}`, 'running']);
    const ready = join(root, 'ready'), release = join(root, 'release'), done = join(root, 'done');
    const bin = join(root, 'fake-archon');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake.ts')}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'fake.ts'), `import {Database} from 'bun:sqlite';
import {writeFileSync,existsSync} from 'node:fs';
if(process.argv[2]!=='workflow'||process.argv[3]!=='run') {console.log('{\"ok\":true}');process.exit(0);}
writeFileSync(${JSON.stringify(ready)},String(process.pid));
while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
const db=new Database(${JSON.stringify(join(ah, 'archon.db'))});
db.run('insert into remote_agent_workflow_runs values (?,?)',['child','pending']);db.close();
writeFileSync(${JSON.stringify(done)},'done');console.log(JSON.stringify({ok:true,runId:'child'}));`);
    const plan = fixturePlan(root, repo);
    const invoke = () => Bun.spawn([process.execPath, join(WETAMP, 'src/cli.ts'), 'run', plan, '--fake', '--skip-selftest'], {
      env: { ...process.env, SUPERAGENT_HOME: join(root, 'sa'), ARCHON_HOME: ah, SUPERAGENT_WRITE_ROOTS: root, SA_ARCHON_BIN: bin },
      stdout: 'ignore', stderr: 'ignore',
    });
    const until = async (check: () => boolean): Promise<void> => {
      for (const deadline = Date.now() + 5000; !check();) {
        expect(Date.now()).toBeLessThan(deadline); await Bun.sleep(10);
      }
    };
    const a = invoke();
    try {
      await until(() => existsSync(ready));
      const reservation = JSON.parse(readFileSync(join(ah, 'run-admission.json'), 'utf8'));
      expect(reservation).toMatchObject({ host: hostname(), pid: Number(readFileSync(ready, 'utf8')), pid_start: expect.any(String) });
      a.kill('SIGKILL'); await a.exited;
      expect(await invoke().exited).toBe(EXIT_ADMISSION);
      expect(db.query('select count(*) as n from remote_agent_workflow_runs').get()).toEqual({ n: capacity - 1 });
      writeFileSync(release, 'go'); await until(() => existsSync(done));
      await until(() => !archonPidAlive(Number(readFileSync(ready, 'utf8'))));
      expect(await invoke().exited).toBe(EXIT_ADMISSION);
      expect(db.query('select count(*) as n from remote_agent_workflow_runs').get()).toEqual({ n: capacity });
    } finally {
      a.kill('SIGKILL'); await a.exited;
      if (existsSync(ready)) { try { process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch { /* already exited */ } }
      db.close();
    }
  }, 15_000);

  test('bounded matrix: cross-CLI storm, refused requests create nothing, startup failure frees admission', async () => {
    const root = tmp(),
      repo = gitRepo(root),
      ah = join(root, 'archon');
    mkdirSync(ah);
    mkdirSync(join(root, 'sa'));
    const db = new Database(join(ah, 'archon.db'));
    db.run('create table remote_agent_workflow_runs(id text primary key, status text)');
    const capacity = runCapacity();
    for (let i = 0; i < capacity - 1; i++)
      db.run('insert into remote_agent_workflow_runs values (?,?)', [`old${String(i)}`, 'running']);
    const bin = join(root, 'fake-archon');
    // The subprocess is the admission/launch subject. Its row is the real shared SQLite boundary.
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake.ts')}' "$@"\n`);
    chmodSync(bin, 0o755);
    writeFileSync(
      join(root, 'fake.ts'),
      `import {Database} from 'bun:sqlite';
if(process.argv[2]!=='workflow'||process.argv[3]!=='run') {console.log('{"ok":true}');process.exit(0);}
const db=new Database(${JSON.stringify(join(ah, 'archon.db'))});
if(process.env.MATRIX_FAIL==='1') {console.log(JSON.stringify({ok:false,reason:'launch_failed'}));process.exit(1);}
db.run('insert into remote_agent_workflow_runs values (?,?)',[crypto.randomUUID(),'pending']);
await Bun.sleep(150);
console.log(JSON.stringify({ok:true,runId:'fixture'})); db.close();`
    );
    const plan = fixturePlan(root, repo);
    const invoke = async (
      fail = false,
      sa = join(root, 'sa')
    ): Promise<{ code: number; ack: ReturnType<typeof lastJson> }> => {
      const p = Bun.spawn(
        [process.execPath, join(WETAMP, 'src/cli.ts'), 'run', plan, '--fake', '--skip-selftest'],
        {
          env: {
            ...process.env,
            SUPERAGENT_HOME: sa,
            ARCHON_HOME: ah,
            SUPERAGENT_WRITE_ROOTS: root,
            SA_ARCHON_BIN: bin,
            MATRIX_FAIL: fail ? '1' : '',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
      return { code, ack: lastJson(out) };
    };
    try {
      const result = await Promise.all(Array.from({ length: 8 }, () => invoke()));
      expect(
        result.filter(r => r.code === 0),
        JSON.stringify(result)
      ).toHaveLength(1);
      expect(
        result.filter(r => r.code === EXIT_ADMISSION && r.ack?.status === 'rejected')
      ).toHaveLength(7);
      const gen = join(root, 'sa/gen');
      const before = readdirSync(gen);
      expect((await invoke()).ack?.reason).toBe('run_capacity');
      const otherHome = join(root, 'other-sa');
      mkdirSync(otherHome);
      expect((await invoke(false, otherHome)).ack?.reason).toBe('run_capacity');
      expect(existsSync(join(otherHome, 'gen'))).toBe(false);
      expect(readdirSync(gen)).toEqual(before);
      expect(db.query('select count(*) as n from remote_agent_workflow_runs').get()).toEqual({
        n: capacity,
      });
      db.run("update remote_agent_workflow_runs set status='completed' where status='pending'");
      const failed = await invoke(true);
      expect(failed.code).toBe(1);
      expect(failed.ack?.phase).toBe('engine');
      expect((await invoke()).code).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);
});
