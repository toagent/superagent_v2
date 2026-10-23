import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonJson } from './archon';
import { reasonOf } from './reasons';
import { redact } from './redact';
import { home, loadTiers, runAliases, WETAMP, writeAtomic } from './config';
import {
  z,
  episodes,
  lessonSchema,
  memoryData,
  memoryLog,
  maintainLessons,
  memoryOn,
  memoryState,
  memoryWrite,
  selectCandidates,
  reflectionQueue,
  type Episode,
  type Lesson,
} from './memory';

const operationSchema = () =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('ADD'), lesson: lessonSchema }).strict(),
    z.object({ op: z.literal('EDIT'), id: z.string().max(240), lesson: lessonSchema }).strict(),
    z.object({ op: z.literal('UPVOTE'), id: z.string().max(240) }).strict(),
  ]);
const reflectionResultSchema = () =>
  z
    .object({
      operations: z.array(z.unknown()).max(3),
      reason: z.string().max(240).nullable().optional(),
    })
    .strict();
export function reflectionInput(e: Episode): string {
  const evidence = {
    reasons: e.reasons.flatMap(r => {
      const reason = reasonOf(r);
      return reason ? [`${r}: ${reason.description}`] : [];
    }),
    failed_acceptance: e.acceptance
      .filter(a => a.ok === false)
      .map(a => redact(a.cmd).slice(0, 240)),
    findings: e.findings.map(f => redact(f).slice(0, 240)),
  };
  while (Buffer.byteLength(JSON.stringify(evidence)) > 2048) {
    const rows = [evidence.findings, evidence.failed_acceptance, evidence.reasons].sort(
      (a, b) => b.length - a.length
    );
    if (!rows[0].length) break;
    rows[0].pop();
  }
  const episode = {
      id: e.id,
      project: e.project,
      tag: e.tag,
      risk: e.risk,
      size: e.size,
      status: e.status,
      category: e.category,
      reasons: e.reasons.filter(r => !!reasonOf(r)),
      duration_ms: e.duration_ms,
      p50_ratio: e.p50_ratio,
      signals: {
        engine_suspect: e.signals.engine_suspect,
        dup_ask: e.signals.dup_ask,
        orphan_hold: e.signals.orphan_hold,
        stale_answer: e.signals.stale_answer,
      },
      acceptance: {
        total: e.acceptance.length,
        passed: e.acceptance.filter(a => a.ok === true).length,
      },
      findings: { total: e.findings.length },
      evidence,
      tokens: e.tokens.map(t => ({
        role: ['general', 'strategist', 'commander'].includes(t.role ?? '') ? t.role : null,
        total: t.total,
      })),
    },
    lessons = selectCandidates(
      e.project,
      e.tag,
      e.tokens.find(t => t.role)?.role ?? (e.category === 'role' ? 'general' : undefined)
    )
      .slice(0, 30)
      .map(l => ({ id: l.id, when: l.when, do: l.do, dont: l.dont }));
  const template = readFileSync(join(WETAMP, 'templates', 'memory-reflect.md'), 'utf8');
  const input = (): string => template + '\n' + JSON.stringify({ episode, lessons });
  while (Buffer.byteLength(input()) > 8000) {
    if (lessons.length) lessons.pop();
    else if (episode.tokens.length) episode.tokens.pop();
    else throw new Error('reflection metadata exceeds input budget');
  }
  return input();
}
export function curate(
  e: Episode,
  output: unknown,
  now: number
): { lessons: Lesson[]; result: string } {
  const decoded = reflectionResultSchema().safeParse(output);
  if (!decoded.success) {
    memoryLog('丢弃反思：输出 schema 不合格');
    return fallback(e, now, '输出 schema 不合格');
  }
  const all = new Map(memoryState().lessons.map(l => [l.id, l])),
    changed = new Map<string, Lesson>(),
    rejected: string[] = [];
  for (const raw of decoded.data.operations) {
    const parsed = operationSchema().safeParse(raw);
    if (!parsed.success) {
      rejected.push('字段或操作不合格');
      continue;
    }
    const op = parsed.data;
    if (op.op === 'UPVOTE') {
      const old = all.get(op.id);
      if (
        !old ||
        !['trial', 'stable'].includes(old.status) ||
        !(
          (old.scope === e.project && old.tag === e.tag) ||
          (old.tier === 'type' && old.scope === e.tag) ||
          (old.tier === 'role' && ['general', 'strategist', 'commander'].includes(old.scope))
        )
      ) {
        rejected.push('UPVOTE 不在适用 scope');
        continue;
      }
      const next = { ...old, votes: (old.votes ?? 0) + 1 };
      all.set(next.id, next);
      changed.set(next.id, next);
      continue;
    }
    const candidate = op.lesson,
      scopeOK =
        candidate.tier === 'project'
          ? candidate.scope === e.project
          : candidate.tier === 'type'
            ? candidate.scope === e.tag
            : ['general', 'strategist', 'commander'].includes(candidate.scope);
    if (!scopeOK || candidate.evidence.some(v => v !== e.id && !e.incidents.includes(v))) {
      rejected.push('scope 或 evidence 不属于本 episode');
      continue;
    }
    const old =
      op.op === 'EDIT'
        ? all.get(op.id)
        : [...all.values()].find(
            l =>
              l.tier === candidate.tier &&
              l.scope === candidate.scope &&
              l.tag === e.tag &&
              l.when === candidate.when &&
              l.do === candidate.do &&
              l.dont === candidate.dont
          );
    if (
      op.op === 'EDIT' &&
      (!old ||
        !['trial', 'stable'].includes(old.status) ||
        old.scope !== candidate.scope ||
        old.tier !== candidate.tier)
    ) {
      rejected.push('EDIT 目标不合格');
      continue;
    }
    const at = new Date(now).toISOString(),
      next: Lesson = {
        ...old,
        ...candidate,
        id: old?.id ?? `l-${crypto.randomUUID()}`,
        tag: e.tag,
        category: e.category,
        reasons: [...new Set([...(old?.reasons ?? []), ...e.reasons])],
        status: old?.status ?? 'trial',
        helpful: old?.helpful ?? 0,
        harmful: old?.harmful ?? 0,
        created_at: old?.created_at ?? at,
        last_hit: old?.last_hit ?? at,
      };
    all.set(next.id, next);
    changed.set(next.id, next);
  }
  for (const why of rejected) memoryLog(`丢弃经验：${why}`);
  return changed.size
    ? { lessons: [...changed.values()], result: `提炼 ${String(changed.size)} 条` }
    : fallback(e, now, decoded.data.reason ?? rejected.at(0) ?? '无可复用经验');
}
const fallback = (e: Episode, now: number, why: string): { lessons: Lesson[]; result: string } => {
  const reason = e.reasons.find(r => reasonOf(r)) ?? e.signature,
    finding = e.findings.at(0) ?? e.acceptance.find(a => a.ok === false)?.cmd,
    at = new Date(now).toISOString(),
    lesson: Lesson = {
      id: `l-reflect-${e.id}`,
      tier: 'project',
      scope: e.project,
      tag: e.tag,
      category: e.category,
      reasons: e.reasons,
      when: `${e.tag}: ${reason}`.slice(0, 240),
      do: redact(`遇到该原因先检查${finding ? `：${finding}` : `结构化原因 ${reason}`}`).slice(
        0,
        240
      ),
      dont: '不要在缺少证据时重复同一修复',
      why: redact(why).slice(0, 240),
      evidence: [e.id],
      mechanizable: false,
      status: 'trial',
      helpful: 0,
      harmful: 0,
      created_at: at,
      last_hit: at,
    };
  return { lessons: [lesson], result: '提炼 1 条（确定性保底）' };
};
type Query = (args: string[], cwd?: string) => Record<string, unknown>;
interface ReflectionRun {
  id: string;
  status: string;
  workflow_name: string;
  user_message: string;
}
interface Event {
  event_type?: string;
  step_name?: string | null;
  data?: Record<string, unknown>;
}
const prefix = (id: string): string => `memory-reflect:${id}\n`;
const usageOf = (events: Event[]): number | null => {
  const values = events.flatMap(event => {
    const tokens = event.data?.tokens;
    if (!tokens || typeof tokens !== 'object') return [];
    const { input, output } = tokens as { input?: unknown; output?: unknown };
    return typeof input === 'number' && typeof output === 'number' ? [input + output] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
const configPath = (dir: string): string => {
  const path = join(dir, 'run-config.yaml');
  writeAtomic(path, JSON.stringify({ aliases: runAliases('codex', loadTiers()) }));
  return path;
};
const reflectWorkspace = (): string => {
  const dir = join(home().sa, 'memory', 'reflect-workspace');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir });
  if (!existsSync(join(dir, '.git'))) {
    git('init', '-q');
    git('config', 'user.name', 'superagent');
    git('config', 'user.email', 'superagent@localhost');
  }
  const head = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
    cwd: dir,
    stderr: 'ignore',
  });
  if (head.exitCode !== 0) git('commit', '--allow-empty', '-qm', 'Initialize reflection workspace');
  return dir;
};

/** Reconcile one durable Archon run. Queries precede launch, so crash replay is idempotent. */
function reflectAttempt(e: Episode, now: number, query: Query): boolean {
  const dir = reflectWorkspace();
  const listed = query(
    ['workflow', 'runs', '--all', '--limit', String(2 ** 31 - 1), '--verbose'],
    dir
  );
  const runs = Array.isArray(listed.runs) ? (listed.runs as ReflectionRun[]) : [];
  const run = runs.find(
    candidate =>
      candidate.workflow_name === 'memory-reflect' &&
      candidate.user_message.startsWith(prefix(e.id))
  );
  if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
    let decoded = { lessons: [] as Lesson[], result: '' },
      usage: number | null = null;
    if (run.status === 'completed') {
      const detail = query(['workflow', 'get', run.id, '--verbose', '--events'], dir);
      const events = Array.isArray(detail.events) ? (detail.events as Event[]) : [];
      const complete = events.find(
        event => event.event_type === 'node_completed' && event.step_name === 'reflect'
      );
      if (!complete) throw new Error(`memory-reflect ${run.id}: missing reflect output`);
      decoded = curate(e, complete.data?.structured_output, now);
      usage = usageOf(events);
    } else decoded = fallback(e, now, `Archon ${run.status}`);
    memoryWrite(() => ({
      ...decoded,
      reflected: e.id,
      reflection: {
        episode: e.id,
        state:
          run.status === 'completed'
            ? decoded.lessons.length
              ? 'produced'
              : 'rejected'
            : 'degraded',
        usage,
        at: new Date(now).toISOString(),
      },
      day: memoryData(now).reflection.day,
      tokens: usage ?? 9216,
    }));
    maintainLessons(undefined, now);
    return true;
  }
  if (run) return false;
  const budget = memoryData(now).reflection;
  if (budget.tokens + 9216 > budget.limit) return false;
  query(
    [
      'workflow',
      'run',
      'memory-reflect',
      prefix(e.id) + reflectionInput(e),
      '--workflow-source',
      join(WETAMP, 'templates'),
      '--folder',
      '--no-worktree',
      '--detach',
      '--config',
      configPath(dir),
    ],
    dir
  );
  return true;
}

export function reflectOne(now = Date.now(), query: Query = archonJson): boolean {
  if (!memoryOn()) return false;
  const e = reflectionQueue(episodes(), memoryState().entries, now).at(0);
  if (!e) return false;
  try {
    return reflectAttempt(e, now, query);
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : String(error));
    appendFileSync(
      join(home().sa, 'memory', 'errors.jsonl'),
      JSON.stringify({ id: e.id, reason }) + '\n'
    );
    memoryWrite(() => ({ lessons: [], reflected: e.id }));
    return true;
  }
}

export function reconcileReflection(
  now = Date.now(),
  run: (at: number) => boolean = reflectOne
): boolean {
  try {
    return run(now);
  } catch {
    memoryLog('reflection reconcile skipped; next tick retries');
    return false;
  }
}
