import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { guardSelftest } from '../src/guard-selftest';
import { agyGuardCommand } from '../src/install-hooks';
import { hookFixtureEnv, tmp } from './helpers';

function check(broken?: { client: 'codex' | 'agy' | 'agy-acp'; source?: string }) {
  const home = tmp();
  const wetamp = join(tmp(), "安装'目录"),
    script = join(wetamp, 'hooks/guard.cjs');
  mkdirSync(dirname(script), { recursive: true });
  if (broken?.source !== undefined) writeFileSync(script, broken.source);
  const env = {
    ...hookFixtureEnv(home),
    PATH: process.env.PATH,
    SUPERAGENT_HOME: join(home, 'sa'),
    ARCHON_HOME: join(home, 'archon'),
  };
  for (const [client, file] of [
    ['claude', '.claude/settings.json'],
    ['codex', '.codex/hooks.json'],
    ['agy', '.gemini/config/hooks.json'],
    ['agy-acp', 'Library/Application Support/orca/antigravity-chat/config/hooks.json'],
  ] as const) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    const command = agyGuardCommand(
      broken?.client === client ? wetamp : join(import.meta.dir, '..')
    ).replace(/ agy$/, ` ${client === 'agy-acp' ? 'agy' : client}`);
    const group = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] };
    const doc = client.startsWith('agy') ? { superagent: group } : { hooks: group };
    writeFileSync(join(home, file), JSON.stringify(doc));
  }
  const before = readdirSync(home, { recursive: true });
  const results = guardSelftest(env);
  expect(readdirSync(home, { recursive: true })).toEqual(before);
  return results;
}

test('真实护栏通过三端探针', () => {
  expect(check().map(({ client, ok }) => (ok ? client : null))).toEqual(['claude', 'codex', 'agy']);
});

test('已配置的 Codex 脚本缺失、无法加载或卡住时仅 Codex 失败', () => {
  for (const [source, reason] of [
    [undefined, '护栏脚本缺失'],
    ['const = ;', '护栏子进程异常退出'],
    ['for (;;) {}', '护栏子进程超时'],
  ] as const) {
    expect(check({ client: 'codex', source }).filter(result => !result.ok)).toEqual([
      { client: 'codex', ok: false, reason },
    ]);
  }
}, 15000);

test('已配置的 agy 脚本错误放行时仅 agy 失败', () => {
  const source = 'console.log(JSON.stringify({ decision: "allow" }));';
  const results = check({ client: 'agy', source });
  expect(results.filter(result => !result.ok)).toEqual([
    { client: 'agy', ok: false, reason: '强制推送未被拒绝' },
  ]);
});

test('Orca ACP 安装位置的护栏失效时 agy 健康检查失败', () => {
  const results = check({ client: 'agy-acp', source: 'console.log("{}");' });
  expect(results.filter(result => !result.ok)).toEqual([
    { client: 'agy', ok: false, reason: 'Orca ACP：无害命令未正常放行' },
  ]);
});
