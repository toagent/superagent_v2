'use strict';
// Read-only hook projection. Heartbeat owns the per-session seen IDs; registry writes belong to the CLI.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { same, presence } = require('./identity.cjs');
const { resolvePath } = require('./redline.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function files(home, dir) {
  const root = path.join(home, 'coord', dir);
  try {
    return fs
      .readdirSync(root)
      .filter(n => n.endsWith('.json'))
      .map(n => read(path.join(root, n)))
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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
      return { kind: 'repo', id: fs.realpathSync(git) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const label = owner =>
  owner ? `${owner.client} ${owner.session_id || `pid:${owner.pid}`}` : '无主';
function refusal(action, owner, state = 'unknown', scope) {
  const status = { online: '在线', offline: '离线', unknown: '状态未知' }[state];
  return `已拒绝：${action}\n原因：这个${scope?.kind === 'run' ? '运行' : '仓库'}由 ${label(owner)} 负责（${status}）\n可以：superagent handoff --to <path|run> … 或经用户同意 superagent claim --takeover --reason "<原话>"`;
}
// The CLI supplies verified run states; hooks use a read-only database snapshot, never a subprocess.
function candidates(home, archon = path.join(home, 'archon'), scope) {
  let db;
  try {
    db = process.versions.bun
      ? new (require('bun:sqlite').Database)(path.join(archon, 'archon.db'), { readonly: true })
      : new (require('node:sqlite').DatabaseSync)(path.join(archon, 'archon.db'), {
          readOnly: true,
        });
  } catch {} // Missing database means unknown, not terminal.
  try {
    const dir = path.join(home, 'runs');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
    return names
      .map(n => read(path.join(dir, n)))
      .filter(l => {
        if (scope?.kind === 'run') return l.run_id === scope.id;
        if (l.state === 'failed') return false;
        let status;
        try {
          const sql = 'select status from remote_agent_workflow_runs where id=?';
          status = (process.versions.bun ? db.query(sql) : db.prepare(sql)).get(
            l.archon_run_id
          )?.status;
        } catch {}
        return !['completed', 'cancelled'].includes(status);
      })
      .map(l => ({
        scope: runScope(l),
        owner: l.controller || l.launcher,
        generation: l.controller?.generation || 0,
        evidence: `nonterminal run ${l.run_id} ${l.controller ? 'controller' : 'legacy launcher'}`,
      }));
  } finally {
    db?.close();
  }
}
function resolveOwner(scope, claims, runs) {
  const repo = scope.kind === 'run' ? { kind: 'repo', id: scope.repo } : scope;
  const c = claims.find(c => hash(c.scope) === hash(scope));
  if (c)
    return {
      owner: c.owner,
      generation: c.generation,
      conflicts: [],
      evidence: [
        `explicit claim ${hash(c.scope)} generation=${c.generation}${c.owner ? '' : ' released'}`,
      ],
    };
  const matches = (typeof runs === 'function' ? runs(scope) : runs).filter(
    r =>
      (scope.kind === 'run'
        ? r.scope?.kind === 'run' && r.scope.id === scope.id
        : (r.scope?.repo || r.scope?.id) === repo.id) && r.owner
  );
  const distinct = matches.filter((r, i) => matches.findIndex(x => same(x.owner, r.owner)) === i);
  return {
    owner: distinct.length === 1 ? distinct[0].owner : null,
    generation: Math.max(0, ...distinct.map(r => r.generation)),
    conflicts: distinct.length > 1 ? distinct.map(r => r.owner) : [],
    evidence: distinct.map(r => r.evidence),
  };
}
// One target and admission contract for CLI, shim and hook. Both ledger IDs resolve before fallback.
function runScope(run) {
  const repo = repoScope(run.repo);
  if (!repo) throw new Error('coord: run repository unavailable');
  return { kind: 'run', id: run.run_id, repo: repo.id };
}
function resolveRun(home, target) {
  if (typeof target !== 'string') return undefined;
  const dir = path.join(home, 'runs');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
  const runs = names.map(n => read(path.join(dir, n)));
  const exact = runs.find(l => l.run_id === target || l.archon_run_id === target);
  if (exact) return exact;
  const matches = runs.filter(l => l.archon_run_id?.startsWith(target));
  return matches.length === 1 ? matches[0] : undefined;
}
function targetScope(home, target, cwd) {
  const run = resolveRun(home, target);
  return run ? runScope(run) : repoScope(cwd);
}
function admission(home, scope, who, expected, archon, resolved) {
  if (!scope) throw new Error('coord: cannot resolve mutation scope');
  const claims = files(home, 'claims'),
    view = resolved || resolveOwner(scope, claims, () => candidates(home, archon, scope));
  const owned = scope;
  const lease = read(
    path.join(
      home,
      'coord',
      'leases',
      hash([owned, require('./identity.cjs').key(who || {})]) + '.json'
    )
  );
  if (
    !same(view.owner, who) ||
    (expected !== undefined && expected !== view.generation) ||
    (claims.some(c => hash(c.scope) === hash(owned)) && lease?.generation !== view.generation)
  )
    throw new Error(
      refusal(
        `变更动作（owner/generation fencing ${scope.kind}:${scope.id}）`,
        view.owner,
        (view.presence || presence(view.owner, home)).state,
        scope
      )
    );
  return { ...who, generation: view.generation };
}
function archonMutation(argv) {
  if (!argv.length || ['version', 'help', 'doctor', 'validate', 'complete'].includes(argv[0]))
    return false;
  if (argv[0] === 'workflow')
    return ![
      'list',
      'runs',
      'get',
      'status',
      'wait',
      'events',
      'logs',
      'validate',
      'help',
    ].includes(argv[1]);
  return !(
    ['ai', 'user', 'isolation', 'telemetry'].includes(argv[0]) &&
    (['list', 'status', 'capacity'].includes(argv[1]) ||
      (['alias', 'tier'].includes(argv[1]) && argv[2] === 'list'))
  );
}
function unread(home, who, seen = [], archon) {
  const claims = files(home, 'claims'),
    runs = scope => candidates(home, archon, scope);
  return files(home, 'inbox').filter(
    m =>
      !seen.includes(m.id) &&
      (m.type === 'receipt' || m.type === 'takeover'
        ? same(m.recipient, who)
        : ['queued', 'surfaced', 'accepted', 'escalated'].includes(m.state) &&
          same(resolveOwner(m.scope, claims, runs).owner, who))
  );
}
function notifications(messages) {
  return messages.length
    ? `Superagent 交接待答复：${messages.map(m => `${m.id} (${m.type || m.kind})`).join('、')}。运行 superagent inbox；使用 inbox --ack <id> accepted|rejected|done --note <短文> 答复。`
    : null;
}
module.exports = {
  hash,
  read,
  files,
  repoScope,
  resolveOwner,
  runScope,
  resolveRun,
  targetScope,
  admission,
  archonMutation,
  label,
  refusal,
  unread,
  notifications,
};
