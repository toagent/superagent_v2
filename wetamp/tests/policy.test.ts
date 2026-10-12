import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assertSQLite,
  loadTiers,
  resolveRoute,
  runAliases,
  snapshotPolicy,
  WETAMP,
} from '../src/config';
import { buildWorkflow, engineHash } from '../src/generate';
import { milestones, type Plan } from '../src/plan';
import { decide } from '../templates/.archon/scripts/sa-check';
import { tmp } from './helpers';
const { loadPolicy } = createRequire(import.meta.url)('../bin/codex-readonly-proxy.cjs') as {
  loadPolicy(path: string): Record<string, unknown>;
};
const plan = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
) as Plan;

describe('B1-POLICY frozen routing', () => {
  test('auto and strict coder routes use only Codex and fail without Codex candidates', () => {
    const tiers = loadTiers();
    for (const console of ['claude', 'codex'] as const)
      for (const mode of ['auto', 'strict'])
        for (const role of ['code', 'repair'] as const)
          expect(
            resolveRoute(tiers, console, mode, role).candidates.every(a => a.provider === 'codex')
          ).toBe(true);
    const explicit = resolveRoute(tiers, 'codex', 'single:claude', 'repair').candidates;
    expect(explicit.every(a => a.provider === 'claude')).toBe(true);
    tiers.routing.coder.models = explicit.map(a => a.model);
    for (const mode of ['auto', 'strict'])
      for (const role of ['code', 'repair'] as const)
        expect(() => resolveRoute(tiers, 'codex', mode, role)).toThrow(`no eligible ${role}`);
  });
  test('single vendor filters both roles; risk and round use the owning policy', () => {
    const tiers = loadTiers();
    for (const [mode, provider] of [
      ['single:claude', 'claude'],
      ['single:chatgpt', 'codex'],
    ] as const) {
      const aliases = runAliases('codex', tiers, mode);
      expect(Object.values(aliases).every(a => a.provider === provider)).toBe(true);
      expect(aliases['@sa-reviewer'].model).not.toBe(aliases['@sa-coder'].model);
      for (const risk of ['G0', 'G1', 'G2'] as const) {
        const route = resolveRoute(tiers, 'codex', mode, 'review', risk, 2, [
          aliases['@sa-coder'].model,
        ]);
        expect(
          route.candidates.every(
            a => a.provider === provider && a.model !== aliases['@sa-coder'].model
          )
        ).toBe(true);
        expect(route.effort).toBe(risk === 'G0' ? 'medium' : risk === 'G2' ? 'high' : 'medium');
      }
      const p = { ...plan, mode };
      const workflow = buildWorkflow(
        p,
        milestones(p),
        'single',
        '/GEN',
        false,
        Date.parse('2026-10-09')
      ) as {
        nodes: { command?: string; model?: string; sandbox?: unknown; mcp?: string }[];
      };
      for (const node of workflow.nodes.filter(n => n.command)) {
        expect(aliases[node.model!].provider).toBe(provider);
        if (node.command!.startsWith('sa-review')) {
          expect(!!node.sandbox).toBe(provider === 'claude');
          expect(!!node.mcp).toBe(provider === 'codex');
        }
      }
    }
    expect(() => resolveRoute(tiers, 'claude', 'single:other')).toThrow('unsupported routing mode');
    tiers.routing.reviewer.by_console.claude = [tiers.routing.coder.models[0]];
    expect(() => runAliases('claude', tiers)).toThrow('no eligible review');
  });
  test('policy is complete, detached from live tiers, validated, and part of workflow identity', () => {
    const tiers = loadTiers(),
      frozen = snapshotPolicy(tiers),
      root = tmp();
    const path = join(root, 'policy.json');
    writeFileSync(path, JSON.stringify(frozen));
    expect(loadPolicy(path).exec_profiles).toEqual(tiers.policy.exec_profiles);
    const reordered = Object.fromEntries(Object.entries(tiers).reverse());
    expect(snapshotPolicy(reordered as typeof tiers).hash).toBe(frozen.hash);
    tiers.policy.sandbox.mcp.push('changed');
    expect(frozen.sandbox.mcp).not.toContain('changed');
    expect(snapshotPolicy(tiers).hash).not.toBe(frozen.hash);
    writeFileSync(path, JSON.stringify({ ...frozen, sandbox: tiers.policy.sandbox }));
    expect(() => loadPolicy(path)).toThrow('hash mismatch');
    for (const dir of ['src', 'templates', 'schemas'])
      cpSync(join(WETAMP, dir), join(root, dir), { recursive: true });
    copyFileSync(join(WETAMP, 'tiers.json'), join(root, 'tiers.json'));
    const before = engineHash(root);
    writeFileSync(join(root, 'tiers.json'), JSON.stringify(tiers));
    expect(engineHash(root)).not.toBe(before);
  });
  test('worker pins explicit snapshots, falls back only without a path, and refuses invalid paths', () => {
    const root = tmp(),
      path = join(root, 'policy.json'),
      real = join(root, 'codex');
    const tiers = loadTiers();
    tiers.policy.exec_profiles.coder.codex = { 'features.multi_agent': false, snapshot_test: true };
    tiers.policy.exec_profiles.reviewer.codex = tiers.policy.exec_profiles.coder.codex;
    writeFileSync(path, JSON.stringify(snapshotPolicy(tiers)));
    writeFileSync(
      real,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n'
    );
    chmodSync(real, 0o755);
    const invoke = (policyPath: string) =>
      Bun.spawnSync([join(WETAMP, 'bin/codex-worker'), 'exec', 'x'], {
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: '',
          SA_CODEX_REAL: real,
          SA_POLICY_PATH: policyPath,
          SA_CODEX_HOOK_TRUST: 'unchecked',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    const good = invoke(path);
    expect(good.exitCode).toBe(0);
    expect(JSON.parse(good.stdout.toString())).toContain('snapshot_test=true');
    const fallback = invoke('');
    expect(fallback.exitCode).toBe(0);
    expect(JSON.parse(fallback.stdout.toString())).not.toContain('snapshot_test=true');
    expect(fallback.stderr.toString()).toContain('using current tiers.json policy (not frozen)');
    const { hash: _hash, ...current } = snapshotPolicy(loadTiers());
    expect(loadPolicy('')).toEqual(current);
    const missing = invoke(join(root, 'missing-policy.json'));
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout.toString()).toBe('');
    expect(missing.stderr.toString()).not.toContain('using current tiers.json');
    writeFileSync(path, '{"hash":"broken"}');
    const bad = invoke(path);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout.toString()).toBe('');
    expect(bad.stderr.toString()).not.toContain('using current tiers.json');
    writeFileSync(path, '{');
    expect(invoke(path).exitCode).not.toBe(0);
  });
});

test('SQLite-only rejects shell and Archon-owned env DSNs without disclosing values', () => {
  const root = tmp(),
    archon = join(root, 'archon'),
    repo = join(root, 'repo');
  mkdirSync(archon);
  mkdirSync(join(repo, '.archon'), { recursive: true });
  const before = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = 'postgresql://dummy-only';
    expect(() => assertSQLite(repo, archon)).toThrow('SQLite-only');
    writeFileSync(join(archon, '.env'), 'DATABASE_URL=""\n');
    expect(() => assertSQLite(repo, archon)).not.toThrow();
    writeFileSync(join(repo, '.archon/.env'), 'DATABASE_URL=postgresql://scratch-only\n');
    expect(() => assertSQLite(repo, archon)).toThrow('DATABASE_URL/PostgreSQL');
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});

test('same-diff reuse requires exact candidate and contract, qualified review, no open findings or debt', () => {
  const prior = {
    ok: false,
    same: false,
    diff_hash: 'diff',
    head: 'candidate',
    contract_hash: 'contract',
    risk: 'G1',
  };
  const current = { ...prior, ok: true, same: true, disposition: 'advance' as const };
  const pass = { status: 'PASS' as const, findings: [], debt: [] };
  const input = {
    reviews: [pass, null],
    rechecks: [prior, current],
    risk: 'G1',
    qualifiedReview: true,
  };
  expect(decide(input)).toMatchObject({ verdict: 'pass', reason: null });
  for (const patch of [
    { head: 'different' },
    { head: undefined },
    { contract_hash: 'different' },
    { contract_hash: undefined },
    { diff_hash: 'different' },
    { risk: 'G2' },
    { ok: false },
  ])
    expect(decide({ ...input, rechecks: [prior, { ...current, ...patch }] })).toMatchObject({
      verdict: 'escalate',
      reason: 'no_change',
    });
  expect(decide({ ...input, qualifiedReview: false }).verdict).toBe('escalate');
  expect(decide({ ...input, risk: 'G2' }).verdict).toBe('escalate');
  expect(decide({ ...input, expired: true }).reason).toBe('deadline');
  expect(decide({ ...input, reviews: [{ ...pass, debt: ['open debt'] }, null] }).verdict).toBe(
    'escalate'
  );
  const finding = {
    id: 'R1-1',
    severity: 'low' as const,
    file: 'x',
    line: 1,
    status: 'open' as const,
    carry_over: false,
    evidence: 'evidence',
  };
  expect(decide({ ...input, reviews: [{ ...pass, findings: [finding] }, null] }).verdict).toBe(
    'escalate'
  );
});
