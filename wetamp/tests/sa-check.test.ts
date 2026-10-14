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
  effectiveBudget,
  decide,
  disposition,
  nextDisposition,
  identityOf,
  independence,
  readAuthorEvidence,
  ledgerOf,
  scopeRisk,
  deliveryDecision,
  readAttempt,
  CHECK_AUX_COUNTS,
  CHECK_AUX_TIMEOUT_MS,
  type Accept,
} from '../templates/.archon/scripts/sa-check';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import { FAILURE_CLASSES } from '../templates/.archon/scripts/failure-class';
import outputSchema from '../schemas/output.schema.json';
import { envPrecheck } from '../templates/.archon/scripts/env-precheck';
import { writePolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
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
    old: { id: 'old', codebase_id: 'repo', output_root: oldRoot, events: [] },
  };
  mkdirSync(art, { recursive: true });
  const attempt = {
    id: 'original',
    node: 'code-core',
    provider: 'codex' as const,
    model: 'author',
    status: 'completed' as const,
  };
  writePolicyAttempts(art, [attempt]);
  const read = () => readAuthorEvidence(runs.current!, [], ['core'], 'm1', id => runs[id]!);
  expect(read()).toEqual([
    { model: 'repair', strength: 'pinned' },
    { model: 'author', strength: 'pinned' },
  ]);
  expect(independence(read(), { model: 'reviewer', strength: 'pinned' })).toBeNull();
  expect(independence(read(), { model: 'author', strength: 'pinned' })).toBe('same_model');
  const cumulative = readAuthorEvidence(
    runs.current!,
    [{ ...attempt, node: 'fix-m0-r2', model: 'fix-author' }],
    ['core'],
    ['m0', 'm1'],
    id => runs[id]!
  );
  expect(independence(cumulative, { model: 'fix-author', strength: 'pinned' })).toBe('same_model');
  expect(
    independence(
      readAuthorEvidence(runs.current!, [], ['core', 'missing'], 'm1', id => runs[id]!),
      { model: 'reviewer', strength: 'pinned' }
    )
  ).toBe('author_unknown');
  writePolicyAttempts(art, [{ ...attempt, status: 'failed' }]);
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
    readAuthorEvidence({ ...old, events: [event('local')] }, [], ['core'], 'm1', () => {
      throw new Error('unexpected ancestry');
    })
  ).toEqual([{ model: 'local', strength: 'pinned' }]);
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
/** 第 2/3 轮用原 id 关闭并附证据：gate 唯一承认的关闭方式。 */
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

describe('FC failure classification', () => {
  test('runtime enum and embedded output schemas derive from their owning schema', () => {
    expect([...FAILURE_CLASSES] as string[]).toEqual(outputSchema.$defs.failure_class.enum);
    expect(outputSchema.$defs.reviewer.properties.findings.items.properties.failure_class).toEqual(
      outputSchema.$defs.failure_class
    );
    expect(outputSchema.$defs.accept.properties.failures.items.properties.failure_class).toEqual(
      outputSchema.$defs.failure_class
    );
    for (const name of ['two-pkgs', 'two-pkgs-fake']) {
      const snapshot = Bun.YAML.parse(
        readFileSync(join(import.meta.dir, 'golden', `${name}.yaml`), 'utf8')
      ) as {
        nodes: { id: string; output_format?: unknown; bash?: string }[];
      };
      for (const node of snapshot.nodes) {
        if (/^(verify|diff)-/.test(node.id))
          expect(node.output_format).toEqual(outputSchema.$defs.accept);
        if (node.id.startsWith('settle-'))
          expect(node.output_format).toEqual(outputSchema.$defs.delivery);
        if (/^review-/.test(node.id)) {
          expect(node.output_format).toEqual(outputSchema.$defs.reviewer);
          if (node.bash) expect(node.bash).toContain('"failure_class":"product","command":null');
        }
      }
    }
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
  test('delivery-truth: same blocker after two repairs stays blocked in G1/strict/G2', () => {
    const r = R('FAIL', [
      f('blocker', { id: 'stable', failure_class: 'product', evidence: '/tmp/fail.log' }),
    ]);
    const input = { reviews: [r, r, r], rechecks: [C('a'), C('b'), C('c')], risk: 'G1' };
    expect(decide({ ...input, reviews: [r, r], rechecks: [C('a'), C('b')] }).verdict).toBe('fix');
    for (const protectedInput of [{}, { strict: true }, { risk: 'G2' }])
      expect(decide({ ...input, ...protectedInput })).toMatchObject({
        verdict: 'escalate',
        reason: 'review_failed+review_limit',
        ledger: { blocking: [{ id: 'stable', repair_rounds: 2 }], debt: [] },
      });
    const newer = R('FAIL', [f('blocker', { id: 'new', evidence: '/tmp/new.log' })]);
    expect(decide({ ...input, reviews: [R('PASS'), R('PASS'), newer] }).verdict).toBe('escalate');
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
      base_pass: false,
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
  test('delivery-truth: third product validation stops repairs without advancing in G1/strict/G2', () => {
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
      for (const round of [1, 2]) {
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
        { kind: 'accept', plan: path, pkgs: 'a', milestone: 'm1', tag: 'diff-m1-r3', risk },
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
        decide({ reviews: [R('PASS'), R('PASS'), R('PASS')], rechecks: [check, check, check] })
      ).toMatchObject({ verdict: 'escalate', reason: 'acceptance_failed+review_limit' });
    }
  });
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
  test('three failing rounds escalate at the review limit', () => {
    const d = decide({
      reviews: [R('FAIL'), R('FAIL'), R('FAIL')],
      rechecks: [C('a'), C('b'), C('c')],
      risk: 'G1',
    });
    expect(d).toMatchObject({
      verdict: 'escalate',
      rounds: 3,
      reason: 'review_failed+review_limit',
    });
  });
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
  test('ledger: R2 漏掉 R1 高危仍阻塞，R3 两轮修复后仍须升级', () => {
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
      verdict: 'escalate',
      reason: 'review_inconsistent+review_limit',
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
  test('blocked without a candidate skips checks and probe; other deliveries still validate', () => {
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
    for (const [status, error_class, candidate, dirty, includeBase, count, reason] of [
      ['blocked', 'env', false, false, true, 0, 'coder_needs'],
      ['blocked', 'redline', false, false, true, 0, 'coder_error:redline'],
      ['partial', 'env', false, false, true, 2, 'environment'],
      ['done', null, false, false, true, 2, 'acceptance_failed'],
      ['blocked', 'task', false, false, false, 1, 'acceptance_failed'],
      ['blocked', 'env', false, false, false, 1, 'environment'],
      ['blocked', 'env', false, true, true, 2, 'environment'],
      ['blocked', 'env', true, false, true, 2, 'environment'],
    ] as const) {
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
      expect(result.code, result.err).toBe(reason === 'coder_error:redline' ? 1 : 0);
      expect(result.out).toMatchObject({
        ok: false,
        disposition: reason === 'coder_error:redline' ? 'fail' : 'repair',
        reason,
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
  }, 10_000);
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
      data: { attemptId, event: { type: 'warning', code: 'x', message: 'x', permissionDenied } },
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
      expect(result.code, result.err).toBe(0);
      expect(result.out).toMatchObject({
        ok: reason !== 'environment',
        decision: { kind: reason ? 'block' : 'advance', reason },
      });
    }
  });
  test('other self-reports do not change control state, including malformed output', () => {
    for (const raw of [
      '{',
      JSON.stringify({ status: 'blocked', error_class: 'redline', needs: [{ cap: 'network' }] }),
    ])
      for (const ok of [true, false])
        expect(disposition(raw, ok).decision.kind).toBe(ok ? 'advance' : 'repair');
  });
  test('non-critical failures become debt', () => {
    const check = {
      ...C('a', false),
      failed: ['check'],
      failures: [
        { command: 'check', failure_class: 'fixture' as const, evidence: '/tmp/accept.log' },
      ],
    };
    expect(deliveryDecision({ rechecks: [check] }).decision.kind).toBe('debt');
  });
  test('E7: partial + env + green checks advances with all audit markers', () => {
    // 原始 node_completed 事件的 structured_output，仅将 notes 置空脱敏。
    const coder: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, 'incidents/e7-coder.json'), 'utf8')
    );
    expect(disposition(JSON.stringify(coder), true)).toMatchObject({
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
  test('out-of-scope (incl. rename source), risk paths, gitlinks and symlinks raise to G2', () => {
    expect(scopeRisk([ch(['lib/x.ts', 'src/x.ts'])], ['src/**'], pol, 'G1')).toEqual({
      risk: 'G2',
      out_of_scope: ['lib/x.ts'],
    });
    expect(scopeRisk([ch(['src/auth/k.ts'])], ['src'], pol, 'G1').risk).toBe('G2');
    expect(scopeRisk([ch(['src/vendor'], ['000000', '160000'])], ['src'], pol, 'G0').risk).toBe(
      'G2'
    );
    expect(scopeRisk([ch(['src/l'], ['100644', '120000'])], ['src'], pol, 'G0').risk).toBe('G2');
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

function runScript(
  cwd: string,
  inputs: Record<string, string>,
  script = SCRIPT,
  extraEnv: Record<string, string> = {}
): { code: number; out: unknown; err: string; art: string } {
  const art = join(cwd, '..', 'art');
  mkdirSync(art, { recursive: true });
  // An engine accept node runs this suite with its own INPUTS_*/WORKFLOW_ID; inheriting them points
  // the script at the live run's Archon instead of the fixture.
  const inherited = Object.entries(process.env as Record<string, string>).filter(
    ([k]) => !k.startsWith('INPUTS_') && k !== 'WORKFLOW_ID'
  );
  const env: Record<string, string> = {
    ...Object.fromEntries(inherited),
    ARTIFACTS_DIR: art,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUTS_${k.toUpperCase()}`] = v;
  const p = Bun.spawnSync(['bun', script], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const out = p.stdout.toString().trim();
  return {
    code: p.exitCode,
    out: out ? (JSON.parse(out) as unknown) : null,
    err: p.stderr.toString(),
    art,
  };
}

// Trace real auxiliary calls through the process-group watchdog.
function auxiliaryFixture(kind: string, hang = '', scaled = false, stubborn = false, hook = false) {
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
  writeFileSync(
    policy,
    JSON.stringify({
      risk_paths: [],
      code_extensions: [],
      exempt_paths: [],
      budget_floor: { S: 1 },
    })
  );
  writeFileSync(archon, '#!/bin/sh\necho \'{"events":[]}\'\n', { mode: 0o755 });
  const script = join(root, 'sa-check.ts');
  writeFileSync(
    join(root, 'reasons.json'),
    readFileSync(join(import.meta.dir, '../templates/.archon/scripts/reasons.json'))
  );
  writeFileSync(
    join(root, 'sa-context.ts'),
    readFileSync(join(import.meta.dir, '../templates/.archon/scripts/sa-context.ts'))
  );
  // Runtime sibling import of sa-check.ts; type-only imports are erased and need no copy.
  writeFileSync(
    join(root, 'policy-attempts.ts'),
    readFileSync(join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'))
  );
  writeFileSync(
    join(root, 'failure-class.ts'),
    readFileSync(join(import.meta.dir, '../templates/.archon/scripts/failure-class.ts'))
  );
  cpSync(
    join(import.meta.dir, '../templates/.archon/scripts/env-precheck.ts'),
    join(root, 'env-precheck.ts')
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
const spawn = Bun.spawnSync;
Bun.spawnSync = (actual, opts) => {
  const wrapped = actual[0] === 'python3' && actual[1] === '-c';
  const cmd = wrapped ? actual.slice(4) : actual;
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({cmd, timeout: opts?.timeout}) + '\\n');
  const key = cmd[0] === 'git' ? cmd.slice(1, 3).join(' ') : cmd[0] === 'bash' ? 'command' : 'events';
  if (key === ${JSON.stringify(hang)})
    return spawn([...(wrapped ? actual.slice(0, 4) : []), 'bash', '-c', ${JSON.stringify(stubborn ? `trap '' TERM; echo $$ > '${trackedPid}'; echo auxiliary-stalled >&2; while :; do sleep 1; done` : 'echo auxiliary-stalled >&2; exec sleep 2')}], opts);
  return spawn(actual, opts);
};
`;
  let source = readFileSync(SCRIPT, 'utf8').replace('const env =', `${instrument}\nconst env =`);
  if (scaled)
    source = source.replace('CHECK_AUX_TIMEOUT_MS = 10_000', 'CHECK_AUX_TIMEOUT_MS = 2000');
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
  const calls = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { cmd: string[]; timeout?: number });
  return { ...r, calls, trackedPid };
}

for (const kind of ['accept', 'settle', 'env'])
  test(`ACCT: ${kind} traced worst path enforces shared auxiliary count and timeout`, () => {
    const r = auxiliaryFixture(kind);
    const auxiliary = r.calls.filter(c => c.cmd[0] !== 'bash');
    const count = CHECK_AUX_COUNTS[kind === 'env' ? 'env' : 'accept'];
    // Permission evidence is queried even when failed settle suspends before budget().
    expect(auxiliary).toHaveLength(count);
    expect(auxiliary.every(c => c.timeout === CHECK_AUX_TIMEOUT_MS)).toBe(true);
    if (kind === 'env') expect(r.code).toBe(0);
    else {
      expect(r.out).toMatchObject({ ok: false, base_pass: false });
      expect(r.code).toBe(kind === 'settle' ? 1 : 0);
      expect(r.calls.filter(c => c.cmd[0] === 'bash')).toHaveLength(3);
    }
  });

for (const [kind, step, evidence] of [
  ['accept', 'status --porcelain', 'git status:'],
  ['accept', 'worktree add', 'git worktree:'],
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

test('ACCT: real git hook descendant holding pipes is killed within the shared budget', () => {
  const r = auxiliaryFixture('accept', '', true, false, true);
  // Fixture setup and other auxiliary calls are outside this watchdog's budget.
  expect(r.calls.find(c => c.cmd.slice(0, 3).join(' ') === 'git worktree add')?.timeout).toBe(2000);
  expect(r.code).toBe(1);
  expect(r.err).toContain('git worktree:');
  expect(r.err).toContain('hook-descendant');
  expect(r.err).toContain('TERM -> SIGKILL; output pipes reclaimed');
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
        join(portable, 'sa-check.ts')
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
    const decide = (c: Accept) => deliveryDecision({ rechecks: [c] }).decision.requirements;
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
    const validate = new Ajv2020().compile(outputSchema.$defs.accept.properties.decision);
    for (const c of [
      check,
      { ...check, command_results: [] },
      { ...check, command_results: check.command_results!.map(c => ({ ...c, pass: false })) },
      { ok: true, same: false, diff_hash: '' },
    ]) {
      expect(validate(deliveryDecision({ rechecks: [c] }).decision)).toBe(true);
    }
    expect(
      deliveryDecision({ rechecks: [check], packages: changed.requirement_contract }).decision
        .requirements?.status
    ).toBe('unknown');
    expect(
      outputSchema.$defs.accept.properties.decision.properties.requirements.properties.status.enum
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
    });
    expect(again.out).toMatchObject({ diff_hash: out.diff_hash, same: true });
  });
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
      base_pass: false,
      base_results: [{ cmd: command, pass: false }],
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
    expect(preexisting.out).toMatchObject({ ok: false, base_pass: false });
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
      { cmd: commands[1], pass: false },
    ];
    expect(r).toMatchObject({
      code: 0,
      out: {
        ok: false,
        base_pass: true,
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
    expect(r.out).toMatchObject({ ok: false, base_results: [{ pass: false }] });
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
    expect(r.out).toEqual({ diff_hash: '' });
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
      same: false,
    };
    const pass = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify(first),
      repaired: 'null',
    });
    expect(pass.code).toBe(0);
    expect(pass.out).toEqual({ diff_hash: 'delivered' });
    const auditChanged = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, PRODUCT_FAILURE),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify({
        ...first,
        log: '/changed.log',
        head: 'changed',
        decision: { kind: 'debt', reason: null, evidence: ['/changed.log'], debt: ['fixture'] },
      }),
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
  test('F-21: omitted cache reuses a pass on the same tree; cache:false always runs; new trees rerun', () => {
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
    const go = (tag: string) => runScript(repo, { kind: 'accept', plan: p, pkgs: 'a', tag }).out;
    expect(go('verify-a')).toMatchObject({ ok: true });
    expect(go('diff-m1-r1')).toMatchObject({ ok: true });
    expect(readFileSync(counter, 'utf8')).toBe('c\nu\nu\n');
    expect(readFileSync(join(root, 'art', 'diff-m1-r1.log'), 'utf8')).toContain(
      'reused pass from verify-a'
    );
    sh(
      'echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@l commit -qm z',
      repo
    );
    go('diff-m1-r2');
    expect(readFileSync(counter, 'utf8')).toBe('c\nu\nu\nc\nu\n');
  });
  test('delivery-truth: cache binds filtered command environment and private context, never legacy identity', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = join(root, 'plan.json');
    const counter = join(root, 'n'),
      art = join(root, 'art'),
      cache = join(art, 'accept-cache');
    const cmd = `echo x >> ${counter}; test "$SA_REVIEW_MODE" = good`;
    const check = { cmd, timeout_s: 5, cache: true };
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
      }).out
    ).toMatchObject({ ok: true });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
    expect(go('changed', 'worse').out).toMatchObject({ ok: false });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\n');
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
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\n');
    writeFileSync(join(repo, 'dirty.txt'), 'dirty');
    expect(go('dirty').out).toMatchObject({ ok: false, workspace_clean: false });
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\nx\nx\n');
  });
  test('delivery-truth: concurrent cache initialization publishes one complete private key', async () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = planFile(root, 'true');
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
  });
  test('FC legacy cache default product cannot hide an unclassified command', () => {
    const root = tmp(),
      repo = gitRepo(root),
      counter = join(root, 'count');
    const command = `echo x >> '${counter}'; false`;
    const legacy = join(root, 'legacy.ts');
    cpSync(join(import.meta.dir, '../templates/.archon/scripts'), root, { recursive: true });
    writeFileSync(
      join(root, 'policy-attempts.ts'),
      readFileSync(join(import.meta.dir, '../../packages/workflows/src/provider-attempts.ts'))
    );
    writeFileSync(
      legacy,
      readFileSync(SCRIPT, 'utf8')
        .replace('                FAILURE_CLASSES,\n', '')
        .replace('failure_class: failureClass(classification)', "failure_class: 'product'")
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
  test('P2: cached failures survive cumulative checks; contract and environment changes rerun', () => {
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
    const first = go('verify-a');
    const evidence = (first.out as { failures: { evidence: string }[] }).failures[0].evidence;
    const cumulative = go('diff-m1-r1', 'a,b');
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
    expect(cumulative.out).toMatchObject({
      failed: [check.cmd, check.cmd],
      failures: [
        { failure_class: 'fixture', evidence },
        { failure_class: 'fixture', evidence },
      ],
    });
    expect(evidence).toBe(join(first.art, 'verify-a.log'));
    const originalLog = readFileSync(evidence, 'utf8');
    expect(originalLog).toContain('{"failure_class":"fixture","evidence":"fixture"}\n');
    expect(originalLog).toContain('# exit=1');
    expect(readFileSync(join(cumulative.art, 'diff-m1-r1.log'), 'utf8')).toContain(
      '# reused failure from verify-a'
    );
    // R1-1: retrying the originating tag must retain the cached failure's diagnostic.
    const retried = go('verify-a');
    expect(retried.out).toMatchObject({ failures: [{ failure_class: 'fixture', evidence }] });
    expect(readFileSync(counter, 'utf8')).toBe('x\n');
    expect(readFileSync(evidence, 'utf8')).toBe(
      `${originalLog}$ ${check.cmd}\n# reused failure from verify-a\n\n`
    );
    plan.environment = [{ cmd: 'true', timeout_s: 5 }];
    go('environment-change');
    check.timeout_s++;
    go('contract-change');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\nx\n');
  });
  test('F-20/F-13: delta patch against delta_base; out-of-scope and risk paths raise the risk', () => {
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
    expect(go('G0')).toMatchObject({ risk: 'G2', out_of_scope: ['src/b.md'] });
    write(['src/']);
    commit('src/auth/x.md');
    expect(go('G1')).toMatchObject({ risk: 'G2', out_of_scope: [] });
  }, 15_000); // Six real accept invocations exercise patch and scope integration.
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});

test('budget grants inherit enforcement and token exemption from the plan, including old grants', () => {
  const grant = { milestone: 'm1', attempt: 0, limits: { launches: 4, weighted_tokens: 100 } };
  for (const enforcement of [undefined, 'observe', 'hard'] as const) {
    const base = { weighted_tokens: 0, enforcement, unlimited_tokens: true as const };
    expect(effectiveBudget(base, grant, 'm1', 0)).toMatchObject({
      enforcement: enforcement ?? 'observe',
      unlimited_tokens: true,
    });
    expect(
      effectiveBudget(
        base,
        { ...grant, limits: { ...grant.limits, enforcement: 'observe' } },
        'm1',
        0
      ).enforcement
    ).toBe(enforcement ?? 'observe');
  }
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

test('NO_HOLD coder_redline permission audit block repairs without changing acceptance', () => {
  const out = disposition('{}', false, undefined, ['events:code-a:1']);
  expect(out).toMatchObject({
    disposition: 'repair',
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
    tag: kind === 'settle' ? 'settle-a' : 'diff-m1-r3',
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
  expect(
    JSON.parse(
      readFileSync(join(r.art, kind === 'settle' ? 'settle-a.json' : 'diff-m1-r3.json'), 'utf8')
    )
  ).toEqual(r.out);
});

test('NO_HOLD explicit high-risk redline immediately fails using a registered reason', () => {
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
  expect(r.out).toMatchObject({
    disposition: 'fail',
    reason: 'coder_error:redline',
    decision: { kind: 'block', reason: 'coder_error:redline' },
  });
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
