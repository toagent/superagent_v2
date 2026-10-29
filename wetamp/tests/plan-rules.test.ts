import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPlanRules, freezePlanRules } from '../src/plan-rules';
import { loadPlan, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const setup = () => {
  const root = tmp(),
    repo = gitRepo(root);
  const source = join(repo, 'wetamp/src/frozen.ts');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'export {}\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm source', repo);
  const path = fixturePlan(root, repo, value => {
    const pkg = (value.packages as Record<string, unknown>[])[0];
    value.packages = [pkg];
    value.base_ref = 'HEAD';
    pkg.scope = { write: ['wetamp/src/frozen.ts'] };
  });
  const rules = (value: unknown) => {
    mkdirSync(join(repo, '.superagent'), { recursive: true });
    writeFileSync(join(repo, '.superagent/rules.json'), JSON.stringify(value));
  };
  return { root, repo, path, plan: () => loadPlan(path, [root]), rules };
};

test('missing rules preserve the plan; invalid rules fail with the field path', () => {
  const s = setup(),
    plan = s.plan();
  expect(applyPlanRules(plan)).toEqual({ plan, warnings: [], rejected: false, added: 0 });
  s.rules({ required_checks: [{ when: ['**'], check: { cmd: 'true' } }] });
  expect(() => applyPlanRules(s.plan())).toThrow(/required_checks\/0\/check.*timeout_s/);
});

test('frozen exact, directory and glob scopes plus size limits reject unless overridden', () => {
  const s = setup();
  s.rules({ frozen: ['wetamp/src/**'], limits: { max_size: 'M' } });
  for (const write of ['wetamp/src/frozen.ts', 'wetamp/src/', 'wetamp/**/*.ts']) {
    const plan = s.plan();
    plan.packages[0].scope.write = [write];
    expect(applyPlanRules(plan).rejected).toBe(true);
  }
  const unrelated = s.plan();
  unrelated.packages[0].scope.write = ['docs/**'];
  expect(applyPlanRules(unrelated).rejected).toBe(false);
  const large = s.plan();
  large.packages[0].size = 'L';
  expect(applyPlanRules(large).warnings.join('\n')).toContain('limits.max_size M');
  expect(applyPlanRules(large, 'approved exception').rejected).toBe(false);
});

test('required checks append once without changing requirement indexes or obeying override', () => {
  const s = setup(),
    check = { cmd: 'required-check', timeout_s: 9 };
  s.rules({ required_checks: [{ when: ['wetamp/src/**'], check }] });
  const plan = s.plan();
  plan.packages[0].requirements = [{ id: 'r', text: 'kept', verified_by: [0] }];
  const applied = applyPlanRules(plan, 'does not skip checks');
  expect(applied.plan.packages[0].accept.at(-1)).toEqual(check);
  expect(applied.plan.packages[0].requirements?.[0].verified_by).toEqual([0]);
  expect(applyPlanRules(applied.plan).added).toBe(0);
  const unmatched = s.plan();
  unmatched.packages[0].scope.write = ['docs/**'];
  expect(applyPlanRules(unmatched).plan.packages[0].accept).toEqual(unmatched.packages[0].accept);

  const repo = join(import.meta.dir, '../..'),
    self = s.plan() as Plan;
  self.repo = repo;
  self.base_ref = sh('git rev-parse HEAD', repo).trim();
  self.packages[0].scope.write = ['wetamp/src/plan-rules.ts'];
  expect(applyPlanRules(self).plan.packages[0].accept.at(-1)?.cmd).toBe(
    'cd wetamp && bun run type-check'
  );
});

test('frozen rule content and hash are copied to continuations without rereading the repo', () => {
  const s = setup(),
    original = JSON.stringify({ required_checks: [] });
  s.rules(JSON.parse(original));
  const plan = applyPlanRules(s.plan()).plan;
  const base = join(s.root, 'gen'),
    continuation = join(base, 'continuation');
  mkdirSync(continuation, { recursive: true });
  freezePlanRules(plan, base);
  s.rules({ frozen: ['**'] });
  freezePlanRules({ ...plan } as Plan, continuation, base);
  expect(JSON.parse(readFileSync(join(continuation, 'project-rules.json'), 'utf8'))).toEqual({
    rules: JSON.parse(original),
    sha256: createHash('sha256').update(original).digest('hex'),
  });
});
