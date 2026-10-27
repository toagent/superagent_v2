import { expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleTestDirs } from './preload';
test('sweeps only stale test directories without following symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preload-sweep-')),
    now = Date.now(),
    old = new Date(now - 7 * 60 * 60 * 1000),
    stale = join(root, 'sa-test-stale'),
    staleHome = join(root, 'sa-test-home-stale'),
    fresh = join(root, 'sa-test-fresh'),
    other = join(root, 'other-stale'),
    target = join(root, 'kept-target'),
    link = join(root, 'sa-test-link');
  try {
    for (const path of [stale, staleHome, fresh, other, target]) mkdirSync(path);
    mkdirSync(join(stale, 'readonly'));
    writeFileSync(join(stale, 'readonly', 'snapshot'), 'sealed');
    chmodSync(join(stale, 'readonly', 'snapshot'), 0o444);
    chmodSync(join(stale, 'readonly'), 0o555);
    for (const path of [stale, staleHome, other]) utimesSync(path, old, old);
    symlinkSync(target, link);
    sweepStaleTestDirs(root, now);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleHome)).toBe(false);
    for (const path of [fresh, other, target, link]) expect(existsSync(path)).toBe(true);
  } finally {
    await removeTempTree(root);
  }
});
