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
  superagentPermissionCategory?: string;
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
  hooks = HOOKS,
  exitCode = 0
): Out {
  const p = Bun.spawnSync(['node', join(hooks, file), client], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...baseEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.stderr.toString()).not.toContain('superagent guard:');
  expect(p.exitCode).toBe(exitCode);
  const out = p.stdout.toString().trim();
  const result = out ? (JSON.parse(out) as Out) : null;
  if (client === 'codex' && result?.systemMessage?.startsWith('superagent.permission.'))
    result.superagentPermissionCategory = result.systemMessage.slice(
      'superagent.permission.'.length
    );
  return result;
}
const reason = (o: Out): string | undefined =>
  o?.hookSpecificOutput?.permissionDecision === 'deny'
    ? o.hookSpecificOutput.permissionDecisionReason
    : undefined;

describe('REDLINE 默认放行与危险效果', () => {
  test('M5: native Move checks source loss and destination replacement independently', () => {
    const repo = gitRepo(tmp()),
      foreign = gitRepo(tmp());
    const redline = createRequire(import.meta.url)('../hooks/redline.cjs') as {
      reason: (options: object) => string | null;
    };
    for (const [source, target, denied, advisory] of [
      [join(foreign, 'README.md'), join(repo, 'new.txt'), true, false],
      [join(repo, 'README.md'), join(foreign, 'README.md'), true, false],
      [join(repo, 'README.md'), join(foreign, 'new.txt'), false, true],
      [join(repo, 'README.md'), join(repo, 'new.txt'), false, false],
    ] as const) {
      const advisories: string[] = [],
        input = {
          input: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n-hi\n+edit\n*** End Patch`,
        };
      expect(
        Boolean(
          redline.reason({
            client: 'codex',
            name: 'apply_patch',
            input,
            cwd: repo,
            root: repo,
            derived: true,
            onAdvisory: (value: string) => advisories.push(value),
          })
        )
      ).toBe(denied);
      if (!denied) expect(advisories.includes('file_ownership')).toBe(advisory);
    }
  });
  test.each(['claude', 'codex'])(
    'M5: %s shares existing-target loss policy across tools and shell',
    client => {
      const { guard, repo } = setup(),
        foreign = gitRepo(tmp());
      const file = join(foreign, 'README.md'),
        fresh = join(foreign, 'new.txt');
      const env = { SUPERAGENT_ROLE: 'worker' };
      const check = (tool_name: string, tool_input: object, denied: boolean) => {
        const out = guard(client, { tool_name, tool_input }, env);
        expect(Boolean(reason(out)), JSON.stringify({ tool_name, tool_input })).toBe(denied);
        if (!denied) expect(out?.systemMessage).toContain('advisory');
      };
      if (client === 'claude') {
        check('Write', { file_path: file, content: 'replace\n' }, true);
        check('Write', { file_path: fresh, content: 'new\n' }, false);
        check('Edit', { file_path: file, old_string: 'hi', new_string: 'edit' }, false);
      } else {
        for (const [target, denied] of [
          [file, true],
          [fresh, false],
        ] as const)
          check(
            'apply_patch',
            { input: `*** Begin Patch\n*** Add File: ${target}\n+replacement\n*** End Patch` },
            denied
          );
        check(
          'apply_patch',
          { input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-hi\n+edit\n*** End Patch` },
          false
        );
        check(
          'apply_patch',
          { input: `*** Begin Patch\n*** Add File: ${fresh}\n+new\n*** End Patch` },
          false
        );
        check(
          'apply_patch',
          { input: `*** Begin Patch\n*** Delete File: ${file}\n*** End Patch` },
          true
        );
      }
      for (const [command, denied] of [
        [`printf x > ${file}`, true],
        [`printf x > ${fresh}`, false],
        [`printf x >> ${file}`, false],
        [`cp ${join(repo, 'a.ts')} ${file}`, true],
        [`mv ${join(repo, 'a.ts')} ${file}`, true],
        [`rm ${file}`, true],
        [`rm ${fresh}`, false],
      ] as const)
        check(
          client === 'claude' ? 'Bash' : 'exec_command',
          client === 'claude' ? { command } : { cmd: command },
          denied
        );
      expect(readFileSync(file, 'utf8')).toBe('hi\n');
      expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe('old\n');
    }
  );
  const allowed = [
    'rtk proxy command -v uv',
    'rtk proxy which flock bun timeout',
    'rtk proxy bash -c \'baseline_dir=$(mktemp -d /tmp/mac-presets-baseline.XXXXXX); git archive HEAD app/src-tauri | tar -x -C "$baseline_dir"; cargo test --manifest-path "$baseline_dir/app/src-tauri/Cargo.toml" --lib --locked > /tmp/mac-presets-baseline-cargo.log 2>&1; result=$?; tail -n 10 /tmp/mac-presets-baseline-cargo.log; exit "$result"\'',
    'rtk proxy sh -c \'git diff --check && test "$(git rev-parse HEAD)" = abc && git status --short\'',
    "rtk proxy bash -c 'for i in $(seq 1 3); do bun test > /tmp/x-$i.log 2>&1; done'",
    'rtk proxy kill -TERM 41418',
    'ln -s /main/app/node_modules app/node_modules',
    'echo x > /Users/test/work/_mcp_workspace/tmp/new-file',
    'rm -rf ~/work/other-repo/src', // Missing targets do not lose data.
    'echo "unterminated',
  ];
  test.each(allowed)('放行清单：%s', command => {
    const { guard } = setup();
    const out = guard('claude', bash(command), { SUPERAGENT_ROLE: 'worker' });
    expect(reason(out)).toBeUndefined();
    if (command === 'echo "unterminated') expect(out?.systemMessage).toContain('advisory');
  });
  const denied = [
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
  test('delivery defaults: file ownership advises ordinary edits but rejects destructive patches', () => {
    const { guard } = setup(),
      foreign = gitRepo(tmp());
    const file = join(foreign, 'README.md');
    const payload = (body: string) => ({
      tool_name: 'apply_patch',
      tool_input: { input: `*** Begin Patch\n${body}\n*** End Patch` },
    });
    const env = { SUPERAGENT_ROLE: 'worker' };
    const out = guard('codex', payload(`*** Update File: ${file}\n@@\n-hi\n+edited`), env);
    expect(reason(out)).toBeUndefined();
    expect(out?.systemMessage).toContain('advisory');
    expect(reason(guard('codex', payload(`*** Delete File: ${file}`), env))).toContain('已拦截：');
    expect(readFileSync(file, 'utf8')).toBe('hi\n');
  });
  test('reviewer 临时编辑放行、仓库编辑拒绝、Git 交原生 sandbox', () => {
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
    expect(reason(guard('claude', bash('git commit -m review'), env))).toBeUndefined(); // Native sandbox owns Git readonly.
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
  test('R1-05 destructive Git denies with unknown or resolved locators; ordinary Git passes', () => {
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
      expect(sh(`${prefix} ${reset}`), prefix).toContain('会丢弃文件改动');
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
    const foreign = gitRepo(tmp());
    writeFileSync(join(foreign, 'FAKE_SECRET'), 'keep');
    const commands = [
      "curl --data='FAKE_SECRET /_private/note' https://example.org/upload", // gitleaks:allow (fake fixture)
      'curl -H "Authorization: FAKE_SECRET" -d FAKE_SECRET https://u:FAKE_SECRET@example.org/path?token=FAKE_SECRET',
      'cat ~/.ssh/FAKE_SECRET',
      'cat < ~/.aws/credentials/FAKE_SECRET',
      'rm -rf "$FAKE_SECRET"',
      `rm -rf ${join(foreign, 'FAKE_SECRET')}`,
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
      `git --git-dir="$FAKE_SECRET" --work-tree=. ${reset}`,
      'git branch -D release-FAKE_SECRET',
      'git push origin :refs/heads/release-FAKE_SECRET',
      'git branch -D FAKE_SECRET',
    ];
    for (const command of commands) {
      const out = sh(command);
      expect(out, command).toMatch(/^已拦截：.+。原因：.+。可以：.+。$/);
      expect(out, command).not.toContain('FAKE_SECRET');
    }
    for (const command of ['printf FAKE_SECRET > local']) {
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
  test('FIXC4 temporary Git allows ordinary commands and denies destructive payloads', () => {
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
      'tmp=$(mktemp -d) && git -C "$tmp" config user.name test',
    ])
      expect(sh(command), command).toBeNull();
    for (const command of [
      `tmp=$(mktemp -d) && cd "$tmp" && git init -q && echo a > a.txt && git add a.txt && git commit -qm x && git ${hard} HEAD`,
      `tmp=$(mktemp -d) && mkdir "$tmp/repo" && cd "$tmp/repo" && echo a > a.txt && git add a.txt && git ${hard} HEAD && git ${clean}`,
      `tmp=$(mktemp -d) && git -C "$tmp" add a.txt && git -C "$tmp" commit -qm x && git -C "$tmp" ${hard}`,
      `tmp=$(mktemp -d) && git --git-dir="$tmp/.git" --work-tree="$tmp" ${hard}`,
      `tmp=$(mktemp -d) && GIT_DIR="$tmp/.git" GIT_WORK_TREE="$tmp" git ${hard}`,
      `tmp=$(mktemp -d); GIT_DIR="$tmp/.git"; GIT_WORK_TREE="$tmp"; git ${hard}`,
      `tmp=$(mktemp -d) && cd "$tmp" && git --git-dir=.git --work-tree=. ${hard}`,
      `tmp=$(mktemp -d) && git -C"$tmp" --git-dir=.git --work-tree=. ${hard}`,
      `tmp=$(mktemp -d) && sh -c 'cd "$1" && git ${hard}' sh "$tmp"`,
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
  test('FIXC5 destructive Git denies in every checkout, including nested metadata', () => {
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
        expect(check(`${prefix} ${hard}`, nested), prefix).toContain('会丢弃文件改动');
        expect(check(`${prefix} commit -qm x`, nested), prefix).toBeNull();
      }
    }
    for (const command of ['status --short', 'commit -qm x']) {
      expect(check(`git ${command}`)).toBeNull();
      expect(check(`git --git-dir=.git --work-tree=. ${command}`)).toBeNull();
    }
    mkdirSync(join(repo, 'src'));
    expect(check(`git ${hard}`)).toContain('会丢弃文件改动');
    expect(check(`git --git-dir=.git --work-tree=. ${hard}`)).toContain('会丢弃文件改动');
    expect(check(`git ${hard}`, repo, join(repo, 'src'))).toContain('会丢弃文件改动');
    expect(check(`git --git-dir="${join(repo, '.git')}" ${hard}`, worktree)).toMatch(/^已拦截：/);
    expect(check(`git -C "${gitRepo(tmp())}" ${hard}`)).toMatch(/^已拦截：/);
    expect(check(`git -C /foreign ${hard}`)).toMatch(/^已拦截：/);
    expect(check('echo ok > src/result')).toBeNull();
    expect(
      check('tmp=$(mktemp -d); cd "$tmp"; git init -q; git add a; git commit -qm x; git ' + hard)
    ).toContain('会丢弃文件改动');
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
          'clean -fdx',
          'checkout -- file',
          'checkout -b t --force',
          'switch --discard-changes other',
          'branch -D t',
          'branch -C old new',
          'branch -f t HEAD',
          'tag -d t',
          'tag -f t',
          'push --force',
          'update-ref -d refs/heads/t',
          'stash drop',
          'stash clear',
          'fetch -f origin',
          'fetch origin +HEAD:refs/heads/t',
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
    ['R1-07 pid provenance', 'pgrep node | xargs kill -TERM 41418'],
    ['R1-08 option spelling', 'curl --request=DELETE https://example.com/item'], // gitleaks:allow (fake fixture)
    [
      'R1-09 secret redaction',
      'curl -H "Authorization: Bearer FAKE_SECRET" -d "{}" https://example.com',
    ],
  ];
  test.each(probes)('探针 %s', (_id, command) => {
    const { guard } = setup();
    const foreign = gitRepo(tmp());
    writeFileSync(join(foreign, 'victim'), 'keep');
    command = command.replaceAll('/Users/Shared', foreign);
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
    const foreign = gitRepo(tmp());
    writeFileSync(join(foreign, 'other'), 'keep');
    for (const command of commands)
      expect(
        reason(
          guard('claude', bash(command.replaceAll('/Users/Shared', foreign)), {
            SUPERAGENT_ROLE: 'worker',
          })
        ),
        command
      ).toMatch(/^已拦截：/);
  });
  test('R1-09 only action and host survive external write reminders', () => {
    const { guard } = setup();
    for (const command of [
      'curl --user user:FAKE_SECRET --data=PRIVATE_BODY https://example.org/private?token=QUERY_SECRET', // gitleaks:allow (fake fixture)
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
  test('G-1：元帅 Edit 31 行放行并提示、29 行及 ALLOW 静默放行', () => {
    const { repo, guard } = setup();
    const out = guard('claude', edit(repo, 31));
    expect(reason(out)).toBeUndefined();
    expect(out?.systemMessage).toContain('本会话已改 31 行 / 1 个文件（超过微改 30 行/2 文件）');
    expect(out?.systemMessage).toContain('superagent quick 交将军编码；本次不拦截。');
    expect(guard('claude', edit(repo, 29))).toBeNull();
    expect(guard('claude', edit(repo, 31), { SUPERAGENT_ALLOW_COMMANDER_WRITE: '1' })).toBeNull();
  });

  test('G-1：同一会话持续累计，首次超限及再增 100 行才提示', () => {
    const { repo, guard } = setup();
    const p = { ...edit(repo, 20), session_id: 'same' };
    expect(guard('claude', p)).toBeNull();
    expect(guard('claude', p)?.systemMessage).toContain('已改 40 行');
    for (let i = 0; i < 4; i++) expect(guard('claude', p)).toBeNull();
    expect(guard('claude', p)?.systemMessage).toContain('已改 140 行');
  });

  test('G-1：文件超限每再增 2 个提示，新增与风险路径只提示，两端一致', () => {
    const { repo, guard } = setup();
    const write = (file: string): Out =>
      guard('codex', {
        session_id: 'files',
        tool_name: 'apply_patch',
        tool_input: { input: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
      });
    for (const file of ['b.txt', 'c.txt']) expect(write(file)).toBeNull();
    expect(write('d.txt')?.systemMessage).toContain('已改 3 行 / 3 个文件');
    expect(write('e.txt')).toBeNull();
    expect(write('f.txt')?.systemMessage).toContain('已改 5 行 / 5 个文件');
    const risk = write('auth/login.ts');
    expect(reason(risk)).toBeUndefined();
    expect(risk?.systemMessage).toContain(join(repo, 'auth/login.ts'));
    expect(write('auth/login.ts')).toBeNull();
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

  test('元帅会话 Agent 放行；派发上下文仅 advisory', () => {
    const { guard } = setup();
    expect(
      guard('claude', { tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'coder-1' } })
    ).toBeNull();
    expect(
      reason(
        guard('claude', { tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'fork' } })
      )
    ).toBeUndefined();
  });

  test('delivery defaults: dispatch context is advisory without mutating inputs', () => {
    const { guard } = setup();
    for (const client of ['claude', 'codex']) {
      const input =
        client === 'claude'
          ? { prompt: 'x'.repeat(13000), subagent_type: 'fork' }
          : { message: 'x'.repeat(13000), fork_turns: 'all', model: 'outside-pool' };
      const before = JSON.stringify(input);
      const out = guard(client, {
        tool_name: client === 'claude' ? 'Agent' : 'spawn_agent',
        tool_input: input,
      });
      expect(reason(out)).toBeUndefined();
      expect(out?.systemMessage).toContain('advisory');
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  test('git：正常 push 放行，force/foreign reset --hard 被拦', () => {
    const { guard } = setup();
    expect(guard('claude', bash('git stash push -m wip'))).toBeNull();
    expect(reason(guard('claude', bash('git push origin wetamp')))).toBeUndefined();
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
    ).toContain('会丢弃文件改动');
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

  test('G-1：并发写入全部放行，在锁内累计且只提示首次超限', async () => {
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
        const out = (await new Response(p.stdout).text()).trim();
        expect(await p.exited).toBe(0);
        return out;
      })
    );
    expect(outs.filter(o => o === '').length).toBe(7);
    const out = JSON.parse(outs.find(o => o !== '')!) as Out;
    expect(reason(out)).toBeUndefined();
    expect(out?.systemMessage).toContain('已改 40 行');
    const file = join(home, 'hooks', `${createHash('sha256').update('race').digest('hex')}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8')).micro.lines).toBe(80);
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
    expect(guard('claude', { ...p, tool_use_id: 'event-2' })?.systemMessage).toContain(
      '已改 40 行'
    );
    expect(guard('claude', { ...p, tool_use_id: 'event-2' })).toBeNull();
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

  test('活动 run 内超过 15 次 Bash/Read 仍静默，不产生工具计数状态', () => {
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
    const call = (command: string, tool_name = 'Bash'): Out =>
      run(
        'context-advisory.cjs',
        'claude',
        {
          hook_event_name: 'PreToolUse',
          session_id: 'x',
          transcript_path: transcript,
          tool_name,
          tool_input: { command },
        },
        { SUPERAGENT_HOME: home }
      );
    for (let i = 0; i < 18; i++) expect(call('ls', i % 2 ? 'Read' : 'Bash')).toBeNull();
    const file = join(
      home,
      'hooks/context-advisory',
      `${createHash('sha256').update('x').digest('hex')}.json`
    );
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });
  test('F-12/A-11: concurrent context hooks keep every distinct event and deduplicate repeated IDs', async () => {
    const root = tmp(),
      home = join(root, 'sa'),
      transcript = join(root, 't.jsonl');
    writeFileSync(transcript, JSON.stringify({ usage: { input_tokens: 170000 } }));
    const outs = await Promise.all(
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
        const out = (await new Response(p.stdout).text()).trim();
        expect(await p.exited).toBe(0);
        return out;
      })
    );
    const file = join(
      home,
      'hooks/context-advisory',
      `${createHash('sha256').update('race').digest('hex')}.json`
    );
    const state = JSON.parse(readFileSync(file, 'utf8'));
    expect(state.warned_at).toBe(170000);
    expect(Object.keys(state.events)).toHaveLength(20);
    expect(outs.filter(Boolean)).toHaveLength(1);
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
  test('safe-delete checks surviving refs and actual worktree contents, failing closed', () => {
    const root = tmp(),
      repo = gitRepo(root),
      worktree = join(root, 'clean-worktree');
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', '-C', repo, ...args]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    const check = (shell: string, reviewer = false) =>
      redline.reason({
        client: 'claude',
        name: 'Bash',
        cwd: repo,
        root: reviewer ? repo : '/foreign',
        derived: true,
        reviewer,
        shell,
        env: baseEnv,
      });
    git('branch', 'merged');
    git('branch', 'merged-two');
    git('checkout', '-q', '-b', 'unmerged');
    git('-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '--allow-empty', '-qm', 'unique');
    git('branch', 'same-tip');
    git('checkout', '-q', 'main');
    for (const flags of ['-d', '--delete', '-D', '-df', '-fd', '--delete --force']) {
      expect(check(`git branch ${flags} merged merged-two`), flags).toBeNull();
    }
    expect(check('git branch -D unmerged')).toBeNull(); // same-tip preserves it.
    expect(check('git branch -D unmerged same-tip')).toContain('分支有未合并提交，删除会丢失');
    // R1-3: separate commands must not count each other's deleted refs as survivors.
    for (const separator of [' && ', '; ', ' || ']) {
      expect(check(`git branch -D unmerged${separator}git branch -D same-tip`)).toContain(
        '已拦截：'
      );
    }
    expect(check('git branch -d unmerged; git branch -D same-tip')).toContain('已拦截：');
    expect(check('git branch -D merged && git branch -D merged-two')).toBeNull();
    expect(check('git branch -D merged unmerged same-tip')).toContain('已拦截：');
    git('tag', 'tag-only', 'unmerged');
    expect(check('git branch -D unmerged same-tip')).toContain('已拦截：');
    git('update-ref', 'refs/remotes/origin/saved', 'unmerged');
    for (const flags of ['-dr', '--delete --remotes']) {
      expect(check(`git branch ${flags} origin/saved`)).toBeNull();
      expect(
        check(`git branch -D unmerged same-tip && git branch ${flags} origin/saved`)
      ).toContain('已拦截：');
      expect(check(`git -C /nonexistent-sa-delete-query branch ${flags} origin/saved`)).toContain(
        '已拦截：'
      );
    }
    expect(check('git branch -D unmerged same-tip')).toBeNull();
    expect(check('git branch -D unmerged && git branch -D same-tip')).toBeNull();
    expect(
      check('git branch -D unmerged; git branch -drD origin/saved; git branch -D same-tip')
    ).toContain('已拦截：');
    expect(check('git branch -D missing')).toContain('Git 查询失败');
    expect(check('git -C /nonexistent-sa-delete-query branch -D merged')).toContain('已拦截：');
    expect(check('git branch -D main')).toBeNull(); // Other branches retain its tip.
    expect(check('git branch -m merged new')).toBeNull();
    expect(check('git branch -D merged', true)).toBeNull();
    git('worktree', 'add', '-q', '--detach', worktree, 'main');
    expect(check(`git worktree remove "${worktree}"`)).toBeNull();
    expect(check(`git worktree remove --force "${worktree}"`)).toBeNull();
    // R1-2: an existing cwd-relative directory must not mask Git's registered suffix target.
    mkdirSync(join(repo, 'clean-worktree'));
    expect(check('git worktree remove --force clean-worktree')).toBeNull();
    expect(check('git worktree prune')).toBeNull();
    expect(check(`git worktree move "${worktree}" "${worktree}-moved"`)).toBeNull();
    writeFileSync(join(worktree, 'untracked'), 'keep');
    expect(check(`git worktree remove --force "${worktree}"`)).toContain('未提交改动');
    expect(check('git worktree remove --force clean-worktree')).toContain('未提交改动');
    // R1-1: all accepted force prefixes must perform the same dirty-tree check.
    for (const force of ['--f', '--fo', '--for', '--forc', '--force', '-ff']) {
      expect(check(`git worktree remove ${force} "${worktree}"`), force).toContain('未提交改动');
    }
    // Non-forced deletion delegates dirty/locked checks to Git.
    expect(check(`git worktree remove "${worktree}"`)).toBeNull();
    const other = join(root, 'detached-worktree');
    git('worktree', 'add', '-q', '--detach', other, 'main');
    expect(
      Bun.spawnSync([
        'git',
        '-C',
        other,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@l',
        'commit',
        '--allow-empty',
        '-qm',
        'detached',
      ]).exitCode
    ).toBe(0);
    expect(check(`git worktree remove -f "${other}"`)).toContain('未保留的提交');
    expect(check(`git worktree remove -f "${other}-missing"`)).toContain('Git 查询失败');
  });
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
    for (const flag of ['-m', '-M', '-c', '--move', '--copy'])
      expect(check(`git branch ${flag} old new`, '/foreign')).toBeNull();
    for (const flag of ['-D', '--delete --force', '-df'])
      expect(check(`git branch ${flag} old new`, '/foreign')).toContain('已拦截：');
    expect(check('git branch -C old new', '/foreign')).toContain('会丢弃文件改动');
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

  test('rebase 无分支参数时不按分支名阻断', () => {
    const { repo, sh } = box();
    expect(sh('git rebase -i HEAD~2')).toBeNull(); // Branch names do not gate Git.
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

test('guard categories preserve structured rejection sources and physical denial', () => {
  const repo = gitRepo(tmp()),
    foreign = gitRepo(tmp());
  for (const [cmd, category] of [
    [`git -C "${foreign}" reset --hard`, 'diagnostic'],
    ['git branch -D missing', 'diagnostic'],
    ['git push --force', 'shared_history'],
    ['git push origin dev', 'external'],
  ]) {
    const payload = { cwd: repo, tool_input: { command: cmd } };
    const out = run('git-guardrail.cjs', 'claude', payload, {}, HOOKS, 2);
    expect(out?.superagentPermissionCategory).toBe(category);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  }
  for (const [tool_name, tool_input, category] of [
    ['Agent', {}, 'delegation'],
    ['Read', { file_path: join(repo, '_private', 'sample') }, 'privacy'],
    ['Bash', { command: `rm -rf "${repo}"` }, 'destruction'],
    ['Bash', { command: 'sudo true' }, 'authorization'],
    ['Write', { file_path: join(foreign, 'README.md'), content: '' }, 'diagnostic'],
  ] as const) {
    const out = run(
      'guard.cjs',
      'claude',
      { cwd: repo, hook_event_name: 'PreToolUse', tool_name, tool_input },
      { SUPERAGENT_ROLE: 'general' }
    );
    expect(out?.superagentPermissionCategory).toBe(category);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  }
});

describe('E3-2b MCP action boundary', () => {
  test.each(['claude', 'codex'])('%s normalizes MCP and shares privacy/effect policy', client => {
    const { guard, home, repo } = setup();
    const env = { SUPERAGENT_ROLE: 'worker' };
    const mcp = (server: string, tool: string, args: object = {}, role = 'worker') =>
      guard(
        client,
        client === 'claude'
          ? { tool_name: `mcp__${server}__${tool}`, tool_input: args }
          : { tool_name: 'mcp_tool_call', tool_input: { server, tool, arguments: args } },
        { SUPERAGENT_ROLE: role }
      );
    const privatePath = join(repo, '_private', 'secret');
    expect(
      guard(client, { tool_name: 'Read', tool_input: { file_path: privatePath } }, env)
        ?.superagentPermissionCategory
    ).toBe('privacy');
    expect(
      mcp('unknown', 'lookup', { nested: [{ value: privatePath }] })?.superagentPermissionCategory
    ).toBe('privacy');
    for (const command of [
      'superagent run p.json',
      'superagent quick x',
      'superagent `echo run` p.json',
      'superagent job exec --title test -- codex exec p',
    ]) {
      const out = guard(
        client,
        { tool_name: client === 'claude' ? 'Bash' : 'exec_command', tool_input: { command } },
        env
      );
      expect(out?.superagentPermissionCategory).toBe('delegation');
      expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    }
    expect(mcp('twin-agent', 'delegate_agent')?.superagentPermissionCategory).toBe('delegation');
    expect(mcp('claude', 'Agent')?.superagentPermissionCategory).toBe('delegation');
    for (const tool of [
      'add_comment_to_pending_review',
      'add_issue_comment',
      'add_reply_to_pull_request_comment',
      'create_branch',
      'create_or_update_file',
      'create_pull_request',
      'create_repository',
      'delete_file',
      'fork_repository',
      'issue_write',
      'merge_pull_request',
      'pull_request_review_write',
      'push_files',
      'request_copilot_review',
      'sub_issue_write',
      'update_issue_comment',
      'update_pull_request',
      'update_pull_request_branch',
    ])
      expect(mcp('github', tool)?.superagentPermissionCategory).toBe('external');
    for (const [server, tool, args, category] of [
      ['github', 'create_or_update_file', {}, 'external'],
      ['serena', 'execute_shell_command', {}, 'authorization'],
      ['filesystem', 'read_file', { path: privatePath }, 'privacy'],
    ] as const) {
      const out = mcp(server, tool, { ...args, server: 'noop', tool: 'noop' });
      expect(out?.superagentPermissionCategory).toBe(category);
      expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    }
    expect(reason(mcp('github', 'get_file_contents'))).toBeUndefined();
    expect(reason(mcp('computer-use', 'screenshot'))).toBeUndefined();
    expect(mcp('serena', 'execute_shell_command')?.superagentPermissionCategory).toBe(
      'authorization'
    );
    expect(
      mcp('serena', 'replace_symbol_body', { relative_path: 'a.ts' }, 'reviewer')
        ?.superagentPermissionCategory
    ).toBe('authorization');
    for (const role of ['worker', 'reviewer', 'commander'])
      expect(reason(mcp('new', 'tool', { value: 'DO_NOT_LOG' }, role))).toBeUndefined();
    const events = readFileSync(join(home, 'hooks', 'events.jsonl'), 'utf8');
    expect(events).not.toContain('DO_NOT_LOG');
    expect(events).toContain('mcp.unregistered_tool');
    expect(events).toContain('"role":"reviewer"');
  });
});
