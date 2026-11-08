// @archon-test-isolated
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { executeStandaloneWorktreeSetup, WorktreeSetupCommandError } from './worktree-setup';

const trackTempRoot = trackTempRoots();
const originalProbe = process.env.ARCHON_POST_CREATE_PROBE;
afterEach(() => {
  if (originalProbe === undefined) delete process.env.ARCHON_POST_CREATE_PROBE;
  else process.env.ARCHON_POST_CREATE_PROBE = originalProbe;
});

test('runs commands sequentially in the worktree with the native environment', async () => {
  const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-post-create-'))));
  process.env.ARCHON_POST_CREATE_PROBE = 'native';
  await executeStandaloneWorktreeSetup({
    workingPath: root,
    canonicalRepoPath: root,
    codebaseId: 'project',
    commands: [
      'printf "%s|%s" "$ARCHON_POST_CREATE_PROBE" "$PWD" > order',
      'test -f order && printf "|second" >> order',
    ],
    timeout: 5_000,
  });
  expect(await readFile(join(root, 'order'), 'utf8')).toBe(`native|${root}|second`);
});

test('kills the command process group on timeout before returning', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-post-create-timeout-')));
  const result = executeStandaloneWorktreeSetup({
    workingPath: root,
    canonicalRepoPath: root,
    codebaseId: 'project',
    commands: ['(sleep 0.2; touch late-write) & wait'],
    timeout: 30,
  });
  await expect(result).rejects.toBeInstanceOf(WorktreeSetupCommandError);
  await Bun.sleep(300);
  expect(await Bun.file(join(root, 'late-write')).exists()).toBe(false);
});
