#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const WETAMP = path.join(__dirname, '..');
const LOCK_STALE_MS = 60_000;
const RESCAN_DELAY_MS = 10_000;

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
  terminal &&
  typeof terminal.handle === 'string' &&
  terminal.connected === true &&
  !terminal.orphaned;

function firstHandle(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.handle === 'string') return value.handle;
  for (const child of Object.values(value)) {
    const handle = firstHandle(child);
    if (handle) return handle;
  }
  return null;
}

function panelHandles(value, title, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.title === title) {
    const handle = firstHandle(value.panes);
    if (handle) found.push(handle);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'panes') panelHandles(child, title, found);
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
    throw new Error(
      result.stderr?.trim() || result.error?.message || `${file} exit ${result.status}`
    );
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

function listState(orca, selector, env) {
  const listed = command(
      orca,
      ['terminal', 'list', '--worktree', selector, '--include-visual-layouts', '--json'],
      env
    ),
    result = listed?.result || listed;
  return {
    terminals: Array.isArray(result?.terminals) ? result.terminals : [],
    visualLayouts: result?.visualLayouts,
  };
}

function recordedTerminal(record, terminals) {
  if (typeof record?.handle !== 'string' || typeof record?.incarnationId !== 'string') return null;
  return terminals.find(
    terminal =>
      terminal.handle === record.handle &&
      terminal.incarnationId === record.incarnationId &&
      live(terminal)
  );
}

function closeOtherPanels(orca, state, title, keep, env) {
  for (const handle of panelHandles(state.visualLayouts, title)) {
    if (handle !== keep)
      command(orca, ['terminal', 'close', '--terminal', handle, '--tab', '--json'], env);
  }
}

function ensure(root, env = process.env, rescanDelayMs = RESCAN_DELAY_MS) {
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
      title = `心跳·${projectName(root)}`,
      state = listState(orca, selector, env);
    let prior = null;
    try {
      prior = JSON.parse(fs.readFileSync(record, 'utf8'));
    } catch {}
    const current = recordedTerminal(prior, state.terminals);
    closeOtherPanels(orca, state, title, current?.handle, env);
    if (current) return;
    // The shim routes to the promoted engine; bin/superagent in this checkout is a candidate
    // and refuses production state. The loop keeps the tab useful while the engine lacks the
    // verb (before promotion) or after a crash, instead of leaving a dead terminal.
    const superagent = path.join(WETAMP, 'bin', 'superagent-shim'),
      scope = root === path.dirname(WETAMP) ? ['--all'] : ['--cwd', root],
      watch = [superagent, 'heartbeat', '--watch', ...scope]
        .map(value => `'${value.replace(/'/g, "'\\''")}'`)
        .join(' '),
      shellCommand = `while true; do ${watch}; case $? in 75) continue;; esac; echo '心跳面板暂不可用，60 秒后重试'; sleep 60; done`,
      created = command(
        orca,
        [
          'terminal',
          'create',
          '--worktree',
          selector,
          '--title',
          title,
          '--command',
          shellCommand,
          '--json',
        ],
        env
      ),
      handle = createdHandle(created);
    if (!handle) throw new Error('orca terminal create returned no handle');
    const createdTerminal = listState(orca, selector, env).terminals.find(
      terminal => terminal.handle === handle && typeof terminal.incarnationId === 'string'
    );
    if (!createdTerminal) throw new Error('created heartbeat terminal has no incarnationId');
    const next = { handle, incarnationId: createdTerminal.incarnationId };
    atomicWrite(record, next);
    if (rescanDelayMs > 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rescanDelayMs);
    const rescanned = listState(orca, selector, env);
    closeOtherPanels(orca, rescanned, title, handle, env);
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
    const delay = process.argv[4] === undefined ? RESCAN_DELAY_MS : Number(process.argv[4]);
    ensure(process.argv[3], process.env, delay);
  } catch (error) {
    logFailure(error, process.env);
  }
}

module.exports = { ensurePanel };
