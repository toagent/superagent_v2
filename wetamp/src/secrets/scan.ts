import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { collectCredentialValues } from '@archon/paths/credential-redaction';

const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`;
const KEY_VALUES: RegExp[] = [
  new RegExp(String.raw`\b(authorization)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:[^"\\\n]|\\.)*)`, 'gi'),
  new RegExp(
    String.raw`\b([\w-]*(?:token|key|secret|password)[\w-]*)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:bearer\s+)?[^\s"',;}]+)`,
    'gi'
  ),
  /\b(bearer)(\s+)[^\s"',;}]+/gi,
];
export const redactKeyValues = (text: string): string =>
  KEY_VALUES.reduce((value, rule) => value.replace(rule, '$1$2***'), text);
const strings = (value: unknown, key = ''): string[] =>
  typeof value === 'string'
    ? /token|key|secret|password/i.test(key)
      ? [value]
      : []
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([name, child]) => strings(child, name))
      : [];
const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
export interface ManagedSecret {
  name: string;
  value: string;
}
// prettier-ignore
export function managedSecrets(env: NodeJS.ProcessEnv = process.env): ManagedSecret[] {
  const home = env.HOME ?? homedir(), names = read(join(home, '.wetamp', 'secrets.list')).split(/\r?\n/).filter(Boolean), values = new Map<string, string>();
  for (const name of names) if (env[name]) values.set(name, env[name]);
  for (const value of collectCredentialValues(env)) values.set('environment', value);
  let configured: string[] = [];
  try { const paths = JSON.parse(read(env.SA_SECRET_PATHS ?? join(home, '.wetamp', 'jail', 'secret-paths.json'))) as { client_auth?: string[] }; configured = (paths.client_auth ?? []).map(file => join(home, file)); } catch { /* absent list */ }
  const auth = env.SA_CLIENT_AUTH_FILES?.split(delimiter).filter(Boolean) ?? configured;
  for (const file of auth) try { for (const value of strings(JSON.parse(read(file)))) values.set('client_auth', value); } catch { /* unreadable auth */ }
  return [...values].filter(([, value]) => value.length >= 8).map(([name, value]) => ({ name, value }));
}
const encodings = (value: string): string[] => {
  const bytes = Buffer.from(value);
  return [
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    encodeURIComponent(value),
  ];
};
// prettier-ignore
export function exactPatterns(secrets = managedSecrets()): ManagedSecret[] {
  const out = new Map<string, string>();
  for (const secret of secrets) { out.set(secret.value, secret.name); for (const raw of [secret.value, `${secret.value}\n`, `${secret.value}\r\n`]) for (const encoded of encodings(raw)) out.set(encoded, secret.name); }
  return [...out].map(([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
}
interface Finding {
  Secret?: string;
  StartLine?: number;
  EndLine?: number;
}
export interface ScanOptions {
  secrets?: ManagedSecret[];
  gitleaks?: boolean;
  config?: string;
}
// prettier-ignore
export const redactGitleaksFindings = (text: string, findings: Finding[]): string => {
  const lines = text.split('\n');
  for (const finding of findings) { const start = Math.max(0, (finding.StartLine ?? 1) - 1), end = Math.min(lines.length - 1, (finding.EndLine ?? finding.StartLine ?? 1) - 1), secret = finding.Secret ?? '';
    if (secret && lines.slice(start, end + 1).some(line => line.includes(secret))) for (let i = start; i <= end; i++) lines[i] = lines[i].replaceAll(secret, '[REDACTED:gitleaks]');
    else for (let i = start; i <= end; i++) lines[i] = '[REDACTED:gitleaks]'; }
  return lines.join('\n');
};
// prettier-ignore
function gitleaks(text: string, config: string): string {
  if (!text) return text;
  const result = spawnSync('gitleaks', ['stdin', '--config', config, '--ignore-gitleaks-allow', '--no-banner', '--report-format', 'json', '--report-path', '-'], { input: text, encoding: 'utf8' });
  if (result.status === 0) return text;
  if (result.status !== 1) throw new Error('scan_failed');
  try { const findings = JSON.parse(result.stdout || '[]') as Finding[]; if (!findings.length) throw new Error('empty report'); return redactGitleaksFindings(text, findings); } catch { throw new Error('scan_failed'); }
}
// prettier-ignore
export function scanText(text: string, options: ScanOptions = {}): string {
  let result = text;
  for (const { name, value } of exactPatterns(options.secrets)) result = result.replaceAll(value, `[REDACTED:${name}]`);
  result = redactKeyValues(result);
  return options.gitleaks === false ? result : gitleaks(result, options.config ?? process.env.SA_GITLEAKS_CONFIG ?? join(homedir(), '.wetamp', 'jail', 'gitleaks.toml'));
}
// prettier-ignore
export function secretsHealth(config: string, home = process.env.HOME ?? homedir()): { ok: boolean; scanned: number } {
  const targets = [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md'), join(home, '.config', 'opencode', 'AGENTS.md'), join(home, '.ai-agent-shared', 'memory')].filter(existsSync);
  for (const target of targets) { const result = spawnSync('gitleaks', ['dir', target, '--config', config, '--ignore-gitleaks-allow', '--no-banner', '--report-format', 'json', '--report-path', '/dev/null'], { encoding: 'utf8' }); if (result.status !== 0) return { ok: false, scanned: targets.length }; }
  return { ok: true, scanned: targets.length };
}
