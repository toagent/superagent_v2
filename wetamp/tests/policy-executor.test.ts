import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { IAgentProvider, MessageChunk, ResultChunk, SendQueryOptions } from '../../packages/providers/src/types';
import { codexDescriptor } from '@archon/providers';
import { executePolicy, MODEL_FAILURE_COOLDOWN_MS, wrapPolicyProvider } from '../src/policy-executor';
import { loadTiers, snapshotPolicy, type Alias } from '../src/config';
import type { Plan } from '../src/plan';
import { attemptIdentity, budgetUsage } from '../templates/.archon/scripts/sa-check';
import { readPolicyAttempts, writePolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import { tmp } from './helpers';

const pool: Alias[] = [
  { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
  { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
];
const success: ResultChunk = { type: 'result', text: 'done', tokens: { input: 5, output: 5 } };
function fake(run: (options: SendQueryOptions, resume?: string) => ResultChunk | Promise<ResultChunk>): IAgentProvider {
  return {
    getType: () => 'codex', getCapabilities: () => codexDescriptor.capabilities,
    checkCredential: async () => ({ state: 'usable', source: 'native' }),
    async *sendQuery(_prompt, _cwd, resume, options) {
      yield await run(options ?? {}, resume);
      yield { type: 'settled' };
    },
  };
}
async function collect(stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function setup(first: ResultChunk, budget = { launches: 10, weighted_tokens: 1000 }) {
  const artifacts = tmp(), calls: string[] = [], sessions: (string | undefined)[] = [];
  const execution = { node: 'code-core', candidates: pool, artifacts, budget, floor: 20,
    events: () => [], requestedModel: pool[0].model,
    options: (a: Alias) => ({ model: a.model }),
    provider: (a: Alias) => fake((_options, resume) => {
      calls.push(a.model); sessions.push(resume);
      return a.model === pool[0].model ? first : success;
    }),
  };
  return { execution, calls, sessions, artifacts };
}
for (const [name, failure] of [
  ['model unavailable', 'misconfigured'], ['vendor overloaded', 'overloaded'], ['quota exhausted', 'quota_exhausted'],
] as const) test(`${name}: typed failure falls back in snapshot order and accounts for both attempts`, async () => {
  const s = setup({ type: 'result', isError: true, failure: { class: failure, evidence: 'opaque diagnostic' },
    tokens: { input: 8, output: 2 } });
  const out = await collect(executePolicy(s.execution, 'prompt', '/scratch', 'original-session'));
  expect(s.calls).toEqual(pool.slice(0, 2).map(a => a.model));
  expect(s.sessions).toEqual(['original-session', undefined]);
  expect(out.filter(c => c.type === 'result')).toEqual([{ ...success, tokens: { input: 13, output: 7 } }]);
  const attempts = readPolicyAttempts(s.artifacts);
  expect(attempts[0]).toMatchObject({ status: 'failed', failure });
  expect(attempts[0].cooldown_until).toBeGreaterThan(Date.now() + MODEL_FAILURE_COOLDOWN_MS[failure] - 1000);
  expect(budgetUsage([{ event_type: 'node_started', step_name: 'code-core' },
    { event_type: 'node_completed', step_name: 'code-core', data: { spend: { tokens: { source: 'provider', value: { input: 10, output: 10 } } } } }], 20, attempts))
    .toMatchObject({ launches: 2, weighted_tokens: 20 });
  expect(attemptIdentity(attempts, 'code-core')).toEqual({ model: pool[1].model, strength: 'pinned' });
});

test('all provider results and fallback attempts contribute to the emitted usage and budget', async () => {
  const s = setup(success);
  const provider = (a: Alias): IAgentProvider => ({ ...fake(() => success),
    async *sendQuery() {
      yield { type: 'result', tokens: { input: 5, output: 2 } };
      yield a.model === pool[0].model ? { type: 'result', isError: true,
        failure: { class: 'overloaded', evidence: 'typed' }, tokens: { input: 7, output: 3 } } : success;
      yield { type: 'settled' };
    },
  });
  const chunks = await collect(executePolicy({ ...s.execution, provider }, 'p', '/scratch'));
  expect(chunks.at(-2)).toMatchObject({ tokens: { input: 22, output: 12 } });
  const attempts = readPolicyAttempts(s.artifacts);
  expect(attempts.map(a => a.tokens)).toEqual([{ input: 12, output: 5 }, { input: 10, output: 7 }]);
  expect(budgetUsage([], 20, attempts)).toMatchObject({ launches: 2, weighted_tokens: 34 });
});

test('malformed persisted attempts fail closed instead of weakening budget or model identity', () => {
  const artifacts = tmp();
  for (const value of [null, [{}], [{ id: 'x', node: 'code-core', provider: 'codex', model: 'gpt-6.1-sol',
    status: 'completed', tokens: { input: -1, output: 5 } }],
  [{ id: 'x', node: 'code-core', provider: 'codex', model: 'gpt-6.1-sol', status: 'completed',
    tokens: { input: 1, output: 1, cacheRead: 10 } }]]) {
    writeFileSync(join(artifacts, 'policy-attempts.json'), JSON.stringify(value));
    expect(() => readPolicyAttempts(artifacts)).toThrow('policy-attempts:');
  }
});

test('cooldown skips the failed model across node calls and expires without resetting budget', async () => {
  const s = setup({ type: 'result', failure: { class: 'overloaded', evidence: 'typed' }, isError: true });
  let now = 100;
  await collect(executePolicy({ ...s.execution, now: () => now }, 'p', '/scratch'));
  s.calls.length = 0;
  await collect(executePolicy({ ...s.execution, node: 'repair-core', now: () => now }, 'p', '/scratch'));
  expect(s.calls).toEqual([pool[1].model]);
  now += MODEL_FAILURE_COOLDOWN_MS.overloaded;
  s.calls.length = 0;
  await collect(executePolicy({ ...s.execution, node: 'fix-m1-r2', now: () => now }, 'p', '/scratch'));
  expect(s.calls).toEqual(pool.slice(0, 2).map(a => a.model));
  expect(readPolicyAttempts(s.artifacts)).toHaveLength(5);
});

for (const budget of [{ launches: 1, weighted_tokens: 1000 }, { launches: 10, weighted_tokens: 30 }])
  test(`fallback fails when total budget is exhausted: ${JSON.stringify(budget)}`, async () => {
    const s = setup({ type: 'result', isError: true, failure: { class: 'quota_exhausted', evidence: 'typed' } }, budget);
    const chunks = await collect(executePolicy(s.execution, 'p', '/scratch'));
    expect(s.calls).toEqual([pool[0].model]);
    expect(chunks.at(-2)).toMatchObject({ type: 'result', failure: { class: 'budget_exceeded' } });
    const result = chunks.at(-2) as ResultChunk;
    expect(JSON.parse(result.failure!.evidence)).toMatchObject({ used: { launches: 1, weighted_tokens: 20 } });
  });

test('untyped failure, unknown/auth/transient classes and throws never trigger fallback', async () => {
  for (const result of [
    { type: 'result', isError: true, errors: ['model not found: quota exhausted'] },
    ...(['unknown', 'auth', 'transient'] as const).map(failure => ({ type: 'result' as const, isError: true,
      failure: { class: failure, evidence: 'model_not_found quota overloaded' } })),
  ] as ResultChunk[]) {
    const s = setup(result);
    expect((await collect(executePolicy(s.execution, 'p', '/scratch'))).at(-2)).toEqual(result);
    expect(s.calls).toHaveLength(1);
  }
  const s = setup(success);
  await expect(collect(executePolicy({ ...s.execution, provider: () => fake(() => { throw new Error('quota exhausted'); }) }, 'p', '/scratch')))
    .rejects.toThrow('quota exhausted');
  expect(readPolicyAttempts(s.artifacts)[0].status).toBe('failed');
});

test('runtime wrapper: reviewer-alt excludes actual author; cross-vendor fallback keeps read-only and native credentials', async () => {
  const root = tmp(), artifacts = join(root, 'artifacts/runs/run');
  mkdirSync(artifacts, { recursive: true });
  const tiers = loadTiers(), policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(snapshotPolicy(tiers)));
  const plan = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')) as Plan;
  plan.console = 'codex'; plan.budget = { launches: 20, weighted_tokens: 2_000_000 };
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  writePolicyAttempts(artifacts, [{ id: 'author', node: 'code-core', provider: 'claude',
    model: 'claude-opus-5', resolved: 'claude-opus-5', status: 'completed', tokens: { input: 10, output: 0 } }]);
  const db = new Database(join(root, 'archon.db'));
  db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT, working_path TEXT, status TEXT, output_root TEXT, metadata TEXT)');
  db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, data TEXT, event_order INTEGER)');
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?)', ['run', root, 'running', root,
    JSON.stringify({ execution_owner: { pid: process.pid }, ai_configuration: { assistants: { claude: { settingSources: ['project', 'user'] } } } })]);
  db.run('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?)', ['run', 'node_started', 'review-m1-r1', '{}', 1]);
  db.close();
  const calls: SendQueryOptions[] = [];
  const factories = { codex: () => fake(options => { calls.push(options);
    return options.nodeConfig?.nodeId === 'code-core' ? { type: 'result', isError: true,
      failure: { class: 'overloaded', evidence: 'typed' }, tokens: { input: 1, output: 1 } }
      : { ...success, resolvedModel: { id: options.model! } }; }),
    claude: () => fake(options => { calls.push(options); return success; }) };
  const before = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = root;
  try {
    const provider = wrapPolicyProvider(fake(() => { throw new Error('original must not execute'); }), factories, 'claude');
    await collect(provider.sendQuery('p', root, undefined, { model: 'claude-opus-5',
      env: { SA_POLICY_PATH: policyPath, PROVIDER_CREDENTIAL: 'scratch-only', KEEP: 'yes' }, protectedEnvKeys: ['PROVIDER_CREDENTIAL'],
      nodeConfig: { nodeId: 'review-m1-r1', sandbox: tiers.policy.exec_profiles.reviewer.claude.sandbox } }));
    expect(calls.map(o => o.model)).toEqual(['gpt-6-astra']);
    expect(calls[0].env).toEqual({ SA_POLICY_PATH: policyPath, KEEP: 'yes' });
    expect(calls[0].nodeConfig?.mcp).toBe(join(root, 'reviewer-readonly.mcp.json'));
    expect(calls[0].nodeConfig?.denied_tools).toContain('Write');
    expect(calls[0].assistantConfig?.codexBinaryPath).toBe(join(root, 'codex-worker'));
    expect(attemptIdentity(readPolicyAttempts(artifacts), 'review-m1-r1').model).toBe('gpt-6-astra');
    calls.length = 0;
    const coder = wrapPolicyProvider(fake(() => { throw new Error('original must not execute'); }), factories, 'codex');
    await collect(coder.sendQuery('p', root, undefined, { model: tiers.routing.coder.models[0],
      env: { SA_POLICY_PATH: policyPath, CODEX_CREDENTIAL: 'scratch-only' }, protectedEnvKeys: ['CODEX_CREDENTIAL'],
      nodeConfig: { nodeId: 'code-core' } }));
    const expected = tiers.routing.coder.models.slice(0, tiers.routing.coder.models.findIndex(m => m.startsWith('claude')) + 1);
    expect(calls.map(o => o.model)).toEqual(expected);
    expect(calls.at(-1)?.env).toEqual({ SA_POLICY_PATH: policyPath });
    expect(calls.at(-1)?.assistantConfig?.settingSources).toEqual(['project', 'user']);
    expect(budgetUsage([], 20, readPolicyAttempts(artifacts)).launches).toBe(2 + expected.length);
  } finally { if (before === undefined) delete process.env.ARCHON_HOME; else process.env.ARCHON_HOME = before; }
});

test('advisory threshold key reaches its consumer and produces only an advisory', () => {
  const { roleLimit, advise } = createRequire(import.meta.url)('../hooks/context-advisory.cjs') as {
    roleLimit(role: string, policy: unknown): number;
    advise(input: unknown, tokens: number, prior: unknown, active: boolean, threshold: number): { messages: string[] };
  };
  expect(roleLimit('general', { context: { advisory_tokens: { general: 123 } } })).toBe(123);
  expect(advise({ hook_event_name: 'UserPromptSubmit' }, 124, {}, false, 123).messages[0]).toContain('advisory');
  expect(loadTiers().policy.context.advisory_tokens.general).toBe(240000);
});
