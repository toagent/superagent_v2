'use strict';
// Frozen execution policy shared by generation, native workers and workflow dispatch.
const fs = require('node:fs');
const { join } = require('node:path');

const { createHash } = require('node:crypto');
function canonicalPolicy(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalPolicy).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(k => JSON.stringify(k) + ':' + canonicalPolicy(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
// generate.ts 与无快照的 worker 共用此构造与哈希，不手抄 policy 子集。
function snapshotPolicy(tiers) {
  const body = JSON.parse(JSON.stringify({ ...tiers.policy, routing: tiers.routing }));
  return { ...body, hash: createHash('sha256').update(canonicalPolicy(body)).digest('hex') };
}
function loadPolicy(path) {
  let snapshot;
  if (!path) {
    // 凭据预检、selftest 与 POLICY 前的旧 run 没有冻结快照；当前 tiers 等同新 run 将冻结的策略，
    // 仍执行全部权限限制。显式路径的读取/校验失败绝不回退，已有快照继续钉住原策略。
    snapshot = snapshotPolicy(
      JSON.parse(fs.readFileSync(join(__dirname, '..', 'tiers.json'), 'utf8'))
    );
    process.stderr.write(
      'codex policy: SA_POLICY_PATH unset; using current tiers.json policy (not frozen)\n'
    );
  } else snapshot = JSON.parse(fs.readFileSync(path, 'utf8'));
  const { hash, ...policy } = snapshot;
  if (
    typeof hash !== 'string' ||
    createHash('sha256').update(canonicalPolicy(policy)).digest('hex') !== hash
  )
    throw new Error('policy snapshot hash mismatch');
  return policy;
}
module.exports = { canonicalPolicy, snapshotPolicy, loadPolicy };
