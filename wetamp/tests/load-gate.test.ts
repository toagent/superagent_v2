import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
const script = join(import.meta.dir, '../templates/.archon/scripts/load-gate.ts');
const run = (loads: string, maxMs = '20') => {
  const log = join(tmp(), 'load.log');
  const code = `import { waitForLoad } from ${JSON.stringify(script)}; await waitForLoad(${JSON.stringify(log)});`;
  const result = Bun.spawnSync([process.execPath, '-e', code], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SA_TEST_LOAD_SEQUENCE: loads,
      SA_TEST_LOAD_LIMIT: '1',
      SA_TEST_LOAD_POLL_MS: '1',
      SA_TEST_LOAD_PROGRESS_MS: '1',
      SA_TEST_LOAD_MAX_MS: maxMs,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { result, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
};
test('normal load returns silently while high load waits until recovery', () => {
  const normal = run('0');
  expect(normal.result.exitCode).toBe(0);
  expect(normal.log).toBe('');
  expect(normal.result.stdout.toString()).toBe('');
  const waited = run('2,0');
  expect(waited.result.exitCode).toBe(0);
  expect(waited.log).toContain('负载 2.0 > 1，已等 0s');
  expect(waited.log).toContain('负载已恢复 0.0 <= 1，开始新作业');
  expect(waited.result.stdout.toString()).toContain('负载 2.0 > 1，已等 0s');
  expect(waited.result.stderr.toString()).toBe('');
});
test('high load is released after the bounded wait', () => {
  const timedOut = run('2', '2');
  expect(timedOut.result.exitCode).toBe(0);
  expect(timedOut.log).toContain('负载等待超时，按原计划启动');
  expect(timedOut.result.stdout.toString()).toContain('负载等待超时，按原计划启动');
});
