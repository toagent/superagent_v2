import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTiers, WETAMP } from '../src/config';
import { classify, holdOf, reasonHold, type Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { buildWorkflow } from '../src/generate';
import { describeExecution, executionRoute } from '../src/execution';
import { loadPlan, milestones } from '../src/plan';
import { HOLD_POLICY, REASONS, type Hold } from '../src/reasons';
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
// 高危操作可能需要人工执行；六类风险共享 redline 处置，不增加风险类别。
const highRiskHolds = Object.values(HIGH_RISK_HOLDS).flat();
// 显式暂停/取消与 human 签收尊重操作者决定；签收类仅在声明 human 时合法。
const operatorHolds = ['paused', 'signoff', 'approval'] as const;
// 自动补环境后仍缺外部资源等价于带 needs 的 blocked，不能凭空补齐资源。
const externalResourceHolds = ['environment'] as const;
const allowedHolds = new Set([...highRiskHolds, ...operatorHolds, ...externalResourceHolds]);
const tiers = loadTiers();
const root = tmp();
const planPath = fixturePlan(root, gitRepo(root), p => {
  p.packages = [(p.packages as Record<string, unknown>[])[0]];
  delete (p.packages as Record<string, unknown>[])[0].review;
  delete p.deadline;
  delete p.budget;
});
const plan = loadPlan(planPath, [root]);
type Node = { id: string; command?: string; retry?: unknown; when?: string; approval?: unknown };
const workflow = (risk: 'G0' | 'G1' | 'G2', mode = 'auto', review = false): Node[] => {
  const p = structuredClone(plan);
  p.packages[0].risk = risk;
  p.packages[0].review = review;
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

  test('① waiting policies belong to high-risk, explicit operator, or external-resource closed sets', () => {
    const violations = REASONS.filter(reason => {
      const policy = HOLD_POLICY[reason.hold];
      return (
        (policy.do === 'ask' ||
          policy.do === 'signoff' ||
          policy.do === 'resume' ||
          reason.hold === 'environment') &&
        !allowedHolds.has(reason.hold)
      );
    }).map(reason => reason.code);
    expect(violations).toEqual([]);
    // A new policy must fail even before a reason starts using it.
    expect(
      Object.entries(HOLD_POLICY).filter(
        ([hold, policy]) =>
          (['ask', 'signoff', 'resume'].includes(policy.do) || hold === 'environment') &&
          !allowedHolds.has(hold)
      )
    ).toEqual([]);
  });

  test('① classify/holdOf preserves explicit waits and plan-scoped human signoff', () => {
    const ledger = { plan: planPath, gen_dir: root, started_at: '2026-10-14T00:00:00Z' } as Ledger;
    const cases: { run: RunView; state: string; hold: Hold }[] = [
      { run: { id: 'fixture', status: 'paused', nodes: [] }, state: 'held:paused', hold: 'paused' },
      {
        run: {
          id: 'fixture',
          status: 'failed',
          nodes: [{ nodeId: 'environment', state: 'failed' }],
        },
        state: 'held:environment',
        hold: 'environment',
      },
    ];
    for (const { run, state, hold } of cases) {
      const c = classify(run);
      expect(c.state).toBe(state);
      expect(holdOf(ledger, run, c)).toBe(hold);
      expect(allowedHolds.has(hold)).toBe(true);
    }
    // cancelled_source is a structured reason, not a separate classify state.
    expect(reasonHold('cancelled_source')).toBe('paused');
    expect(classify({ id: 'fixture', status: 'cancelled', nodes: [] }).state).toBe('cancelled');

    for (const human of [false, true]) {
      const p = structuredClone(plan);
      if (human) p.packages[0].signoff = 'human';
      else delete p.packages[0].signoff;
      const nodes = buildWorkflow(p, milestones(p), 'constitution', root, false, 0, tiers)
        .nodes as Node[];
      const approvals = nodes.filter(n => n.approval);
      expect(approvals.length > 0).toBe(p.packages[0].signoff === 'human');
      expect(nodes.some(n => n.id.startsWith('signoff-'))).toBe(human);
      for (const node of approvals) {
        expect(p.packages[0].signoff).toBe('human');
        const run: RunView = {
          id: 'fixture',
          status: 'paused',
          nodes: [],
          metadata: { approval: { nodeId: node.id } },
        };
        expect(classify(run).state).toBe('held:human');
        expect(holdOf(ledger, run, classify(run))).toBe('signoff');
        // classify/holdOf do not read plan: the generator owns signoff scoping.
        const approval: RunView = {
          ...run,
          metadata: { approval: { nodeId: 'ordinary-approval' } },
        };
        expect(classify(approval).state).toBe('held:paused');
        expect(holdOf(ledger, approval, classify(approval))).toBe('approval');
      }
    }
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

  // budgetUsage only measures usage; sa-check budget/finish/accept and CLI recheck
  // are private, so exported functions cannot prove advisory versus block/held behavior.
  test.todo(
    '① exceeding budget emits advisory without block/held (no exported disposition entry)',
    () => {}
  );

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
    test(`② ${risk} reviews are guarded only when runtime G2 escalation is needed`, () => {
      const reviews = (mode: string, review = false) =>
        workflow(risk, mode, review).filter(n => n.command?.startsWith('sa-review'));
      const auto = reviews('auto');
      expect(auto.length).toBeGreaterThan(0);
      for (const node of auto) {
        const guard = `$diff-${node.id.slice('review-'.length)}.output.risk == 'G2'`;
        if (risk === 'G2') expect(node.when).not.toContain(guard);
        else expect(node.when).toContain(guard);
      }
      for (const nodes of [reviews('strict'), reviews('auto', true)]) {
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) expect(node.when).not.toContain(".output.risk == 'G2'");
      }
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
