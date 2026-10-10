import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, tmp } from './helpers';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'verify-local.sh');

interface Verify {
  commit: string;
  ok: boolean;
  at: string;
  steps: { name: string; exit: number; ms: number }[];
  log: string;
  last_ok_commit: string | null;
}

/**
 * 临时仓库里放一份 verify-local.sh 与桩 selftest.sh；bun 桩按检出内容决定 `bun test` 成败，
 * 每次调用记一行到 calls.log，用来确认缓存命中时不再跑任何步骤。
 */
function fixture() {
  const root = tmp();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'wetamp', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'wetamp', 'scripts', 'verify-local.sh'));
  writeFileSync(join(repo, 'wetamp', 'scripts', 'selftest.sh'), 'echo "selftest $SUPERAGENT_HOME" >> "$CALLS"\n');
  writeFileSync(join(repo, 'bun.lock'), 'root-lock\n');
  writeFileSync(join(repo, 'wetamp', 'bun.lock'), 'wetamp-lock\n');
  writeFileSync(join(repo, 'wetamp', 'RESULT'), 'pass\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  const bunDir = join(root, 'bun', 'bin');
  mkdirSync(bunDir, { recursive: true });
  writeFileSync(
    join(bunDir, 'bun'),
    `#!/bin/sh
echo "bun $* @ $PWD" >> "$CALLS"
case "$1" in
  install) [ -n "$INSTALL_FAILS" ] && exit 1; exit 0;;
  test) grep -q fail RESULT && { echo "1 fail"; exit 1; }; exit 0;;
esac
exit 0
`
  );
  chmodSync(join(bunDir, 'bun'), 0o755);
  const git = (cmd: string): string => sh(`git -c user.name=t -c user.email=t@l ${cmd}`, repo).trim();
  sh('git init -q -b main', repo);
  git('add -A');
  git('commit -qm pass');
  const pass = git('rev-parse HEAD');
  writeFileSync(join(repo, 'wetamp', 'RESULT'), 'fail\n');
  git('commit -qam fail');
  const fail = git('rev-parse HEAD');
  const home = join(root, 'sa');
  const calls = join(root, 'calls.log');
  const run = (rev: string, env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(['bash', join(repo, 'wetamp', 'scripts', 'verify-local.sh'), '--commit', rev, '--timeout', '60'], {
      env: { ...process.env, SUPERAGENT_HOME: home, BUN_INSTALL: join(root, 'bun'), CALLS: calls, INSTALL_FAILS: '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = join(home, 'verify.json');
    return {
      code: p.exitCode,
      out: p.stdout.toString(),
      v: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Verify) : null,
    };
  };
  const callCount = (): number => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);
  return { root, repo, home, pass, fail, run, callCount, git };
}

// 每个用例建临时仓库并多次 git worktree add/remove，满载（如嵌在 verify-local 里跑）时超过 bun 默认 5s。
describe('scripts/verify-local.sh', () => {
  test('a passing commit writes ok verify.json; a failing one is cached with last_ok_commit kept', () => {
    const f = fixture();
    const a = f.run(f.pass);
    expect(a.code).toBe(0);
    expect(a.out).toContain(`${f.pass.slice(0, 12)} ok`);
    expect(a.v).toMatchObject({ commit: f.pass, ok: true, last_ok_commit: f.pass });
    expect(a.v?.steps.map(s => [s.name, s.exit])).toEqual([
      ['install', 0],
      ['install:wetamp', 0],
      ['tsc', 0],
      ['test', 0],
      ['selftest', 0],
    ]);
    expect(a.v?.log).toBe(join(f.home, 'verify', `${f.pass.slice(0, 12)}.log`));
    // 步骤与 selftest 用临时 home，调用方的 SUPERAGENT_HOME 只收到 verify.json 与日志。
    expect(readFileSync(join(f.root, 'calls.log'), 'utf8')).not.toContain(`selftest ${f.home}\n`);

    const b = f.run(f.fail);
    expect(b.code).toBe(1);
    expect(b.out).toContain('FAIL');
    expect(b.v).toMatchObject({ commit: f.fail, ok: false, last_ok_commit: f.pass });
    expect(b.v?.steps.at(-1)).toMatchObject({ name: 'test', exit: 1 });
    expect(readFileSync(b.v?.log ?? '', 'utf8')).toContain('1 fail');

    // 同一提交的失败也缓存：不再调用任何步骤。
    const before = f.callCount();
    const c = f.run(f.fail);
    expect(c.code).toBe(1);
    expect(c.out).toContain('cached');
    expect(f.callCount()).toBe(before);
    // 临时 worktree 与锁都已清理。
    expect(f.git('worktree list').split('\n').length).toBe(1);
    expect(existsSync(join(f.home, 'verify', 'lock'))).toBe(false);
  }, 60000);

  test('frozen install failure falls back to the main checkout node_modules only when the lock matches', () => {
    const f = fixture();
    mkdirSync(join(f.repo, 'node_modules'));
    mkdirSync(join(f.repo, 'wetamp', 'node_modules'));
    writeFileSync(join(f.repo, 'node_modules', 'keep'), '');
    const a = f.run(f.pass, { INSTALL_FAILS: '1' });
    expect(a.code).toBe(0);
    expect(a.v?.steps.map(s => s.name)).toEqual([
      'install',
      'install:linked',
      'install:wetamp',
      'install:wetamp:linked',
      'tsc',
      'test',
      'selftest',
    ]);
    // 摘链后再删 worktree：主仓依赖原样保留。
    expect(existsSync(join(f.repo, 'node_modules', 'keep'))).toBe(true);

    // 主仓工作区的 lock 与待验提交不一致：不借用依赖，安装失败即未通过。
    writeFileSync(join(f.repo, 'bun.lock'), 'drifted\n');
    const b = f.run(f.fail, { INSTALL_FAILS: '1' });
    expect(b.code).toBe(1);
    expect(b.v?.steps.map(s => [s.name, s.exit])).toEqual([['install', 1]]);
  }, 60000);
});
