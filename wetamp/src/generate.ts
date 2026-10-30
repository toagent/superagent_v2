import { executionTable, executionRoute, executionNode } from './execution';
import { assertBackgroundDispatchable, parseWorkflow } from '@archon/workflows/loader';
import { assertComposedGateDriveable } from '@archon/workflows/utils/workflow-requirements';
// plan → $SUPERAGENT_HOME/gen/<run>/：Archon 工作流源（git 仓库）+ 工作包 brief。
// 计划文本只进 brief 文件、经绝对路径传给节点：with:/command 正文是模板，`$` 无法转义。
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { RECOVERY_TIMEOUT_MS } from '../templates/.archon/scripts/env-precheck';
import { REASONS } from './reasons';
import { injectMemory } from './memory';
import {
  attemptPath,
  CHECK_AUX_BUDGET_MS,
  PROCESS_TREE_RECOVERY_MS,
  RESOURCE_WAIT_BUDGET_S,
  environmentChecks,
  reviewRoundLimit,
  type RecoveryEvidence,
} from '../templates/.archon/scripts/sa-check';
import { archon, tail, QUERY_TIMEOUT_MS } from './archon';
import { caller, cleanEngine, coord, repoScope, runScope } from './coord';
import { integrationNodeTimeout } from './integration';
import {
  WETAMP,
  assertSQLite,
  home,
  loadTiers,
  runAliases,
  resolveRoute,
  routeState,
  type RouteState,
  snapshotPolicy,
  type Tiers,
} from './config';
import {
  capsOf,
  draftFor,
  GENERATED_OUTPUT_PATHS,
  milestones,
  type Caps,
  type Milestone,
  type Pkg,
  type Plan,
} from './plan';
import {
  acceptOutputFormat,
  attemptOutputFormat,
  coderOutputFormat,
  conditionalOutput,
  contextOutputFormat,
  deliveryOutputFormat,
  gateHashInput,
  output,
  publishOutputFormat,
  ref,
  reviewerOutputFormat,
  syncOutputFormat,
  untilStatus,
  type AcceptOutput,
  type CoderOutput,
  type ContextOutput,
  type DeliveryDecision,
  type DeliveryOutput,
  type PublishOutput,
  type ReviewerOutput,
  type SyncOutput,
} from './contract';

const YAML = createRequire(join(WETAMP, '..', 'packages', 'server', 'package.json'))('yaml') as {
  stringify(v: unknown, opts: Record<string, unknown>): string;
};
type Node = Record<string, unknown>;

/** One traversal owns hashing; callers own workflow and resident input scopes. */
function hashInputs(root: string, paths: string[], seed = ''): string {
  const hash = new Bun.CryptoHasher('sha256').update(seed);
  const add = (path: string): void => {
    hash.update(JSON.stringify(path)).update(readFileSync(join(root, path)));
  };
  const walk = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else add(child);
    }
  };
  for (const path of paths) {
    if (statSync(join(root, path)).isDirectory()) walk(path);
    else add(path);
  }
  return hash.digest('hex');
}

/** Hash generation-time snapshots; execution-time reads through WETAMP do not require adopt. */
// prettier-ignore
export const engineHash = (root = WETAMP, policyHash = snapshotPolicy(loadTiers(join(root, 'tiers.json'))).hash): string => hashInputs(root, [
  '../packages/workflows/src/provider-attempts.ts',
  'templates/.archon', 'src/generate.ts', 'src/reasons.ts', 'src/config.ts', 'src/claude-health.ts', 'src/plan.ts',
  'schemas/output.schema.json', 'templates/brief.md', 'tiers.json',
  'schemas/nodes', 'src/contract',
  // Lesson selection/injection and node roles freeze into generated briefs, commands and YAML.
  'src/memory.ts', 'src/board/workflow.ts', 'src/execution.ts',
], policyHash);
/** Shared by console restart and board refresh; includes their CLI/data consumers. */
export const residentHash = (root = WETAMP): string => hashInputs(root, ['src'], engineHash(root));

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${ts}-${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`;
}

const REVIEW_IDLE_MS = 15 * 60 * 1000;
const SOLDIER_IDLE_MS = 10 * 60 * 1000;

export interface Carried {
  from: string;
  packages: string[];
  freshDirectory?: boolean;
  evidence?: Record<string, string>;
  coded?: string[];
  reviews?: Partial<Record<string, ReviewCheckpoint>>;
  recovery?: RecoveryEvidence & { admitted_by: unknown; admitted_at: string };
}
// prettier-ignore
export interface ReviewCheckpoint { gate: Record<string, unknown> & { decision: DeliveryDecision; reviewed_head: string; reviewed_diff_hash: string; ledger_file: string }; check: Record<string, unknown> & { contract_hash: string } }

const check = (id: string, deps: string[], inputs: Node, extra: Node = {}): Node => ({
  id,
  script: 'sa-check',
  runtime: 'bun',
  ...(deps.length ? { depends_on: deps } : {}),
  with: inputs,
  ...extra,
});

// 与 Archon subprocess 默认值的契约由 generate.test.ts 校验；不是 CLI 查询超时。
const ARCHON_SUBPROCESS_DEFAULT_TIMEOUT_MS = 120_000;
// 子进程均有独立上界；额外 5s 仅供 Bun 启动、hash 和本地文件操作。
const CHECK_OVERHEAD_MS = 5_000;
const commandTimeout = (checks: Pkg['accept'], passes: number, setup: Pkg['accept'] = []): Node =>
  checks.length
    ? {
        timeout: Math.max(
          ARCHON_SUBPROCESS_DEFAULT_TIMEOUT_MS,
          checks.reduce((n, c) => n + c.timeout_s, 0) * passes * 1000 +
            setup.reduce((n, c) => n + c.timeout_s, 0) * 1000 +
            CHECK_AUX_BUDGET_MS +
            CHECK_OVERHEAD_MS +
            RESOURCE_WAIT_BUDGET_S * 1000 +
            PROCESS_TREE_RECOVERY_MS
        ),
      }
    : {};
// acceptOnce 串行跑全部命令，再于基线准备环境并 probe 失败命令；settle 修复后也跑 acceptOnce。
const acceptTimeout = (pkgs: Pkg[], plan: Plan): Node =>
  commandTimeout(
    pkgs.flatMap(p => p.accept),
    2,
    environmentChecks(plan)
  );

/**
 * 纯函数：plan + 里程碑 → 工作流对象（黄金测试比对此结果；now 固定以得到确定的 deadline_ms）。
 * 每个里程碑：start → 逐包 code/verify/[repair]/settle → 至多 policy 轮次的 diff → review → gate（后续各轮前有 when 守卫的
 * fix）。verify 不 advance 时包内修复一次（repair），settle 复验；失败（fail）即该节点失败、run 终止，后续包与
 * 评审都不启动。验收未 advance 的轮次跳过评审，gate 按验收原因直接进入修复。未走到的轮次被条件跳过，下一里程碑以
 * none_failed_min_one_success 汇合各轮 gate；escalate 即 gate 失败、run 停下。
 * fake：AI 节点换成 bash 桩，零模型调用跑通整条 DAG——首轮评审 FAIL（一条 high），修复追加一行，第 2 轮关闭它并 PASS。
 */
export function buildWorkflow(
  plan: Plan,
  ms: Milestone[],
  run: string,
  gen: string,
  fake = false,
  now = Date.now(),
  tiers: Tiers = loadTiers(),
  carried?: Carried,
  delivery?: import('./land').DeliveryTarget,
  engineSnapshot?: string,
  state: RouteState = routeState(tiers, plan.mode, now)
): Node {
  const engineWetamp = engineSnapshot ? join(engineSnapshot, 'wetamp') : WETAMP;
  // 只拒绝显式 deadline 已过的 plan；缺省没有交付期限。
  if (plan.deadline !== undefined && Date.parse(plan.deadline) <= now)
    throw new Error(`plan invalid: /deadline ${plan.deadline} already passed`);
  const aliases = runAliases(plan.console ?? 'claude', tiers, plan.mode, state);
  const executions = executionTable(plan, tiers);
  const maxRounds = reviewRoundLimit(tiers.policy);
  const evidenceScopeBase = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    for (const [candidate, json] of [
      [path, true],
      [path.replace(/\.json$/, '.scope-base'), false],
    ] as const) {
      try {
        const raw = readFileSync(candidate, 'utf8');
        const value = json ? (JSON.parse(raw) as { scope_base?: unknown }).scope_base : raw.trim();
        if (typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)) return value;
      } catch {
        // Missing or legacy evidence falls through to the next representation.
      }
    }
    return undefined;
  };
  const carriedScopeBase = [
    ...Object.values(carried?.evidence ?? {}),
    ...(carried?.recovery?.rounds.flatMap(round => {
      const legacy = round as Partial<typeof round>;
      return [legacy.source?.path, legacy.freeze?.path];
    }) ?? []),
  ]
    .map(evidenceScopeBase)
    .find(Boolean);
  const resuming = Boolean(
    carried &&
    (carried.freshDirectory === true ||
      carried.packages.length > 0 ||
      (carried.coded?.length ?? 0) > 0 ||
      Object.keys(carried.evidence ?? {}).length > 0 ||
      carried.recovery !== undefined ||
      Object.keys(carried.reviews ?? {}).length > 0)
  );
  const execution = (id: string): Node => {
    if (fake) return {};
    const descriptor = executions[id];
    const candidate = executionRoute(
      tiers,
      plan.console ?? 'claude',
      plan.mode,
      descriptor,
      descriptor.role === 'review' ? [aliases['@sa-coder'].model] : [],
      false,
      state
    ).candidates[0];
    return {
      ...executionNode(descriptor, candidate),
      ...(descriptor.role !== 'review' && candidate.provider === 'claude'
        ? { maxBudgetUsd: tiers.policy.coder_budget_usd.claude }
        : {}),
    };
  };
  const planPath = join(gen, 'plan.json');
  const policyPath = join(gen, 'policy.json');
  // fake 不查执行层台账：身份记 fake、预算不检查（桩节点没有 spend/binding）
  const ledger = fake ? {} : { archon: join(gen, 'archon') };
  const brief = (p: Pkg): string => join(gen, 'briefs', `${p.id}.md`);
  const nodes: Node[] = [
    check(
      'environment',
      [],
      { kind: 'env', plan: planPath, ...ledger },
      {
        // Precheck can prescribe one install and one prepare command, each with its own limit.
        timeout:
          Number(
            commandTimeout(environmentChecks(plan), 1).timeout ??
              ARCHON_SUBPROCESS_DEFAULT_TIMEOUT_MS
          ) +
          2 * RECOVERY_TIMEOUT_MS,
        retry: { max_attempts: tiers.policy.auto_retry.environment, on_error: 'all' },
      }
    ),
  ];
  const attemptInputs = (counter: string, pkg = '', review = '', gate = ''): Node => ({
    script: 'sa-context',
    runtime: 'bun',
    with: { counter, gen, pkg, review, ...(gate ? { gate } : {}) },
  });
  const integrationCommand = (
    action: 'sync' | 'publish',
    milestone: string,
    extra = '',
    output = `${action}-${milestone}`
  ): string =>
    `INPUTS_ACTION=${action} INPUTS_RUN='${run}' INPUTS_MILESTONE='${milestone}' INPUTS_OUTPUT=${output} ${extra}bun '${join(
      engineWetamp,
      'src/land.ts'
    ).replaceAll("'", "'\\''")}'`;
  const integrationScript = (milestone: string, output: string): string =>
    [
      `const child = Bun.spawn([process.execPath, ${JSON.stringify(
        join(engineWetamp, 'src/land.ts')
      )}], {`,
      `  env: { ...process.env, INPUTS_ACTION: 'publish', INPUTS_RUN: '${run}', INPUTS_MILESTONE: '${milestone}', INPUTS_OUTPUT: '${output}' },`,
      `  stdout: 'pipe', stderr: 'pipe',`,
      `});`,
      `const [stdout, stderr, exitCode] = await Promise.all([`,
      `  new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited,`,
      `]);`,
      `process.stdout.write(new Uint8Array(stdout));`,
      `process.stderr.write(new Uint8Array(stderr));`,
      `if (exitCode !== 0) process.exit(exitCode);`,
    ].join('\n');
  if (delivery && (!run || /[^0-9a-f-]/.test(run))) throw new Error('delivery: invalid run id');
  let after: Node = { depends_on: ['environment'] };
  let runBase = '',
    scopeBase = carriedScopeBase ?? '';
  const signoff = (
    m: Milestone,
    gates: Node,
    target = nodes,
    attemptId = `attempt-${m.id}`
  ): Node => {
    if (m.human) {
      target.push({
        id: `human-${m.id}`,
        approval: {
          message: `Approve delivery milestone ${m.id}`,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
        },
        ...gates,
        depends_on: [...((gates.depends_on as string[] | undefined) ?? []), attemptId],
      });
      // Native approval owns the decision; the absolute plan deadline still guards delivery.
      const until =
        plan.deadline === undefined ? undefined : Math.floor(Date.parse(plan.deadline) / 1000);
      target.push({
        id: `signoff-${m.id}`,
        bash:
          until === undefined
            ? 'true'
            : [
                `[ "$(date +%s)" -le ${String(until)} ] || { echo 'signoff ${
                  m.id
                }: plan deadline ${String(plan.deadline)} passed' >&2; exit 1; }`,
              ].join('\n'),
        depends_on: [`human-${m.id}`],
        when: `$human-${m.id}.output.decision == 'approve'`,
      });
      return { depends_on: [`signoff-${m.id}`] };
    }
    return gates;
  };
  const addSync = (
    target: Node[],
    m: Milestone,
    id: string,
    deps: string[],
    resumable: boolean,
    localRef = plan.base_ref
  ): string => {
    const syncHandle = output<SyncOutput>(id);
    const local = [
      `tip=$(git rev-parse --verify '${localRef.replaceAll("'", "'\\''")}^{commit}') || exit $?`,
      'base=$(git merge-base HEAD "$tip") || exit $?',
      `printf '{"status":"noop","target_tip":"%s","merge_base":"%s","head":"%s","generation":1}' "$tip" "$base" "$(git rev-parse HEAD)"`,
    ].join('\n');
    target.push({
      id,
      bash: delivery && !fake ? integrationCommand('sync', m.id, '', id) : local,
      ...(deps.length ? { depends_on: deps } : {}),
      output_format: syncOutputFormat,
    });
    const resolve = `resolve-${id}`;
    if (delivery && !fake) {
      const context = `resolve-context-${id}`;
      target.push({
        id: context,
        ...attemptInputs(attemptPath(gen, `sync/${m.id}`)),
        with: {
          counter: attemptPath(gen, `sync/${m.id}`),
          gen,
          context_node: resolve,
          context_packages: m.packages.map(p => p.id),
        },
        depends_on: [id],
        when: `$${id}.output.status == 'conflict'`,
        output_format: contextOutputFormat,
      });
      const owner = m.packages[0];
      target.push({
        id: resolve,
        ...(resumable && m.packages.length === 1
          ? { context: { resume: `code-${owner.id}` } }
          : {}),
        command: 'sa-repair',
        retry: { on_error: 'transient' },
        model: '@sa-coder',
        ...execution(`repair-${owner.id}`),
        with: {
          pkg: owner.id,
          brief: brief(owner),
          hint: join(gen, 'hints', `${owner.id}.md`),
          context_node: context,
          prior_work: ref.value(syncHandle),
          reason: 'sync_conflict',
          accept_log: `$ARTIFACTS_DIR/${id}.json`,
        },
        depends_on: [id, context],
        when: `$${id}.output.status == 'conflict'`,
        output_format: coderOutputFormat,
      });
    }
    const ready = `${id}-ready`;
    target.push({
      id: ready,
      depends_on: [id, ...(delivery && !fake ? [resolve] : [])],
      trigger_rule: 'none_failed_min_one_success',
      script: [
        "const git = (...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim()); return p.stdout.toString().trim(); };",
        "const tip = process.env.INPUTS_TARGET_TIP ?? '';",
        "let status = process.env.INPUTS_STATUS ?? '';",
        "if (status === 'conflict') { git('merge-base', '--is-ancestor', tip, 'HEAD'); status = 'resolved'; }",
        "const output = { status, target_tip: tip, merge_base: git('merge-base', 'HEAD', tip), head: git('rev-parse', 'HEAD'), generation: Number(process.env.INPUTS_GENERATION) };",
        'process.stdout.write(JSON.stringify(output));',
      ].join('\n'),
      runtime: 'bun',
      with: {
        target_tip: ref.required(syncHandle, 'target_tip'),
        status: ref.required(syncHandle, 'status'),
        generation: ref.required(syncHandle, 'generation'),
      },
      output_format: syncOutputFormat,
    });
    return ready;
  };
  const integrationNode = (
    m: Milestone,
    approved: Node,
    acceptInputs: Node,
    gateBindings: { round: number; node: string; carried?: boolean }[]
  ): Node => {
    const reviewRequired = m.review || m.risk === 'G2';
    // A resync happens only after the milestone gate passed, so at least one round of the
    // package-wide repair/review budget is already spent.
    const resyncMaxRounds = Math.max(1, maxRounds - 1);
    const resyncBase = `resync-base-${m.id}`;
    const syncId = `resync-${m.id}`;
    const resolveId = `resolve-${syncId}`;
    const resolveContract = `resolve-sync-${m.id}`;
    const resolveDecision = `${resolveId}-decision`;
    const syncReady = `${syncId}-ready`;
    const finalAccept = `final-accept-${m.id}`;
    const resyncRound = (round: number): string => `${m.id}-rresync${String(round)}`;
    const acceptId = (round: number): string =>
      round === 1 ? finalAccept : `diff-resync-${m.id}-r${String(round)}`;
    const reviewId = (round: number): string => `review-resync-${m.id}-r${String(round)}`;
    const gateId = (round: number): string => `gate-${resyncRound(round)}`;
    const integrationReady = `integration-ready-${m.id}`;
    const publishId = `publish-${m.id}`;
    const syncHandle = output<SyncOutput>(syncId);
    const readyHandle = output<SyncOutput>(syncReady);
    const resolveHandle = conditionalOutput<CoderOutput>(resolveId);
    const publishHandle = output<PublishOutput>(publishId);
    const gateHashes = Object.fromEntries(
      gateBindings.map(binding => [
        gateHashInput(binding.round, binding.carried).workflow,
        ref.optional(
          conditionalOutput<{ artifact_sha256: string }>(binding.node),
          'artifact_sha256',
          ''
        ),
      ])
    );
    for (let round = 1; round <= resyncMaxRounds; round++)
      gateHashes[gateHashInput(`resync${String(round)}`).workflow] = ref.optional(
        conditionalOutput<{ artifact_sha256: string }>(gateId(round)),
        'artifact_sha256',
        ''
      );
    const integrationNodes: Node[] = [
      {
        id: resyncBase,
        bash: 'git rev-parse HEAD',
      },
      {
        id: syncId,
        depends_on: [resyncBase],
        bash:
          delivery && !fake
            ? integrationCommand('sync', m.id, '', syncId)
            : [
                `tip=$(git rev-parse --verify '${plan.base_ref.replaceAll(
                  "'",
                  "'\\''"
                )}^{commit}') || exit $?`,
                'base=$(git merge-base HEAD "$tip") || exit $?',
                `printf '{"status":"noop","target_tip":"%s","merge_base":"%s","head":"%s","generation":1}' "$tip" "$base" "$(git rev-parse HEAD)"`,
              ].join('\n'),
        timeout: integrationNodeTimeout(),
        output_format: syncOutputFormat,
      },
      ...(delivery && !fake
        ? [
            {
              id: `resolve-context-${syncId}`,
              ...attemptInputs(attemptPath(gen, `sync/${m.id}`)),
              with: {
                counter: attemptPath(gen, `sync/${m.id}`),
                gen,
                context_node: resolveContract,
                context_packages: m.packages.map(p => p.id),
              },
              depends_on: [syncId],
              when: `$${syncId}.output.status == 'conflict'`,
              output_format: contextOutputFormat,
            },
            {
              id: resolveId,
              command: 'sa-repair',
              retry: { on_error: 'transient' },
              model: '@sa-coder',
              ...execution(resolveContract),
              with: {
                pkg: m.packages[0].id,
                brief: brief(m.packages[0]),
                hint: join(gen, 'hints', `${m.packages[0].id}.md`),
                context_node: `resolve-context-${syncId}`,
                prior_work: ref.value(syncHandle),
                reason: 'sync_conflict',
                accept_log: `$ARTIFACTS_DIR/${syncId}.json`,
              },
              depends_on: [syncId, `resolve-context-${syncId}`],
              when: `$${syncId}.output.status == 'conflict'`,
              output_format: coderOutputFormat,
            },
            {
              id: resolveDecision,
              depends_on: [resolveId],
              when: `$${syncId}.output.status == 'conflict'`,
              script: [
                "const coder = JSON.parse(process.env.INPUTS_CODER ?? '{}');",
                "const ok = coder.status === 'done' && coder.error_class == null;",
                "const reason = coder.needs?.length ? 'coder_needs' : 'coder_partial';",
                "const decision = { kind: ok ? 'advance' : 'block', reason: ok ? null : reason, evidence: [], debt: [], blockers: coder.blockers ?? [], needs: coder.needs ?? [] };",
                `const out = { decision, disposition: ok ? 'advance' : 'fail', reason: decision.reason };`,
                `await Bun.write(process.env.ARTIFACTS_DIR + '/${resolveDecision}.json', JSON.stringify(out));`,
                'process.stdout.write(JSON.stringify(out));',
                'if (!ok) process.exit(1);',
              ].join('\n'),
              runtime: 'bun',
              with: { coder: ref.optionalValue(resolveHandle, null) },
            },
          ]
        : []),
      {
        id: syncReady,
        depends_on: [syncId, ...(delivery && !fake ? [resolveDecision] : [])],
        trigger_rule: 'none_failed_min_one_success',
        script: [
          "const git = (...args: string[]) => { const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim()); return p.stdout.toString().trim(); };",
          "const tip = process.env.INPUTS_TARGET_TIP ?? '';",
          "let status = process.env.INPUTS_STATUS ?? '';",
          "if (status === 'conflict') { git('merge-base', '--is-ancestor', tip, 'HEAD'); status = 'resolved'; }",
          "const output = { status, target_tip: tip, merge_base: git('merge-base', 'HEAD', tip), head: git('rev-parse', 'HEAD'), generation: Number(process.env.INPUTS_GENERATION) };",
          'process.stdout.write(JSON.stringify(output));',
        ].join('\n'),
        runtime: 'bun',
        with: {
          target_tip: ref.required(syncHandle, 'target_tip'),
          status: ref.required(syncHandle, 'status'),
          generation: ref.required(syncHandle, 'generation'),
        },
        output_format: syncOutputFormat,
      },
    ];
    const resyncRounds: Node = {};
    let previous = syncReady;
    for (let round = 1; round <= resyncMaxRounds; round++) {
      const accepted = acceptId(round);
      const acceptedHandle = conditionalOutput<AcceptOutput>(accepted);
      const reviewer = reviewId(round);
      const reviewerHandle = conditionalOutput<ReviewerOutput>(reviewer);
      const gate = gateId(round);
      const reviewContract = `review-${m.id}-r${String(round)}`;
      const reviewAttempt = `attempt-review-resync-${m.id}-r${String(round)}`;
      const reviewContext = `review-context-resync-${m.id}-r${String(round)}`;
      const reviewWhen =
        `$${syncReady}.output.status == 'resolved' && ` +
        `$${accepted}.output.disposition == 'advance'`;
      if (round > 1) {
        const priorGate = gateId(round - 1);
        const handoff = `handoff-resync-${m.id}-r${String(round)}`;
        const fix = `fix-resync-${m.id}-r${String(round)}`;
        if (!fake)
          integrationNodes.push({
            id: handoff,
            ...attemptInputs(attemptPath(gen, m.id)),
            with: {
              counter: attemptPath(gen, m.id),
              gen,
              context_node: `fix-${m.id}-r${String(round)}`,
              context_packages: m.packages.map(p => p.id),
              handoff: '1',
              work_keys: round === 2 ? (delivery ? ['resolve'] : []) : ['fix'],
              ...(round === 2
                ? delivery
                  ? { work_resolve: ref.optionalValue(resolveHandle, null) }
                  : {}
                : {
                    work_fix: ref.optionalValue(
                      conditionalOutput<CoderOutput>(`fix-resync-${m.id}-r${String(round - 1)}`),
                      null
                    ),
                  }),
            },
            depends_on: [priorGate],
            when: `$${priorGate}.output.verdict == 'fix'`,
          });
        integrationNodes.push({
          id: fix,
          ...(fake
            ? { bash: fakeEdit(m.packages[0], `fix resync ${m.id} r${String(round)}`) }
            : {
                command: 'sa-fix',
                retry: { on_error: 'transient' },
                model: '@sa-coder',
                ...execution(`fix-${m.id}-r${String(round)}`),
                with: {
                  prior_work: `$${handoff}.output.handoff`,
                  context_node: handoff,
                  milestone: m.id,
                  round,
                  ledger: `$${priorGate}.output.ledger_file`,
                  accept_log: ref.optional(
                    conditionalOutput<AcceptOutput>(acceptId(round - 1)),
                    'log',
                    ''
                  ),
                  briefs: m.packages.map(brief).join(' '),
                  hints: join(gen, 'hints'),
                },
              }),
          depends_on: fake ? [priorGate] : [priorGate, handoff],
          when: `$${priorGate}.output.verdict == 'fix'`,
          output_format: coderOutputFormat,
        });
        previous = fix;
      }
      integrationNodes.push(
        check(
          accepted,
          [previous],
          {
            ...acceptInputs,
            kind: 'accept',
            base: ref.required(readyHandle, 'merge_base'),
            target_tip: ref.required(readyHandle, 'target_tip'),
            sync_generation: ref.required(readyHandle, 'generation'),
            acceptance_evidence:
              round === 1
                ? `$ARTIFACTS_DIR/accepted-${m.id}.json`
                : `$ARTIFACTS_DIR/${acceptId(round - 1)}.json`,
            context_node: reviewContract,
            context_counter: attemptPath(gen, `review-resync-${m.id}-r${String(round)}`),
            tag: accepted,
            ...(round === 1
              ? {
                  delta_remerge: '1',
                  terminal: 'unless_resolved',
                  sync_status: ref.required(readyHandle, 'status'),
                }
              : {
                  coder: ref.optionalValue(
                    conditionalOutput<CoderOutput>(`fix-resync-${m.id}-r${String(round)}`),
                    null
                  ),
                  delta_base: `$${gateId(round - 1)}.output.head`,
                  reviewed_diff_hash: `$${gateId(round - 1)}.output.reviewed_diff_hash`,
                }),
          },
          { output_format: acceptOutputFormat, ...acceptTimeout(m.packages, plan) }
        )
      );
      integrationNodes.push({
        id: reviewAttempt,
        when: reviewRequired ? reviewWhen : `$${syncReady}.output.status == '__never__'`,
        depends_on: [accepted],
        ...attemptInputs(attemptPath(gen, `review-resync-${m.id}-r${String(round)}`)),
        output_format: attemptOutputFormat,
      });
      if (!fake)
        integrationNodes.push({
          id: reviewContext,
          when: reviewRequired ? reviewWhen : `$${syncReady}.output.status == '__never__'`,
          always_run: true,
          depends_on: [reviewAttempt],
          ...attemptInputs(
            attemptPath(gen, `review-resync-${m.id}-r${String(round)}`),
            '',
            reviewContract,
            gate
          ),
          output_format: attemptOutputFormat,
        });
      integrationNodes.push({
        id: reviewer,
        when: reviewRequired ? reviewWhen : `$${syncReady}.output.status == '__never__'`,
        ...(fake
          ? { bash: fakeReview(round) }
          : {
              command: 'sa-review-delta',
              retry: { on_error: 'transient' },
              model: tiers.routing.reviewer.by_risk?.[m.risk]
                ? `@sa-reviewer-${m.risk}`
                : '@sa-reviewer',
              ...execution(reviewContract),
              idle_timeout: REVIEW_IDLE_MS,
              with: {
                milestone: m.id,
                risk: ref.optional(acceptedHandle, 'risk', ''),
                round,
                context: `$ARTIFACTS_DIR/${reviewContract}.context.json`,
                briefs: m.packages.map(brief).join(' '),
                accept_log: ref.optional(acceptedHandle, 'log', ''),
                diff: ref.optional(acceptedHandle, 'delta', ''),
                full_diff: ref.optional(acceptedHandle, 'patch', ''),
                ledger: round === 1 ? '' : `$${gateId(round - 1)}.output.ledger_file`,
              },
            }),
        depends_on: [accepted, fake ? reviewAttempt : reviewContext],
        output_format: reviewerOutputFormat,
      });
      resyncRounds[`R${String(round)}`] = ref.optionalValue(reviewerHandle, null);
      resyncRounds[`C${String(round)}`] = `$ARTIFACTS_DIR/${accepted}.json`;
      resyncRounds[`C${String(round)}_HEAD`] = ref.optional(acceptedHandle, 'head', '');
      resyncRounds[`C${String(round)}_DIFF_HASH`] = ref.optional(acceptedHandle, 'diff_hash', '');
      resyncRounds[`C${String(round)}_SHA256`] = ref.optional(
        acceptedHandle,
        'artifact_sha256',
        ''
      );
      integrationNodes.push(
        check(
          gate,
          [accepted, reviewer],
          {
            kind: 'gate',
            review: reviewRequired ? '1' : '0',
            review_node: reviewer,
            round,
            ...resyncRounds,
            risk: m.risk,
            milestone: m.id,
            pkgs: m.packages.map(p => p.id).join(','),
            plan: planPath,
            policy: policyPath,
            tag: gate,
            ...ledger,
          },
          {
            trigger_rule: 'none_failed_min_one_success',
            when: `$${syncReady}.output.status == 'resolved'`,
          }
        )
      );
      previous = gate;
    }
    integrationNodes.push(
      {
        id: integrationReady,
        depends_on: [
          finalAccept,
          ...Array.from({ length: resyncMaxRounds }, (_, i) => gateId(i + 1)),
        ],
        trigger_rule: 'none_failed_min_one_success',
        script: [
          "const status = process.env.INPUTS_STATUS ?? '';",
          "const disposition = process.env.INPUTS_DISPOSITION ?? '';",
          `const gates = [${Array.from(
            { length: resyncMaxRounds },
            (_, i) => `process.env.INPUTS_GATE_${String(i + 1)} ?? ''`
          ).join(', ')}];`,
          "const ok = status === 'resolved' ? gates.includes('pass') : ['advance', 'debt'].includes(disposition);",
          "if (!ok) throw new Error('integration candidate is not approved');",
        ].join('\n'),
        runtime: 'bun',
        with: {
          status: ref.required(readyHandle, 'status'),
          disposition: ref.optional(
            conditionalOutput<AcceptOutput>(finalAccept),
            'disposition',
            'fail'
          ),
          ...Object.fromEntries(
            Array.from({ length: resyncMaxRounds }, (_, i) => [
              `gate_${String(i + 1)}`,
              ref.optional(conditionalOutput<{ verdict: string }>(gateId(i + 1)), 'verdict', ''),
            ])
          ),
        },
      },
      {
        id: publishId,
        depends_on: [integrationReady],
        ...(delivery && !fake
          ? {
              script: integrationScript(m.id, publishId),
              runtime: 'bun',
              with: {
                ...gateHashes,
                target_tip: ref.required(readyHandle, 'target_tip'),
                review_required: reviewRequired ? '1' : '0',
              },
            }
          : {
              script: [
                "const tip = process.env.INPUTS_TARGET_TIP ?? '';",
                "const output = { status: 'published', receipt: { task: 'fake', source: tip, target: { checkout: 'fake', branch: 'fake' }, target_tip: tip, contract: 'fake', evidence: 'fake', integrated: tip, status: 'published' } };",
                `await Bun.write(process.env.ARTIFACTS_DIR + '/${publishId}.json', JSON.stringify(output));`,
                'process.stdout.write(JSON.stringify(output));',
              ].join('\n'),
              runtime: 'bun',
              with: { target_tip: ref.required(readyHandle, 'target_tip') },
            }),
        timeout: integrationNodeTimeout(),
        output_format: publishOutputFormat,
      }
    );
    return {
      id: `integrate-${m.id}`,
      ...approved,
      loop_group: {
        max_iterations: 3,
        until_bash: untilStatus(publishHandle, 'published'),
        nodes: integrationNodes,
      },
    };
  };
  for (const m of ms) {
    const covered = ms.slice(0, ms.indexOf(m) + 1).flatMap(k => k.packages);
    const scope_pkgs = covered.map(p => p.id).join(',');
    const syncReady = addSync(
      nodes,
      m,
      `sync-${m.id}`,
      after.depends_on as string[],
      false,
      carried?.recovery?.base ?? plan.base_ref
    );
    const syncReadyHandle = output<SyncOutput>(syncReady);
    runBase ||= ref.required(syncReadyHandle, 'merge_base');
    if (!resuming) scopeBase ||= ref.required(syncReadyHandle, 'head');
    let base = ref.required(syncReadyHandle, 'merge_base');
    // Milestone retries invalidate only cumulative acceptance and review/fix rounds.
    const attempt = `attempt-${m.id}`;
    nodes.push({
      id: attempt,
      ...attemptInputs(attemptPath(gen, m.id)),
      depends_on: [syncReady],
      always_run: true,
      output_format: attemptOutputFormat,
    });
    if (carried?.recovery) {
      const e = carried.recovery,
        r = e.rounds.length,
        tag = `${m.id}-r${String(r)}`;
      const ids = m.packages.map(p => p.id).join(',');
      const rounds = Object.fromEntries(
        e.rounds.flatMap((_, i) => {
          const n = String(i + 1),
            diff = `diff-${m.id}-r${n}`;
          const diffHandle = conditionalOutput<AcceptOutput>(diff);
          return [
            [`R${n}`, 'null'],
            [`C${n}`, i + 1 === r ? `$ARTIFACTS_DIR/diff-${tag}.json` : 'null'],
            [`C${n}_HEAD`, i + 1 === r ? ref.optional(diffHandle, 'head', '') : ''],
            [`C${n}_DIFF_HASH`, i + 1 === r ? ref.optional(diffHandle, 'diff_hash', '') : ''],
            [`C${n}_SHA256`, i + 1 === r ? ref.optional(diffHandle, 'artifact_sha256', '') : ''],
          ];
        })
      );
      const common = {
        plan: planPath,
        policy: e.policy.path,
        pkgs: ids,
        scope_pkgs,
        scope_base: scopeBase,
        risk: m.risk,
        milestone: m.id,
        target_tip: ref.required(syncReadyHandle, 'target_tip'),
        sync_generation: ref.required(syncReadyHandle, 'generation'),
        ...ledger,
      };
      nodes.push(
        check(
          `diff-${tag}`,
          [syncReady, attempt],
          { ...common, kind: 'accept', base, tag: `diff-${tag}` },
          { output_format: acceptOutputFormat, ...acceptTimeout(m.packages, plan) }
        )
      );
      nodes.push(
        check(`gate-${tag}`, [`diff-${tag}`], {
          ...common,
          kind: 'gate',
          round: r,
          tag: `gate-${tag}`,
          ...rounds,
          recovery_evidence: join(gen, 'recovery-evidence.json'),
          recovery_sha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(e)).digest('hex'),
          operator_id: run,
        })
      );
      nodes.push(
        integrationNode(m, signoff(m, { depends_on: [`gate-${tag}`] }), common, [
          { round: r, node: `gate-${tag}` },
        ])
      );
      after = { depends_on: [`integrate-${m.id}`] };
      continue;
    }
    let prev = syncReady;
    const rawCheckpoint = carried?.reviews?.[m.id];
    // prettier-ignore
    const checkpoint = rawCheckpoint?.gate.decision && ['advance', 'debt'].includes(rawCheckpoint.gate.decision.kind) ? rawCheckpoint : undefined;
    // prettier-ignore
    const checkpointAtoms = checkpoint ? [['head', checkpoint.gate.reviewed_head], ['diff_hash', checkpoint.gate.reviewed_diff_hash],
      ['contract_hash', checkpoint.check.contract_hash]] as const : [];
    // prettier-ignore
    const checkpointCondition = (operator: '==' | '!=', joiner: string): string | undefined => checkpoint
      ? checkpointAtoms.map(([field, value]) => `$diff-${m.id}-r1.output.${field} ${operator} '${value}'`).join(joiner) : undefined;
    const checkpointMatch = checkpointCondition('==', ' && '),
      checkpointDrift = checkpointCondition('!=', ' || ');
    const last = ms.at(-1) === m;
    for (const p of m.packages) {
      const rulerChecks = p.accept.filter(c => c.base_expect_fail?.length);
      const ruler = rulerChecks.length ? `baseline-ruler-${p.id}` : undefined;
      if (ruler)
        nodes.push(
          check(
            ruler,
            [prev],
            {
              kind: 'ruler',
              plan: planPath,
              pkgs: p.id,
              tag: ruler,
              skip: carried ? 'candidate_carried' : '',
            },
            commandTimeout(rulerChecks, 1)
          )
        );
      const packageStart = ruler ?? prev;
      const pkgAttempt = `package-attempt-${p.id}`;
      const pkgAttemptHandle = output<ContextOutput>(pkgAttempt);
      nodes.push({
        id: pkgAttempt,
        ...attemptInputs(attemptPath(gen, `pkg/${p.id}`), p.id),
        depends_on: [packageStart],
        always_run: true,
        output_format: contextOutputFormat,
      });
      // Carry only the initial package attempt; retries keep the native coder and hint binding.
      const resumed = carried?.packages.includes(p.id)
        ? 'carried'
        : carried?.coded?.includes(p.id)
          ? 'coded'
          : undefined;
      const carry: CoderOutput | undefined =
        resumed && carried
          ? {
              status: 'done',
              changed_files: [],
              quick_checks: [],
              notes: `${resumed} from ${carried.from}`,
              blockers: [],
              error_class: null,
              deviations: [],
              needs: [],
            }
          : undefined;
      const carriedEvidence = carried?.evidence?.[p.id]
        ? join(gen, 'carried-evidence', `${p.id}.json`)
        : undefined;
      const soldier =
        !fake && !carry && draftFor(p) === 'soldier' && tiers.routing.soldier?.models.length
          ? `soldier-${p.id}`
          : undefined;
      const soldierOk = soldier ? `soldier-ok-${p.id}` : undefined;
      const soldierReset = soldier ? `soldier-reset-${p.id}` : undefined;
      if (soldier && soldierOk && soldierReset)
        nodes.push(
          {
            id: `soldier-items-${p.id}`,
            depends_on: [packageStart, pkgAttempt],
            bash: `printf '%s' '[{"pkg":"${p.id}"}]'`,
          },
          {
            id: soldier,
            include: `sa-soldier-${p.id}`,
            depends_on: [`soldier-items-${p.id}`],
            with: { pkg: p.id, context_node: pkgAttempt },
            fan_out: {
              items: `$soldier-items-${p.id}.output`,
              as: 'draft',
              max_parallel: 1,
              join: 'all_done',
            },
          },
          {
            id: soldierOk,
            depends_on: [soldier],
            script: [
              'try {',
              '  const v = JSON.parse(process.env.INPUTS_RESULT ?? "");',
              '  if (Array.isArray(v) && v.length === 1 && v[0] !== "" && v[0] !== null && !v.some(x => x?.archon_failed === true)) process.stdout.write("used");',
              '} catch {}',
            ].join('\n'),
            runtime: 'bun',
            with: { result: ref.value(output<unknown[]>(soldier)) },
          },
          {
            id: soldierReset,
            depends_on: [soldierOk],
            trigger_rule: 'all_done',
            when: `$${soldierOk}.output != 'used'`,
            bash: `git stash push --include-untracked -m soldier-leftover-${p.id} >/dev/null && printf reset`,
          }
        );
      const coder = fake
        ? { bash: fakeEdit(p, p.id) }
        : {
            command: 'sa-code',
            retry: { on_error: 'transient' },
            model: '@sa-coder',
            ...execution(`code-${p.id}`),
            // Defer pack expansion to the prompt's output-ref pass so source refs remain literal.
            with: {
              pkg: p.id,
              brief: brief(p),
              hint: join(gen, 'hints', `${p.id}.md`),
              context_node: pkgAttempt,
              soldier_ok: soldierOk ?? '',
            },
          };
      const codeHandle = output<CoderOutput>(`code-${p.id}`);
      const conditionalCodeHandle = conditionalOutput<CoderOutput>(`code-${p.id}`);
      nodes.push({
        id: `code-${p.id}`,
        ...coder,
        ...(fake ? { with: { soldier_ok: '' } } : {}),
        depends_on: [
          packageStart,
          pkgAttempt,
          ...(soldier && soldierOk && soldierReset ? [soldier, soldierOk, soldierReset] : []),
        ],
        ...(soldier && soldierReset
          ? {
              trigger_rule: 'all_done',
              when:
                `$${prev}.output.head != '' && $${pkgAttempt}.output.attempt != '' && ` +
                `$${soldierReset}.output != '__failed__'`,
            }
          : carry
            ? { when: `$${pkgAttempt}.output.attempt != '0'` }
            : {}),
        output_format: coderOutputFormat,
      });
      const previousHandle = output<DeliveryOutput>(prev);
      const accept = {
        kind: 'accept',
        plan: planPath,
        policy: policyPath,
        pkgs: p.id,
        scope_pkgs,
        base,
        scope_base: scopeBase,
        delta_base: ref.required(previousHandle, 'head'),
        ...(p.max_net_lines === undefined
          ? {}
          : {
              run_base: runBase,
              generated_paths: JSON.stringify(GENERATED_OUTPUT_PATHS),
            }),
        target_tip: ref.required(syncReadyHandle, 'target_tip'),
        sync_generation: ref.required(syncReadyHandle, 'generation'),
        risk: p.risk,
        milestone: m.id,
        ...ledger,
      };
      const verify = `verify-${p.id}`;
      const verifyHandle = conditionalOutput<AcceptOutput>(verify);
      nodes.push(
        check(
          verify,
          [`code-${p.id}`, pkgAttempt],
          {
            ...accept,
            tag: verify,
            coder: carry ? ref.optionalValue(conditionalCodeHandle, carry) : ref.value(codeHandle),
            ...(carriedEvidence
              ? {
                  carried_evidence: carriedEvidence,
                  attempt: ref.required(pkgAttemptHandle, 'attempt'),
                }
              : {}),
          },
          {
            ...(carry ? { trigger_rule: 'none_failed_min_one_success' } : {}),
            output_format: acceptOutputFormat,
            ...acceptTimeout([p], plan),
          }
        )
      );
      const budgetGate = p.max_net_lines === undefined ? undefined : `human-budget-${p.id}`;
      if (budgetGate)
        nodes.push({
          id: budgetGate,
          approval: {
            message: `Approve max_net_lines overage for package ${p.id}`,
            decisions: [{ id: 'approve' }, { id: 'reject' }],
          },
          depends_on: [verify],
          when: `$${verify}.output.reason == 'budget_exceeded'`,
        });
      const repairContext = `repair-context-${p.id}`;
      const repairHandle = conditionalOutput<CoderOutput>(`repair-${p.id}`);
      if (!fake)
        nodes.push({
          id: repairContext,
          ...attemptInputs(attemptPath(gen, `pkg/${p.id}`)),
          with: { counter: attemptPath(gen, `pkg/${p.id}`), gen, context_node: `repair-${p.id}` },
          depends_on: [verify, pkgAttempt],
          when: `$${verify}.output.disposition == 'repair'`,
          output_format: contextOutputFormat,
        });
      nodes.push({
        id: `repair-${p.id}`,
        ...(!fake && !carry && !soldier ? { context: { resume: `code-${p.id}` } } : {}),
        ...(fake
          ? { bash: fakeEdit(p, `repair ${p.id}`) }
          : {
              command: 'sa-repair',
              retry: { on_error: 'transient' },
              model: '@sa-coder',
              ...execution(`repair-${p.id}`),
              with: {
                pkg: p.id,
                brief: brief(p),
                hint: join(gen, 'hints', `${p.id}.md`),
                context_node: repairContext,
                prior_work: carry
                  ? ref.optionalValue(conditionalCodeHandle, carry)
                  : ref.value(codeHandle),
                reason: ref.optional(verifyHandle, 'reason', null),
                accept_log: ref.optional(verifyHandle, 'log', ''),
              },
            }),
        depends_on: [verify, pkgAttempt, ...(!fake ? [repairContext] : [])],
        when: `$${verify}.output.disposition == 'repair'`,
        output_format: coderOutputFormat,
      });
      nodes.push(
        check(
          `settle-${p.id}`,
          [verify, `repair-${p.id}`, ...(budgetGate ? [budgetGate] : []), pkgAttempt],
          {
            ...accept,
            kind: 'settle',
            tag: `settle-${p.id}`,
            first: ref.optional(verifyHandle, 'disposition', 'fail'),
            repaired: ref.optionalValue(repairHandle, null),
          },
          {
            trigger_rule: 'none_failed_min_one_success',
            output_format: deliveryOutputFormat,
            ...acceptTimeout([p], plan),
          }
        )
      );
      prev = `settle-${p.id}`;
    }
    const reviewSyncReady = addSync(nodes, m, `sync-review-${m.id}`, [prev], true);
    prev = reviewSyncReady;
    base = `$${reviewSyncReady}.output.merge_base`;
    const briefs = m.packages.map(brief).join(' '),
      resumeFixes =
        m.packages.length === 1 &&
        nodes.some(n => n.id === `repair-${m.packages[0].id}` && n.context !== undefined);
    const rounds: Node = {};
    for (let r = 1; r <= maxRounds; r++) {
      const t = `${m.id}-r${String(r)}`;
      const before = `${m.id}-r${String(r - 1)}`;
      const fixHandle = conditionalOutput<CoderOutput>(`fix-${t}`);
      if (r > 1) {
        const handoff = `handoff-${t}`;
        if (!fake) {
          nodes.push({
            id: handoff,
            ...attemptInputs(attemptPath(gen, m.id)),
            with: {
              counter: attemptPath(gen, m.id),
              gen,
              context_node: `fix-${t}`,
              context_packages: m.packages.map(p => p.id),
              handoff: '1',
              work_keys:
                r === 2 ? m.packages.flatMap(p => [`code_${p.id}`, `repair_${p.id}`]) : ['fix'],
              ...(r === 2
                ? Object.fromEntries(
                    m.packages.flatMap(p => [
                      [
                        `work_code_${p.id}`,
                        ref.optionalValue(conditionalOutput<CoderOutput>(`code-${p.id}`), null),
                      ],
                      [
                        `work_repair_${p.id}`,
                        ref.optionalValue(conditionalOutput<CoderOutput>(`repair-${p.id}`), null),
                      ],
                    ])
                  )
                : {
                    work_fix: ref.optionalValue(
                      conditionalOutput<CoderOutput>(`fix-${before}`),
                      null
                    ),
                  }),
            },
            depends_on: [prev, attempt],
            when: `$gate-${before}.output.verdict == 'fix'`,
          });
        }
        nodes.push({
          id: `fix-${t}`,
          ...(resumeFixes
            ? { context: { resume: r === 2 ? `code-${m.packages[0].id}` : `fix-${before}` } }
            : {}),
          ...(fake
            ? { bash: fakeEdit(m.packages[0], `fix ${m.id} r${String(r)}`) }
            : {
                command: 'sa-fix',
                retry: { on_error: 'transient' },
                model: '@sa-coder',
                ...execution(`fix-${t}`),
                with: {
                  prior_work: `$${handoff}.output.handoff`,
                  context_node: handoff,
                  milestone: m.id,
                  round: r,
                  ledger: `$gate-${before}.output.ledger_file`,
                  accept_log: ref.optional(
                    conditionalOutput<AcceptOutput>(`diff-${before}`),
                    'log',
                    ''
                  ),
                  briefs,
                  hints: join(gen, 'hints'),
                },
              }),
          depends_on: fake ? [prev, attempt] : [prev, attempt, handoff],
          when: `$gate-${before}.output.verdict == 'fix'`,
          output_format: coderOutputFormat,
        });
        prev = `fix-${t}`;
      }
      const ids = m.packages.map(p => p.id).join(',');
      const diffHandle = conditionalOutput<AcceptOutput>(`diff-${t}`);
      nodes.push(
        check(
          `diff-${t}`,
          [prev, attempt],
          {
            kind: 'accept',
            plan: planPath,
            policy: policyPath,
            pkgs: ids,
            scope_pkgs,
            base,
            scope_base: scopeBase,
            target_tip: ref.required(syncReadyHandle, 'target_tip'),
            sync_generation: ref.required(syncReadyHandle, 'generation'),
            risk: m.risk,
            milestone: m.id,
            tag: `diff-${t}`,
            acceptance_evidence:
              r === 1 ? `$ARTIFACTS_DIR/${prev}.json` : `$ARTIFACTS_DIR/diff-${before}.json`,
            ...ledger,
            ...(r > 1
              ? {
                  prev: ref.optional(
                    conditionalOutput<AcceptOutput>(`diff-${before}`),
                    'diff_hash',
                    ''
                  ),
                  coder: ref.optionalValue(fixHandle, null),
                  delta_base: `$gate-${before}.output.reviewed_head`,
                  reviewed_diff_hash: `$gate-${before}.output.reviewed_diff_hash`,
                }
              : {}),
          },
          { output_format: acceptOutputFormat, ...acceptTimeout(m.packages, plan) }
        )
      );
      if (r === 1 && checkpointMatch && checkpoint) {
        const checkpointPath = join(gen, 'review-checkpoints', `${m.id}.json`);
        const gatePath = `$ARTIFACTS_DIR/gate-${m.id}-r1.json`;
        nodes.push({
          id: `carried-gate-${m.id}`,
          bash: `cp '${checkpointPath.replaceAll(
            "'",
            "'\\''"
          )}' "${gatePath}" && EVIDENCE_PATH="${gatePath}" bun -e 'const b = new Uint8Array(await Bun.file(process.env.EVIDENCE_PATH).arrayBuffer()); const o = JSON.parse(new TextDecoder().decode(b)); o.artifact_sha256 = new Bun.CryptoHasher("sha256").update(b).digest("hex"); process.stdout.write(JSON.stringify(o))'`,
          depends_on: [`diff-${t}`],
          when: `$diff-${t}.output.disposition == 'advance' && ${checkpointMatch}`,
        });
      }
      const reviewAttempt = `attempt-review-${t}`;
      const reviewEligible =
        `$diff-${t}.output.disposition == 'advance'` +
        (m.review ? '' : ` && $diff-${t}.output.risk == 'G2'`);
      const reviewWhen =
        r === 1
          ? checkpointDrift
            ? checkpointAtoms
                .map(
                  ([field, value]) =>
                    `${reviewEligible} && $diff-${t}.output.${field} != '${value}'`
                )
                .join(' || ')
            : reviewEligible
          : `${reviewEligible} && $diff-${t}.output.same != 'true' || ` +
            `${reviewEligible} && $diff-${t}.output.reviewed != 'true'`;
      nodes.push({
        id: reviewAttempt,
        when: reviewWhen,
        depends_on: [`diff-${t}`, attempt],
        ...attemptInputs(attemptPath(gen, `review-${t}`)),
        output_format: attemptOutputFormat,
      });
      const reviewContext = `review-context-${t}`;
      if (!fake)
        nodes.push({
          id: reviewContext,
          when: reviewWhen,
          always_run: true,
          depends_on: [reviewAttempt],
          ...attemptInputs(attemptPath(gen, `review-${t}`), '', `review-${t}`, `gate-${t}`),
          output_format: attemptOutputFormat,
        });
      const reviewHandle = conditionalOutput<ReviewerOutput>(`review-${t}`);
      nodes.push({
        id: `review-${t}`,
        // A same-diff round may skip only when an earlier review covered this exact candidate.
        when: reviewWhen,
        ...(fake
          ? { bash: fakeReview(r) }
          : {
              command: r === 1 ? 'sa-review' : 'sa-review-delta',
              retry: { on_error: 'transient' },
              model: tiers.routing.reviewer.by_risk?.[m.risk]
                ? `@sa-reviewer-${m.risk}`
                : '@sa-reviewer',
              ...execution(`review-${t}`),
              idle_timeout: REVIEW_IDLE_MS,
              with: {
                milestone: m.id,
                risk: ref.optional(diffHandle, 'risk', ''),
                round: r,
                context: `$ARTIFACTS_DIR/review-${t}.context.json`,
                briefs,
                accept_log: ref.optional(diffHandle, 'log', ''),
                // 第 2 轮及以后只看上次评审以来的增量与累计台账；全量 diff 只给路径（F-20）
                ...(r > 1
                  ? {
                      diff: ref.optional(diffHandle, 'delta', ''),
                      full_diff: ref.optional(diffHandle, 'patch', ''),
                      ledger: `$gate-${before}.output.ledger_file`,
                    }
                  : { diff: ref.optional(diffHandle, 'patch', '') }),
              },
            }),
        depends_on: [`diff-${t}`, fake ? reviewAttempt : reviewContext],
        output_format: reviewerOutputFormat,
      });
      rounds[`R${String(r)}`] = ref.optionalValue(reviewHandle, null);
      rounds[`C${String(r)}`] = `$ARTIFACTS_DIR/diff-${t}.json`;
      rounds[`C${String(r)}_HEAD`] = ref.optional(diffHandle, 'head', '');
      rounds[`C${String(r)}_DIFF_HASH`] = ref.optional(diffHandle, 'diff_hash', '');
      rounds[`C${String(r)}_SHA256`] = ref.optional(diffHandle, 'artifact_sha256', '');
      // 评审被跳过（验收未 advance 或修复无变化）时 gate 仍要运行；diff 也被跳过则本轮整体不走
      nodes.push(
        check(
          `gate-${t}`,
          [`diff-${t}`, `review-${t}`],
          {
            kind: 'gate',
            review: m.review ? '1' : '0',
            round: r,
            ...rounds,
            risk: m.risk,
            milestone: m.id,
            pkgs: ids,
            plan: planPath,
            policy: policyPath,
            tag: `gate-${t}`,
            ...ledger,
            // 非末里程碑 PASS 后还会启动下一里程碑的模型调用：先过预算
            ...(last ? {} : { next: '1' }),
          },
          {
            trigger_rule: 'none_failed_min_one_success',
            ...(r === 1 && checkpointDrift
              ? { when: `$diff-${t}.output.disposition != 'advance' || ${checkpointDrift}` }
              : {}),
          }
        )
      );
      prev = `gate-${t}`;
    }
    const gates: Node = {
      depends_on: [
        ...Array.from({ length: maxRounds }, (_, i) => `gate-${m.id}-r${String(i + 1)}`),
        ...(checkpointMatch ? [`carried-gate-${m.id}`] : []),
      ],
      trigger_rule: 'none_failed_min_one_success',
    };
    const approved = signoff(m, gates);
    const ids = m.packages.map(p => p.id).join(',');
    nodes.push(
      integrationNode(
        m,
        approved,
        {
          plan: planPath,
          policy: policyPath,
          pkgs: ids,
          scope_pkgs,
          scope_base: scopeBase,
          risk: m.risk,
          milestone: m.id,
          ...ledger,
        },
        [
          ...Array.from({ length: maxRounds }, (_, i) => ({
            round: i + 1,
            node: `gate-${m.id}-r${String(i + 1)}`,
          })),
          ...(checkpointMatch ? [{ round: 1, node: `carried-gate-${m.id}`, carried: true }] : []),
        ]
      )
    );
    after = { depends_on: [`integrate-${m.id}`] };
  }
  return {
    name: `sa-${run}`,
    description: `superagent run ${run}: ${String(plan.packages.length)} package(s), ${String(
      ms.length
    )} milestone(s)`,
    nodes,
  };
}

export function assertGeneratedWorkflow(definition: Node, background = true): void {
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      for (const field of ['bash', 'until_bash'] as const) {
        const source = node[field];
        if (typeof source === 'string' && /\$[A-Za-z0-9_-]+\.output(?:\.|\b)/.test(source))
          throw new Error(`generated ${field} contains an output reference: ${String(node.id)}`);
      }
      const group = node.loop_group as { nodes?: Node[] } | undefined;
      visit(group?.nodes ?? []);
    }
  };
  visit(definition.nodes as Node[]);
  const parsed = parseWorkflow(YAML.stringify(definition, { lineWidth: 0 }), 'generated.yaml', {
    get: () => undefined,
    list: () => [],
  });
  if (parsed.workflow === null)
    throw new Error(`generated workflow invalid: ${parsed.error.error}`);
  if (background) {
    assertBackgroundDispatchable(parsed.workflow);
    assertComposedGateDriveable(parsed.workflow.nodes as never);
  }
}

const CAP_TEXT: Record<Exclude<keyof Caps, 'read' | 'git' | 'mcp' | 'long_tests'>, string> = {
  network: '访问网络（curl/wget、包仓库）',
  web: '联网搜索与抓取网页（WebSearch/WebFetch）',
  install: '安装或新增依赖',
  services: '启动本地服务与容器（docker 等）',
};
const renderCaps = (c: Caps): string =>
  [
    ...Object.entries(CAP_TEXT).map(
      ([k, t]) => `- ${t}：${c[k as keyof typeof CAP_TEXT] ? '允许' : '禁止'}`
    ),
    `- 读取：${c.read === 'any' ? '整机任何非红线路径' : '只读本仓库内任务书列出的路径'}`,
    `- git：${
      c.git === 'branch' ? '本分支内任意提交、rebase、reset' : '只追加提交，不 rebase/reset/amend'
    }`,
    // Codex 把工作树根 AGENTS.md 当成更新的用户指令；项目给人工主仓的"不要提交"曾让将军提交后自报红线。
    '- 提交授权：在本 run 的 worktree 内提交是引擎要求的必需步骤；仓库 AGENTS.md/CLAUDE.md 中禁止 git commit 的条款面向人工主仓，此处不适用，不构成红线',
    '- skills/plugins/MCP：继承用户原生配置；guard 只拦凭据隐私与不可逆破坏',
  ].join('\n');

const safePath = (p: Pkg): string => p.scope.write[0].replace(/[^\w./-]/g, '_');
/** 桩编码：向包的首个写入路径追加一行并提交，输出 coder 结构。 */
// prettier-ignore
const fakeEdit = (p: Pkg, line: string): string => {
  const scenario = process.env.FAKE_CODER_SCENARIO ?? "";
  const classes: Record<string, string> = { done_with_error_class: "task", partial_green: "env", blocked_needs: "env" };
  if (scenario && ![...Object.keys(classes), "invalid_json"].includes(scenario)) throw new Error(`unknown FAKE_CODER_SCENARIO: ${scenario}`);
  const output = { status: scenario === "partial_green" ? "partial" : scenario === "blocked_needs" ? "blocked" : "done", changed_files: [safePath(p)], quick_checks: [], notes: "fake", blockers: [], error_class: classes[scenario] ?? null, deviations: [], needs: scenario === "blocked_needs" ? [{ cap: "network", why: "fixture", minimal_ask: "fixture" }] : [] };
  return [
    `mkdir -p "$(dirname '${safePath(p)}')" && echo '${line}' >> '${safePath(p)}'`,
    `git add '${safePath(p)}' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'fake ${line}'`,
    `echo '${scenario === "invalid_json" ? "{invalid" : JSON.stringify(output)}'`,
  ].join('\n');
};

const FAKE_HIGH = {
  id: 'R1-1',
  severity: 'high',
  file: 'fake',
  line: 1,
  failure_class: 'product',
  command: null,
};
/** 桩评审：第 1 轮 open 一条 high；之后按原 id 关闭并附证据（gate 只认这种关闭）。 */
const fakeReview = (r: number): string => {
  const findings = [
    r === 1
      ? { ...FAKE_HIGH, status: 'open', evidence: 'fake', carry_over: false }
      : { ...FAKE_HIGH, status: 'closed', evidence: 'fake fix verified', carry_over: true },
  ];
  const status = r === 1 ? 'FAIL' : 'PASS';
  const out = { status, notes: 'fake', findings, fixture_confirmations: [], debt: [] };
  return `echo '${JSON.stringify(out)}'`;
};

/** 单趟替换：计划文本里出现的 `{{x}}` 不会被再次展开。 */
export function renderBrief(
  p: Pkg,
  hint: string,
  caps: Caps,
  testBudget = loadTiers().policy.test_budget
): string {
  const list = (xs: string[] | undefined): string =>
    xs?.length ? xs.map(x => `- \`${x}\``).join('\n') : '- （无）';
  const vars: Partial<Record<string, string>> = {
    id: p.id,
    title: p.title,
    risk: p.risk,
    size: p.size,
    test_cases: String(testBudget[p.size].cases),
    test_lines: String(testBudget[p.size].lines),
    goal:
      p.goal +
      (p.requirements
        ? '\n\n需求与验收映射（accept 零基索引）：\n' + JSON.stringify(p.requirements, null, 2)
        : ''),
    write: list(p.scope.write),
    read: list(p.scope.read_hint),
    accept: list(p.accept.map(c => c.cmd)),
    notes: p.notes ?? '（无）',
    caps: renderCaps(caps),
    hint,
  };
  const tpl = readFileSync(join(WETAMP, 'templates', 'brief.md'), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

const git = (cwd: string, ...args: string[]): void => {
  const id = ['-c', 'user.name=superagent', '-c', 'user.email=superagent@localhost'];
  const p = Bun.spawnSync(['git', ...id, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} in ${cwd}: ${tail(p.stderr.toString())}`);
};

function copyOwnerWritable(source: string, destination: string, recursive = false): void {
  cpSync(source, destination, recursive ? { recursive: true } : undefined);
  const makeWritable = (path: string): void => {
    const stat = statSync(path);
    chmodSync(path, stat.mode | 0o200);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  };
  makeWritable(destination);
}

export interface Gen {
  dir: string;
  workflow: string;
  /** run-config 层（钉住的别名），经 `workflow run --config` 传入。 */
  config: string;
  engine_hash: string;
  /** Provenance only; execution still uses the installed runtime. */
  engine_commit: string;
}

/** 写 gen 目录、提交一次、`archon validate workflows`；校验失败抛错。 */
export function generate(
  plan: Plan,
  run: string,
  fake = false,
  previousHash?: string,
  carried?: Carried,
  delivery?: import('./land').DeliveryTarget,
  engineSnapshot?: string,
  routingState?: RouteState
): Gen {
  const engineWetamp = engineSnapshot ? join(engineSnapshot, 'wetamp') : WETAMP;
  const engine_commit = cleanEngine();
  assertSQLite(plan.repo);
  const tiers = loadTiers();
  const state = routingState ?? routeState(tiers, plan.mode);
  const policy = snapshotPolicy(tiers);
  const principlesPath = join(WETAMP, 'templates', '.archon', 'principles.md');
  let principles: string;
  try {
    principles = readFileSync(principlesPath, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read required core principles: ${principlesPath}`, { cause });
  }
  const suffix =
    carried?.freshDirectory || carried?.recovery ? `continuations/${crypto.randomUUID()}` : '.';
  const dir = join(home().sa, 'gen', run, suffix);
  if (carried?.recovery) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recovery-evidence.json'), JSON.stringify(carried.recovery));
  }
  const engine_hash = engineHash(WETAMP, policy.hash);
  if (previousHash !== undefined && existsSync(join(dir, '.archon'))) {
    let backup = join(dir, `.archon.${previousHash.slice(0, 8) || 'unknown'}`);
    if (existsSync(backup)) backup += `.${String(Date.now())}`;
    renameSync(join(dir, '.archon'), backup);
  }
  const workflow = `sa-${run}`;
  const ms = milestones(plan);
  const definition = buildWorkflow(
    plan,
    ms,
    run,
    dir,
    fake,
    Date.now(),
    tiers,
    carried,
    delivery,
    engineSnapshot,
    state
  );
  assertGeneratedWorkflow(definition, !ms.some(m => m.human));
  const wfDir = join(dir, '.archon', 'workflows', workflow);
  for (const d of [wfDir, join(dir, 'briefs'), join(dir, 'hints')])
    mkdirSync(d, { recursive: true });
  if (carried?.reviews) {
    const checkpointDir = join(dir, 'review-checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    for (const [milestone, checkpoint] of Object.entries(carried.reviews))
      if (checkpoint)
        writeFileSync(join(checkpointDir, `${milestone}.json`), JSON.stringify(checkpoint.gate));
  }
  if (carried?.evidence && Object.keys(carried.evidence).length) {
    const evidenceDir = join(dir, 'carried-evidence');
    mkdirSync(evidenceDir, { recursive: true });
    for (const [pkg, source] of Object.entries(carried.evidence))
      copyOwnerWritable(source, join(evidenceDir, `${pkg}.json`));
  }
  if (delivery && !fake)
    writeFileSync(
      join(dir, 'delivery-authorization.json'),
      JSON.stringify({
        run: coord().admit(runScope({ run_id: run, repo: plan.repo }), caller()),
        repo: coord().admit(repoScope(plan.repo), caller()),
        sync_generation: 0,
        target_tip: delivery.head,
      })
    );
  const generatedNodes = (values: Node[]): Node[] =>
    values.flatMap(node => {
      const loop = node.loop_group as { nodes?: Node[] } | undefined;
      return [node, ...generatedNodes(loop?.nodes ?? [])];
    });
  writeFileSync(
    join(dir, 'accept-inputs.json'),
    JSON.stringify(
      generatedNodes(definition.nodes as Node[])
        .filter(n => (n.with as Node | undefined)?.kind === 'accept')
        .map(n => n.with)
    )
  );
  for (const sub of ['commands', 'scripts']) {
    copyOwnerWritable(
      join(engineWetamp, 'templates', '.archon', sub),
      join(dir, '.archon', sub),
      true
    );
  }
  // Freeze the engine-owned receipt reader into portable generated workflows.
  copyOwnerWritable(
    join(engineWetamp, '../packages/workflows/src/provider-attempts.ts'),
    join(dir, '.archon/scripts/policy-attempts.ts')
  );
  writeFileSync(join(dir, '.archon/scripts/reasons.json'), JSON.stringify(REASONS, null, 2) + '\n');
  copyOwnerWritable(join(engineWetamp, 'capabilities.json'), join(dir, 'capabilities.json'));
  writeFileSync(join(dir, '.archon', 'principles.md'), principles);
  if (!existsSync(join(dir, 'plan.json')))
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(
    join(dir, 'execution.json'),
    JSON.stringify(executionTable(plan, tiers), null, 2) + '\n'
  );
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2) + '\n');
  // sa-check 经它查本 run 的 spend/binding（F-14/F-16）；gen 目录可脱离 wetamp 安装位置被引用
  if (!fake && !existsSync(join(dir, 'archon')))
    symlinkSync(join(engineWetamp, 'bin', 'archon'), join(dir, 'archon'));
  for (const p of plan.packages) {
    writeFileSync(
      join(dir, 'briefs', `${p.id}.md`),
      principles +
        '\n' +
        renderBrief(p, join(dir, 'hints', `${p.id}.md`), capsOf(plan, p), tiers.policy.test_budget)
    );
  }
  if (!fake) {
    const executions = executionTable(plan, tiers);
    const candidateFor = (descriptor: (typeof executions)[string]) =>
      executionRoute(tiers, plan.console ?? 'claude', plan.mode, descriptor, [], false, state)
        .candidates[0];
    for (const p of plan.packages) {
      if (draftFor(p) !== 'soldier' || !tiers.routing.soldier?.models.length) continue;
      const id = `soldier-${p.id}`;
      const descriptor = executions[id];
      const candidate = candidateFor(descriptor);
      const launch = {
        ...executionNode(descriptor, candidate),
        ...(candidate.provider === 'claude'
          ? { maxBudgetUsd: tiers.policy.coder_budget_usd.claude }
          : {}),
      };
      writeFileSync(
        join(dir, '.archon', 'workflows', `sa-soldier-${p.id}.yaml`),
        YAML.stringify(
          {
            name: `sa-soldier-${p.id}`,
            description: `Optional draft for ${p.id}`,
            mutates_checkout: true,
            inputs: {
              pkg: { required: true },
              context_node: { required: true },
              draft: { required: true },
            },
            returns: 'draft',
            nodes: [
              {
                id: 'draft',
                command: 'sa-soldier',
                retry: { on_error: 'transient' },
                model: '@sa-soldier',
                ...launch,
                idle_timeout: SOLDIER_IDLE_MS,
                with: { pkg: '$INPUTS.pkg', context_node: '$INPUTS.context_node' },
              },
            ],
          },
          { lineWidth: 0, aliasDuplicateObjects: false }
        )
      );
    }
  }
  const lessons = injectMemory(
    plan,
    dir,
    definition.nodes as {
      id: string;
      command?: unknown;
      model?: unknown;
      with?: Record<string, unknown>;
    }[]
  );
  writeFileSync(
    join(dir, 'engine.json'),
    JSON.stringify({
      engine_hash,
      engine_commit,
      workflow_hash: engine_hash,
      policy_hash: policy.hash,
      execution_contract: 1,
      fake,
      lessons,
    }) + '\n'
  );
  writeFileSync(
    join(wfDir, `${workflow}.yaml`),
    YAML.stringify(definition, {
      lineWidth: 0,
      aliasDuplicateObjects: false,
    })
  );
  writeFileSync(join(dir, '.gitignore'), 'hints/\nattempts/\n.archon.*\n');
  const config = join(dir, 'run-config.yaml');
  const aliases = runAliases(plan.console ?? 'claude', tiers, plan.mode, state);
  const reviewer = (risk: Pkg['risk']) =>
    resolveRoute(
      tiers,
      plan.console ?? 'claude',
      plan.mode,
      'review',
      risk,
      1,
      [aliases['@sa-coder'].model],
      false,
      state
    ).candidates[0];
  for (const risk of ['G0', 'G1', 'G2'] as const) {
    if (tiers.routing.reviewer.by_risk?.[risk]) aliases[`@sa-reviewer-${risk}`] = reviewer(risk);
  }
  const worker = join(dir, 'codex-worker');
  const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    worker,
    `#!/usr/bin/env bash\nSA_POLICY_PATH=${quote(join(dir, 'policy.json'))} exec ${quote(
      join(engineWetamp, 'bin', 'codex-worker')
    )} "$@"\n`
  );
  chmodSync(worker, 0o755);
  const runConfig = YAML.stringify(
    {
      aliases,
      env: { SA_POLICY_PATH: join(dir, 'policy.json') },
      assistants: { codex: { codexBinaryPath: worker } },
    },
    {}
  );
  writeFileSync(config, runConfig);
  // Validation resolves aliases from repo config; execution also pins this same content at run scope.
  writeFileSync(join(dir, '.archon', 'config.yaml'), runConfig);
  git(dir, 'init', '-q');
  const files = [
    '.archon',
    'engine.json',
    'plan.json',
    'policy.json',
    'execution.json',
    'learning.json',
    'accept-inputs.json',
    'capabilities.json',
    ...(carried?.evidence && Object.keys(carried.evidence).length ? ['carried-evidence'] : []),
    'briefs',
    '.gitignore',
    'run-config.yaml',
    'codex-worker',
  ];
  git(
    dir,
    'add',
    ...files,
    ...(fake ? [] : ['archon']),
    ...(delivery && !fake ? ['delivery-authorization.json'] : [])
  );
  const staged = Bun.spawnSync(['git', 'diff', '--cached', '--quiet'], {
    cwd: dir,
    timeout: QUERY_TIMEOUT_MS,
  });
  if (staged.exitCode === 1) git(dir, 'commit', '-qm', `superagent ${run}`);
  else if (staged.exitCode !== 0)
    throw new Error(`cannot inspect generated source index: ${String(staged.exitCode)}`);
  const v = archon(['validate', 'workflows', workflow, '--cwd', dir]);
  if (v.code !== 0) throw new Error(`generated workflow invalid: ${tail(v.out + v.err)}`);
  if (cleanEngine() !== engine_commit)
    throw new Error('换版拒绝：引擎提交在生成期间变化，请重新 retry');
  return { dir, workflow, config, engine_hash, engine_commit };
}
