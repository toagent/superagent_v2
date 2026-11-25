import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { scanText } from '../src/secrets/scan';

const config = join(import.meta.dir, '../secrets/gitleaks.toml');

test('Clash 令牌的两种参数写法均保留参数名并遮蔽值', () => {
  const redact = (text: string) => scanText(text, { config, secrets: [], keyValues: false });
  const value = ['fixture', 'v1'].join('-');
  for (const flag of ['--gateway-token', '--backend-token']) {
    for (const separator of [' ', '=']) {
      const argument = `${flag}${separator}${value}`;
      const command = `neko-agent ${argument} ${argument}`;
      expect(redact(command)).toBe(command.replaceAll(value, '[REDACTED:gitleaks]'));
    }
  }
  const ordinary = 'neko-agent --port=7890 --gateway-token= --backend-token --help';
  expect(redact(ordinary)).toBe(ordinary);
});
// prettier-ignore
const scan = (text: string) => Bun.spawnSync(['gitleaks', 'stdin', '--config', config, '--no-banner', '--report-format', 'json', '--report-path', '-'], { stdin: Buffer.from(text), stdout: 'pipe', stderr: 'pipe' });

// Fixtures are generated at run time so no literal credential lands in source or diff (land gate).
const rand = (n: number): string =>
  Array.from(
    { length: n },
    () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 56)]
  ).join('');
// prettier-ignore
test('custom rules cover password fields, credentialed URLs and vendor secrets without code-like false positives', () => { const hits = ['pass' + 'word=' + rand(16), 'postgres://user:' + rand(16) + '@db.local/app', 'whsec_' + rand(32), 'GOCSPX-' + rand(28)], found = scan(hits.join('\n')); expect(found.exitCode).toBe(1); const ids = new Set((JSON.parse(found.stdout.toString()) as { RuleID: string }[]).map(item => item.RuleID)); expect(ids).toEqual(new Set(['password-assignment', 'credentialed-connection-string', 'webhook-signing-secret', 'google-oauth-client-secret'])); expect(scan(['password_length: 12', 'const password = getInput()', 'pwd = os.getcwd()', 'const password = options.password', '"password": "${PASSWORD}"', 'password: process.env.PASSWORD', 'password=12345678', 'password=********', 'postgres://db.local/app', 'whsec_short', 'GOCSPX-short'].join('\n')).exitCode).toBe(0); });
