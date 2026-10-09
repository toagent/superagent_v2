import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, sh, tmp } from './helpers';

const SCRIPTS = join(import.meta.dir, '..', 'scripts');
const GIT = 'git -c user.name=t -c user.email=t@l';
const exec = (cmd: string[], env: Record<string, string>): { code: number; out: string } => {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

describe('gc.sh', () => {
  /** 四个 run：done（completed 且已合入）、open（completed 未合入）、busy（running）、stray（worktree 不在 ARCHON_HOME）。 */
  function setup(): { root: string; repo: string; home: string; env: Record<string, string> } {
    const root = tmp();
    const repo = gitRepo(root);
    const home = join(root, 'home');
    const ah = join(home, 'archon');
    const stub = join(root, 'archon');
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "{\\"id\\":\\"$3\\",\\"status\\":\\"$(cat "${root}/status-$3")\\"}"\n`
    );
    chmodSync(stub, 0o755);
    mkdirSync(join(home, 'runs'), { recursive: true });
    const runs: [string, string, boolean, string][] = [
      ['done', 'completed', true, ah],
      ['open', 'completed', false, ah],
      ['busy', 'running', true, ah],
      ['stray', 'cancelled', true, join(root, 'elsewhere')],
    ];
    for (const [id, status, merged, wtRoot] of runs) {
      writeFileSync(join(root, `status-${id}`), status);
      const gen = join(home, 'gen', id);
      mkdirSync(gen, { recursive: true });
      writeFileSync(join(gen, 'plan.json'), JSON.stringify({ base_ref: 'origin/main' }));
      const wt = join(wtRoot, 'worktrees', id);
      sh(`git worktree add -q -b sa/${id} "${wt}" main`, repo);
      if (!merged) sh(`echo x > f && git add f && ${GIT} commit -qm ${id}`, wt);
      const ledger = { run_id: id, archon_run_id: id, repo, branch: `sa/${id}`, gen_dir: gen };
      writeFileSync(
        join(home, 'runs', `${id}.json`),
        JSON.stringify({ ...ledger, recoveries: [] })
      );
    }
    writeFileSync(
      join(home, 'asks.json'),
      JSON.stringify({ 'done:sa.human.m1:t': { id: '1' }, 'open:sa.human.m1:t': { id: '2' } })
    );
    const env = { SA_ARCHON_BIN: stub, SUPERAGENT_HOME: home, ARCHON_HOME: ah };
    return { root, repo, home, env };
  }

  test('dry-run lists the plan and skip reasons but changes nothing', () => {
    const { repo, home, env } = setup();
    const r = exec([join(SCRIPTS, 'gc.sh')], env);
    expect(r.out).toContain('gc done:');
    expect(r.out).toContain('skip open: sa/open not merged into main');
    expect(r.out).toContain('skip busy: not terminal (status exit 4)');
    expect(r.out).toContain('refuse: worktree');
    expect(r.out).toContain('(dry-run');
    expect(r.code).toBe(1); // stray 被拒
    expect(existsSync(join(home, 'gen', 'done'))).toBe(true);
    expect(sh('git branch --list sa/done', repo)).toContain('sa/done');
  }, 60000);

  test('--apply removes only terminal, merged runs and their asks', () => {
    const { repo, home, env } = setup();
    const r = exec([join(SCRIPTS, 'gc.sh'), '--apply', 'done', 'open', 'busy'], env);
    expect(r.code).toBe(0);
    expect(sh('git branch --list sa/done', repo)).toBe('');
    expect(sh('git worktree list', repo)).not.toContain('worktrees/done');
    expect(existsSync(join(home, 'gen', 'done'))).toBe(false);
    expect(existsSync(join(home, 'runs', 'done.json'))).toBe(false);
    expect(
      Object.keys(JSON.parse(readFileSync(join(home, 'asks.json'), 'utf8')) as object)
    ).toEqual(['open:sa.human.m1:t']);
    for (const id of ['open', 'busy'])
      expect(existsSync(join(home, 'runs', `${id}.json`))).toBe(true);
  }, 60000);

  test('flags other than --apply are rejected', () => {
    expect(exec([join(SCRIPTS, 'gc.sh'), '--force'], {}).code).toBe(2);
  });
});

describe('upgrade-upstream.sh', () => {
  const DB_TS = 'packages/core/src/db.ts';
  const COLUMNS = [
    'id TEXT PRIMARY KEY,',
    "status TEXT NOT NULL DEFAULT 'pending',",
    "metadata TEXT DEFAULT '{}'",
  ];
  const createTable = (cols: string[]): string =>
    [
      'db.exec(`',
      '  CREATE TABLE IF NOT EXISTS other (status TEXT, metadata TEXT);',
      '  CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (',
      ...cols.map(c => `    ${c}`),
      '  );',
      '`);',
      "const key = 'execution_owner'; // case 'owner_lost':",
      '',
    ].join('\n');
  const RECORDED = [
    'commit=old',
    `table ${DB_TS} remote_agent_workflow_runs status metadata`,
    `fact ${DB_TS} case 'owner_lost':`,
    '',
  ].join('\n');
  /** up：建表语句带真实列定义的上游（dev）；fork：clone -o upstream 后在 wetamp 分支放入脚本与 UPSTREAM 事实行；上游再前进一个提交。 */
  function setup(): { root: string; up: string; fork: string; env: Record<string, string> } {
    const root = tmp();
    const up = join(root, 'up');
    mkdirSync(join(up, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(up, DB_TS), createTable(COLUMNS));
    writeFileSync(join(up, 'package.json'), '{\n  "version": "9.9.9"\n}\n');
    sh(
      `git init -q -b dev up && git -C up add . && ${GIT} -C up commit -qm base && git clone -q -o upstream up fork`,
      root
    );
    const fork = join(root, 'fork');
    mkdirSync(join(fork, 'wetamp', 'scripts'), { recursive: true });
    for (const f of ['upgrade-upstream.sh', 'check-upstream-clean.sh'])
      cpSync(join(SCRIPTS, f), join(fork, 'wetamp', 'scripts', f));
    writeFileSync(join(fork, 'wetamp', 'UPSTREAM'), RECORDED);
    sh(`git switch -q -c wetamp && git add wetamp && ${GIT} commit -qm wetamp`, fork);
    sh(`echo '// more' >> ${DB_TS} && ${GIT} commit -qam next`, up);
    return { root, up, fork, env: { ARCHON_HOME: join(root, 'ah') } };
  }
  const upgrade = (fork: string, env: Record<string, string>, ...args: string[]) =>
    exec([join(fork, 'wetamp', 'scripts', 'upgrade-upstream.sh'), ...args], env);

  test('dry-run fetches, checks engine facts and prints the plan without touching branches', () => {
    const { up, fork, env } = setup();
    const head = sh('git rev-parse HEAD', fork);
    const r = upgrade(fork, env);
    expect(r.code).toBe(0);
    const short = sh('git rev-parse --short=8 HEAD', up).trim();
    for (const s of [
      'behind: 1',
      'db schema: skipped',
      'git merge --no-ff',
      `commit=${short} version=9.9.9`,
    ])
      expect(r.out).toContain(s);
    expect(sh('git rev-parse HEAD', fork)).toBe(head);
    expect(r.out).toContain('engine facts: ok (2)');
    expect(readFileSync(join(fork, 'wetamp', 'UPSTREAM'), 'utf8')).toBe(RECORDED);
  }, 60000);

  test('db schema: status and metadata columns are required', () => {
    const { root, fork, env } = setup();
    mkdirSync(join(root, 'ah'));
    const db = new Database(join(root, 'ah', 'archon.db'));
    db.run('create table remote_agent_workflow_runs (\n  id TEXT,\n  status TEXT\n)');
    db.close();
    const r = upgrade(fork, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('remote_agent_workflow_runs.metadata missing');
    const ok = new Database(join(root, 'ah', 'archon.db'));
    ok.run('alter table remote_agent_workflow_runs add column metadata TEXT');
    ok.close();
    expect(upgrade(fork, env).out).toContain('db schema: ok');
  }, 60000);

  test('upstream dropping a column from the run table fails, even if another table still has it', () => {
    const { up, fork, env } = setup();
    writeFileSync(
      join(up, DB_TS),
      createTable(['id TEXT PRIMARY KEY,', "status TEXT NOT NULL DEFAULT 'pending'"])
    );
    sh(`${GIT} commit -qam drop`, up);
    const r = upgrade(fork, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`upstream/dev:${DB_TS}: remote_agent_workflow_runs.metadata missing`);
  }, 60000);

  test('upstream dropping a registered fact, or an UPSTREAM without facts, fails the dry-run', () => {
    const { up, fork, env } = setup();
    writeFileSync(join(up, DB_TS), createTable(COLUMNS).replace("case 'owner_lost':", ''));
    sh(`${GIT} commit -qam drop`, up);
    expect(upgrade(fork, env).out).toContain("no longer has: case 'owner_lost':");
    writeFileSync(join(fork, 'wetamp', 'UPSTREAM'), 'commit=old\n');
    sh(`${GIT} commit -qam nofacts`, fork);
    const r = upgrade(fork, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('registers no engine facts');
  }, 60000);

  test('--apply merges with --no-ff, rewrites UPSTREAM and never commits it', () => {
    const { up, fork, env } = setup();
    const r = upgrade(fork, env, '--apply');
    expect(r.code).toBe(0);
    expect(sh('git rev-list --parents -n1 HEAD', fork).trim().split(' ')).toHaveLength(3);
    const short = sh('git rev-parse --short=8 HEAD', up).trim();
    const recorded = readFileSync(join(fork, 'wetamp', 'UPSTREAM'), 'utf8').split('\n');
    expect(recorded[0]).toStartWith(`commit=${short} version=9.9.9 branch=dev`);
    expect(recorded.slice(1).join('\n')).toBe(RECORDED.split('\n').slice(1).join('\n'));
    expect(sh('git status --porcelain', fork).trim()).toBe('M wetamp/UPSTREAM');
  }, 60000);

  test('refuses a dirty tree and unknown arguments', () => {
    const { fork, env } = setup();
    expect(upgrade(fork, env, '--force').code).toBe(2);
    writeFileSync(join(fork, 'wetamp', 'UPSTREAM'), 'dirty\n');
    const r = upgrade(fork, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('uncommitted changes');
  }, 60000);
});
