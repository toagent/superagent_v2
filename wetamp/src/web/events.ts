import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { stageKind } from '../board/cockpit';
import { workflowRoles, type Role } from '../board/workflow';
import { ledgerIds, loadLedger } from '../cli';
import { home } from '../config';
export class HudEventsUnsupported extends Error {}
type ToolKind = keyof typeof TOOLS | 'mcp' | 'other';
type Delivery = [run: string, project: string, roles?: Map<string, Role>];
type Row = Record<'workflow_run_id' | 'event_type' | 'data' | 'created_at', string> & {
  event_order: number;
  step_name: string | null;
};
const eventKind = (type: string): string | undefined =>
  'node_start,node_done,node_fail,node_retry,run_done,run_fail,run_cancel'.split(',')[
    'node_started,node_completed,node_failed,node_retry_scheduled,workflow_completed,workflow_failed,workflow_cancelled'
      .split(',')
      .indexOf(type)
  ];
const TOOLS = {
  edit: new Set(['file_change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']),
  exec: new Set(['Bash', 'exec_command', 'shell']),
  read: new Set(['Read', 'Grep', 'Glob', 'codegraph_explore', 'find_symbol']),
  structured: new Set(['StructuredOutput']),
  subagent: new Set(['Task', 'spawn_agent']),
};
const EVENTS_SQL = `SELECT e.event_order, e.workflow_run_id, e.event_type, e.step_name, e.data, e.created_at FROM remote_agent_workflow_events e JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id WHERE e.event_order > ? AND e.event_order IS NOT NULL AND r.workflow_name LIKE 'sa-%' AND e.workflow_run_id IN (SELECT value FROM json_each(?)) AND e.event_type IN ('node_started','node_completed','node_failed','node_retry_scheduled','workflow_completed','workflow_failed','workflow_cancelled','provider_event') AND (e.event_type != 'provider_event' OR (json_valid(e.data) AND json_extract(e.data, '$.event.type') = 'tool_call')) ORDER BY e.event_order LIMIT ?`;
const object = (value: unknown): Record<string, unknown> =>
  Object(value ?? {}) as Record<string, unknown>;
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  for (const kind of Object.keys(TOOLS) as (keyof typeof TOOLS)[])
    if (TOOLS[kind].has(name)) return kind;
  return /^(find_|get_symbols_|search_for_pattern$|list_dir$)/.test(name) ? 'read' : 'other';
}
let cached: { root: string; until: number; runs: Map<string, Delivery> } | undefined;
function deliveryRuns(): Map<string, Delivery> {
  const root = home().sa;
  if (cached?.root === root && cached.until > Date.now()) return cached.runs;
  const scratch = resolve(tmpdir()),
    runs = new Map<string, Delivery>();
  for (const id of ledgerIds())
    try {
      const ledger = loadLedger(id),
        repo = resolve(ledger.repo),
        project = basename(repo);
      const excluded =
        !ledger.workflow.startsWith('sa-') ||
        repo.startsWith(scratch + sep) ||
        /fake/i.test(project);
      if (excluded) continue;
      runs.set(ledger.archon_run_id, [ledger.run_id, project, workflowRoles(ledger)]);
    } catch {
      continue;
    }
  cached = { root, until: Date.now() + 2000, runs };
  return runs;
}
function project(row: Row, delivery: Delivery): Record<string, unknown> | undefined {
  const [run, project, roles] = delivery;
  const data = object(JSON.parse(row.data));
  const provider = object(data.event);
  const tool =
    provider.type === 'tool_call' && typeof provider.name === 'string'
      ? toolKind(provider.name)
      : undefined;
  const kind = tool ? 'tool' : eventKind(row.event_type);
  if (!kind) return;
  const done = kind === 'node_done';
  const tokens = done ? finite(object(data.tokens).input) : undefined;
  const ms = done ? finite(data.duration_ms) : undefined;
  return {
    seq: row.event_order,
    at: row.created_at,
    project,
    run,
    stage: stageKind(row.step_name),
    role: row.step_name ? (roles?.get(row.step_name) ?? null) : null,
    kind,
    ...(tool ? { tool } : {}),
    ...(tokens === undefined ? {} : { tokens }),
    ...(ms === undefined ? {} : { ms }),
  };
}
export function hudEvents(after?: string | null, requestedLimit?: string | null) {
  if (process.env.DATABASE_URL)
    throw new HudEventsUnsupported('Postgres event projection is not supported');
  const db = new Database(join(home().archon, 'archon.db'), { readonly: true });
  try {
    const parsedAfter = Number(after),
      parsedLimit = Number(requestedLimit);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(500, Math.floor(parsedLimit))
        : 200;
    const initial =
      after != null && Number.isFinite(parsedAfter) && parsedAfter >= 0
        ? Math.floor(parsedAfter)
        : (db
            .query<
              { seq: number },
              []
            >("SELECT COALESCE(MAX(event_order), 0) AS seq FROM remote_agent_workflow_events WHERE created_at < datetime('now', '-24 hours')")
            .get()?.seq ?? 0);
    const deliveries = deliveryRuns();
    const rows = db
      .query<Row, [number, string, number]>(EVENTS_SQL)
      .all(initial, JSON.stringify([...deliveries.keys()]), limit + 1);
    const events = rows.flatMap(row => {
      const delivery = deliveries.get(row.workflow_run_id);
      const event = delivery && project(row, delivery);
      return event ? [event] : [];
    });
    const page = events.slice(0, limit);
    return {
      cursor: String((page.at(-1)?.seq as number | undefined) ?? initial),
      more: events.length > limit,
      events: page,
    };
  } finally {
    db.close();
  }
}
