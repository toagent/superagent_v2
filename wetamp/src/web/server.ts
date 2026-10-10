import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { home, WETAMP, writeAtomic } from '../config';
import { engineHash } from '../generate';
import { lock } from '../archon';
import { alive } from '../jobs';
import { createLoader, type Snapshot } from '../board/data';
import { fmtTokens, requestUsageRefresh } from '../usage';
import { cockpit } from '../board/cockpit';
import { parseArgs } from '../cli';
import { homedir } from 'node:os';

interface LegacyWebState { port: number; pid: number; token: string; started_at: string; uid?: number; server_pid?: number; internal_port?: number }
export interface WebState extends LegacyWebState { engine_hash: string; socket: string; label: string }
type ConsoleState = WebState | LegacyWebState;
const stateFile = (): string => join(home().sa, 'web.json');
export function webState(): ConsoleState | null { try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as ConsoleState; } catch { return null; } }
export const webUrl = (s: ConsoleState): string => `http://127.0.0.1:${String(s.port)}/console?t=${s.token}`;
const label = (): string => process.env.SA_CONSOLE_LABEL ?? 'com.wetamp.superagent-console';
const domain = (): string => `gui/${String(process.getuid?.())}`;
const job = (): string => `${domain()}/${label()}`;
const launch = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = (): boolean => launch('print', job()).status === 0;
export const needsRestart = (s: ConsoleState, current = engineHash()): boolean => !('engine_hash' in s) || s.engine_hash !== current;
// Legacy migration alone uses PID identity; incomplete records fail closed.
function migrate(s: ConsoleState): void {
  if ('label' in s) return;
  const check = (pid: number): void => {
    const uid = execFileSync('ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf8' }).trim();
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    const argv = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    const expected = pid === s.pid ? [process.execPath, join(WETAMP, 'src/cli.ts'), 'console', 'serve'].join(' ') : [process.execPath, '--no-env-file', join(WETAMP, 'src/web/archon.ts'), String(s.internal_port)].join(' ');
    if (s.uid !== Number(uid) || Number(uid) !== process.getuid?.() || !Number.isFinite(Date.parse(s.started_at)) || !Number.isFinite(Date.parse(started)) || Math.abs(Date.parse(started) - Date.parse(s.started_at)) >= 1000 || argv !== expected) throw new Error('console owner ambiguous; legacy PID migration refused');
  };
  const pids = [...new Set([s.pid, s.server_pid].filter((p): p is number => p !== undefined && alive(p)))];
  for (const pid of pids) check(pid);
  for (const pid of pids) if (alive(pid)) { check(pid); process.kill(pid, 'SIGTERM'); }
}
/** Detached console children receive no ambient credentials or adapter settings. */
export function consoleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TZ', 'SA_CONSOLE_LABEL', 'SA_LAUNCHD_DIR', 'SA_CONSOLE_PORT', 'SA_CONSOLE_WEB_DIST']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, SUPERAGENT_HOME: home().sa, ARCHON_HOME: home().archon, HOST: '127.0.0.1', NODE_ENV: 'production', ARCHON_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
}
/** Panel data is a projection of cockpit, never a separate collector. */
export function overview(s: Snapshot) {
  const now = Date.parse(s.at), c = cockpit(s, now), day = new Date(now).toLocaleDateString('sv-SE');
  const today = new Set(s.rows.filter(r => Date.parse(r.started_at) <= now && new Date(r.started_at).toLocaleDateString('sv-SE') === day).map(r => r.run_id));
  const order = new Map(s.rows.map(r => [r.run_id, Date.parse(r.started_at)]));
  const state = (v: string): string => ({ running: '进行中', owner_lost: '进行中', completed: '完成', cancelled: '取消', failed: '失败' })[v] ?? (v.startsWith('held:') ? '挂起' : '—');
  return { at: new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), metrics: c.metrics, running: c.active.length, needs: c.needs.map(r => ({ project: r.project, question: r.question, waiting: r.waiting })), tokenRows: c.tokenRows,
    runs: c.runs.filter(r => today.has(r.id)).sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)).map(r => ({ id: r.id, url: r.url, project: r.project, title: r.title, role: r.role, tokens: r.tokens === '未知' ? '—' : r.tokens, elapsed: r.elapsed, state: state(r.state) })) };
}
const html = (s: string | number): string => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
export function panel(d: Partial<ReturnType<typeof overview>>): string {
  const rows = d.tokenRows, models = [...new Set(rows?.flatMap(r => Object.keys(r.models)) ?? [])].sort();
  const cells = (xs: (string | number)[]): string => xs.map(x => `<td>${html(x)}</td>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>superagent</title><style>
/* Colors from packages/web/src/experiments/console/theme.css. */
:root{color-scheme:dark;--surface:oklch(0.175 0.007 265);--surface-elevated:oklch(0.205 0.009 265);--border:oklch(0.275 0.012 265);--text-primary:oklch(0.975 0.004 265);--text-secondary:oklch(0.745 0.014 265);--brand-teal:oklch(0.755 0.165 168)}
body{background:var(--surface);color:var(--text-primary);font:15px system-ui;margin:24px auto;padding:0 20px;max-width:1200px}a{color:var(--brand-teal)}header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}h1{font-size:20px}h2{font-size:17px}section{margin-top:24px;overflow:auto}table{width:100%;border-collapse:collapse;background:var(--surface-elevated)}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--border)}p,small{color:var(--text-secondary)}#tokens td:not(:first-child){font-variant-numeric:tabular-nums;text-align:right}li{margin:12px 0}
</style><body><header id="metrics"><h1>superagent · 跑 ${String(d.running ?? 0)} · 等你 ${String(d.needs?.length ?? 0)} · 今日 ${String(d.metrics?.completed ?? 0)}/${String(d.metrics?.decided ?? 0)}</h1><p>更新 ${html(d.at ?? '—')} · <a href="/console">Archon 控制台</a></p></header>
${d.needs?.length ? `<section id="needs"><h2>需要你</h2><p>在 Mac 提醒 SUPERAGENT 列表回答：勾选=是、删除=否</p><ul>${d.needs.map(r => `<li>${html(r.project)} · ${html(r.question)} · 已等待 ${html(r.waiting)}</li>`).join('')}</ul></section>` : ''}
<section id="tokens"><h2>今日 token</h2><table><thead><tr><th>角色</th><th>合计</th>${models.map(m => `<th>${html(m)}</th>`).join('')}</tr></thead><tbody>${rows ? rows.map(r => `<tr>${cells([r.role, fmtTokens(r.total), ...models.map(m => fmtTokens(r.models[m] ?? 0))])}</tr>`).join('') : '<tr><td colspan="2">今日用量未知</td></tr>'}</tbody></table><p>仅本机日志。未归属：没有 superagent 派发证据的交互终端会话；证据不足的会话也保留在此，不猜角色。</p></section>
<section id="runs"><h2>今日 run</h2><table><thead><tr><th>项目</th><th>任务</th><th>run</th><th>角色·模型</th><th>token</th><th>用时</th><th>状态</th></tr></thead><tbody>${(d.runs ?? []).map(r => `<tr>${cells([r.project, r.title])}<td>${r.url ? `<a href="${html(r.url)}">${html(r.id)}</a>` : html(r.id)}</td>${cells([r.role, r.tokens, r.elapsed, r.state])}</tr>`).join('')}</tbody></table></section><script>setInterval(()=>location.reload(),15000)</script></body></html>`;
}
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function handler(port: number, token: string, get: () => Record<string, unknown>, upstream: string, forward: typeof fetch = fetch, unix?: string): (r: Request) => Promise<Response> {
  return async r => {
    const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };
    const respond = (body: string, status: number, type = 'text/plain'): Response => new Response(r.method === 'HEAD' ? null : body, { status, headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` } });
    if (![ `127.0.0.1:${String(port)}`, `localhost:${String(port)}` ].includes(r.headers.get('host') ?? '')) return respond('Forbidden', 403);
    if (!['GET', 'HEAD'].includes(r.method)) return respond('写操作请用 superagent decide 或 Mac 提醒', 403);
    const url = new URL(r.url), supplied = url.searchParams.get('t'), cookie = /(?:^|;\s*)sa_web=([^;]*)/.exec(r.headers.get('cookie') ?? '')?.[1];
    if (!(supplied && same(supplied, token)) && !(cookie && same(cookie, token))) return respond('Unauthorized', 401);
    if (supplied && same(supplied, token)) headers['Set-Cookie'] = `sa_web=${token}; HttpOnly; SameSite=Strict; Path=/`;
    if (url.pathname === '/sa') return respond(panel(get()), 200, 'text/html');
    if (url.pathname === '/sa/data') return respond(JSON.stringify(get()), 200, 'application/json');
    if (url.pathname === '/api/overview') return respond('Not Found', 404);
    url.searchParams.delete('t');
    try {
      const target = new URL(upstream); target.pathname = url.pathname; target.search = url.search;
      const pass = new Headers(); for (const key of ['accept', 'last-event-id', 'range']) { const value = r.headers.get(key); if (value) pass.set(key, value); }
      const response = await forward(target, { method: r.method, headers: pass, signal: r.signal, redirect: 'manual', ...(unix ? { unix } : {}) });
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
  const { observerDist } = await import('./archon');
  const dist = observerDist(), stamp = join(dist, '.superagent-engine');
  if (existsSync(join(dist, 'index.html')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return;
  const p = Bun.spawn([process.execPath, 'x', 'vite', 'build', '--outDir', dist], { cwd: join(WETAMP, '../packages/web'), env: consoleEnv(), stdout: 'ignore', stderr: 'inherit', timeout: 90000 });
  if (await p.exited !== 0) throw new Error('build:web failed');
  writeFileSync(stamp, hash);
}
async function serve(): Promise<void> {
  mkdirSync(home().sa, { recursive: true });
  const held = lock(join(home().sa, 'web.lock')); if (!held.ok) throw new Error('console already running');
  const dir = join(home().sa, 'console'), socket = join(dir, 'archon.sock');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  let server: ReturnType<typeof Bun.serve> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const token = randomBytes(32).toString('hex'), hash = engineHash(), load = createLoader();
  let snapshot: Snapshot = { summary: {}, rows: [], at: new Date().toISOString() }, busy = false;
  const update = async (): Promise<void> => { if (busy) return; busy = true; try { snapshot = await load(Number.MAX_SAFE_INTEGER); requestUsageRefresh(); } finally { busy = false; } };
  const cleanup = (): void => { if (existsSync(socket)) unlinkSync(socket); if (webState()?.pid === process.pid) unlinkSync(stateFile()); };
  process.once('exit', cleanup);
  try {
    await ensureWebDist(hash);
    if (existsSync(socket)) unlinkSync(socket); // Exclusive web.lock proves there is no console owner.
    const { startObserver } = await import('./archon');
    await startObserver(socket);
    const port = Number(process.env.SA_CONSOLE_PORT ?? 39890);
    server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler(port, token, () => overview(snapshot), 'http://localhost', fetch, socket) });
    writeAtomic(stateFile(), JSON.stringify({ port: server.port ?? port, pid: process.pid, token, started_at: new Date().toISOString(), engine_hash: hash, socket, label: label() } satisfies WebState));
    if (existsSync(join(dir, 'error'))) unlinkSync(join(dir, 'error'));
    timer = setInterval(() => { void update().catch(() => { /* Loader retains the last snapshot. */ }); }, 5000); void update().catch(() => { /* Loader retains the last snapshot. */ });
    await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } catch (e) { writeAtomic(join(dir, 'error'), (e as Error).message); throw e; }
  finally { if (timer) clearInterval(timer); if (server) await server.stop(true); cleanup(); held.release(); }
}
export async function stopWeb(s = webState()): Promise<void> {
  if (s) migrate(s);
  if (loaded()) { const p = launch('bootout', job()); if (p.status !== 0) throw new Error(`console bootout failed: ${String(p.stderr)}`); }
  for (let i = 0; i < 300 && (existsSync(join(home().sa, 'console/archon.sock')) || (s && alive(s.pid))); i++) await Bun.sleep(50);
  if (existsSync(join(home().sa, 'console/archon.sock')) || (s && alive(s.pid))) throw new Error('console still stopping');
}
export async function startWeb(): Promise<WebState> {
  mkdirSync(home().sa, { recursive: true });
  const guard = lock(join(home().sa, 'web-start.lock')); if (!guard.ok) throw new Error('console startup already pending');
  try {
    const old = webState(); if (old) migrate(old);
    const xml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
    const dir = process.env.SA_LAUNCHD_DIR ?? join(homedir(), 'Library/LaunchAgents'), file = join(dir, `${label()}.plist`);
    mkdirSync(dir, { recursive: true });
    const text = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label())}</string><key>ProgramArguments</key><array>${[process.execPath, '--no-env-file', '--preload', join(WETAMP, 'src/web/archon.ts'), join(WETAMP, 'src/cli.ts'), 'console', 'serve'].map(x => `<string>${xml(x)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(consoleEnv()).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict><key>WorkingDirectory</key><string>${xml(home().sa)}</string><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(join(home().sa, 'console.log'))}</string><key>StandardErrorPath</key><string>${xml(join(home().sa, 'console.log'))}</string></dict></plist>`;
    const changed = !existsSync(file) || readFileSync(file, 'utf8') !== text;
    if (changed) writeAtomic(file, text);
    const error = join(home().sa, 'console/error'); if (existsSync(error)) unlinkSync(error);
    if (changed && loaded()) await stopWeb(old);
    if (!loaded()) { const p = launch('bootstrap', domain(), file); if (p.status !== 0) throw new Error(`console bootstrap failed: ${String(p.stderr)}`); }
    else if (changed || !old || needsRestart(old)) { const p = launch('kickstart', '-k', job()); if (p.status !== 0) throw new Error(`console kickstart failed: ${String(p.stderr)}`); }
    for (let i = 0; i < 1200; i++) { const s = webState(); if (s && 'label' in s && s.label === label() && !needsRestart(s) && alive(s.pid)) return s; await Bun.sleep(100); const error = join(home().sa, 'console/error'); if (existsSync(error)) throw new Error(`console startup failed: ${readFileSync(error, 'utf8')}`); }
    throw new Error('console startup timeout; inspect console status and console.log');
  } finally { guard.release(); }
}
export async function refreshConsole(restart = startWeb, current = engineHash()): Promise<ConsoleState | null> {
  const s = webState(); return s && alive(s.pid) && needsRestart(s, current) ? await restart() : s;
}
export async function webCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv), sub = a._[1];
  if (sub === 'serve') { await serve(); return 0; }
  if (sub === 'start') { const s = await startWeb(); console.log(JSON.stringify({ port: s.port, state: 'running' })); return 0; }
  if (sub === 'stop') { await stopWeb(); console.log('stopped'); return 0; }
  const s = webState();
  if (sub === 'status') { const p = launch('print', job()), error = join(home().sa, 'console/error'); console.log(JSON.stringify({ state: p.status === 0 ? s && alive(s.pid) ? 'running' : 'starting' : 'stopped', port: s?.port, error: existsSync(error) ? readFileSync(error, 'utf8') : undefined, launchd: String(p.stdout).split('\n').filter(x => /state =|last exit code =/.test(x)).map(x => x.trim()) })); return 0; }
  if (sub === 'url' && s && 'label' in s && loaded()) { const url = webUrl(s); if (a.flags.open) return await Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' }).exited; console.log(url); return 0; }
  throw new Error('usage: superagent console start|stop|status|url [--open] (web is a compatibility alias)');
}
