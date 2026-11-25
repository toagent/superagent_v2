import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixtureTiersEnv, tmp } from './helpers';
// prettier-ignore
test('relay-quota: passive HTTP, thresholds, omissions, failures, disabled and once per phase', async () => {
  let status = 200, calls = 0, cost = 41.37, level = 'ok', stall = false;
  let gemini: Record<string, unknown> | undefined = { today: { cost: 12.34 }, level: 'ok', accounts_available: 2, accounts_total: 2 };
  const dir = tmp(), source = join(import.meta.dir, '../src/relay-quota.ts');
  const server = Bun.serve({ port: 0, fetch(req) { calls++; expect(new URL(req.url).pathname).toBe('/api/v1/toagent/relay-quota'); expect(req.headers.has('authorization')).toBe(true); return stall ? new Promise<Response>(() => {}) : Response.json({ platforms: { anthropic: { today: { cost }, level, accounts_available: 3, accounts_total: 4, five_hour: { remaining_pct: 58 }, seven_day: { remaining_pct: null } }, openai: { today: { cost: 600 }, five_hour: null }, ...(gemini ? { gemini } : {}) } }, { status }); } });
  const query = async (env = {}, token = 'synthetic', cache?: string, stage = 'start') => {
    const child = Bun.spawn([process.execPath, '-e', `import {relayQuota} from ${JSON.stringify(source)}; console.log(JSON.stringify(relayQuota(${JSON.stringify(cache)},${JSON.stringify(stage)},()=>${JSON.stringify(token)})));`], { env: { ...process.env, ...fixtureTiersEnv(), SUPERAGENT_HOME: dir, SUPERAGENT_RELAY_QUOTA_URL: server.url.origin, SUPERAGENT_RELAY_QUOTA: '', ...env }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()) as { quota?: string };
  };
  try {
    for (const [value, warning] of [[41.37, 'Claude $41.37'], [250, 'Claude 中等'], [350, '⛔ 今日应停用 Claude']] as const) { cost = value; const { quota = '' } = await query(); expect(quota).toContain(warning); expect(quota).toContain('⚠️ Codex 超 $500'); expect(quota).toContain('5h:58%'); expect(quota).toContain('Gemini $12.34 (2/2)'); expect(quota).not.toContain('7d'); expect(quota).not.toContain('synthetic'); expect(quota.length).toBeLessThanOrEqual(120); }
    expect(JSON.parse(readFileSync(join(dir, 'relay-quota.json'), 'utf8'))).toMatchObject({ claude_daily_usd: 350, at: expect.any(Number), claude: { today: { cost: 350 }, level: 'ok', accounts_available: 3, accounts_total: 4, five_hour: { remaining_pct: 58 }, seven_day: { remaining_pct: null } }, codex: { today: { cost: 600 }, five_hour: null }, gemini: { today: { cost: 12.34 }, level: 'ok', accounts_available: 2, accounts_total: 2 } });
    for (const [value, warning] of [['low', '⚠️ 中转余量偏低'], ['exhausted', '⛔ 余量耗尽']]) { level = value!; expect((await query()).quota).toContain(warning!); }
    level = 'ok'; gemini = { today: { cost: 0 }, level: 'exhausted', accounts_available: 0, accounts_total: 0 };
    expect((await query()).quota).not.toContain('⛔ 余量耗尽');
    gemini = undefined; const legacy = await query(); expect(legacy.quota).not.toContain('Gemini');
    expect('gemini' in JSON.parse(readFileSync(join(dir, 'relay-quota.json'), 'utf8'))).toBe(false);
    const first = await query({}, 'synthetic', dir); expect(await query({}, 'synthetic', dir)).toEqual(first); expect(JSON.parse(readFileSync(join(dir, 'relay-quota.start.json'), 'utf8'))).toEqual(first);
    const before = calls; expect(await query({ SUPERAGENT_RELAY_QUOTA_URL: '' })).toEqual({}); expect(await query({ SUPERAGENT_RELAY_QUOTA: 'off' })).toEqual({}); expect((await query({}, '')).quota).toBe('中转余量：未知（no-token）'); expect(calls).toBe(before);
    status = 401; expect((await query({}, 'synthetic', dir, 'end')).quota).toBe('中转余量：未知（401）'); stall = true; expect((await query()).quota).toBe('中转余量：未知（timeout）');
  } finally { server.stop(true); }
});
// prettier-ignore
test('relay-quota: 3-platform compact line and zero-account alert suppression', async () => {
  let platforms: Record<string, unknown> = { anthropic: { today: { cost: 415.65 }, level: 'ok', accounts_available: 1, accounts_total: 1 }, openai: { today: { cost: 250.03 }, level: 'ok', five_hour: { remaining_pct: 100 }, seven_day: { remaining_pct: 63 }, accounts_available: 2, accounts_total: 2 }, gemini: { today: { cost: 12.34 }, level: 'ok', accounts_available: 2, accounts_total: 2 } };
  const dir = tmp(), source = join(import.meta.dir, '../src/relay-quota.ts');
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ platforms }) });
  const query = async () => { const child = Bun.spawn([process.execPath, '-e', `import {relayQuota} from ${JSON.stringify(source)}; console.log(JSON.stringify(relayQuota(undefined,'start',()=>'t')));`], { env: { ...process.env, ...fixtureTiersEnv(), SUPERAGENT_HOME: dir, SUPERAGENT_RELAY_QUOTA_URL: server.url.origin, SUPERAGENT_RELAY_QUOTA: '' }, stdout: 'pipe', stderr: 'pipe' }); expect(await child.exited).toBe(0); return JSON.parse(await new Response(child.stdout).text()) as { quota?: string }; };
  try {
    expect((await query()).quota).toBe('⛔ 今日应停用 Claude · Claude $415.65 (1/1) | Codex $250.03 5h:100% 7d:63% (2/2) | Gemini $12.34 (2/2)');
    platforms = { anthropic: { today: { cost: 10 }, level: 'ok', accounts_available: 1, accounts_total: 1 }, openai: { today: { cost: 20 }, level: 'ok', five_hour: { remaining_pct: 100 }, seven_day: { remaining_pct: 63 }, accounts_available: 2, accounts_total: 2 }, gemini: { today: { cost: 12.34 }, level: 'low', accounts_available: 0, accounts_total: 0 } };
    expect((await query()).quota).toBe('Claude $10.00 (1/1) | Codex $20.00 5h:100% 7d:63% (2/2) | Gemini $12.34 (0/0)');
    platforms.gemini = { today: { cost: 12.34 }, level: 'low' };
    expect((await query()).quota).toContain('⚠️ 中转余量偏低');
  } finally { server.stop(true); }
});
