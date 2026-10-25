#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const identity = require('./identity.cjs'),
  live = require('./live.cjs');
const { resolvePath, within } = require('./redline.cjs');
const { withLock, atomicWrite } = require('./hook-state.cjs');
function createScratch(ROOT) {
  if (
    typeof ROOT !== 'string' ||
    !path.isAbsolute(ROOT) ||
    path.resolve(ROOT) !== ROOT ||
    ROOT === path.parse(ROOT).root
  )
    throw new Error('scratch root must be a normalized absolute child path');
  // Fix the identity from the existing parent, never by probing the production root.
  const CANONICAL =
    ROOT === '/tmp/sa-scratch'
      ? '/private/tmp/sa-scratch'
      : path.join(fs.realpathSync(path.dirname(ROOT)), path.basename(ROOT));
  // Keep session locks outside the removable directory, including across /tmp aliases.
  const sessionLock = dir => path.join(ROOT, `.${path.basename(dir)}`);
  const clients = ['claude', 'codex'];
  function validate(dir) {
    if (
      fs.lstatSync(ROOT).isSymbolicLink() ||
      fs.realpathSync(ROOT) !== CANONICAL ||
      fs.lstatSync(dir).isSymbolicLink() ||
      !fs.lstatSync(dir).isDirectory() ||
      path.dirname(fs.realpathSync(dir)) !== CANONICAL
    )
      throw new Error('scratch path outside direct root or symlink');
    return fs.realpathSync(dir);
  }
  function readOwner(dir) {
    const file = path.join(dir, '.owner.json');
    if (!fs.lstatSync(file).isFile()) throw new Error('scratch owner is not a regular file');
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !clients.includes(o.client) ||
      typeof o.session !== 'string' ||
      !o.session ||
      path.basename(dir) !== `${o.client}-${o.session}` ||
      !validProcess(o)
    )
      throw new Error('scratch owner identity invalid');
    return o;
  }
  function exited(o) {
    const probe = identity.inspect(o.pid);
    return probe.state === 'offline' || (probe.state === 'online' && probe.start !== o.pid_start);
  }
  const validProcess = o =>
    Number.isSafeInteger(o?.pid) && o.pid > 1 && typeof o.pid_start === 'string' && o.pid_start;
  function directory(client, session) {
    if (!clients.includes(client) || typeof session !== 'string' || !session)
      throw new Error('scratch session path invalid');
    if (path.basename(session) !== session || ['.', '..'].includes(session))
      throw new Error('scratch session path invalid');
    return path.join(ROOT, `${client}-${session}`);
  }
  function start(payload, client, env = process.env) {
    if (typeof payload.session_id !== 'string' || !payload.session_id) return null;
    const dir = directory(client, payload.session_id);
    const who = live.owner(),
      probe = who && identity.inspect(who.pid);
    if (!who || probe.state !== 'online')
      throw new Error('scratch client process identity unavailable');
    // R1-1: reject parent drift before creating anything through the changed alias.
    if (path.join(fs.realpathSync(path.dirname(ROOT)), path.basename(ROOT)) !== CANONICAL)
      throw new Error('scratch root invalid');
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(ROOT).isSymbolicLink() || fs.realpathSync(ROOT) !== CANONICAL)
      throw new Error('scratch root invalid');
    return withLock(sessionLock(dir), () => {
      let created = true;
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        created = false;
      }
      validate(dir);
      const file = path.join(dir, '.owner.json');
      let rewrite = created;
      if (!created) {
        const prior = readOwner(dir);
        rewrite = prior.pid !== who.pid || prior.pid_start !== probe.start;
        if (rewrite && !exited(prior)) throw new Error('scratch owner mismatch');
      }
      if (rewrite)
        fs.writeFileSync(
          file,
          JSON.stringify({
            client,
            session: payload.session_id,
            pid: who.pid,
            pid_start: probe.start,
            created: new Date().toISOString(),
          }),
          { flag: created ? 'wx' : 'w', mode: 0o600 }
        );
      if (client === 'claude' && env.CLAUDE_ENV_FILE)
        fs.appendFileSync(env.CLAUDE_ENV_FILE, `export TMPDIR='${dir.replace(/'/g, "'\\''")}/'\n`);
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `scratch: ${dir}/`,
        },
      };
    });
  }
  function transfer(client, session, to) {
    const dir = directory(client, session),
      result = { path: dir, action: 'skipped', reason: 'scratch missing' };
    if (!fs.existsSync(dir)) return result;
    if (!validProcess(to)) throw new Error('scratch target identity invalid');
    return withLock(sessionLock(dir), () => {
      validate(dir);
      const file = path.join(dir, '.owner.json'),
        prior = readOwner(dir);
      if (prior.pid === to.pid && prior.pid_start === to.pid_start)
        return { ...result, reason: 'scratch owner unchanged' };
      atomicWrite(
        file,
        JSON.stringify({
          ...prior,
          pid: to.pid,
          pid_start: to.pid_start,
          transferred_from: { pid: prior.pid, pid_start: prior.pid_start },
          transferred_at: new Date().toISOString(),
        })
      );
      return { path: dir, action: 'transferred', reason: 'scratch owner transferred' };
    });
  }
  function cleanOne(dir, dryRun, referenced) {
    const result = { path: dir, action: 'skipped', reason: '' };
    try {
      validate(dir);
      return withLock(sessionLock(dir), () => {
        const real = validate(dir),
          o = readOwner(dir);
        if (!exited(o)) throw new Error('scratch owner alive or unknown');
        if (referenced(dir) || (real !== dir && referenced(real)))
          throw new Error('nonterminal run plan references scratch');
        const linked = [],
          repos = [],
          modules = [];
        const walk = d => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, e.name);
            if (e.name === '.git') {
              if (e.isFile()) linked.push(d);
              else if (e.isDirectory()) repos.push(d);
              else throw new Error('scratch .git symlink refused');
            } else if (e.isSymbolicLink() && e.name === 'node_modules') modules.push(f);
            else if (e.isDirectory()) walk(f);
          }
        };
        const git = (repo, ...args) => {
          const p = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
          if (p.error || p.status !== 0)
            throw new Error(p.stderr || p.error?.message || `git exit ${p.status}`);
          return p.stdout;
        };
        const trees = repo =>
          git(repo, 'worktree', 'list', '--porcelain', '-z')
            .split('\0')
            .filter(f => f.startsWith('worktree '))
            .map(f => resolvePath(f.slice(9)));
        walk(real);
        for (const repo of repos)
          if (trees(repo).some(w => !within(w, real)))
            throw new Error('scratch repository has an outside worktree');
        const removals = linked
          .sort((a, b) => b.length - a.length)
          .map(w => {
            const common = path.resolve(w, git(w, 'rev-parse', '--git-common-dir').trim());
            const main = path.basename(common) === '.git' ? path.dirname(common) : common;
            if (!within(resolvePath(w), real) || !trees(main).includes(w))
              throw new Error('scratch linked worktree registration mismatch');
            return { main, w };
          });
        if (!dryRun) {
          for (const f of modules) if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f);
          for (const { main, w } of removals) {
            validate(dir);
            git(main, 'worktree', 'remove', '--force', w);
          }
          if (fs.existsSync(dir)) {
            validate(dir);
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
        result.action = dryRun ? 'would_remove' : 'removed';
        result.reason = 'scratch owner exited';
        return result;
      });
    } catch (e) {
      result.reason = e.message;
    }
    return result;
  }
  function clean(session, dryRun, referenced) {
    if (!fs.existsSync(ROOT)) return [];
    const out = [];
    try {
      if (fs.lstatSync(ROOT).isSymbolicLink() || fs.realpathSync(ROOT) !== CANONICAL)
        throw new Error('scratch root invalid');
      for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (
          !(e.isDirectory() || e.isSymbolicLink()) ||
          (session !== undefined && !clients.some(c => e.name === `${c}-${session}`))
        )
          continue;
        const result = cleanOne(path.join(ROOT, e.name), dryRun, referenced);
        out.push(result);
        if (!dryRun)
          fs.appendFileSync(
            path.join(ROOT, '.log'),
            JSON.stringify({ ...result, at: new Date().toISOString() }) + '\n',
            {
              flag:
                fs.constants.O_WRONLY |
                fs.constants.O_APPEND |
                fs.constants.O_CREAT |
                fs.constants.O_NOFOLLOW,
              mode: 0o600,
            }
          );
      }
    } catch (e) {
      out.push({ path: ROOT, action: 'skipped', reason: e.message });
    }
    return out;
  }
  return { ROOT, directory, start, transfer, clean, cleanOne };
}
module.exports = { ...createScratch('/tmp/sa-scratch'), createScratch };
