import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOLD_POLICY, CODER_CLASSES, REASONS, reasonOf } from '../src/reasons';
import { askKey, cockpitSignals, supersedeAsks, type Asks } from '../src/cockpit-signals';
import { decisionFields, saveIncident } from '../src/incidents';
import { buildWorkflow, generate } from '../src/generate';
import { inspectBase } from '../src/preflight';
import {
  disposition,
  decide,
  SUSPEND_CLASSES,
  independence,
} from '../templates/.archon/scripts/sa-check';
import mirror from '../templates/.archon/scripts/reasons.json';
import golden from './golden/fake-coder-scenarios.json';
import e5 from './incidents/e5-base.json';
import e7 from './incidents/e7-adopt.json';
import { milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

describe('S4 reason closed set', () => {
  test('registry mirror and generated snapshot derive from one owner; policy has no orphan row', () => {
    expect(mirror).toEqual(REASONS);
    expect(new Set(REASONS.map(r => r.code)).size).toBe(REASONS.length);
    expect(new Set<string>(REASONS.map(r => r.hold))).toEqual(new Set(Object.keys(HOLD_POLICY)));
    for (const r of REASONS)
      expect(Object.keys(HOLD_POLICY).filter(h => h === r.hold)).toHaveLength(1);
    const root = tmp();
    process.env.SUPERAGENT_HOME = join(root, 'home');
    process.env.ARCHON_HOME = join(root, 'home/archon');
    const plan = JSON.parse(readFileSync(fixturePlan(root, root), 'utf8')) as Plan;
    const gen = generate(plan, 'registry', true);
    expect(JSON.parse(readFileSync(join(gen.dir, '.archon/scripts/reasons.json'), 'utf8'))).toEqual(
      REASONS
    );
  });
  test('all coder, repair, gate, limit, budget and independence producers are registered', () => {
    const produced = new Set<string>(['budget_launches_exceeded', 'budget_tokens_exceeded']);
    expect(
      SUSPEND_CLASSES.every(c => CODER_CLASSES.includes(c as (typeof CODER_CLASSES)[number]))
    ).toBe(true);
    for (const status of ['done', 'partial', 'blocked', 'unknown'])
      for (const error_class of [null, ...CODER_CLASSES, 'unknown'])
        for (const ok of [false, true])
          for (const needs of [[], [{ cap: 'x', why: 'fixture', minimal_ask: 'fixture' }]]) {
            const d = disposition(JSON.stringify({ status, error_class, needs }), ok);
            if (d.reason) produced.add(d.reason);
            if (d.disposition === 'repair') produced.add(`repair_exhausted:${d.reason}`);
          }
    produced.add(disposition('{invalid', true).reason!);
    for (const author of [undefined, 'a'])
      for (const reviewer of [undefined, 'a', 'b']) {
        const why = independence(
          [{ model: author ?? null, strength: author ? 'provider' : 'unknown' }],
          { model: reviewer ?? null, strength: reviewer ? 'provider' : 'unknown' }
        );
        if (why) produced.add(`review_not_independent:${why}`);
      }
    for (const reason of [...produced])
      for (const rounds of [1, 3]) {
        const d = decide({
          reviews: Array.from({ length: rounds }, () => null),
          rechecks: [
            { ok: false, disposition: 'suspend', reason, diff_hash: 'fixture', same: false },
          ],
          risk: 'G1',
        });
        if (d.reason) produced.add(d.reason);
      }
    for (const status of ['PASS', 'FAIL', 'INCOMPLETE'] as const)
      for (const ok of [true, false])
        for (const rounds of [1, 3]) {
          const reviews = Array.from({ length: rounds }, () => ({
            status,
            findings: [
              {
                id: 'x',
                severity: 'high' as const,
                file: 'x',
                line: 1,
                status: 'open' as const,
                evidence: 'fixture',
                carry_over: false,
              },
            ],
            debt: [],
          }));
          for (const duplicate of [false, true]) {
            if (duplicate) reviews[0].findings.push(reviews[0].findings[0]);
            const d = decide({
              reviews,
              rechecks: [{ ok, diff_hash: 'fixture', same: false }],
              risk: 'G1',
            });
            if (d.reason) produced.add(d.reason);
          }
        }
    for (const code of produced) expect(reasonOf(code), code).toBeDefined();
    expect(reasonOf('coder_error:unknown')).toBeUndefined();
    expect(reasonOf('new_failure+review_limit')).toBeUndefined();
  });
});

test('S4 golden fake coder scenarios execute their generated output contract', () => {
  const root = tmp(),
    repo = gitRepo(root);
  const plan = JSON.parse(readFileSync(fixturePlan(root, repo), 'utf8')) as Plan;
  const old = process.env.FAKE_CODER_SCENARIO;
  try {
    for (const [scenario, expected] of Object.entries(golden)) {
      process.env.FAKE_CODER_SCENARIO = scenario;
      const wf = buildWorkflow(plan, milestones(plan), 'fake', join(root, 'gen'), true) as {
        nodes: { id: string; bash?: string }[];
      };
      const body = wf.nodes.find(n => n.id === 'code-core')!.bash!;
      const raw = sh(body, repo).trim().split('\n').at(-1)!;
      expect<unknown>(expected.decision).toEqual(disposition(raw, true));
      if ('status' in expected)
        expect(JSON.parse(raw)).toMatchObject({
          status: expected.status,
          error_class: expected.error_class,
        });
      else expect(raw).toBe(expected.raw);
    }
  } finally {
    if (old === undefined) delete process.env.FAKE_CODER_SCENARIO;
    else process.env.FAKE_CODER_SCENARIO = old;
  }
});

test('E7 adopt partial+env+green still advances (HF4)', () => {
  expect(e7.expected).toBe(disposition(JSON.stringify(e7.coder), e7.ok).disposition);
});

test('E5 preflight refuses a repository without a detectable base and names worktree.baseBranch', async () => {
  const root = tmp();
  sh(`git init -q -b '${e5.branch}'`, root);
  await expect(inspectBase(root)).rejects.toThrow(e5.fix);
  mkdirSync(join(root, '.archon'));
  writeFileSync(join(root, '.archon/config.yaml'), `worktree:\n  baseBranch: ${e5.branch}\n`);
  await expect(inspectBase(root)).resolves.toBeUndefined();
});

test('I4 canonical migration, hold change and terminal supersession expose stale, duplicate and orphan counts', () => {
  const asks: Asks = {
    'r:environment:1': { id: 'a', status: 'pending' },
    'r:environment:2': { id: 'b', status: 'yes' },
  };
  expect(cockpitSignals([], asks).dup_ask).toBe(1);
  supersedeAsks(asks, 'r', 'environment');
  expect(asks[askKey('r', 'environment')]).toMatchObject({ id: 'a', status: 'pending' });
  expect(cockpitSignals([], asks)).toMatchObject({ dup_ask: 0, stale_answer: 1 });
  supersedeAsks(asks, 'r', 'engine_suspect');
  expect(asks['r:environment']?.status).toBe('superseded');
  const hold = {
    run_id: 'r',
    hold: 'engine_suspect',
    since: '2020-01-01T00:00:00Z',
    disposed: false,
  };
  expect(cockpitSignals([hold], asks)).toMatchObject({ orphan_hold: 1, engine_suspect: 1 });
  expect(cockpitSignals([{ ...hold, disposed: true }], asks).orphan_hold).toBe(0);
  const pending: Asks = { 'r:engine_suspect': { status: 'unknown' } };
  expect(cockpitSignals([hold], pending).orphan_hold).toBe(0);
  supersedeAsks(pending, 'r');
  expect(pending['r:engine_suspect']?.status).toBe('superseded');
});

test('I5 incident projection is atomic, deduplicated and excludes prompt, transcript, argv and arbitrary prose', () => {
  const root = tmp();
  process.env.SUPERAGENT_HOME = join(root, 'home');
  process.env.ARCHON_HOME = join(root, 'home/archon');
  const plan = JSON.parse(readFileSync(fixturePlan(root, root), 'utf8')) as Plan;
  const art = join(root, 'art');
  mkdirSync(art);
  const input = {
    ok: true,
    status: 'partial',
    error_class: 'env',
    reason: 'coder_partial',
    prompt: 'PRIVATE',
    transcript: 'PRIVATE',
    argv: ['PRIVATE'],
    log: 'PRIVATE',
    notes: 'PRIVATE',
  };
  writeFileSync(join(art, 'verify-core.json'), JSON.stringify(input));
  writeFileSync(join(art, 'verify-core.coder.json'), JSON.stringify(input));
  saveIncident('r', art, 'settle-core', plan, { run: 'old', current: 'new' });
  const path = join(root, 'home/incidents/r/sample.json');
  expect(existsSync(path)).toBe(true);
  const bytes = readFileSync(path, 'utf8');
  expect(bytes).not.toContain('PRIVATE');
  expect(JSON.parse(bytes).inputs_outputs['verify-core.coder']).toEqual(decisionFields(input));
  writeFileSync(join(art, 'verify-core.json'), '{"ok":false}');
  saveIncident('r', art, 'settle-core', plan, { run: 'new', current: 'new' });
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readdirSync(join(root, 'home/incidents'))).toEqual(['r']);
  expect(decisionFields({ reason: 'Bearer private token', status: 'PRIVATE', error_class: 'PRIVATE', argv: 'PRIVATE' })).toEqual({ unregistered_reason: true });
});
