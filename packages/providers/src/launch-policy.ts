import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { clampEffort, isEffortRung } from '@archon/provider-contract';
import type { NodeConfig } from './types';
import { AppServerConnection } from './codex/app-server';
import { applyNodeScope, readCodexInventory } from './codex/scope';
import { buildClaudePluginSettings, readClaudePluginIds } from './claude/plugins';

/** Non-secret policy shared by native CLI and workflow launches. Native homes stay untouched. */
export interface LaunchPolicy {
  effort: string;
  readonly: boolean;
  deniedTools: string[];
  codex: Record<string, unknown>;
  sandbox?: Options['sandbox'];
}
export const CLAUDE_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly NonNullable<Options['effort']>[];

export function claudeLaunchPolicy(
  policy: LaunchPolicy
): Pick<
  Options,
  'effort' | 'disallowedTools' | 'sandbox' | 'permissionMode' | 'allowDangerouslySkipPermissions'
> {
  if (!isEffortRung(policy.effort)) throw new Error('execution: unsupported effort');
  const sandbox = policy.sandbox;
  if (
    policy.readonly &&
    (!sandbox?.enabled ||
      !sandbox.failIfUnavailable ||
      sandbox.allowUnsandboxedCommands !== false ||
      !sandbox.autoAllowBashIfSandboxed ||
      !sandbox.filesystem?.denyWrite?.includes('/'))
  )
    throw new Error('execution: readonly Claude requires a fail-closed sandbox');
  return {
    effort: clampEffort(policy.effort, CLAUDE_EFFORTS),
    disallowedTools: [
      ...new Set([...policy.deniedTools, ...(policy.readonly ? ['WebFetch', 'WebSearch'] : [])]),
    ],
    ...(sandbox
      ? { sandbox: policy.readonly ? { ...sandbox, network: { allowedDomains: [] } } : sandbox }
      : {}),
    // Sandboxed Bash uses the sandbox authorization path, never the auto safety model.
    permissionMode: policy.readonly ? 'default' : 'bypassPermissions',
    allowDangerouslySkipPermissions: !policy.readonly,
  };
}

export function workflowLaunchPolicy(
  policy: LaunchPolicy,
  provider: 'claude' | 'codex',
  readonlyMcp: string
): Pick<NodeConfig, 'effort' | 'denied_tools' | 'sandbox' | 'mcp'> {
  if (!isEffortRung(policy.effort)) throw new Error('execution: unsupported effort');
  if (provider === 'codex')
    return {
      effort: policy.effort,
      ...(policy.readonly ? { mcp: readonlyMcp } : {}),
    };
  const native = claudeLaunchPolicy(policy);
  return {
    effort: native.effort,
    denied_tools: native.disallowedTools,
    ...(native.sandbox ? { sandbox: native.sandbox } : {}),
  };
}

/** Only presentation/output switches survive. Every capability or policy override fails before spawn. */
export function roleCommandArgs(
  command: string[],
  provider: 'claude' | 'codex',
  model: string
): string[] {
  const args = command.slice(1);
  if (provider === 'codex' && args.shift() !== 'exec')
    throw new Error('job: role Codex requires exec');
  const values = new Set(
    provider === 'codex'
      ? ['-o', '--output-last-message', '--output-schema', '--color']
      : ['--output-format', '--json-schema']
  );
  const switches = new Set(
    provider === 'codex' ? ['--json', '--skip-git-repo-check'] : ['-p', '--print', '--verbose']
  );
  const out: string[] = provider === 'codex' ? ['exec'] : [];
  let models = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      out.push(arg);
      continue;
    }
    if (arg === '--') {
      out.push(...args.slice(i));
      break;
    }
    const [key, inline] = arg.split(/=(.*)/s);
    if (key === '-m' || key === '--model') {
      const value = inline ?? args[++i];
      if (++models > 1 || value !== model)
        throw new Error('job: ambiguous or conflicting model override');
    } else if (values.has(key)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`job: missing ${key} value`);
      out.push(key, value);
    } else if (switches.has(arg)) out.push(arg);
    else throw new Error(`job: unsupported role agent option ${key}`);
  }
  if (provider === 'claude' && !out.some(a => a === '-p' || a === '--print'))
    throw new Error('job: role Claude requires --print');
  return [
    ...out.slice(0, provider === 'codex' ? 1 : 0),
    '--model',
    model,
    ...out.slice(provider === 'codex' ? 1 : 0),
  ];
}

export async function prepareRoleCommand(
  command: string[],
  provider: 'claude' | 'codex',
  model: string,
  policy: LaunchPolicy,
  cwd: string
): Promise<string[]> {
  const args = roleCommandArgs(command, provider, model);
  if (provider === 'claude') {
    const native = claudeLaunchPolicy(policy);
    const ids = await readClaudePluginIds({
      command: command[0],
      args: ['plugin', 'list', '--json'],
      cwd,
      env: process.env,
    });
    const settings = {
      ...buildClaudePluginSettings(ids, []),
      ...(native.sandbox ? { sandbox: native.sandbox } : {}),
    };
    let format: 'text' | 'json' | 'stream-json' = 'text';
    const index = args.indexOf('--output-format');
    if (index !== -1) {
      const declared = args[index + 1];
      if (declared !== 'text' && declared !== 'json' && declared !== 'stream-json')
        throw new Error('job: unsupported Claude output format');
      format = declared;
      args.splice(index, 2);
    }
    const nativeCommand = [
      command[0],
      '--effort',
      native.effort!,
      '--permission-mode',
      native.permissionMode!,
      '--disallowedTools',
      native.disallowedTools!.join(','),
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--settings',
      JSON.stringify(settings),
      '--output-format',
      'stream-json',
      '--verbose',
      ...args,
    ];
    return [
      process.execPath,
      fileURLToPath(new URL('./launch-policy-cli.ts', import.meta.url)),
      format,
      JSON.stringify(nativeCommand),
    ];
  }
  if (!isEffortRung(policy.effort)) throw new Error('execution: unsupported effort');
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  );
  const connection = AppServerConnection.start({ path: command[0], pathDirs: [] }, [], env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const inventory = await Promise.race([
      (async () => {
        await connection.request('initialize', {
          clientInfo: { name: 'superagent-policy', title: null, version: '1' },
          capabilities: null,
        });
        connection.notify('initialized');
        return readCodexInventory(connection, { cwd, plugins: [], codexHome: 'native' });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('job: native inventory timed out')), 30000);
      }),
    ]);
    const { config } = applyNodeScope({ skills: { include_instructions: false } }, inventory, []);
    const settings = {
      ...policy.codex,
      ...config,
      'features.multi_agent': false,
      model_reasoning_effort: policy.effort,
      sandbox_mode: policy.readonly ? 'read-only' : 'danger-full-access',
      approval_policy: 'never',
    };
    return [command[0], ...codexCliConfig(settings), ...args];
  } finally {
    clearTimeout(timer);
    await connection.shutdown(250);
  }
}

/** TOML dotted leaf assignments; JSON objects are not TOML inline tables. */
export function codexCliConfig(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (path: string[], value: unknown): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) visit([...path, key], child);
      return;
    }
    if (
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.some(v => typeof v === 'object'))
    )
      throw new Error('execution: unsupported Codex config value');
    out.push('-c', `${path.map(k => JSON.stringify(k)).join('.')}=${JSON.stringify(value)}`);
  };
  for (const [key, value] of Object.entries(settings)) visit(key.split('.'), value);
  return out;
}
