import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkflow,
  capsDenied,
  engineHash,
  residentHash,
  generate,
  newRunId,
  renderBrief,
} from '../src/generate';
import { install, loadTiers, snapshotPolicy, WETAMP } from '../src/config';
import * as coord from '../src/coord';
import * as archon from '../src/archon';
import { lastJson } from '../src/archon';
import { capsOf, loadPlan, milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import { CHECK_AUX_COUNTS, CHECK_AUX_TIMEOUT_MS } from '../templates/.archon/scripts/sa-check';
import { executionTable } from '../src/execution';
import { attemptPath } from '../templates/.archon/scripts/sa-check';
import { evaluateCondition } from '../../packages/workflows/src/condition-evaluator';
import {
  resolveNodeBindings,
  substituteNodeOutputRefs,
  type ShellInputContext,
} from '../../packages/workflows/src/dag-executor';

import { substituteWorkflowVariables } from '../../packages/workflows/src/executor-shared';

test('CONTEXT_PACK runtime code/repair/fix inline fresh bounded source without reinterpreting references', () => {
  const gen = tmp(),
    repo = gitRepo(tmp());
  const p = structuredClone(fixture);
  p.packages[0].scope = {
    write: ['range.ts:2-3', 'long.ts', 'new.ts'],
    read_hint: ['large.ts', 'overflow.ts', '.env.local', 'mykey.ts', '_private/file.ts'],
  };
  fs.cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
  fs.copyFileSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(gen, '.archon/scripts/policy-attempts.ts')
  );
  fs.copyFileSync(join(WETAMP, 'src/models.ts'), join(gen, '.archon/scripts/native-models.ts'));
  const checker = join(gen, '.archon/scripts/sa-check.ts');
  fs.writeFileSync(
    checker,
    readFileSync(checker, 'utf8').replace("from '../../../src/models'", "from './native-models'")
  );
  fs.writeFileSync(join(gen, 'plan.json'), JSON.stringify(p));
  fs.writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(p, loadTiers())));
  fs.mkdirSync(join(gen, 'briefs'));
  fs.mkdirSync(join(gen, 'hints'));
  for (const pkg of p.packages)
    fs.writeFileSync(join(gen, 'briefs', `${pkg.id}.md`), renderBrief(pkg, '', capsOf(p, pkg, [])));
  fs.writeFileSync(join(gen, 'hints/core.md'), 'HINT_FULL_TEXT');
  const literal = '$missing.output.field `quoted` "double" $ARTIFACTS_DIR';
  fs.writeFileSync(join(repo, 'range.ts'), `excluded\n${literal}\nselected\nlast`);
  fs.writeFileSync(
    join(repo, 'long.ts'),
    Array.from({ length: 401 }, (_, i) => `line-${i + 1}`).join('\n')
  );
  fs.writeFileSync(join(repo, 'large.ts'), '中'.repeat(15000));
  fs.writeFileSync(join(repo, 'overflow.ts'), 'OVERFLOW_CONTENT'.repeat(1000));
  const nodes = nodesOf(buildWorkflow(p, milestones(p), 'pack', gen, false, NOW));
  const ctx: ShellInputContext = {
    workflowRun: { id: 'pack', user_message: '', metadata: {} },
    artifactsDir: gen,
    stateDir: gen,
    baseBranch: 'main',
    docsDir: gen,
    nodeOutputs: new Map(),
  };
  const prompt = (id: string, producerId: string) => {
    const producer = nodes.find(n => n.id === producerId)!;
    const run = runAttempt(producer, repo, gen);
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    expect(run.exitCode).toBe(0);
    ctx.nodeOutputs.set(producerId, { state: 'completed', output: run.stdout.toString() });
    const node = nodes.find(n => n.id === id)!;
    const bindings = resolveNodeBindings(
      id,
      { context_node: node.with!.context_node as string },
      ctx,
      undefined
    );
    const template = readFileSync(
      join(WETAMP, 'templates/.archon/commands', `${node.command}.md`),
      'utf8'
    );
    expect(template).not.toContain('先读取职责证据指针');
    expect(template).not.toContain('先完整阅读任务书');
    expect(template).toContain('$$INPUTS.context_node.output.context_pack');
    const inputs = {
      pkg: 'core',
      brief: '',
      hint: '',
      prior_work: '',
      reason: '',
      accept_log: '',
      milestone: 'm1',
      round: 2,
      ledger: '',
      ...bindings,
    };
    const substituted = substituteWorkflowVariables(
      template,
      'pack',
      '',
      gen,
      'main',
      gen,
      undefined,
      undefined,
      undefined,
      undefined,
      { inputs }
    ).prompt;
    return substituteNodeOutputRefs(substituted, ctx.nodeOutputs);
  };
  const code = prompt('code-core', 'package-attempt-core');
  for (const text of [
    p.packages[0].goal,
    'HINT_FULL_TEXT',
    literal,
    'selected',
    '已截断：仅前 200 行',
    '共 401 行',
    '不存在（可能是待新建文件）',
    '48KB 上限',
    '不内联（仓库外或隐私路径）',
    '"cwd"',
    '"scope"',
    '"refs"',
  ])
    expect(code).toContain(text);
  expect(code).toContain('中'.repeat(15000));
  expect(code).not.toContain('OVERFLOW_CONTENT');
  expect(code).not.toContain('line-201');
  fs.writeFileSync(join(repo, 'range.ts'), 'excluded\nREPAIR_CURRENT_SOURCE\nselected\nlast');
  fs.writeFileSync(join(gen, 'hints/core.md'), 'REPAIR_CURRENT_HINT');
  const repair = prompt('repair-core', 'repair-context-core');
  expect(repair).toContain('REPAIR_CURRENT_SOURCE');
  expect(repair).toContain('REPAIR_CURRENT_HINT');
  expect(repair).not.toContain(literal);
  const handoff = nodes.find(n => n.id === 'handoff-m1-r2')!;
  handoff.with!.work_keys = [];
  expect(prompt('fix-m1-r2', handoff.id)).toContain('REPAIR_CURRENT_SOURCE');
  const fake = nodesOf(buildWorkflow(p, milestones(p), 'pack', gen, true, NOW));
  expect(fake.find(n => n.id === 'code-core')!.bash).toBeDefined();
  expect(fake.some(n => n.id === 'repair-context-core')).toBe(false);
});

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
  timeout?: number;
  approval?: { message: string };
  retry?: { max_attempts: number; on_error: string };
  with?: Record<string, unknown>;
};
const nodesOf = (w: unknown): N[] => (w as { nodes: N[] }).nodes;
const runAttempt = (node: N, cwd: string, artifacts: string) =>
  Bun.spawnSync(
    [process.execPath, '--no-env-file', 'run', join(artifacts, '.archon/scripts/sa-context.ts')],
    {
      cwd,
      env: {
        ...process.env,
        ARTIFACTS_DIR: artifacts,
        ...Object.fromEntries(
          Object.entries(node.with!).map(([k, v]) => [
            `INPUTS_${k.toUpperCase()}`,
            Array.isArray(v) ? JSON.stringify(v) : String(v),
          ])
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

test('RECOVERY_CONTINUATION generates acceptance, gate and land without AI nodes', () => {
  const p = structuredClone(fixture);
  p.packages = [p.packages[0]];
  p.packages[0].signoff = 'human';
  const recovery = {
    base: 'a'.repeat(40),
    policy: { path: '/ORIGINAL/policy.json' },
    rounds: Array.from({ length: 4 }, () => ({})),
  } as import('../templates/.archon/scripts/sa-check').RecoveryEvidence;
  const nodes = nodesOf(
    buildWorkflow(p, milestones(p), 'original-id', '/GEN', false, NOW, loadTiers(), {
      from: 'old-failed',
      packages: [],
      recovery: { ...recovery, admitted_by: 'owner', admitted_at: 'now' },
    })
  );
  expect(nodes.some(n => /^(code|repair|fix|review)-/.test(n.id))).toBe(false);
  expect(nodes.some(n => n.command)).toBe(false);
  const accept = nodes.find(n => n.with?.kind === 'accept')!;
  expect(accept.with?.policy).toBe('/ORIGINAL/policy.json');
  expect(nodes.find(n => n.id.startsWith('start-'))?.bash).toContain(recovery.base);
  const gate = nodes.find(n => n.with?.kind === 'gate')!;
  expect(gate.with?.round).toBe(4);
  expect(gate.with?.C3).toBe('null');
  expect(gate.with?.C4).toBe(`$${accept.id}.output`);
  expect(gate.with?.operator_id).toBe('original-id');
  expect(nodes.find(n => n.id.startsWith('human-'))?.depends_on).toEqual([gate.id]);
  expect(nodes.at(-1)?.with?.kind).toBe('land');
});

test('review guidance uses the node schema for failure classes', () => {
  for (const name of ['sa-review.md', 'sa-review-delta.md']) {
    const guidance = readFileSync(
      join(import.meta.dir, '../templates/.archon/commands', name),
      'utf8'
    );
    expect(guidance).toContain('output schema');
    expect(guidance).not.toContain('product | test_env');
  }
});

test('HF3 fingerprint is stable and changes with template bytes or generation logic', () => {
  const root = join(tmp(), 'wetamp');
  for (const path of ['templates', 'src', 'schemas', 'bin', 'scripts'])
    fs.cpSync(join(WETAMP, path), join(root, path), { recursive: true });
  fs.copyFileSync(join(WETAMP, 'tiers.json'), join(root, 'tiers.json'));
  fs.mkdirSync(join(root, '../packages/workflows/src'), { recursive: true });
  fs.copyFileSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(root, '../packages/workflows/src/provider-attempts.ts')
  );
  const hash = engineHash(root);
  expect(engineHash(root)).toBe(hash);
  const script = join(root, 'templates/.archon/scripts/sa-check.ts');
  fs.appendFileSync(script, '\n// changed template\n');
  expect(engineHash(root)).not.toBe(hash);
  fs.copyFileSync(join(WETAMP, 'templates/.archon/scripts/sa-check.ts'), script);
  expect(engineHash(root)).toBe(hash);
  for (const command of ['sa-code', 'sa-fix', 'sa-repair']) {
    const file = join(root, `templates/.archon/commands/${command}.md`);
    const original = fs.readFileSync(file, 'utf8');
    expect(original).toContain('包括首条读取在内，所有 shell 命令遵循你的 AGENTS.md 命令规则');
    fs.writeFileSync(file, original + '\nchanged command guidance\n');
    expect(engineHash(root)).not.toBe(hash);
    fs.writeFileSync(file, original);
    expect(engineHash(root)).toBe(hash);
  }
  const resident = residentHash(root);
  for (const path of ['src/board/App.tsx', 'src/web/server.ts']) {
    fs.appendFileSync(join(root, path), '\n// UI-only change\n');
    expect(engineHash(root)).toBe(hash);
    expect(residentHash(root)).not.toBe(resident);
  }
  for (const path of [
    'bin/codex-worker',
    'bin/codex-readonly-proxy.cjs',
    'scripts/codex-trust.cjs',
    'src/archon.ts',
  ]) {
    fs.appendFileSync(join(root, path), '\n// execution-time change\n');
    expect(engineHash(root)).toBe(hash);
  }
  for (const path of [
    'src/generate.ts',
    'src/config.ts',
    'src/plan.ts',
    'src/reasons.ts',
    'src/memory.ts',
    'src/board/workflow.ts',
  ]) {
    fs.appendFileSync(join(root, path), '\n// frozen generation input\n');
    expect(engineHash(root)).not.toBe(hash);
    fs.copyFileSync(join(WETAMP, path), join(root, path));
    expect(engineHash(root)).toBe(hash);
  }
});

test('EV reflection and memory views are read live; lesson data is outside both identities', () => {
  const root = join(tmp(), 'wetamp');
  for (const path of ['templates', 'src', 'schemas'])
    fs.cpSync(join(WETAMP, path), join(root, path), { recursive: true });
  fs.copyFileSync(join(WETAMP, 'tiers.json'), join(root, 'tiers.json'));
  fs.mkdirSync(join(root, '../packages/workflows/src'), { recursive: true });
  fs.copyFileSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(root, '../packages/workflows/src/provider-attempts.ts')
  );
  const workflow = engineHash(root),
    resident = residentHash(root);
  for (const path of ['src/memory-reflect.ts', 'src/web/memory.ts']) {
    fs.appendFileSync(join(root, path), '\n// execution-time change\n');
    expect(engineHash(root)).toBe(workflow);
    expect(residentHash(root)).not.toBe(resident);
    fs.copyFileSync(join(WETAMP, path), join(root, path));
    expect(residentHash(root)).toBe(resident);
  }
  fs.appendFileSync(join(root, 'templates/memory-reflect.md'), '\nLive reflection prompt\n');
  fs.mkdirSync(join(root, 'memory'));
  fs.writeFileSync(join(root, 'memory/lessons.jsonl'), '{"lessons":[]}\n');
  expect(engineHash(root)).toBe(workflow);
  expect(residentHash(root)).toBe(resident);
});

describe('buildWorkflow', () => {
  test('P2: two-package data dependencies exclude milestone and review retry counters', () => {
    for (const sameMilestone of [false, true]) {
      const plan = structuredClone(fixture);
      if (sameMilestone) plan.packages[1].milestone = 'm1';
      const nodes = nodesOf(build(false, plan));
      const dependencies = (id: string): string[] => {
        const deps = nodes.find(n => n.id === id)!.depends_on ?? [];
        return [...deps, ...deps.flatMap(dependencies)];
      };
      for (const p of plan.packages)
        for (const kind of ['code', 'verify', 'repair', 'settle']) {
          const deps = dependencies(`${kind}-${p.id}`);
          // Cross-milestone gates are ordering predecessors of start, not data inputs:
          // start emits the same merge-base when control state changes.
          const local = nodes.filter(n => n.depends_on?.includes('attempt-m1')).map(n => n.id);
          expect(local.some(id => /^(code|verify|repair|settle)-/.test(id))).toBe(false);
          expect(deps).toContain(`package-attempt-${p.id}`);
          if (sameMilestone) expect(deps.some(id => id.startsWith('attempt-'))).toBe(false);
        }
      if (sameMilestone)
        expect(nodes.find(n => n.id === 'code-api')?.depends_on).toEqual([
          'settle-core',
          'package-attempt-api',
        ]);
    }
  });
  test('P2: carry changes only code/verify wiring; an empty carry preserves every byte', () => {
    const make = (packages: string[]) =>
      buildWorkflow(fixture, milestones(fixture), 'golden-0001', '/GEN', false, NOW, loadTiers(), {
        from: "old'run",
        packages,
      });
    const normal = build(false);
    expect(JSON.stringify(make([]))).toBe(JSON.stringify(normal));
    const nodes = nodesOf(make(['core']));
    const code = nodes.find(n => n.id === 'code-core');
    const verify = nodes.find(n => n.id === 'verify-core');
    expect(code?.command).toBe('sa-code');
    expect(code?.when).toBe("$package-attempt-core.output.attempt != '0'");
    expect(verify?.trigger_rule).toBe('none_failed_min_one_success');
    const binding = verify?.with?.coder as { from: string; if_skipped: string };
    expect(binding.from).toBe('$code-core.output');
    expect(JSON.parse(binding.if_skipped)).toEqual({
      status: 'done',
      changed_files: [],
      quick_checks: [],
      notes: "carried from old'run",
      blockers: [],
      error_class: null,
      deviations: [],
      needs: [],
    });
    expect(nodes.filter(n => !['code-core', 'verify-core'].includes(n.id))).toEqual(
      nodesOf(normal).filter(n => !['code-core', 'verify-core'].includes(n.id))
    );
    expect(code?.depends_on).toEqual(nodesOf(normal).find(n => n.id === 'code-core')?.depends_on);
  });
  test('P2 R2: incrementing a carried package attempt enables sa-code with its hint', () => {
    const gen = tmp();
    fs.cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
    fs.copyFileSync(
      join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
      join(gen, '.archon/scripts/policy-attempts.ts')
    );
    const repo = gitRepo(tmp());
    fs.writeFileSync(join(gen, 'plan.json'), JSON.stringify(fixture));
    fs.writeFileSync(
      join(gen, 'execution.json'),
      JSON.stringify(executionTable(fixture, loadTiers()))
    );
    const nodes = nodesOf(
      buildWorkflow(fixture, milestones(fixture), 'retry', gen, false, NOW, loadTiers(), {
        from: 'old-run',
        packages: ['core'],
      })
    );
    const code = nodes.find(n => n.id === 'code-core')!;
    const attempt = nodes.find(n => n.id === 'package-attempt-core')!;
    const verify = nodes.find(n => n.id === 'verify-core')!;
    const binding = verify.with!.coder as { from: string; if_skipped: string };
    const ctx: ShellInputContext = {
      workflowRun: { id: 'retry', user_message: '', metadata: {} },
      artifactsDir: gen,
      stateDir: gen,
      baseBranch: 'dev',
      docsDir: gen,
      nodeOutputs: new Map(),
    };
    const enabled = (): boolean => {
      ctx.nodeOutputs.set(attempt.id, {
        state: 'completed',
        output: (() => {
          const result = runAttempt(attempt, repo, gen);
          expect(result.exitCode).toBe(0);
          return result.stdout.toString();
        })(),
      });
      const result = evaluateCondition(code.when!, ctx.nodeOutputs);
      expect(result.parsed).toBe(true);
      return result.result;
    };
    expect(enabled()).toBe(false);
    ctx.nodeOutputs.set(code.id, {
      state: 'skipped',
      output: '',
      cause: { kind: 'condition', expr: code.when! },
    });
    expect(resolveNodeBindings(verify.id, { coder: binding }, ctx, undefined).coder).toBe(
      binding.if_skipped
    );

    const path = attemptPath(gen, 'pkg/core');
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, '1');
    fs.mkdirSync(join(gen, 'hints'));
    fs.writeFileSync(join(gen, 'hints/core.md'), 'use the retry hint');
    expect(enabled()).toBe(true);
    expect(code.command).toBe('sa-code');
    expect(code.with).toEqual({
      pkg: 'core',
      brief: join(gen, 'briefs/core.md'),
      hint: join(gen, 'hints/core.md'),
    });
    const retryOutput = JSON.stringify({ status: 'done', notes: 'retried' });
    ctx.nodeOutputs.set(code.id, { state: 'completed', output: retryOutput });
    expect(resolveNodeBindings(verify.id, { coder: binding }, ctx, undefined).coder).toBe(
      retryOutput
    );
    ctx.nodeOutputs.set(code.id, { state: 'failed', output: '', error: 'coder failed' });
    expect(() => resolveNodeBindings(verify.id, { coder: binding }, ctx, undefined)).toThrow(
      'failed'
    );
  });
  test('NR: optional review runs only on effective G2 risk, including fake mode', () => {
    const plan = { ...fixture, packages: [{ ...fixture.packages[0], review: undefined }] };
    for (const fake of [false, true]) {
      const nodes = nodesOf(build(fake, plan));
      expect(nodes.find(n => n.id === 'review-m1-r1')?.when).toBe(
        "$diff-m1-r1.output.disposition == 'advance' && $diff-m1-r1.output.risk == 'G2'"
      );
      expect(nodes.find(n => n.id === 'gate-m1-r1')?.with?.review).toBe('0');
    }
  });
  test('ACCT: short acceptance keeps the Archon subprocess default floor', () => {
    const source = readFileSync(join(WETAMP, '../packages/workflows/src/dag-executor.ts'), 'utf8');
    const ms = Number(
      source.match(/const SUBPROCESS_DEFAULT_TIMEOUT = ([\d_]+);/)?.[1]?.replaceAll('_', '')
    );
    expect(ms).toBe(120_000);
    const plan = structuredClone(fixture);
    for (const p of plan.packages) p.accept = [{ cmd: 'short-check', timeout_s: 10 }];
    for (const fake of [false, true]) {
      const nodes = nodesOf(build(fake, plan));
      for (const n of nodes.filter(n => n.with?.kind === 'accept' || n.with?.kind === 'settle'))
        expect(n.timeout).toBe(ms);
      for (const n of nodes.filter(n => n.with?.kind !== 'accept' && n.with?.kind !== 'settle'))
        expect(n.timeout).toBeUndefined();
    }
  });
  test('ACCT: serial checks include a full failed-command baseline probe, even with cache enabled', () => {
    const plan = structuredClone(fixture);
    plan.packages[0].accept = [
      { cmd: 'check-a', timeout_s: 600, cache: true },
      { cmd: 'check-b', timeout_s: 900 },
    ];
    for (const fake of [false, true]) {
      const nodes = nodesOf(build(fake, plan));
      for (const id of ['verify-core', 'settle-core', 'diff-m1-r1', 'diff-m1-r2', 'diff-m1-r3'])
        expect(nodes.find(n => n.id === id)?.timeout).toBe(
          3_000_000 + CHECK_AUX_COUNTS.accept * CHECK_AUX_TIMEOUT_MS + 5_000
        );
    }
  });
  test('ACCT: milestone totals cover only its own packages, not the cumulative scope', () => {
    const plan = structuredClone(fixture);
    plan.packages[0].accept = [{ cmd: 'first', timeout_s: 900 }];
    plan.packages[1].accept = [{ cmd: 'second', timeout_s: 300 }];
    plan.packages.push({
      ...plan.packages[1],
      id: 'web',
      accept: [{ cmd: 'third', timeout_s: 600 }],
    });
    const nodes = nodesOf(build(false, plan));
    expect(nodes.find(n => n.id === 'verify-api')?.timeout).toBe(695_000);
    expect(nodes.find(n => n.id === 'settle-web')?.timeout).toBe(1_295_000);
    for (const r of [1, 2, 3]) {
      const n = nodes.find(n => n.id === `diff-m2-r${r}`);
      expect(n?.with).toMatchObject({ pkgs: 'api,web', scope_pkgs: 'core,api,web' });
      expect(n?.timeout).toBe(1_895_000);
    }
  });
  test('ACCT: environment commands run once and empty environment has no timeout', () => {
    const plan = structuredClone(fixture);
    plan.environment = [{ cmd: 'plan-env', timeout_s: 200 }];
    plan.packages[0].environment = [{ cmd: 'pkg-env', timeout_s: 300 }];
    expect(nodesOf(build(false, plan)).find(n => n.id === 'environment')?.timeout).toBe(
      500_000 + CHECK_AUX_COUNTS.env * CHECK_AUX_TIMEOUT_MS + 5_000
    );
    expect(nodesOf(build(false)).find(n => n.id === 'environment')?.timeout).toBeUndefined();
    expect(nodesOf(build(false)).find(n => n.id === 'environment')?.retry).toEqual({
      max_attempts: loadTiers().policy.auto_retry.environment,
      on_error: 'all',
    });
    for (const node of nodesOf(build(false, plan)).filter(
      n => n.with?.kind === 'accept' || n.with?.kind === 'settle'
    ))
      expect(node.timeout).toBe(
        500_000 + 60_000 + CHECK_AUX_COUNTS.accept * CHECK_AUX_TIMEOUT_MS + 5_000
      );
  });
  test('ACCT: real Archon completes failed acceptance and baseline probe with the generated budget', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const plan = structuredClone(fixture);
    plan.repo = repo;
    // Budget arithmetic is covered above. Keep real subprocess overhead unscaled here.
    plan.environment = [{ cmd: 'true', timeout_s: 1 }];
    plan.packages[0].accept = [
      {
        cmd: `printf '%s' '{"failure_class":"product","evidence":"ACCT product fixture"}'; exit 1`,
        timeout_s: 1,
      },
    ];
    const planPath = join(root, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const source = join(root, 'source');
    const workflow = join(source, '.archon/workflows/acct');
    fs.mkdirSync(workflow, { recursive: true });
    fs.cpSync(join(WETAMP, 'templates/.archon/scripts'), join(source, '.archon/scripts'), {
      recursive: true,
    });
    fs.copyFileSync(
      join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
      join(source, '.archon/scripts/policy-attempts.ts')
    );
    const base = sh('git rev-parse HEAD', repo).trim();
    const policy = join(root, 'policy.json');
    fs.writeFileSync(
      policy,
      JSON.stringify({
        risk_paths: [],
        code_extensions: [],
        exempt_paths: [],
        budget_floor: { S: 1 },
      })
    );
    const ledger = join(root, 'archon-stub');
    fs.writeFileSync(ledger, '#!/bin/sh\necho \'{"events":[]}\'\n', { mode: 0o755 });
    const generated = nodesOf(build(true, plan)).find(n => n.id === 'verify-core')!;
    const node = {
      ...generated,
      depends_on: [],
      with: {
        ...generated.with,
        plan: planPath,
        base,
        delta_base: base,
        policy,
        archon: ledger,
        coder: '',
      },
    };
    fs.writeFileSync(
      join(workflow, 'acct.yaml'),
      Bun.YAML.stringify({
        name: 'acct',
        description: 'ACCT generated subprocess timeout contract',
        nodes: [node],
      })
    );
    sh(
      'git init -q && git add .archon && git -c user.name=t -c user.email=t@l commit -qm fixture',
      source
    );
    const env = {
      ...process.env,
      SUPERAGENT_HOME: join(root, 'home'),
      ARCHON_HOME: join(root, 'home/archon'),
    };
    const archon = (...args: string[]) => {
      const p = Bun.spawnSync([join(WETAMP, 'bin/archon'), ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(p.exitCode).toBe(0);
      return lastJson(p.stdout.toString());
    };
    const ack = archon(
      'workflow',
      'run',
      'acct',
      '--workflow-source',
      source,
      '--cwd',
      repo,
      '--no-worktree',
      '--detach',
      '--json'
    );
    const id = String(ack?.runId);
    const waited = archon('workflow', 'wait', id, '--timeout', '20', '--json');
    expect(waited).toMatchObject({
      attention: { status: 'completed' },
    });
    const view = archon('workflow', 'get', id, '--verbose', '--json');
    expect(view).toMatchObject({
      status: 'completed',
      nodes: [{ nodeId: 'verify-core', state: 'completed' }],
    });
    const verified = JSON.parse(
      readFileSync(
        join(String(view?.output_root), 'artifacts/runs', id, 'verify-core.json'),
        'utf8'
      )
    );
    expect(verified).toMatchObject({ ok: false, base_pass: false, disposition: 'repair' });
  }, 40_000);
  test('golden: two packages across two milestones', () => {
    expect(build(false)).toEqual(golden('two-pkgs'));
  });
  test('golden: fake mode swaps coder nodes for bash stubs only', () => {
    expect(build(true)).toEqual(golden('two-pkgs-fake'));
  });
  const reviewAttempts = [false, true].flatMap(fake =>
    nodesOf(build(fake))
      .filter(n => n.id.startsWith('attempt-review-'))
      .map(n => ({ fake, id: n.id }))
  );
  const reviewAttemptCases = reviewAttempts.flatMap(node =>
    ['missing', '0', '7', 'NaN', '-1', 'directory'].map(counter => ({ ...node, counter }))
  );
  // Each counter executes a subprocess; keep independent executions in separate timeout budgets.
  test.each(reviewAttemptCases)(
    'HF10b review attempt node validates counters at execution (%j)',
    ({ fake, id, counter }) => {
      const gen = gitRepo(tmp());
      fs.cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
      fs.copyFileSync(
        join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
        join(gen, '.archon/scripts/policy-attempts.ts')
      );
      fs.mkdirSync(join(gen, 'attempts'));
      const nodes = nodesOf(
        buildWorkflow(fixture, milestones(fixture), 'hf10b', gen, fake, NOW)
      ).filter(n => n.id.startsWith('attempt-review-'));
      expect(nodes).toHaveLength(6);
      const node = nodes.find(n => n.id === id)!;
      const path = join(gen, 'attempts', node.id.slice('attempt-'.length));
      if (counter === 'directory') {
        fs.mkdirSync(path);
      } else if (counter !== 'missing') {
        fs.writeFileSync(path, counter);
      }
      const context = join(gen, 'prepared.json');
      expect(node.script).toBe('sa-context');
      expect(node.bash).toBeUndefined();
      const fingerprint = Bun.spawnSync(
        [
          process.execPath,
          '--no-env-file',
          '-e',
          'import { contextEnvironmentIdentity } from "./.archon/scripts/sa-check.ts"; console.log(contextEnvironmentIdentity(process.env));',
        ],
        { cwd: gen, env: { ...process.env, ARTIFACTS_DIR: gen }, stdout: 'pipe', stderr: 'pipe' }
      );
      expect(fingerprint.exitCode).toBe(0);
      const environment = fingerprint.stdout.toString().trim();
      fs.writeFileSync(
        context,
        JSON.stringify({
          node: id.slice('attempt-'.length),
          refs: { head: sh('git rev-parse HEAD', gen).trim() },
          carry_over: null,
          environment,
        })
      );
      fs.writeFileSync(
        join(gen, `${id.slice('attempt-'.length)}.context.json`),
        JSON.stringify({ path: context })
      );
      const result = runAttempt(node, gen, gen);
      if (counter === 'missing' || counter === '0' || counter === '7') {
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toEqual({
          attempt: counter === 'missing' ? '0' : counter,
        });
      } else {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          counter === 'directory' ? 'EISDIR' : 'invalid attempt counter'
        );
        expect(result.stdout.toString()).toBe('');
      }
    }
  );
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
    expect(n('code-core')?.depends_on).toEqual(['start-m1', 'package-attempt-core']);
    expect(n('start-m2')).toMatchObject({
      depends_on: ['gate-m1-r1', 'gate-m1-r2', 'gate-m1-r3'],
      trigger_rule: 'none_failed_min_one_success',
    });
    expect(n('human-m2')).toMatchObject({
      approval: { message: 'Approve delivery milestone m2' },
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
      base_ref: fixture.base_ref,
      operator_ledger: '/runs/golden-0001.json',
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
  test('native approval owns signoff; passed plan deadlines fail generation', () => {
    const approval = (deadline: string) =>
      nodesOf(build(false, { ...fixture, deadline })).find(x => x.id === 'human-m2')?.approval;
    expect(approval('2026-10-10T00:00:00Z')).toEqual({ message: 'Approve delivery milestone m2' });
    expect(() => approval('2026-10-09T00:00:00Z')).toThrow(/already passed/);
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
        filesystem: { denyWrite: ['/'], disabled: false },
        network: {
          allowedDomains: [],
          deniedDomains: ['*'],
          strictAllowlist: true,
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
      });
      expect(node('codex', id).mcp).toBeUndefined();
    }
    for (const c of ['claude', 'codex'] as const) {
      expect(node(c, 'code-core').sandbox).toBeUndefined();
      expect(node(c, 'code-core').mcp).toBeUndefined();
    }
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
      '禁止 git commit 的条款面向人工主仓，此处不适用',
      'searxng',
      '## 红线（执行层强制）',
      '过程规范的偏差不是红线',
      '按建议改写重试一次不算绕过',
      '不延续到本轮',
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

test.each(['stable', 'dirty-before', 'dirty-during', 'commit-during', 'invalid'] as const)(
  'P4a generation provenance uses a verified git checkout: %s',
  sample => {
    const root = tmp(),
      engine = gitRepo(tmp());
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: join(root, 'archon') });
    const plan = loadPlan(fixturePlan(root, gitRepo(root)), [root]);
    const commit = sh('git rev-parse HEAD', engine).trim();
    const clean = coord.cleanEngine;
    const boundary = spyOn(coord, 'cleanEngine').mockImplementation(() => clean(engine));
    const validation = spyOn(archon, 'archon').mockImplementation(() => {
      if (sample === 'dirty-during') fs.writeFileSync(join(engine, 'dirty'), 'changed');
      if (sample === 'commit-during')
        sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm changed', engine);
      return { code: sample === 'invalid' ? 1 : 0, out: '', err: 'fixture invalid' };
    });
    try {
      if (sample === 'dirty-before') fs.writeFileSync(join(engine, 'dirty'), 'changed');
      if (sample === 'stable') {
        const gen = generate(plan, 'provenance');
        expect(gen.engine_commit).toBe(commit);
        expect(JSON.parse(readFileSync(join(gen.dir, 'engine.json'), 'utf8')).engine_commit).toBe(
          commit
        );
        expect(boundary).toHaveBeenCalledTimes(2);
      } else {
        expect(() => generate(plan, 'provenance')).toThrow(
          sample.startsWith('dirty')
            ? '工作树不干净'
            : sample === 'invalid'
              ? 'generated workflow invalid'
              : '引擎提交在生成期间变化'
        );
        if (sample === 'dirty-before') expect(existsSync(join(root, 'gen'))).toBe(false);
      }
    } finally {
      validation.mockRestore();
      boundary.mockRestore();
    }
  }
);

test('ENV_PRECHECK generated helper runs independently with no source checkout imports', () => {
  const root = tmp();
  const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME'] as const,
    saved = keys.map(k => process.env[k]);
  try {
    Object.assign(process.env, {
      SUPERAGENT_HOME: join(root, 'home'),
      ARCHON_HOME: join(root, 'home/archon'),
    });
    install();
    const repo = gitRepo(root),
      plan = loadPlan(fixturePlan(root, repo), [root]);
    const engine = gitRepo(tmp()),
      clean = coord.cleanEngine;
    const boundary = spyOn(coord, 'cleanEngine').mockImplementation(() => clean(engine));
    const validation = spyOn(archon, 'archon').mockReturnValue({ code: 0, out: '', err: '' });
    let gen: ReturnType<typeof generate>;
    try {
      gen = generate(plan, 'env-precheck');
    } finally {
      validation.mockRestore();
      boundary.mockRestore();
    }
    const source = readFileSync(join(gen.dir, '.archon/scripts/env-precheck.ts'), 'utf8');
    expect(source).not.toContain('../../../src');
    const p = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { envPrecheck } from './.archon/scripts/env-precheck.ts'; console.log(JSON.stringify(envPrecheck(${JSON.stringify(repo)})));`,
      ],
      { cwd: gen.dir, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({
      ok: true,
      dependencies: 'not_required',
    });
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('generate writes a committed gen repo that archon validates', () => {
  const root = tmp();
  const env = { SUPERAGENT_HOME: join(root, 'home'), ARCHON_HOME: join(root, 'home', 'archon') };
  Object.assign(process.env, env);
  install();
  const plan = loadPlan(fixturePlan(root, gitRepo(root)), [root]);
  plan.packages[0].requirements = [{ id: 'r', text: 'core exists', verified_by: [0] }];
  const g = generate(plan, 'gen-0001');
  expect(
    JSON.parse(readFileSync(join(g.dir, 'plan.json'), 'utf8')).packages[0].requirements
  ).toEqual(plan.packages[0].requirements);
  expect(readFileSync(join(g.dir, 'briefs/core.md'), 'utf8')).toContain('"verified_by"');

  const principles = readFileSync(join(WETAMP, 'templates', '.archon', 'principles.md'), 'utf8');
  const generated = Bun.YAML.parse(
    readFileSync(join(g.dir, '.archon', 'workflows', g.workflow, `${g.workflow}.yaml`), 'utf8')
  );
  const ai = nodesOf(generated).filter(n => n.command);
  expect(JSON.parse(readFileSync(join(g.dir, 'accept-inputs.json'), 'utf8'))).toEqual(
    nodesOf(generated)
      .filter(n => n.with?.kind === 'accept')
      .map(n => n.with)
  );
  expect(nodesOf(generated).find(n => n.id === 'land')?.with?.operator_ledger).toBe(
    join(env.SUPERAGENT_HOME, 'runs', 'gen-0001.json')
  );
  expect([...new Set(ai.map(n => n.command))].sort()).toEqual([
    'sa-code',
    'sa-fix',
    'sa-repair',
    'sa-review',
    'sa-review-delta',
  ]);
  for (const n of ai) {
    const prompt = readFileSync(join(g.dir, '.archon', 'commands', `${n.command}.md`), 'utf8');
    expect(prompt).not.toContain(principles);
    expect(readFileSync(join(g.dir, '.archon/principles.md'), 'utf8')).toBe(principles);
    if (n.command === 'sa-code') {
      expect(prompt).toContain('拒绝须附工具调用证据');
      expect(prompt).toContain('在 `needs[].why` 引用该工具调用及原始返回');
      expect(prompt).toContain('status=done、error_class=null');
    }
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
  const frozen = snapshotPolicy(loadTiers());
  expect(JSON.parse(readFileSync(join(g.dir, 'policy.json'), 'utf8'))).toEqual(frozen);
  expect(JSON.parse(readFileSync(join(g.dir, 'engine.json'), 'utf8')).policy_hash).toBe(
    frozen.hash
  );
  const config = Bun.YAML.parse(readFileSync(g.config, 'utf8')) as {
    assistants: { codex: { codexBinaryPath: string } };
  };
  expect(readFileSync(join(g.dir, '.archon/config.yaml'), 'utf8')).toBe(
    readFileSync(g.config, 'utf8')
  );
  expect(config.assistants.codex.codexBinaryPath).toBe(join(g.dir, 'codex-worker'));
  expect(readFileSync(config.assistants.codex.codexBinaryPath, 'utf8')).toContain(
    join(g.dir, 'policy.json')
  );
  const single = generate(
    { ...plan, mode: 'single:claude', packages: plan.packages.map(p => ({ ...p, risk: 'G0' })) },
    'gen-single'
  );
  const singleConfig = Bun.YAML.parse(readFileSync(single.config, 'utf8')) as {
    aliases: Record<string, { provider: string }>;
  };
  expect(Object.values(singleConfig.aliases).every(a => a.provider === 'claude')).toBe(true);
  const singleWorkflow = Bun.YAML.parse(
    readFileSync(
      join(single.dir, '.archon/workflows', single.workflow, `${single.workflow}.yaml`),
      'utf8'
    )
  );
  for (const n of nodesOf(singleWorkflow).filter(n => n.command)) {
    const model = (n as N & { model: string }).model;
    expect(singleConfig.aliases[model].provider).toBe('claude');
  }
  // Only explicit hard budgets enforce the package floor.
  const thin = loadPlan(
    fixturePlan(root, plan.repo, p => (p.budget = { weighted_tokens: 700000 })),
    [root]
  );
  expect(() => generate(thin, 'gen-observe')).not.toThrow();
  thin.budget.enforcement = 'hard';
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

test('delivery defaults: no deadline survives >24h and preserves explicit human signoff', () => {
  const { deadline: _deadline, ...plan } = fixture;
  const nodes = nodesOf(
    buildWorkflow(plan, milestones(plan), 'defaults', '/GEN', false, NOW + 48 * 3600_000)
  );
  expect(nodes.find(n => n.id === 'human-m2')?.approval).toEqual({
    message: 'Approve delivery milestone m2',
  });
  expect(nodes.find(n => n.id === 'signoff-m2')?.bash).toBe('true');
  expect(nodes.find(n => n.id === 'land')).toBeDefined();
  expect(() =>
    buildWorkflow(
      fixture,
      milestones(fixture),
      'defaults',
      '/GEN',
      false,
      Date.parse(fixture.deadline!)
    )
  ).toThrow(/already passed/);
});

test('role efficiency handoff resolves prior work without model calls or skipped-branch guesses', () => {
  const gen = tmp();
  const nodes = nodesOf(buildWorkflow(fixture, milestones(fixture), 'handoff', gen, false, NOW));
  const handoff = nodes.find(n => n.id === 'handoff-m1-r2')!;
  const work = {
    status: 'done',
    changed_files: ['core.txt'],
    quick_checks: [{ cmd: 'test -f core.txt', exit: 0 }],
    notes: '$HOME `literal`',
    deviations: [],
    needs: [],
  };
  const ctx: ShellInputContext = {
    workflowRun: { id: 'handoff', user_message: '', metadata: {} },
    artifactsDir: gen,
    stateDir: '',
    baseBranch: '',
    docsDir: '',
    nodeOutputs: new Map<
      string,
      ShellInputContext['nodeOutputs'] extends Map<string, infer V> ? V : never
    >([
      [
        'code-core',
        { state: 'completed' as const, output: JSON.stringify(work), structuredOutput: work },
      ],
      [
        'repair-core',
        { state: 'skipped' as const, output: '', cause: { kind: 'condition', expr: 'false' } },
      ],
    ]),
  };
  const bound = resolveNodeBindings(
    handoff.id,
    handoff.with as Parameters<typeof resolveNodeBindings>[1],
    ctx,
    undefined
  );
  expect(bound.work_code_core).toEqual(work);
  expect(bound.work_repair_core).toBeNull();
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      'run',
      join(WETAMP, 'templates/.archon/scripts/sa-context.ts'),
    ],
    {
      cwd: gen,
      env: {
        ...process.env,
        ARTIFACTS_DIR: gen,
        ...Object.fromEntries(
          Object.entries(bound).map(([k, v]) => [
            `INPUTS_${k.toUpperCase()}`,
            typeof v === 'object' ? JSON.stringify(v) : String(v),
          ])
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  const path = JSON.parse(result.stdout.toString()).handoff;
  expect(JSON.parse(readFileSync(path, 'utf8')).work).toEqual({
    CODE_CORE: work,
    REPAIR_CORE: null,
  });
  expect(handoff.command).toBeUndefined();
  expect(nodes.find(n => n.id === 'fix-m1-r2')?.with?.prior_work).toBe(
    '$handoff-m1-r2.output.handoff'
  );
  expect(nodes.find(n => n.id === 'repair-core')?.with?.prior_work).toBe('$code-core.output');
  expect(nodes.find(n => n.id === 'handoff-m1-r3')?.with?.work_fix).toBe('$fix-m1-r2.output');
  ctx.nodeOutputs.set('repair-core', { state: 'failed', output: '', error: 'fixture failure' });
  expect(() =>
    resolveNodeBindings(
      handoff.id,
      handoff.with as Parameters<typeof resolveNodeBindings>[1],
      ctx,
      undefined
    )
  ).toThrow('failed');
});

test('role efficiency preserves ordinary, explicit review, G2 and strict gates and routed effort', () => {
  for (const [risk, mode, review, needed] of [
    ['G1', undefined, false, false],
    ['G1', undefined, true, true],
    ['G2', undefined, false, true],
    ['G1', 'strict', false, true],
  ] as const) {
    const p = structuredClone(fixture);
    p.packages = [{ ...p.packages[0], risk, review }];
    if (mode) p.mode = mode;
    const ms = milestones(p);
    const nodes = nodesOf(buildWorkflow(p, ms, 'roles', '/GEN', false, NOW));
    const condition = nodes.find(n => n.id === 'review-m1-r1')!.when!;
    expect(
      evaluateCondition(
        condition,
        new Map([
          [
            'diff-m1-r1',
            { state: 'completed', output: JSON.stringify({ disposition: 'advance', risk }) },
          ],
        ])
      ).result
    ).toBe(needed);
    expect(nodes.filter(n => n.command).map(n => n.command)).toEqual([
      'sa-code',
      'sa-repair',
      'sa-review',
      'sa-fix',
      'sa-review-delta',
      'sa-fix',
      'sa-review-delta',
    ]);
    expect(nodes.find(n => n.id === 'fix-m1-r2')?.when).toBe("$gate-m1-r1.output.verdict == 'fix'");
    expect(nodes.find(n => n.id === 'verify-core')?.with?.kind).toBe('accept');
    expect(nodes.find(n => n.id === 'settle-core')?.with?.kind).toBe('settle');
  }
});
