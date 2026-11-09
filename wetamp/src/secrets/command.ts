import {
  closeSync,
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

type Runner = (command: string, args: string[], input?: string) => SpawnSyncReturns<Buffer>;
const valid = (name: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(name);
const listPath = (): string => join(process.env.HOME ?? homedir(), '.wetamp', 'secrets.list');
const names = (): string[] => {
  try {
    return [...new Set(readFileSync(listPath(), 'utf8').split(/\r?\n/).filter(valid))].sort();
  } catch {
    return [];
  }
};
// prettier-ignore
const save = (values: string[]): void => {
  const file = listPath(), temp = `${file}.${String(process.pid)}.tmp`;
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(temp, values.length ? `${values.join('\n')}\n` : '', { mode: 0o600 }); renameSync(temp, file);
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
export function secretCommand(action: string | undefined, name?: string, value?: string, run: Runner = (command, args, input) => spawnSync(command, args, { input })): unknown {
  if (action === 'list') return names();
  if (!name || !valid(name)) throw new Error('secret: NAME must match [A-Z_][A-Z0-9_]*');
  const service = `superagent-secret:${name}`;
  if (action === 'set') { const secret = value ?? hidden();
    if (secret.length < 8) throw new Error('secret: value must be at least 8 characters');
    // `add-generic-password -w` with no value stores an empty password when stdin is not a TTY, and
    // `-w <value>` would expose the value in argv; `security -i` reads the whole command from stdin.
    const quoted = `"${secret.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    if (/[\r\n]/.test(secret)) throw new Error('secret: value must be a single line');
    if (run('/usr/bin/security', ['-i'], `add-generic-password -U -a ${name} -s ${service} -w ${quoted}\n`).status !== 0) throw new Error('secret: AI 会话的 jail 禁止访问钥匙串，请在普通终端执行');
    save([...new Set([...names(), name])].sort()); return { ok: true, name }; }
  if (action === 'rm') { if (run('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', service]).status !== 0) throw new Error('secret: keychain delete failed'); save(names().filter(value => value !== name)); return { ok: true, name }; }
  throw new Error('usage: superagent secret set|list|rm <NAME>');
}
