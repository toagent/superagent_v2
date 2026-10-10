'use strict';
// Only structured dispatch inputs are observable here. Shell forwarding and
// existing-agent controls (send_message/resume_agent/etc.) are not new tasks.
const defaults = Object.freeze({max_prompt_chars:12000,allow_limited_history:false,max_history_turns:3});
function contextPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dispatch_context policy');
  const policy = {...defaults,...value};
  if (!Number.isSafeInteger(policy.max_prompt_chars) || policy.max_prompt_chars < 1
      || typeof policy.allow_limited_history !== 'boolean'
      || !Number.isSafeInteger(policy.max_history_turns) || policy.max_history_turns < 1)
    throw new Error('Invalid dispatch_context limits');
  return policy;
}
function contextReason(client, name, input, policy) {
  const native = client === 'codex' && name === 'spawn_agent';
  const agent = ['claude','codex'].includes(client) && ['Agent','Task','mcp__claude__Agent','claude.Agent'].includes(name);
  if (!native && !agent) return null;
  for (const field of native ? ['message'] : ['prompt']) {
    if (input[field] !== undefined && typeof input[field] !== 'string')
      return `G-2: ${field} 须为字符串；用短任务卡和文件路径派发。`;
    if (typeof input[field] === 'string' && input[field].length > policy.max_prompt_chars)
      return `G-2: ${field} 超过 ${policy.max_prompt_chars} 字符；改为短任务卡 + 证据路径，不内嵌历史/日志。`;
  }
  if (native && input.fork_turns !== 'none') {
    const limited = typeof input.fork_turns === 'string' && /^[1-9][0-9]*$/.test(input.fork_turns)
      && Number.isSafeInteger(Number(input.fork_turns)) && Number(input.fork_turns) <= policy.max_history_turns;
    if (!policy.allow_limited_history || !limited)
      return 'G-2: 新任务须显式 fork_turns="none"；有限历史须在 tiers.json 的 dispatch_context 中授权并指定允许的轮数。';
  }
  // Claude Agent has no fork_turns input. Never invent one or update its input.
  // Ordinary Agent/Task starts a new task; explicit fork opts into parent history.
  if (agent && input.subagent_type === 'fork')
    return 'G-2: 使用普通 coder-N/reviewer-N 新会话与路径式任务卡；fork 类型会继承父历史，无法限定轮数。';
  return null;
}
module.exports = {contextPolicy,contextReason};
