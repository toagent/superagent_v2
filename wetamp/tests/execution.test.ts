import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeExecution,
  executionLaunch,
  executionNode,
  executionRoute,
  executionTable,
  readExecution,
} from '../src/execution';
import { effortFor, loadTiers } from '../src/config';
import type { Plan } from '../src/plan';
import { tmp } from './helpers';
import { executePolicy } from '../src/policy-executor';
import { effectiveBudget } from '../templates/.archon/scripts/sa-check';

const tiers = loadTiers();
const plan = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
) as Plan;

test('frozen descriptors and both entry points share risk/round effort and native profiles', () => {
  for (const risk of ['G0', 'G1', 'G2'] as const)
    for (const role of ['code', 'repair', 'review'] as const)
      for (const round of [1, 2, 3]) {
        const descriptor = describeExecution(tiers, role, risk, round);
        const route = executionRoute(tiers, 'codex', 'strict', descriptor, [
          tiers.routing.coder.models[0],
        ]);
        for (const candidate of route.candidates) {
          expect(candidate.effort).toBe(effortFor(tiers, role, risk, round));
          expect(executionLaunch(descriptor, candidate).readonly).toBe(role === 'review');
          expect(String(executionNode(descriptor, candidate, '/readonly.json').effort)).toBe(
            candidate.effort
          );
        }
      }
  const descriptor = describeExecution(tiers, 'review', 'G2');
  const authors = tiers.routing.reviewer.by_console.codex;
  expect(() => executionRoute(tiers, 'codex', 'strict', descriptor, authors)).toThrow(
    'no eligible review'
  );
});

test('new runs read persisted identities; only missing tables use the historical adapter', () => {
  const path = join(tmp(), 'execution.json');
  const table = executionTable(plan, tiers);
  const [node, descriptor] = Object.entries(table)[0];
  expect(readExecution(path, plan, tiers, node)).toEqual(descriptor);
  // Deliberately change the input plan: a new run must not reconstruct it at dispatch.
  writeFileSync(path, JSON.stringify(table));
  expect(readExecution(path, { ...plan, packages: [] }, tiers, node)).toEqual(descriptor);
  expect(() => readExecution(path, plan, tiers, 'unknown')).toThrow('unknown node');
  writeFileSync(path, '{');
  expect(() => readExecution(path, plan, tiers, node)).toThrow();
  const missing = join(tmp(), 'execution.json');
  writeFileSync(join(missing, '..', 'engine.json'), JSON.stringify({ execution_contract: 1 }));
  expect(() => readExecution(missing, plan, tiers, node)).toThrow('execution table missing');
});

test('explicit unlimited tokens ignores reserves and spend while preserving launch admission', async () => {
  const candidate = { provider: 'codex' as const, model: 'fixture', effort: 'medium' };
  let calls = 0;
  const execution = {
    node: 'code-fixture',
    candidates: [candidate],
    artifacts: tmp(),
    provider: 'codex' as const,
    budget: { weighted_tokens: 0, unlimited_tokens: true as const, launches: 2 },
    floor: 100,
    events: () => [],
    options: () => ({}),
    async *sendQuery() {
      calls++;
      yield { type: 'result' as const, tokens: { input: 1e16, output: 0 } };
      yield { type: 'settled' as const };
    },
  };
  const collect = async () => {
    const chunks = [];
    for await (const c of executePolicy(execution, '', '/scratch')) chunks.push(c);
    return chunks;
  };
  expect((await collect()).at(-2)).not.toHaveProperty('failure');
  expect((await collect()).at(-2)).not.toHaveProperty('failure');
  expect((await collect()).at(-2)).toMatchObject({ failure: { class: 'budget_exceeded' } });
  expect(calls).toBe(2);
  expect(
    effectiveBudget(
      execution.budget,
      { milestone: 'm1', attempt: 0, limits: { weighted_tokens: 10, launches: 3 } },
      'm1',
      0
    ).unlimited_tokens
  ).toBe(true);
});
