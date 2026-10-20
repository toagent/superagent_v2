import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadTiers, snapshotPolicy } from '../src/config';
import {
  budgetUsage,
  reviewRoundLimit,
  decide as rawDecide,
  disposition as rawDisposition,
  nextDisposition,
  permissionEvidence,
  identityOf,
  attemptIdentity,
  independence,
  readAuthorEvidence,
  ledgerOf,
  scopeRisk,
  deliveryDecision as rawDeliveryDecision,
  readAttempt,
  CHECK_AUX_TIMEOUT_MS,
  projectEnvironment,
  type Accept,
} from '../templates/.archon/scripts/sa-check';
const MAX_ROUNDS = reviewRoundLimit(snapshotPolicy(loadTiers()));
type DecisionInput = Parameters<typeof rawDeliveryDecision>[0];
const withRounds = (input: Omit<DecisionInput, 'reviewRounds'> & { reviewRounds?: number }) => ({
  ...input,
  reviewRounds: input.reviewRounds ?? MAX_ROUNDS,
});
const deliveryDecision = (input: Omit<DecisionInput, 'reviewRounds'> & { reviewRounds?: number }) =>
  rawDeliveryDecision(withRounds(input));
const decide = (input: Omit<DecisionInput, 'reviewRounds'> & { reviewRounds?: number }) =>
  rawDecide(withRounds(input));
const disposition = (...args: Parameters<typeof rawDisposition>) =>
  rawDisposition(args[0], args[1], args[2], args[3], args[4], args[5] ?? MAX_ROUNDS);
import {
  acceptanceNodeEnvironment,
  directAuxiliaryPreload,
  fixturePlan,
  gitRepo,
  sh,
  tmp,
} from './helpers';
import { FAILURE_CLASSES } from '../templates/.archon/scripts/failure-class';
import outputSchema from '../schemas/output.schema.json';
import acceptOutputSchema from '../schemas/nodes/accept.schema.json';
import deliveryOutputSchema from '../schemas/nodes/delivery.schema.json';
import { checkoutFingerprint } from '../templates/.archon/scripts/checkout-integrity';
import { envPrecheck } from '../templates/.archon/scripts/env-precheck';
import {
  readPolicyAttempts,
  writePolicyAttempts,
} from '../templates/.archon/scripts/policy-attempts';
import { executePolicy } from '@archon/workflows/policy-dispatch';
import Ajv2020 from '../../packages/workflows/node_modules/ajv/dist/2020';

test.each(['relative', 'absolute'])(
  'ENV_PRECHECK tracked hooks resolve %s paths and only require declared hooks',
  mode => {
    const repo = gitRepo(tmp()),
      hooks = join(repo, '.hooks'),
      hook = join(hooks, 'pre-commit');
    mkdirSync(hooks);
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(hooks, 'README.md'), 'hook documentation');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.4.3', scripts: { prepare: 'setup-hooks' } })
    );
    sh('git add .hooks', repo);
    sh(`git config core.hooksPath '${mode === 'relative' ? '.hooks' : hooks}'`, repo);
    expect(envPrecheck(repo)).toMatchObject({ ok: true });
    chmodSync(hook, 0o644);
    expect(envPrecheck(repo).failures[0]).toMatchObject({
      failure_class: 'test_env',
      recovery: ['bun run prepare'],
    });
    unlinkSync(hook);
    expect(envPrecheck(repo)).toMatchObject({ ok: false });
  }
);

test('ENV_PRECHECK missing dependencies block; installed consistency stays unknown with no writes', () => {
  const repo = gitRepo(tmp());
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ dependencies: { example: '1' }, packageManager: 'bun@1.4.3' })
  );
  writeFileSync(join(repo, 'bun.lock'), 'declared lock');
  const before = sh('git status --porcelain', repo);
  expect(envPrecheck(repo)).toMatchObject({
    ok: false,
    dependencies: 'unknown',
    failures: [
      {
        failure_class: 'test_env',
        recovery: ['bun install --frozen-lockfile'],
      },
    ],
  });
  expect(existsSync(join(repo, 'node_modules'))).toBe(false);
  expect(sh('git status --porcelain', repo)).toBe(before);
  expect(readFileSync(join(repo, 'bun.lock'), 'utf8')).toBe('declared lock');
  mkdirSync(join(repo, 'node_modules'));
  expect(envPrecheck(repo)).toMatchObject({ ok: true, dependencies: 'unknown' });
});

test('ENV_PRECHECK unset hooks and empty dependency repo pass; missing declared tools block', () => {
  const repo = gitRepo(tmp());
  sh("git config core.hooksPath ''", repo);
  expect(envPrecheck(repo)).toMatchObject({
    ok: true,
    dependencies: 'not_required',
    hooks: 'not_configured',
  });
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'bun.lock'), 'empty');
  expect(envPrecheck(repo)).toMatchObject({ ok: true, dependencies: 'not_required' });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ packageManager: 'sa-nonexistent-tool@1' })
  );
  expect(envPrecheck(repo).failures[0]?.evidence).toBe(
    'missing declared tool: sa-nonexistent-tool'
  );
});

test('ENV_PRECHECK environment emits typed evidence and skips commands until checkout ready', () => {
  const root = tmp(),
    repo = gitRepo(root),
    marker = join(root, 'executed');
  writeFileSync(join(repo, 'package.json'), '{"dependencies":{"example":"1"}}');
  writeFileSync(join(repo, 'bun.lock'), 'declared');
  const p = planFile(root, 'true', [`touch '${marker}'`]);
  const r = runScript(repo, { kind: 'env', plan: p });
  expect(r.code, r.err).toBe(1);
  expect(r.out).toMatchObject({
    ok: false,
    failed: ['env-precheck'],
    failures: [{ failure_class: 'test_env' }],
  });
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(join(r.art, 'environment.log'), 'utf8')).toContain(
    'bun install --frozen-lockfile'
  );
  mkdirSync(join(repo, 'node_modules'));
  const ready = runScript(repo, { kind: 'env', plan: p });
  expect(ready.code, ready.err).toBe(0);
  expect(ready.out).toMatchObject({ ok: true, precheck: { dependencies: 'unknown' } });
  expect(existsSync(marker)).toBe(true);
});

test('ENV_PRECHECK environment retains command typed failure classification', () => {
  const root = tmp(),
    repo = gitRepo(root);
  const r = runScript(repo, {
    kind: 'env',
    plan: planFile(root, 'true', [
      `printf '%s' '{"failure_class":"test_env","evidence":"missing fixture resource"}'; exit 1`,
    ]),
  });
  expect(r.code, r.err).toBe(1);
  expect(r.out).toMatchObject({ failures: [{ failure_class: 'test_env' }] });
});

test.each([
  ['owned', 0],
  ['owned', 9],
  ['unowned', 0],
  ['wrong-path', 0],
  ['wrong-run', 0],
  ['main', 0],
] as const)(
  'RUN_PROVISION %s recovery exit %s respects run ownership and records artifacts',
  (mode, status) => {
    const root = tmp(),
      repo = gitRepo(root),
      worktree = join(root, 'run-worktree');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.4.3',
        dependencies: { example: '1' },
        scripts: { prepare: 'setup-hooks' },
      })
    );
    writeFileSync(join(repo, 'bun.lock'), 'declared');
    mkdirSync(join(repo, '.hooks'));
    writeFileSync(join(repo, '.hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    sh('git add . && git -c user.name=t -c user.email=t@l commit -qm fixture', repo);
    sh(`git worktree add -b sa/provision '${worktree}'`, repo);
    sh('git config core.hooksPath .hooks/_', repo);
    const cwd = mode === 'main' ? repo : worktree,
      bin = join(root, 'bin'),
      marker = join(root, 'recovery');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      `#!/bin/sh
case "$*" in
  'install --frozen-lockfile'|'run prepare')
    echo "$*" >> '${marker}'
    echo recovery-output
    ${status ? `exit ${status}` : `if [ "$1" = install ]; then mkdir node_modules; else mkdir .hooks/_; cp .hooks/pre-commit .hooks/_/pre-commit; fi`}
    ;;
  *) exec '${process.execPath}' "$@" ;;
esac
`,
      { mode: 0o755 }
    );
    const events = join(root, 'events.json');
    writeFileSync(
      events,
      JSON.stringify({
        id: mode === 'wrong-run' ? 'other-run' : 'current-run',
        events: [],
        working_path: mode === 'wrong-path' ? repo : cwd,
        metadata:
          mode === 'unowned' ? {} : { owned_worktree: { envId: 'env', creationId: 'creation' } },
      })
    );
    const path = planFile(root, 'true');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), repo }));
    const r = runScript(cwd, { kind: 'env', plan: path, events_file: events }, SCRIPT, {
      WORKFLOW_ID: 'current-run',
      PATH: `${bin}:${process.env.PATH}`,
    });
    const artifact = JSON.parse(readFileSync(join(r.art, 'environment.json'), 'utf8'));
    expect(r.out).toEqual(artifact);
    expect(r.code, r.err).toBe(mode === 'owned' && status === 0 ? 0 : 1);
    expect(artifact.precheck.ok).toBe(mode === 'owned' && status === 0);
    expect(existsSync(marker)).toBe(mode === 'owned');
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);
    expect(existsSync(join(repo, '.hooks/_'))).toBe(false);
    if (mode === 'owned') {
      expect(artifact.provisioned[0]).toMatchObject({
        cmd: 'bun install --frozen-lockfile',
        exit: status,
        output: 'recovery-output\n',
      });
      expect(artifact.provisioned[0].ms).toBeGreaterThanOrEqual(0);
      expect(artifact.provisioned.map((p: { cmd: string }) => p.cmd)).toEqual(
        status
          ? ['bun install --frozen-lockfile']
          : ['bun install --frozen-lockfile', 'bun run prepare']
      );
      if (status) expect(JSON.stringify(artifact.precheck.failures)).toContain('exit=9');
    } else {
      expect(artifact.provisioned).toEqual([]);
      expect(artifact.notes.join(' ')).toContain('Recovery skipped');
    }
  }
);

test('R1-1 author reservation persists tracking before provider execution and survives adoption', async () => {
  const root = tmp(),
    art = join(root, 'artifacts/runs/prior');
  mkdirSync(art, { recursive: true });
  const read = () =>
    readAuthorEvidence(
      { id: 'current', codebase_id: 'repo', adopted_from_run_id: 'prior', events: [] },
      [],
      ['core'],
      'm1',
      MAX_ROUNDS,
      () => ({
        id: 'prior',
        codebase_id: 'repo',
        output_root: root,
        events: [{ event_type: 'node_started', step_name: 'code-core' }],
      })
    );
  const stream = executePolicy(
    {
      node: 'code-core',
      artifacts: art,
      candidates: [{ provider: 'codex', model: 'author' }],
      provider: 'codex',
      budget: { weighted_tokens: 1000 },
      usage: () => ({ launches: 0, weighted_tokens: 0, reserve: 0 }),
      options: candidate => ({ model: candidate.model }),
      async *sendQuery(_prompt, _cwd, _resume, options) {
        // No provider callback has run: the dispatch reservation must already be durable.
        expect(readPolicyAttempts(art)[0]).toMatchObject({
          status: 'started',
          rerouted_models: [],
        });
        expect(read()).toEqual([{ model: 'author', strength: 'pinned' }]);
        expect(independence(read(), { model: 'other', strength: 'provider' })).toBeNull();
        expect(independence(read(), { model: 'author', strength: 'provider' })).toBe('same_model');
        options?.onModelRerouted?.('rerouted');
        expect(independence(read(), { model: 'rerouted', strength: 'provider' })).toBe(
          'same_model'
        );
        yield { type: 'warning', code: 'fixture.interrupted', message: 'interrupted' };
      },
    },
    'fixture',
    '/scratch'
  );
  try {
    await stream.next();
    expect(readPolicyAttempts(art)[0]?.status).toBe('started');
  } finally {
    await stream.return(undefined);
  }
});

test('author carry reads each adopted generation and refuses unknown or invalid ancestry', () => {
  type Run = Parameters<typeof readAuthorEvidence>[0];
  const root = tmp(),
    oldRoot = tmp(),
    art = join(oldRoot, 'artifacts/runs/old');
  const event = (model: string) => ({
    event_type: 'node_completed',
    step_name: 'repair-core',
    data: {
      binding: {
        model: { requested: model, resolved: { source: 'unavailable', reason: 'unsupported' } },
      },
    },
  });
  const runs: Record<string, Run> = {
    current: { id: 'current', codebase_id: 'repo', adopted_from_run_id: 'middle', events: [] },
    middle: {
      id: 'middle',
      codebase_id: 'repo',
      output_root: root,
      adopted_from_run_id: 'old',
      events: [event('repair')],
    },
    old: {
      id: 'old',
      codebase_id: 'repo',
      output_root: oldRoot,
      events: [{ event_type: 'node_started', step_name: 'code-core' }],
    },
  };
  mkdirSync(art, { recursive: true });
  const attempt = {
    rerouted_models: [] as string[],
    id: 'original',
    node: 'code-core',
    provider: 'codex' as const,
    model: 'author',
    status: 'started' as const,
  };
  writePolicyAttempts(art, [attempt]);
  const read = () =>
    readAuthorEvidence(runs.current!, [], ['core'], 'm1', MAX_ROUNDS, id => runs[id]!);
  expect(read()).toEqual([
    { model: 'repair', strength: 'pinned' },
    { model: 'author', strength: 'pinned' },
  ]);
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBeNull();
  expect(independence(read(), { model: 'author', strength: 'pinned' })).toBe('same_model');
  writePolicyAttempts(art, [{ ...attempt, rerouted_models: ['rerouted'] }]);
  expect(read().map(a => a.model)).toEqual(['repair', 'author', 'rerouted']);
  expect(independence(read(), { model: 'rerouted', strength: 'pinned' })).toBe('same_model');
  const cumulative = readAuthorEvidence(
    runs.current!,
    [{ ...attempt, node: 'fix-m0-r2', model: 'fix-author' }],
    ['core'],
    ['m0', 'm1'],
    MAX_ROUNDS,
    id => runs[id]!
  );
  expect(independence(cumulative, { model: 'fix-author', strength: 'pinned' })).toBe('same_model');
  expect(
    independence(
      readAuthorEvidence(runs.current!, [], ['core', 'missing'], 'm1', MAX_ROUNDS, id => runs[id]!),
      { model: 'reviewer', strength: 'pinned' }
    )
  ).toBe('author_unknown');
  writePolicyAttempts(art, [{ ...attempt, status: 'failed' }]);
  expect(independence(read(), { model: 'author', strength: 'pinned' })).toBe('same_model');
  expect(attemptIdentity([attempt], attempt.node).strength).toBe('unknown');
  writePolicyAttempts(art, [{ ...attempt, rerouted_models: undefined }]);
  // old executors could execute and reroute without ever writing this marker.
  expect(read()).toEqual([
    { model: 'repair', strength: 'pinned' },
    { model: null, strength: 'unknown' },
  ]);
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBe('author_unknown');
  expect(independence(read(), { model: 'author', strength: 'pinned' })).toBe('author_unknown');
  expect(attemptIdentity([{ ...attempt, rerouted_models: undefined }], attempt.node).strength).toBe(
    'unknown'
  );
  writePolicyAttempts(art, [{ ...attempt, status: 'failed', rerouted_models: undefined }]);
  expect(independence(read(), { model: 'author', strength: 'pinned' })).toBe('author_unknown');
  writePolicyAttempts(art, [{ ...attempt, provider: 'claude' }]);
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBe('author_unknown');
  writePolicyAttempts(art, [attempt]);
  const old = runs.old!;
  for (const broken of [
    undefined,
    { ...old, codebase_id: 'other' },
    { ...old, adopted_from_run_id: 'middle' },
    { ...old, output_root: null },
  ]) {
    if (broken) runs.old = broken;
    else delete runs.old;
    expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBe('author_unknown');
  }
  runs.old = old;
  writePolicyAttempts(art, []);
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBe('author_unknown');
  runs.old = { ...old, events: [event('unknown')] };
  runs.old.events[0]!.data!.binding = undefined;
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBe('author_unknown');
  expect(
    readAuthorEvidence({ ...old, events: [event('local')] }, [], ['core'], 'm1', MAX_ROUNDS, () => {
      throw new Error('unexpected ancestry');
    })
  ).toEqual([{ model: 'local', strength: 'pinned' }]);
});

test('author evidence uses the frozen review ladder for late fix rounds', () => {
  const run = { id: 'current', codebase_id: 'repo', events: [] };
  const attempt = {
    id: 'late-fix',
    node: 'fix-m1-r5',
    provider: 'codex' as const,
    model: 'late-author',
    status: 'started' as const,
    rerouted_models: [] as string[],
  };
  expect(readAuthorEvidence(run, [attempt], [], 'm1', 6, () => run)).toEqual([
    { model: 'late-author', strength: 'pinned' },
  ]);
});

test('P3 missing provider and node receipts reserve spend instead of counting zero', () => {
  expect(budgetUsage([{ event_type: 'node_started', step_name: 'code-core' }], 20)).toMatchObject({
    launches: 1,
    weighted_tokens: 20,
  });
  expect(
    budgetUsage([], 20, [
      { id: 'lost', node: 'code-core', provider: 'codex', model: 'fixture', status: 'started' },
    ])
  ).toMatchObject({ launches: 1, weighted_tokens: 20 });
  expect(
    budgetUsage(
      [
        { event_type: 'node_started', step_name: 'code-core' },
        { event_type: 'node_completed', step_name: 'code-core' },
        { event_type: 'node_completed', step_name: 'code-core' },
        { event_type: 'node_started', step_name: 'code-api' },
      ],
      20
    )
  ).toMatchObject({ launches: 2, weighted_tokens: 60 });
});

test('P3 budget display reports receipts while admission reserves missing spend', () => {
  const attempts: Parameters<typeof budgetUsage>[2] = [
    { id: 'lost', node: 'code-api', provider: 'codex', model: 'fixture', status: 'started' },
    {
      id: 'done',
      node: 'code-core',
      provider: 'codex',
      model: 'fixture',
      status: 'completed',
      tokens: { input: 10, cacheRead: 4, output: 2 },
    },
  ];
  expect(budgetUsage([], 20, attempts, 'reported')).toMatchObject({
    launches: 2,
    weighted_tokens: 8,
  });
  expect(budgetUsage([], 20, attempts)).toMatchObject({ launches: 2, weighted_tokens: 16 });
});

const PRODUCT_FAILURE = `printf '%s' '{"failure_class":"product","evidence":"product regression"}'; exit 1`;
const SCRIPT = join(import.meta.dir, '..', 'templates', '.archon', 'scripts', 'sa-check.ts');
type Rv = NonNullable<NonNullable<Parameters<typeof decide>[0]['reviews']>[number]>;
type F = Rv['findings'][number];
const f = (severity: F['severity'], extra: Partial<F> = {}): F => ({
  id: `x-${severity}`,
  severity,
  file: 'a.ts',
  line: 1,
  status: 'open',
  evidence: '/tmp/product.log',
  failure_class: 'product',
  carry_over: false,
  ...extra,
});
/** 第 2 轮及以后用原 id 关闭并附证据：gate 唯一承认的关闭方式。 */
const fixed = (id: string, severity: F['severity'] = 'high'): F =>
  f(severity, { id, status: 'closed', carry_over: true, evidence: 'diff L3 removes it' });
const review = (status: Rv['status'], findings: F[] = [], debt: string[] = []): Rv => ({
  status,
  findings,
  debt,
});

const R = review;
const C = (
  diff_hash: string,
  ok = true,
  same = false
): { ok: boolean; diff_hash: string; same: boolean } => ({
  ok,
  diff_hash,
  same,
});
const ids = (reviews: (Rv | null)[], risk = 'G1'): string[] =>
  ledgerOf(reviews, risk)
    .blocking.map(e => e.id)
    .sort();

describe('NONCONVERGENCE delivery gate', () => {
  test('three rotating structured failure sets stop as environment unless one product finding persists', () => {
    const checks = ['A', 'B', 'C'].map(id => ({
      ...C(id, false),
      head: 'same-head',
      contract_hash: 'same-contract',
      failed: ['bun test'],
      failures: [
        {
          command: 'bun test',
          failure_class: 'product' as const,
          evidence: `/tmp/${id}.log`,
          failed_tests: [id],
        },
      ],
    }));
    expect(
      deliveryDecision({ reviews: [null, null, null], rechecks: checks, reviewRounds: MAX_ROUNDS })
    ).toMatchObject({
      decision: {
        kind: 'block',
        reason: 'environment',
        evidence: expect.arrayContaining([expect.stringContaining('rotated')]),
      },
    });
    const persistent = R('FAIL', [
      f('high', { id: 'persistent', failure_class: 'product', evidence: '/tmp/product.log' }),
    ]);
    expect(
      deliveryDecision({
        reviews: [persistent, persistent, persistent],
        rechecks: checks,
        reviewRounds: MAX_ROUNDS,
      }).decision.reason
    ).toBe('acceptance_failed');
  });
  test('G1 done + error_class advances in one round without review', () => {
    const root = tmp(),
      repo = gitRepo(root),
      plan = planFile(root, 'true');
    const accepted = runScript(repo, {
      kind: 'accept',
      plan,
      pkgs: 'a',
      risk: 'G1',
      tag: 'diff-m1-r1',
      coder: '{"status":"done","error_class":"task","needs":[],"blockers":[]}',
    });
    expect(accepted.out).toMatchObject({
      ok: true,
      disposition: 'advance',
      error_class_ignored: true,
    });
    expect(
      runScript(repo, {
        kind: 'gate',
        plan,
        pkgs: 'a',
        risk: 'G1',
        review: '0',
        round: '1',
        milestone: 'm1',
        tag: 'gate-m1-r1',
        r1: 'null',
        c1: JSON.stringify(accepted.out),
      })
    ).toMatchObject({
      code: 0,
      out: { verdict: 'pass', reason: 'review_not_required', rounds: 1 },
    });
  });
  test.each([
    ['ok', false],
    ['risk', 'G1'],
  ] as const)('gate rejects acceptance artifact with tampered %s', (field, value) => {
    const root = tmp(),
      repo = gitRepo(root),
      plan = planFile(root, 'true');
    const accepted = runScript(repo, {
      kind: 'accept',
      plan,
      pkgs: 'a',
      risk: 'G2',
      tag: 'diff-m1-r1',
      coder: '{"status":"done","error_class":null}',
    });
    const check = accepted.out as {
      head: string;
      diff_hash: string;
      artifact_sha256: string;
    };
    const path = join(accepted.art, 'diff-m1-r1.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...artifact, [field]: value }));
    expect(
      runScript(repo, {
        kind: 'gate',
        plan,
        pkgs: 'a',
        risk: 'G2',
        review: '0',
        round: '1',
        milestone: 'm1',
        tag: 'gate-m1-r1',
        r1: 'null',
        c1: path,
        c1_head: check.head,
        c1_diff_hash: check.diff_hash,
        c1_sha256: check.artifact_sha256,
      })
    ).toMatchObject({
      code: 1,
      out: {
        verdict: 'escalate',
        reason: 'acceptance_evidence_mismatch',
        decision: { kind: 'block' },
        head_trusted: false,
      },
    });
  });
  test('gate accepts an artifact matching the captured full-file sha256', () => {
    const root = tmp(),
      repo = gitRepo(root),
      plan = planFile(root, 'true');
    const accepted = runScript(repo, {
      kind: 'accept',
      plan,
      pkgs: 'a',
      risk: 'G1',
      tag: 'diff-m1-r1',
      coder: '{"status":"done","error_class":null}',
    });
    const check = accepted.out as {
      head: string;
      diff_hash: string;
      artifact_sha256: string;
    };
    expect(
      runScript(repo, {
        kind: 'gate',
        plan,
        pkgs: 'a',
        risk: 'G1',
        review: '0',
        round: '1',
        milestone: 'm1',
        tag: 'gate-m1-r1',
        r1: 'null',
        c1: join(accepted.art, 'diff-m1-r1.json'),
        c1_head: check.head,
        c1_diff_hash: check.diff_hash,
        c1_sha256: check.artifact_sha256,
      })
    ).toMatchObject({ code: 0, out: { verdict: 'pass', reason: 'review_not_required' } });
  });
  test.each(['G1', 'G2'])('%s low unknown self-report finding remains debt', risk => {
    for (const status of ['PASS', 'FAIL'] as const) {
      const result = decide({
        risk,
        reviewRequired: true,
        reviews: [
          R(status, [
            f('low', { failure_class: 'unknown', evidence: 'done + error_class diagnostic' }),
            f('low', { id: 'naming', evidence: 'naming debt' }),
          ]),
        ],
        rechecks: [C('a')],
      });
      expect(result).toMatchObject({
        verdict: 'pass',
        decision: { kind: 'debt' },
        ledger: { blocking: [] },
      });
      expect(result.ledger.debt).toHaveLength(2);
    }
    expect(
      decide({
        risk,
        reviews: [R('PASS', [f('high', { failure_class: 'unknown' })])],
        rechecks: [C('a')],
      })
    ).toMatchObject({ verdict: 'escalate', reason: 'acceptance_failed' });
  });
  test.each([false, true])('repeated failed input stops at round two (same=%s)', same => {
    const root = tmp(),
      repo = gitRepo(root),
      plan = planFile(root, 'true');
    const check = {
      ...C('a', false),
      head: sh('git rev-parse HEAD', repo).trim(),
      failed: ['test-command'],
      failures: [{ command: 'test-command', failure_class: 'product', evidence: 'test failed' }],
    };
    const gate = (checks: unknown[]) =>
      runScript(repo, {
        kind: 'gate',
        plan,
        pkgs: 'a',
        risk: 'G1',
        review: '0',
        round: String(checks.length),
        milestone: 'm1',
        tag: `gate-m1-r${checks.length}`,
        r1: 'null',
        r2: 'null',
        c1: JSON.stringify(checks[0]),
        c2: JSON.stringify(checks[1] ?? null),
      });
    expect(gate([check])).toMatchObject({
      code: 0,
      out: { verdict: 'fix', decision: { kind: 'repair' } },
    });
    expect(gate([check, { ...check, same }])).toMatchObject({
      code: 1,
      out: {
        verdict: 'escalate',
        reason: 'no_change',
        rounds: 2,
        decision: {
          kind: 'block',
          evidence: expect.arrayContaining([expect.stringContaining('unchanged')]),
        },
      },
    });
    const changed = {
      ...check,
      failures: [{ ...check.failures[0], evidence: 'different failure' }],
    };
    expect(gate([check, changed])).toMatchObject({ code: 0, out: { verdict: 'fix' } });
  });
  test('a current PASS review lets verified requirements outrank an unchanged diff', () => {
    const command = { cmd: 'true', timeout_s: 5 };
    const check: Accept = {
      ok: true,
      same: true,
      diff_hash: 'candidate',
      head: 'head',
      contract_hash: 'contract',
      risk: 'G2',
      decision: { kind: 'advance', reason: null, evidence: [], debt: [] },
      requirement_contract: [
        {
          id: 'w5',
          accept: [command],
          requirements: [{ id: 'verified', text: 'W5 verified', verified_by: [0] }],
        },
      ],
      command_results: [{ check: command, pass: true, evidence: 'accept.log' }],
    };
    expect(
      decide({
        reviews: [R('PASS'), R('PASS')],
        rechecks: [check, check],
        risk: 'G2',
        qualifiedReview: true,
      })
    ).toMatchObject({
      verdict: 'pass',
      decision: { kind: 'advance', reason: null, requirements: { status: 'verified' } },
      ledger: { blocking: [], debt: [] },
    });
    expect(decide({ reviews: [null, null], rechecks: [check, check], risk: 'G2' })).toMatchObject({
      verdict: 'escalate',
      reason: 'no_change',
      decision: { kind: 'block', reason: 'no_change' },
    });
  });
  test('unchanged diff stops unknown diagnosis even after an empty commit', () => {
    const unknown = R('PASS', [f('high', { failure_class: 'unknown' })]);
    const result = decide({
      reviews: [unknown, null],
      rechecks: [
        { ...C('a'), head: 'before' },
        { ...C('a', true, true), head: 'empty-commit' },
      ],
      risk: 'G2',
    });
    expect(result).toMatchObject({ verdict: 'escalate', reason: 'no_change' });
    expect(nextDisposition(result.decision)).toBe('fail');
  });
});

describe('FC failure classification', () => {
  test('runtime enum and embedded output schemas derive from their owning schema', () => {
    expect([...FAILURE_CLASSES] as string[]).toEqual(outputSchema.$defs.failure_class.enum);
    expect(outputSchema.$defs.reviewer.properties.findings.items.properties.failure_class).toEqual(
      outputSchema.$defs.failure_class
    );
    expect(acceptOutputSchema.properties.failures.items.properties.failure_class).toEqual(
      outputSchema.$defs.failure_class
    );
    expect(deliveryOutputSchema.required).toEqual(['diff_hash']);
  });
  test('product and missing/invalid/no-evidence classifications remain blocking', () => {
    for (const extra of [
      { failure_class: 'product' as const },
      { failure_class: undefined },
      JSON.parse('{"failure_class":"invalid"}'),
      { failure_class: 'fixture' as const, evidence: '' },
    ]) {
      const finding = f('high', { evidence: '/tmp/accept.log', ...extra });
      const d = decide({ reviews: [R('FAIL', [finding])], rechecks: [C('a')], risk: 'G1' });
      expect(d.verdict).toBe(extra.failure_class === 'product' ? 'fix' : 'escalate');
      expect(d.ledger.debt).toEqual([]);
      expect(d.ledger.blocking).toHaveLength(1);
      expect(d.ledger.blocking[0].failure_class).toBe(
        extra.failure_class === 'product' ? 'product' : 'unknown'
      );
    }
  });
  test('reviewer non-product failures become observable debt without any repair round', () => {
    for (const failure_class of FAILURE_CLASSES.filter(c => c !== 'product' && c !== 'unknown')) {
      const d = decide({
        reviews: [R('FAIL', [f('blocker', { failure_class, evidence: '/tmp/accept.log' })])],
        rechecks: [C('a')],
        risk: 'G2',
        strict: true,
      });
      expect(d.verdict).toBe('pass');
      expect(d.ledger.blocking).toEqual([]);
      expect(d.ledger.debt[0]).toMatchObject({
        failure_class,
        repair_rounds: 0,
        evidence: '/tmp/accept.log',
      });
      expect(d.debt[0]).toContain('/tmp/accept.log');
    }
  });
  test('delivery-truth: same blocker at the review limit stays blocked in G1/strict/G2', () => {
    const r = R('FAIL', [
      f('blocker', { id: 'stable', failure_class: 'product', evidence: '/tmp/fail.log' }),
    ]);
    const input = {
      reviews: Array.from({ length: MAX_ROUNDS }, () => r),
      rechecks: Array.from({ length: MAX_ROUNDS }, (_, i) => C(String(i))),
      risk: 'G1',
    };
    expect(decide({ ...input, reviews: [r, r], rechecks: [C('a'), C('b')] }).verdict).toBe('fix');
    for (const protectedInput of [{}, { strict: true }, { risk: 'G2' }])
      expect(decide({ ...input, ...protectedInput })).toMatchObject({
        verdict: 'escalate',
        reason: 'review_failed+review_limit',
        ledger: { blocking: [{ id: 'stable', repair_rounds: MAX_ROUNDS - 1 }], debt: [] },
      });
    const newer = R('FAIL', [f('blocker', { id: 'new', evidence: '/tmp/new.log' })]);
    expect(
      decide({
        ...input,
        reviews: [...Array.from({ length: MAX_ROUNDS - 1 }, () => R('PASS')), newer],
      }).verdict
    ).toBe('escalate');
  });
  test('reviewer classifies exact failed commands; omitted classification fails closed', () => {
    const check = { ...C('a', false), failed: ['bun test'], disposition: 'repair' as const };
    const finding = f('high', {
      command: 'bun test',
      failure_class: 'fixture',
      evidence: '/tmp/test.log',
    });
    const d = decide({ reviews: [R('FAIL', [finding])], rechecks: [check], risk: 'G1' });
    expect(d.verdict).toBe('pass');
    expect(d.ledger.blocking).toEqual([]);
    expect(d.ledger.debt.some(e => e.command === 'bun test')).toBe(true);
    expect(decide({ reviews: [R('PASS')], rechecks: [check], risk: 'G1' }).verdict).toBe(
      'escalate'
    );
    expect(
      decide({
        reviews: [R('FAIL', [finding])],
        rechecks: [{ ...check, workspace_clean: false }],
        risk: 'G1',
      }).verdict
    ).toBe('fix');
  });
  test('FC-R1-01: mixed findings for one failed command preserve IDs and block in either order', () => {
    const command = 'bun test';
    const check = {
      ...C('a', false),
      failed: [command],
      disposition: 'repair' as const,
      failures: [{ command, failure_class: 'fixture' as const, evidence: '/tmp/validator.log' }],
    };
    const fixture = f('blocker', {
      id: 'fixture-id',
      command,
      failure_class: 'fixture',
      evidence: '/tmp/fixture.log',
    });
    for (const failure_class of ['product' as const, undefined]) {
      const product = f('blocker', {
        id: 'product-id',
        command,
        failure_class,
        evidence: '/tmp/product.log',
      });
      for (const findings of [
        [fixture, product],
        [product, fixture],
      ])
        for (const protection of [{ risk: 'G1', strict: true }, { risk: 'G2' }]) {
          const d = decide({ reviews: [R('FAIL', findings)], rechecks: [check], ...protection });
          expect(d.verdict).toBe(failure_class ? 'fix' : 'escalate');
          expect(d.ledger.blocking).toHaveLength(2);
          expect(d.ledger.blocking).toContainEqual(
            expect.objectContaining({
              id: 'product-id',
              command,
              failure_class: failure_class ?? 'unknown',
              evidence: '/tmp/product.log',
            })
          );
          expect(
            d.ledger.blocking.some(
              e => e.id.startsWith('check:') && e.failure_class === (failure_class ?? 'unknown')
            )
          ).toBe(true);
          expect(d.ledger.debt).toMatchObject([
            {
              id: 'fixture-id',
              command,
              failure_class: 'fixture',
              evidence: '/tmp/fixture.log',
            },
          ]);
        }
    }
  });
  test('validator product and unknown cannot be hidden by reviewer fixture classification', () => {
    for (const failure_class of ['product', 'unknown'] as const) {
      const command = 'check';
      const d = decide({
        reviews: [R('FAIL', [f('blocker', { command, failure_class: 'fixture' })])],
        rechecks: [
          {
            ...C('a', false),
            failed: [command],
            failures: [{ command, failure_class, evidence: '/tmp/validator.log' }],
          },
        ],
      });
      expect(d.verdict).toBe(failure_class === 'product' ? 'fix' : 'escalate');
      expect(d.ledger.blocking[0].failure_class).toBe(failure_class);
    }
  });
  test('FC-R1-01: distinct non-product findings keep their own classifications and close by ID', () => {
    const command = 'bun test';
    const findings = [
      f('blocker', {
        id: 'fixture-id',
        command,
        failure_class: 'fixture',
        evidence: '/tmp/fixture.log',
      }),
      f('blocker', {
        id: 'baseline-id',
        command,
        failure_class: 'baseline',
        evidence: '/tmp/baseline.log',
      }),
    ];
    const check = { ...C('a', false), failed: [command], disposition: 'repair' as const };
    const d = decide({
      reviews: [R('FAIL', findings)],
      rechecks: [check],
      risk: 'G2',
      strict: true,
    });
    expect(d.verdict).toBe('pass');
    expect(d.ledger.debt).toContainEqual(
      expect.objectContaining({ id: 'fixture-id', failure_class: 'fixture' })
    );
    expect(d.ledger.debt).toContainEqual(
      expect.objectContaining({ id: 'baseline-id', failure_class: 'baseline' })
    );
    const resolved = ledgerOf([R('FAIL', findings), R('PASS')], 'G2', {
      rechecks: [check, C('b')],
    });
    expect(resolved.debt).toEqual([]);
    expect(resolved.closed.map(e => e.id)).toEqual(
      expect.arrayContaining(['fixture-id', 'baseline-id'])
    );
  });
  test('FC-R1-02: unresolved products cannot bypass skipped-review reuse checks', () => {
    const r = R('FAIL', [
      f('high', { id: 'stable', failure_class: 'product', evidence: '/tmp/fail.log' }),
    ]);
    const prior = {
      ...C('diff'),
      head: 'candidate',
      contract_hash: 'contract',
      risk: 'G1',
      disposition: 'advance' as const,
    };
    for (const drift of [
      {},
      { head: 'changed' },
      { contract_hash: 'changed' },
      { diff_hash: 'changed' },
    ])
      for (const qualifiedReview of [true, false]) {
        const d = decide({
          reviews: [r, r, null],
          rechecks: [prior, prior, { ...prior, same: true, ...drift }],
          risk: 'G1',
          qualifiedReview,
        });
        expect(d).toMatchObject({
          verdict: 'escalate',
          reason: 'no_change',
          ledger: {
            blocking: [{ id: 'stable', repair_rounds: 2 }],
            debt: [],
          },
        });
      }
  });
  test('validator fixture JSON advances with red check evidence; coder cannot classify it', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const command = `printf '%s' '{"failure_class":"fixture","evidence":"isolated fixture mismatch"}'; exit 1`;
    const out = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, command),
      pkgs: 'a',
      tag: 'verify-fixture',
    });
    expect(out.code).toBe(0);
    expect(out.out).toMatchObject({
      ok: false,
      disposition: 'advance',
      failed: [command],
      failures: [{ command, failure_class: 'fixture' }],
    });
    const known = out.out as Parameters<typeof decide>[0]['rechecks'][number];
    expect(decide({ reviews: [R('PASS')], rechecks: [known], risk: 'G1' }).verdict).toBe('pass');
    const coder = JSON.stringify({ status: 'done', error_class: null, failure_class: 'fixture' });
    const red = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'sa_missing_tool_DEV_R1_02', ['true']),
      pkgs: 'a',
      tag: 'verify-unknown',
      base: sh('git rev-parse HEAD', repo).trim(),
      coder,
    });
    expect(red.out).toMatchObject({
      ok: false,
      disposition: 'repair',
      base_pass: null,
      decision: {
        kind: 'block',
        evidence: expect.arrayContaining([
          'diagnosis required: supply structured failure_class and evidence',
        ]),
      },
      failures: [{ failure_class: 'unknown' }],
    });
    expect(red.code).toBe(0);
  });
  test('delivery-truth: final product validation stops repairs without advancing in G1/strict/G2', () => {
    const root = tmp(),
      repo = gitRepo(root),
      art = join(root, 'artifacts');
    mkdirSync(art);
    const path = planFile(root, PRODUCT_FAILURE);
    for (const [mode, risk, expected] of [
      ['milestone', 'G1', 'fail'],
      ['strict', 'G1', 'fail'],
      ['milestone', 'G2', 'fail'],
    ]) {
      const p = JSON.parse(readFileSync(path, 'utf8'));
      p.mode = mode;
      writeFileSync(path, JSON.stringify(p));
      // Exercise the real repair history; fabricated artifacts cannot prove the dispatch bound.
      for (let round = 1; round < MAX_ROUNDS; round++) {
        const earlier = runScript(
          repo,
          {
            kind: 'accept',
            plan: path,
            pkgs: 'a',
            milestone: 'm1',
            tag: `diff-m1-r${round}`,
            risk,
          },
          SCRIPT,
          { ARTIFACTS_DIR: art }
        );
        expect(earlier.code).toBe(0);
        expect(earlier.out).toMatchObject({
          ok: false,
          disposition: 'repair',
          decision: { kind: 'repair' },
          failures: [{ failure_class: 'product' }],
        });
      }
      const result = runScript(
        repo,
        {
          kind: 'accept',
          plan: path,
          pkgs: 'a',
          milestone: 'm1',
          tag: `diff-m1-r${String(MAX_ROUNDS)}`,
          risk,
        },
        SCRIPT,
        { ARTIFACTS_DIR: art }
      );
      expect(result.out).toMatchObject({ ok: false, disposition: expected });
      expect(result.code).toBe(1);
      expect(result.out).toMatchObject({
        reason: 'acceptance_failed+review_limit',
        decision: { kind: 'block' },
        failures: [{ failure_class: 'product' }],
      });
      const check = result.out as Parameters<typeof decide>[0]['rechecks'][number];
      expect(
        decide({
          reviews: Array.from({ length: MAX_ROUNDS }, () => R('PASS')),
          rechecks: Array.from({ length: MAX_ROUNDS }, () => check),
        })
      ).toMatchObject({ verdict: 'escalate', reason: 'acceptance_failed+review_limit' });
    }
  }, 30_000);
});

test('HF10 attempt counters default only missing files to zero and reject invalid contents', () => {
  const path = join(tmp(), 'attempt');
  expect(readAttempt(path)).toBe(0);
  for (const raw of ['', 'null', 'NaN', '-1', '1.5', 'true', '1e2', '9007199254740992']) {
    writeFileSync(path, raw);
    expect(() => readAttempt(path)).toThrow('invalid attempt counter');
    expect(readFileSync(path, 'utf8')).toBe(raw);
  }
  for (const n of [0, 1, 42]) {
    writeFileSync(path, `${n}\n`);
    expect(readAttempt(path)).toBe(n);
  }
});

describe('gate rules', () => {
  test('R1: open high blocks G1; medium does not', () => {
    expect(ids([R('FAIL', [f('high'), f('medium')])])).toEqual(['x-high']);
  });
  test('R1: G2 also blocks on medium', () => {
    expect(ids([R('FAIL', [f('medium'), f('low')])], 'G2')).toEqual(['x-medium']);
  });
  test('R2+: new non-blocker findings do not block; new blocker does', () => {
    const r2 = R('FAIL', [f('high', { id: 'R2-1' }), f('blocker', { id: 'R2-2' })]);
    expect(ids([R('PASS'), r2])).toEqual(['R2-2']);
  });
  test('closed findings never block', () => {
    expect(ids([R('PASS', [f('blocker', { status: 'closed' })])])).toEqual([]);
  });
  test('R2: a previous high only closes by original id, carry_over and evidence', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' })]);
    expect(ids([r1, R('PASS', [fixed('R1-1')])])).toEqual([]);
  });
  test('R2: omitting a previous high keeps it open (PASS with omission is not success)', () => {
    const d = decide({
      reviews: [R('FAIL', [f('high', { id: 'R1-1' })]), R('PASS')],
      rechecks: [C('a'), C('b')],
      risk: 'G1',
    });
    expect(d).toMatchObject({ verdict: 'fix', reason: 'review_inconsistent' });
  });
  test('R2: renamed id, carry_over:false or closed without evidence all stay open', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' })]);
    expect(ids([r1, R('PASS', [fixed('R1-1b')])])).toEqual(['R1-1']);
    expect(ids([r1, R('PASS', [{ ...fixed('R1-1'), carry_over: false }])])).toEqual(['R1-1']);
    expect(ids([r1, R('PASS', [{ ...fixed('R1-1'), evidence: ' ' }])])).toEqual(['R1-1']);
  });
  test('R3 baseline is what R2 left open, not only what R2 reported', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' }), f('high', { id: 'R1-2' })]);
    const r2 = R('FAIL', [fixed('R1-1')]);
    expect(
      ledgerOf([r1, r2, R('PASS', [])], 'G1', { strict: true }).blocking.map(e => e.id)
    ).toEqual(['R1-2']);
  });
  test('G2: a previous medium also needs explicit closure', () => {
    const r1 = R('FAIL', [f('medium', { id: 'R1-1' })]);
    expect(ids([r1, R('PASS')], 'G2')).toEqual(['R1-1']);
    expect(ids([r1, R('PASS', [fixed('R1-1', 'medium')])], 'G2')).toEqual([]);
  });
  test('r1 PASS with green acceptance passes, carrying debt', () => {
    expect(
      decide({ reviews: [R('PASS', [], ['tidy'])], rechecks: [C('a')], risk: 'G1' })
    ).toMatchObject({
      verdict: 'pass',
      rounds: 1,
      reason: null,
      debt: ['tidy'],
    });
  });
  test('G1: open non-blocking findings become debt when the reviewer left debt empty', () => {
    const d = decide({
      reviews: [R('PASS', [f('medium', { id: 'R1-1', file: 'b.ts', line: 7 }), f('low')])],
      rechecks: [C('a')],
      risk: 'G1',
    });
    expect(d).toMatchObject({ verdict: 'pass', debt: ['R1-1 medium b.ts:7', 'x-low low a.ts:1'] });
  });
  test('G1: a reviewer listing one of two open mediums still yields both as debt', () => {
    const d = decide({
      reviews: [
        R(
          'PASS',
          [f('medium', { id: 'R1-1' }), f('medium', { id: 'R1-2' })],
          ['R1-1 medium a.ts:1']
        ),
      ],
      rechecks: [C('a')],
      risk: 'G1',
    });
    expect(d).toMatchObject({
      verdict: 'pass',
      debt: ['R1-1 medium a.ts:1', 'R1-2 medium a.ts:1'],
    });
  });
  test('G1: delta closes B1 and D1 with evidence, preserves omitted D2, and cannot pass without B1 closure', () => {
    const r1 = R('FAIL', [
      f('blocker', { id: 'B1' }),
      f('medium', { id: 'D1' }),
      f('low', { id: 'D2' }),
    ]);
    const fold = (r2: Rv) => decide({ reviews: [r1, r2], rechecks: [C('a'), C('b')], risk: 'G1' });
    const d = fold(R('PASS', [fixed('B1', 'blocker'), fixed('D1', 'medium')]));
    expect(d).toMatchObject({ verdict: 'pass', debt: ['D2 low a.ts:1'] });
    expect(d.ledger.blocking).toEqual([]);
    expect(d.ledger.closed.map(e => e.id)).toEqual(['B1', 'D1']);
    expect(d.ledger.debt.map(e => e.id)).toEqual(['D2']);
    const omitted = fold(R('PASS', [fixed('D1', 'medium')]));
    expect(omitted).toMatchObject({ verdict: 'fix', reason: 'review_inconsistent' });
    expect(omitted.ledger.blocking.map(e => e.id)).toEqual(['B1']);
    const noEvidence = { ...fixed('D1', 'medium'), evidence: ' ' };
    expect(
      fold(R('PASS', [fixed('B1', 'blocker'), noEvidence])).ledger.debt.map(e => e.id)
    ).toEqual(['D1', 'D2']);
  });
  test('N1: a duplicate id (closed + open high) in one review escalates as invalid_review', () => {
    const r1 = R('FAIL', [f('high', { id: 'H1' })]);
    const r2 = R('PASS', [fixed('H1'), f('high', { id: 'H1', carry_over: true })]);
    expect(decide({ reviews: [r1, r2], rechecks: [C('a'), C('b')], risk: 'G1' })).toMatchObject({
      verdict: 'escalate',
      rounds: 2,
      reason: 'invalid_review',
      debt: [],
    });
    expect(ids([r1, r2])).toEqual(['H1']);
    const dupLow = R('PASS', [f('low', { id: 'L' }), f('low', { id: 'L' })]);
    expect(decide({ reviews: [dupLow], rechecks: [C('a')], risk: 'G1' }).reason).toBe(
      'invalid_review'
    );
  });
  test('r1 FAIL asks for a fix round', () => {
    expect(
      decide({ reviews: [R('FAIL', [f('high')])], rechecks: [C('a')], risk: 'G1' })
    ).toMatchObject({ verdict: 'fix', reason: 'review_failed' });
  });
  test('r2 PASS that closes the r1 high with evidence passes', () => {
    expect(
      decide({
        reviews: [R('FAIL', [f('high', { id: 'R1-1' })]), R('PASS', [fixed('R1-1')])],
        rechecks: [C('a'), C('b')],
        risk: 'G1',
      })
    ).toMatchObject({ verdict: 'pass', rounds: 2 });
  });
  test('red acceptance outranks a PASS review and asks for a fix', () => {
    expect(decide({ reviews: [R('PASS')], rechecks: [C('a', false)], risk: 'G1' })).toMatchObject({
      verdict: 'fix',
      reason: 'acceptance_failed',
    });
  });
  test('PASS that still lists an open blocker is inconsistent', () => {
    expect(
      decide({ reviews: [R('PASS', [f('blocker')])], rechecks: [C('a')], risk: 'G1' }).reason
    ).toBe('review_inconsistent');
  });
  test.each(Array.from({ length: MAX_ROUNDS - 2 }, (_, i) => i + 3))(
    'failing round %i permits the next fix only below the limit',
    rounds => {
      const d = decide({
        reviews: Array.from({ length: rounds }, () => R('FAIL')),
        rechecks: Array.from({ length: rounds }, (_, i) => C(String(i))),
        risk: 'G1',
      });
      expect(d).toMatchObject({
        verdict: rounds < MAX_ROUNDS ? 'fix' : 'escalate',
        rounds,
        reason: rounds < MAX_ROUNDS ? 'review_failed' : 'review_failed+review_limit',
      });
    }
  );
  test('a fix round whose diff is unchanged (same:true, review skipped) escalates as no_change', () => {
    expect(
      decide({ reviews: [R('FAIL'), null], rechecks: [C('h'), C('h', true, true)], risk: 'G1' })
    ).toMatchObject({ verdict: 'escalate', reason: 'no_change' });
  });
  test('past the plan deadline even a PASS escalates (deadline is checked first)', () => {
    expect(
      decide({ reviews: [R('PASS')], rechecks: [C('a')], risk: 'G1', expired: true })
    ).toMatchObject({ verdict: 'escalate', reason: 'deadline' });
  });
  test('INCOMPLETE review escalates immediately', () => {
    expect(decide({ reviews: [R('INCOMPLETE')], rechecks: [C('a')], risk: 'G1' })).toMatchObject({
      verdict: 'escalate',
      reason: 'review_incomplete',
    });
  });
  test('ledger: R2 漏掉 R1 高危仍阻塞，R3 保留未关闭问题并继续修复', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1', file: 'k.ts', line: 9 })]);
    const l = ledgerOf([r1, R('PASS')], 'G1');
    expect(l.blocking).toMatchObject([
      { id: 'R1-1', severity: 'high', file: 'k.ts', line: 9, round: 1 },
    ]);
    expect(
      decide({ reviews: [r1, R('PASS')], rechecks: [C('a'), C('b')], risk: 'G1' })
    ).toMatchObject({
      verdict: 'fix',
      reason: 'review_inconsistent',
    });
    expect(
      decide({
        reviews: [r1, R('PASS'), R('PASS')],
        rechecks: [C('a'), C('b'), C('c')],
        risk: 'G1',
      })
    ).toMatchObject({
      verdict: 'fix',
      reason: 'review_inconsistent',
      ledger: { blocking: [{ id: 'R1-1' }], debt: [] },
    });
  });
  test('ledger: 新增项伪装 carry-over——未知 id 不扩大阻塞集合，只按新发现记债', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' })]);
    const r2 = R('FAIL', [fixed('R1-1'), f('high', { id: 'R1-7', carry_over: true })]);
    const l = ledgerOf([r1, r2], 'G1');
    expect(l.blocking).toEqual([]);
    expect(l.debt.map(e => e.id)).toEqual(['R1-7']);
    expect(l.closed).toMatchObject([
      { id: 'R1-1', closed_round: 2, evidence: 'diff L3 removes it' },
    ]);
    // 伪装“已关闭”的未知 id 同样不进台账
    expect(
      ledgerOf([r1, R('PASS', [fixed('R1-1'), fixed('R0-9')])], 'G1').closed.map(e => e.id)
    ).toEqual(['R1-1']);
  });
  test('ledger: 新 high 债与真 blocker 共存——blocker 阻塞、high 记债，关闭 blocker 后带债 PASS', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' })]);
    const r2 = R('FAIL', [
      fixed('R1-1'),
      f('high', { id: 'R2-1', file: 'n.ts', line: 4 }),
      f('blocker', { id: 'R2-2' }),
    ]);
    expect(ledgerOf([r1, r2], 'G1')).toMatchObject({
      blocking: [{ id: 'R2-2', round: 2 }],
      debt: [{ id: 'R2-1', severity: 'high' }],
    });
    expect(decide({ reviews: [r1, r2], rechecks: [C('a'), C('b')], risk: 'G1' })).toMatchObject({
      verdict: 'fix',
      debt: ['R2-1 high n.ts:4'],
    });
    const r3 = R('PASS', [fixed('R2-2', 'blocker')]);
    expect(
      decide({ reviews: [r1, r2, r3], rechecks: [C('a'), C('b'), C('c')], risk: 'G1' })
    ).toMatchObject({ verdict: 'pass', debt: ['R2-1 high n.ts:4'] });
  });
  test('ledger: a debt entry re-reported as blocker becomes blocking', () => {
    const r2 = R('FAIL', [f('high', { id: 'R2-1' })]);
    const r3 = R('FAIL', [f('blocker', { id: 'R2-1' })]);
    expect(ids([R('PASS'), r2, r3])).toEqual(['R2-1']);
  });
  test('F-20: a round whose review was skipped (acceptance not advanced) fixes without a review', () => {
    const red = { ...C('a', false), disposition: 'repair' as const, reason: 'acceptance_failed' };
    expect(decide({ reviews: [null], rechecks: [red], risk: 'G1' })).toMatchObject({
      verdict: 'fix',
      reason: 'acceptance_failed',
    });
    // 首份非空评审才是台账基准：其 open high 照常阻塞
    expect(ids([null, R('FAIL', [f('high', { id: 'R2-1' })])])).toEqual(['R2-1']);
  });
  test('no review is a wiring error', () => {
    expect(decide({ reviews: [], rechecks: [], risk: 'G1' }).decision).toMatchObject({
      kind: 'block',
      reason: 'engine_suspect',
    });
    expect(() => decide({ reviews: [null], rechecks: [C('a')], risk: 'G1' })).toThrow(/no review/);
  });
});

describe('single delivery decision', () => {
  test.each([
    ['blocked', 'env', false, false, true, 2, 'environment'],
    ['blocked', 'redline', false, false, true, 2, 'acceptance_failed'],
    ['partial', 'env', false, false, true, 2, 'environment'],
    ['done', null, false, false, true, 2, 'acceptance_failed'],
    ['blocked', 'task', false, false, false, 1, 'acceptance_failed'],
    ['blocked', 'env', false, false, false, 1, 'environment'],
    ['blocked', 'env', false, true, true, 2, 'environment'],
    ['blocked', 'env', true, false, true, 2, 'environment'],
  ] as const)(
    'ROOT_ACCEPT empty candidates still validate regardless of coder status: %s/%s/%s/%s/%s',
    (status, error_class, candidate, dirty, includeBase, count, reason) => {
      const root = tmp(),
        repo = gitRepo(root),
        marker = join(root, 'calls');
      const base = sh('git rev-parse HEAD', repo).trim();
      const cmd = `echo check >> '${marker}'; printf '%s' '{"failure_class":"product","evidence":"failed check"}'; exit 1`;
      const plan = fixturePlan(root, repo, p => {
        p.environment = [{ cmd: 'true', timeout_s: 5 }];
        p.packages = [{ id: 'a', accept: [{ cmd, timeout_s: 5, cache: false }] }];
      });
      const needs = [{ cap: 'environment', why: 'missing tool', minimal_ask: 'prepare tool' }];
      if (existsSync(marker)) unlinkSync(marker);
      if (candidate || dirty) writeFileSync(join(repo, 'README.md'), 'candidate');
      if (candidate)
        sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
      const report = {
        status,
        error_class,
        needs: error_class === 'env' ? needs : [],
        blockers: ['original blocker'],
        failure_class: 'test_env',
      };
      const result = runScript(repo, {
        kind: 'accept',
        plan,
        pkgs: 'a',
        tag: 'verify-empty',
        base: includeBase ? base : '',
        delta_base: candidate ? sh('git rev-parse HEAD', repo).trim() : base,
        coder: JSON.stringify(report),
      });
      const emptyUnfinished = includeBase && status !== 'done';
      const emptyReason = report.needs.length ? 'coder_needs' : 'coder_partial';
      expect(result.code, result.err).toBe(emptyUnfinished ? 1 : 0);
      expect(result.out).toMatchObject({
        ok: false,
        disposition: emptyUnfinished ? 'fail' : 'repair',
        reason: emptyUnfinished ? emptyReason : reason,
        ...(emptyUnfinished
          ? { decision: { blockers: report.blockers, needs: report.needs } }
          : {}),
      });
      expect(existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0).toBe(
        count
      );
      expect(
        JSON.parse(readFileSync(join(result.art, 'verify-empty.coder.json'), 'utf8'))
      ).toMatchObject({ ...report, status: error_class === 'task' ? 'partial' : status });
      if (!count)
        expect(result.out).toMatchObject({
          command_results: [],
          failures: [],
          decision: {
            kind: 'block',
            evidence: expect.arrayContaining([join(result.art, 'verify-empty.coder.json')]),
          },
        });
      if (dirty) writeFileSync(join(repo, 'README.md'), 'hi\n');
    }
  );
  test('permission evidence and retry boundaries survive the real acceptance node', () => {
    const root = tmp(),
      repo = gitRepo(root),
      archon = join(root, 'archon'),
      policy = join(root, 'policy.json');
    writeFileSync(policy, JSON.stringify(snapshotPolicy(loadTiers())));
    const inputs = { kind: 'accept', pkgs: 'a', tag: 'verify-permission', archon, policy };
    const event = (attemptId: string, permissionDenied?: true) => ({
      event_type: 'provider_event',
      step_name: 'code-a',
      data: {
        attemptId,
        event: {
          type: 'warning',
          code: 'superagent.permission.authorization',
          message: 'x',
          permissionDenied,
        },
      },
    });
    const start = { event_type: 'node_started', step_name: 'code-a' };
    const counter = (step_name: string, attempt = '1') => ({
      event_type: 'node_completed',
      step_name,
      data: { structured_output: { attempt } },
    });
    const repair = { ...event('old', true), step_name: 'repair-a' };
    const fix = { ...repair, step_name: 'fix-m1-r2' };
    for (const [events, reason] of [
      [[repair, counter('package-attempt-a'), start, event('new')], null],
      [[fix, counter('attempt-m1'), start, event('new')], null],
      [[counter('package-attempt-a'), repair, counter('package-attempt-a')], 'coder_redline'],
      [[repair, counter('package-attempt-a'), start, event('new', true)], 'coder_redline'],
      [[], 'environment'],
    ] as const) {
      writeFileSync(archon, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ events })}'\n`, {
        mode: 0o755,
      });
      const cmd =
        reason === 'environment'
          ? `printf '%s' '{"failure_class":"test_env","evidence":"environment unavailable"}'; exit 1`
          : 'true';
      const plan = fixturePlan(root, repo, p => {
        p.packages = [{ id: 'a', accept: [{ cmd, timeout_s: 5 }] }];
      });
      const result = runScript(repo, { ...inputs, plan }, SCRIPT, { WORKFLOW_ID: 'fixture' });
      expect(result.code, result.err).toBe(reason === 'coder_redline' ? 1 : 0);
      expect(result.out).toMatchObject({
        ok: reason !== 'environment',
        decision: { kind: reason ? 'block' : 'advance', reason },
      });
    }
  }, 10_000);
  test('other self-reports do not change control state, including malformed output', () => {
    for (const raw of [
      '{',
      JSON.stringify({ status: 'blocked', error_class: 'redline', needs: [{ cap: 'network' }] }),
    ])
      for (const ok of [true, false])
        expect(disposition(raw, ok, undefined, [], undefined, MAX_ROUNDS).decision.kind).toBe(
          ok ? 'advance' : 'repair'
        );
  });
  test('non-critical failures become debt', () => {
    const check = {
      ...C('a', false),
      failed: ['check'],
      failures: [
        { command: 'check', failure_class: 'fixture' as const, evidence: '/tmp/accept.log' },
      ],
    };
    expect(deliveryDecision({ rechecks: [check], reviewRounds: MAX_ROUNDS }).decision.kind).toBe(
      'debt'
    );
  });
  test('E7: partial + env + green checks advances with all audit markers', () => {
    // 原始 node_completed 事件的 structured_output，仅将 notes 置空脱敏。
    const coder: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, 'incidents/e7-coder.json'), 'utf8')
    );
    expect(
      disposition(JSON.stringify(coder), true, undefined, [], undefined, MAX_ROUNDS)
    ).toMatchObject({
      disposition: 'advance',
      reason: null,
      self_report_conflict: true,
      coder_partial: true,
      error_class_ignored: true,
    });
    const root = tmp();
    const r = runScript(gitRepo(root), {
      kind: 'accept',
      plan: planFile(root, 'true'),
      pkgs: 'a',
      tag: 'verify-e7',
      coder: JSON.stringify(coder),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(r.art, 'verify-e7.json'), 'utf8'))).toMatchObject({
      ok: true,
      failed: [],
      disposition: 'advance',
      reason: null,
      self_report_conflict: true,
      coder_partial: true,
      error_class_ignored: true,
    });
    expect(JSON.parse(readFileSync(join(r.art, 'verify-e7.coder.json'), 'utf8'))).toMatchObject({
      status: 'partial',
      error_class: 'env',
      error_class_ignored: true,
    });
  });
});

describe('F-13 delivery scope', () => {
  const pol = {
    risk_paths: ['**/auth/**', '**/*.sql'],
    code_extensions: ['.ts'],
    exempt_paths: ['*.md'],
    budget_floor: { S: 1 },
  };
  const ch = (paths: string[], modes = ['100644', '100644']) => ({ modes, paths });
  test('in-scope code edits keep the declared risk; G0 touching code is inferred G1', () => {
    expect(scopeRisk([ch(['src/a.ts'])], ['src/'], pol, 'G1')).toEqual({
      risk: 'G1',
      out_of_scope: [],
    });
    expect(scopeRisk([ch(['src/a.ts'])], ['src'], pol, 'G0').risk).toBe('G1');
    expect(scopeRisk([ch(['README.md'])], ['src'], pol, 'G0')).toEqual({
      risk: 'G0',
      out_of_scope: [],
    });
  });
  test('out-of-scope paths remain evidence while risk paths, gitlinks and symlinks raise G2', () => {
    expect(scopeRisk([ch(['lib/x.ts', 'src/x.ts'])], ['src/**'], pol, 'G1')).toEqual({
      risk: 'G1',
      out_of_scope: ['lib/x.ts'],
    });
    expect(scopeRisk([ch(['src/auth/k.ts'])], ['src'], pol, 'G1').risk).toBe('G2');
    expect(scopeRisk([ch(['src/vendor'], ['000000', '160000'])], ['src'], pol, 'G0').risk).toBe(
      'G2'
    );
    expect(scopeRisk([ch(['src/l'], ['100644', '120000'])], ['src'], pol, 'G0').risk).toBe('G2');
  });
  test.each([
    ['ci/Jenkinsfile', 'G2'],
    ['app/Dockerfile', 'G2'],
    ['db/X.SQL', 'G2'],
    ['keys/server.PEM', 'G2'],
    ['src/UserCredential.ts', 'G2'],
    ['src/styles/theme/tokens.css', 'G2'],
    ['src/a.ts', 'G1'],
  ])('E3-3: gate and micro-edit risk matching agree for %s', (file, expected) => {
    const micro = require('../hooks/micro-edit.cjs');
    const root = process.cwd();
    const edit = micro.plan(
      'codex',
      {
        cwd: root,
        tool_input: {
          input: `*** Begin Patch\n*** Update File: ${file}\n-old\n+new\n*** End Patch`,
        },
      },
      root,
      (p: string) => p,
      root
    );
    const risk = scopeRisk([ch([file])], ['**'], loadTiers().policy, 'G1').risk;
    expect(risk).toBe(expected);
    expect(edit.risk.length > 0).toBe(risk === 'G2');
  });
});

describe('F-14 model identity', () => {
  const b = (requested: string, resolved: Record<string, string>) => ({
    provider: 'x',
    model: { requested, resolved: resolved as { source: string } },
  });
  test('provider-reported model wins; unsupported resolution falls back to the pinned request', () => {
    expect(identityOf(b('a', { source: 'provider', value: 'a-2' }))).toEqual({
      model: 'a-2',
      strength: 'provider',
    });
    expect(identityOf(b('gpt-x', { source: 'unavailable', reason: 'unsupported' }))).toEqual({
      model: 'gpt-x',
      strength: 'pinned',
    });
    expect(identityOf(b('a', { source: 'unavailable', reason: 'no_result' })).strength).toBe(
      'unknown'
    );
    expect(identityOf(undefined).strength).toBe('unknown');
  });
  test('same actual model, unknown reviewer or unknown author is not a qualified review', () => {
    const id = (
      model: string | null,
      strength: 'provider' | 'pinned' | 'unknown' = 'provider'
    ) => ({
      model,
      strength,
    });
    expect(independence([id('a')], id('b', 'pinned'))).toBeNull();
    expect(independence([id('a'), id('b')], id('b'))).toBe('same_model');
    expect(independence([id('a')], id(null, 'unknown'))).toBe('reviewer_unknown');
    expect(independence([id(null, 'unknown')], id('b'))).toBe('author_unknown');
    expect(independence([], id('b'))).toBe('author_unknown');
  });
});

// These checks exercise delivery/classification/cache semantics. Process-group
// supervision has separate ACCT/probe tests below; avoid starting Python for
// each ordinary Git query here while retaining the real commands and deadlines.
const directAuxiliary = directAuxiliaryPreload();

function runScript(
  cwd: string,
  inputs: Record<string, string>,
  script = SCRIPT,
  extraEnv: Record<string, string> = {},
  directQueries = script === SCRIPT
): { code: number; out: unknown; err: string; art: string; stdoutBytes: number } {
  const art = join(cwd, '..', 'art');
  mkdirSync(art, { recursive: true });
  // An engine accept node runs this suite with its own INPUTS_*/WORKFLOW_ID; inheriting them points
  // the script at the live run's Archon instead of the fixture.
  const inherited = Object.entries(process.env as Record<string, string>).map(([k, v]) => [
    k,
    k.startsWith('INPUTS_') || k === 'WORKFLOW_ID' ? '' : v,
  ]);
  const env: Record<string, string> = {
    ...Object.fromEntries(inherited),
    ARTIFACTS_DIR: art,
    ...extraEnv,
  };
  if (!inputs.policy) {
    const policy = join(art, 'policy.json');
    writeFileSync(policy, JSON.stringify(snapshotPolicy(loadTiers())));
    env.INPUTS_POLICY = policy;
  }
  for (const [k, v] of Object.entries(inputs)) {
    // Synthetic gate fixtures bind the real checkout just like accept artifacts do.
    let value = v;
    if (inputs.kind === 'gate' && /^c\d+$/.test(k)) {
      const file = existsSync(v) ? v : undefined;
      const check = JSON.parse(file ? readFileSync(file, 'utf8') : v);
      const needsFingerprint = check && !Object.hasOwn(check, 'checkout_fingerprint');
      if (needsFingerprint)
        check.checkout_fingerprint = checkoutFingerprint(args =>
          Bun.spawnSync(['git', '-C', cwd, ...args])
        );
      if (file) {
        if (needsFingerprint) writeFileSync(file, JSON.stringify(check));
      } else value = JSON.stringify(check);
    }
    env[`INPUTS_${k.toUpperCase()}`] = value;
  }
  const p = Bun.spawnSync(
    directQueries
      ? [process.execPath, '--preload', directAuxiliary, script]
      : [process.execPath, script],
    {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    }
  );
  const out = p.stdout.toString().trim();
  return {
    code: p.exitCode,
    out: out ? (JSON.parse(out) as unknown) : null,
    err: p.stderr.toString(),
    art,
    stdoutBytes: p.stdout.byteLength,
  };
}

// Trace real auxiliary calls through the process-group watchdog.
function auxiliaryFixture(
  kind: string,
  hang = '',
  scaled = false,
  stubborn = false,
  hook = false,
  budget?: number
) {
  const root = tmp(),
    repo = gitRepo(root),
    trace = join(root, 'trace.jsonl'),
    trackedPid = join(root, 'auxiliary.pid');
  const base = sh('git rev-parse HEAD', repo).trim();
  const plan = fixturePlan(root, repo);
  const p = JSON.parse(readFileSync(plan, 'utf8'));
  p.environment = [{ cmd: 'true', timeout_s: 1 }];
  p.packages[0].accept = [{ cmd: PRODUCT_FAILURE, timeout_s: 1, cache: true }];
  writeFileSync(plan, JSON.stringify(p));
  const policy = join(root, 'policy.json'),
    archon = join(root, 'archon-stub');
  cpSync(join(import.meta.dir, '../templates/.archon/scripts'), root, { recursive: true });
  writeFileSync(
    policy,
    JSON.stringify({
      effort: snapshotPolicy(loadTiers()).effort,
      risk_paths: [],
      code_extensions: [],
      exempt_paths: [],
      budget_floor: { S: 1 },
    })
  );
  writeFileSync(archon, '#!/bin/sh\necho \'{"events":[]}\'\n', { mode: 0o755 });
  const script = join(root, 'sa-check.ts');
  // Runtime sibling import of sa-check.ts; type-only imports are erased and need no copy.
  writeFileSync(
    join(root, 'policy-attempts.ts'),
    readFileSync(join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'))
  );
  if (hook) sh(`git config core.hooksPath '${join(repo, '.git/hooks')}'`, repo);
  if (hook)
    writeFileSync(
      join(repo, '.git/hooks/post-checkout'),
      `#!/bin/bash\n(trap '' TERM; echo $BASHPID > '${trackedPid}'; echo hook-descendant >&2; while :; do sleep 1; done) &\nexit 0\n`,
      { mode: 0o755 }
    );
  const instrument = `
process.env.WORKFLOW_ID = 'fixture';
const rawSpawnSync = Bun.spawnSync;
Bun.spawnSync = (actual, opts) => {
  const wrapped = actual[0] === 'python3' && actual[1] === '-c';
  const cmd = wrapped ? actual.slice(4) : actual;
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({cmd, timeout: opts?.timeout, watchdog: wrapped}) + '\\n');
  const key = cmd[0] === 'git' ? cmd.slice(1, 3).join(' ') : cmd[0] === 'bash' ? 'command' : 'events';
  if (key === ${JSON.stringify(hang)})
    return rawSpawnSync([...(wrapped ? actual.slice(0, 4) : []), 'bash', '-c', ${JSON.stringify(stubborn ? `trap '' TERM; echo $$ > '${trackedPid}'; echo auxiliary-stalled >&2; while :; do sleep 1; done` : 'echo auxiliary-stalled >&2; exec sleep 2')}], opts);
  // Only the stalled auxiliary (or the hook-bearing checkout) needs a real
  // process-group watchdog. Keep every production request in the trace.
  if (wrapped && key !== ${JSON.stringify(hang)} && !(${JSON.stringify(hook)} && key === 'worktree add'))
    return rawSpawnSync(cmd, opts);
  return rawSpawnSync(actual, opts);
};
`;
  let source = readFileSync(SCRIPT, 'utf8').replace('const env =', `${instrument}\nconst env =`);
  if (scaled)
    source = source.replace('CHECK_AUX_TIMEOUT_MS = 10_000', 'CHECK_AUX_TIMEOUT_MS = 2000');
  if (budget !== undefined)
    source = source.replace('CHECK_AUX_BUDGET_MS = 130_000', `CHECK_AUX_BUDGET_MS = ${budget}`);
  writeFileSync(script, source);
  const r = runScript(
    repo,
    {
      kind,
      plan,
      policy,
      archon,
      pkgs: 'core',
      tag: 'acct',
      base,
      delta_base: base,
      risk: 'G1',
      ...(kind === 'settle'
        ? { repaired: '{"status":"done","error_class":null}', first: '{}' }
        : {}),
    },
    script
  );
  if (!existsSync(trace)) throw new Error(`auxiliary fixture did not start: ${r.err}`);
  const calls = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { cmd: string[]; timeout?: number; watchdog: boolean });
  return { ...r, calls, trackedPid };
}

for (const kind of ['accept', 'settle', 'env'])
  test(`ACCT: ${kind} traced worst path enforces allowed auxiliary categories and timeout`, () => {
    const r = auxiliaryFixture(kind);
    const auxiliary = r.calls.filter(c => c.watchdog);
    // Explicitly register subprocess categories; repetitions do not create a new contract.
    const allowed = new Set(
      kind === 'env'
        ? ['workflow get', 'git rev-parse']
        : [
            'workflow get',
            'git status',
            'git write-tree',
            'git diff',
            'git worktree',
            'git rev-parse',
          ]
    );
    expect(auxiliary.length).toBeGreaterThan(0);
    for (const call of auxiliary) {
      const category =
        call.cmd[0] === 'git'
          ? call.cmd[1] === '-C'
            ? `git ${call.cmd[3]}`
            : call.cmd.slice(0, 2).join(' ')
          : call.cmd.slice(1, 3).join(' ');
      expect(allowed.has(category), category).toBe(true);
      expect(call.timeout).toBe(CHECK_AUX_TIMEOUT_MS);
    }
    if (kind === 'env') expect(r.code).toBe(0);
    else {
      expect(r.out).toMatchObject({ ok: false, base_pass: false });
      expect(r.code).toBe(kind === 'settle' ? 1 : 0);
      expect(r.calls.filter(c => c.cmd[0] === 'bash')).toHaveLength(3);
    }
  });

test('ACCT: auxiliary timeout uses the remaining shared elapsed budget', () => {
  const r = auxiliaryFixture('accept', '', false, false, false, CHECK_AUX_TIMEOUT_MS);
  expect(r.code, r.err).toBe(0);
  const timeouts = r.calls.filter(c => c.watchdog).map(c => c.timeout!);
  expect(timeouts.length).toBeGreaterThan(1);
  expect(timeouts.every(ms => Number.isInteger(ms) && ms > 0 && ms <= CHECK_AUX_TIMEOUT_MS)).toBe(
    true
  );
  expect(timeouts.at(-1)!).toBeLessThan(timeouts[0]);
});

for (const [kind, step, evidence] of [
  ['accept', 'status --porcelain', 'git status:'],
  ['accept', 'events', 'archon workflow get fixture:'],
  ['env', 'rev-parse HEAD', 'git rev-parse:'],
])
  test(`ACCT: ${kind} auxiliary ${step} timeout fails with original evidence`, () => {
    const r = auxiliaryFixture(kind, step, true);
    expect(r.code).toBe(1);
    expect(r.err).toContain(evidence);
    expect(r.err).toContain('auxiliary-stalled');
    expect(r.err).toContain('TERM -> SIGKILL');
    expect(
      r.calls.find(c =>
        c.cmd[0] === 'git'
          ? c.cmd.slice(1, 3).join(' ') === step
          : c.cmd[0] !== 'bash' && step === 'events'
      )?.timeout
    ).toBe(2000);
  });

test('probe: bounded prune timeout cannot override baseline results', () => {
  const r = auxiliaryFixture('accept', 'worktree prune', true);
  expect(r.code).toBe(0);
  expect(r.out).toMatchObject({
    base_pass: false,
    base_results: [{ cmd: PRODUCT_FAILURE, pass: false }],
  });
  expect(r.err).toContain(`probe: kept worktree ${r.art}/.trash/probe-acct-`);
  expect(r.err).toContain('TERM -> SIGKILL');
  expect(readFileSync(join(r.art, 'acct.probe.log'), 'utf8')).toContain('auxiliary-stalled');
});

function expectAuxiliaryDead(path: string): void {
  const pid = readFileSync(path, 'utf8').trim();
  const p = Bun.spawnSync(['ps', '-p', pid, '-o', 'stat=']);
  expect(p.exitCode !== 0 || p.stdout.toString().trim().startsWith('Z')).toBe(true);
}

test('ACCT: TERM-ignoring auxiliary is killed within the shared budget with evidence', () => {
  const started = Date.now();
  const r = auxiliaryFixture('env', 'rev-parse HEAD', true, true);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(r.code).toBe(1);
  expect(r.err).toContain('auxiliary-stalled');
  expect(r.err).toContain('TERM -> SIGKILL; output pipes reclaimed');
  expectAuxiliaryDead(r.trackedPid);
});

test('ROOT_ACCEPT diagnostic probe hook timeout preserves acceptance failure', () => {
  const r = auxiliaryFixture('accept', '', true, false, true);
  // Fixture setup and other auxiliary calls are outside this watchdog's budget.
  expect(r.calls.find(c => c.cmd.slice(0, 3).join(' ') === 'git worktree add')?.timeout).toBe(2000);
  expect(r.code, r.err).toBe(0);
  expect(r.out).toMatchObject({ ok: false, disposition: 'repair', base_pass: null });
  const diagnostic = readFileSync(join(r.art, 'acct.probe.log'), 'utf8');
  expect(diagnostic).toContain('hook-descendant');
  expect(diagnostic).toContain('TERM -> SIGKILL; output pipes reclaimed');
  expectAuxiliaryDead(r.trackedPid);
});

function planFile(
  root: string,
  accept: string,
  environment: string[] = [],
  cache?: boolean
): string {
  const p = join(root, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      environment: environment.map(cmd => ({ cmd, timeout_s: 5 })),
      packages: [{ id: 'a', accept: [{ cmd: accept, timeout_s: 5, cache }] }],
    })
  );
  return p;
}

describe('sa-check script', () => {
  // prettier-ignore
  test('carried acceptance replays accepted ancestor evidence without running checks', () => {
    const root = tmp(), repo = gitRepo(root), counter = join(root, 'ran');
    const path = planFile(root, `echo ran >> '${counter}'; false`, [], false);
    const head = sh('git rev-parse HEAD', repo).trim(), carried = join(root, 'carried.json');
    const evidence = {
      ok: true, failed: [], log: '/old.log', patch: '/old.patch', delta: '/old.delta',
      diff_hash: 'old', same: false, reviewed: false, base_pass: null, head,
      checkout_fingerprint: '/old.fingerprint', disposition: 'advance', reason: null,
      risk: 'G1', out_of_scope: [], tag: 'verify-old',
      artifact_sha256: 'old-artifact-sha256',
      decision: { kind: 'advance', reason: null, evidence: ['/old.log'], debt: [] },
    };
    const run = (attempt = '0') => runScript(repo, {
      kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a', carried_evidence: carried, attempt,
    });
    writeFileSync(carried, JSON.stringify(evidence));
    const replay = run();
    expect(replay.code, replay.err).toBe(0);
    const artifact = readFileSync(join(replay.art, 'verify-a.json'), 'utf8');
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
    expect(replay.out).toEqual({ ...evidence, tag: 'verify-a', artifact_sha256: artifactSha256 });
    expect(JSON.parse(artifact)).not.toHaveProperty('artifact_sha256');
    expect(existsSync(counter)).toBe(false);
    const retry = run('1');
    expect(retry.code, retry.err).toBe(0);
    expect(retry.out).toMatchObject({ disposition: 'repair' });
    expect(readFileSync(counter, 'utf8')).toBe('ran\n');
    const unrelated = sh('git commit-tree HEAD^{tree} -m unrelated', repo).trim();
    for (const [decision, carriedHead, error] of [
      ['repair', head, 'decision must be advance/debt'],
      ['advance', unrelated, 'head is not an ancestor'],
    ] as const) {
      writeFileSync(carried, JSON.stringify({ ...evidence, head: carriedHead,
        decision: { ...evidence.decision, kind: decision } }));
      const rejected = run();
      expect(rejected.code).toBe(1);
      expect(rejected.err).toContain(error);
    }
  });
  test('req-evidence: mapped evidence, cache identity, legacy and portable installed runtime', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'true');
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept = [
      { cmd: 'true', timeout_s: 5 },
      { cmd: 'true', timeout_s: 6 },
    ];
    p.packages[0].requirements = [{ id: 'r', text: 'two checks', verified_by: [0, 1] }];
    writeFileSync(path, JSON.stringify(p));
    const portable = join(root, 'installed');
    cpSync(join(import.meta.dir, '../templates/.archon/scripts'), portable, { recursive: true });
    cpSync(
      join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'),
      join(portable, 'policy-attempts.ts')
    );
    const accept = () =>
      runScript(
        repo,
        {
          kind: 'accept',
          plan: path,
          pkgs: 'a',
          tag: 'verify-a',
          coder: '{"status":"partial","error_class":"task"}',
        },
        join(portable, 'sa-check.ts'),
        {},
        true
      );
    const first = accept();
    expect(first).toMatchObject({
      code: 0,
      out: {
        disposition: 'advance',
        coder_partial: true,
        decision: { requirements: { status: 'verified' } },
      },
    });
    const check = first.out as Accept;
    const decide = (c: Accept) =>
      deliveryDecision({ rechecks: [c], reviewRounds: MAX_ROUNDS }).decision.requirements;
    expect(
      decide({ ...check, command_results: check.command_results?.slice(0, 1) })?.items[0].status
    ).toBe('unknown');
    const results = check.command_results!.map(c => ({ ...c }));
    results[1].pass = false;
    expect(decide({ ...check, command_results: results })?.status).toBe('unmet');
    results[1] = { ...results[1], pass: true, check: { cmd: 'unrelated', timeout_s: 6 } };
    expect(decide({ ...check, command_results: results })?.status).toBe('unknown');
    expect(decide({ ok: true, same: false, diff_hash: '' })?.status).toBe('legacy');
    expect(accept().code).toBe(0);
    expect(readFileSync(join(first.art, 'verify-a.log'), 'utf8')).toContain('# reused pass');
    p.packages[0].requirements[0].verified_by = [1, 0];
    writeFileSync(path, JSON.stringify(p));
    const changed = accept().out as Accept;
    expect(changed.contract_hash).not.toBe(check.contract_hash);
    expect(readdirSync(join(first.art, 'accept-cache')).filter(f => f !== '.key').length).toBe(4);
    const validate = new Ajv2020().compile(acceptOutputSchema.properties.decision);
    for (const c of [
      check,
      { ...check, command_results: [] },
      { ...check, command_results: check.command_results!.map(c => ({ ...c, pass: false })) },
      { ok: true, same: false, diff_hash: '' },
    ]) {
      expect(validate(deliveryDecision({ rechecks: [c], reviewRounds: MAX_ROUNDS }).decision)).toBe(
        true
      );
    }
    expect(
      deliveryDecision({
        rechecks: [check],
        packages: changed.requirement_contract,
        reviewRounds: MAX_ROUNDS,
      }).decision.requirements?.status
    ).toBe('unknown');
    expect(
      acceptOutputSchema.properties.decision.properties.requirements.properties.status.enum
    ).toEqual(['legacy', 'verified', 'unmet', 'unknown']);
  });
  test('RA: non-product advance passes TESTED with command debt visible in land', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const command = `printf '%s' '{"failure_class":"fixture","evidence":"fixture mismatch"}'; exit 1`;
    const plan = fixturePlan(root, repo, p => {
      p.packages = [{ id: 'a', accept: [{ cmd: command, timeout_s: 5, cache: false }] }];
    });
    const accepted = runScript(repo, {
      kind: 'accept',
      plan,
      pkgs: 'a',
      tag: 'diff-m1-r1',
      risk: 'G1',
      coder: JSON.stringify({ status: 'done', error_class: null }),
    });
    expect(accepted.out).toMatchObject({
      ok: false,
      disposition: 'advance',
      failures: [{ command, failure_class: 'fixture' }],
    });
    const gated = runScript(repo, {
      kind: 'gate',
      plan,
      round: '1',
      review: '0',
      risk: 'G1',
      milestone: 'm1',
      pkgs: 'a',
      tag: 'gate-m1-r1',
      r1: 'null',
      c1: JSON.stringify(accepted.out),
    });
    const evidence = join(accepted.art, 'diff-m1-r1.log');
    expect(gated).toMatchObject({
      code: 0,
      out: { verdict: 'pass', grade: 'TESTED' },
    });
    const debt = (gated.out as { debt: string[] }).debt;
    expect(debt).toEqual([expect.stringContaining(command)]);
    expect(debt[0]).toContain('[fixture non_product]');
    expect(debt[0]).toContain(evidence);
    expect(
      JSON.parse(readFileSync(join(gated.art, 'gate-m1-r1.ledger.json'), 'utf8'))
    ).toMatchObject({ blocking: [], debt: [{ command, failure_class: 'fixture', evidence }] });
    expect(runScript(repo, { kind: 'land', plan, base_ref: 'origin/main' }).out).toMatchObject({
      debt,
    });
  });
  test('NR: no review passes TESTED only with green advance and effective risk below G2', () => {
    const root = tmp(),
      repo = gitRepo(root),
      plan = fixturePlan(root, repo);
    const gate = (risk: string, reviewed = false) =>
      runScript(repo, {
        kind: 'gate',
        plan,
        round: '1',
        review: '0',
        risk: 'G1',
        milestone: 'm1',
        pkgs: 'core',
        tag: 'gate-m1-r1',
        r1: JSON.stringify(reviewed ? R('PASS') : null),
        c1: JSON.stringify({ ...C('a'), disposition: 'advance', risk }),
      });
    expect(gate('G1')).toMatchObject({
      code: 0,
      out: {
        verdict: 'pass',
        grade: 'TESTED',
        reason: 'review_not_required',
        identity: null,
        debt: [],
      },
    });
    expect(gate('G2')).toMatchObject({ code: 1, err: expect.stringContaining('gate: no review') });
    expect(gate('G2', true)).toMatchObject({ code: 0, out: { grade: 'PASS', risk: 'G2' } });
  });
  test('B1 carry same-diff reuses a qualified review after acceptance recovers; contract or identity drift refuses reuse', () => {
    const root = tmp(),
      repo = gitRepo(root),
      flag = join(root, 'ready');
    const p = join(root, 'plan.json');
    const contract = {
      deadline: '2099-01-01T00:00:00Z',
      mode: 'strict',
      budget: { launches: 20, weighted_tokens: 2_000_000 },
      packages: [
        {
          id: 'a',
          scope: { write: ['*.md'] },
          accept: [{ cmd: `test -f '${flag}'`, timeout_s: 5, cache: false }],
        },
      ],
    };
    writeFileSync(p, JSON.stringify(contract));
    const pol = join(root, 'policy.json');
    writeFileSync(pol, JSON.stringify(snapshotPolicy(loadTiers())));
    const inputs = {
      kind: 'accept',
      plan: p,
      pkgs: 'a',
      risk: 'G1',
      policy: pol,
      base: sh('git rev-parse HEAD', repo).trim(),
    };
    const prior = runScript(repo, { ...inputs, tag: 'prior' }).out as {
      diff_hash: string;
      contract_hash: string;
      ok: boolean;
    };
    expect(prior.ok).toBe(false);
    writeFileSync(flag, 'ready');
    const current = runScript(repo, { ...inputs, tag: 'current', prev: prior.diff_hash }).out;
    expect(current).toMatchObject({
      same: true,
      ok: true,
      disposition: 'advance',
      contract_hash: prior.contract_hash,
    });
    const eventsFile = join(root, 'events.json'),
      archon = join(root, 'archon');
    writeFileSync(
      archon,
      `#!/usr/bin/env node\nconst saved=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(eventsFile)}, 'utf8')); const prior=process.argv[4]==='ancestor'; process.stdout.write(JSON.stringify({...saved,id:prior?'ancestor':'scratch-only',codebase_id:'repo',output_root:${JSON.stringify(root)},adopted_from_run_id:prior?null:'ancestor',events:saved.events.filter(e=>prior?e.step_name==='code-a':e.step_name!=='code-a')}));\n`
    );
    chmodSync(archon, 0o755);
    const events = (reviewer: string) => ({
      events: ['code-a', 'review-m1-r1'].map((step_name, i) => ({
        step_name,
        event_type: 'node_completed',
        data: {
          binding: {
            model: {
              requested: i === 0 ? 'author-model' : reviewer,
              resolved: { reason: 'unsupported' },
            },
          },
        },
      })),
    });
    writeFileSync(eventsFile, JSON.stringify(events('review-model')));
    const gate = (check: unknown) =>
      runScript(
        repo,
        {
          kind: 'gate',
          plan: p,
          pkgs: 'a',
          milestone: 'm1',
          tag: 'reuse',
          round: '2',
          risk: 'G1',
          archon,
          policy: pol,
          r1: JSON.stringify(R('PASS')),
          r2: 'null',
          c1: JSON.stringify(prior),
          c2: JSON.stringify(check),
        },
        SCRIPT,
        { WORKFLOW_ID: 'scratch-only' }
      );
    const reusedResult = gate(current);
    expect(reusedResult.err).toBe('');
    const reused = reusedResult.out as { review_file: string };
    expect(reused).toMatchObject({ verdict: 'pass', grade: 'PASS' });
    expect(JSON.parse(readFileSync(reused.review_file, 'utf8'))).toEqual(R('PASS'));
    writeFileSync(eventsFile, JSON.stringify(events('author-model')));
    expect(gate(current).out).toMatchObject({ verdict: 'escalate', reason: 'no_change' });
    writeFileSync(eventsFile, JSON.stringify(events('review-model')));
    writeFileSync(p, JSON.stringify({ ...contract, environment: [{ cmd: 'true', timeout_s: 5 }] }));
    const changed = runScript(repo, { ...inputs, tag: 'changed', prev: prior.diff_hash }).out;
    expect(changed).toMatchObject({ same: true, ok: true });
    expect(gate(changed).out).toMatchObject({ verdict: 'escalate', reason: 'no_change' });
    writeFileSync(p, JSON.stringify({ ...contract, deadline: '2000-01-01T00:00:00Z' }));
    // Deadline remains terminal even when the binding/event query is unavailable.
    writeFileSync(archon, '#!/usr/bin/env node\nprocess.exit(1);\n');
    expect(gate(current).out).toMatchObject({ verdict: 'escalate', reason: 'deadline' });
  }, 30_000); // Real sa-check subprocess rounds take ~5-10s; the 5s default flakes under load.
  test('budget enforcement: NO_HOLD hard and observe final review budgets preserve PASS', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = join(root, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        deadline: '2099-01-01T00:00:00Z',
        mode: 'strict',
        budget: { launches: 2, weighted_tokens: 30, enforcement: 'hard' },
        packages: [],
      })
    );
    const pol = join(root, 'policy.json');
    writeFileSync(pol, JSON.stringify(snapshotPolicy(loadTiers())));
    const eventsFile = join(root, 'events.json'),
      archon = join(root, 'archon');
    writeFileSync(
      archon,
      `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(eventsFile)}, 'utf8'));\n`
    );
    chmodSync(archon, 0o755);
    const events = ['code-a', 'review-m1-r1'].flatMap((step_name, i) => [
      { step_name, event_type: 'node_started' },
      {
        step_name,
        event_type: 'node_completed',
        data: {
          binding: {
            model: {
              requested: i ? 'review-model' : 'author-model',
              resolved: { reason: 'unsupported' },
            },
          },
          spend: {
            tokens: { source: 'provider', value: { input: i ? 25 : 5, output: i ? 20 : 5 } },
          },
        },
      },
    ]);
    writeFileSync(eventsFile, JSON.stringify({ events }));
    const gate = () =>
      runScript(
        repo,
        {
          kind: 'gate',
          plan: p,
          policy: pol,
          archon,
          pkgs: 'a',
          milestone: 'm1',
          tag: 'gate-m1-r1',
          round: '1',
          risk: 'G0',
          r1: JSON.stringify(R('PASS')),
          c1: JSON.stringify({ ...C('a'), risk: 'G2' }),
        },
        SCRIPT,
        { WORKFLOW_ID: 'scratch-only' }
      );
    const exceeded = gate();
    expect(exceeded.code).toBe(0);
    expect(exceeded.out).toMatchObject({
      verdict: 'pass',
      grade: 'PASS',
      risk: 'G2',
      budget_advisory: 'budget_tokens_exceeded',
    });
    const observed = JSON.parse(readFileSync(p, 'utf8'));
    delete observed.budget.enforcement;
    writeFileSync(p, JSON.stringify(observed));
    expect(gate()).toMatchObject({ code: 0, out: { verdict: 'pass', grade: 'PASS' } });
    observed.budget.enforcement = 'hard';
    writeFileSync(p, JSON.stringify(observed));
    // Exactly the allowed final launch count is legal once actual tokens are within budget.
    events[3]!.data!.spend.tokens.value = { input: 5, output: 5 };
    writeFileSync(eventsFile, JSON.stringify({ events }));
    expect(gate()).toMatchObject({ code: 0, out: { verdict: 'pass', grade: 'PASS' } });
  });
  test('env: failing environment check exits 1 with failed list', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), { kind: 'env', plan: planFile(root, 'true', ['false']) });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, failed: ['false'] });
  });
  test('accept: passing command on clean tree is ok and logs output', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), {
      kind: 'accept',
      plan: planFile(root, 'echo accepted'),
      pkgs: 'a',
      tag: 'verify-a',
    });
    expect(r.out).toMatchObject({ ok: true, failed: [] });
    expect(readFileSync(join(r.art, 'verify-a.log'), 'utf8')).toContain('accepted');
  });
  test('P2: complete JUnit failures require identity-bound adjudication before becoming debt', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'false', ['true']);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const base = sh('git rev-parse HEAD', repo).trim();
    writeFileSync(join(repo, 'README.md'), 'candidate\n');
    sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    const xml =
      '<testsuite tests="1"><testcase classname="suite" name="case"><failure type="AssertionError" message="expected">body</failure></testcase></testsuite>';
    plan.packages[0].accept = [
      {
        cmd: `printf '%s' '${xml}' > junit.xml; exit 1`,
        timeout_s: 5,
        report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
        known_failures: [{ id: 'suite::case', reason: 'tracked environment issue' }],
      },
    ];
    writeFileSync(path, JSON.stringify(plan));
    const inputs = { kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a', base };
    const first = runScript(repo, inputs);
    expect(first.code, first.err).toBe(1);
    expect(first.out).toMatchObject({
      disposition: 'adjudicate',
      reason: 'acceptance_adjudication',
      decision: { kind: 'block', reason: 'acceptance_adjudication' },
      adjudication: { command: plan.packages[0].accept[0].cmd, failed_tests: ['suite::case'] },
    });
    const a = (first.out as { adjudication: Record<string, unknown> }).adjudication;
    mkdirSync(join(root, 'approvals'));
    writeFileSync(
      join(root, 'approvals', 'verify-a.json'),
      JSON.stringify({
        diff_hash: a.diff_hash,
        contract_hash: a.contract_hash,
        command: a.command,
        failed_tests: a.failed_tests,
        failure_digest: a.failure_digest,
        at: new Date().toISOString(),
      })
    );
    const approved = runScript(repo, inputs);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toMatchObject({
      ok: false,
      disposition: 'advance',
      decision: { kind: 'debt', reason: null },
      failures: [{ failure_class: 'test_env', adjudicated: true }],
    });
  });
  test('P2: cache:false failure body changes invalidate an approved adjudication', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'false', ['true']),
      body = join(root, 'failure-body');
    writeFileSync(body, 'first');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const base = sh('git rev-parse HEAD', repo).trim();
    writeFileSync(join(repo, 'README.md'), 'candidate\n');
    sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept = [
      {
        cmd: `printf '<testsuite tests="1"><testcase classname="suite" name="case"><failure>%s</failure></testcase></testsuite>' "$(cat '${body}')" > junit.xml; exit 1`,
        timeout_s: 5,
        cache: false,
        report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
        known_failures: [{ id: 'suite::case', reason: 'known' }],
      },
    ];
    writeFileSync(path, JSON.stringify(p));
    const inputs = { kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a', base };
    const first = runScript(repo, inputs);
    const adjudication = (first.out as { adjudication: Record<string, unknown> }).adjudication;
    mkdirSync(join(root, 'approvals'));
    writeFileSync(join(root, 'approvals', 'verify-a.json'), JSON.stringify(adjudication));
    expect(runScript(repo, inputs).out).toMatchObject({ disposition: 'advance' });
    writeFileSync(body, 'changed');
    const changed = runScript(repo, inputs);
    expect(changed.out).toMatchObject({
      disposition: 'adjudicate',
      adjudication: { failed_tests: ['suite::case'] },
    });
    expect(
      (changed.out as { adjudication: { failure_digest: string } }).adjudication.failure_digest
    ).not.toBe(adjudication.failure_digest);
  });
  test('P2: a newly skipped candidate case cannot be adjudicated', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'false', ['true']);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const base = sh('git rev-parse HEAD', repo).trim();
    writeFileSync(join(repo, 'README.md'), 'candidate\n');
    sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept = [
      {
        cmd: `if grep -q candidate README.md; then extra='<skipped/>'; else extra=''; fi; printf '<testsuite tests="2"><testcase classname="suite" name="failed"><failure>same</failure></testcase><testcase classname="suite" name="later">%s</testcase></testsuite>' "$extra" > junit.xml; exit 1`,
        timeout_s: 5,
        cache: false,
        report: { junit: 'junit.xml', collect: `printf 'suite::failed\\nsuite::later\\n'` },
        known_failures: [{ id: 'suite::failed', reason: 'known' }],
      },
    ];
    writeFileSync(path, JSON.stringify(p));
    const result = runScript(repo, {
      kind: 'accept',
      plan: path,
      pkgs: 'a',
      tag: 'verify-a',
      base,
    });
    expect(result.out).toMatchObject({
      disposition: 'repair',
      failures: [{ failure_class: 'unknown' }],
      command_results: [{ structured: { complete: true, skipped: ['suite::later'] } }],
    });
    expect(result.out).not.toHaveProperty('adjudication');
  });
  test('P2: report without collect remains unknown and cannot adjudicate', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'false', ['true']);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    plan.packages[0].accept = [
      {
        cmd: `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"><failure>body</failure></testcase></testsuite>' > junit.xml; exit 1`,
        timeout_s: 5,
        report: { junit: 'junit.xml' },
        known_failures: [{ id: 'suite::case', reason: 'known' }],
      },
    ];
    writeFileSync(path, JSON.stringify(plan));
    const out = runScript(repo, {
      kind: 'accept',
      plan: path,
      pkgs: 'a',
      tag: 'verify-a',
      base: sh('git rev-parse HEAD', repo).trim(),
    });
    expect(out.out).toMatchObject({
      disposition: 'repair',
      reason: 'acceptance_failed',
      failures: [{ failure_class: 'unknown' }],
    });
    expect(out.out).not.toHaveProperty('adjudication');
  });
  test.each([
    ['missing', 'true'],
    [
      'truncated',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/>' > junit.xml`,
    ],
    [
      'suite error',
      `printf '%s' '<testsuite tests="1"><error/><testcase classname="suite" name="case"/></testsuite>' > junit.xml`,
    ],
    [
      'duplicate id',
      `printf '%s' '<testsuite tests="2"><testcase classname="suite" name="case"/><testcase classname="suite" name="case"/></testsuite>' > junit.xml`,
    ],
    [
      'attributes without whitespace',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite"name="case"/></testsuite>' > junit.xml`,
    ],
    [
      'comment-only testcase',
      `printf '%s' '<testsuite tests="1"><!-- <testcase classname="suite" name="case"/> --></testsuite>' > junit.xml`,
    ],
  ])(
    'P2: exit zero with %s structured report fails closed and stays failed in cache',
    (_, command) => {
      const root = tmp(),
        repo = gitRepo(root),
        path = planFile(root, command);
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
      const p = JSON.parse(readFileSync(path, 'utf8'));
      p.packages[0].accept[0] = {
        cmd: command,
        timeout_s: 5,
        cache: true,
        report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
      };
      writeFileSync(path, JSON.stringify(p));
      for (const tag of ['verify-a', 'diff-m1-r1']) {
        const r = runScript(repo, { kind: 'accept', plan: path, pkgs: 'a', tag });
        expect(r.out).toMatchObject({
          ok: false,
          disposition: 'repair',
          failures: [{ failure_class: 'unknown' }],
          command_results: [{ pass: false }],
        });
      }
    }
  );
  test('P2: JUnit element discovery ignores comments and CDATA', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'true');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept[0] = {
      cmd: `printf '%s' '<testsuite tests="1"><!-- <testcase classname="fake" name="comment"/> --><![CDATA[<testcase classname="fake" name="cdata"/>]]><testcase classname="suite" name="case"/></testsuite>' > junit.xml`,
      timeout_s: 5,
      report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
    };
    writeFileSync(path, JSON.stringify(p));
    expect(
      runScript(repo, { kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a' }).out
    ).toMatchObject({
      ok: true,
      command_results: [{ structured: { complete: true, ids: ['suite::case'] } }],
    });
  });
  test.each([
    [
      'stale report',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml; touch -t 200001010000 junit.xml`,
      5,
    ],
    [
      'failure with exit zero',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"><failure>bad</failure></testcase></testsuite>' > junit.xml`,
      5,
    ],
    [
      'passing report with exit one',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml; exit 1`,
      5,
    ],
    [
      'collect mismatch',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="other"/></testsuite>' > junit.xml`,
      5,
    ],
    [
      'signal after report',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml; kill -TERM $$`,
      5,
    ],
    [
      'timeout after report',
      `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml; sleep 2`,
      0.05,
    ],
  ])('P2: %s cannot provide complete structured evidence', (_, command, timeout_s) => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, command);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept[0] = {
      cmd: command,
      timeout_s,
      report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
    };
    writeFileSync(path, JSON.stringify(p));
    expect(
      runScript(repo, { kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a' }).out
    ).toMatchObject({ disposition: 'repair', failures: [{ failure_class: 'unknown' }] });
  });
  test.each(['normal', 'strict', 'effective G2'])(
    'P2: %s structured baseline failure adjudication policy',
    mode => {
      const root = tmp(),
        repo = gitRepo(root),
        path = planFile(root, 'false', ['true']);
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
      const base = sh('git rev-parse HEAD', repo).trim();
      writeFileSync(join(repo, 'README.md'), 'candidate\n');
      sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
      const p = JSON.parse(readFileSync(path, 'utf8'));
      p.mode = mode === 'strict' ? 'strict' : 'single';
      p.packages[0].scope = { write: mode === 'effective G2' ? ['src/'] : ['README.md'] };
      p.packages[0].accept[0] = {
        cmd: `printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"><failure>body</failure></testcase></testsuite>' > junit.xml; exit 1`,
        timeout_s: 5,
        report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
      };
      writeFileSync(path, JSON.stringify(p));
      const policy = join(root, 'policy.json');
      writeFileSync(
        policy,
        JSON.stringify({
          effort: snapshotPolicy(loadTiers()).effort,
          risk_paths: mode === 'effective G2' ? ['README.md'] : [],
          code_extensions: ['.ts'],
          exempt_paths: [],
          budget_floor: {},
        })
      );
      const r = runScript(repo, {
        kind: 'accept',
        plan: path,
        pkgs: 'a',
        tag: 'verify-a',
        base,
        risk: 'G1',
        policy,
      });
      if (mode === 'normal') expect(r.out).toMatchObject({ disposition: 'adjudicate' });
      else {
        expect(r.out).toMatchObject({
          disposition: 'repair',
          failures: [{ failure_class: 'unknown' }],
        });
        expect(r.out).not.toHaveProperty('adjudication');
      }
    }
  );
  test('P2: multiple structured failures retain independent approvals', () => {
    const root = tmp(),
      repo = gitRepo(root),
      path = planFile(root, 'false', ['true']);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'a.xml\nb.xml\n');
    const xml = (id: string) =>
      `<testsuite tests="1"><testcase classname="suite" name="${id}"><failure>${id}</failure></testcase></testsuite>`;
    const command = (id: string) => `printf '%s' '${xml(id)}' > ${id}.xml; exit 1`;
    const base = sh('git rev-parse HEAD', repo).trim();
    writeFileSync(join(repo, 'README.md'), 'candidate\n');
    sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
    const p = JSON.parse(readFileSync(path, 'utf8'));
    p.packages[0].accept = ['a', 'b'].map(id => ({
      cmd: command(id),
      timeout_s: 5,
      report: { junit: `${id}.xml`, collect: `printf 'suite::${id}\\n'` },
    }));
    writeFileSync(path, JSON.stringify(p));
    const inputs = { kind: 'accept', plan: path, pkgs: 'a', tag: 'verify-a', base };
    const approvals: Record<string, unknown>[] = [];
    mkdirSync(join(root, 'approvals'));
    for (const expected of [command('a'), command('b')]) {
      const r = runScript(repo, inputs);
      expect(r.out).toMatchObject({ adjudication: { command: expected } });
      approvals.push((r.out as { adjudication: Record<string, unknown> }).adjudication);
      writeFileSync(join(root, 'approvals', 'verify-a.json'), JSON.stringify({ approvals }));
    }
    expect(runScript(repo, inputs).out).toMatchObject({
      disposition: 'advance',
      decision: { kind: 'debt' },
      failures: [{ adjudicated: true }, { adjudicated: true }],
    });
  });
  for (const [command, needs, kind, disposition, reason, code] of [
    ['false', [{ cap: 'environment' }], 'block', 'repair', 'environment', 0],
    [PRODUCT_FAILURE, [], 'repair', 'repair', 'acceptance_failed', 0],
    ['true', [{ cap: 'environment' }], 'advance', 'advance', null, 0],
  ] as const)
    test(`env-parity: ${command} with ${needs.length} environment needs -> ${kind}`, () => {
      const root = tmp();
      const r = runScript(gitRepo(root), {
        kind: 'accept',
        plan: planFile(root, command, [], false),
        pkgs: 'a',
        tag: 'verify-a',
        coder: JSON.stringify({ status: 'done', error_class: null, needs }),
      });
      expect(r.code, r.err).toBe(code);
      expect(r.out).toMatchObject({
        ok: command === 'true',
        disposition,
        reason,
        decision: { kind, reason },
      });
      if (kind === 'block') {
        expect(r.out).toMatchObject({
          decision: { evidence: [join(r.art, 'verify-a.log'), join(r.art, 'verify-a.coder.json')] },
        });
        expect(readFileSync(join(r.art, 'verify-a.coder.json'), 'utf8')).toContain('environment');
      }
    });
  test.each(['accept', 'probe'])('%s: acceptance commands exclude engine node variables', kind => {
    const root = tmp(),
      repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    if (kind === 'probe')
      sh('git rm -q README.md && git -c user.name=t -c user.email=t@l commit -qm rm', repo);
    const command = `bun -e 'const keys = Object.keys(process.env).filter(k => k.startsWith("INPUTS_") || ["WORKFLOW_ID", "ARTIFACTS_DIR", "SA_COORD_ADMISSION", "SUPERAGENT_ROLE"].includes(k)); if (keys.length || process.env.SA_PROBE_KEEP !== "1" || process.env.SUPERAGENT_HOME !== "kept-home" || !process.env.PATH || !process.env.HOME) process.exit(1); console.log("isolated")'`;
    const r = runScript(
      repo,
      {
        kind: 'accept',
        plan: planFile(root, kind === 'probe' ? `${command} && test -f README.md` : command, [
          'true',
        ]),
        pkgs: 'a',
        tag: 'verify-a',
        ...(kind === 'probe' ? { base } : {}),
      },
      SCRIPT,
      {
        INPUTS_UNUSED: 'node-input',
        WORKFLOW_ID: 'node-workflow',
        SA_COORD_ADMISSION: 'fixture-admission',
        SUPERAGENT_ROLE: 'worker',
        SUPERAGENT_HOME: 'kept-home',
        SA_PROBE_KEEP: '1',
      }
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject(kind === 'probe' ? { ok: false, base_pass: true } : { ok: true });
    expect(
      readFileSync(join(r.art, kind === 'probe' ? 'verify-a.probe.log' : 'verify-a.log'), 'utf8')
    ).toContain('isolated');
  });
  test('env: environment commands retain engine node variables', () => {
    const root = tmp();
    const command = `bun -e 'if (process.env.INPUTS_KIND !== "env" || process.env.INPUTS_UNUSED !== "node-input" || process.env.WORKFLOW_ID !== "node-workflow" || !process.env.ARTIFACTS_DIR || process.env.SA_COORD_ADMISSION !== "fixture-admission" || process.env.SUPERAGENT_ROLE !== "worker") process.exit(1)'`;
    const r = runScript(
      gitRepo(root),
      {
        kind: 'env',
        plan: planFile(root, 'true', [command]),
      },
      SCRIPT,
      {
        INPUTS_UNUSED: 'node-input',
        WORKFLOW_ID: 'node-workflow',
        SA_COORD_ADMISSION: 'fixture-admission',
        SUPERAGENT_ROLE: 'worker',
      }
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, failed: [] });
  });
  test('accept: archives the result and the coder output; blocked without needs or redline counts as partial', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const coder = (c: Record<string, unknown>, tag: string): unknown => {
      runScript(repo, {
        kind: 'accept',
        plan: planFile(root, 'true'),
        pkgs: 'a',
        tag,
        milestone: 'm1',
        coder: JSON.stringify({ error_class: null, needs: [], deviations: [], ...c }),
      });
      return JSON.parse(readFileSync(join(root, 'art', `${tag}.coder.json`), 'utf8'));
    };
    expect(coder({ status: 'blocked' }, 'verify-a')).toMatchObject({
      status: 'partial',
      milestone: 'm1',
    });
    expect(JSON.parse(readFileSync(join(root, 'art', 'verify-a.json'), 'utf8'))).toMatchObject({
      ok: true,
    });
    const need = { cap: 'network', why: 'w', minimal_ask: 'm' };
    expect(coder({ status: 'blocked', needs: [need] }, 'verify-b')).toMatchObject({
      status: 'blocked',
      needs: [need],
    });
    expect(JSON.parse(readFileSync(join(root, 'art', 'verify-b.json'), 'utf8'))).toMatchObject({
      ok: true,
      disposition: 'advance',
      self_report_conflict: true,
    });
    expect(coder({ status: 'blocked', error_class: 'redline' }, 'verify-c')).toMatchObject({
      status: 'blocked',
    });
    expect(coder({ status: 'done' }, 'verify-d')).toMatchObject({ status: 'done' });
    coder({ status: 'partial' }, 'verify-partial');
    expect(
      JSON.parse(readFileSync(join(root, 'art', 'verify-partial.json'), 'utf8'))
    ).toMatchObject({
      disposition: 'advance',
      coder_partial: true,
      ok: true,
    });
  }, 30_000); // Real sa-check subprocess rounds take ~5-10s; the 5s default flakes under load.
  test.each([
    ['partial', false, false, true],
    ['partial', false, false, false],
    ['done', false, false, true],
    ['partial', true, false, true],
    ['partial', false, true, true],
  ] as const)(
    'empty delivery: %s changed=%s previous-package=%s needs=%s',
    (status, changed, previous, hasNeeds) => {
      const root = tmp();
      const repo = gitRepo(root);
      const base = sh('git rev-parse HEAD', repo).trim();
      if (previous) sh('echo prior > prior && git add prior && git commit -qm prior', repo);
      const start = sh('git rev-parse HEAD', repo).trim();
      if (changed) sh('echo work > work && git add work && git commit -qm work', repo);
      const blockers = ['需要确认原始需求'];
      const needs = hasNeeds
        ? [{ cap: 'requirement_decision', why: '输入缺失', minimal_ask: '提供需求' }]
        : [];
      const r = runScript(repo, {
        kind: 'accept',
        plan: planFile(root, 'true'),
        pkgs: 'a',
        tag: 'verify-a',
        base,
        delta_base: start,
        coder: JSON.stringify({
          status,
          error_class: status === 'done' ? null : 'task',
          blockers,
          needs,
        }),
      });
      const blocked = status !== 'done' && !changed;
      expect(r.code, r.err).toBe(blocked ? 1 : 0);
      expect(r.out).toMatchObject({
        ok: true,
        no_changes: !changed,
        disposition: blocked ? 'fail' : 'advance',
        decision: blocked
          ? { kind: 'block', reason: hasNeeds ? 'coder_needs' : 'coder_partial', blockers, needs }
          : { kind: 'advance' },
      });
      // Subsequent decisions without a self-report must preserve the recorded block and details.
      expect(
        deliveryDecision({ rechecks: [r.out as Accept], reviewRounds: MAX_ROUNDS }).decision.kind
      ).toBe(blocked ? 'block' : 'advance');
    }
  );
  test('accept: uncommitted change fails even when commands pass', () => {
    const root = tmp();
    const repo = gitRepo(root);
    writeFileSync(join(repo, 'stray.txt'), 'x');
    expect(
      runScript(repo, { kind: 'accept', plan: planFile(root, 'true'), pkgs: 'a', tag: 'verify-a' })
        .out
    ).toMatchObject({ ok: false });
  });
  test('accept: timeout kills the command and fails it', () => {
    const root = tmp();
    const p = join(root, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ packages: [{ id: 'a', accept: [{ cmd: 'sleep 5', timeout_s: 1 }] }] })
    );
    const r = runScript(gitRepo(root), { kind: 'accept', plan: p, pkgs: 'a', tag: 'verify-a' });
    expect(r.out).toMatchObject({ ok: false, failed: ['sleep 5'] });
  });
  test('accept with base: writes patch and stable diff hash', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    sh(
      'echo y > y.txt && git add y.txt && git -c user.name=t -c user.email=t@l commit -qm y',
      repo
    );
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'true'),
      pkgs: 'a',
      tag: 'diff-m1',
      base,
    });
    const out = r.out as { patch: string; diff_hash: string };
    expect(readFileSync(out.patch, 'utf8')).toContain('+y');
    expect(out.diff_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.out).toMatchObject({ ok: true, base_pass: null, same: false });
    const again = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'true'),
      pkgs: 'a',
      tag: 'diff-m1-r2',
      base,
      prev: out.diff_hash,
      reviewed_diff_hash: out.diff_hash,
    });
    expect(again.out).toMatchObject({ diff_hash: out.diff_hash, same: true, reviewed: true });
  });
  test('accept keeps binary patch and checkout evidence on disk with bounded stdout', () => {
    const root = tmp(),
      repo = gitRepo(root),
      base = sh('git rev-parse HEAD', repo).trim();
    sh(
      'head -c 2300000 /dev/urandom > image.png && git add image.png && git -c user.name=t -c user.email=t@l commit -qm image',
      repo
    );
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'head -c 2300000 /dev/urandom > image.png'),
      pkgs: 'a',
      tag: 'diff-large',
      base,
    });
    const out = r.out as { patch: string; checkout_fingerprint: string };
    expect(r.stdoutBytes).toBeLessThan(64 * 1024);
    expect(statSync(out.patch).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(statSync(out.checkout_fingerprint).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(readFileSync(out.checkout_fingerprint, 'utf8')).toBe(
      checkoutFingerprint(args => Bun.spawnSync(['git', '-C', repo, ...args]))
    );
  });
  test.each(['unchanged', 'dirty-content', 'commit', 'missing', 'git-failure', 'probe-failure'])(
    'gate checkout integrity: %s',
    mode => {
      const root = tmp(),
        repo = gitRepo(root),
        plan = fixturePlan(root, repo);
      if (mode === 'dirty-content') writeFileSync(join(repo, 'README.md'), 'before');
      const accepted = runScript(repo, { kind: 'accept', plan, pkgs: 'core', tag: 'diff-m1-r1' });
      const check = accepted.out as Accept;
      if (mode === 'dirty-content') writeFileSync(join(repo, 'README.md'), 'after');
      if (mode === 'commit') sh('git commit --allow-empty -qm reviewer', repo);
      if (mode === 'missing') check.checkout_fingerprint = '';
      const before = sh('git status --porcelain', repo);
      const head = sh('git rev-parse HEAD', repo);
      const extraEnv: Record<string, string> = {};
      if (mode === 'git-failure' || mode === 'probe-failure') {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'git'),
          `#!/bin/sh\nif [ "$1" = ${mode === 'probe-failure' ? 'rev-parse' : 'status'} ] ${mode === 'probe-failure' ? '&& [ "$2" = --is-inside-work-tree ]' : ''}; then echo evidence-unavailable >&2; exit 1; fi\nexec /usr/bin/git "$@"\n`,
          { mode: 0o755 }
        );
        extraEnv.PATH = `${bin}:${process.env.PATH}`;
      }
      const gated = runScript(
        repo,
        {
          kind: 'gate',
          plan,
          round: '1',
          risk: 'G2',
          milestone: 'm1',
          pkgs: 'core',
          tag: 'gate-m1-r1',
          r1: JSON.stringify(R('PASS')),
          c1: JSON.stringify({
            ...check,
            ok: true,
            failed: [],
            failures: [],
            command_results: [],
            disposition: 'advance',
            decision: undefined,
          }),
        },
        SCRIPT,
        extraEnv
      );
      expect(gated.code, gated.err).toBe(mode === 'unchanged' ? 0 : 1);
      expect(gated.out).toMatchObject(
        mode === 'unchanged'
          ? { verdict: 'pass' }
          : { verdict: 'escalate', reason: 'review_modified_checkout', decision: { kind: 'block' } }
      );
      expect(gated.out).toMatchObject({ head: head.trim(), head_trusted: mode === 'unchanged' });
      expect(sh('git status --porcelain', repo)).toBe(before);
      expect(sh('git rev-parse HEAD', repo)).toBe(head);
    }
  );

  test('gate: fix verdict writes review file and gate json; deadline passed escalates with exit 1', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const plan = (deadline: string): string => {
      const p = join(root, `plan-${deadline.slice(0, 4)}.json`);
      writeFileSync(p, JSON.stringify({ deadline, packages: [] }));
      return p;
    };
    const inputs = {
      kind: 'gate',
      round: '1',
      r1: JSON.stringify(R('FAIL', [f('high')])),
      c1: JSON.stringify(C('a')),
      risk: 'G1',
      milestone: 'm1',
      tag: 'gate-m1-r1',
    };
    const fix = runScript(repo, { ...inputs, plan: plan('2099-01-01T00:00:00Z') });
    expect(fix.code).toBe(0);
    const out = fix.out as { verdict: string; review_file: string };
    expect(out.verdict).toBe('fix');
    expect(JSON.parse(readFileSync(out.review_file, 'utf8'))).toMatchObject({ status: 'FAIL' });
    const late = runScript(repo, { ...inputs, plan: plan('2000-01-01T00:00:00Z') });
    expect(late.code).toBe(1);
    expect(JSON.parse(readFileSync(join(late.art, 'gate-m1-r1.json'), 'utf8'))).toMatchObject({
      verdict: 'escalate',
      reason: 'deadline',
    });
  });
  test.each([{ setup: [] }, { setup: ['false'] }])(
    'probe: untrusted environment %j yields unknown without rerunning checks',
    ({ setup }) => {
      const root = tmp(),
        repo = gitRepo(root);
      const base = sh('git rev-parse HEAD', repo).trim();
      const trace = join(root, 'checks.txt');
      const command = `printf '%s\\n' "$PWD" >> '${trace}'; false`;
      const r = runScript(repo, {
        kind: 'accept',
        plan: planFile(root, command, [...setup]),
        pkgs: 'a',
        tag: 'unknown',
        base,
      });
      expect(r.out).toMatchObject({
        ok: false,
        failed: [command],
        base_pass: null,
        base_results: [],
        disposition: 'repair',
      });
      expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([repo]);
      const log = readFileSync(join(r.art, 'unknown.probe.log'), 'utf8');
      expect(log).toContain(
        setup.length ? 'environment preparation failed' : 'no environment commands declared'
      );
      expect(log).not.toContain(`$ ${command}`);
      expect(sh('git worktree list', repo).trim().split('\n')).toHaveLength(1);
    }
  );
  test('probe: prepares plan and every package environment in order only inside its worktree', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    const command =
      'if [ "$(cat .probe-dependency 2>/dev/null)" = plan-package-other ]; then rm .probe-dependency; echo prepared; fi; false';
    const plan = fixturePlan(root, repo, p => {
      p.environment = [{ cmd: 'printf plan > .probe-dependency', timeout_s: 5 }];
      p.packages = [
        {
          id: 'a',
          environment: [{ cmd: 'printf -- -package >> .probe-dependency', timeout_s: 5 }],
          accept: [{ cmd: command, timeout_s: 5 }],
        },
        {
          id: 'unselected',
          environment: [{ cmd: 'printf -- -other >> .probe-dependency', timeout_s: 5 }],
          accept: [],
        },
      ];
    });
    const r = runScript(repo, { kind: 'accept', plan, pkgs: 'a', tag: 'prepared', base });
    expect(r.out).toMatchObject({
      ok: false,
      base_pass: null,
      base_results: [{ cmd: command, pass: null }],
      disposition: 'repair',
    });
    expect(readFileSync(join(r.art, 'prepared.probe.log'), 'utf8')).toContain(
      '\nprepared\n# exit=1'
    );
    expect(readFileSync(join(r.art, 'prepared.log'), 'utf8')).not.toContain('\nprepared\n');
    expect(sh('git status --porcelain', repo)).toBe('');
    expect(sh('git worktree list', repo).trim().split('\n')).toHaveLength(1);
  });
  test('accept with base: failing command is probed at base (pre-existing vs introduced)', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    sh('git rm -q README.md && git -c user.name=t -c user.email=t@l commit -qm rm', repo);
    const introduced = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'test -f README.md', ['true']),
      pkgs: 'a',
      tag: 'v1',
      base,
    });
    expect(introduced.out).toMatchObject({ ok: false, base_pass: true });
    expect(readFileSync(join(introduced.art, 'v1.probe.log'), 'utf8')).toContain('exit=0');
    const preexisting = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'test -f nope', ['true']),
      pkgs: 'a',
      tag: 'v2',
      base,
    });
    expect(preexisting.out).toMatchObject({ ok: false, base_pass: null, baseline: 'incomparable' });
    expect(sh('git worktree list', repo).trim().split('\n')).toHaveLength(1);
  });
  test('RA: probe records each base result without letting self-report suppress repair', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    sh('git rm -q README.md && git -c user.name=t -c user.email=t@l commit -qm rm', repo);
    const commands = ['test -f README.md', 'test -f nope'];
    const plan = fixturePlan(root, repo, p => {
      p.environment = [{ cmd: 'true', timeout_s: 5 }];
      p.packages = [{ id: 'a', accept: commands.map(cmd => ({ cmd, timeout_s: 5 })) }];
    });
    const r = runScript(repo, {
      kind: 'accept',
      plan,
      pkgs: 'a',
      tag: 'mixed',
      base,
      coder: JSON.stringify({ status: 'blocked', error_class: 'env', needs: [{ cap: 'network' }] }),
    });
    const base_results = [
      { cmd: commands[0], pass: true },
      {
        cmd: commands[1],
        pass: null,
        reason: 'baseline incomparable: exit=1; failure_class=unknown',
      },
    ];
    expect(r).toMatchObject({
      code: 0,
      out: {
        ok: false,
        base_pass: null,
        disposition: 'repair',
        base_results,
        failures: commands.map(command => ({ command, failure_class: 'unknown' })),
      },
    });
    expect(JSON.parse(readFileSync(join(r.art, 'mixed.json'), 'utf8'))).toMatchObject({
      base_results,
    });
    expect(readFileSync(join(r.art, 'mixed.log'), 'utf8').trimEnd().split('\n').at(-1)).toContain(
      JSON.stringify(base_results)
    );
  });
  test('probe: dirty disposable worktree lives in artifacts and is unregistered on cleanup', () => {
    const root = tmp(),
      repo = gitRepo(root),
      trace = join(root, 'probe-path');
    const base = sh('git rev-parse HEAD', repo).trim();
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'echo x > junk.txt; false', [`pwd > '${trace}'`]),
      pkgs: 'a',
      tag: 'v3',
      base,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: false, base_results: [{ pass: null }] });
    const path = readFileSync(trace, 'utf8').trim();
    expect(path.startsWith(join(r.art, 'probe-v3-'))).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(sh('git worktree list', repo).trim().split('\n')).toHaveLength(1);
  });
  test('probe: rename failure preserves baseline results and logs the retained path', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, PRODUCT_FAILURE, ['touch ../.trash']),
      pkgs: 'a',
      tag: 'rename-fail',
      base: sh('git rev-parse HEAD', repo).trim(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({
      base_pass: false,
      base_results: [{ cmd: PRODUCT_FAILURE, pass: false }],
    });
    expect(r.err).toContain(`probe: kept worktree ${r.art}/probe-rename-fail-`);
    expect(readFileSync(join(r.art, 'rename-fail.probe.log'), 'utf8')).toContain(r.err.trim());
  });
  test('land: fast-forward when base is an ancestor, no-ff otherwise; never pushes', () => {
    const root = tmp();
    const repo = gitRepo(root);
    sh(
      'git switch -qc sa/x && echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@l commit -qm z',
      repo
    );
    const plan = join(root, 'plan.json');
    writeFileSync(plan, JSON.stringify({ deadline: '2099-01-01T00:00:00Z', packages: [] }));
    const ff = runScript(repo, { kind: 'land', base_ref: 'origin/main', plan }).out as {
      commands: string[];
    };
    expect(ff.commands[1]).toContain("merge --ff-only 'sa/x'");
    expect(ff.commands.join(' ')).not.toContain('push');
    sh(
      'git switch -q main && echo w > w.txt && git add w.txt && git -c user.name=t -c user.email=t@l commit -qm w && git switch -q sa/x',
      repo
    );
    expect(
      (runScript(repo, { kind: 'land', base_ref: 'main', plan }).out as { commands: string[] })
        .commands[1]
    ).toContain('--no-ff');
  });
  for (const base of ['main', 'origin/main', 'refs/heads/main', 'sha'] as const)
    test(`LAND: ${base} uses a verified local branch without changing the comparison base`, () => {
      const root = tmp(),
        repo = gitRepo(root);
      const sha = sh('git rev-parse HEAD', repo).trim();
      const plan = fixturePlan(root, repo);
      const ledger = join(root, 'ledger.json');
      writeFileSync(ledger, JSON.stringify({ launch_branch: base === 'sha' ? 'main' : 'wrong' }));
      sh('git switch -qc sa/land', repo);
      const result = runScript(repo, {
        kind: 'land',
        base_ref: base === 'sha' ? sha : base,
        plan,
        operator_ledger: ledger,
      });
      expect(result.code, result.err).toBe(0);
      expect(result.out).toMatchObject({
        commands: [`git -C '${repo}' switch 'main'`, `git -C '${repo}' merge --ff-only 'sa/land'`],
      });
      expect(sh('git branch --show-current', repo).trim()).toBe('sa/land');
    });

  for (const sample of ['missing-ledger', 'old-ledger', 'missing-branch', 'missing-base'] as const)
    test(`LAND: ${sample} records why manual target selection is needed and emits no commands`, () => {
      const root = tmp(),
        repo = gitRepo(root);
      const sha = sh('git rev-parse HEAD', repo).trim();
      const plan = fixturePlan(root, repo);
      const ledger = join(root, 'ledger.json');
      if (sample !== 'missing-ledger')
        writeFileSync(
          ledger,
          JSON.stringify(
            sample === 'old-ledger'
              ? {}
              : { launch_branch: sample === 'missing-base' ? 'main' : 'deleted' }
          )
        );
      sh('git switch -qc sa/land', repo);
      const result = runScript(repo, {
        kind: 'land',
        base_ref: sample === 'missing-base' ? 'missing' : sha,
        plan,
        operator_ledger: ledger,
      });
      expect(result.code).toBe(1);
      expect(result.out).toMatchObject({
        reason: 'land_target_unknown',
        commands: [],
        error: expect.stringContaining('No existing local merge target'),
        action: expect.stringContaining('git show-ref --verify refs/heads/<branch>'),
      });
      expect(JSON.parse(readFileSync(join(result.art, 'land.json'), 'utf8'))).toEqual(result.out);
      expect(sh('git branch --show-current', repo).trim()).toBe('sa/land');
    });

  test('land: carries the last gate debt per milestone; refuses past the plan deadline', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const art = join(root, 'art');
    mkdirSync(art, { recursive: true });
    const gate = (name: string, debt: string[]): void => {
      writeFileSync(join(art, `${name}.json`), JSON.stringify({ verdict: 'pass', debt }));
    };
    gate('gate-m1-r1', ['stale']);
    gate('gate-m1-r2', ['m1 debt']);
    gate('gate-m2-r1', ['m2 debt']);
    const plan = (deadline: string): string => {
      const p = join(root, `plan-${deadline.slice(0, 4)}.json`);
      writeFileSync(p, JSON.stringify({ deadline, packages: [] }));
      return p;
    };
    const ok = runScript(repo, {
      kind: 'land',
      base_ref: 'main',
      plan: plan('2099-01-01T00:00:00Z'),
    });
    expect(ok.out).toMatchObject({ debt: ['m1 debt', 'm2 debt'] });
    const late = runScript(repo, {
      kind: 'land',
      base_ref: 'main',
      plan: plan('2000-01-01T00:00:00Z'),
    });
    expect(late.code).toBe(1);
    expect(late.err).toContain('deadline');
    expect(JSON.parse(readFileSync(join(art, 'land.json'), 'utf8'))).toMatchObject({
      debt: ['m1 debt', 'm2 debt'],
    });
  });
  test('self-reported redline does not suppress product repair', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), {
      kind: 'accept',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'verify-a',
      coder: JSON.stringify({ status: 'blocked', error_class: 'redline', needs: [] }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: false, disposition: 'repair', reason: 'acceptance_failed' });
  });
  test('HF1: self-report error_class stays diagnostic in the coder archive', () => {
    const root = tmp();
    const repo = gitRepo(root);
    for (const [error_class, acceptance, disposition, reason, code] of [
      ['task', 'true', 'advance', null, 0],
      ['task', PRODUCT_FAILURE, 'repair', 'acceptance_failed', 0],
      ['redline', 'true', 'advance', null, 0],
      ['redline', PRODUCT_FAILURE, 'repair', 'acceptance_failed', 0],
    ] as const) {
      const tag = `verify-${error_class}-${acceptance}`;
      const r = runScript(repo, {
        kind: 'accept',
        plan: planFile(root, acceptance),
        pkgs: 'a',
        tag,
        coder: JSON.stringify({ status: 'done', error_class, needs: [] }),
      });
      expect(r.code).toBe(code);
      expect(r.out).toMatchObject({ ok: acceptance === 'true', disposition, reason });
      if (error_class === 'redline' && acceptance === 'true')
        expect(r.out).toMatchObject({ self_report_conflict: true, error_class_ignored: true });
      const saved = JSON.parse(readFileSync(join(r.art, `${tag}.coder.json`), 'utf8'));
      expect(saved).toMatchObject({ status: 'done', error_class });
      expect(saved.error_class_ignored).toBe(true);
    }
  });
  test('HF1: settle advances a green done repair even when error_class is task', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), {
      kind: 'settle',
      plan: planFile(root, 'true'),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify({ ok: false, disposition: 'repair', reason: 'acceptance_failed' }),
      repaired: JSON.stringify({ status: 'done', error_class: 'task', needs: [] }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual({
      diff_hash: '',
      head: sh('git rev-parse HEAD', join(root, 'repo')).trim(),
    });
    expect(JSON.parse(readFileSync(join(r.art, 'settle-a.json'), 'utf8'))).toMatchObject({
      ok: true,
      disposition: 'advance',
      reason: null,
    });
    expect(JSON.parse(readFileSync(join(r.art, 'settle-a.coder.json'), 'utf8'))).toMatchObject({
      status: 'done',
      error_class: 'task',
      error_class_ignored: true,
    });
  });
  test('F-18 settle: advance passes through; a repair that stays red fails repair_exhausted', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const first = {
      ok: true,
      disposition: 'advance',
      reason: null,
      diff_hash: 'delivered',
      head: sh('git rev-parse HEAD', repo).trim(),
      same: false,
    };
    mkdirSync(join(root, 'art'));
    writeFileSync(join(root, 'art', 'verify-a.json'), JSON.stringify(first));
    const pass = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'settle-a',
      first: 'advance',
      repaired: 'null',
    });
    expect(pass.code).toBe(0);
    expect(pass.out).toEqual({ diff_hash: 'delivered', head: first.head });
    writeFileSync(join(root, 'art', 'final-accept-m1.json'), JSON.stringify(first));
    const final = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'final-settle-m1',
      first: 'advance',
      repaired: 'null',
      full_output: '1',
    });
    expect(final.code).toBe(0);
    expect(final.out).toMatchObject(first);
    writeFileSync(
      join(root, 'art', 'verify-a.json'),
      JSON.stringify({
        ...first,
        log: '/changed.log',
        decision: { kind: 'debt', reason: null, evidence: ['/changed.log'], debt: ['fixture'] },
      })
    );
    const auditChanged = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'settle-a',
      first: 'advance',
      repaired: 'null',
    });
    expect(auditChanged.out).toEqual(pass.out);
    const red = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify({ ...first, ok: false, disposition: 'repair' }),
      repaired: JSON.stringify({ status: 'done', error_class: null, needs: [] }),
    });
    expect(red.code).toBe(1);
    expect(red.out).toMatchObject({
      disposition: 'fail',
      reason: 'repair_exhausted:acceptance_failed',
    });
  });
  test('final accept explicitly makes repair terminal', () => {
    const root = tmp();
    const result = runScript(gitRepo(root), {
      kind: 'accept',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'final-accept-m1',
      terminal: '1',
      coder: '{"status":"done","error_class":null}',
    });
    expect(result.code).toBe(1);
    expect(result.out).toMatchObject({
      disposition: 'fail',
      decision: { kind: 'block' },
    });
  });
  test('F-21: node evidence reuses cache:false checks on the same head; a new head reruns', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const p = join(root, 'plan.json');
    const counter = join(root, 'n');
    writeFileSync(
      p,
      JSON.stringify({
        packages: [
          {
            id: 'a',
            accept: [
              { cmd: `echo c >> ${counter}`, timeout_s: 5 },
              { cmd: `echo u >> ${counter}`, timeout_s: 5, cache: false },
            ],
          },
        ],
      })
    );
    const go = (tag: string, acceptance_evidence = '') =>
      runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag, acceptance_evidence }).out;
    expect(go('verify-a')).toMatchObject({ ok: true });
    const evidence = join(root, 'art', 'verify-a.json');
    expect(go('diff-m1-r1', evidence)).toMatchObject({ ok: true });
    expect(readFileSync(counter, 'utf8')).toBe('c\nu\n');
    expect(readFileSync(join(root, 'art', 'diff-m1-r1.log'), 'utf8')).toContain(
      'reused stable acceptance from'
    );
    sh(
      'echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@l commit -qm z',
      repo
    );
    go('diff-m1-r2', evidence);
    expect(readFileSync(counter, 'utf8')).toBe('c\nu\nc\nu\n');
  });
  test('delivery-truth: cache binds filtered command environment and private context, never legacy identity', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = join(root, 'plan.json');
    const counter = join(root, 'n'),
      art = join(root, 'art'),
      cache = join(art, 'accept-cache');
    const cmd = `echo x >> ${counter}; test "$SA_REVIEW_MODE" = good && bun -e 'if (Object.keys(process.env).some(k => k.startsWith("INPUTS_") || ["ARCHON_NODE_EXECUTION", "TYPED_ARTIFACTS_FILE", "STATE_DIR", "LOG_DIR", "BASE_BRANCH", "USER_MESSAGE", "CONTEXT"].includes(k))) process.exit(1)'`;
    const check = { cmd, timeout_s: 5, cache: true };
    const claudeEnv = {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      PATH: '/bin',
    };
    const owner = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { stripCwdEnv } from ${JSON.stringify(join(import.meta.dir, '../../packages/paths/src/strip-cwd-env.ts'))}; stripCwdEnv(${JSON.stringify(root)}); console.log(JSON.stringify(process.env));`,
      ],
      { env: claudeEnv, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(owner.exitCode).toBe(0);
    const ownerEnv = JSON.parse(owner.stdout.toString()) as NodeJS.ProcessEnv;
    for (const key of Object.keys(claudeEnv))
      expect(projectEnvironment(claudeEnv)[key]).toBe(ownerEnv[key]);
    writeFileSync(p, JSON.stringify({ packages: [{ id: 'a', accept: [check] }] }));
    const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    mkdirSync(cache, { recursive: true });
    const legacy = hash([sh('git rev-parse HEAD^{tree}', repo).trim(), cmd, 5, hash([])]);
    writeFileSync(join(cache, legacy), JSON.stringify({ tag: 'legacy', failure: null }));
    const sentinel = 'private-environment-sentinel-ARCH-R1-01';
    const go = (tag: string, mode = 'good', extra: Record<string, string> = {}) =>
      runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag }, SCRIPT, {
        SA_REVIEW_MODE: mode,
        SA_CACHE_SENTINEL: sentinel,
        ...extra,
      });
    // A legacy pass must not hide a real failure.
    expect(go('legacy-rejected', 'bad').out).toMatchObject({ ok: false });
    expect(go('first').out).toMatchObject({ ok: true });
    expect(go('same').out).toMatchObject({ ok: true });
    expect(
      go('excluded', 'good', {
        INPUTS_UNUSED: 'changed',
        WORKFLOW_ID: 'changed',
        SA_COORD_ADMISSION: 'changed',
        SUPERAGENT_ROLE: 'changed',
        PWD: '/changed',
        SHLVL: '99',
        TERM_SESSION_ID: 'changed',
        _: '/changed/bun',
        ARCHON_RUN_ID: 'changed',
        ARCHON_DETACHED_RUN: 'changed',
        SUPERAGENT_SESSION_ID: 'changed',
        CLAUDE_CODE_ENTRYPOINT: 'changed',
        CLAUDE_PID: 'changed',
        AI_AGENT: 'changed',
        CODEX_COMPANION_SESSION: 'changed',
        ARCHON_NODE_EXECUTION: 'changed',
        TYPED_ARTIFACTS_FILE: 'changed',
        STATE_DIR: 'changed',
        LOG_DIR: 'changed',
        BASE_BRANCH: 'changed',
        USER_MESSAGE: 'changed',
        CONTEXT: 'changed',
      }).out
    ).toMatchObject({ ok: true });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
    expect(go('path-changed', 'good', { PATH: `${process.env.PATH}:/changed` }).out).toMatchObject({
      ok: true,
    });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\n');
    expect(go('changed', 'worse').out).toMatchObject({ ok: false });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\n');
    const keyPath = join(cache, '.key'),
      key = readFileSync(keyPath);
    expect(key.length).toBe(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    for (const dir of [art, cache])
      for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        if (path === keyPath || !statSync(path).isFile()) continue;
        const bytes = readFileSync(path);
        expect(bytes.includes(key)).toBe(false);
        expect(bytes.toString()).not.toContain(sentinel);
        expect(bytes.toString()).not.toContain(key.toString('hex'));
        expect(bytes.toString()).not.toContain(key.toString('base64'));
      }
    unlinkSync(keyPath);
    expect(go('lost-context').out).toMatchObject({ ok: true });
    expect(readFileSync(keyPath).equals(key)).toBe(false);
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\nx\n');
    writeFileSync(join(repo, 'dirty.txt'), 'dirty');
    expect(go('dirty').out).toMatchObject({ ok: false, workspace_clean: false });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\nx\nx\n');
  }, 10_000);
  test('U5: hmac-v1 cache entries cannot satisfy the new identity version', () => {
    const root = tmp(),
      repo = gitRepo(root),
      art = join(root, 'art');
    const counter = join(root, 'executions');
    const p = planFile(root, `echo executed >> '${counter}'`, [], true);
    const scripts = join(root, 'scripts');
    cpSync(join(import.meta.dir, '../templates/.archon/scripts'), scripts, { recursive: true });
    cpSync(
      join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'),
      join(scripts, 'policy-attempts.ts')
    );
    const legacy = join(scripts, 'sa-check.ts');
    writeFileSync(legacy, readFileSync(legacy, 'utf8').replace("'hmac-v2'", "'hmac-v1'"));
    const inputs = { kind: 'accept', plan: p, pkgs: 'a', tag: 'old-version' };
    const node = acceptanceNodeEnvironment(art, 'old-version');
    expect(runScript(repo, inputs, legacy, node, true).code).toBe(0);
    expect(runScript(repo, { ...inputs, tag: 'current-version' }, SCRIPT, node).code).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('executed\nexecuted\n');
    expect(runScript(repo, { ...inputs, tag: 'current-reuse' }, SCRIPT, node).code).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('executed\nexecuted\n');
  });
  test('P2: junit-v1 cache entries cannot satisfy the current adapter', () => {
    const root = tmp(),
      repo = gitRepo(root),
      art = join(root, 'art'),
      counter = join(root, 'executions'),
      p = planFile(root, 'true');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const plan = JSON.parse(readFileSync(p, 'utf8'));
    plan.packages[0].accept[0] = {
      cmd: `echo executed >> '${counter}'; printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml`,
      timeout_s: 5,
      report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
    };
    writeFileSync(p, JSON.stringify(plan));
    const scripts = join(root, 'scripts');
    cpSync(join(import.meta.dir, '../templates/.archon/scripts'), scripts, { recursive: true });
    cpSync(
      join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'),
      join(scripts, 'policy-attempts.ts')
    );
    const legacy = join(scripts, 'sa-check.ts');
    writeFileSync(legacy, readFileSync(legacy, 'utf8').replace("'junit-v2'", "'junit-v1'"));
    const node = acceptanceNodeEnvironment(art, 'old-adapter');
    expect(
      runScript(
        repo,
        { kind: 'accept', plan: p, pkgs: 'a', tag: 'old-adapter' },
        legacy,
        node,
        true
      ).code
    ).toBe(0);
    expect(
      runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag: 'current' }, SCRIPT, node).code
    ).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('executed\nexecuted\n');
  });
  test.each(['missing', 'incomplete'])(
    'P2: %s cached structured output reruns the report check',
    state => {
      const root = tmp(),
        repo = gitRepo(root),
        counter = join(root, 'executions'),
        p = planFile(root, 'true');
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
      const plan = JSON.parse(readFileSync(p, 'utf8'));
      plan.packages[0].accept[0] = {
        cmd: `echo executed >> '${counter}'; printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"/></testsuite>' > junit.xml`,
        timeout_s: 5,
        report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
      };
      writeFileSync(p, JSON.stringify(plan));
      const first = runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag: 'first' });
      expect(first.code, first.err).toBe(0);
      const cache = join(first.art, 'accept-cache');
      const entry = join(cache, readdirSync(cache).find(name => name !== '.key')!);
      const saved = JSON.parse(readFileSync(entry, 'utf8'));
      if (state === 'missing') delete saved.structured;
      else saved.structured.complete = false;
      writeFileSync(entry, JSON.stringify(saved));
      const rerun = runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag: 'rerun' });
      expect(rerun.code, rerun.err).toBe(0);
      expect(readFileSync(counter, 'utf8')).toBe('executed\nexecuted\n');
    }
  );
  test('U5: real node environments reuse output and contract; identity changes execute again', () => {
    const root = tmp(),
      repo = gitRepo(root),
      art = join(root, 'art');
    const counter = join(root, 'executions'),
      p = join(root, 'plan.json');
    const check = {
      cmd: `echo executed >> '${counter}'; echo original-stdout; echo original-stderr >&2`,
      timeout_s: 5,
      cache: true,
    };
    const plan = {
      packages: [{ id: 'a', accept: [check] }],
      environment: [] as { cmd: string; timeout_s: number }[],
    };
    const go = (tag: string, extra: Record<string, string> = {}) => {
      writeFileSync(p, JSON.stringify(plan));
      const result = runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag }, SCRIPT, {
        ...acceptanceNodeEnvironment(art, tag),
        ...extra,
      });
      expect(result.code, result.err).toBe(0);
      return result.out as Accept;
    };
    const count = () => readFileSync(counter, 'utf8').trim().split('\n').length;
    const first = go('verify-a'),
      second = go('diff-m1-r1');
    expect(count()).toBe(1);
    expect(second.contract_hash).toBe(first.contract_hash);
    const replay = readFileSync(join(art, 'diff-m1-r1.log'), 'utf8');
    expect(replay).toContain('# reused pass from verify-a');
    expect(replay).toContain('original-stdout\noriginal-stderr\n');
    for (const [tag, path] of [
      ['tracked', 'README.md'],
      ['untracked', 'new.txt'],
    ]) {
      const file = join(repo, path!);
      const original = existsSync(file) ? readFileSync(file) : null;
      writeFileSync(file, 'changed');
      const before = count();
      for (let i = 0; i < 2; i++) {
        const result = runScript(
          repo,
          { kind: 'accept', plan: p, pkgs: 'a', tag: `${tag}-${i}` },
          SCRIPT,
          acceptanceNodeEnvironment(art, tag!)
        );
        expect(result.out).toMatchObject({ workspace_clean: false, ok: false });
      }
      expect(count()).toBe(before + 2);
      if (original) writeFileSync(file, original);
      else unlinkSync(file);
    }
    check.cache = false;
    go('uncached-1');
    go('uncached-2');
    expect(count()).toBe(7);
    check.cache = true;
    go('project-changed', { SA_U5_PROJECT: 'changed' });
    expect(count()).toBe(8);
    plan.environment = [{ cmd: 'true', timeout_s: 5 }];
    go('env-key-changed');
    expect(count()).toBe(9);
    check.timeout_s++;
    go('timeout-changed');
    expect(count()).toBe(10);
    sh(
      'echo changed > README.md && git add README.md && git -c user.name=t -c user.email=t@l commit -qm changed',
      repo
    );
    go('tree-changed');
    expect(count()).toBe(11);
  });
  test('delivery-truth: concurrent cache initialization publishes one complete private key', async () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = planFile(root, 'true'),
      frozenPolicy = join(root, 'policy.json');
    writeFileSync(frozenPolicy, JSON.stringify(snapshotPolicy(loadTiers())));
    const art = join(root, 'art');
    mkdirSync(art);
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('INPUTS_') && k !== 'WORKFLOW_ID')
    );
    const children = [1, 2, 3].map(i =>
      Bun.spawn(['bun', SCRIPT], {
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...inherited,
          ARTIFACTS_DIR: art,
          INPUTS_KIND: 'accept',
          INPUTS_PLAN: p,
          INPUTS_POLICY: frozenPolicy,
          INPUTS_PKGS: 'a',
          INPUTS_TAG: `parallel-${i}`,
        },
      })
    );
    for (const child of children) {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ ok: true });
    }
    const cache = join(art, 'accept-cache');
    expect(readdirSync(cache).filter(f => f !== '.key')).toHaveLength(1);
    expect(readFileSync(join(cache, '.key')).length).toBe(32);
    expect(statSync(join(cache, '.key')).mode & 0o777).toBe(0o600);
  }, 10_000);
  test('FC legacy cache default product cannot hide an unclassified command', () => {
    const root = tmp(),
      repo = gitRepo(root),
      counter = join(root, 'count');
    const command = `echo x >> '${counter}'; false`;
    const legacy = join(root, 'legacy.ts');
    const currentScript = readFileSync(SCRIPT, 'utf8');
    const legacyScript = currentScript.replace('        FAILURE_CLASSES,\n', '');
    expect(legacyScript).not.toBe(currentScript);
    cpSync(join(import.meta.dir, '../templates/.archon/scripts'), root, { recursive: true });
    writeFileSync(
      join(root, 'policy-attempts.ts'),
      readFileSync(join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'))
    );
    writeFileSync(
      legacy,
      legacyScript.replace(
        'failure_class: failureClass(classification)',
        "failure_class: 'product'"
      )
    );
    const plan = planFile(root, command, [], true);
    expect(
      runScript(repo, { kind: 'accept', plan, pkgs: 'a', tag: 'legacy' }, legacy).out
    ).toMatchObject({ disposition: 'repair', failures: [{ failure_class: 'product' }] });
    const current = runScript(repo, { kind: 'accept', plan, pkgs: 'a', tag: 'current' });
    expect(current.out).toMatchObject({
      disposition: 'repair',
      failures: [{ failure_class: 'unknown' }],
    });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
  });
  test('P2: failures never enter the acceptance cache', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = join(root, 'plan.json'),
      counter = join(root, 'n');
    const check = {
      cmd: `echo x >> ${counter}; echo '{"failure_class":"fixture","evidence":"fixture"}'; exit 1`,
      timeout_s: 5,
      cache: true,
    };
    const plan = {
      packages: [
        { id: 'a', accept: [check] },
        { id: 'b', accept: [check] },
      ],
      environment: [] as { cmd: string; timeout_s: number }[],
    };
    const go = (tag: string, pkgs = 'a') => {
      writeFileSync(p, JSON.stringify(plan));
      return runScript(repo, { kind: 'accept', plan: p, pkgs, tag });
    };
    go('verify-a');
    const cumulative = go('diff-m1-r1', 'a,b');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\n');
    expect(cumulative.out).toMatchObject({
      failed: [check.cmd, check.cmd],
      failures: [{ failure_class: 'fixture' }, { failure_class: 'fixture' }],
    });
    expect(readFileSync(join(cumulative.art, 'diff-m1-r1.log'), 'utf8')).not.toContain('# reused');
    go('verify-a');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\n');
    plan.environment = [{ cmd: 'true', timeout_s: 5 }];
    go('environment-change');
    check.timeout_s++;
    go('contract-change');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\nx\nx\n');
  });
  test('P2: structured probe failures rerun each check in the execution cwd tree', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = planFile(root, 'false', ['true']),
      trees = join(root, 'trees');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'junit.xml\n');
    const base = sh('git rev-parse HEAD', repo).trim(),
      baseTree = sh('git rev-parse HEAD^{tree}', repo).trim();
    writeFileSync(join(repo, 'README.md'), 'candidate\n');
    sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm candidate', repo);
    const candidateTree = sh('git rev-parse HEAD^{tree}', repo).trim();
    const plan = JSON.parse(readFileSync(p, 'utf8'));
    const check = {
      cmd: `git rev-parse HEAD^{tree} >> '${trees}'; printf '%s' '<testsuite tests="1"><testcase classname="suite" name="case"><failure>same</failure></testcase></testsuite>' > junit.xml; exit 1`,
      timeout_s: 5,
      report: { junit: 'junit.xml', collect: `printf 'suite::case\\n'` },
      known_failures: [{ id: 'suite::case', reason: 'known' }],
    };
    plan.packages[0].accept = [check, check];
    writeFileSync(p, JSON.stringify(plan));
    runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag: 'verify-a', base });
    expect(readFileSync(trees, 'utf8')).toBe(
      `${candidateTree}\n${candidateTree}\n${baseTree}\n${baseTree}\n`
    );
    expect(readFileSync(join(root, 'art', 'verify-a.probe.log'), 'utf8')).not.toContain('# reused');
  });
  test('F-20/F-13: delta patch retains out-of-scope evidence; risk paths raise the risk', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const commit = (f: string) =>
      sh(
        `mkdir -p $(dirname ${f}) && echo ${f} > ${f} && git add ${f} && git -c user.name=t -c user.email=t@l commit -qm ${f}`,
        repo
      );
    const base = sh('git rev-parse HEAD', repo).trim();
    commit('src/a.ts');
    const mid = sh('git rev-parse HEAD', repo).trim();
    commit('src/b.md');
    const p = join(root, 'plan.json');
    const write = (w: string[]) =>
      writeFileSync(
        p,
        JSON.stringify({
          packages: [{ id: 'a', scope: { write: w }, accept: [{ cmd: 'true', timeout_s: 5 }] }],
        })
      );
    const pol = join(root, 'policy.json');
    writeFileSync(
      pol,
      JSON.stringify({
        effort: snapshotPolicy(loadTiers()).effort,
        risk_paths: ['**/auth/**'],
        code_extensions: ['.ts'],
        exempt_paths: [],
        budget_floor: {},
      })
    );
    write(['src/']);
    const go = (risk: string) =>
      runScript(repo, {
        kind: 'accept',
        plan: p,
        pkgs: 'a',
        tag: 'diff-m1-r2',
        base,
        delta_base: mid,
        risk,
        policy: pol,
      }).out as { patch: string; delta: string; risk: string; out_of_scope: string[] };
    const r = go('G0');
    expect(readFileSync(r.delta, 'utf8')).toContain('src/b.md');
    expect(readFileSync(r.delta, 'utf8')).not.toContain('src/a.ts');
    expect(readFileSync(r.patch, 'utf8')).toContain('src/a.ts');
    expect(r).toMatchObject({ risk: 'G1', out_of_scope: [] });
    // adopt 重跑编码没有增量，仍用 baseline…HEAD 全量 patch/hash 推进首轮评审。
    const head = sh('git rev-parse HEAD', repo).trim();
    const adopted = runScript(repo, {
      kind: 'accept',
      plan: p,
      pkgs: 'a',
      tag: 'diff-adopt-r1',
      base,
      delta_base: head,
      risk: 'G0',
      policy: pol,
    });
    const full = adopted.out as { patch: string; delta: string; diff_hash: string };
    expect(readFileSync(full.delta, 'utf8')).toBe('');
    expect(readFileSync(full.patch, 'utf8')).toContain('src/a.ts');
    expect(adopted.out).toMatchObject({ disposition: 'advance', same: false, risk: 'G1' });
    writeFileSync(
      p,
      JSON.stringify({
        packages: [
          { id: 'later', scope: { write: ['other/'] }, accept: [{ cmd: 'true', timeout_s: 5 }] },
          { id: 'a', scope: { write: ['src/'] }, accept: [{ cmd: 'false', timeout_s: 5 }] },
        ],
      })
    );
    expect(
      runScript(repo, {
        kind: 'accept',
        plan: p,
        pkgs: 'later',
        scope_pkgs: 'a,later',
        tag: 'verify-later',
        base,
        risk: 'G0',
        policy: pol,
      }).out
    ).toMatchObject({ ok: true, risk: 'G1', out_of_scope: [] });
    // 原包顺序不能决定累计范围；SCOPE_PKGS 由生成器按实际里程碑拓扑提供。
    write(['src/a.ts']);
    expect(go('G0')).toMatchObject({ risk: 'G1', out_of_scope: ['src/b.md'] });
    write(['src/']);
    commit('src/auth/x.md');
    expect(go('G1')).toMatchObject({ risk: 'G2', out_of_scope: [] });
  }, 15_000); // Six real accept invocations exercise patch and scope integration.
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});

test.each(['true', PRODUCT_FAILURE])('NO_HOLD hard budget is advisory for %s', command => {
  const root = tmp(),
    repo = gitRepo(root),
    plan = planFile(root, command);
  const p = JSON.parse(readFileSync(plan, 'utf8'));
  p.budget = { launches: 1, weighted_tokens: 1, enforcement: 'hard' };
  writeFileSync(plan, JSON.stringify(p));
  const policy = join(root, 'policy.json'),
    archon = join(root, 'archon');
  writeFileSync(policy, JSON.stringify(snapshotPolicy(loadTiers())));
  writeFileSync(
    archon,
    `#!/bin/sh\necho '{"events":[{"event_type":"node_started","step_name":"code-a"}]}'\n`,
    { mode: 0o755 }
  );
  const r = runScript(
    repo,
    { kind: 'accept', plan, pkgs: 'a', tag: 'verify-a', policy, archon },
    SCRIPT,
    { WORKFLOW_ID: 'fixture' }
  );
  expect(r.code, r.err).toBe(0);
  expect(r.out).toMatchObject({
    disposition: command === 'true' ? 'advance' : 'repair',
    budget_advisory: 'budget_launches_exceeded',
  });
});

test('ROOT_ACCEPT high-risk boundary evidence fails without changing acceptance', () => {
  const out = disposition('{}', false, undefined, ['events:code-a:1'], undefined, MAX_ROUNDS);
  expect(out).toMatchObject({
    disposition: 'fail',
    decision: { kind: 'block', reason: 'coder_redline' },
  });
});

test.each(['settle', 'accept'])('NO_HOLD %s repair exhaustion exits failed with evidence', kind => {
  const root = tmp(),
    repo = gitRepo(root);
  const r = runScript(repo, {
    kind,
    plan: planFile(root, PRODUCT_FAILURE),
    pkgs: 'a',
    milestone: 'm1',
    tag: kind === 'settle' ? 'settle-a' : `diff-m1-r${String(MAX_ROUNDS)}`,
    first: JSON.stringify({ disposition: 'repair' }),
    repaired: '{"status":"done","error_class":null}',
  });
  expect(r.code, r.err).toBe(1);
  expect(r.out).toMatchObject({
    disposition: 'fail',
    decision: {
      kind: 'block',
      evidence: expect.arrayContaining([expect.stringContaining('.log')]),
    },
  });
  const path = join(
      r.art,
      kind === 'settle' ? 'settle-a.json' : `diff-m1-r${String(MAX_ROUNDS)}.json`
    ),
    bytes = readFileSync(path),
    { artifact_sha256: artifactSha256, ...emitted } = r.out as Record<string, unknown>;
  expect(JSON.parse(bytes.toString('utf8'))).toEqual(emitted);
  expect(artifactSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
});

test('ROOT_ACCEPT unfinished redline self-report with green empty diff holds as coder_partial', () => {
  const root = tmp(),
    repo = gitRepo(root);
  const r = runScript(repo, {
    kind: 'accept',
    plan: planFile(root, 'true'),
    pkgs: 'a',
    tag: 'verify-a',
    base: sh('git rev-parse HEAD', repo).trim(),
    coder: '{"status":"blocked","error_class":"redline","needs":[]}',
  });
  expect(r.code, r.err).toBe(1);
  expect(r.out).toMatchObject({ ok: true, disposition: 'fail', reason: 'coder_partial' });
  expect(
    nextDisposition({
      kind: 'block',
      reason: 'acceptance_failed+review_limit',
      evidence: [],
      debt: [],
    })
  ).toBe('fail');
});

test('NO_HOLD environment block exhausts package repair with registered terminal evidence', () => {
  const root = tmp(),
    repo = gitRepo(root);
  const r = runScript(repo, {
    kind: 'settle',
    plan: planFile(root, 'false'),
    pkgs: 'a',
    tag: 'settle-a',
    first: '{"disposition":"repair"}',
    repaired: '{"status":"blocked","error_class":"env","needs":[{"cap":"environment"}]}',
  });
  expect(r.code, r.err).toBe(1);
  expect(r.out).toMatchObject({
    disposition: 'fail',
    reason: 'acceptance_failed+review_limit',
    repair_reason: 'environment',
  });
});

test.each([
  'destruction',
  'shared_history',
  'external',
  'privacy',
  'authorization',
  'delegation',
  'diagnostic',
  null,
])('ROOT_ACCEPT boundary category %s alone decides whether refusal is redline', category => {
  const events = [
    {
      event_type: 'provider_event',
      step_name: 'code-a',
      data: {
        event: {
          type: 'warning' as const,
          permissionDenied: true as const,
          code: category ? `superagent.permission.${category}` : 'claude.permission_denied',
          message: 'diagnostic',
        },
      },
    },
  ];
  const permissions = permissionEvidence(events, ['a'], 'm1', MAX_ROUNDS);
  const high = category !== null && category !== 'diagnostic';
  expect(permissions.length).toBe(high ? 1 : 0);
  expect(disposition('{}', true, undefined, permissions, undefined, MAX_ROUNDS).disposition).toBe(
    high ? 'fail' : 'advance'
  );
});

test('ROOT_ACCEPT HEAD filename does not make patch or scope git diff ambiguous', () => {
  const root = tmp(),
    repo = gitRepo(root),
    base = sh('git rev-parse HEAD', repo).trim();
  writeFileSync(join(repo, 'HEAD'), 'a path, not a revision');
  sh('git add -- HEAD && git -c user.name=t -c user.email=t@l commit -qm head-path', repo);
  const external = join(root, 'external-diff');
  const called = join(root, 'external-called');
  writeFileSync(external, `#!/bin/sh\ntouch '${called}'\nexit 1\n`, { mode: 0o755 });
  sh(`git config diff.external '${external}'`, repo);
  const policy = join(root, 'policy.json');
  writeFileSync(policy, JSON.stringify(snapshotPolicy(loadTiers())));
  const plan = planFile(root, 'true');
  const p = JSON.parse(readFileSync(plan, 'utf8'));
  p.packages[0].scope = { write: ['HEAD'] };
  writeFileSync(plan, JSON.stringify(p));
  const r = runScript(repo, {
    kind: 'accept',
    plan,
    pkgs: 'a',
    tag: 'head-path',
    base,
    risk: 'G1',
    policy,
  });
  expect(r.code, r.err).toBe(0);
  expect(r.out).toMatchObject({ ok: true, disposition: 'advance' });
  expect(readFileSync(join(r.art, 'head-path.patch'), 'utf8')).toContain('a/HEAD');
  expect(existsSync(called)).toBe(false);
});

test('ROOT_ACCEPT necessary diff timeout reports engine evidence instead of a repair verdict', () => {
  const r = auxiliaryFixture('accept', 'diff --no-ext-diff', true);
  expect(r.code).toBe(1);
  expect(r.out).toMatchObject({
    ok: false,
    reason: 'engine_suspect',
    disposition: 'fail',
    engine_error: expect.stringContaining('auxiliary-stalled'),
  });
  expect(r.err).not.toContain('at git (');
});

test('ROOT_ACCEPT diagnostic probe creation timeout preserves failed command and unknown baseline', () => {
  const r = auxiliaryFixture('accept', 'worktree add', true);
  expect(r.code, r.err).toBe(0);
  expect(r.out).toMatchObject({
    ok: false,
    disposition: 'repair',
    failed: [PRODUCT_FAILURE],
    base_pass: null,
  });
  expect(readFileSync(join(r.art, 'acct.probe.log'), 'utf8')).toContain('auxiliary-stalled');
});

test('ROOT_ACCEPT malformed plan is an engine fault with original evidence and no TypeScript stack', () => {
  const root = tmp(),
    repo = gitRepo(root),
    plan = join(root, 'plan.json');
  writeFileSync(plan, '{');
  const r = runScript(repo, { kind: 'accept', plan, tag: 'invalid-plan' });
  expect(r.code).toBe(1);
  expect(r.out).toMatchObject({
    reason: 'engine_suspect',
    disposition: 'fail',
    engine_error: expect.any(String),
  });
  expect(r.err).not.toContain('at plan (');
});

test.each(['scope_violation', 'plan_invalid'])(
  'adjudication %s stops verify, settle and gate repair',
  error_class => {
    const root = tmp(),
      repo = gitRepo(root);
    const needs = [
      { cap: 'scope_decision', why: '401 vs required 403', minimal_ask: 'resolve contract' },
    ];
    const coder = JSON.stringify({
      status: 'blocked',
      error_class,
      needs,
      blockers: ['contract conflict'],
    });
    const inputs = { plan: planFile(root, 'false'), pkgs: 'a', coder };
    const verify = runScript(repo, { ...inputs, kind: 'accept', tag: 'verify-a' });
    expect(verify.code).toBe(1);
    expect(verify.out).toMatchObject({
      disposition: 'fail',
      reason: 'coder_needs',
      decision: { needs },
    });
    const settled = runScript(repo, {
      ...inputs,
      kind: 'settle',
      tag: 'settle-a',
      first: JSON.stringify(verify.out),
      repaired: coder,
    });
    expect(settled.code).toBe(1);
    expect(settled.out).toMatchObject({
      disposition: 'fail',
      reason: 'coder_needs',
      decision: { needs },
    });
    expect(decide({ rechecks: [verify.out as Accept], reviews: [null], risk: 'G1' })).toMatchObject(
      { verdict: 'escalate', reason: 'coder_needs', decision: { needs } }
    );
  }
);

test.each([4, 1])(
  'probe exit %s without comparable test evidence never proves baseline failure',
  exit => {
    const root = tmp(),
      repo = gitRepo(root),
      base = sh('git rev-parse HEAD', repo).trim();
    const command = `echo 'setup errors or missing new test'; exit ${exit}`;
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, command, ['true']),
      pkgs: 'a',
      tag: 'incomparable',
      base,
    });
    expect(r.out).toMatchObject({
      ok: false,
      base_pass: null,
      baseline: 'incomparable',
      base_results: [{ pass: null }],
      disposition: 'repair',
    });
    expect((r.out as Accept).baseline_reason).toContain(`exit=${exit}`);
  }
);

test('unresolved completeness blocker prevents verified requirement summary', () => {
  const check = { cmd: 'true', timeout_s: 5 };
  const accept: Accept = {
    ok: true,
    same: false,
    diff_hash: 'x',
    requirement_contract: [
      {
        id: 'a',
        accept: [check],
        requirements: [{ id: 'r', text: 'complete delivery', verified_by: [0] }],
      },
    ],
    command_results: [{ check, pass: true, evidence: 'check.log' }],
  };
  const review = {
    status: 'FAIL' as const,
    debt: [],
    findings: [
      {
        id: 'R1-1',
        severity: 'blocker' as const,
        status: 'open' as const,
        file: 'report',
        line: 1,
        evidence: '19 requirements missing',
        carry_over: false,
        failure_class: 'product' as const,
      },
    ],
  };
  const result = deliveryDecision({
    rechecks: [accept],
    reviews: [review],
    reviewRounds: MAX_ROUNDS,
  });
  expect(result.decision.requirements?.status).toBe('unmet');
  expect(result.decision.kind).toBe('repair');
  expect(
    deliveryDecision({
      rechecks: [accept, accept],
      reviews: [review, { ...review, status: 'PASS', findings: [] }],
      reviewRounds: MAX_ROUNDS,
    }).decision.requirements?.status
  ).toBe('unmet');
  const closed = { ...review.findings[0]!, status: 'closed' as const, carry_over: true };
  expect(
    deliveryDecision({
      rechecks: [accept, accept],
      reviews: [review, { ...review, status: 'PASS', findings: [closed] }],
      reviewRounds: MAX_ROUNDS,
    }).decision.requirements?.status
  ).toBe('verified');
});
