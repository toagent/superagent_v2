import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WETAMP } from './config';
import { type Check, type Plan } from './plan';
import { covered } from './plan-precheck';
interface ProjectRules {
  frozen?: string[];
  required_checks?: { when: string[]; check: Check }[];
  limits?: { max_size?: 'S' | 'M' | 'L' };
}
interface Validator {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
}
type AjvCtor = new (opts: Record<string, unknown>) => {
  addSchema(schema: unknown, key: string): void;
  compile(schema: unknown): Validator;
};
const snapshots = new WeakMap<Plan, string>();
let validate: Validator | undefined;
const sizeRank = { S: 0, M: 1, L: 2 } as const;
const matches = (p: string, globs: string[]): boolean => globs.some(g => new Bun.Glob(g).match(p));
const schema = (name: string): unknown =>
  JSON.parse(readFileSync(join(WETAMP, `schemas/${name}.schema.json`), 'utf8'));
function rulesValidator(): Validator {
  if (validate) return validate;
  const Ajv = createRequire(join(WETAMP, '..', 'packages', 'workflows', 'package.json'))(
    'ajv/dist/2020'
  ) as { default: AjvCtor };
  const ajv = new Ajv.default({ allErrors: true, validateFormats: false });
  ajv.addSchema(schema('plan'), 'plan.schema.json');
  return (validate = ajv.compile(schema('rules')));
}
function loadRules(repo: string): { rules: ProjectRules; raw: string } | undefined {
  const path = join(repo, '.superagent', 'rules.json');
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  const data: unknown = JSON.parse(raw);
  const validator = rulesValidator();
  if (!validator(data)) {
    const detail = (validator.errors ?? [])
      .map(error => `${error.instancePath || '/'} ${error.message ?? ''}`)
      .join('; ');
    throw new Error(`project rules invalid: ${path}: ${detail}`);
  }
  return { rules: data as ProjectRules, raw };
}
export function applyPlanRules(plan: Plan, override?: string) {
  const loaded = loadRules(plan.repo);
  if (!loaded) return { plan, warnings: [], rejected: false, added: 0 };
  const listed = Bun.spawnSync(
    ['git', '-C', plan.repo, 'ls-tree', '-r', '--name-only', plan.base_ref],
    {
      timeout: 10_000,
    }
  );
  if (listed.exitCode !== 0)
    throw new Error(
      `project rules: git ls-tree ${plan.base_ref}: ${listed.stderr.toString().trim()}`
    );
  const tracked = listed.stdout.toString().split(/\r?\n/).filter(Boolean);
  const intersects = (write: string[], patterns: string[]): boolean =>
    write.some(path => matches(path, patterns)) ||
    tracked.some(path => covered(path, write) && matches(path, patterns));
  const warnings: string[] = [];
  let added = 0;
  const packages = plan.packages.map(pkg => {
    const frozen = loaded.rules.frozen ?? [];
    if (intersects(pkg.scope.write, frozen))
      warnings.push(`[${pkg.id}] scope.write intersects frozen path`);
    const maximum = loaded.rules.limits?.max_size;
    if (maximum && sizeRank[pkg.size] > sizeRank[maximum])
      warnings.push(`[${pkg.id}] size ${pkg.size} exceeds limits.max_size ${maximum}`);
    const accept = [...pkg.accept];
    for (const required of loaded.rules.required_checks ?? [])
      if (
        intersects(pkg.scope.write, required.when) &&
        !accept.some(check => check.cmd === required.check.cmd)
      ) {
        accept.push(required.check);
        added++;
      }
    return accept.length === pkg.accept.length ? pkg : { ...pkg, accept };
  });
  const applied = packages.every((pkg, index) => pkg === plan.packages[index])
    ? plan
    : { ...plan, packages };
  snapshots.set(applied, loaded.raw);
  return { plan: applied, warnings, rejected: warnings.length > 0 && !override?.trim(), added };
}
export function freezePlanRules(plan: Plan, dir: string, frozenRoot = dir): void {
  const raw = snapshots.get(plan),
    source = join(frozenRoot, 'project-rules.json');
  const snapshot: unknown = raw
    ? { sha256: createHash('sha256').update(raw).digest('hex'), rules: JSON.parse(raw) as unknown }
    : existsSync(source)
      ? (JSON.parse(readFileSync(source, 'utf8')) as unknown)
      : undefined;
  if (snapshot)
    writeFileSync(join(dir, 'project-rules.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
