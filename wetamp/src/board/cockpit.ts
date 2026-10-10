import { basename } from 'node:path';
import { progressLabel, jobProgress, unknownProgress, type Progress } from './eta';
import { HOLD_POLICY } from '../cli';
import { shortModel } from '../models';
import { fmtTokens } from '../usage';
import { elapsedAt, fmtElapsed, type BoardRow, type Snapshot } from './data';

/** Stable S3 reasons have exactly one display translation; unknown reasons remain evidence. */
export const REASONS = {
  signoff: '等待签收', deadline: '截止已过', gate: '门禁未通过', coder: '编码未通过',
  environment: '环境未就绪', paused: '等待恢复', auto_retry_exhausted: '重试已用尽',
  no_change: '修复无变化', no_attempt_node: '旧工作流无法重跑', recover_no_progress: '恢复无进展',
  needs: '需要补能力', redline: '命中红线', coder_blocked: '执行约束阻断', budget: '预算已用尽',
  review_limit: '三轮评审用尽', review_not_independent: '评审不独立', engine_suspect: '引擎嫌疑', approval: '等待批准',
} satisfies Record<keyof typeof HOLD_POLICY, string>;
export const reasonText = (s: string): string => (REASONS as Partial<Record<string, string>>)[s] ?? s;
export const roleTag = (role: string | null | undefined, model?: string | null, compact = false): string =>
  ({ commander: '元帅', general: '将军', strategist: '军师', coder: '将军', reviewer: '军师', script: '引擎', human: '人工' }[role ?? ''] ?? '未归属') + (shortModel(model, compact) ? `·${shortModel(model, compact)}` : '');
export function stages(r: BoardRow): string {
  const kind = (r.nodes.current ?? '').split('-')[0];
  const round = /-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? String(r.engine?.round ?? 1);
  const ms = r.engine?.milestones ?? [], index = ms.indexOf(r.engine?.currentMilestone ?? '');
  if (kind === 'code') return `编码 m${index < 0 ? '?' : String(index + 1)}/${ms.length ? String(ms.length) : '?'}`;
  if (kind === 'review') return `评审 r${round}`;
  return ({ repair: '修复', fix: '修复', verify: '验收', settle: '验收', diff: '评审准备', gate: '门禁', human: '签收', land: '合入' })[kind] ?? '准备';
}
export interface CockpitRun {
  progress: Progress; progressText: string;
  id: string; project: string; title: string; state: string; elapsed: string; tokens: string;
  stage: string; role: string; round: string; reason: string; question: string; waiting: string;
}
export interface Cockpit {
  metrics: { completed: number; decided: number; firstPass: number; asks: number; debt: number };
  tokens: string; roleTokens: string[]; needs: CockpitRun[]; active: CockpitRun[]; runs: CockpitRun[];
}
/** Pure projection shared by Ink and HTTP; collection remains owned by the existing loader/cache. */
export function cockpit(s: Snapshot, now = Date.now()): Cockpit {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = (ms: number): boolean => ms >= start.getTime() && ms <= now;
  const day = start.toLocaleDateString('sv-SE'), c = s.usage;
  const daily = c?.daily.filter(d => d.day === day) ?? [];
  const known = c?.status === 'ok' && daily.length > 0;
  // A day-scoped result from the existing usage collector proves role/day attribution. Older caches stay unknown.
  const byRole = new Map<string, number>();
  const todaySessions = c?.today?.day === day && c.today.status === 'ok' ? c.today.sessions : c?.since === day.replaceAll('-', '') ? c.sessions : null;
  if (known && todaySessions) for (const x of todaySessions) for (const p of x.parts?.length ? x.parts : [x]) {
    const tag = roleTag(x.owner?.role, p.model); byRole.set(tag, (byRole.get(tag) ?? 0) + p.total);
  }
  const runTokens = (id: string, field: 'run_id' | 'job_id' = 'run_id'): string => {
    const xs = c?.sessions.filter(x => x.owner?.[field] === id) ?? [];
    return c?.status === 'ok' && xs.length ? fmtTokens(xs.reduce((n, x) => n + x.total, 0)) : '未知';
  };
  const project = (r: BoardRow, why?: string): CockpitRun => {
    const d = r.engine?.dispositions.at(-1), key = why ?? d?.reason ?? r.engine?.reason ?? '';
    const policy = (HOLD_POLICY as Partial<Record<string, typeof HOLD_POLICY[keyof typeof HOLD_POLICY]>>)[key];
    const question = policy && 'yes' in policy ? `${reasonText(key)} 是=${({ retry: key === 'budget' ? '放宽预算再跑' : '再跑', resume: '恢复', approve: '批准', review: '重评' })[policy.yes]} 否=终止` : key === 'signoff' || r.state === 'held:human' ? '等待签收 是=批准 否=终止' : `${reasonText(key || r.state.replace('held:', ''))}；superagent brief 查看处置`;
    const progress = s.eta?.[r.run_id]?.progress ?? unknownProgress();
    return { progress, progressText: progressLabel(progress), id: r.run_id, project: r.repo, title: r.engine?.title ?? '任务标题未知', state: r.state, elapsed: fmtElapsed(elapsedAt(r, now)), tokens: runTokens(r.run_id), stage: stages(r), role: roleTag(r.nodes.currentRole, r.model), round: r.engine?.round ? String(r.engine.round) : /-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? '-', reason: reasonText(r.engine?.reason ?? ''), question, waiting: fmtElapsed(d?.action === 'ask' ? Math.max(0, Math.floor((now - Date.parse(d.at)) / 1000)) : elapsedAt(r, now)) };
  };
  const started = s.rows.filter(r => today(Date.parse(r.started_at))), completed = started.filter(r => r.state === 'completed').length;
  const active = s.rows.filter(r => ['running', 'owner_lost'].includes(r.state)).map(r => project(r));
  for (const j of s.activity?.jobs.filter(j => j.state === 'running') ?? []) {
    const progress = jobProgress({ ...j, role: j.tier }, s.activity?.jobHistory ?? [], now);
    active.push({ progress, progressText: progressLabel(progress), id: j.id, project: basename(j.cwd), title: j.title,
      state: j.state, elapsed: fmtElapsed(Math.max(0, Math.floor((now - Date.parse(j.started_at)) / 1000))),
      tokens: runTokens(j.id, 'job_id'), stage: j.tier === 'strategist' ? '评审' : j.tier === 'general' ? '编码' : '执行',
      role: roleTag(j.tier, j.model), round: '-', reason: '', question: '', waiting: '' });
  }
  const needs = Object.entries(s.asks ?? {}).flatMap(([key, ask]) => {
    if (!['pending', 'unknown'].includes(ask.status)) return [];
    const [id, reason] = key.split(':'), row = s.rows.find(r => r.run_id === id);
    if (!row) return [{ progress: unknownProgress(), progressText: '?%', id, project: id, title: '', state: 'unknown', elapsed: '-', tokens: '未知', stage: '', role: '', round: '-', reason: reasonText(reason), question: `${reasonText(reason)} 是=? 否=?`, waiting: '?' }];
    const r = project(row, reason);
    const asked = [...(row.engine?.dispositions ?? [])].reverse().find(d => d.action === 'ask' && d.reason === reason);
    return [{ ...r, waiting: asked ? fmtElapsed(Math.max(0, Math.floor((now - Date.parse(asked.at)) / 1000))) : r.waiting }];
  });
  return {
    metrics: { completed, decided: completed + started.filter(r => r.state === 'failed').length, firstPass: started.filter(r => r.engine?.firstPass && r.state === 'completed').length, asks: s.rows.reduce((n, r) => n + (r.engine?.dispositions.filter(d => d.action === 'ask' && today(Date.parse(d.at))).length ?? 0), 0), debt: typeof s.summary.debt === 'number' ? s.summary.debt : 0 },
    tokens: known ? fmtTokens(daily.reduce((n, d) => n + d.total, 0)) : '未知', roleTokens: byRole.size ? [...byRole].sort(([a], [b]) => Number(a.startsWith('未归属')) - Number(b.startsWith('未归属'))).map(([k, v]) => `${k} ${fmtTokens(v)}`) : ['角色今日用量未知'],
    needs,
    active,
    runs: s.rows.map(r => project(r)),
  };
}
/** Truncate by terminal display columns, including wide characters. */
export function fit(s: string, width: number): string {
  if (Bun.stringWidth(s) <= width) return s;
  let out = ''; for (const ch of s) { if (Bun.stringWidth(out + ch + '…') > width) break; out += ch; }
  return width > 0 ? out + '…' : '';
}
