'use strict';
// G-3 Stop gate and per-session hook state. A commander session records, per git root it
// touches, the base HEAD and a fingerprint of guarded changes before its first write; Stop
// compares the current fingerprint with that baseline and with the last reviewed one.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tiers, policy} = require('../tiers.json');
const microEdit = require('./micro-edit.cjs');

const MODES = ['off', 'advisory', 'cycle', 'change'];
// Keep a stable inode: unlinking a locked path lets two processes own different
// inodes. A helper locks our inherited open file description; close releases it,
// including on SIGKILL. Slow live owners are never reclaimed by elapsed time.
function withState(file, fn) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const fd = fs.openSync(`${file}.lock`, 'a', 0o600);
  try {
    const bun = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'),
      path.join(require('node:os').homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun']
      .find(p => p && fs.existsSync(p)) || 'bun';
    const locked = spawnSync(bun, [path.join(__dirname, 'flock.ts')],
      {stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 7000});
    if (locked.status !== 0) throw new Error(locked.status === 2 ? '状态锁忙' : '状态锁不可用');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') state = {corrupt: error.message}; }
    const result = fn(state);
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state), {mode: 0o600});
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
    return result;
  } finally { fs.closeSync(fd); }
}

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], {input, maxBuffer: 256 * 1024 * 1024, timeout: 10000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${String(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return r.stdout;
}
const nul = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
// Hash of guarded changes against `base` (committed, staged, unstaged and untracked) without
// writing git objects; documentation and scratch paths (policy.exempt_paths) do not count.
function fingerprint(root, base) {
  const tracked = nul(git(root, ['diff', '--name-only', '--no-renames', '-z', base, '--'])).filter(microEdit.guardedPath);
  const untracked = nul(git(root, ['ls-files', '-o', '--exclude-standard', '-z'])).filter(microEdit.guardedPath);
  const hash = crypto.createHash('sha256');
  if (tracked.length) hash.update(git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--', ...tracked.map(file => `:(literal)${file}`)]));
  if (untracked.length) hash.update(untracked.join('\0')).update(git(root, ['hash-object', '--no-filters', '--stdin-paths'], untracked.join('\n') + '\n'));
  return tracked.length || untracked.length ? hash.digest('hex') : 'clean';
}
const head = root => { try { return git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim(); } catch { return '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; } };

// Record the baseline of each root the first time it is seen; errors make the session unknown.
function observe(gate, roots) {
  for (const root of roots) {
    if (!root || gate.roots[root]) continue;
    try { const base = head(root); gate.roots[root] = {base, baseline: fingerprint(root, base), reviewed: null}; }
    catch (error) { gate.unknown = gate.unknown || error.message; }
  }
}
const successful = response => !(response && typeof response === 'object' && (response.is_error === true || response.error));
// A finished reviewer-N subagent (Claude) or strategist-pool subagent (Codex) reviewed the tree.
function reviewEvidence(payload, client, rootCall) {
  const reviewer = value => /^reviewer-\d+$/.test(typeof value === 'string' ? value : '');
  if (payload.hook_event_name === 'SubagentStop') {
    if (rootCall) return false;
    return client === 'claude' ? reviewer(payload.agent_type) : !!payload.agent_type && tiers.strategist.pools.chatgpt.includes(payload.model);
  }
  if (payload.hook_event_name !== 'PostToolUse' || !successful(payload.tool_response)) return false;
  const tools = client === 'claude' ? ['Agent', 'Task'] : ['mcp__claude__Agent', 'claude.Agent'];
  return tools.includes(payload.tool_name) && reviewer(payload.tool_input?.subagent_type);
}

// Track one hook event of a commander session; only Stop returns a decision. `roots` are the
// git roots a PreToolUse may write (empty for read-only tools) or the cwd root otherwise.
function gate(file, payload, client, roots, rootCall) {
  const mode = policy.stop_gate ?? 'off';
  const event = payload.hook_event_name;
  if (!MODES.includes(mode)) return event === 'Stop' ? {systemMessage: `SUPERAGENT: stop_gate=${mode} 无效（off/advisory/cycle/change），请修正 tiers.json。`} : null;
  if (mode === 'off' || !file || (event === 'Stop' || event === 'SessionStart') && !rootCall) return null;
  return withState(file, state => {
    if (!state.gate) state.gate = {roots: {}, ownWrites: 0, blocked: null, unknown: ['PostToolUse', 'Stop'].includes(event) ? '首个事件不是 SessionStart/PreToolUse（钩子中途安装或状态丢失）' : null};
    if (state.corrupt) { state.gate.unknown = `状态文件损坏：${state.corrupt}`; delete state.corrupt; }
    const g = state.gate;
    if (event === 'SessionStart' || event === 'PreToolUse') {
      observe(g, roots);
      if (event === 'PreToolUse' && roots.length) g.ownWrites++;
      return null;
    }
    if (reviewEvidence(payload, client, rootCall)) {
      for (const [root, record] of Object.entries(g.roots)) {
        try { record.reviewed = fingerprint(root, record.base); } catch (error) { g.unknown = error.message; return null; }
      }
      g.unknown = null; g.blocked = null;
      return null;
    }
    if (event !== 'Stop') return null;
    const reasons = g.unknown ? [`会话 unknown：${g.unknown}`] : [];
    const dirty = {};
    for (const [root, record] of Object.entries(g.roots)) {
      let current; try { current = fingerprint(root, record.base); } catch (error) { reasons.push(error.message); continue; }
      if (current !== record.baseline && current !== record.reviewed) { dirty[root] = current; reasons.push(`${path.basename(root)} 有未评审改动`); }
    }
    if (!reasons.length) return null;
    const why = ` 原因：${reasons.join('；')}`;
    if (mode === 'advisory') return {systemMessage: `⚠ UNREVIEWED：最终 diff 尚未评审；请军师评审。${why}`};
    const token = crypto.createHash('sha256').update(JSON.stringify(mode === 'change' ? {dirty, reasons} : {ownWrites: g.ownWrites, unknown: !!g.unknown})).digest('hex');
    // Same state as the last block: release once instead of looping the session on Stop.
    if (payload.stop_hook_active || g.blocked === token) return {systemMessage: `⚠ UNREVIEWED：为避免 Stop 死循环本次放行；最终 diff 仍需军师评审。${why}`};
    g.blocked = token;
    return {decision: 'block', reason: `SUPERAGENT G-3: 最终 diff 尚未评审或会话 unknown；请军师（reviewer-N）评审后结束。${why}`};
  });
}
module.exports = {withState, gate, fingerprint, reviewEvidence};
