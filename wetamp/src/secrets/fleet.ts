import { spawnSync } from 'node:child_process';
import { inJail, valid, type Runner } from './command';
import { emptySummary, syncErrors, type SyncSummary } from './sync';

const job = 'gui/$(/usr/bin/id -u)/com.wetamp.superagent.secret-sync';
const receipt = '"$HOME/.wetamp/secret-sync.last.json"';
const read = `if [ -f ${receipt} ]; then /bin/cat ${receipt}; fi`;
const knownError = (message: unknown) =>
  Object.values(syncErrors).find(error => error === message) ?? syncErrors.state;
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(valid);

export function syncFleet(
  hosts: string[],
  dryRun: boolean,
  local: () => SyncSummary,
  run: Runner = (command, args, input, env, timeout) =>
    spawnSync(command, args, { input, env, timeout, killSignal: 'SIGKILL' }),
  timeout = 120_000
) {
  if (hosts.some(host => !/^[a-z0-9_][a-z0-9_.-]*$/i.test(host) || host === 'local'))
    throw new Error('secret sync: --host 须为 SSH 别名，local 为本机保留名');
  let here: SyncSummary;
  try {
    here = local();
  } catch (error) {
    here = emptySummary(knownError(error instanceof Error ? error.message : undefined));
  }
  const { ok, synced, unchanged, pruned, failed, error } = here;
  const jailed = !ok && inJail();
  const results = Object.create(null) as Record<string, SyncSummary>;
  results.local = { ok, synced, unchanged, pruned, failed, error };
  for (const host of new Set(hosts))
    results[host] = jailed ? emptySummary(syncErrors.jail) : remote(host, dryRun, run, timeout);
  return { ok: Object.values(results).every(result => result.ok), hosts: results };
}

function remote(host: string, dryRun: boolean, run: Runner, timeout: number): SyncSummary {
  const end = Date.now() + timeout,
    timedOut = '等待同步回执超时';
  const ssh = (command: string) => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error(timedOut);
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, command];
    const result = run('ssh', args, undefined, undefined, remaining);
    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT')
      throw new Error(timedOut);
    if (result.status === 69) throw new Error('同步 LaunchAgent 未安装或 GUI 会话不可用');
    if (result.status !== 0) throw new Error(`SSH 请求失败（退出码 ${String(result.status)}）`);
    return result.stdout.toString().trim();
  };
  const snapshot = () => {
    const raw = ssh(read);
    if (!raw) return undefined;
    try {
      const { at, ok, synced, unchanged, pruned, failed, error } = JSON.parse(raw) as Record<
        string,
        unknown
      >;
      if (
        typeof at === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) &&
        typeof ok === 'boolean' &&
        names(synced) &&
        names(unchanged) &&
        names(pruned) &&
        names(failed)
      )
        return {
          at,
          summary: { ok, synced, unchanged, pruned, failed, error: ok ? null : knownError(error) },
        };
    } catch {
      /* 无效回执统一报错。 */
    }
    throw new Error('同步回执格式无效');
  };
  try {
    const previous = dryRun ? undefined : snapshot()?.at;
    ssh(`/bin/launchctl ${dryRun ? 'print' : 'kickstart -k'} "${job}" || exit 69`);
    if (dryRun) return emptySummary(null);
    for (;;) {
      const next = snapshot();
      if (next && next.at !== previous) return next.summary;
      Bun.sleepSync(Math.max(0, Math.min(1000, end - Date.now())));
    }
  } catch (error) {
    return emptySummary((error as Error).message);
  }
}
