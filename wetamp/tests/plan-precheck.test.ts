import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSyntaxErrors, planPrecheck } from '../src/plan-precheck';
import type { Plan } from '../src/plan';
import { gitRepo, sh, tmp } from './helpers';

const fixture = (): string => {
  const root = gitRepo(tmp());
  for (const dir of ['wetamp/tests/scenarios', 'wetamp/scripts', 'wetamp/schemas', 'wetamp/src'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, 'wetamp/scripts/generate-plan-schema.ts'),
    "export const GENERATED_OUTPUT_PATHS = ['wetamp/src/plan-types.generated.ts'];\nconst input = '../schemas/plan.schema.json';\nconst output = '../src/plan-types.generated.ts';\n"
  );
  writeFileSync(join(root, 'wetamp/schemas/plan.schema.json'), '{}');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm fixture', root);
  return root;
};
const plan = (root: string, write: string[], accept: string[]): Plan =>
  ({
    repo: root,
    base_ref: 'HEAD',
    budget: { weighted_tokens: 1 },
    packages: [
      {
        id: 'core',
        title: 'core',
        goal: 'core',
        scope: { write },
        accept: accept.map(cmd => ({ cmd, timeout_s: 1 })),
        risk: 'G1',
        size: 'S',
      },
    ],
  }) as Plan;

test('generator inputs require registered outputs; non-engine repos are skipped', () => {
  const root = fixture(),
    subject = plan(root, ['wetamp/schemas/plan.schema.json'], ['bun run type-check']);
  expect(planPrecheck(subject, root).blocking.join('\n')).toContain(
    'wetamp/src/plan-types.generated.ts'
  );
  subject.packages[0].scope.write.push('wetamp/src/plan-types.generated.ts');
  expect(planPrecheck(subject, root).blocking).toEqual([]);
  const foreign = tmp();
  expect(
    planPrecheck(plan(foreign, ['wetamp/src/foo.ts'], ['bun test']), foreign).blocking
  ).toEqual([]);
});

test('missing acceptance test paths block unless the new test is in scope', () => {
  const root = fixture(),
    subject = plan(
      root,
      ['packages/paths/src/plugin-process.ts'],
      ['cd packages/paths && bun run test src/plugin-process.test.ts']
    );
  expect(planPrecheck(subject, root).blocking.join('\n')).toContain(
    'base_ref 不存在 packages/paths/src/plugin-process.test.ts'
  );
  subject.packages[0].scope.write.push('packages/paths/src/plugin-process.test.ts');
  expect(planPrecheck(subject, root).blocking).toEqual([]);
});

test('shell syntax errors are reported with their package and command number in any repo', () => {
  const subject = plan(tmp(), ['src/foo.ts'], [`test -s 'unfinished`]);
  subject.packages[0].accept[0].report = { junit: 'report.xml', collect: 'for x in' };
  subject.environment = [{ cmd: 'echo ok', timeout_s: 1 }];
  subject.packages[0].environment = [{ cmd: 'case x in', timeout_s: 1 }];
  expect(checkSyntaxErrors(subject)).toEqual([
    expect.stringMatching(/^core#1: bash:/),
    expect.stringMatching(/^core#1\.collect: bash:/),
    expect.stringMatching(/^core\.environment#1: bash:/),
  ]);
});

test('valid shell quoting, heredocs, and nested zsh source remain parse-only', () => {
  const commands = [
    `printf '%s\\n' 'quoted text'`,
    "cat <<'EOF' >/dev/null\ntext with 'quotes'\nEOF",
    `zsh -c 'print "unterminated for zsh'`,
  ];
  expect(checkSyntaxErrors(plan(tmp(), ['src/foo.ts'], commands))).toEqual([]);
});

// prettier-ignore
test('three recent typed failures block only their repo unless a mechanism override is recorded', () => {
  const root = fixture(), home = tmp(), dir = join(home, 'memory/episodes'), subject = plan(root, [], []);
  mkdirSync(dir, { recursive: true });
  const saved = [process.env.SUPERAGENT_HOME, process.env.SUPERAGENT_MEMORY];
  process.env.SUPERAGENT_HOME = home;
  const episode = (id: string, days: number, project = root, reasons = ['scope_violation']) =>
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, project, reasons,
      at: new Date(Date.now() - days * 86400_000).toISOString() }));
  try {
    episode('one', 1); episode('two', 2);
    expect(planPrecheck(subject, root).blocking).toEqual([]);
    episode('old', 8); episode('foreign', 1, tmp());
    expect(planPrecheck(subject, root).blocking).toEqual([]);
    episode('three', 3);
    expect(planPrecheck(subject, root).blocking.join('\n')).toContain('scope 3 次');
    const overridden = planPrecheck(subject, root, 'implemented scope guard');
    expect(overridden.blocking).toEqual([]);
    expect(overridden.info.join('\n')).toMatch(/run ids: (?=.*one)(?=.*two)(?=.*three)/);
    process.env.SUPERAGENT_MEMORY = 'off';
    expect(planPrecheck(subject, root).info).toContain('重复失败检查已跳过：memory 关闭');
  } finally {
    if (saved[0] === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = saved[0];
    if (saved[1] === undefined) delete process.env.SUPERAGENT_MEMORY; else process.env.SUPERAGENT_MEMORY = saved[1];
  }
});
