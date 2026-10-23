// prettier-ignore
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 6 * 60 * 60 * 1000;
function makeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}
export function sweepStaleTestDirs(root: string, now = Date.now()): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^sa-test-(?:home-)?/.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      if (lstatSync(path).mtimeMs >= now - STALE_MS) continue;
      makeWritable(path);
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      console.warn(`stale test cleanup failed for ${path}: ${String(error)}`);
    }
  }
}

export const inheritedTestHomes = {
  superagent: process.env.SUPERAGENT_HOME,
  archon: process.env.ARCHON_HOME,
};
sweepStaleTestDirs(tmpdir());
const testHome = mkdtempSync(join(tmpdir(), 'sa-test-home-'));
export const isolatedTestHomes = {
  superagent: testHome,
  archon: join(testHome, 'archon'),
};
process.env.SUPERAGENT_HOME = isolatedTestHomes.superagent;
process.env.ARCHON_HOME = isolatedTestHomes.archon;
mkdirSync(process.env.ARCHON_HOME);
process.once('exit', () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch (error) {
    console.warn(`test home cleanup failed: ${String(error)}`);
  }
});

// Empty values prevent Bun children from restoring derived identities from .env.
for (const key of [
  'SUPERAGENT_ROLE',
  'SA_JOB_ID',
  'SA_JOB_CARD',
  'SA_JOB_REQUEST_REF',
  'AI_DISPATCH_ROLE',
  'TWIN_AGENT_REMOTE',
])
  process.env[key] = '';
