import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { WETAMP } from '../src/config';
import { agyChatHooksFile, mergeHooks, openCodeGuard } from '../src/install-hooks';
import { hookFixtureEnv, tmp } from './helpers';

const track = trackTempRoots();
const installer = join(WETAMP, 'src/install-hooks.ts');
const accountHome = Bun.spawnSync(['node', '-p', 'require("node:os").userInfo().homedir'])
  .stdout.toString()
  .trimEnd();

test('临时 HOME 的 Orca 安装忽略继承的外部目录', () => {
  const env = hookFixtureEnv(tmp());
  const external = hookFixtureEnv(tmp()).ORCA_USER_DATA_PATH;
  const chatFile = (data: string) => join(data, 'antigravity-chat/config/hooks.json');
  for (const data of [env.ORCA_USER_DATA_PATH, external])
    mkdirSync(dirname(chatFile(data)), { recursive: true });
  const overrides = { ...env, ORCA_USER_DATA_PATH: external };
  const p = Bun.spawnSync([process.execPath, installer, '--only', 'agy'], {
    env: { ...process.env, ...overrides },
    stderr: 'pipe',
  });
  expect(p.exitCode, p.stderr.toString()).toBe(0);
  expect(existsSync(chatFile(external))).toBe(false);
  expect(existsSync(chatFile(env.ORCA_USER_DATA_PATH))).toBe(true);
  expect(agyChatHooksFile(env.HOME, { ORCA_USER_DATA_PATH: '' })).toBe(
    chatFile(env.ORCA_USER_DATA_PATH)
  );
  expect(agyChatHooksFile(accountHome, overrides)).toBe(chatFile(external));
});

test('临时来源在真实用户主目录内创建配置和锁之前拒绝写入', () => {
  const root = track(mkdtempSync(join(accountHome, 'sa-test-hooks-')));
  const codex = join(root, 'codex');
  const p = Bun.spawnSync([process.execPath, installer, '--only', 'codex'], {
    env: { ...process.env, ...hookFixtureEnv(tmp()), CODEX_HOME: codex, TMPDIR: WETAMP },
    stderr: 'pipe',
  });
  expect(p.stderr.toString()).toContain('拒绝将临时护栏');
  expect(p.exitCode).not.toBe(0);
  expect(existsSync(codex)).toBe(false);
});

test('Codex context advisory hooks are complete and idempotent', () => {
  const once = mergeHooks({}, 'codex'),
    command = `node '${WETAMP}/hooks/context-advisory.cjs' codex`;
  for (const event of ['UserPromptSubmit', 'PreToolUse'])
    expect(
      once[event].flatMap(group => group.hooks ?? []).filter(hook => hook.command === command)
    ).toHaveLength(1);
  expect(mergeHooks(once, 'codex')).toEqual(once);
  expect(openCodeGuard()).toContain('scanner.scanText(item, { keyValues: false })');
});
