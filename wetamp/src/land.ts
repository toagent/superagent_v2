import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  if (run.status !== 'completed' || !run.nodes?.some(n => n.nodeId === 'land' && n.state === 'completed'))
    throw new Error('land: run is not ready for integration');
  const repo = land.repo ?? context?.repo; if (!repo) throw new Error('land: missing repository');
  const target = land.target ?? (context && landTarget(repo, context.base_ref, () => context.launch_branch)); if (!target) throw new Error('land: missing integration target');
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
  const clean = () => { if (checkout && gitAt(checkout, 'status', '--porcelain', '--untracked-files=all')) throw new Error('land: target checkout is dirty'); };
  clean();
  const tree = git('rev-parse', `${land.head}^{tree}`);
  const sameTree = () => {
    if (git('rev-parse', `${land.branch}^{tree}`) !== tree) throw new Error('land: branch tree differs from accepted tree');
  };
  sameTree();
  const fingerprint = runtimeFingerprint();
  for (let attempt = 0; ; attempt++) {
  const tip = git('rev-parse', `refs/heads/${target}`), root = mkdtempSync(join(tmpdir(), 'sa-land-')), candidate = join(root, 'wt');
  const links: string[] = [];
  try {
    git('worktree', 'add', '--detach', candidate, tip);
    const ff = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', tip, land.head], { stdout: 'pipe', stderr: 'pipe' });
    if (ff.exitCode > 1) throw new Error(`land: ${ff.stderr.toString().trim()}`);
    try { gitAt(candidate, 'merge', ff.exitCode === 0 ? '--ff-only' : '--no-ff', '-m', `Merge ${land.branch}`, land.head); }
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
    // Reuse installed dependencies only when their owning lockfile matches.
    for (const rel of ['.', 'wetamp']) {
      const dir = join(candidate, rel), source = join(repo, rel), lockfile = join(dir, 'bun.lock');
      if (!existsSync(lockfile)) continue;
      if (existsSync(join(source, 'bun.lock')) && readFileSync(lockfile).equals(readFileSync(join(source, 'bun.lock'))) && existsSync(join(source, 'node_modules'))) {
        const deps = ['node_modules', ...(rel === '.' && existsSync(join(source, 'packages')) ? readdirSync(join(source, 'packages')).map(p => `packages/${p}/node_modules`) : [])];
        for (const dep of deps) if (existsSync(join(source, dep)) && existsSync(join(dir, dep, '..')) && !existsSync(join(dir, dep))) { symlinkSync(join(source, dep), join(dir, dep)); links.push(join(dir, dep)); }
      } else {
        const p = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
        if (p.exitCode !== 0) throw new Error(`land: dependency install failed: ${p.stderr.toString().trim()}`);
      }
    }
    if (verify(candidate) !== 0) throw new Error('land: acceptance failed');
    for (const link of links.splice(0)) rmSync(link);
    if (gitAt(candidate, 'rev-parse', 'HEAD') !== accepted || gitAt(candidate, 'status', '--porcelain', '--untracked-files=all')) throw new Error('land: acceptance changed candidate checkout');
    sameTree(); clean();
    if (targetCheckout() !== checkout) throw new Error('land: target checkout changed during acceptance; retry land --apply');
    if (git('rev-parse', `refs/heads/${target}`) !== tip) {
      if (attempt < 2) continue;
      throw new Error('land: target advanced during acceptance after 2 retries');
    }
    if (checkout) gitAt(checkout, 'merge', '--ff-only', accepted);
    else git('update-ref', `refs/heads/${target}`, accepted, tip);
    console.log(`land: integrated ${accepted} in ${checkout ?? repo}`);
    break;
  } finally {
    for (const link of links) rmSync(link, { force: true });
    try { if (existsSync(candidate)) git('worktree', 'remove', '--force', candidate); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  }
  for (const args of [...(run.working_path ? [['worktree', 'remove', run.working_path]] : []), ['branch', '-d', land.branch]]) {
    try { git(...args); } catch (e) { console.error(`land: kept ${String(args.at(-1))}: ${(e as Error).message}`); }
  }
  if (runtimeFingerprint() !== fingerprint) {
    const log = join(home().sa, 'selftest-land.log'), fd = openSync(log, 'a');
    try { spawn(process.execPath, [import.meta.path], { cwd: repo, detached: true, stdio: ['ignore', fd, fd] }).unref(); }
    finally { closeSync(fd); }
    console.log(`land: background selftest log ${log}`);
  }
  } finally { lease.release(); }
}
if (import.meta.main) selftest(false);
