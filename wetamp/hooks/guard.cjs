#!/usr/bin/env node
'use strict';
// superagent V2 guard for Claude Code / Codex hooks: `node guard.cjs claude|codex`.
// Own failures never deny: an internal error is reported on stderr and exits 0.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {tiers, policy} = require('../tiers.json');
const {commands, parse, deletionTarget} = require('./shell.cjs');
const microEdit = require('./micro-edit.cjs');
const stopGate = require('./stop-gate.cjs');
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
  return hit ? `禁止删除 ${path.basename(target) || target}：它是或包含受保护目录` : null;
}

// Reviewer shells run an allowlist of read-only commands; anything else, any output
// redirection and any unparsable or dynamic command head is denied.
const READ_ONLY = new Set(['cat','head','tail','wc','grep','egrep','fgrep','rg','ls','stat','file','diff','cmp','sort','uniq','cut','tr','nl','column','sed','jq','echo','printf','pwd','which','type','realpath','dirname','basename','readlink','date','true','false','test','[','[[',':','cd','sleep','tree','find','git']);
const GIT_READ = new Set(['status','diff','log','show','rev-parse','ls-files','ls-tree','blame','grep','cat-file','describe','merge-base','rev-list','shortlog','show-ref','name-rev','for-each-ref']);
const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p(?:;(?:\d+|\$)(?:,(?:\d+|\$))?p)*$/;
function gitReadOnly(argv) {
  let i = 1;
  while (argv[i]?.startsWith('-')) {
    // -c/--config-env/--exec-path can install a pager, diff driver or helper command.
    if (['-c', '--config-env'].includes(argv[i]) || argv[i].startsWith('--exec-path')) return false;
    i += GIT_VALUE_OPTIONS.includes(argv[i]) ? 2 : 1;
  }
  const [sub, ...rest] = argv.slice(i);
  if (rest.some(arg => /^--output|^--open-files-in-pager|^-O/.test(arg))) return false;
  if (GIT_READ.has(sub)) return true;
  const only = (...allowed) => rest.every(arg => allowed.includes(arg));
  if (sub === 'reflog') return !rest.length || rest[0] === 'show';
  if (sub === 'branch') return only('-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current');
  if (sub === 'tag') return ['-l', '--list'].includes(rest[0]) && rest.length <= 2;
  if (sub === 'remote') return only('-v', '--verbose');
  if (sub === 'config') return ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(rest[0]);
  if (sub === 'worktree' || sub === 'stash') return rest[0] === 'list' || sub === 'stash' && rest[0] === 'show';
  return false;
}
function readOnly(argv) {
  const [name, ...args] = argv;
  if (!READ_ONLY.has(name)) return false;
  const options = args.filter(arg => arg.startsWith('-')), operands = args.filter(arg => !arg.startsWith('-'));
  switch (name) {
    case 'sort': return !options.some(arg => /^-[^-]*o|^--output/.test(arg));
    case 'uniq': return operands.length <= 1;
    case 'tree': return !options.some(arg => /^-[^-]*o/.test(arg));
    case 'rg': return !options.some(arg => arg.startsWith('--pre'));
    case 'find': return !args.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
    case 'sed': return options.every(arg => ['-n', '-E', '-r'].includes(arg)) && options.includes('-n') && SED_PRINT.test(operands[0] ?? '');
    case 'git': return gitReadOnly(argv);
    default: return true;
  }
}
function reviewerShell(text) {
  let parsed; try { parsed = parse(text); } catch (error) { return `命令无法解析（${error.message}）`; }
  if (parsed.writes.length) return `禁止输出重定向到 ${path.basename(parsed.writes[0]) || parsed.writes[0]}`;
  const bad = parsed.argvs.find(argv => !readOnly(argv));
  return bad ? `${bad[0]} 不在只读白名单或带写入参数` : null;
}

const stateFile = (payload, env) => {
  const session = payload.session_id || payload.transcript_path;
  return session ? path.join(saHome(env), 'hooks', `${crypto.createHash('sha256').update(String(session)).digest('hex')}.json`) : null;
};
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
  const file = stateFile(payload, env);
  const check = state => {
    const next = microEdit.accumulate(state.micro || {lines: 0, files: [], risk: [], newCode: []}, {...edit, ...absolute});
    const reasons = microEdit.violations(next);
    if (reasons.length) return deny(`G-1: ${reasons.join('；')}；超过微改，请写 plan 交 superagent run 由将军编码`);
    state.micro = next;
    return null;
  };
  try { return file ? stopGate.withState(file, check) : check({}); }
  catch (error) { return deny(`G-1: 无法计量本次写入（${error.message}），请稍后重试`); }
}
// Write targets of an edit tool, or the cwd for a shell; [] for read-only tools.
function writeRoots(client, name, input, cwd) {
  if (shellText(name, input) !== undefined) return [gitRoot(cwd)];
  if (!microEdit.isEdit(client, name)) return [];
  const files = client === 'codex' ? microEdit.patchEdits(input).map(edit => edit.file) : [input.file_path || input.notebook_path];
  return files.filter(file => typeof file === 'string' && file).map(file => {
    let parent = path.dirname(resolvePath(path.resolve(cwd, file)));
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    return gitRoot(parent);
  });
}

function decide(payload, client, env = process.env) {
  const event = payload.hook_event_name;
  const name = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const derived = derivedBy(payload, client, env);
  if (event !== 'PreToolUse') {
    if (derived || !['SessionStart', 'PostToolUse', 'SubagentStop', 'Stop'].includes(event)) return null;
    return stopGate.gate(stateFile(payload, env), payload, client, [gitRoot(cwd)], rootCall(payload));
  }
  if (derived) {
    const reason = nestedReason(name, input);
    if (reason) return deny(`${reason}（判定：${derived}）`);
  }
  const text = shellText(name, input);
  if (text !== undefined) {
    const reason = shellReason(text, cwd, env);
    if (reason) return deny(reason);
  }
  const edit = microEdit.isEdit(client, name);
  if (env.SUPERAGENT_ROLE === 'reviewer') {
    if (edit) return deny('reviewer 只读：军师会话禁止编辑文件');
    const reason = text !== undefined && reviewerShell(text);
    if (reason) return deny(`reviewer 只读：${reason}`);
  }
  if (derived) return null;
  const context = dispatch.contextReason(client, name, input, dispatch.contextPolicy(policy.dispatch_context));
  if (context) return deny(context);
  if (client === 'codex' && name === 'spawn_agent' && input.model && ![...pool('general'), ...pool('strategist')].includes(input.model))
    return deny('G-2: spawn_agent 的显式 model 必须属于将军或军师池；缺省使用 default_subagent_model。');
  const write = edit && rootCall(payload) ? commanderWrite(payload, client, env) : null;
  if (write) return write;
  let roots; try { roots = writeRoots(client, name, input, cwd); } catch { roots = [gitRoot(cwd)]; }
  return stopGate.gate(stateFile(payload, env), payload, client, roots, rootCall(payload));
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
