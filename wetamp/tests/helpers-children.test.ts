import { expect, test } from 'bun:test';
import { trackTestChild } from './helpers';

let failedTestPid = 0;

test.failing('tracked detached child is reaped when its test fails', () => {
  const child = trackTestChild(Bun.spawn(['sleep', '60'], { detached: true }), true);
  failedTestPid = child.pid;
  throw new Error('exercise failure cleanup');
});

test('afterEach reaped the failed test child', () => {
  expect(failedTestPid).toBeGreaterThan(0);
  try {
    process.kill(failedTestPid, 0);
    throw new Error(`child ${String(failedTestPid)} is still running`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
  }
});

test('already exited tracked child is accepted', async () => {
  const child = trackTestChild(Bun.spawn(['true']));
  expect(await child.exited).toBe(0);
});
