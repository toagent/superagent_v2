import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { BoardRow, Snapshot } from '../src/board/data';
import {
  assessGeneral,
  collectGenerals,
  generalKey,
  observeGeneral,
  processSnapshot,
  type GeneralObservation,
  type ProcessSnapshot,
} from '../src/stall';

const now = Date.parse('2026-10-30T10:00:00Z'),
  track = trackTempRoots();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
// prettier-ignore
const observation = (x: Partial<GeneralObservation> = {}): GeneralObservation => ({
  run: 'run', node: 'code-core', startedAt: ago(10), coder: true,
  lastActivityAt: ago(1), entries: 'a', mtime: now - 600_000, cpu: 0, ...x,
});
// prettier-ignore
const row = (path: string): BoardRow => ({
  run_id: 'run', repo: path, branch: 'sa/run', state: 'running', exit: 4,
  nodes: { done: 0, total: 1, current: 'code-core', currentRole: 'coder' },
  activeNodes: [{ id: 'code-core', role: 'coder', model: 'gpt', startedAt: ago(10) }],
  working_path: path, started_at: ago(10), span: null, elapsed_s: 600, held: null,
  lastEvent: ago(1), recoveries: 0, auto_retries: 0, console: 'codex',
  evidence: '', plan: '', stale: false,
});
const result = (stdout = '', status = 0, stderr = '') =>
  ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }) as never;

// prettier-ignore
test('assessGeneral tracks progress, idle, stalled episodes, restart, and handoff', () => {
  const idle = assessGeneral(undefined, observation({ cpu: 20 }), now);
  expect(idle).toMatchObject({ state: 'idle', idle_s: 600, waiting_command: true });
  const edited = assessGeneral(idle, observation({ entries: 'b', mtime: now, cpu: 20 }), now + 1000);
  expect(edited).toMatchObject({ state: 'working', idle_s: 0 }); expect(edited.episode).toBeUndefined();
  const idleAgain = assessGeneral(edited, observation({ entries: 'b', mtime: now, cpu: 20 }), now + 301_000);
  const stalled = assessGeneral(idleAgain, observation({ entries: 'b', mtime: now, lastActivityAt: ago(10), cpu: 0 }), now + 302_000);
  expect(stalled.state).toBe('stalled'); expect(stalled.episode?.id).toBe(idleAgain.episode?.id);
  const restarted = assessGeneral(stalled, observation({ startedAt: new Date(now + 303_000).toISOString() }), now + 303_000);
  expect(restarted).toMatchObject({ state: 'working', idle_s: 0 }); expect(restarted.episode).toBeUndefined();
  const fresh = assessGeneral(undefined, observation({ startedAt: ago(1), lastActivityAt: ago(10) }), now);
  expect(fresh.state).toBe('working');
  expect(assessGeneral(restarted, observation({ coder: false }), now + 304_000).state).toBe('handed_back');
});

// prettier-ignore
test('observeGeneral counts scoped untracked/deleted files and uses adopted working_path', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'sa-stall-'))), adopted = join(root, 'adopted');
  mkdirSync(join(adopted, 'src'), { recursive: true }); writeFileSync(join(adopted, 'src/new.ts'), 'x');
  let cwd = '', output = '?? src/new.ts\0 D src/gone.ts\0?? docs/out.md\0';
  const run = ((_name: string, _args: string[], options: { cwd?: string }) => { cwd = options.cwd ?? ''; return result(output); }) as never;
  const processes: ProcessSnapshot = { at: () => ({ cpu: 8, root: { pid: 7, command: 'bun test' } }) };
  const first = observeGeneral(row(adopted), row(adopted).activeNodes![0], ['src/**'], processes, run);
  output = '?? src/new.ts\0 D src/gone.ts\0?? other/out.md\0';
  const outsideChanged = observeGeneral(row(adopted), row(adopted).activeNodes![0], ['src/**'], processes, run);
  expect(cwd).toBe(adopted); expect(first.entries).toBe(outsideChanged.entries); expect(first).toMatchObject({ cpu: 8, root: { pid: 7 } });
  output = 'R  docs/moved.ts\0src/new.ts\0';
  expect(observeGeneral(row(adopted), row(adopted).activeNodes![0], ['src/**'], processes, run).entries).not.toBe(outsideChanged.entries);
  expect(observeGeneral({ ...row(adopted), working_path: null }, row(adopted).activeNodes![0], ['src/**'], processes).error).toContain('working_path');
  expect(observeGeneral(row(adopted), row(adopted).activeNodes![0], ['src/**'], processes, (() => result('', 1, 'bad git')) as never).error).toContain('bad git');
});

// prettier-ignore
test('processSnapshot samples ps/lsof once and sums descendants under the highest root', () => {
  const calls: string[] = [], run = ((name: string) => { calls.push(name); return name === 'ps'
    ? result(' 10 1 3.0 bun token=abc\n 11 10 4.0 child\n 20 1 2.0 other\n')
    : result('p10\nn/work/repo\np20\nn/elsewhere\n'); }) as never;
  const sample = processSnapshot(run), found = sample.at('/work/repo');
  expect(calls).toEqual(['ps', 'lsof']); expect(found).toEqual({ cpu: 7, root: { pid: 10, command: 'bun token=***' } });
  expect(processSnapshot((() => result('', 1)) as never).error).toContain('process observation failed');
});

// prettier-ignore
test('collectGenerals persists current run and maps node scope from the frozen plan', () => {
  const root = track(mkdtempSync(join(tmpdir(), 'sa-stall-home-'))), repo = join(root, 'adopted');
  mkdirSync(join(root, 'runs'), { recursive: true }); mkdirSync(repo); writeFileSync(join(repo, 'core.txt'), 'x');
  const plan = { repo, base_ref: 'dev', deadline: '2099-01-01T00:00:00Z', budget: { weighted_tokens: 1 },
    packages: [{ id: 'core', title: 'core', goal: 'g', scope: { write: ['core.txt'], read_hint: [] }, accept: [], risk: 'G1', size: 'S' }] };
  writeFileSync(join(repo, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(root, 'runs/run.json'), JSON.stringify({ run_id: 'run', archon_run_id: 'archon', gen_dir: root, repo, branch: 'sa/run', workflow: 'wf', plan: 'plan.json' }));
  const oldSa = process.env.SUPERAGENT_HOME, oldArchon = process.env.ARCHON_HOME;
  process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = root;
  try {
    const calls: string[] = [], run = ((name: string) => { calls.push(name); return name === 'ps' || name === 'lsof' ? result('') : result(' M core.txt\0'); }) as never;
    const snap: Snapshot = { at: new Date(now).toISOString(), summary: {}, rows: [row(repo)] };
    const reviewer = { ...snap, rows: [{ ...row(repo), activeNodes: [{ ...row(repo).activeNodes![0], role: 'reviewer' }] }] };
    expect(collectGenerals(reviewer, now, run)).toEqual({}); expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'stall.json'), 'utf8'))).toEqual({ at: new Date(now).toISOString(), runs: {} });
    const general = collectGenerals(snap, now, run), saved = JSON.parse(readFileSync(join(root, 'stall.json'), 'utf8'));
    expect(calls.filter(x => x === 'ps')).toHaveLength(1); expect(calls.filter(x => x === 'lsof')).toHaveLength(1);
    expect(general[generalKey('run', 'code-core')]?.state).not.toBe('unknown');
    expect(saved).toMatchObject({ at: new Date(now).toISOString(), runs: { run: { node: 'code-core' } } });
  } finally {
    if (oldSa) process.env.SUPERAGENT_HOME = oldSa; else delete process.env.SUPERAGENT_HOME;
    if (oldArchon) process.env.ARCHON_HOME = oldArchon; else delete process.env.ARCHON_HOME;
  }
});

test('assessGeneral reads zone-less SQLite node times as UTC', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const sqlite = (iso: string): string => iso.slice(0, 19).replace('T', ' ');
    const fresh = assessGeneral(
      undefined,
      observation({ startedAt: sqlite(ago(1)), lastActivityAt: sqlite(ago(0)), mtime: 0 }),
      now
    );
    expect(fresh).toMatchObject({ state: 'working', idle_s: 60 });
    expect(fresh.episode).toBeUndefined();
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
