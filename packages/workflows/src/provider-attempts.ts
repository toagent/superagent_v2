import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderFailureClass } from '@archon/provider-contract';
import type { TokenUsage } from '@archon/provider-contract';

/** One run has one engine owner; its provider wrapper writes before dispatch and after settlement. */
export interface PolicyAttempt {
  id: string;
  node: string;
  provider: 'codex' | 'claude';
  model: string;
  resolved?: string;
  status: 'started' | 'completed' | 'failed';
  tokens?: TokenUsage;
  failure?: ProviderFailureClass;
  cooldown_until?: number;
}
const attemptFile = (artifacts: string): string => join(artifacts, 'policy-attempts.json');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validAttempt(value: unknown): value is PolicyAttempt {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.node !== 'string' ||
    !value.node ||
    typeof value.model !== 'string' ||
    !value.model ||
    !['codex', 'claude'].includes(String(value.provider)) ||
    !['started', 'completed', 'failed'].includes(String(value.status)) ||
    (value.resolved !== undefined && (typeof value.resolved !== 'string' || !value.resolved)) ||
    (value.cooldown_until !== undefined && !amount(value.cooldown_until))
  )
    return false;
  const tokens = value.tokens;
  return (
    tokens === undefined ||
    (record(tokens) &&
      amount(tokens.input) &&
      amount(tokens.output) &&
      (tokens.cacheRead === undefined ||
        (amount(tokens.cacheRead) && tokens.cacheRead <= tokens.input)))
  );
}
export function readPolicyAttempts(artifacts: string): PolicyAttempt[] {
  const file = attemptFile(artifacts);
  if (!existsSync(file)) return [];
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value)) throw new Error('policy-attempts: expected an array');
  if (!value.every(validAttempt)) throw new Error('policy-attempts: invalid attempt record');
  return value;
}
export function writePolicyAttempts(artifacts: string, attempts: PolicyAttempt[]): void {
  const file = attemptFile(artifacts),
    tmp = `${file}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(attempts) + '\n', { flag: 'wx' });
  renameSync(tmp, file);
}
