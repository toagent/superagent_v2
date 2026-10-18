import { describe, expect, spyOn, test } from 'bun:test';
import { stepRetryConfigSchema } from '@archon/workflows/schemas/retry';
import * as fs from 'node:fs';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWorkflow,
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
import { fixturePlan, fixtureTiers, gitRepo, fixtureEnv, sh, tmp } from './helpers';
import { RECOVERY_TIMEOUT_MS } from '../templates/.archon/scripts/env-precheck';
import { CHECK_AUX_BUDGET_MS, reviewRoundLimit } from '../templates/.archon/scripts/sa-check';
import { executionTable } from '../src/execution';
import { integrationLockTimeout } from '../src/land';
import { attemptPath } from '../templates/.archon/scripts/sa-check';
import { evaluateCondition } from '../../packages/workflows/src/condition-evaluator';
import {
  inputEnvVars,
  resolveNodeBindings,
  substituteNodeOutputRefs,
  type ShellInputContext,
} from '../../packages/workflows/src/dag-executor';
import { validateDagStructure } from '../../packages/workflows/src/loader';
import type { DagNode } from '../../packages/workflows/src/schemas';

const MAX_ROUNDS = reviewRoundLimit(snapshotPolicy(loadTiers()));

test('CONTEXT_PACK runtime code/repair/fix read fresh bounded source through stable attempt paths', () => {
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
  const prompt = (id: string, producerId: string) => {
    const producer = nodes.find(n => n.id === producerId)!;
    const run = runAttempt(producer, repo, gen);
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    expect(run.exitCode).toBe(0);
    const node = nodes.find(n => n.id === id)!;
    const template = readFileSync(
      join(WETAMP, 'templates/.archon/commands', `${node.command}.md`),
      'utf8'
    );
    expect(template).not.toContain('先读取职责证据指针');
    expect(template).not.toContain('先完整阅读任务书');
    expect(template).toContain('$$INPUTS.context_node.output.context_pack_path');
    return readFileSync(JSON.parse(run.stdout.toString()).context_pack_path, 'utf8');
  };
  const attempts = nodes.filter(n => n.id.startsWith('package-attempt-'));
  const before = attempts.map(n => runAttempt(n, repo, gen).stdout.toString());
  sh('git add range.ts long.ts large.ts overflow.ts && git commit -qm candidate', repo);
  expect(attempts.map(n => runAttempt(n, repo, gen).stdout.toString())).toEqual(before);
  const calls = join(gen, 'calls'),
    input = join(gen, 'input');
  fs.writeFileSync(input, 'initial');
  const workflow = {
    name: 'stable-pack',
    description: 'Native resume invalidation',
    nodes: [
      { id: 'input', bash: `cat '${input}'`, always_run: true },
      ...attempts.flatMap((n, i) => [
        { ...n, depends_on: [i ? 'code-core' : 'input'] },
        {
          id: `code-${p.packages[i].id}`,
          depends_on: [i ? 'code-core' : 'input', n.id],
          bash: `echo ${p.packages[i].id} >> '${calls}'; cat '${input}'`,
        },
      ]),
      { id: 'gate', depends_on: ['code-api'], bash: 'exit 1' },
    ],
  };
  fs.mkdirSync(join(gen, '.archon/workflows'), { recursive: true });
  fs.writeFileSync(join(gen, '.archon/workflows/stable-pack.yaml'), Bun.YAML.stringify(workflow));
  const env = fixtureEnv({
    SUPERAGENT_HOME: join(gen, 'home'),
    ARCHON_HOME: join(gen, 'home/archon'),
  });
  const invoke = (...args: string[]) => workflowCli(repo, env, ...args);
  const ack = invoke(
    'run',
    'stable-pack',
    '--workflow-source',
    gen,
    '--cwd',
    repo,
    '--no-worktree',
    '--detach'
  );
  const runId = String(ack?.runId);
  const count = () => readFileSync(calls, 'utf8').trim().split('\n');
  const counter = attemptPath(gen, 'pkg/api');
  fs.mkdirSync(join(counter, '..'), { recursive: true });
  let resumed = false;
  for (const [change, expected] of [
    [() => {}, ['core', 'api']],
    [() => sh('git commit --allow-empty -qm resume', repo), ['core', 'api']],
    [() => fs.writeFileSync(counter, '1'), ['core', 'api', 'api']],
    [
      () => fs.writeFileSync(input, 'changed upstream candidate'),
      ['core', 'api', 'api', 'core', 'api'],
    ],
  ] as const) {
    change();
    if (resumed) invoke('resume', runId, '--detach');
    resumed = true;
    invoke('wait', runId, '--timeout', '20');
    expect(count()).toEqual([...expected]);
  }
  const code = prompt('code-core', 'package-attempt-core');
  for (const text of [
    p.packages[0].goal,
    'HINT_FULL_TEXT',
    literal,
    'selected',
    '已截断：仅前 200 行',
    '共 401 行',
    '未内联（当前 worktree 中不存在）',
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
  const evidence: ShellInputContext['nodeOutputs'] = new Map([
    ['code-core', { state: 'completed', output: '{"changed_files":["range.ts"]}' }],
    [
      'verify-core',
      { state: 'completed', output: '{"reason":"product_failure","log":"/failure.log"}' },
    ],
  ]);
  for (const [field, expected] of Object.entries({
    prior_work: '{"changed_files":["range.ts"]}',
    reason: 'product_failure',
    accept_log: '/failure.log',
  }))
    expect(
      substituteNodeOutputRefs(
        String(nodes.find(n => n.id === 'repair-core')!.with![field]),
        evidence
      )
    ).toBe(expected);
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
}, 30_000);

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'plan-two-pkgs.json'), 'utf8')
) as Plan;
const golden = (name: string): unknown =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, 'golden', `${name}.yaml`), 'utf8'));
// 语义比对：lint-staged 会对 YAML 跑 prettier，字节比对没有意义。
const NOW = Date.parse('2026-10-09T00:00:00Z');
const legacyTiers = () => {
  const tiers = loadTiers();
  if (tiers.routing.soldier) tiers.routing.soldier.models = [];
  return tiers;
};
const build = (fake: boolean, plan = fixture): unknown =>
  JSON.parse(
    JSON.stringify(
      buildWorkflow(plan, milestones(plan), 'golden-0001', '/GEN', fake, NOW, legacyTiers())
    )
  );
type N = {
  id: string;
  always_run?: boolean;
  command?: string;
  script?: string;
  bash?: string;
  depends_on?: string[];
  trigger_rule?: string;
  when?: string;
  timeout?: number;
  idle_timeout?: number;
  model?: string;
  provider?: string;
  approval?: { message: string; decisions?: { id: string }[] };
  retry?: { max_attempts?: number; on_error: string };
  maxBudgetUsd?: number;
  with?: Record<string, unknown>;
};
const nodesOf = (w: unknown): N[] => (w as { nodes: N[] }).nodes;
test('Claude coder nodes use the policy cost cap while Codex and review nodes stay uncapped', () => {
  for (const console of ['codex', 'claude'] as const) {
    const mode = console === 'claude' ? 'single:claude' : 'single:chatgpt';
    const plan = { ...fixture, console, mode } as Plan;
    const workflow = buildWorkflow(plan, milestones(plan), 'no-quota', '/GEN', false, NOW);
    const nodes = nodesOf(workflow);
    const ai = nodes.filter(node => node.command && /^(code|repair|fix|review)-/.test(node.id));
    expect(ai.length).toBeGreaterThan(0);
    for (const prefix of ['code', 'repair', 'fix', 'review'])
      expect(ai.some(node => node.id.startsWith(`${prefix}-`))).toBe(true);
    for (const node of ai) {
      expect(node.retry).toEqual({ on_error: 'transient' });
      expect(stepRetryConfigSchema.parse(node.retry)).toEqual({
        max_attempts: 2,
        on_error: 'transient',
      });
    }
    for (const node of ai) {
      const isCoder = /^(code|repair|fix)-/.test(node.id);
      expect(node.maxBudgetUsd).toBe(
        console === 'claude' && isCoder ? loadTiers().policy.coder_budget_usd.claude : undefined
      );
    }
    const land = nodes.filter(node => node.id.startsWith('land'));
    expect(land.length).toBeGreaterThan(0);
    for (const node of land) expect(node.retry).toBeUndefined();
    for (const node of nodes.filter(node => node.bash)) expect(node.retry).toBeUndefined();
  }
});

test('NO_QUOTA bash nodes ignore inherited BASH_ENV startup failures', () => {
  const root = tmp();
  const repo = gitRepo(join(root, 'repo'));
  const startup = join(root, 'startup.sh');
  const marker = join(root, 'rc-loaded');
  fs.writeFileSync(startup, `touch '${marker}'\nexit 91\n`);
  const workflows = join(repo, '.archon', 'workflows');
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    join(workflows, 'no-quota.yaml'),
    Bun.YAML.stringify({
      name: 'no-quota',
      description: 'Bash startup isolation regression',
      nodes: [{ id: 'probe', bash: 'printf success' }],
    })
  );
  sh('git add .archon && git commit -qm fixture', repo);
  const env = {
    ...fixtureEnv(),
    BASH_ENV: startup,
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home/archon'),
  };
  const invoke = (...args: string[]) => workflowCli(repo, env, ...args);
  const ack = invoke(
    'run',
    'no-quota',
    '--workflow-source',
    repo,
    '--cwd',
    repo,
    '--no-worktree',
    '--detach'
  );
  const waited = invoke('wait', String(ack?.runId), '--timeout', '20');
  expect(waited).toMatchObject({ attention: { status: 'completed' } });
  const view = invoke('get', String(ack?.runId));
  expect(view).toMatchObject({ status: 'completed' });
  expect(existsSync(marker)).toBe(false);
});

const workflowCli = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      join(WETAMP, 'src/coord/archon-entry.ts'),
      'workflow',
      ...args,
      '--json',
    ],
    { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return lastJson(result.stdout.toString());
};

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

test('completed review context replay keeps stale refs fail-closed only for unfinished rounds', () => {
  const gen = tmp(),
    repo = gitRepo(tmp()),
    artifacts = tmp(),
    counter = join(gen, 'attempt');
  fs.cpSync(join(WETAMP, 'templates/.archon'), join(artifacts, '.archon'), { recursive: true });
  fs.copyFileSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(artifacts, '.archon/scripts/policy-attempts.ts')
  );
  fs.writeFileSync(counter, '0');
  const reviewedHead = sh('git rev-parse HEAD', repo).trim();
  const frozen = join(artifacts, 'frozen.json');
  fs.writeFileSync(
    frozen,
    JSON.stringify({
      node: 'review-m1-r1',
      refs: { head: reviewedHead },
      carry_over: 'unknown',
    })
  );
  fs.writeFileSync(
    join(artifacts, 'review-m1-r1.context.json'),
    JSON.stringify({ path: frozen, attempt: 0 })
  );
  const node: N = {
    id: 'review-context-m1-r1',
    with: { counter, gen, review: 'review-m1-r1', gate: 'gate-m1-r1' },
  };
  expect(runAttempt(node, repo, artifacts).exitCode).toBe(1);
  fs.writeFileSync(
    join(artifacts, 'gate-m1-r1.json'),
    JSON.stringify({ reviewed_head: reviewedHead })
  );
  expect(runAttempt(node, repo, artifacts).exitCode).toBe(0);
  sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm drift', repo);
  expect(runAttempt(node, repo, artifacts).exitCode).toBe(1);
});

test('approval resume preserves review attempts while failed reviews refresh context', () => {
  const run = (retry: boolean) => {
    const root = tmp(),
      repo = gitRepo(join(root, 'repo')),
      source = join(root, 'source'),
      counter = join(root, 'attempt'),
      attemptCalls = join(root, 'attempt-calls'),
      setupCalls = join(root, 'setup-calls'),
      reviewCalls = join(root, 'review-calls'),
      allowReview = join(root, 'allow-review');
    fs.mkdirSync(join(source, '.archon', 'workflows'), { recursive: true });
    fs.writeFileSync(counter, '0');
    fs.writeFileSync(
      join(source, '.archon', 'workflows', 'review-resume.yaml'),
      Bun.YAML.stringify({
        name: 'review-resume',
        description: 'Review attempt resume contract',
        nodes: [
          { id: 'attempt-m1', bash: `cat '${counter}'`, always_run: true },
          { id: 'diff-m1-r1', bash: 'printf stable', depends_on: ['attempt-m1'] },
          {
            id: 'attempt-review-m1-r1',
            bash: `echo attempt >> '${attemptCalls}'; printf prepared`,
            depends_on: ['diff-m1-r1', 'attempt-m1'],
          },
          {
            id: 'review-context-m1-r1',
            bash: `echo setup >> '${setupCalls}'; printf prepared`,
            always_run: true,
            depends_on: ['attempt-review-m1-r1'],
          },
          {
            id: 'review-m1-r1',
            bash: `echo review >> '${reviewCalls}'; test -f '${allowReview}'`,
            depends_on: ['review-context-m1-r1'],
          },
          ...(retry
            ? []
            : [
                {
                  id: 'human-m1',
                  approval: { message: 'Approve review' },
                  depends_on: ['review-m1-r1'],
                },
              ]),
        ],
      })
    );
    if (!retry) fs.writeFileSync(allowReview, '1');
    const env = fixtureEnv({
      SUPERAGENT_HOME: join(root, 'home'),
      ARCHON_HOME: join(root, 'home/archon'),
    });
    const invoke = (...args: string[]) => workflowCli(repo, env, ...args);
    const ack = invoke(
      'run',
      'review-resume',
      '--workflow-source',
      source,
      '--cwd',
      repo,
      '--no-worktree',
      '--detach'
    );
    const id = String(ack?.runId);
    invoke('wait', id, '--timeout', '20');
    if (retry) {
      fs.writeFileSync(allowReview, '1');
      invoke('resume', id, '--detach');
    } else invoke('approve', id, '--detach');
    invoke('wait', id, '--timeout', '20');
    const count = (path: string) => readFileSync(path, 'utf8').trim().split('\n').length;
    expect(count(attemptCalls)).toBe(1);
    expect(count(setupCalls)).toBe(2);
    expect(count(reviewCalls)).toBe(retry ? 2 : 1);
  };
  run(false);
  run(true);
}, 30_000);

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
  expect(nodes.find(n => n.id.startsWith('human-'))?.depends_on).toEqual([gate.id, 'attempt-m1']);
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

test('SHIFT_LEFT_ACCEPT HF3 fingerprint is stable and changes with template bytes or generation logic', () => {
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
    expect(original).toContain('所有 shell 命令遵循你的 AGENTS.md 命令规则');
    expect(original).toContain('交付前运行任务书验收命令');
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
    'bin/policy-snapshot.cjs',
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
  test('soldier branch records use, stashes failed leftovers, and fails closed on reset error', () => {
    const tiers = fixtureTiers();
    const plan = structuredClone(fixture);
    plan.packages[0].draft = 'soldier';
    const nodes = nodesOf(
      buildWorkflow(plan, milestones(plan), 'soldier', '/GEN', false, NOW, tiers)
    );
    // toMatchObject 会把 asymmetric matcher 写回被比较节点，先取出原始 bash。
    const okSource = String(nodes.find(n => n.id === 'soldier-ok-core')!.bash);
    expect(nodes.find(n => n.id === 'soldier-core')).toMatchObject({
      include: 'sa-soldier-core',
      depends_on: ['soldier-items-core'],
      with: { pkg: 'core', context_node: 'package-attempt-core' },
      fan_out: {
        items: '$soldier-items-core.output',
        as: 'draft',
        max_parallel: 1,
        join: 'all_done',
      },
    });
    expect(nodes.find(n => n.id === 'soldier-items-core')).toMatchObject({
      depends_on: ['start-m1', 'package-attempt-core'],
    });
    expect(nodes.find(n => n.id === 'soldier-ok-core')).toMatchObject({
      id: 'soldier-ok-core',
      depends_on: ['soldier-core'],
      bash: expect.stringContaining('archon_failed===true'),
    });
    expect(nodes.find(n => n.id === 'soldier-reset-core')).toEqual({
      id: 'soldier-reset-core',
      depends_on: ['soldier-ok-core'],
      trigger_rule: 'all_done',
      when: "$soldier-ok-core.output != 'used'",
      bash: 'git stash push --include-untracked -m soldier-leftover-core >/dev/null && printf reset',
    });
    // 真实替换后执行：bash 节点不接收 with:，草稿结果必须内联进 bash 才能判成 used。
    const okBash = (output: string): string =>
      substituteNodeOutputRefs(
        okSource,
        new Map([['soldier-core', { state: 'completed' as const, output }]]),
        true
      );
    expect(sh(okBash(JSON.stringify([{ ok: "it's" }])), tmp())).toBe('used');
    expect(sh(okBash(JSON.stringify([{ archon_failed: true }])), tmp())).toBe('');
    const resetWhen = nodes.find(n => n.id === 'soldier-reset-core')!.when!;
    expect(
      evaluateCondition(
        resetWhen,
        new Map([['soldier-ok-core', { state: 'completed' as const, output: 'used' }]])
      ).result
    ).toBe(false);
    expect(
      evaluateCondition(
        resetWhen,
        new Map([
          [
            'soldier-ok-core',
            {
              state: 'skipped' as const,
              output: '',
              cause: { kind: 'upstream_failed' as const, origin: 'soldier-core' },
            },
          ],
        ])
      ).result
    ).toBe(true);
    expect(nodes.find(n => n.id === 'code-core')).toMatchObject({
      depends_on: [
        'start-m1',
        'package-attempt-core',
        'soldier-core',
        'soldier-ok-core',
        'soldier-reset-core',
      ],
      trigger_rule: 'all_done',
      with: { soldier_ok: 'soldier-ok-core' },
    });
    expect(() =>
      evaluateCondition(
        nodes.find(n => n.id === 'code-core')!.when!,
        new Map([
          ['start-m1', { state: 'completed' as const, output: JSON.stringify({ head: 'abc' }) }],
          [
            'package-attempt-core',
            { state: 'completed' as const, output: JSON.stringify({ attempt: '1' }) },
          ],
          [
            'soldier-reset-core',
            { state: 'failed' as const, output: 'stale', error: 'stash failed' },
          ],
        ])
      )
    ).toThrow("references node 'soldier-reset-core', but it failed");
    expect(
      nodesOf(buildWorkflow(plan, milestones(plan), 'fake', '/GEN', true, NOW, tiers)).some(n =>
        n.id.startsWith('soldier-')
      )
    ).toBe(false);
    expect(
      nodesOf(
        buildWorkflow(plan, milestones(plan), 'carry', '/GEN', false, NOW, tiers, {
          from: 'old',
          packages: ['core'],
        })
      ).some(n => n.id === 'soldier-core')
    ).toBe(false);
    expect(validateDagStructure(nodes as DagNode[])).toBeNull();
    expect(readFileSync(join(WETAMP, 'templates/.archon/commands/sa-code.md'), 'utf8')).toContain(
      '`$$INPUTS.soldier_ok.output`'
    );
  });
  test('draft routing emits soldiers only for eligible packages', () => {
    const tiers = fixtureTiers();
    const plan = structuredClone(fixture) as Plan;
    const core = plan.packages[0],
      api = plan.packages[1];
    core.size = 'L';
    api.risk = 'G1';
    api.size = 'M';
    api.draft = 'general';
    const direct = nodesOf(
      buildWorkflow(plan, milestones(plan), 'direct', '/GEN', false, NOW, tiers)
    );
    expect(direct.some(n => n.id.startsWith('soldier-'))).toBe(false);
    expect(direct.filter(n => n.id.startsWith('code-')).map(n => n.with?.soldier_ok)).toEqual([
      '',
      '',
    ]);
    core.draft = 'soldier';
    api.draft = undefined;
    const drafted = nodesOf(
      buildWorkflow(plan, milestones(plan), 'drafted', '/GEN', false, NOW, tiers)
    );
    expect(drafted.filter(n => /^soldier-(core|api)$/.test(n.id)).map(n => n.id)).toEqual([
      'soldier-core',
    ]);
    expect(
      drafted.some(
        n => /^(repair|fix)-/.test(n.id) && n.depends_on?.some(d => d.startsWith('soldier-'))
      )
    ).toBe(false);
  });
  test('P2: two-package data dependencies exclude milestone and review retry counters', () => {
    for (const sameMilestone of [false, true]) {
      const plan = structuredClone(fixture);
      if (sameMilestone) plan.packages[1].milestone = 'm1';
      const nodes = nodesOf(build(false, plan));
      const cache = new Map<string, string[]>();
      const dependencies = (id: string): string[] => {
        if (!cache.has(id)) {
          const deps = nodes.find(n => n.id === id)!.depends_on ?? [];
          cache.set(id, [...new Set([...deps, ...deps.flatMap(dependencies)])]);
        }
        return cache.get(id)!;
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
    const make = (packages: string[], coded?: string[]) =>
      buildWorkflow(
        fixture,
        milestones(fixture),
        'golden-0001',
        '/GEN',
        false,
        NOW,
        legacyTiers(),
        {
          from: "old'run",
          packages,
          evidence: Object.fromEntries(packages.map(id => [id, `/OLD/${id}.json`])),
          coded,
        }
      );
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
    expect(verify?.with?.carried_evidence).toBe('/GEN/carried-evidence/core.json');
    expect(verify?.with?.attempt).toBe('$package-attempt-core.output.attempt');
    expect(nodes.find(n => n.id === 'verify-api')?.with?.carried_evidence).toBeUndefined();
    expect(validateDagStructure(nodes as DagNode[])).toBeNull();
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
    expect(nodes.filter(n => !['code-core', 'verify-core', 'repair-core'].includes(n.id))).toEqual(
      nodesOf(normal).filter(n => !['code-core', 'verify-core', 'repair-core'].includes(n.id))
    );
    expect(code?.depends_on).toEqual(nodesOf(normal).find(n => n.id === 'code-core')?.depends_on);
    expect(nodesOf(make([], ['core'])).find(n => n.id === 'code-core')?.when).toBe(code?.when);
    expect(
      JSON.parse(
        (
          nodesOf(make([], ['core'])).find(n => n.id === 'verify-core')?.with?.coder as {
            if_skipped: string;
          }
        ).if_skipped
      ).notes
    ).toBe("coded from old'run");
  });
  test('engine-stale adoption carries terminal review checkpoint without restarting R1', () => {
    const checkpoint = {
      gate: {
        verdict: 'pass',
        decision: {
          kind: 'debt' as const,
          reason: null,
          evidence: [],
          debt: ["audit $code-core.output and 'quotes'"],
        },
        reviewed_head: 'a'.repeat(40),
        reviewed_diff_hash: 'd'.repeat(16),
        ledger_file: '/OLD/gate-m1-r4.ledger.json',
      },
      check: { contract_hash: 'c'.repeat(64) },
    };
    const nodes = nodesOf(
      buildWorkflow(fixture, milestones(fixture), 'continued', '/GEN', false, NOW, loadTiers(), {
        from: 'old-run',
        packages: [],
        reviews: { m1: checkpoint },
      })
    );
    const carried = nodes.find(n => n.id === 'carried-gate-m1')!;
    expect(carried.bash).toContain('$ARTIFACTS_DIR/gate-m1-r1.json');
    expect(carried.bash).not.toContain('$code-core.output');
    expect(carried.bash).toContain('/GEN/review-checkpoints/m1.json');
    expect(carried.when).toContain(`.contract_hash == '${checkpoint.check.contract_hash}'`);
    expect(nodes.find(n => n.id === 'review-m1-r1')?.when).toContain(
      `.contract_hash != '${checkpoint.check.contract_hash}'`
    );
    expect(nodes.find(n => n.id === 'gate-m1-r1')?.when).toContain(
      `.contract_hash != '${checkpoint.check.contract_hash}'`
    );
    expect(nodes.find(n => n.id === 'land-m1')?.depends_on).toContain(carried.id);
    expect(nodes.find(n => n.id === 'start-m2')?.depends_on).toEqual(['land-m1']);
  });
  test('engine-stale adoption rejects checkpoint when reviewed_head or contract hash drifts', () => {
    const checkpoint = {
      gate: {
        decision: { kind: 'advance' as const, reason: null, evidence: [], debt: [] },
        reviewed_head: 'head',
        reviewed_diff_hash: 'd'.repeat(16),
        ledger_file: '/ledger',
      },
      check: { contract_hash: 'c'.repeat(64) },
    };
    const nodes = nodesOf(
      buildWorkflow(fixture, milestones(fixture), 'continued', '/GEN', false, NOW, loadTiers(), {
        from: 'old',
        packages: [],
        reviews: { m1: checkpoint },
      })
    );
    const carry = nodes.find(n => n.id === 'carried-gate-m1')!;
    const review = nodes.find(n => n.id === 'review-m1-r1')!;
    const outputs = new Map([
      [
        'diff-m1-r1',
        {
          state: 'completed' as const,
          output: JSON.stringify({
            disposition: 'advance',
            head: 'head',
            diff_hash: checkpoint.gate.reviewed_diff_hash,
            contract_hash: checkpoint.check.contract_hash,
          }),
        },
      ],
    ]);
    expect(evaluateCondition(carry.when!, outputs).result).toBe(true);
    expect(evaluateCondition(review.when!, outputs).result).toBe(false);
    outputs.set('diff-m1-r1', {
      state: 'completed',
      output: JSON.stringify({
        disposition: 'repair',
        head: 'head',
        diff_hash: checkpoint.gate.reviewed_diff_hash,
        contract_hash: checkpoint.check.contract_hash,
      }),
    });
    expect(evaluateCondition(carry.when!, outputs).result).toBe(false);
    for (const drift of [{ head: 'other' }, { contract_hash: 'other' }]) {
      outputs.set('diff-m1-r1', {
        state: 'completed',
        output: JSON.stringify({
          disposition: 'advance',
          head: 'head',
          diff_hash: checkpoint.gate.reviewed_diff_hash,
          contract_hash: checkpoint.check.contract_hash,
          ...drift,
        }),
      });
      expect(evaluateCondition(carry.when!, outputs).result).toBe(false);
      expect(evaluateCondition(review.when!, outputs).result).toBe(true);
    }
  });
  test('P2 R2: incrementing a carried package attempt enables sa-code with its hint', () => {
    const gen = tmp();
    fs.cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
    fs.copyFileSync(
      join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
      join(gen, '.archon/scripts/policy-attempts.ts')
    );
    const repo = gitRepo(tmp());
    fs.mkdirSync(join(gen, 'briefs'));
    for (const p of fixture.packages)
      fs.writeFileSync(
        join(gen, 'briefs', `${p.id}.md`),
        renderBrief(p, '', capsOf(fixture, p, []))
      );
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
          expect(result.exitCode, result.stderr.toString()).toBe(0);
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
      context_node: 'package-attempt-core',
      soldier_ok: '',
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
      const when = nodes.find(n => n.id === 'review-m1-r1')!.when!;
      const ctx = {
        nodeOutputs: new Map([
          [
            'diff-m1-r1',
            {
              state: 'completed' as const,
              output: JSON.stringify({
                disposition: 'advance',
                risk: 'G1',
                self_report_conflict: true,
                error_class_ignored: true,
              }),
            },
          ],
        ]),
      };
      expect(evaluateCondition(when, ctx.nodeOutputs)).toMatchObject({
        parsed: true,
        result: false,
      });
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
        expect(n.timeout).toBe(Math.max(ms, 20_000 + CHECK_AUX_BUDGET_MS + 5_000));
      for (const n of nodes.filter(
        n => n.with?.kind !== 'accept' && n.with?.kind !== 'settle' && n.id !== 'environment'
      ))
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
        expect(nodes.find(n => n.id === id)?.timeout).toBe(3_000_000 + CHECK_AUX_BUDGET_MS + 5_000);
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
    expect(nodes.find(n => n.id === 'verify-api')?.timeout).toBe(
      600_000 + CHECK_AUX_BUDGET_MS + 5_000
    );
    expect(nodes.find(n => n.id === 'settle-web')?.timeout).toBe(
      1_200_000 + CHECK_AUX_BUDGET_MS + 5_000
    );
    for (const r of [1, 2, 3]) {
      const n = nodes.find(n => n.id === `diff-m2-r${r}`);
      expect(n?.with).toMatchObject({ pkgs: 'api,web', scope_pkgs: 'core,api,web' });
      expect(n?.timeout).toBe(1_800_000 + CHECK_AUX_BUDGET_MS + 5_000);
    }
  });
  test('RUN_PROVISION: environment budget includes install and prepare even without declared checks', () => {
    const plan = structuredClone(fixture);
    plan.environment = [{ cmd: 'plan-env', timeout_s: 200 }];
    plan.packages[0].environment = [{ cmd: 'pkg-env', timeout_s: 300 }];
    expect(nodesOf(build(false, plan)).find(n => n.id === 'environment')?.timeout).toBe(
      500_000 + CHECK_AUX_BUDGET_MS + 5_000 + 2 * RECOVERY_TIMEOUT_MS
    );
    expect(nodesOf(build(false)).find(n => n.id === 'environment')?.timeout).toBe(
      120_000 + 2 * RECOVERY_TIMEOUT_MS
    );
    expect(nodesOf(build(false)).find(n => n.id === 'environment')?.retry).toEqual({
      max_attempts: loadTiers().policy.auto_retry.environment,
      on_error: 'all',
    });
    for (const node of nodesOf(build(false, plan)).filter(
      n => n.with?.kind === 'accept' || n.with?.kind === 'settle'
    ))
      expect(node.timeout).toBe(500_000 + 60_000 + CHECK_AUX_BUDGET_MS + 5_000);
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
        effort: snapshotPolicy(loadTiers()).effort,
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
      ...fixtureEnv(),
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
  test('package delta starts at the previous delivery, not the milestone baseline', () => {
    const plan = structuredClone(fixture) as Plan;
    plan.packages[1].milestone = plan.packages[0].milestone;
    const workflow = buildWorkflow(plan, milestones(plan), 'golden-0001', '/GEN', false, NOW);
    const nodes = workflow.nodes as { id: string; with?: Record<string, unknown> }[];
    expect(nodes.find(n => n.id === 'verify-core')?.with?.delta_base).toBe('$start-m1.output.head');
    expect(nodes.find(n => n.id === 'verify-api')?.with?.delta_base).toBe(
      '$settle-core.output.head'
    );
    expect(nodes.find(n => n.id === 'settle-api')?.with?.delta_base).toBe(
      '$settle-core.output.head'
    );
  });
  test('golden: two packages across two milestones', () => {
    expect(build(false)).toEqual(golden('two-pkgs'));
  });
  test('multi-milestone delivery lands each cumulative prefix before the next starts', () => {
    const nodes = nodesOf(build(false));
    expect(nodes.find(n => n.id === 'land-m1')).toMatchObject({
      with: { milestone: 'm1', pkgs: 'core', output: 'land-m1.json' },
    });
    expect(nodes.find(n => n.id === 'start-m2')?.depends_on).toEqual(['land-m1']);
    expect(nodes.find(n => n.id === 'land-m2')).toMatchObject({
      with: { milestone: 'm2', pkgs: 'core,api', output: 'land-m2.json' },
    });
  });
  test('golden: fake mode swaps coder nodes for bash stubs only', () => {
    expect(build(true)).toEqual(golden('two-pkgs-fake'));
  });
  test('review rounds are derived from the configured policy ladder', () => {
    const tiers = structuredClone(loadTiers());
    for (const ladder of [tiers.policy.effort.reviewer, tiers.policy.effort.G2_reviewer])
      for (const round of ['R3', 'R4', 'R5', 'R6']) delete ladder[round];
    const nodes = nodesOf(
      buildWorkflow(fixture, milestones(fixture), 'round-policy', '/GEN', false, NOW, tiers)
    );
    expect(nodes.filter(node => node.id.startsWith('gate-m1-r')).map(node => node.id)).toEqual([
      'gate-m1-r1',
      'gate-m1-r2',
    ]);
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
      const allNodes = nodesOf(
        buildWorkflow(fixture, milestones(fixture), 'hf10b', gen, fake, NOW)
      );
      const nodes = allNodes.filter(n => n.id.startsWith('attempt-review-'));
      expect(nodes).toHaveLength(milestones(fixture).length * MAX_ROUNDS);
      const node = nodes.find(n => n.id === id)!;
      expect(node.always_run).toBeUndefined();
      expect(node.depends_on).toContain(`attempt-${id.slice(15).replace(/-r\d+$/, '')}`);
      const reviewContextNode = allNodes.find(
        n => n.id === id.replace('attempt-review-', 'review-context-')
      )!;
      if (fake) expect(reviewContextNode).toBeUndefined();
      else {
        expect(reviewContextNode.always_run).toBeTrue();
        expect(reviewContextNode.depends_on).toEqual([id]);
        expect(reviewContextNode.with?.gate).toBe(id.replace('attempt-review-', 'gate-'));
        expect(allNodes.find(n => n.id === id.slice('attempt-'.length))?.depends_on).toContain(
          reviewContextNode.id
        );
      }
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
          'import { environmentIdentity, projectEnvironment } from "./.archon/scripts/sa-check.ts"; console.log(environmentIdentity(projectEnvironment(process.env)));',
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
    const first = JSON.parse(sh(n('start-m1').bash!, repo)) as { head: string };
    expect(first.head).toBe(original);
    expect(sh(`git diff --binary ${first.head} HEAD`, repo)).toContain('+delivered');
    // 后续里程碑只评审前序 land head 之后的增量，不再重审已落地的前序改动。
    const landed = sh('git rev-parse HEAD', repo).trim();
    const startM2 = (head: string): string =>
      n('start-m2').bash!.replace('$land-m1.output.head', `'${head}'`);
    expect(n('start-m2').bash).toContain('head=$land-m1.output.head;');
    expect(JSON.parse(sh(startM2(landed), repo))).toEqual({ head: landed });
    expect(() => sh(startM2(''), repo)).toThrow();
    sh(`git branch "base'quoted" ${original}`, repo);
    const quoted = nodesOf(build(false, { ...fixture, base_ref: "base'quoted" }));
    const start = JSON.parse(sh(quoted.find(x => x.id === 'start-m1')!.bash!, repo)) as {
      head: string;
    };
    expect(start.head).toBe(original);
    expect(n('diff-m1-r1').with?.base).toBe('$start-m1.output.head');
    expect(n('review-m1-r1').with?.diff).toBe('$diff-m1-r1.output.patch');
    expect(n('review-m1-r1').when).not.toContain('same');
    expect(n('review-m2-r1').with?.briefs).toBe('/GEN/briefs/api.md');
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
  test('packages run serially; each milestone lands after its gate and optional signoff', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('start-m1')?.depends_on).toEqual(['environment']);
    expect(n('code-core')?.depends_on).toEqual(['start-m1', 'package-attempt-core']);
    expect(n('land-m1')).toMatchObject({
      depends_on: Array.from({ length: MAX_ROUNDS }, (_, i) => `gate-m1-r${String(i + 1)}`),
      trigger_rule: 'none_failed_min_one_success',
    });
    expect(n('start-m2')?.depends_on).toEqual(['land-m1']);
    expect(n('human-m2')).toMatchObject({
      approval: {
        message: 'Approve delivery milestone m2',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
      },
      trigger_rule: 'none_failed_min_one_success',
    });
    expect(n('human-m2')?.depends_on).toContain('attempt-m2');
    expect(n('signoff-m2')?.depends_on).toEqual(['human-m2']);
    expect(n('signoff-m2')?.when).toBe("$human-m2.output.decision == 'approve'");
    expect(n('land-m2')?.depends_on).toEqual(['signoff-m2']);
    expect(nodes.at(-1)?.id).toBe('land-m2');
  });
  test('review rounds: fix only when the previous gate says fix; later gates see every earlier round', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('fix-m1-r1')).toBeUndefined();
    expect(n('fix-m1-r2')).toMatchObject({
      depends_on: ['gate-m1-r1', 'attempt-m1', 'handoff-m1-r2'],
      when: "$gate-m1-r1.output.verdict == 'fix'",
    });
    expect(n('diff-m1-r3')?.depends_on).toEqual(['fix-m1-r3', 'attempt-m1']);
    expect(
      Object.keys(n('gate-m1-r3')?.with ?? {})
        .filter(k => /^[RC]\d$/.test(k))
        .sort()
    ).toEqual(['C1', 'C2', 'C3', 'R1', 'R2', 'R3']);
    for (let r = 4; r <= MAX_ROUNDS; r++) {
      const t = `m1-r${String(r)}`,
        before = `m1-r${String(r - 1)}`;
      expect(n(`fix-${t}`)?.when).toBe(`$gate-${before}.output.verdict == 'fix'`);
      expect(n(`handoff-${t}`)?.when).toBe(n(`fix-${t}`)?.when);
      expect(n(`review-${t}`)?.command).toBe('sa-review-delta');
      expect(n(`diff-${t}`)?.depends_on).toContain(`fix-${t}`);
      expect(Object.keys(n(`gate-${t}`)?.with ?? {}).filter(k => /^[RC]\d$/.test(k))).toHaveLength(
        r * 2
      );
      expect(n(`gate-${t}`)?.trigger_rule).toBe('none_failed_min_one_success');
    }
    expect(n('review-m1-r2')).toMatchObject({
      command: 'sa-review-delta',
    });
  });
  test('unchanged fix diff skips review only when an earlier review covered its hash', () => {
    const nodes = nodesOf(build(false));
    const n = (id: string): N | undefined => nodes.find(x => x.id === id);
    expect(n('diff-m1-r1')?.with?.prev).toBeUndefined();
    expect(n('diff-m1-r2')?.with?.prev).toBe('$diff-m1-r1.output.diff_hash');
    expect(n('diff-m1-r2')?.with?.reviewed_diff_hash).toBe('$gate-m1-r1.output.reviewed_diff_hash');
    expect(n('review-m1-r1')?.when).toBe("$diff-m1-r1.output.disposition == 'advance'");
    expect(n('review-m1-r2')?.when).toBe(
      "$diff-m1-r2.output.disposition == 'advance' && $diff-m1-r2.output.same != 'true' || " +
        "$diff-m1-r2.output.disposition == 'advance' && $diff-m1-r2.output.reviewed != 'true'"
    );
    const when = n('review-m1-r2')!.when!;
    const outputs = new Map([
      [
        'diff-m1-r2',
        {
          state: 'completed' as const,
          output: JSON.stringify({ disposition: 'advance', same: true, reviewed: false }),
        },
      ],
      ['gate-m1-r1', { state: 'completed' as const, output: '{}' }],
    ]);
    expect(evaluateCondition(when, outputs)).toMatchObject({ parsed: true, result: true });
    outputs.set('diff-m1-r2', {
      state: 'completed',
      output: JSON.stringify({ disposition: 'advance', same: true, reviewed: true }),
    });
    expect(evaluateCondition(when, outputs)).toMatchObject({ parsed: true, result: false });
    expect(n('gate-m1-r2')).toMatchObject({
      depends_on: ['diff-m1-r2', 'review-m1-r2'],
      trigger_rule: 'none_failed_min_one_success',
    });
  });
  test('signoff and land check the absolute plan deadline, not only the relative wait', () => {
    const nodes = nodesOf(build(false, { ...fixture, deadline: '2026-10-10T00:00:00Z' }));
    const signoff = nodes.find(x => x.id === 'signoff-m2') as N & { bash: string };
    expect(signoff.bash).toContain(`-le ${String(Date.parse('2026-10-10T00:00:00Z') / 1000)} ]`);
    expect(nodes.find(x => x.id === 'land-m2')?.with).toMatchObject({
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
    expect(nodes.find(x => x.id === 'land-m2')?.depends_on).toEqual(
      Array.from({ length: MAX_ROUNDS }, (_, i) => `gate-m2-r${String(i + 1)}`)
    );
  });
  test('native approval owns signoff; passed plan deadlines fail generation', () => {
    const approval = (deadline: string) =>
      nodesOf(build(false, { ...fixture, deadline })).find(x => x.id === 'human-m2')?.approval;
    expect(approval('2026-10-10T00:00:00Z')).toEqual({
      message: 'Approve delivery milestone m2',
      decisions: [{ id: 'approve' }, { id: 'reject' }],
    });
    expect(() => approval('2026-10-09T00:00:00Z')).toThrow(/already passed/);
  });
  test('all generated nodes preserve native agent tools', () => {
    const denied = (console: 'claude' | 'codex', id: string): unknown =>
      (
        nodesOf(build(false, { ...fixture, console })).find(x => x.id === id) as Record<
          string,
          unknown
        >
      ).denied_tools;
    // console=codex：@sa-reviewer 解析为 claude；@sa-coder 是 codex
    expect(denied('codex', 'review-m1-r1')).toBeUndefined();
    expect(denied('codex', 'code-core')).toBeUndefined();
    expect(denied('claude', 'review-m1-r1')).toBeUndefined();
  });
  test('reviewer integrity belongs to the deterministic gate in both consoles', () => {
    const node = (console: 'claude' | 'codex', id: string): Record<string, unknown> =>
      nodesOf(build(false, { ...fixture, console })).find(x => x.id === id) as Record<
        string,
        unknown
      >;
    for (const id of ['review-m1-r1', 'review-m2-r3']) {
      for (const c of ['claude', 'codex'] as const) {
        expect(node(c, id).mcp).toBeUndefined();
        expect(node(c, id).sandbox).toBeUndefined();
        expect(node(c, id).mutates_checkout).toBeUndefined();
      }
    }
    for (const c of ['claude', 'codex'] as const) {
      expect(node(c, 'code-core').sandbox).toBeUndefined();
      expect(node(c, 'code-core').mcp).toBeUndefined();
    }
  });
  test('plan prose never enters the workflow text (no $ substitution hazard)', () => {
    expect(JSON.stringify(build(false))).not.toContain('$HOME');
  });
});

describe('renderBrief', () => {
  test('takes the S package test limit from tiers policy', () => {
    const p = fixture.packages[0];
    const limit = loadTiers().policy.test_budget.S;
    const brief = renderBrief(p, '/H/core.md', capsOf(fixture, p, []));
    expect(brief).toContain(
      `新增测试上限（除非任务备注另有明确要求）：${String(limit.cases)} 个用例、${String(limit.lines)} 行测试代码。`
    );
  });
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
    expect(b).toContain('交付前在当前 worktree 按原样运行本包全部命令一次');
    expect(b).toContain('命令通过不代替逐项核对需求的实现位置与对应测试');
    expect(b).not.toContain('跑长时测试（全量、E2E）');
  });
  test('lists the package permissions and the execution-layer red lines', () => {
    const p = { ...fixture.packages[0], caps: { network: false, git: 'commit' as const } };
    const b = renderBrief(p, '/H/core.md', capsOf(fixture, p, ['searxng']));
    for (const s of [
      '## 你的权限',
      '包仓库）：禁止',
      '只追加提交',
      '禁止 git commit 的条款面向人工主仓，此处不适用',
      'skills/plugins/MCP：继承用户原生配置',
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

test('SHIFT_LEFT_ACCEPT generated code/repair/fix require acceptance before delivery', () => {
  const root = tmp();
  Object.assign(process.env, {
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'archon'),
  });
  const engine = gitRepo(tmp());
  const clean = coord.cleanEngine;
  const boundary = spyOn(coord, 'cleanEngine').mockImplementation(() => clean(engine));
  try {
    const plan = loadPlan(fixturePlan(root, gitRepo(root)), [root]);
    const gen = generate(plan, 'shift-left');
    const workflow = Bun.YAML.parse(
      readFileSync(join(gen.dir, '.archon/workflows', gen.workflow, `${gen.workflow}.yaml`), 'utf8')
    );
    const commands = new Set(nodesOf(workflow).map(n => n.command));
    for (const command of ['sa-code', 'sa-repair', 'sa-fix']) {
      expect(commands.has(command)).toBe(true);
      const prompt = readFileSync(join(gen.dir, '.archon/commands', `${command}.md`), 'utf8');
      for (const requirement of [
        '$$INPUTS.context_node.output.context_pack',
        '交付前运行任务书验收命令',
        '在当前 worktree、commit 前',
        '保持相同 cwd 与环境前缀',
        '失败就在本会话继续修，直到全部通过',
        '把实际命令与退出码写进 `quick_checks`',
        '引擎的 verify 照常独立复跑，是唯一的放行依据',
        'coder 自报永远不作为验收证据',
        '基线上就失败且与本次工作无关',
        '"cap":"environment"',
        '改用等价路径完成任务，并在 `deviations` 记录',
        '只有任务目标本身必须执行被拒绝的高危操作时',
        '`blocked`、`error_class: redline` 和非空 `needs`',
      ])
        expect(prompt).toContain(requirement);
      for (const stale of [
        '正式验收由引擎独占执行',
        '不要求交付前',
        '省事验证或跳过',
        '命中红线',
        '复验仍不通过即挂起',
        '不重跑前序里程碑验收',
      ])
        expect(prompt).not.toContain(stale);
      expect(prompt).toContain(
        command === 'sa-code'
          ? '按任务书原样运行全部 `accept` 命令'
          : '失败的验收命令及受影响的其余验收命令'
      );
    }
  } finally {
    boundary.mockRestore();
  }
}, 30_000);

function withCleanEngine(check: () => void): () => void {
  return () => {
    const engine = gitRepo(tmp()),
      clean = coord.cleanEngine;
    const boundary = spyOn(coord, 'cleanEngine').mockImplementation(() => clean(engine));
    try {
      check();
    } finally {
      boundary.mockRestore();
    }
  };
}

function checkGeneratedRepo(): void {
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
  expect(nodesOf(generated).find(n => n.id === 'land-m1')?.with?.operator_ledger).toBe(
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
  expect(existsSync(join(g.dir, 'reviewer-readonly.mcp.json'))).toBe(false);
  // console=codex 的评审节点允许测试写入，Archon 校验同样通过
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
  expect(singleConfig.aliases['@sa-coder'].provider).toBe('claude');
  expect(singleConfig.aliases['@sa-reviewer-G0'].provider).toBe('codex');
  const singleWorkflow = Bun.YAML.parse(
    readFileSync(
      join(single.dir, '.archon/workflows', single.workflow, `${single.workflow}.yaml`),
      'utf8'
    )
  );
  for (const n of nodesOf(singleWorkflow).filter(n => n.command)) {
    const model = (n as N & { model: string }).model;
    expect(singleConfig.aliases[model].provider).toBe(
      n.command!.startsWith('sa-review') || n.command === 'sa-soldier' ? 'codex' : 'claude'
    );
  }
  const thin = loadPlan(
    fixturePlan(root, plan.repo, p => (p.budget = { weighted_tokens: 700000 })),
    [root]
  );
  expect(() => generate(thin, 'gen-observe')).not.toThrow();
  expect(() => generate(thin, 'gen-0003')).not.toThrow();
  const fake = generate(plan, 'gen-fake', true);
  for (const command of new Set(ai.map(n => n.command))) {
    const path = join('.archon', 'commands', `${command}.md`);
    expect(readFileSync(join(fake.dir, path), 'utf8')).toBe(
      readFileSync(join(WETAMP, 'templates', path), 'utf8')
    );
  }
}

test(
  'generate writes a committed gen repo that archon validates',
  withCleanEngine(checkGeneratedRepo),
  60000
);

function checkMissingPrinciples(): void {
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
}

test(
  'generate fails clearly before writing gen when core principles are missing',
  withCleanEngine(checkMissingPrinciples)
);

test('delivery defaults: no deadline survives >24h and preserves explicit human signoff', () => {
  const { deadline: _deadline, ...plan } = fixture;
  const nodes = nodesOf(
    buildWorkflow(plan, milestones(plan), 'defaults', '/GEN', false, NOW + 48 * 3600_000)
  );
  expect(nodes.find(n => n.id === 'human-m2')?.approval).toEqual({
    message: 'Approve delivery milestone m2',
    decisions: [{ id: 'approve' }, { id: 'reject' }],
  });
  expect(nodes.find(n => n.id === 'signoff-m2')?.bash).toBe('true');
  expect(nodes.find(n => n.id === 'land-m2')).toBeDefined();
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
  const gen = tmp(),
    repo = gitRepo(tmp());
  fs.mkdirSync(join(gen, 'briefs'));
  for (const p of fixture.packages)
    fs.writeFileSync(join(gen, 'briefs', `${p.id}.md`), renderBrief(p, '', capsOf(fixture, p, [])));
  fs.writeFileSync(join(gen, 'plan.json'), JSON.stringify(fixture));
  fs.writeFileSync(
    join(gen, 'execution.json'),
    JSON.stringify(executionTable(fixture, loadTiers()))
  );
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
      cwd: repo,
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
  const diagnostics = result.stderr.toString().trim().split('\n').filter(Boolean);
  expect(diagnostics.map(line => JSON.parse(line).event)).toEqual(['codegraph: unavailable']);
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
  const tiers = fixtureTiers();
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
    const nodes = nodesOf(buildWorkflow(p, ms, 'roles', '/GEN', false, NOW, tiers));
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
      ...Array.from({ length: MAX_ROUNDS - 1 }, () => ['sa-fix', 'sa-review-delta']).flat(),
    ]);
    expect(nodes.find(n => n.id === 'fix-m1-r2')?.when).toBe("$gate-m1-r1.output.verdict == 'fix'");
    expect(nodes.find(n => n.id === 'verify-core')?.with?.kind).toBe('accept');
    expect(nodes.find(n => n.id === 'settle-core')?.with?.kind).toBe('settle');
    expect(nodes.find(n => n.id === 'settle-core')?.with?.first).toBe(
      '$verify-core.output.disposition'
    );
  }
});

test('NO_HOLD generated acceptance uses bounded repairs and no durable human wait', () => {
  const p = structuredClone(fixture);
  for (const pkg of p.packages) pkg.signoff = 'auto';
  const workflow = buildWorkflow(p, milestones(p), 'no-hold', '/tmp/no-hold', true, 0);
  const nodes = workflow.nodes as Record<string, unknown>[];
  const acceptance = nodes.filter(n => /^(verify|settle|diff|gate)-/.test(String(n.id)));
  expect(acceptance.length).toBeGreaterThan(0);
  for (const node of acceptance) {
    expect(node.wait).toBeUndefined();
    expect(node.approval).toBeUndefined();
    expect(node.retry).toBeUndefined();
  }
  expect(nodes.find(n => n.id === 'repair-core')?.when).toBe(
    "$verify-core.output.disposition == 'repair'"
  );
});

test('DURABLE_DELIVERY generated node receives run id through real Archon execution', () => {
  const root = tmp(),
    repo = gitRepo(join(root, 'repo')),
    run = newRunId(new Date(NOW));
  const delivery = { checkout: '/repo', branch: 'feature', head: 'a'.repeat(40) };
  const single = structuredClone(fixture);
  single.packages[1].milestone = 'm1';
  const nodes = nodesOf(
    buildWorkflow(
      single,
      milestones(single),
      run,
      '/GEN',
      false,
      NOW,
      loadTiers(),
      undefined,
      delivery
    )
  );
  const deliver = nodes.find(n => n.id === 'deliver')!;
  expect(deliver).toMatchObject({ depends_on: ['land'] });
  expect(Number(deliver.timeout)).toBeGreaterThanOrEqual(
    integrationLockTimeout() +
      single.packages.flatMap(p => p.accept).reduce((ms, c) => ms + c.timeout_s * 1000, 0)
  );
  const observed = join(root, 'received-run.json');
  const preload = join(root, 'delivery-probe.ts');
  // Observe the actual land.ts child before authorization/integration can run.
  fs.writeFileSync(
    preload,
    `if (process.argv[1] === ${JSON.stringify(join(WETAMP, 'src/land.ts'))}) {
      await Bun.write(${JSON.stringify(observed)}, JSON.stringify({ run: process.env.INPUTS_RUN }));
      process.exit(0);
    }`
  );
  const workflows = join(repo, '.archon/workflows');
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(
    join(workflows, 'delivery-input.yaml'),
    Bun.YAML.stringify({
      name: 'delivery-input',
      description: 'Generated delivery process input contract',
      nodes: [{ id: 'land', bash: 'true' }, deliver],
    })
  );
  const env = fixtureEnv({
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home/archon'),
    INPUTS_RUN: 'wrong-inherited-run',
    BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`,
  });
  const ack = workflowCli(
    repo,
    env,
    'run',
    'delivery-input',
    '--workflow-source',
    repo,
    '--cwd',
    repo,
    '--no-worktree',
    '--detach'
  );
  const waited = workflowCli(repo, env, 'wait', String(ack?.runId), '--timeout', '20');
  expect(waited).toMatchObject({ attention: { status: 'completed' } });
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({ run });
}, 30_000);

test.each(['', 'bad-id', "ab'cd", 'ab\n', '$(echo bad)', 'ab cd'])(
  'DURABLE_DELIVERY rejects unsafe run id %j before building a shell command',
  run => {
    expect(() =>
      buildWorkflow(fixture, milestones(fixture), run, '/GEN', false, NOW, loadTiers(), undefined, {
        checkout: '/repo',
        branch: 'feature',
        head: 'a'.repeat(40),
      })
    ).toThrow('delivery: invalid run id');
  }
);

// The gate's C bindings carry complete acceptance outputs, including checkout fingerprints.
// prettier-ignore
test('gate rejects oversized resolved env before spawn without interpreting review', () => {
  const ctx: ShellInputContext = {
    workflowRun: { id: 'big', user_message: '', metadata: {} },
    artifactsDir: '/art', stateDir: '/state', baseBranch: 'dev', docsDir: '/docs',
    nodeOutputs: new Map([['diff', { state: 'completed', output: JSON.stringify({ log: '中'.repeat(180000) }) }]]),
  };
  const node = { id: 'gate', kind: 'exec' as const, script: 'sa-check', runtime: 'bun' as const, with: { C1: '$diff.output' } };
  expect(() => inputEnvVars(node, ctx)).toThrow('engine_execution_boundary');
  expect(() => inputEnvVars(node, ctx)).toThrow('INPUTS_C1=540021 bytes');
  ctx.nodeOutputs.set('diff', { state: 'completed', output: JSON.stringify({ path: '/art/result.json' }) });
  expect(inputEnvVars(node, ctx).INPUTS_C1).toBe('{"path":"/art/result.json"}');
  node.with.C1 = 'x'.repeat(70000);
  Object.assign(node.with, { C2: 'y'.repeat(70000) });
  expect(() => inputEnvVars(node, ctx)).toThrow('env budget');
});
