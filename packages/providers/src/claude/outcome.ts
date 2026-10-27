import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderFailure } from '@archon/provider-contract';

export type ClaudeOutcome = { ok: true } | { failure: ProviderFailure };

export function withClaudeRetries(failure: ProviderFailure, retries: number): ProviderFailure {
  return retries > 0 ? { ...failure, retries } : failure;
}

export function foldClaudeOutcome(
  messages: Iterable<SDKMessage>,
  failure?: ProviderFailure,
  initialRetries = 0
): { retries: number; outcome: ClaudeOutcome } {
  let retries = initialRetries;
  for (const message of messages) {
    if (message.type === 'system' && message.subtype === 'api_retry') retries += 1;
    else if (
      message.type === 'stream_event' ||
      (message.type === 'assistant' &&
        !(message.error !== undefined && message.message.model === '<synthetic>'))
    )
      retries = 0;
  }
  return {
    retries,
    outcome: failure ? { failure: withClaudeRetries(failure, retries) } : { ok: true },
  };
}
