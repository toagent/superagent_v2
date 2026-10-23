import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planPrecheck } from '../src/plan-precheck';
import type { Plan } from '../src/plan';
import { tmp } from './helpers';

const fixture = (): string => {
  const root = tmp();
  for (const dir of ['wetamp/tests/scenarios', 'wetamp/scripts', 'wetamp/schemas', 'wetamp/src'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, 'wetamp/scripts/generate-plan-schema.ts'),
    "export const GENERATED_OUTPUT_PATHS = ['wetamp/src/plan-types.generated.ts'];\nconst input = '../schemas/plan.schema.json';\nconst output = '../src/plan-types.generated.ts';\n"
  );
  writeFileSync(join(root, 'wetamp/schemas/plan.schema.json'), '{}');
  return root;
};
const plan = (root: string, write: string[], accept: string[]): Plan =>
  ({
    repo: root,
    base_ref: 'main',
    budget: { weighted_tokens: 1 },
    packages: [
      {
        id: 'core',
        title: 'core',
        goal: 'core',
        scope: { write },
        accept: accept.map(cmd => ({ cmd, timeout_s: 1 })),
        risk: 'G1',
        size: 'S',
      },
    ],
  }) as Plan;

test('wetamp code requires type-check in the first acceptance command', () => {
  const root = fixture();
  expect(planPrecheck(plan(root, ['wetamp/src/foo.ts'], ['bun test']), root).join('\n')).toContain(
    'accept[0] 须含 bun run type-check'
  );
  expect(
    planPrecheck(plan(root, ['wetamp/src/foo.ts'], ['bun run type-check && bun test']), root)
  ).toEqual([]);
});

test('engine paths require all three engine suites or the wildcard suite', () => {
  const root = fixture(),
    write = ['wetamp/src/engine/index.ts'],
    partial = 'bun run type-check && bun test tests/engine-channel.test.ts';
  expect(planPrecheck(plan(root, write, [partial]), root).join('\n')).toContain('三组测试');
  expect(
    planPrecheck(plan(root, write, ['bun run type-check && bun test tests/engine-*.test.ts']), root)
  ).toEqual([]);
});

test('scenario callers missing from scope warn, with hubs downgraded to a hint', () => {
  const root = fixture(),
    subject = plan(root, ['wetamp/src/foo.ts'], ['bun run type-check']);
  writeFileSync(join(root, 'wetamp/tests/scenarios/one.ts'), "import '../../src/foo';\n");
  expect(planPrecheck(subject, root).join('\n')).toContain('scope 缺场景调用方');
  for (const name of ['two.ts', 'three.ts'])
    writeFileSync(join(root, `wetamp/tests/scenarios/${name}`), "import '../../src/foo';\n");
  expect(planPrecheck(subject, root).join('\n')).toContain('枢纽模块提示');
  subject.packages[0].scope.write.push('wetamp/tests/scenarios/');
  expect(planPrecheck(subject, root)).toEqual([]);
});

test('generator inputs require registered outputs; non-engine repos are skipped', () => {
  const root = fixture(),
    subject = plan(root, ['wetamp/schemas/plan.schema.json'], ['bun run type-check']);
  expect(planPrecheck(subject, root).join('\n')).toContain('wetamp/src/plan-types.generated.ts');
  subject.packages[0].scope.write.push('wetamp/src/plan-types.generated.ts');
  expect(planPrecheck(subject, root)).toEqual([]);
  const foreign = tmp();
  expect(planPrecheck(plan(foreign, ['wetamp/src/foo.ts'], ['bun test']), foreign)).toEqual([]);
});
