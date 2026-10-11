import { basename } from 'node:path';
import { memoryData, type Episode, type Lesson } from '../memory';
import { cockpit } from '../board/cockpit';
import { fmtElapsed, type Snapshot } from '../board/data';
import { fmtTokens } from '../usage';
import { html, panel } from './server';

const states: Record<string, string> = {
  failed: '失败',
  cancelled: '取消',
  paused: '挂起',
  running: '进行中',
  completed: '完成',
  done: '完成',
  lost: '失联',
  pending: '等待',
};
const lessonState: Record<Lesson['status'], string> = {
  trial: '试用',
  stable: '稳定',
  retired: '退役',
  mechanized: '已机制化',
};
const terminal = (e: Episode): boolean =>
  ['completed', 'done', 'failed', 'cancelled', 'lost'].includes(e.status);
const ratio = (n: number, d: number): string => (d ? `${String(Math.round((n / d) * 100))}%` : '—');
const total = (e: Episode): number | null =>
  e.tokens.length && e.tokens.every(t => t.total !== null)
    ? e.tokens.reduce((n, t) => n + (t.total ?? 0), 0)
    : null;

/** Rates use one latest episode per run/job; earlier held episodes remain in the history table. */
export function memoryOverview(s: Snapshot, data = memoryData(Date.parse(s.at)), all = false) {
  const c = cockpit(s, Date.parse(s.at)),
    now = Date.parse(s.at),
    latest = [
      ...new Map(
        [...data.all].sort((a, b) => a.at.localeCompare(b.at)).map(e => [`${e.source}:${e.id}`, e])
      ).values(),
    ];
  const ended = latest.filter(terminal),
    runEnded = ended.filter(e => e.source === 'run'),
    runs = new Map(c.runs.map(r => [r.id, r]));
  const failures = (from: number, to: number): Episode[] =>
    latest.filter(e => e.status === 'failed' && Date.parse(e.at) >= from && Date.parse(e.at) < to);
  const previous = failures(now - 14 * 86400000, now - 7 * 86400000),
    recent = failures(now - 7 * 86400000, now + 1);
  const recurrence = (xs: Episode[], prior: Episode[]): string => {
    const codes = (e: Episode): string[] => (e.reasons.length ? e.reasons : [e.signature]);
    const keys = new Set(prior.flatMap(e => codes(e).map(r => JSON.stringify([e.project, r]))));
    let repeat = 0;
    for (const e of xs.sort((a, b) => a.at.localeCompare(b.at))) {
      if (codes(e).some(r => keys.has(JSON.stringify([e.project, r])))) repeat++;
      for (const r of codes(e)) keys.add(JSON.stringify([e.project, r]));
    }
    return ratio(repeat, xs.length);
  };
  const helpful = data.lessons.reduce((n, l) => n + l.helpful, 0),
    harmful = data.lessons.reduce((n, l) => n + l.harmful, 0);
  const packageTokens = runEnded.flatMap(e => {
    const t = total(e);
    return t === null || !e.packages.length ? [] : [{ tokens: t, packages: e.packages.length }];
  });
  const metrics = {
    '同类失败复发率（近7天 / 前7天）': `${recurrence(recent, previous)} / ${recurrence(previous, [])}`,
    一次通过率: ratio(
      c.runs.filter(r => r.firstPass && ['completed', 'failed', 'cancelled'].includes(r.state))
        .length,
      c.runs.filter(r => ['completed', 'failed', 'cancelled'].includes(r.state)).length
    ),
    人工干预次数: c.runs.reduce(
      (n, r) =>
        n +
        Math.max(
          r.interventions ?? 0,
          latest
            .find(e => e.source === 'run' && e.id === r.id)
            ?.dispositions.filter(d => ['ask', 'approve', 'reject', 'retry'].includes(d.action))
            .length ?? 0
        ),
      0
    ),
    '每个交付包 token': packageTokens.length
      ? fmtTokens(
          Math.round(
            packageTokens.reduce((n, e) => n + e.tokens, 0) /
              packageTokens.reduce((n, e) => n + e.packages, 0)
          )
        )
      : '—',
    经验命中率: ratio(data.hitRuns, data.scored),
    经验有效率: ratio(helpful, helpful + harmful),
    引擎自修复次数: 0,
  };
  return {
    at: new Date(now).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    metrics,
    reflection: data.reflection,
    queued: data.queued,
    lessons: data.lessons,
    hits: data.hits,
    rows: data.all
      .filter(
        e =>
          all ||
          ['failed', 'lost', 'paused', 'pending'].includes(e.status) ||
          (runs.get(e.id)?.state.startsWith('held:') ?? false) ||
          (e.p50_ratio ?? 0) > 2
      )
      .map(e => ({
        ...e,
        title: runs.get(e.id)?.title ?? e.tag,
        url: runs.get(e.id)?.url,
        tokenText: total(e) === null ? '—' : fmtTokens(total(e) ?? 0),
        extracted: data.lessons.filter(l => l.evidence.includes(e.id)),
      })),
  };
}
export function memoryPanel(d: ReturnType<typeof memoryOverview>, all: boolean): string {
  const cells = (xs: (string | number)[]): string => xs.map(x => `<td>${html(x)}</td>`).join('');
  const table = (ls: Lesson[]): string =>
    `<table><thead><tr><th>状态</th><th>when</th><th>do</th><th>命中</th><th>helpful / harmful</th></tr></thead><tbody>${ls.map(l => `<tr>${cells([lessonState[l.status], l.when, l.do, d.hits[l.id] ?? 0, `${String(l.helpful)} / ${String(l.harmful)}`])}</tr>`).join('')}</tbody></table>`;
  const body = `<header><h1>经验与进化 · ${html(d.at)}</h1><p><a href="/sa">驾驶舱</a> · <a href="/console">所有 Archon run</a></p></header><section id="evolution"><h2>进化指标</h2><table>${Object.entries(
    d.metrics
  )
    .map(([k, v]) => `<tr>${cells([k, v])}</tr>`)
    .join(
      ''
    )}</table><p${d.reflection.yellow ? ' style="color:#e5c07b"' : ''}>今日反思 token ${String(d.reflection.tokens)} / ${String(d.reflection.limit)} · 排队 episode ${String(d.queued)}</p><small>复发按原因码 × 项目；比率无样本为 —。token 仅已知回执，按交付包数加权。</small></section>
<section id="episodes"><h2>${all ? '全部' : '失败 / 挂起 / 长耗时'} · <a href="/sa/memory${all ? '' : '?filter=all'}">${all ? '默认筛选' : '全部'}</a></h2><table><thead><tr><th>项目</th><th>任务 / run / episode</th><th>终态</th><th>原因码</th><th>处置</th><th>用时 / p50</th><th>token</th><th>finding</th><th>经验 / 状态</th></tr></thead><tbody>${d.rows.map(e => `<tr data-episode="${html(e.id)}">${cells([basename(e.project)])}<td>${html(e.title)}<br>${e.url ? `<a href="${html(e.url)}">${html(e.id)}</a>` : html(e.id)} · <a href="/sa/memory/episode?id=${encodeURIComponent(e.id)}">JSON</a></td>${cells([states[e.status] ?? e.status, e.reasons.join(' · ') || e.signature, e.dispositions.map(x => `${x.action}:${x.reason}`).join(' · ') || e.result, `${fmtElapsed(Math.round(e.duration_ms / 1000))} / ${e.p50_ratio === null ? '—' : e.p50_ratio.toFixed(2) + '×'}`, e.tokenText, e.findings.length, e.extracted.map(l => `${l.do}（${lessonState[l.status]}）`).join(' · ') || e.result])}</tr>`).join('')}</tbody></table></section>
<section id="lessons"><h2>经验库</h2>${[...new Set(d.lessons.map(l => l.scope))]
    .map(scope => {
      const ls = d.lessons.filter(l => l.scope === scope);
      return `<h3>${html(scope)}</h3>${table(ls.filter(l => l.status !== 'retired'))}${ls.some(l => l.status === 'retired') ? `<details><summary>退役</summary>${table(ls.filter(l => l.status === 'retired'))}</details>` : ''}`;
    })
    .join('')}</section>`;
  return panel({ at: d.at }, body);
}
