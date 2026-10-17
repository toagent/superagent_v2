import { clock, metricsOf } from '../ledger-metrics';
import { basename, dirname } from 'node:path';
import { progressLabel, jobProgress, unknownProgress, type Progress } from './eta';
import { HOLD_POLICY } from '../cli';
import { shortModel } from '../models';
import { fmtTokens } from '../usage';
import { elapsedAt, fmtElapsed, type BoardRow, type Snapshot } from './data';

/** Stable S3 reasons have exactly one display translation; unknown reasons remain evidence. */
export const REASONS = {
  signoff: '等待签收',
  deadline: '截止已过',
  gate: '门禁未通过',
  coder: '编码未通过',
  coder_budget: 'Claude 将军预算用尽',
  environment: '环境未就绪',
  paused: '等待恢复',
  auto_retry_exhausted: '重试已用尽',
  no_change: '修复无变化',
  no_attempt_node: '旧工作流无法重跑',
  recover_no_progress: '恢复无进展',
  needs: '需要补能力',
  redline: '命中红线',
  coder_blocked: '执行约束阻断',
  review_limit: '评审轮次用尽',
  review_not_independent: '评审不独立',
  engine_suspect: '引擎嫌疑',
  approval: '等待批准',
  acceptance_adjudication: '等待验收裁决',
} satisfies Record<keyof typeof HOLD_POLICY, string> & Record<string, string>;
export const reasonText = (s: string): string =>
  (REASONS as Partial<Record<string, string>>)[s] ?? s;
export const roleTag = (
  role: string | null | undefined,
  model?: string | null,
  compact = false
): string =>
  (({
    commander: '元帅',
    general: '将军',
    strategist: '军师',
    coder: '将军',
    reviewer: '军师',
    script: '引擎',
    human: '人工',
  })[role ?? ''] ?? '未归属') +
  (shortModel(model, compact) ? `·${shortModel(model, compact)}` : '');
export function stages(r: BoardRow): string {
  const kind = (r.nodes.current ?? '').split('-')[0];
  const round = /-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? String(r.engine?.round ?? 1);
  const ms = r.engine?.milestones ?? [],
    index = ms.indexOf(r.engine?.currentMilestone ?? '');
  if (kind === 'code')
    return `编码 m${index < 0 ? '?' : String(index + 1)}/${ms.length ? String(ms.length) : '?'}`;
  if (kind === 'review') return `评审 r${round}`;
  return (
    {
      repair: '修复',
      fix: '修复',
      verify: '验收',
      settle: '验收',
      diff: '评审准备',
      gate: '门禁',
      human: '签收',
      land: '合入',
    }[kind] ?? '准备'
  );
}
export interface CockpitRun {
  coordination?: BoardRow['coordination'];
  url?: string;
  firstPass?: boolean | 'unknown';
  interventions?: number;
  progress: Progress;
  progressText: string;
  id: string;
  project: string;
  title: string;
  state: string;
  elapsed: string;
  tokens: string;
  stage: string;
  node?: string;
  role: string;
  round: string;
  reason: string;
  question: string;
  decision?: { event: string; yes: string; no: string };
  waiting: string;
}
export interface Cockpit {
  tree: (CockpitRun & { children: { id: string; role: string; progress: Progress }[] })[];
  anomalies: string[];
  unfinished: number;
  zombies: number;
  reflection: Snapshot['reflection'];
  tokenRows: { role: string; total: number; models: Record<string, number> }[] | null;
  metrics: ReturnType<typeof metricsOf>;
  tokens: string;
  roleTokens: string[];
  needs: CockpitRun[];
  active: CockpitRun[];
  runs: CockpitRun[];
}
const decisionText = (d: NonNullable<CockpitRun['decision']>): string =>
  `${d.event} 是=${d.yes} 否=${d.no}`;
/** Pure projection shared by Ink and HTTP; collection remains owned by the existing loader/cache. */
export function cockpit(s: Snapshot, now = Date.now()): Cockpit {
  const day = new Date(now).toLocaleDateString('sv-SE'),
    c = s.usage;
  const daily = c?.daily.filter(d => d.day === day) ?? [];
  const known = c?.status === 'ok' && daily.length > 0;
  // A day-scoped result from the existing usage collector proves role/day attribution. Older caches stay unknown.
  const byRole = new Map<string, number>();
  const tokenRows = ['元帅', '军师', '将军', '未归属'].map(role => ({
    role,
    total: 0,
    models: {} as Record<string, number>,
  }));
  const todaySessions =
    c?.today?.day === day && c.today.status === 'ok'
      ? c.today.sessions
      : c?.since === day.replaceAll('-', '')
        ? c.sessions
        : null;
  if (known && todaySessions)
    for (const x of todaySessions)
      for (const p of x.parts?.length ? x.parts : [x]) {
        const tag = roleTag(x.owner?.role, p.model);
        byRole.set(tag, (byRole.get(tag) ?? 0) + p.total);
        const row = tokenRows.find(r => r.role === roleTag(x.owner?.role));
        if (!row) continue;
        const model = shortModel(p.model) || '—';
        row.total += p.total;
        row.models[model] = (row.models[model] ?? 0) + p.total;
      }
  const runTokens = (id: string, field: 'run_id' | 'job_id' = 'run_id'): string => {
    const xs = c?.sessions.filter(x => x.owner?.[field] === id) ?? [];
    return c?.status === 'ok' && xs.length
      ? fmtTokens(xs.reduce((n, x) => n + x.total, 0))
      : '未知';
  };
  const project = (r: BoardRow, why?: string): CockpitRun => {
    const d = r.engine?.dispositions.at(-1),
      key = why ?? d?.reason ?? r.engine?.reason ?? '';
    const policy = (
      HOLD_POLICY as Partial<Record<string, (typeof HOLD_POLICY)[keyof typeof HOLD_POLICY]>>
    )[key];
    const decision =
      policy && 'yes' in policy
        ? {
            event: reasonText(key),
            yes: {
              retry: key === 'budget' ? '放宽预算再跑' : '再跑',
              resume: '恢复',
              approve: '批准',
              review: '重评',
              adjudicate: '按证据记债',
            }[policy.yes],
            no: '终止',
          }
        : key === 'signoff' || r.state === 'held:human'
          ? { event: '等待签收', yes: '批准', no: '终止' }
          : undefined;
    const question = decision
      ? decisionText(decision)
      : `${reasonText(key || r.state.replace('held:', ''))}；superagent brief 查看处置`;
    const progress = s.eta?.[r.run_id]?.progress ?? unknownProgress();
    return {
      ...(r.coordination ? { coordination: r.coordination } : {}),
      interventions: r.interventions,
      firstPass: r.engine?.firstPass,
      progress,
      progressText: progressLabel(progress),
      id: r.run_id,
      url: r.archon_id ? `/console/r/${encodeURIComponent(r.archon_id)}` : undefined,
      project: basename(r.repo),
      title: r.engine?.title ?? '任务标题未知',
      state: r.state,
      elapsed: fmtElapsed(elapsedAt(r, now)),
      tokens: runTokens(r.run_id),
      stage: stages(r),
      node: r.nodes.current ?? undefined,
      role: ['completed', 'failed', 'cancelled'].includes(r.state)
        ? roleTag(
            'coder',
            r.coderModel ??
              c?.sessions.find(x => x.owner?.run_id === r.run_id && x.owner.role === 'general')
                ?.model
          )
        : roleTag(r.nodes.currentRole, r.model),
      round: r.engine?.round
        ? String(r.engine.round)
        : (/-r(\d+)$/.exec(r.nodes.current ?? '')?.[1] ?? '1'),
      reason: reasonText(r.engine?.reason ?? ''),
      question,
      decision,
      waiting: fmtElapsed(
        d?.action === 'ask'
          ? Math.max(0, Math.floor((now - clock(d.at)) / 1000))
          : elapsedAt(r, now)
      ),
    };
  };
  const fresh = (at: string | null | undefined): boolean => {
    const age = now - clock(at ?? '');
    return age >= 0 && age < 600000;
  };
  const liveRows = s.rows.filter(r => r.state === 'running' && fresh(r.lastEvent));
  const liveJobs =
    s.activity?.jobs.filter(j => j.state === 'running' && j.pidAlive && fresh(j.heartbeatAt)) ?? [];
  const zombies =
    s.rows.filter(
      r =>
        (r.nativeState === 'running' || ['running', 'owner_lost'].includes(r.state)) &&
        !r.state.startsWith('held:') &&
        !liveRows.includes(r)
    ).length +
    (s.activity?.jobs.filter(j => j.state === 'running' && !liveJobs.includes(j)).length ?? 0);
  const active = liveRows.map(r => project(r));
  const tree: Cockpit['tree'] = liveRows.map(r => ({
    ...project(r),
    children: (r.activeNodes ?? []).map(n => ({
      id: n.id,
      role: roleTag(n.role, n.model),
      progress: s.eta?.[r.run_id]?.nodes?.[n.id] ?? unknownProgress(),
    })),
  }));
  for (const j of liveJobs) {
    const progress =
      j.state === 'queued'
        ? unknownProgress()
        : jobProgress({ ...j, role: j.tier }, s.activity?.jobHistory ?? [], now);
    active.push({
      progress,
      progressText: progressLabel(progress),
      id: j.id,
      project: basename(j.cwd),
      title: j.title,
      state: j.state,
      elapsed: fmtElapsed(Math.max(0, Math.floor((now - clock(j.started_at)) / 1000))),
      tokens: runTokens(j.id, 'job_id'),
      stage:
        j.state === 'queued'
          ? '准备启动'
          : j.tier === 'strategist'
            ? '评审'
            : j.tier === 'general'
              ? '编码'
              : '执行',
      role: roleTag(j.tier, j.model),
      round: '-',
      reason: j.reason ?? '',
      question: '',
      waiting: j.state === 'queued' ? '准备启动' : '',
    });
  }
  for (const cwd of new Set(liveJobs.map(j => j.cwd))) {
    const children = active.filter(r => liveJobs.some(j => j.cwd === cwd && j.id === r.id));
    const measured = children.filter(r => r.progress.pct !== null);
    const progress: Progress =
      measured.length === children.length
        ? {
            pct: Math.round(
              measured.reduce((n, r) => n + (r.progress.pct ?? 0), 0) / measured.length
            ),
            eta_s: measured.every(r => r.progress.eta_s !== null)
              ? Math.max(...measured.map(r => r.progress.eta_s ?? 0))
              : null,
            overrun_s: Math.max(...measured.map(r => r.progress.overrun_s)),
            basis: 'history',
          }
        : unknownProgress();
    tree.push({
      ...children[0],
      id: cwd,
      project: basename(cwd),
      progress,
      children: children.map(r => ({ id: r.id, role: r.role, progress: r.progress })),
    });
  }
  const anomalies: string[] = [],
    seen = new Set<string>();
  const needs = Object.entries(s.asks ?? {}).flatMap(([key, ask]) => {
    if (!['pending', 'unknown'].includes(ask.status)) return [];
    const unresolved = (): [] => {
      anomalies.push(`无法解析：${key}`);
      return [];
    };
    if (key.startsWith('coord:')) {
      const parts = /^coord:([^:]+)(?::(\d+):(\d+))?$/.exec(key);
      const m = s.coordMessages?.find(m => m.id === parts?.[1]);
      if (!m || !parts) return unresolved();
      if (m.type || ['accepted', 'done', 'rejected'].includes(m.state)) return [];
      if (m.ask && !['pending', 'unknown'].includes(m.ask.status)) return [];
      if (
        parts[2] &&
        (Number(parts[2]) !== (m.ask?.generation ?? m.generation) ||
          Number(parts[3]) !== (m.ask_round ?? 0))
      )
        return [];
      if (seen.has(`coord:${m.id}`)) return [];
      seen.add(`coord:${m.id}`);
      const repo = m.scope.kind === 'repo' ? m.scope.id : m.scope.repo;
      const decision = { event: m.title.replace(/[\r\n]+/g, ' '), yes: '发现者接管', no: '继续等' };
      return [
        {
          progress: unknownProgress(),
          progressText: '—',
          id: m.id,
          project: basename(basename(repo) === '.git' ? dirname(repo) : repo),
          title: m.title,
          state: m.state,
          elapsed: '-',
          tokens: '未知',
          stage:
            m.scope.kind === 'run'
              ? m.scope.id
              : (m.sender.session_id?.slice(0, 8) ?? m.sender.client),
          role: '',
          round: '-',
          reason: m.kind,
          decision,
          question: decisionText(decision),
          waiting: fmtElapsed(Math.max(0, Math.floor((now - clock(m.at)) / 1000))),
        },
      ];
    }
    const parts = /^([^:]+):([^:]+)(?::([^:]+))?$/.exec(key);
    if (!parts) return unresolved();
    const [, id, reason] = parts,
      row = s.rows.find(r => r.run_id === id);
    const policy = (HOLD_POLICY as Partial<Record<string, { do: string }>>)[reason];
    if (!row || !policy || !['ask', 'signoff'].includes(policy.do)) return unresolved();
    // the engine owns reason mapping; failed may still require a coder decision.
    if (row.askReason !== reason) return [];
    if (!row.stale && row.humanDecision) return [];
    if (seen.has(`${id}:${reason}`)) return [];
    seen.add(`${id}:${reason}`);
    const r = project(row, reason);
    const asked = [...(row.engine?.dispositions ?? [])]
      .reverse()
      .find(d => d.action === 'ask' && d.reason === reason);
    return [
      {
        ...r,
        ...(row.stale || (!row.humanDecision && ['signoff', 'approval'].includes(reason))
          ? { decision: undefined, question: r.question + '；手机决策信息未知，请在 Mac 核实' }
          : {}),
        waiting: asked
          ? fmtElapsed(Math.max(0, Math.floor((now - clock(asked.at)) / 1000)))
          : r.waiting,
      },
    ];
  });
  for (const r of s.rows) {
    const d = r.humanDecision;
    if (r.stale || !d) continue;
    needs.push({
      ...project(r),
      question:
        d.question +
        '；' +
        (d.disabled ?? d.options.map(o => o.label + '：' + o.consequence).join(' / ')),
    });
  }
  return {
    tokenRows: known && todaySessions ? tokenRows.sort((a, b) => b.total - a.total) : null,
    metrics: metricsOf(s.rows, s.summary, now),
    tokens: known ? fmtTokens(daily.reduce((n, d) => n + d.total, 0)) : '未知',
    roleTokens: byRole.size
      ? [...byRole]
          .sort(([a], [b]) => Number(a.startsWith('未归属')) - Number(b.startsWith('未归属')))
          .map(([k, v]) => `${k} ${fmtTokens(v)}`)
      : ['角色今日用量未知'],
    unfinished:
      s.rows.filter(
        r =>
          !['completed', 'failed', 'cancelled'].includes(r.state) ||
          (r.nativeState !== undefined &&
            !['completed', 'failed', 'cancelled'].includes(r.nativeState))
      ).length +
      (s.activity?.jobs.filter(j => !['done', 'failed', 'cancelled', 'lost'].includes(j.state))
        .length ?? 0),
    tree,
    anomalies,
    zombies,
    reflection: s.reflection,
    needs,
    active,
    runs: s.rows.map(r => project(r)),
  };
}
/** Truncate by terminal display columns, including wide characters. */
export function fit(s: string, width: number): string {
  if (Bun.stringWidth(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (Bun.stringWidth(out + ch + '…') > width) break;
    out += ch;
  }
  return width > 0 ? out + '…' : '';
}

/** The soonest measured completion; unknown estimates remain unknown. */
export function decisionHeader(c: Cockpit): string {
  const etas = c.active.flatMap(r => (r.progress.eta_s === null ? [] : [r.progress.eta_s]));
  return `跑 ${String(c.active.length)} · 等你 ${String(c.needs.length)} · 僵死 ${String(c.zombies)} · ETA ${etas.length ? `~${String(Math.ceil(Math.min(...etas) / 60))}m` : '未知'} · 异常 ${String(c.anomalies.length)}`;
}
