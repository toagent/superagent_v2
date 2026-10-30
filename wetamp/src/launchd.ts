import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type LaunchctlRunner = (args: string[]) => LaunchctlResult;

interface LaunchdDeps {
  runner?: LaunchctlRunner;
}

const runLaunchctl: LaunchctlRunner = args => spawnSync('launchctl', args, { encoding: 'utf8' });

const uid = (): number => {
  const value = process.getuid?.();
  if (value === undefined) throw new Error('launchd requires a Unix user id');
  return value;
};

const canonicalDirectory = (path: string, role: string): string => {
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`launchd mutation refused: cannot resolve ${role} directory ${path}`);
  }
};

const guardMutation = (plist: string): void => {
  const actual = canonicalDirectory(dirname(plist), 'plist parent');
  const allowed = canonicalDirectory(
    join(userInfo().homedir, 'Library', 'LaunchAgents'),
    'system user LaunchAgents'
  );
  if (actual !== allowed)
    throw new Error(
      `launchd mutation refused: plist parent ${actual} is not system user LaunchAgents ${allowed}`
    );
};

const mutation = (args: string[], plist: string, deps: LaunchdDeps): LaunchctlResult => {
  guardMutation(plist);
  return (deps.runner ?? runLaunchctl)(args);
};

export const printLaunchd = (job: string, runner = runLaunchctl): LaunchctlResult =>
  runner(['print', job]);

export const bootstrapLaunchd = (
  domain: string,
  plist: string,
  deps: LaunchdDeps = {}
): LaunchctlResult => mutation(['bootstrap', domain, plist], plist, deps);

export const bootoutLaunchd = (
  job: string,
  plist: string,
  deps: LaunchdDeps = {}
): LaunchctlResult => mutation(['bootout', job], plist, deps);

export const kickstartLaunchd = (
  job: string,
  plist: string,
  deps: LaunchdDeps = {}
): LaunchctlResult => mutation(['kickstart', '-k', job], plist, deps);

const requireSuccess = (operation: string, result: LaunchctlResult): void => {
  if (result.status !== 0)
    throw new Error(
      `launchd ${operation} failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`
    );
};

export function reloadLaunchd(plist: string, deps: LaunchdDeps = {}): void {
  const file = basename(plist);
  if (!file.endsWith('.plist')) throw new Error(`launchd reload requires a .plist: ${plist}`);
  guardMutation(plist);
  const label = file.slice(0, -'.plist'.length),
    domain = `gui/${String(uid())}`,
    job = `${domain}/${label}`,
    runner = deps.runner ?? runLaunchctl;
  if (printLaunchd(job, runner).status === 0)
    requireSuccess('bootout', bootoutLaunchd(job, plist, { ...deps, runner }));
  requireSuccess('bootstrap', bootstrapLaunchd(domain, plist, { ...deps, runner }));
}

if (import.meta.main) {
  const [command, plist] = process.argv.slice(2);
  if (command !== 'reload' || !plist) throw new Error('usage: bun src/launchd.ts reload <plist>');
  reloadLaunchd(plist);
}
