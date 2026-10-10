import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { ownership, psRows, visible, type Activity } from '../src/board/activity';
import { findSessions, readLive, type Term } from '../src/board/terminals';
import { Frame } from '../src/board/App';
import { unreadableRow } from '../src/board/data';
import { tmp } from './helpers';

const id = '20261010-120000-abcd';
const now = Date.parse('2026-10-10T12:00:00Z');
const owner = createRequire(import.meta.url)('../hooks/live.cjs').owner as (
  interactive: boolean,
  inspect: (pid: number) => string[] | null,
  parent: number
) => { pid: number; tty: string | null } | null;
const rows = psRows(
  [
    '10 1 ttys001 0 01:00 claude',
    '20 1 ttys002 0 01:00 node /bin/codex',
    '21 20 ttys002 0 01:00 /vendor/codex',
    `11 10 ?? 0 00:30 bun /w/wetamp/src/cli.ts wait ${id} --timeout 1500`,
  ].join('\n')
);
const sessions = findSessions(rows);
const term = (pid: number, cwd: string): Term => ({
  pid,
  cwd,
  kind: pid === 10 ? 'claude' : 'codex',
  tty: `ttys00${pid === 10 ? 1 : 2}`,
  tier: 'commander',
  state: 'idle',
  tool: null,
  since_ms: now,
  bound: true,
});
const terms = [term(10, '/w/sinan'), term(20, '/w/xiaopan-translator')];
const launcher = {
  client: 'codex' as const,
  pid: 21,
  tty: 'ttys002',
  cwd: '/w/xiaopan-translator',
};

test('launcher walks to nearest interactive CLI, skipping headless/service ancestors and missing tty', () => {
  for (const cli of ['claude', 'node /bin/codex', 'opencode']) {
    const fixture = new Map([
      [50, ['', '40', '??', 'bun /w/wetamp/src/cli.ts run p']],
      [40, ['', '30', 'ttys001', 'codex exec -m sol PROMPT']],
      [30, ['', '20', 'ttys001', 'claude mcp serve']],
      [20, ['', '10', '??', 'opencode']],
      [10, ['', '1', 'ttys001', cli]],
    ]);
    expect(owner(true, pid => fixture.get(pid) ?? null, 50)).toEqual({ pid: 10, tty: 'ttys001' });
  }
  expect(owner(true, () => null, 50)).toBeNull();
  expect(owner(true, () => ['', '1', '??', 'claude'], 50)).toBeNull();
});

test('recorded launcher wins over watcher; merged codex launcher/native pids bind once', () => {
  expect(ownership({ run_id: id, cwd: '/w/sinan', launcher }, rows, sessions, terms)).toEqual({
    owner: 20,
    inferred: false,
  });
});

test('watcher ancestor wins over cwd, including dead recorded launcher; unrelated argv cannot impersonate watcher', () => {
  const ref = { run_id: id, cwd: '/w/xiaopan-translator', launcher: { ...launcher, pid: 999 } };
  expect(ownership(ref, rows, sessions, terms)).toEqual({ owner: 10, inferred: false });
  const fake = psRows(`50 20 ?? 0 00:10 echo superagent wait ${id}`);
  expect(ownership(ref, fake, sessions, terms)).toEqual({ owner: null, inferred: false });
});

test('watcher accepts flags before the run id without scanning unrelated prose', () => {
  const fixture = new Map(rows);
  fixture.set(11, { ...rows.get(11)!, argv: ['superagent', 'wait', '--timeout', '1500', id] });
  expect(ownership({ run_id: id, cwd: '/w/unrelated' }, fixture, sessions, terms)).toEqual({
    owner: 10,
    inferred: false,
  });
});

test('legacy cwd infers only a unique equal/descendant session with a path boundary', () => {
  for (const cwd of ['/w/xiaopan-translator', '/w/xiaopan-translator/src'])
    expect(ownership({ run_id: 'old', cwd }, rows, sessions, terms)).toEqual({
      owner: 20,
      inferred: true,
    });
  for (const cwd of ['/w/xiaopan-translator-other', '/w/unrelated'])
    expect(ownership({ run_id: 'old', cwd }, rows, sessions, terms)).toEqual({
      owner: null,
      inferred: false,
    });
  expect(
    ownership({ run_id: 'old', cwd: '/w/sinan' }, rows, sessions, [terms[0], term(20, '/w/sinan')])
  ).toEqual({ owner: null, inferred: false });
  expect(
    ownership({ run_id: 'old', cwd: '/w/sinan' }, rows, sessions, [terms[0], term(20, '/w')])
  ).toEqual({ owner: null, inferred: false });
  expect(
    ownership(
      { run_id: 'old', cwd: '/w/sinan', launcher: { ...launcher, pid: 999 } },
      rows,
      sessions,
      terms
    )
  ).toEqual({ owner: null, inferred: false });
});

test('jobs share recorded/wrapper/unique cwd ownership; exited wrapper still uses recorded launcher', () => {
  expect(
    ownership({ run_id: 'job', cwd: '/w/sinan', launcher }, rows, sessions, terms, [999])
  ).toEqual({ owner: 20, inferred: false });
  expect(
    ownership({ run_id: 'job', cwd: '/w/xiaopan-translator' }, rows, sessions, terms, [11])
  ).toEqual({ owner: 10, inferred: false });
});

test('terminal items expire after exactly 30 minutes; nonterminal items remain visible', () => {
  expect(visible(now - 30 * 60_000, now)).toBe(true);
  expect(visible(now - 30 * 60_000 - 1, now)).toBe(false);
  expect(visible(new Date(now - 31 * 60_000).toISOString(), now)).toBe(false);
  expect(visible(null, now)).toBe(true);
  expect(visible(undefined, now)).toBe(false);
});

test('read-only board heartbeat reads never delete old files', () => {
  const dir = tmp();
  const file = join(dir, 'dead.json');
  writeFileSync(
    file,
    JSON.stringify({ pid: 99999999, at: new Date(now - 90_000_000).toISOString(), event: 'Stop' })
  );
  expect(readLive(dir, now, true)).toEqual([]);
  expect(existsSync(file)).toBe(true);
});

test('job exec persists launcher metadata from matching heartbeat; no prompt/argv enters launcher', async () => {
  const root = tmp();
  const bin = join(root, 'bin');
  const home = join(root, 'sa');
  mkdirSync(bin);
  mkdirSync(join(home, 'live'), { recursive: true });
  writeFileSync(
    join(home, 'live', 'claude.json'),
    JSON.stringify({
      pid: process.pid,
      client: 'claude',
      session_id: 'session-fixture',
      cwd: '/w/sinan',
      at: new Date(now).toISOString(),
    })
  );
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "1 ttys001 claude\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nprintf "fcwd\\nn/w/sinan\\n"\n', { mode: 0o755 });
  const p = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../src/cli.ts'),
      'job',
      'exec',
      '--title',
      'fixture',
      '--',
      '/usr/bin/true',
    ],
    {
      env: {
        ...process.env,
        SUPERAGENT_HOME: home,
        ARCHON_HOME: join(home, 'archon'),
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: '' });
  const { readdirSync } = await import('node:fs');
  const [name] = readdirSync(join(home, 'jobs'));
  const record = JSON.parse(readFileSync(join(home, 'jobs', name), 'utf8'));
  expect(record.launcher).toEqual({
    client: 'claude',
    pid: process.pid,
    tty: 'ttys001',
    cwd: '/w/sinan',
    session_id: 'session-fixture',
  });
  expect(record.state).toBe('done');
});

test('pane renders normalized active rows and hides retired jobs/terminals', () => {
  const running = {
    ...unreadableRow(id, ''),
    repo: 'sinan',
    state: 'running',
    nodes: { done: 1, total: 4, current: '中文当前节点'.repeat(20), currentRole: 'coder' },
  };
  const reviewer = {
    ...running,
    run_id: '20261010-120001-abce',
    repo: 'xiaopan-translator',
    nodes: { ...running.nodes, current: 'review', currentRole: 'reviewer' },
  };
  const finished = {
    ...running,
    run_id: '20261010-110000-abcf',
    state: 'completed',
    span: { started_ms: now - 3600000, ended_ms: now - 31 * 60000 },
  };
  const orphan = { ...running, run_id: '20261010-120002-abca' };
  const activity: Activity = {
    terms,
    procs: [],
    remote: [],
    notes: [],
    jobs: [
      {
        id: 'job',
        title: 'old-job',
        cwd: '/w/other',
        kind: 'other',
        model: null,
        card: null,
        log: null,
        wrapper_pid: 1,
        pid: 2,
        started_at: new Date(now - 3600000).toISOString(),
        ended_at: new Date(now - 31 * 60000).toISOString(),
        state: 'done',
        owner: null,
        tier: null,
        guess: false,
      },
    ],
    runs: [
      { run_id: id, cwd: '/w/sinan', owner: 10, inferred: false },
      { run_id: reviewer.run_id, cwd: '/w/xiaopan-translator', owner: 20, inferred: true },
      { run_id: finished.run_id, cwd: '/w/sinan', owner: 10, inferred: false },
      { run_id: orphan.run_id, cwd: '/w/superagent_v2', owner: null, inferred: false },
    ],
  };
  for (const width of [59, 140]) {
    const text = renderToString(
      createElement(Frame, {
        snap: {
          rows: [running, reviewer, finished, orphan],
          at: new Date(now).toISOString(),
          summary: {},
          activity,
        },
        width,
        height: 100,
        now: new Date(now),
      }),
      { columns: width }
    );
    expect(text).toContain('sinan');
    expect(text).toContain('xiaopan');
    expect(text).not.toContain('━ 终端');
    expect(text).not.toContain('old-job');
    expect(text.split('\n').filter(l => Bun.stringWidth(l) > width)).toEqual([]);
  }
});
