import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import { expect, spyOn, test } from 'bun:test';
import * as transport from '../src/archon';

test('targeted batch query reads only requested database runs', async () => {
  const root = tmp(),
    savedBin = process.env.SA_ARCHON_BIN,
    savedHome = process.env.ARCHON_HOME;
  delete process.env.SA_ARCHON_BIN;
  process.env.ARCHON_HOME = root;
  const db = new Database(join(root, 'archon.db'));
  db.exec(`
    CREATE TABLE remote_agent_workflow_runs (
      id TEXT PRIMARY KEY, workflow_name TEXT, conversation_id TEXT, codebase_id TEXT,
      status TEXT, outcome TEXT, user_message TEXT, metadata TEXT, parent_conversation_id TEXT,
      parent_run_id TEXT, adopted_from_run_id TEXT, started_at TEXT, completed_at TEXT,
      last_activity_at TEXT, working_path TEXT, user_id TEXT, output_root TEXT,
      checkout_baseline TEXT, origin TEXT
    );
    CREATE TABLE remote_agent_workflow_events (
      id TEXT PRIMARY KEY, workflow_run_id TEXT, event_type TEXT, step_index INTEGER,
      step_name TEXT, data TEXT, created_at TEXT, event_order INTEGER
    );
  `);
  const insert = db.query(`INSERT INTO remote_agent_workflow_runs VALUES
    (?, 'targeted', NULL, NULL, 'completed', NULL, '', '{}', NULL, NULL, NULL,
     '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:01.000Z',
     '2026-10-30T00:00:01.000Z', NULL, NULL, NULL, NULL, '{}')`);
  for (const id of ['r-1', 'r-2', 'extra']) insert.run(id);
  db.close();
  try {
    const runs = await transport.getRunsAsync(['r-2', 'missing'], root, { timeoutMs: 1000 });
    expect([...runs.keys()]).toEqual(['r-2']);
    expect(runs.get('r-2')).toMatchObject({ id: 'r-2', status: 'completed', nodes: [] });
  } finally {
    const { closeDatabase } = await import('../../packages/core/src/db/connection');
    await closeDatabase();
    if (savedBin === undefined) delete process.env.SA_ARCHON_BIN;
    else process.env.SA_ARCHON_BIN = savedBin;
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
  }
});

test('worker launches clear CLI routing identity while queries preserve it', async () => {
  const root = tmp(),
    bin = join(root, 'wetamp', 'bin', 'archon'),
    launch = join(root, 'launch'),
    query = join(root, 'query'),
    detached = join(root, 'detached'),
    saved = { ...process.env };
  mkdirSync(join(root, 'wetamp', 'bin'), { recursive: true });
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s|%s' "\${SA_SERVED_RUN-x}" "\${SA_HISTORICAL_RUN-x}" > "$3"\n`,
    { mode: 0o755 }
  );
  Object.assign(process.env, {
    SA_ARCHON_BIN: bin,
    SA_SERVED_RUN: 'served',
    SA_HISTORICAL_RUN: 'historical',
    SUPERAGENT_HOME: join(root, 'sa'),
  });
  try {
    transport.archon(['workflow', 'run', launch, '--detach']);
    transport.archon(['workflow', 'status', query]);
    transport.archonDetached(
      ['workflow', 'wake', detached],
      join(root, 'detached.log'),
      undefined,
      false,
      root
    );
    for (let i = 0; i < 100 && !existsSync(detached); i++) await Bun.sleep(20);
    expect(readFileSync(launch, 'utf8')).toBe('|');
    expect(readFileSync(detached, 'utf8')).toBe('|');
    expect(readFileSync(query, 'utf8')).toBe('served|historical');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('error excerpts preserve the first line and stack tail within the limit', () => {
  const first =
    'TypeError: require() async module "/workspace/wetamp/src/cli.ts" is unsupported. use "await import()" instead.';
  const error =
    first + '\n' + '    at main (/workspace/wetamp/src/cli.ts:530:12)\n'.repeat(30) + 'Bun v1.4.3';
  for (const limit of [200, 400]) {
    const excerpt = transport.errorExcerpt(error, limit);
    expect(excerpt).toStartWith(first);
    expect(excerpt).toEndWith('Bun v1.4.3');
    expect(excerpt).toContain('…');
    expect(excerpt.length).toBeLessThanOrEqual(limit);
  }
  expect(transport.errorExcerpt('  short error\n')).toBe('short error');
  expect(transport.errorExcerpt('')).toBe('');
  expect(transport.errorExcerpt('x'.repeat(200), 200)).toBe('x'.repeat(200));
  expect(transport.errorExcerpt('x'.repeat(500), 200).length).toBe(200);
  expect(transport.tail('abcdef', 3)).toBe('def');
});

test('native wait enforces bounded transport and rejects broken notifications', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
    exitCode: 3,
    stdout: Buffer.from(
      JSON.stringify({
        ok: true,
        action: 'wait',
        runId: 'r',
        result: 'deadline',
        observedStatus: 'running',
      })
    ),
    stderr: Buffer.from('attached'),
  } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(transport.waitNotification('r', '/tmp', 60)).toMatchObject({ kind: 'deadline' });
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({
      timeout: 60_000 + transport.QUERY_TIMEOUT_MS,
    });
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['wait', '--timeout', '60']));
    expect(transport.waitNotification('r', '/tmp', 0.1251)).toMatchObject({ kind: 'deadline' });
    expect(spawn.mock.calls[1]?.[1]).toMatchObject({ timeout: 126 + transport.QUERY_TIMEOUT_MS });
    expect(spawn.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(['--timeout', '0.1251']));
    for (const seconds of [0, -1, NaN, Infinity, Number.MAX_VALUE])
      expect(() => transport.waitNotification('r', '/tmp', seconds)).toThrow('positive finite');
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const result of ['attention', 'owner_lost', 'aborted', 'not_found'] as const) {
      spawn.mockReturnValue({
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            ok: true,
            action: 'wait',
            runId: 'r',
            result,
            ...(result === 'attention'
              ? {
                  attention: {
                    kind: 'stalled_tool_calls',
                    runId: 'r',
                    status: 'running',
                    calls: [],
                  },
                }
              : { observedStatus: 'running' }),
          })
        ),
        stderr: Buffer.alloc(0),
      } as ReturnType<typeof Bun.spawnSync>);
      if (result === 'aborted' || result === 'not_found')
        expect(() => transport.waitNotification('r', '/tmp', 60)).toThrow(result);
      else expect(transport.waitNotification('r', '/tmp', 60)).toMatchObject({ kind: result });
    }
    spawn.mockReturnValue({
      exitCode: -1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof Bun.spawnSync>);
    expect(() => transport.waitNotification('r', '/tmp', 60)).toThrow('timed out after 180s');
    spawn.mockReturnValue({
      exitCode: 1,
      stdout: Buffer.from('{"ok":false,"error":"not_found"}'),
      stderr: Buffer.alloc(0),
    } as ReturnType<typeof Bun.spawnSync>);
    expect(() => transport.waitNotification('r', '/tmp', 1)).toThrow('not_found');
  } finally {
    spawn.mockRestore();
  }
});

test('wait transport allows cold startup and shutdown beyond the former one-second margin', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation(function <
    const In extends Bun.SpawnOptions.Writable = 'ignore',
    const Out extends Bun.SpawnOptions.Readable = 'pipe',
    const Err extends Bun.SpawnOptions.Readable = 'pipe',
  >(
    command:
      | string[]
      | (Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err> & { cmd: string[]; onExit?: never }),
    options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>
  ): Bun.SyncSubprocess<Out, Err> {
    const args = Array.isArray(command) ? command : command.cmd;
    const config = Array.isArray(command) ? options : command;
    const nativeMs = Number(args[args.indexOf('--timeout') + 1]) * 1000;
    // Deterministic lifecycle simulation: no real sleep or run mutation.
    const requiredMs = 2500 + nativeMs + 2500;
    const timedOut = Number(config?.timeout) < requiredMs;
    return {
      exitCode: timedOut ? -1 : 3,
      stdout: Buffer.from(
        timedOut
          ? ''
          : JSON.stringify({
              ok: true,
              action: 'wait',
              runId: 'r',
              result: 'deadline',
              observedStatus: 'running',
            })
      ),
      stderr: Buffer.alloc(0),
    } as Bun.SyncSubprocess<Out, Err>;
  });
  try {
    expect(transport.waitNotification('r', '/tmp', 60)).toMatchObject({ kind: 'deadline' });
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    spawn.mockRestore();
  }
});

test('BYPASS_CAPACITY run counts are observed and launch reservations remain exclusive', () => {
  const savedSa = process.env.SUPERAGENT_HOME;
  const saved = process.env.ARCHON_HOME,
    root = tmp();
  process.env.ARCHON_HOME = root;
  process.env.SUPERAGENT_HOME = root;
  const db = new Database(join(root, 'archon.db'));
  db.exec('create table remote_agent_workflow_runs (status text)');
  try {
    for (const status of [
      'paused',
      'completed',
      'failed',
      'cancelled',
      'pending',
      'running',
      'unknown',
    ]) {
      db.exec('delete from remote_agent_workflow_runs');
      db.query('insert into remote_agent_workflow_runs values (?)').run(status);
      const admission = transport.admitRun();
      expect(admission.ok).toBe(true);
      if (admission.ok) admission.release();
    }
    db.exec('delete from remote_agent_workflow_runs');
    writeFileSync(join(root, 'run-admission.json'), '{}');
    expect(transport.admitRun()).toMatchObject({ ok: false, reason: 'admission_busy' });
  } finally {
    db.close();
    if (savedSa === undefined) delete process.env.SUPERAGENT_HOME;
    else process.env.SUPERAGENT_HOME = savedSa;
    if (saved === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = saved;
  }
});
