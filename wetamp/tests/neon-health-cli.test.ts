import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';

test('models 显示 Neon 冷却原因，models 与 health 输出同一份 JSON 状态', () => {
  const home = tmp();
  const at = new Date().toISOString();
  const neon = {
    state: 'down',
    observed_at: at,
    changed_at: at,
    probe_failures: 0,
    next_probe_at: new Date(Date.now() + 300_000).toISOString(),
    cause: { source: 'dispatch', class: 'transient', retries: 0 },
  };
  writeFileSync(join(home, 'agy-health.json'), JSON.stringify(neon));
  const run = (...args: string[]) =>
    Bun.spawnSync(
      [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), ...args],
      {
        cwd: home,
        env: {
          HOME: home,
          TMPDIR: home,
          ARCHON_HOME: home,
          SUPERAGENT_HOME: home,
          PATH: '/usr/bin:/bin',
          SA_ARCHON_BIN: '/usr/bin/true',
          GIT_CONFIG_NOSYSTEM: '1',
          SUPERAGENT_RELAY_QUOTA: 'off',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    ).stdout.toString();
  expect(run('models')).toMatch(/Neon 冷却至 .*，跳过 Neon 候选/);
  expect(JSON.parse(run('models', '--json')).route_state.agy).toEqual(neon);
  for (const flags of [[], ['--json']])
    expect(JSON.parse(run('health', ...flags)).neon_health).toEqual(neon);
});
