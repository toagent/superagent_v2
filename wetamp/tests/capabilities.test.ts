import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCapabilities } from '../src/capabilities';
import { loadTiers, WETAMP } from '../src/config';
import { executionTable } from '../src/execution';
import type { Plan } from '../src/plan';
import { contextPack, roleContext } from '../templates/.archon/scripts/sa-context';
import { gitRepo, tmp } from './helpers';

const mapPath = join(WETAMP, 'capabilities.json');
// prettier-ignore
const mapping = JSON.parse(readFileSync(mapPath, 'utf8')) as { id: string; use: Record<string, string> }[];
const skillHome = () => {
  const home = tmp();
  for (const cap of mapping)
    for (const [provider, skill] of Object.entries(cap.use)) {
      const dir = join(home, `.${provider}`, 'skills', skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'fixture');
    }
  return home;
};
// prettier-ignore
const resolved = (home: string, role: string, failure_classes: string[], risk: string, scope: string[]) => resolveCapabilities(mapPath, home, { role, failure_classes, risk, scope }).evidence.injected;

// prettier-ignore
test('structured triggers cover code, repair, fix and upgraded review', () => {
  const home = skillHome();
  expect(resolved(home, 'code', [], 'G1', ['packages/web/page.ts'])).toEqual(['qa.visual']);
  expect(resolved(home, 'code', [], 'G1', ['packages/server/page.ts'])).toEqual([]);
  expect(resolved(home, 'repair', ['product'], 'G1', ['src/view.tsx'])).toEqual(['debug.root-cause', 'qa.visual']);
  expect(resolved(home, 'review', [], 'G2', [])).toEqual(['security.audit']);
});

// prettier-ignore
test('context uses ledger/effective risk and emits one mapped guidance line', () => {
  const gen = tmp(), artifacts = join(gen, 'artifacts'), repo = gitRepo(tmp()), home = skillHome();
  const plan = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')) as Plan;
  plan.packages[0].scope.write = ['packages/web/view.tsx']; const table = executionTable(plan, loadTiers());
  mkdirSync(join(gen, 'briefs')); mkdirSync(artifacts); mkdirSync(join(gen, '.archon'));
  for (const [path, text] of [['plan.json', JSON.stringify(plan)], ['execution.json', JSON.stringify(table)], ['capabilities.json', readFileSync(mapPath, 'utf8')], [`briefs/${plan.packages[0].id}.md`, 'TASK'], ['.archon/principles.md', 'PRINCIPLES']]) writeFileSync(join(gen, path), text);
  const old = process.env.HOME; process.env.HOME = home;
  try {
    const base = { gen, artifacts, cwd: repo, base: 'base', head: 'head', environment: 'env' };
    const code = roleContext({ ...base, node: `code-${plan.packages[0].id}` });
    expect(code.capabilities.injected).toEqual(['qa.visual']); expect(contextPack(gen, code).split('\n').filter(line => line.startsWith('可用技能'))).toHaveLength(1);
    const fix = Object.keys(table).find(key => key.startsWith('fix-'))!, d = table[fix];
    writeFileSync(join(artifacts, `gate-${d.milestone}-r${d.round - 1}.ledger.json`), JSON.stringify({ blocking: [{ failure_class: 'product' }], debt: [], closed: [] }));
    expect(roleContext({ ...base, node: fix }).capabilities.injected).toContain('debug.root-cause');
    const review = Object.keys(table).find(key => key.startsWith('review-') && key.endsWith('-r1'))!;
    expect(roleContext({ ...base, node: review, acceptance: { ok: true, diff_hash: '', same: true, risk: 'G2' } }).capabilities.injected).toEqual(['security.audit']);
  } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; }
});

// prettier-ignore
test('missing skills are unavailable, health-visible, and map-owned', () => {
  const home = skillHome(), first = mapping[0], missing = Object.entries(first.use)[0]; rmSync(join(home, `.${missing[0]}`, 'skills', missing[1]), { recursive: true });
  expect(resolveCapabilities(mapPath, home, { role: 'repair', failure_classes: ['product'], risk: 'G1', scope: [] })).toMatchObject({ evidence: { injected: [], unavailable: [first.id] }, guidance: [] });
  const state = tmp(), archon = join(state, 'archon'); mkdirSync(archon);
  const health = Bun.spawnSync([process.execPath, 'src/cli.ts', 'health'], { cwd: WETAMP, env: { ...process.env, HOME: home, SUPERAGENT_HOME: state, ARCHON_HOME: archon } });
  expect(JSON.parse(health.stdout.toString().trim()).capability_drift).toHaveLength(1);
  const names = mapping.flatMap(cap => Object.values(cap.use));
  const files = Bun.spawnSync(['rg', '--files', 'src', 'templates', 'README.md'], { cwd: WETAMP }).stdout.toString().trim().split('\n');
  const source = files.map(file => readFileSync(join(WETAMP, file), 'utf8')).join('\n');
  expect(names.filter(name => [`'${name}'`, `"${name}"`, `\`${name}\``].some(s => source.includes(s)))).toEqual([]);
});
