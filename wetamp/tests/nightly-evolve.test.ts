import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { serializeNodeStateRecord } from '../../packages/workflows/src/node-record-serialization';
import { lock } from '../src/archon';
import { main, maintenanceTick } from '../src/cli';
import { analyze, collect, evolve, type Sample } from '../src/nightly-evolve';
import { buildReport } from '../src/report';
import type { Ledger } from '../src/ledger';
import { capNightlyOperations, nightlyReflection } from '../src/memory-reflect';
import { maintainLessons, memoryState, memoryWrite, type Lesson } from '../src/memory';

const homes: string[] = [];
const originalHome = process.env.SUPERAGENT_HOME;
const originalArchon = process.env.ARCHON_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.SUPERAGENT_HOME;
  else process.env.SUPERAGENT_HOME = originalHome;
  if (originalArchon === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchon;
  for (const path of homes.splice(0)) removeTempTree(path);
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), 'nightly-'));
  homes.push(path);
  process.env.SUPERAGENT_HOME = path;
  process.env.ARCHON_HOME = join(path, 'archon');
  return path;
};
const at = (day: number, hour = 2, minute = 0) => +new Date(2026, 10, day, hour, minute);
const sample = (id: string, repo: string, first: number): Sample => ({
  id,
  at: at(18, 1),
  repo,
  first,
  packages: 1,
  groups: [],
  reasons: [],
  tokens: null,
  tokenPackages: 0,
  measuredTokenPackages: 0,
  elapsed: null,
  elapsedPackages: 0,
});

test('local 02:00, same-day claim, restart, following day, and explicit entry share the lock', () => {
  const sa = home(),
    days: number[] = [];
  const task = (now: number) =>
    evolve(sa, now, () => {
      days.push(now);
      return [];
    });
  const tasks = { memory: () => {}, gc: () => [], scratch: () => [], nightly: task };
  expect(
    evolve(sa, at(18, 1, 59), () => {
      throw Error('early');
    })
  ).toBe('not-due');
  const held = lock(join(sa, 'maintenance.lock'));
  if (!held.ok) throw Error('lock');
  try {
    expect(maintenanceTick(sa, tasks, true)).toMatchObject({
      maintenance: { skipped: 'maintenance_running' },
    });
  } finally {
    held.release();
  }
  task(at(18, 10));
  task(at(18, 12));
  task(at(19));
  evolve(
    sa,
    at(20, 1),
    () => {
      days.push(at(20, 1));
      return [];
    },
    true
  );
  expect(days).toEqual([at(18, 10), at(19), at(20, 1)]);
});

test('one Archon launch fails while the night report and other maintenance tasks survive', () => {
  const sa = home(),
    calls: string[] = [];
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => sample('bad' + i, 'bad', 0)),
    ...Array.from({ length: 30 }, (_, i) => sample('good' + i, 'good', 1)),
  ];
  const tasks = {
    memory: () => calls.push('memory'),
    gc: () => {
      calls.push('gc');
      return [];
    },
    scratch: () => {
      calls.push('scratch');
      return [];
    },
    nightly: () =>
      evolve(
        sa,
        at(18),
        () => rows,
        false,
        (input, source) =>
          nightlyReflection(
            input,
            args => {
              calls.push(source + ':' + args.slice(0, 3).join(' '));
              throw Error('offline');
            },
            source
          )
      ),
  };
  maintenanceTick(sa, tasks);
  maintenanceTick(sa, tasks);
  const path = join(sa, 'evolution', '2026-11-18.json');
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    model: { called: true, status: 'failed' },
    models: { local: { status: 'failed' }, remote: { status: 'failed' } },
    candidates: [],
  });
  expect(calls).toEqual([
    'memory',
    'gc',
    'scratch',
    'remote:workflow run memory-reflect',
    'local:workflow run memory-reflect',
    'memory',
    'scratch',
  ]);
});

test('small groups are excluded and missing receipts stay unknown', () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => sample('small' + i, 'small', 0)),
    ...Array.from({ length: 5 }, (_, i) => ({
      ...sample('bad' + i, 'bad', 0),
      reasons: ['review_inconsistent'],
    })),
    ...Array.from({ length: 30 }, (_, i) => sample('good' + i, 'good', 1)),
    { ...sample('missing', 'bad', 0), first: null, tokenPackages: 1 },
  ];
  const result = analyze(rows, at(18));
  expect(result.attribution.map(r => r.group)).toEqual(['repo:bad']);
  expect(result.failure_reasons).toMatchObject({
    denominator: 9,
    reasons: { review_inconsistent: { count: 5, share: 5 / 9 } },
  });
  expect(result.last_24h.first).toMatchObject({ numerator: 30, denominator: 39, eligible: 40 });
  expect(result.last_24h.tokens).toMatchObject({ value: null, denominator: 0, eligible: 1 });
});

// prettier-ignore
test('nightly windows use report receipts and separate operator and superseded cancellations', () => {
  const sa = home(), archon = process.env.ARCHON_HOME!;
  mkdirSync(archon);
  const db = new Database(join(archon, 'archon.db'));
  db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, started_at TEXT, completed_at TEXT, output_root TEXT, metadata TEXT)');
  db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, created_at TEXT, event_order INTEGER, data TEXT)');
  const plan = join(sa, 'plan.json'), started_at = new Date(at(18, 1)).toISOString();
  const completed_at = new Date(at(18, 1, 10)).toISOString();
  const packages = ['core', 'missing'].map(id => ({ id, size: 'M', risk: 'G1', scope: { write: ['src/a.ts'] }, accept: [] }));
  const repo = '/repos/nightly-fixture';
  writeFileSync(plan, JSON.stringify({ repo, packages }));
  const dispatch = join(sa, 'gen/pass');
  mkdirSync(dispatch, { recursive: true });
  writeFileSync(join(dispatch, 'plan.json'), JSON.stringify({ packages: [{ ...packages[0], max_net_lines: 0 }] }));
  writeFileSync(join(dispatch, 'run-config.yaml'), JSON.stringify({ aliases: { '@sa-coder': { model: 'dispatch-model' } } }));
  const ledgers: Ledger[] = ['pass', 'fail', 'operator', 'superseded', 'replaced', 'successor'].map(id => ({
    run_id: id, archon_run_id: id, plan, gen_dir: sa, repo, workflow: 'fixture', started_at,
    ...(id === 'pass' ? { delivery_result: { status: 'integrated', integrated: 'head' } } : {}),
    ...(['operator', 'superseded'].includes(id) ? { intervention_events: [{ action: 'cancel', ok: true, reason: id, at: completed_at, source: 'cli' }] } : {}),
    ...(id === 'successor' ? { adoptions: [{ from: 'replaced', to: id, reason: 'plan_replacement', at: completed_at }] } : {}),
  }) as Ledger);
  const statuses = ['completed', 'failed', 'cancelled', 'cancelled', 'failed', 'running'] as const;
  for (const [i, l] of ledgers.entries()) db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?)', [l.run_id, statuses[i], started_at, completed_at, sa, '{}']);
  const event = serializeNodeStateRecord({
    runId: 'pass', path: 'code-core', node: { id: 'code-core', kind: 'agent', source: { kind: 'inline' } },
    invocation: { id: 'i', startedAt: started_at, loopPath: [] }, attempt: { id: 'a', startedAt: started_at },
    binding: { provider: 'codex', model: { requested: 'm', resolved: { source: 'unavailable', reason: 'not_reported' } } },
    timing: { startedAt: started_at, durationMs: 1 }, accounting: 'node', lifecycle: { status: 'completed' },
    spend: { tokens: { source: 'provider', value: { input: 30, cacheRead: 10, output: 4 } },
      costUsd: { source: 'unavailable', reason: 'not_reported' }, stopReason: { source: 'unavailable', reason: 'not_reported' }, numTurns: { source: 'unavailable', reason: 'not_reported' } },
  });
  db.run('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)', ['pass', event.event_type, event.step_name, completed_at, 1, JSON.stringify(event.data)]);
  db.run('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)', ['successor', event.event_type, event.step_name, completed_at, 1, JSON.stringify({
    ...event.data, spend: { ...event.data.spend, tokens: { source: 'provider', value: { input: 0, output: 0 } } },
  })]);
  db.close();
  const art = join(sa, 'artifacts/runs/pass');
  const activeArt = join(sa, 'artifacts/runs/successor');
  const decision = JSON.stringify({ decision: { kind: 'advance', reason: null, debt: [], evidence: [] } });
  for (const dir of [art, activeArt]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(art, 'gate-m1-r1.json'), decision);
  writeFileSync(join(activeArt, 'verify-core.json'), decision);
  const report = buildReport(ledgers);
  const first = (report.consolidation as { first_pass_rate: unknown }).first_pass_rate;
  const rows = collect(ledgers, at(18));
  expect(rows.find(row => row.id === 'pass')?.groups).toEqual(['size:M', 'risk:G1', 'accept_count:0', 'max_net_lines:yes', 'tag:ts-cli', 'write_globs:1-3', 'model:dispatch-model']);
  const weekly = analyze(rows, at(18)).last_7d;
  expect(first).toMatchObject({ passed: 1, known: 2, ratio: 0.5, excluded: { operator: 1, superseded: 2 } });
  expect(weekly.first).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, excluded: { operator: 1, superseded: 2 } });
  const tokens = (report.token_value as { packages: { tokens: unknown }[] }).packages.map(p => p.tokens);
  expect(tokens).toEqual([24, 'unknown', 0]);
  expect(weekly.tokens).toMatchObject({ eligible: 3, denominator: 2, value: (Number(tokens[0]) + Number(tokens[2])) / 2 });
  const elapsed = (report.measurement as Record<string, { wall_clock_ms: number }>)['pass/pass'].wall_clock_ms;
  expect(weekly.elapsed.value).toBe(elapsed / 2);
  expect(collect([{ ...ledgers[0], repo: sa }], at(18))).toEqual([]);
  expect(collect([{ ...ledgers[0], repo: '/tmp/sa-scratch/probe' }], at(18))).toEqual([]);
  writeFileSync(join(sa, 'engine.json'), '{"fake":true}');
  expect(collect([ledgers[0]], at(18))).toEqual([]);
});

// prettier-ignore
test('empty, invalid and filtered reflection output retains diagnostics and survives a repeat claim', () => {
  const sa = home();
  const rows = [...Array.from({ length: 5 }, (_, i) => sample('bad' + i, sa, 0)),
    ...Array.from({ length: 30 }, (_, i) => sample('good' + i, 'good', 1))];
  const query = (args: string[]) => {
    if (args[1] === 'run') return { ok: true, runId: args.at(-1)!.includes('local') ? 'local' : 'remote' };
    const local = args[2] === 'local';
    const detail = local ? { failure_kind: 'output_contract', error: "Node 'reflect': output_format declared but the provider's structured output failed schema validation: invalid type" } :
      { structured_output: { operations: [add(sa, 'no matching episode')] } };
    return { id: args[2], output_root: sa, status: local ? 'failed' : 'completed', events: [{ event_type: local ? 'node_failed' : 'node_completed', step_name: 'reflect',
      data: { ...detail, binding: { model: { resolved: { source: 'provider', value: 'fixture-model' } } }, spend: { tokens: { source: 'provider', value: { input: 12, output: 3 } } } } }] };
  };
  const path = evolve(sa, at(18), () => rows, false, (input, source) => nightlyReflection(input, query, source, () => {}));
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    candidates: [], models: {
      remote: { status: 'all_filtered', proposed: 1, produced: 0, filtered: { evidence_missing: 1 },
        model: 'fixture-model', tokens: 15, evidence_path: join(sa, 'artifacts/runs/remote') },
      local: { status: 'schema_invalid', proposed: 0, produced: 0 },
    },
  });
  const empty = evolve(sa, at(19), () => rows, false, () => ({ output: { operations: [], reason: '无可复用经验' } }));
  expect(JSON.parse(readFileSync(empty, 'utf8'))).toMatchObject({ model: { status: 'no_output' }, models: { remote: { reason: '无可复用经验' } } });
  expect(evolve(sa, at(19), () => { throw Error('已认领'); })).toBe('already-claimed');
  const missing = evolve(sa, at(20), () => rows, false, (_input, source) => source === 'remote' ? {} : { output: null });
  expect(JSON.parse(readFileSync(missing, 'utf8'))).toMatchObject({
    models: { remote: { status: 'no_output', tokens: null }, local: { status: 'schema_invalid', tokens: null } },
  });
  mkdirSync(join(sa, 'memory'), { recursive: true });
  const held = lock(join(sa, 'memory/store.lock'));
  if (!held.ok) throw Error('lock');
  try {
    const busy = evolve(sa, at(21), () => rows, false, () => ({ output: { operations: [add(sa, 'blocked')] } }));
    expect(JSON.parse(readFileSync(busy, 'utf8'))).toMatchObject({
      model: { status: 'failed' }, models: { remote: { status: 'failed', reason: '经验写入失败', produced: 0 } },
    });
  } finally { held.release(); }
});

test('both workflow aliases contribute distinct trial candidates, alternating up to three', () => {
  expect(capNightlyOperations({ operations: [1, 2, 3, 4], reason: null })).toEqual({
    operations: [1, 2, 3],
    reason: null,
  });
  expect(capNightlyOperations({ operations: null })).toEqual({ operations: null });
  const sa = home(),
    dir = join(sa, 'memory', 'episodes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'bad0.json'),
    JSON.stringify({
      id: 'bad0',
      project: sa,
      tag: 'cli',
      category: 'project',
      reasons: [],
      incidents: [],
    })
  );
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => sample('bad' + i, sa, 0)),
    ...Array.from({ length: 30 }, (_, i) => sample('good' + i, 'good', 1)),
  ];
  const query = (args: string[]) => {
    if (args[1] === 'run') {
      const alias = JSON.parse(readFileSync(args.at(-1)!, 'utf8')).aliases['@sa-coder'];
      if (alias.provider === 'pi') expect(alias.model).toBe('splash/qwen3.8-27b');
      return { ok: true, runId: alias.provider === 'pi' ? 'local' : 'remote' };
    }
    const ids = args[2] === 'local' ? [1, 4, 5, 6] : [1, 2, 3, 4];
    const operations = ids.map(i => add(sa, 'action ' + i));
    const data = { structured_output: { operations } };
    const event = { event_type: 'node_completed', step_name: 'reflect', data };
    return { status: 'completed', events: [event] };
  };
  evolve(
    sa,
    at(18),
    () => rows,
    false,
    (input, source) => nightlyReflection(input, query, source, () => {})
  );
  const lessons = memoryState().lessons;
  expect(lessons.map(l => [l.do, l.source])).toEqual([
    ['action 1', 'remote'],
    ['action 4', 'local'],
    ['action 2', 'remote'],
  ]);
  expect(lessons.every(l => l.status === 'trial' && l.curated_at)).toBe(true);
  const local = memoryState().lessons.find(l => l.source === 'local')!;
  const scope = { project: sa, tag: 'cli' };
  const packages = [
    { ...scope, ids: [local.id], passed: true, control: false },
    { ...scope, ids: [], passed: false, control: true },
  ];
  maintainLessons({ id: 'trial', packages }, at(18, 3));
  const reflect = (_input: string, source: string) => {
    if (source === 'local') throw Error('offline');
    return { output: { operations: [add(sa, 'remaining')] } };
  };
  const next = evolve(sa, at(19), () => rows, false, reflect);
  expect(JSON.parse(readFileSync(next, 'utf8'))).toMatchObject({
    models: { local: { status: 'failed' }, remote: { status: 'produced' } },
    candidates: [{ do: 'remaining', source: 'remote' }],
    sources: {
      local: { selected: 1, pass_rate_delta: 1 },
      remote: { selected: 3, pass_rate_delta: null },
    },
  });
});

const add = (scope: string, action: string) => {
  const evidence = ['bad0'];
  const lesson = {
    tier: 'project' as const,
    scope,
    when: 'trigger',
    do: action,
    dont: '',
    why: '',
    evidence,
    mechanizable: false,
  };
  return { op: 'ADD', lesson };
};
const stored = (scope: string, id: string): Lesson => ({
  ...add(scope, 'old').lesson,
  id,
  tag: 'cli',
  category: 'project',
  reasons: [],
  status: 'trial',
  helpful: 0,
  harmful: 0,
  created_at: '2026-11-17',
  last_hit: '2026-11-17',
});
const importFixture = () => {
  const sa = home(),
    dir = join(sa, 'memory');
  return { sa, log: join(dir, 'lessons.jsonl'), file: join(sa, 'import.json'), dir };
};

test('memory import backs up the original bytes, records merge evidence and is idempotent', () => {
  const { sa, dir, log, file } = importFixture();
  memoryWrite(() => ({ lessons: [stored(sa, 'rep'), stored(sa, 'merged')] }));
  const original = readFileSync(log, 'utf8');
  const row = { id: 'rep', merged_ids: ['merged'], content: 'rewritten' };
  writeFileSync(file, JSON.stringify([row]));
  expect(main(['memory', 'import', file])).toBe(0);
  const backups = () => readdirSync(dir).filter(name => name.endsWith('.bak'));
  expect(backups()).toHaveLength(1);
  expect(readFileSync(join(dir, backups()[0]), 'utf8')).toBe(original);
  const [rep, merged] = memoryState().lessons;
  expect(rep.do).toBe(row.content);
  expect(rep.source).toBe('curated');
  expect(rep.curated_at).toBeTruthy();
  expect(rep.evidence).toEqual(['bad0', 'merged']);
  expect(merged.status).toBe('retired');
  const imported = readFileSync(log, 'utf8');
  expect(main(['memory', 'import', file])).toBe(0);
  expect(readFileSync(log, 'utf8')).toBe(imported);
  expect(backups()).toHaveLength(1);
  maintainLessons({
    id: 'scored',
    packages: [{ project: sa, tag: 'cli', ids: ['rep'], passed: true, control: false }],
  });
  const [scored] = memoryState().lessons;
  const beforeScopeUpdate = readFileSync(log, 'utf8');
  writeFileSync(file, JSON.stringify([{ ...row, applicability: ['python', 'docs'] }]));
  expect(main(['memory', 'import', file])).toBe(0);
  expect(memoryState().lessons[0]).toEqual({ ...scored, applicability: ['docs', 'python'] });
  expect(backups().map(name => readFileSync(join(dir, name), 'utf8'))).toContain(beforeScopeUpdate);
  writeFileSync(file, JSON.stringify([{ ...row, applicability: ['docs', 'python', 'docs'] }]));
  expect(main(['memory', 'import', file])).toBe(0);
  expect(backups()).toHaveLength(2);
  writeFileSync(file, JSON.stringify([row]));
  expect(main(['memory', 'import', file])).toBe(0);
  expect(memoryState().lessons[0]).toEqual({ ...scored, applicability: ['docs', 'python'] });
  expect(backups()).toHaveLength(2);
});

test('memory import rejects overflow before changing the store', () => {
  const { sa, log, file } = importFixture();
  const lessons = Array.from({ length: 31 }, (_, i) => stored(sa, 'l' + i));
  memoryWrite(() => ({ lessons }));
  const original = readFileSync(log, 'utf8');
  const rows = lessons.map(({ id }) => ({ id, merged_ids: [], content: 'new' }));
  writeFileSync(file, JSON.stringify(rows));
  expect(main(['memory', 'import', file])).toBe(1);
  expect(readFileSync(log, 'utf8')).toBe(original);
});
