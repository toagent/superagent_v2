// Episodes are evidence projections; lessons are append-only data, never engine inputs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { infer as Infer } from '../../packages/workflows/node_modules/zod';
import { archonJson, lock, type RunView } from './archon';
import { home, runAliases, WETAMP, writeAtomic } from './config';
import { artifactsOf, classifyRun, ledgerIds, loadLedger, type Ledger } from './cli';
import { cockpitSignals, type Asks } from './cockpit-signals';
import { etaInput } from './board/eta';
import { confined, nodeRole, workflowRoles } from './board/workflow';
import { callsOf } from './report';
import { readUsage } from './usage';
import { readJobs } from './jobs';
import { reasonOf } from './reasons';
import { redact } from './redact';
import type { Plan, Pkg } from './plan';
// Reuse the workflows package's existing schema dependency, as plan.ts does for Ajv.
export const z: typeof import('../../packages/workflows/node_modules/zod').z = (createRequire(join(WETAMP, '..', 'packages/workflows/package.json'))('zod') as typeof import('../../packages/workflows/node_modules/zod')).z;

export type Category = 'engine' | 'plan' | 'project' | 'role' | 'transient';
export interface Episode {
  id: string; at: string; source: 'run' | 'job'; status: string; project: string; tag: string; risk: string; size: string; model: string | null; fake: boolean;
  packages: { id: string; tag: string; risk: string; size: string }[]; duration_ms: number; p50_ratio: number | null; reasons: string[]; category: Category; fingerprint: string | null; incidents: string[];
  timeline: { node: string; state: string; started_at: string | null; duration_ms: number | null }[];
  acceptance: { cmd: string; ok: boolean | null }[]; findings: string[]; diff: { files: number; added: number; removed: number } | null;
  tokens: { role: string | null; model: string | null; total: number | null }[]; asks: { hold: string; status: string }[];
  dispositions: { at: string; reason: string; action: string; ok: boolean }[]; signals: ReturnType<typeof cockpitSignals>;
}
const field = z.string().max(240);
export const lessonSchema = z.object({ tier: z.enum(['project', 'type', 'role']), scope: field.min(1), when: field.min(1), do: field.min(1), dont: field, why: field, evidence: z.array(field).min(1).max(5), mechanizable: z.boolean() }).strict();
export type Lesson = Infer<typeof lessonSchema> & { id: string; tag: string; category: Category; reasons: string[]; status: 'trial' | 'stable' | 'retired' | 'mechanized'; helpful: number; harmful: number; votes?: number; created_at: string; last_hit: string };
interface Entry { lessons: Lesson[]; scored?: string; reflected?: string; result?: string; day?: string; tokens?: number }
export interface Prior { n: number; duration: { p50: number; p90: number }; tokens: { n: number; p50: number; p90: number } }
const root = (): string => join(home().sa, 'memory');
export const memoryOn = (): boolean => process.env.SUPERAGENT_MEMORY !== 'off';
export const privateProject = (p: string): boolean => p.includes('_private') || p.includes('Mobile Documents');
export const memoryLog = (why: string): void => { console.error(`memory: ${why}`); };
export function memoryJson<T>(path: string, fallback: T): T { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback; }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
export const episodes = (): Episode[] => files(join(root(), 'episodes')).map(f => memoryJson<Episode>(join(root(), 'episodes', f), {} as Episode));
export function memoryState(): { lessons: Lesson[]; entries: Entry[] } {
  const file = join(root(), 'lessons.jsonl'), entries = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as Entry) : [];
  return { entries, lessons: [...new Map(entries.flatMap(e => e.lessons).map(l => [l.id, l])).values()] };
}
export function memoryWrite(fn: (state: ReturnType<typeof memoryState>) => Entry): void {
  mkdirSync(root(), { recursive: true }); const held = lock(join(root(), 'store.lock'));
  if (!held.ok) throw new Error('store busy');
  try { const entry = fn(memoryState()); if (entry.lessons.length || entry.scored || entry.reflected || entry.day) appendFileSync(join(root(), 'lessons.jsonl'), JSON.stringify(entry) + '\n'); } finally { held.release(); }
}
export const taskTag = (paths: string[]): string => {
  const rules: [RegExp, string][] = [[/\.(java|xml)$/, 'java-mybatis'], [/\.vue$/, 'vue2'], [/\.(ts|tsx|js|mjs|cjs)$/, 'ts-cli'], [/\.(md|txt|rst)$/, 'docs'], [/\.py$/, 'python'], [/\.go$/, 'go']];
  return [...new Set(paths.flatMap(p => rules.filter(([re]) => re.test(p)).map(([, tag]) => tag)))].sort().slice(0, 2).join('+') || 'other';
};
export function triage(e: Pick<Episode, 'reasons' | 'signals'>, contradiction = false): Category {
  const reasons = e.reasons.map(reasonOf);
  if (contradiction || e.signals.engine_suspect || e.signals.dup_ask || e.signals.orphan_hold || reasons.some(r => !r || r.owner === 'engine' && r.determinism === 'deterministic')) return 'engine';
  if (reasons.some(r => r?.code === 'coder_output_invalid' || r?.code === 'review_failed')) return 'role';
  if (reasons.length && reasons.every(r => r?.determinism === 'transient')) return 'transient';
  if (reasons.some(r => r?.owner === 'human')) return 'plan';
  return 'project';
}
function mechanize(id: string, reasons: string[]): void {
  mkdirSync(join(root(), 'mechanize'), { recursive: true });
  const file = join(root(), 'mechanize', `${id}.json`);
  if (!existsSync(file)) writeAtomic(file, JSON.stringify({ id, reasons, invariant: 'I1/I6', requirement: '用对应 episode 的证据建立事故回放，将重复失败转为确定性机制。' }));
}
export function saveEpisode(e: Episode): boolean {
  if (basename(e.id) !== e.id || !e.id || e.id === '..') throw new Error('invalid episode id');
  const dir = join(root(), 'episodes'); mkdirSync(dir, { recursive: true }); const path = join(dir, `${e.id}.json`);
  if (existsSync(path)) return false;
  // Drop whole optional rows, never truncate JSON or omit the failure identity.
  while (Buffer.byteLength(JSON.stringify(e)) > 8192) {
    const rows = [e.timeline, e.findings, e.acceptance, e.dispositions, e.asks, e.tokens].sort((a, b) => b.length - a.length);
    if (!rows[0].length) throw new Error('episode metadata exceeds 8KB'); rows[0].pop();
  }
  writeAtomic(path, JSON.stringify(e)); if (e.category === 'engine') mechanize(e.id, e.reasons); return true;
}
const quantiles = (xs: number[]): { p50: number; p90: number } => { const s = [...xs].sort((a, b) => a - b); return { p50: s[Math.floor((s.length - 1) / 2)] ?? 0, p90: s[Math.ceil((s.length - 1) * .9)] ?? 0 }; };
export const priorKey = (project: string, p: Pick<Pkg, 'size' | 'risk' | 'scope'>, model: string | null): string => JSON.stringify([project, taskTag(p.scope.write), p.size, p.risk, model]);
function evidenceRows(l: Ledger, run: RunView): { file: string; data: Record<string, unknown> }[] {
  const art = artifactsOf(run); return files(art).filter(f => /^(verify-|settle-|gate-|environment\.json$)/.test(f) && !/\.(coder|ledger)\.json$/.test(f)).map(f => ({ file: f, data: memoryJson<Record<string, unknown>>(confined(l, join(art, f)) ?? '', {}) }));
}
const rowReasons = (rows: ReturnType<typeof evidenceRows>): string[] => [...new Set(rows.flatMap(r => typeof r.data.reason === 'string' ? [reasonOf(r.data.reason)?.code ?? 'unregistered_reason'] : []))];
function runUsage(l: Ledger, plan: Plan, events: Parameters<typeof etaInput>[2]): { model: string | null; tokens: Episode['tokens']; calls: ReturnType<typeof callsOf> } {
  const usage = readUsage().sessions.filter(s => s.owner?.run_id === l.run_id), calls = callsOf(l.run_id, events as Parameters<typeof callsOf>[1], plan), roles = workflowRoles(l);
  return { calls, model: usage.find(s => s.owner?.role === 'general')?.model ?? calls.find(x => x.role !== 'review')?.model.replace(/\(pinned\)$/, '') ?? null, tokens: usage.length ? usage.flatMap(s => (s.parts?.length ? s.parts : [s]).map(p => ({ role: s.owner?.role ?? null, model: p.model, total: p.total }))) : calls.map(x => ({ role: roles?.get(x.node) === 'reviewer' || x.role === 'review' ? 'strategist' : 'general', model: x.model, total: x.tokens ? Object.values(x.tokens).reduce((a, b) => a + b, 0) : null })) };
}
export function foldEpisode(l: Ledger, plan: Plan, raw: RunView, events: Parameters<typeof etaInput>[2], asks: Asks, now: number, prior?: Prior): Episode {
  const run = etaInput(l, raw, events).run, ownAsks = Object.fromEntries(Object.entries(asks).filter(([k]) => k.startsWith(`${l.run_id}:`))), rows = evidenceRows(l, run), reasons = rowReasons(rows);
  const c = classifyRun(l, run), signals = cockpitSignals([{ run_id: l.run_id, hold: c.state.startsWith('held:') ? c.state.slice(5) : undefined, since: run.metadata?.wait?.waitingSince ?? run.last_activity_at ?? l.started_at, disposed: !!l.dispositions?.length }], ownAsks, now), { model, tokens } = runUsage(l, plan, events);
  const repeated = (l.auto_retries ?? []).some((r, i, all) => r.deterministic && all.slice(0, i).some(old => old.reason === r.reason && old.engine_hash === r.engine_hash));
  if (c.state === 'held:engine_suspect' || repeated) reasons.push('engine_suspect');
  const duration_ms = Math.max(0, Date.parse(run.completed_at ?? new Date(now).toISOString()) - Date.parse(run.started_at ?? l.started_at));
  const acceptance = plan.packages.flatMap(p => { const check = rows.find(r => r.file === `settle-${p.id}.json`) ?? rows.find(r => r.file === `verify-${p.id}.json`); return p.accept.map(a => ({ cmd: redact(a.cmd).slice(0, 240), ok: check ? check.data.ok === true && !(check.data.failed as string[] | undefined)?.includes(a.cmd) : null })); });
  const findings = rows.flatMap(r => Array.isArray(r.data.findings) ? (r.data.findings as { id: string; severity: string; file: string; line: number; status: string; evidence: string }[]).map(f => redact(`| ${f.id} | ${f.severity} | ${f.file}:${String(f.line)} | ${f.status} | ${f.evidence} |`).slice(0, 800)) : []);
  let diff: Episode['diff'] = null;
  if (run.working_path && !privateProject(plan.repo)) { const d = Bun.spawnSync(['git', '-C', run.working_path, 'diff', '--numstat', plan.base_ref, 'HEAD'], { stdout: 'pipe', stderr: 'ignore', timeout: 5000 }); if (d.exitCode === 0) { const stats = d.stdout.toString().trim().split('\n').filter(Boolean).map(s => s.split('\t')); diff = { files: stats.length, added: stats.reduce((n, s) => n + (Number(s[0]) || 0), 0), removed: stats.reduce((n, s) => n + (Number(s[1]) || 0), 0) }; } }
  return { signals, id: l.run_id, at: new Date(now).toISOString(), source: 'run', status: run.status, packages: plan.packages.map(p => ({ id: p.id, tag: taskTag(p.scope.write), risk: p.risk, size: p.size })), project: plan.repo, tag: taskTag(plan.packages.flatMap(p => p.scope.write)), risk: [...plan.packages].sort((a, b) => b.risk.localeCompare(a.risk))[0].risk, size: plan.packages.length === 1 ? plan.packages[0].size : 'L', model, fake: memoryJson<{ fake?: boolean }>(join(l.gen_dir, 'engine.json'), {}).fake === true, duration_ms, p50_ratio: prior?.duration.p50 ? duration_ms / prior.duration.p50 : null, reasons, category: triage({ reasons, signals }, c.state === 'held:engine_suspect' || repeated), fingerprint: l.engine_hash ?? null, incidents: existsSync(join(home().sa, 'incidents', l.run_id)) ? [`incidents/${l.run_id}/sample.json`] : [], timeline: (run.nodes ?? []).map(n => ({ node: n.nodeId, state: n.state, started_at: n.startedAt ?? null, duration_ms: n.durationMs ?? null })), acceptance, findings, diff, tokens, asks: Object.entries(ownAsks).flatMap(([k, a]) => a ? [{ hold: k.split(':')[1], status: a.status }] : []), dispositions: [...(l.dispositions ?? []), ...l.recoveries.map(at => ({ at, reason: 'recover', action: 'recover', ok: true })), ...(l.adoptions ?? []).map(a => ({ at: a.at, reason: 'adopt', action: 'adopt', ok: true }))].map(d => ({ at: d.at, reason: reasonOf(d.reason)?.code ?? d.reason.slice(0, 80), action: d.action, ok: d.ok })) };
}
export function triggered(e: Episode, heldSince: string | undefined, etaMs: number | undefined, now: number): boolean {
  return ['failed', 'cancelled', 'lost'].includes(e.status) || e.status === 'completed' && (e.asks.length > 0 || e.dispositions.some(d => ['ask', 'approve', 'retry', 'recover', 'adopt'].includes(d.action))) || !!heldSince && now - Date.parse(heldSince) > 1800000 || (e.p50_ratio ?? 0) > 2 || !!etaMs && e.duration_ms > etaMs * 1.5 || e.findings.some(f => /\| (high|blocker) \|/.test(f)) || !!(e.signals.engine_suspect + e.signals.dup_ask + e.signals.orphan_hold);
}
const active = (l: Lesson): boolean => l.status === 'trial' || l.status === 'stable';
const rank = (l: Lesson): number => l.helpful - 2 * l.harmful + Math.min(l.votes ?? 0, 1);
export function selectLessons(project: string, tag: string, role?: string, category?: Category): Lesson[] {
  return memoryState().lessons.filter(l => active(l) && (!category || l.category === category) && (l.tier === 'project' ? l.scope === project && l.tag === tag : l.tier === 'type' ? l.scope === tag : !!role && l.scope === role)).sort((a, b) => ['project', 'type', 'role'].indexOf(a.tier) - ['project', 'type', 'role'].indexOf(b.tier) || rank(b) - rank(a) || a.id.localeCompare(b.id));
}
const LESSON_HEADER = '\n## 经验（自动，按命中排序）\n经验只供参考，与任务卡或验收冲突时以验收为准。\n';
export function lessonText(candidates: Lesson[], limit = 600): { text: string; ids: string[] } {
  let text = LESSON_HEADER, trial = 0; const ids: string[] = [];
  for (const l of candidates) { if (ids.length === 5) break; if (l.status === 'trial' && trial === 2) continue; const row = `- [${l.id}] ${l.when}：${l.do}；避免：${l.dont}\n`; if (Buffer.byteLength(text + row) > limit) continue; text += row; ids.push(l.id); if (l.status === 'trial') trial++; }
  return { text: ids.length ? text : '', ids };
}
export function injectMemory(plan: Plan, dir: string, nodes: { id: string; command?: unknown; model?: unknown; with?: Record<string, unknown> }[]): Record<string, string[]> {
  if (!memoryOn()) return {}; const hits: Record<string, string[]> = {};
  try {
    const byPkg = new Map<string, Lesson[]>(), originals = new Map<string, string>();
    for (const p of plan.packages) { const candidates = selectLessons(plan.repo, taskTag(p.scope.write)); byPkg.set(p.id, candidates); originals.set(p.id, readFileSync(join(dir, 'briefs', `${p.id}.md`), 'utf8')); appendFileSync(join(dir, 'briefs', `${p.id}.md`), lessonText(candidates).text); }
    for (const n of nodes) {
      const pkgIds = typeof n.with?.briefs === 'string' ? plan.packages.filter(p => n.with?.briefs === plan.packages.map(k => join(dir, 'briefs', `${k.id}.md`)).join(' ') || (n.with?.briefs as string).includes(join(dir, 'briefs', `${p.id}.md`))).map(p => p.id) : [typeof n.with?.brief === 'string' ? basename(n.with.brief, '.md') : plan.packages.find(p => n.id === `code-${p.id}` || n.id === `repair-${p.id}`)?.id ?? ''];
      const role = nodeRole(n) === 'reviewer' ? 'strategist' : 'general', candidates = [...new Map([...pkgIds.flatMap(id => byPkg.get(id) ?? []), ...(typeof n.command === 'string' ? selectLessons(plan.repo, '', role).filter(l => l.tier === 'role') : [])].map(l => [l.id, l])).values()];
      const found = lessonText(candidates, 600 - Buffer.byteLength(LESSON_HEADER)), chosen = candidates.filter(l => found.ids.includes(l.id)), project = lessonText(chosen.filter(l => l.tier !== 'role')), roles = lessonText(chosen.filter(l => l.tier === 'role')); hits[n.id] = found.ids;
      // Per-node copies prevent cumulative milestone briefs from multiplying the injection budget.
      if (n.with && pkgIds.some(id => originals.has(id)) && project.ids.length) { const copies = pkgIds.map((id, i) => { const path = join(dir, 'briefs', `${id}.${n.id}.md`); writeAtomic(path, (originals.get(id) ?? '') + (i === 0 ? project.text : '')); return path; }); if (typeof n.with.briefs === 'string') n.with.briefs = copies.join(' '); else n.with.brief = copies[0]; }
      else if (n.with && pkgIds.some(id => (byPkg.get(id)?.length ?? 0) > 0) && typeof n.command === 'string') { const copies = pkgIds.map(id => { const path = join(dir, 'briefs', `${id}.${n.id}.md`); writeAtomic(path, originals.get(id) ?? ''); return path; }); if (typeof n.with.briefs === 'string') n.with.briefs = copies.join(' '); else n.with.brief = copies[0]; }
      if (roles.ids.length && typeof n.command === 'string') { const name = `${n.command}-${n.id}`; writeAtomic(join(dir, '.archon', 'commands', `${name}.md`), readFileSync(join(dir, '.archon', 'commands', `${n.command}.md`), 'utf8') + roles.text); n.command = name; }
    }
    const ids = new Set(Object.values(hits).flat()); if (ids.size) memoryWrite(s => ({ lessons: s.lessons.filter(l => ids.has(l.id)).map(l => ({ ...l, last_hit: new Date().toISOString() })) }));
  } catch { memoryLog('检索失败，照常生成'); } return hits;
}
export function maintainLessons(run?: { id: string; reasons: string[]; failed: boolean; ids: string[] }, now = Date.now()): void {
  memoryWrite(s => {
    if (run && s.entries.some(e => e.scored === run.id)) return { lessons: [] };
    const lessons = s.lessons.map(l => { const used = run?.ids.includes(l.id), harmful = used && run?.failed && l.reasons.some(r => run.reasons.includes(r)); const next = { ...l, helpful: l.helpful + (used && !harmful ? 1 : 0), harmful: l.harmful + (harmful ? 1 : 0) }; if (active(next)) { if (next.harmful >= 2 || now - Date.parse(next.last_hit) >= 30 * 86400000) next.status = 'retired'; else if (next.helpful >= 2 && next.harmful === 0) next.status = 'stable'; } if (next.harmful >= 2 || next.mechanizable) mechanize(next.id, next.reasons); return next; });
    for (const scope of new Set(lessons.map(l => `${l.tier}:${l.scope}`))) lessons.filter(l => active(l) && `${l.tier}:${l.scope}` === scope).sort((a, b) => rank(b) - rank(a) || b.last_hit.localeCompare(a.last_hit)).slice(30).forEach(l => { l.status = 'retired'; });
    return { lessons: lessons.filter(l => JSON.stringify(l) !== JSON.stringify(s.lessons.find(old => old.id === l.id))), ...(run ? { scored: run.id } : {}) };
  });
}
export function lintPlan(plan: Plan, override?: string, now = Date.now()): { warnings: string[]; rejected: boolean; override?: string } {
  const warnings: string[] = []; let rejected = false; if (!memoryOn()) return { warnings, rejected };
  const priors = memoryJson<Partial<Record<string, Prior>>>(join(root(), 'priors.json'), {}), model = runAliases(plan.console ?? 'claude')['@sa-coder'].model; let suggested = 0, duration = 0;
  for (const p of plan.packages) { for (const l of selectLessons(plan.repo, taskTag(p.scope.write), 'commander', 'plan').slice(0, 5)) warnings.push(`${p.id}: ${l.when} → ${l.do}`); const prior = priors[priorKey(plan.repo, p, model)]; if (!prior || prior.n < 5) continue; duration = Math.max(duration, prior.duration.p50); if (prior.tokens.n >= 5) suggested += prior.tokens.p50; }
  if (suggested && plan.budget.weighted_tokens < suggested / 2) { rejected = true; warnings.push(`预算低于 p50 一半；建议 weighted_tokens >= ${String(Math.ceil(suggested))}`); }
  if (duration && Date.parse(plan.deadline) < now + duration) { rejected = true; warnings.push(`截止不现实；建议 deadline >= ${new Date(now + duration).toISOString()}`); }
  return { warnings, rejected: rejected && !override?.trim(), ...(override?.trim() ? { override: redact(override).slice(0, 240) } : {}) };
}
export const reflectionLimit = (): number => z.number().int().nonnegative().parse(memoryJson<{ daily_tokens?: number }>(join(root(), 'config.json'), {}).daily_tokens ?? 5000000);
export function memoryData(now = Date.now()): { states: Record<Lesson['status'], number>; categories: Record<Category, number>; reflection: { day: string; tokens: number; limit: number; yellow: boolean }; queued: number; recent: (Episode & { result: string })[] } {
  const s = memoryState(), all = episodes(), day = new Date(now).toLocaleDateString('sv-SE'), tokens = s.entries.filter(e => e.day === day).reduce((n, e) => n + (e.tokens ?? 0), 0), done = new Map(s.entries.filter(e => e.reflected).map(e => [e.reflected, e.result ?? '未提炼']));
  const queue = all.filter(e => !done.has(e.id) && !['engine', 'transient'].includes(e.category) && !privateProject(e.project) && (!e.fake || !!process.env.SUPERAGENT_REFLECT_CMD));
  const categories: Record<Category, number> = { engine: 0, plan: 0, project: 0, role: 0, transient: 0 }; for (const e of all) categories[e.category]++;
  return { categories, states: Object.fromEntries(['trial', 'stable', 'retired', 'mechanized'].map(status => [status, s.lessons.filter(l => l.status === status).length])) as Record<Lesson['status'], number>, reflection: { day, tokens, limit: reflectionLimit(), yellow: queue.length > 0 && tokens + 9216 > reflectionLimit() }, queued: queue.length, recent: all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10).map(e => ({ ...e, result: done.get(e.id) ?? (privateProject(e.project) ? '仅分诊：私有项目' : e.category === 'engine' ? '机制化需求' : e.category === 'transient' ? '仅计数' : '排队') })) };
}
export function memoryTick(asks: Asks, now = Date.now(), kick = true): void {
  if (!memoryOn()) return;
  try {
    const samples = new Map<string, { id: string; duration: number; tokens: number | null }[]>(), observed: { l: Ledger; plan: Plan; raw: RunView; events: Parameters<typeof etaInput>[2]; stats: ReturnType<typeof runUsage> }[] = [];
    for (const id of ledgerIds()) try {
      const l = loadLedger(id), snapshot = memoryJson<unknown>(join(l.gen_dir, 'plan.json'), null);
      // Old or partial snapshots cannot supply scoped priors; skip before making another native query.
      if (!z.object({ repo: z.string(), packages: z.array(z.object({ id: z.string(), risk: z.string(), size: z.string(), scope: z.object({ write: z.array(z.string()) }) })).min(1) }).safeParse(snapshot).success) continue;
      const plan = snapshot as Plan, raw = archonJson(['workflow', 'get', l.archon_run_id, '--verbose', '--events'], l.repo) as unknown as RunView & { events: Parameters<typeof etaInput>[2] }; if (!Array.isArray(raw.events)) continue; const events = raw.events; observed.push({ l, plan, raw: etaInput(l, raw, events).run, events, stats: runUsage(l, plan, events) });
    } catch { memoryLog('一条历史记录不可读，已跳过'); }
    for (const { l, plan, raw, stats } of observed) if (['completed', 'failed'].includes(raw.status)) for (const p of plan.packages) {
      const calls = stats.calls.filter(c => c.node === `code-${p.id}` || c.node === `repair-${p.id}`), totals = plan.packages.length === 1 ? stats.tokens.map(t => t.total) : calls.map(c => c.tokens ? Object.values(c.tokens).reduce((a, b) => a + b, 0) : null);
      const duration = plan.packages.length === 1 ? Date.parse(raw.completed_at ?? '') - Date.parse(raw.started_at ?? l.started_at) : calls.every(c => c.exec_ms !== null) ? calls.reduce((n, c) => n + (c.exec_ms ?? 0), 0) : 0;
      if (Number.isFinite(duration) && duration > 0) { const key = priorKey(plan.repo, p, stats.model), group = samples.get(key) ?? []; group.push({ id: l.run_id, duration, tokens: totals.length && totals.every(t => t !== null) ? totals.reduce<number>((n, t) => n + t, 0) : null }); samples.set(key, group); }
    }
    const priorOf = (s: { duration: number; tokens: number | null }[]): Prior => { const totals = s.flatMap(v => v.tokens === null ? [] : [v.tokens]); return { n: s.length, duration: quantiles(s.map(v => v.duration)), tokens: { n: totals.length, ...quantiles(totals) } }; };
    const priors = Object.fromEntries([...samples].map(([key, group]) => [key, priorOf(group)])); mkdirSync(root(), { recursive: true }); writeAtomic(join(root(), 'priors.json'), JSON.stringify(priors));
    for (const { l, plan, raw, events, stats } of observed) {
      const stored = memoryJson<Episode | null>(join(root(), 'episodes', `${l.run_id}.json`), null), prior = priorOf((samples.get(priorKey(plan.repo, plan.packages[0], stats.model)) ?? []).filter(s => s.id !== l.run_id));
      if (!stored) { const e = foldEpisode(l, plan, raw, events, asks, now, prior), eta = memoryJson<{ runs?: Record<string, { weight: number }> }>(join(home().sa, 'usage', 'eta.json'), {}).runs?.[l.run_id]?.weight; if (triggered(e, raw.status === 'paused' ? raw.metadata?.wait?.waitingSince ?? raw.last_activity_at ?? l.started_at : undefined, eta ? eta * 1000 : undefined, now)) saveEpisode(e); }
      if (['completed', 'failed', 'cancelled'].includes(raw.status) && !memoryState().entries.some(e => e.scored === l.run_id)) maintainLessons({ id: l.run_id, reasons: rowReasons(evidenceRows(l, raw)), failed: raw.status === 'failed', ids: Object.values(memoryJson<{ lessons?: Record<string, string[]> }>(join(l.gen_dir, 'engine.json'), {}).lessons ?? {}).flat() }, now);
    }
    const jobs = readJobs(now, true).jobs; for (const j of jobs) if (j.state !== 'running' && !j.title.startsWith('memory-reflect:')) { const duration_ms = Date.parse(j.ended_at ?? '') - Date.parse(j.started_at), history = jobs.filter(h => h.id !== j.id && h.role === j.role && h.ended_at).map(h => Date.parse(h.ended_at ?? '') - Date.parse(h.started_at)); const p50 = quantiles(history).p50; if (['failed', 'lost'].includes(j.state) || p50 > 0 && duration_ms > p50 * 2) saveEpisode({ id: `job-${j.id}`, at: new Date(now).toISOString(), source: 'job', status: j.state, packages: [], project: j.cwd, tag: 'other', risk: 'G0', size: 'S', model: j.model, fake: j.kind === 'other', duration_ms: Number.isFinite(duration_ms) ? duration_ms : 0, p50_ratio: p50 ? duration_ms / p50 : null, reasons: j.state === 'lost' ? ['engine_suspect'] : [], category: j.state === 'lost' ? 'engine' : 'role', fingerprint: null, incidents: [], timeline: [], acceptance: [], findings: [], diff: null, tokens: readUsage().sessions.filter(s => s.owner?.job_id === j.id).map(s => ({ role: j.role ?? null, model: s.model, total: s.total })), asks: [], dispositions: [], signals: { engine_suspect: 0, dup_ask: 0, orphan_hold: 0, stale_answer: 0 } }); }
    maintainLessons(undefined, now);
    if (kick && memoryOn() && memoryData(now).queued && (process.env.NODE_ENV !== 'test' || process.env.SUPERAGENT_REFLECT_CMD)) { const child = spawn(process.execPath, [join(WETAMP, 'src/memory-reflect.ts')], { detached: true, stdio: 'ignore', env: process.env }); child.unref(); }
  } catch { memoryLog('巡检折叠失败，主巡检继续'); }
}
