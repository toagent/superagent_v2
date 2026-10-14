import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { clampEffort, isEffortRung } from '@archon/provider-contract';
import type { NodeConfig } from './types';

/** Non-secret policy shared by native CLI and workflow launches. Native homes stay untouched. */
export interface LaunchPolicy {
  effort: string;
  codex: Record<string, unknown>;
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
): Pick<Options, 'effort' | 'permissionMode' | 'allowDangerouslySkipPermissions'> {
  if (!isEffortRung(policy.effort)) throw new Error('execution: unsupported effort');
  return {
    effort: clampEffort(policy.effort, CLAUDE_EFFORTS),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
}

export function workflowLaunchPolicy(
  policy: LaunchPolicy,
  provider: 'claude' | 'codex'
): Pick<NodeConfig, 'effort'> {
  if (!isEffortRung(policy.effort)) throw new Error('execution: unsupported effort');
  if (provider === 'codex')
    return {
      effort: policy.effort,
    };
  const native = claudeLaunchPolicy(policy);
  return {
    effort: native.effort,
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
  _cwd: string
): Promise<string[]> {
  const args = roleCommandArgs(command, provider, model);
  if (provider === 'claude') {
    const native = claudeLaunchPolicy(policy);
    const settings = {};
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
      native.effort ?? policy.effort,
      '--permission-mode',
      native.permissionMode ?? 'default',
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
  const settings = {
    ...policy.codex,
    model_reasoning_effort: policy.effort,
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
  };
  return [command[0], ...codexCliConfig(settings), ...args];
}

/** CLI paths are bare dotted keys; nested table keys are literal capability identifiers. */
export function codexCliConfig(settings: Record<string, unknown>): string[] {
  const literal = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        throw new Error('execution: unsupported Codex config value');
      return Object.is(value, -0) ? '-0.0' : String(value);
    }
    if (Array.isArray(value)) return `[${Array.from(value, literal).join(', ')}]`;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.entries(value)
        .map(([key, child]) => `${JSON.stringify(key)} = ${literal(child)}`)
        .join(', ')}}`;
    throw new Error('execution: unsupported Codex config value');
  };
  return Object.entries(settings).flatMap(([key, value]) => {
    // Codex splits the CLI path on dots without TOML key parsing. Quote IDs in the value instead.
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(key))
      throw new Error('execution: unsupported Codex config path');
    return ['-c', `${key}=${literal(value)}`];
  });
}
