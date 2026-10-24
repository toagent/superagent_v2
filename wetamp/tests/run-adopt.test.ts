import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as archonModule from '../src/archon';
import * as coordination from '../src/coord';
import { ledgerPath, loadLedger, main, type Ledger } from '../src/cli';
import { fixtureArchon } from './fixtures/archon-stub';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import type { RunView } from '../src/archon';
import type { Plan } from '../src/plan';

const savedEnv = { ...process.env };
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  process.env = { ...savedEnv };
});

function setup(
  change: (next: Plan, state: { status: RunView['status']; repo: string }) => void = () => {}
) {
  const root = tmp(),
    repo = gitRepo(root),
    home = join(root, 'home'),
    stub = join(root, 'stub');
  sh('git switch -qc feature/adopt', repo);
  for (const dir of [join(home, 'runs'), join(home, 'archon'), join(stub, 'used')])
    mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'),
    SUPERAGENT_WRITE_ROOTS: root,
    SUPERAGENT_MEMORY: 'off',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  const oldPath = fixturePlan(root, repo),
    old = JSON.parse(readFileSync(oldPath, 'utf8')) as Plan;
  old.packages = [old.packages[0]];
  const next = structuredClone(old),
    state: { status: RunView['status']; repo: string } = { status: 'failed', repo };
  change(next, state);
  const nextPath = join(root, 'next.json'),
    gen = join(root, 'old-gen');
  writeFileSync(oldPath, JSON.stringify(old));
  writeFileSync(nextPath, JSON.stringify(next));
  mkdirSync(join(gen, 'hints'), { recursive: true });
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(old));
  const ledger: Ledger = {
    run_id: 'old-sa',
    archon_run_id: 'old-engine',
    plan: oldPath,
    gen_dir: gen,
    repo: state.repo,
    branch: 'sa/old-sa',
    workflow: 'sa-old-sa',
    console: 'claude',
    started_at: '',
    transcript: '',
    log: '',
  };
  ledger.controller = coordination
    .coord()
    .claim(coordination.runScope(ledger), coordination.caller()).controller;
  writeFileSync(ledgerPath(ledger.run_id), JSON.stringify(ledger));
  const art = join(root, 'artifacts/runs/old-engine');
  mkdirSync(art, { recursive: true });
  const coder = {
    status: 'partial',
    needs: [{ cap: 'scope' }],
    blockers: ['old'],
    changed_files: ['core.txt'],
  };
  writeFileSync(join(art, 'verify-core.coder.json'), JSON.stringify(coder));
  const run = { id: 'old-engine', status: state.status, working_path: repo, output_root: root };
  writeFileSync(join(stub, 'get-000.json'), JSON.stringify(run));
  const calls: string[] = [];
  spies.push(
    spyOn(coordination, 'cleanEngine').mockReturnValue('a'.repeat(40)),
    spyOn(archonModule, 'archon').mockImplementation(args => {
      calls.push(args.join(' '));
      return fixtureArchon(stub, args);
    })
  );
  return { home, nextPath, calls };
}

test('run --adopt rejects nonterminal, package, milestone, and cross-repo mismatches', () => {
  for (const sample of ['live', 'package', 'milestone', 'repo']) {
    const s = setup((next, state) => {
      if (sample === 'live') state.status = 'running';
      if (sample === 'package') next.packages[0].id = 'other';
      if (sample === 'milestone') next.packages[0].milestone = 'm2';
      if (sample === 'repo') state.repo = gitRepo(tmp());
    });
    expect(main(['run', s.nextPath, '--adopt', 'old-sa', '--allow-overlap', 'fixture'])).toBe(1);
    expect(s.calls.some(call => /^workflow (cancel|abandon)/.test(call))).toBe(false);
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  }
});

test('run --adopt launches on the old branch with fresh plan and structured handoff', () => {
  const s = setup();
  expect(main(['run', s.nextPath, '--adopt', 'old-sa', '--allow-overlap', 'fixture'])).toBe(0);
  const call = s.calls.find(value => value.startsWith('workflow run')) ?? '';
  expect(call).toContain(' --adopt old-engine ');
  expect(call).not.toMatch(/ --(?:branch|from|config) /);
  const id = readdirSync(join(s.home, 'runs'))
    .map(file => file.slice(0, -5))
    .find(value => value !== 'old-sa');
  expect(id).toBeDefined();
  const ledger = loadLedger(id!);
  expect(ledger).toMatchObject({ branch: 'sa/old-sa', launch_branch: 'sa/old-sa' });
  expect(ledger.adoptions?.at(-1)).toMatchObject({
    from: 'old-engine',
    to: 'r2',
    carried: [],
    coded: [],
  });
  expect(readFileSync(join(ledger.gen_dir, 'hints/core.md'), 'utf8')).toContain('"changed_files"');
});
