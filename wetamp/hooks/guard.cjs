#!/usr/bin/env node
'use strict';
// superagent V2 guard for Claude Code / Codex hooks: `node guard.cjs claude|codex`.
// Own failures never deny: an internal error is reported on stderr and exits 0.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tiers, policy} = require('../tiers.json');
const {commands, deletionTarget} = require('./shell.cjs');
const microEdit = require('./micro-edit.cjs');
const dispatch = require('./dispatch-context.cjs');

const saHome = env => env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent');
const pool = tier => tiers[tier].pools.chatgpt;
const deny = reason => ({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}});
// Only two nonempty strings establish a child (subagent) call.
const rootCall = payload => !(typeof payload.agent_type === 'string' && payload.agent_type.trim() && typeof payload.agent_id === 'string' && payload.agent_id.trim());
// child is parent itself or below it.
const within = (child, parent) => { const r = path.relative(parent, child); return !r.startsWith('..') && !path.isAbsolute(r); };
function resolvePath(file) {
  let cursor = file; const tail = [];
  while (!fs.existsSync(cursor)) {
    tail.unshift(path.basename(cursor)); const parent = path.dirname(cursor);
    if (parent === cursor) return file;
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...tail);
}
function gitRoot(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  return r.status === 0 ? r.stdout.trim() : null;
}

// Why this session is derived (general/reviewer/worker), or null for the commander.
function derivedBy(payload, client, env = process.env) {
  if (['general', 'reviewer', 'worker'].includes(env.SUPERAGENT_ROLE)) return `SUPERAGENT_ROLE=${env.SUPERAGENT_ROLE}`;
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
function nestedReason(name, input) {
  if (['Agent', 'Task', 'spawn_agent', 'claude.Agent'].includes(name) || name.startsWith('mcp__claude__'))
    return `N-1: 派生会话禁止再派生（工具 ${name}）；在本会话内完成，或把需求回报元帅`;
  const text = shellText(name, input);
  if (text === undefined) return null;
  let heads;
  // Unparsable text: every word counts as a possible command head (conservative).
  try { heads = commands(text).map(argv => argv[0]); } catch { heads = text.split(/[\s;&|()`$"'<>]+/); }
  const hit = heads.map(head => path.posix.basename(head)).find(aiCli);
  return hit ? `N-1: 派生会话禁止调用 ${hit} 再派生 AI；在本会话内完成，或把需求回报元帅` : null;
}
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
function gitReason(argv) {
  if (path.posix.basename(argv[0]) !== 'git') return null;
  let i = 1;
  while (argv[i]?.startsWith('-')) i += GIT_VALUE_OPTIONS.includes(argv[i]) ? 2 : 1;
  if (argv[i] === 'push') return '禁止 AI 执行 git push（含 force push）：push/发布一律人工执行';
  if (argv[i] === 'reset' && argv.includes('--hard')) return '禁止 AI 执行 git reset --hard：历史改写一律人工执行';
  return null;
}
function shellReason(text, cwd, env) {
  let argvs; try { argvs = commands(text); } catch { return null; }
  for (const argv of argvs) { const reason = gitReason(argv); if (reason) return reason; }
  const target = deletionTarget(text, cwd);
  if (!target) return null;
  const resolved = resolvePath(target);
  const guarded = ['/', os.homedir(), saHome(env), gitRoot(cwd)].filter(Boolean).map(resolvePath);
  const hit = guarded.find(root => within(root, resolved));
  return hit ? `禁止删除 ${target}：它是或包含受保护目录 ${hit}` : null;
}

// G-1: commander edits accumulate per session (never reset) against policy.micro_edit.
function commanderWrite(payload, client, env) {
  if (env.SUPERAGENT_ALLOW_COMMANDER_WRITE === '1') return null;
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const repo = gitRoot(cwd), root = resolvePath(repo || cwd);
  let edit;
  try { edit = microEdit.plan(client, payload, root, resolvePath, repo); }
  catch (error) { return {systemMessage: `SUPERAGENT G-1: 无法计量本次写入（${error.message}），已放行；超过微改请走 superagent run。`}; }
  if (!edit.files.length) return null;
  const absolute = Object.fromEntries(['files', 'risk', 'newCode'].map(key => [key, edit[key].map(file => path.resolve(root, file))]));
  const session = payload.session_id || payload.transcript_path;
  const file = session ? path.join(saHome(env), 'hooks', `${crypto.createHash('sha256').update(String(session)).digest('hex')}.json`) : null;
  let prior = {lines: 0, files: [], risk: [], newCode: []};
  try { if (file) prior = JSON.parse(fs.readFileSync(file, 'utf8')).micro || prior; } catch {}
  const next = microEdit.accumulate(prior, {...edit, ...absolute});
  const reasons = microEdit.violations(next);
  if (reasons.length) return deny(`G-1: ${reasons.join('；')}；超过微改，请写 plan 交 superagent run 由将军编码`);
  if (file) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({micro: next}));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }
  return null;
}

function decide(payload, client, env = process.env) {
  const event = payload.hook_event_name;
  if (event === 'Stop' || event === 'SubagentStop') {
    const gate = policy.stop_gate ?? 'off';
    // V2 has no tree fingerprints; any value other than off is a config error made visible.
    return gate === 'off' ? null : {systemMessage: `SUPERAGENT: stop_gate=${gate} 在 V2 hooks 未实现（只支持 off），请修正 tiers.json。`};
  }
  if (event !== 'PreToolUse') return null;
  const name = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const derived = derivedBy(payload, client, env);
  if (derived) {
    const reason = nestedReason(name, input);
    if (reason) return deny(`${reason}（判定：${derived}）`);
  }
  const text = shellText(name, input);
  if (text !== undefined) {
    const reason = shellReason(text, typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), env);
    if (reason) return deny(reason);
  }
  const edit = microEdit.isEdit(client, name);
  if (edit && env.SUPERAGENT_ROLE === 'reviewer') return deny('reviewer 只读：军师会话禁止编辑文件');
  if (derived) return null;
  const context = dispatch.contextReason(client, name, input, dispatch.contextPolicy(policy.dispatch_context));
  if (context) return deny(context);
  if (client === 'codex' && name === 'spawn_agent' && input.model && ![...pool('general'), ...pool('strategist')].includes(input.model))
    return deny('G-2: spawn_agent 的显式 model 必须属于将军或军师池；缺省使用 default_subagent_model。');
  return edit && rootCall(payload) ? commanderWrite(payload, client, env) : null;
}

if (require.main === module) {
  try {
    const client = process.argv[2];
    if (!['claude', 'codex'].includes(client)) throw new Error('usage: guard.cjs claude|codex');
    const result = decide(JSON.parse(fs.readFileSync(0, 'utf8')), client);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(`superagent guard: ${error.message}\n`); }
}
module.exports = {decide, derivedBy, sessionRole};
