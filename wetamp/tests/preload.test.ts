import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { expect, test } from 'bun:test';
import { inheritedTestHomes } from './preload';

// Capture during module loading: isolation must precede fixtures and test hooks.
const identity = [
  process.env.SUPERAGENT_ROLE,
  process.env.SA_JOB_ID,
  process.env.SA_JOB_CARD,
  process.env.SA_JOB_REQUEST_REF,
  process.env.AI_DISPATCH_ROLE,
  process.env.TWIN_AGENT_REMOTE,
];

test('test preload clears inherited derived identities before module loading', () => {
  expect(identity).toEqual(['', '', '', '', '', '']);
});

test('test preload isolates inherited homes in this process and child test processes', () => {
  const homes = [process.env.SUPERAGENT_HOME!, process.env.ARCHON_HOME!];
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
    },
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
