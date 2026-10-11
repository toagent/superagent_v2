'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const FRESH_MS = 120000;
function inspect(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8', timeout: 1000,
    env: {...process.env, LC_ALL: 'C'}, stdio: ['ignore', 'pipe', 'ignore']});
  if (r.error || r.signal) return {state: 'unknown'};
  if (r.status === 1 && !r.stdout.trim()) return {state: 'offline'};
  return r.status === 0 && r.stdout.trim() ? {state: 'online', start: r.stdout.trim()} : {state: 'unknown'};
}
const key = a => [a.client, a.session_id || null, a.host || null, a.pid, a.pid_start || null];
function same(a, b) { return !!a && !!b && JSON.stringify(key(a)) === JSON.stringify(key(b)); }
function presence(identity, home, deps = {}) {
  if (!identity || identity.host !== (deps.host || os.hostname())) return {state: 'unknown'};
  const p = (deps.inspect || inspect)(identity.pid);
  if (p.state === 'offline') return {state: 'offline'};
  if (p.state !== 'online' || !identity.pid_start) return {state: 'unknown'};
  if (p.start !== identity.pid_start) return {state: 'offline'};
  let at = 0;
  try { for (const f of fs.readdirSync(path.join(home, 'live')).filter(f => f.endsWith('.json'))) {
    const b = JSON.parse(fs.readFileSync(path.join(home, 'live', f), 'utf8'));
    if (same(identity, b)) at = Math.max(at, Date.parse(b.at) || 0);
  } } catch {}
  return {state: 'online', activity: (deps.now || Date.now)() - at < FRESH_MS ? 'active' : 'idle'};
}
module.exports = {inspect, same, key, presence, FRESH_MS};
