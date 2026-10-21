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
  ].join('\0');
  expect(netLinesFromNumstat(raw, ['generated/types.ts'])).toBe(7);
});
