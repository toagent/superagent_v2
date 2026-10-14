import { expect, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  utimesSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WETAMP } from '../src/config';
import { installMode } from '../src/install-mode';
import { mergeHooks, openCodeGuard } from '../src/install-hooks';
import { Coordination, caller, repoScope } from '../src/coord';
import { fixturePlan, gitRepo, tmp } from './helpers';
const state = createRequire(import.meta.url)('../hooks/hook-state.cjs') as {
  withLock: <T>(file: string, fn: () => T) => T;
  withState: <T>(file: string, fn: (s: Record<string, unknown>) => T) => T;
};

// Child HOME must be set before module loading; never inherit the operator's installation.
function stableInstallation(root: string): string {
  const wetamp = join(root, 'permanent/wetamp');
  mkdirSync(join(root, 'permanent/.git'), { recursive: true });
  mkdirSync(join(wetamp, 'hooks'), { recursive: true });
  mkdirSync(join(wetamp, 'bin'), { recursive: true });
  mkdirSync(join(root, '.local/bin'), { recursive: true });
  writeFileSync(join(wetamp, 'bin/superagent'), '# fixture');
  writeFileSync(join(wetamp, 'hooks/git-guardrail.cjs'), '// fixture');
  symlinkSync(join(wetamp, 'bin/superagent'), join(root, '.local/bin/superagent'));
  return join(wetamp, 'hooks/git-guardrail.cjs');
}

test('OpenCode adapter preserves native payload, cwd and session for both event shapes', async () => {
  const root = tmp(),
    captured = join(root, 'payload.json'),
    guard = join(root, 'guard.cjs');
  writeFileSync(
    guard,
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(captured)}, fs.readFileSync(0)); process.stderr.write('fixture denied'); process.exitCode = 2;`
  );
  const adapter = join(root, 'adapter.mjs');
  writeFileSync(adapter, openCodeGuard(guard));
  const { default: plugin } = await import(adapter);
  const hooks = await plugin({ directory: root });
  for (const native of [true, false]) {
    const args = { script: 'git push', directory: root, custom: { retained: true } };
    const input = {
      tool: 'bash',
      sessionID: 'session-42',
      callID: 'call-7',
      ...(native ? {} : { args }),
    };
    await expect(
      hooks['tool.execute.before'](input, native ? { args } : undefined)
    ).rejects.toThrow('fixture denied');
    expect(JSON.parse(readFileSync(captured, 'utf8'))).toEqual({
      ...input,
      session_id: 'session-42',
      cwd: root,
      tool_name: 'bash',
      tool_input: { ...args, command: 'git push' },
    });
  }
});

test('three Git adapters share classification without executing the proposed command', async () => {
  const require = createRequire(import.meta.url);
  await require('../hooks/redline.cjs').init();
  const guard = require('../hooks/guard.cjs');
  const root = tmp();
  for (const command of ['git push --force', 'git reset --hard', 'git status']) {
    const decisions = ['claude', 'codex'].map(client =>
      Boolean(
        guard.decide(
          {
            hook_event_name: 'PreToolUse',
            cwd: root,
            tool_name: client === 'claude' ? 'Bash' : 'exec_command',
            tool_input: { command },
          },
          client,
          { ...process.env, HOME: root, SUPERAGENT_HOME: root, SUPERAGENT_ROLE: 'general' }
        )?.hookSpecificOutput?.permissionDecision === 'deny'
      )
    );
    const p = Bun.spawnSync(['node', join(WETAMP, 'hooks/git-guardrail.cjs')], {
      stdin: Buffer.from(
        JSON.stringify({
          cwd: root,
          session_id: 'oc-session',
          args: { script: command, directory: root },
        })
      ),
      env: { ...process.env, HOME: root, SUPERAGENT_HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(command === 'git status' ? 0 : 2);
    expect(decisions).toEqual([p.exitCode === 2, p.exitCode === 2]);
  }
  for (const command of [
    'git push',
    'git -C /tmp add -A',
    'git add --al .',
    'git add --no-ignore-removal .',
    'git add --no-ignore-rem .',
    'git commit --no-verify',
    'git commit --no-verif -m x',
  ]) {
    const p = Bun.spawnSync(['node', join(WETAMP, 'hooks/git-guardrail.cjs')], {
      stdin: Buffer.from(JSON.stringify({ cwd: root, tool_input: { command } })),
      env: { ...process.env, HOME: root, SUPERAGENT_HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
  }
});

test('installer migrates OpenCode and wrapper only in isolated HOME; dry-run and replay are safe', () => {
  const root = tmp(),
    plugin = join(root, '.config/opencode/plugins/git-guardrail.js');
  const wrapper = join(root, '.wetamp/bin/git-guardrail.sh');
  mkdirSync(join(plugin, '..'), { recursive: true });
  mkdirSync(join(wrapper, '..'), { recursive: true });
  writeFileSync(plugin, '// git-guardrail.sh\nexport const GitGuardrailPlugin = 1;\n');
  writeFileSync(wrapper, '# git-guardrail.sh\nexec python3 legacy.py\n');
  const settings = join(root, '.claude/settings.json');
  mkdirSync(join(settings, '..'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ userSetting: 'native', hooks: {} }));
  const guard = stableInstallation(root);
  const before = readFileSync(plugin, 'utf8');
  const install = (args: string[]) =>
    Bun.spawnSync([process.execPath, join(WETAMP, 'src/install-hooks.ts'), ...args], {
      env: {
        ...process.env,
        HOME: root,
        SUPERAGENT_HOME: join(root, 'sa'),
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
        CODEX_HOME: join(root, '.codex'),
        OPENCODE_CONFIG_DIR: join(root, '.config/opencode'),
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_STATE_HOME: join(root, '.local/state'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  expect(install(['--dry-run']).exitCode).toBe(0);
  expect(readFileSync(plugin, 'utf8')).toBe(before);
  expect(existsSync(join(root, 'sa/backups'))).toBe(false);
  const installed = install([]);
  expect(installed.stderr.toString()).toBe('');
  expect(installed.exitCode).toBe(0);
  expect(readFileSync(plugin, 'utf8')).toBe(openCodeGuard(guard));
  expect(readFileSync(wrapper, 'utf8')).toContain('git-guardrail.cjs');
  expect(statSync(wrapper).mode & 0o100).toBe(0o100);
  expect(JSON.parse(readFileSync(settings, 'utf8')).userSetting).toBe('native');
  expect(install([]).stdout.toString()).toBe('hooks: no changes\n');
  expect(install(['--dry-run']).stdout.toString()).toBe('hooks: no changes\n');
});

test('OpenCode advisory is logged; malformed output or missing log channel rejects explicitly', async () => {
  const root = tmp(),
    guard = join(root, 'advisory.cjs'),
    adapter = join(root, 'adapter.mjs');
  writeFileSync(
    guard,
    `process.stdout.write(JSON.stringify({systemMessage: 'fixture advisory'}));`
  );
  writeFileSync(adapter, openCodeGuard(guard));
  const { default: plugin } = await import(adapter);
  const notices: unknown[] = [];
  const hooks = await plugin({
    client: { app: { log: async (notice: unknown) => notices.push(notice) } },
  });
  const input = { tool: 'bash', args: { command: 'echo safe' } };
  await hooks['tool.execute.before'](input);
  expect(notices).toEqual([
    { body: { service: 'superagent', level: 'warn', message: 'fixture advisory' } },
  ]);
  await expect((await plugin())['tool.execute.before'](input)).rejects.toThrow(
    'advisory unavailable'
  );
  writeFileSync(guard, `process.stdout.write('invalid');`);
  await expect(hooks['tool.execute.before'](input)).rejects.toThrow('advisory unavailable');
});

test('installer refuses a worktree source before writing any global adapter', () => {
  const root = tmp();
  stableInstallation(root);
  const dotgit = join(root, 'permanent/.git');
  // Recreate only this fixture's .git as a worktree pointer.
  require('node:fs').rmdirSync(dotgit);
  writeFileSync(dotgit, 'gitdir: /fixture/worktrees/temporary');
  const p = Bun.spawnSync([process.execPath, join(WETAMP, 'src/install-hooks.ts')], {
    env: {
      ...process.env,
      HOME: root,
      XDG_STATE_HOME: join(root, 'state'),
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      CODEX_HOME: join(root, '.codex'),
      OPENCODE_CONFIG_DIR: join(root, '.config/opencode'),
      SUPERAGENT_HOME: join(root, 'sa'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.exitCode).not.toBe(0);
  expect(p.stderr.toString()).toContain('permanent checkout');
  expect(existsSync(join(root, '.config/opencode'))).toBe(false);
  expect(existsSync(join(root, '.claude'))).toBe(false);
});

test('INTAKE_NATIVE installer registers both native events idempotently and preserves user hooks', () => {
  for (const client of ['claude', 'codex'] as const) {
    const user = { hooks: [{ command: 'user-prompt-hook', timeout: 77 }], userField: true };
    const merged = mergeHooks({ UserPromptSubmit: [user] }, client);
    expect(merged.UserPromptSubmit).toContainEqual(user);
    for (const event of ['UserPromptSubmit', 'SessionStart'])
      expect(
        merged[event]
          .flatMap(g => g.hooks ?? [])
          .filter(h => h.command === `node '${WETAMP}/hooks/intake.cjs' ${client}`)
      ).toHaveLength(1);
    expect(mergeHooks(merged, client)).toEqual(merged);
  }
});

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
  stableInstallation(root);
  const env = {
    ...process.env,
    HOME: root,
    OPENCODE_CONFIG_DIR: join(root, '.config/opencode'),
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_STATE_HOME: join(root, '.local/state'),
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
