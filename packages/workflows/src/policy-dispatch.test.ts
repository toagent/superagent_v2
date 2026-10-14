import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { MessageChunk, ProviderFailureClass } from '@archon/provider-contract';
import { executePolicy, type DispatchExecution } from './policy-dispatch';
import { readPolicyAttempts, writePolicyAttempts } from './provider-attempts';

const roots = trackTempRoots();
const pool = [
  { provider: 'codex' as const, model: 'codex-a' },
  { provider: 'codex' as const, model: 'codex-b' },
  { provider: 'claude' as const, model: 'claude-a' },
];
const collect = async (stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> => {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
function setup(failure: ProviderFailureClass = 'overloaded'): {
  execution: DispatchExecution<(typeof pool)[number]>;
  calls: { model?: string; session?: string; provider: string }[];
  artifacts: string;
} {
  const artifacts = mkdtempSync(join(tmpdir(), 'vendor-failover-'));
  roots(artifacts);
  const calls: { model?: string; session?: string; provider: string }[] = [];
  const send = (provider: string): DispatchExecution<(typeof pool)[number]>['sendQuery'] =>
    async function* (_prompt, _cwd, session, options) {
      calls.push({ model: options?.model, session, provider });
      yield provider === 'codex'
        ? { type: 'result', isError: true, failure: { class: failure, evidence: 'opaque' } }
        : { type: 'result', sessionId: 'claude-session', text: 'done' };
      yield { type: 'settled' };
    };
  const execution: DispatchExecution<(typeof pool)[number]> = {
    node: 'code-core',
    candidates: pool,
    artifacts,
    provider: 'codex',
    requestedModel: pool[0].model,
    budget: { weighted_tokens: 1000 },
    usage: () => ({ launches: 0, weighted_tokens: 0, reserve: 0 }),
    options: candidate => ({ model: candidate.model }),
    sendQuery: send('codex'),
    sendQueryFor: candidate => send(candidate.provider),
  };
  return { execution, calls, artifacts };
}
for (const failure of ['overloaded', 'quota_exhausted', 'transient'] as const)
  test(`VENDOR_FAILOVER ${failure}: exhaust vendor, clear session, warn and persist`, async () => {
    const s = setup(failure);
    const chunks = await collect(executePolicy(s.execution, 'p', '/scratch', 'original'));
    expect(s.calls).toEqual([
      { model: 'codex-a', session: 'original', provider: 'codex' },
      { model: 'codex-b', session: undefined, provider: 'codex' },
      { model: 'claude-a', session: undefined, provider: 'claude' },
    ]);
    const warning = chunks.find(
      c => c.type === 'warning' && c.code === 'superagent.vendor_failover'
    );
    expect(warning?.type === 'warning' && JSON.parse(warning.message)).toEqual({
      node: 'code-core',
      from: 'codex',
      to: 'claude',
      failure,
    });
    expect(chunks.at(-2)).not.toHaveProperty('sessionId');
    expect(readPolicyAttempts(s.artifacts).at(-1)).toMatchObject({
      provider: 'claude',
      status: 'completed',
      reassignment: { from: 'codex', to: 'claude', failure },
    });
  });

test('VENDOR_FAILOVER unclassified throw preserves failure without reassignment', async () => {
  const s = setup();
  s.execution.sendQuery = async function* () {
    throw new Error('overloaded HTTP 503');
  };
  await expect(collect(executePolicy(s.execution, 'p', '/scratch'))).rejects.toThrow(
    'overloaded HTTP 503'
  );
  expect(s.calls).toEqual([]);
  expect(readPolicyAttempts(s.artifacts)).toHaveLength(1);
});

test('VENDOR_FAILOVER misconfigured candidate prevents vendor reassignment', async () => {
  const s = setup('misconfigured');
  await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls.map(c => c.provider)).toEqual(['codex', 'codex']);
});

test('VENDOR_FAILOVER all cooled candidates are still attempted; warm sorts first', async () => {
  const s = setup();
  writePolicyAttempts(
    s.artifacts,
    pool.map((c, i) => ({
      ...c,
      id: String(i),
      node: 'prior',
      status: 'failed' as const,
      cooldown_until: Date.now() + 100000,
    }))
  );
  await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls.map(c => c.model)).toEqual(pool.map(c => c.model));
  const t = setup();
  writePolicyAttempts(t.artifacts, [
    {
      ...pool[0],
      id: 'prior',
      node: 'prior',
      status: 'failed',
      cooldown_until: Date.now() + 100000,
    },
  ]);
  await collect(executePolicy(t.execution, 'p', '/scratch'));
  expect(t.calls.map(c => c.model)).toEqual(['codex-b', 'codex-a', 'claude-a']);
});

test('BYPASS_CAPACITY exhausted thresholds warn through fallback and successful settlement', async () => {
  const artifacts = roots(mkdtempSync(join(tmpdir(), 'bypass-policy-')));
  const calls: string[] = [];
  const chunks: MessageChunk[] = [];
  for await (const chunk of executePolicy(
    {
      node: 'code-fixture',
      artifacts,
      provider: 'codex',
      candidates: [
        { provider: 'codex', model: 'first' },
        { provider: 'codex', model: 'second' },
      ],
      budget: { launches: 0, weighted_tokens: 0 },
      usage: attempts => ({
        launches: attempts.length,
        weighted_tokens: attempts.length * 10,
        reserve: 10,
      }),
      options: candidate => ({ model: candidate.model }),
      async *sendQuery(_prompt, _cwd, _resume, options) {
        const model = options?.model;
        if (!model) throw new Error('missing model');
        calls.push(model);
        yield model === 'first'
          ? {
              type: 'result',
              isError: true,
              failure: { class: 'overloaded', evidence: 'typed failure' },
              tokens: { input: 8, output: 2 },
            }
          : { type: 'result', tokens: { input: 8, output: 2 } };
        yield { type: 'settled' };
      },
    },
    'fixture',
    artifacts
  ))
    chunks.push(chunk);
  expect(calls).toEqual(['first', 'second']);
  expect(
    chunks.filter(c => c.type === 'warning' && c.code === 'superagent.budget_observed')
  ).toHaveLength(4);
  expect(chunks.at(-2)).toMatchObject({ type: 'result', tokens: { input: 16, output: 4 } });
  expect(chunks.at(-2)).not.toHaveProperty('failure');
  expect(readPolicyAttempts(artifacts).map(a => a.status)).toEqual(['failed', 'completed']);
});
