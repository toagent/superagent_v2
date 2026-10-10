import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { basename, join } from 'node:path';
import { home, WETAMP } from '../config';
import { lock } from '../archon';
import { alive } from '../jobs';
import { createLoader, type Snapshot } from '../board/data';
import { readUsage, requestUsageRefresh, usageSummary } from '../usage';
import { cockpit } from '../board/cockpit';
import { shortModel } from '../models';
import { parseArgs } from '../cli';

interface WebState { port: number; pid: number; token: string; started_at: string }
const stateFile = (): string => join(home().sa, 'web.json');
export function webState(): WebState | null { try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as WebState; } catch { return null; } }
export const webUrl = (s: WebState): string => `http://127.0.0.1:${String(s.port)}/?t=${s.token}`;
function owned(s: WebState): boolean {
  try { const args = execFileSync('ps', ['-p', String(s.pid), '-o', 'command='], { encoding: 'utf8' }).trim(); return args === `${process.execPath} ${join(WETAMP, 'src/cli.ts')} web serve`; } catch { return false; }
}
/** Explicit projection: no prompt, argv, errors, artifacts or transcript paths enter HTTP. */
export function overview(s: Snapshot): Record<string, unknown> {
  const a = s.activity, c = s.usage ?? readUsage();
  const jobs = a?.jobs.map(j => ({ id: j.id, state: j.state, role: j.tier, short_model: shortModel(j.model), cwd: basename(j.cwd), owner: j.owner })) ?? [];
  const runs = s.rows.map(r => ({ id: r.run_id, state: r.state, nodes: { done: r.nodes.done, total: r.nodes.total, current: r.nodes.current }, role: r.nodes.currentRole, short_model: shortModel(r.model), cwd: r.repo, rounds: Number(/-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? 0), recoveries: r.recoveries, retries: r.auto_retries, held: r.held ? { node: r.held.node, event: r.held.event } : null, action: r.held ? 'superagent brief <run> 查看处置' : null }));
  return { cockpit: cockpit({ ...s, usage: c }, Date.parse(s.at)), at: s.at, terminals: a?.terms.map(t => ({ client: t.kind, role: t.tier, short_model: shortModel(t.model), state: t.state, cwd: t.cwd ? basename(t.cwd) : null, pid: t.pid, jobs: jobs.filter(j => j.owner === t.pid) })) ?? [], jobs, runs, pending: runs.filter(r => r.held), usage: usageSummary(c), estimate: { label: 'ccusage 公开价目估算，非账单', dollars: c.status === 'ok' && c.sessions.every(x => typeof x.cost === 'number') ? c.sessions.reduce((n, x) => n + (x.cost ?? 0), 0) : null } };
}
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function handler(port: number, token: string, get: () => Record<string, unknown>): (r: Request) => Response {
  const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');
  const hashes = [...html.matchAll(/<(?:script|style)>([\s\S]*?)<\/(?:script|style)>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  return r => {
    const headers: Record<string, string> = { 'Content-Security-Policy': `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' ${hashes}; frame-ancestors 'none'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    const respond = (body: string, status: number, type = 'text/plain'): Response => new Response(r.method === 'HEAD' ? null : body, { status, headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` } });
    if (![ `127.0.0.1:${String(port)}`, `localhost:${String(port)}` ].includes(r.headers.get('host') ?? '')) return respond('Forbidden', 403);
    if (!['GET', 'HEAD'].includes(r.method)) return respond('Method Not Allowed', 405);
    const url = new URL(r.url), supplied = url.searchParams.get('t'), cookie = /(?:^|;\s*)sa_web=([^;]*)/.exec(r.headers.get('cookie') ?? '')?.[1];
    if (!(supplied && same(supplied, token)) && !(cookie && same(cookie, token))) return respond('Unauthorized', 401);
    if (supplied && same(supplied, token)) headers['Set-Cookie'] = `sa_web=${token}; HttpOnly; SameSite=Strict; Path=/`;
    if (url.pathname === '/') return respond(html, 200, 'text/html');
    if (url.pathname === '/api/overview') return respond(JSON.stringify(get()), 200, 'application/json');
    return respond('Not Found', 404);
  };
}
async function serve(): Promise<void> {
  mkdirSync(home().sa, { recursive: true });
  const held = lock(join(home().sa, 'web.lock'));
  if (!held.ok) throw new Error('web already running');
  const token = randomBytes(32).toString('hex'), load = createLoader();
  let snapshot: Snapshot = { summary: {}, rows: [], at: new Date().toISOString() }, busy = false;
  const update = async (): Promise<void> => { if (busy) return; busy = true; try { snapshot = await load(Number.MAX_SAFE_INTEGER); if (process.env.NODE_ENV !== 'test') requestUsageRefresh(); } catch { /* Previous safe snapshot remains visible. */ } finally { busy = false; } };
  let server: ReturnType<typeof Bun.serve> | undefined, boundPort = 0;
  for (let port = 39890; port < 39990; port++) {
    try { server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler(port, token, () => overview(snapshot)) }); boundPort = port; break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') { held.release(); throw e; } }
  }
  if (!server) { held.release(); throw new Error('no free web port'); }
  const state: WebState = { port: boundPort, pid: process.pid, token, started_at: new Date().toISOString() }, tmp = `${stateFile()}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); renameSync(tmp, stateFile());
  const timer = setInterval(() => { void update(); }, 5000); void update();
  const running = server;
  await new Promise<void>(resolve => { const stop = (): void => { clearInterval(timer); void running.stop(true); if (webState()?.pid === process.pid) unlinkSync(stateFile()); held.release(); resolve(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop); });
}
export async function startWeb(): Promise<WebState> {
  const old = webState();
  if (old && alive(old.pid)) { if (!owned(old)) throw new Error('web owner ambiguous; refusing'); return old; }
  mkdirSync(home().sa, { recursive: true });
  const guard = lock(join(home().sa, 'web-start.lock'));
  if (!guard.ok) { for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 50)); const s = webState(); if (s && alive(s.pid) && owned(s)) return s; } throw new Error('web startup still pending'); }
  try {
    const p = spawn(process.execPath, [join(WETAMP, 'src/cli.ts'), 'web', 'serve'], { detached: true, stdio: 'ignore', env: process.env }); p.unref();
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 50)); const s = webState(); if (s && s.pid === p.pid && owned(s)) return s; if (p.exitCode !== null) break; }
    throw new Error('web startup failed');
  } finally { guard.release(); }
}
export async function webCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv), sub = a._[1];
  if (sub === 'serve') { await serve(); return 0; }
  if (sub === 'start') { const s = await startWeb(); console.log(JSON.stringify({ port: s.port, pid: s.pid, state: 'running' })); return 0; }
  const s = webState();
  if (sub === 'status') { console.log(JSON.stringify({ state: s && alive(s.pid) ? owned(s) ? 'running' : 'unknown' : 'stopped', port: s?.port, pid: s?.pid })); return 0; }
  if (sub === 'stop') {
    if (!s || !alive(s.pid)) { console.log('stopped'); return 0; }
    if (!owned(s)) throw new Error('web owner ambiguous; refusing to stop');
    process.kill(s.pid, 'SIGTERM');
    for (let i = 0; i < 100 && alive(s.pid); i++) await new Promise(r => setTimeout(r, 50));
    if (alive(s.pid)) throw new Error('web still stopping'); console.log('stopped'); return 0;
  }
  if (sub === 'url' && s && alive(s.pid) && owned(s)) { const url = webUrl(s); if (a.flags.open) { const p = Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' }); return await p.exited; } console.log(url); return 0; }
  throw new Error('usage: superagent web serve|start|stop|status|url [--open]');
}
