'use strict';
// Board heartbeat for interactive sessions: `beat(client, input)` writes
// $SUPERAGENT_HOME/live/<client>-<sha256(session_id)[:16]>.json for `superagent board`.
// Side channel only: every failure is swallowed and nothing reaches stdout/stderr, so a hook's
// output and exit status are the same with or without it. Only the whitelisted fields below are
// stored: never prompts, tool input/output or transcript content.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const ALWAYS = new Set(['SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
const THROTTLE_MS = 2000;
const AGENTS = ['claude', 'codex', 'opencode'];
const ROLES = ['commander', 'general', 'strategist'];
const str = v => (typeof v === 'string' && v ? v : null);

// `claude`, a native `codex` or `node …/bin/codex`: the agent CLI an argv runs, else null.
function agentOf(command) {
  const argv = command.trim().split(/\s+/);
  const a = ['node', 'bun'].includes(path.basename(argv[0])) ? argv.slice(1) : argv;
  const name = a.length ? path.basename(a[0]) : '';
  return AGENTS.includes(name) ? name : null;
}
// Shared with the board and launcher recording; headless/service processes are not terminals.
function cliOf(argv) {
  const a = ['node', 'bun'].includes(path.basename(argv[0] || '')) ? argv.slice(1) : argv;
  const [k, sub] = [a.length ? path.basename(a[0]) : '', a[1] || ''];
  if (k === 'claude' && sub !== 'mcp') return {kind: k, headless: a.some(t => t === '-p' || t === '--print')};
  if (k === 'codex' && !['app-server', 'mcp', 'mcp-server'].includes(sub)) return {kind: k, headless: sub === 'exec'};
  if (k === 'opencode' && sub !== 'serve') return {kind: k, headless: sub === 'run'};
  return null;
}
// Nearest agent CLI ancestor of this hook process. One `ps -p` per level: a full `ps -ax`
// costs ~100ms on macOS, a level ~3ms, and hooks sit 1–3 levels below the agent.
function owner(interactive = false, inspect = inspectPid, parent = process.ppid) {
  for (let pid = parent, n = 0; pid > 1 && n < 16; n++) {
    const m = inspect(pid);
    if (!m) return null;
    const cli = cliOf(m[3].trim().split(/\s+/));
    if (interactive ? cli && !cli.headless && m[2] !== '??' : agentOf(m[3]))
      return {pid, tty: m[2] === '??' ? null : m[2]};
    pid = Number(m[1]);
  }
  return null;
}
function inspectPid(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,tty=,command=', '-p', String(pid)], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']});
  return r.status === 0 && /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(r.stdout.trim());
}
// Only identity metadata is returned; absent/ambiguous heartbeat identity stays absent.
function launcher(home) {
  try {
    const who = owner(true);
    if (!who) return undefined;
    const cli = cliOf(inspectPid(who.pid)?.[3]?.trim().split(/\s+/) || []);
    if (!cli || cli.headless) return undefined;
    let beats = [];
    try {
      for (const name of fs.readdirSync(path.join(home, 'live')).filter(n => n.endsWith('.json'))) {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(home, 'live', name), 'utf8'));
          if (b.pid === who.pid && b.client === cli.kind) beats.push(b);
        } catch {}
      }
    } catch {}
    beats.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const out = spawnSync('lsof', ['-a', '-p', String(who.pid), '-d', 'cwd', '-Fn'], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']});
    const cwd = out.stdout?.split('\n').find(l => l.startsWith('n'))?.slice(1) || str(beats[0]?.cwd);
    if (!cwd) return undefined;
    const session = new Set(beats.map(b => str(b.session_id)).filter(Boolean));
    return {client: cli.kind, ...who, cwd, ...(session.size === 1 ? {session_id: [...session][0]} : {})};
  } catch { return undefined; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// roleOf: () => guard's sessionRole (passed in so live.cjs never requires guard.cjs); anything else is stored as null.
function beat(client, input, roleOf = () => null, env = process.env) {
  try {
    const session = str(input?.session_id);
    // A subagent call carries the parent's session_id: it must not overwrite the parent's phase.
    if (!session || (str(input.agent_type) && str(input.agent_id))) return;
    const event = String(input.hook_event_name || '');
    const dir = path.join(env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent'), 'live');
    const file = path.join(dir, `${client}-${crypto.createHash('sha256').update(session).digest('hex').slice(0, 16)}.json`);
    let prior = null, mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const now = Date.now();
    // Codex has no UserPromptSubmit: its turn starts with the first tool call after Stop.
    const turn = event === 'UserPromptSubmit'
      || (event === 'PreToolUse' && (!prior || ['Stop', 'SessionStart'].includes(prior.event)));
    // Only a repeat of the same tool event is throttled: a PostToolUse right after its PreToolUse always
    // lands, so the board never keeps showing a tool that has already finished.
    const toolRun = !ALWAYS.has(event) && prior?.event === event;
    if (toolRun && !turn && now - mtime < THROTTLE_MS) return;
    // The owner is resolved once per session; a session without an agent ancestor stays null.
    const keep = prior && (prior.pid === null || (Number.isSafeInteger(prior.pid) && alive(prior.pid)));
    const who = keep ? {pid: prior.pid, tty: str(prior.tty)} : owner();
    let role = null;
    try { role = roleOf(); } catch {}
    const record = {
      client, session_id: session, pid: who?.pid ?? null, tty: who?.tty ?? null,
      cwd: str(input.cwd), transcript_path: str(input.transcript_path), event,
      tool: event.endsWith('ToolUse') ? str(input.tool_name) : null,
      turn_at: turn ? new Date(now).toISOString() : str(prior?.turn_at),
      at: new Date(now).toISOString(), role: ROLES.includes(role) ? role : null,
    };
    fs.mkdirSync(dir, {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(record)); fs.renameSync(tmp, file); }
    catch { try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}
module.exports = {beat, agentOf, cliOf, owner, launcher, THROTTLE_MS};
