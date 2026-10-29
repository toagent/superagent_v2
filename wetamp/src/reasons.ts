// 原因与处置的唯一注册表；generate 将 REASONS 写入冻结模板。
export type Yes = 'retry' | 'resume' | 'approve' | 'review' | 'adjudicate' | 'cancel';
export type Policy =
  | { do: 'expire' | 'resume' }
  | { do: 'blocked'; text: string; next: string }
  | { do: 'signoff'; text: string; yesText: string }
  | { do: 'ask'; yes: Yes; text: string; yesText: string; noText?: string };
/**
 * 挂起原因 → 处置：supervise-tick 对非终态 run 的唯一分派表（docs/00「挂起处置」），每行都有单测。
 * signoff 走 human()；expire 按 plan 截止终止、不提醒；paused 等待 Archon 原生 wake；失败由原生 retry 处理，停止后只接受明确决定；
 * ask 行投一条提醒（键 run:挂起类别），“是”执行 yes，“否”终止 run 并保留证据，过期不替用户决定、等 plan 截止。
 */
export const HOLD_POLICY = {
  signoff: { do: 'signoff', text: '等待人工签收', yesText: '批准签收门并续跑（不自动合入）' },
  deadline: { do: 'expire' },
  gate: { do: 'blocked', text: '交付检查失败', next: '修复验收或评审中的阻断发现' },
  coder: { do: 'blocked', text: '编码节点失败', next: '检查编码节点证据并修复失败条件' },
  coder_budget: {
    do: 'blocked',
    text: 'Claude 将军单次预算用尽',
    next: '已保留工作树，拆包或带提示 retry',
  },
  environment: { do: 'blocked', text: '环境检查失败', next: '恢复声明的依赖和环境后再重试' },
  paused: { do: 'resume' },
  no_change: { do: 'blocked', text: '连续两轮修复无变化', next: '重新确认根因和修复范围' },
  needs: { do: 'blocked', text: '将军需要补能力', next: '在brief中检查needs并补齐明确能力或输入' },
  redline: {
    do: 'blocked',
    text: '将军命中红线',
    next: '改用允许的操作；需人工执行的红线操作交操作员处理',
  },
  coder_blocked: {
    do: 'blocked',
    text: '将军受执行约束阻断',
    next: '检查执行约束并提供符合约束的操作或环境',
  },
  review_limit: { do: 'blocked', text: '评审轮次已用尽', next: '重新确认遗留blocker和工作包范围' },
  review_not_independent: {
    do: 'blocked',
    text: '评审身份不独立',
    next: '配置与作者不同的合格评审身份',
  },
  engine_suspect: {
    do: 'blocked',
    text: '引擎判定与验收矛盾或原因未注册',
    next: '检查incident证据并修复引擎判定',
  },
  approval: { do: 'ask', yes: 'approve', text: 'Archon审批门', yesText: '批准审批门并续跑' },
  stalled: {
    do: 'ask',
    yes: 'cancel',
    text: '进展停滞',
    yesText: '精确取消该run',
    noText: '继续等待',
  },
  auto_recover: {
    do: 'ask',
    yes: 'resume',
    text: '自动恢复被准入拦截',
    yesText: '显式重试恢复',
  },
  acceptance_adjudication: {
    do: 'ask',
    yes: 'adjudicate',
    text: '验收失败仅来自基线或预登记用例',
    yesText: '按当前结构化证据记债并重跑验收',
  },
} as const satisfies Record<string, Policy>;
export type Hold = keyof typeof HOLD_POLICY;

// 仅用于引擎标识与 plan 名称；自由文本证据不进入提醒标题。
export const askName = (v: string, limit: number): string =>
  Array.from(v.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
export function askQuestion(
  hold: Hold,
  names: string[],
  details: [string, string],
  recovery: (limit: number, stage: number) => [string, string],
  marker: string
): string {
  const p = HOLD_POLICY[hold];
  if (p.do !== 'ask' && p.do !== 'signoff') throw new Error(`not an ask policy: ${hold}`);
  // 依次缩名称、完成包名单、数字事实、固定文案；原因与完整动作/marker 始终保留。
  for (let stage = 0; stage <= 3; stage++)
    for (let limit = 24; limit >= 1; limit--) {
      const [target, consequence] = recovery(limit, stage);
      const detail = stage < 2 ? details[0] : details[1];
      const q =
        `${names.map(n => askName(n, limit)).join('/')}：${p.text}` +
        (stage < 3 ? `；${detail || '证据缺失'}` : '') +
        `；是=${p.yesText.replace('{target}', target)}${consequence}；否=${p.do === 'ask' && 'noText' in p ? p.noText : '终止整个run（保留证据）'}` +
        (stage < 3 ? '；详情superagent brief <run>' : '') +
        `；${marker}`;
      if (Array.from(q).length <= 200) return q;
    }
  throw new Error('ask title: structured facts exceed 200 characters');
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
export const CANCELLATION_REASONS = [
  'unstated',
  'superseded',
  'replaced',
  'deadline',
  'operator',
  'test',
  'duplicate',
  'obsolete',
  'rejected',
] as const;
const base: Reason[] = [
  deterministic('base_branch_missing', 'engine_suspect', 'engine', '起跑缺少可检测的 base branch'),
  entry('cancelled_source', 'paused', 'transient', 'env', '有结构化取消来源'),
  deterministic('signoff', 'signoff', 'human', '等待人工签收'),
  deterministic('deadline', 'deadline', 'human', '计划截止已过'),
  entry('gate', 'gate', 'transient', 'engine', '评审节点执行失败'),
  entry('coder', 'coder', 'transient', 'coder', '编码节点执行失败'),
  deterministic('coder_budget', 'coder_budget', 'coder', 'Claude 将军单次预算用尽'),
  entry('environment', 'environment', 'transient', 'env', '环境预检失败'),
  entry('paused', 'paused', 'transient', 'engine', '可恢复的暂停'),
  deterministic('no_change', 'no_change', 'coder', '修复未改变交付'),
  deterministic('coder_needs', 'needs', 'human', '编码端需要补充能力'),
  deterministic('coder_redline', 'redline', 'human', '编码端命中红线'),
  deterministic('approval', 'approval', 'human', '等待 Archon 审批'),
  deterministic(
    'acceptance_adjudication',
    'acceptance_adjudication',
    'human',
    '结构化失败需要人工裁决'
  ),
  deterministic('engine_suspect', 'engine_suspect', 'engine', '验收与状态矛盾或原因未注册'),
  entry('coder_output_invalid', 'coder', 'transient', 'coder', '编码输出不是合法 JSON'),
  deterministic('coder_partial', 'coder', 'coder', '编码未完成且无改动或验收失败'),
  deterministic('scope_violation', 'coder', 'coder', '交付包含 scope.write 之外的路径'),
  deterministic('acceptance_failed', 'gate', 'coder', '验收失败'),
  deterministic('ruler_invalid', 'gate', 'human', '基线尺子缺失目标断言失败或无法执行'),
  deterministic('vacuous_test', 'gate', 'human', '基线尺子的目标测试已通过'),
  deterministic('review_failed', 'gate', 'coder', '评审未通过'),
  deterministic('finding_stuck', 'gate', 'coder', '同一阻断发现连续三轮未关闭'),
  deterministic(
    'acceptance_evidence_mismatch',
    'gate',
    'engine',
    '验收 artifact 与引擎捕获输出不一致'
  ),
  deterministic('review_modified_checkout', 'gate', 'human', '评审修改工作区或完整性证据不可用'),
  deterministic('review_inconsistent', 'gate', 'engine', '评审结论与发现矛盾'),
  entry('invalid_review', 'gate', 'transient', 'engine', '评审发现标识重复'),
  entry('review_incomplete', 'gate', 'transient', 'env', '评审未完成'),
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
  .filter(r => ['acceptance_failed', 'coder_partial', 'scope_violation'].includes(r.code))
  .map(r => ({
    ...r,
    code: `repair_exhausted:${r.code}`,
    hold: r.hold === 'gate' ? ('coder' as const) : r.hold,
  }));
// gate 可透传验收原因；封闭组合展开为精确码，消费者不解析前后缀。
export const REASONS: Reason[] = [
  deterministic('review_not_required', 'gate', 'engine', '验收通过且无需评审'),
  deterministic('land_target_unknown', 'needs', 'human', '合入缺少可验证的本地目标分支'),
  deterministic('budget_exceeded', 'signoff', 'human', '净增行数超过工作包上限'),
  entry(
    'git_lock_held',
    'environment',
    'transient',
    'env',
    'run worktree 的 git index 锁仍被持有或无法确认陈旧'
  ),
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
