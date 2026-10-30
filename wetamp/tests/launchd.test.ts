import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootstrapLaunchd,
  kickstartLaunchd,
  printLaunchd,
  reloadLaunchd,
  type LaunchctlRunner,
} from '../src/launchd';
import { tmp } from './helpers';

const result = (status = 0) => ({ status, signal: null, stdout: '', stderr: '', pid: 1 });
const systemHome = (): string => {
  const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
  return execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {
    encoding: 'utf8',
  })
    .trim()
    .slice('NFSHomeDirectory: '.length);
};

test('mutation rejects a fake-home plist before invoking the runner', () => {
  const root = tmp(),
    actual = join(root, 'Library', 'LaunchAgents'),
    savedHome = process.env.HOME;
  mkdirSync(actual, { recursive: true });
  process.env.HOME = root;
  let calls = 0;
  try {
    expect(() =>
      bootstrapLaunchd('gui/501', join(actual, 'com.wetamp.superagent.supervise-tick.plist'), {
        runner: () => (calls++, result()),
      })
    ).toThrow('launchd mutation refused');
    expect(calls).toBe(0);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test('mutation invokes the injected runner for the system user LaunchAgents directory', () => {
  const dir = join(systemHome(), 'Library', 'LaunchAgents'),
    plist = join(dir, 'fixture.plist'),
    calls: string[][] = [];
  kickstartLaunchd('gui/501/fixture', plist, {
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

test('reload preserves launchctl order and reports mutation failures', () => {
  const plist = join(systemHome(), 'Library', 'LaunchAgents', 'fixture.plist'),
    domain = `gui/${String(process.getuid?.())}`,
    calls: string[][] = [];
  let statuses = [1, 0];
  const runner: LaunchctlRunner = args => {
    calls.push(args);
    return { ...result(statuses.shift() ?? 0), stderr: 'denied' };
  };
  reloadLaunchd(plist, { runner });
  expect(calls).toEqual([
    ['print', `${domain}/fixture`],
    ['bootstrap', domain, plist],
  ]);

  calls.length = 0;
  statuses = [0, 0, 0];
  reloadLaunchd(plist, { runner });
  expect(calls).toEqual([
    ['print', `${domain}/fixture`],
    ['bootout', `${domain}/fixture`],
    ['bootstrap', domain, plist],
  ]);

  statuses = [0, 7];
  expect(() => reloadLaunchd(plist, { runner })).toThrow('launchd bootout failed: denied');
  statuses = [1, 7];
  expect(() => reloadLaunchd(plist, { runner })).toThrow('launchd bootstrap failed: denied');
});
