import type {
  IAgentProvider,
  MessageChunk,
  ResultChunk,
  SendQueryOptions,
} from '@archon/provider-contract';
import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import { readPolicyAttempts, writePolicyAttempts, type PolicyAttempt } from './provider-attempts';
/** These are execution constants, not a second set of operator configuration knobs. */
export const MODEL_FAILURE_COOLDOWN_MS = {
  misconfigured: 24 * 3600_000,
  overloaded: 120_000,
  quota_exhausted: 3600_000,
} as const;
interface BudgetUsage {
  launches: number;
  weighted_tokens: number;
  reserve: number;
}
export interface DispatchCandidate {
  provider: string;
  model: string;
}

export interface DispatchExecution<Candidate extends DispatchCandidate> {
  node: string;
  candidates: Candidate[];
  artifacts: string;
  budget: { launches?: number; weighted_tokens: number; unlimited_tokens?: true };
  usage(attempts: PolicyAttempt[]): BudgetUsage;
  provider: 'codex' | 'claude';
  sendQuery: IAgentProvider['sendQuery'];
  options(candidate: Candidate): SendQueryOptions;
  now?: () => number;
  requestedModel?: string;
}

/** One execution boundary consumes only typed failure classes; provider prose never selects a route. */
export async function* executePolicy<Candidate extends DispatchCandidate>(
  execution: DispatchExecution<Candidate>,
  prompt: string,
  cwd: string,
  resume?: string
): AsyncGenerator<MessageChunk> {
  const now = execution.now ?? Date.now;
  const attempts = readPolicyAttempts(execution.artifacts);
  const usage: TokenUsage[] = [];
  const accounted = (result: ResultChunk, model?: string): ResultChunk => {
    const out = { ...result, tokens: mergeTokenUsage(usage) };
    // The engine binds sessions to its requested model; fallback ownership cannot be relabelled.
    if (
      model !== execution.requestedModel ||
      (result.resolvedModel && result.resolvedModel.id !== model)
    ) {
      delete out.sessionId;
      delete out.resumed;
    }
    return out;
  };
  const budgetFailure = (beforeLaunch: boolean): ResultChunk | undefined => {
    const used = execution.usage(attempts);
    const reason =
      execution.budget.launches !== undefined &&
      (beforeLaunch
        ? used.launches >= execution.budget.launches
        : used.launches > execution.budget.launches)
        ? 'budget_launches_exceeded'
        : !execution.budget.unlimited_tokens &&
            used.weighted_tokens + (beforeLaunch ? used.reserve : 0) >
              execution.budget.weighted_tokens
          ? 'budget_tokens_exceeded'
          : null;
    return reason
      ? {
          type: 'result',
          isError: true,
          failure: {
            class: 'budget_exceeded',
            evidence: JSON.stringify({
              reason,
              used,
              limits: execution.budget,
              node: execution.node,
            }),
          },
        }
      : undefined;
  };
  let last: ResultChunk | undefined;
  // The outer admission slot belongs to this provider for the entire stream.
  for (const candidate of execution.candidates.filter(a => a.provider === execution.provider)) {
    const options = execution.options(candidate);
    if (options.abortSignal?.aborted) throw new Error('policy execution aborted');
    if (attempts.some(a => a.model === candidate.model && (a.cooldown_until ?? 0) > now()))
      continue;
    const over = budgetFailure(true);
    if (over) {
      yield accounted(over);
      yield { type: 'settled' };
      return;
    }
    const attempt: PolicyAttempt = {
      id: crypto.randomUUID(),
      node: execution.node,
      provider: execution.provider,
      model: candidate.model,
      status: 'started',
    };
    attempts.push(attempt);
    writePolicyAttempts(execution.artifacts, attempts); // Reserve even if the process dies mid-turn.
    let result: ResultChunk | undefined,
      settled = false;
    const turnUsage: TokenUsage[] = [];
    try {
      // Never pass a session from a different model or vendor to the fallback.
      const session = !last && candidate.model === execution.requestedModel ? resume : undefined;
      for await (const chunk of execution.sendQuery(prompt, cwd, session, options)) {
        if (chunk.type === 'result') {
          result = chunk;
          if (chunk.tokens) {
            turnUsage.push(chunk.tokens);
            usage.push(chunk.tokens);
          }
        } else if (chunk.type === 'settled') settled = true;
        else yield chunk;
      }
    } catch (error) {
      attempt.status = 'failed';
      attempt.tokens = mergeTokenUsage(turnUsage);
      attempt.resolved = result?.resolvedModel?.id;
      writePolicyAttempts(execution.artifacts, attempts);
      throw error; // An untyped throw cannot justify switching models.
    }
    attempt.status =
      settled && result && !result.failure && !result.isError ? 'completed' : 'failed';
    attempt.tokens = mergeTokenUsage(turnUsage);
    attempt.resolved = result?.resolvedModel?.id;
    attempt.failure = result?.failure?.class;
    const failure = result?.failure?.class;
    const cooldown =
      failure && Object.hasOwn(MODEL_FAILURE_COOLDOWN_MS, failure)
        ? MODEL_FAILURE_COOLDOWN_MS[failure as keyof typeof MODEL_FAILURE_COOLDOWN_MS]
        : undefined;
    if (cooldown !== undefined) attempt.cooldown_until = now() + cooldown;
    writePolicyAttempts(execution.artifacts, attempts);
    if (!settled || !result)
      throw new Error('policy provider stream ended without result and settled');
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
    yield {
      type: 'warning',
      code: 'superagent.policy_fallback',
      message: JSON.stringify({
        node: execution.node,
        model: candidate.model,
        failure,
        cooldown_until: attempt.cooldown_until,
      }),
    };
  }
  yield accounted(
    last ?? {
      type: 'result',
      isError: true,
      failure: {
        class: 'misconfigured',
        evidence: `policy: no eligible ${execution.provider} model outside cooldown for ${execution.node}; vendor reassignment belongs to engine`,
      },
    }
  );
  yield { type: 'settled' };
}
