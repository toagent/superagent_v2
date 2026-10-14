'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
// Keep one inode and retain the inherited open file description in the caller.
// The kernel releases this lock on close/SIGKILL; elapsed time never steals it.
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(`${file}.lock`, 'a', 0o600);
  try {
    const bun =
      [
        process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'),
        path.join(require('node:os').homedir(), '.bun/bin/bun'),
        '/opt/homebrew/bin/bun',
      ].find(p => p && fs.existsSync(p)) || 'bun';
    const locked = spawnSync(bun, [path.join(__dirname, 'flock.ts')], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      timeout: 7000,
    });
    if (locked.status !== 0) throw new Error(locked.status === 2 ? '状态锁忙' : '状态锁不可用');
    return fn();
  } finally {
    fs.closeSync(fd);
  }
}
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
function withState(file, fn) {
  return withLock(file, () => {
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('状态文件损坏或无法读取', { cause: error });
    }
    if (!state || typeof state !== 'object' || Array.isArray(state))
      throw new Error('状态文件不是对象');
    const result = fn(state);
    atomicWrite(file, JSON.stringify(state));
    return result;
  });
}
// No prose/content hashes: without a native event ID, distinct calls stay distinct.
function once(state, namespace, payload, fn, replay = true) {
  const id = payload.tool_use_id ?? payload.tool_call_id ?? payload.event_id ?? payload.prompt_id;
  if (typeof id !== 'string' || !id.trim()) return fn();
  const key = crypto
    .createHash('sha256')
    .update(`${namespace}\0${payload.hook_event_name}\0${id}`)
    .digest('hex');
  state.events ??= {};
  if (typeof state.events !== 'object' || Array.isArray(state.events))
    throw new Error('事件计量状态损坏');
  if (Object.hasOwn(state.events, key)) return replay ? state.events[key] : null;
  const result = fn();
  state.events[key] = result;
  return result;
}
module.exports = { withLock, withState, atomicWrite, once };
