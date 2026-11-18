import { afterEach, expect, test } from 'bun:test';
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
import { lock } from '../src/archon';
import { main, maintenanceTick } from '../src/cli';
import { analyze, evolve, type Sample } from '../src/nightly-evolve';
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
  integrated: false,
  sizes: [],
  roles: [],
  reasons: [],
  tokens: null,
  elapsed: null,
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
    ...Array.from({ length: 5 }, (_, i) => sample('bad' + i, 'bad', 0)),
    ...Array.from({ length: 30 }, (_, i) => sample('good' + i, 'good', 1)),
    { ...sample('missing', 'bad', 0), first: null, integrated: true, sizes: ['M'] },
  ];
  const result = analyze(rows, at(18));
  expect(result.attribution.map(r => r.group)).toEqual(['repo:bad']);
  expect(result.last_24h.first).toMatchObject({ numerator: 30, denominator: 39, eligible: 40 });
  expect(result.last_24h.tokens).toMatchObject({ value: null, denominator: 0, eligible: 1 });
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
    return { operations: [add(sa, 'remaining')] };
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
