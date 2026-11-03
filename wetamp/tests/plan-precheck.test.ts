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
  writeFileSync(join(root, 'wetamp/src/foo.ts'), 'export const foo = 1;\n');
  writeFileSync(
    join(root, 'wetamp/tests/foo.test.ts'),
    "import { foo } from '../src/foo';\nvoid foo;\n"
  );
  writeFileSync(join(root, 'wetamp/src/cli.ts'), 'export const cli = 1;\n');
  for (let i = 0; i < 16; i++)
    writeFileSync(join(root, `wetamp/tests/hub-${String(i)}.test.ts`), "import '../src/cli';\n");
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
        risk: 'G0',
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

test('direct unit test consumers require scope or an explicit read hint', () => {
  const root = fixture(),
    subject = plan(root, ['wetamp/src/foo.ts'], []);
  expect(planPrecheck(subject, root, 'unrelated override').blocking.join('\n')).toContain(
    'wetamp/tests/foo.test.ts'
  );
  subject.packages[0].scope.read_hint = ['wetamp/tests/foo.test.ts'];
  expect(planPrecheck(subject, root).blocking).toEqual([]);
});

test('hub modules with more than fifteen unit test consumers only add info', () => {
  const root = fixture(),
    result = planPrecheck(plan(root, ['wetamp/src/cli.ts'], []), root);
  expect(result.blocking).toEqual([]);
  expect(result.info.join('\n')).toMatch(/wetamp\/src\/cli\.ts.*16.*仅提示/);
});

test('G1 requires behavior acceptance and reports ignored legacy review requests', () => {
  const root = fixture(),
    subject = plan(root, [], ['cd wetamp && bun run type-check']);
  subject.packages[0].risk = 'G1';
  subject.packages[0].review = true;
  const rejected = planPrecheck(subject, root);
  expect(rejected.blocking.join('\n')).toContain('冒烟/行为测试');
  expect(rejected.info.join('\n')).toContain('review:true 已忽略');
  expect(planPrecheck(subject, root, 'approved exception').blocking).toEqual([]);
  subject.packages[0].accept.push({ cmd: 'bun test wetamp/tests/foo.test.ts', timeout_s: 10 });
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
test('an unresolved repeated mechanism signature blocks until a promoted PV1 passes', () => {
  const root = fixture(), home = tmp(), dir = join(home, 'memory/episodes'), promotions = join(home, 'engine/promotions'), subject = plan(root, [], []);
  mkdirSync(dir, { recursive: true });
  const saved = [process.env.SUPERAGENT_HOME, process.env.SUPERAGENT_MEMORY];
  process.env.SUPERAGENT_HOME = home;
  const episode = (id: string, days: number, signature = 'verify:scope') => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, project: root,
    reasons: ['scope_violation'], signature, status: 'failed', at: new Date(Date.now() - days * 86400_000).toISOString() }));
  try {
    episode('one', 3); episode('two', 2); episode('other', 1, 'integrate:scope');
    expect(planPrecheck(subject, root).blocking).toEqual([]);
    episode('three', 1);
    expect(planPrecheck(subject, root).blocking.join('\n')).toMatch(/verify:scope 3 次.*three/);
    const overridden = planPrecheck(subject, root, 'implemented scope guard');
    expect(overridden.blocking).toEqual([]);
    expect(overridden.info.join('\n')).toContain('verify:scope 3 次');
    mkdirSync(promotions, { recursive: true });
    const sha = 'a'.repeat(40), at = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(join(promotions, `${sha}.json`), JSON.stringify({ sha, status: 'promoted', at }));
    writeFileSync(join(promotions, `${sha}.verify.json`), JSON.stringify({ sha, status: 'passed', at }));
    const cleared = planPrecheck(subject, root);
    expect(cleared.blocking).toEqual([]);
    expect(cleared.info.join('\n')).toMatch(/verify:scope.*PV1.*已解除/);
    process.env.SUPERAGENT_MEMORY = 'off';
    expect(planPrecheck(subject, root).info).toContain('重复失败检查已跳过：memory 关闭');
  } finally {
    if (saved[0] === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = saved[0];
    if (saved[1] === undefined) delete process.env.SUPERAGENT_MEMORY; else process.env.SUPERAGENT_MEMORY = saved[1];
  }
});

// prettier-ignore
test('duration overruns only block for failed runs; completed runs stay informational', () => {
  const root = fixture(), home = tmp(), dir = join(home, 'memory/episodes'), subject = plan(root, [], []), saved = process.env.SUPERAGENT_HOME;
  mkdirSync(dir, { recursive: true }); process.env.SUPERAGENT_HOME = home;
  const episode = (id: string, status: string) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, project: root, status,
    reasons: [], signature: 'duration_overrun', at: new Date(Date.now() - 86400_000).toISOString() }));
  try {
    for (const id of ['done-1', 'done-2', 'done-3']) episode(id, 'completed');
    episode('stale-running', 'running');
    const completed = planPrecheck(subject, root);
    expect(completed.blocking).toEqual([]); expect(completed.info.join('\n')).toContain('3 个已完成 run 超时长');
    for (const id of ['failed-1', 'failed-2', 'failed-3']) episode(id, 'failed');
    expect(planPrecheck(subject, root).blocking.join('\n')).toMatch(/duration_overrun 3 次.*failed-/);
  } finally { if (saved === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = saved; }
});
