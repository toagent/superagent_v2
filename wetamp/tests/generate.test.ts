import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkflow,
  capsDenied,
  engineHash,
  generate,
  newRunId,
  renderBrief,
} from '../src/generate';
import { install, WETAMP } from '../src/config';
import { capsOf, loadPlan, milestones, type Plan } from '../src/plan';
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
const capsOfAll = (c: Plan['caps']) => capsOf({ ...fixture, caps: c }, fixture.packages[0], []);
type N = {
  id: string;
  command?: string;
  script?: string;
  bash?: string;
  depends_on?: string[];
  trigger_rule?: string;
  when?: string;
  wait?: { event: string; deadline_ms: number };
  with?: Record<string, unknown>;
};
const nodesOf = (w: unknown): N[] => (w as { nodes: N[] }).nodes;

test('HF3 fingerprint is stable and changes with template bytes or generation logic', () => {
  const root = tmp();
  for (const path of ['templates', 'src', 'schemas'])
    fs.cpSync(join(WETAMP, path), join(root, path), { recursive: true });
  fs.copyFileSync(join(WETAMP, 'tiers.json'), join(root, 'tiers.json'));
  const hash = engineHash(root);
  expect(engineHash(root)).toBe(hash);
  const script = join(root, 'templates/.archon/scripts/sa-check.ts');
  fs.appendFileSync(script, '\n// changed template\n');
  expect(engineHash(root)).not.toBe(hash);
  fs.copyFileSync(join(WETAMP, 'templates/.archon/scripts/sa-check.ts'), script);
  expect(engineHash(root)).toBe(hash);
  fs.appendFileSync(join(root, 'src/generate.ts'), '\n// changed generation\n');
  expect(engineHash(root)).not.toBe(hash);
});

describe('buildWorkflow', () => {
  test('golden: two packages across two milestones', () => {
    expect(build(false)).toEqual(golden('two-pkgs'));
  });
  test('golden: fake mode swaps coder nodes for bash stubs only', () => {
    expect(build(true)).toEqual(golden('two-pkgs-fake'));
  });
  test('HF4: an adopted checkout still reviews pre-existing commits with zero coder delta', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const original = sh('git rev-parse HEAD', repo).trim();
    sh('git switch -qc sa/adopted', repo);
    sh(
      'echo delivered > delivered.txt && git add delivered.txt && git -c user.name=t -c user.email=t@l commit -qm delivered',
      repo
    );
    const nodes = nodesOf(build(false));
    const n = (id: string): N => nodes.find(x => x.id === id)!;
    for (const id of ['start-m1', 'start-m2']) {
      const start = JSON.parse(sh(n(id).bash!, repo)) as { head: string };
      expect(start.head).toBe(original);
      expect(sh(`git diff --binary ${start.head} HEAD`, repo)).toContain('+delivered');
      expect(sh('git diff HEAD HEAD', repo)).toBe('');
    }
    sh(`git branch "base'quoted" ${original}`, repo);
    const quoted = nodesOf(build(false, { ...fixture, base_ref: "base'quoted" }));
    const start = JSON.parse(sh(quoted.find(x => x.id === 'start-m1')!.bash!, repo)) as {
      head: string;
    };
    expect(start.head).toBe(original);
    expect(n('diff-m1-r1').with?.base).toBe('$start-m1.output.head');
    expect(n('review-m1-r1').with?.diff).toBe('$diff-m1-r1.output.patch');
    expect(n('review-m1-r1').when).not.toContain('same');
    expect(n('review-m2-r1').with?.briefs).toBe('/GEN/briefs/core.md /GEN/briefs/api.md');
    expect(n('verify-api').with?.scope_pkgs).toBe('core,api');
    expect(n('diff-m2-r1').with?.scope_pkgs).toBe('core,api');
    const reversed = nodesOf(
      build(false, { ...fixture, packages: [...fixture.packages].reverse() })
    );
    expect(reversed.find(x => x.id === 'verify-api')?.with?.scope_pkgs).toBe('core,api');
    expect(n('review-m1-r2').with?.full_diff).toBe('$diff-m1-r2.output.patch');
    expect(n('review-m1-r2').with?.diff).toBe('$diff-m1-r2.output.delta');
  });
  test('every $INPUTS.<name> a command template reads is bound by its node', () => {
    const nodes = nodesOf(build(false)) as (N & { command?: string })[];
    for (const x of nodes.filter(k => k.command)) {
      const md = readFileSync(
        join(import.meta.dir, '..', 'templates', '.archon', 'commands', `${x.command ?? ''}.md`),
        'utf8'
      );
      // Archon 的变量名可含 '-'：`$INPUTS.round-1` 会被当成名为 round-1 的输入
      const used = [...md.matchAll(/\$INPUTS\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
      expect({ node: x.id, missing: used.filter(u => !(u in (x.with ?? {}))) }).toEqual({
        node: x.id,
        missing: [],
      });
    }
  });
  test('packages run serially; milestones join their three gates; signed-off milestone waits for a human; land is last', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('start-m1')?.depends_on).toEqual(['environment']);
    expect(n('code-core')?.depends_on).toEqual(['start-m1', 'attempt-m1']);
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
      depends_on: ['gate-m1-r1', 'attempt-m1'],
      when: "$gate-m1-r1.output.verdict == 'fix'",
    });
    expect(n('diff-m1-r3')?.depends_on).toEqual(['fix-m1-r3', 'attempt-m1']);
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
    expect(n('review-m1-r1')?.when).toBe("$diff-m1-r1.output.disposition == 'advance'");
    expect(n('review-m1-r2')?.when).toBe(
      "$diff-m1-r2.output.disposition == 'advance' && $diff-m1-r2.output.same != 'true'"
    );
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
  test('reviewer nodes are read-only at the execution layer in both consoles', () => {
    const node = (console: 'claude' | 'codex', id: string): Record<string, unknown> =>
      nodesOf(build(false, { ...fixture, console })).find(x => x.id === id) as Record<
        string,
        unknown
      >;
    // console=claude：@sa-reviewer 是 codex，挂哨兵 MCP 交给 codex-worker 的代理；console=codex：claude 走 SDK 沙箱
    for (const id of ['review-m1-r1', 'review-m2-r3']) {
      expect(node('claude', id)).toMatchObject({ mcp: '/GEN/reviewer-readonly.mcp.json' });
      expect(node('claude', id).sandbox).toBeUndefined();
      expect(node('codex', id).sandbox).toEqual({
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: ['/'] },
      });
      expect(node('codex', id).mcp).toBeUndefined();
    }
    for (const c of ['claude', 'codex'] as const) {
      expect(node(c, 'code-core').sandbox).toBeUndefined();
      expect(node(c, 'code-core').mcp).toBeUndefined();
    }
  });
  test('attempt-<m> always runs and gates the coder, accept and fix nodes, not review or gate', () => {
    const nodes = nodesOf(build(false));
    expect(nodes.find(x => x.id === 'attempt-m1')).toMatchObject({
      depends_on: ['start-m1'],
      always_run: true,
    });
    expect(JSON.stringify(nodes.find(x => x.id === 'attempt-m1'))).toContain('/GEN/attempts/m1');
    const on = nodes.filter(x => x.depends_on?.includes('attempt-m1')).map(x => x.id);
    expect(on).toEqual(
      expect.arrayContaining(['code-core', 'verify-core', 'diff-m1-r1', 'fix-m1-r2'])
    );
    expect(on.some(id => /^(review|gate)-/.test(id))).toBe(false);
  });
  test('tightened caps map to Claude denied_tools; defaults deny nothing', () => {
    // 默认 tiers 的 @sa-coder 是 codex（caps 提示级）；Claude 将军节点把 capsDenied 并入 denied_tools
    expect(capsDenied(capsOfAll({ network: false, git: 'commit' }))).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Bash(curl *)', 'Bash(git rebase*)'])
    );
    expect(capsDenied(capsOfAll({}))).toEqual([]);
    expect(capsDenied(capsOfAll({ web: false }))).toEqual(['WebFetch', 'WebSearch']);
    expect(capsDenied(capsOfAll({ install: false, services: false }))).toEqual(
      expect.arrayContaining(['Bash(npm install *)', 'Bash(bun add *)', 'Bash(docker *)'])
    );
  });
  test('plan prose never enters the workflow text (no $ substitution hazard)', () => {
    expect(JSON.stringify(build(false))).not.toContain('$HOME');
  });
});

describe('renderBrief', () => {
  test('carries goal, write scope, accept commands and hint path verbatim', () => {
    const b = renderBrief(
      fixture.packages[0],
      '/H/core.md',
      capsOf(fixture, fixture.packages[0], [])
    );
    for (const s of [
      '$HOME and $ARTIFACTS_DIR literal',
      '`core.txt`',
      '`test -f core.txt`',
      '`README.md`',
      '/H/core.md',
    ])
      expect(b).toContain(s);
  });
  test('lists the package permissions and the execution-layer red lines', () => {
    const p = { ...fixture.packages[0], caps: { network: false, git: 'commit' as const } };
    const b = renderBrief(p, '/H/core.md', capsOf(fixture, p, ['searxng']));
    for (const s of [
      '## 你的权限',
      '包仓库）：禁止',
      '只追加提交',
      'searxng',
      '## 红线（执行层强制）',
      'deviations',
    ])
      expect(b).toContain(s);
  });
  test('placeholders inside plan text are not expanded', () => {
    const p = { ...fixture.packages[0], goal: 'keep {{hint}} and $1 literal' };
    expect(renderBrief(p, '/H/core.md', capsOf(fixture, p, []))).toContain(
      'keep {{hint}} and $1 literal'
    );
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
  const principles = readFileSync(join(WETAMP, 'templates', '.archon', 'principles.md'), 'utf8');
  const generated = Bun.YAML.parse(
    readFileSync(join(g.dir, '.archon', 'workflows', g.workflow, `${g.workflow}.yaml`), 'utf8')
  );
  const ai = nodesOf(generated).filter(n => n.command);
  expect([...new Set(ai.map(n => n.command))].sort()).toEqual([
    'sa-code',
    'sa-fix',
    'sa-repair',
    'sa-review',
    'sa-review-delta',
  ]);
  for (const n of ai) {
    const prompt = readFileSync(join(g.dir, '.archon', 'commands', `${n.command}.md`), 'utf8');
    expect(prompt.startsWith(principles + '\n')).toBe(true);
    expect(prompt.split(principles)).toHaveLength(2);
  }
  for (const n of nodesOf(generated).filter(n => n.script || n.bash)) {
    expect(n.bash ?? '').not.toContain(principles);
    if (n.script) {
      const path = join('.archon', 'scripts', `${n.script}.ts`);
      expect(readFileSync(join(g.dir, path), 'utf8')).toBe(
        readFileSync(join(WETAMP, 'templates', path), 'utf8')
      );
    }
  }
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
  // 哨兵 required 且命令必败：不经 codex-readonly-proxy 时 Codex 线程起不来
  expect(JSON.parse(readFileSync(join(g.dir, 'reviewer-readonly.mcp.json'), 'utf8'))).toEqual({
    'superagent-reviewer-readonly': { command: 'false', required: true },
  });
  // console=codex 的评审节点带 sandbox，Archon 校验同样通过
  const codex = loadPlan(
    fixturePlan(root, plan.repo, p => (p.console = 'codex')),
    [root]
  );
  expect(generate(codex, 'gen-0002').workflow).toBe('sa-gen-0002');
  expect(readlinkSync(join(g.dir, 'archon'))).toEndWith('/bin/archon');
  expect(JSON.parse(readFileSync(join(g.dir, 'policy.json'), 'utf8')).budget_floor).toMatchObject({
    S: 200000,
  });
  // F-16：预算低于各包 size 的 budget_floor 之和（S+M）时在生成期拒绝，不等到运行中途挂起
  const thin = loadPlan(
    fixturePlan(root, plan.repo, p => (p.budget = { weighted_tokens: 700000 })),
    [root]
  );
  expect(() => generate(thin, 'gen-0003')).toThrow(/budget_floor sum 800000/);
  const fake = generate(plan, 'gen-fake', true);
  for (const command of new Set(ai.map(n => n.command))) {
    const path = join('.archon', 'commands', `${command}.md`);
    expect(readFileSync(join(fake.dir, path), 'utf8')).toBe(
      readFileSync(join(WETAMP, 'templates', path), 'utf8')
    );
  }
}, 60000);

test('generate fails clearly before writing gen when core principles are missing', () => {
  const root = tmp();
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: join(root, 'archon') });
  const read = fs.readFileSync;
  const principlesPath = join(WETAMP, 'templates', '.archon', 'principles.md');
  const spy = spyOn(fs, 'readFileSync').mockImplementation(
    new Proxy(read, {
      apply(target, thisArg, args) {
        if (args[0] === principlesPath) args[0] = join(root, 'missing-principles.md');
        return Reflect.apply(target, thisArg, args);
      },
    })
  );
  try {
    expect(() => generate(fixture, 'missing-principles')).toThrow(
      `cannot read required core principles: ${principlesPath}`
    );
    expect(existsSync(join(root, 'gen'))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
