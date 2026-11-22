import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { secretCommand, type Runner } from '../src/secrets/command';
import { tmp } from './helpers';

const savedHome = process.env.HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});
const probe = (): string => `s_${randomBytes(18).toString('base64url')}`;
const done = (status = 0, stdout = '') => ({ status, stdout: Buffer.from(stdout) }) as never;

type Revision = { version: number; error?: string };
function fixture(home: string, items: string[], values: Record<string, string>, rev?: Revision) {
  const token = probe(),
    keychain = new Map<string, string>(),
    calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: Runner = (command, args, input, env) => {
    calls.push({ args, env });
    if (command === '/fake/op' && args[0] === 'item') {
      if (rev?.error) return { status: 1, stderr: Buffer.from(rev.error) } as ReturnType<Runner>;
      const metadata = { id: 'c4p3fx5xfzm4vno2a4ii7u3qea', updated_at: '2026-11-22T01:00:00Z' };
      return done(
        0,
        JSON.stringify(items.map(title => ({ ...metadata, title, version: rev?.version })))
      );
    }
    if (command === '/fake/op') {
      const match = args[1]?.match(/^op:\/\/[^/]+\/([^/]+)\/(credential|password)$/);
      const value = match && values[`${match[1]}/${match[2]}`];
      return done(value ? 0 : 1, value ?? '');
    }
    if (args[0] === '-i') {
      const match = input?.match(/-a ([A-Z_][A-Z0-9_]*) .* -w "([^"]+)"/);
      if (match) keychain.set(match[1]!, match[2]!);
      return done(match ? 0 : 1);
    }
    if (args[0] === 'delete-generic-password') return done(keychain.delete(args[2]!) ? 0 : 1);
    if (args.includes('superagent-op-sa-token')) return done(0, token);
    const name = args[args.indexOf('-a') + 1]!;
    return done(keychain.has(name) ? 0 : 44, args.includes('-w') ? (keychain.get(name) ?? '') : '');
  };
  process.env.HOME = home;
  return { run, token, keychain, calls };
}
test('sync verifies writes, records provenance, and prunes only synchronized names', () => {
  const home = tmp(),
    first = probe(),
    second = probe();
  mkdirSync(join(home, '.wetamp'), { recursive: true });
  writeFileSync(join(home, '.wetamp/secrets.list'), 'MANUAL\nOLD_SYNC\n');
  writeFileSync(join(home, '.wetamp/secrets.synced'), 'OLD_SYNC\n');
  const f = fixture(home, ['FIRST', 'SECOND', 'not-valid'], {
    'FIRST/credential': first,
    'SECOND/password': second,
  });
  f.keychain.set('OLD_SYNC', probe());
  const result = secretCommand('sync', undefined, undefined, f.run, {
    opPath: '/fake/op',
    prune: true,
  }) as Record<string, unknown>;
  expect(result).toMatchObject({
    ok: true,
    synced: ['FIRST', 'SECOND'],
    pruned: ['OLD_SYNC'],
    skipped_titles: 1,
  });
  expect(readFileSync(join(home, '.wetamp/secrets.list'), 'utf8')).toBe('FIRST\nMANUAL\nSECOND\n');
  expect(readFileSync(join(home, '.wetamp/secrets.synced'), 'utf8')).toBe('FIRST\nSECOND\n');
  expect(JSON.stringify(result)).not.toContain(first);
  expect(
    f.calls
      .filter(call => call.args[0] === 'item' || call.args[0] === 'read')
      .every(call => call.env?.OP_SERVICE_ACCOUNT_TOKEN === f.token)
  ).toBeTrue();
  expect(f.calls.flatMap(call => call.args).join(' ')).not.toContain(f.token);
});

test('sync reuses versions, recovers missing entries and refuses empty prune', () => {
  const items = ['ONLY'],
    rev = { version: 1 };
  const f = fixture(tmp(), items, { 'ONLY/credential': probe() }, rev);
  const options = { opPath: '/fake/op', prune: true };
  const sync = () => secretCommand('sync', undefined, undefined, f.run, options);
  expect(sync()).toMatchObject({ synced: ['ONLY'] });
  f.calls.length = 0;
  expect(sync()).toMatchObject({ synced: [], unchanged: ['ONLY'] });
  expect(f.calls.some(call => call.args.includes('-w') && call.args.includes('ONLY'))).toBeFalse();
  expect(f.calls.some(call => call.args[0] === 'read')).toBeFalse();
  rev.version++;
  expect(sync()).toMatchObject({ synced: ['ONLY'] });
  f.keychain.delete('ONLY');
  expect(sync()).toMatchObject({ synced: ['ONLY'] });
  items.pop();
  expect(sync()).toMatchObject({ ok: false, failed: ['ONLY'], pruned: [] });
  expect(f.keychain.has('ONLY')).toBeTrue();
});

test('sync writes success and failure receipts without raw command output', () => {
  const home = tmp(),
    value = probe(),
    rev: Revision = { version: 1 };
  const f = fixture(home, ['ONLY'], { 'ONLY/credential': value }, rev);
  const state = (file: string) => readFileSync(join(home, '.wetamp', file), 'utf8');
  const receipt = () => state('secret-sync.last.json');
  const sync = () => secretCommand('sync', undefined, undefined, f.run, { opPath: '/fake/op' });
  sync();
  expect(JSON.parse(receipt())).toMatchObject({ ok: true, synced: ['ONLY'], error: null });
  expect(receipt() + state('secrets.sync-state.json')).not.toContain(value);
  rev.error = value;
  expect(sync).toThrow('op item list failed');
  expect(JSON.parse(receipt())).toMatchObject({
    ok: false,
    synced: [],
    error: 'secret sync: op item list failed',
  });
  expect(receipt()).not.toContain(value);
});

test('dry-run and initialization expose no values and perform no keychain writes', () => {
  const value = probe(),
    f = fixture(tmp(), ['ONLY'], { 'ONLY/credential': value });
  expect(
    secretCommand('sync', undefined, undefined, f.run, { opPath: '/fake/op', dryRun: true })
  ).toMatchObject({ synced: ['ONLY'], dry_run: true });
  expect(f.calls.some(call => call.args[0] === '-i')).toBeFalse();
  expect(secretCommand('init-op', undefined, undefined, f.run, { tty: true })).toMatchObject({
    command: expect.stringContaining('pbpaste'),
  });
  expect(() =>
    secretCommand('init-op', undefined, undefined, f.run, { tty: false, stdin: 'short' })
  ).toThrow('ops_');
  const token = 'ops_' + 'x'.repeat(400);
  expect(
    secretCommand('init-op', undefined, undefined, f.run, { tty: false, stdin: token })
  ).toMatchObject({ ok: true });
  expect(f.calls.some(call => call.args.includes('add-generic-password'))).toBeFalse();
  expect(() => secretCommand('sync', undefined, undefined, f.run, { opPath: null })).toThrow(
    'brew install 1password-cli'
  );
});

test('jail blocks mutations before security and redline blocks op argv0', async () => {
  const home = tmp(),
    probeFile = join(home, '.wetamp/jail/.probe'),
    calls: string[][] = [];
  mkdirSync(join(home, '.wetamp/jail'), { recursive: true });
  writeFileSync(probeFile, 'x');
  chmodSync(probeFile, 0);
  process.env.HOME = home;
  const run: Runner = (_command, args) => {
    calls.push(args);
    return done();
  };
  expect(() => secretCommand('set', 'LOCKED', probe(), run)).toThrow('jail');
  expect(() => secretCommand('rm', 'LOCKED', undefined, run)).toThrow('jail');
  expect(calls).toEqual([]);
  const redline = createRequire(import.meta.url)('../hooks/redline.cjs');
  await redline.init();
  const why = redline.reason({
    shell: '/usr/local/bin/op read op://vault/item/password',
    cwd: resolve(import.meta.dir, '../..'),
    root: resolve(import.meta.dir, '../..'),
    env: {},
    client: 'codex',
    name: 'exec_command',
    input: {},
  });
  expect(why).toContain('superagent secret sync');
});
