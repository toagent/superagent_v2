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
import { routeState, type Alias, type Tiers } from './config';
import { claudeOutcomeTrips, recordClaudeOutcome, type ClaudeOutcome } from './claude-health';
import { readExecutionTable, executionForNode, executionRoute, executionNode } from './execution';
import { type Plan } from './plan';
import {
  readAuthorEvidence,
  reviewRoundLimit,
  budgetUsage,
  effectiveRisk,
} from '../templates/.archon/scripts/sa-check';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';

const { loadPolicy } = createRequire(import.meta.url)('../bin/policy-snapshot.cjs') as {
  loadPolicy: (path: string) => ReturnType<typeof import('./config').snapshotPolicy>;
};
import {
  executePolicy as dispatchPolicy,
  type DispatchExecution,
} from '@archon/workflows/policy-dispatch';
export { MODEL_FAILURE_COOLDOWN_MS } from '@archon/workflows/policy-dispatch';
export const SOLDIER_BUDGET_MS = 10 * 60_000;
type Events = Parameters<typeof budgetUsage>[0];
interface Execution extends Omit<DispatchExecution<Alias>, 'usage'> {
  floor: number;
  events(): Events;
  role?: string;
  soldierBudgetMs?: number;
}
const timedOut = (signal?: AbortSignal): boolean => {
  const reason: unknown = signal?.reason;
  return reason instanceof DOMException && reason.name === 'TimeoutError';
};
function budgetedSender(
  send: IAgentProvider['sendQuery'],
  budgetMs: number
): IAgentProvider['sendQuery'] {
  return async function* (prompt, cwd, resume, options) {
    try {
      yield* send(prompt, cwd, resume, options);
    } catch (error) {
      if (!timedOut(options?.abortSignal)) throw error;
    }
    if (timedOut(options?.abortSignal))
      throw new Error(`soldier_budget_exceeded: ${String(budgetMs)}ms`);
  };
}
/** Delivery policy supplies limits and evidence; Archon owns every dispatch and receipt. */
export function executePolicy(
  execution: Execution,
  prompt: string,
  cwd: string,
  resume?: string
): AsyncGenerator<MessageChunk> {
  if (execution.role === 'soldier') {
    const budgetMs = execution.soldierBudgetMs ?? SOLDIER_BUDGET_MS;
    const options = execution.options;
    const sendQueryFor = execution.sendQueryFor;
    execution = {
      ...execution,
      candidates: execution.candidates.slice(0, 1),
      sendQuery: budgetedSender(execution.sendQuery, budgetMs),
      sendQueryFor: sendQueryFor
        ? candidate => budgetedSender(sendQueryFor(candidate), budgetMs)
        : undefined,
      options: candidate => {
        const value = options(candidate);
        const timeout = AbortSignal.timeout(budgetMs);
        return {
          ...value,
          abortSignal: value.abortSignal ? AbortSignal.any([value.abortSignal, timeout]) : timeout,
        };
      },
    };
  }
  return dispatchPolicy(
    {
      ...execution,
      budget: execution.budget,
      usage: attempts => budgetUsage(execution.events(), execution.floor, attempts),
    },
    prompt,
    cwd,
    resume
  );
}

type RunRow = Omit<Parameters<typeof readAuthorEvidence>[0], 'events'> & { output_root: string };
/** Match the current engine owner exactly; never infer ownership from age or newest run. */
function runtimeExecution(
  path: string,
  cwd: string,
  options: SendQueryOptions,
  sendQuery: IAgentProvider['sendQuery'],
  provider: Alias['provider'],
  sendQueryFor: NonNullable<Execution['sendQueryFor']>
): Execution {
  const policy = loadPolicy(path),
    dir = dirname(path);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan;
  const node = options.nodeConfig?.nodeId;
  if (!node) throw new Error('policy: node id missing');
  const tiers: Tiers = { tiers: {}, policy, routing: policy.routing };
  const table = readExecutionTable(join(dir, 'execution.json'), plan, tiers);
  const route = executionForNode(table, node, tiers);
  const archonHome = process.env.ARCHON_HOME;
  if (!archonHome) throw new Error('policy: ARCHON_HOME missing');
  const db = new Database(join(archonHome, 'archon.db'), { readonly: true });
  let run: RunRow, events: Events;
  let authors: string[] = [];
  try {
    const rows = db
      .query<
        RunRow,
        [string, number]
      >("SELECT id, output_root, codebase_id, adopted_from_run_id FROM remote_agent_workflow_runs WHERE working_path=? AND status='running' AND json_extract(metadata,'$.execution_owner.pid')=?")
      .all(cwd, process.pid);
    if (rows.length !== 1) throw new Error('policy: engine owner is missing or ambiguous');
    run = rows[0];
    const readEvents = (id: string): Events =>
      db
        .query<{ event_type: string; step_name: string; data: string }, [string]>(
          'SELECT event_type, step_name, data FROM remote_agent_workflow_events WHERE workflow_run_id=? ORDER BY event_order'
        )
        .all(id)
        .map(e => ({ ...e, data: JSON.parse(e.data) as Events[number]['data'] }));
    events = readEvents(run.id);
    if (route.role === 'review') {
      const identities = readAuthorEvidence(
        { ...run, events },
        readPolicyAttempts(join(run.output_root, 'artifacts', 'runs', run.id)),
        route.packages,
        plan.packages.filter(p => route.packages.includes(p.id)).map(p => p.milestone ?? 'm1'),
        reviewRoundLimit(policy),
        id => {
          const prior = db
            .query<
              RunRow,
              [string]
            >('SELECT id, output_root, codebase_id, adopted_from_run_id FROM remote_agent_workflow_runs WHERE id=?')
            .get(id);
          if (!prior) throw new Error('policy: author ancestry missing');
          return { ...prior, events: readEvents(id) };
        }
      );
      if (!identities.length || identities.some(a => !a.model))
        throw new Error('policy: author_unknown');
      authors = [...new Set(identities.flatMap(a => (a.model ? [a.model] : [])))];
    }
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
  const state = routeState(tiers, plan.mode),
    candidates = executionRoute(
      tiers,
      plan.console ?? 'claude',
      plan.mode,
      route,
      authors,
      true,
      state
    ).candidates;
  let claudeAvailable = plan.mode === 'single:claude' || state.claude.state === 'up';
  return {
    node,
    role: route.role,
    candidates,
    artifacts,
    budget: plan.budget,
    floor: policy.budget_floor.S,
    events: () => events,
    requestedModel: options.model,
    provider,
    sendQuery,
    sendQueryFor,
    ...(state.claude.state !== 'up' || candidates.some(candidate => candidate.provider === 'claude')
      ? { available: (candidate: Alias) => candidate.provider !== 'claude' || claudeAvailable }
      : {}),
    onSettled: (attempt, failure) => {
      if (attempt.provider !== 'claude') return Promise.resolve(undefined);
      const outcome: ClaudeOutcome = {
        provider: 'claude',
        ok: attempt.status === 'completed',
        source: 'dispatch',
        class: failure?.class,
        retries: failure?.retries,
        resetAt: failure?.resetAt,
        model: attempt.model,
        run: run.id,
        node,
      };
      if (outcome.ok) claudeAvailable = true;
      else if (claudeOutcomeTrips(outcome)) claudeAvailable = false;
      const saved = recordClaudeOutcome(outcome);
      if (!saved.persisted)
        return Promise.resolve({
          code: 'superagent.health_persist_failed',
          message: JSON.stringify({ run: run.id, node, error: saved.error }),
        });
      return Promise.resolve(undefined);
    },
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
          ...executionNode(route, candidate),
        },
      };
    },
  };
}
/** Decorate the registered factories while retaining native credential/config parsers and provider IDs. */
export function wrapPolicyProvider(
  native: IAgentProvider,
  provider: Alias['provider'],
  sendQueryFor: NonNullable<Execution['sendQueryFor']> = candidate => {
    const native = nativeFactories[candidate.provider]?.();
    if (!native) throw new Error('policy: native failover factory missing');
    return native.sendQuery.bind(native);
  }
): IAgentProvider {
  const send = native.sendQuery.bind(native);
  native.sendQuery = (prompt, cwd, resume, options) => {
    const path = options?.env?.SA_POLICY_PATH;
    if (!path || !options.nodeConfig?.nodeId || options.purpose === 'title-generation')
      return send(prompt, cwd, resume, options);
    return executePolicy(
      runtimeExecution(path, cwd, options, send, provider, sendQueryFor),
      prompt,
      cwd,
      resume
    );
  };
  return native;
}
const nativeFactories: Partial<Record<Alias['provider'], () => IAgentProvider>> = {};
export function installPolicyExecutor(): void {
  registerBuiltinProviders();
  for (const provider of ['codex', 'claude'] as const) {
    const registration = getRegistration(provider),
      factory = nativeFactories[provider] ?? registration.factory;
    nativeFactories[provider] = factory;
    registration.factory = () => wrapPolicyProvider(factory(), provider);
  }
}
