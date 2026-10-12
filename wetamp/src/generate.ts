import { executionTable, executionRoute, executionNode } from './execution';
export { capsDenied } from './execution';
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
import { REASONS } from './reasons';
import { injectMemory } from './memory';
import {
  MAX_ROUNDS,
  attemptPath,
  CHECK_AUX_TIMEOUT_MS,
  CHECK_AUX_COUNTS,
  environmentChecks,
} from '../templates/.archon/scripts/sa-check';
import { archon, tail, QUERY_TIMEOUT_MS } from './archon';
import { cleanEngine } from './coord';
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

const READONLY_MCP = 'reviewer-readonly.mcp.json';
/**
 * Codex 评审节点的 mcp: 文件：只有一个以 tiers 哨兵命名、required 且命令必败的 server。
 * codex-readonly-proxy 认出后删掉它并收紧沙箱；不经代理时 Codex 因 required server 起不来，线程启动失败。
 */
const readOnlyMcp = (marker: string): string =>
  JSON.stringify({ [marker]: { command: 'false', required: true } }, null, 2) + '\n';

const REVIEW_IDLE_MS = 15 * 60 * 1000;

const skippable = (from: string): Node => ({ from, if_skipped: null });
export interface Carried {
  from: string;
  packages: string[];
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
            CHECK_AUX_COUNTS[passes === 1 ? 'env' : 'accept'] * CHECK_AUX_TIMEOUT_MS +
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
 * 每个里程碑：start → 逐包 code/verify/[repair]/settle → 至多 3 轮 diff → review → gate（第 2、3 轮前有 when 守卫的
 * fix）。verify 不 advance 时包内修复一次（repair），settle 复验；挂起（suspend）即该节点失败、run 停下，后续包与
 * 评审都不启动。验收未 advance 的轮次跳过评审，gate 按验收原因直接进入修复。未走到的轮次被条件跳过，下一里程碑以
 * none_failed_min_one_success 汇合三个 gate；escalate 即 gate 失败、run 停下。
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
  carried?: Carried
): Node {
  // 人工等待按“剩余时长”生成，不设下限；已过 deadline 的 plan 生成即失败，不起一个注定 escalate 的 run
  const left = Date.parse(plan.deadline) - now;
  if (left <= 0) throw new Error(`plan invalid: /deadline ${plan.deadline} already passed`);
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
    return executionNode(descriptor, candidate, join(gen, READONLY_MCP));
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
      { kind: 'env', plan: planPath },
      {
        ...commandTimeout(
          [...(plan.environment ?? []), ...plan.packages.flatMap(p => p.environment ?? [])],
          1
        ),
        retry: { max_attempts: tiers.policy.auto_retry.environment, on_error: 'all' },
      }
    ),
  ];
  const attemptCommand = (path: string, pkg = '', review = ''): string => {
    const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
    return ['bun', join(gen, '.archon/scripts/sa-context.ts'), path, gen, pkg, review]
      .map(quote)
      .join(' ');
  };
  let after: Node = { depends_on: ['environment'] };
  for (const m of ms) {
    const covered = ms.slice(0, ms.indexOf(m) + 1).flatMap(k => k.packages);
    const scope_pkgs = covered.map(p => p.id).join(',');
    const start = `start-${m.id}`;
    const base = `$${start}.output.head`;
    nodes.push({
      id: start,
      // adopt 从已有提交起跑；共同祖先保留此前交付，不能把当前 HEAD 当评审基线。
      bash: `base=$(git merge-base '${plan.base_ref.replaceAll("'", "'\\''")}' HEAD) || exit $?; printf '{"head":"%s"}' "$base"`,
      ...after,
      output_format: outputSchema('head'),
    });
    // Milestone retries invalidate only cumulative acceptance and review/fix rounds.
    const attempt = `attempt-${m.id}`;
    nodes.push({
      id: attempt,
      bash: attemptCommand(attemptPath(gen, m.id)),
      depends_on: [start],
      always_run: true,
      output_format: outputSchema('attempt'),
    });
    let prev = start;
    const last = ms.at(-1) === m;
    for (const p of m.packages) {
      const pkgAttempt = `package-attempt-${p.id}`;
      nodes.push({
        id: pkgAttempt,
        bash: attemptCommand(attemptPath(gen, `pkg/${p.id}`), p.id),
        depends_on: [prev],
        always_run: true,
        output_format: outputSchema('attempt'),
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
            retry: { max_attempts: tiers.policy.auto_retry.coder, on_error: 'transient' },
            model: '@sa-coder',
            ...execution(`code-${p.id}`),
            with: { pkg: p.id, brief: brief(p), hint: join(gen, 'hints', `${p.id}.md`) },
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
      nodes.push({
        id: `repair-${p.id}`,
        ...(fake
          ? { bash: fakeEdit(p, `repair ${p.id}`) }
          : {
              command: 'sa-repair',
              retry: { max_attempts: tiers.policy.auto_retry.coder, on_error: 'transient' },
              model: '@sa-coder',
              ...execution(`repair-${p.id}`),
              with: {
                pkg: p.id,
                brief: brief(p),
                hint: join(gen, 'hints', `${p.id}.md`),
                reason: `$${verify}.output.reason`,
                accept_log: `$${verify}.output.log`,
              },
            }),
        depends_on: [verify, pkgAttempt],
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
        nodes.push({
          id: `fix-${t}`,
          ...(fake
            ? { bash: fakeEdit(m.packages[0], `fix ${m.id} r${String(r)}`) }
            : {
                command: 'sa-fix',
                retry: { max_attempts: tiers.policy.auto_retry.coder, on_error: 'transient' },
                model: '@sa-coder',
                ...execution(`fix-${t}`),
                with: {
                  milestone: m.id,
                  round: r,
                  ledger: `$gate-${before}.output.ledger_file`,
                  accept_log: `$diff-${before}.output.log`,
                  briefs,
                  hints: join(gen, 'hints'),
                },
              }),
          depends_on: [prev, attempt],
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
        bash: attemptCommand(attemptPath(gen, `review-${t}`), '', fake ? '' : `review-${t}`),
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
              retry: { max_attempts: tiers.policy.auto_retry.gate, on_error: 'transient' },
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
                // 第 2/3 轮只看上次评审以来的增量与累计台账；全量 diff 只给路径（F-20）
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
        mutates_checkout: false,
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
    if (m.human) {
      nodes.push({
        id: `human-${m.id}`,
        approval: { message: `Approve delivery milestone ${m.id}` },
        ...gates,
      });
      // Native approval owns the decision; the absolute plan deadline still guards delivery.
      const until = Math.floor(Date.parse(plan.deadline) / 1000);
      nodes.push({
        id: `signoff-${m.id}`,
        bash: [
          `[ "$(date +%s)" -le ${String(until)} ] || { echo 'signoff ${m.id}: plan deadline ${plan.deadline} passed' >&2; exit 1; }`,
        ].join('\n'),
        depends_on: [`human-${m.id}`],
      });
      after = { depends_on: [`signoff-${m.id}`] };
    } else after = gates;
  }
  const operator_ledger = join(gen, '..', '..', 'runs', `${run}.json`);
  const landInputs = { kind: 'land', base_ref: plan.base_ref, plan: planPath, operator_ledger };
  nodes.push(check('land', [], landInputs, after));
  return {
    name: `sa-${run}`,
    description: `superagent run ${run}: ${String(plan.packages.length)} package(s), ${String(ms.length)} milestone(s)`,
    nodes,
  };
}

const CAP_TEXT: Record<Exclude<keyof Caps, 'read' | 'git' | 'mcp'>, string> = {
  network: '访问网络（curl/wget、包仓库）',
  web: '联网搜索与抓取网页（WebSearch/WebFetch）',
  install: '安装或新增依赖',
  services: '启动本地服务与容器（docker 等）',
  long_tests: '跑长时测试（全量、E2E）',
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
    `- MCP：${c.mcp.length ? c.mcp.join('、') : '（无）'}`,
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
    goal: p.goal,
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
  carried?: Carried
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
  const dir = join(home().sa, 'gen', run);
  const engine_hash = engineHash(WETAMP, policy.hash);
  if (previousHash !== undefined && existsSync(join(dir, '.archon'))) {
    let backup = join(dir, `.archon.${previousHash.slice(0, 8) || 'unknown'}`);
    if (existsSync(backup)) backup += `.${String(Date.now())}`;
    renameSync(join(dir, '.archon'), backup);
  }
  const workflow = `sa-${run}`;
  const ms = milestones(plan);
  const definition = buildWorkflow(plan, ms, run, dir, fake, Date.now(), tiers, carried);
  const wfDir = join(dir, '.archon', 'workflows', workflow);
  for (const d of [wfDir, join(dir, 'briefs'), join(dir, 'hints')])
    mkdirSync(d, { recursive: true });
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
  const floor = plan.packages.reduce((n, p) => n + tiers.policy.budget_floor[p.size], 0);
  if (!plan.budget.unlimited_tokens && plan.budget.weighted_tokens < floor)
    throw new Error(
      `plan invalid: /budget/weighted_tokens ${String(plan.budget.weighted_tokens)} < policy.budget_floor sum ${String(floor)}`
    );
  writeFileSync(
    join(dir, 'execution.json'),
    JSON.stringify(executionTable(plan, tiers), null, 2) + '\n'
  );
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2) + '\n');
  // sa-check 经它查本 run 的 spend/binding（F-14/F-16）；gen 目录可脱离 wetamp 安装位置被引用
  if (!fake && !existsSync(join(dir, 'archon')))
    symlinkSync(join(WETAMP, 'bin', 'archon'), join(dir, 'archon'));
  const mcp = tiers.policy.sandbox.mcp;
  for (const p of plan.packages) {
    writeFileSync(
      join(dir, 'briefs', `${p.id}.md`),
      principles + '\n' + renderBrief(p, join(dir, 'hints', `${p.id}.md`), capsOf(plan, p, mcp))
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
  writeFileSync(
    join(dir, READONLY_MCP),
    readOnlyMcp(tiers.policy.exec_profiles.reviewer.codex_readonly_marker)
  );
  writeFileSync(join(dir, '.gitignore'), 'hints/\nattempts/\nbudget-extra\n.archon.*\n');
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
    'accept-inputs.json',
    'briefs',
    '.gitignore',
    'run-config.yaml',
    'codex-worker',
  ];
  git(dir, 'add', ...files, READONLY_MCP, ...(fake ? [] : ['archon']));
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
