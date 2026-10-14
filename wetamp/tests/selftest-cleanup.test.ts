import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WETAMP } from '../src/config';
import { tmp } from './helpers';

for (const [name, receipt, code, preserve] of [
  ['failure at exit zero', { ok: false }, 0, true],
  ['unknown empty output', null, 0, true],
  ['unknown subprocess outcome', { ok: true, status: 'cancelled', action: 'abandon' }, 1, true],
  [
    'cleanup warning',
    { ok: true, status: 'cancelled', action: 'abandon', cleanupWarnings: ['busy tree'] },
    0,
    true,
  ],
  [
    'cascade failure',
    { ok: true, status: 'cancelled', action: 'abandon', cascadeFailures: 1 },
    0,
    true,
  ],
  ['confirmed stop', { ok: true, status: 'cancelled', action: 'abandon' }, 0, false],
] as const)
  test(`selftest cleanup preserves diagnostics and trees: ${name}`, () => {
    const root = tmp(),
      scratch = join(root, 'scratch'),
      bin = join(root, 'archon'),
      calls = join(root, 'drop-calls');
    mkdirSync(join(scratch, 'worktree'), { recursive: true });
    writeFileSync(join(scratch, 'payload.json'), receipt ? JSON.stringify(receipt) : '');
    writeFileSync(
      bin,
      `#!/usr/bin/env bash\ncat '${join(scratch, 'payload.json')}'\necho diagnostics >&2\nexit ${code}\n`
    );
    chmodSync(bin, 0o755);
    const script = join(root, 'cleanup.sh');
    writeFileSync(
      script,
      `set -euo pipefail\nkeep=0; ID=r; BR=branch; WT="$TMPH/worktree"\ndrop() { echo dropped >> "$CALLS"; }\nsource "$WETAMP/scripts/selftest-cleanup.sh"\ncleanup\n`
    );
    const p = Bun.spawnSync(['bash', script], {
      env: { ...process.env, TMPH: scratch, WETAMP, A: bin, CALLS: calls },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    expect(existsSync(scratch)).toBe(preserve);
    expect(existsSync(calls)).toBe(!preserve);
    if (preserve) {
      expect(existsSync(join(scratch, 'worktree'))).toBe(true);
      expect(readFileSync(join(scratch, 'cleanup-r.err'), 'utf8')).toContain('diagnostics');
      expect(p.stderr.toString()).toContain(`selftest: kept ${scratch}`);
    }
  });

test('an unknown launch without a run ID preserves the whole scratch home', () => {
  const root = tmp(),
    scratch = join(root, 'scratch'),
    script = join(root, 'cleanup.sh');
  mkdirSync(scratch);
  writeFileSync(
    script,
    `set -euo pipefail\nkeep=0; LAUNCH_INFLIGHT=1\ndrop() { exit 99; }\nsource "$WETAMP/scripts/selftest-cleanup.sh"\ncleanup\n`
  );
  const p = Bun.spawnSync(['bash', script], {
    env: { ...process.env, TMPH: scratch, WETAMP },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.exitCode).toBe(0);
  expect(existsSync(scratch)).toBe(true);
  expect(p.stderr.toString()).toContain('launch outcome unknown');
});
