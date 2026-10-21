import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inheritedTestHomes = {
  superagent: process.env.SUPERAGENT_HOME,
  archon: process.env.ARCHON_HOME,
};
const testHome = mkdtempSync(join(tmpdir(), 'sa-test-home-'));
process.env.SUPERAGENT_HOME = testHome;
process.env.ARCHON_HOME = join(testHome, 'archon');
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
