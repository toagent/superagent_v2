#!/usr/bin/env node
'use strict';
// codex-worker 对 `codex app-server` 的 stdio 代理：node <policy.json|空串> <real codex> app-server ...
// Archon 的 thread/start 固定下发 sandbox:'danger-full-access'，会盖掉 worker 的 -c sandbox_mode；
// reviewer 节点只能经 generate 写进节点 mcp: 的哨兵 server 认出来（thread config 是唯一逐节点到达的结构化通道）。
// 认出后：删掉哨兵，本连接此后的 thread/start|resume|fork 改 sandbox:'read-only'，turn/start 注入只读
// sandboxPolicy。哨兵是 required 且命令必败的 MCP server，绕过代理直连真 codex 时线程起不来（失败关闭）。
// 服务端→客户端直接继承 stdout；客户端→服务端逐行转发，未改写的行原字节不动。
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const { createHash } = require('node:crypto');
function canonicalPolicy(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalPolicy).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalPolicy(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
// generate.ts 与无快照的 worker/proxy 共用此构造与哈希，不手抄 policy 子集。
function snapshotPolicy(tiers) {
  const body = JSON.parse(JSON.stringify({ ...tiers.policy, routing: tiers.routing, health: tiers.health }));
  return { ...body, hash: createHash('sha256').update(canonicalPolicy(body)).digest('hex') };
}
function loadPolicy(path) {
  let snapshot;
  if (!path) {
    // 凭据预检、selftest 与 POLICY 前的旧 run 没有冻结快照；当前 tiers 等同新 run 将冻结的策略，
    // 仍执行全部权限限制。显式路径的读取/校验失败绝不回退，已有快照继续钉住原策略。
    snapshot = snapshotPolicy(JSON.parse(fs.readFileSync(join(__dirname, '..', 'tiers.json'), 'utf8')));
    process.stderr.write('codex policy: SA_POLICY_PATH unset; using current tiers.json policy (not frozen)\n');
  } else snapshot = JSON.parse(fs.readFileSync(path, 'utf8'));
  const { hash, ...policy } = snapshot;
  if (typeof hash !== 'string' || createHash('sha256').update(canonicalPolicy(policy)).digest('hex') !== hash)
    throw new Error('policy snapshot hash mismatch');
  if (typeof policy.exec_profiles?.reviewer?.codex_readonly_marker !== 'string' || !policy.exec_profiles.reviewer.codex_readonly_marker)
    throw new Error('codex_readonly_marker missing');
  return policy;
}
module.exports = { canonicalPolicy, snapshotPolicy, loadPolicy };
if (require.main === module) {
const [policyPath, real, ...args] = process.argv.slice(2);
const die = (msg, child) => {
  process.stderr.write(`codex-readonly-proxy: ${msg}\n`);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exit(1);
};
let marker, network;
try {
  const policy = loadPolicy(policyPath);
  marker = policy.exec_profiles.reviewer.codex_readonly_marker;
  network = false; // Readonly review has no network side effects or exfiltration channel.
  if (typeof marker !== 'string' || !marker) throw new Error('codex_readonly_marker missing');
} catch (e) {
  die(`cannot read policy from ${policyPath}: ${e.message}`);
}

const THREAD = new Set(['thread/start', 'thread/resume', 'thread/fork']);
// 整个 worker 以 reviewer 身份运行时一开始就只读；否则由哨兵在本连接内置位，置位后不再撤销。
let reviewer = process.env.SUPERAGENT_ROLE === 'reviewer';

/** 返回要转发的字节；null 表示原样转发。无法确认是否该收紧时抛错，由调用方失败关闭。 */
function rewrite(line) {
  let msg;
  try {
    msg = JSON.parse(line.toString('utf8'));
  } catch {
    if (reviewer || line.includes(marker)) throw new Error('unparsable request on a reviewer connection');
    return null;
  }
  if (msg === null || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  const p = msg.params;
  if (THREAD.has(msg.method)) {
    const servers = p?.config?.mcp_servers;
    if (servers && typeof servers === 'object' && Object.hasOwn(servers, marker)) {
      reviewer = true;
      delete servers[marker];
      if (Object.keys(servers).length === 0) delete p.config.mcp_servers;
    }
    if (!reviewer) return null;
    p.sandbox = 'read-only';
  } else if (msg.method === 'turn/start') {
    if (!reviewer) return null;
    p.sandboxPolicy = { type: 'readOnly', networkAccess: network };
  } else {
    if (line.includes(marker)) throw new Error(`marker outside thread params in ${msg.method}`);
    return null;
  }
  return Buffer.from(JSON.stringify(msg));
}

const child = spawn(real, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', e => die(`cannot start ${real}: ${e.message}`));
child.stdin.on('error', () => {}); // 子进程先退出时的 EPIPE；退出码由下方 exit 处理
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));

let pending = Buffer.alloc(0);
const forward = line => {
  let out;
  try {
    out = rewrite(line);
  } catch (e) {
    die(e.message, child);
  }
  return child.stdin.write(Buffer.concat([out ?? line, Buffer.from('\n')]));
};
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  let ok = true;
  for (let i; (i = pending.indexOf(10)) >= 0; ) {
    ok = forward(pending.subarray(0, i)) && ok;
    pending = pending.subarray(i + 1);
  }
  if (!ok) {
    process.stdin.pause();
    child.stdin.once('drain', () => process.stdin.resume());
  }
});
process.stdin.on('end', () => {
  if (pending.length > 0) {
    let out;
    try {
      out = rewrite(pending);
    } catch (e) {
      die(e.message, child);
    }
    child.stdin.write(out ?? pending);
  }
  child.stdin.end();
});

}
