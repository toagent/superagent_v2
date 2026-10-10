import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from './helpers';

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
    ).toContain('N-1');
    expect(
      reason(
        guard(
          'claude',
          { tool_name: 'Task', tool_input: { prompt: 'x' } },
          { AI_DISPATCH_ROLE: 'general' }
        )
      )
    ).toContain('N-1');
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
    ).toContain('N-1');
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

  test('Codex 判定：general 池且不在 commander 池为派生；子调用与 commander 模型不按模型判', () => {
    const { guard } = setup();
    const spawn = { tool_name: 'spawn_agent', tool_input: { message: 'x', fork_turns: 'none' } };
    expect(reason(guard('codex', { ...spawn, model: 'gpt-6.1-sol' }))).toContain('general 池模型');
    expect(guard('codex', { ...spawn, model: 'gpt-6-astra' })).toBeNull();
    expect(
      guard('codex', { ...spawn, model: 'gpt-6.1-sol', agent_type: 'x', agent_id: 'y' })
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
    expect(reason(guard('claude', bash('echo ok; git reset --hard HEAD~1')))).toContain(
      'reset --hard'
    );
  });

  test('删除目标拦截与 reviewer 只读', () => {
    const { home, repo, guard } = setup();
    expect(reason(guard('claude', bash(`rm -rf ${home}`)))).toContain('受保护目录');
    expect(reason(guard('claude', bash(`rm -rf ${repo}`)))).toContain('受保护目录');
    expect(guard('claude', bash(`rm -rf ${join(repo, 'build')}`))).toBeNull();
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
      'time -p claude -p x',
      'command claude -p x',
      'exec -a name codex exec x',
      'sudo -u root opencode run',
      'nice -n 5 claude -p x',
      'caffeinate -i claude -p x',
      'env -S "claude -p x"',
      'timeout 5 sol-run x',
      'echo "$(claude -p x)"',
      'find . -name a -exec codex exec {} \\;',
    ])
      expect(reason(guard('claude', bash(cmd), worker)), cmd).toContain('N-1');
    for (const cmd of ["echo '$(claude -p x)'", 'command -v claude', 'grep -r claude .'])
      expect(guard('claude', bash(cmd), worker), cmd).toBeNull();
  });

  test('reviewer：Bash 只放行只读白名单，重定向与写命令被拒', () => {
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
      'git -c core.pager=sh log',
      'sort -o a.ts a.ts',
      'find . -delete',
      '$(echo rm) a.ts',
      'python3 -c "open(1)"',
    ])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toContain('reviewer 只读');
    expect(
      reason(
        guard('codex', { tool_name: 'exec_command', tool_input: { cmd: 'touch x' } }, reviewer)
      )
    ).toContain('reviewer 只读');
  });

  test('reviewer：包装器自身的写入副作用按写入处理', () => {
    const { guard } = setup();
    const reviewer = { SUPERAGENT_ROLE: 'reviewer' };
    for (const [cmd, target] of [
      ['time -o out.txt cat a.ts', 'out.txt'],
      ['/usr/bin/time --output=t.log git status', 't.log'],
      ['nohup cat a.ts', 'nohup.out'],
      ['script s.log cat a.ts', 's.log'],
      ['cat a.ts | tee -a b.ts', 'b.ts'],
      ['env -C /tmp/elsewhere cat a.ts', 'elsewhere'],
      ['env --chdir=/w git status', 'w'],
    ])
      expect(reason(guard('claude', bash(cmd), reviewer)), cmd).toContain(`禁止写入 ${target}`);
    // script 也是包装器：其后的 claude 仍被 N-1 认出
    expect(
      reason(
        guard('claude', bash('script -q /dev/null claude -p x'), { SUPERAGENT_ROLE: 'worker' })
      )
    ).toContain('N-1');
  });

  test('删除拒绝信息只回显 basename', () => {
    const { home, guard } = setup();
    const r = reason(guard('claude', bash(`rm -rf ${home}`))) ?? '';
    expect(r).toContain('禁止删除 sa：');
    expect(r).not.toContain(home);
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

  test('G-3：stop_gate=change 有未评审改动时 Stop 被拒；同一状态二次 Stop 放行；评审后通过', () => {
    const { repo, guard } = setup(hooksWith({ stop_gate: 'change' }));
    const s = (p: object): Out => guard('claude', { session_id: 'g', ...p });
    expect(s({ hook_event_name: 'SessionStart' })).toBeNull();
    expect(s({ hook_event_name: 'Stop' })).toBeNull();
    expect(s(edit(repo, 1))).toBeNull();
    writeFileSync(join(repo, 'a.ts'), 'changed\n');
    const blocked = s({ hook_event_name: 'Stop' }) as { decision?: string; reason?: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('G-3');
    expect(s({ hook_event_name: 'Stop' })?.systemMessage).toContain('UNREVIEWED');
    writeFileSync(join(repo, 'a.ts'), 'changed again\n');
    expect((s({ hook_event_name: 'Stop' }) as { decision?: string }).decision).toBe('block');
    expect(s({ hook_event_name: 'Stop', stop_hook_active: true })?.systemMessage).toContain(
      'UNREVIEWED'
    );
    s({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer-1', prompt: 'x' },
      tool_response: {},
    });
    expect(s({ hook_event_name: 'Stop' })).toBeNull();
    // 文档改动不计入；首个事件为 Stop 的会话是 unknown。
    writeFileSync(join(repo, 'NOTES.md'), 'x\n');
    expect(s({ hook_event_name: 'Stop' })).toBeNull();
    const unknown = guard('claude', { session_id: 'late', hook_event_name: 'Stop' }) as {
      decision?: string;
      reason?: string;
    };
    expect(unknown.reason).toContain('unknown');
  });

  test('G-3：advisory 只提示；无效取值给出配置提示而不报错', () => {
    const adv = setup(hooksWith({ stop_gate: 'advisory' }));
    adv.guard('claude', { session_id: 'a', hook_event_name: 'SessionStart' });
    writeFileSync(join(adv.repo, 'a.ts'), 'changed\n');
    expect(
      adv.guard('claude', { session_id: 'a', hook_event_name: 'Stop' })?.systemMessage
    ).toContain('UNREVIEWED');
    const bad = setup(hooksWith({ stop_gate: 'strict' }));
    expect(bad.guard('claude', { hook_event_name: 'Stop' })?.systemMessage).toContain(
      'stop_gate=strict 无效'
    );
  });
});

describe('context-budget.cjs', () => {
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
      'context-budget.cjs',
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
        'context-budget.cjs',
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
});
