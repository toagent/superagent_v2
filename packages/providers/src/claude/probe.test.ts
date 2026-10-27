import { expect, mock, test } from 'bun:test';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

let behavior: 'success' | 'empty' | 'throw' | 'wait' = 'success';
let seen: Options | undefined;
let closes = 0;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    seen = options;
    const iterator = (async function* (): AsyncGenerator<SDKMessage> {
      if (behavior === 'throw') throw new Error('sdk failed');
      if (behavior === 'wait')
        await new Promise<void>(resolve =>
          options.abortController?.signal.addEventListener('abort', () => resolve())
        );
      if (behavior === 'success')
        yield { type: 'result', subtype: 'success', is_error: false, result: 'OK' } as SDKMessage;
    })();
    return Object.assign(iterator, { close: () => closes++ }) as unknown as Query;
  },
}));
const { probeClaudeAvailability } = await import('./probe');

test('uses isolated SDK options and fails closed on empty, thrown, and timed-out streams', async () => {
  behavior = 'success';
  expect(await probeClaudeAvailability({ model: 'm', timeoutMs: 100, budgetUsd: 0.01 })).toEqual({
    ok: true,
  });
  expect(seen).toMatchObject({
    model: 'm',
    settingSources: ['user'],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    allowedTools: [],
    maxTurns: 1,
    maxBudgetUsd: 0.01,
  });
  for (const value of ['empty', 'throw', 'wait'] as const) {
    behavior = value;
    expect(
      await probeClaudeAvailability({ model: 'm', timeoutMs: 1, budgetUsd: 0.01 })
    ).toHaveProperty('failure');
  }
  expect(closes).toBe(5);
});
