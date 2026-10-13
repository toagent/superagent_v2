import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../src/plan';
import {
  buildReport,
  callsOf,
  interventionStats,
  rollup,
  jobReceipt,
  requirementCoverage,
  criticalPath,
  demandStats,
} from '../src/report';
import type { Job } from '../src/jobs';
import { archonRunIds } from '../src/archon';
import type { Ledger } from '../src/cli';
import { tmp } from './helpers';
import { WETAMP } from '../src/config';

const plan = {
  packages: [{ id: 'core' }, { id: 'api', milestone: 'm2' }],
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
    const saved = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME];
    process.env.SUPERAGENT_HOME = root;
    process.env.ARCHON_HOME = root;
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
        investment: { input: 30, fees: 'unknown' },
      });
      expect(result.by_request['ticket:42'].attempts).toHaveLength(3);
      writeFileSync(join(art, 'gate-m2-r1.json'), readFileSync(join(art, 'gate-m1-r1.json')));
      expect(demandStats(pairs, calls)).toMatchObject({ completed: 1 });
      writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
      expect(demandStats(pairs, calls)).toMatchObject({
        denominator: 0,
        completed: 0,
        unknown_runs: ['r0', 'r1', 'r2'],
      });
    } finally {
      for (const [i, key] of ['SUPERAGENT_HOME', 'ARCHON_HOME'].entries()) {
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
            total: { calls: 4, output: 165, coverage: '3/4', infra_retries: 1 },
            by_run: { sa1: { calls: 4, output: 165 } },
            by_role: { code: { calls: 2, output: 155 }, review: { calls: 1, output: 10 } },
            by_attempt: { 'attempt:2': { calls: 1, output: 100 } },
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
      { run_id: 'old', recoveries: ['a'], intervened: true },
      { run_id: 'zero', intervention_events: [] },
      { run_id: 'one', intervention_events: [event] },
      { run_id: 'many', intervention_events: Array.from({ length: 25 }, () => event) },
    ] as Ledger[];
    expect(interventionStats(runs)).toEqual({
      by_run: { old: 'unknown', zero: 0, one: 1, many: 25 },
      known: 3,
      unknown: 1,
      median: 1,
      max: 25,
      zero_share: 1 / 3,
    });
    expect(interventionStats(runs.slice(0, 1))).toMatchObject({
      median: 'unknown',
      max: 'unknown',
      zero_share: 'unknown',
    });
    expect(interventionStats(runs.slice(1, 3)).median).toBe(0.5);
  });
  const events = [
    ev('node_started', 'code-core'),
    ev('node_completed', 'code-core'),
    ev('node_failed', 'review-m2-r1', { provider_failure: { class: 'vendor_unavailable' } }),
    ev(
      'node_completed',
      'review-m2-r1',
      provider('claude-x', { input: 100, output: 10, cacheRead: 60 })
    ),
    ev('node_completed', 'repair-api'),
    // 条件跳过（无 binding.model）与 resume 沿用的 prior_success（无 attempt）不是调用
    {
      event_type: 'node_completed',
      step_name: 'fix-m1-r2',
      data: { attempt: { id: 'x' }, binding: {} },
    },
    { event_type: 'node_completed', step_name: 'code-api', data: { reason: 'prior_success' } },
    ev('node_completed', 'verify-core'),
  ];
  const calls = callsOf('r1', events, plan);

  test('one call per terminal AI event with milestone, role, attempt, model identity and failure class', () => {
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
