import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmp } from './helpers';

const root = resolve(import.meta.dir, '../..'),
  script = join(root, 'wetamp/scripts/check-serving-rules.ts');
const run = (repo: string, engine: string) =>
  Bun.spawnSync([process.execPath, script], {
    cwd: repo,
    env: { ...process.env, SUPERAGENT_SERVING_ENGINE_DIR: engine },
    stdout: 'pipe',
    stderr: 'pipe',
  });
const fixture = (supported: boolean) => {
  const base = tmp(),
    repo = join(base, 'repo'),
    engine = join(base, 'engine');
  mkdirSync(join(repo, '.superagent'), { recursive: true });
  mkdirSync(join(engine, 'wetamp/schemas'), { recursive: true });
  mkdirSync(join(engine, 'packages/workflows/node_modules'), { recursive: true });
  symlinkSync(
    realpathSync(join(root, 'packages/workflows/node_modules/ajv')),
    join(engine, 'packages/workflows/node_modules/ajv')
  );
  writeFileSync(join(engine, 'packages/workflows/package.json'), '{}');
  writeFileSync(join(engine, 'wetamp/schemas/plan.schema.json'), '{}');
  writeFileSync(
    join(engine, 'wetamp/schemas/rules.schema.json'),
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: supported ? { future_field: {} } : {},
    })
  );
  writeFileSync(join(repo, '.superagent/rules.json'), JSON.stringify({ future_field: true }));
  return { base, repo, engine };
};

test('serving schema rejects drift and fails closed without disturbing absent rules', () => {
  const old = fixture(false),
    rejected = run(old.repo, old.engine),
    supported = fixture(true);
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr.toString()).toContain('future_field');
  expect(rejected.stderr.toString()).toContain(
    '先落地并晋升引擎对新字段的支持，再在后续包里修改规则'
  );
  expect(run(supported.repo, supported.engine).exitCode).toBe(0);
  const missing = run(old.repo, join(old.base, 'missing'));
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain('serving engine unavailable');
  expect(run(tmp(), join(old.base, 'missing')).exitCode).toBe(0);
});

test('current project rules pass the current checkout schema', () => {
  const result = run(root, root);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const rules = JSON.parse(readFileSync(join(root, '.superagent/rules.json'), 'utf8'));
  expect(rules.required_checks).toContainEqual({
    when: ['.superagent/rules.json'],
    check: { cmd: 'bun wetamp/scripts/check-serving-rules.ts', timeout_s: 120, cache: false },
  });
});
