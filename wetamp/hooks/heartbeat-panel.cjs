#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const WETAMP = path.join(__dirname, '..');
const LOCK_STALE_MS = 60_000;

function gitRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let dir;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function projectName(root) {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return path.basename(root);
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8')),
      gitDir = match && path.resolve(root, match[1]),
      marker = `${path.sep}.git${path.sep}worktrees${path.sep}`,
      offset = gitDir ? gitDir.lastIndexOf(marker) : -1;
    if (offset >= 0) return path.basename(gitDir.slice(0, offset));
  } catch {}
  return path.basename(root);
}

function ensurePanel(payload, env = process.env) {
  if (!env.ORCA_AGENT_SESSION_ID) return false;
  const root = gitRoot(payload?.cwd);
  if (!root) return false;
  try {
    spawn(process.execPath, [__filename, 'ensure', root], {
      detached: true,
      stdio: 'ignore',
      env,
    }).unref();
    return true;
  } catch {
    return false;
  }
}

const live = terminal =>
  terminal && typeof terminal.handle === 'string' && terminal.connected === true && !terminal.orphaned;

function heartbeatHandles(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value.title === 'string' && value.title.startsWith('心跳')) {
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.handle === 'string') found.push(node.handle);
      for (const child of Object.values(node)) visit(child);
    };
    visit(value.panes);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'panes') heartbeatHandles(child, found);
  }
  return found;
}

function command(file, args, env) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.stderr?.trim() || result.error?.message || `${file} exit ${result.status}`);
  return JSON.parse(result.stdout);
}

function atomicWrite(file, value) {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function acquire(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {}
      if (!stale) return null;
      try {
        fs.unlinkSync(lock);
      } catch {}
    }
  }
  return null;
}

function createdHandle(output) {
  const result = output?.result;
  return typeof result?.handle === 'string'
    ? result.handle
    : typeof result?.terminal?.handle === 'string'
      ? result.terminal.handle
      : null;
}

function ensure(root, env = process.env) {
  const home = env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent'),
    panels = path.join(home, 'panels'),
    record = path.join(panels, `${crypto.createHash('sha256').update(root).digest('hex')}.json`),
    lock = `${record}.lock`;
  fs.mkdirSync(panels, { recursive: true, mode: 0o700 });
  const fd = acquire(lock);
  if (fd === null) return;
  try {
    const orca = env.ORCA_CLI_BIN_DIR ? path.join(env.ORCA_CLI_BIN_DIR, 'orca') : 'orca',
      selector = `path:${root}`,
      listed = command(
        orca,
        ['terminal', 'list', '--worktree', selector, '--include-visual-layouts', '--json'],
        env
      ),
      result = listed?.result || listed,
      terminals = Array.isArray(result?.terminals) ? result.terminals : [];
    let prior = null;
    try {
      prior = JSON.parse(fs.readFileSync(record, 'utf8'));
    } catch {}
    if (live(terminals.find(terminal => terminal.handle === prior?.handle))) return;
    const adopted = heartbeatHandles(result?.visualLayouts).find(handle =>
      live(terminals.find(terminal => terminal.handle === handle))
    );
    if (adopted) {
      atomicWrite(record, { handle: adopted });
      return;
    }
    // The shim routes to the promoted engine; bin/superagent in this checkout is a candidate
    // and refuses production state. The loop keeps the tab useful while the engine lacks the
    // verb (before promotion) or after a crash, instead of leaving a dead terminal.
    const superagent = path.join(WETAMP, 'bin', 'superagent-shim'),
      scope = root === path.dirname(WETAMP) ? ['--all'] : ['--cwd', root],
      watch = [superagent, 'heartbeat', '--watch', ...scope]
        .map(value => `'${value.replace(/'/g, "'\\''")}'`)
        .join(' '),
      shellCommand = `while true; do ${watch}; echo '心跳面板暂不可用，60 秒后重试'; sleep 60; done`,
      created = command(
        orca,
        [
          'terminal',
          'create',
          '--worktree',
          selector,
          '--title',
          `心跳·${projectName(root)}`,
          '--command',
          shellCommand,
          '--json',
        ],
        env
      ),
      handle = createdHandle(created);
    if (!handle) throw new Error('orca terminal create returned no handle');
    atomicWrite(record, { handle });
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}

function logFailure(error, env) {
  try {
    const dir = path.join(env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent'), 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'heartbeat-panel.log'),
      `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}\n`
    );
  } catch {}
}

if (require.main === module && process.argv[2] === 'ensure') {
  try {
    ensure(process.argv[3], process.env);
  } catch (error) {
    logFailure(error, process.env);
  }
}

module.exports = { ensurePanel };
