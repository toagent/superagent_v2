import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
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

function run(file: string, client: string, payload: object, env: Record<string, string>): Out {
  const p = Bun.spawnSync(['node', join(HOOKS, file), client], {
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

function setup(): {
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
      }
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
