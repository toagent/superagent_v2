'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const FRESH_MS = 120000;
function inspect(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.signal) return { state: 'unknown' };
  if (r.status === 1 && !r.stdout.trim()) return { state: 'offline' };
  return r.status === 0 && r.stdout.trim()
    ? { state: 'online', start: r.stdout.trim() }
    : { state: 'unknown' };
}
const key = a => [a.client, a.session_id || null, a.host || null, a.pid, a.pid_start || null];
function same(a, b) {
  return !!a && !!b && JSON.stringify(key(a)) === JSON.stringify(key(b));
}
function readProcessHeartbeats(identity, home) {
  const dir = path.join(home, 'live');
  let names;
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap(name => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      return record.client === identity.client &&
        record.host === identity.host &&
        record.pid === identity.pid &&
        record.pid_start === identity.pid_start
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}
function presence(identity, home, deps = {}) {
  if (!identity || identity.host !== (deps.host || os.hostname())) return { state: 'unknown' };
  const p = (deps.inspect || inspect)(identity.pid);
  if (p.state === 'offline') return { state: 'offline' };
  if (p.state !== 'online' || !identity.pid_start) return { state: 'unknown' };
  if (p.start !== identity.pid_start) return { state: 'offline' };
  let beats;
  try {
    beats = readProcessHeartbeats(identity, home);
  } catch {
    return { state: 'unknown' };
  }
  const at = Math.max(0, ...beats.filter(b => same(identity, b)).map(b => Date.parse(b.at) || 0));
  return {
    state: 'online',
    activity: (deps.now || Date.now)() - at < FRESH_MS ? 'active' : 'idle',
  };
}
module.exports = { inspect, same, key, presence, readProcessHeartbeats, FRESH_MS };
