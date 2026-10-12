import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type {
  IAgentProvider,
  MessageChunk,
  SendQueryOptions,
} from '../../packages/providers/src/types';
import { isEffortRung } from '../../packages/provider-contract/src/effort';
import { getRegistration } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { type Alias, type Tiers } from './config';
import { readExecutionTable, executionForNode, executionRoute, executionNode } from './execution';
import { type Plan } from './plan';
import {
  attemptIdentity,
  budgetUsage,
  effectiveBudget,
  effectiveRisk,
  readAttempt,
} from '../templates/.archon/scripts/sa-check';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';

const { loadPolicy } = createRequire(import.meta.url)('../bin/codex-readonly-proxy.cjs') as {
  loadPolicy: (path: string) => ReturnType<typeof import('./config').snapshotPolicy>;
};
import {
  executePolicy as dispatchPolicy,
  type DispatchExecution,
} from '../../packages/workflows/src/policy-dispatch';
export { MODEL_FAILURE_COOLDOWN_MS } from '../../packages/workflows/src/policy-dispatch';
type Events = Parameters<typeof budgetUsage>[0];
interface Execution extends Omit<DispatchExecution<Alias>, 'usage'> {
  floor: number;
  events(): Events;
}
/** Delivery policy supplies limits and evidence; Archon owns every dispatch and receipt. */
export function executePolicy(
  execution: Execution,
  prompt: string,
  cwd: string,
  resume?: string
): AsyncGenerator<MessageChunk> {
  return dispatchPolicy(
    { ...execution, usage: attempts => budgetUsage(execution.events(), execution.floor, attempts) },
    prompt,
    cwd,
    resume
  );
}

interface RunRow {
  id: string;
  output_root: string;
}
/** Match the current engine owner exactly; never infer ownership from age or newest run. */
function runtimeExecution(
  path: string,
  cwd: string,
  options: SendQueryOptions,
  sendQuery: IAgentProvider['sendQuery'],
  provider: Alias['provider']
): Execution {
  const policy = loadPolicy(path),
    dir = dirname(path);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan;
  const node = options.nodeConfig?.nodeId;
  if (!node) throw new Error('policy: node id missing');
  const tiers: Tiers = { tiers: {}, policy, routing: policy.routing, health: policy.health };
  const table = readExecutionTable(join(dir, 'execution.json'), plan, tiers);
  const route = executionForNode(table, node);
  const archonHome = process.env.ARCHON_HOME;
  if (!archonHome) throw new Error('policy: ARCHON_HOME missing');
  const db = new Database(join(archonHome, 'archon.db'), { readonly: true });
  let run: RunRow, events: Events;
  try {
    const rows = db
      .query<
        RunRow,
        [string, number]
      >("SELECT id, output_root FROM remote_agent_workflow_runs WHERE working_path=? AND status='running' AND json_extract(metadata,'$.execution_owner.pid')=?")
      .all(cwd, process.pid);
    if (rows.length !== 1) throw new Error('policy: engine owner is missing or ambiguous');
    run = rows[0];
    events = db
      .query<{ event_type: string; step_name: string; data: string }, [string]>(
        'SELECT event_type, step_name, data FROM remote_agent_workflow_events WHERE workflow_run_id=? ORDER BY event_order'
      )
      .all(run.id)
      .map(e => ({ ...e, data: JSON.parse(e.data) as Events[number]['data'] }));
  } finally {
    db.close();
  }
  // The engine has already announced this node; its dispatch reservation is written below.
  let started = events.length - 1;
  while (
    started >= 0 &&
    !(events[started].event_type === 'node_started' && events[started].step_name === node)
  )
    started--;
  if (started >= 0) events.splice(started, 1);
  const artifacts = join(run.output_root, 'artifacts', 'runs', run.id);
  const attempts = readPolicyAttempts(artifacts);
  if (route.role === 'review' || route.round > 1) {
    const rounds = route.role === 'review' ? route.round : route.round - 1;
    route.risk = effectiveRisk(
      route.risk,
      Array.from(
        { length: rounds },
        (_, i) =>
          JSON.parse(
            readFileSync(join(artifacts, `diff-${route.milestone}-r${String(i + 1)}.json`), 'utf8')
          ) as { risk?: string }
      )
    );
  }
  // Include every author that touched this candidate, including failed/partial attempts.
  const authors =
    route.role === 'review'
      ? [
          ...new Set([
            ...attempts
              .filter(a => table[a.node]?.role !== 'review')
              .flatMap(a => [a.model, ...(a.resolved ? [a.resolved] : [])]),
            ...events
              .filter(
                e =>
                  ['code', 'repair'].includes(table[e.step_name ?? '']?.role) &&
                  e.event_type === 'node_completed'
              )
              .flatMap(e => {
                const identity = attemptIdentity(attempts, e.step_name ?? '', e.data?.binding);
                return identity.model ? [identity.model] : [];
              }),
          ]),
        ]
      : [];
  const candidates = executionRoute(
    tiers,
    plan.console ?? 'claude',
    plan.mode,
    route,
    authors
  ).candidates;
  const extra = join(dir, 'budget-extra');
  const grant = readFileSyncIfPresent(extra);
  const limits = effectiveBudget(
    plan.budget,
    grant,
    route.milestone,
    readAttempt(join(dir, 'attempts', route.milestone))
  );
  return {
    node,
    candidates,
    artifacts,
    budget: limits,
    floor: policy.budget_floor.S,
    events: () => events,
    requestedModel: options.model,
    provider,
    sendQuery,
    options: candidate => {
      if (!isEffortRung(candidate.effort)) throw new Error('policy: unsupported effort');
      return {
        ...options,
        model: candidate.model,
        fallbackModel: undefined,
        nodeConfig: {
          ...options.nodeConfig,
          denied_tools: undefined,
          sandbox: undefined,
          mcp: undefined,
          ...executionNode(route, candidate, join(dir, 'reviewer-readonly.mcp.json')),
        },
      };
    },
  };
}
function readFileSyncIfPresent(path: string): Parameters<typeof effectiveBudget>[1] {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof effectiveBudget>[1];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Decorate the registered factories while retaining native credential/config parsers and provider IDs. */
export function wrapPolicyProvider(
  native: IAgentProvider,
  provider: Alias['provider']
): IAgentProvider {
  const send = native.sendQuery.bind(native);
  native.sendQuery = (prompt, cwd, resume, options) => {
    const path = options?.env?.SA_POLICY_PATH;
    if (!path || !options.nodeConfig?.nodeId || options.purpose === 'title-generation')
      return send(prompt, cwd, resume, options);
    return executePolicy(runtimeExecution(path, cwd, options, send, provider), prompt, cwd, resume);
  };
  return native;
}
export function installPolicyExecutor(): void {
  registerBuiltinProviders();
  for (const provider of ['codex', 'claude'] as const) {
    const registration = getRegistration(provider),
      factory = registration.factory;
    registration.factory = () => wrapPolicyProvider(factory(), provider);
  }
}
