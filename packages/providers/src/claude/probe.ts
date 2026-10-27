import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { removeTempTree } from '@archon/paths/test-utils';
import { classifyClaudeResultMessage } from './provider';
import { foldClaudeOutcome, type ClaudeOutcome } from './outcome';

export async function probeClaudeAvailability(input: {
  model: string;
  timeoutMs: number;
  budgetUsd: number;
}): Promise<ClaudeOutcome> {
  const cwd = await mkdtemp(join(tmpdir(), 'archon-claude-probe-'));
  const abortController = new AbortController();
  const stream = query({
    prompt: 'Reply with OK.',
    options: {
      model: input.model,
      cwd,
      settingSources: ['user'],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      mcpServers: {},
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: input.budgetUsd,
      abortController,
    },
  });
  let retries = 0;
  let result: SDKResultMessage | undefined;
  const timer = setTimeout(() => {
    abortController.abort();
    stream.close();
  }, input.timeoutMs);
  try {
    for await (const message of stream) {
      retries = foldClaudeOutcome([message], undefined, retries).retries;
      if (message.type === 'result') result = message;
    }
    if (result?.subtype === 'success' && !result.is_error) return { ok: true };
    if (result) {
      const failure = classifyClaudeResultMessage(result) ?? {
        class: 'unknown' as const,
        evidence: 'Claude probe failed',
      };
      return { failure: { ...failure, retries } };
    }
    return {
      failure: {
        class: 'unknown' as const,
        evidence: 'Claude probe ended without a result',
        retries,
      },
    };
  } catch (error) {
    const evidence = abortController.signal.aborted
      ? `Claude probe timed out after ${String(input.timeoutMs)}ms`
      : String(error);
    return { failure: { class: 'unknown', evidence, retries } };
  } finally {
    clearTimeout(timer);
    stream.close();
    await removeTempTree(cwd);
  }
}
