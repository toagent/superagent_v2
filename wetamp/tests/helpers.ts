import { afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
export const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sa-test-')));
  roots.push(d);
  return d;
};

export const sh = (cmd: string, cwd: string, env: Record<string, string> = {}): string => {
  const p = Bun.spawnSync(['bash', '-c', cmd], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

/** main 分支上一个提交的 repo，外加 bare origin（--branch 需要 origin；不 push）。 */
export function gitRepo(root: string): string {
  const repo = join(root, 'repo');
  sh(
    `git init -q -b main repo && echo hi > repo/README.md && git -C repo add README.md && git -C repo -c user.name=t -c user.email=t@l commit -qm init && git clone -q --bare repo origin.git && git -C repo remote add origin "${root}/origin.git" && git -C repo fetch -q origin`,
    root
  );
  return repo;
}

export function fixturePlan(root: string, repo: string, patch: (p: Record<string, unknown>) => void = () => undefined): string {
  const plan = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'plan-two-pkgs.json'), 'utf8')) as Record<string, unknown>;
  plan.repo = repo;
  patch(plan);
  const p = join(root, 'plan.json');
  writeFileSync(p, JSON.stringify(plan));
  return p;
}
