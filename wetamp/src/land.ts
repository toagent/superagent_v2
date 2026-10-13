import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock, QUERY_TIMEOUT_MS, type RunView } from './archon';
import { home, receiptIssue, runtimeFingerprint, WETAMP, type Receipt } from './config';
import { redact } from './redact';
import { landTarget, type Land } from '../templates/.archon/scripts/sa-check';
export interface DeliveryTarget { checkout: string; branch: string; head: string }
export interface LocalDelivery {
  task: string;
  target: DeliveryTarget;
  contract: string;
  receipt: string;
  title: string;
  evidence: string;
}
export interface DeliveryReceipt {
  task: string;
  source: string;
  target: DeliveryTarget;
  contract: string;
  evidence: string;
  accepted: string;
  integrated: string;
  target_tip: string;
  status: 'manual_push';
  push: string;
}
export function captureDelivery(checkout: string): DeliveryTarget {
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', checkout, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(`delivery: ${p.stderr.toString().trim()}`);
    return p.stdout.toString().trim();
  };
  return { checkout: realpathSync(git('rev-parse', '--show-toplevel')), branch: git('symbolic-ref', '--short', 'HEAD'), head: git('rev-parse', 'HEAD') };
}
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
export function applyLand(run: RunView, land: Pick<Land, 'branch' | 'head'> & Partial<Land>, verify: (cwd: string) => number, context?: { repo: string; base_ref: string; launch_branch?: string; delivery?: LocalDelivery }): DeliveryReceipt | undefined {
  if (run.status !== 'completed' || !run.nodes?.some(n => n.nodeId === 'land' && n.state === 'completed'))
    throw new Error('land: run is not ready for integration');
  const delivery = context?.delivery;
  const repo = delivery?.target.checkout ?? land.repo ?? context?.repo; if (!repo) throw new Error('land: missing repository');
  const target = delivery?.target.branch ?? land.target ?? (context && landTarget(repo, context.base_ref, () => context.launch_branch)); if (!target) throw new Error('land: missing integration target');
  if (delivery && /^(main|master|dev|develop|release-.*)$/.test(target)) throw new Error('delivery: protected target branch');
  const gitAt = (cwd: string, ...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
    if (p.exitCode !== 0) throw new Error(`land: ${p.stderr.toString().trim()}`);
    return p.stdout.toString().trim();
  };
  const git = (...args: string[]): string => gitAt(repo, ...args);
  const targetCheckout = () => git('worktree', 'list', '--porcelain', '-z').split('\0\0').find(record => record.split('\0').includes(`branch refs/heads/${target}`))?.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  const lockfile = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), `sa-land-${createHash('sha256').update(target).digest('hex')}.lock`);
  let lease = lock(lockfile);
  const deadline = Date.now() + selftestTimeout();
  while (!lease.ok && Date.now() < deadline) { Bun.sleepSync(50); lease = lock(lockfile); }
  if (!lease.ok) throw new Error('land: timed out waiting for integration lock');
  try {
  const checkout = targetCheckout();
  if (delivery && (!checkout || realpathSync(checkout) !== delivery.target.checkout || gitAt(checkout, 'symbolic-ref', '--short', 'HEAD') !== target)) throw new Error('delivery: target checkout/branch changed');
  const clean = () => { if (checkout && gitAt(checkout, 'status', '--porcelain', '--untracked-files=all')) throw new Error('land: target checkout is dirty'); };
  clean();
  const tree = git('rev-parse', `${land.head}^{tree}`);
  const sameTree = () => {
    if (delivery && git('rev-parse', land.branch) !== land.head) throw new Error('delivery: source HEAD drifted');
    if (delivery && run.working_path && gitAt(run.working_path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('delivery: source checkout is dirty');
    if (git('rev-parse', `${land.branch}^{tree}`) !== tree) throw new Error('land: branch tree differs from accepted tree');
  };
  sameTree();
  const ancestor = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', land.head, `refs/heads/${target}`], { stdout: 'pipe', stderr: 'pipe' });
  if (ancestor.exitCode > 1) throw new Error(`delivery: ${ancestor.stderr.toString().trim()}`);
  // Git evidence, never a supplied receipt, determines whether integration already happened.
  if (delivery && ancestor.exitCode !== 0 && git('rev-parse', `refs/heads/${target}`) !== delivery.target.head) throw new Error('delivery: target HEAD drifted since launch');
  let receipt: DeliveryReceipt | undefined;
  const fingerprint = runtimeFingerprint();
  for (let attempt = 0; ; attempt++) {
  const tip = git('rev-parse', `refs/heads/${target}`), root = mkdtempSync(join(tmpdir(), 'sa-land-')), candidate = join(root, 'wt');
  try {
    git('worktree', 'add', '--detach', candidate, tip);
    const ff = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', tip, land.head], { stdout: 'pipe', stderr: 'pipe' });
    if (ff.exitCode > 1) throw new Error(`land: ${ff.stderr.toString().trim()}`);
    try { gitAt(candidate, 'merge', ff.exitCode === 0 ? '--ff-only' : '--no-ff', '-m', delivery ? `${delivery.title}\n\nTask: ${delivery.task}\nAcceptance contract: ${delivery.contract}\nLocal delivery; manual push required.` : `Merge ${land.branch}`, land.head); }
    catch (e) {
      const conflicts = gitAt(candidate, 'diff', '--name-only', '--diff-filter=U');
      if (!conflicts) throw e;
      const solver = Bun.which('mergiraf', { PATH: process.env.PATH });
      if (solver) for (const file of conflicts.split('\n')) {
        const solved = Bun.spawnSync([solver, 'solve', file], { cwd: candidate, stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
        if (solved.exitCode === 0) gitAt(candidate, 'add', '--', file);
      }
      const remaining = gitAt(candidate, 'diff', '--name-only', '--diff-filter=U');
      if (remaining) {
        gitAt(candidate, 'merge', '--abort');
        throw new Error(`land: merge conflicts:\n${remaining}\nnext: git -C ${repo} merge --no-ff ${land.branch}`);
      }
      gitAt(candidate, 'commit', '--no-edit');
    }
    const accepted = gitAt(candidate, 'rev-parse', 'HEAD');
    // Workspace links must resolve within the checkout being accepted.
    for (const rel of ['.', 'wetamp']) {
      const dir = join(candidate, rel), lockfile = join(dir, 'bun.lock');
      if (!existsSync(lockfile)) continue;
      const p = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      if (p.exitCode !== 0) throw new Error(`land: dependency install failed: ${p.stderr.toString().trim()}`);
    }
    if (verify(candidate) !== 0) throw new Error('land: acceptance failed');
    if (gitAt(candidate, 'rev-parse', 'HEAD') !== accepted || gitAt(candidate, 'status', '--porcelain', '--untracked-files=all')) throw new Error('land: acceptance changed candidate checkout');
    sameTree(); clean();
    if (targetCheckout() !== checkout) throw new Error('land: target checkout changed during acceptance; retry land --apply');
    if (git('rev-parse', `refs/heads/${target}`) !== tip) {
      if (attempt < 2) continue;
      throw new Error('land: target advanced during acceptance after 2 retries');
    }
    if (checkout) gitAt(checkout, 'merge', '--ff-only', accepted);
    else git('update-ref', `refs/heads/${target}`, accepted, tip);
    if (!delivery) console.log(`land: integrated ${accepted} in ${checkout ?? repo}`);
    if (delivery) {
      const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      const integrated = git('rev-parse', `refs/heads/${target}`);
      if (integrated !== accepted) throw new Error('delivery: target changed after integration; outcome unknown');
      receipt = { task: delivery.task, source: land.head, target: delivery.target, target_tip: tip, contract: delivery.contract, evidence: delivery.evidence, accepted, integrated, status: 'manual_push', push: `git -C ${q(repo)} push origin ${q(target)}` };
      const temp = `${delivery.receipt}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(receipt, null, 2));
      renameSync(temp, delivery.receipt);
    }
    break;
  } finally {
    try { if (existsSync(candidate)) git('worktree', 'remove', '--force', candidate); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  }
  for (const args of delivery ? [] : [...(run.working_path ? [['worktree', 'remove', run.working_path]] : []), ['branch', '-d', land.branch]]) {
    try { git(...args); } catch (e) { console.error(`land: kept ${String(args.at(-1))}: ${(e as Error).message}`); }
  }
  if (runtimeFingerprint() !== fingerprint) {
    const log = join(home().sa, 'selftest-land.log'), fd = openSync(log, 'a');
    try { spawn(process.execPath, [import.meta.path], { cwd: repo, detached: true, stdio: ['ignore', fd, fd] }).unref(); }
    finally { closeSync(fd); }
    if (!delivery) console.log(`land: background selftest log ${log}`);
  }
  return receipt;
  } finally { lease.release(); }
}
if (import.meta.main) selftest(false);
