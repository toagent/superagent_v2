import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
const track = trackTempRoots(),
  source = join(import.meta.dir, '..', 'scripts', 'codex-trust.cjs');
const git = (cwd: string, ...args: string[]) =>
  expect(Bun.spawnSync(['git', '-C', cwd, ...args]).exitCode).toBe(0);
test('check trusts only the current or main-worktree guard with the matching hash', () => {
  const root = realpathSync(track(mkdtempSync(join(tmpdir(), 'codex-trust-')))),
    main = join(root, 'main'),
    linked = join(root, 'linked'),
    codex = join(root, 'codex'),
    other = join(root, 'other');
  mkdirSync(join(main, 'wetamp/scripts'), { recursive: true });
  mkdirSync(join(main, 'wetamp/hooks'));
  cpSync(source, join(main, 'wetamp/scripts/codex-trust.cjs'));
  writeFileSync(join(main, 'wetamp/hooks/guard.cjs'), '');
  mkdirSync(join(other, 'wetamp/scripts'), { recursive: true });
  mkdirSync(join(other, 'wetamp/hooks'));
  cpSync(source, join(other, 'wetamp/scripts/codex-trust.cjs'));
  git(other, 'init', '-q');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-qb', 'linked', linked);
  mkdirSync(codex);
  const run = (repo: string, command: string) =>
    Bun.spawnSync(['bun', join(repo, 'wetamp/scripts/codex-trust.cjs'), command], {
      env: { ...process.env, CODEX_HOME: codex },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const trust = (repo: string) => {
    const command = `node '${join(repo, 'wetamp/hooks/guard.cjs')}' codex`;
    writeFileSync(
      join(codex, 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } })
    );
    expect(run(repo, 'write').exitCode).toBe(0);
  };
  trust(main);
  const pass = run(linked, 'check');
  expect(pass.exitCode, pass.stderr.toString()).toBe(0);
  trust(other);
  expect(run(linked, 'check').exitCode).toBe(1);
  trust(main);
  const config = join(codex, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace(/sha256:[0-9a-f]+/, 'sha256:bad'));
  expect(run(linked, 'check').exitCode).toBe(1);
});
