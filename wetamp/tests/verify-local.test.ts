import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
  const stateFile = join(root, 'caller-state/superagent/install.json');
  mkdirSync(join(root, 'caller-state/superagent'), { recursive: true });
  const stateBytes = '{ "role": "worker", "commit": "caller" }\n';
  writeFileSync(stateFile, stateBytes);
  const writeState =
    'mkdir -p "$XDG_STATE_HOME/superagent"\nprintf \'{"role":"controller"}\\n\' > "$XDG_STATE_HOME/superagent/install.json"\necho "$XDG_STATE_HOME" >> "$STATE_CALLS"\n';
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'wetamp', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'wetamp', 'scripts', 'verify-local.sh'));
  writeFileSync(
    join(repo, 'wetamp', 'scripts', 'selftest.sh'),
    writeState + 'echo "selftest $SUPERAGENT_HOME" >> "$CALLS"\n'
  );
  writeFileSync(join(repo, 'bun.lock'), 'root-lock\n');
  writeFileSync(join(repo, 'wetamp', 'bun.lock'), 'wetamp-lock\n');
  writeFileSync(join(repo, 'wetamp', 'RESULT'), 'pass\n');
  const testFiles = [
    'tests/scenarios/scenario-rest.test.ts',
    'tests/scenarios/scenario-engine.test.ts',
    'tests/scenarios/mutations.test.ts',
    'tests/engine-promote.test.ts',
    'tests/alpha.test.ts',
    'tests/bravo.test.ts',
    'tests/charlie.test.ts',
    'tests/delta.test.ts',
    'tests/echo_test.js',
    'tests/foxtrot.spec.tsx',
  ];
  for (const file of testFiles) {
    mkdirSync(join(repo, 'wetamp', file, '..'), { recursive: true });
    writeFileSync(join(repo, 'wetamp', file), '');
  }
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  const bunDir = join(root, 'bun', 'bin');
  mkdirSync(bunDir, { recursive: true });
  writeFileSync(
    join(bunDir, 'bun'),
    `#!/bin/sh
${writeState}
echo "bun $* @ $PWD" >> "$CALLS"
[ -z "$READONLY_CAPTURE" ] || [ -e "$READONLY_CAPTURE" ] || {
  mkdir -p "$TMPDIR/readonly"; : > "$TMPDIR/readonly/snapshot"
  chmod 444 "$TMPDIR/readonly/snapshot"; chmod 555 "$TMPDIR/readonly"
  echo "$TMPDIR" > "$READONLY_CAPTURE"
}
case "$1" in
  install) [ -n "$INSTALL_FAILS" ] && exit 1; exit 0;;
  test)
    if [ -n "$SHARD_SYNC" ]; then
      mkdir -p "$SHARD_SYNC"; : > "$SHARD_SYNC/$$"; tries=0
      while [ "$(find "$SHARD_SYNC" -type f | wc -l | tr -d ' ')" -lt 4 ] && [ "$tries" -lt 100 ]; do sleep 0.05; tries=$((tries + 1)); done
      [ "$(find "$SHARD_SYNC" -type f | wc -l | tr -d ' ')" = 4 ] || exit 12
    fi
    case "$*" in *"$SHARD_FAIL"*) [ -z "$SHARD_FAIL" ] || { echo "1 fail"; exit 1; };; esac
    case "$*" in *"$SHARD_SLEEP"*) [ -z "$SHARD_SLEEP" ] || sleep 10;; esac
    grep -q fail RESULT && { echo "1 fail"; exit 1; }; exit 0;;
esac
exit 0
`
  );
  chmodSync(join(bunDir, 'bun'), 0o755);
  const git = (cmd: string): string =>
    sh(`git -c user.name=t -c user.email=t@l ${cmd}`, repo).trim();
  sh('git init -q -b main', repo);
  git('add -A');
  git('commit -qm pass');
  const pass = git('rev-parse HEAD');
  writeFileSync(join(repo, 'wetamp', 'RESULT'), 'fail\n');
  git('commit -qam fail');
  const fail = git('rev-parse HEAD');
  const home = join(root, 'sa');
  const calls = join(root, 'calls.log');
  const run = (rev: string, env: Record<string, string> = {}, timeout = '60') => {
    const p = Bun.spawnSync(
      [
        'bash',
        join(repo, 'wetamp', 'scripts', 'verify-local.sh'),
        '--commit',
        rev,
        '--timeout',
        timeout,
      ],
      {
        env: {
          ...process.env,
          SUPERAGENT_HOME: home,
          XDG_STATE_HOME: join(root, 'caller-state'),
          STATE_CALLS: join(root, 'state-calls'),
          BUN_INSTALL: join(root, 'bun'),
          CALLS: calls,
          INSTALL_FAILS: '',
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const out = join(home, 'verify.json');
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBytes);
    if (existsSync(join(root, 'state-calls')))
      expect(readFileSync(join(root, 'state-calls'), 'utf8')).not.toContain(
        join(root, 'caller-state')
      );
    return {
      code: p.exitCode,
      out: p.stdout.toString(),
      err: p.stderr.toString(),
      v: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Verify) : null,
    };
  };
  const callCount = (): number =>
    existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  return { root, repo, home, pass, fail, run, callCount, git, testFiles };
}

// 每个用例建临时仓库并多次 git worktree add/remove，满载（如嵌在 verify-local 里跑）时超过 bun 默认 5s。
describe('scripts/verify-local.sh', () => {
  test('runs four parallel shards with complete, unique and balanced heavy-test assignment', () => {
    const f = fixture(),
      sync = join(f.root, 'shard-sync');
    const result = f.run(f.pass, { SHARD_SYNC: sync });
    expect(result.code).toBe(0);
    const calls = readFileSync(join(f.root, 'calls.log'), 'utf8')
      .split('\n')
      .filter(line => line.startsWith('bun test '));
    expect(calls).toHaveLength(4);
    const assigned = calls.flatMap(line => f.testFiles.filter(file => line.includes(file)));
    expect([...assigned].sort()).toEqual([...f.testFiles].sort());
    expect(new Set(assigned).size).toBe(f.testFiles.length);
    for (const heavy of f.testFiles.slice(0, 4))
      expect(calls.filter(line => line.includes(heavy))).toHaveLength(1);
    expect(
      new Set(f.testFiles.slice(0, 4).map(file => calls.findIndex(line => line.includes(file))))
    ).toHaveLength(4);
    expect(result.v?.steps.find(step => step.name === 'test')).toMatchObject({ exit: 0 });
  }, 60000);

  test('one failed shard fails test, while one timed-out shard is inconclusive and uncached', () => {
    const failed = fixture();
    const a = failed.run(failed.pass, { SHARD_FAIL: 'scenario-rest.test.ts' });
    expect(a.code).toBe(1);
    expect(a.v?.steps.at(-1)).toMatchObject({ name: 'test', exit: 1 });

    const timed = fixture();
    const b = timed.run(timed.pass, { SHARD_SLEEP: 'scenario-rest.test.ts' }, '2');
    expect(b.code).toBe(1);
    expect(b.out).toContain('inconclusive');
    expect(b.v).toBeNull();
  }, 60000);

  test('exit reaps only detached processes carrying its exact temporary path', () => {
    const f = fixture(),
      capture = join(f.root, 'orphan-pids');
    const bun = join(f.root, 'bun/bin/bun');
    writeFileSync(
      bun,
      readFileSync(bun, 'utf8').replace(
        'case "$1" in',
        `if [ -n "$ORPHAN_CAPTURE" ] && [ ! -e "$ORPHAN_CAPTURE" ]; then
python3 -c 'import subprocess,sys; ps=[subprocess.Popen(["python3","-c","import time; time.sleep(60)",p],start_new_session=True) for p in (sys.argv[1]+"/orphan",sys.argv[1]+"x/orphan")]; open(sys.argv[2],"w").write(" ".join(str(p.pid) for p in ps))' "$TMPDIR" "$ORPHAN_CAPTURE"
fi
case "$1" in`
      )
    );
    let similar = 0;
    try {
      expect(f.run(f.pass, { ORPHAN_CAPTURE: capture }).code).toBe(0);
      const [owned, other] = readFileSync(capture, 'utf8').split(' ').map(Number);
      similar = other!;
      expect(() => process.kill(owned!, 0)).toThrow();
      expect(() => process.kill(similar, 0)).not.toThrow();
    } finally {
      if (similar) process.kill(similar, 'SIGKILL');
    }
  }, 60000);

  test('steps isolate global Git config and avoid production scratch TMPDIR', () => {
    const f = fixture(),
      config = join(f.root, 'host.gitconfig');
    writeFileSync(config, '[core]\n\thooksPath = /host-hooks\n');
    const bun = join(f.root, 'bun/bin/bun');
    writeFileSync(
      bun,
      readFileSync(bun, 'utf8').replace(
        '#!/bin/sh',
        `#!/bin/sh
git config --global --get core.hooksPath && exit 9
[ "$(git config --global user.name)" = "superagent verify" ] || exit 10`
      )
    );
    const result = f.run(f.pass, {
      GIT_CONFIG_GLOBAL: config,
      TMPDIR: '/tmp/sa-scratch/not-created',
    });
    expect(result.code).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('[core]\n\thooksPath = /host-hooks\n');
  });

  test('exit removes temporary trees containing read-only snapshots', () => {
    const f = fixture(),
      capture = join(f.root, 'tmp-path');
    expect(f.run(f.pass, { READONLY_CAPTURE: capture }).code).toBe(0);
    expect(existsSync(readFileSync(capture, 'utf8').trim())).toBe(false);
  });

  test.each(['dead', 'live', 'dirty'] as const)(
    'startup recovery respects %s lock ownership',
    async state => {
      const f = fixture(),
        old = join(f.root, 'sa-verify.orphan'),
        lock = join(f.home, 'verify/lock');
      mkdirSync(old);
      mkdirSync(lock, { recursive: true });
      f.git(`worktree add --detach '${old}/wt' HEAD`);
      const child = Bun.spawn(['true']);
      await child.exited;
      writeFileSync(join(lock, 'pid'), String(state === 'live' ? process.pid : child.pid));
      writeFileSync(join(lock, 'tmp'), old);
      if (state === 'dirty') writeFileSync(join(old, 'wt/keep'), 'keep');
      if (state === 'dead') {
        mkdirSync(join(old, 'readonly'));
        writeFileSync(join(old, 'readonly/snapshot'), 'sealed');
        chmodSync(join(old, 'readonly/snapshot'), 0o444);
        chmodSync(join(old, 'readonly'), 0o555);
      }
      const orphan =
        state === 'live'
          ? null
          : Bun.spawn(['python3', '-c', 'import time; time.sleep(60)', join(old, 'orphan')], {
              detached: true,
            });
      const result = f.run(f.pass, {}, state === 'live' ? '0' : '60');
      expect(result.code).toBe(state === 'live' ? 1 : 0);
      expect(existsSync(old)).toBe(state !== 'dead');
      expect(f.git('worktree list --porcelain').includes(`${old}/wt`)).toBe(state !== 'dead');
      if (state === 'dirty') expect(result.err).toContain(`retained dirty orphan ${old}`);
      if (orphan) {
        if (state === 'dirty') {
          expect(() => process.kill(orphan.pid, 0)).not.toThrow();
          orphan.kill();
        }
        await orphan.exited;
        expect(() => process.kill(orphan.pid, 0)).toThrow();
      }
    },
    60000
  );

  test('a passing commit writes ok verify.json; a failing one is cached with last_ok_commit kept', () => {
    const f = fixture();
    const a = f.run(f.pass);
    expect(a.code).toBe(0);
    expect(a.out).toContain(`${f.pass.slice(0, 12)} ok`);
    expect(a.v).toMatchObject({ commit: f.pass, ok: true, last_ok_commit: f.pass });
    expect(a.v?.steps.map(s => [s.name, s.exit])).toEqual([
      ['install', 0],
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
