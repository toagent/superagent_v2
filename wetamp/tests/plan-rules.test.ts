import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPlanRules } from '../src/plan-rules';
import { loadPlan, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const setup = () => {
  const root = tmp(),
    repo = gitRepo(root);
  const source = join(repo, 'tools/qa/gate.py');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'export {}\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm source', repo);
  const path = fixturePlan(root, repo, value => {
    const pkg = (value.packages as Record<string, unknown>[])[0];
    value.packages = [pkg];
    value.base_ref = 'HEAD';
    pkg.scope = { write: ['tools/qa/gate.py'] };
  });
  const rules = (value: unknown) => {
    mkdirSync(join(repo, '.superagent'), { recursive: true });
    writeFileSync(join(repo, '.superagent/rules.json'), JSON.stringify(value));
  };
  return { root, repo, path, plan: () => loadPlan(path, [root]), rules };
};

test('missing and invalid rules preserve context in their results', () => {
  const s = setup(),
    plan = s.plan();
  expect(applyPlanRules(plan)).toEqual({ plan, warnings: [], rejected: false, added: 0 });
  s.rules({ required_checks: [{ when: ['**'], check: { cmd: 'true' } }] });
  expect(() => applyPlanRules(s.plan())).toThrow(/required_checks\/0\/check.*timeout_s/);
  const rulesPath = join(s.repo, '.superagent/rules.json');
  writeFileSync(rulesPath, '{');
  expect(() => applyPlanRules(s.plan())).toThrow(rulesPath);
  expect(() => applyPlanRules(s.plan())).toThrow(/JSON/);
});

test('frozen exact, directory and glob scopes plus size limits reject unless overridden', () => {
  const s = setup();
  s.rules({ frozen: ['tools/qa'], limits: { max_size: 'M' } });
  for (const write of ['tools/qa/gate.py', 'tools/qa/', 'tools/**/*.py']) {
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
  s.rules({ required_checks: [{ when: ['tools/qa'], check }] });
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
  const originalAccept = self.packages[0].accept;
  const wetampChecks = applyPlanRules(self).plan.packages[0].accept;
  expect(wetampChecks.at(-1)?.cmd).toBe('cd wetamp && bun run type-check');
  expect(wetampChecks.at(-1)?.requires_prior_pass).toBeUndefined();
  expect(wetampChecks.some(check => check.cmd === 'cd wetamp && bun run test')).toBe(false);
  expect(wetampChecks.some(check => check.cmd.includes('mutations.test.ts'))).toBe(false);

  self.packages[0].scope.write = ['packages/paths/src/index.ts'];
  expect(applyPlanRules(self).plan.packages[0].accept).toEqual(originalAccept);
});

test('required scope rejects missing companion files even with an override', () => {
  const s = setup();
  s.rules({
    required_scope: [
      {
        when: ['tools/qa'],
        include: ['tools/qa/contract.ts', 'tools/qa/scenario.test.ts'],
      },
    ],
  });
  expect(() => applyPlanRules(s.plan())).toThrow(
    /scope\.write missing tools\/qa\/contract\.ts, tools\/qa\/scenario\.test\.ts/
  );
  expect(() => applyPlanRules(s.plan(), 'approved exception')).toThrow(/required_scope/);

  const complete = s.plan();
  complete.packages[0].scope.write.push('tools/qa/contract.ts', 'tools/qa/scenario.test.ts');
  expect(applyPlanRules(complete).rejected).toBe(false);
  const unrelated = s.plan();
  unrelated.packages[0].scope.write = ['docs/**'];
  expect(applyPlanRules(unrelated).rejected).toBe(false);
});
