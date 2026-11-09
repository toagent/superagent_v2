import {
  closeSync,
  accessSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { initOp, syncSecrets } from './sync';

export type Runner = (
  command: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv
) => SpawnSyncReturns<Buffer>;
const valid = (name: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(name);
const wetampPath = (file: string): string => join(process.env.HOME ?? homedir(), '.wetamp', file);
export const storedNames = (file = 'secrets.list'): string[] => {
  try {
    return [...new Set(readFileSync(wetampPath(file), 'utf8').split(/\r?\n/).filter(valid))].sort();
  } catch {
    return [];
  }
};
// prettier-ignore
export const saveNames = (values: string[], name = 'secrets.list'): void => {
  const file = wetampPath(name), temp = `${file}.${String(process.pid)}.tmp`;
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(temp, values.length ? `${values.join('\n')}\n` : '', { mode: 0o600 }); renameSync(temp, file);
};
export const inJail = (): boolean => {
  try {
    accessSync(wetampPath('jail/.probe'), constants.R_OK);
    return false;
  } catch (error) {
    return (
      !!error &&
      typeof error === 'object' &&
      ['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))
    );
  }
};
const service = (name: string): string => `superagent-secret:${name}`;
export const writeSecret = (name: string, secret: string, run: Runner): boolean => {
  if (/\r|\n/.test(secret)) throw new Error('secret: value must be a single line');
  const quoted = `"${secret.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return (
    run(
      '/usr/bin/security',
      ['-i'],
      `add-generic-password -U -a ${name} -s ${service(name)} -w ${quoted}\n`
    ).status === 0
  );
};
export const deleteSecret = (name: string, run: Runner): boolean =>
  run('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', service(name)]).status ===
  0;
// prettier-ignore
const hidden = (): string => {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
  const fd = openSync('/dev/tty', 'r+'), bytes: number[] = [], byte = Buffer.alloc(1);
  spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); writeSync(fd, 'Secret: ');
  try { while (readSync(fd, byte, 0, 1, null) && byte[0] !== 10 && byte[0] !== 13) bytes.push(byte[0]); }
  finally { spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); writeSync(fd, '\n'); closeSync(fd); }
  return Buffer.from(bytes).toString();
};
// prettier-ignore
export function secretCommand(action: string | undefined, name?: string, value?: string, run: Runner = (command, args, input, env) => spawnSync(command, args, { input, env }), options: { vault?: string; dryRun?: boolean; prune?: boolean; opPath?: string | null; tty?: boolean } = {}): unknown {
  if (action === 'list') return storedNames();
  if (action === 'sync' || action === 'init-op')
    return action === 'sync' ? syncSecrets(run, options) : initOp(options.tty ?? process.stdin.isTTY);
  if (!name || !valid(name)) throw new Error('secret: NAME must match [A-Z_][A-Z0-9_]*');
  if ((action === 'set' || action === 'rm') && inJail()) throw new Error('secret: AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
  if (action === 'set') { const secret = value ?? hidden();
    if (secret.length < 8) throw new Error('secret: value must be at least 8 characters');
    if (!writeSecret(name, secret, run)) throw new Error('secret: AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
    saveNames([...new Set([...storedNames(), name])].sort()); saveNames(storedNames('secrets.synced').filter(value => value !== name), 'secrets.synced'); return { ok: true, name }; }
  if (action === 'rm') { if (!deleteSecret(name, run)) throw new Error('secret: keychain delete failed'); saveNames(storedNames().filter(value => value !== name)); saveNames(storedNames('secrets.synced').filter(value => value !== name), 'secrets.synced'); return { ok: true, name }; }
  throw new Error('usage: superagent secret set|list|rm|sync|init-op <NAME>');
}
