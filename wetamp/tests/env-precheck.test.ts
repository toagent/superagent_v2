import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionEnvironment } from '../templates/.archon/scripts/env-precheck';
import { tmp } from './helpers';

test('dependency lock change reinstalls once and refreshes the record', async () => {
  const root = tmp(),
    bin = join(root, 'bin'),
    calls = join(root, 'calls');
  mkdirSync(bin);
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'packages/a'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'bun@1', workspaces: ['packages/*'] })
  );
  writeFileSync(join(root, 'packages/a/package.json'), '{"dependencies":{"a":"1"}}');
  writeFileSync(join(root, 'bun.lock'), 'one');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    expect((await provisionEnvironment(root)).environment.ok).toBe(true);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['install --frozen-lockfile']);
    expect((await provisionEnvironment(root)).provisioned).toEqual([]);
    writeFileSync(join(root, 'bun.lock'), 'two');
    const changed = await provisionEnvironment(root);
    expect(changed.environment.ok).toBe(true);
    expect(changed.provisioned.map(entry => entry.cmd)).toEqual(['bun install --frozen-lockfile']);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    process.env.PATH = path;
  }
});
