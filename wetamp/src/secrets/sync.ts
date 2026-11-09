import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Runner } from './command';
import { deleteSecret, saveNames, storedNames, writeSecret } from './command';

interface Options {
  vault?: string;
  dryRun?: boolean;
  prune?: boolean;
  opPath?: string | null;
}
const valid = (name: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(name);
const output = (result: ReturnType<Runner>): string =>
  Buffer.from(result.stdout)
    .toString()
    .replace(/\r?\n$/, '');

// The service-account token lives in a 0600 file the jail denies (secret-paths.json "os"):
// macOS `security ... -w` prompts through getpass, which silently truncates input at 128 characters,
// and a 1Password service-account token is several hundred characters long.
export const opTokenFile = (home = process.env.HOME ?? homedir()): string =>
  join(home, '.config', 'superagent', 'op-sa.token');
export function initOp(
  tty: boolean,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
  file = opTokenFile()
): { ok: true; command?: string; stored?: string } {
  if (tty) return { ok: true, command: 'pbpaste | superagent secret init-op' };
  const token = readStdin().trim();
  if (!token.startsWith('ops_') || token.length < 200 || /\s/.test(token))
    throw new Error(
      'secret init-op: 输入不像 1Password 服务账号 token（应以 ops_ 开头、无空白、数百字符）'
    );
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, token, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return { ok: true, stored: file };
}

export function syncSecrets(run: Runner, options: Options = {}): unknown {
  const op = options.opPath === undefined ? Bun.which('op') : options.opPath;
  if (!op) throw new Error('secret sync: 未找到 op，请执行 brew install 1password-cli');
  const file = opTokenFile();
  let token = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (!token) {
    const tokenResult = run('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-a',
      'superagent',
      '-s',
      'superagent-op-sa-token',
    ]);
    token = output(tokenResult);
    if (tokenResult.status !== 0 && tokenResult.status !== 44)
      throw new Error('secret sync: 钥匙串不可访问，须在普通终端执行');
  }
  if (!token)
    throw new Error('secret sync: 未初始化，请先执行 pbpaste | superagent secret init-op');
  const env = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token };
  const vault = options.vault ?? 'AI-Agents';
  const listed = run(op, ['item', 'list', '--vault', vault, '--format', 'json'], undefined, env);
  if (listed.status !== 0)
    throw new Error(
      `secret sync: op item list failed: ${Buffer.from(listed.stderr).toString().split('\n')[0].slice(0, 160)}`
    );
  let items: unknown;
  try {
    items = JSON.parse(output(listed)) as unknown;
  } catch {
    throw new Error('secret sync: op item list returned invalid JSON');
  }
  if (!Array.isArray(items)) throw new Error('secret sync: op item list returned invalid JSON');
  const titles = items.flatMap((item: unknown) =>
    item && typeof item === 'object' && 'title' in item && typeof item.title === 'string'
      ? [item.title]
      : []
  );
  const candidates = [...new Set(titles.filter(valid))].sort();
  const synced: string[] = [],
    failed: string[] = [];
  for (const name of candidates) {
    let value = '';
    for (const field of ['credential', 'password']) {
      const read = run(op, ['read', `op://${vault}/${name}/${field}`], undefined, env);
      if (read.status === 0 && output(read)) {
        value = output(read);
        break;
      }
    }
    if (!value) {
      failed.push(name);
      continue;
    }
    if (!options.dryRun) {
      if (!writeSecret(name, value, run)) {
        failed.push(name);
        continue;
      }
      const verify = run('/usr/bin/security', [
        'find-generic-password',
        '-w',
        '-a',
        name,
        '-s',
        `superagent-secret:${name}`,
      ]);
      if (verify.status !== 0 || output(verify) !== value) {
        failed.push(name);
        continue;
      }
    }
    synced.push(name);
  }
  const prior = storedNames('secrets.synced');
  const pruned = options.prune ? prior.filter(name => !candidates.includes(name)) : [];
  if (!options.dryRun) {
    const removed = pruned.filter(name => {
      if (deleteSecret(name, run)) return true;
      failed.push(name);
      return false;
    });
    saveNames(
      [...new Set([...storedNames().filter(name => !removed.includes(name)), ...synced])].sort()
    );
    saveNames(
      [...new Set([...prior.filter(name => !removed.includes(name)), ...synced])].sort(),
      'secrets.synced'
    );
    pruned.splice(0, pruned.length, ...removed);
  }
  return {
    ok: failed.length === 0,
    vault,
    synced,
    pruned,
    failed,
    skipped_titles: titles.filter(title => !valid(title)).length,
    dry_run: !!options.dryRun,
  };
}
