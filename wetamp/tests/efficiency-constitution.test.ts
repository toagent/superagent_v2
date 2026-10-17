import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTiers, WETAMP } from '../src/config';
import { classify, classifyRun, holdOf, reasonHold, type Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { buildWorkflow } from '../src/generate';
import { describeExecution, executionRoute } from '../src/execution';
import { loadPlan, milestones } from '../src/plan';
import { HOLD_POLICY, REASONS, type Hold } from '../src/reasons';
import { buildReport } from '../src/report';
import { fixturePlan, gitRepo, tmp } from './helpers';

// Closed policy set: adding a seventh category requires a constitutional decision.
const HIGH_RISK = [
  '销毁范围外数据',
  '改写共享历史',
  '对外不可撤回',
  '凭据与隐私',
  '越权',
  '再委派',
] as const;
const HIGH_RISK_HOLDS: Record<(typeof HIGH_RISK)[number], readonly string[]> = {
  销毁范围外数据: ['redline'],
  改写共享历史: ['redline'],
  对外不可撤回: ['redline'],
  凭据与隐私: ['redline'],
  越权: ['redline'],
  再委派: ['redline'],
};
// 高危操作可能需要人工执行；六类风险共享 redline 处置，不增加风险类别。
const highRiskHolds = Object.values(HIGH_RISK_HOLDS).flat();
// 显式暂停/取消、human 签收与结构化验收裁决尊重操作者决定；签收类仅在声明 human 时合法。
const operatorHolds = ['paused', 'signoff', 'approval', 'acceptance_adjudication'] as const;
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

  test('① typed coder budget exhaustion is a registered hold and preserves the worktree for retry', () => {
    const run = {
      id: 'fixture',
      status: 'failed',
      working_path: '/preserved/worktree',
      nodes: [
        {
          nodeId: 'code-core',
          state: 'failed',
          execution: {
            lifecycle: {
              status: 'failed',
              error: 'typed failure',
              providerFailure: { class: 'budget_exceeded', evidence: 'typed' },
            },
          },
        },
      ],
    } as unknown as RunView;
    const ledger = { plan: planPath, gen_dir: root, started_at: '2026-10-14T00:00:00Z' } as Ledger;
    const classified = classify(run);
    const held = classifyRun(ledger, run);
    expect(held).toMatchObject({ state: 'held:gate', node: 'code-core' });
    expect(holdOf(ledger, run, held)).toBe('coder_budget');
    expect(run.working_path).toBe('/preserved/worktree');
    expect(classified.state).toBe('failed');
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

  // prettier-ignore
  test('⑤ real report pairs Claude/Codex attempts and preserves unknown measurements', () => {
    const saved = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME, process.env.SA_ARCHON_BIN];
    Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: root, SA_ARCHON_BIN: '' });
    const db = new Database(join(root, 'archon.db'));
    db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT, status TEXT, started_at TEXT, completed_at TEXT, metadata TEXT)');
    db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT, event_type TEXT, step_name TEXT, created_at TEXT, event_order INTEGER, data TEXT)');
    const clock = (s: number) => new Date(Date.UTC(2026, 9, 14) + s * 1000).toISOString();
    db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?)', ['engine', 'failed', clock(0), clock(100), '{}']);
    const insert = (type: string, data: unknown) => db.run('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)', ['engine', type, 'code-core', clock(100), 0, JSON.stringify(data)]);
    for (const [attempt, offset, event] of [
      ['claude', 0, { type: 'tool_call', toolCallId: 'x', name: 'Bash', rawInput: { command: 'cat file' } }],
      ['codex', 90, { type: 'subtask', taskId: 'x', taskType: 'command_execution', status: 'started', description: 'rg pattern file' }],
    ] as const) {
      insert('provider_event', { attemptId: attempt, seq: 0, observedAt: clock(offset), event });
      insert('provider_event', { attemptId: attempt, seq: 1, observedAt: clock(offset + 2), event: attempt === 'claude' ? { type: 'tool_call_update', toolCallId: 'x', status: 'completed' } : { ...event, status: 'completed' } });
      insert('node_failed', { invocation: { id: attempt }, attempt: { id: attempt, startedAt: clock(offset) }, timing: { startedAt: clock(offset), durationMs: 3000 } });
    }
    db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?)', ['missing', 'cancelled', clock(0), clock(100), '{}']);
    db.run('INSERT INTO remote_agent_workflow_events VALUES (?, ?, ?, ?, ?, ?)', ['missing', 'node_failed', 'code-core', clock(100), 0, '{}']);
    db.close();
    try {
      // Unregistered engine runs remain in measurement, with no invented plan or identity.
      const report = buildReport([]);
      expect(report.provider_timing).toMatchObject({ engine: [
        { attempt_id: 'claude', invocation_id: 'claude', cmds: 1, explore_ratio: 1, mcp_calls: 0, model_turns: 0, think_gap_ms: 0 },
        { attempt_id: 'codex', invocation_id: 'codex', cmds: 1, explore_ratio: 1, mcp_calls: 0, model_turns: 0, think_gap_ms: 0 },
      ] });
      expect(report.measurement).toMatchObject({ engine: { cumulative_ms: 6000, wall_clock_ms: 100000, hold_ms: 'unknown', idle_ms: 'unknown', nodes: [
        { cumulative_ms: 3000, cmds: 1, execution: 'multiple' }, { cumulative_ms: 3000, cmds: 1, execution: 'multiple' },
      ] }, missing: { cumulative_ms: 'unknown', nodes: [{ execution: 'unknown', invocation: 'unknown', attempt: 'unknown', cumulative_ms: 'unknown', cmds: 'unknown', explore_ratio: 'unknown', mcp_calls: 'unknown', model_turns: 'unknown', think_gap_ms: 'unknown' }] } });
    } finally {
      ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ARCHON_BIN'].forEach((k,i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
  });
});
