import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../src/plan';
import { contextPack, type RoleContext } from '../templates/.archon/scripts/sa-context';
import { tmp } from './helpers';

test('read_hint maps primary checkout paths and reports missing worktree files', () => {
  const gen = tmp(),
    primary = tmp(),
    worktree = tmp();
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  const mapped = join(primary, 'src/mapped.ts');
  const missing = join(primary, 'src/missing.ts');
  plan.packages[0].scope = { write: [], read_hint: [mapped, missing] };
  mkdirSync(join(gen, 'briefs'));
  mkdirSync(join(worktree, 'src'));
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'briefs/core.md'), 'TASK');
  writeFileSync(join(worktree, 'src/mapped.ts'), 'WORKTREE_SOURCE');
  const context = {
    node: 'code-core',
    cwd: worktree,
    codegraph: { projectPath: primary },
    refs: {},
    execution: { packages: ['core'], scope: [] },
    environment: 'unknown',
    environment_check: 'unknown',
    capabilities: { injected: [], unavailable: [] },
  } as unknown as RoleContext;
  const pack = contextPack(gen, context);
  expect(pack).toContain('WORKTREE_SOURCE');
  expect(pack).toContain(`## 源码 ${missing}`);
  expect(pack).toContain('未内联（当前 worktree 中不存在），需自行读取或请主控补全');
});
