import {
  closeSync,
  accessSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { initOp, syncSecrets } from './sync';

export type Runner = (
  command: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
  timeout?: number
) => SpawnSyncReturns<Buffer>;
export const defaultRunner: Runner = (command, args, input, env) =>
  spawnSync(command, args, { input, env });
export const valid = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(name);
export const wetampPath = (file: string): string =>
  join(process.env.HOME ?? homedir(), '.wetamp', file);
export const { withLock, atomicWrite } = createRequire(import.meta.url)(
  '../../hooks/hook-state.cjs'
) as {
  withLock: <T>(file: string, run: () => T) => T;
  atomicWrite: (file: string, text: string) => void;
};
export const storedNames = (file = 'secrets.list'): string[] => {
  try {
    return [...new Set(readFileSync(wetampPath(file), 'utf8').split(/\r?\n/).filter(valid))].sort();
  } catch {
    return [];
  }
};
export const saveNames = (values: string[], name = 'secrets.list'): void => {
  const file = wetampPath(name);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, values.length ? `${values.join('\n')}\n` : '');
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
const keychain = (run: Runner, name: string, ...args: string[]) =>
  run('/usr/bin/security', [...args, '-a', name, '-s', service(name)]);
export const findSecret = (name: string, run: Runner, read = false) =>
  keychain(run, name, 'find-generic-password', ...(read ? ['-w'] : []));
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
export const deleteSecret = (name: string, run: Runner, missingOk = false): boolean => {
  const { status } = keychain(run, name, 'delete-generic-password');
  return status === 0 || (missingOk && status === 44);
};
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
export function secretCommand(action: string | undefined, name?: string, value?: string, run: Runner = defaultRunner, options: { vault?: string; dryRun?: boolean; prune?: boolean; opPath?: string | null; tty?: boolean; stdin?: string } = {}): unknown {
  if (action === 'list') return storedNames();
  if (action === 'sync' || action === 'init-op')
    return action === 'sync' ? syncSecrets(run, options) : initOp(options.tty ?? process.stdin.isTTY, options.stdin ? () => options.stdin ?? '' : undefined);
  if (!name || !valid(name)) throw new Error('secret: NAME must match [A-Z_][A-Z0-9_]*');
  if ((action === 'set' || action === 'rm') && inJail()) throw new Error('secret: AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
  if (action === 'set') { const secret = value ?? hidden();
    if (secret.length < 8) throw new Error('secret: value must be at least 8 characters');
    if (!writeSecret(name, secret, run)) throw new Error('secret: AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
    saveNames([...new Set([...storedNames(), name])].sort()); saveNames(storedNames('secrets.synced').filter(value => value !== name), 'secrets.synced'); return { ok: true, name }; }
  if (action === 'rm') { if (!deleteSecret(name, run)) throw new Error('secret: keychain delete failed'); saveNames(storedNames().filter(value => value !== name)); saveNames(storedNames('secrets.synced').filter(value => value !== name), 'secrets.synced'); return { ok: true, name }; }
  throw new Error('usage: superagent secret set|list|rm|sync|init-op <NAME>');
}
