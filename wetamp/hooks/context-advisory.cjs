#!/usr/bin/env node
'use strict';
// Advisory only: malformed input, missing usage and unavailable state are no-ops.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const LIMIT = 256 * 1024;
function recentUsage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, start = Math.max(0, size - LIMIT);
    const buffer = Buffer.alloc(Math.min(size, LIMIT)); fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let event; try { event = JSON.parse(lines[i]); } catch { continue; }
      const u = event.message?.usage || event.usage;
      if (!u || typeof u !== 'object') continue;
      const values = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
      if (values.every(v => Number.isSafeInteger(v) && v >= 0)) return values.reduce((a, b) => a + b, 0);
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
// role: commander | general | strategist (guard.sessionRole); advisory thresholds from policy.context.
function roleLimit(role, policy) {
  if (policy === undefined) { try { policy = require('../tiers.json').policy; } catch {} }
  const value = policy?.context?.advisory_tokens?.[role];
  return Number.isSafeInteger(value) && value > 0 ? value : 160000;
}
function advise(_input, tokens, prior = {}, _active = false, threshold = roleLimit('commander')) {
  if (tokens === null) return {state: prior, messages: []};
  const state = {...prior}, messages = [];
  if (tokens > threshold && (!Number.isFinite(state.warned_at) || tokens >= state.warned_at + 40000)) {
    messages.push(`上下文约 ${tokens} token（advisory）：把读文件、跑测试、长输出交给 superagent 或将军，只读 ≤20 行结果。`); state.warned_at = tokens;
  }
  return {state, messages};
}
function main(input, client = 'claude') {
  let inbox = [];
  try { inbox = require('./live.cjs').beat(client, input, () => require('./guard.cjs').sessionRole(input, client)) || []; } catch {}
  const context = require('./coord.cjs').notifications(inbox);
  if (context) return {hookSpecificOutput: {hookEventName: input.hook_event_name, additionalContext: context}};
  if (!['UserPromptSubmit', 'PreToolUse'].includes(input?.hook_event_name)) return null;
  const tokens = recentUsage(input.transcript_path); if (tokens === null) return null;
  const home = process.env.SUPERAGENT_HOME || path.join(require('node:os').homedir(), '.superagent');
  const key = crypto.createHash('sha256').update(String(input.session_id || input.transcript_path)).digest('hex');
  const file = path.join(home, 'hooks', 'context-advisory', `${key}.json`);
  const threshold = roleLimit(require('./guard.cjs').sessionRole(input, client));
  try {
    return require('./hook-state.cjs').withState(file, state => require('./hook-state.cjs').once(state, 'context', input, () => {
      const result = advise(input, tokens, state, false, threshold);
      Object.assign(state, result.state);
      return result.messages.length ? {hookSpecificOutput: {hookEventName: input.hook_event_name, additionalContext: result.messages.join('\n')}} : null;
    }, false));
  } catch { return null; } // Advisory cannot deny; failed transactions never reset usage state.
}
if (require.main === module) {
  try { const result = main(JSON.parse(fs.readFileSync(0, 'utf8')), process.argv[2] || 'claude'); if (result) process.stdout.write(JSON.stringify(result) + '\n'); } catch {}
  // Never emit a denial or a nonzero status, even if state/transcript I/O fails.
}
module.exports = {recentUsage, advise, main, roleLimit, LIMIT};
