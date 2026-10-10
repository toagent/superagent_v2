import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { capsOf, loadPlan, milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, tmp } from './helpers';

const setup = (patch?: (p: Record<string, unknown>) => void): { path: string; root: string } => {
  const root = tmp();
  return { path: fixturePlan(root, gitRepo(root), patch), root };
};
const pkgs = (p: Record<string, unknown>): Record<string, unknown>[] =>
  p.packages as Record<string, unknown>[];

describe('loadPlan', () => {
  test('valid plan loads with realpath repo', () => {
    const { path, root } = setup();
    expect(loadPlan(path, [root]).repo).toBe(join(root, 'repo'));
  });
  test('rejects unknown top-level field (schema additionalProperties)', () => {
    const { path, root } = setup(p => (p.surprise = 1));
    expect(() => loadPlan(path, [root])).toThrow(/additional properties/);
  });
  test('rejects missing budget (v2 compatibility)', () => {
    const { path, root } = setup(p => delete p.budget);
    expect(() => loadPlan(path, [root])).toThrow(/budget/);
  });
  test('rejects unparseable deadline', () => {
    const { path, root } = setup(p => (p.deadline = 'tomorrow'));
    expect(() => loadPlan(path, [root])).toThrow(/deadline/);
  });
  test('rejects repo outside allowed roots', () => {
    const { path } = setup();
    const other = tmp();
    expect(() => loadPlan(path, [other])).toThrow(/outside allowed roots/);
  });
  test('rejects a root that is only a string prefix of the repo path', () => {
    const { path, root } = setup();
    expect(() => loadPlan(path, [join(root, 're')])).toThrow(/outside allowed roots/);
  });
  test('rejects repo without .git', () => {
    const { path, root } = setup(p => (p.repo = join(String(p.repo), '..', 'plain')));
    mkdirSync(join(root, 'plain'));
    expect(() => loadPlan(path, [root])).toThrow(/not a git checkout/);
  });
  test('rejects missing repo', () => {
    const { path, root } = setup(p => (p.repo = '/nonexistent/sa-repo'));
    expect(() => loadPlan(path, [root])).toThrow(/does not exist/);
  });
  test('rejects dependency cycle', () => {
    const { path, root } = setup(p => (pkgs(p)[0].deps = ['api']));
    expect(() => loadPlan(path, [root])).toThrow(/cycle/);
  });
  test('rejects unknown dependency', () => {
    const { path, root } = setup(p => (pkgs(p)[1].deps = ['ghost']));
    expect(() => loadPlan(path, [root])).toThrow(/unknown ghost/);
  });
  test('rejects duplicate package id', () => {
    const { path, root } = setup(p => (pkgs(p)[1].id = 'core'));
    expect(() => loadPlan(path, [root])).toThrow(/duplicate package id core/);
  });
});

const pkg = (
  id: string,
  extra: Partial<Plan['packages'][number]> = {}
): Plan['packages'][number] => ({
  id,
  title: id,
  goal: id,
  scope: { write: [`${id}.txt`] },
  accept: [{ cmd: 'true', timeout_s: 1 }],
  risk: 'G0',
  size: 'S',
  ...extra,
});
const plan = (packages: Plan['packages']): Plan => ({
  repo: '/r',
  base_ref: 'main',
  deadline: '2099-01-01T00:00:00Z',
  budget: { weighted_tokens: 1 },
  packages,
});

describe('caps', () => {
  test('plan and package caps load; unknown cap keys and bad values are rejected', () => {
    const ok = setup(p => {
      p.caps = { network: false, mcp: ['searxng'] };
      pkgs(p)[0].caps = { network: true, git: 'commit' };
    });
    expect(loadPlan(ok.path, [ok.root]).packages[0].caps).toEqual({ network: true, git: 'commit' });
    const bad = setup(p => (p.caps = { netwrok: false }));
    expect(() => loadPlan(bad.path, [bad.root])).toThrow(/additional properties/);
    const badPkg = setup(p => (pkgs(p)[0].caps = { read: 'everything' }));
    expect(() => loadPlan(badPkg.path, [badPkg.root])).toThrow(/caps/);
  });
  test('defaults all allowed, mcp from tiers; package caps override plan caps', () => {
    const p = plan([pkg('a', { caps: { network: true, git: 'commit' } }), pkg('b')]);
    p.caps = { network: false, install: false };
    const [a, b] = p.packages.map(x => capsOf(p, x, ['tiers-mcp']));
    expect(a).toEqual({
      network: true,
      web: true,
      install: false,
      services: true,
      long_tests: true,
      read: 'any',
      git: 'commit',
      mcp: ['tiers-mcp'],
    });
    expect([b.network, b.git]).toEqual([false, 'branch']);
  });
});

describe('milestones', () => {
  test('packages without milestone default to m1, ordered by deps not plan order', () => {
    const ms = milestones(plan([pkg('b', { deps: ['a'] }), pkg('a')]));
    expect(ms.map(m => [m.id, m.packages.map(p => p.id)])).toEqual([['m1', ['a', 'b']]]);
  });
  test('milestones ordered by cross-milestone deps', () => {
    const ms = milestones(
      plan([pkg('x', { milestone: 'late', deps: ['y'] }), pkg('y', { milestone: 'early' })])
    );
    expect(ms.map(m => m.id)).toEqual(['early', 'late']);
  });
  test('milestone risk is the highest package risk; human iff any signoff human', () => {
    const [m] = milestones(
      plan([pkg('a', { risk: 'G1' }), pkg('b', { risk: 'G2', signoff: 'human' }), pkg('c')])
    );
    expect([m.risk, m.human]).toEqual(['G2', true]);
    expect(milestones(plan([pkg('a', { signoff: 'auto' })]))[0].human).toBe(false);
  });
  test('milestone dependency cycle is rejected', () => {
    const p = plan([
      pkg('a', { milestone: 'one', deps: ['b'] }),
      pkg('b', { milestone: 'two' }),
      pkg('c', { milestone: 'two', deps: ['a'] }),
    ]);
    expect(() => milestones(p)).toThrow(/milestone dependency cycle/);
  });
});
