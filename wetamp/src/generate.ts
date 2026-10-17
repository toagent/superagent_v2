import { executionTable, executionRoute, executionNode } from './execution';
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
  MAX_ROUNDS,
  attemptPath,
  CHECK_AUX_BUDGET_MS,
  environmentChecks,
  type RecoveryEvidence,
} from '../templates/.archon/scripts/sa-check';
import { archon, tail, QUERY_TIMEOUT_MS } from './archon';
import { caller, cleanEngine, coord, repoScope, runScope } from './coord';
import {
  WETAMP,
  CODEX_WORKER,
  assertSQLite,
  home,
  loadTiers,
  runAliases,
  resolveRoute,
  snapshotPolicy,
  type Tiers,
} from './config';
import { capsOf, milestones, type Caps, type Milestone, type Pkg, type Plan } from './plan';

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
  'templates/.archon', 'src/generate.ts', 'src/reasons.ts', 'src/config.ts', 'src/plan.ts',
  'schemas/output.schema.json', 'templates/brief.md', 'tiers.json',
  // Lesson selection/injection and node roles freeze into generated briefs, commands and YAML.
  'src/memory.ts', 'src/board/workflow.ts', 'src/execution.ts',
], policyHash);
/** Shared by console restart and board refresh; includes their CLI/data consumers. */
export const residentHash = (root = WETAMP): string => hashInputs(root, ['src'], engineHash(root));

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${ts}-${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`;
}

const outputSchema = (
  kind: 'coder' | 'reviewer' | 'accept' | 'delivery' | 'head' | 'attempt'
): unknown =>
  (
    JSON.parse(readFileSync(join(WETAMP, 'schemas', 'output.schema.json'), 'utf8')) as {
      $defs: Record<string, unknown>;
    }
  ).$defs[kind];

// Pack fields are declared only on runtime producers; AI output contracts stay unchanged.
const contextOutputSchema = (): unknown => {
  const schema = outputSchema('attempt') as { properties: Record<string, unknown> };
  return { ...schema, properties: { ...schema.properties, context_pack_path: { type: 'string' } } };
};

const REVIEW_IDLE_MS = 15 * 60 * 1000;

const skippable = (from: string): Node => ({ from, if_skipped: null });
export interface Carried {
  from: string;
  packages: string[];
  recovery?: RecoveryEvidence & { admitted_by: unknown; admitted_at: string };
}

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
            CHECK_OVERHEAD_MS
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
 * 每个里程碑：start → 逐包 code/verify/[repair]/settle → 至多 MAX_ROUNDS 轮 diff → review → gate（后续各轮前有 when 守卫的
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
  delivery?: import('./land').DeliveryTarget
): Node {
  // 只拒绝显式 deadline 已过的 plan；缺省没有交付期限。
  if (plan.deadline !== undefined && Date.parse(plan.deadline) <= now)
    throw new Error(`plan invalid: /deadline ${plan.deadline} already passed`);
  const aliases = runAliases(plan.console ?? 'claude', tiers, plan.mode);
  const executions = executionTable(plan, tiers);
  const execution = (id: string): Node => {
    if (fake) return {};
    const descriptor = executions[id];
    const candidate = executionRoute(
      tiers,
      plan.console ?? 'claude',
      plan.mode,
      descriptor,
      descriptor.role === 'review' ? [aliases['@sa-coder'].model] : []
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
  const attemptInputs = (counter: string, pkg = '', review = ''): Node => ({
    script: 'sa-context',
    runtime: 'bun',
    with: { counter, gen, pkg, review },
  });
  let after: Node = { depends_on: ['environment'] };
  const signoff = (m: Milestone, gates: Node): Node => {
    if (m.human) {
      const attempt = `attempt-${m.id}`;
      nodes.push({
        id: `human-${m.id}`,
        approval: {
          message: `Approve delivery milestone ${m.id}`,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
        },
        ...gates,
        depends_on: [...((gates.depends_on as string[] | undefined) ?? []), attempt],
      });
      // Native approval owns the decision; the absolute plan deadline still guards delivery.
      const until =
        plan.deadline === undefined ? undefined : Math.floor(Date.parse(plan.deadline) / 1000);
      nodes.push({
        id: `signoff-${m.id}`,
        bash:
          until === undefined
            ? 'true'
            : [
                `[ "$(date +%s)" -le ${String(until)} ] || { echo 'signoff ${m.id}: plan deadline ${String(plan.deadline)} passed' >&2; exit 1; }`,
              ].join('\n'),
        depends_on: [`human-${m.id}`],
        when: `$human-${m.id}.output.decision == 'approve'`,
      });
      return { depends_on: [`signoff-${m.id}`] };
    }
    return gates;
  };
  for (const m of ms) {
    const covered = ms.slice(0, ms.indexOf(m) + 1).flatMap(k => k.packages);
    const scope_pkgs = covered.map(p => p.id).join(',');
    const start = `start-${m.id}`;
    const startRef = carried?.recovery?.base ?? plan.base_ref;
    const base = `$${start}.output.head`;
    nodes.push({
      id: start,
      // adopt 从已有提交起跑；共同祖先保留此前交付，不能把当前 HEAD 当评审基线。
      bash: `base=$(git merge-base '${startRef.replaceAll("'", "'\\''")}' HEAD) || exit $?; printf '{"head":"%s"}' "$base"`,
      ...after,
      output_format: outputSchema('head'),
    });
    // Milestone retries invalidate only cumulative acceptance and review/fix rounds.
    const attempt = `attempt-${m.id}`;
    nodes.push({
      id: attempt,
      ...attemptInputs(attemptPath(gen, m.id)),
      depends_on: [start],
      always_run: true,
      output_format: outputSchema('attempt'),
    });
    if (carried?.recovery) {
      const e = carried.recovery,
        r = e.rounds.length,
        tag = `${m.id}-r${String(r)}`;
      const ids = m.packages.map(p => p.id).join(',');
      const rounds = Object.fromEntries(
        e.rounds.flatMap((_, i) => [
          [`R${String(i + 1)}`, 'null'],
          [`C${String(i + 1)}`, i + 1 === r ? `$diff-${tag}.output` : 'null'],
        ])
      );
      const common = {
        plan: planPath,
        policy: e.policy.path,
        pkgs: ids,
        scope_pkgs,
        risk: m.risk,
        milestone: m.id,
        ...ledger,
      };
      nodes.push(
        check(
          `diff-${tag}`,
          [start, attempt],
          { ...common, kind: 'accept', base, tag: `diff-${tag}` },
          { output_format: outputSchema('accept'), ...acceptTimeout(m.packages, plan) }
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
      after = signoff(m, { depends_on: [`gate-${tag}`] });
      continue;
    }
    let prev = start;
    const last = ms.at(-1) === m;
    for (const p of m.packages) {
      const pkgAttempt = `package-attempt-${p.id}`;
      nodes.push({
        id: pkgAttempt,
        ...attemptInputs(attemptPath(gen, `pkg/${p.id}`), p.id),
        depends_on: [prev],
        always_run: true,
        output_format: contextOutputSchema(),
      });
      // Carry only the initial package attempt; retries keep the native coder and hint binding.
      const carry = carried?.packages.includes(p.id)
        ? JSON.stringify({
            status: 'done',
            changed_files: [],
            quick_checks: [],
            notes: `carried from ${carried.from}`,
            blockers: [],
            error_class: null,
            deviations: [],
            needs: [],
          })
        : undefined;
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
            },
          };
      nodes.push({
        id: `code-${p.id}`,
        ...coder,
        depends_on: [prev, pkgAttempt],
        ...(carry ? { when: `$${pkgAttempt}.output.attempt != '0'` } : {}),
        output_format: outputSchema('coder'),
      });
      const accept = {
        kind: 'accept',
        plan: planPath,
        policy: policyPath,
        pkgs: p.id,
        scope_pkgs,
        base,
        delta_base: `$${prev}.output.head`,
        risk: p.risk,
        milestone: m.id,
        ...ledger,
      };
      const verify = `verify-${p.id}`;
      nodes.push(
        check(
          verify,
          [`code-${p.id}`, pkgAttempt],
          {
            ...accept,
            tag: verify,
            coder: carry
              ? { from: `$code-${p.id}.output`, if_skipped: carry }
              : `$code-${p.id}.output`,
          },
          {
            ...(carry ? { trigger_rule: 'none_failed_min_one_success' } : {}),
            output_format: outputSchema('accept'),
            ...acceptTimeout([p], plan),
          }
        )
      );
      const repairContext = `repair-context-${p.id}`;
      if (!fake)
        nodes.push({
          id: repairContext,
          ...attemptInputs(attemptPath(gen, `pkg/${p.id}`)),
          with: { counter: attemptPath(gen, `pkg/${p.id}`), gen, context_node: `repair-${p.id}` },
          depends_on: [verify, pkgAttempt],
          when: `$${verify}.output.disposition == 'repair'`,
          output_format: contextOutputSchema(),
        });
      nodes.push({
        id: `repair-${p.id}`,
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
                  ? { from: `$code-${p.id}.output`, if_skipped: carry }
                  : `$code-${p.id}.output`,
                reason: `$${verify}.output.reason`,
                accept_log: `$${verify}.output.log`,
              },
            }),
        depends_on: [verify, pkgAttempt, ...(!fake ? [repairContext] : [])],
        when: `$${verify}.output.disposition == 'repair'`,
        output_format: outputSchema('coder'),
      });
      nodes.push(
        check(
          `settle-${p.id}`,
          [verify, `repair-${p.id}`, pkgAttempt],
          {
            ...accept,
            kind: 'settle',
            tag: `settle-${p.id}`,
            first: `$${verify}.output`,
            repaired: skippable(`$repair-${p.id}.output`),
          },
          {
            trigger_rule: 'none_failed_min_one_success',
            output_format: outputSchema('delivery'),
            ...acceptTimeout([p], plan),
          }
        )
      );
      prev = `settle-${p.id}`;
    }
    const briefs = covered.map(brief).join(' ');
    const rounds: Node = {};
    for (let r = 1; r <= MAX_ROUNDS; r++) {
      const t = `${m.id}-r${String(r)}`;
      const before = `${m.id}-r${String(r - 1)}`;
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
              context_packages: covered.map(p => p.id),
              handoff: '1',
              work_keys:
                r === 2 ? m.packages.flatMap(p => [`code_${p.id}`, `repair_${p.id}`]) : ['fix'],
              ...(r === 2
                ? Object.fromEntries(
                    m.packages.flatMap(p => [
                      [`work_code_${p.id}`, skippable(`$code-${p.id}.output`)],
                      [`work_repair_${p.id}`, skippable(`$repair-${p.id}.output`)],
                    ])
                  )
                : { work_fix: `$fix-${before}.output` }),
            },
            depends_on: [prev, attempt],
            when: `$gate-${before}.output.verdict == 'fix'`,
          });
        }
        nodes.push({
          id: `fix-${t}`,
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
                  accept_log: `$diff-${before}.output.log`,
                  briefs,
                  hints: join(gen, 'hints'),
                },
              }),
          depends_on: fake ? [prev, attempt] : [prev, attempt, handoff],
          when: `$gate-${before}.output.verdict == 'fix'`,
          output_format: outputSchema('coder'),
        });
        prev = `fix-${t}`;
      }
      const ids = m.packages.map(p => p.id).join(',');
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
            risk: m.risk,
            milestone: m.id,
            tag: `diff-${t}`,
            ...ledger,
            ...(r > 1
              ? {
                  prev: `$diff-${before}.output.diff_hash`,
                  coder: `$fix-${t}.output`,
                  delta_base: `$gate-${before}.output.reviewed_head`,
                }
              : {}),
          },
          { output_format: outputSchema('accept'), ...acceptTimeout(m.packages, plan) }
        )
      );
      const reviewAttempt = `attempt-review-${t}`;
      const reviewWhen =
        `$diff-${t}.output.disposition == 'advance'` +
        (r > 1 ? ` && $diff-${t}.output.same != 'true'` : '') +
        (m.review ? '' : ` && $diff-${t}.output.risk == 'G2'`);
      nodes.push({
        id: reviewAttempt,
        always_run: true,
        when: reviewWhen,
        depends_on: [`diff-${t}`],
        ...attemptInputs(attemptPath(gen, `review-${t}`), '', fake ? '' : `review-${t}`),
        output_format: outputSchema('attempt'),
      });
      nodes.push({
        id: `review-${t}`,
        // 验收未 advance 不烧评审调用；修复无变化（same）同样跳过，gate 直接 escalate
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
                risk: `$diff-${t}.output.risk`,
                round: r,
                context: `$ARTIFACTS_DIR/review-${t}.context.json`,
                briefs,
                accept_log: `$diff-${t}.output.log`,
                // 第 2 轮及以后只看上次评审以来的增量与累计台账；全量 diff 只给路径（F-20）
                ...(r > 1
                  ? {
                      diff: `$diff-${t}.output.delta`,
                      full_diff: `$diff-${t}.output.patch`,
                      ledger: `$gate-${before}.output.ledger_file`,
                    }
                  : { diff: `$diff-${t}.output.patch` }),
              },
            }),
        depends_on: [`diff-${t}`, reviewAttempt],
        output_format: outputSchema('reviewer'),
      });
      rounds[`R${String(r)}`] = skippable(`$review-${t}.output`);
      rounds[`C${String(r)}`] = `$diff-${t}.output`;
      // 评审被跳过（验收未 advance 或修复无变化）时 gate 仍要运行；diff 也被跳过则本轮整体不走
      nodes.push(
        check(
          `gate-${t}`,
          [`diff-${t}`, `review-${t}`],
          {
            kind: 'gate',
            scope_pkgs,
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
          { trigger_rule: 'none_failed_min_one_success' }
        )
      );
      prev = `gate-${t}`;
    }
    const gates: Node = {
      depends_on: Array.from({ length: MAX_ROUNDS }, (_, i) => `gate-${m.id}-r${String(i + 1)}`),
      trigger_rule: 'none_failed_min_one_success',
    };
    after = signoff(m, gates);
  }
  const operator_ledger = join(
    gen,
    ...(carried?.recovery ? ['..', '..', '..', '..'] : ['..', '..']),
    'runs',
    `${run}.json`
  );
  const landInputs = {
    kind: 'land',
    base_ref: plan.base_ref,
    plan: planPath,
    operator_ledger,
    ...(delivery ? { target_checkout: delivery.checkout, target_branch: delivery.branch } : {}),
  };
  nodes.push(check('land', [], landInputs, after));
  if (delivery && !fake) {
    if (!run || /[^0-9a-f-]/.test(run)) throw new Error('delivery: invalid run id');
    nodes.push({
      id: 'deliver',
      depends_on: ['land'],
      bash: `INPUTS_RUN='${run}' bun '${join(WETAMP, 'src/land.ts').replaceAll("'", "'\\''")}'`,
      timeout:
        20 * 60_000 +
        3 *
          Number(
            acceptTimeout(plan.packages, plan).timeout ?? ARCHON_SUBPROCESS_DEFAULT_TIMEOUT_MS
          ),
    });
  }
  return {
    name: `sa-${run}`,
    description: `superagent run ${run}: ${String(plan.packages.length)} package(s), ${String(ms.length)} milestone(s)`,
    nodes,
  };
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
    `- git：${c.git === 'branch' ? '本分支内任意提交、rebase、reset' : '只追加提交，不 rebase/reset/amend'}`,
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
export function renderBrief(p: Pkg, hint: string, caps: Caps): string {
  const list = (xs: string[] | undefined): string =>
    xs?.length ? xs.map(x => `- \`${x}\``).join('\n') : '- （无）';
  const vars: Partial<Record<string, string>> = {
    id: p.id,
    title: p.title,
    risk: p.risk,
    size: p.size,
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
  delivery?: import('./land').DeliveryTarget
): Gen {
  const engine_commit = cleanEngine();
  assertSQLite(plan.repo);
  const tiers = loadTiers();
  const policy = snapshotPolicy(tiers);
  const principlesPath = join(WETAMP, 'templates', '.archon', 'principles.md');
  let principles: string;
  try {
    principles = readFileSync(principlesPath, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read required core principles: ${principlesPath}`, { cause });
  }
  const suffix = carried?.recovery ? `continuations/${crypto.randomUUID()}` : '.';
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
  const definition = buildWorkflow(plan, ms, run, dir, fake, Date.now(), tiers, carried, delivery);
  const wfDir = join(dir, '.archon', 'workflows', workflow);
  for (const d of [wfDir, join(dir, 'briefs'), join(dir, 'hints')])
    mkdirSync(d, { recursive: true });
  if (delivery && !fake)
    writeFileSync(
      join(dir, 'delivery-authorization.json'),
      JSON.stringify({
        run: coord().admit(runScope({ run_id: run, repo: plan.repo }), caller()),
        repo: coord().admit(repoScope(plan.repo), caller()),
      })
    );
  writeFileSync(
    join(dir, 'accept-inputs.json'),
    JSON.stringify(
      (definition.nodes as Node[])
        .filter(n => (n.with as Node | undefined)?.kind === 'accept')
        .map(n => n.with)
    )
  );
  for (const sub of ['commands', 'scripts']) {
    cpSync(join(WETAMP, 'templates', '.archon', sub), join(dir, '.archon', sub), {
      recursive: true,
    });
  }
  // Freeze the engine-owned receipt reader into portable generated workflows.
  cpSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(dir, '.archon/scripts/policy-attempts.ts')
  );
  writeFileSync(join(dir, '.archon/scripts/reasons.json'), JSON.stringify(REASONS, null, 2) + '\n');
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
    symlinkSync(join(WETAMP, 'bin', 'archon'), join(dir, 'archon'));
  for (const p of plan.packages) {
    writeFileSync(
      join(dir, 'briefs', `${p.id}.md`),
      principles + '\n' + renderBrief(p, join(dir, 'hints', `${p.id}.md`), capsOf(plan, p))
    );
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
  const aliases = runAliases(plan.console ?? 'claude', tiers, plan.mode);
  for (const risk of ['G0', 'G1', 'G2'] as const) {
    if (tiers.routing.reviewer.by_risk?.[risk])
      aliases[`@sa-reviewer-${risk}`] = resolveRoute(
        tiers,
        plan.console ?? 'claude',
        plan.mode,
        'review',
        risk,
        1,
        [aliases['@sa-coder'].model]
      ).candidates[0];
  }
  const worker = join(dir, 'codex-worker');
  const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    worker,
    `#!/usr/bin/env bash\nSA_POLICY_PATH=${quote(join(dir, 'policy.json'))} exec ${quote(CODEX_WORKER)} "$@"\n`
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
