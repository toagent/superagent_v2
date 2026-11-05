import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';

const wetamp = join(import.meta.dir, '..');
const cli = join(wetamp, 'src/cli.ts');

// prettier-ignore
test('真实 export 对管道和普通文件完整写出大 JSON', async () => {
  const root = tmp(), home = join(root, 'home'), repo = join(root, 'repo');
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(home, 'jobs')); mkdirSync(join(home, 'archon')); mkdirSync(repo);
  Bun.spawnSync(['git', '-C', repo, 'init', '-q']);
  const title = 'x'.repeat(900);
  for (let i = 0; i < 5_000; i++) writeFileSync(join(home, 'jobs', `${i}.json`), JSON.stringify({
    id: String(i), title, cwd: repo, state: 'done', started_at: '2026-11-04T01:00:00Z', ended_at: '2026-11-04T02:00:00Z',
  }));
  const args = [process.execPath, cli, 'export', '--source-instance', 'fixture', '--since', '2026-11-04T00:00:00Z', '--until', '2026-11-05T00:00:00Z', '--timezone', 'UTC', '--all-repos', '--json'];
  const env = { ...process.env, SUPERAGENT_HOME: home, ARCHON_HOME: join(home, 'archon') };
  const piped = Bun.spawnSync(args, { cwd: wetamp, env, stdout: 'pipe', stderr: 'pipe' });
  const output = join(root, 'export.json');
  const redirected = Bun.spawn(args, { cwd: wetamp, env, stdout: Bun.file(output), stderr: 'pipe' });
  const redirectedExit = await redirected.exited, file = readFileSync(output);
  expect([piped.exitCode, redirectedExit]).toEqual([3, 3]);
  expect(piped.stdout.byteLength).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(piped.stdout.byteLength).toBe(file.byteLength);
  expect(() => JSON.parse(piped.stdout.toString())).not.toThrow();
  expect(() => JSON.parse(file.toString())).not.toThrow();
});

// prettier-ignore
test('exitCli 排空 stdout 和 stderr 并保留退出码', () => {
  const root = tmp(), script = join(root, 'exit.ts'), payload = 4 * 1024 * 1024;
  writeFileSync(script, `import { exitCli } from ${JSON.stringify(cli)}; const value = 'x'.repeat(${payload}); process.stdout.write(value); process.stderr.write(value); await exitCli(7);`);
  const result = Bun.spawnSync([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  expect([result.exitCode, result.stdout.byteLength, result.stderr.byteLength]).toEqual([7, payload, payload]);
});
