import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { collectCredentialValues } from '@archon/paths/credential-redaction';

const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`;
// prettier-ignore
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

const BASIC_AUTH = /(?:^|[\s"':=])basic[ \t]+([A-Za-z0-9+/]{4,4096}={0,2})(?![\w+/=-])/gi;

function redactBasicAuth(text: string): string {
  return text.replace(BASIC_AUTH, (header: string, encoded: string) => {
    const bytes = Buffer.from(encoded, 'base64');
    const canonical = bytes.toString('base64');
    // Buffer accepts malformed padding and trailing bits. Require canonical Base64.
    if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) return header;
    const colon = ':'.charCodeAt(0);
    if (!bytes.includes(colon) || bytes.some(byte => byte < 0x20 || byte === 0x7f)) return header;
    return `${header.slice(0, -encoded.length)}[REDACTED:basic-auth]`;
  });
}
// prettier-ignore
const strings = (value: unknown, key = ''): string[] => typeof value === 'string' ? (/token|key|secret|password/i.test(key) ? [value] : []) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, child]) => strings(child, name)) : [];
// prettier-ignore
const read = (file: string): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
export interface ManagedSecret {
  name: string;
  value: string;
}
// prettier-ignore
export function managedSecrets(env: NodeJS.ProcessEnv = process.env): ManagedSecret[] {
  // Keyed by value: several secrets share a source label, and a name-keyed map kept only the last one.
  const home = env.HOME ?? homedir(), names = read(join(home, '.wetamp', 'secrets.list')).split(/\r?\n/).filter(Boolean), values = new Map<string, string>();
  for (const value of collectCredentialValues(env)) values.set(value, 'environment');
  for (const name of names) if (env[name]) values.set(env[name], name);
  let configured: string[] = [];
  try { const paths = JSON.parse(read(env.SA_SECRET_PATHS ?? join(home, '.wetamp', 'jail', 'secret-paths.json'))) as { client_auth?: string[] }; configured = (paths.client_auth ?? []).map(file => join(home, file)); } catch { /* absent list */ }
  const auth = env.SA_CLIENT_AUTH_FILES?.split(delimiter).filter(Boolean) ?? configured;
  for (const file of auth) {
    // agy authentication files are guard targets only, including the Orca ACP token.
    const path = resolve(file).toLowerCase();
    if (path.startsWith(resolve(home, '.gemini').toLowerCase() + '/') || path.includes('/antigravity-chat/')) continue;
    try { for (const value of strings(JSON.parse(read(file)))) if (!values.has(value)) values.set(value, 'client_auth'); } catch { /* unreadable auth */ }
  }
  return [...values].filter(([value]) => value.length >= 8).map(([value, name]) => ({ name, value }));
}
// prettier-ignore
const encodings = (value: string): string[] => { const bytes = Buffer.from(value); return [bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex'), encodeURIComponent(value)]; };
// prettier-ignore
export function exactPatterns(secrets = managedSecrets()): ManagedSecret[] {
  const out = new Map<string, string>();
  for (const secret of secrets) { out.set(secret.value, secret.name); for (const raw of [secret.value, `${secret.value}\n`, `${secret.value}\r\n`]) for (const encoded of encodings(raw)) out.set(encoded, secret.name); }
  return [...out].map(([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
}
interface Finding {
  RuleID?: string;
  Match?: string;
  Secret?: string;
  StartLine?: number;
  EndLine?: number;
}
// These rules infer secrets from generic field names and entropy, so prompt input must not
// block on them. Tool-output redaction keeps them enabled to catch unmanaged secret values.
export const HEURISTIC_RULES = new Set(['generic-api-key', 'password-assignment']);
export interface ScanOptions {
  secrets?: ManagedSecret[];
  gitleaks?: boolean;
  heuristics?: boolean;
  keyValues?: boolean;
  config?: string;
}
// prettier-ignore
export const redactGitleaksFindings = (text: string, findings: Finding[]): string => {
  const lines = text.split('\n');
  const handled = new Set<string>();
  for (const finding of findings) { const start = Math.max(0, (finding.StartLine ?? 1) - 1), end = Math.min(lines.length - 1, (finding.EndLine ?? finding.StartLine ?? 1) - 1), secret = finding.Secret ?? '';
    const key = JSON.stringify([start, end, secret]);
    if (handled.has(key)) continue;
    handled.add(key);
    if (secret && lines.slice(start, end + 1).some(line => line.includes(secret))) for (let i = start; i <= end; i++) lines[i] = lines[i].replaceAll(secret, '[REDACTED:gitleaks]');
    else for (let i = start; i <= end; i++) lines[i] = '[REDACTED:gitleaks]'; }
  return lines.join('\n');
};
// Gitleaks can interpret a comma between two paths as a generic key assignment.
const PATH_PAIR =
  /^[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|sh|json|toml|ya?ml|md|txt)["']?,[ \t]*["'`]?((?:[\w.-]+\/)+[\w.-]+\/?)['"`]?[ \t;]*$/i;

function isPathPair({ Match, Secret }: Finding): boolean {
  const path = PATH_PAIR.exec(Match ?? '')?.[1];
  if (!path || path !== Secret) return false;
  // Check individual segments so the combined character diversity of ordinary paths is allowed.
  return path
    .replace(/\/$/, '')
    .split('/')
    .every(segment => {
      const counts = new Map<string, number>();
      for (const char of segment) counts.set(char, (counts.get(char) ?? 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) {
        const probability = count / segment.length;
        entropy -= probability * Math.log2(probability);
      }
      return entropy <= 3.25;
    });
}

// prettier-ignore
function gitleaks(text: string, options: ScanOptions): Finding[] {
  if (!text || options.gitleaks === false) return [];
  const config = options.config ?? process.env.SA_GITLEAKS_CONFIG ?? defaultConfig();
  const result = spawnSync('gitleaks', ['stdin', '--config', config, '--ignore-gitleaks-allow', '--no-banner', '--report-format', 'json', '--report-path', '-'], { input: text, encoding: 'utf8' });
  if (result.status === 0) return [];
  if (result.status !== 1) throw new Error('scan_failed');
  try {
    const findings = JSON.parse(result.stdout) as Finding[];
    if (!Array.isArray(findings) || !findings.length) throw new Error('invalid report');
    return findings.filter(finding => {
      if (options.heuristics === false && HEURISTIC_RULES.has(finding.RuleID ?? '')) return false;
      return finding.RuleID !== 'generic-api-key' || !isPathPair(finding);
    });
  } catch {
    throw new Error('scan_failed');
  }
}

function scanLocally(text: string, patterns: ManagedSecret[], keyValues = true): string {
  let result = redactBasicAuth(text);
  for (const { name, value } of patterns) result = result.replaceAll(value, `[REDACTED:${name}]`);
  return keyValues ? redactKeyValues(result) : result;
}

export function scanText(text: string, options: ScanOptions = {}): string {
  const result = scanLocally(text, exactPatterns(options.secrets), options.keyValues);
  const findings = gitleaks(result, options);
  return findings.length ? redactGitleaksFindings(result, findings) : result;
}

// Six intervening lines and >200 punctuation bytes isolate the bundled curl and Kubernetes
// multiline rules. Close any unfinished PEM match inside the fence before the next field.
// Blank lines give gitleaks safe read boundaries between fields.
const FIELD_FENCE = ['', '!', '!', '!', '!', '!', '!'.repeat(256) + 'KEY-----', ''];
const FENCE_OWNERS = FIELD_FENCE.map(() => -1);

export function fieldsContainSecret(fields: Iterable<string>): boolean {
  const patterns = exactPatterns();
  const lines: string[] = [];
  const owners: number[] = [];
  for (const field of fields) {
    if (scanLocally(field, patterns, false) !== field) return true;
    if (lines.length) {
      lines.push(...FIELD_FENCE);
      owners.push(...FENCE_OWNERS);
    }
    const owner = lines.length;
    for (const line of field.split('\n')) {
      lines.push(line);
      owners.push(owner);
    }
  }
  return gitleaks(lines.join('\n'), {}).some(({ StartLine, EndLine }) => {
    if (!StartLine || !EndLine || StartLine > EndLine || EndLine > owners.length)
      throw new Error('scan_failed');
    const owner = owners[StartLine - 1];
    return owner >= 0 && owner === owners[EndLine - 1];
  });
}
// The config ships beside its code: install.sh copies it next to the built cjs in the jail, and the
// engine checkout carries it at wetamp/secrets/. Never depend on the jail install from engine code,
// or every run launch fails closed on a machine where the firewall is not installed yet.
function defaultConfig(): string {
  const candidates = [
    join(__dirname, 'gitleaks.toml'),
    join(__dirname, '..', '..', 'secrets', 'gitleaks.toml'),
  ];
  return candidates.find(existsSync) ?? join(homedir(), '.wetamp', 'jail', 'gitleaks.toml');
}
// Do not follow a linked file or directory below the home chosen for the scan.
export function scanStat(home: string, path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    for (let dir = dirname(path); dir !== home; dir = dirname(dir)) {
      if (dir === dirname(dir) || !lstatSync(dir).isDirectory()) return undefined;
    }
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? undefined : stat;
  } catch {
    return undefined;
  }
}

// prettier-ignore
export function secretsHealth(config: string, home = process.env.HOME ?? homedir()): { ok: boolean; scanned: number } {
  const targets = [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md'), join(home, '.ai-agent-shared', 'memory')].filter(existsSync);
  const gemini = resolve(home, '.gemini/GEMINI.md');
  if (scanStat(resolve(home), gemini)?.isFile()) targets.push(gemini);
  for (const target of targets) { const result = spawnSync('gitleaks', ['dir', target, '--config', config, '--ignore-gitleaks-allow', '--no-banner', '--report-format', 'json', '--report-path', '/dev/null'], { encoding: 'utf8' }); if (result.status !== 0) return { ok: false, scanned: targets.length }; }
  return { ok: true, scanned: targets.length };
}
