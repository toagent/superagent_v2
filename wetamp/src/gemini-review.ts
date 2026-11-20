import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MessageChunk, ProviderCapabilities } from '@archon/providers';
import { validateStructuredOutput } from '@archon/workflows/structured-output';
import { reviewerOutputFormat } from './contract';
import {
  GeminiGatewayError,
  geminiTurn,
  privateRolePath,
  RestrictedRoleInput,
  roleFile,
  roleText,
} from './gemini-role';
import type { RoleContext } from '../templates/.archon/scripts/sa-context';
import {
  readPolicyAttempts,
  writePolicyAttempts,
  type PolicyAttempt,
} from '../templates/.archon/scripts/policy-attempts';

// prettier-ignore
export const geminiCapabilities: ProviderCapabilities = {
  backgroundWork: 'none', sessionResume: false, containerExec: false,
  mcp: false, hooks: false, skills: false, plugins: false, agents: false, nativeTools: false,
  toolRestrictions: false, envInjection: false, sandbox: false, settingSources: false,
  costControl: false, costReporting: false, tokenReporting: false, resolvedModelReporting: true,
  effortControl: false, fallbackModel: false,
  structuredOutput: 'enforced', requiresAllPropertiesRequired: false,
};

export interface GeminiReview {
  models: string[];
  authors: string[];
  contract: string;
  network: boolean;
}

function reviewMaterial(artifacts: string, cwd: string, contract: string, resync: boolean): string {
  const root = realpathSync(artifacts);
  const read = (path: string, dir = root) => {
    const file = realpathSync(path);
    if (dirname(file) !== dir) throw new RestrictedRoleInput('review evidence outside artifacts');
    return roleFile(file);
  };
  const { path } = JSON.parse(read(join(root, `${contract}.context.json`))) as { path: string };
  const raw = read(path, join(root, 'contexts'));
  if (basename(path) !== createHash('sha256').update(raw).digest('hex') + '.json')
    throw new Error('review manifest changed');
  const context = JSON.parse(raw) as RoleContext;
  // prettier-ignore
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
      stderr: 'ignore', timeout: 10_000, maxBuffer: 1_000_000,
    });
    if (result.exitCode !== 0) throw new Error('review checkout unavailable');
    return result.stdout.toString();
  };
  const sha = /^[a-f0-9]{40,64}$/;
  if (context.node !== contract || context.execution.role !== 'review')
    throw new Error('review manifest does not own this node');
  if (
    !sha.test(context.refs.base) ||
    !sha.test(context.refs.delta_base) ||
    git('rev-parse', 'HEAD').trim() !== context.refs.head
  )
    throw new Error('review refs are missing or stale');
  if (typeof context.acceptance === 'string' || context.carry_over === 'unknown')
    throw new Error('review evidence missing');
  for (const base of new Set([context.refs.base, context.refs.delta_base])) {
    if (
      git('diff', '--name-only', '--no-renames', '-z', base, context.refs.head, '--')
        .split('\0')
        .some(privateRolePath)
    )
      throw new RestrictedRoleInput('review diff contains private paths');
  }
  const diff = resync && context.execution.round === 1 ? context.acceptance.delta : context.diff;
  if (!diff || !context.acceptance.log) throw new Error('review diff or log missing');
  return [
    '以下材料为当前候选的核验数据。按本轮约束评审。你没有工具，只能使用这些材料。',
    '证据不足时返回 INCOMPLETE。使用简体中文，只输出符合 schema 的 JSON 对象。',
    JSON.stringify(reviewerOutputFormat),
    `职责及证据\n${raw}`,
    `候选 diff\n${read(diff)}`,
    `验收日志\n${read(context.acceptance.log)}`,
  ].join('\n\n');
}

/** Only settled, validated Gemini verdicts leave the provider boundary. */
export async function* reviewWithGemini(
  review: GeminiReview,
  node: string,
  artifacts: string,
  cwd: string,
  prompt: string,
  signal: AbortSignal | undefined,
  fallback: (prompt: string) => AsyncGenerator<MessageChunk>
): AsyncGenerator<MessageChunk> {
  signal?.throwIfAborted();
  let material: string;
  try {
    material = roleText(
      prompt + '\n\n' + reviewMaterial(artifacts, cwd, review.contract, node !== review.contract)
    );
  } catch (error) {
    const status = 'INCOMPLETE';
    const notes = error instanceof RestrictedRoleInput ? '评审材料受限' : '评审材料缺失或无效';
    yield {
      type: 'result',
      structuredOutput: { status, notes, findings: [], fixture_confirmations: [], debt: [] },
    };
    yield { type: 'settled' };
    return;
  }
  const attempts = readPolicyAttempts(artifacts);
  for (const model of review.network ? new Set(review.models) : []) {
    signal?.throwIfAborted();
    if (review.authors.includes(model) || review.authors.includes(decodeURIComponent(model)))
      continue;
    // prettier-ignore
    const attempt: PolicyAttempt = {
      id: crypto.randomUUID(), node, model,
      provider: 'gemini', status: 'started',
    };
    attempts.push(attempt);
    writePolicyAttempts(artifacts, attempts);
    let result: Awaited<ReturnType<typeof geminiTurn>> | undefined;
    let reason = 'gateway invalid review result';
    try {
      const reply = await geminiTurn(model, material, signal);
      attempt.resolved = reply.model;
      if (
        validateStructuredOutput(reply.value, reviewerOutputFormat).valid &&
        (reply.value as { status: string }).status !== 'INCOMPLETE' &&
        !review.authors.includes(reply.model)
      )
        result = reply;
    } catch (error) {
      if (error instanceof GeminiGatewayError) reason = error.reason;
    }
    attempt.status = result && !signal?.aborted ? 'completed' : 'failed';
    if (attempt.status === 'failed') attempt.failure = 'transient';
    writePolicyAttempts(artifacts, attempts);
    signal?.throwIfAborted();
    if (result) {
      yield {
        type: 'result',
        structuredOutput: result.value,
        stopReason: 'end_turn',
        resolvedModel: { id: result.model },
      };
      yield { type: 'settled' };
      return;
    }
    yield {
      type: 'warning',
      code: 'superagent.gemini_review_failed',
      message: JSON.stringify({ node, model, reason }),
    };
  }
  const reason = review.network ? 'attempts_exhausted' : 'network_denied';
  yield {
    type: 'warning',
    code: 'superagent.gemini_review_fallback',
    message: JSON.stringify({ node, reason }),
  };
  yield* fallback(material);
}
