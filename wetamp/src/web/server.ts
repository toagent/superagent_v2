import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { getSourceWebDistDir } from '../../../packages/paths/src/archon-paths';
import { home, WETAMP, writeAtomic } from '../config';
import { engineHash } from '../generate';
import { lock } from '../archon';
import { alive } from '../jobs';
import { createLoader, type Snapshot } from '../board/data';
import { requestUsageRefresh } from '../usage';
import { cockpit } from '../board/cockpit';
import { parseArgs } from '../cli';

interface LegacyWebState { port: number; pid: number; token: string; started_at: string }
export interface WebState extends LegacyWebState { server_pid: number; internal_port: number; engine_hash: string }
type ConsoleState = WebState | LegacyWebState;
const stateFile = (): string => join(home().sa, 'web.json');
export function webState(): ConsoleState | null { try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as ConsoleState; } catch { return null; } }
export const webUrl = (s: ConsoleState): string => `http://127.0.0.1:${String(s.port)}/console?t=${s.token}`;
const serverArgs = (port: number): string[] => ['--no-env-file', join(WETAMP, 'src/web/archon.ts'), String(port)];
function owned(pid: number, args: string[]): boolean {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() === [process.execPath, ...args].join(' '); } catch { return false; }
}
const proxyArgs = [join(WETAMP, 'src/cli.ts'), 'console', 'serve'];
const residentPids = (s: ConsoleState): number[] => 'server_pid' in s ? [s.pid, s.server_pid] : [s.pid];
// The previous web command recorded only its own PID; migrate it through the same checked stop path.
const ownedState = (s: ConsoleState): boolean => (!alive(s.pid) || owned(s.pid, proxyArgs) || owned(s.pid, [join(WETAMP, 'src/cli.ts'), 'web', 'serve'])) && (!('server_pid' in s) || !alive(s.server_pid) || owned(s.server_pid, serverArgs(s.internal_port)));
export const needsRestart = (s: ConsoleState, current = engineHash()): boolean => !('engine_hash' in s) || s.engine_hash !== current || residentPids(s).some(pid => !alive(pid));
/** Detached console children receive no ambient credentials or adapter settings. */
export function consoleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  // A millennium keeps current recovery handles without overflowing SQLite's datetime range.
  return { ...env, SUPERAGENT_HOME: home().sa, ARCHON_HOME: home().archon, HOST: '127.0.0.1', NODE_ENV: 'production', ARCHON_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', STALE_THRESHOLD_DAYS: '365000', SESSION_RETENTION_DAYS: '365000' };
}
/** No prompts, errors, artifact paths or terminal metadata enter the supplementary panel. */
export function overview(s: Snapshot): Record<string, unknown> {
  const c = cockpit(s, Date.parse(s.at));
  return { at: s.at, metrics: c.metrics, roleTokens: c.roleTokens, runs: c.runs.map(r => ({ project: r.project, title: r.title, role: r.role, tokens: r.tokens, state: r.state })) };
}
const panel = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>superagent</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:16px}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}</style><a href="/console">Archon 控制台</a><p id="metrics"></p><p id="roles"></p><table><thead><tr><th>项目</th><th>任务</th><th>角色·模型</th><th>token</th><th>状态</th></tr></thead><tbody id="runs"></tbody></table><p id="status"></p><script>async function refresh(){try{const r=await fetch('/sa/data');if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();document.getElementById('metrics').textContent='今日达成 '+d.metrics.completed+'/'+d.metrics.decided;document.getElementById('roles').textContent=d.roleTokens.join(' · ');document.getElementById('runs').replaceChildren(...d.runs.map(x=>{const tr=document.createElement('tr');for(const k of ['project','title','role','tokens','state']){const td=document.createElement('td');td.textContent=x[k];tr.append(td)}return tr}));document.getElementById('status').textContent=d.at}catch(e){document.getElementById('status').textContent='数据未更新：'+e.message}}refresh();setInterval(refresh,5000)</script></html>`;
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function handler(port: number, token: string, get: () => Record<string, unknown>, upstream: string, forward: typeof fetch = fetch): (r: Request) => Promise<Response> {
  return async r => {
    const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };
    const respond = (body: string, status: number, type = 'text/plain'): Response => new Response(r.method === 'HEAD' ? null : body, { status, headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` } });
    if (![ `127.0.0.1:${String(port)}`, `localhost:${String(port)}` ].includes(r.headers.get('host') ?? '')) return respond('Forbidden', 403);
    if (!['GET', 'HEAD'].includes(r.method)) return respond('写操作请用 superagent decide 或 Mac 提醒', 403);
    const url = new URL(r.url), supplied = url.searchParams.get('t'), cookie = /(?:^|;\s*)sa_web=([^;]*)/.exec(r.headers.get('cookie') ?? '')?.[1];
    if (!(supplied && same(supplied, token)) && !(cookie && same(cookie, token))) return respond('Unauthorized', 401);
    if (supplied && same(supplied, token)) headers['Set-Cookie'] = `sa_web=${token}; HttpOnly; SameSite=Strict; Path=/`;
    if (url.pathname === '/sa') return respond(panel, 200, 'text/html');
    if (url.pathname === '/sa/data') return respond(JSON.stringify(get()), 200, 'application/json');
    if (url.pathname === '/api/overview') return respond('Not Found', 404);
    url.searchParams.delete('t');
    try {
      const target = new URL(upstream); target.pathname = url.pathname; target.search = url.search;
      const pass = new Headers(); for (const key of ['accept', 'last-event-id', 'range']) { const value = r.headers.get(key); if (value) pass.set(key, value); }
      const response = await forward(target, { method: r.method, headers: pass, signal: r.signal, redirect: 'manual' });
      const result = new Headers(response.headers); for (const [key, value] of Object.entries(headers)) result.set(key, value);
      if (r.method !== 'HEAD' && response.headers.get('content-type')?.includes('text/html')) {
        const html = (await response.text()).replace('</body>', '<a href="/sa" style="position:fixed;right:12px;bottom:12px;z-index:9999">superagent 角色·模型·token</a></body>');
        result.delete('content-length'); result.delete('content-encoding');
        return new Response(html, { status: response.status, headers: result });
      }
      return new Response(r.method === 'HEAD' ? null : response.body, { status: response.status, headers: result });
    } catch { return respond('Archon console unavailable', 502); }
  };
}
export async function ensureWebDist(hash = engineHash()): Promise<void> {
  const dist = getSourceWebDistDir(), stamp = join(dist, '.superagent-engine');
  if (existsSync(join(dist, 'index.html')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return;
  const p = Bun.spawn([process.execPath, 'run', 'build:web'], { cwd: join(WETAMP, '..'), env: consoleEnv(), stdout: 'ignore', stderr: 'inherit', timeout: 90000 });
  if (await p.exited !== 0) throw new Error('build:web failed');
  writeFileSync(stamp, hash);
}
async function serve(): Promise<void> {
  mkdirSync(home().sa, { recursive: true });
  const held = lock(join(home().sa, 'web.lock')); if (!held.ok) throw new Error('console already running');
  let server: ReturnType<typeof Bun.serve> | undefined, child: ReturnType<typeof spawn> | undefined;
  const token = randomBytes(32).toString('hex'), hash = engineHash(), load = createLoader();
  let snapshot: Snapshot = { summary: {}, rows: [], at: new Date().toISOString() }, busy = false, timer: ReturnType<typeof setInterval> | undefined;
  const update = async (): Promise<void> => { if (busy) return; busy = true; try { snapshot = await load(Number.MAX_SAFE_INTEGER); requestUsageRefresh(); } finally { busy = false; } };
  try {
    await ensureWebDist(hash);
    const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }), internal = reserve.port; await reserve.stop(true);
    if (!internal) throw new Error('no internal port');
    const fd = openSync(join(home().sa, 'console.log'), 'a', 0o600);
    try { child = spawn(process.execPath, serverArgs(internal), { cwd: home().sa, stdio: ['ignore', fd, fd], env: consoleEnv() }); } finally { closeSync(fd); }
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error('Archon server failed; see console.log');
      try { if ((await fetch(`http://127.0.0.1:${String(internal)}/console`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* Wait for native boot/migrations. */ }
      if (i === 299) throw new Error('Archon server startup timeout'); await Bun.sleep(100);
    }
    for (let port = 39890; port < 39990; port++) {
      try { server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler(port, token, () => overview(snapshot), `http://127.0.0.1:${String(internal)}`) }); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; }
    }
    if (!server || !child.pid) throw new Error('no free console port');
    const state: WebState = { port: server.port ?? 0, pid: process.pid, server_pid: child.pid, internal_port: internal, token, started_at: new Date().toISOString(), engine_hash: hash };
    writeAtomic(stateFile(), JSON.stringify(state));
    timer = setInterval(() => { void update().catch(() => { /* Keep the previous snapshot; visible timestamp remains unchanged. */ }); }, 5000); void update().catch(() => { /* The initial timestamp exposes an unavailable snapshot. */ });
    await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); child?.once('exit', () => { resolve(); }); });
  } finally {
    if (timer) clearInterval(timer); if (server) await server.stop(true);
    if (child?.pid && alive(child.pid) && owned(child.pid, serverArgs(Number(child.spawnargs.at(-1))))) { child.kill('SIGTERM'); await new Promise<void>(resolve => { child?.once('exit', () => { resolve(); }); }); }
    if (webState()?.pid === process.pid) unlinkSync(stateFile()); held.release();
  }
}
export async function stopWeb(s = webState()): Promise<void> {
  if (!s) return; if (!ownedState(s)) throw new Error('console owner ambiguous; refusing to stop');
  const pids = residentPids(s);
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 300 && pids.some(alive); i++) await Bun.sleep(50);
  if (pids.some(alive)) throw new Error('console still stopping');
  if (webState()?.pid === s.pid) unlinkSync(stateFile());
}
export async function startWeb(): Promise<WebState> {
  mkdirSync(home().sa, { recursive: true });
  const guard = lock(join(home().sa, 'web-start.lock'));
  if (!guard.ok) throw new Error('console startup already pending');
  try {
    const old = webState();
    if (old) { if (!ownedState(old)) throw new Error('console owner ambiguous; refusing'); if ('server_pid' in old && !needsRestart(old)) return old; await stopWeb(old); }
    const p = spawn(process.execPath, proxyArgs, { detached: true, stdio: 'ignore', cwd: home().sa, env: consoleEnv() }); p.unref();
    for (let i = 0; i < 1200; i++) { await Bun.sleep(100); const s = webState(); if (s && 'server_pid' in s && s.pid === p.pid && ownedState(s)) return s; if (p.exitCode !== null) break; }
    if (p.pid && alive(p.pid) && owned(p.pid, proxyArgs)) process.kill(p.pid, 'SIGTERM');
    throw new Error('console startup failed; see console.log');
  } finally { guard.release(); }
}
export async function refreshConsole(restart = startWeb, current = engineHash()): Promise<ConsoleState | null> {
  const s = webState(); return s && residentPids(s).some(alive) && needsRestart(s, current) ? await restart() : s;
}
export async function webCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv), sub = a._[1];
  if (sub === 'serve') { await serve(); return 0; }
  if (sub === 'start') { const s = await startWeb(); console.log(JSON.stringify({ port: s.port, pid: s.pid, server_pid: s.server_pid, state: 'running' })); return 0; }
  if (sub === 'stop') { await stopWeb(); console.log('stopped'); return 0; }
  const s = await refreshConsole();
  if (sub === 'status') { console.log(JSON.stringify({ state: s && alive(s.pid) ? ownedState(s) ? 'running' : 'unknown' : 'stopped', port: s?.port, pid: s?.pid, server_pid: s && 'server_pid' in s ? s.server_pid : undefined })); return 0; }
  if (sub === 'url' && s && alive(s.pid) && ownedState(s)) { const url = webUrl(s); if (a.flags.open) return await Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' }).exited; console.log(url); return 0; }
  throw new Error('usage: superagent console start|stop|status|url [--open] (web is a compatibility alias)');
}
