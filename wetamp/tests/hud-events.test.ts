import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handler } from '../src/web/server';
import { hudEvents, toolKind } from '../src/web/events';
import { tmp } from './helpers';

function fixture() {
  const root = tmp(),
    archon = join(root, 'archon'),
    gen = join(root, 'gen');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(gen, '.archon/workflows/sa-test'), { recursive: true });
  mkdirSync(archon);
  process.env.SUPERAGENT_HOME = root;
  process.env.ARCHON_HOME = archon;
  delete process.env.DATABASE_URL;
  writeFileSync(
    join(gen, '.archon/workflows/sa-test/sa-test.yaml'),
    'nodes:\n  - id: code-one\n    model: "@sa-coder"\n  - id: verify-one\n'
  );
  const db = new Database(join(archon, 'archon.db'));
  db.exec(
    'CREATE TABLE remote_agent_workflow_runs (id TEXT PRIMARY KEY, workflow_name TEXT); CREATE TABLE remote_agent_workflow_events (event_order INTEGER, workflow_run_id TEXT, event_type TEXT, step_name TEXT, data TEXT, created_at TEXT);'
  );
  const register = (run_id = 'delivery', archon_run_id = 'engine') => {
    writeFileSync(
      join(root, `runs/${run_id}.json`),
      JSON.stringify({
        run_id,
        archon_run_id,
        repo: process.cwd(),
        gen_dir: gen,
        branch: 'sa/test',
        workflow: 'sa-test',
      })
    );
    db.query('INSERT INTO remote_agent_workflow_runs VALUES (?, ?)').run(
      archon_run_id,
      `sa-${run_id}`
    );
  };
  register();
  db.query('INSERT INTO remote_agent_workflow_runs VALUES (?, ?)').run(
    'unregistered',
    'sa-missing'
  );
  const add = (seq: number, type: string, step: string | null, data: object = {}, run = 'engine') =>
    db
      .query('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(seq, run, type, step, JSON.stringify(data), new Date().toISOString());
  return { db, add, register };
}

test('event_order pagination is lossless and projects only delivery lifecycle events', () => {
  const { db, add } = fixture();
  try {
    add(1, 'node_started', 'code-one');
    add(2, 'node_skipped', 'code-one');
    add(3, 'node_completed', 'code-one', { tokens: { input: 12 }, duration_ms: 34 });
    add(4, 'node_failed', 'verify-one', {}, 'unregistered');
    add(5, 'workflow_completed', null);
    const first = hudEvents('0', '2'),
      second = hudEvents(first.cursor, '2');
    expect(first).toMatchObject({
      cursor: '3',
      more: true,
      events: [
        { seq: 1, kind: 'node_start', role: 'coder' },
        { seq: 3, kind: 'node_done', tokens: 12, ms: 34 },
      ],
    });
    expect(second).toMatchObject({
      cursor: '5',
      more: false,
      events: [{ seq: 5, kind: 'run_done', role: null }],
    });
    expect([...first.events, ...second.events].map(event => event.seq)).toEqual([1, 3, 5]);
  } finally {
    db.close();
  }
});

test('a run registered after the first page remains reachable', () => {
  const { db, add, register } = fixture();
  try {
    add(1, 'node_started', 'code-one');
    const first = hudEvents('0', '1');
    register('later', 'later-engine');
    add(2, 'workflow_completed', null, {}, 'later-engine');
    expect(hudEvents(first.cursor, '1')).toMatchObject({
      cursor: '2',
      events: [{ seq: 2, run: 'later', kind: 'run_done' }],
    });
  } finally {
    db.close();
  }
});

test('excluded rows still advance the scan cursor', () => {
  const { db, add } = fixture();
  try {
    add(1, 'node_failed', 'verify-one', {}, 'unregistered');
    const page = hudEvents('0', '1');
    expect(page).toMatchObject({ cursor: '1', more: false, events: [] });
    expect(hudEvents(page.cursor, '1').events).toEqual([]);
  } finally {
    db.close();
  }
});

test('tool projection classifies machine names and never serializes tool input', () => {
  const { db, add } = fixture(),
    fake = 'tok' + '_fixture_value',
    path = '/Users/x/secret/file.ts';
  try {
    add(1, 'provider_event', 'code-one', {
      event: { type: 'tool_call', name: 'Edit', rawInput: { path, command: fake } },
    });
    const page = hudEvents('0', '10'),
      serialized = JSON.stringify(page);
    expect(page.events).toEqual([expect.objectContaining({ kind: 'tool', tool: 'edit' })]);
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(fake);
    expect(
      ['exec_command', 'Read', 'mcp__x', 'StructuredOutput', 'spawn_agent', 'unknown'].map(toolKind)
    ).toEqual(['exec', 'read', 'mcp', 'structured', 'subagent', 'other']);
  } finally {
    db.close();
  }
});

test('/sa/events shares authentication, avoids snapshot refresh, and rejects Postgres', async () => {
  process.env.DATABASE_URL = 'postgres://fixture';
  let updates = 0;
  const update = async () => {
    updates++;
  };
  const get = handler(
    39890,
    'fixture',
    () => ({}),
    'http://unused',
    fetch,
    undefined,
    undefined,
    update
  );
  const request = (path: string) =>
    new Request(`http://127.0.0.1:39890${path}`, { headers: { host: '127.0.0.1:39890' } });
  expect((await get(request('/sa/events'))).status).toBe(401);
  const response = await get(request('/sa/events?t=fixture'));
  expect(response.status).toBe(501);
  expect(await response.text()).toContain('Postgres');
  expect(updates).toBe(0);
});
