import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { expect, test } from 'bun:test';
import { inheritedTestHomes, isolatedTestHomes } from './preload';
import { sh, tmp } from './helpers';

// Capture during module loading: isolation must precede fixtures and test hooks.
const identity = [
  process.env.SUPERAGENT_ROLE,
  process.env.SA_JOB_ID,
  process.env.SA_JOB_CARD,
  process.env.SA_JOB_REQUEST_REF,
  process.env.AI_DISPATCH_ROLE,
  process.env.TWIN_AGENT_REMOTE,
];
const isolation = {
  gitDir: process.env.GIT_DIR,
  ceiling: process.env.GIT_CEILING_DIRECTORIES,
  verify: process.env.SA_ENGINE_VERIFY_TOKEN,
  promoter: process.env.SA_ENGINE_PROMOTER_TOKEN,
  served: process.env.SA_SERVED_RUN,
  historical: process.env.SA_HISTORICAL_RUN,
  consoleLabel: process.env.SA_CONSOLE_LABEL,
  launchdDir: process.env.SA_LAUNCHD_DIR,
};

test('test preload clears inherited derived identities before module loading', () => {
  expect(identity).toEqual(['', '', '', '', '', '']);
});

test('test preload isolates inherited homes in this process and child test processes', () => {
  const homes = [isolatedTestHomes.superagent, isolatedTestHomes.archon];
  for (const home of homes) {
    expect(home.startsWith(`${tmpdir()}${sep}`)).toBe(true);
    expect(existsSync(home)).toBe(true);
  }
  expect(homes).not.toContain(inheritedTestHomes.superagent);
  expect(homes).not.toContain(inheritedTestHomes.archon);
  if (process.env.SA_PRELOAD_CHILD === '1') return;
  const child = Bun.spawnSync([process.execPath, 'test', 'tests/preload.test.ts'], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      SA_PRELOAD_CHILD: '1',
      SUPERAGENT_HOME: '/inherited-superagent-home',
      ARCHON_HOME: '/inherited-archon-home',
      GIT_DIR: '/inherited-git-dir',
      SA_ENGINE_VERIFY_TOKEN: 'verify-secret',
      SA_ENGINE_PROMOTER_TOKEN: 'promoter-secret',
      SA_SERVED_RUN: 'served-run',
      SA_HISTORICAL_RUN: 'historical-run',
    },
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test('test preload clears git and engine state and redirects launchd state', () => {
  expect(isolation).toMatchObject({
    gitDir: undefined,
    ceiling: dirname(tmpdir()),
    verify: '',
    promoter: '',
    served: '',
    historical: '',
    launchdDir: join(isolatedTestHomes.superagent, 'LaunchAgents'),
  });
  expect(isolation.consoleLabel).toStartWith('com.wetamp.superagent-console.test.');
});

test('test preload fails the process when a guarded repository changes', () => {
  if (process.env.SA_PRELOAD_CHILD === '1') return;
  const root = tmp(),
    repo = join(root, 'repo'),
    fixture = join(root, 'git-guard.test.ts');
  mkdirSync(repo);
  sh(
    'git init -q && git config user.name test && git config user.email test@example.com && touch tracked && git add tracked && git commit -qm init',
    repo
  );
  writeFileSync(
    fixture,
    `import { test } from 'bun:test'; import { installGitGuard } from ${JSON.stringify(join(import.meta.dir, 'preload.ts'))}; test('mutate', () => { installGitGuard(${JSON.stringify(repo)}); Bun.spawnSync(['git', '-C', ${JSON.stringify(repo)}, 'config', 'core.bare', 'true']); });\n`
  );
  const child = Bun.spawnSync([process.execPath, 'test', fixture], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain('test git guard: repository changed');
});
