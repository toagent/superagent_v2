import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { admitRun, lock, pidAlive as archonPidAlive } from '../src/archon';
import { EXIT_ADMISSION } from '../src/cli';
import { home, WETAMP } from '../src/config';
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
  test('schema/read failure releases the launch lock without treating the DB as empty', () =>
    withHome(db => {
      db.run('drop table remote_agent_workflow_runs');
      expect(() => admitRun()).toThrow();
      const lease = lock(join(home().archon, 'run-admission.lock'));
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }));
  test('launch reservations retain unknown/live effects and clear only confirmed dead children', () =>
    withHome(() => {
      const path = join(home().archon, 'run-admission.json');
      for (const old of [
        { host: hostname() },
        { host: hostname(), pid: process.pid, pid_start: 'known' },
      ]) {
        writeFileSync(path, JSON.stringify(old));
        expect(admitRun()).toMatchObject({ ok: false, reason: 'admission_busy' });
        expect(existsSync(path)).toBe(true);
      }
      writeFileSync(
        path,
        JSON.stringify({ host: hostname(), pid: 2 ** 22 + 1, pid_start: 'known' })
      );
      const next = admitRun();
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
    const root = tmp(),
      repo = gitRepo(root),
      ah = join(root, 'archon');
    mkdirSync(ah);
    mkdirSync(join(root, 'sa'));
    const db = new Database(join(ah, 'archon.db'));
    db.run('create table remote_agent_workflow_runs(id text primary key, status text)');
    const capacity = 8;
    for (let i = 0; i < capacity - 1; i++)
      db.run('insert into remote_agent_workflow_runs values (?,?)', [`old${String(i)}`, 'running']);
    const ready = join(root, 'ready'),
      release = join(root, 'release'),
      done = join(root, 'done');
    const bin = join(root, 'fake-archon');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake.ts')}' "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(root, 'fake.ts'),
      `import {Database} from 'bun:sqlite';
import {writeFileSync,existsSync} from 'node:fs';
if(process.argv[2]!=='workflow'||process.argv[3]!=='run') {console.log('{\"ok\":true}');process.exit(0);}
writeFileSync(${JSON.stringify(ready)},String(process.pid));
while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
const db=new Database(${JSON.stringify(join(ah, 'archon.db'))});
db.run('insert into remote_agent_workflow_runs values (?,?)',['child'+String(process.pid),'pending']);db.close();
writeFileSync(${JSON.stringify(done)},'done');console.log(JSON.stringify({ok:true,runId:'child'}));`
    );
    const plan = fixturePlan(root, repo);
    const invoke = () =>
      Bun.spawn([process.execPath, join(WETAMP, 'src/cli.ts'), 'run', plan, '--fake'], {
        env: {
          ...process.env,
          SUPERAGENT_HOME: join(root, 'sa'),
          ARCHON_HOME: ah,
          SUPERAGENT_WRITE_ROOTS: root,
          SA_ARCHON_BIN: bin,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
    const until = async (check: () => boolean): Promise<void> => {
      for (const deadline = Date.now() + 5000; !check(); ) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(10);
      }
    };
    const a = invoke();
    try {
      await until(() => existsSync(ready));
      const reservation = JSON.parse(readFileSync(join(ah, 'run-admission.json'), 'utf8'));
      expect(reservation).toMatchObject({
        host: hostname(),
        pid: Number(readFileSync(ready, 'utf8')),
        pid_start: expect.any(String),
      });
      a.kill('SIGKILL');
      await a.exited;
      expect(await invoke().exited).toBe(EXIT_ADMISSION);
      expect(db.query('select count(*) as n from remote_agent_workflow_runs').get()).toEqual({
        n: capacity - 1,
      });
      writeFileSync(release, 'go');
      await until(() => existsSync(done));
      await until(() => !archonPidAlive(Number(readFileSync(ready, 'utf8'))));
      expect(await invoke().exited).toBe(0);
      expect(db.query('select count(*) as n from remote_agent_workflow_runs').get()).toEqual({
        n: capacity + 1,
      });
    } finally {
      a.kill('SIGKILL');
      await a.exited;
      if (existsSync(ready)) {
        try {
          process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
      db.close();
    }
  }, 15_000);
});
