import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, openBlocking } from '../templates/.archon/scripts/sa-check';
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
const ids = (reviews: Rv[], risk = 'G1'): string[] => [...openBlocking(reviews, risk)].sort();

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
    expect(decide({ reviews: [R('PASS', [], ['tidy'])], rechecks: [C('a')], risk: 'G1' })).toEqual({
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
    expect(decide({ reviews: [r1, r2], rechecks: [C('a'), C('b')], risk: 'G1' })).toEqual({
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
  test('no review is a wiring error', () => {
    expect(() => decide({ reviews: [], rechecks: [], risk: 'G1' })).toThrow(/no review/);
    expect(() => decide({ reviews: [null], rechecks: [C('a')], risk: 'G1' })).toThrow(/no review/);
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
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});
