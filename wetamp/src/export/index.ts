import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Database } from 'bun:sqlite';
import { gitHead, home } from '../config';
import { archonRunIds } from '../archon';
import { loadLedger, type Ledger } from '../ledger';
import { readJobs, type Job } from '../jobs';
import { Intake, type Task } from '../intake';
import type { Plan } from '../plan';

type SourceKind = 'run' | 'package' | 'job' | 'intake';
export const EXPORT_USAGE =
  'usage: superagent export --source-instance <v> --since <v> --until <v> --timezone <v> (--repo <v>...|--all-repos) --json';
type State = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'unknown';
interface ErrorItem { code: string; source_kind: SourceKind | null; repo_id: string | null; source_id: string | null; message: string; retryable: boolean }
interface Attempt { attempt_id: string; raw_status: string | null; started_at: string | null; ended_at: string | null }
type RecordItem = Record<string, unknown> & { source_kind: SourceKind; source_id: string; repo_id: string | null; selection_reasons: string[] };
interface RunRow { id: string; status: string; started_at: string | null; completed_at: string | null; last_activity_at: string | null; output_root?: string | null; metadata?: string | Record<string, unknown> | null }
interface Check { gate: 'coder' | 'acceptance' | 'review'; check_id: string; name: string; command: string | null; exit_code: number | null; passed: boolean | null; status: 'passed' | 'failed' | 'unknown' | 'not_run' | 'degraded'; evidence_ids: string[] }

const LIMIT_RECORDS = 10_000;
const LIMIT_BYTES = 64 * 1024 * 1024;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const utc = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const inWindow = (value: string | null, since: number, until: number): boolean => {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) && time >= since && time < until;
};
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
});
const revision = (record: RecordItem): string => {
  const semantic: Record<string, unknown> = { ...record };
  delete semantic.revision; delete semantic.observed_at; delete semantic.selection_reasons; delete semantic.window_events;
  return `sha256:${sha(stable(semantic))}`;
};
const stateOf = (raw: string | null): [State, boolean | null] => {
  if (raw === 'queued' || raw === 'pending') return ['pending', false];
  if (raw === 'running') return ['running', false];
  if (raw === 'paused' || raw?.startsWith('held:')) return ['blocked', false];
  if (raw === 'completed' || raw === 'done') return ['completed', true];
  if (raw === 'failed') return ['failed', true];
  if (raw === 'cancelled') return ['cancelled', true];
  return ['unknown', null];
};
const reasons = (created: string | null, updated: string | null, started: string | null, ended: string | null, since: number, until: number): string[] => {
  const out: string[] = [];
  if (inWindow(created, since, until)) out.push('created');
  if (updated !== created && inWindow(updated, since, until)) out.push('changed');
  const start = Date.parse(started ?? ''), end = Date.parse(ended ?? '');
  if (Number.isFinite(start) && start < until && (!Number.isFinite(end) || end >= since)) out.push('active_overlap');
  if (![created, updated, started, ended].some(Boolean)) out.push('time_unknown');
  return out;
};
const omissions = (fields: string[], reason: 'not_recorded' | 'not_supported' = 'not_supported') => fields.sort().map(field => ({ field, reason }));
const events = (id: string, values: [string, string | null][], since: number, until: number) => values.flatMap(([type, occurred_at], index) => inWindow(occurred_at, since, until) ? [{ event_id: `${id}:${type}:${String(index)}`, type, occurred_at, summary: null, evidence_ids: ['source'] }] : []);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const ref = (repo_id: string, source_kind: SourceKind, source_id: string) => ({ repo_id, source_kind, source_id });

function repo(path: string): { repo_id: string; label: string; root: string } {
  const query = (arg: string): string => {
    const result = Bun.spawnSync(['git', '-C', path, 'rev-parse', '--path-format=absolute', arg], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('not a readable git repository');
    return result.stdout.toString().trim();
  };
  const root = realpathSync(query('--show-toplevel'));
  const common = query('--git-common-dir');
  const canonical = existsSync(common) ? realpathSync(common) : resolve(common);
  return { repo_id: `repo-${sha(canonical)}`, label: basename(root), root };
}

function baseRecord(kind: SourceKind, id: string, repoId: string | null, observed: string, raw: string | null, created: string | null, started: string | null, updated: string | null, ended: string | null, selection: string[], extra: Record<string, unknown>): RecordItem {
  const [state, terminal] = stateOf(raw);
  const record: RecordItem = {
    source_kind: kind, source_id: id, repo_id: repoId, parent: null, related: [], request_ref: null,
    source_revision: null, revision: '', observed_at: observed, title: null, goal: null,
    state, raw_status: raw, projected_status: null, terminal, process_exit_code: null,
    created_at: created, started_at: started, updated_at: updated, ended_at: ended,
    selection_reasons: selection, window_events: [], attempts: [], result: null, checks: [], insights: [], usage: null,
    evidence: [{ id: 'source', kind: 'source_record', locator: `${kind}/${id}`, uri: null, availability: 'available', occurred_at: null }],
    omissions: omissions(['checks', 'insights', 'result', 'usage']), ...extra,
  };
  record.revision = revision(record);
  return record;
}

function readRuns(ids: string[]): { rows: Map<string, RunRow>; error?: string } {
  const path = join(home().archon, 'archon.db');
  if (!existsSync(path)) return { rows: new Map(), error: 'archon.db 不存在，无法读取执行状态。' };
  try {
    const db = new Database(path, { readonly: true });
    try {
      if (!ids.length) return { rows: new Map() };
      const unique = [...new Set(ids)];
      const rows = db.query<RunRow, string[]>(`SELECT * FROM remote_agent_workflow_runs WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique);
      return { rows: new Map(rows.map(row => [row.id, row])) };
    } finally { db.close(); }
  } catch { return { rows: new Map(), error: 'archon.db 不可读，无法读取执行状态。' }; }
}

function readIntakes(): { tasks: Task[]; bad: number } {
  const root = join(home().sa, 'intake');
  if (!existsSync(root)) return { tasks: [], bad: 0 };
  const tasks: Task[] = []; let bad = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'state.json'))) continue;
    try { tasks.push(...new Intake(join(root, entry.name)).list()); } catch { bad++; }
  }
  return { tasks, bad };
}

function safeJson(root: string, name: string): Record<string, unknown> | undefined {
  if (basename(name) !== name || !existsSync(root)) return;
  try {
    const base = realpathSync(root), path = realpathSync(join(base, name));
    if (!path.startsWith(base + sep)) return;
    return object(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return; }
}

function packageFacts(ledger: Ledger, row: RunRow | undefined, pkg: Plan['packages'][number]) {
  const definitions: Check[] = pkg.accept.map((check, index) => ({ gate: 'acceptance', check_id: `acceptance-${String(index)}`, name: check.cmd, command: check.cmd, exit_code: null, passed: null, status: 'not_run', evidence_ids: [] }));
  const evidence: Record<string, unknown>[] = [], checks = [...definitions], insights: Record<string, unknown>[] = [];
  const root = row?.output_root ? join(row.output_root, 'artifacts', 'runs', row.id) : '';
  const allowed = root && [ledger.repo, home().sa].some(value => { try { const base = realpathSync(value), path = realpathSync(root); return path === base || path.startsWith(base + sep); } catch { return false; } });
  if (!allowed) return { checks, evidence, insights };
  const add = (gate: Check['gate'], values: unknown[], prefix: string): void => { values.forEach((raw, index) => {
    const value = object(raw), definition = object(value.check);
    const command = typeof value.cmd === 'string' ? value.cmd : typeof definition.cmd === 'string' ? definition.cmd : null;
    const exit = typeof value.exit === 'number' && Number.isInteger(value.exit) ? value.exit : null;
    const id = `${prefix}-${String(index)}`, pass = exit === null ? null : exit === 0;
    const item: Check = { gate, check_id: id, name: command ?? id, command, exit_code: exit, passed: pass, status: pass === null ? 'unknown' : pass ? 'passed' : 'failed', evidence_ids: [id] };
    const existing = gate === 'acceptance' && command ? checks.findIndex(check => check.gate === gate && check.command === command) : -1;
    if (existing >= 0) checks.splice(existing, 1, item); else checks.push(item);
    evidence.push({ id, kind: 'check', locator: `run/${ledger.run_id}/package/${pkg.id}/${gate}/${id}`, uri: null, availability: 'available', occurred_at: null });
  }); };
  const coder = safeJson(root, `verify-${pkg.id}.coder.json`); add('coder', Array.isArray(coder?.quick_checks) ? coder.quick_checks : [], 'coder');
  const accepted = safeJson(root, `settle-${pkg.id}.json`) ?? safeJson(root, `verify-${pkg.id}.json`); add('acceptance', Array.isArray(accepted?.command_results) ? accepted.command_results : [], 'acceptance');
  const gate = readdirSync(root).filter(name => new RegExp(`^gate-${(pkg.milestone ?? 'm1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r\\d+\\.json$`).test(name)).sort().at(-1);
  const review = gate ? safeJson(root, gate) : undefined;
  if (review && (review.reviewed === true || review.grade === 'DEGRADED_PASS')) {
    const degraded = review.grade === 'DEGRADED_PASS';
    checks.push({ gate: 'review', check_id: 'review', name: 'review', command: null, exit_code: null, passed: null, status: degraded ? 'degraded' : 'unknown', evidence_ids: ['review'] });
    evidence.push({ id: 'review', kind: 'check', locator: `run/${ledger.run_id}/package/${pkg.id}/review/review`, uri: null, availability: 'available', occurred_at: null });
  }
  for (const value of Array.isArray(accepted?.insights) ? accepted.insights : []) {
    const item = object(value); if (['lesson', 'caution', 'knowledge', 'decision'].includes(String(item.kind)) && typeof item.content === 'string') insights.push({ kind: item.kind, content: item.content.slice(0, 2048), origin: ['human', 'agent', 'system'].includes(String(item.origin)) ? item.origin : 'unknown', assertion: 'reported', evidence_ids: ['source'] });
  }
  return { checks, evidence, insights };
}

function usageOf(row: RunRow | undefined) {
  let metadata: Record<string, unknown> = {};
  try { metadata = typeof row?.metadata === 'string' ? object(JSON.parse(row.metadata)) : object(row?.metadata); } catch { /* Invalid metadata is unavailable. */ }
  const input = finite(metadata.total_tokens_in), output = finite(metadata.total_tokens_out), cached = finite(metadata.total_cache_read_tokens), cost = finite(metadata.total_cost_usd);
  const duration = row?.started_at && row.completed_at ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at)) : null;
  if ([input, output, cached, cost, duration].every(value => value === null)) return null;
  const amount = cost === null ? null : cost.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return { scope: 'inclusive', duration_ms: Number.isFinite(duration) ? duration : null, input_tokens: input, output_tokens: output, cached_input_tokens: cached, cost: amount === null ? null : { amount, currency: 'USD' } };
}

function readPlan(ledger: Ledger): Plan {
  return JSON.parse(readFileSync(join(ledger.gen_dir, 'plan.json'), 'utf8')) as Plan;
}

function parseExport(argv: string[], now: Date) {
  const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true, options: {
    'source-instance': { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, timezone: { type: 'string' },
    repo: { type: 'string', multiple: true }, 'all-repos': { type: 'boolean' }, json: { type: 'boolean' },
  }});
  if (parsed.positionals.length) throw new Error('INVALID_ARGUMENT positionals');
  const required = (name: 'source-instance' | 'since' | 'until' | 'timezone'): string => {
    const value = parsed.values[name]; if (!value?.trim()) throw new Error(`INVALID_ARGUMENT --${name}`); return value;
  };
  const source = required('source-instance'), sinceValue = required('since'), untilValue = required('until'), timezone = required('timezone');
  if (!parsed.values.json) throw new Error('INVALID_ARGUMENT --json');
  const repos = parsed.values.repo ?? [], all = parsed.values['all-repos'] === true;
  if (all === (repos.length > 0)) throw new Error('INVALID_ARGUMENT --repo/--all-repos');
  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/;
  if (!timestamp.test(sinceValue) || !timestamp.test(untilValue)) throw new Error('INVALID_ARGUMENT --since/--until');
  const since = Date.parse(sinceValue), until = Date.parse(untilValue);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || until > now.getTime()) throw new Error('INVALID_ARGUMENT --since/--until');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(now); } catch { throw new Error('INVALID_ARGUMENT --timezone'); }
  return { source, since, until, timezone, repos, all };
}

export function buildExport(argv: string[], now = new Date()): { exit: number; output?: Record<string, unknown>; error?: string } {
  const readStarted = now.toISOString();
  let input: ReturnType<typeof parseExport>;
  try { input = parseExport(argv, now); } catch (error) { return { exit: 2, error: (error as Error).message }; }
  const errors: ErrorItem[] = [], ledgers: Ledger[] = [];
  let ledgerFiles: string[] = [];
  try { ledgerFiles = readdirSync(join(home().sa, 'runs')).filter(file => file.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'run', repo_id: null, source_id: null, message: 'run ledger 来源不可读。', retryable: true }); }
  for (const file of ledgerFiles) try { ledgers.push(loadLedger(file.slice(0, -5))); } catch { errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'run', repo_id: null, source_id: file.slice(0, -5), message: 'run ledger 记录不可读。', retryable: true }); }
  let jobs: Job[] = [], badJobs: string[] = [];
  try { ({ jobs, bad: badJobs } = readJobs()); } catch { errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'job', repo_id: null, source_id: null, message: 'job 来源不可读。', retryable: true }); }
  for (const item of badJobs) errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'job', repo_id: null, source_id: item.split(':', 1)[0] || null, message: 'job 记录不可读。', retryable: true });
  let intake: ReturnType<typeof readIntakes> = { tasks: [], bad: 0 };
  try { intake = readIntakes(); } catch { intake.bad++; }
  if (intake.bad) errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'intake', repo_id: null, source_id: null, message: 'intake 来源部分不可读。', retryable: true });
  const knownPaths = [...new Set([...ledgers.map(item => item.repo), ...jobs.map(item => item.worktree?.repo ?? item.cwd), ...intake.tasks.map(item => item.repo)])];
  const repoById = new Map<string, ReturnType<typeof repo>>();
  for (const path of input.all ? knownPaths : input.repos) try { const item = repo(path); repoById.set(item.repo_id, item); } catch { if (!input.all) return { exit: 2, error: 'INVALID_ARGUMENT --repo' }; }
  const selected = new Set(repoById.keys()), includesUnassigned = input.all, pathIds = new Map<string, string | null>();
  const identify = (path: string): string | null => {
    if (pathIds.has(path)) return pathIds.get(path) ?? null;
    let id: string | null = null;
    try { const item = repo(path); id = selected.has(item.repo_id) ? item.repo_id : null; } catch { /* An unassigned job has no repository. */ }
    pathIds.set(path, id); return id;
  };
  const runIds = ledgers.flatMap(archonRunIds), execution = readRuns(runIds);
  if (execution.error) errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'run', repo_id: null, source_id: null, message: execution.error, retryable: true });
  const observed = new Date(Math.max(now.getTime(), Date.now())).toISOString(), records: RecordItem[] = [];
  for (const ledger of ledgers) {
    const repoId = identify(ledger.repo); if (!repoId) continue;
    let plan: Plan; try { plan = readPlan(ledger); } catch { errors.push({ code: 'SOURCE_UNREADABLE', source_kind: 'run', repo_id: repoId, source_id: ledger.run_id, message: '冻结 plan 不可读。', retryable: true }); continue; }
    const attempts: Attempt[] = archonRunIds(ledger).map(id => execution.rows.get(id)).filter((row): row is RunRow => !!row).map(row => ({ attempt_id: row.id, raw_status: row.status, started_at: utc(row.started_at), ended_at: utc(row.completed_at) }));
    const missingAttempts = archonRunIds(ledger).filter(id => !execution.rows.has(id));
    if (!execution.error && missingAttempts.length) errors.push({ code: 'RELATION_UNRESOLVED', source_kind: 'run', repo_id: repoId, source_id: ledger.run_id, message: 'run 的执行 attempt 关联缺失。', retryable: true });
    const current = attempts.at(-1), created = utc(ledger.started_at), started = attempts[0]?.started_at ?? null, ended = current?.ended_at ?? null;
    const updated = utc(execution.rows.get(current?.attempt_id ?? '')?.last_activity_at) ?? ended ?? started ?? created;
    const selection = reasons(created, updated, null, null, input.since, input.until);
    if (attempts.some(attempt => reasons(null, null, attempt.started_at, attempt.ended_at, input.since, input.until).includes('active_overlap'))) selection.push('active_overlap');
    if (!selection.length && ![created, updated, ...attempts.flatMap(attempt => [attempt.started_at, attempt.ended_at])].some(Boolean)) selection.push('time_unknown');
    if (!selection.length) continue;
    const raw = current?.raw_status ?? null;
    const run = baseRecord('run', ledger.run_id, repoId, observed, raw, created, started, updated, ended, selection, {
      request_ref: plan.request_ref ?? null, attempts, window_events: events(ledger.run_id, [['created', created], ['updated', updated], ...attempts.flatMap(attempt => [['attempt_started', attempt.started_at], ['attempt_ended', attempt.ended_at]] as [string, string | null][])], input.since, input.until),
      usage: usageOf(execution.rows.get(current?.attempt_id ?? '')), omissions: omissions(['checks', 'goal', 'insights', 'result', 'title', ...(usageOf(execution.rows.get(current?.attempt_id ?? '')) ? [] : ['usage'])], 'not_recorded'),
    });
    run.revision = revision(run); records.push(run);
    for (const pkg of plan.packages) {
      const id = JSON.stringify([ledger.run_id, pkg.id]), pkgRaw = raw === 'pending' ? 'pending' : null;
      const facts = packageFacts(ledger, execution.rows.get(current?.attempt_id ?? ''), pkg);
      const item = baseRecord('package', id, repoId, observed, pkgRaw, created, null, null, null, ['parent_selected'], {
        parent: ref(repoId, 'run', ledger.run_id), title: pkg.title, goal: pkg.goal, checks: facts.checks, insights: facts.insights,
        evidence: [{ id: 'source', kind: 'source_record', locator: `package/${id}`, uri: null, availability: 'available', occurred_at: null }, ...facts.evidence],
        omissions: omissions(['result', 'usage', ...(facts.insights.length ? [] : ['insights'])], 'not_recorded'),
      });
      item.revision = revision(item); records.push(item);
    }
  }
  for (const job of jobs) {
    const repoId = identify(job.worktree?.repo ?? job.cwd); if (!repoId && !includesUnassigned) continue;
    const created = utc(job.receipt?.enqueued_at ?? job.started_at), started = utc(job.receipt?.spawned_at ?? job.started_at), ended = utc(job.receipt?.settled_at ?? job.ended_at), updated = ended ?? started;
    const selection = reasons(created, updated, started, ended, input.since, input.until); if (!selection.length) continue;
    const item = baseRecord('job', job.id, repoId, observed, job.state, created, started, updated, ended, selection, {
      request_ref: job.request_ref ?? null, title: job.title, process_exit_code: job.exit_code ?? null,
      window_events: events(job.id, [['created', created], ['started', started], ['ended', ended]], input.since, input.until),
      omissions: omissions(['checks', 'goal', 'insights', 'result', 'usage']),
    });
    item.revision = revision(item); records.push(item);
  }
  for (const task of intake.tasks) {
    const repoId = identify(task.repo); if (!repoId) continue;
    const cancelled = task.cancellations.some(item => item.revision === task.revision);
    const parent = task.parent ? ref(repoId, 'intake', task.parent) : null;
    const related = [
      ...(parent ? [{ relation: 'derived_from', target: parent }] : []),
      ...task.dependencies.map(id => ({ relation: 'depends_on', target: ref(repoId, 'intake', id) })),
      ...task.runs.flatMap(binding => binding.run_id ? [
        { relation: 'executes', target: ref(repoId, 'run', binding.run_id) },
        ...(binding.requirement_map ?? []).map(item => ({ relation: 'executes', target: ref(repoId, 'package', JSON.stringify([binding.run_id, item.package])) })),
      ] : []),
    ];
    const item = baseRecord('intake', task.id, repoId, observed, cancelled ? 'cancelled' : null, null, null, null, null, ['time_unknown'], {
      parent, related, source_revision: task.revision, omissions: omissions(['checks', 'goal', 'insights', 'result', 'title', 'usage']),
    });
    item.revision = revision(item); records.push(item);
  }
  records.sort((a, b) => `${a.repo_id ?? ''}\0${a.source_kind}\0${a.source_id}`.localeCompare(`${b.repo_id ?? ''}\0${b.source_kind}\0${b.source_id}`));
  for (const kind of ['run', 'job', 'intake'] as const) errors.push({ code: 'HISTORY_UNKNOWN', source_kind: kind, repo_id: null, source_id: null, message: `${kind} 历史没有可证明的完整保留起点。`, retryable: false });
  const history = { status: 'unknown', guaranteed_since: null, gaps: [] };
  const runEmitted = records.filter(record => record.source_kind === 'run' || record.source_kind === 'package').length;
  const output: Record<string, unknown> = {
    schema_version: 1, source_instance: input.source, source_version: gitHead(),
    scope: { scope_id: `scope-${sha(JSON.stringify([[...selected].sort(), includesUnassigned]))}`, selection: input.all ? 'all' : 'repos', repos: [...repoById.values()].sort((a, b) => a.repo_id.localeCompare(b.repo_id)).map(({ repo_id, label }) => ({ repo_id, label })), includes_unassigned: includesUnassigned },
    since: new Date(input.since).toISOString(), until: new Date(input.until).toISOString(), timezone: input.timezone,
    read_started_at: readStarted, observed_at: observed, consistency: 'per_record', status: 'partial',
    coverage: {
      run: { status: errors.some(error => error.source_kind === 'run' && error.code === 'SOURCE_UNREADABLE') ? 'partial' : 'complete', scanned: ledgerFiles.length, emitted: runEmitted, history, limitations: ['历史保留起点未知。'] },
      job: { status: errors.some(error => error.source_kind === 'job' && error.code === 'SOURCE_UNREADABLE') ? 'partial' : 'complete', scanned: jobs.length + badJobs.length, emitted: records.filter(record => record.source_kind === 'job').length, history, limitations: ['历史保留起点未知。'] },
      intake: { status: intake.bad ? 'partial' : 'complete', scanned: intake.tasks.length + intake.bad, emitted: records.filter(record => record.source_kind === 'intake').length, history, limitations: ['历史保留起点未知；来源没有事实时间时按 time_unknown 输出。'] },
    }, records, errors,
  };
  const encoded = JSON.stringify(output);
  if (records.length > LIMIT_RECORDS || Buffer.byteLength(encoded) > LIMIT_BYTES) {
    output.status = 'failed'; output.records = []; output.errors = [{ code: 'EXPORT_TOO_LARGE', source_kind: null, repo_id: null, source_id: null, message: '导出超过 10,000 条或 64 MiB 上限。', retryable: false }];
    for (const item of Object.values(output.coverage as Record<string, { emitted: number }>)) item.emitted = 0;
    return { exit: 1, output };
  }
  return { exit: 3, output };
}

export function exportCli(argv: string[]): number {
  const result = buildExport(argv);
  if (result.error) console.error(result.error);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  return result.exit;
}
