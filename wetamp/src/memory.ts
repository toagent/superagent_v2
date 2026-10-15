// Episodes and legacy lessons are evidence projections; only owner publications feed learning.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { infer as Infer } from '../../packages/workflows/node_modules/zod';
import { archonJson, lock, runRevision, type RunView } from './archon';
import { home, loadTiers, runAliases, WETAMP, writeAtomic } from './config';
import { artifactsOf, classifyRun, ledgerIds, loadLedger, type Ledger } from './cli';
import { cockpitSignals, type Asks } from './cockpit-signals';
import { etaInput } from './board/eta';
import { confined, workflowRoles } from './board/workflow';
import { callsOf } from './report';
import { readUsage } from './usage';
import { readJobs } from './jobs';
import { reasonOf } from './reasons';
import { redact } from './redact';
import { budgetUsage } from '../templates/.archon/scripts/sa-check';
import type { Plan, Pkg } from './plan';
import { recallLearning, selectLearning, type LearningEntry } from './learning';
// Reuse the workflows package's existing schema dependency, as plan.ts does for Ajv.
export const z: typeof import('../../packages/workflows/node_modules/zod').z = (
  createRequire(join(WETAMP, '..', 'packages/workflows/package.json'))(
    'zod'
  ) as typeof import('../../packages/workflows/node_modules/zod')
).z;

export type Category = 'engine' | 'plan' | 'project' | 'role' | 'transient';
export interface Episode {
  id: string;
  at: string;
  source: 'run' | 'job';
  status: string;
  project: string;
  tag: string;
  risk: string;
  size: string;
  model: string | null;
  fake: boolean;
  packages: { id: string; tag: string; risk: string; size: string }[];
  duration_ms: number;
  p50_ratio: number | null;
  reasons: string[];
  category: Category;
  signature: string;
  fingerprint: string | null;
  incidents: string[];
  timeline: {
    node: string;
    state: string;
    started_at: string | null;
    duration_ms: number | null;
  }[];
  acceptance: { cmd: string; ok: boolean | null }[];
  findings: string[];
  diff: { files: number; added: number; removed: number } | null;
  tokens: { role: string | null; model: string | null; total: number | null }[];
  asks: { hold: string; status: string }[];
  dispositions: { at: string; reason: string; action: string; ok: boolean }[];
  signals: ReturnType<typeof cockpitSignals>;
}
const field = z.string().max(240);
export const lessonSchema = z
  .object({
    tier: z.enum(['project', 'type', 'role']),
    scope: field.min(1),
    when: field.min(1),
    do: field.min(1),
    dont: field,
    why: field,
    evidence: z.array(field).min(1).max(5),
    mechanizable: z.boolean(),
  })
  .strict();
export type Lesson = Infer<typeof lessonSchema> & {
  id: string;
  tag: string;
  category: Category;
  reasons: string[];
  status: 'trial' | 'stable' | 'retired' | 'mechanized';
  helpful: number;
  harmful: number;
  votes?: number;
  created_at: string;
  last_hit: string;
};
interface Entry {
  lessons: Lesson[];
  hit_ids?: string[];
  scored?: string;
  reflected?: string;
  reflection?: {
    episode: string;
    state: 'queued' | 'running' | 'produced' | 'rejected' | 'failed' | 'interrupted';
    usage?: number | null;
  };
  result?: string;
  day?: string;
  tokens?: number;
}
export interface Prior {
  n: number;
  duration: { p50: number; p90: number };
  tokens: { n: number; p50: number; p90: number };
}
const root = (): string => join(home().sa, 'memory');
export const memoryOn = (): boolean => process.env.SUPERAGENT_MEMORY !== 'off';
export const privateProject = (p: string): boolean =>
  p.includes('_private') || p.includes('Mobile Documents');
export const memoryLog = (why: string): void => {
  console.error(`memory: ${why}`);
};
export const memoryPath = (path: string): string | null =>
  confined({ repo: home().sa } as Ledger, path);
// Collection may read repository evidence; Web memory reads have no Ledger scope.
export function memoryJson<T>(path: string, fallback: T, owner?: Ledger): T {
  const file = owner ? confined(owner, path) : memoryPath(path);
  return file ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}
const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
    : [];
export const episodeOf = (id: string): Episode | null =>
  memoryJson<Episode | null>(
    join(root(), 'projections', id + '.json'),
    memoryJson<Episode | null>(join(root(), 'episodes', id + '.json'), null)
  );
export const episodes = (): Episode[] =>
  files(join(root(), 'episodes')).flatMap(f => {
    const e = episodeOf(f.slice(0, -5));
    return e ? [e] : [];
  });
export function memoryState(): { lessons: Lesson[]; entries: Entry[] } {
  const file = memoryPath(join(root(), 'lessons.jsonl')),
    entries = file
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(s => JSON.parse(s) as Entry)
      : [];
  return {
    entries,
    lessons: [...new Map(entries.flatMap(e => e.lessons).map(l => [l.id, l])).values()],
  };
}
export function memoryWrite(fn: (state: ReturnType<typeof memoryState>) => Entry): void {
  mkdirSync(root(), { recursive: true });
  const held = lock(join(root(), 'store.lock'));
  if (!held.ok) throw new Error('store busy');
  try {
    const entry = fn(memoryState());
    if (entry.lessons.length || entry.scored || entry.reflected || entry.reflection || entry.day)
      appendFileSync(join(root(), 'lessons.jsonl'), JSON.stringify(entry) + '\n');
  } finally {
    held.release();
  }
}
export const taskTag = (paths: string[]): string => {
  const rules: [RegExp, string][] = [
    [/\.(java|xml)$/, 'java-mybatis'],
    [/\.vue$/, 'vue2'],
    [/\.(ts|tsx|js|mjs|cjs)$/, 'ts-cli'],
    [/\.(md|txt|rst)$/, 'docs'],
    [/\.py$/, 'python'],
    [/\.go$/, 'go'],
  ];
  return (
    [...new Set(paths.flatMap(p => rules.filter(([re]) => re.test(p)).map(([, tag]) => tag)))]
      .sort()
      .slice(0, 2)
      .join('+') || 'other'
  );
};
type TriageEvidence = Pick<Episode, 'reasons' | 'signals'> &
  Partial<Pick<Episode, 'status' | 'acceptance' | 'dispositions' | 'p50_ratio'>> & {
    overrun?: boolean;
    coder_error?: boolean;
  };
export function diagnosis(
  e: TriageEvidence,
  contradiction = false
): { category: Category; signature: string } {
  const reasons = e.reasons.map(reasonOf),
    result = (
      category: Category,
      signature: string
    ): { category: Category; signature: string } => ({ category, signature });
  if (e.reasons.includes('base_branch_missing')) return result('engine', 'base_branch_missing');
  if (e.signals.engine_suspect) return result('engine', 'engine_suspect');
  if (e.signals.dup_ask) return result('engine', 'dup_ask');
  if (e.signals.orphan_hold) return result('engine', 'orphan_hold');
  if (
    e.dispositions?.some(
      d => d.action.startsWith('auto_retry') || d.reason.startsWith('auto_retry')
    )
  )
    return result('engine', 'auto_retry');
  // An operator cancellation is a recorded terminal cause; earlier coder errors don't explain it.
  if (e.status === 'cancelled' && e.reasons.includes('cancelled_source'))
    return result('transient', 'cancelled_source');
  if (['failed', 'cancelled', 'lost'].includes(e.status ?? '') && !reasons.length)
    return result('engine', 'evidence_missing');
  if (
    contradiction ||
    e.coder_error ||
    e.reasons.some(r => r.includes('coder_error:')) ||
    (e.status &&
      ['failed', 'cancelled', 'lost', 'paused'].includes(e.status) &&
      e.acceptance?.length &&
      e.acceptance.every(a => a.ok === true))
  )
    return result('engine', 'evidence_conflict');
  if (reasons.some(r => !r)) return result('engine', 'unregistered_reason');
  if (reasons.some(r => r?.owner === 'engine' && r.determinism === 'deterministic'))
    return result(
      'engine',
      reasons.find(r => r?.owner === 'engine' && r.determinism === 'deterministic')?.code ??
        'evidence_missing'
    );
  if (reasons.some(r => r?.code === 'coder_output_invalid' || r?.code === 'review_failed'))
    return result(
      'role',
      reasons.find(r => r?.code === 'coder_output_invalid' || r?.code === 'review_failed')?.code ??
        'evidence_missing'
    );
  if (reasons.length && reasons.every(r => r?.determinism === 'transient'))
    return result('transient', e.reasons.slice().sort().join('+'));
  if (reasons.some(r => r?.owner === 'human') || e.overrun || (e.p50_ratio ?? 0) > 2)
    return result('plan', reasons.find(r => r?.owner === 'human')?.code ?? 'duration_overrun');
  if (reasons.some(r => r?.owner === 'coder'))
    return result('project', e.reasons.slice().sort().join('+'));
  return result('engine', 'evidence_missing');
}
export const triage = (e: TriageEvidence, contradiction = false): Category =>
  diagnosis(e, contradiction).category;
function mechanize(signature: string, reasons: string[], episode: string): void {
  mkdirSync(join(root(), 'mechanize'), { recursive: true });
  const id = signature.replace(/[^a-zA-Z0-9_-]/g, '_'),
    file = join(root(), 'mechanize', `${id}.json`),
    previous = memoryJson<{ episodes: string[]; reasons: string[] }>(file, {
      episodes: [],
      reasons: [],
    });
  writeAtomic(
    file,
    JSON.stringify({
      id,
      signature,
      episodes: [...new Set([...previous.episodes, episode])],
      reasons: [...new Set([...previous.reasons, ...reasons])],
      invariant: 'I1/I2/I5/I6',
      requirement: '用 episode 证据建立事故回放，将重复失败转为确定性机制。',
    })
  );
}
export function saveEpisode(e: Episode): boolean {
  if (basename(e.id) !== e.id || !e.id || e.id === '..') throw new Error('invalid episode id');
  const dir = join(root(), 'episodes');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${e.id}.json`);
  const first = !existsSync(path);
  if (e.category === 'engine') mechanize(e.signature, e.reasons, e.id);
  // Drop whole optional rows, never truncate JSON or omit the failure identity.
  while (Buffer.byteLength(JSON.stringify(e)) > 8192) {
    const rows = [e.timeline, e.findings, e.acceptance, e.dispositions, e.asks, e.tokens].sort(
      (a, b) => b.length - a.length
    );
    if (!rows[0].length) throw new Error('episode metadata exceeds 8KB');
    rows[0].pop();
  }
  const target = first ? path : join(root(), 'projections', `${e.id}.json`);
  if (!first) mkdirSync(join(root(), 'projections'), { recursive: true });
  const text = JSON.stringify(e);
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) writeAtomic(target, text);
  return first;
}
const quantiles = (xs: number[]): { p50: number; p90: number } => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p50: s[Math.floor((s.length - 1) / 2)] ?? 0,
    p90: s[Math.ceil((s.length - 1) * 0.9)] ?? 0,
  };
};
export const priorKey = (
  project: string,
  p: Pick<Pkg, 'size' | 'risk' | 'scope'>,
  model: string | null
): string => JSON.stringify([project, taskTag(p.scope.write), p.size, p.risk, model]);
// Producer conformance is exercised with sa-check's success and failure artifacts in memory.test.ts.
const evidenceSchema = z
  .object({
    reason: z.string().nullable().optional(),
    ok: z.boolean().optional(),
    failed: z.array(z.string()).optional(),
    findings: z
      .array(
        z
          .object({
            id: z.string(),
            severity: z.enum(['blocker', 'high', 'medium', 'low']),
            status: z.string(),
          })
          .loose()
      )
      .optional(),
  })
  .loose();
function evidenceRows(
  l: Ledger,
  run: RunView
): { file: string; data: Infer<typeof evidenceSchema> }[] {
  const art = confined(l, artifactsOf(run));
  if (!art) return [];
  return files(art)
    .filter(
      f =>
        /^(verify-|settle-|gate-|environment\.json$)/.test(f) && !/\.(coder|ledger)\.json$/.test(f)
    )
    .flatMap(file => {
      const raw = memoryJson<unknown>(join(art, file), null, l);
      // gate writes a nullable review independently of its mandatory decision object.
      if (raw === null && file.endsWith('.review.json')) return [];
      return [{ file, data: evidenceSchema.parse(raw) }];
    });
}
// Closed mapping is diagnostic only: unknown vendor prose is never a retry decision.
export const failureReason = (text: string): string =>
  reasonOf(text)?.code ??
  (text.includes('No base branch could be detected')
    ? 'base_branch_missing'
    : 'unregistered_reason');
const holdCodes: Partial<Record<string, string>> = {
  redline: 'coder_redline',
  needs: 'coder_needs',
};
const holdReason = (s: string): string =>
  holdCodes[s] ?? reasonOf(s)?.code ?? 'unregistered_reason';
const rowReasons = (rows: ReturnType<typeof evidenceRows>): string[] => [
  ...new Set(
    rows.flatMap(r =>
      typeof r.data.reason === 'string'
        ? [reasonOf(r.data.reason)?.code ?? 'unregistered_reason']
        : []
    )
  ),
];
function runUsage(
  l: Ledger,
  plan: Plan,
  events: Parameters<typeof etaInput>[2]
): { model: string | null; tokens: Episode['tokens']; calls: ReturnType<typeof callsOf> } {
  const usage = readUsage().sessions.filter(s => s.owner?.run_id === l.run_id),
    calls = callsOf(l.run_id, events as Parameters<typeof callsOf>[1], plan),
    roles = workflowRoles(l);
  return {
    calls,
    model:
      usage.find(s => s.owner?.role === 'general')?.model ??
      calls.find(x => x.role !== 'review')?.model.replace(/\(pinned\)$/, '') ??
      null,
    tokens: usage.length
      ? usage.flatMap(s =>
          (s.parts?.length ? s.parts : [s]).map(p => ({
            role: s.owner?.role ?? null,
            model: p.model,
            total: p.total,
          }))
        )
      : calls.map(x => ({
          role: roles?.get(x.node) === 'reviewer' || x.role === 'review' ? 'strategist' : 'general',
          model: x.model,
          total:
            typeof x.tokens?.input === 'number' && typeof x.tokens.output === 'number'
              ? x.tokens.input + x.tokens.output
              : null,
        })),
  };
}
export function foldEpisode(
  l: Ledger,
  plan: Plan,
  raw: RunView,
  events: Parameters<typeof etaInput>[2],
  asks: Asks,
  now: number,
  prior?: Prior
): Episode {
  const run = etaInput(l, raw, events).run,
    ownAsks = Object.fromEntries(
      Object.entries(asks).filter(([k]) => k.startsWith(`${l.run_id}:`))
    ),
    rows = evidenceRows(l, run),
    reasons = [
      ...new Set([
        ...rowReasons(rows),
        ...(l.reason ? [l.reason] : []),
        ...(l.dispositions ?? []).flatMap(d =>
          ['recover', 'adopt', 'owner_lost'].includes(d.reason) ? [] : [holdReason(d.reason)]
        ),
        ...[
          run.terminal_record?.error,
          run.metadata?.error,
          ...(run.nodes ?? []).map(n => n.error),
        ].flatMap(text => (text ? [failureReason(text)] : [])),
      ]),
    ];
  const cancelled = events.some(e =>
    ['operator', 'approval_rejected', 'conversation_reset', 'fan_out'].includes(
      String((e.data as { cancel_reason?: string }).cancel_reason)
    )
  );
  if (run.status === 'cancelled' && cancelled) reasons.push('cancelled_source');
  const c = classifyRun(l, run),
    signals = cockpitSignals(
      [
        {
          run_id: l.run_id,
          hold: c.state.startsWith('held:') ? c.state.slice(5) : undefined,
          since: run.metadata?.wait?.waitingSince ?? run.last_activity_at ?? l.started_at,
          disposed:
            l.dispositions?.some(
              d =>
                d.ok &&
                Date.parse(d.at) >=
                  Date.parse(
                    run.metadata?.wait?.waitingSince ?? run.last_activity_at ?? l.started_at
                  )
            ) ?? false,
        },
      ],
      ownAsks,
      now
    ),
    { model, tokens } = runUsage(l, plan, events);
  // HF5 keys identify an episode by hash; legacy attempt keys share the pre-HF5 episode.
  const groups = new Map<string, Set<string>>();
  for (const [key, a] of Object.entries(ownAsks))
    if (a && !a.legacy_key) {
      const parts = key.split(':'),
        group =
          parts.slice(0, 2).join(':') +
          (/^[a-f0-9]{16}$/.test(parts[2] ?? '') ? ':' + parts[2] : '');
      const ids = groups.get(group) ?? new Set<string>();
      ids.add(a.id ?? key);
      groups.set(group, ids);
    }
  signals.dup_ask = [...groups.values()].reduce((n, ids) => n + Math.max(0, ids.size - 1), 0);
  signals.engine_suspect = Number(
    c.state === 'held:engine_suspect' ||
      reasons.some(r => reasonOf(r)?.hold === 'engine_suspect') ||
      existsSync(join(home().sa, 'incidents', l.run_id))
  );
  const repeated = (l.auto_retries ?? []).some(
    (r, i, all) =>
      r.deterministic &&
      all.slice(0, i).some(old => old.reason === r.reason && old.engine_hash === r.engine_hash)
  );
  if (c.state === 'held:engine_suspect' || repeated) reasons.push('engine_suspect');
  const duration_ms = Math.max(
    0,
    Date.parse(run.completed_at ?? new Date(now).toISOString()) -
      Date.parse(run.started_at ?? l.started_at)
  );
  const acceptance = plan.packages.flatMap(p => {
    const check =
      rows.find(r => r.file === `settle-${p.id}.json`) ??
      rows.find(r => r.file === `verify-${p.id}.json`);
    return p.accept.map(a => ({
      cmd: redact(a.cmd).slice(0, 240),
      ok: check ? check.data.ok === true && !check.data.failed?.includes(a.cmd) : null,
    }));
  });
  const findings = rows.flatMap(r =>
    (r.data.findings ?? []).map(f => `| ${f.id} | ${f.severity} | ${f.status} |`)
  );
  let diff: Episode['diff'] = null;
  if (run.working_path && !privateProject(plan.repo)) {
    const d = Bun.spawnSync(
      ['git', '-C', run.working_path, 'diff', '--numstat', plan.base_ref, 'HEAD'],
      { stdout: 'pipe', stderr: 'ignore', timeout: 5000 }
    );
    if (d.exitCode === 0) {
      const stats = d.stdout
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(s => s.split('\t'));
      diff = {
        files: stats.length,
        added: stats.reduce((n, s) => n + (Number(s[0]) || 0), 0),
        removed: stats.reduce((n, s) => n + (Number(s[1]) || 0), 0),
      };
    }
  }
  const decision = diagnosis(
    {
      reasons,
      signals,
      status: run.status,
      acceptance,
      dispositions: l.dispositions,
      p50_ratio: prior?.duration.p50 ? duration_ms / prior.duration.p50 : null,
      coder_error:
        rows.some(r => !!r.data.error_class || r.data.self_report_conflict === true) ||
        files(artifactsOf(run))
          .filter(f => f.endsWith('.coder.json'))
          .some(
            f =>
              !!memoryJson<{ error_class?: string | null }>(join(artifactsOf(run), f), {}, l)
                .error_class
          ),
    },
    repeated
  );
  return {
    ...decision,
    signals,
    id: l.run_id,
    at: new Date(now).toISOString(),
    source: 'run',
    status: run.status,
    packages: plan.packages.map(p => ({
      id: p.id,
      tag: taskTag(p.scope.write),
      risk: p.risk,
      size: p.size,
    })),
    project: plan.repo,
    tag: taskTag(plan.packages.flatMap(p => p.scope.write)),
    risk: [...plan.packages].sort((a, b) => b.risk.localeCompare(a.risk))[0].risk,
    size: plan.packages.length === 1 ? plan.packages[0].size : 'L',
    model,
    fake: memoryJson<{ fake?: boolean }>(join(l.gen_dir, 'engine.json'), {}, l).fake === true,
    duration_ms,
    p50_ratio: prior?.duration.p50 ? duration_ms / prior.duration.p50 : null,
    reasons,
    fingerprint: l.engine_hash ?? null,
    incidents: existsSync(join(home().sa, 'incidents', l.run_id))
      ? [`incidents/${l.run_id}/sample.json`]
      : [],
    timeline: (run.nodes ?? []).map(n => ({
      node: n.nodeId,
      state: n.state,
      started_at: n.startedAt ?? null,
      duration_ms: n.durationMs ?? null,
    })),
    acceptance,
    findings,
    diff,
    tokens,
    asks: Object.entries(ownAsks).flatMap(([k, a]) =>
      a ? [{ hold: k.split(':')[1], status: a.status }] : []
    ),
    dispositions: [
      ...(l.dispositions ?? []),
      ...(l.recoveries ?? []).map(at => ({ at, reason: 'recover', action: 'recover', ok: true })),
      ...(l.adoptions ?? []).map(a => ({ at: a.at, reason: 'adopt', action: 'adopt', ok: true })),
    ].map(d => ({
      at: d.at,
      reason: reasonOf(d.reason)?.code ?? d.reason.slice(0, 80),
      action: d.action,
      ok: d.ok,
    })),
  };
}
export function triggered(
  e: Episode,
  heldSince: string | undefined,
  etaMs: number | undefined,
  now: number
): boolean {
  return (
    (e.category === 'engine' && e.signature !== 'evidence_missing') ||
    ['failed', 'cancelled', 'lost'].includes(e.status) ||
    (e.status === 'completed' &&
      (e.asks.length > 0 ||
        e.dispositions.some(d =>
          ['ask', 'approve', 'retry', 'recover', 'adopt'].includes(d.action)
        ))) ||
    (!!heldSince && now - Date.parse(heldSince) > 1800000) ||
    (e.p50_ratio ?? 0) > 2 ||
    (!!etaMs && e.duration_ms > etaMs * 1.5) ||
    e.findings.some(f => /\| (high|blocker) \|/.test(f)) ||
    !!(e.signals.engine_suspect + e.signals.dup_ask + e.signals.orphan_hold)
  );
}
const active = (l: Lesson): boolean => l.status === 'trial' || l.status === 'stable';
const rank = (l: Lesson): number => l.helpful - 2 * l.harmful + Math.min(l.votes ?? 0, 1);
export function selectCandidates(
  project: string,
  tag: string,
  role?: string,
  category?: Category
): Lesson[] {
  return memoryState()
    .lessons.filter(
      l =>
        active(l) &&
        (!category || l.category === category) &&
        (l.tier === 'project'
          ? l.scope === project && l.tag === tag
          : l.tier === 'type'
            ? l.scope === tag
            : !!role && l.scope === role)
    )
    .sort(
      (a, b) =>
        ['project', 'type', 'role'].indexOf(a.tier) - ['project', 'type', 'role'].indexOf(b.tier) ||
        rank(b) - rank(a) ||
        a.id.localeCompare(b.id)
    );
}
const LESSON_HEADER =
  '\n## 经验（自动，按命中排序）\n经验只供参考，与任务卡或验收冲突时以验收为准。\n';
export function lessonText(candidates: Lesson[], limit = 600): { text: string; ids: string[] } {
  let text = LESSON_HEADER,
    trial = 0;
  const ids: string[] = [];
  for (const l of candidates) {
    if (ids.length === 5) break;
    if (l.status === 'trial' && trial === 2) continue;
    const row = `- [${l.id}] ${l.when}：${l.do}；避免：${l.dont}\n`;
    if (Buffer.byteLength(text + row) > limit) continue;
    text += row;
    ids.push(l.id);
    if (l.status === 'trial') trial++;
  }
  return { text: ids.length ? text : '', ids };
}
export function selectLessons(
  project: string,
  query: string,
  _role?: string,
  _category?: Category
): LearningEntry[] {
  void _role;
  void _category;
  return recallLearning(project, query).entries;
}
export function injectMemory(
  plan: Plan,
  dir: string,
  _nodes: { id: string; command?: unknown; model?: unknown; with?: Record<string, unknown> }[]
): Record<string, string[]> {
  void _nodes;
  const path = join(dir, 'learning.json');
  if (existsSync(path))
    return (JSON.parse(readFileSync(path, 'utf8')) as { ids: Record<string, string[]> }).ids;
  const selections = selectLearning(
    plan.repo,
    Object.fromEntries(
      plan.packages.map(p => [
        p.id,
        [p.goal, ...(p.requirements ?? []).map(r => r.text)].join('\n'),
      ])
    )
  );
  const ids = Object.fromEntries(
    Object.entries(selections)
      .filter(([, s]) => s.entries.length)
      .map(([id, s]) => [id, s.entries.map(e => e.id)])
  );
  writeAtomic(path, JSON.stringify({ version: 1, data_only: true, selections, ids }) + '\n');
  return ids;
}
export function maintainLessons(
  run?: { id: string; reasons: string[]; failed: boolean; accepted?: boolean; ids: string[] },
  _now = Date.now()
): void {
  void _now;
  memoryWrite(s => {
    if (run && s.entries.some(e => e.scored === run.id)) return { lessons: [] };
    const lessons = s.lessons.map(l => {
      const used = run?.ids.includes(l.id),
        harmful = used && run?.failed && l.reasons.some(r => run.reasons.includes(r));
      const next = {
        ...l,
        helpful: l.helpful + (used && run?.accepted === true && !run.failed && !harmful ? 1 : 0),
        harmful: l.harmful + (harmful ? 1 : 0),
      };
      if (next.harmful >= 2 || next.mechanizable)
        mechanize('lesson_' + next.id, next.reasons, next.id);
      return next;
    });
    return {
      lessons: lessons.filter(
        l => JSON.stringify(l) !== JSON.stringify(s.lessons.find(old => old.id === l.id))
      ),
      ...(run ? { scored: run.id, hit_ids: [...new Set(run.ids)] } : {}),
    };
  });
}
export function lintPlan(
  plan: Plan,
  override?: string,
  now = Date.now()
): { warnings: string[]; rejected: boolean; override?: string } {
  const warnings: string[] = [];
  const rejected = false;
  if (!memoryOn()) return { warnings, rejected };
  const priors = memoryJson<Partial<Record<string, Prior>>>(join(root(), 'priors.json'), {}),
    model = runAliases(plan.console ?? 'claude')['@sa-coder'].model;
  let suggested = 0,
    duration = 0;
  for (const p of plan.packages) {
    const prior = priors[priorKey(plan.repo, p, model)];
    if (!prior || prior.n < 5) continue;
    duration = Math.max(duration, prior.duration.p50);
    if (prior.tokens.n >= 5) suggested += prior.tokens.p50;
  }
  if (suggested && !plan.budget.unlimited_tokens && plan.budget.weighted_tokens < suggested / 2) {
    warnings.push(`预算低于 p50 一半；建议 weighted_tokens >= ${String(Math.ceil(suggested))}`);
  }
  if (duration && plan.deadline !== undefined && Date.parse(plan.deadline) < now + duration) {
    warnings.push(`截止不现实；建议 deadline >= ${new Date(now + duration).toISOString()}`);
  }
  return {
    warnings,
    rejected,
    ...(override?.trim() ? { override: redact(override).slice(0, 240) } : {}),
  };
}
export const reflectionLimit = (): number =>
  z
    .number()
    .int()
    .nonnegative()
    .parse(
      memoryJson<{ daily_tokens?: number }>(join(root(), 'config.json'), {}).daily_tokens ?? 5000000
    );
export function reflectionQueue(all: Episode[], entries: Entry[], now: number): Episode[] {
  const done = new Set(entries.map(e => e.reflected ?? e.reflection?.episode));
  const key = (e: Episode): string => JSON.stringify([e.project, e.tag, e.category, e.signature]);
  const attempted = new Set(all.filter(e => done.has(e.id)).map(key));
  const seen = new Set<string>();
  return all.filter(e => {
    const identity = key(e);
    if (
      done.has(e.id) ||
      attempted.has(identity) ||
      seen.has(identity) ||
      ['engine', 'transient'].includes(e.category) ||
      privateProject(e.project) ||
      (e.fake && !process.env.SUPERAGENT_REFLECT_CMD) ||
      (['completed', 'done'].includes(e.status) && !triggered(e, undefined, undefined, now))
    )
      return false;
    seen.add(identity);
    return true;
  });
}
export function memoryData(now = Date.now()): {
  deliveries: Record<string, Delivery>;
  lessons: Lesson[];
  all: (Episode & { result: string })[];
  hits: Record<string, number>;
  scored: number;
  hitRuns: number;
  states: Record<Lesson['status'], number>;
  categories: Record<Category, number>;
  reflection: { day: string; tokens: number; limit: number; yellow: boolean };
  queued: number;
  recent: (Episode & { result: string })[];
} {
  const s = memoryState(),
    all = episodes(),
    day = new Date(now).toLocaleDateString('sv-SE'),
    tokens = s.entries.filter(e => e.day === day).reduce((n, e) => n + (e.tokens ?? 0), 0),
    done = new Map(
      s.entries
        .filter(e => Boolean(e.reflected) || Boolean(e.reflection))
        .map(e => [
          e.reflected ?? e.reflection?.episode ?? '',
          e.result ?? e.reflection?.state ?? '未提炼',
        ])
    );
  const queue = reflectionQueue(all, s.entries, now);
  const categories: Record<Category, number> = {
    engine: 0,
    plan: 0,
    project: 0,
    role: 0,
    transient: 0,
  };
  for (const e of all) categories[e.category]++;
  const history = all
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(e => ({
      ...e,
      result:
        done.get(e.id) ??
        (privateProject(e.project)
          ? '仅分诊：私有项目'
          : e.category === 'engine'
            ? '机制化需求'
            : e.category === 'transient'
              ? '仅计数'
              : '排队'),
    }));
  const seen = new Map<string, Lesson>(),
    hits: Record<string, number> = {};
  let scored = 0,
    hitRuns = 0;
  for (const entry of s.entries) {
    let hit = (entry.hit_ids?.length ?? 0) > 0;
    for (const l of entry.lessons) {
      const old = seen.get(l.id);
      if (l.last_hit !== l.created_at && l.last_hit !== old?.last_hit)
        hits[l.id] = (hits[l.id] ?? 0) + 1;
      if (entry.scored && old && l.helpful + l.harmful > old.helpful + old.harmful) hit = true;
      seen.set(l.id, l);
    }
    if (entry.scored) {
      scored++;
      if (hit) hitRuns++;
    }
  }
  const deliveries =
    memoryJson<FoldIndex | null>(join(root(), 'fold-index.json'), null)?.deliveries ?? {};
  return {
    deliveries,
    lessons: s.lessons,
    all: history,
    hits,
    scored,
    hitRuns,
    categories,
    states: Object.fromEntries(
      ['trial', 'stable', 'retired', 'mechanized'].map(status => [
        status,
        s.lessons.filter(l => l.status === status).length,
      ])
    ) as Record<Lesson['status'], number>,
    reflection: {
      day,
      tokens,
      limit: reflectionLimit(),
      yellow:
        tokens >= reflectionLimit() || (queue.length > 0 && tokens + 9216 > reflectionLimit()),
    },
    queued: queue.length,
    recent: history.slice(0, 10),
  };
}
interface LiveFold {
  stamp: string;
  episode: Episode;
  hold?: string;
  since: string;
  prior_ms: number;
}
export interface Delivery {
  status: string;
  packages: number;
  tokens: number | null;
}
interface FoldIndex {
  version?: number;
  deliveries?: Record<string, Delivery>;
  live?: Partial<Record<string, LiveFold>>;
  day: string;
  terminal: Record<string, string>;
  samples: Record<string, { key: string; duration: number; tokens: number | null }[]>;
}
export function memoryTick(
  asks: Asks,
  now = Date.now(),
  kick = true,
  dryRun = false
): {
  categories: Record<Category, number>;
  episodes: Episode[];
  errors: { id: string; reason: string }[];
} {
  const result = {
    categories: { engine: 0, plan: 0, project: 0, role: 0, transient: 0 },
    episodes: [] as Episode[],
    errors: [] as { id: string; reason: string }[],
  };
  if (!memoryOn() && !dryRun) return result;
  const day = new Date(now).toLocaleDateString('sv-SE'),
    indexFile = join(root(), 'fold-index.json');
  const index = dryRun
    ? ({ day: '', terminal: {}, samples: {} } as FoldIndex)
    : memoryJson<FoldIndex>(indexFile, { day: '', terminal: {}, samples: {} });
  // Rebuild old total-token priors and backfill all terminal runs once.
  if (index.version !== 2) {
    index.terminal = {};
    index.samples = {};
    index.day = '';
    index.version = 2;
  }
  const deliveries = (index.deliveries ??= {});
  const live = (index.live ??= {});
  const reused: { l: Ledger; cache: LiveFold }[] = [];
  let changed = index.day !== day;
  const error = (id: string, e: unknown): void => {
    const reason =
      e instanceof SyntaxError
        ? 'invalid_json'
        : e instanceof Error && e.message.includes('路径越界')
          ? 'path_outside'
          : ((e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined) ?? 'fold_failed');
    result.errors.push({ id, reason });
    if (!dryRun) {
      mkdirSync(root(), { recursive: true });
      appendFileSync(join(root(), 'errors.jsonl'), JSON.stringify({ id, reason }) + '\n');
    }
  };
  const emit = (e: Episode): void => {
    result.episodes.push(e);
    result.categories[e.category]++;
    if (!dryRun) saveEpisode(e);
  };
  try {
    const observed: {
      l: Ledger;
      plan: Plan;
      raw: RunView;
      events: Parameters<typeof etaInput>[2];
      stats: ReturnType<typeof runUsage>;
      stamp: string;
      revision: string | null;
    }[] = [];
    for (const id of ledgerIds())
      try {
        const l = loadLedger(id),
          st = statSync(join(home().sa, 'runs', `${id}.json`)),
          stamp = `${l.archon_run_id}:${String(st.mtimeMs)}:${String(st.size)}`;
        if (index.terminal[id] === stamp) continue;
        const native = dryRun ? null : runRevision(l.archon_run_id),
          revision = native
            ? stamp +
              ':' +
              native +
              ':' +
              new Bun.CryptoHasher('sha256')
                .update(
                  JSON.stringify(Object.entries(asks).filter(([k]) => k.startsWith(id + ':')))
                )
                .digest('hex')
            : null;
        const cached = live[id];
        if (revision && cached?.stamp === revision) {
          reused.push({ l, cache: cached });
          continue;
        }
        const snapshot = memoryJson<unknown>(join(l.gen_dir, 'plan.json'), null, l);
        if (
          !z
            .object({
              repo: z.string(),
              packages: z
                .array(
                  z.object({
                    id: z.string(),
                    risk: z.string(),
                    size: z.string(),
                    scope: z.object({ write: z.array(z.string()) }),
                  })
                )
                .min(1),
            })
            .safeParse(snapshot).success
        )
          continue;
        const plan = snapshot as Plan,
          raw = archonJson(
            ['workflow', 'get', l.archon_run_id, '--verbose', '--events'],
            l.repo
          ) as unknown as RunView & { events: Parameters<typeof etaInput>[2] };
        if (!Array.isArray(raw.events)) throw new Error('events missing');
        const events = raw.events,
          run = etaInput(l, raw, events).run,
          stats = runUsage(l, plan, events);
        observed.push({ l, plan, raw: run, events, stats, stamp, revision });
        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          deliveries[id] = {
            status: run.status,
            packages: plan.packages.length,
            tokens:
              stats.tokens.length && stats.tokens.every(t => t.total !== null)
                ? stats.tokens.reduce((n, t) => n + (t.total ?? 0), 0)
                : null,
          };
          const previous = JSON.stringify(index.samples[id]);
          const settledCalls = callsOf(
            l.run_id,
            events.filter(e => e.event_type !== 'node_started') as Parameters<typeof callsOf>[1],
            plan
          );
          index.samples[id] = plan.packages.flatMap(p => {
            const calls = stats.calls.filter(
                c => c.node === `code-${p.id}` || c.node === `repair-${p.id}`
              ),
              budgetEvents =
                plan.packages.length === 1
                  ? events
                  : events.filter(
                      e => e.step_name === `code-${p.id}` || e.step_name === `repair-${p.id}`
                    ),
              weighted = budgetUsage(
                budgetEvents as Parameters<typeof budgetUsage>[0],
                loadTiers().policy.budget_floor.S
              );
            const duration =
              plan.packages.length === 1
                ? Date.parse(run.completed_at ?? '') - Date.parse(run.started_at ?? l.started_at)
                : calls.every(c => c.exec_ms !== null)
                  ? calls.reduce((n, c) => n + (c.exec_ms ?? 0), 0)
                  : 0;
            return calls.length > 0 &&
              settledCalls.filter(c => c.node === `code-${p.id}` || c.node === `repair-${p.id}`)
                .length === calls.length &&
              ['completed', 'failed'].includes(run.status) &&
              Number.isFinite(duration) &&
              duration > 0
              ? [
                  {
                    key: priorKey(plan.repo, p, stats.model),
                    duration,
                    tokens: budgetEvents.some(
                      e =>
                        ['node_completed', 'node_failed'].includes(e.event_type) &&
                        /^(code|repair|fix|review)-/.test(e.step_name ?? '') &&
                        (e.data as Parameters<typeof budgetUsage>[0][number]['data'])?.spend?.tokens
                          ?.source === 'provider'
                    )
                      ? weighted.weighted_tokens
                      : null,
                  },
                ]
              : [];
          });
          changed ||= previous !== JSON.stringify(index.samples[id]);
        }
      } catch (e) {
        error(id, e);
      }
    const priorOf = (ss: { duration: number; tokens: number | null }[]): Prior => {
      const totals = ss.flatMap(v => (v.tokens === null ? [] : [v.tokens]));
      return {
        n: ss.length,
        duration: quantiles(ss.map(v => v.duration)),
        tokens: { n: totals.length, ...quantiles(totals) },
      };
    };
    const samples = Object.values(index.samples).flat(),
      priors = changed
        ? Object.fromEntries(
            [...new Set(samples.map(s => s.key))].map(key => [
              key,
              priorOf(samples.filter(s => s.key === key)),
            ])
          )
        : {};
    const eta = memoryJson<{ runs?: Record<string, { weight: number }> }>(
      join(home().sa, 'usage', 'eta.json'),
      {}
    ).runs;
    for (const { l, cache } of reused)
      try {
        const e = {
            ...cache.episode,
            at: new Date(now).toISOString(),
            duration_ms: Math.max(
              0,
              cache.episode.duration_ms + now - Date.parse(cache.episode.at)
            ),
          },
          etaMs = (eta?.[l.run_id]?.weight ?? 0) * 1000;
        e.p50_ratio = cache.prior_ms ? e.duration_ms / cache.prior_ms : null;
        e.signals = {
          ...e.signals,
          orphan_hold: cockpitSignals(
            [
              {
                run_id: l.run_id,
                hold: cache.hold,
                since: cache.since,
                disposed:
                  l.dispositions?.some(d => d.ok && Date.parse(d.at) >= Date.parse(cache.since)) ??
                  false,
              },
            ],
            asks,
            now
          ).orphan_hold,
        };
        Object.assign(
          e,
          diagnosis(
            { ...e, overrun: etaMs > 0 && e.duration_ms > etaMs * 1.5 },
            cache.episode.signature === 'evidence_conflict'
          )
        );
        if (triggered(e, cache.hold ? cache.since : undefined, etaMs, now)) emit(e);
      } catch (e) {
        error(l.run_id, e);
      }
    for (const { l, plan, raw, events, stats, stamp, revision } of observed)
      try {
        const prior = priorOf(
            Object.entries(index.samples)
              .filter(([id]) => id !== l.run_id)
              .flatMap(([, ss]) => ss)
              .filter(s => s.key === priorKey(plan.repo, plan.packages[0], stats.model))
          ),
          e = foldEpisode(l, plan, raw, events, asks, now, prior),
          etaMs = (eta?.[l.run_id]?.weight ?? 0) * 1000;
        const heldSince =
          raw.status === 'paused'
            ? (raw.metadata?.wait?.waitingSince ?? raw.last_activity_at ?? l.started_at)
            : undefined;
        if (
          triggered(e, heldSince, etaMs, now) ||
          existsSync(join(root(), 'episodes', `${e.id}.json`))
        ) {
          if (
            e.category === 'engine' &&
            e.signature === 'evidence_missing' &&
            etaMs > 0 &&
            e.duration_ms > etaMs * 1.5
          )
            Object.assign(e, diagnosis({ ...e, overrun: true }));
          emit(e);
        }
        if (['completed', 'failed', 'cancelled'].includes(raw.status)) {
          if (!dryRun)
            maintainLessons(
              {
                id: l.run_id,
                reasons: e.reasons,
                failed: raw.status === 'failed',
                accepted:
                  raw.status === 'completed' &&
                  e.acceptance.length > 0 &&
                  e.acceptance.every(a => a.ok === true),
                ids: Object.values(
                  memoryJson<{ lessons?: Record<string, string[]> }>(
                    join(l.gen_dir, 'engine.json'),
                    {},
                    l
                  ).lessons ?? {}
                ).flat(),
              },
              now
            );
          index.terminal[l.run_id] = stamp;
          live[l.run_id] = undefined;
        } else if (revision) {
          const c = classifyRun(l, raw);
          live[l.run_id] = {
            stamp: revision,
            episode: e,
            hold: c.state.startsWith('held:') ? c.state.slice(5) : undefined,
            since: raw.metadata?.wait?.waitingSince ?? raw.last_activity_at ?? l.started_at,
            prior_ms: prior.duration.p50,
          };
        }
      } catch (e) {
        error(l.run_id, e);
      }
    const { jobs, bad } = readJobs(now, true);
    for (const id of bad) error(id.split(':')[0], new SyntaxError());
    for (const j of jobs)
      try {
        const id = `job-${j.id}`,
          stamp = JSON.stringify([j.state, j.ended_at, j.exit_code, j.role, j.card]);
        if (
          j.state === 'running' ||
          j.title.startsWith('memory-reflect:') ||
          index.terminal[id] === stamp
        )
          continue;
        const duration_ms = Date.parse(j.ended_at ?? '') - Date.parse(j.started_at),
          history = jobs
            .filter(h => h.id !== j.id && h.role === j.role && h.ended_at)
            .map(h => Date.parse(h.ended_at ?? '') - Date.parse(h.started_at)),
          p50 = quantiles(history).p50;
        if (['failed', 'lost'].includes(j.state) || (p50 > 0 && duration_ms > p50 * 2)) {
          const signals = {
              engine_suspect: Number(j.state === 'lost'),
              dup_ask: 0,
              orphan_hold: 0,
              stale_answer: 0,
            },
            reasons =
              j.state === 'failed' && j.role === 'strategist'
                ? ['review_failed']
                : j.state === 'failed' && j.role === 'general'
                  ? ['coder_partial']
                  : [],
            decision =
              j.state === 'failed' && j.role
                ? { category: 'role' as const, signature: `${j.role}_job_failed` }
                : diagnosis({
                    reasons,
                    signals,
                    status: j.state,
                    overrun: p50 > 0 && duration_ms > p50 * 2,
                  });
          emit({
            ...decision,
            id,
            at: new Date(now).toISOString(),
            source: 'job',
            status: j.state,
            packages: [],
            project: j.cwd,
            tag: `${j.role ?? 'unassigned'}:${j.card ? basename(j.card, '.md') : 'job'}`,
            risk: 'G0',
            size: 'S',
            model: j.model,
            fake: j.kind === 'other',
            duration_ms: Number.isFinite(duration_ms) ? duration_ms : 0,
            p50_ratio: p50 ? duration_ms / p50 : null,
            reasons,
            fingerprint: null,
            incidents: [],
            timeline: [],
            acceptance: [],
            findings: [],
            diff: null,
            tokens: readUsage()
              .sessions.filter(s => s.owner?.job_id === j.id)
              .map(s => ({ role: j.role ?? null, model: s.model, total: s.total })),
            asks: [],
            dispositions: [],
            signals,
          });
        }
        index.terminal[id] = stamp;
      } catch (e) {
        error(`job-${j.id}`, e);
      }
    if (!dryRun) {
      mkdirSync(root(), { recursive: true });
      if (changed) {
        writeAtomic(join(root(), 'priors.json'), JSON.stringify(priors));
        maintainLessons(undefined, now);
      }
      index.day = day;
      writeAtomic(indexFile, JSON.stringify(index));
      if (
        kick &&
        memoryData(now).queued &&
        (process.env.NODE_ENV !== 'test' || process.env.SUPERAGENT_REFLECT_CMD)
      ) {
        const child = spawn(process.execPath, [join(WETAMP, 'src/memory-reflect.ts')], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
      }
    }
  } catch (e) {
    error('tick', e);
  }
  return result;
}
