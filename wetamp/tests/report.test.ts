import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../src/plan';
import {
  buildReport,
  deliveryStats,
  engineComparison,
  type EngineRow,
  reportSummary,
  measurementOf,
  callsOf,
  interventionStats,
  rollup,
  jobReceipt,
  requirementCoverage,
  criticalPath,
  demandStats,
  firstPassOf,
  planOf,
  cancellationStats,
} from '../src/report';
import type { Job } from '../src/jobs';
import type { UsageSession } from '../src/usage';
import { archonRunIds } from '../src/archon';
import { main, report as cliReport, type Ledger } from '../src/cli';
import { gitRepo, tmp } from './helpers';
import { WETAMP } from '../src/config';
import { currentDecisions } from '../src/decisions';

const plan = {
  packages: [
    { id: 'core', title: 'core' },
    { id: 'api', title: 'api', milestone: 'm2' },
  ],
} as unknown as Plan;

const ev = (
  type: string,
  node: string,
  data: Record<string, unknown> = {}
): { event_type: string; step_name: string; data: Record<string, unknown> } => ({
  event_type: type,
  step_name: node,
  data: {
    invocation: { startedAt: '2026-10-10T00:00:00.000Z' },
    attempt: { id: `${node}-a`, startedAt: '2026-10-10T00:00:02.000Z' },
    binding: { model: { requested: 'm-req', resolved: { source: 'unavailable' } }, effort: 'high' },
    timing: { durationMs: 1000 },
    spend: { tokens: { source: 'unavailable', reason: 'not_reported' } },
    ...data,
  },
});
const provider = (model: string, value: Record<string, number>): Record<string, unknown> => ({
  binding: {
    model: { requested: model, resolved: { source: 'provider', value: model } },
    effort: 'xhigh',
  },
  spend: { tokens: { source: 'provider', value } },
});

describe('F-22 report', () => {
  test('delivery separates legacy, missing and blocked without mutating ledger evidence', () => {
    const pairs = [
      { run_id: 'legacy', repo: '/repo' },
      {
        run_id: 'missing',
        repo: '/repo',
        delivery: { checkout: '/repo', branch: 'work', head: 'base' },
      },
      {
        run_id: 'blocked',
        repo: '/repo',
        delivery_result: { status: 'blocked', reason: 'dirty\ndetail' },
      },
    ].map(l => ({ ledger: l as Ledger, run: { id: l.run_id, status: 'completed' as const } }));
    const before = JSON.stringify(pairs);
    const stats = deliveryStats(pairs);
    expect(stats.delivery).toEqual({ legacy: 1, missing: 1, blocked: 1 });
    expect(stats.undelivered.map(r => r.status)).toEqual(['legacy', 'missing', 'blocked']);
    expect(stats.undelivered[2].reason).toBe('dirty');
    expect(JSON.stringify(pairs)).toBe(before);
    expect(deliveryStats([{ ...pairs[2], run: new Error('unavailable') }]).undelivered).toEqual([]);
    const summary = reportSummary({
      ...stats,
      usage: { unreadable: [] },
      jobs: { unreadable: [] },
      interventions: {},
      demands: { unknown_runs: [] },
      repo_missing: [],
      unreadable: [],
    });
    expect(summary).toMatchObject(stats);
  });
  test('standalone and historical jobs appear in summary with inferred usage and unknown gaps', () => {
    const root = tmp();
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, {
      SUPERAGENT_HOME: root,
      ARCHON_HOME: root,
      SA_ARCHON_BIN: '/usr/bin/true',
    });
    const session: UsageSession = {
      id: 'job-session',
      client: 'codex',
      model: 'fixture',
      at: '',
      cost: 0.25,
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      reasoning: 0,
      total: 120,
      sessions: 1,
    };
    const job = {
      title: 'standalone',
      card: null,
      log: null,
      cwd: root,
      kind: 'codex',
      model: 'fixture',
      wrapper_pid: process.pid,
      pid: process.pid,
      started_at: new Date().toISOString(),
      state: 'done',
    } satisfies Omit<Job, 'id'>;
    try {
      mkdirSync(join(root, 'jobs'));
      mkdirSync(join(root, 'usage'));
      writeFileSync(
        join(root, 'usage/cache.json'),
        JSON.stringify({ sessions: [session], daily: [] })
      );
      const known = join(root, 'jobs/known.json');
      writeFileSync(known, JSON.stringify({ ...job, id: 'known', session_id: session.id }));
      const before = readFileSync(known, 'utf8');
      const summary = reportSummary(buildReport([]));
      expect(summary).toMatchObject({
        demands: {
          denominator: 0,
          by_request: {},
          unattributed: { jobs: 1, input: 100, fees: 0.25 },
        },
      });
      writeFileSync(join(root, 'jobs/missing.json'), JSON.stringify({ ...job, id: 'missing' }));
      expect(reportSummary(buildReport([]))).toMatchObject({
        demands: {
          denominator: 0,
          unattributed: {
            jobs: 2,
            status: 'unknown',
            input: 'unknown',
            known_tokens: { input: 100 },
            coverage: '1/2',
          },
        },
      });
      expect(readFileSync(known, 'utf8')).toBe(before);
      expect(demandStats([], [], [], [{ ...job, id: 'missing' }])).toMatchObject({
        denominator: 0,
        by_request: {},
        unattributed: { input: 'unknown', fees: 'unknown', coverage: '0/1' },
      });
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  test('cached inferred job ownership is reused and conflicting demand claims stay unknown', () => {
    const session: UsageSession = {
      id: 'session',
      client: 'codex',
      model: null,
      at: '',
      cost: 1,
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      reasoning: 0,
      total: 120,
      sessions: 1,
      owner: {
        client: 'codex',
        role: null,
        model: null,
        cwd: null,
        kind: 'inferred',
        job_id: 'old',
      },
    };
    const jobs = [{ id: 'old', kind: 'codex' }] as Job[];
    expect(demandStats([], [], [session], jobs)).toMatchObject({
      denominator: 0,
      by_request: {},
      unattributed: { jobs: 1, input: 100, fees: 1, coverage: '1/1' },
    });
    const conflict = {
      id: 'other',
      kind: 'codex',
      request_ref: 'other',
      session_id: session.id,
    } as Job;
    const demands = demandStats([], [], [session], [...jobs, conflict]);
    for (const ref of ['other'])
      expect(demands).toMatchObject({
        by_request: {
          [ref]: {
            jobs: { inferred: 0, unknown: 1 },
            investment: { input: 'unknown', fees: 'unknown' },
          },
        },
      });
    expect(jobs[0]!.request_ref).toBeUndefined();
  });

  test('report CLI defaults to summary with or without --json; --full preserves details', () => {
    const root = tmp(),
      keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(k => process.env[k]),
      log = console.log;
    Object.assign(process.env, {
      SUPERAGENT_HOME: root,
      ARCHON_HOME: root,
      SA_ARCHON_BIN: '/usr/bin/true',
    });
    try {
      for (const flags of [[], ['--json'], ['--full'], ['--full', '--json']]) {
        let output = '';
        console.log = (...args: unknown[]) => {
          output += args.join('');
        };
        expect(main(['report', ...flags])).toBe(0);
        const report = JSON.parse(output) as Record<string, unknown>;
        for (const key of [
          'measurement',
          'provider_timing',
          'critical_path',
          'requirements',
          'decisions',
          'slow_nodes',
        ])
          expect(key in report).toBe(flags.includes('--full'));
        expect('receipts' in (report.usage as Record<string, unknown>)).toBe(
          flags.includes('--full')
        );
        if (!flags.includes('--full'))
          expect(report).toMatchObject({
            unreadable: { runs: 0, usage: 0, jobs: 0 },
            next_steps: expect.any(Array),
          });
      }
      mkdirSync(join(root, 'runs'));
      writeFileSync(join(root, 'runs', 'broken.json'), '{');
      for (const flags of [[], ['--full']]) expect(main(['report', ...flags])).toBe(1);
    } finally {
      console.log = log;
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  test('summary counts unknown by normalized field, excluding n/a and preserving unreadable counts', () => {
    const report = {
      runs: 2,
      metrics: {},
      cancellations: {},
      interventions: { by_run: {} },
      demands: { unknown_runs: ['missing'] },
      repo_missing: [],
      unreadable: ['bad'],
      jobs: { unreadable: ['job'], phase_coverage: {} },
      usage: { total: { input: 'unknown' }, unreadable: ['generation'] },
      measurement: { r: { nodes: [{ explore_ratio: 'n/a' }, { explore_ratio: 'unknown' }] } },
    };
    expect(reportSummary(report)).toMatchObject({
      unknown_counts: { 'measurement.*.nodes[].explore_ratio': 1, 'usage.total.input': 1 },
      unreadable: { runs: 1, usage: 1, jobs: 1 },
      demands: { unknown_runs: 1 },
    });
  });

  test('measurement uses explicit node types, never names or missing provider evidence, for n/a', () => {
    const run = { id: 'r', status: 'completed' } as Parameters<typeof measurementOf>[0];
    const rows = [
      ev('node_completed', 'code-looking-script', {
        node: { id: 'script', kind: 'exec', runtime: 'bun' },
        binding: {},
      }),
      ev('node_completed', 'verify-looking-agent', {
        node: { id: 'ai', kind: 'agent', source: { kind: 'inline' } },
      }),
      ev('node_completed', 'environment', { binding: {} }),
      ev('node_failed', 'legacy', { type: 'bash', binding: {}, attempt: undefined }),
    ];
    const nodes = measurementOf(run, rows, null).nodes;
    for (const key of [
      'cmds',
      'explore_ratio',
      'mcp_calls',
      'model_turns',
      'think_gap_ms',
    ] as const)
      expect(nodes.map(n => n[key])).toEqual(['n/a', 'unknown', 'unknown', 'n/a']);
    expect(nodes[0]?.cumulative_ms).toBe('unknown');
    const contradictory = ev('provider_event', 'code-looking-script', {
      attemptId: 'code-looking-script-a',
      seq: 1,
      observedAt: '2026-10-10T00:00:00Z',
      event: { type: 'agent_message_chunk', text: 'fixture' },
    });
    expect(measurementOf(run, [rows[0]!, contradictory], null).nodes[0]?.explore_ratio).toBe(
      'unknown'
    );
  });

  test('measure UTC SQL clocks, millisecond skips and overlapping dispatch without counting parallel branches', () => {
    const run = {
      id: 'r',
      status: 'completed',
      started_at: '2026-10-10 00:00:00',
      completed_at: '2026-10-10 00:00:04',
    } as Parameters<typeof criticalPath>[0];
    const terminal = (id: string, start: number, duration: number, skipped = false) =>
      ev(skipped ? 'node_skipped' : 'node_completed', id, {
        invocation: { startedAt: new Date(Date.UTC(2026, 9, 10) + start - 20).toISOString() },
        attempt: { startedAt: new Date(Date.UTC(2026, 9, 10) + start).toISOString() },
        timing: {
          startedAt: new Date(Date.UTC(2026, 9, 10) + start).toISOString(),
          durationMs: duration,
        },
      });
    const events = [
      terminal('code-a', 20, 2000),
      terminal('code-b', 20, 3000),
      terminal('skip', 3020, 0, true),
      terminal('verify', 3020, 1100),
    ];
    const graph = [
      { id: 'code-a' },
      { id: 'code-b' },
      { id: 'skip', depends_on: ['code-b'] },
      { id: 'verify', depends_on: ['code-a', 'skip'] },
    ];
    expect(criticalPath(run, events, graph)).toMatchObject({
      status: 'measured',
      elapsed_ms: 4120,
      critical_path_ms: 4120,
      reconciled_ms: 4120,
      path: ['code-b', 'skip', 'verify'],
    });
    expect(
      criticalPath({ ...run, completed_at: '2026-10-10T00:00:04Z' }, events, graph).status
    ).toBe('unknown');
    expect(criticalPath(run, [...events, events[0]], graph).status).toBe('unknown');
  });

  test('measurement SQL and ISO UTC clocks agree under Asia/Taipei, including segment holds', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Taipei';
    try {
      const run = {
        id: 'r',
        status: 'completed',
        started_at: '2026-10-14 08:02:00',
        completed_at: '2026-10-14T08:02:06Z',
      } as Parameters<typeof measurementOf>[0];
      const terminal = (node: string, start: string, durationMs: number) =>
        ev('node_completed', node, {
          invocation: { id: node, startedAt: start },
          attempt: { id: node, startedAt: start },
          timing: { startedAt: start, durationMs },
        });
      const events = [
        terminal('code-p', '2026-10-14T08:02:00Z', 1000),
        terminal('wait-p', '2026-10-14 08:02:02', 3000),
      ];
      expect(
        measurementOf(
          run,
          events,
          null,
          [],
          [{ id: 'code-p' }, { id: 'wait-p', depends_on: ['code-p'], wait: true }]
        )
      ).toMatchObject({ k1: 'post', wall_clock_ms: 6000, hold_ms: 3000, idle_ms: 2000 });
      expect(measurementOf({ ...run, started_at: '2026-10-14 08:00:00' }, [], null).k1).toBe('pre');
      expect(measurementOf(run, [], null).hold_ms).toBe('unknown');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  test('firstPass is a run count; missing gates stay unknown and repairs cannot pass', () => {
    const root = tmp();
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME'] as const,
      saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root });
    try {
      writeFileSync(
        join(root, 'plan.json'),
        JSON.stringify({ packages: [{ id: 'core', title: 'core', risk: 'G1' }] })
      );
      const ledger = { gen_dir: root, repo: root, run_id: 'r' } as Ledger;
      const run = {
        id: 'r',
        status: 'completed',
        output_root: root,
        nodes: [{ nodeId: 'code-core', state: 'completed' }],
      } as Parameters<typeof criticalPath>[0];
      expect(firstPassOf({ ledger, run })).toBe('unknown');
      expect(firstPassOf({ ledger, run: { ...run, status: 'failed' } })).toBe(false);
      expect(
        firstPassOf({
          ledger,
          run: { ...run, nodes: [{ nodeId: 'fix-m1-r2', state: 'completed' }] },
        })
      ).toBe(false);
      const art = join(root, 'artifacts/runs/r');
      mkdirSync(art, { recursive: true });
      writeFileSync(
        join(art, 'gate-m1-r1.json'),
        JSON.stringify({
          decision: { kind: 'advance', reason: 'accepted', evidence: [], debt: [] },
        })
      );
      expect(firstPassOf({ ledger, run })).toBe(true);
      expect(firstPassOf({ ledger: { ...ledger, auto_retries: [{}] } as Ledger, run })).toBe(false);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  test('cancel summaries prioritize successful events and fall back to deadline', () => {
    const pair = (status: string, events?: Ledger['intervention_events']) =>
      ({
        ledger: { intervention_events: events, reason: 'deadline' },
        run: { status },
      }) as Parameters<typeof cancellationStats>[0][number];
    expect(
      cancellationStats([
        pair('cancelled'),
        pair('cancelled', [
          { action: 'cancel', ok: true, reason: 'superseded', at: '', source: 'cli' },
        ]),
        pair('cancelled', [
          { action: 'cancel', ok: false, reason: 'replaced', at: '', source: 'cli' },
        ]),
        pair('completed'),
      ])
    ).toEqual({ deadline: 2, superseded: 1 });
  });
  // prettier-ignore
  test('attempt receipts sum retries; registered holds exclude inter-node idle and review reasons stay explicit', () => {
    const clock = (s: number) => new Date(Date.UTC(2026,9,14) + s*1000).toISOString();
    const terminal = (attempt: string, start: number, duration: number) => ({ ...ev('node_completed', 'code-core', { invocation: { id: 'i' }, attempt: { id: attempt, startedAt: clock(start) }, timing: { startedAt: clock(start), durationMs: duration } }), created_at: clock(start + (Number.isFinite(duration) ? duration/1000 : 0)) });
    const run = { id: 'r', status: 'failed', started_at: clock(0), completed_at: clock(20) } as Parameters<typeof measurementOf>[0];
    const events = [terminal('a', 0, 3000), terminal('b', 8, 2000),
      { event_type: 'wait_started', step_name: 'wait', created_at: clock(3) }, { event_type: 'wait_completed', step_name: 'wait', created_at: clock(6) }];
    expect(measurementOf(run, [...events, events[0]], null)).toMatchObject({ cumulative_ms: 5000, wall_clock_ms: 20000, hold_ms: 3000, idle_ms: 2000, nodes: [{ execution: 'multiple' }, { execution: 'multiple' }] });
    expect(measurementOf({ ...run, started_at: clock(8) }, events, null).wall_clock_ms).toBe('unknown');
    expect(measurementOf(run, events.slice(0,3), null).hold_ms).toBe('unknown');
    expect(measurementOf(run, [...events, { event_type: 'wait_started', step_name: 'parallel', created_at: clock(2) }, { event_type: 'wait_completed', step_name: 'parallel', created_at: clock(8) }], null)).toMatchObject({ hold_ms: 6000, idle_ms: 0 });
    expect(measurementOf(run, [terminal('a', 0, Infinity)], null).cumulative_ms).toBe('unknown');
    const reviewPlan = { mode: 'strict', packages: [{ id: 'core', risk: 'G2', review: true }] } as Plan;
    const reviews = measurementOf(run, [ev('node_completed', 'review-m1-r1'), ev('node_completed', 'diff-m1-r1', { structured_output: { risk: 'G2', out_of_scope: ['outside'] } })], reviewPlan);
    expect(reviews.nodes[0].review_trigger).toEqual({ reasons: ['plan G2', 'strict', 'review:true'], glob: 'unknown', symlink: 'unknown', gitlink: 'unknown' });
    expect(measurementOf(run, [ev('node_completed', 'review-m1-r1'), ev('node_completed', 'diff-m1-r1', { structured_output: { risk: 'G2', out_of_scope: ['outside'] } })], { packages: [{ id: 'core', risk: 'G1' }] } as Plan).nodes[0].review_trigger?.reasons).toEqual(['runtime:other']);
  });
  // prettier-ignore
  test('readonly report processes 300 runs / 51000 events in under five seconds', () => {
    const root = tmp(), keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const, saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: '' });
    const db = new Database(join(root, 'archon.db'));
    db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, started_at TEXT, completed_at TEXT, metadata TEXT)');
    db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, created_at TEXT, event_order INTEGER, data TEXT)');
    const run = db.prepare('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?)'), event = db.prepare('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => { for (let r = 0; r < 300; r++) {
      run.run(String(r), ['completed', 'failed', 'cancelled'][r % 3], '2026-10-10T00:00:00Z', '2026-10-10T00:10:00Z', '{}');
      for (let seq = 0; seq < 170; seq++) event.run(String(r), 'provider_event', 'code-core', '2026-10-10T00:00:00Z', seq, JSON.stringify({ attemptId: 'a', seq, observedAt: new Date(Date.UTC(2026,9,10) + seq*1000).toISOString(), event: seq % 2 ? { type: 'tool_call_update', toolCallId: String(seq-1), status: 'completed' } : { type: 'tool_call', toolCallId: String(seq), name: 'Bash', rawInput: { command: 'cat file' } } }));
    } })(); db.close();
    const before = readFileSync(join(root, 'archon.db'));
    try {
      const start = performance.now(), report = buildReport([]);
      expect(performance.now() - start).toBeLessThan(5000);
      expect(Object.keys(report.measurement as object)).toHaveLength(300);
      expect(readFileSync(join(root, 'archon.db'))).toEqual(before);
      expect(report.provider_timing).toMatchObject({ '0': [{ cmds: 85, explore_ratio: 1, model_turns: 84 }] });
    } finally { keys.forEach((k,i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
  });

  // prettier-ignore
  test('report reuses its batch for human decisions instead of querying each run again', () => {
    const root = gitRepo(tmp()), keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const, saved = keys.map(k => process.env[k]);
    const argv = process.argv;
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: '' });
    process.argv = [...argv, '--since', '2026-10-11T00:00:00.000Z'];
    mkdirSync(join(root, 'runs')); writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [] }));
    const ledger = { run_id: 'r', archon_run_id: 'engine', repo: root, gen_dir: root, plan: join(root, 'plan.json'), branch: 'task', workflow: 'fixture', console: 'codex', started_at: '2026-10-10T00:00:00Z', transcript: '', log: '' };
    writeFileSync(join(root, 'runs/r.json'), JSON.stringify(ledger));
    const db = new Database(join(root, 'archon.db'));
    db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, started_at TEXT, completed_at TEXT, metadata TEXT)');
    db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, created_at TEXT, event_order INTEGER, data TEXT)');
    db.run("INSERT INTO remote_agent_workflow_runs VALUES ('engine', 'paused', '2026-10-10T00:00:00Z', NULL, '{\"approval\":{\"nodeId\":\"approval-a\",\"pauseId\":\"p\",\"message\":\"Approve?\"}}')"); db.close();
    try {
      expect((cliReport().human_decisions as { decisions: { run: string }[] }).decisions.map(d => d.run)).toEqual(['r']);
    } finally {
      process.argv = argv;
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
  });

  test('terminal decision scans reuse safe cache and recheck failed evidence', () => {
    const root = tmp(),
      keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'DATABASE_URL'] as const,
      saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, DATABASE_URL: '' });
    mkdirSync(join(root, 'runs'));
    const ledger = {
      run_id: 'r',
      archon_run_id: 'engine',
      repo: root,
      gen_dir: root,
      branch: 'task',
      workflow: 'fixture',
      recoveries: [],
    };
    const file = join(root, 'runs/r.json');
    writeFileSync(file, JSON.stringify(ledger));
    const db = new Database(join(root, 'archon.db'));
    db.run(
      'CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, last_activity_at TEXT, completed_at TEXT, metadata TEXT)'
    );
    db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT)');
    db.run(
      "INSERT INTO remote_agent_workflow_runs VALUES ('engine', 'completed', 'now', 'now', '{}')"
    );
    db.close();
    let calls = 0;
    let status: 'completed' | 'failed' = 'completed';
    const query = () => {
      calls++;
      return {
        id: 'engine',
        status,
        output_root: root,
        metadata: {},
        nodes: status === 'failed' ? [{ nodeId: 'verify-core', state: 'failed' }] : [],
      } as unknown as import('../src/archon').RunView;
    };
    try {
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: [] });
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: [] });
      expect(calls).toBe(1);
      writeFileSync(file, JSON.stringify({ ...ledger, reason: 'changed' }));
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: [] });
      expect(calls).toBe(2);
      status = 'failed';
      const artifacts = join(root, 'artifacts/runs/engine');
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [] }));
      writeFileSync(
        join(artifacts, 'verify-core.json'),
        JSON.stringify({ decision: { kind: 'block', reason: 'coder_partial' } })
      );
      const changedDb = new Database(join(root, 'archon.db'));
      changedDb.run("UPDATE remote_agent_workflow_runs SET status = 'failed'");
      changedDb.close();
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: [] });
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: [] });
      expect(calls).toBe(4);
      writeFileSync(join(artifacts, 'verify-core.json'), '{invalid');
      expect(currentDecisions(query)).toEqual({ decisions: [], unknown: ['r'] });
      expect(calls).toBe(5);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  test('EFFICIENCY_BUDGET buildReport ranks slow attempts across runs and limits to five', () => {
    const root = tmp(),
      bin = join(root, 'archon-stub');
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: bin });
    try {
      const events = Array.from({ length: 7 }, (_, i) =>
        [0, 1].map(seq => ({
          workflow_run_id: `engine-${i}`,
          event_type: 'provider_event',
          step_name: 'repair-core',
          data: {
            attemptId: `a-${i}`,
            seq,
            observedAt: new Date(Date.UTC(2026, 9, 14) + seq * 156000 * (i + 1)).toISOString(),
            event:
              seq === 0
                ? { type: 'tool_call', toolCallId: 'x', name: 'file_change' }
                : { type: 'tool_call_update', toolCallId: 'x', status: 'completed' },
          },
        }))
      ).flat();
      const run = { id: 'engine', status: 'completed', output_root: root, nodes: [], events };
      writeFileSync(
        bin,
        '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n',
        { mode: 0o755 }
      );
      const ledger = {
        run_id: 'r',
        archon_run_id: 'engine',
        repo: root,
        gen_dir: root,
        workflow: 'fixture',
        recoveries: [],
      } as unknown as Ledger;
      const report = buildReport([ledger]);
      expect(report.slow_nodes).toEqual(
        [6, 5, 4, 3, 2].map(i => ({
          run: `engine-${i}`,
          node: 'repair-core',
          attempt: `a-${i}`,
          over_ratio: i + 1,
          reasons: [`wall_clock_ms ${156000 * (i + 1)} > p90 156000`],
          duration_ms: 156000 * (i + 1),
          model_turns: 0,
          first_edit_ms: 0,
          longest_gap_ms: 0,
          longest_gap_at: '2026-10-14T00:00:00.000Z',
          longest_silence_ms: 156000 * (i + 1),
          longest_silence_closed_by: { type: 'tool_call_update' },
          provider_warnings: [],
        }))
      );
      expect(buildReport([]).slow_nodes).toEqual([]);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  test('PROVIDER_TIMING buildReport consumes engine envelopes; native clocks remain unknown', () => {
    const root = tmp(),
      bin = join(root, 'archon-stub');
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: bin });
    try {
      const acceptCommand = 'bun test focused';
      writeFileSync(
        join(root, 'plan.json'),
        JSON.stringify({
          ...plan,
          packages: plan.packages.map((p, i) => ({
            ...p,
            accept: i === 0 ? [{ cmd: acceptCommand, timeout_s: 10 }] : [],
          })),
        })
      );
      const arrival = (seq: number, second: number, event: Record<string, unknown>) => ({
        event_type: 'provider_event',
        step_name: 'code-core',
        data: { attemptId: 'code-core-a', seq, observedAt: `2026-10-10T00:00:0${second}Z`, event },
      });
      const events = [
        arrival(0, 1, {
          type: 'tool_call',
          toolCallId: 'x',
          name: 'shell',
          rawInput: { command: acceptCommand },
        }),
        arrival(1, 3, { type: 'tool_call_update', toolCallId: 'x', status: 'completed' }),
        arrival(2, 4, {
          type: 'tool_call',
          toolCallId: 'y',
          name: 'shell',
          rawInput: { command: `${acceptCommand} ` },
        }),
        arrival(3, 5, { type: 'tool_call_update', toolCallId: 'y', status: 'completed' }),
        arrival(4, 6, { type: 'agent_message_chunk', text: 'answer' }),
        { ...ev('node_completed', 'code-core'), created_at: '2026-10-10T00:00:07Z' },
      ];
      const run = { id: 'engine', status: 'completed', output_root: root, nodes: [], events };
      writeFileSync(
        bin,
        '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n',
        { mode: 0o755 }
      );
      const ledger = {
        run_id: 'r',
        archon_run_id: 'engine',
        repo: root,
        gen_dir: root,
        workflow: 'fixture',
        recoveries: [],
      } as unknown as Ledger;
      const report = buildReport([ledger]);
      expect(report.agent_ran_acceptance).toBe(1);
      expect(report.provider_timing).toMatchObject({
        'r/engine': [
          {
            run: 'engine',
            node: 'code-core',
            attempt_id: 'code-core-a',
            agent_ran_acceptance: 1,
            tool_union_ms: 3000,
            non_tool_gap_ms: 2000,
            final_answer_at: '2026-10-10T00:00:06Z',
            request_at: 'unknown',
          },
        ],
      });
      expect(jobReceipt({ id: 'native', state: 'done' } as Job).provider_timing).toBe('unknown');
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
  // prettier-ignore
  test('job cumulative snapshot overlapping engine turn is excluded once without state writes', () => {
    const root = tmp(), bin = join(root, 'archon-stub');
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: bin });
    try {
      writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
      const event = ev('node_completed', 'code-core', { ...provider('m', { input: 100, output: 10 }),
        invocation: { id: 'turn', startedAt: '2026-10-10T00:00:00Z' }, session_id: 'thread',
        binding: { provider: 'codex', model: { requested: 'm', resolved: { source: 'provider', value: 'm' } } } });
      const run = { id: 'engine', status: 'completed', started_at: '2026-10-10T00:00:00Z', completed_at: '2026-10-10T00:00:10Z', output_root: root, nodes: [], events: [event] };
      writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n', { mode: 0o755 });
      mkdirSync(join(root, 'usage'));
      const cache = { at: 'now', status: 'ok', sources: {}, daily: [], sessions: [{ id: 'thread', client: 'codex', model: 'm', at: 'now', input: 100, output: 10, total: 110, cacheRead: 0, cacheWrite: 0, reasoning: 0, sessions: 1, cost: null, owner: { kind: 'job', job_id: 'job', client: 'codex', role: 'general', model: 'm', cwd: root } }] };
      const path = join(root, 'usage/cache.json'), bytes = JSON.stringify(cache);
      writeFileSync(path, bytes);
      const ledger = { run_id: 'r', archon_run_id: 'engine', repo: root, gen_dir: root, plan: join(root, 'plan.json'), workflow: 'fixture', console: 'codex', started_at: run.started_at, branch: 'task', recoveries: [] } as unknown as Ledger;
      const report = buildReport([ledger]);
      expect(report.usage).toMatchObject({ investment: { input: 100, output: 10, fees: 'unknown' }, supplemental: { overlap_excluded: 1, investment: { input: 'unknown' } } });
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      const receipt = { ...event, data: { ...event.data, session_id: undefined } };
      writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify({ ...run, events: [receipt, receipt] })) + ');\n');
      writeFileSync(path, JSON.stringify({ ...cache, status: 'exit_nonzero' }));
      expect(buildReport([ledger]).usage).toMatchObject({ investment: { input: 100, output: 10, deduplication: 'covered', source: 'provider_attempt_receipts', coverage: '1/1' } });
    } finally {
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
  });
  test('real invocation identities deduplicate receipts; resumed turns stay per-turn and providers are explicit', () => {
    const turn = (id: string, input: number) =>
      ev('node_completed', 'code-core', {
        ...provider('a-model-is-not-a-provider', { input, output: 10, cacheRead: 60 }),
        invocation: { id, startedAt: '2026-10-10T00:00:00Z' },
        binding: {
          provider: 'claude',
          model: { resolved: { source: 'provider', value: 'a-model-is-not-a-provider' } },
        },
        session_id: 'same-thread',
      });
    const first = turn('turn1', 100),
      second = turn('turn2', 200);
    const rows = callsOf('r', [first, first, second], plan);
    expect(rollup(rows)).toMatchObject({
      calls: 2,
      input: 300,
      cacheRead: 120,
      identity_coverage: '2/2',
      providers: { claude: 2 },
    });
    expect(
      rollup(
        callsOf(
          'r',
          [ev('node_completed', 'code-core', provider('claude-x', { input: 20, output: 5 }))],
          plan
        )
      )
    ).toMatchObject({ providers: { unknown: 1 }, identity_coverage: '0/1' });
  });

  test('parallel frozen graph accounts only the blocking path; absent clocks and repeated attempts are unknown', () => {
    const run = {
      id: 'r',
      status: 'completed',
      started_at: '2026-10-10T00:00:00Z',
      completed_at: '2026-10-10T00:00:10Z',
    } as Parameters<typeof criticalPath>[0];
    const terminal = (node: string, start: number, duration: number) =>
      ev('node_completed', node, {
        invocation: { id: node, startedAt: `2026-10-10T00:00:0${start}Z`, loopPath: [] },
        attempt: { id: node, startedAt: `2026-10-10T00:00:0${start}Z` },
        timing: { startedAt: `2026-10-10T00:00:0${start}Z`, durationMs: duration },
      });
    const events = [
      terminal('code-a', 0, 4000),
      terminal('code-b', 0, 7000),
      terminal('verify-a', 7, 3000),
    ];
    const graph = [
      { id: 'code-a' },
      { id: 'code-b' },
      { id: 'verify-a', depends_on: ['code-a', 'code-b'] },
    ];
    const result = criticalPath(run, events, graph);
    expect(result).toMatchObject({
      status: 'measured',
      elapsed_ms: 10000,
      reconciled_ms: 10000,
      path: ['code-b', 'verify-a'],
    });
    expect(criticalPath(run, events)).toMatchObject({ status: 'unknown' });
    expect(criticalPath(run, [...events, events[0]], graph)).toMatchObject({ status: 'unknown' });
    expect(
      criticalPath(run, [terminal('code-a', 0, NaN), ...events.slice(1)], graph)
    ).toMatchObject({ status: 'unknown' });
  });

  test('explicit demand reference includes failed and cancelled attempts; legacy is unknown and completion is engine-owned', () => {
    const root = tmp();
    const saved = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME, process.env.TZ];
    process.env.SUPERAGENT_HOME = root;
    process.env.ARCHON_HOME = root;
    process.env.TZ = 'Asia/Taipei';
    try {
      writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...plan, request_ref: 'ticket:42' }));
      const pairs = ['failed', 'cancelled', 'completed'].map((status, i) => ({
        ledger: {
          run_id: `r${i}`,
          gen_dir: root,
          repo: root,
          started_at: '2026-10-10T00:00:00Z',
        } as Ledger,
        run: { id: `r${i}`, status, output_root: root, completed_at: '2026-10-10T00:00:10Z' },
      })) as Parameters<typeof demandStats>[0];
      const art = join(root, 'artifacts/runs/r2');
      mkdirSync(art, { recursive: true });
      writeFileSync(
        join(art, 'gate-m1-r1.json'),
        JSON.stringify({
          decision: {
            kind: 'advance',
            reason: 'accepted',
            evidence: [],
            debt: [],
            requirements: { status: 'verified', items: [] },
          },
        })
      );
      // api belongs to m2 and has no decision: a completed run cannot manufacture acceptance.
      const calls = pairs.flatMap(p =>
        callsOf(
          p.ledger.run_id,
          [ev('node_completed', 'code-core', provider('m', { input: 10, output: 1 }))],
          plan
        )
      );
      const result = demandStats(pairs, calls) as {
        denominator: number;
        completed: number;
        by_request: Record<
          string,
          {
            attempts: unknown[];
            investment: { input: number };
            complete: unknown;
            elapsed_ms: number;
          }
        >;
      };
      expect(result.denominator).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.by_request['ticket:42']).toMatchObject({
        complete: 'unknown',
        elapsed_ms: 10000,
        investment: {
          input: 'unknown',
          fees: 'unknown',
          deduplication: 'unknown',
          raw: { input: 30 },
        },
      });
      expect(result.by_request['ticket:42'].attempts).toHaveLength(3);
      for (const p of pairs) p.ledger.started_at = '2026-10-10 00:00:00';
      expect(demandStats(pairs, calls)).toMatchObject({
        by_request: { 'ticket:42': { elapsed_ms: 10000 } },
      });
      for (const p of pairs)
        if (!(p.run instanceof Error)) p.run.completed_at = '2026-10-10 00:00:10';
      expect(demandStats(pairs, calls)).toMatchObject({
        by_request: { 'ticket:42': { elapsed_ms: 10000 } },
      });
      writeFileSync(join(art, 'gate-m2-r1.json'), readFileSync(join(art, 'gate-m1-r1.json')));
      expect(demandStats(pairs, calls)).toMatchObject({ completed: 1 });
      writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
      expect(demandStats(pairs, calls)).toMatchObject({
        denominator: 0,
        completed: 0,
        unknown_runs: ['r0', 'r1', 'r2'],
      });
    } finally {
      for (const [i, key] of ['SUPERAGENT_HOME', 'ARCHON_HOME', 'TZ'].entries()) {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      }
    }
  });
  test('req-evidence: report projects the last decision without interpreting green or self-report', () => {
    const root = tmp(),
      art = join(root, 'artifacts/runs/r');
    const saved = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME];
    process.env.SUPERAGENT_HOME = root;
    process.env.ARCHON_HOME = root;
    try {
      mkdirSync(art, { recursive: true });
      writeFileSync(join(root, 'plan.json'), JSON.stringify({ packages: [{ id: 'a' }] }));
      const l = { repo: root, gen_dir: root } as Ledger;
      const run = { id: 'r', output_root: root } as Parameters<typeof requirementCoverage>[1];
      writeFileSync(join(art, 'verify-a.json'), '{"ok":true,"status":"done"}');
      expect(requirementCoverage(l, run)).toEqual({ a: { status: 'legacy', items: [] } });
      const requirements = {
        status: 'unknown' as const,
        items: [
          { package: 'a', id: 'r', text: 'external', status: 'unknown' as const, evidence: [] },
        ],
      };
      writeFileSync(
        join(art, 'gate-m1-r2.json'),
        JSON.stringify({
          decision: {
            kind: 'block',
            reason: 'acceptance_failed',
            evidence: [],
            debt: [],
            requirements,
          },
        })
      );
      expect(requirementCoverage(l, run)).toEqual({ a: requirements });
    } finally {
      for (const [i, key] of ['SUPERAGENT_HOME', 'ARCHON_HOME'].entries()) {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      }
    }
  });
  test('job phases require actual receipts; legacy and invalid clocks remain unknown', () => {
    const job = {
      id: 'job',
      state: 'done',
      role: null,
      card: '/cards/current.md',
      started_at: '2026-10-10T00:00:03Z',
      ended_at: '2026-10-10T00:00:10Z',
    } as Job;
    expect(jobReceipt(job)).toMatchObject({
      role: 'unknown',
      queue_ms: 'unknown',
      exec_ms: 'unknown',
      policy: 'unknown',
    });
    job.receipt = {
      enqueued_at: '2026-10-10T00:00:00Z',
      admitted_at: '2026-10-10T00:00:02Z',
      spawned_at: job.started_at,
      settled_at: job.ended_at,
    };
    expect(jobReceipt(job)).toMatchObject({
      queue_ms: 2000,
      prepare_ms: 1000,
      exec_ms: 7000,
      context_ref: job.card,
      first_token_ms: 'unknown',
      model_calls: 'unknown',
    });
    job.receipt.admitted_at = 'invalid';
    expect(jobReceipt(job)).toMatchObject({ queue_ms: 'unknown', prepare_ms: 'unknown' });
    expect(
      rollup(callsOf('r', [ev('node_completed', 'code-core', { timing: undefined })], plan))
    ).toMatchObject({ phase_coverage: { queue_ms: '1/1', exec_ms: '0/1' } });
  });
  test('generation identities reuse adoption endpoints once in ledger order', () => {
    expect(archonRunIds({ archon_run_id: 'latest' })).toEqual(['latest']);
    const adoption = { at: '', engine_from: null, engine_to: '', reason: '' };
    expect(
      archonRunIds({
        archon_run_id: 'latest',
        adoptions: [
          { ...adoption, from: 'old', to: 'middle' },
          { ...adoption, from: 'middle', to: 'latest' },
        ],
      })
    ).toEqual(['old', 'middle', 'latest']);
  });

  test.each([false, true])(
    'adopted usage survives repo deletion=%s without state writes',
    missing => {
      const root = tmp(),
        repo = join(root, 'repo'),
        gen = join(root, 'gen');
      mkdirSync(repo);
      mkdirSync(gen);
      writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
      const ledger: Ledger = {
        run_id: 'sa1',
        archon_run_id: 'latest',
        plan: join(gen, 'plan.json'),
        gen_dir: gen,
        repo,
        branch: 'task',
        workflow: 'fixture',
        console: 'codex',
        started_at: '2026-10-10T00:00:00.000Z',
        transcript: '',
        log: '',
        recoveries: [],
        adoptions: [
          { from: 'old', to: 'latest', at: '', engine_from: null, engine_to: '', reason: '' },
        ],
      };
      const ledgerFile = join(root, 'ledger.json');
      writeFileSync(ledgerFile, JSON.stringify(ledger));
      const generations = {
        old: [
          ev('node_completed', 'code-core', provider('review-looking-name', { output: 55 })),
          ev('node_completed', 'review-m2-r1', provider('model', { output: 10 })),
        ],
        latest: [
          ev('node_completed', 'code-core', provider('model', { output: 100 })),
          ev('node_completed', 'repair-api'),
        ],
      };
      for (const [id, events] of Object.entries(generations))
        writeFileSync(
          join(root, `${id}.json`),
          JSON.stringify({
            id,
            status: 'completed',
            output_root: root,
            nodes: [],
            events,
            started_at: ledger.started_at,
            completed_at: '2026-10-10T00:01:00.000Z',
          })
        );
      const before = ['ledger', 'old', 'latest'].map(id =>
        readFileSync(join(root, `${id}.json`), 'utf8')
      );
      const bin = join(root, 'archon');
      writeFileSync(
        bin,
        `#!/bin/sh\nprintf '%s|%s\\n' "$3" "$(pwd -P)" >> '${root}/queries'\ncat '${root}/'"$3".json\n`,
        { mode: 0o755 }
      );
      const saved = process.env.SA_ARCHON_BIN;
      const savedHomes = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME];
      process.env.SUPERAGENT_HOME = join(root, 'home');
      process.env.ARCHON_HOME = join(root, 'home', 'archon');
      process.env.SA_ARCHON_BIN = bin;
      if (missing) rmSync(repo, { recursive: true });
      const started = Date.now();
      try {
        const report = buildReport([ledger]);
        expect(report).toMatchObject({
          runs: 1,
          'state:completed': 1,
          unreadable: [],
          repo_missing: missing ? ['sa1'] : [],
          usage: {
            total: {
              calls: 4,
              raw: { output: 165 },
              output: 'unknown',
              coverage: '3/4',
              infra_retries: 1,
            },
            by_run: { sa1: { calls: 4, raw: { output: 165 } } },
            by_role: {
              code: { calls: 2, raw: { output: 155 } },
              review: { calls: 1, raw: { output: 10 } },
            },
            by_attempt: { 'attempt:2': { calls: 1, raw: { output: 100 } } },
            window: { scope: 'all_retained_events_for_recorded_generations' },
            unreadable: [],
          },
        });
        const window = (report.usage as { window: { generated_at: string } }).window;
        expect(Date.parse(window.generated_at)).toBeGreaterThanOrEqual(started);
        expect(Date.parse(window.generated_at)).toBeLessThanOrEqual(Date.now());
        // The stub reports the physical cwd; tmp roots and the checkout may sit behind symlinks.
        const cwd = realpathSync(missing ? WETAMP : repo);
        expect(readFileSync(join(root, 'queries'), 'utf8').trim().split('\n')).toEqual([
          `latest|${cwd}`,
          `old|${cwd}`,
          `latest|${cwd}`,
        ]);
        expect(
          ['ledger', 'old', 'latest'].map(id => readFileSync(join(root, `${id}.json`), 'utf8'))
        ).toEqual(before);
        expect(ledger).toEqual(JSON.parse(before[0]));
      } finally {
        for (const [i, key] of ['SUPERAGENT_HOME', 'ARCHON_HOME'].entries()) {
          if (savedHomes[i] === undefined) delete process.env[key];
          else process.env[key] = savedHomes[i];
        }
        if (saved === undefined) delete process.env.SA_ARCHON_BIN;
        else process.env.SA_ARCHON_BIN = saved;
      }
    }
  );

  test('intervention distribution excludes unknown history and uses all append-only events', () => {
    const event = {
      at: '2026-10-12T00:00:00Z',
      action: 'decide',
      source: 'cli' as const,
      ok: false,
      error: 'exit:1',
    };
    const runs = [
      { run_id: 'old', started_at: '2026-10-11T00:00:00Z', recoveries: ['a'], intervened: true },
      { run_id: 'missing', started_at: '2026-10-13T00:00:00Z' },
      { run_id: 'zero', intervention_events: [] },
      { run_id: 'one', intervention_events: [event] },
      { run_id: 'many', intervention_events: Array.from({ length: 25 }, () => event) },
    ] as Ledger[];
    expect(interventionStats(runs)).toEqual({
      by_run: { old: 'legacy', missing: 'unknown', zero: 0, one: 1, many: 25 },
      known: 3,
      legacy: 1,
      unknown: 1,
      median: 1,
      max: 25,
      zero_share: 1 / 3,
    });
    expect(interventionStats(runs.slice(0, 2))).toMatchObject({
      median: 'unknown',
      max: 'unknown',
      zero_share: 'unknown',
    });
    expect(interventionStats(runs.slice(2, 4)).median).toBe(0.5);
  });
  const events = [
    ev('node_started', 'code-core'),
    ev('node_completed', 'code-core'),
    ev('node_failed', 'review-m2-r1', { provider_failure: { class: 'vendor_unavailable' } }),
    ev('node_completed', 'review-m2-r1', {
      ...provider('claude-x', { input: 100, output: 10, cacheRead: 60 }),
      attempt: { id: 'review-second', startedAt: '2026-10-10T00:00:02.000Z' },
    }),
    ev('node_completed', 'repair-api'),
    // 条件跳过与 resume 沿用的 prior_success（无 attempt）不是调用
    {
      event_type: 'node_skipped',
      step_name: 'fix-m1-r2',
      data: { attempt: { id: 'x' }, binding: {} },
    },
    { event_type: 'node_completed', step_name: 'code-api', data: { reason: 'prior_success' } },
    ev('node_completed', 'verify-core'),
  ];
  const calls = callsOf('r1', events, plan);

  test('one call per AI attempt with milestone, role, model identity and failure class', () => {
    expect(calls.map(c => [c.node, c.milestone, c.role, c.attempt, c.model, c.failure])).toEqual([
      ['code-core', 'm1', 'code', 1, 'm-req(pinned)', null],
      ['review-m2-r1', 'm2', 'review', 1, 'm-req(pinned)', 'vendor_unavailable'],
      ['review-m2-r1', 'm2', 'review', 2, 'claude-x', null],
      ['repair-api', 'm2', 'repair', 1, 'm-req(pinned)', null],
    ]);
    expect(calls[0]).toMatchObject({ queue_ms: 2000, exec_ms: 1000, effort: 'high', tokens: null });
    expect(callsOf('r1', events, null)[0].milestone).toBe('?');
  });

  test('unreported usage is unknown, never 0; coverage says how much is known', () => {
    expect(rollup(calls.filter(c => c.role !== 'review'))).toMatchObject({
      calls: 2,
      coverage: '0/2',
      input: 'unknown',
      output: 'unknown',
      cacheRead: 'unknown',
      cacheWrite: 'unknown',
    });
    expect(rollup(calls)).toMatchObject({
      calls: 4,
      coverage: '1/4',
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 'unknown',
      infra_retries: 1,
      repair_rounds: 1,
      queue_ms: 8000,
      exec_ms: 4000,
      models: { 'm-req(pinned)': 3, 'claude-x': 1 },
      efforts: { high: 3, xhigh: 1 },
      failures: { vendor_unavailable: 1 },
    });
    expect(rollup([])).toMatchObject({ calls: 0, input: 'unknown', exec_ms: 'unknown' });
    expect(JSON.stringify(rollup(calls))).not.toMatch(/cost|usd/i);
  });
});

test('engine comparison uses disjoint nearest matches and requires both cohorts', () => {
  const row = (id: string, newer: boolean, diff: number): EngineRow => ({
    id,
    newer,
    diff,
    repo: 'repo',
    risk: 'G1',
    started: newer ? 86400000 : 0,
    status: 'completed',
    elapsed: 100,
    adjusted: 100,
    tokens: 100,
    first: true,
    silence: 0,
    disruptions: 0,
  });
  const old = [1, 9, 10, 11, 100].map((size, i) => ({
    ...row(`o${i}`, false, size),
    tokens: size,
  }));
  const fresh = Array.from({ length: 15 }, (_, i) => ({ ...row(`n${i}`, true, 10), tokens: 10 }));
  const report = (patch: Partial<EngineRow> = {}) =>
    engineComparison([...old, ...fresh.map(r => ({ ...r, ...patch }))]);
  expect(report().size_matched).toMatchObject({
    old: { runs: 5, tokens: 26.2 },
    new: { runs: 2 },
    unmatched: 13,
  });
  expect(report().verdict).toBe('insufficient_sample');
  expect(report({ adjusted: 75 }).verdict).toBe('insufficient_sample');
  expect(report({ diff: 'unknown' }).size_matched.unmatched).toBe(15);
  expect(report({ repo: 'other' }).size_matched.unmatched).toBe(15);
  expect(report({ risk: 'G2' }).size_matched.unmatched).toBe(15);
  expect(report({ tokens: 'unknown', adjusted: 75 }).verdict).toBe('insufficient_sample');
  expect(engineComparison([fresh[0]])).toMatchObject({
    verdict: 'insufficient_sample',
    groups: { old: { runs: 0 } },
  });
});

test('engine projection groups ledger commits and unions retry silences without emitting bodies', () => {
  const root = tmp(),
    bin = join(root, 'archon-stub'),
    art = join(root, 'artifacts/runs/engine');
  const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const,
    saved = keys.map(k => process.env[k]);
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: bin });
  try {
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(root, 'plan.json'),
      JSON.stringify({ packages: [{ id: 'core', risk: 'G1' }] })
    );
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 15) + ms).toISOString();
    const events = [0, 1].flatMap(i =>
      [0, 1].map(seq => ({
        event_type: 'provider_event',
        step_name: `code-${i}`,
        data: {
          attemptId: `a${i}`,
          seq,
          observedAt: at(i * 100000 + seq * 200000),
          event: seq
            ? { type: 'warning', code: 'codex.will_retry', message: 'never emit this' }
            : { type: 'agent_message_chunk', text: 'never emit this' },
        },
      }))
    );
    const run = {
      id: 'engine',
      status: 'completed',
      started_at: at(0),
      completed_at: at(600000),
      output_root: root,
      events,
    };
    writeFileSync(
      bin,
      '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n',
      { mode: 0o755 }
    );
    const base = Bun.spawnSync(['git', 'rev-parse', '6acdc886^'], { cwd: WETAMP })
      .stdout.toString()
      .trim();
    const ledger = {
      run_id: 'r',
      archon_run_id: 'engine',
      repo: root,
      gen_dir: root,
      plan: join(root, 'plan.json'),
      started_at: at(0),
      engine_commit: '6acdc886',
    } as Ledger;
    const ledgers = [
      ledger,
      { ...ledger, run_id: 'old', engine_commit: base, started_at: at(-86400000) },
      { ...ledger, run_id: 'unknown', engine_commit: undefined },
    ];
    const result = buildReport(ledgers, { commit: '6acdc886', baselineDays: 7 });
    expect(result).toMatchObject({
      groups: {
        old: { runs: 1 },
        new: {
          runs: 1,
          elapsed_ms: 600000,
          adjusted_ms: 300000,
          disruptions: 2,
          disruption_seconds: 300,
          missing: { diff: 1 },
        },
      },
      excluded: { unknown_engine_commit: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('never emit this');
    const ordinary = {
      ...run,
      events: events.map(e => ({
        ...e,
        data: { ...e.data, event: { ...e.data.event, code: 'other' } },
      })),
    };
    writeFileSync(
      bin,
      '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(ordinary)) + ');\n'
    );
    expect(buildReport([ledger], { commit: '6acdc886', baselineDays: 7 })).toMatchObject({
      groups: { new: { adjusted_ms: 600000, disruptions: 0, disruption_seconds: 0 } },
    });
    writeFileSync(
      bin,
      '#!/usr/bin/env bun\nconsole.log(' + JSON.stringify(JSON.stringify(run)) + ');\n'
    );
    const patch = join(art, 'delta.patch');
    writeFileSync(
      patch,
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+more\n'
    );
    writeFileSync(join(art, 'diff-m1-r1.json'), JSON.stringify({ delta: patch }));
    expect(buildReport(ledgers, { commit: '6acdc886', baselineDays: 7 })).toMatchObject({
      size_matched: { old: { runs: 1 }, new: { runs: 1 }, unmatched: 0 },
      groups: { new: { missing: { diff: 0 } } },
    });
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('P1 started attempts survive cancellation and late terminal receipts deduplicate', () => {
  const start = ev('node_started', 'code-core', {
    invocation: { id: 'i' },
    binding: {},
    node: { id: 'code-core', kind: 'agent' },
  });
  expect(callsOf('r', [start, start, { event_type: 'workflow_cancelled' }], plan)).toMatchObject([
    { attempt: 1, failure: 'unknown', tokens: null, exec_ms: null, model: 'unknown' },
  ]);
  const terminal = ev('node_failed', 'code-core', {
    invocation: { id: 'i' },
    ...provider('m', { input: 10, output: 2 }),
  });
  const calls = callsOf('r', [start, terminal, terminal, start], plan);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ failure: 'unknown', tokens: { input: 10, output: 2 } });
  expect(callsOf('r', [terminal, start, terminal], plan)).toEqual(calls);
  expect(
    cancellationStats([
      { ledger: { rejected: 'human rejected' } as Ledger, run: { id: 'r', status: 'cancelled' } },
      {
        ledger: { started_at: '2026-10-11T00:00:00Z' } as Ledger,
        run: { id: 'l', status: 'cancelled' },
      },
      {
        ledger: { started_at: '2026-10-13T00:00:00Z' } as Ledger,
        run: { id: 'u', status: 'cancelled' },
      },
    ])
  ).toEqual({ rejected: 1, legacy: 1, unrecorded: 1 });
});

test('P1 SQL clock precision allows subsecond persistence, not a real overrun', () => {
  const run = {
    id: 'r',
    status: 'completed' as const,
    started_at: '2026-10-10 00:00:00',
    completed_at: '2026-10-10 00:00:03',
  };
  const event = ev('node_completed', 'code-core', {
    invocation: { id: 'i' },
    timing: { startedAt: '2026-10-10T00:00:02Z', durationMs: 1500 },
  });
  expect(measurementOf(run, [event], plan).wall_clock_ms).toBe(3000);
  expect(
    measurementOf({ ...run, completed_at: '2026-10-10T00:00:03Z' }, [event], plan).wall_clock_ms
  ).toBe('unknown');
  expect(
    measurementOf(
      run,
      [
        ev('node_completed', 'code-core', {
          invocation: { id: 'i' },
          timing: { startedAt: '2026-10-10T00:00:02Z', durationMs: 2001 },
        }),
      ],
      plan
    ).wall_clock_ms
  ).toBe('unknown');
});

test('P1 improvement requires independent cohorts, completion and total investment', () => {
  const rows = (newer: boolean, n = 15): EngineRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${newer}-${i}`,
      newer,
      started: newer ? 86400000 : 0,
      repo: 'r',
      risk: 'G1',
      status: 'completed',
      elapsed: newer ? 70 : 100,
      adjusted: 1,
      tokens: 100,
      first: true,
      diff: 10,
      silence: 0,
      disruptions: 0,
    }));
  const old = rows(false),
    fresh = rows(true);
  expect(engineComparison([...old, ...fresh]).verdict).toBe('improved');
  expect(
    engineComparison([
      ...old,
      ...rows(true, 100).map((r, i) => (i < 15 ? r : { ...r, status: 'failed', first: false })),
    ]).verdict
  ).not.toBe('improved');
  expect(engineComparison([...old.slice(0, 1), ...fresh]).verdict).toBe('insufficient_sample');
  expect(
    engineComparison([...old, ...fresh.map(r => ({ ...r, elapsed: 100, adjusted: 0 }))]).verdict
  ).toBe('unproven');
  expect(
    engineComparison([...old, ...fresh.map(r => ({ ...r, tokens: 'unknown' as const }))]).verdict
  ).toBe('unproven');
  expect(engineComparison([...old, ...fresh]).size_matched.old.runs).toBe(15);
});

test('P1 outside plan falls back to confined generation snapshot and attributes demand', () => {
  const root = tmp(),
    outside = tmp();
  const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME'] as const,
    saved = keys.map(k => process.env[k]);
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root });
  try {
    writeFileSync(
      join(outside, 'plan.json'),
      JSON.stringify({ request_ref: 'wrong', packages: [] })
    );
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ request_ref: 'actual', packages: [] }));
    const ledger = {
      run_id: 'r',
      repo: root,
      gen_dir: root,
      plan: join(outside, 'plan.json'),
    } as Ledger;
    expect(planOf(ledger)?.request_ref).toBe('actual');
    expect(demandStats([{ ledger, run: { id: 'r', status: 'cancelled' } }], [])).toMatchObject({
      denominator: 1,
      unknown_runs: [],
      by_request: { actual: { attempts: [{ run: 'r' }] } },
    });
    writeFileSync(
      join(root, 'plan.json'),
      JSON.stringify({ request_ref: 'plan-external', packages: [] })
    );
    expect(
      demandStats(
        [{ ledger, run: { id: 'r', status: 'cancelled' } }],
        callsOf('r', [ev('node_started', 'code-core')], plan)
      )
    ).toMatchObject({
      denominator: 0,
      unknown_runs: ['r'],
      unattributed: { calls: 1, input: 'unknown' },
    });
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('P1 prior success event preserves measured node duration in batch report', () => {
  const root = tmp(),
    keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const,
    saved = keys.map(k => process.env[k]);
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: '' });
  const db = new Database(join(root, 'archon.db'));
  db.run(
    'CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, started_at TEXT, completed_at TEXT, metadata TEXT)'
  );
  db.run(
    'CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, created_at TEXT, event_order INTEGER, data TEXT)'
  );
  db.run(
    "INSERT INTO remote_agent_workflow_runs VALUES ('r', 'completed', '2026-10-10 00:00:00', '2026-10-10 00:00:03', '{}')"
  );
  const unavailable = { source: 'unavailable', reason: 'not_applicable' };
  const data = {
    node: { id: 'code-core', kind: 'exec', runtime: 'sh' },
    invocation: { id: 'i', startedAt: '2026-10-10T00:00:00Z', loopPath: [] },
    attempt: { id: 'a', startedAt: '2026-10-10T00:00:00Z' },
    binding: {},
    timing: { startedAt: '2026-10-10T00:00:00Z', durationMs: 3000 },
    spend: {
      tokens: unavailable,
      costUsd: unavailable,
      stopReason: unavailable,
      numTurns: unavailable,
    },
    accounting: 'node',
  };
  const insert = db.prepare(
    "INSERT INTO remote_agent_workflow_events VALUES ('r', ?, 'code-core', '2026-10-10 00:00:03', ?, ?)"
  );
  insert.run('node_completed', 1, JSON.stringify(data));
  insert.run('node_skipped_prior_success', 2, '{}');
  db.close();
  try {
    const report = buildReport([
      {
        run_id: 'r',
        archon_run_id: 'r',
        repo: root,
        gen_dir: root,
        recoveries: [],
        workflow: 'w',
      } as unknown as Ledger,
    ]);
    expect(report['node_s:code']).toBe(3);
    expect(report['state:completed']).toBe(1);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

test('R1-1 AI attempts use native kind and legacy model binding, not node names alone', () => {
  const events = ['node_started', 'node_completed', 'node_failed'].flatMap(type => [
    ev(type, 'repair-context-core', {
      node: { id: 'repair-context-core', kind: 'exec' },
      binding: {},
    }),
    ev(type, 'code-probe', { node: { id: 'code-probe', kind: 'exec' } }),
    ev(type, 'code-legacy-script', { binding: {} }),
  ]);
  expect(callsOf('r', events, plan)).toEqual([]);
  const agent = ev('node_started', 'code-core', {
    node: { id: 'code-core', kind: 'agent' },
    binding: {},
  });
  const legacy = ev('node_started', 'code-api');
  expect(rollup(callsOf('r', [...events, agent, legacy], plan))).toMatchObject({
    calls: 2,
    coverage: '0/2',
    repair_rounds: 0,
  });
});
