import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type {
  IAgentProvider,
  MessageChunk,
  ResultChunk,
  SendQueryOptions,
} from '../../packages/providers/src/types';
import { codexDescriptor } from '@archon/providers';
import {
  executePolicy,
  MODEL_FAILURE_COOLDOWN_MS,
  wrapPolicyProvider,
} from '../src/policy-executor';
import { loadTiers, snapshotPolicy, type Alias } from '../src/config';
import type { Plan } from '../src/plan';
import { executePolicy as dispatchPolicy } from '@archon/workflows/policy-dispatch';
import { attemptIdentity, budgetUsage } from '../templates/.archon/scripts/sa-check';
import {
  readPolicyAttempts,
  writePolicyAttempts,
} from '../templates/.archon/scripts/policy-attempts';
import { tmp } from './helpers';

const pool: Alias[] = [
  { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
  { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
];
const success: ResultChunk = { type: 'result', text: 'done', tokens: { input: 5, output: 5 } };
function fake(
  run: (options: SendQueryOptions, resume?: string) => ResultChunk | Promise<ResultChunk>
): IAgentProvider {
  return {
    getType: () => 'codex',
    getCapabilities: () => codexDescriptor.capabilities,
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
function setup(
  first: ResultChunk,
  budget: Plan['budget'] = { launches: 10, weighted_tokens: 1000 }
) {
  const artifacts = tmp(),
    calls: string[] = [],
    sessions: (string | undefined)[] = [];
  const execution = {
    node: 'code-core',
    candidates: pool,
    artifacts,
    budget,
    floor: 20,
    events: () => [],
    requestedModel: pool[0].model,
    options: (a: Alias) => ({ model: a.model }),
    provider: 'codex' as const,
    sendQuery: fake((options, resume) => {
      calls.push(options.model!);
      sessions.push(resume);
      return options.model === pool[0].model ? first : success;
    }).sendQuery,
  };
  return { execution, calls, sessions, artifacts };
}
for (const [name, failure] of [
  ['model unavailable', 'misconfigured'],
  ['vendor overloaded', 'overloaded'],
  ['quota exhausted', 'quota_exhausted'],
] as const)
  test(`${name}: typed failure falls back in snapshot order and accounts for both attempts`, async () => {
    const s = setup({
      type: 'result',
      isError: true,
      failure: { class: failure, evidence: 'opaque diagnostic' },
      tokens: { input: 8, output: 2 },
    });
    const out = await collect(executePolicy(s.execution, 'prompt', '/scratch', 'original-session'));
    expect(s.calls).toEqual(pool.slice(0, 2).map(a => a.model));
    expect(s.sessions).toEqual(['original-session', undefined]);
    expect(out.filter(c => c.type === 'result')).toEqual([
      { ...success, tokens: { input: 13, output: 7 } },
    ]);
    const attempts = readPolicyAttempts(s.artifacts);
    expect(attempts[0]).toMatchObject({ status: 'failed', failure });
    expect(attempts[0].cooldown_until).toBeGreaterThan(
      Date.now() + MODEL_FAILURE_COOLDOWN_MS[failure] - 1000
    );
    expect(
      budgetUsage(
        [
          { event_type: 'node_started', step_name: 'code-core' },
          {
            event_type: 'node_completed',
            step_name: 'code-core',
            data: { spend: { tokens: { source: 'provider', value: { input: 10, output: 10 } } } },
          },
        ],
        20,
        attempts
      )
    ).toMatchObject({ launches: 2, weighted_tokens: 20 });
    expect(attemptIdentity(attempts, 'code-core')).toEqual({
      model: pool[1].model,
      strength: 'pinned',
    });
  });

test('all provider results and fallback attempts contribute to the emitted usage and budget', async () => {
  const s = setup(success);
  const provider: IAgentProvider = {
    ...fake(() => success),
    async *sendQuery(_prompt, _cwd, _resume, options) {
      yield { type: 'result', tokens: { input: 5, output: 2 } };
      yield options?.model === pool[0].model
        ? {
            type: 'result',
            isError: true,
            failure: { class: 'overloaded', evidence: 'typed' },
            tokens: { input: 7, output: 3 },
          }
        : success;
      yield { type: 'settled' };
    },
  };
  const chunks = await collect(
    executePolicy({ ...s.execution, sendQuery: provider.sendQuery }, 'p', '/scratch')
  );
  expect(chunks.at(-2)).toMatchObject({ tokens: { input: 22, output: 12 } });
  const attempts = readPolicyAttempts(s.artifacts);
  expect(attempts.map(a => a.tokens)).toEqual([
    { input: 12, output: 5 },
    { input: 10, output: 7 },
  ]);
  expect(budgetUsage([], 20, attempts)).toMatchObject({ launches: 2, weighted_tokens: 34 });
});

test('malformed persisted attempts fail closed instead of weakening budget or model identity', () => {
  const artifacts = tmp();
  for (const value of [
    null,
    [{}],
    [
      {
        id: 'x',
        node: 'code-core',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        status: 'completed',
        tokens: { input: -1, output: 5 },
      },
    ],
    [
      {
        id: 'x',
        node: 'code-core',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        status: 'completed',
        tokens: { input: 1, output: 1, cacheRead: 10 },
      },
    ],
  ]) {
    writeFileSync(join(artifacts, 'policy-attempts.json'), JSON.stringify(value));
    expect(() => readPolicyAttempts(artifacts)).toThrow('policy-attempts:');
  }
});

test('cooldown sorts the failed model after warm candidates and expires without resetting usage', async () => {
  const s = setup({
    type: 'result',
    failure: { class: 'overloaded', evidence: 'typed' },
    isError: true,
  });
  let now = 100;
  await collect(executePolicy({ ...s.execution, now: () => now }, 'p', '/scratch'));
  s.calls.length = 0;
  await collect(
    executePolicy({ ...s.execution, node: 'repair-core', now: () => now }, 'p', '/scratch')
  );
  expect(s.calls).toEqual([pool[1].model]);
  now += MODEL_FAILURE_COOLDOWN_MS.overloaded;
  s.calls.length = 0;
  await collect(
    executePolicy({ ...s.execution, node: 'fix-m1-r2', now: () => now }, 'p', '/scratch')
  );
  expect(s.calls).toEqual(pool.slice(0, 2).map(a => a.model));
  expect(readPolicyAttempts(s.artifacts)).toHaveLength(5);
});

test('untyped failure, unknown/auth classes and throws never trigger fallback', async () => {
  for (const result of [
    { type: 'result', isError: true, errors: ['model not found: quota exhausted'] },
    ...(['unknown', 'auth'] as const).map(failure => ({
      type: 'result' as const,
      isError: true,
      failure: { class: failure, evidence: 'model_not_found quota overloaded' },
    })),
  ] as ResultChunk[]) {
    const s = setup(result);
    expect((await collect(executePolicy(s.execution, 'p', '/scratch'))).at(-2)).toEqual(result);
    expect(s.calls).toHaveLength(1);
  }
  const s = setup(success);
  await expect(
    collect(
      executePolicy(
        {
          ...s.execution,
          sendQuery: fake(() => {
            throw new Error('quota exhausted');
          }).sendQuery,
        },
        'p',
        '/scratch'
      )
    )
  ).rejects.toThrow('quota exhausted');
  expect(readPolicyAttempts(s.artifacts)[0].status).toBe('failed');
});

function runtimeFixture() {
  const root = tmp(),
    artifacts = join(root, 'artifacts/runs/run');
  mkdirSync(artifacts, { recursive: true });
  const tiers = loadTiers(),
    policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(snapshotPolicy(tiers)));
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  plan.console = 'claude';
  plan.budget = { launches: 20, weighted_tokens: 2_000_000 };
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  const db = new Database(join(root, 'archon.db'));
  db.run(
    'CREATE TABLE remote_agent_workflow_runs (id TEXT, working_path TEXT, status TEXT, output_root TEXT, metadata TEXT, codebase_id TEXT, adopted_from_run_id TEXT)'
  );
  db.run(
    'CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, data TEXT, event_order INTEGER)'
  );
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, ?)', [
    'run',
    root,
    'running',
    root,
    JSON.stringify({ execution_owner: { pid: process.pid } }),
    'repo',
    null,
  ]);
  db.close();
  return { root, artifacts, tiers, policyPath, plan };
}
async function inRuntime<T>(root: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = root;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = before;
  }
}

test('POLICY-R1-01/02: same-vendor fallback preserves protected child env and the admitted slot', async () => {
  const s = runtimeFixture(),
    calls: SendQueryOptions[] = [];
  const env = {
    SA_POLICY_PATH: s.policyPath,
    GH_TOKEN: '',
    CODEX_CREDENTIAL: 'scratch-only',
    KEEP: 'yes',
  };
  const protectedEnvKeys = ['GH_TOKEN', 'CODEX_CREDENTIAL'];
  let held = false,
    admissions = 0;
  const native = fake(options => {
    expect(held).toBe(true);
    calls.push(options);
    const child = Bun.spawnSync(
      [
        'bun',
        '-e',
        'process.stdout.write(JSON.stringify([process.env.GH_TOKEN, process.env.CODEX_CREDENTIAL, process.env.KEEP]))',
      ],
      {
        env: { ...process.env, GH_TOKEN: 'ambient-scratch', ...options.env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual(['', 'scratch-only', 'yes']);
    expect(options.env).toBe(env);
    expect(options.protectedEnvKeys).toBe(protectedEnvKeys);
    return options.model === s.tiers.routing.coder.models[0]
      ? { type: 'result', isError: true, failure: { class: 'overloaded', evidence: 'typed' } }
      : success;
  });
  const provider = wrapPolicyProvider(native, 'codex');
  const admitted: IAgentProvider = {
    ...provider,
    async *sendQuery(...args) {
      admissions++;
      held = true;
      try {
        yield* provider.sendQuery(...args);
      } finally {
        held = false;
      }
    },
  };
  await inRuntime(s.root, () =>
    collect(
      admitted.sendQuery('p', s.root, undefined, {
        model: s.tiers.routing.coder.models[0],
        env,
        protectedEnvKeys,
        nodeConfig: { nodeId: 'code-core' },
      })
    )
  );
  expect(calls.map(o => o.model)).toEqual(
    s.tiers.routing.coder.models.filter(m => m.startsWith('gpt')).slice(0, 2)
  );
  expect(admissions).toBe(1);
  expect(held).toBe(false);
});

test('POLICY-R1-02/04: exhausted same-vendor pool returns typed failure without cross-vendor calls', async () => {
  const s = setup({
    type: 'result',
    isError: true,
    failure: { class: 'quota_exhausted', evidence: 'typed' },
  });
  const failure: ResultChunk = {
    type: 'result',
    isError: true,
    failure: { class: 'quota_exhausted', evidence: 'typed' },
  };
  const chunks = await collect(
    executePolicy(
      {
        ...s.execution,
        sendQuery: fake(options => {
          s.calls.push(options.model!);
          if (options.model!.startsWith('claude'))
            throw new Error('cross-vendor call must never execute');
          return failure;
        }).sendQuery,
      },
      'p',
      '/scratch'
    )
  );
  expect(s.calls).toEqual(pool.slice(0, 2).map(a => a.model));
  expect(chunks.at(-2)).toMatchObject(failure);
});

test('POLICY-R1-04: fallback session is withheld and the next node starts a fresh session', async () => {
  const s = setup(success);
  const failure: ResultChunk = {
    type: 'result',
    isError: true,
    sessionId: 'failed-session',
    failure: { class: 'overloaded', evidence: 'typed' },
  };
  let now = 100,
    fail = true;
  const execution = {
    ...s.execution,
    now: () => now,
    sendQuery: fake((options, resume) => {
      s.sessions.push(resume);
      return fail && options.model === pool[0].model
        ? failure
        : { ...success, sessionId: `session-${options.model}` };
    }).sendQuery,
  };
  const first = await collect(executePolicy(execution, 'p', '/scratch', 'original-session'));
  const result = first.at(-2) as ResultChunk;
  expect(result.sessionId).toBeUndefined();
  expect(s.sessions).toEqual(['original-session', undefined]);
  now += MODEL_FAILURE_COOLDOWN_MS.overloaded;
  fail = false;
  await collect(
    executePolicy({ ...execution, node: 'repair-core' }, 'p', '/scratch', result.sessionId)
  );
  expect(s.sessions.at(-1)).toBeUndefined();
});

test('BYPASS_CAPACITY final successful call retains success, receipts and budget warnings', async () => {
  const s = setup(
    { ...success, tokens: { input: 25, output: 20 } },
    { launches: 0, weighted_tokens: 0 }
  );
  const chunks = await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(chunks.at(-2)).toMatchObject({ type: 'result', tokens: { input: 25, output: 20 } });
  expect(chunks.at(-2)).not.toHaveProperty('failure');
  expect(chunks).toContainEqual(
    expect.objectContaining({ type: 'warning', code: 'superagent.budget_observed' })
  );
  expect(readPolicyAttempts(s.artifacts)[0]).toMatchObject({
    status: 'completed',
    tokens: { input: 25, output: 20 },
  });
});

test('POLICY-R1-05: declared G0 risk-path acceptance selects the G2 review pool and effort', async () => {
  const s = runtimeFixture(),
    calls: SendQueryOptions[] = [];
  s.plan.packages[0].risk = 'G0';
  writeFileSync(join(s.root, 'plan.json'), JSON.stringify(s.plan));
  // Structured acceptance is the owner of inferred risk; the runtime does not parse paths again.
  const { scopeRisk } = await import('../templates/.archon/scripts/sa-check');
  const acceptance = scopeRisk(
    [{ modes: ['100644', '100644'], paths: ['src/auth/token.ts'] }],
    ['src'],
    s.tiers.policy,
    'G0'
  );
  expect(acceptance.risk).toBe('G2');
  writeFileSync(join(s.artifacts, 'diff-m1-r1.json'), JSON.stringify(acceptance));
  writePolicyAttempts(s.artifacts, [
    {
      id: 'author',
      node: 'code-core',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      status: 'completed',
      tokens: { input: 10, output: 0 },
    },
  ]);
  const native = fake(options => {
    calls.push(options);
    return success;
  });
  const provider = wrapPolicyProvider(native, 'codex');
  await inRuntime(s.root, () =>
    collect(
      provider.sendQuery('p', s.root, undefined, {
        model: 'gpt-6-sol',
        env: { SA_POLICY_PATH: s.policyPath },
        nodeConfig: { nodeId: 'review-m1-r1' },
      })
    )
  );
  expect(calls.map(o => o.model)).toEqual(['gpt-6-astra']);
  expect(String(calls[0].nodeConfig?.effort)).toBe(s.tiers.policy.effort.G2_reviewer.R1);
  // A later acceptance cannot lower cumulative risk relative to the gate's evidence.
  writeFileSync(join(s.artifacts, 'diff-m1-r2.json'), JSON.stringify({ risk: 'G0' }));
  await inRuntime(s.root, () =>
    collect(
      provider.sendQuery('p', s.root, undefined, {
        model: 'gpt-6-sol',
        env: { SA_POLICY_PATH: s.policyPath },
        nodeConfig: { nodeId: 'review-m1-r2' },
      })
    )
  );
  expect(calls.at(-1)?.model).toBe('gpt-6-astra');
  expect(String(calls.at(-1)?.nodeConfig?.effort)).toBe(s.tiers.policy.effort.G2_reviewer.R2);
});

test('reviewer-alt carry excludes actual authors within the admitted vendor and refuses a vendor change', async () => {
  const s = runtimeFixture(),
    calls: SendQueryOptions[] = [];
  s.plan.console = 'codex';
  s.plan.packages[0].risk = 'G0';
  writeFileSync(join(s.root, 'plan.json'), JSON.stringify(s.plan));
  writeFileSync(join(s.artifacts, 'diff-m1-r1.json'), JSON.stringify({ risk: 'G0' }));
  writePolicyAttempts(s.artifacts, [
    {
      id: 'author',
      node: 'code-core',
      provider: 'codex',
      model: 'gpt-6-sol',
      status: 'completed',
      tokens: { input: 10, output: 0 },
    },
  ]);
  const priorRoot = tmp(),
    priorArtifacts = join(priorRoot, 'artifacts/runs/prior');
  mkdirSync(priorArtifacts, { recursive: true });
  writePolicyAttempts(priorArtifacts, readPolicyAttempts(s.artifacts));
  writePolicyAttempts(s.artifacts, []);
  const db = new Database(join(s.root, 'archon.db'));
  db.run('UPDATE remote_agent_workflow_runs SET adopted_from_run_id=? WHERE id=?', [
    'prior',
    'run',
  ]);
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, ?)', [
    'prior',
    priorRoot,
    'completed',
    priorRoot,
    '{}',
    'repo',
    null,
  ]);
  db.close();
  const native = fake(options => {
    calls.push(options);
    return success;
  });
  const provider = wrapPolicyProvider(native, 'codex');
  const options = {
    model: 'gpt-6-sol',
    env: { SA_POLICY_PATH: s.policyPath },
    nodeConfig: { nodeId: 'review-m1-r1' },
  };
  await inRuntime(s.root, () => collect(provider.sendQuery('p', s.root, undefined, options)));
  expect(calls.map(o => o.model)).toEqual(['gpt-6-astra']);
  calls.length = 0;
  writePolicyAttempts(s.artifacts, [
    ...readPolicyAttempts(s.artifacts),
    ...s.tiers.routing.reviewer.by_console.claude
      .filter(m => m.startsWith('claude'))
      .map(model => ({
        id: model,
        node: 'repair-core',
        provider: 'claude' as const,
        model,
        resolved: model,
        status: 'completed' as const,
        tokens: { input: 10, output: 0 },
      })),
  ]);
  const claude = wrapPolicyProvider(
    fake(() => {
      throw new Error('ineligible vendor must not call');
    }),
    'claude'
  );
  writeFileSync(join(s.artifacts, 'diff-m1-r1.json'), JSON.stringify({ risk: 'G2' }));
  s.plan.console = 'claude';
  writeFileSync(join(s.root, 'plan.json'), JSON.stringify(s.plan));
  const out = await inRuntime(s.root, () =>
    collect(claude.sendQuery('p', s.root, undefined, { ...options, model: 'claude-opus-5' }))
  );
  expect(out.at(-2)).toMatchObject({ isError: true, failure: { class: 'misconfigured' } });
  expect(calls).toEqual([]);
});

test('advisory threshold key reaches its consumer and produces only an advisory', () => {
  const { roleLimit, advise } = createRequire(import.meta.url)('../hooks/context-advisory.cjs') as {
    roleLimit(role: string, policy: unknown): number;
    advise(
      input: unknown,
      tokens: number,
      prior: unknown,
      active: boolean,
      threshold: number
    ): { messages: string[] };
  };
  expect(roleLimit('general', { context: { advisory_tokens: { general: 123 } } })).toBe(123);
  expect(
    advise({ hook_event_name: 'UserPromptSubmit' }, 124, {}, false, 123).messages[0]
  ).toContain('advisory');
  expect(loadTiers().policy.context.advisory_tokens.general).toBe(240000);
});

test('BYPASS_CAPACITY exhausted observation thresholds allow fallback and preserve receipts', async () => {
  const s = setup(
    {
      type: 'result',
      isError: true,
      failure: { class: 'quota_exhausted', evidence: 'typed' },
      tokens: { input: 8, output: 2 },
    },
    { launches: 0, weighted_tokens: 0 }
  );
  const out = await collect(executePolicy(s.execution, 'p', '/scratch'));
  expect(s.calls).toHaveLength(2);
  expect(out.at(-2)).toEqual({ ...success, tokens: { input: 13, output: 7 } });
  expect(out).toContainEqual(
    expect.objectContaining({ type: 'warning', code: 'superagent.budget_observed' })
  );
  const attempts = readPolicyAttempts(s.artifacts);
  expect(attempts[1].status).toBe('completed');
  expect(budgetUsage([], 20, attempts)).toMatchObject({ launches: 2, weighted_tokens: 20 });
});
test('BYPASS_CAPACITY generic Archon dispatch observes exhausted budgets', async () => {
  const s = setup(success, { launches: 0, weighted_tokens: 0 });
  const out = await collect(
    dispatchPolicy(
      { ...s.execution, usage: attempts => budgetUsage([], 20, attempts) },
      'p',
      '/scratch'
    )
  );
  expect(s.calls).toHaveLength(1);
  expect(out.at(-2)).toEqual(success);
  expect(out).toContainEqual(
    expect.objectContaining({ type: 'warning', code: 'superagent.budget_observed' })
  );
});

test('VENDOR_FAILOVER runtime coder retains native role config on Claude dispatch', async () => {
  const s = runtimeFixture();
  s.tiers.routing.coder.models = pool.map(c => c.model);
  writeFileSync(s.policyPath, JSON.stringify(snapshotPolicy(s.tiers)));
  const calls: SendQueryOptions[] = [];
  const native = fake(() => ({
    type: 'result',
    isError: true,
    failure: { class: 'overloaded', evidence: 'typed' },
  }));
  const provider = wrapPolicyProvider(native, 'codex', candidate => {
    expect(candidate.provider).toBe('claude');
    return fake((options, session) => {
      expect(session).toBeUndefined();
      calls.push(options);
      return success;
    }).sendQuery;
  });
  const chunks = await inRuntime(s.root, () =>
    collect(
      provider.sendQuery('p', s.root, 'original', {
        model: pool[0].model,
        env: { SA_POLICY_PATH: s.policyPath },
        nodeConfig: { nodeId: 'code-core' },
      })
    )
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].nodeConfig?.denied_tools).toEqual(
    expect.arrayContaining(s.tiers.policy.exec_profiles.coder.claude.denied_tools)
  );
  expect(chunks.some(c => c.type === 'warning' && c.code === 'superagent.vendor_failover')).toBe(
    true
  );
});
