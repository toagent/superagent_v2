// One detached worker, one evidence-only invocation. The OS lock survives overlapping ticks.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { lock } from './archon';
import { reasonOf } from './reasons';
import { readJobs } from './jobs';
import { home, loadTiers, WETAMP } from './config';
import {
  z,
  episodes,
  lessonSchema,
  memoryData,
  memoryJson,
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

const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD'), lesson: lessonSchema }).strict(),
  z.object({ op: z.literal('EDIT'), id: z.string().max(240), lesson: lessonSchema }).strict(),
  z.object({ op: z.literal('UPVOTE'), id: z.string().max(240) }).strict(),
]);
const resultSchema = z
  .object({ operations: z.array(z.unknown()).max(3), reason: z.string().max(240).optional() })
  .strict();
export function reflectionInput(e: Episode): string {
  // Only metadata crosses the model boundary, including for legacy episodes containing evidence.
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
  const decoded = resultSchema.safeParse(output);
  if (!decoded.success) {
    memoryLog('丢弃反思：输出 schema 不合格');
    return { lessons: [], result: '未提炼：输出 schema 不合格' };
  }
  const all = new Map(memoryState().lessons.map(l => [l.id, l])),
    changed = new Map<string, Lesson>(),
    rejected: string[] = [];
  for (const raw of decoded.data.operations) {
    const parsed = operation.safeParse(raw);
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
  return {
    lessons: [...changed.values()],
    result: changed.size
      ? `提炼 ${String(changed.size)} 条`
      : `未提炼：${decoded.data.reason ?? rejected.at(0) ?? '无可复用经验'}`,
  };
}
// Codex exec JSONL: turn.completed.usage.input_tokens already includes cached_input_tokens.
export function reflectionUsage(line: string): number | null {
  const s = z
    .object({
      type: z.literal('turn.completed'),
      usage: z.object({
        input_tokens: z.number().int().nonnegative(),
        cached_input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      }),
    })
    .safeParse(JSON.parse(line) as unknown);
  return s.success ? s.data.usage.input_tokens + s.data.usage.output_tokens : null;
}
export const reflectionCommand = (model: string, out: string, input: string): string[] => [
  'codex',
  'exec',
  '--json',
  '--skip-git-repo-check',
  '-m',
  model,
  '-o',
  out,
  input,
];
export const reflectionFailure = (code: number, signal: string | null, launched: boolean) =>
  signal
    ? ({ kind: 'signal', signal } as const)
    : ({ kind: launched ? 'exit_code' : 'launch_rejected', exit_code: code } as const);
export async function reflectOne(now = Date.now()): Promise<boolean> {
  if (!memoryOn()) return false;
  const root = join(home().sa, 'memory');
  mkdirSync(root, { recursive: true });
  const held = lock(join(root, 'reflect.lock'));
  if (!held.ok) return false;
  let out: string | undefined;
  let attempt: string | undefined;
  try {
    const state = memoryState(),
      e = reflectionQueue(episodes(), state.entries, now).at(0);
    const budget = memoryData(now).reflection;
    if (!e || budget.tokens + 9216 > budget.limit) return false;
    const input = reflectionInput(e),
      dir = join(root, 'reflect-workspace');
    mkdirSync(dir, { recursive: true });
    out = join(dir, `${e.id}.json`);
    const model = loadTiers().tiers.general.pools.chatgpt[0];
    if (!model) throw new Error('general model pool empty');
    const override = process.env.SUPERAGENT_REFLECT_CMD;
    const cmd = override
      ? [
          ...z
            .array(z.string())
            .min(1)
            .parse(JSON.parse(override) as unknown),
          out,
          input,
        ]
      : reflectionCommand(model, out, input);
    const day = budget.day;
    attempt = e.id;
    memoryWrite(() => ({
      lessons: [],
      reflection: { episode: e.id, state: 'queued', usage: null },
      result: '入队（预留预算，不自动重跑）',
      day,
      tokens: 9216,
    }));
    const child = Bun.spawn(
      [
        join(WETAMP, 'bin', 'superagent'),
        'job',
        'exec',
        // Command fixtures use the ordinary job path; real model calls retain role routing.
        ...(override ? [] : ['--role', 'general']),
        '--title',
        `memory-reflect:${e.id}`,
        '--',
        ...cmd,
      ],
      {
        cwd: dir,
        // Jobs deliberately close stdin; pass the bounded metadata prompt explicitly.
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, SUPERAGENT_ROLE: 'general' },
      }
    );
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
      child.kill('SIGTERM');
    }, 120000);
    let usage = 0,
      known = false,
      buffer = '';
    try {
      for await (const chunk of child.stdout) {
        buffer += new TextDecoder().decode(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines)
          try {
            const n = reflectionUsage(line);
            if (n !== null) {
              usage += n;
              known = true;
            }
          } catch {
            /* Only usage is retained; vendor prose is discarded. */
          }
        if (buffer.length > 65536) buffer = '';
      }
      if (buffer)
        try {
          const n = reflectionUsage(buffer);
          if (n !== null) {
            usage += n;
            known = true;
          }
        } catch {
          /* Incomplete JSONL. */
        }
      const code = await child.exited;
      const job = readJobs().jobs.find(
        j => j.wrapper_pid === child.pid && j.title === `memory-reflect:${e.id}`
      );
      // Wrapper spawn is still queued; only the job's actual child receipt proves execution.
      if (job?.receipt?.spawned_at)
        memoryWrite(() => ({
          lessons: [],
          reflection: { episode: e.id, state: 'running', usage: null },
        }));
      const signal = job?.signal ?? child.signalCode,
        state =
          timeout.signal.aborted || signal || code === 143 || code === 130 || code === 129
            ? 'interrupted'
            : code !== 0
              ? 'failed'
              : undefined,
        decoded =
          code === 0 && memoryOn()
            ? curate(
                e,
                existsSync(out) && Buffer.byteLength(readFileSync(out)) <= 1024
                  ? memoryJson<unknown>(out, null)
                  : null,
                now
              )
            : { lessons: [], result: '未提炼：反思失败或开关已关闭' };
      memoryWrite(() => ({
        ...decoded,
        ...(code === 0 && !timeout.signal.aborted ? { reflected: e.id } : {}),
        reflection: {
          episode: e.id,
          state: state ?? (decoded.lessons.length ? 'produced' : 'rejected'),
          usage: known ? usage : null,
          ...(state
            ? {
                at: new Date().toISOString(),
                failure: reflectionFailure(code, signal, !!job?.receipt?.spawned_at),
              }
            : {}),
        },
        day,
        tokens: (known ? usage : 9216) - 9216,
      }));
      maintainLessons(undefined, now);
    } catch {
      memoryWrite(() => ({
        lessons: [],
        reflection: {
          episode: e.id,
          state: timeout.signal.aborted ? 'interrupted' : 'failed',
          usage: known ? usage : null,
          at: new Date().toISOString(),
          failure: { kind: 'output' },
        },
        result: '未提炼：反思输出失败',
        day,
        tokens: (known ? usage : 9216) - 9216,
      }));
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch (error) {
    if (!attempt) throw error;
    const episode = attempt;
    memoryWrite(() => ({
      lessons: [],
      reflection: {
        episode,
        state: 'failed',
        usage: null,
        at: new Date().toISOString(),
        failure: { kind: 'launch_rejected', exit_code: 1 },
      },
      result: '未提炼：反思启动失败',
    }));
    return true;
  } finally {
    if (out) rmSync(out, { force: true });
    held.release();
  }
}
if (import.meta.main)
  try {
    await reflectOne();
  } catch {
    memoryLog('反思工作进程失败');
    process.exitCode = 1;
  }
