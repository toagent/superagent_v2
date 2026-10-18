import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { capsOf, draftFor, loadPlan, milestones, type Plan } from '../src/plan';
import { fixturePlan, gitRepo, tmp } from './helpers';

const setup = (patch?: (p: Record<string, unknown>) => void): { path: string; root: string } => {
  const root = tmp();
  return { path: fixturePlan(root, gitRepo(root), patch), root };
};
const pkgs = (p: Record<string, unknown>): Record<string, unknown>[] =>
  p.packages as Record<string, unknown>[];

test('owner contracts reject optional keys, types and optionality drift', () => {
  const file = join(import.meta.dir, '../src/plan.ts');
  const config = ts.readConfigFile(join(import.meta.dir, '../tsconfig.json'), ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(import.meta.dir, '..')
  );
  const source = readFileSync(file, 'utf8');
  const probes = [
    "Assert<Equal<Omit<PolicyBudget, 'launches'>, Omit<Plan['budget'], 'cost'>>>",
    "Assert<Equal<PolicyBudget & { extra?: boolean }, Omit<Plan['budget'], 'cost'>>>",
    "Assert<Equal<Omit<PolicyBudget, 'launches'> & { launches?: string }, PolicyBudget>>",
    "Assert<Equal<Omit<PolicyBudget, 'launches'> & { launches: number }, PolicyBudget>>",
    "Assert<Equal<Omit<NonNullable<Pkg['caps']>, 'network'>, NonNullable<Plan['caps']>>>",
    "Assert<Equal<NonNullable<Pkg['caps']> & { extra?: boolean }, NonNullable<Plan['caps']>>>",
  ];
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = path =>
    path === file
      ? source + probes.map((probe, i) => `\nexport type Drift${i} = ${probe};`).join('')
      : read(path);
  const program = ts.createProgram(
    [file, ...fileNames.filter(path => path.endsWith('.d.ts'))],
    options,
    host
  );
  const subject = program.getSourceFile(file);
  if (!subject) throw new Error('missing contract test source');
  // Resolve real imported owner types, but only diagnose the contract and its mutations.
  // The package type-check owns diagnostics in unrelated dependency implementations.
  const diagnostics = program.getSemanticDiagnostics(subject);
  expect(diagnostics.map(d => d.code)).toEqual(probes.map(() => 2344));
  expect(
    diagnostics.every(
      d => d.file?.fileName === file && d.start !== undefined && d.start >= source.length
    )
  ).toBe(true);
}, 30000);

describe('loadPlan', () => {
  test('accepts explicit long_tests with one deprecation warning', () => {
    const { path, root } = setup(p => {
      p.caps = { long_tests: false };
      pkgs(p)[0].caps = { long_tests: true };
    });
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(loadPlan(path, [root]).packages[0].caps?.long_tests).toBe(true);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("'long_tests'");
  });
  test('request_ref is optional and caller-owned', () => {
    const legacy = setup();
    expect(loadPlan(legacy.path, [legacy.root]).request_ref).toBeUndefined();
    const explicit = setup(p => {
      p.request_ref = 'ticket:42';
    });
    expect(loadPlan(explicit.path, [explicit.root]).request_ref).toBe('ticket:42');
    for (const ref of ['', '  ', 42]) {
      const invalid = setup(p => {
        p.request_ref = ref;
      });
      expect(() => loadPlan(invalid.path, [invalid.root])).toThrow('plan invalid');
    }
  });
  test('req-evidence: invalid requirement mappings', () => {
    const r = { id: 'r', text: 'Write core', verified_by: [0] };
    for (const requirements of [
      [],
      [{ ...r, text: ' ' }],
      [{ ...r, id: '' }],
      [{ id: 'r', text: 'missing mapping' }],
      [{ ...r, verified_by: [] }],
      [{ ...r, verified_by: [0, 0] }],
      [{ ...r, verified_by: [1] }],
      [{ ...r, verified_by: [-1] }],
      [r, r],
    ]) {
      const { path, root } = setup(p => (pkgs(p)[0].requirements = requirements));
      expect(() => loadPlan(path, [root])).toThrow('plan invalid');
    }
    const { path, root } = setup(p => (pkgs(p)[0].requirements = [r]));
    expect(loadPlan(path, [root]).packages[0].requirements).toEqual([r]);
  });
  test('schema annotations do not fill defaults or coerce optional fields', () => {
    const { path, root } = setup(p => {
      p.deadline = '2026-01-01';
      p.budget = { weighted_tokens: 1e20 };
    });
    const loaded = loadPlan(path, [root]);
    expect(loaded.budget.weighted_tokens).toBe(1e20);
    expect(loaded.caps).toBeUndefined();
    expect(loaded.packages[0].signoff).toBeUndefined();
    expect(loaded.packages[0].accept[0].cache).toBeUndefined();
    for (const patch of [
      (p: Record<string, unknown>) => (p.mode = null),
      (p: Record<string, unknown>) => (pkgs(p)[0].caps = null),
      (p: Record<string, unknown>) =>
        (pkgs(p)[0].accept = [{ cmd: 'true', timeout_s: 1, extra: true }]),
    ]) {
      const invalid = setup(patch);
      expect(() => loadPlan(invalid.path, [invalid.root])).toThrow('plan invalid');
    }
    const legacy = setup(p => (pkgs(p)[0].effort = 'high'));
    expect(loadPlan(legacy.path, [legacy.root]).packages[0].effort).toBe('high');
  });
  test('structured acceptance report validates paths and known failure identity', () => {
    const valid = setup(p => {
      pkgs(p)[0].accept = [
        {
          cmd: 'bun test',
          timeout_s: 5,
          report: { junit: 'reports/junit.xml', collect: 'bun test --list' },
          known_failures: [{ id: 'suite::case', reason: 'tracked environment issue' }],
        },
      ];
    });
    expect(loadPlan(valid.path, [valid.root]).packages[0].accept[0].report?.junit).toBe(
      'reports/junit.xml'
    );
    for (const junit of ['/tmp/junit.xml', '../junit.xml']) {
      const invalid = setup(p => {
        pkgs(p)[0].accept = [{ cmd: 'true', timeout_s: 5, report: { junit } }];
      });
      expect(() => loadPlan(invalid.path, [invalid.root])).toThrow('plan invalid');
    }
    const duplicate = setup(p => {
      pkgs(p)[0].accept = [
        {
          cmd: 'false',
          timeout_s: 5,
          known_failures: [
            { id: 'suite::case', reason: 'one' },
            { id: 'suite::case', reason: 'two' },
          ],
        },
      ];
    });
    expect(() => loadPlan(duplicate.path, [duplicate.root])).toThrow('duplicate known failure id');
  });
  test('valid plan loads with realpath repo', () => {
    const { path, root } = setup();
    expect(loadPlan(path, [root]).repo).toBe(join(root, 'repo'));
  });
  test('rejects unknown top-level field (schema additionalProperties)', () => {
    const { path, root } = setup(p => (p.surprise = 1));
    expect(() => loadPlan(path, [root])).toThrow(/additional properties/);
  });
  test('delivery defaults: missing budget and deadline resolve without a ceiling', () => {
    const { path, root } = setup(p => {
      delete p.budget;
      delete p.deadline;
    });
    const plan = loadPlan(path, [root]);
    expect(plan.deadline).toBeUndefined();
    expect(plan.budget).toEqual({
      weighted_tokens: 0,
      unlimited_tokens: true,
    });
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
  test('rejects schema fields the engine does not honour, naming the field', () => {
    const cases: [(p: Record<string, unknown>) => void, RegExp][] = [
      [p => (p.concurrency = 2), /plan unsupported: \/concurrency/],
      [p => (pkgs(p)[0].accept_quick = []), /plan unsupported: \/packages\/core\/accept_quick/],
      [
        p => ((pkgs(p)[0].scope as Record<string, unknown>).artifact_paths = []),
        /plan unsupported: \/packages\/core\/scope\/artifact_paths/,
      ],
    ];
    for (const [patch, err] of cases) {
      const { path, root } = setup(patch);
      expect(() => loadPlan(path, [root])).toThrow(err);
    }
    const ok = setup(p => ((p.concurrency = 1), (p.mode = 'strict')));
    expect(loadPlan(ok.path, [ok.root]).concurrency).toBe(1);
  });
  test('accepts supported single-vendor modes', () => {
    for (const mode of ['single:claude', 'single:chatgpt']) {
      const { path, root } = setup(p => (p.mode = mode));
      expect(loadPlan(path, [root]).mode).toBe(mode);
    }
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
    expect([m.risk, m.human, m.review]).toEqual(['G2', true, true]);
    const optional = plan([pkg('a', { risk: 'G1' })]);
    expect(milestones(optional)[0].review).toBe(false);
    expect(milestones({ ...optional, mode: 'strict' })[0].review).toBe(true);
    expect(milestones(plan([pkg('a', { review: true })]))[0].review).toBe(true);
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

test('draft routing defaults to general, honors explicit choice, and rejects G2 soldier', () => {
  const route = (risk: 'G0' | 'G1' | 'G2', size: 'S' | 'M' | 'L', draft?: 'soldier' | 'general') =>
    draftFor({ risk, size, ...(draft ? { draft } : {}) } as Plan['packages'][number]);
  expect([
    route('G1', 'S'),
    route('G1', 'M'),
    route('G1', 'L'),
    route('G1', 'L', 'soldier'),
    route('G1', 'S', 'general'),
    route('G2', 'S'),
  ]).toEqual(['general', 'general', 'general', 'soldier', 'general', 'general']);
  const invalid = setup(p => Object.assign(pkgs(p)[0], { risk: 'G2', draft: 'soldier' }));
  expect(() => loadPlan(invalid.path, [invalid.root])).toThrow('draft soldier is forbidden for G2');
});

test('BYPASS_CAPACITY legacy enforcement is ignored', () => {
  for (const enforcement of [undefined, 'observe', 'hard', 'invalid'] as const) {
    const { path, root } = setup(p => (p.budget = { weighted_tokens: 0, enforcement }));
    expect(loadPlan(path, [root]).budget).toEqual({ weighted_tokens: 0 });
  }
});
