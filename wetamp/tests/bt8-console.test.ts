import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleEnv, handler, needsRestart, refreshConsole, stopWeb, type WebState } from '../src/web/server';
import { WETAMP } from '../src/config';
import { tmp } from './helpers';
const saved = { ...process.env };
afterEach(() => { for (const k of ['SUPERAGENT_HOME', 'ARCHON_HOME', 'HOST', 'DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'NODE_OPTIONS']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const request = (path: string, method = 'GET', headers: Record<string, string> = {}): Request => new Request(`http://127.0.0.1:39890${path}`, { method, headers: { host: '127.0.0.1:39890', ...headers } });
test('proxy retains Host/token gates; all mutations return 403 without reaching Archon', async () => {
  let calls = 0;
  const forward: typeof fetch = Object.assign(async () => { calls++; return new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } }); }, { preconnect: () => {} });
  const get = handler(39890, 'fixture', () => ({ safe: true }), 'http://127.0.0.1:1234', forward);
  expect((await get(request('/console?t=fixture', 'GET', { host: 'evil.test' }))).status).toBe(403);
  expect((await get(request('/console'))).status).toBe(401);
  expect((await get(request('/console?t=wrong'))).status).toBe(401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const denied = await get(request('/api/workflows/runs/r/approve?t=fixture', method));
    expect(denied.status).toBe(403); expect(await denied.text()).toContain('superagent decide');
  }
  expect(calls).toBe(0);
  const page = await get(request('/console?t=fixture'));
  expect(page.status).toBe(200); expect(page.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  expect(page.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(await page.text()).toContain('href="/sa"');
  expect((await get(request('/sa', 'GET', { cookie: 'sa_web=fixture' }))).status).toBe(200);
  expect(await (await get(request('/sa/data?t=fixture'))).json()).toEqual({ safe: true });
  expect((await get(request('/api/overview?t=fixture'))).status).toBe(404);
  expect(await (await get(request('/sa?t=fixture', 'HEAD'))).text()).toBe('');
});
test('SSE stays streamed and forwarding drops proxy token, cookies and arbitrary headers', async () => {
  let seenUrl = '', seenHeaders = new Headers();
  const forward: typeof fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
    seenUrl = String(url); seenHeaders = new Headers(options?.headers);
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { preconnect: () => {} });
  const get = handler(39890, 'fixture', () => ({}), 'http://127.0.0.1:1234', forward);
  const response = await get(request('/api/stream/dashboard?t=fixture&since=1', 'GET', { cookie: 'sa_web=fixture', authorization: 'synthetic', 'last-event-id': '2' }));
  expect(seenUrl).toBe('http://127.0.0.1:1234/api/stream/dashboard?since=1'); expect(seenHeaders.has('cookie')).toBe(false); expect(seenHeaders.has('authorization')).toBe(false); expect(seenHeaders.get('last-event-id')).toBe('2');
  const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: ready\n\n'); await reader.cancel();
});
test('whitelisted child environment keeps native home while discarding adapters, DSN and runtime injection', () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  Object.assign(process.env, { HOST: '0.0.0.0', DATABASE_URL: 'synthetic', TELEGRAM_BOT_TOKEN: 'synthetic', SLACK_BOT_TOKEN: 'synthetic', NODE_OPTIONS: 'synthetic' });
  const env = consoleEnv(); expect(env.HOST).toBe('127.0.0.1'); expect(env.ARCHON_HOME).toBe(join(root, 'archon'));
  for (const key of ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'NODE_OPTIONS']) expect(key in env).toBe(false);
});
test('observer loader blocks native dotenv reload, including override:true in ARCHON_HOME', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  mkdirSync(process.env.ARCHON_HOME);
  writeFileSync(join(process.env.ARCHON_HOME, '.env'), 'HOST=0.0.0.0\nDATABASE_URL=synthetic\nTELEGRAM_BOT_TOKEN=synthetic\n');
  const code = 'const { observerEnv } = await import(process.argv[1]); observerEnv(); const { loadArchonEnv } = await import(process.argv[2]); loadArchonEnv(process.cwd()); console.log(JSON.stringify({ host: process.env.HOST, dsn: !!process.env.DATABASE_URL, adapter: !!process.env.TELEGRAM_BOT_TOKEN }));';
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code, join(WETAMP, 'src/web/archon.ts'), join(WETAMP, '../packages/paths/src/env-loader.ts')], { cwd: root, env: consoleEnv(), stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0); expect(JSON.parse(out)).toEqual({ host: '127.0.0.1', dsn: false, adapter: false });
});
test('fingerprint drift restarts both resident processes through the existing lifecycle; current engine stays', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const s: WebState = { pid: process.pid, server_pid: process.pid, port: 39890, internal_port: 1234, token: 'fixture', started_at: new Date().toISOString(), engine_hash: 'old' };
  writeFileSync(join(root, 'web.json'), JSON.stringify(s)); let count = 0;
  const restart = async (): Promise<WebState> => { count++; return { ...s, engine_hash: 'new' }; };
  expect(needsRestart(s, 'old')).toBe(false); expect(needsRestart(s, 'new')).toBe(true);
  expect(await refreshConsole(restart, 'old')).toMatchObject({ engine_hash: 'old' }); expect(count).toBe(0);
  expect(await refreshConsole(restart, 'new')).toMatchObject({ engine_hash: 'new' }); expect(count).toBe(1);
  await expect(stopWeb(s)).rejects.toThrow('owner ambiguous'); // Never signal this unowned test process.
});
test('previous web state has no fingerprint and migrates; unknown owners are still refused', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const legacy = { pid: process.pid, port: 39890, token: 'fixture', started_at: new Date().toISOString() };
  writeFileSync(join(root, 'web.json'), JSON.stringify(legacy));
  expect(needsRestart(legacy, 'new')).toBe(true);
  let count = 0;
  const migrated: WebState = { ...legacy, server_pid: process.pid, internal_port: 1234, engine_hash: 'new' };
  expect(await refreshConsole(async () => { count++; return migrated; }, 'new')).toEqual(migrated);
  expect(count).toBe(1); await expect(stopWeb(legacy)).rejects.toThrow('owner ambiguous');
});
