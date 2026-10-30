import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootstrapLaunchd,
  kickstartLaunchd,
  printLaunchd,
  type LaunchctlRunner,
} from '../src/launchd';
import { tmp } from './helpers';

const result = (status = 0) => ({ status, signal: null, stdout: '', stderr: '', pid: 1 });

test('mutation rejects a fake-home plist before invoking the runner', () => {
  const root = tmp(),
    actual = join(root, 'fake', 'Library', 'LaunchAgents'),
    system = join(root, 'system');
  mkdirSync(actual, { recursive: true });
  mkdirSync(join(system, 'Library', 'LaunchAgents'), { recursive: true });
  let calls = 0;
  expect(() =>
    bootstrapLaunchd('gui/501', join(actual, 'com.wetamp.superagent.supervise-tick.plist'), {
      accountHome: () => system,
      runner: () => (calls++, result()),
    })
  ).toThrow('launchd mutation refused');
  expect(calls).toBe(0);
});

test('mutation invokes the injected runner for the system user LaunchAgents directory', () => {
  const system = tmp(),
    dir = join(system, 'Library', 'LaunchAgents'),
    plist = join(dir, 'fixture.plist'),
    calls: string[][] = [];
  mkdirSync(dir, { recursive: true });
  kickstartLaunchd('gui/501/fixture', plist, {
    accountHome: () => system,
    runner: args => (calls.push(args), result()),
  });
  expect(calls).toEqual([['kickstart', '-k', 'gui/501/fixture']]);
});

test('print is not restricted by plist ownership', () => {
  const calls: string[][] = [],
    runner: LaunchctlRunner = args => (calls.push(args), result());
  expect(printLaunchd('gui/501/fixture', runner).status).toBe(0);
  expect(calls).toEqual([['print', 'gui/501/fixture']]);
});
