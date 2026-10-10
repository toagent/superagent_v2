import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflow, generate, newRunId, renderBrief } from '../src/generate';
import { install } from '../src/config';
import { loadPlan, milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'plan-two-pkgs.json'), 'utf8')
) as Plan;
const golden = (name: string): unknown =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, 'golden', `${name}.yaml`), 'utf8'));
// 语义比对：lint-staged 会对 YAML 跑 prettier，字节比对没有意义。
const NOW = Date.parse('2026-10-09T00:00:00Z');
const build = (fake: boolean, plan = fixture): unknown =>
  JSON.parse(
    JSON.stringify(buildWorkflow(plan, milestones(plan), 'golden-0001', '/GEN', fake, NOW))
  );
type N = {
  id: string;
  depends_on?: string[];
  trigger_rule?: string;
  when?: string;
  wait?: { event: string; deadline_ms: number };
  with?: Record<string, unknown>;
};
const nodesOf = (w: unknown): N[] => (w as { nodes: N[] }).nodes;

describe('buildWorkflow', () => {
  test('golden: two packages across two milestones', () => {
    expect(build(false)).toEqual(golden('two-pkgs'));
  });
  test('golden: fake mode swaps coder nodes for bash stubs only', () => {
    expect(build(true)).toEqual(golden('two-pkgs-fake'));
  });
  test('packages run serially; milestones join their three gates; signed-off milestone waits for a human; land is last', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('start-m1')?.depends_on).toEqual(['environment']);
    expect(n('code-core')?.depends_on).toEqual(['start-m1']);
    expect(n('start-m2')).toMatchObject({
      depends_on: ['gate-m1-r1', 'gate-m1-r2', 'gate-m1-r3'],
      trigger_rule: 'none_failed_min_one_success',
    });
    expect(n('human-m2')).toMatchObject({
      wait: { event: 'sa.human.m2' },
      trigger_rule: 'none_failed_min_one_success',
    });
    expect(n('signoff-m2')?.depends_on).toEqual(['human-m2']);
    expect(n('land')?.depends_on).toEqual(['signoff-m2']);
    expect(nodes.at(-1)?.id).toBe('land');
  });
  test('review rounds: fix only when the previous gate says fix; later gates see every earlier round', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('fix-m1-r1')).toBeUndefined();
    expect(n('fix-m1-r2')).toMatchObject({
      depends_on: ['gate-m1-r1'],
      when: "$gate-m1-r1.output.verdict == 'fix'",
    });
    expect(n('diff-m1-r3')?.depends_on).toEqual(['fix-m1-r3']);
    expect(
      Object.keys(n('gate-m1-r3')?.with ?? {})
        .filter(k => /^[RC]\d$/.test(k))
        .sort()
    ).toEqual(['C1', 'C2', 'C3', 'R1', 'R2', 'R3']);
    expect(n('review-m1-r2')).toMatchObject({
      command: 'sa-review-delta',
      mutates_checkout: false,
    });
  });
  test('unchanged fix diff: diff-rN compares with the previous hash, review is skipped, gate still runs', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('diff-m1-r1')?.with?.prev).toBeUndefined();
    expect(n('diff-m1-r2')?.with?.prev).toBe('$diff-m1-r1.output.diff_hash');
    expect(n('review-m1-r1')?.when).toBeUndefined();
    expect(n('review-m1-r2')?.when).toBe("$diff-m1-r2.output.same != 'true'");
    expect(n('gate-m1-r2')).toMatchObject({
      depends_on: ['diff-m1-r2', 'review-m1-r2'],
      trigger_rule: 'none_failed_min_one_success',
    });
  });
  test('signoff and land check the absolute plan deadline, not only the relative wait', () => {
    const nodes = nodesOf(build(false, { ...fixture, deadline: '2026-10-10T00:00:00Z' }));
    const signoff = nodes.find(x => x.id === 'signoff-m2') as N & { bash: string };
    expect(signoff.bash).toContain(`-le ${String(Date.parse('2026-10-10T00:00:00Z') / 1000)} ]`);
    expect(nodes.find(x => x.id === 'land')?.with).toMatchObject({
      kind: 'land',
      plan: '/GEN/plan.json',
    });
  });
  test('without human signoff the next step joins the gates directly', () => {
    const plan = {
      ...fixture,
      packages: fixture.packages.map(p => ({ ...p, signoff: undefined })),
    };
    const nodes = nodesOf(build(false, plan));
    expect(nodes.find(x => x.id === 'human-m2')).toBeUndefined();
    expect(nodes.find(x => x.id === 'land')?.depends_on).toEqual([
      'gate-m2-r1',
      'gate-m2-r2',
      'gate-m2-r3',
    ]);
  });
  test('human wait deadline is the time left to the plan deadline, no floor; a passed deadline fails generation', () => {
    const wait = (deadline: string): number | undefined =>
      nodesOf(build(false, { ...fixture, deadline })).find(x => x.id === 'human-m2')?.wait
        ?.deadline_ms;
    expect(wait('2026-10-10T00:00:00Z')).toBe(24 * 3600 * 1000);
    expect(wait('2026-10-09T00:05:00Z')).toBe(5 * 60 * 1000);
    expect(() => wait('2026-10-09T00:00:00Z')).toThrow(
      /plan invalid: \/deadline .* already passed/
    );
    expect(() => wait('2026-10-08T00:00:00Z')).toThrow(/already passed/);
  });
  test('claude nodes deny nested agents; codex nodes leave it to codex-worker', () => {
    const denied = (console: 'claude' | 'codex', id: string): unknown =>
      (
        nodesOf(build(false, { ...fixture, console })).find(x => x.id === id) as Record<
          string,
          unknown
        >
      ).denied_tools;
    // console=codex：@sa-reviewer 解析为 claude；@sa-coder 是 codex
    expect(denied('codex', 'review-m1-r1')).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'Bash(codex *)', 'Edit', 'Write', 'MultiEdit'])
    );
    expect(denied('codex', 'code-core')).toBeUndefined();
    expect(denied('claude', 'review-m1-r1')).toBeUndefined();
  });
  test('plan prose never enters the workflow text (no $ substitution hazard)', () => {
    expect(JSON.stringify(build(false))).not.toContain('$HOME');
  });
});

describe('renderBrief', () => {
  test('carries goal, write scope, accept commands and hint path verbatim', () => {
    const b = renderBrief(fixture.packages[0], '/H/core.md');
    for (const s of [
      '$HOME and $ARTIFACTS_DIR literal',
      '`core.txt`',
      '`test -f core.txt`',
      '`README.md`',
      '/H/core.md',
    ])
      expect(b).toContain(s);
  });
  test('placeholders inside plan text are not expanded', () => {
    const p = { ...fixture.packages[0], goal: 'keep {{hint}} and $1 literal' };
    expect(renderBrief(p, '/H/core.md')).toContain('keep {{hint}} and $1 literal');
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
  for (const f of [
    '.archon/workflows/sa-gen-0001/sa-gen-0001.yaml',
    '.archon/commands/sa-code.md',
    '.archon/scripts/sa-check.ts',
    'briefs/core.md',
    'plan.json',
  ])
    expect(existsSync(join(g.dir, f))).toBe(true);
  expect(sh('git status --porcelain', g.dir)).toBe('');
}, 60000);
