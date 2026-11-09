import { parseArgs } from 'node:util';
import { cockpit, type Cockpit, type CockpitRun } from './board/cockpit';
import { createLoader, type Snapshot } from './board/data';
import { collectCurrentExport } from './export';

export const WORK_FIND_USAGE =
  'usage: superagent work find --terms-json <json-array> [--limit <1..100>] --json';
export const WORK_QUEUE_USAGE = 'usage: superagent work queue --json';

type ExportRecord = Record<string, unknown> & {
  repo_id: string | null;
  source_kind: string;
  source_id: string;
  revision?: unknown;
  observed_at?: unknown;
  evidence?: unknown;
};
type ExportView = Record<string, unknown> & {
  status?: unknown;
  coverage?: unknown;
  errors?: unknown;
  records?: unknown;
};
export interface WorkResult {
  exit: number;
  output?: Record<string, unknown>;
  error?: string;
}
export interface WorkDeps {
  collect: () => ReturnType<typeof collectCurrentExport>;
  load: () => Promise<Snapshot>;
}

const identity = (record: ExportRecord) => ({
  repo_id: record.repo_id,
  source_kind: record.source_kind,
  source_id: record.source_id,
});
const identityKey = (record: ExportRecord): string =>
  `${record.repo_id ?? ''}\0${record.source_kind}\0${record.source_id}`;
const observedAt = (record: ExportRecord): string =>
  typeof record.observed_at === 'string' ? record.observed_at : '';
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      )
    : [];

export function findWork(
  view: ExportView,
  terms: string[],
  limit: number
): Record<string, unknown> {
  const folded = [...new Map(terms.map(term => [term.toLowerCase(), term])).entries()];
  const candidates = objects(view.records)
    .map(record => {
      const item = record as ExportRecord;
      const haystack = JSON.stringify(item).toLowerCase();
      const matched = folded.filter(([term]) => haystack.includes(term)).map(([, term]) => term);
      return { item, matched };
    })
    .filter(candidate => candidate.matched.length > 0)
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        observedAt(b.item).localeCompare(observedAt(a.item)) ||
        identityKey(a.item).localeCompare(identityKey(b.item))
    )
    .slice(0, limit)
    .map(({ item, matched }) => ({
      identity: identity(item),
      revision: typeof item.revision === 'string' ? item.revision : null,
      observed_at: typeof item.observed_at === 'string' ? item.observed_at : null,
      matched_terms: matched,
      evidence: objects(item.evidence),
      record: item,
    }));
  return {
    status: view.status ?? 'unknown',
    coverage: view.coverage ?? null,
    errors: Array.isArray(view.errors) ? view.errors : [],
    terms,
    candidates,
  };
}

type ActionDescriptor =
  | {
      kind: 'ask_answer';
      command: 'ask';
      args: ['answer', string];
      options: { id: string; label: string; consequence: string }[];
    }
  | {
      kind: 'inbox_ack';
      command: 'inbox';
      args: ['--ack', string];
      options: ['accepted', 'rejected'];
      note_supported: true;
    };

const actionsFor = (need: CockpitRun, snapshot: Snapshot): ActionDescriptor[] => {
  const message = snapshot.coordMessages?.find(item => item.id === need.id);
  if (message && !message.type && !['accepted', 'done', 'rejected'].includes(message.state))
    return [
      {
        kind: 'inbox_ack',
        command: 'inbox',
        args: ['--ack', message.id],
        options: ['accepted', 'rejected'],
        note_supported: true,
      },
    ];
  const decision = snapshot.rows.find(row => row.run_id === need.id)?.humanDecision;
  if (!decision || !need.decision) return [];
  return [
    {
      kind: 'ask_answer',
      command: 'ask',
      args: ['answer', decision.id],
      options: decision.options.map(({ id, label, consequence }) => ({ id, label, consequence })),
    },
  ];
};

export function queueWork(
  snapshot: Snapshot,
  view: Cockpit = cockpit(snapshot)
): Record<string, unknown> {
  const needs = view.needs.map(need => {
    const coord = snapshot.coordMessages?.some(message => message.id === need.id) === true;
    return {
      identity: { kind: coord ? 'coord' : 'run', id: need.id },
      project: need.project,
      title: need.title,
      state: need.state,
      reason: need.reason,
      question: need.question,
      actions: actionsFor(need, snapshot),
    };
  });
  const unmapped = needs
    .filter(need => need.actions.length === 0)
    .map(need => `无法证明动作：${need.identity.kind}/${need.identity.id}`);
  return {
    status: 'ok',
    observed_at: snapshot.at,
    needs,
    anomalies: [...new Set([...view.anomalies, ...unmapped])],
  };
}

const defaultDeps: WorkDeps = {
  collect: collectCurrentExport,
  load: () => createLoader()(10_000),
};

const invalidTerms = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 8 &&
  value.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 80);

export async function runWork(argv: string[], deps: WorkDeps = defaultDeps): Promise<WorkResult> {
  const command = argv[1];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        'terms-json': { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    return { exit: 64, error: (error as Error).message };
  }
  if (parsed.positionals.length || parsed.values.json !== true)
    return { exit: 64, error: command === 'queue' ? WORK_QUEUE_USAGE : WORK_FIND_USAGE };
  if (command === 'queue') {
    if (parsed.values['terms-json'] !== undefined || parsed.values.limit !== undefined)
      return { exit: 64, error: WORK_QUEUE_USAGE };
    try {
      return { exit: 0, output: queueWork(await deps.load()) };
    } catch (error) {
      return { exit: 1, error: (error as Error).message };
    }
  }
  if (command !== 'find') return { exit: 64, error: WORK_FIND_USAGE };
  const termsJson = parsed.values['terms-json'];
  const limitValue = parsed.values.limit;
  if (typeof termsJson !== 'string' || (limitValue !== undefined && typeof limitValue !== 'string'))
    return { exit: 64, error: WORK_FIND_USAGE };
  let terms: unknown;
  try {
    terms = JSON.parse(termsJson);
  } catch {
    return { exit: 64, error: WORK_FIND_USAGE };
  }
  const limit = limitValue === undefined ? 10 : Number(limitValue);
  if (!invalidTerms(terms) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return { exit: 64, error: WORK_FIND_USAGE };
  try {
    const collected = deps.collect();
    if (!collected.output) return { exit: collected.exit === 2 ? 64 : 1, error: collected.error };
    const output = findWork(collected.output as ExportView, terms, limit);
    const sourceFailed = objects((collected.output as ExportView).errors).some(
      error => error.code === 'SOURCE_UNREADABLE' || error.code === 'EXPORT_TOO_LARGE'
    );
    return { exit: sourceFailed || collected.exit === 1 ? 1 : 0, output };
  } catch (error) {
    return { exit: 1, error: (error as Error).message };
  }
}

export async function workCli(argv: string[]): Promise<number> {
  const result = await runWork(argv);
  if (result.error) console.error(result.error);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  return result.exit;
}
