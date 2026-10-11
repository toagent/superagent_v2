import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { IAgentProvider, MessageChunk, ResultChunk, SendQueryOptions } from '../../packages/providers/src/types';
import { isEffortRung } from '../../packages/provider-contract/src/effort';
import { mergeTokenUsage, type TokenUsage } from '../../packages/provider-contract/src/result';
import { getRegistration } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { resolveRoute, type Alias, type Tiers } from './config';
import { milestones, type Plan } from './plan';
import { attemptIdentity, budgetUsage, effectiveBudget, effectiveRisk, readAttempt, MAX_ROUNDS } from '../templates/.archon/scripts/sa-check';
import { readPolicyAttempts, writePolicyAttempts, type PolicyAttempt } from '../templates/.archon/scripts/policy-attempts';

const { loadPolicy } = createRequire(import.meta.url)('../bin/codex-readonly-proxy.cjs') as {
  loadPolicy: (path: string) => ReturnType<typeof import('./config').snapshotPolicy>;
};
/** These are execution constants, not a second set of operator configuration knobs. */
export const MODEL_FAILURE_COOLDOWN_MS = {
  misconfigured: 24 * 3600_000,
  overloaded: 120_000,
  quota_exhausted: 3600_000,
} as const;
type Events = Parameters<typeof budgetUsage>[0];
interface Execution {
  node: string;
  candidates: Alias[];
  artifacts: string;
  budget: Plan['budget'];
  floor: number;
  events(): Events;
  provider: Alias['provider'];
  sendQuery: IAgentProvider['sendQuery'];
  options(candidate: Alias): SendQueryOptions;
  now?: () => number;
  requestedModel?: string;
}

/** One execution boundary consumes only typed failure classes; provider prose never selects a route. */
export async function* executePolicy(
  execution: Execution, prompt: string, cwd: string, resume?: string
): AsyncGenerator<MessageChunk> {
  const now = execution.now ?? Date.now;
  const attempts = readPolicyAttempts(execution.artifacts);
  const usage: TokenUsage[] = [];
  const accounted = (result: ResultChunk, model?: string): ResultChunk => {
    const out = { ...result, tokens: mergeTokenUsage(usage) };
    // The engine binds sessions to its requested model; fallback ownership cannot be relabelled.
    if (model !== execution.requestedModel || (result.resolvedModel && result.resolvedModel.id !== model)) {
      delete out.sessionId;
      delete out.resumed;
    }
    return out;
  };
  const budgetFailure = (beforeLaunch: boolean): ResultChunk | undefined => {
    const used = budgetUsage(execution.events(), execution.floor, attempts);
    const reason = execution.budget.launches !== undefined &&
      (beforeLaunch ? used.launches >= execution.budget.launches : used.launches > execution.budget.launches)
      ? 'budget_launches_exceeded'
      : used.weighted_tokens + (beforeLaunch ? used.reserve : 0) > execution.budget.weighted_tokens
        ? 'budget_tokens_exceeded' : null;
    return reason ? { type: 'result', isError: true, failure: { class: 'budget_exceeded',
      evidence: JSON.stringify({ reason, used, limits: execution.budget, node: execution.node }) } } : undefined;
  };
  let last: ResultChunk | undefined;
  // The outer admission slot belongs to this provider for the entire stream.
  for (const candidate of execution.candidates.filter(a => a.provider === execution.provider)) {
    const options = execution.options(candidate);
    if (options.abortSignal?.aborted) throw new Error('policy execution aborted');
    if (attempts.some(a => a.model === candidate.model && (a.cooldown_until ?? 0) > now())) continue;
    const over = budgetFailure(true);
    if (over) {
      yield accounted(over);
      yield { type: 'settled' };
      return;
    }
    const attempt: PolicyAttempt = { id: crypto.randomUUID(), node: execution.node,
      provider: candidate.provider, model: candidate.model, status: 'started' };
    attempts.push(attempt);
    writePolicyAttempts(execution.artifacts, attempts); // Reserve even if the process dies mid-turn.
    let result: ResultChunk | undefined, settled = false;
    const turnUsage: TokenUsage[] = [];
    try {
      // Never pass a session from a different model or vendor to the fallback.
      const session = !last && candidate.model === execution.requestedModel ? resume : undefined;
      for await (const chunk of execution.sendQuery(prompt, cwd, session, options)) {
        if (chunk.type === 'result') {
          result = chunk;
          if (chunk.tokens) { turnUsage.push(chunk.tokens); usage.push(chunk.tokens); }
        }
        else if (chunk.type === 'settled') settled = true;
        else yield chunk;
      }
    } catch (error) {
      attempt.status = 'failed';
      attempt.tokens = mergeTokenUsage(turnUsage);
      attempt.resolved = result?.resolvedModel?.id;
      writePolicyAttempts(execution.artifacts, attempts);
      throw error; // An untyped throw cannot justify switching models.
    }
    attempt.status = settled && result && !result.failure && !result.isError ? 'completed' : 'failed';
    attempt.tokens = mergeTokenUsage(turnUsage);
    attempt.resolved = result?.resolvedModel?.id;
    attempt.failure = result?.failure?.class;
    const failure = result?.failure?.class;
    const cooldown = failure && Object.hasOwn(MODEL_FAILURE_COOLDOWN_MS, failure)
      ? MODEL_FAILURE_COOLDOWN_MS[failure as keyof typeof MODEL_FAILURE_COOLDOWN_MS] : undefined;
    if (cooldown !== undefined) attempt.cooldown_until = now() + cooldown;
    writePolicyAttempts(execution.artifacts, attempts);
    if (!settled || !result) throw new Error('policy provider stream ended without result and settled');
    const exceeded = budgetFailure(false);
    if (exceeded) {
      attempt.status = 'failed';
      attempt.failure = 'budget_exceeded';
      writePolicyAttempts(execution.artifacts, attempts);
    }
    if (exceeded || cooldown === undefined || options.abortSignal?.aborted) {
      yield accounted(exceeded ?? result, candidate.model);
      yield { type: 'settled' };
      return;
    }
    last = result;
    yield { type: 'warning', code: 'superagent.policy_fallback',
      message: JSON.stringify({ node: execution.node, model: candidate.model, failure, cooldown_until: attempt.cooldown_until }) };
  }
  yield accounted(last ?? { type: 'result', isError: true, failure: { class: 'misconfigured',
    evidence: `policy: no eligible ${execution.provider} model outside cooldown for ${execution.node}; vendor reassignment belongs to engine` } });
  yield { type: 'settled' };
}

/** Node ids are engine-generated identifiers, not vendor text or agent-interpreted intent. */
function nodeRoute(plan: Plan, node: string): { role: 'code' | 'repair' | 'review'; risk: 'G0' | 'G1' | 'G2'; round: number; milestone: string } {
  const ms = milestones(plan);
  for (const m of ms) {
    for (const p of m.packages) {
      for (const role of ['code', 'repair'] as const) if (node === `${role}-${p.id}`)
        return { role, risk: p.risk, round: 1, milestone: m.id };
    }
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (node === `review-${m.id}-r${String(round)}`)
        return { role: 'review', risk: m.risk, round, milestone: m.id };
      if (node === `fix-${m.id}-r${String(round)}`)
        return { role: 'repair', risk: m.risk, round, milestone: m.id };
    }
  }
  throw new Error(`policy: node ${node} is not declared by the frozen plan`);
}

interface RunRow { id: string; output_root: string }
/** Match the current engine owner exactly; never infer ownership from age or newest run. */
function runtimeExecution(path: string, cwd: string, options: SendQueryOptions,
  sendQuery: IAgentProvider['sendQuery'], provider: Alias['provider']): Execution {
  const policy = loadPolicy(path), dir = dirname(path);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan;
  const node = options.nodeConfig?.nodeId;
  if (!node) throw new Error('policy: node id missing');
  const route = nodeRoute(plan, node);
  const archonHome = process.env.ARCHON_HOME;
  if (!archonHome) throw new Error('policy: ARCHON_HOME missing');
  const db = new Database(join(archonHome, 'archon.db'), { readonly: true });
  let run: RunRow, events: Events;
  try {
    const rows = db.query<RunRow, [string, number]>(
      "SELECT id, output_root FROM remote_agent_workflow_runs WHERE working_path=? AND status='running' AND json_extract(metadata,'$.execution_owner.pid')=?"
    ).all(cwd, process.pid);
    if (rows.length !== 1) throw new Error('policy: engine owner is missing or ambiguous');
    run = rows[0];
    events = db.query<{ event_type: string; step_name: string; data: string }, [string]>(
      'SELECT event_type, step_name, data FROM remote_agent_workflow_events WHERE workflow_run_id=? ORDER BY event_order'
    ).all(run.id).map(e => ({ ...e, data: JSON.parse(e.data) as Events[number]['data'] }));
  } finally { db.close(); }
  // The engine has already announced this node; its dispatch reservation is written below.
  let started = events.length - 1;
  while (started >= 0 && !(events[started].event_type === 'node_started' && events[started].step_name === node)) started--;
  if (started >= 0) events.splice(started, 1);
  const artifacts = join(run.output_root, 'artifacts', 'runs', run.id);
  const attempts = readPolicyAttempts(artifacts);
  if (route.role === 'review' || route.round > 1) {
    const rounds = route.role === 'review' ? route.round : route.round - 1;
    route.risk = effectiveRisk(route.risk, Array.from({ length: rounds }, (_, i) =>
      JSON.parse(readFileSync(join(artifacts, `diff-${route.milestone}-r${String(i + 1)}.json`), 'utf8')) as { risk?: string }));
  }
  // Include every author that touched this candidate, including failed/partial attempts.
  const authors = route.role === 'review' ? [...new Set([
    ...attempts.filter(a => !a.node.startsWith('review-')).flatMap(a => [a.model, ...(a.resolved ? [a.resolved] : [])]),
    ...events.filter(e => /^(code|repair|fix)-/.test(e.step_name ?? '') && e.event_type === 'node_completed')
      .flatMap(e => { const identity = attemptIdentity(attempts, e.step_name ?? '', e.data?.binding); return identity.model ? [identity.model] : []; }),
  ])] : [];
  const tiers: Tiers = { tiers: {}, policy, routing: policy.routing, health: policy.health };
  const candidates = resolveRoute(tiers, plan.console ?? 'claude', plan.mode, route.role, route.risk, route.round, authors).candidates;
  const extra = join(dir, 'budget-extra');
  const grant = readFileSyncIfPresent(extra);
  const limits = effectiveBudget(plan.budget, grant, route.milestone, readAttempt(join(dir, 'attempts', route.milestone)));
  return { node, candidates, artifacts, budget: limits, floor: policy.budget_floor.S, events: () => events,
    requestedModel: options.model, provider, sendQuery,
    options: candidate => {
      if (!isEffortRung(candidate.effort)) throw new Error('policy: unsupported effort');
      return { ...options, model: candidate.model, fallbackModel: undefined,
        nodeConfig: { ...options.nodeConfig, effort: candidate.effort } };
    } };
}
function readFileSyncIfPresent(path: string): Parameters<typeof effectiveBudget>[1] {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof effectiveBudget>[1]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Decorate the registered factories while retaining native credential/config parsers and provider IDs. */
export function wrapPolicyProvider(native: IAgentProvider, provider: Alias['provider']): IAgentProvider {
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
    const registration = getRegistration(provider), factory = registration.factory;
    registration.factory = () => wrapPolicyProvider(factory(), provider);
  }
}
