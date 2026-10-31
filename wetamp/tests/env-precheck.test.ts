import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionEnvironment } from '../templates/.archon/scripts/env-precheck';
import { prepareEnvironment } from '../templates/.archon/scripts/sa-check';
import { tmp } from './helpers';

test('unowned checkout ignores a missing dependency record without installing', async () => {
  const root = tmp(),
    log = join(root, 'environment.log'),
    record = join(root, 'node_modules', '.sa-deps.sha256');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'bun@1', dependencies: { example: '1' } })
  );
  writeFileSync(join(root, 'bun.lock'), 'one');
  expect(
    await prepareEnvironment(root, { environment: [], packages: [] }, log, false)
  ).toMatchObject({ ok: false, failed: ['env-precheck'] });
  mkdirSync(join(root, 'node_modules'));
  const result = await prepareEnvironment(root, { environment: [], packages: [] }, log, false);
  expect(result).toMatchObject({
    ok: true,
    failed: [],
    failures: [],
    precheck: { ok: true, failures: [] },
    provisioned: [],
  });
  expect(result.notes).toEqual([
    'Dependency record is missing or stale, but this run does not own the checkout; automatic install skipped.',
  ]);
  expect(existsSync(record)).toBe(false);
});

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
