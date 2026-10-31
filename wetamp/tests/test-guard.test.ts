import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';

const script = join(import.meta.dir, '../scripts/test.sh');

test('complete suite requires an sa-check ancestor in a general worktree', () => {
  const root = tmp(),
    cwd = join(root, 'worktrees/sa/run/wetamp'),
    bin = join(root, 'bin');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SA_ACCEPTANCE: '1',
    SA_HEAVY_LOCK_HELD: '1',
  };
  const blocked = Bun.spawnSync(['sh', script], { cwd, env, stderr: 'pipe' });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr.toString()).toContain('完整套件由引擎验收运行');
  expect(Bun.spawnSync(['sh', script, 'tests/one.test.ts'], { cwd, env }).exitCode).toBe(0);
  const allowed = Bun.spawnSync(
    ['sh', '-c', 'sh "$1" & wait', '.archon/scripts/sa-check.ts', script],
    { cwd, env, stderr: 'pipe' }
  );
  expect(allowed.exitCode).toBe(0);
});
