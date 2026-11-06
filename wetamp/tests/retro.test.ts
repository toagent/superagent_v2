import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { applyRetro, main, retroHints, validateRetro, type Ledger } from '../src/cli';
import type { Controller } from '../src/coord';
import { responsibilityList } from '../src/resume-card';
import { retroCoverage } from '../src/report';
import { gitRepo } from './helpers';

const roots = trackTempRoots(),
  savedHome = process.env.SUPERAGENT_HOME,
  by = { client: 'codex', pid: 1, generation: 1, session_id: 's' } as Controller;
let home: string;
const tmp = (): string => roots(mkdtempSync(join(tmpdir(), 'retro-')));
beforeEach(() => {
  home = tmp();
  process.env.SUPERAGENT_HOME = home;
  mkdirSync(join(home, 'runs'), { recursive: true });
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.SUPERAGENT_HOME;
  else process.env.SUPERAGENT_HOME = savedHome;
});
const ledger = (id = 'r'): Ledger => ({
  run_id: id,
  archon_run_id: id,
  repo: home,
  controller: by,
  gen_dir: join(home, 'gen', id),
  plan: join(home, 'plan.json'),
  branch: `sa/${id}`,
  workflow: `sa-${id}`,
  console: 'codex',
  started_at: '2026-11-06T00:00:00Z',
  transcript: '',
  log: '',
});

test('retro validates entry count, empty values, and Unicode code-point limit', () => {
  expect(validateRetro([' a ', 'b', 'c'], ['好'])).toEqual({
    effect: ['a', 'b', 'c'],
    improve: ['好'],
  });
  expect(() => validateRetro(['a', 'b', 'c', 'd'], ['x'])).toThrow('1-3');
  expect(() => validateRetro([''], ['x'])).toThrow('must not be empty');
  expect(validateRetro(['你'.repeat(200)], ['好'.repeat(200)]).effect[0]).toHaveLength(200);
  expect(() => validateRetro(['你'.repeat(201)], ['好'])).toThrow(
    '--effect exceeds 200 characters by 1'
  );
  expect(() => validateRetro(['你'], ['好'.repeat(100), '好'.repeat(101)])).toThrow(
    '--improve exceeds 200 characters by 1'
  );
});

test('retro revision keeps five prior versions and derived roles cannot write', () => {
  const value = ledger();
  expect(() => applyRetro(value, { effect: ['x'], improve: ['y'] }, by, false)).toThrow(
    'not terminal'
  );
  for (let revision = 1; revision <= 7; revision++)
    applyRetro(
      value,
      { effect: [`e${revision}`], improve: [`i${revision}`] },
      by,
      true,
      `2026-11-06T00:00:0${revision}Z`
    );
  expect(value.retro?.revision).toBe(7);
  expect(value.retro_history?.map(item => item.revision)).toEqual([2, 3, 4, 5, 6]);
  writeFileSync(join(home, 'runs', 'r.json'), JSON.stringify(value));
  process.env.SUPERAGENT_ROLE = 'general';
  try {
    expect(() => main(['retro', 'r', '--effect', 'x', '--improve', 'y'])).toThrow('派生会话');
  } finally {
    delete process.env.SUPERAGENT_ROLE;
  }
});

test('retro hints use the canonical repository, five recent runs, deduplication, and limit', () => {
  const repo = gitRepo(tmp());
  for (let i = 0; i < 6; i++) {
    const value = {
      ...ledger(`r${i}`),
      repo,
      retro: {
        at: `2026-11-06T00:00:0${i}Z`,
        by,
        effect: ['ok'],
        improve: i > 3 ? ['same', `i${i}`] : [`i${i}`],
        revision: 1,
      },
    };
    writeFileSync(join(home, 'runs', `r${i}.json`), JSON.stringify(value));
  }
  expect(retroHints(repo)).toEqual([
    { run_id: 'r5', improve: 'same' },
    { run_id: 'r5', improve: 'i5' },
    { run_id: 'r4', improve: 'i4' },
  ]);
});

test('terminal missing retro is a controller responsibility and report coverage counts it', () => {
  writeFileSync(
    join(home, 'heartbeat.json'),
    JSON.stringify({ marshals: [{ owner: by, waiting: [] }] })
  );
  const pending: Ledger = { ...ledger(), retro_required: true };
  writeFileSync(join(home, 'runs', 'r.json'), JSON.stringify(pending));
  const terminal = () => new Map([['r', 'completed']]);
  expect(responsibilityList('s', terminal)).toMatchObject([{ id: 'r', waiting_for: '待复盘' }]);
  pending.retro = { at: '', by, effect: ['ok'], improve: ['next'], revision: 1 };
  writeFileSync(join(home, 'runs', 'r.json'), JSON.stringify(pending));
  expect(responsibilityList('s', terminal)).toEqual([]);
  expect(
    retroCoverage([
      { ledger: pending, run: { id: 'r', status: 'completed' } },
      { ledger: ledger('active'), run: { id: 'active', status: 'running' } },
    ])
  ).toEqual({ with_retro: 1, terminal: 1 });
});
