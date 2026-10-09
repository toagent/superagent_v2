import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflow, generate, newRunId, renderBrief } from '../src/generate';
import { install } from '../src/config';
import { loadPlan, milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'plan-two-pkgs.json'), 'utf8')) as Plan;
const golden = (name: string): unknown => Bun.YAML.parse(readFileSync(join(import.meta.dir, 'golden', `${name}.yaml`), 'utf8'));
// 语义比对：lint-staged 会对 YAML 跑 prettier，字节比对没有意义。
const build = (fake: boolean): unknown => JSON.parse(JSON.stringify(buildWorkflow(fixture, milestones(fixture), 'golden-0001', '/GEN', fake)));

describe('buildWorkflow', () => {
  test('golden: two packages across two milestones', () => {
    expect(build(false)).toEqual(golden('two-pkgs'));
  });
  test('golden: fake mode swaps coder nodes for bash stubs only', () => {
    expect(build(true)).toEqual(golden('two-pkgs-fake'));
  });
  test('packages run serially; next milestone starts after previous gate; land is last', () => {
    const nodes = (build(false) as { nodes: { id: string; depends_on?: string[] }[] }).nodes;
    const dep = (id: string): string[] | undefined => nodes.find(n => n.id === id)?.depends_on;
    expect(dep('code-core')).toEqual(['environment']);
    expect(dep('code-api')).toEqual(['gate-m1']);
    expect(dep('land')).toEqual(['gate-m2']);
  });
  test('plan prose never enters the workflow text (no $ substitution hazard)', () => {
    expect(JSON.stringify(build(false))).not.toContain('$HOME');
  });
});

describe('renderBrief', () => {
  test('carries goal, write scope, accept commands and hint path verbatim', () => {
    const b = renderBrief(fixture.packages[0], '/H/core.md');
    for (const s of ['$HOME and $ARTIFACTS_DIR literal', '`core.txt`', '`test -f core.txt`', '`README.md`', '/H/core.md']) expect(b).toContain(s);
  });
});

test('newRunId is sortable timestamp plus 4 hex', () => {
  expect(newRunId(new Date('2026-10-09T01:02:03Z'))).toMatch(/^20261009-010203-[0-9a-f]{4}$/);
});

test('generate writes a committed gen repo that archon validates', () => {
  const root = tmp();
  const env = { SUPERAGENT_HOME: join(root, 'home'), ARCHON_HOME: join(root, 'home', 'archon') };
  Object.assign(process.env, env);
  install();
  const plan = loadPlan(fixturePlan(root, gitRepo(root)), [root]);
  const g = generate(plan, 'gen-0001');
  expect(g.workflow).toBe('sa-gen-0001');
  for (const f of ['.archon/workflows/sa-gen-0001/sa-gen-0001.yaml', '.archon/commands/sa-code.md', '.archon/scripts/sa-check.ts', 'briefs/core.md', 'plan.json'])
    expect(existsSync(join(g.dir, f))).toBe(true);
  expect(sh('git status --porcelain', g.dir)).toBe('');
}, 60000);
