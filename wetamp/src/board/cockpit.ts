import { progressLabel, totalProgress, unknownProgress, type Progress } from './eta';
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
const STAGES: Partial<Record<string, number>> = { code: 0, repair: 0, verify: 1, settle: 1, diff: 2, review: 2, fix: 2, gate: 3, human: 3, land: 4 };
export function stages(r: BoardRow): string {
  const nodes = r.engine?.states ?? [{ id: r.nodes.current ?? '', state: r.state === 'failed' ? 'failed' : 'running' }];
  const round = Math.max(0, ...nodes.filter(n => n.state !== 'skipped').map(n => Number(/-r(\d+)$/.exec(n.id)?.[1] ?? 0)));
  const current = STAGES[(r.nodes.current ?? '').split('-')[0]];
  const marks = ['编', '验', `评${round ? `R${String(round)}` : ''}`, '门', '合'].map((label, i) => {
    let xs = nodes.filter(n => STAGES[n.id.split('-')[0]] === i && n.state !== 'skipped' && (i < 2 || i > 3 || !/-r\d+$/.test(n.id) || Number(/-r(\d+)$/.exec(n.id)?.[1]) === round));
    // A successful repair/settle supersedes the original failed code/verify node for that same package.
    if (i < 2) xs = xs.filter(n => n.state !== 'failed' || !nodes.some(x => x.id === `${i === 0 ? 'repair' : 'settle'}-${n.id.slice(n.id.indexOf('-') + 1)}` && x.state === 'completed'));
    const mark = xs.some(n => n.state === 'running') ? '◐' : xs.some(n => n.state === 'failed') ? '✗' : xs.length && xs.every(n => n.state === 'completed') ? '✓' : current === i && r.state === 'running' ? '◐' : '·';
    return label + mark;
  });
  const ms = r.engine?.milestones ?? [], index = ms.indexOf(r.engine?.currentMilestone ?? '');
  return `M${index < 0 ? '?' : String(index + 1)}/${ms.length ? String(ms.length) : '?'} ${marks.join(' ')}${current === undefined && r.state === 'running' ? ' 准备◐' : ''}`;
}
export interface CockpitRun {
  progress: Progress; progressText: string;
  id: string; project: string; title: string; state: string; elapsed: string; tokens: string;
  stage: string; role: string; round: string; reason: string; question: string; waiting: string;
}
export interface Cockpit {
  total: Progress | null; totalText: string;
  heartbeat: string; metrics: { completed: number; decided: number; firstPass: number; asks: number; debt: number };
  tokens: string; roleTokens: string[]; needs: CockpitRun[]; active: CockpitRun[]; results: CockpitRun[];
  jobs: string; terminals: string;
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
    const tag = roleTag(x.owner?.role, p.model, true); byRole.set(tag, (byRole.get(tag) ?? 0) + p.total);
  }
  const runTokens = (id: string): string => {
    const xs = c?.sessions.filter(x => x.owner?.run_id === id) ?? [];
    return c?.status === 'ok' && xs.length ? fmtTokens(xs.reduce((n, x) => n + x.total, 0)) : '未知';
  };
  const pending = (r: BoardRow): boolean => Object.entries(s.asks ?? {}).some(([k, v]) => k.startsWith(r.run_id + ':') && ['pending', 'unknown', 'expired'].includes(v.status));
  const project = (r: BoardRow): CockpitRun => {
    const d = r.engine?.dispositions.at(-1), key = d?.reason ?? r.engine?.reason ?? '';
    const policy = (HOLD_POLICY as Partial<Record<string, typeof HOLD_POLICY[keyof typeof HOLD_POLICY]>>)[key];
    const question = policy && 'yes' in policy ? `${reasonText(key)}：是=${({ retry: key === 'budget' ? '放宽预算再跑' : '再跑', resume: '恢复', approve: '批准', review: '重评' })[policy.yes]} 否=终止` : key === 'signoff' || r.state === 'held:human' ? '等待签收：是=批准 否=终止' : `${reasonText(key || r.state.replace('held:', ''))}；superagent brief 查看处置`;
    const progress = s.eta?.[r.run_id]?.progress ?? unknownProgress();
    return { progress, progressText: progressLabel(progress), id: r.run_id, project: r.repo, title: r.engine?.title ?? '任务标题未知', state: r.state, elapsed: fmtElapsed(elapsedAt(r, now)), tokens: runTokens(r.run_id), stage: stages(r), role: roleTag(r.nodes.currentRole, r.model), round: r.engine?.round ? String(r.engine.round) : /-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? '-', reason: reasonText(r.engine?.reason ?? ''), question, waiting: fmtElapsed(d?.action === 'ask' ? Math.max(0, Math.floor((now - Date.parse(d.at)) / 1000)) : elapsedAt(r, now)) };
  };
  const started = s.rows.filter(r => today(Date.parse(r.started_at))), completed = started.filter(r => r.state === 'completed').length;
  const terms = s.activity?.terms ?? [], busy = terms.filter(t => t.state === 'busy').length;
  const waiting = terms.filter(t => t.state === 'idle' && t.since_ms !== null && now - t.since_ms <= 1800000).length;
  const jobs = s.activity?.jobs.filter(j => j.state === 'running') ?? [];
  const active = s.rows.filter(r => ['running', 'owner_lost'].includes(r.state)).map(project);
  const total = active.length ? totalProgress(active.map(r => s.eta?.[r.id] ?? { progress: unknownProgress(), weight: 0 })) : null;
  return { total, totalText: total ? `${String(active.length)} run · ${progressLabel({ ...total, overrun_s: 0 })}` : '',
    heartbeat: s.heartbeat_ms === undefined ? '未知 ✗' : `${fmtElapsed(Math.max(0, Math.floor((now - s.heartbeat_ms) / 1000)))} ${now - s.heartbeat_ms > 180000 ? '✗' : '✓'}`,
    metrics: { completed, decided: completed + started.filter(r => r.state === 'failed').length, firstPass: started.filter(r => r.engine?.firstPass && r.state === 'completed').length, asks: s.rows.reduce((n, r) => n + (r.engine?.dispositions.filter(d => d.action === 'ask' && today(Date.parse(d.at))).length ?? 0), 0), debt: typeof s.summary.debt === 'number' ? s.summary.debt : 0 },
    tokens: known ? fmtTokens(daily.reduce((n, d) => n + d.total, 0)) : '未知', roleTokens: byRole.size ? [...byRole].sort(([a], [b]) => Number(a.startsWith('未归属')) - Number(b.startsWith('未归属'))).map(([k, v]) => `${k} ${fmtTokens(v)}`) : ['角色今日用量未知'],
    needs: s.rows.filter(r => r.state.startsWith('held:') || r.state === 'failed' && /^(code|fix|verify|settle)-/.test(r.nodes.current ?? '') && pending(r)).map(project),
    active,
    results: s.rows.filter(r => ['completed', 'failed', 'cancelled'].includes(r.state) && r.span?.ended_ms !== null && today(r.span?.ended_ms ?? NaN)).sort((a, b) => (b.span?.ended_ms ?? 0) - (a.span?.ended_ms ?? 0)).map(project),
    jobs: jobs.length ? `▸ 作业 ${String(jobs.length)} · ${jobs.map(j => `${roleTag(j.tier, j.model)} ${j.title} ${fmtElapsed(Math.max(0, Math.floor((now - Date.parse(j.started_at)) / 1000)))}`).join(' · ')}` : '',
    terminals: `终端 ${String(terms.length)}：执行中 ${String(busy)} · 等待输入 ${String(waiting)} · 空闲 ${String(terms.filter(t => t.state === 'idle').length - waiting)}${terms.some(t => t.state === 'unknown') ? ` · 未确认 ${String(terms.filter(t => t.state === 'unknown').length)}` : ''}（t 展开）`,
  };
}
/** Truncate title only, retaining elapsed/token columns at every width. */
export function fit(s: string, width: number): string {
  if (Bun.stringWidth(s) <= width) return s;
  let out = ''; for (const ch of s) { if (Bun.stringWidth(out + ch + '…') > width) break; out += ch; }
  return width > 0 ? out + '…' : '';
}
export function runLine(r: CockpitRun, width: number, result = false): string {
  const mark = result ? ({ completed: '✓', failed: '✗', cancelled: '⊘' }[r.state] ?? '?') : '▶';
  const suffix = ` ${r.elapsed}${result || width >= 100 ? ` R${r.round}` : ''} ${r.tokens}${result && r.reason ? ` ${r.reason}` : ''}${!result && width >= 100 ? ` ${r.id.replace(/^\d{8}-/, '')}` : ''}`;
  return fit(`${fit(`${mark} ${r.project} ${r.title}`, Math.max(1, width - Bun.stringWidth(suffix)))}${suffix}`, width);
}
