import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();
const wetamp = join(import.meta.dir, '..');

test('engine acceptance defaults to scenario-core and --full covers every scenario', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'engine-acceptance-')));
  const bin = join(root, 'bin');
  const trace = join(root, 'trace');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'bun'),
    '#!/bin/sh\nprintf "%s:%s\\n" "${SA_HEAVY_LOCK_HELD:-}" "$*" >> "$TRACE"\n'
  );
  chmodSync(join(bin, 'bun'), 0o755);
  const invoke = (...args: string[]) => {
    writeFileSync(trace, '');
    const result = Bun.spawnSync(['bash', 'scripts/engine-acceptance.sh', ...args], {
      cwd: wetamp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TRACE: trace,
        SA_HEAVY_LOCK_FILE: join(root, 'heavy.lock'),
      },
    });
    expect(result.exitCode).toBe(0);
    return readFileSync(trace, 'utf8').trim().split('\n');
  };
  expect(invoke()).toEqual([
    ':run type-check',
    ':test --timeout 900000 tests/scenarios/scenario-core.test.ts',
  ]);
  const scenarios = readdirSync(join(wetamp, 'tests/scenarios'))
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => `tests/scenarios/${name}`);
  const engines = readdirSync(join(wetamp, 'tests'))
    .filter(name => name.startsWith('engine-') && name.endsWith('.test.ts'))
    .sort()
    .map(name => `tests/${name}`);
  expect(invoke('--full')).toEqual([
    ':run type-check',
    ...[...scenarios, ...engines].map(path => `1:test --timeout 900000 ${path}`),
  ]);
});
