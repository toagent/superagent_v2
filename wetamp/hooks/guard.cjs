#!/usr/bin/env node
'use strict';
// superagent V2 guard for Claude Code / Codex hooks: `node guard.cjs claude|codex`.
// Unknown effects and parser/internal failures are visible advisories, never a hold.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tiers, policy} = require('../tiers.json');
const {parse, commands, deletionTarget} = require('./shell.cjs');
const microEdit = require('./micro-edit.cjs');
const stopGate = require('./stop-gate.cjs');
const {withState, once} = require('./hook-state.cjs');
const dispatch = require('./dispatch-context.cjs');
const redline = require('./redline.cjs');
const {resolvePath, within} = redline;

const saHome = env => env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent');
const pool = tier => tiers[tier].pools.chatgpt;
const deny = reason => ({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}});
// Only two nonempty strings establish a child (subagent) call.
const isChild = payload => Boolean(typeof payload.agent_type === 'string' && payload.agent_type.trim() && typeof payload.agent_id === 'string' && payload.agent_id.trim());
const rootCall = payload => !isChild(payload);
function gitRoot(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  return r.status === 0 ? r.stdout.trim() : null;
}

// Why this session is derived (general/reviewer/worker), or null for the commander.
function derivedBy(payload, client, env = process.env) {
  if (['general', 'reviewer', 'worker'].includes(env.SUPERAGENT_ROLE)) return `SUPERAGENT_ROLE=${env.SUPERAGENT_ROLE}`;
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
// Tier whose autocompact budget applies to this session.
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
const aiCli = name => ['claude', 'codex', 'opencode', 'sol-run'].includes(name) || name.startsWith('twin-agent');
// N-1: a derived session must not start another agent.
function nestedReason(name, input, normalized) {
  if (['Agent', 'Task', 'spawn_agent', 'claude.Agent'].includes(name) || name.startsWith('mcp__claude__'))
    return redline.message(`派生会话再次调用 AI（${name}）`, '派生会话不能再派生或委派', '在本会话完成，或回报元帅');
  const text = shellText(name, input);
  if (text === undefined) return null;
  let heads;
  // Unparsable text: every word counts as a possible command head (conservative).
  try { heads = (normalized?.argvs || commands(text)).map(argv => argv[0]); } catch { heads = text.split(/[\s;&|()`$"'<>]+/); }
  const hit = heads.map(head => path.posix.basename(head)).find(aiCli);
  return hit ? redline.message(`派生会话再次调用 AI（${hit}）`, '派生会话不能再派生或委派', '在本会话完成，或回报元帅') : null;
}
function shellReason(text, cwd, env, normalized) {
  const target = deletionTarget(text, cwd, normalized?.argvs.length === 1 ? normalized.argvs[0] : normalized ? [] : undefined);
  if (!target) return null;
  const resolved = resolvePath(target);
  const guarded = ['/', os.homedir(), saHome(env), gitRoot(cwd)].filter(Boolean).map(resolvePath);
  return guarded.some(root => within(root, resolved))
    ? redline.message(`删除 ${target}`, '它是或包含受保护目录', '只删除本任务的明确产物文件') : null;
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
      const parsed = parse(text), targets = [...parsed.writes, ...parsed.argvs.flatMap(redline.effects).filter(a => ['create', 'destroy', 'overwrite', 'write'].includes(a.effect)).map(a => a.target)];
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
    const reasons = microEdit.violations(next);
    if (reasons.length) return deny(`G-1: ${reasons.join('；')}；超过微改，请写 plan 交 superagent run 由将军编码`);
    state.micro = next;
    return null;
  });
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
    return stopGate.gate(payload);
  }
  const text = shellText(name, input);
  const notices = new Set();
  if (SHELL_TOOLS.includes(name) && text === undefined) notices.add('shell_text_missing');
  const normalized = text !== undefined ? {argvs: [], writes: [], reads: []} : undefined;
  const red = redline.reason({client, name, input, cwd, root: gitRoot(cwd), shell: text, derived: Boolean(derived),
    reviewer: env.SUPERAGENT_ROLE === 'reviewer', env, onAdvisory: code => notices.add(code),
    onCommand: normalized && (parsed => { for (const key of Object.keys(normalized)) normalized[key].push(...parsed[key]); })});
  if (red) return deny(red);
  if (derived) {
    const reason = nestedReason(name, input, normalized);
    if (reason) return deny(reason);
  }
  if (text !== undefined) {
    const reason = shellReason(text, cwd, env, normalized);
    if (reason) return deny(reason);
  }
  const edit = microEdit.isEdit(client, name);
  const advisory = notices.size ? {systemMessage: `SUPERAGENT advisory：本次护栏无法完整确认命令效果，已放行（${[...notices].join(', ')}）。`} : null;
  if (derived) return advisory;
  const context = dispatch.contextReason(client, name, input, dispatch.contextPolicy(policy.dispatch_context));
  if (context) return deny(context);
  if (client === 'codex' && name === 'spawn_agent' && input.model && ![...pool('general'), ...pool('strategist')].includes(input.model))
    return deny('G-2: spawn_agent 的显式 model 必须属于将军或军师池；缺省使用 default_subagent_model。');
  const write = (edit || text !== undefined) && rootCall(payload) ? commanderWrite(payload, client, env, text) : null;
  if (write) return write;
  return advisory;
}

if (require.main === module) (async () => {
  try {
    const client = process.argv[2];
    if (!['claude', 'codex'].includes(client)) throw new Error('usage: guard.cjs claude|codex');
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    try { require('./live.cjs').beat(client, payload, () => sessionRole(payload, client)); } catch {}
    if (payload.hook_event_name === 'PreToolUse'
        && shellText(String(payload.tool_name || ''), payload.tool_input || {}) !== undefined) {
      const error = await redline.init();
      if (error) { /* decide records parser unavailability through the advisory channel. */ }
    }
    const result = decide(payload, client);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch { process.stdout.write(JSON.stringify({systemMessage: 'SUPERAGENT advisory：护栏内部异常，本次已放行。'}) + '\n'); }
})();
module.exports = {decide, derivedBy, sessionRole, isChild};
