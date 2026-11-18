import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { lock } from '../src/archon';
import { maintenanceTick } from '../src/cli';
import { analyze, evolve, type Sample } from '../src/nightly-evolve';
import { capNightlyOperations, nightlyReflection } from '../src/memory-reflect';
import { memoryState } from '../src/memory';

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
        input =>
          nightlyReflection(input, args => {
            calls.push(args.slice(0, 3).join(' '));
            throw Error('offline');
          })
      ),
  };
  maintenanceTick(sa, tasks);
  maintenanceTick(sa, tasks);
  const path = join(sa, 'evolution', '2026-11-18.json');
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    model: { called: true, status: 'failed' },
    candidates: [],
  });
  expect(calls).toEqual([
    'memory',
    'gc',
    'scratch',
    'workflow run memory-reflect',
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

test('the fourth operation is ignored and validated candidates enter the persisted trial pool', () => {
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
  evolve(
    sa,
    at(18),
    () => rows,
    false,
    () => ({
      operations: [1, 2, 3, 4].map(i => ({
        op: 'ADD',
        lesson: {
          tier: 'project',
          scope: sa,
          when: 'when',
          do: 'action ' + i,
          dont: '',
          why: '',
          evidence: ['bad0'],
          mechanizable: false,
        },
      })),
    })
  );
  expect(memoryState().lessons.map(l => [l.do, l.status, l.source, Boolean(l.curated_at)])).toEqual(
    [1, 2, 3].map(i => ['action ' + i, 'trial', 'remote', true])
  );
});
