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
import { providerChunkSchema } from '../../packages/provider-contract/src';
import { createAgyProvider } from '../src/agy-provider';
import { loadTiers, snapshotPolicy } from '../src/config';
import { executionTable } from '../src/execution';
import { agyGuardCommand, agyGuardPath } from '../src/install-hooks';
import { installPolicyExecutor } from '../src/policy-executor';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import { readAuthorEvidence } from '../templates/.archon/scripts/sa-check';
import { loadPlan } from '../src/plan';
import { fixturePlan, gitRepo, tmp } from './helpers';

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
    HOME: home,
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
    'result',
    'settled',
  ]);
  expect(chunks[1]).toMatchObject({ status: 'failed', toolCallId: '2' });
  expect(chunks[2]).toMatchObject({ type: 'result', text: 'OK' });
  expect(chunks[2]).not.toHaveProperty('isError');
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
    '--print',
    '检查',
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--json-schema',
    JSON.stringify(schema),
    '--dangerously-skip-permissions',
  ]);
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
  const missing = createAgyProvider({ executable: join(f.home, 'missing') });
  expect(
    (await collect(missing.sendQuery('检查', f.cwd, undefined, { model, env: f.env }))).at(-2)
  ).toMatchObject({
    type: 'result',
    failure: { class: 'misconfigured', evidence: '找不到 agy 可执行文件' },
  });
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
  process.env.ARCHON_HOME = f.home;
  try {
    installPolicyExecutor();
    const provider = getRegistration('agy').factory();
    const invoke = (role: 'code' | 'repair') =>
      collect(
        provider.sendQuery('检查', f.cwd, undefined, {
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
