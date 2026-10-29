import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLaunchdPath } from '../src/launchd-path';
import { tmp } from './helpers';

test('normalizes stable launchd paths while preserving order and missing nvm current', () => {
  const home = tmp(),
    current = join(home, '.nvm/current/bin'),
    version = join(home, '.nvm/versions/node/v24.22.1/bin'),
    codexTmp = join(home, '.codex/tmp/arg0-macos/codex-arg0'),
    codexPath = '/opt/node_modules/@openai/codex/vendor/codex-path';
  mkdirSync(current, { recursive: true });
  expect(
    normalizeLaunchdPath([version, '/usr/bin', codexTmp, codexPath, version].join(':'), home)
  ).toBe(`${current}:/usr/bin`);
  expect(normalizeLaunchdPath(version, join(tmp(), 'missing-home'))).toBe(version);
});
