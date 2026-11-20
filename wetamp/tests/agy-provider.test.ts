import { expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { providerChunkSchema } from '../../packages/provider-contract/src';
import { createAgyProvider } from '../src/agy-provider';
import { tmp } from './helpers';

const fixtures = join(import.meta.dir, 'fixtures/agy');
const model = 'gemini-4-neon-%78high';
const managed = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard' }] }] };

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
  const env = { HOME: home, FIXTURE_STREAM: output, FIXTURE_RUN: 'node-env', FIXTURE_EXIT: '0' };
  return { home, cwd, env, output, executable, hooksPath };
}

test('工具拒绝后进程退出 0 且报告 SUCCESS，仍结算失败', async () => {
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
  expect(chunks[2]).toMatchObject({ isError: true, failure: { class: 'unknown' } });
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
      tokens: { input: 10418, output: 589, cacheRead: 8113, total: 11007 },
    },
    { type: 'settled' },
  ]);
});

test('没有输出、空回执、非成功状态、坏行、非零退出均结算为失败', async () => {
  const f = fixture();
  const provider = createAgyProvider({ executable: f.executable, hooksPath: f.hooksPath });
  const success = readFileSync(f.output, 'utf8');
  const cases = [
    ['', '0', '未收到结果'],
    ['{"event":"result","result":{"status":"SUCCESS","response":" "}}', '0', '未产生输出'],
    ['{"event":"result","result":{"status":"ERROR","response":"partial"}}', '0', 'ERROR'],
    ['{\n' + success, '0', '无效事件'],
    [success, '7', '7'],
  ] as const;
  for (const [output, exit, evidence] of cases) {
    writeFileSync(f.output, output);
    const chunks = await collect(
      provider.sendQuery('检查', f.cwd, undefined, {
        model,
        env: { ...f.env, FIXTURE_EXIT: exit },
      })
    );
    expect(chunks.at(-2)).toMatchObject({
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
    failure: { class: 'misconfigured', evidence: '无法启动 agy' },
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
