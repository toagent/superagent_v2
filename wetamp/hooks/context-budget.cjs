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
// A superagent run is active when a non-failed ledger in $SUPERAGENT_HOME/runs points at an
// Archon run still pending/running/paused. Any read failure means "not active".
function activeRun(home) {
  let db;
  try {
    const dir = path.join(home, 'runs');
    const ids = fs.readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => {
      try { const run = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); return run.state !== 'failed' && typeof run.archon_run_id === 'string' ? [run.archon_run_id] : []; }
      catch { return []; }
    });
    if (!ids.length) return false;
    db = new (require('node:sqlite').DatabaseSync)(path.join(process.env.ARCHON_HOME || path.join(home, 'archon'), 'archon.db'), {readOnly: true});
    const query = db.prepare("SELECT 1 FROM remote_agent_workflow_runs WHERE id=? AND status IN ('pending','running','paused')");
    return ids.some(id => query.get(id));
  } catch { return false; } finally { db?.close(); }
}
// role: commander | general | strategist (guard.sessionRole); budgets from policy.context.
function roleLimit(role, policy) {
  if (policy === undefined) { try { policy = require('../tiers.json').policy; } catch {} }
  const value = policy?.context?.autocompact_tokens?.[role];
  return Number.isSafeInteger(value) && value > 0 ? value : 160000;
}
function advise(input, tokens, prior = {}, active = false, threshold = roleLimit('commander')) {
  if (tokens === null) return {state: prior, messages: []};
  const state = {...prior}, messages = [];
  if (input.hook_event_name === 'UserPromptSubmit') { state.tools = 0; state.tool_warned = false; }
  if (tokens > threshold && (!Number.isFinite(state.warned_at) || tokens >= state.warned_at + 40000)) {
    messages.push(`上下文约 ${tokens} token：把读文件、跑测试、长输出交给 superagent 或将军，只读 ≤20 行结果。`); state.warned_at = tokens;
  }
  if (active && input.hook_event_name === 'PreToolUse' && ['Bash', 'Read'].includes(input.tool_name)) {
    // Only a Bash call of the superagent CLI is exempt; reading its sources still counts.
    const superagentCommand = input.tool_name === 'Bash' && /(^|[\s/])superagent(?:\s|$)/.test(String(input.tool_input?.command || ''));
    if (!superagentCommand) {
      state.tools = (state.tools || 0) + 1;
      if (state.tools > 15 && !state.tool_warned) { messages.push('活动 run 内本次输入的非 superagent Bash/Read 已超过 15 次：请回到 superagent wait 处理决策。'); state.tool_warned = true; }
    }
  }
  return {state, messages};
}
function main(input, client = 'claude') {
  if (!['UserPromptSubmit', 'PreToolUse'].includes(input?.hook_event_name)) return null;
  const tokens = recentUsage(input.transcript_path); if (tokens === null) return null;
  const home = process.env.SUPERAGENT_HOME || path.join(require('node:os').homedir(), '.superagent');
  const key = crypto.createHash('sha256').update(String(input.session_id || input.transcript_path)).digest('hex');
  const file = path.join(home, 'hooks', 'context-budget', `${key}.json`); let prior = {};
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const threshold = roleLimit(require('./guard.cjs').sessionRole(input, client));
  const result = advise(input, tokens, prior, activeRun(home), threshold);
  try { fs.mkdirSync(path.dirname(file), {recursive: true}); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(result.state)); fs.renameSync(tmp, file); } catch {}
  return result.messages.length ? {hookSpecificOutput: {hookEventName: input.hook_event_name, additionalContext: result.messages.join('\n')}} : null;
}
if (require.main === module) {
  try { const result = main(JSON.parse(fs.readFileSync(0, 'utf8')), process.argv[2] || 'claude'); if (result) process.stdout.write(JSON.stringify(result) + '\n'); } catch {}
  // Never emit a denial or a nonzero status, even if state/transcript I/O fails.
}
module.exports = {recentUsage, advise, main, roleLimit, LIMIT};
