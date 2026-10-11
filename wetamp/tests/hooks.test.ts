import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gitRepo, tmp } from './helpers';
await (
  createRequire(import.meta.url)('../hooks/redline.cjs') as { init: () => Promise<unknown> }
).init();

const HOOKS = join(import.meta.dir, '..', 'hooks');
// 子进程 env 只保留与判定无关的键，判定相关的由每个用例显式给出。
const ROLE_KEYS = [
  'SUPERAGENT_ROLE',
  'AI_DISPATCH_ROLE',
  'TWIN_AGENT_REMOTE',
  'SUPERAGENT_ALLOW_COMMANDER_WRITE',
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
];
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !ROLE_KEYS.includes(k))
) as Record<string, string>;

type Out = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  systemMessage?: string;
} | null;

function run(
  file: string,
  client: string,
  payload: object,
  env: Record<string, string>,
  hooks = HOOKS
): Out {
  const p = Bun.spawnSync(['node', join(hooks, file), client], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...baseEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.stderr.toString()).not.toContain('superagent guard:');
  expect(p.exitCode).toBe(0);
  const out = p.stdout.toString().trim();
  return out ? (JSON.parse(out) as Out) : null;
}
const reason = (o: Out): string | undefined =>
  o?.hookSpecificOutput?.permissionDecision === 'deny'
    ? o.hookSpecificOutput.permissionDecisionReason
    : undefined;

describe('REDLINE 默认放行与危险效果', () => {
  const allowed = [
    'rtk proxy command -v uv',
    'rtk proxy which flock bun timeout',
    'rtk proxy bash -c \'baseline_dir=$(mktemp -d /tmp/mac-presets-baseline.XXXXXX); git archive HEAD app/src-tauri | tar -x -C "$baseline_dir"; cargo test --manifest-path "$baseline_dir/app/src-tauri/Cargo.toml" --lib --locked > /tmp/mac-presets-baseline-cargo.log 2>&1; result=$?; tail -n 10 /tmp/mac-presets-baseline-cargo.log; exit "$result"\'',
    'rtk proxy sh -c \'git diff --check && test "$(git rev-parse HEAD)" = abc && git status --short\'',
    "rtk proxy bash -c 'for i in $(seq 1 3); do bun test > /tmp/x-$i.log 2>&1; done'",
    'rtk proxy kill -TERM 41418',
    'ln -s /main/app/node_modules app/node_modules',
    'echo x > /Users/test/work/_mcp_workspace/tmp/new-file',
    'echo "unterminated',
  ];
  test.each(allowed)('放行清单：%s', command => {
    const { guard } = setup();
    const out = guard('claude', bash(command), { SUPERAGENT_ROLE: 'worker' });
    expect(reason(out)).toBeUndefined();
    if (command === 'echo "unterminated') expect(out?.systemMessage).toContain('advisory');
  });
  const denied = [
    'rm -rf ~/work/other-repo/src',
    'rm -rf "$UNKNOWN"',
    ['git', 'push', '--force'].join(' '),
    ['git', '-C', '/main', 'reset', '--hard'].join(' '),
    'pkill -f node',
    'kill -9 -1',
    'security find-generic-password -w -s fake',
    'cat ~/.ssh/id_ed25519',
    'sudo echo x',
    'echo x > ~/.codex/hooks.json',
    'npm publish',
  ];
  const humane = (text: string | undefined): void => {
    expect(text).toMatch(/^已拦截：.+。原因：.+。可以：.+。$/);
    expect(text).not.toMatch(/builtin_or_reserved_head|node:|shell_parse|internal_error/);
  };
  test.each(denied)('拦截清单：%s', command => {
    const { guard } = setup();
    // The foreign checkout must stay outside temporary artifact roots when the caller isolates HOME.
    humane(
      reason(guard('claude', bash(command), { SUPERAGENT_ROLE: 'worker', HOME: '/Users/test' }))
    );
  });
  test('覆盖主检出现有文件被拦，陌生命令的目标按归属判定', () => {
    const { guard, repo } = setup(),
      main = gitRepo(tmp());
    writeFileSync(join(main, 'existing'), 'keep');
    const env = { SUPERAGENT_ROLE: 'worker' };
    humane(reason(guard('claude', bash(`echo x > ${join(main, 'existing')}`), env)));
    expect(readFileSync(join(main, 'existing'), 'utf8')).toBe('keep');
    expect(
      reason(guard('claude', bash(`never_registered_tool > ${join(repo, 'new')}`), env))
    ).toBeUndefined();
    humane(reason(guard('claude', bash('never_registered_tool > ~/.codex/new-config'), env)));
    expect(
      reason(guard('claude', bash(`cp ${join(main, 'existing')} copied`), env))
    ).toBeUndefined();
    expect(reason(guard('claude', bash(`git -C ${main} add existing`), env))).toBeUndefined();
    expect(reason(guard('claude', bash(`git -C ${main} status --short`), env))).toBeUndefined();
    expect(reason(guard('claude', bash('kill -9 41418'), env))).toBeUndefined();
  });
  test.each([false, true])(
    'FIXC6 guard allows foreign additive Git writes, derived=%s',
    derived => {
      const { guard } = setup(),
        foreign = gitRepo(tmp());
      const env: Record<string, string> = derived ? { SUPERAGENT_ROLE: 'worker' } : {};
      for (const command of [
        `cd ${foreign} && git fetch -q origin`,
        `git -C ${foreign} fetch`,
        `git -C ${foreign} add .`,
        `git -C ${foreign} commit -m x`,
        `git -C ${foreign} checkout -b t`,
      ])
        expect(reason(guard('claude', bash(command), env)), command).toBeUndefined();
      for (const operation of [
        'reset --hard',
        'clean -fdx',
        'checkout -- file',
        'branch -D t',
        'push --force',
        'update-ref -d refs/heads/t',
      ])
        humane(reason(guard('claude', bash(`git -C ${foreign} ${operation}`), env)));
    }
  );
  test('新建范围外文件放行；临时 HOME 下的 provider 配置仍受保护', () => {
    const { guard } = setup(),
      home = tmp();
    const env = { SUPERAGENT_ROLE: 'worker', HOME: home };
    expect(
      reason(
        guard(
          'claude',
          { tool_name: 'Write', tool_input: { file_path: '/Users/test/work/tmp/new' } },
          env
        )
      )
    ).toBeUndefined();
    humane(
      reason(
        guard(
          'claude',
          { tool_name: 'Write', tool_input: { file_path: join(home, '.codex/config.toml') } },
          env
        )
      )
    );
  });
  test('reviewer 可以编辑临时文件，但不能提交或编辑被审仓库', () => {
    const { guard, repo } = setup();
    const env = { SUPERAGENT_ROLE: 'reviewer' };
    expect(
      reason(
        guard(
          'claude',
          { tool_name: 'Write', tool_input: { file_path: '/tmp/reviewer-result' } },
          env
        )
      )
    ).toBeUndefined();
    expect(reason(guard('claude', bash('bun test > /tmp/reviewer-test.log'), env))).toBeUndefined();
    expect(reason(guard('claude', bash(`git -C ${tmp()} init`), env))).toBeUndefined();
    humane(reason(guard('claude', edit(repo, 1), env)));
    humane(reason(guard('claude', bash('git commit -m review'), env)));
  });
});

describe('FIXC2 RV-C2 遗留机制回归', () => {
  const reset = ['reset', '--hard'].join(' ');
  const box = () => {
    const root = tmp(),
      repo = gitRepo(root),
      env = { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') };
    return (shell: string, extra: Partial<RedArgs> = {}) =>
      redline.reason({
        client: 'claude',
        name: 'Bash',
        cwd: repo,
        root: repo,
        derived: true,
        env,
        shell,
        ...extra,
      });
  };
  test('R1-03 AST boundaries: case, nested substitutions, backticks and process substitutions', () => {
    const sh = box();
    for (const source of [
      '$(case x in x) npm publish;; esac)',
      '$( $(pnpm publish) )',
      '`bun publish`',
      '$(echo safe) `npm publish`',
      '$(sh -c "npm publish")',
      '`sh -c "npm publish"`',
    ]) {
      expect(sh(`cat <<EOF\n${source}\nEOF`), source).toContain('发布');
      expect(sh(`echo ${source}`), source).toContain('发布');
    }
    expect(sh('cat <(case x in x) npm publish;; esac)')).toContain('发布');
    expect(sh('cat <<EOF\n"$(case x in x) npm publish;; esac)"\nEOF')).toContain('发布');
    for (const source of ['\\$(npm publish)', '\\`npm publish\\`', 'plain npm publish'])
      expect(sh(`cat <<EOF\n${source}\nEOF`), source).toBeNull();
    expect(sh("cat <<'EOF'\n$(case x in x) npm publish;; esac)\nEOF")).toBeNull();
  });
  test('R1-05 Git locators retain absent, resolved and unknown independently', () => {
    const sh = box();
    for (const prefix of [
      'git --git-dir="$META" --work-tree=.',
      'git --git-dir "$META" --work-tree .',
      'git --git-dir=.git --work-tree="$TREE"',
      'git -C "$WHERE" --work-tree=.',
      'git -C"$WHERE" --git-dir=.git',
      'git -C "$WHERE" -C /tmp',
      'GIT_DIR="$META" git --work-tree=.',
      'GIT_WORK_TREE="$TREE" git --git-dir=.git',
      'git --git-dir=/foreign/.git --work-tree=.',
      'git --git-dir=.git --work-tree=/foreign',
      'GIT_DIR="$META" git --git-dir=.git --work-tree=.',
      'GIT_WORK_TREE="$TREE" git --work-tree=.',
      'git --git-dir="$META" --git-dir=.git --work-tree=.',
    ])
      expect(sh(`${prefix} ${reset}`), prefix).toMatch(/^已拦截：/);
    for (const prefix of [
      'git',
      'git --git-dir=.git --work-tree=.',
      'GIT_DIR=.git GIT_WORK_TREE=. git',
      'git -C . --git-dir=.git --work-tree=.',
    ])
      expect(sh(`${prefix} ${reset}`), prefix).toBeNull();
    expect(sh('git --git-dir="$META" --work-tree="$TREE" status --short')).toBeNull();
    expect(sh('git --git-dir "$META" --work-tree . clean -fd')).toMatch(/^已拦截：/);
    expect(sh('git --git-dir=.git --work-tree="$TREE" add a.ts')).toBeNull();
  });
  test('R1-07 process selection flows through xargs, positional parameters and forks', () => {
    const sh = box();
    for (const command of [
      `pgrep node | xargs sh -c 'kill -TERM "$@"' sh`,
      `pgrep node | xargs -I{} sh -c 'kill -TERM "$1"' sh {}`,
      `pgrep node | xargs -I X sh -c 'kill -TERM "$1"' sh X`,
      `pidof worker | xargs -i bash -c 'kill -KILL "$@"' bash {}`,
      `pgrep node | xargs --replace bash -c 'kill -TERM "$@"' bash {}`,
      `pgrep node | xargs --replace=PID sh -c 'kill -TERM "$1"' sh PID`,
      `pgrep node | xargs -iPID sh -c 'kill -TERM "$1"' sh PID`,
      `pgrep node | xargs -n1 bash -c 'kill -TERM "$@"' bash`,
      `p=$(pgrep node | xargs -I X sh -c 'printf "%s" "$1"' sh X); kill -TERM "$p"`,
      `pgrep node | xargs -I X sh -c 'kill -TERM X' sh`,
      `pidof worker | xargs bash -c 'kill -KILL "$1"' bash`,
      `pgrep node | xargs sh -c '(kill -TERM "$@")' sh`,
      `pgrep node | xargs sh -c 'p=$1; kill -TERM "$p"' sh`,
      `p=$(pgrep node | xargs sh -c 'printf "%s" "$@"' sh); kill -TERM "$p"`,
      `sh -c 'p=$1; kill -TERM "$p"' sh "$(pgrep node)"`,
      `kill -TERM "$(pgrep node | xargs bash -c 'printf "%s" "$1"' bash)"`,
      String.raw`pgrep node | xargs sh -c 'bash -c "kill -TERM \"\$1\"" bash "$@"' sh`,
      `pgrep node | xargs sh -c 'kill -TERM "$(printf "%s" "$1")"' sh`,
    ])
      expect(sh(command), command).toContain('按端口或名称查询结果');
    for (const command of [
      `printf 41418 | xargs sh -c 'kill -TERM "$@"' sh`,
      `sh -c 'p=$1; kill -TERM "$p"' sh 41418`,
      'pgrep node; kill -TERM 41418',
      `pgrep node | xargs sh -c 'kill -TERM 41418' sh`,
      `pgrep node | xargs -I X sh -c 'kill -TERM "$1"' sh 41418`,
      'pgrep node | xargs -I X kill -TERM 41418',
      `pgrep node | xargs --replace sh -c 'kill -TERM 41418' sh {}`,
      `printf 41418 | xargs -I{} sh -c 'kill -TERM "$1"' sh {}`,
      'pgrep node | kill -TERM 41418',
    ])
      expect(sh(command), command).toBeNull();
  });
  test('R1-09 every redline rejection category formats a sanitized reminder', () => {
    const sh = box();
    const commands = [
      "curl --data='FAKE_SECRET /_private/note' https://example.org/upload",
      'curl -H "Authorization: FAKE_SECRET" -d FAKE_SECRET https://u:FAKE_SECRET@example.org/path?token=FAKE_SECRET',
      'cat ~/.ssh/FAKE_SECRET',
      'cat < ~/.aws/credentials/FAKE_SECRET',
      'rm -rf "$FAKE_SECRET"',
      'rm -rf /Users/Shared/FAKE_SECRET',
      'rm -rf / FAKE_SECRET',
      'printf FAKE_SECRET > ~/.codex/config.toml',
      'printf FAKE_SECRET > /Users/Shared',
      'sudo FAKE_SECRET',
      'security find-generic-password -w -s FAKE_SECRET',
      'pkill -f FAKE_SECRET',
      'kill -9 -1 FAKE_SECRET',
      'pgrep FAKE_SECRET | xargs kill',
      '/tmp/FAKE_SECRET/claude -p FAKE_SECRET',
      'twin-agent-FAKE_SECRET run',
      ['git', 'push', 'origin', 'FAKE_SECRET'].join(' '),
      `git --git-dir="$FAKE_SECRET" --work-tree=. ${reset}`,
      'git config --global user.name FAKE_SECRET',
      'git branch -D release-FAKE_SECRET',
      'git update-ref refs/heads/release-FAKE_SECRET HEAD',
      'git update-ref -d refs/heads/release-FAKE_SECRET',
      'git branch -f refs/heads/release-FAKE_SECRET HEAD',
      'git checkout -B release-FAKE_SECRET',
      'git switch --force-create release-FAKE_SECRET',
      'git rebase main release-FAKE_SECRET',
      'git push origin HEAD:refs/heads/release-FAKE_SECRET',
      'git push origin :refs/heads/release-FAKE_SECRET',
      'git branch -D FAKE_SECRET',
    ];
    for (const command of commands) {
      const out = sh(command);
      expect(out, command).toMatch(/^已拦截：.+。原因：.+。可以：.+。$/);
      expect(out, command).not.toContain('FAKE_SECRET');
    }
    for (const command of [
      'printf FAKE_SECRET > local',
      'git commit -m FAKE_SECRET',
      'git FAKE_SECRET',
    ]) {
      const out = sh(command, { reviewer: true });
      expect(out).toContain('reviewer 只读');
      expect(out).not.toContain('FAKE_SECRET');
    }
    const { guard } = setup();
    for (const payload of [
      { tool_name: 'mcp__claude__FAKE_SECRET', tool_input: { prompt: 'FAKE_SECRET' } },
      { tool_name: 'Read', tool_input: { file_path: '/_private/FAKE_SECRET' } },
    ]) {
      const out = guard('claude', payload, { SUPERAGENT_ROLE: 'worker' });
      expect(reason(out)).toMatch(/^已拦截：/);
      expect(JSON.stringify(out)).not.toContain('FAKE_SECRET');
    }
  });
  test('R1-10 mktemp generated paths allow scoped writes without trusting arbitrary substitution', () => {
    const sh = box();
    for (const command of [
      'd=$(mktemp -d /tmp/rv-c2.XXXXXX); printf ok > "$d/result"',
      'd=$(mktemp -d); tee "$d/result"',
      'd=$(mktemp -t baseline); printf ok > "$d/result"',
      'd=$(mktemp -dt rv-c3); printf ok > "$d/result"',
      'd=$(mktemp -td baseline); printf ok > "$d/result"',
      'd=$(mktemp -d -t baseline); printf ok > "$d/result"',
      'd=$(mktemp -p "$TMPDIR" x.XXXX); printf ok > "$d/result"',
      'd=$(mktemp --tmpdir=/tmp -d); printf ok > "$d/result"',
      'd=$(mktemp --tmpdir -d x.XXXX); printf ok > "$d/result"',
      'd=$(mktemp -p /tmp -d x.XXXX); printf ok > "$d/result"',
      'd=$(mktemp -dp/tmp x.XXXX); printf ok > "$d/result"',
      'd=$(mktemp -d "$TMPDIR/baseline.XXXXXX"); cp input "$d/result"',
      'f=$(mktemp); printf ok > "$f"',
      `d=$(mktemp -d); sh -c 'printf ok > "$1/result"' sh "$d"`,
      'd=$(mktemp -d /tmp/other.XXXXXX); rm -rf "$d"',
      'TMPDIR=/tmp; d=$(mktemp -d); printf ok > "$d/result"',
    ])
      expect(sh(command), command).toBeNull();
    for (const command of [
      'd=$(mktemp -d /foreign/rv-c2.XXXXXX); printf ok > "$d/result"',
      'd=$(mktemp -p /foreign -d x.XXXX); printf ok > "$d/result"',
      'd=$(mktemp --tmpdir=/foreign -d); printf ok > "$d/result"',
      'd=$(mktemp -dt "$UNKNOWN"); printf ok > "$d/result"',
      'd=$(mktemp -p /tmp ../foreign/x.XXXX); printf ok > "$d/result"',
      'd=$(echo /tmp/fake); printf ok > "$d/result"',
      'd=$(mktemp -d "$UNKNOWN/x.XXXXXX"); printf ok > "$d/result"',
      'd=$(mktemp -d /tmp/x.XXXXXX); printf ok > "$d/../../etc/x"',
      'TMPDIR=/foreign; d=$(mktemp -d); printf ok > "$d/result"',
      'd=$(TMPDIR=/foreign mktemp -d); printf ok > "$d/result"',
    ])
      expect(sh(command), command).toMatch(/^已拦截：/);
    const baseline =
      'rtk proxy bash -c \'baseline_dir=$(mktemp -d /tmp/mac-presets-baseline.XXXXXX); git archive HEAD app/src-tauri | tar -x -C "$baseline_dir"; cargo test --manifest-path "$baseline_dir/app/src-tauri/Cargo.toml" --lib --locked > /tmp/mac-presets-baseline-cargo.log 2>&1; result=$?; tail -n 10 /tmp/mac-presets-baseline-cargo.log; exit "$result"\'';
    expect(sh(baseline)).toBeNull();
  });
  test('FIXC4 temporary files and Git locators share task ownership', () => {
    const sh = box();
    const hard = ['reset', '--hard'].join(' '),
      clean = ['clean', '-fdx'].join(' ');
    for (const command of [
      'tmp=$(mktemp -d /tmp/xp.XXXXXX) && cd "$tmp" && git init -q',
      'tmp=$(mktemp -d /tmp/xp.XXXXXX) && git -C "$tmp" init -q',
      'tmp=$(mktemp -d) && cd "$tmp" && git commit -qm x',
      'git -C "$(mktemp -d)" init',
      'git -C "$UNKNOWN" init -q',
      'git -C /foreign init -q',
      `tmp=$(mktemp -d) && cd "$tmp" && git init -q && echo a > a.txt && git add a.txt && git commit -qm x && git ${hard} HEAD`,
      `tmp=$(mktemp -d) && mkdir "$tmp/repo" && cd "$tmp/repo" && echo a > a.txt && git add a.txt && git ${hard} HEAD && git ${clean}`,
      `tmp=$(mktemp -d) && git -C "$tmp" add a.txt && git -C "$tmp" commit -qm x && git -C "$tmp" ${hard}`,
      `tmp=$(mktemp -d) && git --git-dir="$tmp/.git" --work-tree="$tmp" ${hard}`,
      `tmp=$(mktemp -d) && GIT_DIR="$tmp/.git" GIT_WORK_TREE="$tmp" git ${hard}`,
      `tmp=$(mktemp -d); GIT_DIR="$tmp/.git"; GIT_WORK_TREE="$tmp"; git ${hard}`,
      `tmp=$(mktemp -d) && cd "$tmp" && git --git-dir=.git --work-tree=. ${hard}`,
      `tmp=$(mktemp -d) && git -C"$tmp" --git-dir=.git --work-tree=. ${hard}`,
      `tmp=$(mktemp -d) && sh -c 'cd "$1" && git ${hard}' sh "$tmp"`,
      'tmp=$(mktemp -d) && git -C "$tmp" config user.name test',
    ])
      expect(sh(command), command).toBeNull();
    for (const command of [
      `git -C /foreign ${hard}`,
      ['GIT_DIR="$UNKNOWN"', 'git', 'push', '--force'].join(' '),
      `git -C "$UNKNOWN" ${clean}`,
      `tmp=$(mktemp -d) && git -C "$tmp" --git-dir="$UNKNOWN" ${hard}`,
      `tmp=$(mktemp -d) && git -C "$tmp" --work-tree=/foreign ${clean}`,
      `tmp=$(mktemp -d) && git -C "$tmp/.." ${hard}`,
      `tmp=$(mktemp -d) && GIT_DIR="$tmp/.git"; GIT_WORK_TREE="$tmp"; git ${hard}`,
      `tmp=$(echo /tmp/fake) && cd "$tmp" && git ${hard}`,
      `git -C "${gitRepo(tmp())}" ${hard}`,
    ])
      expect(sh(command), command).toMatch(/^已拦截：/);
  });
  test('FIXC5 Git ownership follows checkout identity, including nested metadata', () => {
    const root = tmp(),
      repo = gitRepo(root),
      clone = join(repo, 'clone'),
      worktree = join(repo, '.context', 'wt-other'),
      submodule = join(repo, 'submodule'),
      subMetadata = join(repo, '.git', 'modules', 'submodule');
    mkdirSync(join(repo, '.context'), { recursive: true });
    mkdirSync(join(repo, '.git', 'modules'), { recursive: true });
    for (const argv of [
      ['git', 'clone', '-q', repo, clone],
      ['git', '-C', repo, 'worktree', 'add', '-q', '-b', 'fixc5', worktree],
      ['git', 'init', '-q', '--separate-git-dir', subMetadata, submodule],
    ])
      expect(Bun.spawnSync(argv).exitCode, argv.join(' ')).toBe(0);
    const check = (shell: string, checkout = repo, cwd = checkout) =>
      redline.reason({
        client: 'claude',
        name: 'Bash',
        cwd,
        root: checkout,
        derived: true,
        shell,
        env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') },
      });
    const hard = ['reset', '--hard'].join(' '),
      clean = ['clean', '-fdx'].join(' ');
    for (const nested of [clone, worktree, submodule]) {
      for (const command of [hard, clean]) {
        expect(check(`git -C "${nested}" ${command}`)).toMatch(/^已拦截：/);
        expect(check(`cd "${nested}" && git ${command}`)).toMatch(/^已拦截：/);
      }
      expect(check(`git -C "${nested}" commit -qm x`)).toBeNull();
      expect(check(`cd "${nested}" && git commit -qm x`)).toBeNull();
      const marker = join(nested, '.git');
      const metadata = nested === clone ? marker : readFileSync(marker, 'utf8').trim().slice(8);
      expect(check(`git --git-dir="${metadata}" --work-tree=. ${hard}`)).toMatch(/^已拦截：/);
      expect(check(`GIT_DIR="${metadata}" git commit -qm x`)).toBeNull();
      for (const prefix of ['git', `git --git-dir="${marker}"`, `git --git-dir="${metadata}"`]) {
        expect(check(`${prefix} ${hard}`, nested), prefix).toBeNull();
        expect(check(`${prefix} commit -qm x`, nested), prefix).toBeNull();
      }
    }
    for (const command of ['status --short', hard, 'commit -qm x']) {
      expect(check(`git ${command}`)).toBeNull();
      expect(check(`git --git-dir=.git --work-tree=. ${command}`)).toBeNull();
    }
    mkdirSync(join(repo, 'src'));
    expect(check(`git ${hard}`, repo, join(repo, 'src'))).toBeNull();
    expect(check(`git --git-dir="${join(repo, '.git')}" ${hard}`, worktree)).toMatch(/^已拦截：/);
    expect(check(`git -C "${gitRepo(tmp())}" ${hard}`)).toMatch(/^已拦截：/);
    expect(check(`git -C /foreign ${hard}`)).toMatch(/^已拦截：/);
    expect(check('echo ok > src/result')).toBeNull();
    expect(
      check('tmp=$(mktemp -d); cd "$tmp"; git init -q; git add a; git commit -qm x; git ' + hard)
    ).toBeNull();
  });
  test('FIXC6 foreign and unknown Git targets allow additive writes for both identities', () => {
    const root = tmp(),
      repo = gitRepo(root),
      foreign = gitRepo(tmp());
    for (const derived of [false, true]) {
      const check = (shell: string) =>
        redline.reason({
          client: 'claude',
          name: 'Bash',
          cwd: repo,
          root: repo,
          derived,
          shell,
          env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') },
        });
      expect(check(`cd "${foreign}" && git fetch -q origin`)).toBeNull();
      for (const prefix of [
        `git -C "${foreign}"`,
        'git -C "$UNKNOWN"',
        'git --git-dir="$META" --work-tree=.',
        'cd "$WHERE"; git',
      ]) {
        for (const operation of [
          'fetch',
          'add .',
          'commit -m x',
          'checkout -b t',
          'switch -c t',
          'branch t',
          'branch -c old new',
          'tag t',
          'tag -a t -m x',
          'init',
          'clone source target',
          'stash push -m x',
          'stash apply',
          'merge t',
          'pull origin t',
          'cherry-pick HEAD',
          'revert HEAD',
        ])
          expect(check(`${prefix} ${operation}`), `${derived}: ${prefix} ${operation}`).toBeNull();
        for (const operation of [
          'reset --hard',
          'reset --mixed',
          'reset --soft HEAD~1',
          'clean -fdx',
          'checkout -- file',
          'checkout other',
          'checkout -b t --force',
          'checkout -B t',
          'switch --discard-changes other',
          'branch -D t',
          'branch -m old new',
          'branch -C old new',
          'branch -f t HEAD',
          'tag -d t',
          'tag -f t',
          'commit --amend -m x',
          'push --force',
          'push origin t',
          'update-ref -d refs/heads/t',
          'update-ref refs/heads/t HEAD',
          'rebase other',
          'stash drop',
          'stash clear',
          'fetch --prune',
          'fetch -f origin',
          'fetch origin +HEAD:refs/heads/t',
          'restore --staged file',
          'merge --abort',
          'cherry-pick --abort',
          'revert --abort',
        ])
          expect(check(`${prefix} ${operation}`), `${derived}: ${prefix} ${operation}`).toMatch(
            /^已拦截：/
          );
      }
    }
  });
});

describe('FIXC RV-C 机制回归', () => {
  const probes = [
    ['R1-01 overwrite', 'echo x > "$UNKNOWN"'],
    ['R1-02 eval cwd', "eval 'cd /Users/Shared'; rm -rf victim"],
    ['R1-02 negated cwd', '! cd /Users/Shared || rm -rf victim'],
    ['R1-03 heredoc expansion', 'cat <<EOF\n$(npm publish)\nEOF'],
    ['R1-04 find execdir', 'find . -execdir codex exec x \\;'],
    [
      'R1-05 git object',
      ['git', '--git-dir=/foreign/.git', '--work-tree=/foreign', 'reset', '--hard'].join(' '),
    ],
    ['R1-06 git config', 'git config --global core.hooksPath /tmp/empty'],
    ['R1-07 pid provenance', 'pgrep node | xargs kill -TERM 41418'],
    ['R1-08 option spelling', 'curl --request=DELETE https://example.com/item'],
    [
      'R1-09 secret redaction',
      'curl -H "Authorization: Bearer FAKE_SECRET" -d "{}" https://example.com',
    ],
  ];
  test.each(probes)('探针 %s', (_id, command) => {
    const { guard } = setup();
    for (const client of ['claude', 'codex']) {
      const payload =
        client === 'claude'
          ? bash(command)
          : { tool_name: 'exec_command', tool_input: { cmd: command } };
      const out = guard(client, payload, { SUPERAGENT_ROLE: 'worker' });
      expect(reason(out)).toMatch(/^已拦截：.+。原因：.+。可以：.+。$/);
      expect(JSON.stringify(out)).not.toContain('FAKE_SECRET');
    }
  });
  test('R1-07 fallback retains known process query provenance without parser', () => {
    const { guard } = setup(hooksWith({}));
    const out = guard('claude', bash('pgrep worker | xargs kill -TERM 41418'), {
      SUPERAGENT_ROLE: 'worker',
    });
    expect(reason(out)).toContain('按端口或名称查询结果');
  });
  const variants = [
    [
      'R1-01 overwrite variants',
      ['echo x >| "$DEST"', 'tee "$DEST"', 'cd "$WHERE"; strange_tool > output'],
    ],
    [
      'R1-02 parent scope variants',
      [
        "eval 'cd /Users/Shared' && rm -rf other",
        '! cd /Users/Shared; rm -rf other',
        '! cd /Users/Shared || truncate -s 0 "$UNKNOWN"',
      ],
    ],
    [
      'R1-03 expansion variants',
      [
        'cat <<-END\n\t`codex exec other`\n\tEND',
        'cat <<END\n$(pnpm publish)\nEND',
        "cat <<END\n'$(npm publish)'\nEND",
      ],
    ],
    [
      'R1-04 find body variants',
      [
        'find . -okdir pnpm publish \\;',
        'find . -execdir rm -rf relative \\;',
        'find . -ok codex exec other \\;',
        'find . -exec npm publish \\;',
      ],
    ],
    [
      'R1-05 git location variants',
      [
        ['git', '-C', '/foreign', 'reset', '--hard'].join(' '),
        ['git', '--git-dir', '/foreign/.git', '--work-tree', '/foreign', 'clean', '-fd'].join(' '),
        ['env', 'GIT_DIR=/foreign/.git', 'git', 'reset', '--hard'].join(' '),
        ['GIT_DIR=/foreign/.git', 'git', 'reset', '--hard'].join(' '),
        ['GIT_DIR=/foreign/.git;', 'git', 'reset', '--hard'].join(' '),
        ['git', '--work-tree=$TREE', 'reset', '--hard'].join(' '),
      ],
    ],
    [
      'R1-06 config variants',
      [
        'git config --system user.name changed',
        'git config core.hooksPath /tmp/empty',
        'git config --file=$CFG core.hooksPath /tmp/empty',
        'cd "$WHERE"; git config core.hooksPath /tmp/empty',
      ],
    ],
    [
      'R1-07 selection variants',
      [
        'kill -TERM 41418 $(pidof server)',
        'pgrep -f worker | xargs -n 2 kill -KILL 41418',
        'pid=$(pgrep server); kill -TERM "$pid"',
      ],
    ],
    [
      'R1-08 HTTP option variants',
      [
        'curl --request DELETE https://example.org/other',
        'curl --request=PATCH https://example.org/other',
      ],
    ],
  ];
  test.each(variants)('%s', (_id, commands) => {
    const { guard } = setup();
    for (const command of commands)
      expect(
        reason(guard('claude', bash(command), { SUPERAGENT_ROLE: 'worker' })),
        command
      ).toMatch(/^已拦截：/);
  });
  test('R1-09 only action and host survive external write reminders', () => {
    const { guard } = setup();
    for (const command of [
      'curl --user user:FAKE_SECRET --data=PRIVATE_BODY https://example.org/private?token=QUERY_SECRET',
      'curl --header="Authorization: Bearer FAKE_SECRET" --request=POST https://user:PASS_SECRET@example.org/private',
    ]) {
      const out = guard('claude', bash(command), { SUPERAGENT_ROLE: 'worker' });
      expect(reason(out)).toContain('example.org');
      expect(JSON.stringify(out)).not.toMatch(
        /FAKE_SECRET|PRIVATE_BODY|QUERY_SECRET|PASS_SECRET|Authorization|\/private/
      );
    }
  });
  test('mechanism controls retain ordinary execution and parent/child cwd distinctions', () => {
    const { guard, repo } = setup();
    const worker = { SUPERAGENT_ROLE: 'worker' };
    for (const command of [
      "cat <<'END'\n$(npm publish) `codex exec data`\nEND",
      'cat <<END\n$(git status --short)\nEND',
      'cat <<END\n\\$(npm publish)\nEND',
      'find . -execdir echo safe \\;',
      'find . -okdir git status --short \\;',
      `eval 'cd ${repo}' && echo x > local`,
      '! cd /Users/Shared && rm -rf local',
      'sh -c "cd /Users/Shared"; rm -rf local',
      'echo x >> "$UNKNOWN"',
      'tee --append "$UNKNOWN"',
      'curl --request=GET https://example.org/read',
      'git --work-tree=. status --short',
      'git config --global --get core.hooksPath',
      'env GIT_DIR=/foreign/.git git status; git status --short',
      'kill -TERM 41418',
      'pgrep server; kill -TERM 41418',
    ])
      expect(reason(guard('claude', bash(command), worker)), command).toBeUndefined();
    expect(
      reason(
        guard('claude', bash(['git', 'reset', '--hard'].join(' ')), {
          ...worker,
          GIT_DIR: '/foreign/.git',
        })
      )
    ).toMatch(/^已拦截：/);
  });
});

// A copy of hooks/ next to a tiers.json with the given policy overrides.
function hooksWith(policy: Record<string, unknown>): string {
  const root = tmp();
  cpSync(HOOKS, join(root, 'hooks'), { recursive: true });
  const tiers = JSON.parse(readFileSync(join(HOOKS, '..', 'tiers.json'), 'utf8')) as {
    policy: Record<string, unknown>;
  };
  writeFileSync(
    join(root, 'tiers.json'),
    JSON.stringify({ ...tiers, policy: { ...tiers.policy, ...policy } })
  );
  return join(root, 'hooks');
}

function setup(hooks = HOOKS): {
  home: string;
  repo: string;
  guard: (client: string, p: object, env?: Record<string, string>) => Out;
} {
  const root = tmp();
  const home = join(root, 'sa');
  const repo = gitRepo(root);
  writeFileSync(join(repo, 'a.ts'), 'old\n');
  let n = 0;
  const guard = (client: string, p: object, env: Record<string, string> = {}): Out =>
    run(
      'guard.cjs',
      client,
      { hook_event_name: 'PreToolUse', session_id: `s${String(++n)}`, cwd: repo, ...p },
      {
        SUPERAGENT_HOME: home,
        ...env,
      },
      hooks
    );
  return { home, repo, guard };
}
const lines = (k: number): string =>
  Array.from({ length: k }, (_, i) => `n${String(i)}`).join('\n');
const edit = (repo: string, k: number): object => ({
  tool_name: 'Edit',
  tool_input: { file_path: join(repo, 'a.ts'), old_string: 'old', new_string: lines(k) },
});
const bash = (command: string): object => ({ tool_name: 'Bash', tool_input: { command } });

describe('guard.cjs', () => {
  test('G-1：元帅 Edit 31 行被拦、29 行放行、ALLOW 放行', () => {
    const { repo, guard } = setup();
    expect(reason(guard('claude', edit(repo, 31)))).toContain('G-1: 累计 31 行 > 30 行');
    expect(guard('claude', edit(repo, 29))).toBeNull();
    expect(guard('claude', edit(repo, 31), { SUPERAGENT_ALLOW_COMMANDER_WRITE: '1' })).toBeNull();
  });

  test('G-1：同一会话累计计量', () => {
    const { repo, guard } = setup();
    const p = { ...edit(repo, 20), session_id: 'same' };
    expect(guard('claude', p)).toBeNull();
    expect(reason(guard('claude', p))).toContain('累计 40 行');
  });

  test('N-1：三种派生判定各拦一次再派生', () => {
    const { home, guard } = setup();
    const ws = join(home, 'archon', 'workspaces', 'w1');
    mkdirSync(ws, { recursive: true });
    const worker = { SUPERAGENT_ROLE: 'worker' };
    expect(
      reason(guard('claude', { tool_name: 'Agent', tool_input: { prompt: 'x' } }, worker))
    ).toContain('派生会话');
    expect(
      reason(
        guard(
          'claude',
          { tool_name: 'Task', tool_input: { prompt: 'x' } },
          { AI_DISPATCH_ROLE: 'general' }
        )
      )
    ).toContain('派生会话');
    expect(
      reason(
        guard('claude', bash('/opt/bin/codex exec -s read-only x'), { TWIN_AGENT_REMOTE: '1' })
      )
    ).toContain('codex');
    expect(
      reason(guard('claude', { ...bash('cd x && bash -c "claude -p hi"'), cwd: ws }))
    ).toContain('claude');
    expect(
      reason(
        guard('codex', {
          tool_name: 'spawn_agent',
          tool_input: { message: 'x', fork_turns: 'none' },
          cwd: ws,
        })
      )
    ).toContain('派生会话');
    expect(
      reason(
        guard(
          'codex',
          { tool_name: 'exec_command', tool_input: { cmd: 'ls | twin-agent-run q' } },
          worker
        )
      )
    ).toContain('twin-agent');
    expect(guard('claude', bash('ls && git status'), worker)).toBeNull();
  });

  test('A-08: child metadata and derivedBy agree; commander model keeps its root behavior', () => {
    const { guard } = setup();
    const spawn = { tool_name: 'spawn_agent', tool_input: { message: 'x', fork_turns: 'none' } };
    expect(reason(guard('codex', { ...spawn, model: 'gpt-6.1-sol' }))).toContain('派生会话');
    expect(guard('codex', { ...spawn, model: 'gpt-6-astra' })).toBeNull();
    const child = { ...spawn, model: 'gpt-6.1-sol', agent_type: 'x', agent_id: 'y' };
    const identity = createRequire(import.meta.url)('../hooks/guard.cjs') as {
      derivedBy: (p: object, c: string, env: object) => string | null;
      isChild: (p: object) => boolean;
    };
    expect(identity.isChild(child)).toBe(true);
    expect(identity.derivedBy(child, 'codex', {})).toBe('child metadata');
    expect(reason(guard('codex', child))).toContain('派生会话');
    expect(
      reason(guard('claude', { tool_name: 'Agent', agent_type: 'coder-1', agent_id: 'child' }))
    ).toContain('派生会话');
    expect(
      guard('codex', { ...spawn, model: 'gpt-6-astra', agent_type: ' ', agent_id: 'x' })
    ).toBeNull();
  });

  test('元帅会话 Agent 放行；G-2 仍生效', () => {
    const { guard } = setup();
    expect(
      guard('claude', { tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'coder-1' } })
    ).toBeNull();
    expect(
      reason(
        guard('claude', { tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'fork' } })
      )
    ).toContain('G-2');
  });

  test('git：stash push 放行，push/force/reset --hard 被拦', () => {
    const { guard } = setup();
    expect(guard('claude', bash('git stash push -m wip'))).toBeNull();
    expect(reason(guard('claude', bash('git push origin wetamp')))).toContain('git push');
    expect(
      reason(
        guard('codex', {
          tool_name: 'exec_command',
          tool_input: { cmd: 'git -C /x -c a=b push --force' },
        })
      )
    ).toContain('git push');
    expect(
      reason(guard('claude', bash(['git', '-C', '/x', 'reset', '--hard', 'HEAD~1'].join(' '))))
    ).toContain('非本任务');
  });

  test('删除目标拦截与 reviewer 只读', () => {
    const { home, repo, guard } = setup();
    expect(reason(guard('claude', bash(`rm -rf ${home}`)))).toContain('受保护目录');
    expect(reason(guard('claude', bash(`rm -rf ${repo}`)))).toContain('受保护目录');
    const ownDeletion = guard('claude', bash(`rm -rf ${join(repo, 'build')}`));
    expect(reason(ownDeletion)).toBeUndefined();
    expect(ownDeletion?.systemMessage).toContain('advisory');
    expect(reason(guard('claude', edit(repo, 1), { SUPERAGENT_ROLE: 'reviewer' }))).toContain(
      'reviewer 只读'
    );
  });

  test('Stop 在 stop_gate=off 时静默', () => {
    const { guard } = setup();
    expect(guard('claude', { hook_event_name: 'Stop' })).toBeNull();
  });

  test('N-1：包装器按参数语义剥离；单引号字面量不算执行', () => {
    const { guard } = setup();
    const worker = { SUPERAGENT_ROLE: 'worker' };
    for (const cmd of [
      'echo x | xargs -n1 claude -p',
      'env -u FOO claude -p x',
      'env X=1 codex exec x',
      'nohup claude -p x &',
      'nice -n 5 claude -p x',
      'caffeinate -i claude -p x',
      'timeout 5 sol-run x',
      'find . -name a -exec codex exec {} \\;',
    ])
      expect(reason(guard('claude', bash(cmd), worker)), cmd).toContain('派生会话');
    for (const cmd of [
      'time -p claude -p x',
      'echo "$(claude -p x)"',
      'command claude -p x',
      'exec -a name codex exec x',
      'env -S "claude -p x"',
    ])
      expect(reason(guard('claude', bash(cmd), worker)), cmd).toContain('派生会话');
    for (const cmd of ["echo '$(claude -p x)'", 'grep -r claude .', 'command -v claude'])
      expect(guard('claude', bash(cmd), worker), cmd).toBeNull();
  });

  test('reviewer：允许执行和临时写入，拒绝修改被审仓库', () => {
    const { guard } = setup();
    const reviewer = { SUPERAGENT_ROLE: 'reviewer' };
    for (const cmd of [
      'git diff HEAD~1 -- a.ts | head -50',
      'rg -n foo src 2>/dev/null',
      "sed -n '1,20p' a.ts",
      'cat a.ts && git log --oneline -5 && ls -la',
      'git branch -a',
    ])
      expect(guard('claude', bash(cmd), reviewer), cmd).toBeNull();
    for (const cmd of [
      'echo x > a.ts',
      'echo x >> a.ts',
      'cat a.ts | tee b.ts',
      "sed -i 's/a/b/' a.ts",
      'cp a.ts b.ts',
      'mv a.ts b.ts',
      'rm a.ts',
      'mkdir d',
      'touch b.ts',
      'git commit -m x',
      'git add a.ts',
      'git checkout -- a.ts',
      'git stash',
      'git branch --list --delete other',
      'git tag changed',
      'git remote add other https://example.com/repo',
      'sort -o a.ts a.ts',
      'find . -delete',
    ])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toContain('reviewer 只读');
    expect(reason(guard('claude', bash('echo ~[x]'), reviewer))).toBeUndefined();
    expect(reason(guard('claude', bash('python3 -c "print(1)"'), reviewer))).toBeUndefined();
    expect(reason(guard('claude', bash('bun test > /tmp/reviewer.log'), reviewer))).toBeUndefined();
    expect(
      reason(
        guard('codex', { tool_name: 'exec_command', tool_input: { cmd: 'touch x' } }, reviewer)
      )
    ).toContain('reviewer 只读');
  });

  test('MK：reviewer 按写入路径允许临时产物与隔离校验', () => {
    const { guard, repo } = setup();
    const reviewer = { SUPERAGENT_ROLE: 'reviewer', TMPDIR: '/tmp' };
    for (const cmd of [
      'mktemp',
      'mktemp -d',
      'mktemp -u ./src/x.XXXXXX',
      't=$(mktemp -d); echo x > $t/a',
      't=$(mktemp -d); SUPERAGENT_HOME=$t/sa bun test x.test.ts',
      't=$(mktemp -d); env SUPERAGENT_HOME=$t/sa bun x tsc --noEmit',
      'echo x > "$TMPDIR/a"',
      'echo x > "${TMPDIR}/a"',
      'TMPDIR=/tmp; echo x > "$TMPDIR/a"',
      'echo x > /tmp/mk-result',
      'echo x > /private/var/folders/mk-result',
    ])
      expect(guard('claude', bash(cmd), reviewer), cmd).toBeNull();
    for (const cmd of [
      'echo x > ./src/a.ts',
      'TMPDIR=.; echo x > "$TMPDIR/a"',
      'mktemp -d ./src/x.XXXXXX',
      't=$(mktemp -d); echo x > "$t/../../etc/mk-result"',
      'echo x > ~/.superagent/mk-result',
      'git add src/a.ts',
    ])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toMatch(/^已拦截：/);
    expect(reason(guard('claude', bash('echo x > ./src/a.ts'), reviewer))).toContain(
      join(repo, 'src/a.ts')
    );
  });

  test('动态 cwd 不隐藏明确危险；未知覆盖拒绝、普通新建留 advisory', () => {
    const { guard } = setup();
    const worker = { SUPERAGENT_ROLE: 'worker' };
    for (const cmd of [
      'cd "$UNKNOWN" && sudo true',
      'cd "$UNKNOWN"; rm -rf relative',
      'env -C "$UNKNOWN" npm publish',
      'case x in x) sudo true;; esac',
      'lsof -ti:3000 | xargs kill -9',
    ])
      expect(reason(guard('claude', bash(cmd), worker)), cmd).toMatch(/^已拦截：/);
    expect(reason(guard('claude', bash('cd "$UNKNOWN" && echo x > relative'), worker))).toMatch(
      /^已拦截：/
    );
    const result = guard('claude', bash('cd "$UNKNOWN" && touch relative'), worker);
    expect(reason(result)).toBeUndefined();
    expect(result?.systemMessage).toContain('advisory');
    expect(guard('claude', bash('curl --fail https://example.com'), worker)).toBeNull();
    expect(reason(guard('claude', bash('env FOO=x git -C . status'), worker))).toBeUndefined();
  });

  test('reviewer：包装器自身的写入副作用按写入处理', () => {
    const { guard } = setup();
    const reviewer = { SUPERAGENT_ROLE: 'reviewer' };
    for (const cmd of ['nohup cat a.ts', 'script s.log cat a.ts', 'cat a.ts | tee -a b.ts'])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toContain('本任务仓库');
    for (const cmd of ['time -o out.txt cat a.ts', '/usr/bin/time --output=t.log git status'])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toContain('reviewer 只读');
    expect(reason(guard('claude', bash('env -C /tmp cat a.ts'), reviewer))).toBeUndefined();
    // script 也是包装器：其后的 claude 仍被 N-1 认出
    expect(
      reason(
        guard('claude', bash('script -q /dev/null claude -p x'), { SUPERAGENT_ROLE: 'worker' })
      )
    ).toContain('派生会话');
  });

  test('删除提醒包含目标、后果和替代动作', () => {
    const { home, guard } = setup();
    const r = reason(guard('claude', bash(`rm -rf ${home}`))) ?? '';
    expect(r).toContain('已拦截：删除目录（受保护目录）');
    expect(r).toContain('。原因：');
    expect(r).toContain('。可以：');
  });

  test('G-1：并发写入在锁内累计，30 行上限下恰好放行 3 次', async () => {
    const { home, repo } = setup();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'race',
      cwd: repo,
      ...edit(repo, 10),
    });
    const outs = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const p = Bun.spawn(['node', join(HOOKS, 'guard.cjs'), 'claude'], {
          stdin: Buffer.from(payload),
          env: { ...baseEnv, SUPERAGENT_HOME: home },
          stdout: 'pipe',
        });
        return (await new Response(p.stdout).text()).trim();
      })
    );
    expect(outs.filter(o => o === '').length).toBe(3);
  });

  test('A-07: reviewer completion cannot approve the current tree; legacy blocking modes are advisory', () => {
    for (const mode of ['change', 'cycle', 'advisory']) {
      const { repo, guard } = setup(hooksWith({ stop_gate: mode }));
      const s = (p: object): Out => guard('claude', { session_id: 'g', ...p });
      s({ hook_event_name: 'SessionStart' });
      s(edit(repo, 1));
      writeFileSync(join(repo, 'a.ts'), 'changed after review started\n');
      for (const event of [
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: 'reviewer-1' },
          tool_response: {},
        },
        { hook_event_name: 'SubagentStop', agent_type: 'reviewer-1', agent_id: 'child' },
      ])
        s(event);
      expect(s({ hook_event_name: 'Stop' })?.systemMessage).toContain('advisory');
      expect(s({ hook_event_name: 'Stop' })?.systemMessage).toContain('引擎正式 gate');
    }
  });

  test('A-09: unmetered shell writes, unknown targets and malformed edits allow with advisory', () => {
    const { repo, guard } = setup();
    for (const command of [
      'echo x > a.ts',
      'tee a.ts',
      'touch auth.ts',
      'cp NOTES.md a.ts',
      'echo x > "$TARGET"',
      'echo "unclosed',
      'sed -i s/old/new/ a.ts',
      'node -e "require(\"fs\").writeFileSync(\"a.ts\", \"x\")"',
    ]) {
      const out = guard('claude', bash(command));
      expect(reason(out), command).toBeUndefined();
      expect(out?.systemMessage, command).toContain('advisory');
    }
    expect(guard('claude', bash('echo x > NOTES.md'))).toBeNull();
    expect(guard('claude', bash('git status'))).toBeNull();
    expect(
      guard('codex', { tool_name: 'apply_patch', tool_input: { input: 'invalid' } })?.systemMessage
    ).toContain('advisory');
    expect(
      guard('claude', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.ts') } })
        ?.systemMessage
    ).toContain('advisory');
    expect(
      guard('claude', { ...edit(repo, 1), session_id: '', transcript_path: '' })?.systemMessage
    ).toContain('advisory');
    expect(guard('claude', { tool_name: 'Bash', tool_input: {} })?.systemMessage).toContain(
      'advisory'
    );
  });

  test('A-09: corrupt quota state and internal exceptions allow with advisory without resetting state', () => {
    const { home, repo, guard } = setup();
    const file = join(home, 'hooks', `${createHash('sha256').update('bad').digest('hex')}.json`);
    mkdirSync(join(home, 'hooks'), { recursive: true });
    for (const raw of [
      '{broken',
      JSON.stringify({ micro: { lines: 'NaN', files: [], risk: [], newCode: [] } }),
    ]) {
      writeFileSync(file, raw);
      expect(guard('claude', { ...edit(repo, 1), session_id: 'bad' })?.systemMessage).toContain(
        'advisory'
      );
      expect(readFileSync(file, 'utf8')).toBe(raw);
    }
    const p = Bun.spawnSync(['node', join(HOOKS, 'guard.cjs'), 'claude'], {
      stdin: Buffer.from('null'),
      env: { ...baseEnv, SUPERAGENT_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    const out = JSON.parse(p.stdout.toString()) as Out;
    expect(reason(out)).toBeUndefined();
    expect(out?.systemMessage).toContain('advisory');
    expect(out?.systemMessage).toContain('内部异常');
  });

  test('A-11: duplicate native event IDs consume G-1 exactly once; new IDs still accumulate', () => {
    const { repo, guard } = setup();
    const p = { ...edit(repo, 20), session_id: 'dedup', tool_use_id: 'event-1' };
    expect(guard('claude', p)).toBeNull();
    expect(guard('claude', p)).toBeNull();
    expect(reason(guard('claude', { ...p, tool_use_id: 'event-2' }))).toContain('累计 40 行');
    expect(reason(guard('claude', { ...p, tool_use_id: 'event-2' }))).toContain('累计 40 行');
  });

  test('G-3：advisory 只提示；无效取值给出配置提示而不报错', () => {
    const adv = setup(hooksWith({ stop_gate: 'advisory' }));
    adv.guard('claude', { session_id: 'a', hook_event_name: 'SessionStart' });
    writeFileSync(join(adv.repo, 'a.ts'), 'changed\n');
    expect(
      adv.guard('claude', { session_id: 'a', hook_event_name: 'Stop' })?.systemMessage
    ).toContain('advisory');
    const bad = setup(hooksWith({ stop_gate: 'strict' }));
    expect(bad.guard('claude', { hook_event_name: 'Stop' })?.systemMessage).toContain(
      'stop_gate=strict 无效'
    );
  });
});

describe('context-advisory.cjs', () => {
  function budget(
    tokens: number,
    env: Record<string, string>,
    extra: object = {},
    session = 's'
  ): Out {
    const root = tmp();
    const transcript = join(root, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ message: { usage: { input_tokens: tokens } } }) + '\n'
    );
    return run(
      'context-advisory.cjs',
      'claude',
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        transcript_path: transcript,
        cwd: root,
        ...extra,
      },
      { SUPERAGENT_HOME: join(root, 'sa'), ...env }
    );
  }
  const advised = (o: Out): boolean =>
    o?.hookSpecificOutput?.additionalContext?.includes('上下文约') ?? false;

  test('三档阈值：commander 160K / general 240K / strategist 360K', () => {
    expect(advised(budget(170_000, {}))).toBe(true);
    expect(advised(budget(170_000, { SUPERAGENT_ROLE: 'worker' }))).toBe(false);
    expect(advised(budget(250_000, { SUPERAGENT_ROLE: 'worker' }))).toBe(true);
    expect(advised(budget(250_000, { SUPERAGENT_ROLE: 'reviewer' }))).toBe(false);
    expect(advised(budget(370_000, { SUPERAGENT_ROLE: 'reviewer' }))).toBe(true);
  });

  test('活动 run（V2 ledger + archon.db）内第 16 次非 superagent 调用提醒一次', () => {
    const root = tmp();
    const home = join(root, 'sa');
    mkdirSync(join(home, 'runs'), { recursive: true });
    mkdirSync(join(home, 'archon'), { recursive: true });
    writeFileSync(
      join(home, 'runs', 'r1.json'),
      JSON.stringify({ run_id: 'r1', archon_run_id: 'a1' })
    );
    const db = new Database(join(home, 'archon', 'archon.db'));
    db.run('create table remote_agent_workflow_runs (id text primary key, status text)');
    db.run("insert into remote_agent_workflow_runs values ('a1','paused')");
    db.close();
    const transcript = join(root, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ message: { usage: { input_tokens: 1000 } } }) + '\n'
    );
    const call = (command: string): Out =>
      run(
        'context-advisory.cjs',
        'claude',
        {
          hook_event_name: 'PreToolUse',
          session_id: 'x',
          transcript_path: transcript,
          tool_name: 'Bash',
          tool_input: { command },
        },
        { SUPERAGENT_HOME: home }
      );
    for (let i = 0; i < 16; i++) expect(call(i === 0 ? 'superagent wait r1' : 'ls')).toBeNull();
    expect(call('ls')?.hookSpecificOutput?.additionalContext).toContain('超过 15 次');
    expect(call('ls')).toBeNull();
  });
  test('F-12/A-11: concurrent context hooks keep every distinct event and deduplicate repeated IDs', async () => {
    const root = tmp(),
      home = join(root, 'sa'),
      transcript = join(root, 't.jsonl');
    mkdirSync(join(home, 'runs'), { recursive: true });
    mkdirSync(join(home, 'archon'), { recursive: true });
    writeFileSync(join(home, 'runs/r.json'), JSON.stringify({ archon_run_id: 'r' }));
    const db = new Database(join(home, 'archon/archon.db'));
    db.run('create table remote_agent_workflow_runs (id text primary key, status text)');
    db.run("insert into remote_agent_workflow_runs values ('r','running')");
    db.close();
    writeFileSync(transcript, JSON.stringify({ usage: { input_tokens: 1000 } }));
    await Promise.all(
      Array.from({ length: 24 }, async (_, i) => {
        const p = Bun.spawn(['node', join(HOOKS, 'context-budget.cjs')], {
          stdin: Buffer.from(
            JSON.stringify({
              hook_event_name: 'PreToolUse',
              session_id: 'race',
              tool_name: 'Read',
              transcript_path: transcript,
              tool_use_id: `e${i % 20}`,
            })
          ),
          env: { ...baseEnv, SUPERAGENT_HOME: home },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
      })
    );
    const file = join(
      home,
      'hooks/context-advisory',
      `${createHash('sha256').update('race').digest('hex')}.json`
    );
    expect(JSON.parse(readFileSync(file, 'utf8')).tools).toBe(20);
  });
});

interface RedArgs {
  client: string;
  name: string;
  input?: Record<string, unknown>;
  cwd: string;
  root: string | null;
  shell?: string;
  derived: boolean;
  reviewer?: boolean;
  env: Record<string, string>;
}
const redline = createRequire(import.meta.url)('../hooks/redline.cjs') as {
  reason: (a: RedArgs) => string | null;
};

describe('redline.cjs（所有角色的执行层红线）', () => {
  test('G1: safe branch deletion passes; forced deletion and destructive branch flags still deny', () => {
    const repo = gitRepo(tmp());
    const check = (shell: string, root = repo) =>
      redline.reason({
        client: 'claude',
        name: 'Bash',
        cwd: repo,
        root,
        shell,
        derived: true,
        env: baseEnv,
      });
    for (const flag of ['-d', '--delete']) {
      for (const branch of ['merged', 'release-old']) {
        expect(check(`git branch ${flag} ${branch}`)).toBeNull();
        expect(check(`git branch ${flag} ${branch}`, '/foreign')).toBeNull();
      }
    }
    for (const flag of ['-D', '-df', '--delete --force'])
      expect(check(`git branch ${flag} merged`)).toContain('已拦截：');
    for (const flag of ['-D', '-m', '-M', '-C', '--delete --force', '-df'])
      expect(check(`git branch ${flag} old new`, '/foreign')).toContain('已拦截：');
  });
  const box = (): {
    home: string;
    repo: string;
    env: Record<string, string>;
    sh: (cmd: string, derived?: boolean) => string | null;
  } => {
    const root = tmp();
    const home = join(root, 'home');
    const repo = gitRepo(root);
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'fake');
    writeFileSync(join(home, '.netrc'), 'fake');
    const env = { HOME: home, TMPDIR: join(root, 'tmpdir') };
    return {
      home,
      repo,
      env,
      sh: (cmd, derived = false) =>
        redline.reason({
          client: 'claude',
          name: 'Bash',
          cwd: repo,
          root: repo,
          shell: cmd,
          derived,
          env,
        }),
    };
  };

  test('每条红线一对 deny/allow（Bash）', () => {
    const { sh } = box();
    const pairs: [string, string, string][] = [
      ['cat ~/.ssh/id_ed25519', 'cat ~/.ssh/id_ed25519.pub', 'ssh 私钥'],
      [
        `python3 -c "open('$HOME/.ssh/id_rsa')"`,
        'ssh-keygen -F host -f ~/.ssh/known_hosts',
        'ssh 私钥',
      ],
      ['ls ~/Library/Keychains/login.keychain-db', 'ls ~/Library/Caches', '钥匙串'],
      ['security find-generic-password -s x -w', 'security list-keychains', 'security'],
      ['security dump-keychain', 'security find-certificate -a', 'security'],
      ['cat ~/.aws/credentials', 'cat ~/.aws/config', '凭据文件'],
      ['head ${HOME}/.netrc', 'netstat -an', '凭据文件'],
      ['cat ~/.config/gh/hosts.yml', 'gh auth status', '凭据文件'],
      ['cat ~/.npmrc', 'npm install', '凭据文件'],
      ['grep x < ~/.pypirc', 'grep x < README.md', '凭据文件'],
      ['cat docs/_private/a.md', 'grep -rn _private src', '_private'],
      ['ls "$HOME/Library/Mobile Documents/x"', 'ls ~/Library/Mobile', 'iCloud'],
      [
        'cp ~/Library/Application\\ Support/Google/Chrome/Default/Cookies /tmp/c',
        'ls ~/Library/Application\\ Support/Code',
        '浏览器资料',
      ],
      ['sqlite3 ~/Library/Cookies/Cookies.binarycookies', 'sqlite3 db.sqlite', '浏览器资料'],
      ['npm publish', 'npm pack', '发布'],
      ['bun publish --dry-run', 'bun run build', '发布'],
      ['pnpm -r publish', 'pnpm -r build', '发布'],
      ['docker push img:1', 'docker build -t img:1 .', 'docker'],
      ['gh release create v1', 'gh release view v1', 'gh'],
      ['gh pr merge 12 --squash', 'gh pr view 12', 'gh'],
      ['vercel --prod', 'vercel build', 'vercel'],
      ['git branch -D release-1', 'git branch --list', '受保护分支'],
      ['git branch -f main HEAD~1', 'git branch -f topic HEAD~1', '受保护分支'],
      [
        'git update-ref refs/heads/wetamp HEAD',
        'git update-ref refs/heads/topic HEAD',
        '受保护分支',
      ],
      ['git rebase main develop', 'git rebase main topic', '受保护分支'],
      ['git -c x=y checkout -B master', 'git checkout -B topic', '受保护分支'],
      ['pkill -f node', 'kill $!', 'pkill'],
      ['killall bun', 'kill %1', 'killall'],
      ['lsof -ti :3000 | xargs kill', 'lsof -i :3000', 'kill'],
      ['kill $(pgrep node)', 'kill 12345', 'kill'],
    ];
    for (const [deny, allow, hit] of pairs) {
      expect(sh(deny), deny).toContain(hit);
      expect(sh(allow), allow).toBeNull();
    }
  });

  test('rebase 无分支参数时按当前分支判定', () => {
    const { repo, sh } = box();
    expect(sh('git rebase -i HEAD~2')).toContain('受保护分支'); // gitRepo 在 main 上
    expect(sh(`git -C ${repo} rebase --abort`)).toBeNull();
  });

  test('cd 之后的相对路径、heredoc 正文、软链与大小写', () => {
    const { home, repo, sh } = box();
    expect(sh('cd ~/.ssh && cat id_ed25519')).toContain('ssh 私钥');
    expect(sh('ls ~/.ssh')).toBeNull();
    // heredoc 正文是数据；交给 bash 执行的不是
    expect(sh("cat > notes.md <<'EOF'\npkill -f x\ngh pr merge 1\nEOF\necho ok")).toBeNull();
    expect(sh('bash <<EOF\npkill -f x\nEOF')).toContain('pkill');
    symlinkSync(join(home, '.netrc'), join(repo, 'n'));
    expect(sh('cat n')).toContain('凭据文件');
    expect(sh('cat ~/.SSH/ID_ED25519')).toContain('ssh 私钥');
  });

  test('Read/Grep/Edit 工具路径；派生会话的写入落点', () => {
    const { home, repo, env, sh } = box();
    const tool = (
      name: string,
      input: Record<string, unknown>,
      derived = false,
      client = 'claude'
    ): string | null =>
      redline.reason({ client, name, input, cwd: repo, root: repo, derived, env });
    expect(tool('Read', { file_path: join(home, '.netrc') })).toContain('凭据文件');
    expect(tool('Read', { file_path: join(repo, 'README.md') })).toBeNull();
    expect(tool('Grep', { pattern: 'x', path: '~/.ssh' })).toBeNull();
    expect(tool('Grep', { pattern: 'x', path: '~/.ssh/id_ed25519' })).toContain('ssh 私钥');
    expect(tool('Write', { file_path: join(home, '.ssh', 'config') }, true)).toContain(
      '配置或凭据'
    );
    expect(tool('Write', { file_path: join(home, '.ssh', 'authorized_keys') })).toContain(
      'ssh 私钥'
    );
    // 元帅不限落点；派生会话只能写 worktree、临时目录与缓存（测试 home 本身在临时目录下，越界用 /etc）
    const away = '/etc/sa-redline-test/x.ts';
    expect(tool('Write', { file_path: away })).toBeNull();
    expect(tool('Write', { file_path: away }, true)).toContain('系统目录');
    expect(tool('Write', { file_path: join(repo, 'src', 'new.ts') }, true)).toBeNull();
    expect(tool('Write', { file_path: '/tmp/sa-x' }, true)).toBeNull();
    expect(tool('Write', { file_path: join(home, '.cache', 'x') }, true)).toBeNull();
    const patch = (f: string): Record<string, unknown> => ({
      command: `*** Begin Patch\n*** Add File: ${f}\n+x\n*** End Patch`,
    });
    expect(tool('apply_patch', patch('a.ts'), true, 'codex')).toBeNull();
    expect(tool('apply_patch', patch(away), true, 'codex')).toContain('系统目录');
    expect(sh(`echo x > ${away}`, true)).toContain('系统目录');
    expect(sh(`echo x > ${away}`, false)).toBeNull();
    expect(sh('echo x > out.txt && cp out.txt /tmp/y && mkdir -p build', true)).toBeNull();
    expect(sh(`cp out.txt ${away}`, true)).toContain('系统目录');
    expect(sh('echo x 2>/dev/null >> ~/.cache/log', true)).toBeNull();
  });

  test('guard 对所有角色先查红线（元帅、worker、reviewer 都拒）', () => {
    const { guard } = setup();
    for (const env of [
      {},
      { SUPERAGENT_ROLE: 'worker' },
      { SUPERAGENT_ROLE: 'reviewer' },
    ] as Record<string, string>[])
      expect(reason(guard('claude', bash('git branch -D release-1'), env))).toContain('已拦截：');
    expect(
      reason(guard('codex', { tool_name: 'exec_command', tool_input: { cmd: 'npm publish' } }))
    ).toContain('已拦截：');
  });
});
