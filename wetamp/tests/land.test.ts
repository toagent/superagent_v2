import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyLand, selftest } from '../src/land';
import * as config from '../src/config';
import type { Land } from '../templates/.archon/scripts/sa-check';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
const saved = { ...process.env };
// prettier-ignore
afterEach(() => { process.env = { ...saved }; });
// prettier-ignore
const fixture = () => {
  const root = tmp(), repo = gitRepo(root), worktree = join(root, 'worker'), art = join(root, 'art');
  mkdirSync(art);
  sh('git config user.name t && git config user.email t@l', repo);
  sh(`git worktree add -qb sa/land '${worktree}'`, repo);
  sh('echo delivery > delivery.txt && git add delivery.txt && git -c user.name=t -c user.email=t@l commit -qm delivery', worktree);
  const head = sh('git rev-parse HEAD', worktree).trim();
  const land: Land = { repo, target: 'main', ff: true, branch: 'sa/land', head, commands: [], debt: [] };
  const run = { id: 'r', status: 'completed' as const, working_path: worktree, nodes: [{ nodeId: 'land', state: 'completed' }] };
  return { root, repo, worktree, art, land, run };
};
// prettier-ignore
test.each(['current', 'legacy-ref', 'legacy-hash'])('%s apply checks the accepted tree, reuses cache and cleans worktree/branch', mode => {
  const f = fixture(), counter = join(f.root, 'calls');
  const receipt = mode === 'current' ? f.land : { branch: f.land.branch, head: f.land.head, commands: [], debt: [] };
  const plan = fixturePlan(f.root, f.repo, p => { p.packages = [{ id: 'p', accept: [{ cmd: `echo checked >> '${counter}'`, timeout_s: 2, cache: true }] }]; });
  const verify = (cwd: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')], {
    cwd, env: { ...process.env, INPUTS_KIND: 'accept', INPUTS_PLAN: plan, INPUTS_PKGS: 'p', INPUTS_TAG: 'land-check', ARTIFACTS_DIR: f.art }, stdout: 'pipe', stderr: 'pipe',
  }).exitCode;
  expect(verify(f.worktree)).toBe(0);
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  const original = sh('git rev-parse HEAD', f.repo);
  let candidate = '';
  try { applyLand(f.run, receipt, cwd => { candidate = cwd; expect(cwd).not.toBe(f.repo); expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('main'); expect(sh('git rev-parse HEAD', f.repo)).toBe(original); expect(sh('git rev-parse HEAD', cwd).trim()).toBe(f.land.head); return verify(cwd); }, { repo: f.repo, base_ref: mode === 'legacy-hash' ? sh('git rev-parse main', f.repo).trim() : 'origin/main', launch_branch: 'main' }); }
  finally { probe.mockRestore(); }
  expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(f.land.head);
  expect(readFileSync(counter, 'utf8')).toBe('checked\n');
  expect(readFileSync(join(f.art, 'land-check.log'), 'utf8')).toContain('reused pass');
  expect(existsSync(f.worktree)).toBe(false);
  expect(existsSync(candidate)).toBe(false);
  expect(sh('git branch --list sa/land', f.repo).trim()).toBe('');
});
// prettier-ignore
test.each(['pass', 'accept-fail', 'conflict', 'target-race'])('diverged target: %s preserves branches until verified and removes temporary worktree', kind => {
  const f = fixture(); f.land.ff = false;
  sh('echo target > README.md && git add README.md && git commit -qm target', f.repo);
  if (kind === 'conflict') {
    sh('echo worker > README.md && git add README.md && git commit -qm worker', f.worktree);
    f.land.head = sh('git rev-parse HEAD', f.worktree).trim();
  }
  const before = sh('git rev-parse main', f.repo), worker = sh('git rev-parse sa/land', f.repo), worktrees = sh('git worktree list --porcelain', f.repo);
  let candidate = '', accepted = '', calls = 0, targetAfter = before;
  const verify = (cwd: string) => {
    candidate = cwd; calls++;
    expect(sh('git rev-parse main', f.repo)).toBe(before);
    expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('main');
    accepted = sh('git rev-parse HEAD', cwd);
    expect(sh('git rev-list --parents -n 1 HEAD', cwd).trim().split(' ')).toEqual([accepted.trim(), before.trim(), worker.trim()]);
    expect(readFileSync(join(cwd, 'delivery.txt'), 'utf8')).toBe('delivery\n');
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('target\n');
    if (kind === 'target-race') { sh('git commit --allow-empty -qm concurrent', f.repo); targetAfter = sh('git rev-parse HEAD', f.repo); }
    return kind === 'accept-fail' ? 1 : 0;
  };
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try {
    if (kind === 'pass') applyLand(f.run, f.land, verify);
    else expect(() => applyLand(f.run, f.land, verify)).toThrow(kind === 'conflict' ? 'README.md' : kind === 'target-race' ? 'target advanced' : 'acceptance failed');
  } finally { probe.mockRestore(); }
  expect(calls).toBe(kind === 'conflict' ? 0 : 1);
  if (candidate) expect(existsSync(candidate)).toBe(false);
  expect(sh('git rev-parse main', f.repo)).toBe(kind === 'pass' ? accepted : targetAfter);
  if (kind !== 'pass') {
    expect(sh('git rev-parse sa/land', f.repo)).toBe(worker);
    expect(sh('git worktree list --porcelain', f.repo)).toBe(kind === 'target-race' ? worktrees.replace(`HEAD ${before.trim()}`, `HEAD ${targetAfter.trim()}`) : worktrees);
  }
});
// prettier-ignore
test('apply refuses a target checkout changed during acceptance', () => {
  const f = fixture(), before = sh('git rev-parse main', f.repo);
  let candidate = '';
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try { expect(() => applyLand(f.run, f.land, cwd => {
    candidate = cwd;
    sh('git switch -qc operator', f.repo);
    return 0;
  })).toThrow('target checkout changed'); } finally { probe.mockRestore(); }
  expect(sh('git rev-parse main', f.repo)).toBe(before);
  expect(sh('git rev-parse operator', f.repo)).toBe(before);
  expect(sh('git symbolic-ref --short HEAD', f.repo).trim()).toBe('operator');
  expect(existsSync(candidate)).toBe(false);
});
// prettier-ignore
test.each(['dirty', 'tree'])('apply refuses %s before advancing the target', kind => {
  const f = fixture(), before = sh('git rev-parse HEAD', f.repo);
  if (kind === 'dirty') writeFileSync(join(f.repo, 'untracked'), 'keep');
  else sh('echo change >> delivery.txt && git add delivery.txt && git -c user.name=t -c user.email=t@l commit -qm changed', f.worktree);
  expect(() => applyLand(f.run, f.land, () => { throw new Error('must not verify'); })).toThrow(kind === 'dirty' ? 'dirty' : 'tree differs');
  expect(sh('git rev-parse HEAD', f.repo)).toBe(before);
});
// prettier-ignore
test.each([true, false])('selftest wait=%s refreshes the latest fingerprint after an occupied lease', async wait => {
  const root = tmp();
  process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = root;
  const receipt = { ok: true, fake: false, fingerprint: 'fixture', config_hash: config.configHash(), expires_at: new Date(Date.now() + 3600e3).toISOString() };
  const bin = join(root, 'selftest.sh'); process.env.NODE_ENV = 'test'; process.env.SA_SELFTEST_BIN = bin; writeFileSync(bin, `printf '%s' '${JSON.stringify(receipt)}' > '${join(root, 'selftest.json')}'\n`);
  const child = Bun.spawn([process.execPath, '-e', `import { lock } from ${JSON.stringify(join(import.meta.dir, '../src/archon.ts'))}; const l=lock(${JSON.stringify(join(root, 'selftest.lock'))}); if(!l.ok) process.exit(1); console.log('locked'); await Bun.sleep(200); await Bun.write(${JSON.stringify(join(root, 'selftest.json'))}, ${JSON.stringify(JSON.stringify({ ...receipt, fingerprint: 'previous' }))}); l.release();`], { stdout: 'pipe', stderr: 'pipe' });
  await child.stdout.getReader().read();
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try { selftest(wait); } finally { probe.mockRestore(); }
  expect(await child.exited).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'selftest.json'), 'utf8')).fingerprint).toBe('fixture');
});
