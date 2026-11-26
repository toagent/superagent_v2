import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getRegistration } from '@archon/providers';
import { executePolicy } from '@archon/workflows/policy-dispatch';
import { providerChunkSchema } from '../../packages/provider-contract/src';
import { createAgyProvider } from '../src/agy-provider';
import { readAgyHealth, readClaudeHealth } from '../src/claude-health';
import { loadTiers, snapshotPolicy } from '../src/config';
import { executionTable } from '../src/execution';
import { agyGuardCommand, agyGuardPath } from '../src/install-hooks';
import { installPolicyExecutor, wrapPolicyProvider } from '../src/policy-executor';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import { readAuthorEvidence } from '../templates/.archon/scripts/sa-check';
import { loadPlan } from '../src/plan';
import { fixturePlan, gitRepo, hookFixtureEnv, tmp } from './helpers';

const fixtures = join(import.meta.dir, 'fixtures/agy');
const model = 'gemini-4-neon-%78high';
const managed = {
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: agyGuardCommand() }] }],
};

function fixture() {
  const home = tmp();
  const cwd = join(home, 'work');
  const executable = join(home, 'agy');
  const hooksPath = join(home, '.gemini/config/hooks.json');
  const output = join(home, 'stdout');
  mkdirSync(cwd);
  copyFileSync(join(fixtures, 'worker.sh'), executable);
  chmodSync(executable, 0o700);
  copyFileSync(join(fixtures, 'success.ndjson'), output);
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify({ superagent: managed }));
  const env = {
    ...hookFixtureEnv(home),
    XDG_STATE_HOME: home,
    AGY_LLM_GATEWAY_URL: 'https://example.invalid',
    AGY_LLM_GATEWAY_API_KEY: 'fixture-gateway-key',
    FIXTURE_STREAM: output,
    FIXTURE_RUN: 'node-env',
    FIXTURE_EXIT: '0',
  };
  return { home, cwd, env, output, executable, hooksPath };
}

test('工具拒绝后进程退出 0 且报告 SUCCESS，结算成功并保留失败事件', async () => {
  const f = fixture();
  copyFileSync(join(fixtures, 'denied.ndjson'), f.output);
  const chunks = await collect(
    createAgyProvider({ executable: f.executable }).sendQuery('检查', f.cwd, undefined, {
      model,
      env: f.env,
    })
  );
  expect(chunks.map(chunk => chunk.type)).toEqual([
    'tool_call',
    'tool_call_update',
    'warning',
    'result',
    'settled',
  ]);
  expect(chunks[1]).toMatchObject({ status: 'failed', toolCallId: '2' });
  expect(chunks[2]).toEqual({
    type: 'warning',
    code: 'superagent.agy_tool_failure',
    message: JSON.stringify({ toolCallIds: ['2'] }),
  });
  expect(chunks[3]).toMatchObject({ type: 'result', text: 'OK' });
  expect(chunks[3]).not.toHaveProperty('isError');
});

async function collect(stream: ReturnType<ReturnType<typeof createAgyProvider>['sendQuery']>) {
  return (await Array.fromAsync(stream)).map(chunk => providerChunkSchema.parse(chunk));
}

test('回放事件，校验工作目录、环境、原始模型标识和结构化参数', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const chunks = await collect(
    provider.sendQuery('检查', f.cwd, undefined, {
      model,
      env: f.env,
      outputFormat: { type: 'json_schema', schema },
    })
  );
  expect(provider.getType()).toBe('agy');
  expect(readFileSync(join(f.home, 'args'), 'utf8').trimEnd().split('\n')).toEqual([
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--json-schema',
    JSON.stringify(schema),
    '--dangerously-skip-permissions',
  ]);
  expect(JSON.parse(readFileSync(join(f.home, 'stdin'), 'utf8'))).toEqual({
    event: 'user',
    message: { role: 'user', content: '检查' },
  });
  expect(readFileSync(join(f.home, 'cwd'), 'utf8').trim()).toBe(f.cwd);
  expect(readFileSync(join(f.home, 'env'), 'utf8')).toBe('node-env');
  expect(chunks).toEqual([
    { type: 'agent_message_chunk', text: '正在检查。' },
    {
      type: 'tool_call',
      toolCallId: '4',
      name: 'run_command',
      rawInput: { CommandLine: 'echo hello_headless_demo' },
    },
    {
      type: 'tool_call_update',
      toolCallId: '4',
      status: 'completed',
      output: 'hello_headless_demo\r\n',
    },
    {
      type: 'result',
      sessionId: 'fixture-session',
      text: '{"ok":true}',
      structuredOutput: { ok: true },
      numTurns: 1,
      resolvedModel: { id: 'gemini-4-neon-xhigh' },
      tokens: { input: 18531, output: 589, cacheRead: 8113, total: 19120 },
    },
    { type: 'settled' },
  ]);
});

test('高缓存命中按总输入计量，未报告的总量保持缺失', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable });
  const options = { model, env: f.env };
  const counts = { input_tokens: 297640, output_tokens: 65506, cache_read_tokens: 5726105 };
  for (const total of [363146, undefined]) {
    const result = { status: 'SUCCESS', response: 'OK', usage: { ...counts, total_tokens: total } };
    writeFileSync(f.output, JSON.stringify({ event: 'result', result }));
    const chunks = await collect(provider.sendQuery('检查', f.cwd, undefined, options));
    const tokens = { input: 6023745, output: 65506, cacheRead: 5726105 };
    const expected = total === undefined ? tokens : { ...tokens, total: 6089251 };
    expect(chunks.find(chunk => chunk.type === 'result')?.tokens).toEqual(expected);
  }
});

test('递归翻译可空属性并还原省略值', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable });
  const row = { type: 'object', required: ['label'] };
  const schema = {
    type: 'object',
    required: ['reason', 'rows'],
    properties: {
      reason: { type: ['string', 'null'], enum: ['failed', null] },
      rows: { type: 'array', items: { ...row, properties: { label: { enum: ['ok', null] } } } },
    },
  };
  const rows = [{}, { label: 'ok' }, { label: null }];
  const result = { status: 'SUCCESS', structured_output: { rows } };
  writeFileSync(f.output, JSON.stringify({ event: 'result', result }));
  const outputFormat = { type: 'json_schema' as const, schema };
  const options = { model, env: f.env, outputFormat };
  const chunks = await collect(provider.sendQuery('检查', f.cwd, undefined, options));
  const args = readFileSync(join(f.home, 'args'), 'utf8').split('\n');
  const translated = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  expect(translated.required).toEqual(['rows']);
  expect(translated.properties.reason).toEqual({ type: 'string', enum: ['failed'] });
  expect(translated.properties.rows.items.required).toEqual([]);
  expect(translated.properties.rows.items.properties.label.enum).toEqual(['ok']);
  const structuredOutput = { reason: null, rows: [{ label: null }, ...rows.slice(1)] };
  expect(chunks.at(-2)).toMatchObject({ structuredOutput });
});

test('没有输出、空回执、非成功状态、坏行、非零退出或工具未完成均结算为失败', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable, hooksPath: f.hooksPath });
  const success = readFileSync(f.output, 'utf8');
  const error = `schema rejected ${f.env.AGY_LLM_GATEWAY_API_KEY} ${'x'.repeat(2000)}`;
  const failed = JSON.stringify({ event: 'result', result: { status: 'ERROR', error } });
  const [active, , terminal] = readFileSync(join(fixtures, 'denied.ndjson'), 'utf8').split('\n');
  const cases = [
    ['', '0', '未收到结果'],
    ['{', '0', '无效事件'],
    ['{', '3', '无效事件'],
    ['{"event":"result","result":{"status":"SUCCESS","response":" "}}', '0', '未产生输出'],
    [failed, '0', 'ERROR'],
    [failed, '3', '3'],
    ['{\n' + success, '0', '无效事件'],
    [success, '7', '7'],
    [`${active}\n${terminal}`, '0', 'agy 工具步骤失败或未完成'],
  ] as const;
  for (const [output, exit, evidence] of cases) {
    writeFileSync(f.output, output);
    const chunks = await collect(
      provider.sendQuery('检查', f.cwd, undefined, {
        model,
        env: { ...f.env, FIXTURE_EXIT: exit },
      })
    );
    const result = chunks.at(-2);
    if (output === '{') expect(result).toMatchObject({ failure: { class: 'unknown' } });
    if (output === failed && result?.type === 'result') {
      const detail = `schema rejected [REDACTED] ${'x'.repeat(2000)}`.slice(0, 1000);
      expect(result.failure?.evidence).toEndWith(detail);
      expect(result.failure?.class).toBe(exit === '0' ? 'unknown' : 'transient');
    }
    expect(result).toMatchObject({
      type: 'result',
      isError: true,
      failure: { class: expect.any(String), evidence: expect.stringContaining(evidence) },
    });
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
  }
  for (const output of ['', active]) {
    writeFileSync(f.output, output);
    const chunks = await collect(
      provider.sendQuery('检查', f.cwd, undefined, {
        model,
        env: { ...f.env, FIXTURE_TERMINATE: '1' },
      })
    );
    expect(chunks.at(-2)).toMatchObject({
      failure: {
        class: output ? 'unknown' : 'transient',
        evidence: expect.stringContaining(output ? '已有工具活动' : 'SIGTERM'),
      },
    });
  }
  const missing = createAgyProvider({ executable: join(f.home, 'missing') });
  expect(
    (await collect(missing.sendQuery('检查', f.cwd, undefined, { model, env: f.env }))).at(-2)
  ).toMatchObject({
    type: 'result',
    failure: { class: 'misconfigured', evidence: '找不到 agy 可执行文件' },
  });
});

// prettier-ignore
test('503 实录报告状态和 error_id，并经真实策略切换到 Codex', async () => {
  const f = fixture(), provider = createAgyProvider({ executable: f.executable });
  const env = { ...f.env, FIXTURE_STREAM: join(fixtures, 'outage.ndjson'), FIXTURE_STDERR: join(fixtures, 'outage.stderr'), FIXTURE_EXIT: '3' };
  const candidates = [{ provider: 'agy', model }, { provider: 'codex', model: 'fixture-codex' }] as const;
  const artifacts = tmp();
  const chunks = await collect(executePolicy({
    node: 'code-core', candidates: [...candidates], artifacts, budget: { weighted_tokens: 0, unlimited_tokens: true },
    usage: () => ({ launches: 0, weighted_tokens: 0, reserve: 0 }), provider: 'agy',
    sendQuery: provider.sendQuery, options: candidate => ({ model: candidate.model, env }),
    sendQueryFor: () => async function* () { yield { type: 'result', text: 'Codex 接手' }; yield { type: 'settled' }; },
    async onSettled(_attempt, failure) {
      if (failure) expect(failure).toMatchObject({ class: 'transient', retries: 9, evidence: expect.stringMatching(/ERROR.*c2bb91fe-4aee-4b6e-a17b-12c6ef224f95-9/) });
      return undefined;
    },
  }, '检查', f.cwd));
  expect(chunks.at(-2)).toMatchObject({ text: 'Codex 接手' });
  expect(readPolicyAttempts(artifacts).map(a => [a.provider, a.failure])).toEqual([['agy', 'transient'], ['codex', undefined]]);

  const legacy = readFileSync(env.FIXTURE_STREAM, 'utf8').trimEnd().split('\n');
  const terminal = JSON.parse(legacy.pop()!);
  delete terminal.result.usage;
  writeFileSync(f.output, [...legacy, JSON.stringify(terminal)].join('\n'));
  const incomplete = await collect(provider.sendQuery('检查', f.cwd, undefined, {
    model, env: { ...env, FIXTURE_STREAM: f.output },
  }));
  expect(incomplete.at(-2)).toMatchObject({
    failure: { class: 'transient', retries: 9, evidence: expect.stringMatching(/异常退出.*ERROR.*c2bb91fe/) },
  });
});

// prettier-ignore
test('非成功终态按用量和原始工具步骤分类', async () => {
  const f = fixture(), provider = createAgyProvider({ executable: f.executable });
  for (const [usage, tool, exit, expected] of [
    [{ thinking_tokens: 1 }, false, '3', 'unknown'],
    [{ cache_read_tokens: 1 }, false, '0', 'unknown'],
    [{ input_tokens: null }, false, '3', 'unknown'],
    [{}, true, '3', 'unknown'],
    [{}, false, '0', 'transient'],
  ] as const) {
    const terminal = JSON.stringify({ event: 'result', result: { status: 'ERROR', usage } });
    const step = '{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE"}}';
    writeFileSync(f.output, tool ? `${step}\n${terminal}` : terminal);
    const chunks = await collect(provider.sendQuery('检查', f.cwd, undefined, { model, env: { ...f.env, FIXTURE_EXIT: exit } }));
    expect(chunks.at(-2)).toMatchObject({ failure: { class: expected } });
  }
});

test('CLI 回显的受保护值在文本和结构化回执中脱敏', async () => {
  const f = fixture();
  const marker = 'fake-fixture-credential';
  writeFileSync(
    f.output,
    [
      {
        event: 'step_update',
        step_update: {
          step_index: 0,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'fake-fixture-',
        },
      },
      {
        event: 'step_update',
        step_update: {
          step_index: 0,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'credential',
        },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: marker, structured_output: { [marker]: marker } },
      },
    ]
      .map(row => JSON.stringify(row))
      .join('\n')
  );
  const chunks = await collect(
    createAgyProvider({ executable: f.executable }).sendQuery('检查', f.cwd, undefined, {
      model,
      env: { ...f.env, FIXTURE_MARKER: marker },
      protectedEnvKeys: ['FIXTURE_MARKER'],
    })
  );
  expect(chunks[0]).toEqual({ type: 'agent_message_chunk', text: '[REDACTED]' });
  expect(chunks[1]).toMatchObject({
    text: '[REDACTED]',
    structuredOutput: { '[REDACTED]': '[REDACTED]' },
  });
  expect(JSON.stringify(chunks)).not.toContain(marker);
});

test('逐次校验受管 PreToolUse，拒绝时未启动进程', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable, hooksPath: f.hooksPath });
  const configs = [
    {},
    { superagent: { ...managed, enabled: false } },
    { superagent: {} },
    { superagent: { PreToolUse: [] } },
    { superagent: { PreToolUse: [{ hooks: [] }] } },
    {
      superagent: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }] },
    },
  ];
  const send = () => collect(provider.sendQuery('检查', f.cwd, undefined, { model, env: f.env }));
  expect((await send()).at(-2)).toMatchObject({ type: 'result', structuredOutput: { ok: true } });
  const missing = createAgyProvider({
    executable: f.executable,
    hooksPath: join(f.home, 'missing.json'),
  });
  const args = join(f.home, 'args');
  const sentinel = 'previous invocation';
  writeFileSync(args, sentinel);
  const refused = async (stream: ReturnType<typeof send>) => {
    expect(await stream).toEqual([
      {
        type: 'result',
        isError: true,
        failure: { class: 'misconfigured', evidence: expect.stringContaining('superagent') },
      },
      { type: 'settled' },
    ]);
    expect(readFileSync(args, 'utf8')).toBe(sentinel);
  };
  await refused(collect(missing.sendQuery('检查', f.cwd, undefined, { model, env: f.env })));
  for (const config of configs) {
    writeFileSync(f.hooksPath, JSON.stringify(config));
    await refused(send());
  }
});

test('agy 启动前区分缺少网关地址或凭据', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable });
  for (const [overrides, evidence] of [
    [{ AGY_LLM_GATEWAY_URL: '' }, '缺少 AGY_LLM_GATEWAY_URL'],
    [{ AGY_LLM_GATEWAY_API_KEY: '', ANTIGRAVITY_API_KEY: '' }, '缺少 AGY_LLM_GATEWAY_API_KEY'],
  ] as const) {
    const chunks = await collect(
      provider.sendQuery('检查', f.cwd, undefined, {
        model,
        env: { ...f.env, ...overrides },
      })
    );
    expect(chunks).toEqual([
      {
        type: 'result',
        isError: true,
        failure: { class: 'misconfigured', evidence: expect.stringContaining(evidence) },
      },
      { type: 'settled' },
    ]);
    expect(existsSync(join(f.home, 'args'))).toBeFalse();
  }
});

test('真实 policy wrapper 从冻结路由派发 agy，失败后用新会话修复', async () => {
  const f = fixture(),
    tiers = loadTiers();
  const plan = loadPlan(
    fixturePlan(f.home, gitRepo(f.home), p => {
      p.mode = 'single:gemini';
    }),
    [f.home]
  );
  const policy = join(f.home, 'policy.json');
  writeFileSync(policy, JSON.stringify(snapshotPolicy(tiers)));
  writeFileSync(join(f.home, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(f.home, 'execution.json'), JSON.stringify(executionTable(plan, tiers)));
  const artifacts = join(f.home, 'artifacts/runs/run');
  mkdirSync(artifacts, { recursive: true });
  const pack = join(artifacts, 'contexts', `repair-${plan.packages[0].id}.md`);
  mkdirSync(dirname(pack));
  writeFileSync(`${pack}.no-skills.md`, 'provider context');
  using db = new Database(join(f.home, 'archon.db'));
  db.exec(`CREATE TABLE remote_agent_workflow_runs (id, working_path, status, output_root, metadata, codebase_id, adopted_from_run_id);
    CREATE TABLE remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, event_order);`);
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, NULL)', [
    'run',
    f.cwd,
    'running',
    f.home,
    JSON.stringify({ execution_owner: { pid: process.pid } }),
    'repo',
  ]);
  const previousHome = process.env.ARCHON_HOME;
  const previousSuperagentHome = process.env.SUPERAGENT_HOME;
  process.env.ARCHON_HOME = f.home;
  process.env.SUPERAGENT_HOME = f.home;
  try {
    installPolicyExecutor();
    const provider = getRegistration('agy').factory();
    const invoke = (role: 'code' | 'repair') =>
      collect(
        provider.sendQuery(pack, f.cwd, undefined, {
          model,
          nodeConfig: { nodeId: `${role}-${plan.packages[0].id}` },
          env: { ...f.env, PATH: `${f.home}:${process.env.PATH ?? ''}`, SA_POLICY_PATH: policy },
        })
      );
    writeFileSync(f.hooksPath, '{}');
    expect((await invoke('code')).at(-2)).toMatchObject({
      failure: { class: 'misconfigured', evidence: expect.stringContaining('PreToolUse') },
    });
    expect(existsSync(join(f.home, 'args'))).toBeFalse();
    const installedRoot = join(f.home, 'installed engine');
    mkdirSync(dirname(agyGuardPath(installedRoot)), { recursive: true });
    copyFileSync(agyGuardPath(), agyGuardPath(installedRoot));
    mkdirSync(join(f.home, 'superagent'));
    writeFileSync(
      join(f.home, 'superagent/install.json'),
      JSON.stringify({ installer: 'superagent_v2', wetamp: installedRoot })
    );
    writeFileSync(
      f.hooksPath,
      JSON.stringify({
        superagent: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: agyGuardCommand(installedRoot) }] },
          ],
        },
      })
    );
    expect((await invoke('repair')).at(-2)).toMatchObject({ structuredOutput: { ok: true } });
    expect(readFileSync(join(f.home, 'args'), 'utf8')).not.toContain(pack);
    expect(JSON.parse(readFileSync(join(f.home, 'stdin'), 'utf8'))).toEqual({
      event: 'user',
      message: { role: 'user', content: `${pack}.no-skills.md` },
    });
    const attempts = readPolicyAttempts(artifacts);
    expect(attempts.map(a => [a.node, a.provider, a.status])).toEqual([
      [`code-${plan.packages[0].id}`, 'agy', 'failed'],
      [`code-${plan.packages[0].id}`, 'agy', 'failed'],
      [`repair-${plan.packages[0].id}`, 'agy', 'completed'],
    ]);
    const authors = readAuthorEvidence(
      { id: 'run', codebase_id: 'repo', events: [], output_root: f.home },
      attempts,
      [plan.packages[0].id],
      'm1',
      6,
      () => {
        throw new Error('unexpected ancestry');
      }
    );
    expect(authors.map(a => [a.model, a.strength])).toEqual([
      [model, 'pinned'],
      ['gemini-4-neon-%68igh', 'pinned'],
      ['gemini-4-neon-xhigh', 'provider'],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    if (previousSuperagentHome === undefined) delete process.env.SUPERAGENT_HOME;
    else process.env.SUPERAGENT_HOME = previousSuperagentHome;
  }
});

test('取消终止进程组内的子进程，预取消不启动', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable });
  const controller = new AbortController();
  const env = { ...f.env, FIXTURE_HANG: '1' };
  const send = (abortSignal: AbortSignal) =>
    provider.sendQuery('检查', f.cwd, undefined, { model, env, abortSignal });
  await expect(collect(send(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' });
  expect(existsSync(join(f.home, 'args'))).toBe(false);
  const stream = send(controller.signal);
  try {
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: 'agent_message_chunk', text: 'ready' },
    });
    const pid = Number(readFileSync(join(f.home, 'child'), 'utf8'));
    expect(process.kill(pid, 0)).toBe(true);
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
    const deadline = performance.now() + 2000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
        break;
      }
      expect(performance.now()).toBeLessThan(deadline);
      await Bun.sleep(20);
    }
  } finally {
    controller.abort();
    await stream.return(undefined);
  }
});

test('显式 Neon 账号耗尽后熔断，冷却后恢复，工作树变更时禁止重放', async () => {
  const f = fixture(),
    tiers = loadTiers(),
    repo = gitRepo(f.home);
  const plan = loadPlan(
    fixturePlan(f.home, repo, p => {
      p.mode = 'single:gemini';
      p.console = 'gemini';
    }),
    [f.home]
  );
  const policy = join(f.home, 'policy.json');
  writeFileSync(policy, JSON.stringify(snapshotPolicy(tiers)));
  writeFileSync(join(f.home, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(f.home, 'execution.json'), JSON.stringify(executionTable(plan, tiers)));
  const artifacts = join(f.home, 'artifacts/runs/run-exhausted');
  mkdirSync(join(artifacts, 'contexts'), { recursive: true });
  const pack = join(artifacts, 'contexts', `code-${plan.packages[0].id}.md`);
  writeFileSync(pack, 'with skills');
  using db = new Database(join(f.home, 'archon.db'));
  db.exec(`CREATE TABLE remote_agent_workflow_runs (id, working_path, status, output_root, metadata, codebase_id, adopted_from_run_id);
    CREATE TABLE remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, event_order);`);
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, NULL)', [
    'run-exhausted',
    repo,
    'running',
    f.home,
    JSON.stringify({ execution_owner: { pid: process.pid } }),
    'repo',
  ]);
  const prevArchon = process.env.ARCHON_HOME,
    prevSa = process.env.SUPERAGENT_HOME;
  process.env.ARCHON_HOME = f.home;
  process.env.SUPERAGENT_HOME = f.home;
  try {
    let codexCalls = 0;
    const wrapped = wrapPolicyProvider(
      createAgyProvider({ executable: f.executable }),
      'agy',
      () =>
        async function* () {
          codexCalls++;
          yield { type: 'result', text: 'Codex 接手' };
          yield { type: 'settled' };
        }
    );
    const runNode = (stream: string, exit = '0') => {
      writeFileSync(f.output, stream);
      return collect(
        wrapped.sendQuery(pack, repo, undefined, {
          model,
          nodeConfig: { nodeId: `code-${plan.packages[0].id}` },
          env: { ...f.env, SA_POLICY_PATH: policy, FIXTURE_EXIT: exit },
        })
      );
    };
    const toolStep =
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE"}}';
    const exhausted =
      '{"event":"result","result":{"status":"ERROR","error":"No available Gemini accounts: no available accounts"}}';
    const chunks = await runNode(`${toolStep}\n${exhausted}`);
    expect(
      chunks.some(c => c.type === 'warning' && c.code === 'superagent.agy_no_skills_missing')
    ).toBeTrue();
    expect(chunks.at(-2)).toMatchObject({
      isError: true,
      failure: {
        class: 'unknown',
        evidence: expect.stringContaining('No available Gemini accounts'),
      },
    });
    expect(codexCalls).toBe(0);
    expect(readAgyHealth().state).toBe('down');
    expect(readPolicyAttempts(artifacts).map(a => a.provider)).toEqual(['agy']);
    expect(readClaudeHealth(Date.now()).state).toBe('up');
    const down = readAgyHealth();
    db.run("UPDATE remote_agent_workflow_runs SET id='run-next'");
    const nextArtifacts = join(f.home, 'artifacts/runs/run-next');
    mkdirSync(nextArtifacts, { recursive: true });
    expect((await runNode(exhausted)).at(-2)).toMatchObject({
      failure: {
        class: 'misconfigured',
        evidence: expect.stringContaining('no eligible agy model'),
      },
    });
    expect(readPolicyAttempts(nextArtifacts)).toEqual([]);
    writeFileSync(
      join(f.home, 'agy-health.json'),
      JSON.stringify({ ...down, next_probe_at: new Date(Date.now() - 1).toISOString() })
    );
    const success = readFileSync(join(fixtures, 'success.ndjson'), 'utf8');
    expect((await runNode(success)).at(-2)).toMatchObject({ structuredOutput: { ok: true } });
    expect(readAgyHealth().state).toBe('up');
    expect(readPolicyAttempts(nextArtifacts).map(a => a.provider)).toEqual(['agy']);
    const refused =
      '{"event":"result","result":{"status":"ERROR","error":"dial tcp 127.0.0.1:1: connect: connection refused"}}';
    expect((await runNode(refused)).at(-2)).toMatchObject({ failure: { class: 'transient' } });
    expect(readAgyHealth().state).toBe('down');
    // 工作树变脏时即使返回 transient 也禁止静默重放
    writeFileSync(
      join(f.home, 'agy-health.json'),
      JSON.stringify({ state: 'up', probe_failures: 0 })
    );
    const dirtyWrapper = wrapPolicyProvider(
      {
        ...createAgyProvider({ executable: f.executable }),
        async *sendQuery(_p, dir) {
          writeFileSync(join(dir, 'dirty.txt'), 'wip');
          yield {
            type: 'result',
            isError: true,
            failure: { class: 'quota_exhausted', evidence: 'No available Gemini accounts' },
          };
          yield { type: 'settled' };
        },
      },
      'agy',
      () =>
        async function* () {
          codexCalls++;
          yield { type: 'result', text: 'bad' };
          yield { type: 'settled' };
        }
    );
    const dirtyChunks = await collect(
      dirtyWrapper.sendQuery(pack, repo, undefined, {
        model,
        nodeConfig: { nodeId: `code-${plan.packages[0].id}` },
        env: { ...f.env, SA_POLICY_PATH: policy },
      })
    );
    expect(dirtyChunks.at(-2)).toMatchObject({
      failure: { class: 'unknown', evidence: expect.stringContaining('工作树已变更') },
    });
    expect(codexCalls).toBe(0);
    expect(readAgyHealth().state).toBe('down');
  } finally {
    if (prevArchon === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = prevArchon;
    if (prevSa === undefined) delete process.env.SUPERAGENT_HOME;
    else process.env.SUPERAGENT_HOME = prevSa;
  }
});

test('异常退出保留 retries 且 SUCCESS 异常退出收窄为 unknown', async () => {
  const f = fixture(),
    provider = createAgyProvider({ executable: f.executable });
  const errSteps = [1, 2, 3]
    .map(i =>
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: i, state: 'DONE', step_type: 'error_message' },
      })
    )
    .join('\n');
  writeFileSync(f.output, errSteps);
  const crashed = await collect(
    provider.sendQuery('检查', f.cwd, undefined, { model, env: { ...f.env, FIXTURE_EXIT: '3' } })
  );
  expect(crashed.at(-2)).toMatchObject({ failure: { class: 'transient', retries: 3 } });
  writeFileSync(
    f.output,
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } })
  );
  const afterSuccess = await collect(
    provider.sendQuery('检查', f.cwd, undefined, { model, env: { ...f.env, FIXTURE_EXIT: '7' } })
  );
  expect(afterSuccess.at(-2)).toMatchObject({
    failure: { class: 'unknown', evidence: expect.stringContaining('7') },
  });
});
