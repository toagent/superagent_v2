import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastJson } from '../src/archon';
import { executionTable } from '../src/execution';
import { loadTiers, WETAMP } from '../src/config';
import type { Plan } from '../src/plan';
import { resolveAcceptanceContext } from '../src/role-context';
import { contextPack, prepareContext, roleContext } from '../templates/.archon/scripts/sa-context';
import {
  buildExecNodeEnvironment,
  EXEC_NODE_ENVIRONMENT_NAMES,
} from '../../packages/workflows/src/exec-environment';
import { newNodeInvocation, startNodeExecution } from '../../packages/workflows/src/node-execution';
import { NODE_CONTRACT_ENV } from '../templates/.archon/scripts/sa-check';
import { gitRepo, fixtureEnv, sh, tmp } from './helpers';

test('CONTEXT_PACK blocks outside/private symlink targets and preserves byte/range boundaries', () => {
  const gen = tmp(),
    repo = gitRepo(tmp()),
    outside = tmp();
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  plan.packages[0].scope = {
    write: [],
    read_hint: [
      '../outside.ts',
      join(outside, 'file.ts'),
      'alias.ts',
      'nested/file.ts',
      'private-alias.ts',
      '.env.production',
      'cert.pem',
      'publickey.ts',
      '_private/file.ts',
      'empty.ts',
      'range.ts:2-2',
      'full.ts',
      'over.ts',
    ],
  };
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(plan, loadTiers())));
  mkdirSync(join(gen, 'briefs'));
  writeFileSync(join(gen, 'briefs/core.md'), 'TASK_BODY');
  writeFileSync(join(outside, 'file.ts'), 'OUTSIDE_SECRET');
  mkdirSync(join(repo, '_private'));
  writeFileSync(join(repo, '_private/file.ts'), 'PRIVATE_SECRET');
  symlinkSync(join(outside, 'file.ts'), join(repo, 'alias.ts'));
  symlinkSync(outside, join(repo, 'nested'));
  symlinkSync(join(repo, '_private/file.ts'), join(repo, 'private-alias.ts'));
  for (const file of ['.env.production', 'cert.pem', 'publickey.ts'])
    writeFileSync(join(repo, file), 'CREDENTIAL_SECRET');
  writeFileSync(join(repo, 'empty.ts'), '');
  writeFileSync(join(repo, 'range.ts'), 'UNSELECTED\nselected\nUNSELECTED');
  writeFileSync(join(repo, 'full.ts'), 'x'.repeat(48 * 1024 - 'selected'.length));
  writeFileSync(join(repo, 'over.ts'), 'OVER_BUDGET');
  const context = roleContext({
    gen,
    artifacts: gen,
    node: 'code-core',
    cwd: repo,
    base: 'base',
    head: 'head',
    environment: 'unknown',
  });
  const before = sh('git status --porcelain', repo);
  const pack = contextPack(gen, context);
  expect(pack).toContain('TASK_BODY');
  expect(pack).toContain('selected');
  expect(pack).toContain('共 0 行');
  expect(pack).toContain('x'.repeat(48 * 1024 - 'selected'.length));
  expect(pack).toContain('48KB 上限');
  for (const secret of [
    'OUTSIDE_SECRET',
    'PRIVATE_SECRET',
    'CREDENTIAL_SECRET',
    'UNSELECTED',
    'OVER_BUDGET',
  ])
    expect(pack).not.toContain(secret);
  expect(sh('git status --porcelain', repo)).toBe(before);
});

test('ROOT_ACCEPT prepared R2 preserves requirements and open carry-over without closed history; immutable bytes', async () => {
  const gen = tmp(),
    repo = gitRepo(tmp()),
    art = join(gen, 'artifacts');
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  plan.packages[1].requirements = [{ id: 'api', text: 'Write api.txt', verified_by: [0] }];
  cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
  cpSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(gen, '.archon/scripts/policy-attempts.ts')
  );
  writeFileSync(join(gen, '.archon/scripts/reasons.json'), '[]');
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(plan, loadTiers())));
  mkdirSync(art);
  const open = {
    id: 'R1-1',
    severity: 'high',
    file: 'core.txt',
    line: 1,
    evidence: 'must retain',
    failure_class: 'unknown',
  };
  const ledger = {
    blocking: [open],
    debt: [{ ...open, id: 'R1-2', severity: 'low' }],
    closed: Array.from({ length: 100 }, (_, i) => ({ ...open, id: `old-${i}` })),
  };
  writeFileSync(join(art, 'gate-m2-r1.ledger.json'), JSON.stringify(ledger));
  const head = sh('git rev-parse HEAD', repo).trim();
  // real exec nodes have distinct execution identities and artifact listings.
  const nodeEnv = (node: string) =>
    buildExecNodeEnvironment({
      artifactsDir: art,
      stateDir: gen,
      logDir: gen,
      workflowId: 'fixture',
      baseBranch: 'main',
      userMessage: '',
      loopUserInput: '',
      loopPrevOutput: '',
      rejectionReason: '',
      typedArtifactsFile: join(art, `${node}.listing.json`),
      nodeExecution: startNodeExecution({
        runId: 'fixture',
        path: node,
        node: { id: node, kind: 'exec', runtime: 'sh', script: ':' },
        invocation: newNodeInvocation(),
      }),
    });
  const diffEnv = {
    ...process.env,
    ...nodeEnv('diff-m2-r2'),
    PYTHONDONTWRITEBYTECODE: '1',
    SA_CONTEXT_TEST_ENV: 'before',
  };
  const reviewEnv = {
    ...process.env,
    ...nodeEnv('attempt-review-m2-r2'),
    SA_CONTEXT_TEST_ENV: 'before',
  };
  const fingerprint = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `import { projectEnvironment, environmentIdentity } from ${JSON.stringify(join(gen, '.archon/scripts/sa-check.ts'))}; console.log(JSON.stringify({context: environmentIdentity(projectEnvironment(process.env)), cache: environmentIdentity(projectEnvironment(process.env))}));`,
    ],
    { cwd: repo, env: diffEnv, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(fingerprint.exitCode).toBe(0);
  const identities = JSON.parse(fingerprint.stdout.toString());
  const reviewFingerprint = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `import { environmentIdentity, projectEnvironment } from ${JSON.stringify(join(gen, '.archon/scripts/sa-check.ts'))}; console.log(environmentIdentity(projectEnvironment(process.env)));`,
    ],
    { cwd: repo, env: reviewEnv, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(reviewFingerprint.exitCode).toBe(0);
  expect(reviewFingerprint.stdout.toString().trim()).toBe(identities.cache);
  const input = {
    gen,
    artifacts: art,
    node: 'review-m2-r2',
    cwd: repo,
    base: head,
    head,
    patch: '/full.patch',
    delta: '/delta.patch',
    environment: identities.context,
  };
  const path = prepareContext(input),
    bytes = readFileSync(path, 'utf8'),
    context = JSON.parse(bytes);
  // 评审基线是前序里程碑的 land head：只带本里程碑的任务，不重放已落地的前序任务。
  const reviewed = plan.packages.filter(p => p.milestone === 'm2');
  expect(reviewed.map(p => p.id)).toEqual(['api']);
  expect(context.tasks.map((p: { goal: string }) => p.goal)).toEqual(reviewed.map(p => p.goal));
  expect(context.tasks.map((p: { accept: unknown }) => p.accept)).toEqual(
    reviewed.map(p => p.accept)
  );
  expect(context.carry_over).toEqual({ blocking: ledger.blocking, debt: ledger.debt });
  expect(context.tasks[0].requirements).toEqual(reviewed[0].requirements);
  expect(context.diff).toBe('/delta.patch');
  expect(bytes).not.toContain('old-99');
  expect(prepareContext(input)).toBe(path);
  const changed = prepareContext({ ...input, environment: 'drifted-env-hmac' });
  expect(changed).not.toBe(path);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  const missing = JSON.parse(
    readFileSync(prepareContext({ ...input, node: 'review-m2-r3' }), 'utf8')
  );
  expect(missing.carry_over).toBe('unknown');
  const pointer = join(art, 'review-m2-r2.context.json');
  writeFileSync(pointer, JSON.stringify({ path }));
  const startReview = (extra: Record<string, string> = {}) =>
    Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        'run',
        join(gen, '.archon/scripts/sa-context.ts'),
        join(gen, 'attempt'),
        gen,
        '',
        'review-m2-r2',
      ],
      {
        cwd: repo,
        env: { ...reviewEnv, ...extra },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  // Typed native inputs and the positional interface used by old frozen workflows agree.
  expect(startReview().exitCode).toBe(0);
  expect(
    startReview({
      INPUTS_COUNTER: join(gen, 'attempt'),
      INPUTS_GEN: gen,
      INPUTS_PKG: '',
      INPUTS_REVIEW: 'review-m2-r2',
    }).exitCode
  ).toBe(0);
  writeFileSync(
    pointer.replace('r2.context', 'r3.context'),
    JSON.stringify({ path: prepareContext({ ...input, node: 'review-m2-r3' }) })
  );
  const missingCarryPrepared = startReview({
    INPUTS_COUNTER: join(gen, 'attempt'),
    INPUTS_GEN: gen,
    INPUTS_REVIEW: 'review-m2-r3',
  });
  expect(missingCarryPrepared.stderr.toString()).toContain('missing carry-over');
  writeFileSync(pointer, JSON.stringify({ path }));
  expect(startReview({ INPUTS_ROUND: '2' }).exitCode).toBe(0);
  const drifted = startReview({ SA_CONTEXT_TEST_ENV: 'after' });
  expect(drifted.exitCode, drifted.stderr.toString()).toBe(0);
  const refreshed = JSON.parse(
    readFileSync(JSON.parse(readFileSync(pointer, 'utf8')).path, 'utf8')
  );
  expect(refreshed.environment).not.toBe(context.environment);
  expect(refreshed.refs).toEqual(context.refs);
  expect(refreshed.carry_over).toEqual(context.carry_over);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm new', repo);
  const stale = startReview();
  expect(stale.exitCode).not.toBe(0);
  expect(stale.stderr.toString()).toContain('stale review refs');
  const completedGate = join(art, 'gate-m2-r2.json');
  const resumeCompletedGate = (verdict: 'fix' | 'pass') => {
    writeFileSync(completedGate, JSON.stringify({ verdict, reviewed_head: context.refs.head }));
    return startReview({
      INPUTS_COUNTER: join(gen, 'attempt'),
      INPUTS_GEN: gen,
      INPUTS_REVIEW: 'review-m2-r2',
      INPUTS_GATE: 'gate-m2-r2',
    });
  };
  const fixed = resumeCompletedGate('fix');
  expect(fixed.exitCode, fixed.stderr.toString()).toBe(0);
  expect(fixed.stdout.toString().trim()).toBe('{"attempt":"0"}');
  const passed = resumeCompletedGate('pass');
  expect(passed.exitCode).not.toBe(0);
  expect(passed.stderr.toString()).toContain('stale review refs');
  // Reproducible read-volume comparison on the same fixture, including complete requirements.
  const before =
    Buffer.byteLength(JSON.stringify(ledger)) +
    plan.packages.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0);
  expect(Buffer.byteLength(bytes)).toBeLessThan(before);
  console.info(
    JSON.stringify({
      fixture: 'plan-two-pkgs R2',
      before_context_bytes: before,
      after_context_bytes: Buffer.byteLength(bytes),
      before_required_reads: plan.packages.length + 3,
      after_required_reads: 4,
      event_fetches: 'see generated CLI acceptance assertion',
      model_calls: 0,
      provider_elapsed_ms: 'unknown',
    })
  );
});

test('canonical owner resolves refs once from events and refuses missing producers', async () => {
  const art = tmp(),
    output = { head: 'immutable-ref' };
  const run = {
    id: 'r',
    user_message: '',
    metadata: {},
    events: [
      {
        step_name: 'start',
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(output), structured_output: output },
      },
    ],
  };
  const contracts = [
    { tag: 'verify-core', base: '$start.output.head' },
    { tag: 'diff-m1-r1', base: '$start.output.head' },
  ];
  const resolved = await resolveAcceptanceContext(run, contracts, art);
  expect(resolved.inputs.map(i => i.base)).toEqual(['immutable-ref', 'immutable-ref']);
  expect(JSON.parse(readFileSync(resolved.events_file, 'utf8'))).toEqual({
    id: 'r',
    events: run.events,
  });
  await expect(resolveAcceptanceContext({ ...run, events: [] }, contracts, art)).rejects.toThrow();
  await expect(
    resolveAcceptanceContext({ ...run, events: undefined }, contracts, art)
  ).rejects.toThrow('missing authoritative');
});

test('native Archon scripts share context identity without shell startup or .env interpretation', () => {
  const root = tmp(),
    repo = gitRepo(tmp()),
    gen = join(root, 'source');
  const scripts = join(gen, '.archon/scripts'),
    workflows = join(gen, '.archon/workflows/native-context');
  mkdirSync(workflows, { recursive: true });
  cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
  cpSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(scripts, 'policy-attempts.ts')
  );
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(plan, loadTiers())));
  writeFileSync(join(repo, '.env'), 'SA_CONTEXT_TEST_ENV=dotenv\n');
  const startup = join(root, 'startup.sh');
  writeFileSync(startup, 'export SA_CONTEXT_TEST_ENV=shell\n');
  writeFileSync(
    join(workflows, 'native-context.yaml'),
    Bun.YAML.stringify({
      name: 'native-context',
      description: 'Controlled native producer/consumer environment',
      nodes: [
        {
          id: 'diff',
          runtime: 'bun',
          script: `
import { prepareContext } from ${JSON.stringify(join(scripts, 'sa-context.ts'))};
import { environmentIdentity, projectEnvironment } from ${JSON.stringify(join(scripts, 'sa-check.ts'))};
import { writeFileSync } from 'node:fs';
const env = process.env;
if (env.SA_CONTEXT_TEST_ENV !== undefined || env.SHLVL !== '1' || env._ !== 'parent-marker' || env.PWD !== 'controlled-pwd')
  throw new Error('native launch reinterpreted controlled environment');
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {stdout: 'pipe'});
if (git.exitCode !== 0) throw new Error('fixture HEAD unavailable');
const head = git.stdout.toString().trim();
const path = prepareContext({gen: ${JSON.stringify(gen)}, artifacts: env.ARTIFACTS_DIR!, node: 'review-m1-r1',
  cwd: process.cwd(), base: head, head, environment: environmentIdentity(projectEnvironment(env))});
writeFileSync(env.ARTIFACTS_DIR + '/review-m1-r1.context.json', JSON.stringify({path}));
console.log(JSON.stringify({prepared: true}));`,
        },
        {
          id: 'attempt-review',
          script: 'sa-context',
          runtime: 'bun',
          depends_on: ['diff'],
          with: { counter: join(gen, 'missing-counter'), gen, pkg: '', review: 'review-m1-r1' },
        },
      ],
    })
  );
  sh(
    'git init -q && git add .archon plan.json execution.json && git -c user.name=t -c user.email=t@l commit -qm fixture',
    gen
  );
  const env = {
    ...fixtureEnv(),
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home/archon'),
    SA_CONTEXT_TEST_ENV: 'before',
    BASH_ENV: startup,
    SHLVL: '1',
    _: 'parent-marker',
    PWD: 'controlled-pwd',
  };
  const archon = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, '--no-env-file', join(WETAMP, 'src/coord/archon-entry.ts'), ...args],
      {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      }
    );
    expect(result.exitCode).toBe(0);
    return lastJson(result.stdout.toString());
  };
  const ack = archon(
    'workflow',
    'run',
    'native-context',
    '--workflow-source',
    gen,
    '--cwd',
    repo,
    '--no-worktree',
    '--detach',
    '--json'
  );
  const id = String(ack?.runId);
  const waited = archon('workflow', 'wait', id, '--timeout', '20', '--json');
  const view = archon('workflow', 'get', id, '--verbose', '--json');
  expect(waited).toMatchObject({ attention: { status: 'completed' } });
  expect(view).toMatchObject({
    status: 'completed',
    nodes: [
      { nodeId: 'diff', state: 'completed' },
      { nodeId: 'attempt-review', state: 'completed' },
    ],
  });
}, 40_000);

test('codegraph uses the main checkout index and exposes stale worktree base', () => {
  const gen = tmp(),
    repo = gitRepo(tmp()),
    worker = join(tmp(), 'worker');
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(plan, loadTiers())));
  sh(`git worktree add -qb sa/index '${worker}'`, repo);
  const base = sh('git rev-parse HEAD', worker).trim();
  const input = {
    gen,
    artifacts: gen,
    node: 'code-core',
    cwd: worker,
    base,
    head: base,
    environment: 'unknown',
  };
  expect(roleContext(input).codegraph.status).toBe('unavailable');
  mkdirSync(join(repo, '.codegraph'));
  expect(roleContext(input).codegraph).toEqual({
    projectPath: repo,
    index_sha: base,
    base_sha: base,
    status: 'available',
  });
  sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm advance', repo);
  const context = roleContext(input);
  expect(context.codegraph.index_sha).toBe(sh('git rev-parse HEAD', repo).trim());
  expect(context.codegraph.index_sha).not.toBe(context.codegraph.base_sha);
  expect(context.cwd).toBe(worker);
  expect(existsSync(join(worker, '.codegraph'))).toBe(false);
});

test('U5: pack node-contract environment conforms to the engine owner', () => {
  expect([...NODE_CONTRACT_ENV].sort()).toEqual([...EXEC_NODE_ENVIRONMENT_NAMES].sort());
});
