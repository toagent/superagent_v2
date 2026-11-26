import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { terminateTree } from '@archon/paths/plugin-process';
import {
  buildProviderSubprocessEnv,
  toolCallSchema,
  truncateToolOutput,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  type ResultChunk,
} from '../../packages/provider-contract/src';
import { agyGuardCommand, agyGuardPath } from './install-hooks';

// prettier-ignore
export const agyCapabilities: ProviderCapabilities = {
  backgroundWork: 'unobserved', sessionResume: false, containerExec: false,
  mcp: false, hooks: true, skills: false, plugins: false, agents: false, nativeTools: false,
  toolRestrictions: false, envInjection: true, sandbox: false, settingSources: false,
  costControl: false, costReporting: false, tokenReporting: true, resolvedModelReporting: true,
  turnCountReporting: true, effortControl: false, fallbackModel: false,
  structuredOutput: 'enforced', requiresAllPropertiesRequired: false,
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const allowsNull = (schema: Record<string, unknown>): boolean =>
  (Array.isArray(schema.type) && schema.type.includes('null')) ||
  (Array.isArray(schema.enum) && schema.enum.includes(null));
const withoutNull = (values: unknown, nil: unknown): unknown[] | undefined =>
  Array.isArray(values) ? values.filter(value => value !== nil) : undefined;

function translateSchema(schema?: Record<string, unknown>): void {
  if (!schema) return;
  translateSchema(object(schema.items));
  const properties = object(schema.properties) ?? {};
  for (const [key, rawField] of Object.entries(properties)) {
    const field = object(rawField);
    if (field && allowsNull(field)) {
      const types = withoutNull(field.type, 'null');
      const choices = withoutNull(field.enum, null);
      if (types) field.type = types.length === 1 ? types[0] : types;
      if (choices) field.enum = choices;
      if (field.type === 'null' || types?.length === 0 || choices?.length === 0)
        Reflect.deleteProperty(properties, key);
      if (Array.isArray(schema.required))
        schema.required = schema.required.filter(name => name !== key);
    }
    translateSchema(field);
  }
}

function restoreNulls(value: unknown, schema?: Record<string, unknown>): void {
  if (!schema) return;
  if (Array.isArray(value)) for (const item of value) restoreNulls(item, object(schema.items));
  const target = object(value);
  if (!target) return;
  const missing = { value: null, enumerable: true, writable: true, configurable: true };
  for (const [key, rawField] of Object.entries(object(schema.properties) ?? {})) {
    const field = object(rawField);
    if (Object.hasOwn(target, key)) restoreNulls(target[key], field);
    else if (field && allowsNull(field)) Object.defineProperty(target, key, missing);
  }
}

function hasManagedHook(path: string, env: NodeJS.ProcessEnv, home: string): boolean {
  try {
    // 已安装的 hook 路径可能属于控制端检出，执行器则在固定版本快照中运行。
    const stateHome = env.XDG_STATE_HOME === '' ? undefined : env.XDG_STATE_HOME;
    const ledger = join(stateHome ?? join(home, '.local/state'), 'superagent/install.json');
    let wetamp: string | undefined;
    try {
      const installed = object(JSON.parse(readFileSync(ledger, 'utf8')));
      wetamp = string(installed?.wetamp);
      if (installed?.installer !== 'superagent_v2' || !wetamp || !isAbsolute(wetamp)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (!statSync(agyGuardPath(wetamp), { throwIfNoEntry: false })?.isFile()) return false;
    const expected = agyGuardCommand(wetamp);
    const group = object(object(JSON.parse(readFileSync(path, 'utf8')))?.superagent);
    const entries = group?.PreToolUse;
    if (group?.enabled !== undefined && group.enabled !== true) return false;
    if (!Array.isArray(entries)) return false;
    return entries.some(entry => {
      const match = object(entry);
      if (match?.matcher !== '*' || !Array.isArray(match.hooks)) return false;
      return match.hooks.some(handler => {
        const hook = object(handler);
        return hook?.type === 'command' && hook.command === expected;
      });
    });
  } catch {
    return false;
  }
}

function failure(
  classification: NonNullable<ResultChunk['failure']>['class'],
  evidence: string,
  retries?: number
): ResultChunk {
  return {
    type: 'result',
    isError: true,
    failure: { class: classification, evidence, ...(retries === undefined ? {} : { retries }) },
  };
}

function usage(value: unknown): ResultChunk['tokens'] {
  const reported = object(value);
  const input = count(reported?.input_tokens);
  const output = count(reported?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  // agy 的 input_tokens 不含缓存读取，契约 input 则是总输入。
  const cacheRead = count(reported?.cache_read_tokens);
  const total = count(reported?.total_tokens);
  return {
    input: input + (cacheRead ?? 0),
    output,
    cacheRead,
    ...(total === undefined ? {} : { total: total + (cacheRead ?? 0) }),
  };
}

const ACCOUNT_EXHAUSTED = /No available Gemini accounts|no available accounts|RESOURCE_EXHAUSTED/i;
const GATEWAY_REFUSED = /ECONNREFUSED|connection refused/i;

function agyResult(
  body: Record<string, unknown>,
  model: string | undefined,
  sawTool: boolean,
  errorSteps: number,
  errorStatus?: string
): ResultChunk {
  const text = string(body.response);
  const structuredOutput = body.structured_output;
  const result: ResultChunk = {
    type: 'result',
    sessionId: string(body.conversation_id),
    tokens: usage(body.usage),
    numTurns: count(body.num_turns),
    resolvedModel: model ? { id: model } : undefined,
  };
  if (body.status !== 'SUCCESS') {
    const status = ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'].find(
      status => status === body.status
    );
    const reported = object(body.usage);
    const detail = string(body.error) ?? '';
    const unserved =
      status &&
      !sawTool &&
      reported &&
      ['input', 'output', 'thinking', 'cache_read', 'total'].every(field => {
        const tokens = reported[`${field}_tokens`];
        return tokens === undefined || tokens === 0;
      });
    const exhausted = errorStatus === 'RESOURCE_EXHAUSTED' || ACCOUNT_EXHAUSTED.test(detail);
    const refused = errorStatus === 'UNAVAILABLE' || GATEWAY_REFUSED.test(detail);
    const classification: NonNullable<ResultChunk['failure']>['class'] = sawTool
      ? 'unknown'
      : exhausted
        ? 'quota_exhausted'
        : unserved || (status === 'ERROR' && refused)
          ? 'transient'
          : 'unknown';
    return {
      ...result,
      ...failure(
        classification,
        `agy 结果状态 ${status ?? '未知'}`,
        !sawTool &&
          status === 'ERROR' &&
          (unserved || body.usage === undefined || exhausted || refused) &&
          errorSteps > 0
          ? errorSteps
          : undefined
      ),
    };
  }
  if (!text?.trim() && structuredOutput == null)
    return {
      ...result,
      ...failure(
        sawTool ? 'unknown' : 'transient',
        `agy 未产生输出${sawTool ? '（已有工具活动）' : ''}`
      ),
    };
  return { ...result, text, structuredOutput };
}

export const agyInput = (prompt: string): string =>
  `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;

export async function* runAgy(
  executable: string,
  args: string[],
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: Parameters<IAgentProvider['sendQuery']>[3],
  job?: {
    spawned: (pid: number) => void;
    init?: (id: string, model: string) => void;
  }
): AsyncGenerator<MessageChunk> {
  const signal = options?.abortSignal;
  signal?.throwIfAborted();
  const secrets = collectCredentialValues(env, options?.protectedEnvKeys);
  const redact = (text: string) => redactCredentialValues(text, secrets);
  let child;
  try {
    child = Bun.spawn([executable, ...args], {
      cwd,
      env,
      detached: true,
      stdin: new Blob([agyInput(prompt)]),
      stderr: 'pipe',
    });
  } catch {
    yield failure('misconfigured', '无法启动 agy');
    yield { type: 'settled' };
    return;
  }
  const lines = createInterface({ input: Readable.from(child.stdout), crlfDelay: Infinity });
  const diagnostics = createInterface({ input: Readable.from(child.stderr), crlfDelay: Infinity });
  const diag: { errorId?: string; status?: string; gatewayRefused: boolean } = {
    gatewayRefused: false,
  };
  const readDiagnostics = (async () => {
    for await (const line of diagnostics) {
      if (GATEWAY_REFUSED.test(line)) diag.gatewayRefused = true;
      if (!line.startsWith('AGY_ERROR: ')) continue;
      try {
        const parsed = object(JSON.parse(line.slice('AGY_ERROR: '.length)));
        diag.errorId = string(parsed?.error_id) ?? diag.errorId;
        diag.status = string(parsed?.status) ?? diag.status;
      } catch {
        // stderr 只补充诊断，分类由 stdout 事件和退出状态决定。
      }
    }
  })().catch(() => undefined);
  let finished = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= terminateTree(child.pid);
    // 信号回调与迭代器分离，由 finally 等待进程组终止。
    void stopping.catch(() => undefined);
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const text = new Map<number, string>();
  const tools = new Map<number, 'active' | 'done'>();
  const failedTools = new Set<string>();
  const errorSteps = new Set<number>();
  let sawTool = false;
  let model: string | undefined;
  let terminal: Record<string, unknown> | undefined;
  let invalid = false;
  let sawEvent = false;
  let result: ResultChunk;
  try {
    job?.spawned(child.pid);
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      let event;
      try {
        event = object(
          JSON.parse(line, (_key, value: unknown) => {
            if (typeof value === 'string') return redact(value);
            const record = object(value);
            if (!record) return value;
            return Object.fromEntries(
              Object.entries(record).map(([key, field]) => [redact(key), field])
            );
          })
        );
      } catch {
        invalid = true;
        continue;
      }
      const body = typeof event?.event === 'string' ? object(event[event.event]) : undefined;
      if (!body || terminal) {
        invalid = true;
        continue;
      }
      sawEvent = true;
      if (event?.event === 'init') {
        model = string(body.model);
        job?.init?.(string(event.conversation_id) ?? '', model ?? '');
      }
      if (event?.event === 'result') terminal = body;
      if (event?.event !== 'step_update') continue;
      sawTool ||= body.step_type === 'tool';
      const index = count(body.step_index);
      if (index === undefined) continue;
      if (body.step_type === 'error_message' && body.state === 'DONE') errorSteps.add(index);
      if (body.step_type === 'agent_response') {
        const block = (text.get(index) ?? '') + (string(body.text_delta) ?? '');
        if (body.state === 'ACTIVE') text.set(index, block);
        else {
          text.delete(index);
          if (block) yield { type: 'agent_message_chunk', text: redact(block) };
        }
      }
      if (body.step_type !== 'tool' || tools.get(index) === 'done') continue;
      const active = body.state === 'ACTIVE';
      const info = object(body.tool_info);
      const toolCallId = String(index);
      if (!tools.has(index) && (!active || info?.parameters !== undefined)) {
        const parsed = toolCallSchema.safeParse({
          type: 'tool_call',
          toolCallId,
          name: string(info?.name) ?? string(body.tool_name),
          rawInput: info?.parameters,
        });
        if (parsed.success) {
          tools.set(index, 'active');
          yield parsed.data;
        }
      }
      if (active) continue;
      // agy 把 hook 拒绝也报告为普通 TOOL_ERROR，且可能以 SUCCESS 退出。
      const failed = body.state !== 'DONE' || info?.error != null;
      if (failed) failedTools.add(toolCallId);
      if (tools.get(index) !== 'active') continue;
      tools.set(index, 'done');
      const value = info?.output ?? object(info?.error)?.message;
      const output =
        value === undefined ? {} : truncateToolOutput(string(value) ?? JSON.stringify(value));
      yield {
        type: 'tool_call_update',
        toolCallId,
        status: failed ? 'failed' : 'completed',
        ...output,
      };
    }
    const code = await child.exited;
    finished = true;
    await readDiagnostics;
    signal?.throwIfAborted();
    const abnormalExit = code !== 0 || child.signalCode;
    const incomplete = (evidence: string): ResultChunk =>
      failure(
        sawTool ? 'unknown' : 'transient',
        `${evidence}${sawTool ? '，已有工具活动' : ''}`,
        !sawTool && errorSteps.size > 0 ? errorSteps.size : undefined
      );
    result = terminal
      ? agyResult(terminal, model, sawTool, errorSteps.size, diag.status)
      : incomplete('agy 未收到结果');
    // 缺少结构化用量的旧回执沿用退出码规则，已观察到工具步骤则保留终态分类。
    if (invalid && !sawEvent) Object.assign(result, failure('unknown', 'agy 输出无效事件'));
    else if (
      abnormalExit &&
      (!terminal || terminal.status === 'SUCCESS' || (!sawTool && terminal.usage === undefined))
    ) {
      const prior = result.failure;
      const exit = `agy 进程异常退出（${String(child.signalCode ?? code)}）`;
      const exitClass: NonNullable<ResultChunk['failure']>['class'] =
        sawTool || terminal?.status === 'SUCCESS'
          ? 'unknown'
          : prior?.class === 'quota_exhausted'
            ? 'quota_exhausted'
            : 'transient';
      result.isError = true;
      result.failure = {
        ...prior,
        class: exitClass,
        evidence: [
          exit,
          terminal ? prior?.evidence : undefined,
          sawTool ? '已有工具活动' : undefined,
        ]
          .filter(Boolean)
          .join('，'),
      };
    } else if (invalid && terminal) Object.assign(result, failure('unknown', 'agy 输出无效事件'));
    else if (!result.isError && [...tools.values()].includes('active'))
      Object.assign(result, failure('unknown', 'agy 工具步骤失败或未完成'));
  } finally {
    signal?.removeEventListener('abort', stop);
    lines.close();
    if (!finished) stop();
    await stopping;
    await child.exited;
    await readDiagnostics;
  }
  const detail = string(terminal?.error)?.trim();
  if (result.failure && diag.errorId)
    result.failure.evidence += `（error_id: ${redact(diag.errorId).slice(0, 128)}）`;
  if (result.failure && detail) result.failure.evidence += `：${detail.slice(0, 1000)}`;
  for (const [index, state] of tools)
    if (state === 'active')
      yield { type: 'tool_call_update', toolCallId: String(index), status: 'cancelled' };
  if (!result.isError) {
    restoreNulls(result.structuredOutput, object(options?.outputFormat?.schema));
    if (failedTools.size)
      yield {
        type: 'warning',
        code: 'superagent.agy_tool_failure',
        message: JSON.stringify({ toolCallIds: [...failedTools] }),
      };
  }
  yield result.isError ? { ...result, text: undefined, structuredOutput: undefined } : result;
  yield { type: 'settled' };
}

export function agyLaunch(
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: {
    executable?: string;
    hooksPath?: string;
  } = {}
) {
  const home = (env.HOME === '' ? undefined : env.HOME) ?? homedir();
  const hooksPath = config.hooksPath ?? join(home, '.gemini/config/hooks.json');
  const executable = Bun.which(config.executable ?? 'agy', { PATH: env.PATH ?? '', cwd });
  const key = env.AGY_LLM_GATEWAY_API_KEY?.trim()
    ? env.AGY_LLM_GATEWAY_API_KEY
    : env.ANTIGRAVITY_API_KEY;
  if (!executable) return { problem: '找不到 agy 可执行文件' } as const;
  if (!env.AGY_LLM_GATEWAY_URL?.trim()) return { problem: 'agy 缺少 AGY_LLM_GATEWAY_URL' } as const;
  if (!key?.trim())
    return { problem: 'agy 缺少 AGY_LLM_GATEWAY_API_KEY 或 ANTIGRAVITY_API_KEY' } as const;
  if (!isAbsolute(hooksPath) || !hasManagedHook(hooksPath, env, home))
    return { problem: 'agy hooks.json 缺少匹配且启用的 superagent PreToolUse 命令' } as const;
  return { executable, env: { ...env, AGY_LLM_GATEWAY_API_KEY: key } } as const;
}

export const agyArgs = (model: string, extra: string[] = []): string[] => [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--model',
  model,
  ...extra,
  '--dangerously-skip-permissions',
];

export function createAgyProvider(
  config: { executable?: string; hooksPath?: string } = {}
): IAgentProvider {
  return {
    getType: () => 'agy',
    getCapabilities: () => agyCapabilities,
    checkCredential: () => Promise.resolve({ state: 'not_checked', source: 'native' }),
    async *sendQuery(prompt, cwd, resume, options) {
      options?.abortSignal?.throwIfAborted();
      const launch = agyLaunch(cwd, buildProviderSubprocessEnv(options), config);
      const model = options?.model;
      const problem =
        launch.problem ??
        (resume !== undefined || options?.execContext?.kind === 'container'
          ? 'agy 仅支持主机上的新会话'
          : undefined);
      if (!launch.executable || problem || !model?.trim()) {
        yield failure('misconfigured', problem ?? 'agy 缺少模型标识');
        yield { type: 'settled' };
        return;
      }
      const extra: string[] = [];
      if (options?.outputFormat) {
        const schema: unknown = JSON.parse(JSON.stringify(options.outputFormat.schema));
        translateSchema(object(schema));
        extra.push('--json-schema', JSON.stringify(schema));
      }
      yield* runAgy(launch.executable, agyArgs(model, extra), prompt, cwd, launch.env, options);
    },
  };
}
