import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildSecrets } from '../src/secrets/build';
import { secretCommand } from '../src/secrets/command';
import { exactPatterns, redactGitleaksFindings, scanText } from '../src/secrets/scan';
import { fixtureTiersEnv, tmp } from './helpers';

const config = join(import.meta.dir, '../secrets/gitleaks.toml');
const probe = (): string => `p_${randomBytes(18).toString('base64url')}`;
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

test('managed values cover raw, line endings, four encodings, and key-value rules', () => {
  const value = probe(),
    secrets = [{ name: 'PROBE', value }],
    variants = exactPatterns(secrets);
  expect(variants.length).toBeGreaterThanOrEqual(9);
  const input = variants.map(item => item.value).join('|') + ` token="not ${value}"`;
  const output = scanText(input, { secrets, gitleaks: false });
  for (const variant of variants) expect(output).not.toContain(variant.value);
  expect(output).toContain('[REDACTED:PROBE]');
  expect(output).toContain('token=***');
  // prettier-ignore
  expect(scanText('max_tokens: value = id\nkeyboard=value abc123', { secrets: [], gitleaks: false, keyValues: false })).toBe('max_tokens: value = id\nkeyboard=value abc123');
});

test('prompt filtering skips heuristic keys but keeps vendor and managed detections', () => {
  const generic = `preview?key=${Array.from({ length: 32 }, (_, index) =>
      (index % 16).toString(16)
    ).join('')}`,
    token = `ghp_${randomBytes(27).toString('hex').slice(0, 36)}`,
    managed = probe();
  expect(scanText(generic, { secrets: [], config, keyValues: false, heuristics: false })).toBe(
    generic
  );
  expect(scanText(generic, { secrets: [], config, keyValues: false })).not.toBe(generic);
  const output = scanText(`safe\n${token} # gitleaks:allow\nafter`, {
    secrets: [],
    config,
    heuristics: false,
  });
  expect(output).not.toContain(token);
  expect(output).toContain('[REDACTED:gitleaks]');
  expect(
    scanText(managed, {
      secrets: [{ name: 'MANAGED', value: managed }],
      config,
      heuristics: false,
    })
  ).toBe('[REDACTED:MANAGED]');
  expect(redactGitleaksFindings('keep\nencoded\nend', [{ Secret: 'decoded', StartLine: 2 }])).toBe(
    'keep\n[REDACTED:gitleaks]\nend'
  );
});

test('built cjs stays consistent and the stream redacts bytewise chunks or fails closed', async () => {
  const out = tmp(),
    value = probe();
  await buildSecrets(out);
  const built = createRequire(import.meta.url)(
    join(out, 'secret-scan.cjs')
  ) as typeof import('../src/secrets/scan');
  expect(built.scanText(value, { secrets: [{ name: 'X', value }], gitleaks: false })).toBe(
    scanText(value, { secrets: [{ name: 'X', value }], gitleaks: false })
  );
  const run = async (input: string, env: Record<string, string>): Promise<string> => {
    const child = Bun.spawn(['node', join(out, 'sa-redact.cjs')], {
      env: { PATH: process.env.PATH, HOME: tmp(), SA_GITLEAKS_CONFIG: config, ...env },
      stdin: 'pipe',
      stdout: 'pipe',
    });
    for (const byte of Buffer.from(input)) child.stdin.write(Uint8Array.of(byte));
    child.stdin.end();
    await child.exited;
    return new Response(child.stdout).text();
  };
  expect(await run(`before ${value} after\n`, { PROBE_TOKEN: value })).toBe(
    'before [REDACTED:environment] after\n'
  );
  expect(await run('plain output', { SA_GITLEAKS_CONFIG: join(out, 'missing.toml') })).toBe(
    '[REDACTED:scan_failed]'
  );
});

test('secret commands persist names only; install renders OS denies and dry-run migration is read-only', () => {
  const home = tmp(),
    calls: string[][] = [],
    run = (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0 } as never;
    };
  process.env.HOME = home;
  expect(() => secretCommand('set', 'SHORT', '1234567', run)).toThrow('at least 8');
  const value = probe();
  expect(secretCommand('set', 'SYNTH_TOKEN', value, run)).toEqual({
    ok: true,
    name: 'SYNTH_TOKEN',
  });
  expect(secretCommand('list')).toEqual(['SYNTH_TOKEN']);
  expect(readFileSync(join(home, '.wetamp/secrets.list'), 'utf8')).toBe('SYNTH_TOKEN\n');
  expect(secretCommand('rm', 'SYNTH_TOKEN', undefined, run)).toEqual({
    ok: true,
    name: 'SYNTH_TOKEN',
  });
  // The value travels on stdin through `security -i`, never in argv.
  expect(calls.map(args => args[0])).toEqual(['-i', 'delete-generic-password']);
  expect(calls.flat().join(' ')).not.toContain(value);
  // prettier-ignore
  expect(() => secretCommand('set', 'SYNTH_FAIL', value, () => ({ status: 1 }) as never)).toThrow('AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
  const bin = join(home, 'bin'),
    op = join(bin, 'op');
  mkdirSync(bin);
  writeFileSync(op, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(op, 0o755);
  mkdirSync(join(home, 'archon'), { recursive: true });
  const install = Bun.spawnSync([join(import.meta.dir, '../scripts/install.sh')], {
    env: {
      ...process.env,
      ...fixtureTiersEnv(),
      HOME: home,
      SUPERAGENT_HOME: home,
      ARCHON_HOME: join(home, 'archon'),
      SA_LAUNCHD_DIR: join(home, 'launchd'),
      SA_SKIP_LAUNCHD_RELOAD: '1',
      SA_SKIP_DOCTOR: '1',
      XDG_STATE_HOME: join(home, 'state'),
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(install.exitCode).toBe(0);
  const policy = readFileSync(join(home, '.wetamp/jail/ai-deny.sb'), 'utf8');
  expect(policy).toContain('/Library/Keychains');
  expect(policy).not.toContain('/.npmrc');
  expect(policy).toContain(`(deny process-exec (literal "${op}"))`);
  expect(existsSync(join(home, '.wetamp/jail/sa-redact.cjs'))).toBeTrue();
  // prettier-ignore
  expect(readFileSync(join(home, '.wetamp/jail/sa-redact.sh'), 'utf8')).not.toMatch(/\/versions\/node\/v/);
  writeFileSync(join(home, '.zshrc'), 'export SYNTH_TOKEN=value\n');
  const migration = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '../secrets/migrate.ts'), '--dry-run'],
    { env: { ...process.env, HOME: home }, stdout: 'pipe' }
  );
  expect(JSON.parse(migration.stdout.toString())).toMatchObject({
    dry_run: true,
    names: ['SYNTH_TOKEN'],
  });
});
