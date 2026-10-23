import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { Frame } from '../src/board/App';
import { cockpit } from '../src/board/cockpit';
import type { BoardRow, Snapshot } from '../src/board/data';
import { loadActivity, processJobs } from '../src/board/activity';
import type { Job } from '../src/jobs';
import { tmp } from './helpers';

test('a classified running run stays active without a recent event', () => {
  const now = new Date('2026-10-17T12:08:00Z');
  const row = {
    run_id: '20261017-033747-7d8a',
    repo: 'BestIFA',
    state: 'running',
    exit: 4,
    nativeState: 'running',
    lastEvent: '2026-10-17T11:00:00Z',
    activeNodes: [{ id: 'code-c1', role: 'coder', model: 'gpt-6.1-sol' }],
    nodes: { done: 0, total: 1, current: 'code-c1', currentRole: 'coder' },
    started_at: '2026-10-17T10:00:00Z',
    span: { started_ms: Date.parse('2026-10-17T10:00:00Z'), ended_ms: null },
    stale: false,
  } as BoardRow;
  const snap = { at: now.toISOString(), summary: {}, rows: [row] } as Snapshot;

  expect(cockpit(snap, now.getTime()).active.map(run => run.id)).toEqual([row.run_id]);
  const frame = renderToString(createElement(Frame, { snap, width: 80, height: 20, now }));
  expect(frame).toContain('code-c1');
  expect(frame).not.toContain('暂无活跃任务');
});

test('job records reuse unchanged parses and only active jobs probe their owner', async () => {
  const root = tmp(),
    home = join(root, 'home'),
    jobs = join(home, 'jobs'),
    file = join(jobs, 'job.json'),
    saved = process.env.SUPERAGENT_HOME;
  mkdirSync(jobs, { recursive: true });
  const now = new Date('2026-10-23T00:00:00.000Z'),
    unchanged = new Date(100_000);
  const record = (state: Job['state'], title: string): Job => ({
    id: 'job',
    title,
    card: null,
    log: null,
    cwd: root,
    kind: 'codex',
    model: null,
    wrapper_pid: process.pid,
    pid: process.pid,
    started_at: now.toISOString(),
    state,
    ended_at: state === 'done' ? now.toISOString() : undefined,
  });
  try {
    process.env.SUPERAGENT_HOME = home;
    writeFileSync(file, JSON.stringify(record('done', 'a')));
    utimesSync(file, unchanged, unchanged);
    const first = await loadActivity(Date.now(), AbortSignal.abort());
    writeFileSync(file, JSON.stringify(record('done', 'b')));
    utimesSync(file, unchanged, unchanged);
    const cached = await loadActivity(Date.now(), AbortSignal.abort());
    expect(cached.jobHistory?.[0]).toBe(first.jobHistory?.[0]);
    expect(cached.jobHistory?.[0]?.title).toBe('a');
    expect(processJobs(cached.jobHistory ?? [])).toEqual([]);

    writeFileSync(file, JSON.stringify(record('running', 'b')));
    const changed = await loadActivity(Date.now(), AbortSignal.abort());
    expect(changed.jobHistory?.[0]).not.toBe(cached.jobHistory?.[0]);
    expect(changed.jobHistory?.[0]?.title).toBe('b');
    expect(processJobs(changed.jobHistory ?? []).map(j => j.id)).toEqual(['job']);
  } finally {
    if (saved === undefined) delete process.env.SUPERAGENT_HOME;
    else process.env.SUPERAGENT_HOME = saved;
  }
});
