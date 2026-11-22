import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Runner } from './command';
import {
  atomicWrite,
  deleteSecret,
  findSecret,
  inJail,
  saveNames,
  storedNames,
  valid,
  wetampPath,
  withLock,
  writeSecret,
} from './command';

interface Options {
  vault?: string;
  dryRun?: boolean;
  prune?: boolean;
  opPath?: string | null;
}
export const syncErrors = {
  jail: 'secret sync: AI 会话的 jail 禁止访问钥匙串',
  missingOp: 'secret sync: 未找到 op，请执行 brew install 1password-cli',
  keychain: 'secret sync: 钥匙串不可访问，须在普通终端执行',
  init: 'secret sync: 未初始化，请先执行 pbpaste | superagent secret init-op',
  list: 'secret sync: op item list failed',
  json: 'secret sync: op item list returned invalid JSON',
  prune: 'secret sync: 保管库无有效候选，已拒绝 prune',
  items: 'secret sync: 部分条目同步失败',
  state: 'secret sync: 执行失败或无法保存状态',
} as const;
class SyncError extends Error {}
export const emptySummary = (error: string | null) => ({
  ok: error === null,
  synced: [] as string[],
  unchanged: [] as string[],
  pruned: [] as string[],
  failed: [] as string[],
  error,
});
export type SyncSummary = ReturnType<typeof emptySummary>;
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

export function syncSecrets(run: Runner, options: Options = {}) {
  const file = wetampPath('secret-sync.last.json');
  const save = (summary: SyncSummary) => {
    const receipt = { ...summary, at: new Date().toISOString(), host: hostname() };
    atomicWrite(file, JSON.stringify(receipt));
  };
  try {
    return withLock(file, () => {
      const { vault, skipped_titles, dry_run, ...summary } = sync(run, options);
      save(summary);
      return { ...summary, vault, skipped_titles, dry_run };
    });
  } catch (error) {
    const message = error instanceof SyncError ? error.message : syncErrors.state;
    try {
      save(emptySummary(message));
    } catch {
      throw new Error(syncErrors.state);
    }
    throw new Error(message);
  }
}

function sync(run: Runner, options: Options) {
  if (inJail()) throw new SyncError(syncErrors.jail);
  const op = options.opPath === undefined ? Bun.which('op') : options.opPath;
  if (!op) throw new SyncError(syncErrors.missingOp);
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
      throw new SyncError(syncErrors.keychain);
  }
  if (!token) throw new SyncError(syncErrors.init);
  const env = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token };
  const vault = options.vault ?? 'AI-Agents';
  const listed = run(op, ['item', 'list', '--vault', vault, '--format', 'json'], undefined, env);
  if (listed.status !== 0) throw new SyncError(syncErrors.list);
  let items: unknown;
  try {
    items = JSON.parse(output(listed)) as unknown;
  } catch {
    throw new SyncError(syncErrors.json);
  }
  if (!Array.isArray(items)) throw new SyncError(syncErrors.json);
  const revisions = new Map<string, string | undefined>();
  let skipped_titles = 0;
  for (const item of items as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { title, id, version, updated_at } = item as Record<string, unknown>;
    if (typeof title !== 'string') continue;
    if (!valid(title)) {
      skipped_titles++;
      continue;
    }
    const updated = typeof updated_at === 'string' ? Date.parse(updated_at) : NaN;
    const numericVersion =
      typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
    const itemId = typeof id === 'string' && /^[a-z0-9]{26}$/.test(id) ? id : null;
    const cacheable =
      !revisions.has(title) && itemId && (numericVersion !== null || Number.isFinite(updated));
    revisions.set(title, cacheable ? JSON.stringify([itemId, numericVersion, updated]) : undefined);
  }
  const candidates = [...revisions.keys()].sort(),
    prior = storedNames('secrets.synced');
  const state = wetampPath('secrets.sync-state.json'),
    next = new Map<string, string>();
  let previous: Record<string, unknown> = {};
  try {
    const cache: unknown = JSON.parse(readFileSync(state, 'utf8'));
    if (cache && typeof cache === 'object') previous = cache as Record<string, unknown>;
  } catch {
    /* Cache miss. */
  }
  const synced: string[] = [],
    unchanged: string[] = [],
    failed: string[] = [];
  for (const name of candidates) {
    const revision = revisions.get(name);
    if (
      revision &&
      previous[name] === revision &&
      prior.includes(name) &&
      findSecret(name, run).status === 0
    ) {
      unchanged.push(name);
      next.set(name, revision);
      continue;
    }
    let value = '';
    for (const field of ['credential', 'password']) {
      const read = run(op, ['read', `op://${vault}/${name}/${field}`], undefined, env);
      if (read.status === 0 && output(read)) {
        value = output(read);
        break;
      }
    }
    if (!value || (!options.dryRun && !writeSecret(name, value, run))) {
      failed.push(name);
      continue;
    }
    if (!options.dryRun) {
      const verify = findSecret(name, run, true);
      if (verify.status !== 0 || output(verify) !== value) {
        failed.push(name);
        continue;
      }
    }
    synced.push(name);
    if (revision) next.set(name, revision);
  }
  const unsafePrune = options.prune && !candidates.length && prior.length > 0;
  if (unsafePrune) failed.push(...prior);
  const pruned = options.prune && !unsafePrune ? prior.filter(name => !revisions.has(name)) : [];
  if (!options.dryRun) {
    const removed = pruned.filter(name => {
      if (deleteSecret(name, run, true)) return true;
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
    atomicWrite(state, JSON.stringify(Object.fromEntries(next)));
  }
  return {
    ok: failed.length === 0,
    vault,
    synced,
    unchanged,
    pruned,
    failed,
    error: unsafePrune ? syncErrors.prune : failed.length ? syncErrors.items : null,
    skipped_titles,
    dry_run: !!options.dryRun,
  };
}
