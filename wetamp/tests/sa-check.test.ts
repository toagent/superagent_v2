import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blocking, decide } from '../templates/.archon/scripts/sa-check';
import { gitRepo, sh, tmp } from './helpers';

const SCRIPT = join(import.meta.dir, '..', 'templates', '.archon', 'scripts', 'sa-check.ts');
type F = Parameters<typeof blocking>[0]['findings'][number];
const f = (severity: F['severity'], extra: Partial<F> = {}): F => ({ id: 'x', severity, status: 'open', carry_over: false, ...extra });
const review = (status: 'PASS' | 'FAIL', findings: F[] = [], debt: string[] = []): { status: 'PASS' | 'FAIL'; findings: F[]; debt: string[] } => ({ status, findings, debt });

describe('gate rules', () => {
  test('no review rounds: pass iff every verify ok', () => {
    expect(decide({ reviews: [], rechecks: [], verify: [true, true], risk: 'G1' }).verdict).toBe('pass');
    expect(decide({ reviews: [], rechecks: [], verify: [true, false], risk: 'G1' })).toMatchObject({ verdict: 'escalate', reason: 'acceptance_failed' });
  });
  test('R1: open high blocks G1; medium does not', () => {
    expect(blocking(review('FAIL', [f('high'), f('medium')]), 1, 'G1').map(x => x.severity)).toEqual(['high']);
  });
  test('R1: G2 also blocks on medium', () => {
    expect(blocking(review('FAIL', [f('medium'), f('low')]), 1, 'G2').map(x => x.severity)).toEqual(['medium']);
  });
  test('R2+: new non-blocker findings do not block; carry-over high does', () => {
    const r = review('FAIL', [f('high'), f('high', { carry_over: true, id: 'R1-1' }), f('blocker')]);
    expect(blocking(r, 2, 'G1').map(x => x.severity)).toEqual(['high', 'blocker']);
  });
  test('closed findings never block', () => {
    expect(blocking(review('PASS', [f('blocker', { status: 'closed' })]), 1, 'G1')).toEqual([]);
  });
  test('PASS with no blocking findings and green recheck passes, carrying debt', () => {
    const d = decide({ reviews: [review('FAIL', [f('high')]), review('PASS', [], ['tidy'])], rechecks: [{ ok: true, diff_hash: 'a' }], verify: [false], risk: 'G1' });
    expect(d).toEqual({ verdict: 'pass', rounds: 2, reason: null, debt: ['tidy'] });
  });
  test('latest recheck outranks initial verify', () => {
    expect(decide({ reviews: [review('PASS')], rechecks: [{ ok: false, diff_hash: 'a' }], verify: [true], risk: 'G1' }).reason).toBe('acceptance_failed');
  });
  test('PASS that still lists an open blocker is inconsistent and escalates', () => {
    expect(decide({ reviews: [review('PASS', [f('blocker')])], rechecks: [], verify: [true], risk: 'G1' }).reason).toBe('review_inconsistent');
  });
  test('FAIL after identical fix diffs escalates as no_change', () => {
    const d = decide({ reviews: [review('FAIL'), review('FAIL'), review('FAIL')], rechecks: [{ ok: true, diff_hash: 'h' }, { ok: true, diff_hash: 'h' }], verify: [true], risk: 'G1' });
    expect(d).toMatchObject({ verdict: 'escalate', rounds: 3, reason: 'review_failed+no_change' });
  });
});

function runScript(cwd: string, inputs: Record<string, string>): { code: number; out: unknown; err: string; art: string } {
  const art = join(cwd, '..', 'art');
  mkdirSync(art, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ARTIFACTS_DIR: art };
  for (const [k, v] of Object.entries(inputs)) env[`INPUTS_${k.toUpperCase()}`] = v;
  const p = Bun.spawnSync(['bun', SCRIPT], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const out = p.stdout.toString().trim();
  return { code: p.exitCode, out: out ? (JSON.parse(out) as unknown) : null, err: p.stderr.toString(), art };
}

function planFile(root: string, accept: string, environment: string[] = []): string {
  const p = join(root, 'plan.json');
  writeFileSync(p, JSON.stringify({ environment: environment.map(cmd => ({ cmd, timeout_s: 5 })), packages: [{ id: 'a', accept: [{ cmd: accept, timeout_s: 5 }] }] }));
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
    const r = runScript(gitRepo(root), { kind: 'accept', plan: planFile(root, 'echo accepted'), pkgs: 'a', tag: 'verify-a' });
    expect(r.out).toMatchObject({ ok: true, failed: [] });
    expect(readFileSync(join(r.art, 'verify-a.log'), 'utf8')).toContain('accepted');
  });
  test('accept: uncommitted change fails even when commands pass', () => {
    const root = tmp();
    const repo = gitRepo(root);
    writeFileSync(join(repo, 'stray.txt'), 'x');
    expect(runScript(repo, { kind: 'accept', plan: planFile(root, 'true'), pkgs: 'a', tag: 'verify-a' }).out).toMatchObject({ ok: false });
  });
  test('accept: timeout kills the command and fails it', () => {
    const root = tmp();
    const p = join(root, 'plan.json');
    writeFileSync(p, JSON.stringify({ packages: [{ id: 'a', accept: [{ cmd: 'sleep 5', timeout_s: 1 }] }] }));
    const r = runScript(gitRepo(root), { kind: 'accept', plan: p, pkgs: 'a', tag: 'verify-a' });
    expect(r.out).toMatchObject({ ok: false, failed: ['sleep 5'] });
  });
  test('accept with base: writes patch and stable diff hash', () => {
    const root = tmp();
    const repo = gitRepo(root);
    const base = sh('git rev-parse HEAD', repo).trim();
    sh('echo y > y.txt && git add y.txt && git -c user.name=t -c user.email=t@l commit -qm y', repo);
    const r = runScript(repo, { kind: 'accept', plan: planFile(root, 'true'), pkgs: 'a', tag: 'diff-m1', base });
    const out = r.out as { patch: string; diff_hash: string };
    expect(readFileSync(out.patch, 'utf8')).toContain('+y');
    expect(out.diff_hash).toMatch(/^[0-9a-f]{16}$/);
  });
  test('gate: escalation writes gate json and exits 1', () => {
    const root = tmp();
    const r = runScript(gitRepo(root), { kind: 'gate', milestone: 'm1', risk: 'G1', verify_0: 'false' });
    expect(r.code).toBe(1);
    expect(JSON.parse(readFileSync(join(r.art, 'gate-m1.json'), 'utf8'))).toMatchObject({ verdict: 'escalate', reason: 'acceptance_failed' });
  });
  test('land: fast-forward when base is an ancestor, no-ff otherwise; never pushes', () => {
    const root = tmp();
    const repo = gitRepo(root);
    sh('git switch -qc sa/x && echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@l commit -qm z', repo);
    const ff = runScript(repo, { kind: 'land', base_ref: 'origin/main' }).out as { commands: string[] };
    expect(ff.commands[1]).toContain("merge --ff-only 'sa/x'");
    expect(ff.commands.join(' ')).not.toContain('push');
    sh('git switch -q main && echo w > w.txt && git add w.txt && git -c user.name=t -c user.email=t@l commit -qm w && git switch -q sa/x', repo);
    expect((runScript(repo, { kind: 'land', base_ref: 'main' }).out as { commands: string[] }).commands[1]).toContain('--no-ff');
  });
  test('unknown kind fails loudly', () => {
    const root = tmp();
    expect(runScript(gitRepo(root), { kind: 'bogus' }).code).not.toBe(0);
  });
});
