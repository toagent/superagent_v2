import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleEnv, consoleStatus, handler, legacyPids, migrate, needsRestart, refreshConsole, stopWeb, type WebState } from '../src/web/server';
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
test('M2-07 fingerprint drift restarts the launchd console; current engine stays', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const s: WebState = { pid: process.pid, server_pid: process.pid, port: 39890, internal_port: 1234, token: 'fixture', started_at: new Date().toISOString(), engine_hash: 'old', socket: join(root, 'console/archon.sock'), label: 'fixture' };
  writeFileSync(join(root, 'web.json'), JSON.stringify(s)); let count = 0;
  const restart = async (): Promise<WebState> => { count++; return { ...s, engine_hash: 'new', socket: join(root, 'console/archon.sock'), label: 'fixture' }; };
  expect(needsRestart(s, 'old')).toBe(false); expect(needsRestart(s, 'new')).toBe(true);
  expect(await refreshConsole(restart, 'old')).toMatchObject({ engine_hash: 'old', socket: join(root, 'console/archon.sock'), label: 'fixture' }); expect(count).toBe(0);
  expect(await refreshConsole(restart, 'new')).toMatchObject({ engine_hash: 'new' }); expect(count).toBe(1);

});
test('M2-07 previous PID state requires migration; incomplete owner identity is refused', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  const legacy = { pid: process.pid, port: 39890, token: 'fixture', started_at: new Date().toISOString() };
  writeFileSync(join(root, 'web.json'), JSON.stringify(legacy));
  expect(needsRestart(legacy, 'new')).toBe(true);
  let count = 0;
  const migrated: WebState = { ...legacy, server_pid: process.pid, internal_port: 1234, engine_hash: 'new', socket: join(root, 'console/archon.sock'), label: 'fixture' };
  expect(await refreshConsole(async () => { count++; return migrated; }, 'new')).toEqual(migrated);
  expect(count).toBe(1); await expect(stopWeb(legacy)).rejects.toThrow('owner ambiguous');
});

// Same keys as the production record: no uid, label or socket.
function legacyFixture() {
  const s = { port: 39890, pid: 40805, server_pid: 40912, internal_port: 35480, token: 'fixture', started_at: '2026-10-10T10:06:52.922Z', engine_hash: 'd6e1a68c' };
  const rows = new Map([
    [s.pid, { uid: String(process.getuid?.()), ppid: '1', lstart: new Date(Date.parse(s.started_at) - 5900).toISOString(), command: `${process.execPath} ${join(WETAMP, 'src/cli.ts')} console serve` }],
    [s.server_pid, { uid: String(process.getuid?.()), ppid: String(s.pid), lstart: new Date(Date.parse(s.started_at) - 900).toISOString(), command: `${process.execPath} --no-env-file ${join(WETAMP, 'src/web/archon.ts')} ${String(s.internal_port)}` }],
  ]);
  const living = new Set(rows.keys());
  const ps: NonNullable<Parameters<typeof legacyPids>[1]> = (pid, field) => {
    const row = rows.get(pid); if (!row) throw new Error('unexpected ps read'); return row[field];
  };
  return { s, rows, living, ps, live: (pid: number) => living.has(pid) };
}
test('HF5c production-shaped record migrates only after both processes exit and clears its state', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, "archon");
  const { s, living, ps, live } = legacyFixture(), signals: number[] = [];
  writeFileSync(join(root, 'web.json'), JSON.stringify(s));
  expect(legacyPids(s, ps, live)).toEqual([s.pid, s.server_pid]);
  let waited = 0;
  await migrate(s, ps, live, pid => { signals.push(pid); }, async () => {
    expect(existsSync(join(root, 'web.json'))).toBe(true);
    expect(signals).toEqual([s.pid, s.server_pid]);
    if (++waited === 2) living.clear();
  });
  expect(waited).toBe(2); expect(existsSync(join(root, 'web.json'))).toBe(false);
});
for (const field of ['argv', 'uid', 'record uid', 'lstart', 'ppid', 'started_at']) {
  test(`HF5c refuses ${field} mismatch before sending any signal`, async () => {
    const { s, rows, ps, live } = legacyFixture();
    const proxy = rows.get(s.pid)!, server = rows.get(s.server_pid)!;
    if (field === 'argv') proxy.command += ' extra';
    if (field === 'uid') proxy.uid = String(Number(proxy.uid) + 1);
    if (field === 'lstart') proxy.lstart = new Date(Date.parse(s.started_at) + 3000).toUTCString();
    if (field === 'ppid') server.ppid = '1';
    if (field === 'started_at') s.started_at = 'invalid';
    const record = field === 'record uid' ? { ...s, uid: Number(proxy.uid) + 1 } : s;
    let signals = 0;
    await expect(migrate(record, ps, live, () => { signals++; })).rejects.toThrow(field === 'record uid' ? 'uid' : field);
    expect(signals).toBe(0);
  });
}
test('HF5c accepts recorded UID and earlier web serve argv, but rejects server argv drift', () => {
  const { s, rows, ps, live } = legacyFixture();
  rows.get(s.pid)!.command = `${process.execPath} ${join(WETAMP, 'src/cli.ts')} web serve`;
  expect(legacyPids({ ...s, uid: process.getuid?.() }, ps, live)).toEqual([s.pid, s.server_pid]);
  rows.get(s.server_pid)!.command += ' extra';
  expect(() => legacyPids(s, ps, live)).toThrow('argv');
});
test('HF5c skips dead PIDs and checks PPID only while both are alive; two dead PIDs are a no-op', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, "archon");
  const { s, rows, living, ps, live } = legacyFixture();
  living.delete(s.server_pid); rows.delete(s.server_pid);
  expect(legacyPids(s, ps, live)).toEqual([s.pid]);
  const onlyServer = legacyFixture(); onlyServer.living.delete(s.pid); onlyServer.rows.delete(s.pid);
  onlyServer.rows.get(s.server_pid)!.ppid = '1';
  expect(legacyPids(s, onlyServer.ps, onlyServer.live)).toEqual([s.server_pid]);
  living.clear(); rows.clear(); s.started_at = 'invalid';
  writeFileSync(join(root, 'web.json'), JSON.stringify(s));
  await migrate(s, ps, live, () => { throw new Error('unexpected signal'); });
  expect(existsSync(join(root, 'web.json'))).toBe(false);
});
test('HF5c times out after 15 seconds of polling without escalating SIGTERM or removing state', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, "archon");
  const { s, ps, live } = legacyFixture(), signals: number[] = [];
  writeFileSync(join(root, 'web.json'), JSON.stringify(s));
  let elapsed = 0;
  await expect(migrate(s, ps, live, pid => { signals.push(pid); }, async ms => { elapsed += Number(ms); })).rejects.toThrow('legacy console still stopping');
  expect(elapsed).toBe(15000); expect(signals).toEqual([s.pid, s.server_pid]);
  expect(existsSync(join(root, 'web.json'))).toBe(true);
});
test('HF5c rechecks identity before each signal and preserves a replacement state', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, "archon");
  const { s, rows, living, ps, live } = legacyFixture();
  let signals = 0, reads = 0;
  await expect(migrate(s, (pid, field) => {
    if (++reads === 8) rows.get(s.pid)!.command += ' changed';
    return ps(pid, field);
  }, live, () => { signals++; })).rejects.toThrow('argv');
  expect(signals).toBe(0);
  rows.get(s.pid)!.command = `${process.execPath} ${join(WETAMP, 'src/cli.ts')} console serve`;
  const replacement: WebState = { ...s, label: 'fixture', socket: 'fixture' };
  await migrate(s, ps, live, pid => { living.delete(pid); writeFileSync(join(root, 'web.json'), JSON.stringify(replacement)); });
  expect(existsSync(join(root, 'web.json'))).toBe(true);
});
test('HF5c status exposes legacy ownership when launchd is absent, including orphaned server', () => {
  const { s, living, live } = legacyFixture();
  expect(consoleStatus(s, false, live)).toEqual({ state: 'legacy', pid_alive: true, server_pid_alive: true });
  living.delete(s.pid);
  expect(consoleStatus(s, false, live)).toEqual({ state: 'legacy', pid_alive: false, server_pid_alive: true });
  living.clear(); expect(consoleStatus(s, false, live).state).toBe('stopped');
  expect(consoleStatus(s, true, live).state).toBe('starting');
  expect(consoleStatus(null, false, live).state).toBe('stopped');
});
