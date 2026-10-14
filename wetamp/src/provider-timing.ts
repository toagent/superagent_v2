import {
  providerEventEnvelopeSchema,
  type ProviderEventEnvelope,
} from '../../packages/workflows/src/schemas/provider-event';

interface TimingRow {
  workflow_run_id?: string;
  event_type: string;
  step_name?: string | null;
  created_at?: string;
  data?: unknown;
}
type Interval = { start: string; end: string };
const object = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === 'object' && x !== null ? x as Record<string, unknown> : undefined;
const clock = (x: unknown): string | 'unknown' =>
  typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : 'unknown';

/** Client arrival boundaries only: neither a request clock nor server reasoning time. */
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
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()].map(group => {
    const raw = group.rows.filter(r => r.event_type === 'provider_event');
    const parsed = raw.map(r => providerEventEnvelopeSchema.safeParse(r.data));
    const events = parsed.flatMap(p => p.success ? [p.data] : []).sort((a, b) => a.seq - b.seq);
    const counts = new Map<number, number>();
    for (const e of events) counts.set(e.seq, (counts.get(e.seq) ?? 0) + 1);
    const unique = events.filter(e => counts.get(e.seq) === 1);
    const ordered = events.every((e, i) => e.seq === i && (i === 0 ||
      Date.parse(e.observedAt) >= Date.parse(events[i - 1]!.observedAt)));
    const complete = raw.length > 0 && parsed.every(p => p.success) && ordered;
    const terminals = group.rows.filter(r => r.event_type !== 'provider_event');
    const terminal = terminals.length === 1 ? terminals[0] : undefined;
    const settled = clock(terminal?.created_at);
    const starts = new Map<string, ProviderEventEnvelope[]>();
    const ends = new Map<string, ProviderEventEnvelope[]>();
    for (const e of unique) {
      const event = e.event;
      if (event.type !== 'tool_call' && event.type !== 'tool_call_update') continue;
      const map = event.type === 'tool_call' ? starts : ends;
      map.set(event.toolCallId, [...(map.get(event.toolCallId) ?? []), e]);
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
          Date.parse(e.observedAt) >= Date.parse(span[i - 1]!.observedAt)) ||
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
    for (const interval of intervals.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      const last = union.at(-1);
      if (last && Date.parse(interval.start) <= Date.parse(last.end)) {
        if (Date.parse(interval.end) > Date.parse(last.end)) last.end = interval.end;
      } else union.push({ ...interval });
    }
    const knownMs = union.reduce((sum, i) => sum + Date.parse(i.end) - Date.parse(i.start), 0);
    const first = events[0], last = events.at(-1);
    const window = complete && first && last
      ? { start: first.observedAt, end: last.observedAt,
          duration_ms: Date.parse(last.observedAt) - Date.parse(first.observedAt),
          basis: 'client_provider_event_arrival' }
      : 'unknown' as const;
    const messages = unique.filter(e => e.event.type === 'agent_message_chunk');
    const terminalClock = settled !== 'unknown' && last && Date.parse(settled) >= Date.parse(last.observedAt);
    return {
      run: group.run, node: group.node, attempt_id: group.attempt,
      window, request_at: 'unknown', first_token_ms: 'unknown',
      first_content_at: complete ? messages[0]?.observedAt ?? 'unknown' : 'unknown',
      final_answer_at: complete && closed && terminalClock && terminal?.event_type === 'node_completed'
        ? messages.at(-1)?.observedAt ?? 'unknown' : 'unknown',
      node_settled_at: terminalClock ? settled : 'unknown',
      terminal: terminal?.event_type ?? 'unknown',
      tool_intervals: union, known_tool_union_ms: knownMs,
      tool_union_ms: complete && closed ? knownMs : 'unknown',
      non_tool_gap_ms: typeof window === 'object' && closed ? window.duration_ms - knownMs : 'unknown',
    };
  });
}
