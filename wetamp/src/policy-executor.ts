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
import { capsOf, milestones, type Plan } from './plan';
import { capsDenied } from './generate';
import { attemptIdentity, budgetUsage, effectiveBudget, readAttempt, MAX_ROUNDS } from '../templates/.archon/scripts/sa-check';
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
  provider(candidate: Alias): IAgentProvider;
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
  const accounted = (result: ResultChunk): ResultChunk => ({ ...result, tokens: mergeTokenUsage(usage) });
  let last: ResultChunk | undefined;
  for (const candidate of execution.candidates) {
    const options = execution.options(candidate);
    if (options.abortSignal?.aborted) throw new Error('policy execution aborted');
    if (attempts.some(a => a.model === candidate.model && (a.cooldown_until ?? 0) > now())) continue;
    const used = budgetUsage(execution.events(), execution.floor, attempts);
    const reason = execution.budget.launches !== undefined && used.launches >= execution.budget.launches
      ? 'budget_launches_exceeded'
      : used.weighted_tokens + used.reserve > execution.budget.weighted_tokens ? 'budget_tokens_exceeded' : null;
    if (reason) {
      yield accounted({ type: 'result', isError: true, failure: { class: 'budget_exceeded',
        evidence: JSON.stringify({ reason, used, limits: execution.budget, node: execution.node }) } });
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
      for await (const chunk of execution.provider(candidate).sendQuery(prompt, cwd, session, options)) {
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
    if (cooldown === undefined || options.abortSignal?.aborted) {
      yield accounted(result);
      yield { type: 'settled' };
      return;
    }
    last = result;
    yield { type: 'warning', code: 'superagent.policy_fallback',
      message: JSON.stringify({ node: execution.node, model: candidate.model, failure, cooldown_until: attempt.cooldown_until }) };
  }
  yield accounted(last ?? { type: 'result', isError: true, failure: { class: 'misconfigured',
    evidence: `policy: no eligible model outside cooldown for ${execution.node}` } });
  yield { type: 'settled' };
}

/** Node ids are engine-generated identifiers, not vendor text or agent-interpreted intent. */
function nodeRoute(plan: Plan, node: string, mcp: string[]): { role: 'code' | 'repair' | 'review'; risk: 'G0' | 'G1' | 'G2'; round: number; milestone: string; denied: string[] } {
  const ms = milestones(plan);
  for (const m of ms) {
    for (const p of m.packages) {
      for (const role of ['code', 'repair'] as const) if (node === `${role}-${p.id}`)
        return { role, risk: p.risk, round: 1, milestone: m.id,
          denied: capsDenied(capsOf(plan, p, mcp)) };
    }
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (node === `review-${m.id}-r${String(round)}`)
        return { role: 'review', risk: m.risk, round, milestone: m.id, denied: [] };
      if (node === `fix-${m.id}-r${String(round)}`)
        return { role: 'repair', risk: m.risk, round, milestone: m.id,
          denied: m.packages.flatMap(p => capsDenied(capsOf(plan, p, mcp))) };
    }
  }
  throw new Error(`policy: node ${node} is not declared by the frozen plan`);
}

interface RunRow { id: string; output_root: string; metadata: string }
/** Match the current engine owner exactly; never infer ownership from age or newest run. */
function runtimeExecution(path: string, cwd: string, options: SendQueryOptions,
  factories: Record<Alias['provider'], () => IAgentProvider>, initialProvider: Alias['provider']): Execution {
  const policy = loadPolicy(path), dir = dirname(path);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan;
  const node = options.nodeConfig?.nodeId;
  if (!node) throw new Error('policy: node id missing');
  const route = nodeRoute(plan, node, policy.sandbox.mcp);
  const archonHome = process.env.ARCHON_HOME;
  if (!archonHome) throw new Error('policy: ARCHON_HOME missing');
  const db = new Database(join(archonHome, 'archon.db'), { readonly: true });
  let run: RunRow, assistants: Record<string, Record<string, unknown>>, events: Events;
  try {
    const rows = db.query<RunRow, [string, number]>(
      "SELECT id, output_root, metadata FROM remote_agent_workflow_runs WHERE working_path=? AND status='running' AND json_extract(metadata,'$.execution_owner.pid')=?"
    ).all(cwd, process.pid);
    if (rows.length !== 1) throw new Error('policy: engine owner is missing or ambiguous');
    run = rows[0];
    const metadata = JSON.parse(run.metadata) as { ai_configuration?: { assistants: Record<string, Record<string, unknown>> } };
    assistants = metadata.ai_configuration?.assistants ?? {};
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
  // Include every author that touched this candidate, including failed/partial attempts.
  const authors = route.role === 'review' ? [...new Set([
    ...attempts.filter(a => !a.node.startsWith('review-')).flatMap(a => [a.model, ...(a.resolved ? [a.resolved] : [])]),
    ...events.filter(e => /^(code|repair|fix)-/.test(e.step_name ?? '') && e.event_type === 'node_completed')
      .flatMap(e => { const identity = attemptIdentity(attempts, e.step_name ?? '', e.data?.binding); return identity.model ? [identity.model] : []; }),
  ])] : [];
  const tiers: Tiers = { tiers: {}, policy, routing: policy.routing, health: policy.health };
  const candidates = resolveRoute(tiers, plan.console ?? 'claude', plan.mode, route.role, route.risk, route.round, authors).candidates;
  if (route.role === 'review' && options.model && authors.includes(options.model)) {
    const alternate = candidates.findIndex(a => a.provider !== initialProvider);
    if (alternate > 0) candidates.unshift(...candidates.splice(alternate, 1));
  }
  const extra = join(dir, 'budget-extra');
  const grant = readFileSyncIfPresent(extra);
  const limits = effectiveBudget(plan.budget, grant, route.milestone, readAttempt(join(dir, 'attempts', route.milestone)));
  const role = route.role === 'review' ? 'reviewer' : 'coder';
  return { node, candidates, artifacts, budget: limits, floor: policy.budget_floor.S, events: () => events,
    requestedModel: attempts.filter(a => a.node === node && a.status === 'completed').at(-1)?.model ?? options.model,
    provider: candidate => factories[candidate.provider](),
    options: candidate => {
      // Protected keys belong to the selected native provider's credential delivery.
      // On cross-vendor fallback, use that provider's own native authentication instead.
      const crossed = candidate.provider !== initialProvider;
      const protectedKeys = crossed ? options.protectedEnvKeys ?? [] : [];
      const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => !protectedKeys.includes(key)));
      const nodeConfig = { ...options.nodeConfig };
      if (!isEffortRung(candidate.effort)) throw new Error('policy: unsupported effort');
      nodeConfig.effort = candidate.effort;
      nodeConfig.denied_tools = [...new Set([...(nodeConfig.denied_tools ?? []),
        ...policy.exec_profiles[role].claude.denied_tools, ...route.denied])];
      if (candidate.provider === 'claude') {
        if (nodeConfig.mcp === join(dir, 'reviewer-readonly.mcp.json')) delete nodeConfig.mcp;
        if (role === 'reviewer') nodeConfig.sandbox = policy.exec_profiles.reviewer.claude.sandbox;
      } else if (role === 'reviewer') {
        delete nodeConfig.sandbox;
        nodeConfig.mcp = join(dir, 'reviewer-readonly.mcp.json');
      }
      return { ...options, model: candidate.model, fallbackModel: undefined, env,
        protectedEnvKeys: crossed ? [] : options.protectedEnvKeys, nodeConfig,
        assistantConfig: candidate.provider === 'codex'
          ? { ...assistants.codex, codexBinaryPath: join(dir, 'codex-worker') }
          : { ...assistants.claude } };
    } };
}
function readFileSyncIfPresent(path: string): Parameters<typeof effectiveBudget>[1] {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof effectiveBudget>[1]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Decorate the registered factories while retaining native credential/config parsers and provider IDs. */
export function wrapPolicyProvider(native: IAgentProvider,
  factories: Record<Alias['provider'], () => IAgentProvider>, provider: Alias['provider']): IAgentProvider {
  const send = native.sendQuery.bind(native);
  native.sendQuery = (prompt, cwd, resume, options) => {
    const path = options?.env?.SA_POLICY_PATH;
    if (!path || !options.nodeConfig?.nodeId || options.purpose === 'title-generation')
      return send(prompt, cwd, resume, options);
    return executePolicy(runtimeExecution(path, cwd, options, factories, provider), prompt, cwd, resume);
  };
  return native;
}
export function installPolicyExecutor(): void {
  registerBuiltinProviders();
  const factories = { codex: getRegistration('codex').factory, claude: getRegistration('claude').factory };
  for (const provider of ['codex', 'claude'] as const) {
    getRegistration(provider).factory = () => wrapPolicyProvider(factories[provider](), factories, provider);
  }
}
