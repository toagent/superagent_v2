import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTiers, snapshotPolicy } from '../src/config';
import {
  decide,
  disposition,
  identityOf,
  independence,
  ledgerOf,
  scopeRisk,
  deliveryDecision,
  permissionEvidence,
  readAttempt,
  CHECK_AUX_COUNTS,
  CHECK_AUX_TIMEOUT_MS,
} from '../templates/.archon/scripts/sa-check';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import { FAILURE_CLASSES } from '../templates/.archon/scripts/failure-class';
import outputSchema from '../schemas/output.schema.json';

const SCRIPT = join(import.meta.dir, '..', 'templates', '.archon', 'scripts', 'sa-check.ts');
type Rv = NonNullable<NonNullable<Parameters<typeof decide>[0]['reviews']>[number]>;
type F = Rv['findings'][number];
const f = (severity: F['severity'], extra: Partial<F> = {}): F => ({
  id: `x-${severity}`,
  severity,
  file: 'a.ts',
  line: 1,
  status: 'open',
  evidence: '',
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
        if (/^(verify|settle|diff)-/.test(node.id))
          expect(node.output_format).toEqual(outputSchema.$defs.accept);
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
      {},
      JSON.parse('{"failure_class":"unknown"}'),
      { failure_class: 'fixture' as const, evidence: '' },
    ]) {
      const finding = f('high', { evidence: '/tmp/accept.log', ...extra });
      const d = decide({ reviews: [R('FAIL', [finding])], rechecks: [C('a')], risk: 'G1' });
      expect(d.verdict).toBe('fix');
      expect(d.ledger.blocking).toHaveLength(1);
      expect(d.ledger.blocking[0].failure_class).toBe('product');
    }
  });
  test('reviewer non-product failures become observable debt without any repair round', () => {
    for (const failure_class of FAILURE_CLASSES.filter(c => c !== 'product')) {
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
  test('same finding after two repairs becomes debt, while strict/G2 remains held', () => {
    const r = R('FAIL', [
      f('high', { id: 'stable', failure_class: 'product', evidence: '/tmp/fail.log' }),
    ]);
    const input = { reviews: [r, r, r], rechecks: [C('a'), C('b'), C('c')], risk: 'G1' };
    expect(decide({ ...input, reviews: [r, r], rechecks: [C('a'), C('b')] }).verdict).toBe('fix');
    const d = decide(input);
    expect(d.verdict).toBe('pass');
    expect(d.ledger.debt[0]).toMatchObject({
      id: 'stable',
      repair_rounds: 2,
      debt_reason: 'repair_limit',
      failure_class: 'product',
    });
    for (const protectedInput of [{ strict: true }, { risk: 'G2' }])
      expect(decide({ ...input, ...protectedInput })).toMatchObject({
        verdict: 'escalate',
        reason: 'review_failed+review_limit',
        ledger: { blocking: [{ id: 'stable' }], debt: [] },
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
    expect(decide({ reviews: [R('PASS')], rechecks: [check], risk: 'G1' }).verdict).toBe('fix');
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
          expect(d.verdict).toBe('fix');
          expect(d.ledger.blocking).toHaveLength(2);
          expect(d.ledger.blocking).toContainEqual(
            expect.objectContaining({
              id: 'product-id',
              command,
              failure_class: 'product',
              evidence: '/tmp/product.log',
            })
          );
          expect(
            d.ledger.blocking.some(e => e.id.startsWith('check:') && e.failure_class === 'product')
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
  test('FC-R1-02: repair-limit debt cannot bypass skipped-review reuse checks', () => {
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
            blocking: [],
            debt: [{ id: 'stable', repair_rounds: 2, debt_reason: 'repair_limit' }],
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
      plan: planFile(root, 'false'),
      pkgs: 'a',
      tag: 'verify-product',
      coder,
    });
    expect(red.out).toMatchObject({
      ok: false,
      disposition: 'repair',
      failures: [{ failure_class: 'product' }],
    });
  });
  test('third validation of the same product command stops repairs and proceeds to review only outside strict/G2', () => {
    const root = tmp(),
      repo = gitRepo(root),
      art = join(root, 'artifacts');
    mkdirSync(art);
    for (const i of [1, 2])
      writeFileSync(
        join(art, `diff-m1-r${i}.json`),
        JSON.stringify({
          ...C(String(i), false),
          failed: ['false'],
          disposition: 'repair',
          failures: [{ command: 'false', failure_class: 'product', evidence: '/tmp/fail.log' }],
        })
      );
    const path = planFile(root, 'false');
    for (const [mode, risk, expected] of [
      ['milestone', 'G1', 'advance'],
      ['strict', 'G1', 'repair'],
      ['milestone', 'G2', 'repair'],
    ]) {
      const p = JSON.parse(readFileSync(path, 'utf8'));
      p.mode = mode;
      writeFileSync(path, JSON.stringify(p));
      const result = runScript(
        repo,
        { kind: 'accept', plan: path, pkgs: 'a', milestone: 'm1', tag: 'diff-m1-r3', risk },
        SCRIPT,
        { ARTIFACTS_DIR: art }
      );
      expect(result.out).toMatchObject({ ok: false, disposition: expected });
      if (expected === 'advance')
        expect(result.out).toMatchObject({
          failures: [{ failure_class: 'product', repair_rounds: 2, debt_reason: 'repair_limit' }],
        });
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
  test('ledger: R2 漏掉 R1 高危仍阻塞，R3 两轮修复后非 strict 转债', () => {
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
      verdict: 'pass',
      ledger: { blocking: [], debt: [{ id: 'R1-1', debt_reason: 'repair_limit' }] },
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
  test('permission denial and unknown environment survive the real acceptance node', () => {
    const root = tmp(),
      repo = gitRepo(root),
      archon = join(root, 'archon');
    const event = {
      event_type: 'provider_event',
      step_name: 'code-a',
      data: { event: { type: 'hook', hookEvent: 'PreToolUse', exitCode: 2 } },
    };
    writeFileSync(archon, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ events: [event] })}'\n`, {
      mode: 0o755,
    });
    const denied = runScript(
      repo,
      {
        kind: 'accept',
        plan: planFile(root, 'true'),
        pkgs: 'a',
        tag: 'verify-denied',
        archon,
      },
      SCRIPT,
      { WORKFLOW_ID: 'fixture' }
    );
    expect(denied.code).toBe(1);
    expect(denied.out).toMatchObject({
      ok: true,
      decision: {
        kind: 'block',
        reason: 'coder_redline',
        evidence: expect.arrayContaining(['events:code-a:0']),
      },
    });
    const unknown = runScript(repo, {
      kind: 'accept',
      plan: planFile(
        root,
        `printf '%s' '{"failure_class":"test_env","evidence":"environment unavailable"}'; exit 1`
      ),
      pkgs: 'a',
      tag: 'verify-unknown',
    });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toMatchObject({ decision: { kind: 'block', reason: 'environment' } });
  });
  test('self-reports do not change control state, including malformed output', () => {
    for (const raw of [
      '{',
      JSON.stringify({ status: 'blocked', error_class: 'redline', needs: [{ cap: 'network' }] }),
    ])
      for (const ok of [true, false])
        expect(disposition(raw, ok).decision.kind).toBe(ok ? 'advance' : 'repair');
  });
  test('provider denial blocks green acceptance; an ordinary hook error does not', () => {
    const events = [
      {
        event_type: 'provider_event',
        step_name: 'code-a',
        data: {
          event: {
            type: 'hook' as const,
            hookId: 'deny',
            hookName: 'guard',
            hookEvent: 'PreToolUse',
            status: 'failed' as const,
            exitCode: 2,
          },
        },
      },
    ];
    const permissions = permissionEvidence(events, ['a'], 'm1');
    expect(disposition('', true, C('a'), permissions).decision).toMatchObject({
      kind: 'block',
      reason: 'coder_redline',
      evidence: ['events:code-a:0'],
    });
    events[0].data.event.exitCode = 1;
    expect(permissionEvidence(events, ['a'], 'm1')).toEqual([]);
  });
  test('unknown environment cannot advance, non-critical failures become debt', () => {
    for (const failure_class of ['test_env', 'fixture'] as const) {
      const check = {
        ...C('a', false),
        failed: ['check'],
        failures: [{ command: 'check', failure_class, evidence: '/tmp/accept.log' }],
      };
      expect(deliveryDecision({ rechecks: [check] }).decision.kind).toBe(
        failure_class === 'test_env' ? 'block' : 'debt'
      );
    }
    expect(outputSchema.$defs.accept.properties.decision.properties.kind.enum).toEqual([
      'advance',
      'debt',
      'repair',
      'block',
    ]);
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
  p.packages[0].accept = [{ cmd: 'false', timeout_s: 1, cache: true }];
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
  // Runtime sibling import of sa-check.ts; type-only imports are erased and need no copy.
  writeFileSync(
    join(root, 'policy-attempts.ts'),
    readFileSync(join(import.meta.dir, '../templates/.archon/scripts/policy-attempts.ts'))
  );
  writeFileSync(
    join(root, 'failure-class.ts'),
    readFileSync(join(import.meta.dir, '../templates/.archon/scripts/failure-class.ts'))
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
    // Failed settle suspends before budget(), so its probe path omits the events query.
    expect(auxiliary).toHaveLength(count - (kind === 'settle' ? 1 : 0));
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
  ['accept', 'worktree remove', 'probe: kept worktree'],
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
  const started = Date.now();
  const r = auxiliaryFixture('accept', '', true, false, true);
  expect(Date.now() - started).toBeLessThan(6000);
  expect(r.code).toBe(1);
  expect(r.err).toContain('git worktree:');
  expect(r.err).toContain('hook-descendant');
  expect(r.err).toContain('TERM -> SIGKILL; output pipes reclaimed');
  expectAuxiliaryDead(r.trackedPid);
});

function planFile(root: string, accept: string, environment: string[] = []): string {
  const p = join(root, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      environment: environment.map(cmd => ({ cmd, timeout_s: 5 })),
      packages: [{ id: 'a', accept: [{ cmd: accept, timeout_s: 5 }] }],
    })
  );
  return p;
}

describe('sa-check script', () => {
  test('RA: non-product advance passes TESTED with command debt visible in land', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const command = `printf '%s' '{"failure_class":"fixture","evidence":"fixture mismatch"}'; exit 1`;
    const plan = fixturePlan(root, repo, p => {
      p.packages = [{ id: 'a', accept: [{ cmd: command, timeout_s: 5 }] }];
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
  test('B1 same-diff reuses a qualified review after acceptance recovers; contract or identity drift refuses reuse', () => {
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
          accept: [{ cmd: `test -f '${flag}'`, timeout_s: 5 }],
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
      `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(eventsFile)}, 'utf8'));\n`
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
  test('POLICY-R1-03: final review exceeding its reservation cannot PASS or reach land', () => {
    const root = tmp(),
      repo = gitRepo(root),
      p = join(root, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        deadline: '2099-01-01T00:00:00Z',
        mode: 'strict',
        budget: { launches: 2, weighted_tokens: 30 },
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
    expect(exceeded.code).toBe(1);
    expect(exceeded.out).toMatchObject({
      verdict: 'escalate',
      grade: null,
      risk: 'G2',
      reason: 'budget_tokens_exceeded',
    });
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
        failures: commands.map(command => ({ command, failure_class: 'product' })),
      },
    });
    expect(JSON.parse(readFileSync(join(r.art, 'mixed.json'), 'utf8'))).toMatchObject({
      base_results,
    });
    expect(readFileSync(join(r.art, 'mixed.log'), 'utf8').trimEnd().split('\n').at(-1)).toContain(
      JSON.stringify(base_results)
    );
  });
  test('probe never force-removes: a worktree the check dirtied is kept and its path reported', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'echo x > junk.txt; false', ['true']),
      pkgs: 'a',
      tag: 'v3',
      base,
    });
    expect(r.out).toMatchObject({ ok: false, base_pass: false });
    const kept = /probe: kept worktree (\S+):/.exec(r.err)?.[1] ?? '';
    expect(readFileSync(join(kept, 'junk.txt'), 'utf8')).toBe('x\n');
    expect(sh('git worktree list', repo)).toContain(kept);
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
      plan: planFile(root, 'false'),
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
      ['task', 'false', 'repair', 'acceptance_failed', 0],
      ['redline', 'true', 'advance', null, 0],
      ['redline', 'false', 'repair', 'acceptance_failed', 0],
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
    expect(r.out).toMatchObject({ ok: true, disposition: 'advance', reason: null });
    expect(JSON.parse(readFileSync(join(r.art, 'settle-a.coder.json'), 'utf8'))).toMatchObject({
      status: 'done',
      error_class: 'task',
      error_class_ignored: true,
    });
  });
  test('F-18 settle: advance passes through; a repair that stays red suspends repair_exhausted', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const first = { ok: true, disposition: 'advance', reason: null, diff_hash: '', same: false };
    const pass = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, 'false'),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify(first),
      repaired: 'null',
    });
    expect(pass.code).toBe(0);
    expect(pass.out).toMatchObject({ ok: true, disposition: 'advance' });
    const red = runScript(repo, {
      kind: 'settle',
      plan: planFile(root, 'false'),
      pkgs: 'a',
      tag: 'settle-a',
      first: JSON.stringify({ ...first, ok: false, disposition: 'repair' }),
      repaired: JSON.stringify({ status: 'done', error_class: null, needs: [] }),
    });
    expect(red.code).toBe(1);
    expect(red.out).toMatchObject({
      disposition: 'suspend',
      reason: 'repair_exhausted:acceptance_failed',
    });
  });
  test('F-21: cache:true reuses a pass on the same tree; uncached commands always run', () => {
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
              { cmd: `echo c >> ${counter}`, timeout_s: 5, cache: true },
              { cmd: `echo u >> ${counter}`, timeout_s: 5 },
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
