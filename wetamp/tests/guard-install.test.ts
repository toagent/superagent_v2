import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WETAMP } from '../src/config';
import { installMode } from '../src/install-mode';
import { mergeHooks } from '../src/install-hooks';
import { tmp } from './helpers';
const state = createRequire(import.meta.url)('../hooks/hook-state.cjs') as {
  withLock: <T>(file: string, fn: () => T) => T;
  withState: <T>(file: string, fn: (s: Record<string, unknown>) => T) => T;
};

test('WP-1: preflight reports matching controller/worker ledger and refuses ambiguous mode', () => {
  const old = process.env.XDG_STATE_HOME, root = tmp();
  process.env.XDG_STATE_HOME = root;
  const file = join(root, 'superagent/install.json');
  try {
    expect(installMode()).toBe('controller');
    mkdirSync(join(root, 'superagent'));
    for (const role of ['controller', 'worker'] as const) {
      writeFileSync(file, JSON.stringify({wetamp: WETAMP, role}));
      expect(installMode()).toBe(role);
    }
    writeFileSync(file, JSON.stringify({wetamp: '/another/checkout', role: 'worker'}));
    expect(installMode()).toBe('controller');
    for (const raw of ['{invalid', JSON.stringify({wetamp: WETAMP, role: 'ambiguous'})]) {
      writeFileSync(file, raw);
      expect(() => installMode()).toThrow('mode unknown');
    }
  } finally {
    if (old === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = old;
  }
});

test('A-11: merged hook groups retain user handlers, unrelated fields and all-handler settings', () => {
  const command = `node '${WETAMP}/hooks/guard.cjs' claude`;
  const hooks = {PreToolUse: [
    {matcher: 'Edit', userField: true, hooks: [{command}, {command: 'user-edit-hook', custom: 'retained'}]},
    {hooks: [{command, timeout: 42, userSetting: true}]},
  ]};
  const merged = mergeHooks(hooks, 'claude');
  expect(merged.PreToolUse[0]).toEqual({matcher: 'Edit', userField: true, hooks: [{command: 'user-edit-hook', custom: 'retained'}]});
  const own = merged.PreToolUse.flatMap(g => g.hooks ?? []).filter(h => h.command === command);
  expect(own).toEqual([{command, timeout: 42, userSetting: true}]);
  expect(mergeHooks(merged, 'claude')).toEqual(merged);
});

test('F-12: concurrent hook installation serializes RMW, preserves other config and publishes no fixed .sa-tmp', async () => {
  const root = tmp(), settings = join(root, 'claude/settings.json');
  mkdirSync(join(root, 'claude'));
  writeFileSync(settings, JSON.stringify({userSetting: true, hooks: {PreToolUse: [{matcher: 'Edit', hooks: [{command: 'user-hook'}]}]}}));
  const env = {...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), SUPERAGENT_HOME: join(root, 'sa')};
  const children = Array.from({length: 4}, () => Bun.spawn([process.execPath, join(WETAMP, 'src/install-hooks.ts')], {env, stdout: 'pipe', stderr: 'pipe'}));
  for (const child of children) {
    const [, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    expect(err).toBe('');
  }
  const config = JSON.parse(readFileSync(settings, 'utf8')) as {userSetting: boolean; hooks: {PreToolUse: {hooks: {command: string}[]}[]}};
  expect(config.userSetting).toBe(true);
  const commands = config.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
  expect(commands.filter(c => c.includes('/guard.cjs'))).toHaveLength(1);
  expect(commands).toContain('user-hook');
  expect(readdirSync(join(root, 'claude'))).toEqual(['settings.json']);
});

test('F-12/A-09: a corrupt state is never reset; lock release survives callback failure', () => {
  const file = join(tmp(), 'state.json');
  writeFileSync(file, '{invalid');
  expect(() => state.withState(file, () => null)).toThrow('状态文件损坏');
  expect(readFileSync(file, 'utf8')).toBe('{invalid');
  expect(() => state.withLock(file, () => {throw new Error('write failed');})).toThrow('write failed');
  expect(state.withLock(file, () => 'released')).toBe('released');
});


test('WP-1: direct CLI worker run reports preflight mode and never starts the engine', () => {
  const root = tmp(), file = join(root, 'state/superagent/install.json');
  mkdirSync(join(root, 'state/superagent'), {recursive: true});
  writeFileSync(file, JSON.stringify({wetamp: WETAMP, role: 'worker'}));
  const p = Bun.spawnSync([process.execPath, join(WETAMP, 'src/cli.ts'), 'run', join(root, 'missing-plan.json'), '--skip-selftest'], {
    env: {...process.env, XDG_STATE_HOME: join(root, 'state'), SUPERAGENT_HOME: join(root, 'sa'), ARCHON_HOME: join(root, 'sa/archon')},
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(p.exitCode).toBe(1);
  const out = JSON.parse(p.stdout.toString()) as {phase: string; mode: string; reason: string};
  expect(out).toMatchObject({phase: 'preflight', mode: 'worker'});
  expect(out.reason).toContain('run requires the controller');
  expect(readdirSync(join(root, 'sa'))).toEqual(['launch-failures']);
});


test('F-12: even an old live-owner lock is never stolen or released by a contender', () => {
  const file = join(tmp(), 'state.json'), lock = `${file}.lock`;
  writeFileSync(lock, String(process.pid));
  const oldTime = new Date(Date.now() - 60_000);
  utimesSync(lock, oldTime, oldTime);
  const now = Date.now; let calls = 0;
  Date.now = () => ++calls === 1 ? 0 : 10_000;
  try {
    expect(() => state.withLock(file, () => {throw new Error('stolen');})).toThrow('状态锁忙');
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  } finally { Date.now = now; }
});
