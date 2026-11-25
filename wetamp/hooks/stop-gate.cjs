'use strict';
const path = require('node:path'),
  os = require('node:os'),
  fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { policy } = require('../tiers.json');
const { bunExecutable, withState } = require('./hook-state.cjs');
const childEnv = () => {
  const superagent = process.env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent');
  return {
    ...process.env,
    SUPERAGENT_HOME: superagent,
    ARCHON_HOME: process.env.ARCHON_HOME || path.join(superagent, 'archon'),
  };
};
const advisory = error => ({
  systemMessage: `SUPERAGENT advisory：无法确认等待进程（${error.message}），本次已放行。`,
});
function neonWaiting(payload) {
  const env = childEnv();
  if (!['runs', 'ntfy/state.json', 'heartbeat.json'].some(file =>
    fs.existsSync(path.join(env.SUPERAGENT_HOME, file))
  )) return {};
  return JSON.parse(spawnSync(bunExecutable(), [path.join(__dirname, '../src/resume-card.ts'), 'waiting'], {
    input: JSON.stringify({ session_id: payload.session_id }), encoding: 'utf8', env, timeout: 10000,
  }).stdout);
}
function waiterGate(payload, client, deps = {}) {
  const neon = client === 'agy';
  if (payload.hook_event_name !== (neon ? 'PreToolUse' : 'Stop') ||
      (!neon && client !== 'claude') || deps.derived) return null;
  const instruction = neon ? '请前台运行' : '请在后台运行', timeout = neon ? 3000 : 7000;
  try {
    if (!payload.session_id) throw new Error('缺少 session_id');
    const waiting = neon ? neonWaiting(payload) : null;
    // prettier-ignore
    const responsibilities = waiting ? (waiting.responsibilities ?? []) : deps.responsibilities
      ? deps.responsibilities(payload.session_id)
      : JSON.parse(spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'responsibilities'], { input: JSON.stringify(payload), encoding: 'utf8', env: childEnv(), timeout: 10000 }).stdout);
    const duty = !neon && responsibilities.length
      ? `SUPERAGENT：需要处理 ${responsibilities.length} 项：\n${responsibilities.map(item => `${item.id} ${item.waiting_for} → ${item.next}`).join('\n')}`
      : null;
    const output = (...reasons) => {
      const notices = reasons.filter(Boolean);
      if (neon) return { responsibilities, notices };
      const [reason] = notices;
      if (!reason) return null;
      return payload.stop_hook_active ? { systemMessage: reason } : { decision: 'block', reason };
    };
    if (duty) return output(duty);
    const runs = waiting ? (waiting.runs ?? []) : deps.runs
      ? deps.runs(payload.session_id)
      : JSON.parse(
          spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'waiting-runs'], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
            env: childEnv(),
            timeout: 10000,
          }).stdout
        );
    const active = runs.filter(run => run.status === 'running' || run.status === 'pending');
    const asks = waiting ? (waiting.asks ?? []) : deps.asks
      ? deps.asks(payload.session_id)
      : JSON.parse(
          spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'waiting-asks'], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
            env: childEnv(),
            timeout: 10000,
          }).stdout
        );
    if (!active.length && !asks.length) return output(duty);
    const listing = deps.processes
      ? deps.processes()
      : spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 })
          .stdout;
    if (!listing) throw new Error('进程表为空');
    const rows = listing.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
    });
    const tree = new Set([deps.rootPid ?? process.ppid]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const row of rows)
        if (tree.has(row.ppid) && !tree.has(row.pid)) (tree.add(row.pid), (changed = true));
    }
    const descendants = rows.filter(row => tree.has(row.pid)),
      commands = descendants.map(row => row.command.trim().split(/\s+/)),
      isCli = value => /(?:^|\/)(?:superagent|cli\.ts)$/.test(value ?? ''),
      runWait = commands.some(args =>
        args.some((arg, index) => arg === 'wait' && isCli(args[index - 1]))
      ),
      inboxWait = commands.some(
        args =>
          args.some((arg, index) => arg === 'inbox' && isCli(args[index - 1])) &&
          args.includes('--wait')
      ),
      waited = new Set(
        descendants.flatMap(row => {
          const args = row.command.trim().split(/\s+/),
            wait = args.findIndex((arg, index) => arg === 'wait' && isCli(args[index - 1])),
            option = args.findIndex((arg, index) => index > wait && arg.startsWith('--'));
          return wait < 0 ? [] : args.slice(wait + 1, option < 0 ? undefined : option);
        })
      );
    const ask = asks.length && !runWait && !inboxWait ? asks[0] : null;
    const askNotice = ask
      ? `SUPERAGENT：问询 ${ask.id.slice(0, 8)}（${ask.title}）尚未答复，${instruction}：superagent inbox --wait --timeout ${timeout}`
      : null;
    if (askNotice && !neon) return output(askNotice);
    const missing = active.filter(run => !waited.has(String(run.run_id)));
    const runNotice = missing.length
      ? `SUPERAGENT：${instruction}以下缺失的等待进程：\n${missing.map(run => `superagent wait ${run.run_id} --timeout ${timeout}`).join('\n')}`
      : null;
    return output(askNotice, runNotice);
  } catch (error) {
    return advisory(error instanceof Error ? error : new Error(String(error)));
  }
}
function gate(payload, client, deps) {
  const waiter = waiterGate(payload, client, deps);
  if (waiter?.decision || (waiter && payload.stop_hook_active)) return waiter;
  if (payload.hook_event_name !== 'Stop' || (policy.stop_gate ?? 'off') === 'off') return waiter;
  const mode = policy.stop_gate;
  if (!['advisory', 'cycle', 'change'].includes(mode))
    return {
      systemMessage: `${waiter?.systemMessage ? `${waiter.systemMessage}\n` : ''}SUPERAGENT: stop_gate=${mode} 无效（off/advisory；cycle/change 仅兼容提示），请修正 tiers.json。`,
    };
  return {
    systemMessage: `${waiter?.systemMessage ? `${waiter.systemMessage}\n` : ''}SUPERAGENT G-3 advisory：hook 不确认评审通过；最终 candidate、实际模型独立性与 verdict 以引擎正式 gate 证据为准。`,
  };
}
// Compatibility export shares the hook transaction owner; no second state store.
module.exports = { gate, waiterGate, withState };
