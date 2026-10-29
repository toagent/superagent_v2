'use strict';
const path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process');
const { policy } = require('../tiers.json');
const advisory = error => ({
  systemMessage: `SUPERAGENT advisory：无法确认等待进程（${error.message}），本次已放行。`,
});
function waiterGate(payload, client, deps = {}) {
  if (payload.hook_event_name !== 'Stop' || client !== 'claude' || deps.derived) return null;
  try {
    if (!payload.session_id) throw new Error('缺少 session_id');
    const runs = deps.runs
      ? deps.runs(payload.session_id)
      : JSON.parse(
          spawnSync('bun', [path.join(__dirname, '../src/resume-card.ts'), 'waiting-runs'], {
            input: JSON.stringify(payload),
            encoding: 'utf8',
            env: {
              ...process.env,
              ARCHON_HOME:
                process.env.ARCHON_HOME ||
                path.join(process.env.SUPERAGENT_HOME || path.join(os.homedir(), '.superagent'), 'archon'),
            },
            timeout: 10000,
          }).stdout
        );
    const active = runs.filter(run => run.status === 'running' || run.status === 'pending');
    if (!active.length) return null;
    const listing = deps.processes
      ? deps.processes()
      : spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 }).stdout;
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
    const missing = active.filter(run => {
      const id = String(run.run_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wait = new RegExp(`(?:superagent|cli\\.ts)\\s+wait\\s+${id}(?:\\s|$)`);
      return !rows.some(row => tree.has(row.pid) && wait.test(row.command));
    });
    if (!missing.length) return null;
    const reason = `SUPERAGENT：请在后台运行以下缺失的等待进程：\n${missing.map(run => `superagent wait ${run.run_id} --timeout 900`).join('\n')}`;
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
    systemMessage:
      `${waiter?.systemMessage ? `${waiter.systemMessage}\n` : ''}SUPERAGENT G-3 advisory：hook 不确认评审通过；最终 candidate、实际模型独立性与 verdict 以引擎正式 gate 证据为准。`,
  };
}
// Compatibility export shares the hook transaction owner; no second state store.
module.exports = { gate, waiterGate, withState: require('./hook-state.cjs').withState };
