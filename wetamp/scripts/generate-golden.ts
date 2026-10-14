// Own the workflow golden fixtures; never edit their YAML by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildWorkflow } from '../src/generate';
import { milestones, type Plan } from '../src/plan';

const YAML = createRequire(join(import.meta.dir, '../../packages/server/package.json'))('yaml') as {
  stringify(value: unknown, options: Record<string, unknown>): string;
};

const tests = join(import.meta.dir, '../tests');
const plan = JSON.parse(readFileSync(join(tests, 'fixtures/plan-two-pkgs.json'), 'utf8')) as Plan;
for (const fake of [false, true]) {
  const workflow = buildWorkflow(
    plan,
    milestones(plan),
    'golden-0001',
    '/GEN',
    fake,
    Date.parse('2026-10-09T00:00:00Z')
  );
  writeFileSync(
    join(tests, 'golden', `two-pkgs${fake ? '-fake' : ''}.yaml`),
    YAML.stringify(workflow, { lineWidth: 0, aliasDuplicateObjects: false, singleQuote: true })
  );
}
