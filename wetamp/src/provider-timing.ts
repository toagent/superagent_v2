import { clock as utcClock } from './ledger-metrics';
import {
  providerEventEnvelopeSchema,
  type ProviderEventEnvelope,
} from '../../packages/workflows/src/schemas/provider-event';
import { createRequire } from 'node:module';

const shell = createRequire(import.meta.url)('../hooks/shell.cjs') as {
  parse(command: string): { writes: string[]; argvs: string[][] };
};
// p90 from the preceding three days: 544 attempts (2026-10-14 efficiency-budget brief).
const baselines = {
  code: [1092000, 63],
  repair: [156000, 19],
  fix: [498000, 46],
  review: [444000, 43],
} as const;
const baseline = (node: string) =>
  Object.entries(baselines).find(([role]) => node === role || node.startsWith(`${role}-`))?.[1];

// prettier-ignore
function editAction(event: ProviderEventEnvelope['event']): boolean | 'unknown' {
  if (event.type !== 'tool_call') return false;
  if (['file_change', 'fileChange', 'apply_patch'].includes(event.name)) return true;
  if (!['command_execution', 'shell', 'exec_command', 'Bash'].includes(event.name)) return false;
  const input = object(event.rawInput), command = input?.command ?? input?.cmd ?? event.title;
  if (typeof command !== 'string') return 'unknown';
  try {
    const parsed = shell.parse(command);
    return parsed.writes.length > 0 || parsed.argvs.some(argv =>
      argv[0] === 'apply_patch' ||
      (argv[0] === 'sed' && argv.slice(1).some(arg => /^-[^-]*i|^--in-place/.test(arg))));
  } catch { return 'unknown'; }
}

interface TimingRow {
  workflow_run_id?: string;
  event_type: string;
  step_name?: string | null;
  created_at?: string;
  data?: unknown;
}
interface Interval {
  start: string;
  end: string;
}
const object = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : undefined;
/** Only an explicit executable descriptor proves provider metrics do not apply. */
// prettier-ignore
export function providerMetricMissing(data: unknown): 'n/a' | 'unknown' {
  const d = object(data), node = object(d?.node), binding = object(d?.binding);
  if (binding?.provider || binding?.model || d?.provider || d?.model) return 'unknown';
  return (node ? node.kind === 'exec' : d?.type === 'bash' || d?.type === 'script') ? 'n/a' : 'unknown';
}
const clock = (x: unknown): string =>
  typeof x === 'string' && Number.isFinite(utcClock(x)) ? x : 'unknown';

/** Client arrival boundaries only: neither a request clock nor server reasoning time. */
// prettier-ignore
export function providerTiming(runId: string, rows: readonly TimingRow[]) {
  const groups = new Map<string, { run: string; node: string; attempt: string; rows: TimingRow[] }>();
  for (const row of rows) {
    if (!['provider_event', 'node_completed', 'node_failed'].includes(row.event_type)) continue;
    const data = object(row.data);
    const attempt = row.event_type === 'provider_event' ? data?.attemptId : object(data?.attempt)?.id;
    if (typeof attempt !== 'string' || !attempt || !row.step_name) continue;
    const run = row.workflow_run_id ?? runId, node = row.step_name;
    const key = JSON.stringify([run, node, attempt]);
    if (!groups.has(key)) groups.set(key, { run, node, attempt, rows: [] });
    groups.get(key)?.rows.push(row);
  }
  return [...groups.values()].map(group => {
    const raw = group.rows.filter(r => r.event_type === 'provider_event');
    const parsed = raw.map(r => providerEventEnvelopeSchema.safeParse(r.data));
    const events = parsed.flatMap(p => p.success ? [p.data] : []).sort((a, b) => a.seq - b.seq);
    const counts = new Map<number, number>();
    for (const e of events) counts.set(e.seq, (counts.get(e.seq) ?? 0) + 1);
    const unique = events.filter(e => counts.get(e.seq) === 1);
    const ordered = events.every((e, i) => e.seq === i && (i === 0 ||
      utcClock(e.observedAt) >= utcClock(events[i - 1].observedAt)));
    const complete = raw.length > 0 && parsed.every(p => p.success) && ordered;
    const terminals = group.rows.filter(r => r.event_type !== 'provider_event');
    const terminal = terminals.length === 1 ? terminals[0] : undefined;
    const missing = raw.length ? 'unknown' : providerMetricMissing(terminal?.data);
    // Boundary summaries must not hide the warning or lifecycle event that ends silence.
    const boundaries = unique.filter(e => !(e.event.type === 'state_update' &&
      e.event.state === 'running' && e.event.progress));
    const silence = complete ? boundaries.slice(1).reduce<{ start: string; ms: number; end: ProviderEventEnvelope['event'] } | undefined>((best, e, i) => {
      const start = boundaries[i].observedAt, ms = utcClock(e.observedAt) - utcClock(start);
      return !best || ms > best.ms ? { start, ms, end: e.event } : best;
    }, undefined) : undefined;
    const longGaps = complete ? unique.slice(1).flatMap((e, i) => {
      const start = unique[i].observedAt, end = e.observedAt;
      const ms = utcClock(end) - utcClock(start);
      if (ms < 180000) return [];
      const p = e.event.type === 'state_update' ? e.event.progress : undefined;
      const covered = p && utcClock(p.since) <= utcClock(start) &&
        utcClock(p.at) >= utcClock(start) && utcClock(p.at) <= utcClock(end);
      const model = p && [p.reasoning, p.message].some(d => d.count > 0 && d.lastAt &&
        utcClock(d.lastAt) > utcClock(start) && utcClock(d.lastAt) <= utcClock(p.at));
      // Observed activity wins; silence describes client observation, not server health.
      const classification = !covered ? 'unclassified' : model ? 'model_progress' :
        p.activeTools + p.activeTasks > 0 ? 'tool_active' : 'silent';
      return [{ start, end, ms, classification }];
    }) : undefined;
    const warnings = complete ? unique.flatMap(e => e.event.type === 'warning'
      ? [{ code: e.event.code, at: e.observedAt }] : []) : missing;
    const settled = clock(terminal?.created_at);
    const starts = new Map<string, ProviderEventEnvelope[]>();
    const ends = new Map<string, ProviderEventEnvelope[]>();
    for (const e of unique) {
      const event = e.event;
      let id: string, map: typeof starts;
      if (event.type === 'tool_call' || event.type === 'tool_call_update') {
        id = JSON.stringify(['tool_call', event.toolCallId]);
        map = event.type === 'tool_call' ? starts : ends;
      } else if (event.type === 'subtask' && event.taskType === 'command_execution') {
        id = JSON.stringify(['subtask', event.taskId]);
        if (event.status === 'started') map = starts;
        else if (event.status === 'completed' || event.status === 'failed') map = ends;
        else continue;
      } else continue;
      map.set(id, [...(map.get(id) ?? []), e]);
    }
    const intervals: Interval[] = [];
    let closed = true;
    for (const id of new Set([...starts.keys(), ...ends.keys()])) {
      const a = starts.get(id), b = ends.get(id);
      const start = a?.[0], end = b?.[0];
      // A hole, duplicate or bad clock inside a pair can hide another lifecycle edge.
      const span = start && end ? unique.filter(e => e.seq >= start.seq && e.seq <= end.seq) : [];
      if (a?.length !== 1 || b?.length !== 1 || !start || !end || end.seq <= start.seq ||
        span.length !== end.seq - start.seq + 1 || !span.every((e, i) => i === 0 ||
          utcClock(e.observedAt) >= utcClock(span[i - 1].observedAt)) ||
        parsed.some((p, i) => {
          if (p.success) return false;
          const seq = object(raw[i]?.data)?.seq;
          return typeof seq !== 'number' || (seq >= start.seq && seq <= end.seq);
        })) {
        closed = false;
        continue;
      }
      intervals.push({ start: start.observedAt, end: end.observedAt });
    }
    const union: Interval[] = [];
    for (const interval of intervals.sort((a, b) => utcClock(a.start) - utcClock(b.start))) {
      const last = union.at(-1);
      if (last && utcClock(interval.start) <= utcClock(last.end)) {
        if (utcClock(interval.end) > utcClock(last.end)) last.end = interval.end;
      } else union.push({ ...interval });
    }
    const knownMs = union.reduce((sum, i) => sum + utcClock(i.end) - utcClock(i.start), 0);
    const first = events[0], last = events.at(-1);
    const window = complete && last
      ? { start: first.observedAt, end: last.observedAt,
          duration_ms: utcClock(last.observedAt) - utcClock(first.observedAt),
          basis: 'client_provider_event_arrival' }
      : 'unknown' as const;
    const messages = unique.filter(e => e.event.type === 'agent_message_chunk');
    const terminalClock = settled !== 'unknown' && last && utcClock(settled) >= utcClock(last.observedAt);
    const measurable = typeof window === 'object' && closed;
    const gaps: { start: string; ms: number }[] = [];
    if (typeof window === 'object' && closed) {
      let cursor = window.start;
      for (const interval of union) {
        gaps.push({ start: cursor, ms: utcClock(interval.start) - utcClock(cursor) });
        cursor = interval.end;
      }
      gaps.push({ start: cursor, ms: utcClock(window.end) - utcClock(cursor) });
    }
    const longest = gaps.reduce<{ start: string; ms: number } | undefined>((best, gap) =>
      !best || gap.ms > best.ms ? gap : best, undefined);
    // Only positive gaps BETWEEN batches count; window edges are not round trips.
    const turns = measurable ? Math.max(0, union.length - 1) : 'unknown' as const;
    const edit = unique.find(e => editAction(e.event) !== false);
    const firstEdit = complete ? (edit ? editAction(edit.event) === true
      ? utcClock(edit.observedAt) - utcClock(first.observedAt) : 'unknown' : null) : 'unknown';
    const actions = unique.flatMap<{ name: string; title?: string; rawInput?: unknown }>(e => e.event.type === 'tool_call' ? [e.event] :
      e.event.type === 'subtask' && e.event.taskType === 'command_execution' && e.event.status === 'started'
        ? [{ name: 'command_execution', title: e.event.description }] : []);
    const commands = actions.filter(e => ['Bash', 'shell', 'exec_command', 'command_execution'].includes(e.name));
    const reads = new Set(['rg', 'grep', 'cat', 'sed', 'head', 'tail', 'ls', 'find', 'pwd', 'git', 'codegraph']);
    let explore = actions.filter(e => ['Read', 'Glob', 'Grep'].includes(e.name)).length, unrecognized = 0;
    for (const command of commands) {
      const input = 'rawInput' in command ? object(command.rawInput) : undefined;
      const text = input?.command ?? input?.cmd ?? command.title;
      if (typeof text !== 'string') { unrecognized++; continue; }
      try { const parsed = shell.parse(text), argvs = parsed.argvs; explore += Number(!parsed.writes.length && argvs.length > 0 && argvs.every(a => reads.has(a[0]) && (a[0] !== 'git' || ['status', 'diff', 'show', 'log'].includes(a[1])) && (a[0] !== 'sed' || !a.slice(1).some(v => /^-[^-]*i|^--in-place/.test(v))))); }
      catch { unrecognized++; }
    }
    const recognized = complete && actions.length > 0;
    unrecognized += actions.filter(e => !['Bash', 'shell', 'exec_command', 'command_execution', 'Read', 'Glob', 'Grep', 'file_change', 'fileChange', 'apply_patch'].includes(e.name) && !e.name.startsWith('mcp__')).length;
    const invocation = object(object(terminal?.data)?.invocation)?.id;
    const limits = baseline(group.node), reasons: string[] = [];
    if (limits && typeof window === 'object' && window.duration_ms > limits[0])
      reasons.push(`wall_clock_ms ${String(window.duration_ms)} > p90 ${String(limits[0])}`);
    if (limits && typeof turns === 'number' && turns > limits[1])
      reasons.push(`model_turns ${String(turns)} > p90 ${String(limits[1])}`);
    if (longest && longest.ms > 180000) reasons.push(`longest_gap_ms ${String(longest.ms)} > 180000`);
    return {
      run: group.run, node: group.node, attempt_id: group.attempt,
      invocation_id: typeof invocation === 'string' ? invocation : 'unknown',
      cmds: recognized ? commands.length : missing,
      explore_ratio: recognized ? explore / actions.length : missing, unrecognized_actions: complete ? unrecognized : missing,
      mcp_calls: recognized ? actions.filter(e => e.name.startsWith('mcp__')).length : missing,
      // Arrival gaps include transport; they are not native server reasoning clocks.
      think_gap_ms: recognized ? (typeof window === 'object' && closed ? window.duration_ms - knownMs : 'unknown') : missing,
      window: missing === 'n/a' ? missing : window, request_at: missing, first_token_ms: missing,
      first_content_at: complete ? messages[0]?.observedAt ?? 'unknown' : missing,
      final_answer_at: complete && closed && terminalClock && terminal?.event_type === 'node_completed'
        ? messages.at(-1)?.observedAt ?? 'unknown' : missing,
      node_settled_at: terminalClock ? settled : 'unknown',
      terminal: terminal?.event_type ?? 'unknown',
      tool_intervals: union, known_tool_union_ms: missing === 'n/a' ? missing : knownMs,
      tool_union_ms: complete && closed ? knownMs : missing,
      non_tool_gap_ms: typeof window === 'object' && closed ? window.duration_ms - knownMs : missing,
      model_turns: recognized ? turns : missing, first_edit_ms: missing === 'n/a' ? missing : firstEdit,
      longest_gap_ms: longest?.ms ?? missing, longest_gap_at: longest?.start ?? missing,
      longest_silence_ms: silence?.ms ?? missing, longest_silence_at: silence?.start ?? missing,
      longest_silence_closed_by: silence ? (silence.end.type === 'warning'
        ? { type: silence.end.type, code: silence.end.code } : { type: silence.end.type }) : missing,
      long_gaps: longGaps ?? missing,
      unclassified_gap_ratio: longGaps ? (longGaps.length ?
        longGaps.filter(g => g.classification === 'unclassified').length / longGaps.length : 0) : missing,
      provider_warnings: warnings,
      budget: { over: reasons.length > 0, reasons },
    };
  });
}

/** Rank by the largest ratio to a measured limit, including the universal gap limit. */
// prettier-ignore
export function slowNodes(timings: readonly ReturnType<typeof providerTiming>[number][]) {
  return timings.filter(t => t.budget.over).map(t => {
    const limits = baseline(t.node);
    const ratio = Math.max(typeof t.longest_gap_ms === 'number' ? t.longest_gap_ms / 180000 : 0,
      limits && typeof t.window === 'object' ? t.window.duration_ms / limits[0] : 0,
      limits && typeof t.model_turns === 'number' ? t.model_turns / limits[1] : 0);
    return { run: t.run, node: t.node, attempt: t.attempt_id, reasons: t.budget.reasons,
      over_ratio: ratio, duration_ms: typeof t.window === 'object' ? t.window.duration_ms : 'unknown',
      model_turns: t.model_turns, first_edit_ms: t.first_edit_ms,
      longest_gap_ms: t.longest_gap_ms, longest_gap_at: t.longest_gap_at,
      longest_silence_ms: t.longest_silence_ms, longest_silence_closed_by: t.longest_silence_closed_by,
      provider_warnings: t.provider_warnings };
  }).sort((a, b) => b.over_ratio - a.over_ratio).slice(0, 5);
}
