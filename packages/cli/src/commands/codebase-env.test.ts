// @archon-test-isolated
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { closeDatabase, resetDatabase } from '@archon/core/db/connection';
import { createCodebase, findCodebaseByDefaultCwd } from '@archon/core/db/codebases';
import { getCodebaseEnvVars } from '@archon/core/db/env-vars';
import { codebaseEnvCommand } from './codebase-env';

const root = mkdtempSync(join(tmpdir(), 'archon-codebase-env-'));
const previousHome = process.env.ARCHON_HOME;
const previousUrl = process.env.DATABASE_URL;
let output: string[] = [];

beforeAll(async () => {
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await createCodebase({ name: 'project', default_cwd: root });
  spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
});
beforeEach(() => (output = []));
afterAll(async () => {
  await closeDatabase();
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
  await removeTempTree(root);
});

describe('codebase env command', () => {
  test('sets, lists only keys, unsets, and rejects an unknown cwd', async () => {
    await codebaseEnvCommand('set', ['JAVA_HOME', '/jdk8'], root);
    expect(await getCodebaseEnvVars((await findCodebaseByDefaultCwd(root))!.id)).toEqual({
      JAVA_HOME: '/jdk8',
    });
    await codebaseEnvCommand('list', [], root);
    expect(output).toEqual(['JAVA_HOME']);
    expect(output.join('\n')).not.toContain('/jdk8');
    await codebaseEnvCommand('unset', ['JAVA_HOME'], root);
    expect(await getCodebaseEnvVars((await findCodebaseByDefaultCwd(root))!.id)).toEqual({});
    await expect(codebaseEnvCommand('list', [], `${root}-missing`)).rejects.toThrow(
      'No registered codebase'
    );
  });

  test('rejects every reserved key without storing or exposing values', async () => {
    for (const key of ['SA_X', 'SUPERAGENT_ROLE', 'ARCHON_X', 'INPUTS_X', 'WORKFLOW_ID']) {
      const value = `secret-${key}`;
      const result = codebaseEnvCommand('set', [key, value], root);
      await expect(result).rejects.toThrow(key);
      await expect(result).rejects.not.toThrow(value);
    }
    await codebaseEnvCommand('list', [], root);
    expect(output).toEqual([]);
  });
});
