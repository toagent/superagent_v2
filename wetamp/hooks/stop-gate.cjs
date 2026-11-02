'use strict';
const path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process');
const { policy } = require('../tiers.json');
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
function waiterGate(payload, client, deps = {}) {
  if (payload.hook_event_name !== 'Stop' || client !== 'claude' || deps.derived) return null;
  try {
    if (!payload.session_id) throw new Error('缺少 session_id');
    // prettier-ignore
    const responsibilities = deps.responsibilities
      ? deps.responsibilities(payload.session_id)
      : JSON.parse(spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'responsibilities'], { input: JSON.stringify(payload), encoding: 'utf8', env: childEnv(), timeout: 10000 }).stdout);
    if (responsibilities.length) {
      const reason = `SUPERAGENT：需要处理 ${responsibilities.length} 项：\n${responsibilities.map(item => `${item.id} ${item.waiting_for} → ${item.next}`).join('\n')}`;
      return payload.stop_hook_active ? { systemMessage: reason } : { decision: 'block', reason };
    }
    const runs = deps.runs
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
    const asks = deps.asks
      ? deps.asks(payload.session_id)
      : JSON.parse(
          spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'waiting-asks'], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
            env: childEnv(),
            timeout: 10000,
          }).stdout
        );
    if (!active.length && !asks.length) return null;
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
    if (asks.length && !runWait && !inboxWait) {
      const ask = asks[0],
        reason = `SUPERAGENT：问询 ${ask.id.slice(0, 8)}（${ask.title}）尚未答复，请在后台运行：superagent inbox --wait --timeout 7000`;
      return payload.stop_hook_active ? { systemMessage: reason } : { decision: 'block', reason };
    }
    const missing = active.filter(run => !waited.has(String(run.run_id)));
    if (!missing.length) return null;
    const reason = `SUPERAGENT：请在后台运行以下缺失的等待进程：\n${missing.map(run => `superagent wait ${run.run_id} --timeout 7000`).join('\n')}`;
    return payload.stop_hook_active ? { systemMessage: reason } : { decision: 'block', reason };
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
module.exports = { gate, waiterGate, withState: require('./hook-state.cjs').withState };
