import type {
  IAgentProvider,
  MessageChunk,
  ResultChunk,
  SendQueryOptions,
} from '@archon/provider-contract';
import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import {
  readPolicyAttempts,
  writePolicyAttempts,
  budgetReason,
  type PolicyAttempt,
  type PolicyBudget,
} from './provider-attempts';
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
  provider: 'codex' | 'claude';
  model: string;
}

export interface DispatchExecution<Candidate extends DispatchCandidate> {
  node: string;
  candidates: Candidate[];
  artifacts: string;
  budget: PolicyBudget;
  usage(attempts: PolicyAttempt[]): BudgetUsage;
  provider: 'codex' | 'claude';
  sendQuery: IAgentProvider['sendQuery'];
  sendQueryFor?(candidate: Candidate): IAgentProvider['sendQuery'];
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
  const budgetObservation = (beforeLaunch: boolean): string | undefined => {
    const used = execution.usage(attempts);
    const reason = budgetReason(execution.budget, used, beforeLaunch);
    return reason
      ? JSON.stringify({ reason, used, limits: execution.budget, node: execution.node })
      : undefined;
  };
  let last: ResultChunk | undefined;
  const cooling = (candidate: Candidate): number =>
    Number(
      attempts.some(
        a =>
          a.provider === candidate.provider &&
          a.model === candidate.model &&
          (a.cooldown_until ?? 0) > now()
      )
    );
  const candidates = [...execution.candidates].sort(
    (a, b) =>
      Number(a.provider !== execution.provider) - Number(b.provider !== execution.provider) ||
      cooling(a) - cooling(b)
  );
  let vendorFailed = true;
  let previousProvider = execution.provider;
  for (const candidate of candidates) {
    const priorFailure = last?.failure?.class;
    if (
      candidate.provider !== execution.provider &&
      (!priorFailure || !vendorFailed || !execution.sendQueryFor)
    )
      break;
    const reassignment =
      candidate.provider !== previousProvider && priorFailure
        ? {
            node: execution.node,
            from: previousProvider,
            to: candidate.provider,
            failure: priorFailure,
          }
        : undefined;
    const options = execution.options(candidate);
    if (options.abortSignal?.aborted) throw new Error('policy execution aborted');
    const over = budgetObservation(true);
    if (over) yield { type: 'warning', code: 'superagent.budget_observed', message: over };
    const attempt: PolicyAttempt = {
      id: crypto.randomUUID(),
      node: execution.node,
      provider: candidate.provider,
      ...(reassignment ? { reassignment } : {}),
      model: candidate.model,
      status: 'started',
      // R1-1: persist tracking with the reservation, before any provider code can execute.
      ...(candidate.provider === 'codex' ? { rerouted_models: [] } : {}),
    };
    attempts.push(attempt);
    writePolicyAttempts(execution.artifacts, attempts); // Reserve even if the process dies mid-turn.
    if (reassignment) {
      yield {
        type: 'warning',
        code: 'superagent.vendor_failover',
        message: JSON.stringify(reassignment),
      };
      previousProvider = candidate.provider;
    }
    options.onModelRerouted = (model): void => {
      attempt.rerouted_models ??= [];
      if (model && !attempt.rerouted_models.includes(model)) attempt.rerouted_models.push(model);
      writePolicyAttempts(execution.artifacts, attempts);
    };
    let result: ResultChunk | undefined,
      settled = false;
    const turnUsage: TokenUsage[] = [];
    try {
      // Never pass a session from a different model or vendor to the fallback.
      const session =
        !last &&
        candidate.provider === execution.provider &&
        candidate.model === execution.requestedModel
          ? resume
          : undefined;
      const sendQuery =
        candidate.provider === execution.provider
          ? execution.sendQuery
          : execution.sendQueryFor?.(candidate);
      if (!sendQuery) throw new Error('policy: native failover sender missing');
      for await (const chunk of sendQuery(prompt, cwd, session, options)) {
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
    const vendorFailure =
      failure === 'overloaded' || failure === 'quota_exhausted' || failure === 'transient';
    vendorFailed &&= vendorFailure;
    const cooldown =
      failure && Object.hasOwn(MODEL_FAILURE_COOLDOWN_MS, failure)
        ? MODEL_FAILURE_COOLDOWN_MS[failure as keyof typeof MODEL_FAILURE_COOLDOWN_MS]
        : undefined;
    if (cooldown !== undefined) attempt.cooldown_until = now() + cooldown;
    writePolicyAttempts(execution.artifacts, attempts);
    if (!settled || !result)
      throw new Error('policy provider stream ended without result and settled');
    const observed = budgetObservation(false);
    if (observed)
      yield {
        type: 'warning',
        code: 'superagent.budget_observed',
        message: observed,
      };
    if ((!vendorFailure && cooldown === undefined) || options.abortSignal?.aborted) {
      yield accounted(result, candidate.model);
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
        evidence: `policy: no eligible ${execution.provider} model for ${execution.node}`,
      },
    }
  );
  yield { type: 'settled' };
}
