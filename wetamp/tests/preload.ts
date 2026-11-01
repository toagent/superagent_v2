import { afterAll, afterEach } from 'bun:test';
// prettier-ignore
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

export const nativeSpawnSync = Bun.spawnSync;
const roots: string[] = [];
const children: Array<[ReturnType<typeof Bun.spawn>, boolean]> = [];
const gitGuards: Array<{
  repo: string;
  bare: string;
  head: string;
  reported: boolean;
}> = [];

const gitState = (repo: string, args: string[]): string => {
  const result = nativeSpawnSync(['git', '-C', repo, ...args], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return `${String(result.exitCode)}:${result.stdout.toString().trim()}`;
};

export function installGitGuard(repo: string): void {
  gitGuards.push({
    repo,
    bare: gitState(repo, ['config', '--get', 'core.bare']),
    head: gitState(repo, ['rev-parse', 'HEAD']),
    reported: false,
  });
}

function checkGitGuards(throwOnChange: boolean): void {
  for (const guard of gitGuards) {
    const actualBare = gitState(guard.repo, ['config', '--get', 'core.bare']);
    const actualHead = gitState(guard.repo, ['rev-parse', 'HEAD']);
    if (actualBare === guard.bare && actualHead === guard.head) continue;
    const message = `test git guard: repository changed: ${guard.repo} (core.bare ${guard.bare} -> ${actualBare}, HEAD ${guard.head} -> ${actualHead})`;
    process.exitCode = 1;
    if (!guard.reported) console.error(message);
    guard.reported = true;
    if (throwOnChange) throw new Error(message);
  }
}

export function trackTestRoot(path: string): void {
  roots.push(path);
}

export function trackTestChild<T extends ReturnType<typeof Bun.spawn>>(
  proc: T,
  processGroup = false
): T {
  children.push([proc, processGroup]);
  return proc;
}

afterEach(async () => {
  for (const [proc, processGroup] of children.splice(0)) {
    try {
      process.kill(processGroup ? -proc.pid : proc.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await proc.exited;
  }
});

afterAll(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
  checkGitGuards(true);
}, 240_000);

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
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CEILING_DIRECTORIES = dirname(tmpdir());
process.env.SA_ENGINE_VERIFY_TOKEN = '';
process.env.SA_ENGINE_PROMOTER_TOKEN = '';
process.env.SA_SERVED_RUN = '';
process.env.SA_HISTORICAL_RUN = '';
process.env.SA_CONSOLE_LABEL = `com.wetamp.superagent-console.test.${String(process.pid)}`;
process.env.SA_LAUNCHD_DIR = join(testHome, 'LaunchAgents');
installGitGuard(join(import.meta.dir, '..'));
process.on('exit', () => checkGitGuards(false));
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
