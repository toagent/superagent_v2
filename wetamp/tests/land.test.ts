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
  sh(`git worktree add -qb sa/land '${worktree}'`, repo);
  sh('echo delivery > delivery.txt && git add delivery.txt && git -c user.name=t -c user.email=t@l commit -qm delivery', worktree);
  const head = sh('git rev-parse HEAD', worktree).trim();
  const land: Land = { repo, target: 'main', ff: true, branch: 'sa/land', head, commands: [], debt: [] };
  const run = { id: 'r', status: 'completed' as const, working_path: worktree, nodes: [{ nodeId: 'land', state: 'completed' }] };
  return { root, repo, worktree, art, land, run };
};
// prettier-ignore
test('apply checks the accepted tree in the target checkout, reuses cache and cleans worktree/branch', () => {
  const f = fixture(), counter = join(f.root, 'calls');
  const plan = fixturePlan(f.root, f.repo, p => { p.packages = [{ id: 'p', accept: [{ cmd: `echo checked >> '${counter}'`, timeout_s: 2, cache: true }] }]; });
  const verify = (cwd: string) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts')], {
    cwd, env: { ...process.env, INPUTS_KIND: 'accept', INPUTS_PLAN: plan, INPUTS_PKGS: 'p', INPUTS_TAG: 'land-check', ARTIFACTS_DIR: f.art }, stdout: 'pipe', stderr: 'pipe',
  }).exitCode;
  expect(verify(f.worktree)).toBe(0);
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try { applyLand(f.run, f.land, cwd => { expect(cwd).toBe(f.repo); expect(sh('git rev-parse HEAD', cwd).trim()).toBe(f.land.head); return verify(cwd); }); }
  finally { probe.mockRestore(); }
  expect(sh('git rev-parse HEAD', f.repo).trim()).toBe(f.land.head);
  expect(readFileSync(counter, 'utf8')).toBe('checked\n');
  expect(readFileSync(join(f.art, 'land-check.log'), 'utf8')).toContain('reused pass');
  expect(existsSync(f.worktree)).toBe(false);
  expect(sh('git branch --list sa/land', f.repo).trim()).toBe('');
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
test('preflight selftest waits for the occupied lease and rechecks its receipt', async () => {
  const root = tmp();
  process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = root;
  const receipt = { ok: true, fake: false, fingerprint: 'fixture', config_hash: config.configHash(), expires_at: new Date(Date.now() + 3600e3).toISOString() };
  const child = Bun.spawn([process.execPath, '-e', `import { lock } from ${JSON.stringify(join(import.meta.dir, '../src/archon.ts'))}; const l=lock(${JSON.stringify(join(root, 'selftest.lock'))}); if(!l.ok) process.exit(1); console.log('locked'); await Bun.sleep(200); await Bun.write(${JSON.stringify(join(root, 'selftest.json'))}, ${JSON.stringify(JSON.stringify(receipt))}); l.release();`], { stdout: 'pipe', stderr: 'pipe' });
  await child.stdout.getReader().read();
  const probe = spyOn(config, 'runtimeFingerprint').mockReturnValue('fixture');
  try { selftest(true); } finally { probe.mockRestore(); }
  expect(await child.exited).toBe(0);
});
