import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gitRepo, tmp } from './helpers';
import { testTimeout } from '@archon/paths/test-utils';
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

type Redline = {
  reason: (options: {
    client?: string;
    name?: string;
    input?: object;
    cwd: string;
    root?: string;
    shell?: string;
    env?: Record<string, string>;
  }) => string | null;
};
const redline = createRequire(import.meta.url)('../hooks/redline.cjs') as Redline;
function boundary() {
  const home = tmp(),
    repo = gitRepo(tmp());
  const env = { HOME: home };
  const sh = (shell: string) => redline.reason({ cwd: repo, root: repo, shell, env });
  return { home, repo, env, sh };
}

describe('两条底线', () => {
  test('iCloud aliases, MCP, listing/search and Codex hook payloads; other cloud providers allowed', () => {
    const { home, repo, env, sh } = boundary();
    const target = join(home, 'Library/CloudStorage/iCloud Drive');
    mkdirSync(target, { recursive: true });
    const alias = join(repo, 'cloud-link');
    symlinkSync(target, alias);
    for (const path of [target, alias, join(alias, 'new-file')]) {
      for (const name of ['Read', 'Edit', 'Write', 'LS', 'Glob', 'Grep', 'mcp__files__read'])
        expect(
          redline.reason({ name, input: { file_path: path, path }, cwd: repo, env })
        ).toContain('iCloud');
      expect(sh(`ls "${path}"`)).toContain('iCloud');
      expect(
        redline.reason({
          name: 'lookup',
          input: { arguments: { nested: [{ path }] } },
          cwd: repo,
          env,
        })
      ).toContain('iCloud');
    }
    const safe = join(home, 'Library/CloudStorage/SynologyDrive/a');
    expect(sh(`cat "${safe}"`)).toBeNull();
    expect(redline.reason({ name: 'lookup', input: { path: safe }, cwd: repo, env })).toBeNull();
    // Transport fixtures prove guard handling, not that a live Codex client emits every event.
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: target }],
      ['view_image', { path: target }],
      ['exec_command', { cmd: `ls "${target}"` }],
      ['apply_patch', { input: `*** Begin Patch\n*** Add File: ${target}/new\n+x\n*** End Patch` }],
      ['mcp__files__read', { arguments: { path: target } }],
    ] as const) {
      expect(
        reason(
          run(
            'guard.cjs',
            'codex',
            {
              hook_event_name: 'PreToolUse',
              cwd: repo,
              tool_name,
              tool_input,
            },
            { ...env, SUPERAGENT_HOME: join(home, '.superagent') }
          )
        )
      ).toContain('iCloud');
    }
  });
  test('redline internal path inspection errors fail closed', () => {
    const { repo, env } = boundary();
    const input = {
      get path(): string {
        throw new Error('synthetic path failure');
      },
    };
    expect(redline.reason({ name: 'Read', input, cwd: repo, env })).toContain(
      'redline_internal_error'
    );
    expect(
      redline.reason({
        shell: 'cat ./file',
        cwd: repo,
        env: {
          get HOME(): string {
            throw new Error('synthetic path failure');
          },
        },
      })
    ).toContain('redline_internal_error');
  });
  const privatePaths = [
    '.ssh/id_ed25519',
    '.aws/credentials',
    ...'.m2/settings.xml .m2/settings-security.xml .cloudflared/cert.pem'.split(' '),
    ...'.codex/auth.json .local/share/opencode/auth.json .zsh_history .bash_history'.split(' '),
    ...'.local/share/atuin/history.db .config/code-server/config.yaml .kube/config .git-credentials .aliyun/config.json .alibabacloud/config.json'.split(
      ' '
    ),
    '.netrc',
    '.config/gh/hosts.yml',
    '.npmrc',
    '.pypirc',
    'Library/Keychains/login.keychain-db',
    'Library/Mobile Documents/a',
    'Library/CloudStorage/iCloud云盘-iCloudDrive (2026-6-6 08:15)/a',
    'Library/CloudStorage/ICLOUDDrive/a',
    'Library/Application Support/Google/Chrome/Default/Cookies',
    'Library/Application Support/Chromium/a',
    'Library/Application Support/Arc/a',
    'Library/Application Support/Microsoft Edge/a',
    'Library/Application Support/Firefox/a',
    'Library/Safari/a',
    'Library/Containers/com.apple.Safari/a',
    'Library/Cookies/a',
    'docs/_private/a',
  ];
  test.each(privatePaths)('隐私 Read / Bash / bash -c：%s', file => {
    const { home, repo, env, sh } = boundary();
    const target = join(home, file);
    expect(
      redline.reason({ name: 'Read', input: { file_path: target }, cwd: repo, env })
    ).toContain('已拦截：');
    expect(sh(`cat "${target}"`)).toContain('已拦截：');
    expect(sh(`bash -c 'cat "${target}"'`)).toContain('已拦截：');
  });
  test.each(
    '.m2/repository/x.jar .cloudflared/config.yml .cloudflared .codex/config.toml .kube/cache/x'.split(
      ' '
    )
  )('凭据相邻路径放行：%s', file => {
    const { home, repo, env } = boundary();
    expect(
      redline.reason({ name: 'Read', input: { file_path: join(home, file) }, cwd: repo, env }) ?? ''
    ).not.toContain('已拦截：');
  });
  test('隐私保留 cwd、变量、软链、大小写及重定向', () => {
    const { home, repo, sh } = boundary();
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh/id_ed25519'), 'synthetic');
    symlinkSync(join(home, '.ssh/id_ed25519'), join(repo, 'link'));
    for (const command of [
      'cd ~/.ssh && cat id_ed25519',
      'pushd ~/.ssh && cat id_ed25519',
      'key=$HOME/.ssh/id_ed25519; cat $key',
      'cat link',
      'cat ~/.SSH/ID_ED25519',
      'cat < ~/.netrc',
      'echo x > ~/.netrc',
      'env HOME=/synthetic cat /synthetic/.netrc',
      "bash -c 'cat $1' _ ~/.netrc",
      'cat <<EOF\n$(cat ~/.netrc)\nEOF',
      'security find-generic-password -w -s fake',
      "bash -c 'security dump-keychain'",
    ])
      expect(sh(command), command).toContain('已拦截：');
    for (const command of [
      'ls ~/.ssh',
      'cat ~/.ssh/id_ed25519.pub',
      'cat ~/.ssh/config',
      'cat ~/.ssh/known_hosts',
      'grep _private src',
      'security list-keychains',
    ])
      expect(sh(command), command).toBeNull();
  });
  test.each(['lookup', 'mcp__unknown__lookup', 'mcp_tool_call'])(
    'MCP 裸名/前缀/包装输入隐私：%s',
    name => {
      const { repo, env } = boundary();
      const input = {
        server: 'unknown',
        tool: 'lookup',
        arguments: { nested: [{ path: '~/.netrc' }] },
      };
      expect(redline.reason({ name, input, cwd: repo, env })).toContain('已拦截：');
    }
  );
  test('编辑与补丁仍保护隐私路径，包括 Move 的两端', () => {
    const { repo, env } = boundary();
    expect(
      redline.reason({
        client: 'claude',
        name: 'Write',
        input: { file_path: '~/.netrc', content: '' },
        cwd: repo,
        env,
      })
    ).toContain('已拦截：');
    for (const [source, target] of [
      ['_private/a', 'b'],
      ['a', '_private/b'],
    ]) {
      expect(
        redline.reason({
          client: 'codex',
          name: 'apply_patch',
          input: {
            input: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n-x\n+y\n*** End Patch`,
          },
          cwd: repo,
          env,
        })
      ).toContain('已拦截：');
    }
  });
  test('不可逆破坏：Read 只读命令文本，Bash 与 bash -c 拒绝执行', () => {
    const { home, repo, env, sh } = boundary();
    const commands = [
      'git push --force',
      'git push -f origin main',
      'git push origin +HEAD:main',
      'git push --force-with-lease',
      'git push --force-with-lease=main:abc',
      'git -C /foreign reset --hard',
      'git reset --hard',
      'git push --dry-run --force',
      `rm -rf "${home}"`,
      `rm -fr "${repo}"`,
      'rm -rf /',
      'rm -rf $SUPERAGENT_HOME',
      'rm -rf ~/.superagent/gen',
      `rm --recursive --force ${repo}`,
      `rm -rf /tmp/file ${repo}`,
      'cd . && rm -rf .',
    ];
    Object.assign(env, { SUPERAGENT_HOME: join(home, '.superagent') });
    const file = join(repo, 'commands.txt');
    writeFileSync(file, commands.join('\n'));
    expect(redline.reason({ name: 'Read', input: { file_path: file }, cwd: repo, env })).toBeNull();
    for (const command of commands) {
      expect(sh(command), command).toContain('已拦截：');
      expect(sh(`bash -c '${command}'`), command).toContain('已拦截：');
    }
    symlinkSync(repo, join(home, 'alias'));
    expect(sh(`rm -rf ${home}/alias`)).toContain('已拦截：');
  });
  test('撤除的 Git 与删除拦截全部放行', () => {
    const { repo, sh } = boundary();
    for (const command of [
      'git push origin main',
      'git push --delete origin main',
      'git push --prune',
      'git push --mirror',
      'git push origin :main',
      'git reset --soft HEAD~1',
      'git clean -fd',
      'git restore .',
      'git checkout -- .',
      'git branch -D topic',
      'git tag -d v1',
      'git worktree remove --force /other',
      'git gc --prune=now',
      'rm -rf /other/repo/src',
      'rm -rf $UNKNOWN',
      'rm -rf ~/.superagent/scratch/x',
      'rm -rf ~/.superagent/gen/x',
      `rm -rf ${repo}/build`,
      'rm /etc/file',
      'find . -delete',
      'truncate -s 0 /other/file',
      'mv /other/file /etc/file',
    ])
      expect(sh(command), command).toBeNull();
  });
  test.each(['claude', 'codex'])(
    '%s 两条底线对所有角色一致，其余类别放行',
    client => {
      const { repo, guard } = setup();
      for (const role of ['worker', 'reviewer', 'strategist']) {
        const env = { SUPERAGENT_ROLE: role };
        for (const command of [
          'superagent run plan.json',
          'superagent job exec --title x -- codex exec x',
          'superagent quick x',
          'claude -p x',
          'codex exec x',
          'gh release create v1',
          'npm publish',
          'sudo true',
          'pkill -f node',
          'kill -9 -1',
          'echo x > ~/.superagent/live/x',
          'echo x > /etc/file',
          'archon workflow wake',
          'archon workflow abandon other',
        ]) {
          expect(reason(guard(client, bash(command), env)), command).toBeUndefined();
        }
        for (const [tool_name, tool_input] of [
          ['Agent', { prompt: 'x' }],
          ['spawn_agent', { message: 'x' }],
          ['mcp__github__create_pull_request', { title: 'x' }],
          ['mcp__serena__execute_shell_command', { command: 'bun test' }],
          ['mcp__serena__replace_content', { relative_path: 'a.ts' }],
          ['mcp__twin-agent__delegate_agent', {}],
          ['Write', { file_path: join(repo, 'a.ts'), content: 'x' }],
        ] as const)
          expect(reason(guard(client, { tool_name, tool_input }, env))).toBeUndefined();
        for (const [command, category] of [
          ['cat ~/.netrc', 'privacy'],
          ['git push --force', 'shared_history'],
          [`rm -rf ${repo}`, 'destruction'],
        ]) {
          expect(guard(client, bash(command), env)?.superagentPermissionCategory).toBe(category);
        }
      }
    },
    testTimeout(20000)
  );
});

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

  test('Stop 在 stop_gate=off 时静默', () => {
    const { guard } = setup();
    expect(guard('claude', { hook_event_name: 'Stop' })).toBeNull();
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
      'echo x > "$TARGET"',
      'echo "unclosed',
      'node -e "require(\"fs\").writeFileSync(\"a.ts\", \"x\")"',
    ]) {
      const out = guard('claude', bash(command));
      expect(reason(out), command).toBeUndefined();
      expect(out?.systemMessage, command).toContain('advisory');
    }
    expect(guard('claude', bash('echo x > NOTES.md'))).toBeNull();
    expect(guard('claude', bash('touch auth.ts'))).toBeNull();
    expect(guard('claude', bash('cp NOTES.md a.ts'))).toBeNull();
    expect(guard('claude', bash('git status'))).toBeNull();
    expect(
      reason(guard('codex', { tool_name: 'apply_patch', tool_input: { input: 'invalid' } }))
    ).toContain('redline_internal_error');
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
    session = 's',
    root = tmp()
  ): Out {
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
  test('rollover state persists across processes and inbox context is merged', () => {
    const root = tmp(),
      home = join(root, 'sa'),
      session = 'r';
    const call = (tokens: number, prompt_id: string): Out =>
      budget(tokens, {}, { prompt_id }, session, root);
    expect(call(400001, 'a')?.hookSpecificOutput?.additionalContext).toContain('tasks.sh list');
    const name = `claude-${createHash('sha256').update(session).digest('hex').slice(0, 16)}.json`;
    const live = JSON.parse(readFileSync(join(home, 'live', name), 'utf8'));
    mkdirSync(join(home, 'coord', 'inbox'), { recursive: true });
    writeFileSync(
      join(home, 'coord', 'inbox', 'm.json'),
      JSON.stringify({ id: 'm', type: 'receipt', recipient: live })
    );
    const merged = call(500001, 'b')?.hookSpecificOutput?.additionalContext;
    expect(merged).toMatch(/Superagent 交接待答复[\s\S]*tasks\.sh list/);
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
