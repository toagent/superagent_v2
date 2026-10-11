'use strict';
// Read-only hook projection. Heartbeat owns the per-session seen IDs; registry writes belong to the CLI.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {same} = require('./identity.cjs');
const {resolvePath, effects, expand} = require('./redline.cjs');
const micro = require('./micro-edit.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function files(home, dir) {
  const root = path.join(home, 'coord', dir);
  try { return fs.readdirSync(root).filter(n => n.endsWith('.json')).map(n => read(path.join(root, n))).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
// Equivalent git-common-dir identity without spawning git from a hook (also follows linked worktrees).
function repoScope(file) {
  let dir = resolvePath(path.resolve(file));
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    const marker = path.join(dir, '.git');
    if (fs.existsSync(marker)) {
      let git = marker;
      if (!fs.statSync(marker).isDirectory()) {
        const text = fs.readFileSync(marker, 'utf8').trim();
        if (!text.startsWith('gitdir: ')) throw new Error(`invalid gitdir ${marker}`);
        git = path.resolve(dir, text.slice(8));
      }
      const common = path.join(git, 'commondir');
      if (fs.existsSync(common)) git = path.resolve(git, fs.readFileSync(common, 'utf8').trim());
      return {kind: 'repo', id: fs.realpathSync(git)};
    }
    const parent = path.dirname(dir); if (parent === dir) return null; dir = parent;
  }
}
const label = owner => owner ? `${owner.client} ${owner.session_id || `pid:${owner.pid}`}` : '无主';
function refusal(action, owner, state = 'unknown') {
  const status = {online: '在线', offline: '离线', unknown: '状态未知'}[state];
  return `已拒绝：${action}\n原因：这个仓库由 ${label(owner)} 负责（${status}）\n可以：superagent handoff --to <path|run> … 或经用户同意 superagent claim --takeover --reason "<原话>"`;
}
// The CLI supplies verified run states; hooks use a read-only database snapshot, never a subprocess.
function candidates(home, archon = path.join(home, 'archon')) {
  let db;
  try {
    db = process.versions.bun ? new (require('bun:sqlite').Database)(path.join(archon, 'archon.db'), {readonly: true}) :
      new (require('node:sqlite').DatabaseSync)(path.join(archon, 'archon.db'), {readOnly: true});
  } catch {} // Missing database means unknown, not terminal.
  try {
    const dir = path.join(home, 'runs');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
    return names.map(n => read(path.join(dir, n))).filter(l => {
      if (l.state === 'failed') return false;
      let status;
      try { const sql = 'select status from remote_agent_workflow_runs where id=?';
        status = (process.versions.bun ? db.query(sql) : db.prepare(sql)).get(l.archon_run_id)?.status; } catch {}
      return !['completed', 'cancelled'].includes(status);
    }).map(l => ({scope: repoScope(l.repo), owner: l.controller || l.launcher,
      generation: l.controller?.generation || 0, evidence: `nonterminal run ${l.run_id} ${l.controller ? 'controller' : 'legacy launcher'}`}));
  } finally { db?.close(); }
}
function resolveOwner(scope, claims, runs) {
  const repo = scope.kind === 'run' ? {kind: 'repo', id: scope.repo} : scope;
  const c = claims.find(c => hash(c.scope) === hash(scope)) || claims.find(c => hash(c.scope) === hash(repo));
  if (c) return {owner: c.owner, generation: c.generation, conflicts: [],
    evidence: [`explicit claim ${hash(c.scope)} generation=${c.generation}${c.owner ? '' : ' released'}`]};
  const matches = (typeof runs === 'function' ? runs() : runs).filter(r => r.scope?.id === repo.id && r.owner);
  const distinct = matches.filter((r, i) => matches.findIndex(x => same(x.owner, r.owner)) === i);
  return {owner: distinct.length === 1 ? distinct[0].owner : null,
    generation: Math.max(0, ...distinct.map(r => r.generation)),
    conflicts: distinct.length > 1 ? distinct.map(r => r.owner) : [], evidence: distinct.map(r => r.evidence)};
}
// One target and admission contract for CLI, shim and hook. Both ledger IDs resolve before fallback.
function targetScope(home, target, cwd) {
  const dir = path.join(home, 'runs');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
  const run = names.map(n => read(path.join(dir, n))).find(l => l.run_id === target || l.archon_run_id === target);
  if (run) return {kind: 'run', id: run.run_id, repo: repoScope(run.repo).id};
  return repoScope(cwd);
}
function admission(home, scope, who, expected, archon, resolved) {
  if (!scope) throw new Error('coord: cannot resolve mutation scope');
  const claims = files(home, 'claims'), view = resolved || resolveOwner(scope, claims, () => candidates(home, archon));
  const owned = claims.find(c => hash(c.scope) === hash(scope))?.scope ||
    (scope.kind === 'run' ? {kind: 'repo', id: scope.repo} : scope);
  const lease = read(path.join(home, 'coord', 'leases', hash([owned, require('./identity.cjs').key(who || {})]) + '.json'));
  if (!same(view.owner, who) || (expected !== undefined && expected !== view.generation) ||
      (claims.some(c => hash(c.scope) === hash(owned)) && lease?.generation !== view.generation))
    throw new Error(refusal('变更动作（owner/generation fencing）', view.owner));
  return {...who, generation: view.generation};
}
function archonMutation(argv) {
  if (!argv.length || ['version', 'help', 'doctor', 'validate', 'complete'].includes(argv[0])) return false;
  if (argv[0] === 'workflow') return !['list', 'runs', 'get', 'status', 'wait', 'events', 'logs', 'validate', 'help'].includes(argv[1]);
  return !(['ai', 'user', 'isolation', 'telemetry'].includes(argv[0]) &&
    (['list', 'status', 'capacity'].includes(argv[1]) || ['alias', 'tier'].includes(argv[1]) && argv[2] === 'list'));
}
function unread(home, who, seen = [], archon) {
  const claims = files(home, 'claims'), runs = () => candidates(home, archon);
  return files(home, 'inbox').filter(m => !seen.includes(m.id) &&
    (m.type === 'receipt' || m.type === 'takeover' ? same(m.recipient, who) :
      ['queued', 'surfaced', 'accepted', 'escalated'].includes(m.state) && same(resolveOwner(m.scope, claims, runs).owner, who)));
}
function notifications(messages) {
  return messages.length ? `Superagent 交接待答复：${messages.map(m => `${m.id} (${m.type || m.kind})`).join('、')}。运行 superagent inbox；使用 inbox --ack <id> accepted|rejected|done --note <短文> 答复。` : null;
}
function writeReason(payload, client, env, shell, readonly) {
  const home = env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent');
  const cwd = payload.cwd || process.cwd(), name = String(payload.tool_name || ''), input = payload.tool_input || {};
  const claims = files(home, 'claims'), runs = () => candidates(home, env.ARCHON_HOME);
  const beats = (() => { try { return fs.readdirSync(path.join(home, 'live')).map(n => read(path.join(home, 'live', n))); } catch { return []; } })();
  const who = beats.find(b => b?.client === client && b.session_id === payload.session_id && b.host === os.hostname());
  const check = (file, dir) => {
    if (!file || /[$`*?]/.test(file)) return null;
    const scope = repoScope(path.resolve(dir, file)); if (!scope) return null;
    const view = resolveOwner(scope, claims, runs);
    return view.owner && !same(view.owner, who) ? refusal('向其他元帅负责的仓库写文件，请改用 handoff', view.owner) : null;
  };
  if (micro.isEdit(client, name)) {
    const edits = client === 'codex' ? micro.patchEdits(input).map(e => e.file) : [input.file_path || input.notebook_path];
    for (const file of edits) { const why = check(file, cwd); if (why) return why; }
  }
  if (shell === undefined) return null;
  // The existing shell parser exposes literal writes and scoped cwd; read-only invocations pass.
  const why = require('./shell-ast.cjs').analyze(shell, input.workdir || cwd, env, (parsed, dir) => {
    for (const file of [...parsed.writes, ...parsed.argvs.flatMap(effects).filter(a => ['create','destroy','overwrite','write'].includes(a.effect)).map(a => a.target)]) { const why = check(file, dir); if (why) return why; }
    for (const argv of parsed.argvs) {
      const name = path.basename(argv[0] || ''), args = argv.slice(1);
      const option = key => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) || (args.includes(key) ? args[args.indexOf(key) + 1] : undefined);
      const command = args.filter((a, i) => !a.startsWith('-') && !['--cwd', '--run-id', '--adopt'].includes(args[i - 1]));
      if (name === 'archon' && archonMutation(command)) {
        if (args.includes('--help') || args.includes('-h')) continue;
        if (command[1] === 'wake' && !command[2]) return refusal('全局 wake 未限定 run', null);
        try { admission(home, targetScope(home, command[0] === 'workflow' ? command[1] === 'event' ? option('--run-id') : command[1] === 'run' ? option('--adopt') : command[2] : undefined, option('--cwd') ? path.resolve(dir, option('--cwd')) : dir), who, undefined, env.ARCHON_HOME); }
        catch (error) { return error.message; }
      }
      if (name === 'git' && !readonly([name, ...args])) {
        const at = argv.indexOf('-C');
        const why = check('.', at >= 0 && argv[at + 1] ? path.resolve(dir, argv[at + 1]) : dir); if (why) return why;
      }
      const inplace = name === 'sed' && args.some(a => a === '--in-place' || /^-i/.test(a)) ||
        name === 'perl' && args.some(a => /^-[^-]*i/.test(a));
      if (name === 'mv' || inplace) for (const file of args.filter(a => !a.startsWith('-'))) {
        const why = check(file, dir); if (why) return why;
      }
      if (['npm', 'bun', 'yarn', 'pnpm'].includes(name) && ['install', 'add', 'remove', 'update', 'upgrade'].includes(args[0])) {
        const why = check('.', dir); if (why) return why;
      }
    }
    return null;
  }, word => expand(word, env));
  return why?.startsWith('已拒绝：') ? why : null;
}
module.exports = {hash, read, files, repoScope, resolveOwner, targetScope, admission, archonMutation, label, refusal, unread, notifications, writeReason};
