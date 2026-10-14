'use strict';
// The engine owns candidate binding, reviewer identity and verdicts. Hook completion
// cannot prove any of them, so all legacy enabled modes are advisory only.
const { policy } = require('../tiers.json');
function gate(payload) {
  if (payload.hook_event_name !== 'Stop' || (policy.stop_gate ?? 'off') === 'off') return null;
  const mode = policy.stop_gate;
  if (!['advisory', 'cycle', 'change'].includes(mode))
    return {
      systemMessage: `SUPERAGENT: stop_gate=${mode} 无效（off/advisory；cycle/change 仅兼容提示），请修正 tiers.json。`,
    };
  return {
    systemMessage:
      'SUPERAGENT G-3 advisory：hook 不确认评审通过；最终 candidate、实际模型独立性与 verdict 以引擎正式 gate 证据为准。',
  };
}
// Compatibility export shares the hook transaction owner; no second state store.
module.exports = { gate, withState: require('./hook-state.cjs').withState };
