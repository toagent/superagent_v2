import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
      reason: 'vendor_failure',
      failure,
    });
    expect(chunks.at(-2)).not.toHaveProperty('sessionId');
    expect(readPolicyAttempts(s.artifacts).at(-1)).toMatchObject({
      provider: 'claude',
      status: 'completed',
      reassignment: { from: 'codex', to: 'claude', reason: 'vendor_failure', failure },
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

for (const missing of ['result', 'settled'] as const)
  test(`VENDOR_FAILOVER missing ${missing} is transient, falls back, and exhausts typed`, async () => {
    const incomplete = (s: ReturnType<typeof setup>) =>
      (s.execution.sendQuery = async function* (_prompt, _cwd, session, options) {
        s.calls.push({ model: options?.model, session, provider: 'codex' });
        if (missing === 'result') yield { type: 'settled' };
        else yield { type: 'result', text: 'orphaned result' };
      });
    const s = setup();
    incomplete(s);
    const chunks = await collect(executePolicy(s.execution, 'p', '/scratch', 'original'));
    expect(s.calls.map(c => c.model)).toEqual(['codex-a', 'codex-b', 'claude-a']);
    expect(readPolicyAttempts(s.artifacts)[0]).toMatchObject({
      status: 'failed',
      failure: 'transient',
    });
    const exhausted = setup();
    exhausted.execution.candidates = [pool[0]];
    incomplete(exhausted);
    const exhaustedChunks = await collect(executePolicy(exhausted.execution, 'p', '/scratch'));
    expect(exhaustedChunks.at(-2)).toMatchObject({
      type: 'result',
      isError: true,
      failure: { class: 'transient', evidence: expect.stringContaining(missing) },
    });
    expect(exhaustedChunks.at(-1)).toEqual({ type: 'settled' });
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
  });

test('VENDOR_FAILOVER misconfigured candidate prevents vendor reassignment', async () => {
  const s = setup('misconfigured');
  await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls.map(c => c.provider)).toEqual(['codex', 'codex']);
});

test('VENDOR_FAILOVER awaits settlement, skips a newly unavailable vendor, and emits warnings', async () => {
  const s = setup('rate_limited');
  let available = true;
  s.execution.available = candidate => candidate.provider !== 'codex' || available;
  s.execution.onSettled = async () => {
    await Promise.resolve();
    available = false;
    return { code: 'superagent.health_persist_failed', message: 'fixture' };
  };
  const chunks = await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls.map(c => c.model)).toEqual(['codex-a', 'claude-a']);
  expect(chunks.filter(c => c.type === 'warning').map(c => c.code)).toEqual(
    expect.arrayContaining(['superagent.health_persist_failed', 'superagent.vendor_skipped'])
  );
  expect(readPolicyAttempts(s.artifacts).at(-1)?.reassignment).toMatchObject({
    reason: 'vendor_unavailable',
  });
});

test('VENDOR_FAILOVER routes without a native candidate and normalizes legacy reassignment', async () => {
  const s = setup();
  s.execution.provider = 'claude';
  s.execution.candidates = pool.filter(c => c.provider === 'codex');
  s.execution.available = () => true;
  await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls[0]).toMatchObject({ provider: 'codex', model: 'codex-a' });
  expect(readPolicyAttempts(s.artifacts)[0]?.reassignment).toMatchObject({
    reason: 'vendor_unavailable',
  });
  writeFileSync(
    join(s.artifacts, 'policy-attempts.json'),
    '[{"id":"old","node":"n","provider":"codex","model":"m","status":"failed","reassignment":{"node":"n","from":"claude","to":"codex","failure":"overloaded"}}]'
  );
  expect(readPolicyAttempts(s.artifacts)[0]?.reassignment).toMatchObject({
    reason: 'vendor_failure',
    failure: 'overloaded',
  });
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
