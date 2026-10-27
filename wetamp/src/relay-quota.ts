import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTiers, routeState, writeAtomic } from './config';
export function refreshBudgetQuota(): void {
  const tiers = loadTiers();
  const budget = () =>
    routeState(tiers, 'auto', Date.now(), { state: 'up', probe_failures: 0 }).budget;
  if (!budget().unknown) return;
  relayQuota();
  if (budget().unknown) console.error('预算状态未知');
}
// prettier-ignore
interface Pool { today?: { cost?: number }; level?: string; accounts_available?: number; accounts_total?: number; five_hour?: { remaining_pct?: number }; seven_day?: { remaining_pct?: number } }
const unknown = (why: string) => ({ quota: `中转余量：未知（${why}）` });
const numeric = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
// prettier-ignore
export function relayQuota(dir?: string, stage: 'start' | 'end' = 'start',
  readToken = () => spawnSync('security', ['find-generic-password', '-s', 'toagent-relay-quota', '-w'],
    { timeout: 200, stdio: ['ignore', 'pipe', 'ignore'] }).output[1]?.toString().trim()): { quota?: string } {
  const url = process.env.SUPERAGENT_RELAY_QUOTA_URL;
  if (!url || process.env.SUPERAGENT_RELAY_QUOTA === 'off') return {};
  const path = dir && `${dir}/relay-quota.${stage}.json`, started = Date.now(); let result = unknown('network');
  try {
    if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as { quota: string };
    // Reserve each run/phase before I/O: concurrent waiters must not repeat the request.
    if (path) writeFileSync(path, JSON.stringify(result), { flag: 'wx' });
    const token = readToken();
    if (!token || /[\r\n"\\]/.test(token)) result = unknown('no-token');
    else {
      const ms = Math.max(1, 3000 - (Date.now() - started));
      // Pass the header through stdin, never argv; curl errors and response prose stay private.
      const p = spawnSync('curl', ['--disable', '--silent', '--max-time', String(ms / 1000), '--config', '-', '--write-out', '\n%{http_code}',
        '--url', `${url.replace(/\/$/, '')}/api/v1/toagent/relay-quota`], { input: `header = "Authorization: Bearer ${token}"\n`, timeout: ms, maxBuffer: 1024 * 1024 });
      const body = p.output[1]?.toString() ?? '', code = body.slice(-3);
      if (p.status !== 0) result = unknown(p.status === 28 || p.signal === 'SIGTERM' ? 'timeout' : 'network');
      else if (code !== '200') result = unknown(/^\d{3}$/.test(code) ? code : 'network');
      else {
        const data = JSON.parse(body.slice(0, -4)) as { platforms?: Record<string, Pool> }; const pools = [data.platforms?.anthropic, data.platforms?.openai];
        const [claude, codex] = pools.map(p => p?.today?.cost);
        const limits = loadTiers().routing.budget;
        try { if (numeric(claude) && process.env.SUPERAGENT_HOME) writeAtomic(join(process.env.SUPERAGENT_HOME, 'relay-quota.json'), JSON.stringify({ at: Date.now(), claude_daily_usd: claude })); } catch { /* Cache write failures remain advisory. */ }
        const alerts = [
          numeric(claude) && (claude >= limits.claude_daily_usd ? '⛔ 今日应停用 Claude' : claude >= limits.claude_medium_usd ? 'Claude 中等' : ''),
          numeric(codex) && codex >= limits.codex_warning_usd && `⚠️ Codex 超 $${String(limits.codex_warning_usd)}`,
          pools.some(p => p?.level === 'exhausted') ? '⛔ 余量耗尽' : pools.some(p => p?.level === 'low') && '⚠️ 中转余量偏低'].filter(Boolean).join(' · ');
        const parts = pools.map((p, i) => p && [
          `${i ? 'Codex' : 'Claude'}${numeric(p.today?.cost) ? ` 今日 $${p.today.cost.toFixed(2)}` : ''}`,
          ...[['5h', p.five_hour?.remaining_pct], ['7d', p.seven_day?.remaining_pct]].map(([w, n]) => numeric(n) ? `${String(w)} 余 ${String(n)}%` : ''),
          numeric(p.accounts_available) && numeric(p.accounts_total) ? `（${String(p.accounts_available)}/${String(p.accounts_total)} 可用）` : ''].filter(Boolean)).filter(p => !!p);
        if (parts.length) for (let keep = 4; keep >= 1; keep--) {
          result = { quota: [alerts, parts.map(p => p.slice(0, keep).join(' · ')).join(' | ')].filter(Boolean).join(' · ') };
          if (result.quota.length <= 120) break;
        }
      }
    }
  } catch { /* Quota is advisory; neither transport nor artifact errors may fail a run. */ }
  result.quota = result.quota.slice(0, 120);
  try { if (path) writeFileSync(path, JSON.stringify(result)); } catch { /* Read-only/full run directories remain non-fatal. */ }
  return result;
}
