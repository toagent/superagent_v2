// 原因与处置的唯一注册表；generate 将 REASONS 写入冻结模板。
import { redact } from './redact';
export type Yes = 'retry' | 'resume' | 'approve' | 'review';
export type Policy =
  | { do: 'expire' | 'auto_retry' | 'backoff' | 'resume' }
  | { do: 'signoff'; text: string; yesText: string }
  | { do: 'ask'; yes: Yes; text: string; yesText: string };
/**
 * 挂起原因 → 处置：supervise-tick 对非终态 run 的唯一分派表（docs/00「挂起处置」），每行都有单测。
 * signoff 走 human()；expire 按 plan 截止终止、不提醒；auto_retry/backoff/resume 自动处置，有上限，用尽后转 ask 行；
 * ask 行投一条提醒（键 run:挂起类别），“是”执行 yes，“否”终止 run 并保留证据，过期不替用户决定、等 plan 截止。
 */
export const HOLD_POLICY = {
  signoff: { do: 'signoff', text: '等待人工签收', yesText: '批准签收门并续跑（不自动合入）' },
  deadline: { do: 'expire' },
  gate: { do: 'auto_retry' },
  coder: { do: 'auto_retry' },
  environment: { do: 'backoff' },
  paused: { do: 'resume' },
  auto_retry_exhausted: {
    do: 'ask',
    yes: 'retry',
    text: '自动重试已用尽', yesText: '{target}一次',
  },
  no_change: {
    do: 'ask',
    yes: 'retry',
    text: '连续两轮修复无变化', yesText: '{target}一次',
  },
  no_attempt_node: {
    do: 'ask',
    yes: 'resume',
    text: '旧工作流无法重跑里程碑', yesText: '清零恢复计数并{target}一次',
  },
  recover_no_progress: {
    do: 'ask',
    yes: 'resume',
    text: '恢复3次无进展', yesText: '清零恢复计数并{target}一次',
  },
  needs: {
    do: 'ask',
    yes: 'retry',
    text: '将军需要补能力', yesText: '确认已补齐后{target}一次',
  },
  redline: { do: 'ask', yes: 'retry', text: '将军命中红线', yesText: '{target}一次（红线不变）' },
  coder_blocked: {
    do: 'ask',
    yes: 'retry',
    text: '将军受执行约束阻断', yesText: '确认已处理后{target}一次',
  },
  budget: {
    do: 'ask',
    yes: 'retry',
    text: '预算已用尽', yesText: '按台账追加本里程碑额度并{target}一次',
  },
  review_limit: { do: 'ask', yes: 'retry', text: '三轮评审已用尽', yesText: '{target}一次' },
  review_not_independent: {
    do: 'ask',
    yes: 'review',
    text: '评审身份不独立', yesText: '确认已处理后{target}一次',
  },
  engine_suspect: {
    do: 'ask',
    yes: 'resume',
    text: '引擎判定与验收矛盾或原因未注册', yesText: '确认已修复引擎后清零恢复计数并{target}一次',
  },
  approval: { do: 'ask', yes: 'approve', text: 'Archon审批门', yesText: '批准审批门并续跑' },
} as const satisfies Record<string, Policy>;
export type Hold = keyof typeof HOLD_POLICY;

// 仅清洗展示摘要；不以散文决定任何引擎动作。代码片段、赋值及凭据样式不进入 iCloud。
export const askText = (v: unknown, limit = 60): string => typeof v !== 'string' ? '' : Array.from(redact(v)
  .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, '[代码省略]')
  .replace(/\b(?:rg|grep|git|curl|wget|bash|zsh|sh|python3|node|bun|npm|cat|ls|sed|awk|find|rm|cp|mv)\s+(?=[A-Za-z0-9_./~$-])[^\n]*/g, '[命令省略]')
  .replace(/\b[\w-]+\s*=\s*(?:"[^"\n]*"?|'[^'\n]*'?|[^\s,;]+)/g, '[赋值省略]')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]+|\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[凭据省略]')
  .replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
export function askQuestion(hold: Hold, context: string, detail: string, target: string, marker: string, consequence = ''): string {
  const p = HOLD_POLICY[hold];
  if (p.do !== 'ask' && p.do !== 'signoff') throw new Error(`not an ask policy: ${hold}`);
  const actions = `；是=${p.yesText.replace('{target}', target)}${consequence}；否=终止整个run（保留证据）；${marker}`;
  return Array.from(`${context}：${p.text}；${detail || '证据缺失'}`).slice(0, 200 - Array.from(actions).length).join('') + actions;
}

export interface Reason {
  code: string;
  hold: Hold;
  determinism: 'deterministic' | 'transient';
  owner: 'coder' | 'engine' | 'env' | 'human';
  description: string;
}
const entry = (
  code: string,
  hold: Hold,
  determinism: Reason['determinism'],
  owner: Reason['owner'],
  description: string
): Reason => ({ code, hold, determinism, owner, description });
const deterministic = (
  code: string,
  hold: Hold,
  owner: Reason['owner'],
  description: string
): Reason => entry(code, hold, 'deterministic', owner, description);
export const CODER_CLASSES = [
  'env',
  'sandbox_denied',
  'permission_denied',
  'vendor_unavailable_all',
  'budget_exhausted',
  'plan_invalid',
  'scope_violation',
  'task',
  'redline',
] as const;
const base: Reason[] = [
  deterministic('signoff', 'signoff', 'human', '等待人工签收'),
  deterministic('deadline', 'deadline', 'human', '计划截止已过'),
  entry('gate', 'gate', 'transient', 'engine', '评审节点执行失败'),
  entry('coder', 'coder', 'transient', 'coder', '编码节点执行失败'),
  entry('environment', 'environment', 'transient', 'env', '环境预检失败'),
  entry('paused', 'paused', 'transient', 'engine', '可恢复的暂停'),
  deterministic('auto_retry_exhausted', 'auto_retry_exhausted', 'human', '自动重试额度已用尽'),
  deterministic('no_change', 'no_change', 'coder', '修复未改变交付'),
  deterministic('no_attempt_node', 'no_attempt_node', 'engine', '旧工作流缺少 attempt 节点'),
  deterministic('recover_no_progress', 'recover_no_progress', 'engine', '恢复未推进节点'),
  deterministic('coder_needs', 'needs', 'human', '编码端需要补充能力'),
  deterministic('coder_redline', 'redline', 'human', '编码端命中红线'),
  deterministic('budget_launches_exceeded', 'budget', 'human', '调用次数超过预算'),
  deterministic('budget_tokens_exceeded', 'budget', 'human', '用量超过预算'),
  deterministic('approval', 'approval', 'human', '等待 Archon 审批'),
  deterministic('engine_suspect', 'engine_suspect', 'engine', '验收与状态矛盾或原因未注册'),
  entry('coder_output_invalid', 'coder', 'transient', 'coder', '编码输出不是合法 JSON'),
  deterministic('coder_partial', 'coder', 'coder', '编码未完成且验收失败'),
  deterministic('acceptance_failed', 'gate', 'coder', '验收失败'),
  deterministic('review_failed', 'gate', 'coder', '评审未通过'),
  deterministic('review_inconsistent', 'gate', 'engine', '评审结论与发现矛盾'),
  entry('invalid_review', 'gate', 'transient', 'engine', '评审发现标识重复'),
  entry('review_incomplete', 'gate', 'transient', 'env', '评审未完成'),
  ...CODER_CLASSES.map(c =>
    entry(
      `coder_error:${c}`,
      c === 'env' || c === 'vendor_unavailable_all'
        ? 'environment'
        : c === 'task'
          ? 'coder'
          : c === 'redline'
            ? 'redline'
            : 'coder_blocked',
      c === 'env' || c === 'vendor_unavailable_all' ? 'transient' : 'deterministic',
      c === 'env' || c === 'vendor_unavailable_all' ? 'env' : 'coder',
      `编码端报告 ${c}`
    )
  ),
  ...['reviewer_unknown', 'author_unknown', 'same_model'].map(c =>
    deterministic(
      `review_not_independent:${c}`,
      'review_not_independent',
      'engine',
      `评审身份不独立 ${c}`
    )
  ),
];
const repaired = base
  .filter(
    r =>
      r.code === 'acceptance_failed' ||
      r.code === 'coder_partial' ||
      CODER_CLASSES.some(c => r.code === `coder_error:${c}`)
  )
  .map(r => ({
    ...r,
    code: `repair_exhausted:${r.code}`,
    hold: r.hold === 'gate' ? ('coder' as const) : r.hold,
  }));
// gate 可透传验收原因；封闭组合展开为精确码，消费者不解析前后缀。
export const REASONS: Reason[] = [
  ...base,
  ...repaired,
  ...[...base, ...repaired].map(r => ({
    ...r,
    code: `${r.code}+review_limit`,
    hold: 'review_limit' as const,
    determinism: 'deterministic' as const,
  })),
];
export const reasonOf = (code: string): Reason | undefined => REASONS.find(r => r.code === code);
