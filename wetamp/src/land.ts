import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock, QUERY_TIMEOUT_MS, type RunView } from './archon';
import { home, receiptIssue, runtimeFingerprint, WETAMP, type Receipt } from './config';
import { redact } from './redact';
import { landTarget, type Land } from '../templates/.archon/scripts/sa-check';
const selftestTimeout = (): number =>
  (process.env.NODE_ENV === 'test' && Number(process.env.SA_SELFTEST_TIMEOUT_MS)) || 20 * 60_000;
/** Both preflight and the detached refresher own the same kernel lease for the entire script. */
// prettier-ignore
export function selftest(wait: boolean): void {
  const { sa } = home(), path = join(sa, 'selftest.json');
  const issue = () => receiptIssue(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Partial<Receipt> : undefined);
  if (!issue()) return;
  const deadline = Date.now() + selftestTimeout();
  let lease = lock(join(sa, 'selftest.lock'));
  while (!lease.ok && Date.now() < deadline) {
    Bun.sleepSync(50);
    lease = lock(join(sa, 'selftest.lock'));
  }
  if (!lease.ok) throw new Error('preflight: timed out waiting for selftest.lock');
  try {
    let why = issue();
    if (why && (why.kind !== 'invalid' || !wait)) {
      console.error(`preflight: ${why.kind}; running real selftest synchronously`);
      const bin = process.env.NODE_ENV === 'test' ? process.env.SA_SELFTEST_BIN ?? join(WETAMP, 'scripts/selftest.sh') : join(WETAMP, 'scripts/selftest.sh');
      const timeout = selftestTimeout();
      // The supervisor stays outside the child's group so it can kill descendants and reap bash.
      const supervisor = `use Time::HiRes qw(alarm); my $ms = shift; my $pid = fork // die "fork: $!";
        if (!$pid) { setpgrp(0, 0) or die "setpgrp: $!"; exec "bash", @ARGV; die "exec: $!"; }
        $SIG{ALRM} = sub { kill 'KILL', -$pid; waitpid($pid, 0); exit 124; };
        alarm($ms / 1000); waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8);`;
      const p = Bun.spawnSync(['perl', '-e', supervisor, String(timeout), bin], { env: process.env, timeout: timeout + 1000, killSignal: 'SIGKILL' });
      const log = redact(p.stdout.toString() + p.stderr.toString());
      if (!wait) console.log(log);
      if (p.exitedDueToTimeout || p.exitCode !== 0)
        why.message += `; selftest ${p.exitedDueToTimeout || p.exitCode === 124 ? 'timed out' : `exit ${String(p.exitCode)}`}; log tail:\n${log.split('\n').slice(-20).join('\n')}`;
      else why = issue();
    }
    if (why) throw new Error(`preflight: no valid selftest receipt: ${why.message}; fix: wetamp/scripts/selftest.sh (real, not --fake)`);
  } finally { lease.release(); }
}
// prettier-ignore
export function applyLand(run: RunView, land: Pick<Land, 'branch' | 'head'> & Partial<Land>, verify: (cwd: string) => number, context?: { repo: string; base_ref: string; launch_branch?: string }): void {
  if (run.status !== 'completed' || !run.nodes?.some(n => n.nodeId === 'land' && n.state === 'completed') || land.ff === false)
    throw new Error('land: run is not ready for fast-forward integration');
  const repo = land.repo ?? context?.repo; if (!repo) throw new Error('land: missing repository');
  const target = land.target ?? (context && landTarget(repo, context.base_ref, () => context.launch_branch)); if (!target) throw new Error('land: missing integration target');
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
    if (p.exitCode !== 0) throw new Error(`land: ${p.stderr.toString().trim()}`);
    return p.stdout.toString().trim();
  };
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('land: target checkout is dirty');
  const tree = git('rev-parse', `${land.head}^{tree}`);
  const sameTree = () => {
    if (git('rev-parse', `${land.branch}^{tree}`) !== tree) throw new Error('land: branch tree differs from accepted tree');
  };
  sameTree();
  const fingerprint = runtimeFingerprint();
  const original = git('symbolic-ref', '--short', 'HEAD');
  // Check the accepted tree in the target checkout without advancing the integration branch.
  git('switch', '--detach', land.head);
  try { if (verify(repo) !== 0) throw new Error('land: acceptance failed'); }
  finally { git('switch', original); }
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('land: acceptance dirtied target checkout');
  sameTree();
  git('switch', target);
  git('merge', '--ff-only', land.branch);
  console.log(`land: integrated ${git('rev-parse', 'HEAD')} in ${repo}`);
  for (const args of [...(run.working_path ? [['worktree', 'remove', run.working_path]] : []), ['branch', '-d', land.branch]]) {
    try { git(...args); } catch (e) { console.error(`land: kept ${String(args.at(-1))}: ${(e as Error).message}`); }
  }
  if (runtimeFingerprint() !== fingerprint) {
    const log = join(home().sa, 'selftest-land.log'), fd = openSync(log, 'a');
    try { spawn(process.execPath, [import.meta.path], { cwd: repo, detached: true, stdio: ['ignore', fd, fd] }).unref(); }
    finally { closeSync(fd); }
    console.log(`land: background selftest log ${log}`);
  }
}
if (import.meta.main) selftest(false);
