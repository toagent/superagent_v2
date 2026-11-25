import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agyChatHooksFile, agyTerminalAvailable, configuredGuard } from './install-hooks';
// prettier-ignore
export function guardSelftest(env = process.env) {
  const home = env.HOME === undefined || env.HOME === '' ? homedir() : env.HOME;
  const probe = (client: 'claude' | 'codex' | 'agy', acp = false) => {
    const failed = (reason: string) => ({ client, ok: false as const, reason: acp ? `Orca ACP：${reason}` : reason });
    let cwd: string | undefined;
    try {
      const script = configuredGuard(client, env, acp);
      if (!script || !existsSync(script)) return failed(script ? '护栏脚本缺失' : '未配置受管 PreToolUse 护栏');
      cwd = mkdtempSync(join(tmpdir(), 'sa-guard-selftest-'));
      const isolated = { PATH: env.PATH, HOME: cwd, TMPDIR: cwd, SUPERAGENT_HOME: cwd, ARCHON_HOME: cwd, GIT_CEILING_DIRECTORIES: dirname(cwd) };
      for (const [command, deny] of [['echo ok', false], ['git push --force', true]] as const) {
        const tool = client === 'claude'
          ? { tool_name: 'Bash', tool_input: { command } }
          : { tool_name: 'exec_command', tool_input: { cmd: command } };
        const payload = client === 'agy'
          ? {
              ...(acp ? {} : { cwd, hookEventName: 'PreToolUse' }),
              toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } },
            }
          : { cwd, session_id: 'guard-selftest', hook_event_name: 'PreToolUse', ...tool };
        const result = spawnSync('node', [script, client], {
          cwd, env: isolated, input: JSON.stringify(payload), encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
        });
        if (result.status !== 0)
          return failed((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? '护栏子进程超时' : '护栏子进程异常退出');
        const out = JSON.parse(result.stdout.trim() || '{}') as { decision?: unknown; systemMessage?: unknown; continue?: unknown; hookSpecificOutput?: { permissionDecision?: unknown } } | null;
        if (!out || typeof out !== 'object' || Array.isArray(out) || result.stderr.trim()) return failed('护栏输出异常');
        const permission = client === 'agy' ? out.decision : out.hookSpecificOutput?.permissionDecision;
        const allowed = client === 'agy' ? permission === 'allow'
          : !out.systemMessage && !out.decision && out.continue !== false && permission !== 'deny';
        if (deny ? permission !== 'deny' : !allowed) return failed(deny ? '强制推送未被拒绝' : '无害命令未正常放行');
      }
      return { client, ok: true as const };
    } catch {
      return failed('无法读取护栏配置或解析探针结果');
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    }
  };
  return (['claude', 'codex', 'agy'] as const).map(client => {
    if (client !== 'agy') return probe(client);
    try {
      if (!agyChatHooksFile(home, env)) return probe(client);
      const chat = probe(client, true);
      return chat.ok && agyTerminalAvailable(home, env) ? probe(client) : chat;
    } catch {
      return { client, ok: false as const, reason: '无法检查 agy 安装位置' };
    }
  });
}
