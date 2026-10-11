import { expect, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  utimesSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WETAMP } from '../src/config';
import { installMode } from '../src/install-mode';
import { mergeHooks } from '../src/install-hooks';
import { Coordination, caller, repoScope } from '../src/coord';
import { fixturePlan, gitRepo, tmp } from './helpers';
const state = createRequire(import.meta.url)('../hooks/hook-state.cjs') as {
  withLock: <T>(file: string, fn: () => T) => T;
  withState: <T>(file: string, fn: (s: Record<string, unknown>) => T) => T;
};

test('WP-1: preflight reports matching controller/worker ledger and refuses ambiguous mode', () => {
  const old = process.env.XDG_STATE_HOME,
    root = tmp();
  process.env.XDG_STATE_HOME = root;
  const file = join(root, 'superagent/install.json');
  try {
    expect(installMode()).toBe('controller');
    mkdirSync(join(root, 'superagent'));
    for (const role of ['controller', 'worker'] as const) {
      writeFileSync(file, JSON.stringify({ wetamp: WETAMP, role }));
      expect(installMode()).toBe(role);
    }
    writeFileSync(file, JSON.stringify({ wetamp: '/another/checkout', role: 'worker' }));
    expect(installMode()).toBe('controller');
    for (const raw of ['{invalid', JSON.stringify({ wetamp: WETAMP, role: 'ambiguous' })]) {
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
  const hooks = {
    PreToolUse: [
      {
        matcher: 'Edit',
        userField: true,
        hooks: [{ command }, { command: 'user-edit-hook', custom: 'retained' }],
      },
      { hooks: [{ command, timeout: 42, userSetting: true }] },
    ],
  };
  const merged = mergeHooks(hooks, 'claude');
  expect(merged.PreToolUse[0]).toEqual({
    matcher: 'Edit',
    userField: true,
    hooks: [{ command: 'user-edit-hook', custom: 'retained' }],
  });
  const own = merged.PreToolUse.flatMap(g => g.hooks ?? []).filter(h => h.command === command);
  expect(own).toEqual([{ command, timeout: 42, userSetting: true }]);
  expect(mergeHooks(merged, 'claude')).toEqual(merged);
});

test('obsolete scratch SessionEnd is removed while user hooks are preserved', () => {
  const user = { hooks: [{ command: 'user-session-end', custom: true }] };
  const hooks = {
    SessionEnd: [user, { hooks: [{ command: `node '${WETAMP}/hooks/scratch.cjs' claude` }] }],
  };
  const merged = mergeHooks(hooks, 'claude');
  expect(merged.SessionEnd[0]).toEqual(user);
  const commands = merged.SessionEnd.flatMap(g => g.hooks ?? []).map(h => h.command);
  expect(commands).toEqual(['user-session-end']);
  expect(mergeHooks({}, 'claude').SessionEnd).toBeUndefined();
  expect(mergeHooks(merged, 'claude')).toEqual(merged);
  expect(mergeHooks({}, 'codex').SessionEnd).toBeUndefined();
});

test('F-12: concurrent hook installation serializes RMW, preserves other config and publishes no fixed .sa-tmp', async () => {
  const root = tmp(),
    settings = join(root, 'claude/settings.json');
  mkdirSync(join(root, 'claude'));
  writeFileSync(
    settings,
    JSON.stringify({
      userSetting: true,
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'user-hook' }] }] },
    })
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    SUPERAGENT_HOME: join(root, 'sa'),
  };
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, join(WETAMP, 'src/install-hooks.ts')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  );
  for (const child of children) {
    const [, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    expect(err).toBe('');
  }
  const config = JSON.parse(readFileSync(settings, 'utf8')) as {
    userSetting: boolean;
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  expect(config.userSetting).toBe(true);
  const commands = config.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
  expect(commands.filter(c => c.includes('/guard.cjs'))).toHaveLength(1);
  expect(commands).toContain('user-hook');
  expect(readdirSync(join(root, 'claude')).sort()).toEqual(['settings.json', 'settings.json.lock']);
});

test('F-12/A-09: a corrupt state is never reset; lock release survives callback failure', () => {
  const file = join(tmp(), 'state.json');
  writeFileSync(file, '{invalid');
  expect(() => state.withState(file, () => null)).toThrow('状态文件损坏');
  expect(readFileSync(file, 'utf8')).toBe('{invalid');
  expect(() =>
    state.withLock(file, () => {
      throw new Error('write failed');
    })
  ).toThrow('write failed');
  expect(state.withLock(file, () => 'released')).toBe('released');
});

test('WP-1: direct CLI worker run reports preflight mode and never starts the engine', () => {
  const root = tmp(),
    file = join(root, 'state/superagent/install.json');
  mkdirSync(join(root, 'state/superagent'), { recursive: true });
  writeFileSync(file, JSON.stringify({ wetamp: WETAMP, role: 'worker' }));
  const p = Bun.spawnSync(
    [
      process.execPath,
      join(WETAMP, 'src/cli.ts'),
      'run',
      join(root, 'missing-plan.json'),
      '--skip-selftest',
    ],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: join(root, 'state'),
        SUPERAGENT_HOME: join(root, 'sa'),
        ARCHON_HOME: join(root, 'sa/archon'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(p.exitCode).toBe(1);
  const out = JSON.parse(p.stdout.toString()) as { phase: string; mode: string; reason: string };
  expect(out).toMatchObject({ phase: 'preflight', mode: 'worker' });
  expect(out.reason).toContain('run requires the controller');
  expect(readdirSync(join(root, 'sa'))).toEqual(['launch-failures']);
});

test('WP-1: plan parsing and foreign-owner failures retain JSON launch-failure evidence', () => {
  const root = tmp(),
    sa = join(root, 'sa'),
    repo = gitRepo(root);
  mkdirSync(sa);
  const badJson = join(root, 'bad-json.json'),
    badSchema = join(root, 'bad-schema.json');
  writeFileSync(badJson, '{invalid');
  writeFileSync(badSchema, '{}');
  const ownedPlan = fixturePlan(root, repo);
  new Coordination({ sa, runs: () => [] }).claim(repoScope(repo), {
    ...caller(),
    client: 'claude',
    session_id: 'foreign-owner',
  });
  for (const [plan, reason] of [
    [join(root, 'missing-plan.json'), 'ENOENT'],
    [badJson, 'JSON'],
    [badSchema, 'plan invalid'],
    [ownedPlan, '普通认领'],
  ] as const) {
    const p = Bun.spawnSync(
      [process.execPath, join(WETAMP, 'src/cli.ts'), 'run', plan, '--skip-selftest', '--json'],
      {
        env: {
          ...process.env,
          HOME: root,
          XDG_STATE_HOME: join(root, 'state'),
          SUPERAGENT_HOME: sa,
          ARCHON_HOME: join(sa, 'archon'),
          SUPERAGENT_WRITE_ROOTS: root,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(p.exitCode).toBe(1);
    const out = JSON.parse(p.stdout.toString()) as {
      run_id: string;
      ok: boolean;
      phase: string;
      mode: string;
      reason: string;
    };
    expect(out).toMatchObject({ ok: false, phase: 'preflight', mode: 'controller' });
    expect(out.reason).toContain(reason);
    expect(
      JSON.parse(readFileSync(join(sa, 'launch-failures', `${out.run_id}.json`), 'utf8'))
    ).toEqual(out);
  }
  expect(existsSync(join(sa, 'runs'))).toBe(false);
  expect(existsSync(join(sa, 'intents'))).toBe(false);
});

test('F-12: even an old live-owner lock is never stolen or released by a contender', async () => {
  const root = tmp(),
    file = join(root, 'state.json'),
    lock = `${file}.lock`,
    ready = join(root, 'ready');
  const hook = join(WETAMP, 'hooks/hook-state.cjs');
  const owner = Bun.spawn(
    [
      'node',
      '-e',
      `const fs=require('node:fs');
    require(${JSON.stringify(hook)}).withLock(${JSON.stringify(file)}, () => {
      fs.writeFileSync(${JSON.stringify(lock)}, String(process.pid));
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
    });`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    const inode = statSync(lock).ino,
      contents = readFileSync(lock, 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lock, oldTime, oldTime);
    expect(() =>
      state.withLock(file, () => {
        throw new Error('stolen');
      })
    ).toThrow('状态锁忙');
    expect(readFileSync(lock, 'utf8')).toBe(contents);
    expect(statSync(lock).ino).toBe(inode);
  } finally {
    owner.kill('SIGKILL');
    await owner.exited;
  }
  expect(state.withLock(file, () => 'released')).toBe('released');
}, 15000);
