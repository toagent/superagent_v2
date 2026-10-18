import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRoute, type Alias, type Console, type Tiers } from './config';
import { capsOf, milestones, type Caps, type Plan, type Pkg } from './plan';
import { workflowLaunchPolicy, type LaunchPolicy } from '@archon/providers/launch-policy';
import { reviewRoundLimit } from '../templates/.archon/scripts/sa-check';

export type ExecutionRole = Parameters<typeof resolveRoute>[3];
/** Wrapper observations only; missing fields are unknown, never inferred from terminal state. */
export interface ExecutionReceipt {
  enqueued_at: string;
  admitted_at?: string;
  spawned_at?: string;
  settled_at?: string;
}
export interface ExecutionDescriptor {
  role: NonNullable<ExecutionRole>;
  risk: Pkg['risk'];
  round: number;
  milestone: string;
  packages: string[];
  scope: string[];
  caps: Caps[];
  profiles: Tiers['policy']['exec_profiles'];
}

export function describeExecution(
  tiers: Tiers,
  role: ExecutionDescriptor['role'],
  risk: Pkg['risk'] = 'G1',
  round = 1,
  milestone = '',
  pkgs: Pkg[] = [],
  plan?: Plan
): ExecutionDescriptor {
  if (!Number.isInteger(round) || round < 1 || round > reviewRoundLimit(tiers.policy))
    throw new Error('execution: invalid round');
  return structuredClone({
    role,
    risk,
    round,
    milestone,
    packages: pkgs.map(p => p.id),
    scope: pkgs.flatMap(p => p.scope.write),
    caps: plan ? pkgs.map(p => capsOf(plan, p)) : [],
    profiles: tiers.policy.exec_profiles,
  });
}

/** Frozen node identities, not names interpreted again at every dispatch. */
export function executionTable(plan: Plan, tiers: Tiers): Record<string, ExecutionDescriptor> {
  const table: Record<string, ExecutionDescriptor> = {};
  for (const m of milestones(plan)) {
    for (const p of m.packages) {
      if (tiers.routing.soldier?.models.length)
        table[`soldier-${p.id}`] = describeExecution(tiers, 'soldier', p.risk, 1, m.id, [p], plan);
      for (const role of ['code', 'repair'] as const)
        table[`${role}-${p.id}`] = describeExecution(tiers, role, p.risk, 1, m.id, [p], plan);
    }
    for (let round = 1; round <= reviewRoundLimit(tiers.policy); round++) {
      table[`review-${m.id}-r${String(round)}`] = describeExecution(
        tiers,
        'review',
        m.risk,
        round,
        m.id,
        milestones(plan)
          .slice(0, milestones(plan).findIndex(k => k.id === m.id) + 1)
          .flatMap(k => k.packages),
        plan
      );
      if (round > 1)
        table[`fix-${m.id}-r${String(round)}`] = describeExecution(
          tiers,
          'repair',
          m.risk,
          round,
          m.id,
          m.packages,
          plan
        );
    }
  }
  return table;
}

export function readExecutionTable(
  path: string,
  plan: Plan,
  tiers: Tiers
): Record<string, ExecutionDescriptor> {
  let table: Record<string, ExecutionDescriptor>;
  try {
    table = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ExecutionDescriptor>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const metadata = join(dirname(path), 'engine.json');
    if (existsSync(metadata)) {
      const recorded: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
      if (typeof recorded !== 'object' || recorded === null || Array.isArray(recorded))
        throw new Error('policy: invalid engine metadata');
      if ('execution_contract' in recorded && recorded.execution_contract !== undefined)
        throw new Error('policy: execution table missing from a contract run');
    }
    // The sole pre-contract adapter; all newly generated sources persist the table.
    table = executionTable(plan, tiers);
  }
  return table;
}

export function executionForNode(
  table: Record<string, ExecutionDescriptor>,
  node: string,
  tiers: Tiers
): ExecutionDescriptor {
  const descriptor = Object.hasOwn(table, node) ? table[node] : undefined;
  if (!descriptor) throw new Error(`policy: unknown node ${node}`);
  if (
    !['soldier', 'code', 'repair', 'review', 'command'].includes(descriptor.role) ||
    !['G0', 'G1', 'G2'].includes(descriptor.risk) ||
    !Number.isInteger(descriptor.round) ||
    descriptor.round < 1 ||
    descriptor.round > reviewRoundLimit(tiers.policy)
  )
    throw new Error(`policy: invalid execution descriptor ${node}`);
  return structuredClone(descriptor);
}

export const readExecution = (
  path: string,
  plan: Plan,
  tiers: Tiers,
  node: string
): ExecutionDescriptor => executionForNode(readExecutionTable(path, plan, tiers), node, tiers);

export function executionRoute(
  tiers: Tiers,
  console: Console,
  mode: string | undefined,
  descriptor: ExecutionDescriptor,
  authors: string[] = [],
  vendorFailover = false
) {
  return resolveRoute(
    tiers,
    console,
    mode,
    descriptor.role,
    descriptor.risk,
    descriptor.round,
    authors,
    vendorFailover
  );
}

export function executionLaunch(descriptor: ExecutionDescriptor, candidate: Alias): LaunchPolicy {
  const profile = descriptor.profiles[descriptor.role === 'review' ? 'reviewer' : 'coder'];
  return {
    effort: candidate.effort,
    codex: profile.codex ?? {},
  };
}

export function executionNode(descriptor: ExecutionDescriptor, candidate: Alias) {
  return {
    ...workflowLaunchPolicy(executionLaunch(descriptor, candidate), candidate.provider),
  };
}
