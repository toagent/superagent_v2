import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decide,
  disposition,
  identityOf,
  independence,
  ledgerOf,
  scopeRisk,
  SUSPEND_CLASSES,
} from '../templates/.archon/scripts/sa-check';
import { gitRepo, sh, tmp } from './helpers';

const SCRIPT = join(import.meta.dir, '..', 'templates', '.archon', 'scripts', 'sa-check.ts');
type Rv = NonNullable<Parameters<typeof decide>[0]['reviews'][number]>;
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
    expect(ids([r1, r2, R('PASS', [])])).toEqual(['R1-2']);
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
  test('G1: an R1 medium omitted in R2 stays debt; closing it with evidence clears it', () => {
    const r1 = R('FAIL', [f('high', { id: 'R1-1' }), f('medium', { id: 'R1-2' })]);
    const pass = (r2: Rv): string[] =>
      decide({ reviews: [r1, r2], rechecks: [C('a'), C('b')], risk: 'G1' }).debt;
    expect(pass(R('PASS', [fixed('R1-1')]))).toEqual(['R1-2 medium a.ts:1']);
    expect(pass(R('PASS', [fixed('R1-1'), fixed('R1-2', 'medium')]))).toEqual([]);
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
  test('ledger: R2 漏掉 R1 高危——遗漏的 high 仍阻塞，PASS 判为不一致，R3 仍遗漏则到上限 escalate', () => {
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
    ).toMatchObject({ verdict: 'escalate', reason: 'review_inconsistent+review_limit' });
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
    expect(() => decide({ reviews: [], rechecks: [], risk: 'G1' })).toThrow(/no review/);
    expect(() => decide({ reviews: [null], rechecks: [C('a')], risk: 'G1' })).toThrow(/no review/);
  });
});

describe('F-18 disposition', () => {
  const c = (o: Record<string, unknown>): string =>
    JSON.stringify({ status: 'done', error_class: null, needs: [], ...o });
  test('green acceptance advances unless a redline or blocked needs prevents it', () => {
    expect(disposition(c({}), true)).toEqual({ disposition: 'advance', reason: null });
    expect(disposition(c({}), false)).toEqual({
      disposition: 'repair',
      reason: 'acceptance_failed',
    });
    expect(disposition('', true).disposition).toBe('advance');
  });
  test('every coder failure kind has an explicit repair or suspend path', () => {
    const d = (o: Record<string, unknown>, ok = true): string | null => {
      const r = disposition(c(o), ok);
      return `${r.disposition}:${r.reason ?? ''}`;
    };
    expect(disposition(c({ status: 'partial' }), true)).toEqual({
      disposition: 'advance',
      reason: null,
      coder_partial: true,
      self_report_conflict: true,
    });
    expect(d({ status: 'partial' }, false)).toBe('repair:coder_partial');
    expect(d({ status: 'blocked' })).toBe('advance:');
    expect(d({ status: 'blocked', needs: [{ cap: 'network' }] })).toBe('suspend:coder_needs');
    expect(d({ status: 'blocked', error_class: 'redline' })).toBe('suspend:coder_redline');
    expect(d({ status: 'partial', error_class: 'env' }, false)).toBe('suspend:coder_error:env');
    expect(d({ status: 'partial', error_class: 'timeout' }, false)).toBe('repair:coder_partial');
    expect(disposition('not json', true)).toEqual({
      disposition: 'suspend',
      reason: 'coder_output_invalid',
    });
  });
  test('HF1: done uses acceptance evidence while redline still suspends', () => {
    for (const error_class of [
      'task',
      'env',
      'timeout',
      'sandbox_denied',
      'permission_denied',
      'vendor_unavailable_all',
      'budget_exhausted',
      'plan_invalid',
      'scope_violation',
    ]) {
      expect(disposition(c({ error_class }), true)).toEqual({
        disposition: 'advance',
        reason: null,
        error_class_ignored: true,
        self_report_conflict: true,
      });
      expect(disposition(c({ error_class }), false)).toEqual({
        disposition: SUSPEND_CLASSES.includes(error_class) ? 'suspend' : 'repair',
        reason: SUSPEND_CLASSES.includes(error_class)
          ? `coder_error:${error_class}`
          : 'acceptance_failed',
      });
    }
    expect(disposition(c({ error_class: 'redline' }), true)).toEqual({
      disposition: 'suspend',
      reason: 'coder_redline',
    });
  });
});

describe('HF4 I1 exhaustive disposition table', () => {
  // 每行定义红验收的判定；绿验收只受 redline 和 blocked needs 的优先规则约束。
  const rows: { error_class: string | null; red: ReturnType<typeof disposition> | null }[] = [
    ...SUSPEND_CLASSES.map(error_class => ({
      error_class,
      red: { disposition: 'suspend' as const, reason: `coder_error:${error_class}` },
    })),
    { error_class: 'redline', red: { disposition: 'suspend', reason: 'coder_redline' } },
    ...['task', null, 'unknown'].map(error_class => ({ error_class, red: null })),
  ];
  for (const status of ['done', 'partial', 'blocked', 'unknown'])
    for (const { error_class, red } of rows)
      for (const ok of [true, false])
        for (const needs of [[], [{ cap: 'network' }]])
          test(`${status}/${String(error_class)}/ok=${String(ok)}/needs=${String(needs.length)}`, () => {
            const expected: ReturnType<typeof disposition> =
              error_class === 'redline'
                ? { disposition: 'suspend', reason: 'coder_redline' }
                : status === 'blocked' && needs.length > 0
                  ? { disposition: 'suspend', reason: 'coder_needs' }
                  : ok
                    ? {
                        disposition: 'advance',
                        reason: null,
                        ...(status !== 'done' || error_class ? { self_report_conflict: true } : {}),
                        ...(status === 'partial' ? { coder_partial: true } : {}),
                        ...(error_class ? { error_class_ignored: true } : {}),
                      }
                    : (red ?? {
                        disposition: 'repair',
                        reason: status === 'done' ? 'acceptance_failed' : 'coder_partial',
                      });
            expect(disposition(JSON.stringify({ status, error_class, needs }), ok)).toEqual(
              expected
            );
          });
  test('invalid JSON suspends before green or red acceptance', () => {
    for (const ok of [true, false])
      expect(disposition('{', ok)).toEqual({
        disposition: 'suspend',
        reason: 'coder_output_invalid',
      });
  });
  test('E7: partial + env + green checks advances with all audit markers', () => {
    // 原始 node_completed 事件的 structured_output，仅将 notes 置空脱敏。
    const coder: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, 'incidents/e7-coder.json'), 'utf8')
    );
    expect(disposition(JSON.stringify(coder), true)).toEqual({
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
  inputs: Record<string, string>
): { code: number; out: unknown; err: string; art: string } {
  const art = join(cwd, '..', 'art');
  mkdirSync(art, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ARTIFACTS_DIR: art,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUTS_${k.toUpperCase()}`] = v;
  const p = Bun.spawnSync(['bun', SCRIPT], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const out = p.stdout.toString().trim();
  return {
    code: p.exitCode,
    out: out ? (JSON.parse(out) as unknown) : null,
    err: p.stderr.toString(),
    art,
  };
}

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
  });
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
  test('accept with base: failing command is probed at base (pre-existing vs introduced)', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    sh('git rm -q README.md && git -c user.name=t -c user.email=t@l commit -qm rm', repo);
    const introduced = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'test -f README.md'),
      pkgs: 'a',
      tag: 'v1',
      base,
    });
    expect(introduced.out).toMatchObject({ ok: false, base_pass: true });
    expect(readFileSync(join(introduced.art, 'v1.probe.log'), 'utf8')).toContain('exit=0');
    const preexisting = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'test -f nope'),
      pkgs: 'a',
      tag: 'v2',
      base,
    });
    expect(preexisting.out).toMatchObject({ ok: false, base_pass: false });
    expect(sh('git worktree list', repo).trim().split('\n')).toHaveLength(1);
  });
  test('probe never force-removes: a worktree the check dirtied is kept and its path reported', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    const r = runScript(repo, {
      kind: 'accept',
      plan: planFile(root, 'echo x > junk.txt; false'),
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
  test('F-18: coder redline suspends with exit 1 and a stable reason', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), {
      kind: 'accept',
      plan: planFile(root, 'true'),
      pkgs: 'a',
      tag: 'verify-a',
      coder: JSON.stringify({ status: 'blocked', error_class: 'redline', needs: [] }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: true, disposition: 'suspend', reason: 'coder_redline' });
  });
  test('HF1: accept preserves ignored error_class in the coder archive only on green', () => {
    const root = tmp();
    const repo = gitRepo(root);
    for (const [error_class, acceptance, disposition, reason, code] of [
      ['task', 'true', 'advance', null, 0],
      ['task', 'false', 'repair', 'acceptance_failed', 0],
      ['redline', 'true', 'suspend', 'coder_redline', 1],
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
      const saved = JSON.parse(readFileSync(join(r.art, `${tag}.coder.json`), 'utf8'));
      expect(saved).toMatchObject({ status: 'done', error_class });
      expect(saved.error_class_ignored).toBe(disposition === 'advance' ? true : undefined);
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
  });
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});
