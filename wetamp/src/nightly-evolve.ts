import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNodeSummaries } from '../../packages/cli/src/commands/workflow';
import { archonRunIds, reportRuns } from './archon';
import { WETAMP, writeAtomic } from './config';
import type { Ledger } from './ledger';
import { deliveryProjection, publishProjection } from './land';
import { clock, firstPassOf, ms, planOf, callsOf } from './report';
import {
  episodeOf,
  memoryOn,
  memoryState,
  memoryWrite,
  privateProject,
  wilson,
  type Lesson,
} from './memory';
import { capNightlyOperations, curate, nightlyReflection } from './memory-reflect';
import { redact } from './redact';

const DAY = 86_400_000;
export interface Sample {
  id: string;
  at: number;
  repo: string;
  first: number | null;
  integrated: boolean;
  sizes: string[];
  roles: string[];
  reasons: string[];
  tokens: number | null;
  elapsed: number | null;
}
export function collect(ls: Ledger[], now: number): Sample[] {
  if (!ls.length) return [];
  const runs = reportRuns(new Date(now - 8 * DAY).toISOString(), new Date(now).toISOString());
  return ls.flatMap(ledger => {
    const ids = archonRunIds(ledger),
      latest = runs.get(ledger.archon_run_id);
    const initial = runs.get(ids[0]);
    if (!initial || !latest || !['completed', 'failed', 'cancelled'].includes(latest.status))
      return [];
    const plan = planOf(ledger);
    if (!plan?.packages.length || clock(latest.completed_at ?? '') > now) return [];
    const run = { ...latest, nodes: buildNodeSummaries(latest.events) };
    const integrated = Boolean(
      deliveryProjection(ledger)?.integrated ?? publishProjection(ledger, run)?.integrated
    );
    const sizes = plan.packages.map(p => p.size);
    const calls = callsOf(
      ledger.run_id,
      ids.flatMap(id => runs.get(id)?.events ?? []),
      plan
    );
    const weights = calls.map(({ tokens: t }) =>
      t?.input === undefined || t.output === undefined
        ? null
        : t.input - (t.cacheRead ?? 0) + t.output
    );
    const elapsed = ms(initial.started_at ?? undefined, latest.completed_at ?? undefined);
    const first = firstPassOf({ ledger, run });
    const e = episodeOf(ledger.run_id);
    return [
      {
        id: ledger.run_id,
        at: clock(initial.started_at ?? ''),
        repo: ledger.repo,
        first: first === 'unknown' ? null : Number(first),
        sizes,
        integrated,
        reasons: e?.reasons ?? [],
        roles: [...new Set(calls.map(c => c.role))],
        tokens:
          integrated &&
          ids.every(id => runs.has(id)) &&
          weights.length &&
          weights.every(w => w !== null)
            ? weights.reduce((a, b) => a + b, 0) / sizes.length
            : null,
        elapsed: integrated && elapsed !== null ? elapsed / sizes.length : null,
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
    const count = metric === 'first' ? 1 : row.integrated ? row.sizes.length : 0;
    eligible += count;
    if (row[metric] === null) continue;
    numerator += row[metric] * count;
    denominator += count;
  }
  return {
    numerator,
    denominator,
    eligible,
    coverage: eligible ? denominator / eligible : null,
    status: eligible && denominator === eligible ? 'complete' : 'insufficient_coverage',
    value: denominator ? numerator / denominator : null,
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
        for (const key of new Set([
          `repo:${r.repo}`,
          ...r.reasons.map(v => `reason:${v}`),
          ...r.sizes.map(v => `size:${v}`),
          ...r.roles.map(v => `role:${v}`),
        ])) {
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
          metric === 'tokens'
            ? '浪费 token'
            : metric === 'elapsed' || /^(role:|reason:.*(?:review|repair|hold|rework))/.test(group)
              ? '协同失败'
              : '影响完成度';
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
  return { last_24h, last_7d, deviation, attribution };
}
const localDay = (at: number) => {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
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
  reflect = nightlyReflection
) {
  if (!force && new Date(now).getHours() < 2) return 'not-due';
  const day = localDay(now),
    dir = join(sa, 'evolution'),
    path = join(dir, day + '.json');
  if (existsSync(path)) return 'already-claimed';
  mkdirSync(dir, { recursive: true });
  const model = { called: false, status: 'interrupted', duration_ms: 0 };
  const save = (payload = {}) => {
    writeAtomic(path, JSON.stringify({ day, ...payload, model }, null, 2) + '\n');
  };
  save({ claimed_at: new Date(now).toISOString() });
  const stats = analyze(samples(), now),
    candidates: Lesson[] = [];
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
    const started = Date.now();
    try {
      if (Buffer.byteLength(input()) > 24_000) throw new Error('reflection input too large');
      model.called = true;
      save({ ...stats, candidates });
      const output = capNightlyOperations(reflect(input()));
      if (Array.isArray(output.operations))
        memoryWrite(state => {
          for (const op of output.operations as ({
            op?: string;
            lesson?: { evidence?: string[] };
          } | null)[]) {
            if (op?.op !== 'ADD' || !Array.isArray(op.lesson?.evidence)) continue;
            const episode = examples.find(e => op.lesson?.evidence?.includes(e.id));
            if (!episode) continue;
            const candidate = curate(episode, { ...output, operations: [op] }, now).lessons.at(0);
            if (
              !candidate ||
              candidate.tier === 'role' ||
              [...state.lessons, ...candidates].some(
                l =>
                  l.id === candidate.id ||
                  (l.tag === candidate.tag && l.scope === candidate.scope && l.do === candidate.do)
              )
            )
              continue;
            candidates.push({
              ...candidate,
              source: 'remote',
              curated_at: new Date(now).toISOString(),
            });
          }
          return { lessons: candidates };
        });
      model.status = candidates.length ? 'produced' : 'rejected';
    } catch {
      model.status = 'failed';
      candidates.length = 0;
    } finally {
      model.duration_ms = Date.now() - started;
    }
  }
  const statusIds = (status: Lesson['status']) =>
    memoryState()
      .lessons.filter(
        l => l.status === status && l.status_at && localDay(Date.parse(l.status_at)) === day
      )
      .map(l => l.id);
  save({ ...stats, candidates, promoted: statusIds('stable'), retired: statusIds('retired') });
  return path;
}
