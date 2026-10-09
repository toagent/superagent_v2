import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blocking, decide } from '../templates/.archon/scripts/sa-check';
import { gitRepo, sh, tmp } from './helpers';

const SCRIPT = join(import.meta.dir, '..', 'templates', '.archon', 'scripts', 'sa-check.ts');
type F = Parameters<typeof blocking>[0]['findings'][number];
const f = (severity: F['severity'], extra: Partial<F> = {}): F => ({
  id: 'x',
  severity,
  status: 'open',
  carry_over: false,
  ...extra,
});
const review = (
  status: 'PASS' | 'FAIL',
  findings: F[] = [],
  debt: string[] = []
): { status: 'PASS' | 'FAIL'; findings: F[]; debt: string[] } => ({ status, findings, debt });

const R = review;
const C = (diff_hash: string, ok = true): { ok: boolean; diff_hash: string } => ({ ok, diff_hash });

describe('gate rules', () => {
  test('R1: open high blocks G1; medium does not', () => {
    expect(
      blocking(review('FAIL', [f('high'), f('medium')]), 1, 'G1').map(x => x.severity)
    ).toEqual(['high']);
  });
  test('R1: G2 also blocks on medium', () => {
    expect(blocking(review('FAIL', [f('medium'), f('low')]), 1, 'G2').map(x => x.severity)).toEqual(
      ['medium']
    );
  });
  test('R2+: new non-blocker findings do not block; carry-over high does', () => {
    const r = review('FAIL', [
      f('high'),
      f('high', { carry_over: true, id: 'R1-1' }),
      f('blocker'),
    ]);
    expect(blocking(r, 2, 'G1').map(x => x.severity)).toEqual(['high', 'blocker']);
  });
  test('closed findings never block', () => {
    expect(blocking(review('PASS', [f('blocker', { status: 'closed' })]), 1, 'G1')).toEqual([]);
  });
  test('r1 PASS with green acceptance passes, carrying debt', () => {
    expect(decide({ reviews: [R('PASS', [], ['tidy'])], rechecks: [C('a')], risk: 'G1' })).toEqual({
      verdict: 'pass',
      rounds: 1,
      reason: null,
      debt: ['tidy'],
    });
  });
  test('r1 FAIL asks for a fix round', () => {
    expect(
      decide({ reviews: [R('FAIL', [f('high')])], rechecks: [C('a')], risk: 'G1' })
    ).toMatchObject({ verdict: 'fix', reason: 'review_failed' });
  });
  test('r2 PASS after a changed fix diff passes', () => {
    expect(
      decide({
        reviews: [R('FAIL', [f('high')]), R('PASS')],
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
  test('a fix round that changed nothing escalates as no_change', () => {
    expect(
      decide({ reviews: [R('FAIL'), R('FAIL')], rechecks: [C('h'), C('h')], risk: 'G1' })
    ).toMatchObject({ verdict: 'escalate', reason: 'review_failed+no_change' });
  });
  test('past the plan deadline a failing gate escalates instead of fixing', () => {
    expect(
      decide({ reviews: [R('FAIL')], rechecks: [C('a')], risk: 'G1', expired: true })
    ).toMatchObject({ verdict: 'escalate', reason: 'review_failed+deadline' });
  });
  test('INCOMPLETE review escalates immediately', () => {
    expect(
      decide({
        reviews: [{ status: 'INCOMPLETE', findings: [], debt: [] }],
        rechecks: [C('a')],
        risk: 'G1',
      })
    ).toMatchObject({ verdict: 'escalate', reason: 'review_incomplete' });
  });
  test('no review is a wiring error', () => {
    expect(() => decide({ reviews: [], rechecks: [], risk: 'G1' })).toThrow(/no review/);
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
    expect(r.out).toMatchObject({ ok: true, base_pass: null });
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
      reason: 'review_failed+deadline',
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
  test('land: fast-forward when base is an ancestor, no-ff otherwise; never pushes', () => {
    const root = tmp();
    const repo = gitRepo(root);
    sh(
      'git switch -qc sa/x && echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@l commit -qm z',
      repo
    );
    const ff = runScript(repo, { kind: 'land', base_ref: 'origin/main' }).out as {
      commands: string[];
    };
    expect(ff.commands[1]).toContain("merge --ff-only 'sa/x'");
    expect(ff.commands.join(' ')).not.toContain('push');
    sh(
      'git switch -q main && echo w > w.txt && git add w.txt && git -c user.name=t -c user.email=t@l commit -qm w && git switch -q sa/x',
      repo
    );
    expect(
      (runScript(repo, { kind: 'land', base_ref: 'main' }).out as { commands: string[] })
        .commands[1]
    ).toContain('--no-ff');
  });
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});
