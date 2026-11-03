import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { alreadySandboxed, tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const INSTALL = join(WETAMP, 'scripts/install.sh');
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function install(home: string, ...args: string[]) {
  const result = Bun.spawnSync(['bash', INSTALL, ...args], {
    env: {
      ...process.env,
      HOME: home,
      SUPERAGENT_HOME: home,
      ARCHON_HOME: join(home, 'archon'),
      SA_LAUNCHD_DIR: join(home, 'LaunchAgents'),
      SA_SKIP_LAUNCHD_RELOAD: '1',
      SA_SKIP_DOCTOR: '1',
      XDG_STATE_HOME: join(home, 'state'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result;
}

const seatbeltTest = test.skipIf(alreadySandboxed());
const seatbeltTitle = alreadySandboxed()
  ? 'real seatbelt skipped: 已在沙箱内，需在普通终端运行'
  : 'real seatbelt denies iCloud and deep _private while allowing ordinary files and nested entry';

describe('ai-jail', () => {
  seatbeltTest(seatbeltTitle, () => {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
    const home = tmp(),
      jail = join(home, '.wetamp/jail'),
      blocked = [
        join(home, 'Library/Mobile Documents/a'),
        join(home, 'Library/CloudStorage/iCloudDrive/a'),
        join(home, 'work/a/_private/b/a'),
      ],
      canaryDir = join(home, 'work/canary/_private'),
      safe = join(home, 'work/public/a');
    for (const file of [...blocked, safe]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'before');
    }
    install(home);
    mkdirSync(canaryDir, { recursive: true });
    writeFileSync(join(canaryDir, 'canary'), 'blocked');
    const run = (...command: string[]) =>
      Bun.spawnSync([join(jail, 'ai-jail'), ...command], {
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    for (const file of blocked) {
      const read = run('/bin/cat', file);
      expect(read.exitCode).not.toBe(0);
      expect(read.stderr.toString()).toMatch(/Operation not permitted/);
      const write = run('/bin/sh', '-c', 'printf changed > "$1"', 'sh', file);
      expect(write.exitCode).not.toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('before');
    }
    const ps = run('/bin/sh', '-c', 'exec /bin/ps -o lstart= -p $$');
    expect(ps.exitCode, ps.stderr.toString()).toBe(0);
    expect(ps.stdout.toString().trim()).not.toBe('');
    const launchctl = run('/bin/launchctl', 'print', `gui/${String(process.getuid?.())}`);
    expect(launchctl.exitCode, launchctl.stderr.toString()).toBe(0);
    const identity = run(
      process.execPath,
      '-e',
      `console.log(JSON.stringify(require(${JSON.stringify(join(WETAMP, 'hooks/identity.cjs'))}).inspect(process.ppid)))`
    );
    expect(identity.exitCode, identity.stderr.toString()).toBe(0);
    expect(JSON.parse(identity.stdout.toString())).toEqual({
      state: 'online',
      start: expect.any(String),
    });
    const probe = run('/bin/cat', join(jail, '.probe'));
    expect(probe.exitCode).not.toBe(0);
    expect(probe.stderr.toString()).toMatch(/Operation not permitted/);
    const sudo = run('/usr/bin/sudo', '-n', 'true');
    expect(sudo.exitCode).not.toBe(0);
    expect(sudo.stderr.toString()).toMatch(/Operation not permitted/);
    expect(run('/bin/cat', safe).stdout.toString()).toBe('before');
    const nested = run(join(jail, 'ai-jail'), '/bin/echo', 'nested');
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.toString().trim()).toBe('nested');
    const canary = run(
      process.execPath,
      join(WETAMP, 'scripts/jail-check.ts'),
      '--canary',
      canaryDir
    );
    expect(canary.exitCode, canary.stderr.toString()).toBe(0);
    expect(canary.stdout.toString()).toContain('node: canary EPERM');
    expect(
      run('/bin/sh', '-c', 'printf x > "$1"', 'sh', join(jail, 'ai-deny.sb')).exitCode
    ).not.toBe(0);
    const disable = run('/bin/bash', INSTALL, '--jail-off');
    expect(disable.exitCode).toBe(126);
    expect(disable.stderr.toString()).toContain('当前在 ai-jail 内');
    expect(existsSync(join(jail, 'installed'))).toBe(true);
  });

  test('installed wrapper fails closed when assets are missing', () => {
    const home = tmp(),
      jail = join(home, '.wetamp/jail'),
      wrapper = join(WETAMP, 'bin/ai-jail');
    mkdirSync(jail, { recursive: true });
    writeFileSync(join(jail, 'installed'), '');
    writeFileSync(join(jail, '.probe'), '');
    const result = Bun.spawnSync([wrapper, '/bin/echo', 'unsafe'], {
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(126);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('沙箱配置缺失');
  });

  test('client shims preserve empty argument lists under macOS bash', () => {
    const root = tmp(),
      home = join(root, 'home'),
      jail = join(home, '.wetamp/jail'),
      realBin = join(root, 'real'),
      output = join(root, 'args.txt'),
      target = join(WETAMP, 'bin/ai-jail-shim');
    mkdirSync(jail, { recursive: true });
    mkdirSync(realBin);
    writeFileSync(join(jail, 'ai-jail'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OUTPUT"\n', {
      mode: 0o755,
    });
    for (const client of ['claude', 'codex']) {
      writeFileSync(join(realBin, client), '#!/bin/sh\n', { mode: 0o755 });
      Bun.spawnSync(['ln', '-s', target, join(root, client)]);
    }
    const cases: [string, string[], string[]][] = [
      ['claude', [], []],
      ['claude', ['x', '', 'y'], ['x', '', 'y']],
      ['codex', [], ['-c', 'sandbox_mode="danger-full-access"']],
      [
        'codex',
        ['--full-auto', '-s', 'read-only', 'x'],
        ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="on-request"', 'x'],
      ],
    ];
    for (const [client, args, expected] of cases) {
      const result = Bun.spawnSync(['/bin/bash', join(root, client), ...args], {
        env: { ...process.env, HOME: home, PATH: `${realBin}:/usr/bin:/bin`, OUTPUT: output },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, 'utf8').split('\n').slice(0, -1)).toEqual([
        join(realBin, client),
        ...expected,
      ]);
    }
  });

  test('Codex shim removes nested sandbox flags and preserves command shape', () => {
    const root = tmp(),
      home = join(root, 'home'),
      jail = join(home, '.wetamp/jail'),
      realBin = join(root, 'real'),
      output = join(root, 'args.json');
    mkdirSync(jail, { recursive: true });
    mkdirSync(realBin);
    for (const file of ['installed', '.probe', 'ai-deny.sb']) writeFileSync(join(jail, file), '');
    writeFileSync(join(jail, 'ai-jail'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(
      join(realBin, 'codex'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(output)}\n`,
      { mode: 0o755 }
    );
    const shim = join(root, 'codex');
    const target = join(WETAMP, 'bin/ai-jail-shim');
    Bun.spawnSync(['ln', '-s', target, shim]);
    const variants = [
      ['exec', 'prompt'],
      ['exec', '-s', 'read-only', 'prompt'],
      ['exec', '--full-auto', 'prompt'],
      ['-c', 'sandbox_mode="danger-full-access"', 'exec', 'prompt'],
    ];
    for (const args of variants) {
      const result = Bun.spawnSync([shim, ...args], {
        env: { ...process.env, HOME: home, PATH: `${realBin}:/usr/bin:/bin` },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const actual = readFileSync(output, 'utf8').trim().split('\n');
      expect(actual).toContain('sandbox_mode="danger-full-access"');
      expect(actual).not.toContain('read-only');
      expect(actual).not.toContain('--full-auto');
      expect(actual).toContain('exec');
      expect(actual.at(-1)).toBe('prompt');
    }
  });

  test('install manages rc blocks idempotently and jail-off removes only managed state', () => {
    const home = tmp(),
      zshrc = join(home, '.zshrc'),
      realBin = join(home, '.opencode/bin'),
      original = 'export KEEP=1\nexport PATH="$HOME/.opencode/bin:$PATH"\n';
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(realBin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(zshrc, original);
    install(home);
    expect(readFileSync(join(home, '.wetamp/jail/ai-deny.sb'), 'utf8')).toContain(
      '(allow process-exec (literal "/bin/launchctl") (with no-sandbox))'
    );
    const first = readFileSync(zshrc, 'utf8');
    expect(first.match(/# >>> superagent ai-jail >>>/g)).toHaveLength(1);
    expect(first.startsWith(original)).toBe(true);
    const shell = Bun.spawnSync(['/bin/zsh', '-ic', 'print -r -- $path[1]; whence -p opencode'], {
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(shell.exitCode, shell.stderr.toString()).toBe(0);
    expect(shell.stdout.toString().trim().split('\n')).toEqual([
      join(home, '.wetamp/jail/bin'),
      join(home, '.wetamp/jail/bin/opencode'),
    ]);
    install(home);
    expect(readFileSync(zshrc, 'utf8')).toBe(first);
    install(home, '--jail-off');
    expect(existsSync(join(home, '.wetamp/jail'))).toBe(false);
    expect(readFileSync(zshrc, 'utf8')).toBe(original);
  });
});
