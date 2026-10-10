// plan.json（schema v2 + milestone/console）：校验、repo 白名单、依赖拓扑与里程碑排序。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { WETAMP, type Console } from './config';

export interface Check {
  cmd: string;
  timeout_s: number;
  /** 同一 tree/命令/环境下复用本 run 已通过的结果；只给不外写、不依赖时间或随机性的命令开（F-21）。 */
  cache?: boolean;
}
export interface Pkg {
  id: string;
  title: string;
  goal: string;
  scope: { write: string[]; read_hint?: string[] };
  deps?: string[];
  accept: Check[];
  environment?: Check[];
  risk: 'G0' | 'G1' | 'G2';
  size: 'S' | 'M' | 'L';
  signoff?: 'auto' | 'human';
  notes?: string;
  milestone?: string;
  caps?: Partial<Caps>;
}
export interface Plan {
  repo: string;
  budget: { weighted_tokens: number; cost?: number; launches?: number }; // v2 兼容：Archon 不按 token 预算调度
  base_ref: string;
  deadline: string;
  mode?: string;
  concurrency?: number;
  console?: Console;
  environment?: Check[];
  caps?: Partial<Caps>;
  packages: Pkg[];
}
/** 将军能力（docs/00 caps）：默认全开；plan 级覆盖默认、包级覆盖 plan 级。 */
export interface Caps {
  network: boolean;
  web: boolean;
  install: boolean;
  services: boolean;
  long_tests: boolean;
  read: 'any' | 'scope';
  git: 'branch' | 'commit';
  mcp: string[];
}
export const capsOf = (plan: Plan, p: Pkg, mcp: string[]): Caps => ({
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

/** 允许的目标 repo 根；SUPERAGENT_WRITE_ROOTS（冒号分隔）可覆盖，测试据此指向临时目录。 */
export const writeRoots = (): string[] =>
  (process.env.SUPERAGENT_WRITE_ROOTS ?? join(homedir(), 'work')).split(':');

export function loadPlan(path: string, roots = writeRoots()): Plan {
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  validator ??= new Ajv2020.default({ allErrors: true, validateFormats: false }).compile(
    JSON.parse(readFileSync(join(WETAMP, 'schemas', 'plan.schema.json'), 'utf8'))
  );
  if (!validator(data)) {
    const errs = (validator.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? ''}`);
    throw new Error(`plan invalid: ${errs.join('; ')}`);
  }
  const plan = data as Plan;
  if (Number.isNaN(Date.parse(plan.deadline)))
    throw new Error('plan invalid: /deadline not date-time');
  if (!existsSync(plan.repo)) throw new Error(`plan invalid: repo ${plan.repo} does not exist`);
  const repo = realpathSync(plan.repo);
  if (!roots.some(r => existsSync(r) && repo.startsWith(realpathSync(r) + sep))) {
    throw new Error(`plan invalid: repo ${repo} outside allowed roots`);
  }
  if (!existsSync(join(repo, '.git')))
    throw new Error(`plan invalid: repo ${repo} is not a git checkout`);
  const gap = unsupported(data as Record<string, unknown> & Plan);
  if (gap) throw new Error(`plan unsupported: ${gap}`);
  milestones({ ...plan, repo });
  return { ...plan, repo };
}

/**
 * schema 接受但执行层兑现不了的字段：明确拒绝并说明能力，不静默忽略（F-17、A-05）。
 * 字段保留在 schema 里，是为了让旧 plan 得到这条说明而不是笼统的 additionalProperties 报错。
 */
function unsupported(plan: Record<string, unknown> & Plan): string | null {
  if (plan.mode?.startsWith('single:'))
    return `/mode ${plan.mode}: single-vendor routing is not wired into node routing; use auto or strict`;
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
    return { id, packages: group, risk, human: group.some(p => p.signoff === 'human') };
  });
}
