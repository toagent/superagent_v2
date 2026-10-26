import { expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../helpers';

test('S15: carried evidence without its persisted-byte hash fails the real scenario', () => {
  const repo = join(import.meta.dir, '../../..'),
    root = join(tmp(), 'repo'),
    wetamp = join(root, 'wetamp');
  cpSync(repo, root, {
    recursive: true,
    filter: source =>
      !source.includes('/node_modules') && !source.includes('/.git/') && !source.endsWith('/.git'),
  });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  symlinkSync(join(repo, 'wetamp/node_modules'), join(wetamp, 'node_modules'));
  for (const name of readdirSync(join(repo, 'packages')))
    if (existsSync(join(repo, 'packages', name, 'node_modules')))
      symlinkSync(
        join(repo, 'packages', name, 'node_modules'),
        join(root, 'packages', name, 'node_modules')
      );
  const path = join(wetamp, 'templates/.archon/scripts/sa-check.ts'),
    source = readFileSync(path, 'utf8'),
    from = 'emit({ ...out, artifact_sha256: sha(serialized) });',
    to = "emit({ ...out, artifact_sha256: '' });";
  expect(source.split(from)).toHaveLength(3);
  const carried = source.indexOf(from);
  writeFileSync(path, `${source.slice(0, carried)}${to}${source.slice(carried + from.length)}`);
  for (const args of [
    ['init', '-q'],
    ['config', 'core.hooksPath', '/dev/null'],
    ['add', 'wetamp', 'packages', 'package.json', 'bun.lock'],
    [
      '-c',
      'user.name=scenario',
      '-c',
      'user.email=scenario@local',
      'commit',
      '-qm',
      'S15 mutation',
    ],
  ]) {
    const git = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
  }
  const result = Bun.spawnSync(
    [
      process.execPath,
      'test',
      '--timeout',
      '240000',
      'tests/scenarios/scenario-engine.test.ts',
      '-t',
      'S15',
    ],
    {
      cwd: wetamp,
      env: { ...process.env, SCENARIO_EXPECT_CARRIED_MUTATION: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 300_000,
    }
  );
  const failure = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  expect(result.exitCode).not.toBe(0);
  expect(failure).toContain('"nodeId":"code-p","when"');
  expect(failure).toContain('"nodeId":"verify-p"');
}, 360_000);
