import { expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { foldClaudeOutcome } from './outcome';

const retry = (noResponse = false): SDKMessage =>
  ({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 1,
    error_status: noResponse ? null : 529,
    error: noResponse ? 'unknown' : 'overloaded',
    ...(noResponse ? { no_response: { waited_ms: 1, retry_wait_ms: 1 } } : {}),
  }) as SDKMessage;
const assistant = {
  type: 'assistant',
  message: { model: 'claude', content: [{ type: 'text', text: 'ok' }] },
} as SDKMessage;
const failure = { class: 'transient', evidence: 'failed' } as const;
const count = (messages: SDKMessage[]): number | undefined => {
  const outcome = foldClaudeOutcome(messages, failure).outcome;
  return 'failure' in outcome ? outcome.failure.retries : undefined;
};

test('folds consecutive retries at 9/10 and resets after successful model content', () => {
  expect(count(Array(9).fill(retry()))).toBe(9);
  expect(count([...Array(9).fill(retry()), retry(true)])).toBe(10);
  expect(count([...Array(10).fill(retry()), assistant, retry()])).toBe(1);
});
