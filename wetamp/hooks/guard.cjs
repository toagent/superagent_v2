#!/usr/bin/env node
'use strict';
// superagent V2 guard for Claude Code / Codex hooks: `node guard.cjs claude|codex`.
// Unknown effects and parser/internal failures are visible advisories, never a hold.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tiers, policy} = require('../tiers.json');
const {parse} = require('./shell.cjs');
const microEdit = require('./micro-edit.cjs');
const stopGate = require('./stop-gate.cjs');
const {withState, once} = require('./hook-state.cjs');
const dispatch = require('./dispatch-context.cjs');
const redline = require('./redline.cjs');
const {resolvePath, within} = redline;

const saHome = env => env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent');
const pool = tier => tiers[tier].pools.chatgpt;
const deny = (reason, superagentPermissionCategory = 'authorization') => ({superagentPermissionCategory, hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}});
// Only two nonempty strings establish a child (subagent) call.
const isChild = payload => Boolean(typeof payload.agent_type === 'string' && payload.agent_type.trim() && typeof payload.agent_id === 'string' && payload.agent_id.trim());
const rootCall = payload => !isChild(payload);
function gitRoot(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  return r.status === 0 ? r.stdout.trim() : null;
}

// Why this session is derived (general/reviewer/worker), or null for the commander.
function derivedBy(payload, client, env = process.env) {
  if (['general', 'strategist', 'reviewer', 'worker'].includes(env.SUPERAGENT_ROLE)) return `SUPERAGENT_ROLE=${env.SUPERAGENT_ROLE}`;
  if (isChild(payload)) return 'child metadata';
  if (env.AI_DISPATCH_ROLE === 'general' || env.TWIN_AGENT_REMOTE === '1') return 'AI_DISPATCH_ROLE/TWIN_AGENT_REMOTE';
  const workspaces = resolvePath(path.join(saHome(env), 'archon', 'workspaces'));
  if (typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)) {
    const cwd = resolvePath(payload.cwd);
    if (cwd !== workspaces && within(cwd, workspaces)) return 'archon workspace';
  }
  // Codex hook payloads carry the turn model; a model in both pools stays commander.
  if (client === 'codex' && rootCall(payload) && typeof payload.model === 'string'
      && pool('general').includes(payload.model) && !pool('commander').includes(payload.model)) return `general 池模型 ${payload.model}`;
  return null;
}
// Tier whose context advisory threshold applies to this session.
function sessionRole(payload, client, env = process.env) {
  if (env.SUPERAGENT_ROLE === 'reviewer') return 'strategist';
  return derivedBy(payload, client, env) ? 'general' : 'commander';
}

const SHELL_TOOLS = ['Bash', 'exec_command', 'shell_command', 'shell', 'local_shell'];
// Shell text of a shell tool call; Codex `shell` passes argv, re-quoted here losslessly.
function shellText(name, input) {
  if (!SHELL_TOOLS.includes(name)) return undefined;
  const value = input.command ?? input.cmd;
  if (Array.isArray(value)) return value.map(arg => `'${String(arg).replace(/'/g, "'\\''")}'`).join(' ');
  return typeof value === 'string' ? value : undefined;
}
const stateFile = (payload, env) => {
  const session = payload.session_id || payload.transcript_path;
  return session ? path.join(saHome(env), 'hooks', `${crypto.createHash('sha256').update(String(session)).digest('hex')}.json`) : null;
};
// G-1: commander edits accumulate per session (never reset) against policy.micro_edit.
function commanderWrite(payload, client, env, text) {
  if (env.SUPERAGENT_ALLOW_COMMANDER_WRITE === '1') return null;
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const repo = gitRoot(cwd), root = resolvePath(repo || cwd);
  let edit;
  try {
    if (text !== undefined) {
      const parsed = parse(text), targets = parsed.writes;
      if (parsed.argvs.some(a => ['node','bun','python','python3','perl','ruby'].includes(path.posix.basename(a[0])) && a.slice(1).some(v => /^-(?:e|c|pe|pi)/.test(v))))
        throw new Error('内联脚本可能写代码，无法可靠计量；请交 superagent run');
      if (!targets.length) return null;
      // Shell output size and cwd-dependent destinations cannot be measured before execution.
      if (targets.some(t => !t || /[$`*?\[\]{}~]/.test(t)) || parsed.argvs.some(a => a[0] === 'cd'))
        throw new Error('无法确认 shell 写入范围');
      for (const target of targets) {
        const candidate = microEdit.plan('claude', {...payload, tool_name: 'Write', tool_input: {file_path: target, content: ''}}, root, resolvePath, repo);
        if (candidate.files.length) throw new Error('无法可靠计量 shell 代码写入；请用 Edit/Write/apply_patch 或 superagent run');
      }
      return null;
    }
    edit = microEdit.plan(client, payload, root, resolvePath, repo);
  } catch (error) { return {systemMessage: `SUPERAGENT advisory G-1: 无法计量本次写入（${error.message}），已放行；超过微改请走 superagent run。`}; }
  if (!edit.files.length) return null;
  const absolute = Object.fromEntries(['files', 'risk', 'newCode'].map(key => [key, edit[key].map(file => path.resolve(root, file))]));
  const file = stateFile(payload, env);
  const check = state => once(state, 'micro', payload, () => {
    const next = microEdit.accumulate(state.micro || {lines: 0, files: [], risk: [], newCode: []}, {...edit, ...absolute});
    state.micro = next;
    const prior = state.micro_notice;
    if (microEdit.violations(next).length && (!prior || next.lines >= prior.lines + 100
        || next.files.length >= prior.files + 2 || next.risk.some(file => !prior.risk.includes(file)))) {
      state.micro_notice = {lines: next.lines, files: next.files.length, risk: next.risk};
      const limit = policy.micro_edit;
      const scope = next.lines > limit.max_lines || next.files.length > limit.max_files
        ? `超过微改 ${limit.max_lines} 行/${limit.max_files} 文件` : '超出微改范围';
      const paths = next.risk.length ? `；命中风险路径：${next.risk.join(', ')}` : '';
      const fresh = next.newCode.length ? `；新建代码文件：${next.newCode.join(', ')}` : '';
      return {systemMessage: `SUPERAGENT advisory G-1: 本会话已改 ${next.lines} 行 / ${next.files.length} 个文件（${scope}）${paths}${fresh}，建议改用 superagent quick 交将军编码；本次不拦截。`};
    }
    return null;
  }, false);
  if (!file) return {systemMessage: 'SUPERAGENT advisory G-1: 缺少会话身份，无法累计本次写入，已放行。'};
  try { return withState(file, check); }
  catch (error) { return {systemMessage: `SUPERAGENT advisory G-1: 无法计量本次写入（${error.message}），已放行；请检查计量状态。`}; }
}

function decide(payload, client, env = process.env) {
  const event = payload.hook_event_name;
  const name = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const derived = derivedBy(payload, client, env);
  if (event !== 'PreToolUse') {
    if (derived || !['SessionStart', 'PostToolUse', 'SubagentStop', 'Stop'].includes(event)) return null;
    if (event === 'SessionStart') return require('./scratch.cjs').start(payload, client, env);
    return stopGate.gate(payload);
  }
  const text = shellText(name, input);
  const notices = new Set();
  if (SHELL_TOOLS.includes(name) && text === undefined) notices.add('shell_text_missing');
  let category = 'diagnostic';
  const red = redline.reason({client, name, input, cwd, root: gitRoot(cwd), shell: text, env,
    onCategory: value => { category = value; }, onAdvisory: code => notices.add(code)});
  if (red) return deny(red, category);
  const edit = microEdit.isEdit(client, name);
  const advisory = notices.size ? {systemMessage: `SUPERAGENT advisory：本次护栏无法完整确认命令效果，已放行（${[...notices].join(', ')}）。`} : null;
  if (derived) return advisory;
  const context = dispatch.contextReason(client, name, input, dispatch.contextPolicy(policy.dispatch_context));
  if (context) notices.add(context);
  if (client === 'codex' && name === 'spawn_agent' && input.model && ![...pool('general'), ...pool('strategist')].includes(input.model))
    notices.add('G-2: spawn_agent 的显式 model 建议属于将军或军师池；缺省使用 default_subagent_model。');
  const write = (edit || text !== undefined) && rootCall(payload) ? commanderWrite(payload, client, env, text) : null;
  if (write) return write;
  return notices.size ? {systemMessage: `SUPERAGENT advisory：${[...notices].join('; ')}。已放行。`} : advisory;
}

if (require.main === module) (async () => {
  try {
    const client = process.argv[2];
    if (!['claude', 'codex'].includes(client)) throw new Error('usage: guard.cjs claude|codex');
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    let inbox = [];
    try { inbox = require('./live.cjs').beat(client, payload, () => sessionRole(payload, client)) || []; } catch {}
    if (payload.hook_event_name === 'PreToolUse'
        && shellText(String(payload.tool_name || ''), payload.tool_input || {}) !== undefined) {
      const error = await redline.init();
      if (error) { /* decide records parser unavailability through the advisory channel. */ }
    }
    const result = decide(payload, client);
    const context = require('./coord.cjs').notifications(inbox);
    const output = context && (!result || payload.hook_event_name === 'SessionStart') ?
      {...result, hookSpecificOutput: {...result?.hookSpecificOutput, hookEventName: payload.hook_event_name,
        additionalContext: [result?.hookSpecificOutput?.additionalContext, context].filter(Boolean).join('\n')}} : result;
    if (client === 'codex' && output?.superagentPermissionCategory) {
      // Codex rejects unknown output properties; keep category in its native message channel.
      output.systemMessage = `superagent.permission.${output.superagentPermissionCategory}`;
      delete output.superagentPermissionCategory;
    }
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch { process.stdout.write(JSON.stringify({systemMessage: 'SUPERAGENT advisory：护栏内部异常，本次已放行。'}) + '\n'); }
})();
module.exports = {decide, derivedBy, sessionRole, isChild};
