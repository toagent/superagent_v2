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
const str = v => (typeof v === 'string' && v ? v : null);

// `claude`, a native `codex` or `node …/bin/codex`: the agent CLI an argv runs, else null.
function agentOf(command) {
  const argv = command.trim().split(/\s+/);
  const a = ['node', 'bun'].includes(path.basename(argv[0])) ? argv.slice(1) : argv;
  const name = a.length ? path.basename(a[0]) : '';
  return AGENTS.includes(name) ? name : null;
}
// Nearest agent CLI ancestor of this hook process. One `ps -p` per level: a full `ps -ax`
// costs ~100ms on macOS, a level ~3ms, and hooks sit 1–3 levels below the agent.
function owner() {
  for (let pid = process.ppid, n = 0; pid > 1 && n < 16; n++) {
    const r = spawnSync('ps', ['-o', 'ppid=,tty=,command=', '-p', String(pid)], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']});
    const m = r.status === 0 && /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(r.stdout.trim());
    if (!m) return null;
    if (agentOf(m[3])) return {pid, tty: m[2] === '??' ? null : m[2]};
    pid = Number(m[1]);
  }
  return null;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// derivedOf: () => truthy when guard's derivedBy classifies the session as derived.
function beat(client, input, derivedOf = () => null, env = process.env) {
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
    // Only a run of tool events is throttled: the first one after any other event always lands.
    const toolRun = !ALWAYS.has(event) && String(prior?.event).endsWith('ToolUse');
    if (toolRun && !turn && now - mtime < THROTTLE_MS) return;
    // The owner is resolved once per session; a session without an agent ancestor stays null.
    const keep = prior && (prior.pid === null || (Number.isSafeInteger(prior.pid) && alive(prior.pid)));
    const who = keep ? {pid: prior.pid, tty: str(prior.tty)} : owner();
    const record = {
      client, session_id: session, pid: who?.pid ?? null, tty: who?.tty ?? null,
      cwd: str(input.cwd), transcript_path: str(input.transcript_path), event,
      tool: event.endsWith('ToolUse') ? str(input.tool_name) : null,
      turn_at: turn ? new Date(now).toISOString() : str(prior?.turn_at),
      at: new Date(now).toISOString(), derived: Boolean(derivedOf()),
    };
    fs.mkdirSync(dir, {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(record)); fs.renameSync(tmp, file); }
    catch { try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}
module.exports = {beat, agentOf, THROTTLE_MS};
