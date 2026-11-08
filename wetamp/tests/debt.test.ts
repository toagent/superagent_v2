import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli';
import { loadTiers } from '../src/config';
import { buildWorkflow } from '../src/generate';
import * as debt from '../src/debt';
import { planPrecheck } from '../src/plan-precheck';
import { milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
const source = (repo: string, output: string, run: string, text: string): debt.DebtSource => {
  const art = join(output, 'artifacts', 'runs', run);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'gate-m1-r1.json'), JSON.stringify({ decision: { debt: [text] } }));
  return {
    ledger: { run_id: run, archon_run_id: run, repo },
    run: { id: run, status: 'completed', output_root: output },
  };
};

test('stable IDs deduplicate linked worktrees; integrated closure is idempotent and metrics use local today', () => {
  const repo = gitRepo(tmp()),
    worktree = join(tmp(), 'linked'),
    output = tmp(),
    closures = join(tmp(), 'closures.jsonl');
  sh(`git worktree add -q -b debt-test '${worktree}'`, repo);
  const text = 'medium src/a.ts:1 keep explicit state',
    sources = [source(repo, output, 'r1', text), source(worktree, output, 'r2', text)];
  const open = debt.debtSnapshot(sources, closures),
    canonical = debt.canonicalRepo(repo);
  expect(debt.canonicalRepo(worktree)).toBe(canonical);
  expect(open.debts).toEqual([
    expect.objectContaining({ id: debt.debtId(canonical, text), status: 'open' }),
  ]);
  const plan = join(tmp(), 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({ repo, packages: [{ id: 'p', closes_debt: [open.debts[0].id] }] })
  );
  expect(debt.closePlannedDebts(plan, 'integrated-run', 'm1', closures)).toHaveLength(1);
  expect(debt.closePlannedDebts(plan, 'integrated-run', 'm1', closures)).toEqual([]);
  const generated = JSON.parse(readFileSync(fixturePlan(tmp(), repo), 'utf8')) as Plan;
  // prettier-ignore
  const workflow = buildWorkflow(
    generated, milestones(generated), 'de14-0001', '/GEN', false, Date.now(), loadTiers(), undefined,
    { checkout: repo, branch: 'main', head: 'a'.repeat(40) });
  const publish = (
    workflow.nodes as { loop_group?: { nodes?: { id?: string; script?: string }[] } }[]
  )
    .flatMap(node => node.loop_group?.nodes ?? [])
    .find(node => node.id === 'publish-m1')!;
  expect(publish.script).toContain('closePlannedDebts');
  const closed = debt.debtSnapshot(sources, closures);
  // prettier-ignore
  expect(debt.debtMetrics(closed)).toMatchObject({ debt: 0, debt_open: 0, debt_new_today: 1, debt_closed_today: 1 });
  writeFileSync(closures, readFileSync(closures, 'utf8') + '{"at":"2020-01-01T00:00:00Z"}\n');
  // prettier-ignore
  expect(debt.debtMetrics(debt.debtSnapshot(sources, closures))).toMatchObject({ debt_open: 0, debt_closed_today: 1, debt_bad_closure_lines: 1 });
  writeFileSync(closures, readFileSync(closures, 'utf8') + 'bad line\n');
  // prettier-ignore
  expect(debt.debtMetrics(debt.debtSnapshot(sources, closures))).toMatchObject({ debt_open: 0, debt_new_today: 1, debt_closed_today: 'unknown', debt_bad_closure_lines: 2 });
});

test('unreadable evidence preserves totals and only obscures a relevant daily metric', () => {
  // prettier-ignore
  const repo = gitRepo(tmp()), output = tmp(), closures = join(tmp(), 'closures.jsonl'), readable = source(repo, output, 'readable', 'debt');
  // prettier-ignore
  const missing = (id: string, status: 'running' | 'completed', started_at?: string): debt.DebtSource => ({ ledger: { run_id: id, archon_run_id: id, repo }, run: { id, status, output_root: join(output, id), started_at } });
  // prettier-ignore
  const historical = debt.debtMetrics(debt.debtSnapshot([readable, missing('old', 'completed', '2020-01-01T00:00:00Z')], closures));
  // prettier-ignore
  expect(historical).toMatchObject({ debt: 1, debt_open: 1, debt_unreadable: 1, debt_new_today: 1, debt_closed_today: 0 });
  // prettier-ignore
  const today = new Date().toISOString(), broken = missing('today', 'completed', today), brokenArt = join(output, 'today/artifacts/runs/today');
  mkdirSync(brokenArt, { recursive: true });
  writeFileSync(join(brokenArt, 'gate-m1-r1.json'), '{');
  const currentSnapshot = debt.debtSnapshot([readable, broken], closures);
  expect(currentSnapshot).toMatchObject({
    unreadable: 1,
    unreadable_started_at: [today],
    unreadable_sources: [{ run_id: 'today', started_at: today, reason: 'gate_unreadable' }],
  });
  const current = debt.debtMetrics(currentSnapshot);
  // prettier-ignore
  expect(current).toMatchObject({ debt: 1, debt_open: 1, debt_unreadable: 1, debt_new_today: 'unknown', debt_closed_today: 0 });
  // A current in-flight run without gate evidence has no debt yet.
  expect(
    debt.debtMetrics(
      debt.debtSnapshot([readable, missing('live', 'running', new Date().toISOString())], closures)
    )
  ).toMatchObject({ debt_unreadable: 0, debt_new_today: 1 });
  const empty = missing('empty', 'completed', new Date().toISOString());
  empty.ledger.repo = join(output, 'deleted');
  mkdirSync(join(output, 'empty/artifacts/runs/empty'), { recursive: true });
  writeFileSync(
    join(output, 'empty/artifacts/runs/empty/gate-m1-r1.json'),
    JSON.stringify({ decision: { debt: ['ignored'] } })
  );
  expect(debt.debtMetrics(debt.debtSnapshot([readable, empty], closures))).toMatchObject({
    debt_unreadable: 0,
    debt_new_today: 1,
  });
  // A run the engine database no longer knows still carries its ledger submission time.
  // prettier-ignore
  const orphan: debt.DebtSource = { ledger: { run_id: 'gone', archon_run_id: 'gone', repo, started_at: '2020-01-01T00:00:00Z' }, run: new Error('not_found') };
  // prettier-ignore
  expect(debt.debtMetrics(debt.debtSnapshot([readable, orphan], closures))).toMatchObject({ debt_unreadable: 1, debt_new_today: 1 });
  // prettier-ignore
  const undated: debt.DebtSource = { ledger: { run_id: 'undated', archon_run_id: 'undated', repo, rejected: 'undated' }, run: new Error('not_found') };
  // prettier-ignore
  expect(debt.debtMetrics(debt.debtSnapshot([readable, undated], closures))).toMatchObject({ debt_unreadable: 0, debt_new_today: 1 });
});

test('CLI lists and explicitly closes debt; plan precheck warns for an unknown ID', () => {
  const root = tmp(),
    repo = gitRepo(tmp()),
    output = tmp(),
    run = 'engine',
    text = 'low src/b.ts:2 remove drift';
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: join(root, 'archon') });
  for (const dir of ['runs', 'archon']) mkdirSync(join(root, dir), { recursive: true });
  source(repo, output, run, text);
  writeFileSync(
    join(root, 'runs/r.json'),
    JSON.stringify({ run_id: 'r', archon_run_id: run, repo })
  );
  const bin = join(root, 'archon-stub'),
    view = { id: run, status: 'completed', output_root: output };
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(view)}'\n`, { mode: 0o755 });
  process.env.SA_ARCHON_BIN = bin;
  const logs: string[] = [],
    original = console.log;
  console.log = value => logs.push(String(value));
  try {
    expect(main(['debt', 'list', '--json'])).toBe(0);
    const listed = JSON.parse(logs.pop()!) as { id: string; repo: string; status: string }[];
    expect(listed[0]).toMatchObject({ repo: debt.canonicalRepo(repo), status: 'open' });
    expect(main(['debt', 'close', listed[0].id, '--reason', 'fixed'])).toBe(0);
    expect(main(['debt', 'list', '--open', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!)).toEqual([]);
    // prettier-ignore
    const plan = { repo, base_ref: 'HEAD', budget: { weighted_tokens: 1 }, packages: [{ id: 'p', title: 'p', goal: 'p', closes_debt: ['000000000000'], scope: { write: ['x'] }, accept: [{ cmd: 'true', timeout_s: 1 }], risk: 'G0', size: 'S' }] } as Plan;
    expect(planPrecheck(plan, repo).info.join('\n')).toContain('closes_debt 不存在');
  } finally {
    console.log = original;
  }
});
