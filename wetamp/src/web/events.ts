import { Database } from 'bun:sqlite';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { home } from '../config';
import { ledgerIds, loadLedger } from '../cli';
import { stageKind } from '../board/cockpit';
import { workflowRoles, type Role } from '../board/workflow';

export class HudEventsUnsupported extends Error {}
export interface HudEvent {
  seq: number;
  at: string;
  project: string;
  run: string;
  stage: ReturnType<typeof stageKind>;
  role: Role | null;
  kind: string;
  tool?: ReturnType<typeof toolKind>;
  tokens?: number;
  ms?: number;
}

const KINDS: Record<string, string> = {
  node_started: 'node_start',
  node_completed: 'node_done',
  node_failed: 'node_fail',
  node_retry_scheduled: 'node_retry',
  workflow_completed: 'run_done',
  workflow_failed: 'run_fail',
  workflow_cancelled: 'run_cancel',
};
const TOOLS = {
  edit: new Set(['file_change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']),
  exec: new Set(['Bash', 'exec_command', 'shell']),
  read: new Set(['Read', 'Grep', 'Glob', 'codegraph_explore', 'find_symbol']),
  structured: new Set(['StructuredOutput']),
  subagent: new Set(['Task', 'spawn_agent']),
};
export function toolKind(
  name: string
): 'edit' | 'exec' | 'read' | 'mcp' | 'structured' | 'subagent' | 'other' {
  if (name.startsWith('mcp__')) return 'mcp';
  for (const kind of ['edit', 'exec', 'read', 'structured', 'subagent'] as const)
    if (TOOLS[kind].has(name)) return kind;
  if (/^(find_|get_symbols_|search_for_pattern$|list_dir$)/.test(name)) return 'read';
  return 'other';
}

interface Delivery {
  run: string;
  project: string;
  workflow: string;
  roles?: Map<string, Role>;
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
      if (
        !ledger.workflow.startsWith('sa-') ||
        repo === scratch ||
        repo.startsWith(scratch + sep) ||
        /fake/i.test(project)
      )
        continue;
      runs.set(ledger.archon_run_id, {
        run: ledger.run_id,
        project,
        workflow: ledger.workflow,
        roles: workflowRoles(ledger),
      });
    } catch {
      /* A bad ledger cannot identify a delivery run. */
    }
  cached = { root, until: Date.now() + 2000, runs };
  return runs;
}

interface Row {
  event_order: number;
  workflow_run_id: string;
  workflow_name: string;
  event_type: string;
  step_name: string | null;
  data: string;
  created_at: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function hudEvents(
  after?: string | null,
  requestedLimit?: string | null
): { cursor: string; more: boolean; events: HudEvent[] } {
  if (process.env.DATABASE_URL)
    throw new HudEventsUnsupported('Postgres event projection is not supported');
  const path = join(home().archon, 'archon.db'),
    parsedAfter = Number(after),
    parsedLimit = Number(requestedLimit);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(500, Math.floor(parsedLimit)) : 200;
  const db = new Database(path, { readonly: true });
  try {
    const initial =
      after !== undefined && after !== null && Number.isFinite(parsedAfter) && parsedAfter >= 0
        ? Math.floor(parsedAfter)
        : (db
            .query<
              { seq: number },
              []
            >("SELECT COALESCE(MAX(event_order), 0) AS seq FROM remote_agent_workflow_events WHERE created_at < datetime('now', '-24 hours')")
            .get()?.seq ?? 0);
    const deliveries = deliveryRuns(),
      events: HudEvent[] = [];
    let scan = initial,
      exhausted = false;
    const query = db.query<Row, [number, number]>(
      `SELECT e.event_order, e.workflow_run_id, r.workflow_name, e.event_type, e.step_name, e.data, e.created_at FROM remote_agent_workflow_events e JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id WHERE e.event_order > ? AND e.event_order IS NOT NULL AND r.workflow_name LIKE 'sa-%' AND e.event_type IN ('node_started','node_completed','node_failed','node_retry_scheduled','workflow_completed','workflow_failed','workflow_cancelled','provider_event') ORDER BY e.event_order LIMIT ?`
    );
    while (events.length <= limit && !exhausted) {
      const rows = query.all(scan, Math.max(501, limit * 2));
      exhausted = rows.length < Math.max(501, limit * 2);
      for (const row of rows) {
        scan = row.event_order;
        const delivery = deliveries.get(row.workflow_run_id);
        if (delivery?.workflow !== row.workflow_name) continue;
        let data: Record<string, unknown>;
        try {
          data = object(JSON.parse(row.data));
        } catch {
          continue;
        }
        const provider = object(data.event),
          tool =
            provider.type === 'tool_call' && typeof provider.name === 'string'
              ? toolKind(provider.name)
              : undefined;
        const kind = tool ? 'tool' : KINDS[row.event_type];
        if (!kind) continue;
        const event: HudEvent = {
          seq: row.event_order,
          at: row.created_at,
          project: delivery.project,
          run: delivery.run,
          stage: stageKind(row.step_name),
          role: row.step_name ? (delivery.roles?.get(row.step_name) ?? null) : null,
          kind,
        };
        if (tool) event.tool = tool;
        if (kind === 'node_done') {
          const tokens = finite(object(data.tokens).input),
            ms = finite(data.duration_ms);
          if (tokens !== undefined) event.tokens = tokens;
          if (ms !== undefined) event.ms = ms;
        }
        events.push(event);
        if (events.length > limit) break;
      }
    }
    const page = events.slice(0, limit);
    return {
      cursor: String(page.at(-1)?.seq ?? initial),
      more: events.length > limit,
      events: page,
    };
  } finally {
    db.close();
  }
}
