import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const providers = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const updatedAt = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
let stop;

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function refreshCache(signal) {
  const home = process.env.HOME || homedir();
  const root = resolve(process.env.SUPERAGENT_HOME || join(home, '.superagent'));
  const file = join(root, 'relay-quota.json');
  const previous = number((await readCache(file))?.at);
  if (signal.aborted) return undefined;
  const started = Date.now();

  try {
    // The installed shim owns secret injection. Give it the GUI's missing Bun/system paths.
    const { stdout } = await exec(join(home, '.local', 'bin', 'superagent'), ['quota'], {
      cwd: '/',
      env: {
        HOME: home,
        PATH: [
          join(home, '.bun/bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(delimiter),
        SUPERAGENT_HOME: root,
        SUPERAGENT_RELAY_QUOTA_URL: 'https://api.toagent.io',
        SUPERAGENT_RELAY_QUOTA: process.env.SUPERAGENT_RELAY_QUOTA === 'off' ? 'off' : undefined,
      },
      signal,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    });
    // quota exits zero even when disabled or unavailable. Another command can update the cache meanwhile.
    const receipt = stdout.trim();
    if (!receipt || receipt.startsWith('中转余量：未知（')) return undefined;
  } catch {
    return undefined;
  }

  const cache = await readCache(file);
  const at = number(cache?.at);
  if (at === undefined || at < started || at === previous || at > Date.now()) return undefined;
  return cache;
}

function statusItem(id, label, cache) {
  const pool = cache?.[id];
  const cost =
    number(pool?.today?.cost) ?? (id === 'claude' ? number(cache?.claude_daily_usd) : undefined);
  const fiveHour = number(pool?.five_hour?.remaining_pct);
  const sevenDay = number(pool?.seven_day?.remaining_pct);
  const available = number(pool?.accounts_available);
  const total = number(pool?.accounts_total);
  const details = [
    cost === undefined ? '' : `$${cost.toFixed(2)}`,
    fiveHour === undefined ? '' : `5h ${percent.format(fiveHour)}%`,
    sevenDay === undefined ? '' : `7d ${percent.format(sevenDay)}%`,
    available === undefined || total === undefined ? '' : `${available}/${total}`,
  ].filter(Boolean);
  const exhausted =
    pool?.level === 'exhausted' ||
    (available === 0 && total > 0) ||
    fiveHour === 0 ||
    sevenDay === 0;
  const tone = exhausted ? 'danger' : pool?.level === 'low' ? 'warning' : 'neutral';
  const text = `${label} ${details.join(' ') || '未知'}`;
  const updated = cache ? `更新于 ${updatedAt.format(cache.at)}` : '用量未知';
  return { id, text, tone, tooltip: `${text}\n${updated} · 点击刷新` };
}

export default function activate(orca) {
  const controller = new AbortController();
  let inFlight;
  const publish = async () => {
    const cache = await refreshCache(controller.signal);
    if (controller.signal.aborted) return;
    await Promise.allSettled(
      Object.entries(providers).map(async ([id, label]) =>
        orca.host.call('statusBar.update', statusItem(id, label, cache))
      )
    );
  };
  const refresh = () => {
    if (controller.signal.aborted) return;
    inFlight ??= publish().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  orca.commands.register('refresh', refresh);
  const timer = setInterval(() => void refresh(), 5 * 60_000);
  stop = () => {
    clearInterval(timer);
    controller.abort();
  };
  void refresh();
}

export function deactivate() {
  stop?.();
  stop = undefined;
}
