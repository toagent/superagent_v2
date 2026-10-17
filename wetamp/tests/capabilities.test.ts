import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityDrift, resolveCapabilities } from '../src/capabilities';
import { main } from '../src/cli';
import { loadTiers, WETAMP } from '../src/config';
import { executionTable } from '../src/execution';
import type { Plan } from '../src/plan';
import { contextPack, roleContext } from '../templates/.archon/scripts/sa-context';
import { gitRepo, tmp } from './helpers';

const mapPath = join(WETAMP, 'capabilities.json');
const mapping = JSON.parse(readFileSync(mapPath, 'utf8')) as {
  id: string;
  use: Record<string, string>;
}[];
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
const resolved = (
  home: string,
  role: string,
  failure_classes: string[],
  risk: string,
  scope: string[]
) => resolveCapabilities(mapPath, home, { role, failure_classes, risk, scope }).evidence.injected;

test('structured triggers cover code, repair, fix and upgraded review', () => {
  const home = skillHome();
  expect(resolved(home, 'code', [], 'G1', ['packages/web/page.ts'])).toEqual(['qa.visual']);
  expect(resolved(home, 'code', [], 'G1', ['packages/server/page.ts'])).toEqual([]);
  expect(resolved(home, 'repair', ['product'], 'G1', ['src/view.tsx'])).toEqual([
    'debug.root-cause',
    'qa.visual',
  ]);
  expect(resolved(home, 'review', [], 'G2', [])).toEqual(['security.audit']);
});

test('role context uses acceptance and ledger state and emits one guidance line', () => {
  const gen = tmp(),
    artifacts = join(gen, 'artifacts'),
    repo = gitRepo(tmp()),
    home = skillHome();
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  plan.packages[0].scope.write = ['packages/web/view.tsx'];
  const table = executionTable(plan, loadTiers());
  mkdirSync(join(gen, 'briefs'));
  mkdirSync(artifacts);
  mkdirSync(join(gen, '.archon'));
  for (const [path, text] of [
    ['plan.json', JSON.stringify(plan)],
    ['execution.json', JSON.stringify(table)],
    ['capabilities.json', readFileSync(mapPath, 'utf8')],
    [`briefs/${plan.packages[0].id}.md`, 'TASK'],
    ['.archon/principles.md', 'PRINCIPLES'],
  ])
    writeFileSync(join(gen, path), text);
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const base = { gen, artifacts, cwd: repo, base: 'base', head: 'head', environment: 'env' };
    const code = roleContext({ ...base, node: `code-${plan.packages[0].id}` });
    expect(code.capabilities.injected).toEqual(['qa.visual']);
    expect(
      contextPack(gen, code)
        .split('\n')
        .filter(line => line.startsWith('可用技能'))
    ).toHaveLength(1);
    const acceptance = {
      ok: false,
      diff_hash: '',
      same: false,
      failures: [{ command: 'x', failure_class: 'product' as const, evidence: 'log' }],
    };
    expect(
      roleContext({ ...base, node: `repair-${plan.packages[0].id}`, acceptance }).capabilities
        .injected
    ).toContain('debug.root-cause');
    const fix = Object.keys(table).find(key => key.startsWith('fix-'))!,
      d = table[fix];
    writeFileSync(
      join(artifacts, `gate-${d.milestone}-r${d.round - 1}.ledger.json`),
      JSON.stringify({ blocking: [{ failure_class: 'product' }], debt: [], closed: [] })
    );
    expect(roleContext({ ...base, node: fix }).capabilities.injected).toContain('debug.root-cause');
    const review = Object.keys(table).find(
      key => key.startsWith('review-') && key.endsWith('-r1')
    )!;
    expect(
      roleContext({
        ...base,
        node: review,
        acceptance: { ok: true, diff_hash: '', same: true, risk: 'G2' },
      }).capabilities.injected
    ).toEqual(['security.audit']);
  } finally {
    if (old === undefined) delete process.env.HOME;
    else process.env.HOME = old;
  }
});

test('missing skills are unavailable, reported by health, and map-owned', () => {
  const home = skillHome(),
    first = mapping[0],
    missing = Object.entries(first.use)[0];
  rmSync(join(home, `.${missing[0]}`, 'skills', missing[1]), { recursive: true });
  const result = resolveCapabilities(mapPath, home, {
    role: 'repair',
    failure_classes: ['product'],
    risk: 'G1',
    scope: [],
  });
  expect(result).toMatchObject({
    evidence: { injected: [], unavailable: [first.id] },
    guidance: [],
  });
  expect(capabilityDrift(mapPath, home)).toHaveLength(1);
  const saved = [process.env.HOME, process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME] as const;
  const log = spyOn(console, 'log').mockImplementation(() => {}),
    state = tmp();
  [process.env.HOME, process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME] = [
    home,
    state,
    join(state, 'archon'),
  ];
  mkdirSync(process.env.ARCHON_HOME);
  try {
    expect(main(['health'])).not.toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).capability_drift).toHaveLength(1);
  } finally {
    log.mockRestore();
    for (const [key, value] of ['HOME', 'SUPERAGENT_HOME', 'ARCHON_HOME'].map(
      (key, i) => [key, saved[i]] as const
    ))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  const names = mapping.flatMap(cap => Object.values(cap.use));
  const files = Bun.spawnSync(['rg', '--files', 'src', 'templates', 'README.md'], { cwd: WETAMP })
    .stdout.toString()
    .trim()
    .split('\n');
  expect(
    files.flatMap(file =>
      names.filter(name =>
        [`'${name}'`, `"${name}"`, `\`${name}\``].some(s =>
          readFileSync(join(WETAMP, file), 'utf8').includes(s)
        )
      )
    )
  ).toEqual([]);
});
