import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNodeSummaries } from '../../packages/cli/src/commands/workflow';
import { archonRunIds, reportRuns } from './archon';
import { engineDateTime, engineDay, home, WETAMP, writeAtomic } from './config';
import { confined } from './board/workflow';
import type { Ledger } from './ledger';
import { deliveryProjection, publishProjection } from './land';
import type { Pkg } from './plan';
import {
  acceptedPackageTokens,
  callsOf,
  clock,
  planOf,
  replacedRuns,
  reportFirstPassOf,
  runElapsedOf,
} from './report';
import {
  episodeOf,
  lessonTrialEligible,
  lessonSources,
  memoryLog,
  memoryOn,
  memoryState,
  memoryWrite,
  privateProject,
  runIsFake,
  taskTag,
  wilson,
  type Lesson,
} from './memory';
import { curate, decodeNightlyOutput, nightlyReflection } from './memory-reflect';
import { redact } from './redact';

const DAY = 86_400_000;
export interface Sample {
  id: string;
  at: number;
  repo: string;
  first: number | null;
  excluded?: 'operator' | 'superseded' | 'active';
  packages: number;
  groups: string[];
  reasons: string[];
  tokens: number | null;
  tokenPackages: number;
  measuredTokenPackages: number;
  elapsed: number | null;
  elapsedPackages: number;
}
const bucket = (n: number) => (n === 0 ? '0' : n <= 3 ? '1-3' : '4+');
function dispatchGroups(ledger: Ledger): string[] {
  // Continuations set gen_dir to the new generation. Use the original dispatch snapshot.
  const gen_dir = join(home().sa, 'gen', ledger.run_id);
  const plan = planOf({ ...ledger, gen_dir, plan: join(gen_dir, 'plan.json') });
  const groups = (plan?.packages ?? []).flatMap((p: Partial<Pkg>) => [
    ...(p.size ? [`size:${p.size}`] : []),
    ...(p.risk ? [`risk:${p.risk}`] : []),
    ...(Array.isArray(p.accept) ? [`accept_count:${bucket(p.accept.length)}`] : []),
    ...(p.max_net_lines === undefined ? ['max_net_lines:no'] : ['max_net_lines:yes']),
    ...(Array.isArray(p.scope?.write)
      ? [`tag:${taskTag(p.scope.write)}`, `write_globs:${bucket(p.scope.write.length)}`]
      : []),
  ]);
  // Legacy recoveries can overwrite the original run-config.yaml in place.
  if (ledger.adoptions?.some(a => a.reason !== 'plan_replacement')) return groups;
  try {
    const path = confined({ ...ledger, gen_dir }, join(gen_dir, 'run-config.yaml'));
    if (path) {
      const config = Bun.YAML.parse(readFileSync(path, 'utf8')) as
        | { aliases?: { '@sa-coder'?: { model?: string } } }
        | null
        | undefined;
      const model = config?.aliases?.['@sa-coder']?.model;
      if (model) groups.push(`model:${model}`);
    }
  } catch {
    // Older or collected run snapshots have no pinned model evidence.
  }
  return groups;
}

export function collect(ls: Ledger[], now: number): Sample[] {
  if (!ls.length) return [];
  const runs = reportRuns(new Date(now - 8 * DAY).toISOString(), new Date(now).toISOString());
  const replaced = replacedRuns(ls);
  return ls.flatMap(ledger => {
    const ids = archonRunIds(ledger),
      latest = runs.get(ledger.archon_run_id);
    if (!latest) return [];
    const e = episodeOf(ledger.run_id);
    try {
      if (!lessonTrialEligible(ledger.repo, e?.fake === true || runIsFake(ledger))) return [];
    } catch {
      memoryLog(`nightly: invalid engine evidence for ${ledger.run_id}`);
      return [];
    }
    const plan = planOf(ledger);
    if (clock(latest.completed_at ?? '') > now) return [];
    const run = { ...latest, nodes: buildNodeSummaries(latest.events) };
    const pair = { ledger, run };
    const first = reportFirstPassOf(pair, replaced);
    const integrated =
      first !== 'active' &&
      Boolean(deliveryProjection(ledger)?.integrated ?? publishProjection(ledger, run)?.integrated);
    const packages = plan?.packages.length ?? 0;
    const calls = callsOf(
      ledger.run_id,
      ids.flatMap(id => runs.get(id)?.events ?? []),
      plan
    );
    const accepted = acceptedPackageTokens(
      pair,
      calls,
      ids.some(id => !runs.has(id))
    );
    const weights = accepted.flatMap(p => (typeof p.tokens === 'number' ? [p.tokens] : []));
    const elapsed = runElapsedOf(pair);
    return [
      {
        id: ledger.run_id,
        at: clock(latest.started_at ?? ''),
        repo: ledger.repo,
        first: typeof first === 'boolean' ? Number(first) : null,
        ...(first === 'operator' || first === 'superseded' || first === 'active'
          ? { excluded: first }
          : {}),
        packages,
        groups: dispatchGroups(ledger),
        reasons: e?.reasons ?? [],
        tokens: weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null,
        tokenPackages: accepted.length,
        measuredTokenPackages: weights.length,
        elapsed: integrated && packages && elapsed !== null ? elapsed / packages : null,
        elapsedPackages: integrated ? packages : 0,
      },
    ];
  });
}
const metrics = ['first', 'tokens', 'elapsed'] as const;
const tally = (rows: Sample[], metric: (typeof metrics)[number]) => {
  let numerator = 0,
    denominator = 0,
    eligible = 0;
  for (const row of rows) {
    const count =
      metric === 'first'
        ? Number(!row.excluded)
        : metric === 'tokens'
          ? row.tokenPackages
          : row.elapsedPackages;
    eligible += count;
    if (row[metric] === null) continue;
    const measured = metric === 'tokens' ? row.measuredTokenPackages : count;
    numerator += row[metric] * measured;
    denominator += measured;
  }
  return {
    numerator,
    denominator,
    eligible,
    coverage: eligible ? denominator / eligible : null,
    status: eligible && denominator === eligible ? 'complete' : 'insufficient_coverage',
    value: denominator ? numerator / denominator : null,
    ...(metric === 'first' && {
      excluded: {
        operator: rows.filter(r => r.excluded === 'operator').length,
        superseded: rows.filter(r => r.excluded === 'superseded').length,
      },
    }),
  };
};
export function analyze(rows: Sample[], now: number) {
  const window = (day: number) => rows.filter(r => r.at >= now - DAY * day && r.at < now);
  const daily = window(1),
    weekly = window(7);
  const last_24h = {
    first: tally(daily, 'first'),
    tokens: tally(daily, 'tokens'),
    elapsed: tally(daily, 'elapsed'),
  };
  const last_7d = {
    first: tally(weekly, 'first'),
    tokens: tally(weekly, 'tokens'),
    elapsed: tally(weekly, 'elapsed'),
  };
  const deviation = Object.fromEntries(
    metrics.map(metric => {
      const days = Array.from({ length: 7 }, (_, i) =>
        tally(
          rows.filter(r => r.at >= now - DAY * (i + 2) && r.at < now - DAY * (i + 1)),
          metric
        )
      );
      const values = days.flatMap(d => (d.value === null ? [] : [d.value]));
      const mean = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
      const sd =
        mean === null || values.length < 2
          ? null
          : Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
      const current = last_24h[metric].value;
      const status =
        current === null || sd === null || mean === null
          ? '覆盖不足'
          : Math.abs(current - mean) > 2 * sd
            ? '显著偏离'
            : '无显著变化';
      return [metric, { mean, sd, days: values.length, status }];
    })
  );
  const attribution = metrics
    .flatMap(metric => {
      const threshold = metric === 'first' ? 0 : last_7d[metric].value;
      if (threshold === null) return [];
      const measured = weekly.filter(r => r[metric] !== null);
      const adverse = (r: Sample) =>
        metric === 'first' ? r.first === 0 : (r[metric] ?? -Infinity) > threshold;
      const baseline = measured.filter(adverse).length / measured.length;
      const groups = new Map<string, Sample[]>();
      for (const r of measured)
        for (const key of new Set([`repo:${r.repo}`, ...r.groups])) {
          const members = groups.get(key);
          if (members) members.push(r);
          else groups.set(key, [r]);
        }
      return [...groups].flatMap(([group, members]) => {
        const failures = members.filter(adverse),
          n = members.length,
          k = failures.length;
        const interval = wilson(k, n);
        if (n < 5 || interval[0] <= baseline) return [];
        const category =
          metric === 'tokens' ? '浪费 token' : metric === 'elapsed' ? '协同失败' : '影响完成度';
        return [
          {
            metric,
            group,
            category,
            n,
            k,
            baseline,
            interval,
            lift: k / n / baseline,
            impact: k - baseline * n,
            examples: failures.map(r => r.id),
          },
        ];
      });
    })
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);
  const failures = weekly.filter(r => r.first === 0);
  const denominator = failures.reduce((sum, row) => sum + row.packages, 0);
  const counts = new Map<string, number>();
  for (const { packages, reasons } of failures) {
    if (!packages) continue;
    for (const reason of new Set(reasons)) counts.set(reason, (counts.get(reason) ?? 0) + packages);
  }
  const failure_reasons = {
    denominator,
    reasons: Object.fromEntries(
      [...counts].map(([reason, count]) => [reason, { count, share: count / denominator }])
    ),
  };
  return { last_24h, last_7d, deviation, attribution, failure_reasons };
}
const sources = ['remote', 'local'] as const;
type Source = (typeof sources)[number];
const modelState = () => ({
  called: false,
  status: 'interrupted',
  duration_ms: 0,
  model: null as string | null,
  tokens: null as number | null,
  run_id: null as string | null,
  evidence_path: null as string | null,
  reason: null as string | null,
  proposed: 0,
  produced: 0,
  filtered: {} as Record<string, number>,
});

export function latestNightReport(sa: string): string | undefined {
  const dir = join(sa, 'evolution');
  const file =
    existsSync(dir) &&
    readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .at(-1);
  return file ? join(dir, file) : undefined;
}
export function evolve(
  sa: string,
  now: number,
  samples: () => Sample[],
  force = false,
  reflect: (input: string, source: Source) => ReturnType<typeof nightlyReflection> = (
    input,
    source
  ) => nightlyReflection(input, undefined, source)
) {
  if (!force && engineDateTime(now).slice(11, 13) < '02') return 'not-due';
  const day = engineDay(now),
    dir = join(sa, 'evolution'),
    path = join(dir, day + '.json');
  if (!force && existsSync(path)) return 'already-claimed';
  mkdirSync(dir, { recursive: true });
  const model = { called: false, status: 'interrupted', duration_ms: 0 },
    models = { remote: modelState(), local: modelState() };
  const save = (payload = {}) => {
    writeAtomic(path, JSON.stringify({ day, ...payload, model, models }, null, 2) + '\n');
  };
  save({ claimed_at: new Date(now).toISOString() });
  const stats = analyze(samples(), now),
    candidates: (Lesson & { source: Source })[] = [];
  const safe = stats.attribution.filter(
    a => !a.group.startsWith('repo:') || !privateProject(a.group.slice(5))
  );
  const examples = [...new Set(safe.flatMap(a => a.examples.slice(0, 5)))].flatMap(id => {
    const e = episodeOf(id);
    return e &&
      !e.fake &&
      !privateProject(e.project) &&
      !['engine', 'transient'].includes(e.category)
      ? [e]
      : [];
  });
  model.status = 'skipped';
  for (const source of sources) models[source].status = 'skipped';
  if (memoryOn() && safe.length) {
    const template = readFileSync(join(WETAMP, 'templates', 'memory-reflect.md'), 'utf8');
    const input = () =>
      template +
      '\n仅 ADD 项目或任务类型经验，必须引用 episode ID，禁止以完成度换 token。\n' +
      redact(
        JSON.stringify({
          groups: safe.map(a => ({
            ...a,
            examples: a.examples.filter(id => examples.some(e => e.id === id)),
          })),
          episodes: examples.map(({ id, project, tag, reasons, retro, status }) => ({
            id,
            project,
            tag,
            reasons,
            retro,
            status,
          })),
        })
      );
    while (examples.length && Buffer.byteLength(input()) > 24_000) examples.pop();
    const prompt = input(),
      started = Date.now();
    const propose = (source: Source) => {
      const state = models[source],
        started = Date.now();
      state.called = true;
      state.status = 'interrupted';
      save({ ...stats, candidates });
      try {
        const { output, evidence, failure, reason: failureReason } = reflect(prompt, source);
        Object.assign(state, evidence);
        const proposed = (output as { operations?: unknown } | null)?.operations;
        state.proposed = Array.isArray(proposed) ? proposed.length : 0;
        if (failure || output === undefined) {
          state.status = failure ?? 'no_output';
          state.reason =
            failureReason ??
            (state.status === 'failed'
              ? '提炼工作流执行失败'
              : state.status === 'schema_invalid'
                ? '工作流拒绝了输出结构'
                : '模型未返回结构化输出');
          return [];
        }
        const decoded = decodeNightlyOutput(output);
        if (!decoded.success) {
          state.status = 'schema_invalid';
          state.reason = '提炼输出结构不合格';
          return [];
        }
        const { operations, reason } = decoded.data;
        state.status = operations.length ? 'all_filtered' : 'no_output';
        state.reason = reason?.trim()
          ? redact(reason.trim())
          : operations.length
            ? null
            : '模型返回空候选';
        if (state.proposed > operations.length)
          state.filtered.source_limit = state.proposed - operations.length;
        return operations as ({ op?: string; lesson?: { evidence?: string[] } } | null)[];
      } catch {
        state.status = 'failed';
        state.reason = '提炼工作流执行失败';
        return [];
      } finally {
        state.duration_ms = Date.now() - started;
      }
    };
    if (Buffer.byteLength(prompt) <= 24_000) {
      model.called = true;
      const pending = { remote: propose('remote'), local: propose('local') };
      const discard = (source: Source, reason: string) => {
        const counts = models[source].filtered;
        counts[reason] = (counts[reason] ?? 0) + 1;
      };
      try {
        if (pending.remote.length || pending.local.length)
          memoryWrite(state => {
            const order = Number(day.slice(-2)) % 2 ? [...sources].reverse() : sources;
            const next = (source: Source) => {
              while (pending[source].length) {
                const op = pending[source].shift();
                if (op?.op !== 'ADD' || !Array.isArray(op.lesson?.evidence)) {
                  discard(source, 'invalid_or_unsupported_operation');
                  continue;
                }
                const episode = examples.find(e => op.lesson?.evidence?.includes(e.id));
                if (!episode) {
                  discard(source, 'evidence_missing');
                  continue;
                }
                const curated = curate(episode, { operations: [op] }, now, examples);
                const candidate = curated.lessons.at(0);
                if (!candidate || candidate.tier === 'role') {
                  discard(source, candidate ? 'unsupported_tier' : curated.result);
                  continue;
                }
                if (
                  [...state.lessons, ...candidates].some(
                    l =>
                      l.id === candidate.id ||
                      (l.tag === candidate.tag &&
                        l.scope === candidate.scope &&
                        l.do === candidate.do)
                  )
                ) {
                  discard(source, 'duplicate');
                  continue;
                }
                candidates.push({ ...candidate, source, curated_at: new Date(now).toISOString() });
                break;
              }
            };
            while (candidates.length < 3 && (pending.remote.length || pending.local.length))
              for (const source of order) if (candidates.length < 3) next(source);
            return { lessons: candidates };
          });
        for (const source of sources) {
          if (pending[source].length)
            models[source].filtered.candidate_limit = pending[source].length;
          models[source].produced = candidates.filter(c => c.source === source).length;
          if (models[source].produced) models[source].status = 'produced';
        }
        const statuses = sources.map(source => models[source].status);
        model.status =
          ['produced', 'all_filtered', 'schema_invalid', 'no_output', 'failed'].find(status =>
            statuses.includes(status)
          ) ?? 'failed';
      } catch {
        model.status = 'failed';
        for (const source of sources) {
          if (models[source].status !== 'all_filtered') continue;
          models[source].status = 'failed';
          models[source].reason = '经验写入失败';
        }
        candidates.length = 0;
      }
    } else {
      model.status = 'failed';
    }
    model.duration_ms = Date.now() - started;
  }
  const state = memoryState();
  const statusIds = (status: Lesson['status']) =>
    state.lessons
      .filter(l => l.status === status && l.status_at && engineDay(Date.parse(l.status_at)) === day)
      .map(l => l.id);
  save({
    ...stats,
    candidates,
    sources: lessonSources(state),
    promoted: statusIds('stable'),
    retired: statusIds('retired'),
  });
  return path;
}
