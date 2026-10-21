// plan.json（schema v2 + milestone/console）：校验、repo 白名单、依赖拓扑与里程碑排序。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { WETAMP, assertSQLite, type Console } from './config';
import type { PolicyBudget } from '../../packages/workflows/src/provider-attempts';
import { GENERATED_OUTPUT_PATHS, type Plan as PlanInput } from './plan-types.generated';
export { GENERATED_OUTPUT_PATHS };
/** Runtime plans resolve the optional wire budget once at ingestion. */
export type Plan = Omit<PlanInput, 'budget'> & { budget: NonNullable<PlanInput['budget']> };
export type Pkg = Plan['packages'][number];
export type Requirement = NonNullable<Pkg['requirements']>[number];
export type Check = Pkg['accept'][number];
/** Soldier drafting is opt-in; G2 always routes directly to a general. */
export const draftFor = (p: Pkg): 'soldier' | 'general' =>
  p.risk === 'G2' ? 'general' : (p.draft ?? 'general');
/** Resolved capability defaults; the wire schema keeps every override optional. */
export type Caps = Required<NonNullable<Plan['caps']>>;

type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Generic quantification detects optional-key drift that assignability misses.
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
/** External owners stay authoritative; drift requires an explicit schema decision. */
export type PlanOwnerContracts = [
  Assert<Equal<Omit<Plan['budget'], 'cost'>, PolicyBudget>>,
  Assert<Equal<NonNullable<Plan['console']>, Console>>,
  Assert<Equal<NonNullable<Pkg['caps']>, NonNullable<Plan['caps']>>>,
];
export const capsOf = (plan: Plan, p: Pkg, mcp: string[] = []): Caps => ({
  network: true,
  web: true,
  install: true,
  services: true,
  long_tests: true,
  read: 'any',
  git: 'branch',
  mcp,
  ...plan.caps,
  ...p.caps,
});
export interface Milestone {
  id: string;
  packages: Pkg[];
  risk: Pkg['risk'];
  human: boolean;
  review: boolean;
}

interface AjvError {
  instancePath: string;
  message?: string;
}
interface Validate {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}
type AjvCtor = new (opts: Record<string, unknown>) => { compile(schema: unknown): Validate };

// ajv 复用 @archon/workflows 已有依赖（不新增包）；date-time 由下方手动校验。
const Ajv2020 = createRequire(join(WETAMP, '..', 'packages', 'workflows', 'package.json'))(
  'ajv/dist/2020'
) as { default: AjvCtor };
let validator: Validate | undefined;

export const SCRATCH_ROOT = '/tmp/sa-scratch';

/** 允许的目标 repo 根；SUPERAGENT_WRITE_ROOTS（冒号分隔）可覆盖，测试据此指向临时目录。 */
export const writeRoots = (): string[] => [
  ...(process.env.SUPERAGENT_WRITE_ROOTS ?? join(homedir(), 'work')).split(':'),
  SCRATCH_ROOT,
];
export const isWithinWriteRoots = (path: string, roots = writeRoots()): boolean => {
  const candidate = realpathSync(path);
  return roots.some(root => existsSync(root) && candidate.startsWith(realpathSync(root) + sep));
};

export function loadPlan(path: string, roots = writeRoots()): Plan {
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  // Ignore the retired wire field before validation, including legacy hard budgets.
  if (
    data &&
    typeof data === 'object' &&
    'budget' in data &&
    data.budget &&
    typeof data.budget === 'object'
  )
    Reflect.deleteProperty(data.budget, 'enforcement');
  validator ??= new Ajv2020.default({ allErrors: true, validateFormats: false }).compile(
    JSON.parse(readFileSync(join(WETAMP, 'schemas', 'plan.schema.json'), 'utf8'))
  );
  if (!validator(data)) {
    const errs = (validator.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? ''}`);
    throw new Error(`plan invalid: ${errs.join('; ')}`);
  }
  const input = data as PlanInput;
  if (
    input.caps?.long_tests !== undefined ||
    input.packages.some(p => p.caps?.long_tests !== undefined)
  )
    console.warn(
      "plan: 'long_tests' is deprecated and retained for compatibility; it no longer grants agents permission to run acceptance commands"
    );
  const plan: Plan = {
    ...input,
    budget: input.budget ?? { weighted_tokens: 0, unlimited_tokens: true },
  };
  for (const p of plan.packages) {
    if (p.risk === 'G2' && p.draft === 'soldier')
      throw new Error(`plan invalid: ${p.id} draft soldier is forbidden for G2`);
    const ids = new Set<string>();
    for (const r of p.requirements ?? []) {
      if (ids.has(r.id)) throw new Error(`plan invalid: duplicate requirement id ${p.id}/${r.id}`);
      ids.add(r.id);
      if (r.verified_by.some(i => i >= p.accept.length))
        throw new Error(`plan invalid: ${p.id}/${r.id} verified_by outside accept`);
    }
    for (const check of p.accept) {
      const known = check.known_failures?.map(f => f.id) ?? [];
      if (new Set(known).size !== known.length)
        throw new Error(`plan invalid: duplicate known failure id ${p.id}/${check.cmd}`);
    }
  }
  if (plan.deadline !== undefined && Number.isNaN(Date.parse(plan.deadline)))
    throw new Error('plan invalid: /deadline not date-time');
  if (!existsSync(plan.repo)) throw new Error(`plan invalid: repo ${plan.repo} does not exist`);
  const repo = realpathSync(plan.repo);
  if (!isWithinWriteRoots(repo, roots)) {
    throw new Error(`plan invalid: repo ${repo} outside allowed roots`);
  }
  if (!existsSync(join(repo, '.git')))
    throw new Error(`plan invalid: repo ${repo} is not a git checkout`);
  const gap = unsupported(data as Record<string, unknown> & Plan);
  if (gap) throw new Error(`plan unsupported: ${gap}`);
  assertSQLite(repo);
  milestones({ ...plan, repo });
  return { ...plan, repo };
}

/**
 * schema 接受但执行层兑现不了的字段：明确拒绝并说明能力，不静默忽略（F-17、A-05）。
 * 字段保留在 schema 里，是为了让旧 plan 得到这条说明而不是笼统的 additionalProperties 报错。
 */
function unsupported(plan: Record<string, unknown> & Plan): string | null {
  if ((plan.concurrency ?? 1) > 1)
    return '/concurrency > 1: packages share one worktree and run serially in one DAG';
  for (const p of plan.packages as (Pkg & Record<string, unknown>)[]) {
    const field = ['accept_quick', 'fixture_exemptions'].find(k => k in p);
    if (field) return `/packages/${p.id}/${field}: not consumed by the engine; remove it`;
    if ('artifact_paths' in p.scope)
      return `/packages/${p.id}/scope/artifact_paths: not consumed by the engine; remove it`;
  }
  return null;
}

/** 稳定 Kahn 排序：同层按 plan 中出现顺序。 */
function topo<T>(items: T[], key: (t: T) => string, deps: (t: T) => string[], what: string): T[] {
  const byKey = new Map(items.map(t => [key(t), t]));
  const indeg = new Map(items.map(t => [key(t), 0]));
  for (const t of items) {
    for (const d of new Set(deps(t))) {
      if (!byKey.has(d)) throw new Error(`plan invalid: ${what} ${key(t)} depends on unknown ${d}`);
      indeg.set(key(t), (indeg.get(key(t)) ?? 0) + 1);
    }
  }
  const out: T[] = [];
  const done = new Set<string>();
  while (out.length < items.length) {
    const next = items.find(t => !done.has(key(t)) && indeg.get(key(t)) === 0);
    if (!next) {
      const rest = items.filter(t => !done.has(key(t))).map(key);
      throw new Error(`plan invalid: ${what} dependency cycle among ${rest.join(', ')}`);
    }
    out.push(next);
    done.add(key(next));
    for (const t of items)
      if (new Set(deps(t)).has(key(next))) indeg.set(key(t), (indeg.get(key(t)) ?? 0) - 1);
  }
  return out;
}

const RISK_ORDER = ['G0', 'G1', 'G2'] as const;

/** 里程碑按依赖排序；里程碑内包按拓扑排序，同一 run 内串行执行。 */
export function milestones(plan: Plan): Milestone[] {
  const ids = plan.packages.map(p => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`plan invalid: duplicate package id ${dup}`);
  const pkgs = topo(
    plan.packages,
    p => p.id,
    p => p.deps ?? [],
    'package'
  );
  const ms = (p: Pkg): string => p.milestone ?? 'm1';
  const msOf = new Map(pkgs.map(p => [p.id, ms(p)]));
  const names = [...new Set(plan.packages.map(ms))];
  const order = topo(
    names,
    n => n,
    n =>
      plan.packages
        .filter(p => ms(p) === n)
        .flatMap(p => (p.deps ?? []).map(d => msOf.get(d) ?? d))
        .filter(m => m !== n),
    'milestone'
  );
  return order.map(id => {
    const group = pkgs.filter(p => ms(p) === id);
    const risk = RISK_ORDER[Math.max(...group.map(p => RISK_ORDER.indexOf(p.risk)))];
    return {
      id,
      packages: group,
      risk,
      human: group.some(p => p.signoff === 'human'),
      review: risk === 'G2' || plan.mode === 'strict' || group.some(p => p.review === true),
    };
  });
}
