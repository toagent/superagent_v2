import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertGeneratedWorkflow, buildWorkflow } from '../src/generate';
import { milestones, type Plan } from '../src/plan';
import { budgetExceeded, netLinesFromNumstat } from '../templates/.archon/scripts/sa-check';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
) as Plan;

test('an absent or unexceeded max_net_lines does not trigger the gate', () => {
  expect(budgetExceeded(undefined, 100)).toBeFalse();
  expect(budgetExceeded(5, 5)).toBeFalse();
});

test('an exceeded budget has one native approval gate and no repair route', () => {
  const plan = structuredClone(fixture);
  plan.packages = [plan.packages[0]];
  plan.packages[0].max_net_lines = 1;
  const workflow = buildWorkflow(plan, milestones(plan), 'budget', '/GEN');
  const nodes = workflow.nodes as {
    id: string;
    when?: string;
    approval?: unknown;
    with?: Record<string, unknown>;
  }[];
  const verify = nodes.find(node => node.id === 'verify-core')!;
  const gate = nodes.find(node => node.id === 'human-budget-core')!;
  expect(budgetExceeded(1, 2)).toBeTrue();
  expect(verify.with).toMatchObject({ run_base: '$sync-m1-ready.output.merge_base' });
  expect(gate).toMatchObject({
    when: "$verify-core.output.reason == 'budget_exceeded'",
    approval: { decisions: [{ id: 'approve' }, { id: 'reject' }] },
  });
  expect(() => assertGeneratedWorkflow(workflow, true)).not.toThrow();
});

test('net lines exclude tests, golden paths and generator-declared outputs', () => {
  const raw = [
    '8\t1\tsrc/main.ts',
    '20\t0\ttests/main.ts',
    '3\t0\tsrc/main.test.ts',
    '9\t0\ttests/golden/result.yaml',
    '7\t0\tgenerated/types.ts',
    '-\t-\tsrc/web/icon.png',
  ].join('\0');
  expect(netLinesFromNumstat(raw, ['generated/types.ts'])).toBe(7);
});

test('net lines exclude conventional test paths and count nearby source names', () => {
  const testPaths = [
    'tests/unit.go',
    'pkg/test/helpers.py',
    'pkg/__tests__/helpers.js',
    'pkg/golden/output.yaml',
    'pkg/server_test.go',
    'pkg/test_routes.py',
    'pkg/routes_test.py',
    'conftest.py',
    'pkg/server_spec.rb',
    ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].flatMap(ext => [
      `pkg/view.test.${ext}`,
      `pkg/view.spec.${ext}`,
    ]),
  ];
  const sourcePaths = [
    'spec/openapi.yaml',
    ...['testing.go', 'contest.py', 'latest.ts', 'attest_utils.py'].map(name => `src/${name}`),
    ...['test', 'tests', '__tests__'].map(name => `src/${name}`),
    'src/conftest.py.bak',
    'src/server_spec.rbs',
    'src/test_routes.py/schema.yaml',
    'src/view.spec.ts/impl.ts',
    'src/view.spec.ts.bak',
  ];
  const rows = testPaths.map(path => `5\t0\t${path}`);
  rows.push(...sourcePaths.map(path => `2\t1\t${path}`));
  expect(netLinesFromNumstat(rows.join('\0'), [])).toBe(sourcePaths.length);
});
