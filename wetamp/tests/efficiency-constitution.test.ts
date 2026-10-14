import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTiers, WETAMP } from '../src/config';
import { classify, holdOf, reasonHold, type Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { buildWorkflow } from '../src/generate';
import { describeExecution, executionRoute } from '../src/execution';
import { loadPlan, milestones } from '../src/plan';
import { HOLD_POLICY, REASONS } from '../src/reasons';
import { buildReport } from '../src/report';
import { fixturePlan, gitRepo, tmp } from './helpers';

// Closed policy set: adding a seventh category requires a constitutional decision.
const HIGH_RISK = ['鉴权', '凭据', '沙箱', '计费', '迁移/删除', '部署发布'] as const;
const HIGH_RISK_HOLDS: Record<(typeof HIGH_RISK)[number], readonly string[]> = {
  鉴权: ['redline'],
  凭据: ['redline'],
  沙箱: ['redline'],
  计费: ['redline'],
  '迁移/删除': ['redline'],
  部署发布: ['redline'],
};
const allowedHolds = new Set(Object.values(HIGH_RISK_HOLDS).flat());
const tiers = loadTiers();
const root = tmp();
const planPath = fixturePlan(root, gitRepo(root), p => {
  p.packages = [(p.packages as Record<string, unknown>[])[0]];
  delete (p.packages as Record<string, unknown>[])[0].review;
  delete p.deadline;
  delete p.budget;
});
const plan = loadPlan(planPath, [root]);
type Node = { id: string; command?: string; retry?: unknown; when?: string };
const workflow = (risk: 'G0' | 'G1' | 'G2', mode = 'auto'): Node[] => {
  const p = structuredClone(plan);
  p.packages[0].risk = risk;
  p.mode = mode as typeof p.mode;
  return buildWorkflow(p, milestones(p), 'constitution', root, false, 0, tiers).nodes as Node[];
};

describe('EFFICIENCY_CONSTITUTION', () => {
  test('① frozen reason registry agrees with its owner', () => {
    const frozen = JSON.parse(
      readFileSync(join(WETAMP, 'templates/.archon/scripts/reasons.json'), 'utf8')
    );
    expect(frozen).toEqual(REASONS);
    for (const reason of REASONS) expect(reasonHold(reason.code)).toBe(reason.hold);
  });

  test('① every registered waiting or human policy belongs to the high-risk closed set', () => {
    const violations = REASONS.filter(reason => {
      const policy = HOLD_POLICY[reason.hold];
      return (
        (policy.do === 'ask' || policy.do === 'signoff' || policy.do === 'resume') &&
        !allowedHolds.has(reason.hold)
      );
    }).map(reason => reason.code);
    expect(violations).toEqual([]);
    // A new policy must fail even before a reason starts using it.
    expect(
      Object.entries(HOLD_POLICY).filter(
        ([hold, policy]) =>
          ['ask', 'signoff', 'resume'].includes(policy.do) && !allowedHolds.has(hold)
      )
    ).toEqual([]);
  });

  test('① classify/holdOf cannot introduce ordinary task waits', () => {
    const ledger = { plan: planPath, gen_dir: root, started_at: '2026-10-14T00:00:00Z' } as Ledger;
    const runs: RunView[] = [
      {
        id: 'fixture',
        status: 'paused',
        nodes: [],
        metadata: { approval: { nodeId: 'human-m1' } },
      },
      {
        id: 'fixture',
        status: 'paused',
        nodes: [],
        metadata: { approval: { nodeId: 'ordinary-approval' } },
      },
      { id: 'fixture', status: 'paused', nodes: [] },
      { id: 'fixture', status: 'failed', nodes: [{ nodeId: 'environment', state: 'failed' }] },
    ];
    const violations = runs.flatMap(run => {
      const c = classify(run),
        hold = holdOf(ledger, run, c);
      return c.state.startsWith('held:') && (!hold || !allowedHolds.has(hold)) ? [c.state] : [];
    });
    expect(violations).toEqual([]);
  });

  test('① parsed config/schema contain no admission or hard-budget fields', () => {
    const forbidden = new Set([
      'max_runs',
      'max_active_runs',
      'run_limit',
      'provider_concurrency',
      'provider_slots',
      'memory_admission',
      'min_free_mb',
      'hard_budget',
      'budget_floor',
      'enforcement',
    ]);
    const fields = (value: unknown, path = ''): string[] => {
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => [
        ...(forbidden.has(key) ? [`${path}/${key}`] : []),
        ...fields(child, `${path}/${key}`),
      ]);
    };
    const schema = JSON.parse(readFileSync(join(WETAMP, 'schemas/plan.schema.json'), 'utf8'));
    expect(fields({ tiers, schema, plan })).toEqual([]);
  });

  for (const role of ['code', 'repair', 'fix']) {
    test(`② generated ${role} prompt requires acceptance before delivery`, () => {
      const nodes = workflow('G1').filter(n => n.id.startsWith(`${role}-`) && n.command);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.command).toBe(`sa-${role}`);
        // Resolve the generated command to its frozen prompt artifact, not TS source text.
        const prompt = readFileSync(
          join(WETAMP, 'templates/.archon/commands', `${node.command}.md`),
          'utf8'
        );
        expect({
          command: node.command,
          defersAcceptance: prompt.includes('不要求交付前跑'),
        }).toEqual({ command: node.command, defersAcceptance: false });
        expect(/交付前[^。\n]*(运行|执行|跑通)[^。\n]*验收/.test(prompt)).toBe(true);
      }
    });
  }

  for (const risk of ['G0', 'G1', 'G2'] as const) {
    test(`② ${risk} only G2 or strict generates review nodes`, () => {
      const reviews = (mode: string) =>
        workflow(risk, mode).filter(n => n.command?.startsWith('sa-review'));
      if (risk === 'G2') expect(reviews('auto').length).toBeGreaterThan(0);
      else expect(reviews('auto').map(node => node.id)).toEqual([]);
      expect(reviews('strict').length).toBeGreaterThan(0);
    });
  }

  // probe is private and binds process argv/artifacts; no deterministic injection seam exists.
  test.todo(
    '③ injected sa-check auxiliary/probe failure is engine/diagnostic, never acceptance_failed',
    () => {}
  );

  test('④ every generated AI node retries transient failures and failover includes another vendor', () => {
    const nodes = workflow('G2').filter(n => n.command);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) expect(node.retry).toEqual({ on_error: 'transient' });
    for (const role of ['code', 'repair'] as const) {
      const descriptor = describeExecution(tiers, role, 'G1');
      const initial = executionRoute(tiers, 'codex', 'auto', descriptor).candidates[0];
      const failover = executionRoute(tiers, 'codex', 'auto', descriptor, [], true).candidates;
      expect(failover.some(candidate => candidate.provider !== initial.provider)).toBe(true);
    }
  });

  test('⑤ report exposes slow_nodes and an efficiency budget for each measured attempt', () => {
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'] as const;
    const saved = keys.map(key => process.env[key]);
    const bin = join(root, 'report-stub');
    const events = [0, 1].map(seq => ({
      event_type: 'provider_event',
      step_name: 'code-core',
      data: {
        attemptId: 'a',
        seq,
        observedAt: new Date(seq * 2000000).toISOString(),
        event:
          seq === 0
            ? { type: 'tool_call', toolCallId: 'x', name: 'file_change' }
            : { type: 'tool_call_update', toolCallId: 'x', status: 'completed' },
      },
    }));
    writeFileSync(
      bin,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(
        JSON.stringify({
          id: 'engine',
          status: 'completed',
          nodes: [],
          events,
        })
      )});\n`,
      { mode: 0o755 }
    );
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: bin });
    try {
      const ledger = {
        run_id: 'r',
        archon_run_id: 'engine',
        repo: plan.repo,
        gen_dir: root,
        workflow: 'fixture',
        recoveries: [],
      } as unknown as Ledger;
      const report = buildReport([ledger]);
      expect(report.slow_nodes).toBeArray();
      expect((report.slow_nodes as unknown[]).length).toBeGreaterThan(0);
      expect(report.provider_timing).toMatchObject({
        'r/engine': [{ budget: { over: true, reasons: expect.any(Array) } }],
      });
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
    }
  });
});
