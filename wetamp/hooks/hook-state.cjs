'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Age alone cannot prove an owner is dead. Empty/ambiguous locks stay busy.
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const lock = `${file}.lock`, until = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // No stale-lock stealing: a competing reclaimer could delete a new owner's
      // lock between inspection and unlink. Surface ambiguity to the operator.
      if (Date.now() >= until) throw new Error('状态锁忙；确认 owner 退出后再处理锁文件');
      sleep(20);
    }
  }
  try { return fn(); } finally { fs.unlinkSync(lock); }
}
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, text, {mode: 0o600}); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function withState(file, fn) {
  return withLock(file, () => {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('状态文件损坏或无法读取', {cause: error}); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('状态文件不是对象');
    const result = fn(state);
    atomicWrite(file, JSON.stringify(state));
    return result;
  });
}
// No prose/content hashes: without a native event ID, distinct calls stay distinct.
function once(state, namespace, payload, fn, replay = true) {
  const id = payload.tool_use_id ?? payload.tool_call_id ?? payload.event_id ?? payload.prompt_id;
  if (typeof id !== 'string' || !id.trim()) return fn();
  const key = crypto.createHash('sha256').update(`${namespace}\0${payload.hook_event_name}\0${id}`).digest('hex');
  state.events ??= {};
  if (typeof state.events !== 'object' || Array.isArray(state.events)) throw new Error('事件计量状态损坏');
  if (Object.hasOwn(state.events, key)) return replay ? state.events[key] : null;
  const result = fn();
  state.events[key] = result;
  return result;
}
module.exports = {withLock, withState, atomicWrite, once};
