// plan → $SUPERAGENT_HOME/gen/<run>/：Archon 工作流源（git 仓库）+ 工作包 brief。
// 计划文本只进 brief 文件、经绝对路径传给节点：with:/command 正文是模板，`$` 无法转义。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MAX_ROUNDS } from '../templates/.archon/scripts/sa-check';
import { archon, tail, QUERY_TIMEOUT_MS } from './archon';
import { WETAMP, effortFor, home, loadTiers, runAliases, type Tiers } from './config';
import { capsOf, milestones, type Caps, type Milestone, type Pkg, type Plan } from './plan';

const YAML = createRequire(join(WETAMP, '..', 'packages', 'server', 'package.json'))('yaml') as {
  stringify(v: unknown, opts: Record<string, unknown>): string;
};
type Node = Record<string, unknown>;

/** Hash the owning generation logic and all template inputs, without a manual version. */
export function engineHash(root = WETAMP): string {
  const hash = new Bun.CryptoHasher('sha256');
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
  walk('templates/.archon');
  for (const path of [
    'src/generate.ts',
    'src/config.ts',
    'schemas/output.schema.json',
    'templates/brief.md',
    'tiers.json',
  ])
    add(path);
  return hash.digest('hex');
}

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${ts}-${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`;
}

const outputSchema = (kind: 'coder' | 'reviewer' | 'accept' | 'head' | 'attempt'): unknown =>
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
const MAX_WAIT_MS = 1000 * 365 * 24 * 3600 * 1000; // Archon wait 上限 1000 年

/** sa-check 读取的 tiers.policy 子集：生成时快照一次，整 run 共用（运行中改 tiers.json 不影响已起的 run）。 */
const policyOf = (t: Tiers): Node => ({
  risk_paths: t.policy.risk_paths,
  code_extensions: t.policy.code_extensions,
  exempt_paths: t.policy.exempt_paths,
  budget_floor: t.policy.budget_floor,
});
const skippable = (from: string): Node => ({ from, if_skipped: null });

const check = (id: string, deps: string[], inputs: Node, extra: Node = {}): Node => ({
  id,
  script: 'sa-check',
  runtime: 'bun',
  ...(deps.length ? { depends_on: deps } : {}),
  with: inputs,
  ...extra,
});

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
  now = Date.now()
): Node {
  // 人工等待按“剩余时长”生成，不设下限；已过 deadline 的 plan 生成即失败，不起一个注定 escalate 的 run
  const left = Date.parse(plan.deadline) - now;
  if (left <= 0) throw new Error(`plan invalid: /deadline ${plan.deadline} already passed`);
  const tiers = loadTiers();
  const aliases = runAliases(plan.console ?? 'claude', tiers);
  // Claude 节点经 SDK disallowedTools 禁再派生；Codex 节点无此字段，由 bin/codex-worker 关 multi_agent 与 MCP
  // caps 收紧项对 Claude 将军追加 denied_tools；修复节点覆盖整个里程碑，取各包限制的并集
  const noNesting = (
    alias: '@sa-coder' | '@sa-reviewer',
    role: 'coder' | 'reviewer',
    pkgs: Pkg[] = []
  ): Node =>
    aliases[alias].provider === 'claude'
      ? {
          denied_tools: [
            ...new Set([
              ...tiers.policy.exec_profiles[role].claude.denied_tools,
              ...pkgs.flatMap(p => capsDenied(capsOf(plan, p, tiers.policy.sandbox.mcp))),
            ]),
          ],
        }
      : {};
  // 评审只读落在执行层：Claude 节点由 SDK sandbox 拦 Bash 写入；Codex 节点挂哨兵 MCP（见 readOnlyMcp），
  // bin/codex-worker 的代理据此把线程与回合改成只读。
  const readOnly: Node =
    aliases['@sa-reviewer'].provider === 'claude'
      ? { sandbox: tiers.policy.exec_profiles.reviewer.claude.sandbox }
      : { mcp: join(gen, READONLY_MCP) };
  const planPath = join(gen, 'plan.json');
  const policyPath = join(gen, 'policy.json');
  // fake 不查执行层台账：身份记 fake、预算不检查（桩节点没有 spend/binding）
  const ledger = fake ? {} : { archon: join(gen, 'archon') };
  const effort = (role: 'code' | 'repair' | 'review', risk: string, r = 1): Node =>
    fake ? {} : { effort: effortFor(tiers, role, risk, r) };
  const brief = (p: Pkg): string => join(gen, 'briefs', `${p.id}.md`);
  const nodes: Node[] = [check('environment', [], { kind: 'env', plan: planPath })];
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
    // 自动重试与 decide retry 给 <gen>/attempts/<m> 加一：always_run 的输出一变，依赖它的编码、验收、修复节点在
    // resume 时失去缓存，整个里程碑重跑（评审与 gate 随 diff 输出变化重跑）
    const attempt = `attempt-${m.id}`;
    nodes.push({
      id: attempt,
      bash: `printf '{"attempt":"%s"}' "$(cat '${join(gen, 'attempts', m.id)}' 2>/dev/null || echo 0)"`,
      depends_on: [start],
      always_run: true,
      output_format: outputSchema('attempt'),
    });
    let prev = start;
    const last = ms.at(-1) === m;
    for (const p of m.packages) {
      const coder = fake
        ? { bash: fakeEdit(p, p.id) }
        : {
            command: 'sa-code',
            model: '@sa-coder',
            ...effort('code', p.risk),
            ...noNesting('@sa-coder', 'coder', [p]),
            with: { pkg: p.id, brief: brief(p), hint: join(gen, 'hints', `${p.id}.md`) },
          };
      nodes.push({
        id: `code-${p.id}`,
        ...coder,
        depends_on: [prev, attempt],
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
          [`code-${p.id}`, attempt],
          { ...accept, tag: verify, coder: `$code-${p.id}.output` },
          { output_format: outputSchema('accept') }
        )
      );
      nodes.push({
        id: `repair-${p.id}`,
        ...(fake
          ? { bash: fakeEdit(p, `repair ${p.id}`) }
          : {
              command: 'sa-repair',
              model: '@sa-coder',
              ...effort('repair', p.risk),
              ...noNesting('@sa-coder', 'coder', [p]),
              with: {
                pkg: p.id,
                brief: brief(p),
                hint: join(gen, 'hints', `${p.id}.md`),
                reason: `$${verify}.output.reason`,
                accept_log: `$${verify}.output.log`,
              },
            }),
        depends_on: [verify, attempt],
        when: `$${verify}.output.disposition == 'repair'`,
        output_format: outputSchema('coder'),
      });
      nodes.push(
        check(
          `settle-${p.id}`,
          [verify, `repair-${p.id}`, attempt],
          {
            ...accept,
            kind: 'settle',
            tag: `settle-${p.id}`,
            first: `$${verify}.output`,
            repaired: skippable(`$repair-${p.id}.output`),
          },
          { trigger_rule: 'none_failed_min_one_success', output_format: outputSchema('accept') }
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
                model: '@sa-coder',
                ...noNesting('@sa-coder', 'coder', m.packages),
                ...effort('repair', m.risk),
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
          { output_format: outputSchema('accept') }
        )
      );
      const reviewAttempt = `attempt-review-${t}`;
      nodes.push({
        id: reviewAttempt,
        always_run: true,
        depends_on: [`diff-${t}`],
        bash: `printf '{"attempt":"%s"}' "$(cat '${join(gen, 'attempts', `review-${t}`)}' 2>/dev/null || echo 0)"`,
        output_format: outputSchema('attempt'),
      });
      nodes.push({
        id: `review-${t}`,
        // 验收未 advance 不烧评审调用；修复无变化（same）同样跳过，gate 直接 escalate
        when:
          `$diff-${t}.output.disposition == 'advance'` +
          (r > 1 ? ` && $diff-${t}.output.same != 'true'` : ''),
        ...(fake
          ? { bash: fakeReview(r) }
          : {
              command: r === 1 ? 'sa-review' : 'sa-review-delta',
              model: '@sa-reviewer',
              ...noNesting('@sa-reviewer', 'reviewer'),
              ...readOnly,
              ...effort('review', m.risk, r),
              idle_timeout: REVIEW_IDLE_MS,
              with: {
                milestone: m.id,
                risk: `$diff-${t}.output.risk`,
                round: r,
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
        wait: { event: `sa.human.${m.id}`, deadline_ms: Math.min(left, MAX_WAIT_MS) },
        ...gates,
      });
      // wait 到期也算完成（status: expired）；签收失败必须让 run 停下，而不是条件跳过后照常 land。
      // deadline_ms 只是上限：引擎从进入等待（含 recover/resume 后重新等待）起计时，生成时无法折算成 plan 的绝对
      // deadline。真正的截止由两处执行：supervise-tick 取消过期的 held:human run，signoff 节点按绝对时刻再核验一次
      const until = Math.floor(Date.parse(plan.deadline) / 1000);
      nodes.push({
        id: `signoff-${m.id}`,
        bash: [
          `s=$human-${m.id}.output.status; [ "$s" = satisfied ] || { echo 'signoff ${m.id}: not approved' >&2; exit 1; }`,
          `[ "$(date +%s)" -le ${String(until)} ] || { echo 'signoff ${m.id}: plan deadline ${plan.deadline} passed' >&2; exit 1; }`,
        ].join('\n'),
        depends_on: [`human-${m.id}`],
      });
      after = { depends_on: [`signoff-${m.id}`] };
    } else after = gates;
  }
  nodes.push(check('land', [], { kind: 'land', base_ref: plan.base_ref, plan: planPath }, after));
  return {
    name: `sa-${run}`,
    description: `superagent run ${run}: ${String(plan.packages.length)} package(s), ${String(ms.length)} milestone(s)`,
    nodes,
  };
}

/**
 * caps 收紧时能在执行层拦下的部分（Claude SDK disallowedTools，按命令前缀匹配）。
 * long_tests、read:"scope"、包级 mcp 收窄以及 Codex 节点上的全部 caps 只是提示级：写进任务书，靠评审核对。
 */
export function capsDenied(c: Caps): string[] {
  const bash = (...cmds: string[]): string[] => cmds.map(x => `Bash(${x})`);
  return [
    ...(c.network && c.web ? [] : ['WebFetch', 'WebSearch']),
    ...(c.network ? [] : bash('curl *', 'wget *')),
    ...(c.install
      ? []
      : bash(
          'npm install *',
          'npm i *',
          'bun add *',
          'pnpm add *',
          'yarn add *',
          'pip install *',
          'pip3 install *',
          'brew install *',
          'cargo install *',
          'go install *'
        )),
    ...(c.services ? [] : bash('docker *', 'docker-compose *', 'brew services *')),
    ...(c.git === 'branch' ? [] : bash('git rebase*', 'git reset*', 'git commit --amend*')),
  ];
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
    `- MCP：${c.mcp.length ? c.mcp.join('、') : '（无）'}`,
  ].join('\n');

const safePath = (p: Pkg): string => p.scope.write[0].replace(/[^\w./-]/g, '_');
/** 桩编码：向包的首个写入路径追加一行并提交，输出 coder 结构。 */
const fakeEdit = (p: Pkg, line: string): string =>
  [
    `mkdir -p "$(dirname '${safePath(p)}')" && echo '${line}' >> '${safePath(p)}'`,
    `git add '${safePath(p)}' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'fake ${line}'`,
    `echo '{"status":"done","changed_files":["${safePath(p)}"],"quick_checks":[],"notes":"fake","blockers":[],"error_class":null,"deviations":[],"needs":[]}'`,
  ].join('\n');

const FAKE_HIGH = { id: 'R1-1', severity: 'high', file: 'fake', line: 1 };
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
}

/** 写 gen 目录、提交一次、`archon validate workflows`；校验失败抛错。 */
export function generate(plan: Plan, run: string, fake = false, previousHash?: string): Gen {
  const principlesPath = join(WETAMP, 'templates', '.archon', 'principles.md');
  let principles: string;
  try {
    principles = readFileSync(principlesPath, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read required core principles: ${principlesPath}`, { cause });
  }
  const dir = join(home().sa, 'gen', run);
  const engine_hash = engineHash();
  if (previousHash !== undefined && existsSync(join(dir, '.archon'))) {
    let backup = join(dir, `.archon.${previousHash.slice(0, 8) || 'unknown'}`);
    if (existsSync(backup)) backup += `.${String(Date.now())}`;
    renameSync(join(dir, '.archon'), backup);
  }
  const workflow = `sa-${run}`;
  const ms = milestones(plan);
  const definition = buildWorkflow(plan, ms, run, dir, fake);
  const wfDir = join(dir, '.archon', 'workflows', workflow);
  for (const d of [wfDir, join(dir, 'briefs'), join(dir, 'hints')])
    mkdirSync(d, { recursive: true });
  for (const sub of ['commands', 'scripts']) {
    cpSync(join(WETAMP, 'templates', '.archon', sub), join(dir, '.archon', sub), {
      recursive: true,
    });
  }
  // Archon loads command Markdown verbatim; include: composes workflows, not prompt text.
  const commands = new Set(
    (definition.nodes as Node[]).flatMap(n => (typeof n.command === 'string' ? [n.command] : []))
  );
  for (const command of commands) {
    const path = join(dir, '.archon', 'commands', `${command}.md`);
    writeFileSync(path, principles + '\n' + readFileSync(path, 'utf8'));
  }
  if (!existsSync(join(dir, 'plan.json')))
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(dir, 'engine.json'), JSON.stringify({ engine_hash, fake }) + '\n');
  const tiers = loadTiers();
  const floor = plan.packages.reduce((n, p) => n + tiers.policy.budget_floor[p.size], 0);
  if (plan.budget.weighted_tokens < floor)
    throw new Error(
      `plan invalid: /budget/weighted_tokens ${String(plan.budget.weighted_tokens)} < policy.budget_floor sum ${String(floor)}`
    );
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policyOf(tiers), null, 2) + '\n');
  // sa-check 经它查本 run 的 spend/binding（F-14/F-16）；gen 目录可脱离 wetamp 安装位置被引用
  if (!fake && !existsSync(join(dir, 'archon')))
    symlinkSync(join(WETAMP, 'bin', 'archon'), join(dir, 'archon'));
  const mcp = tiers.policy.sandbox.mcp;
  for (const p of plan.packages) {
    writeFileSync(
      join(dir, 'briefs', `${p.id}.md`),
      renderBrief(p, join(dir, 'hints', `${p.id}.md`), capsOf(plan, p, mcp))
    );
  }
  writeFileSync(
    join(wfDir, `${workflow}.yaml`),
    YAML.stringify(definition, {
      lineWidth: 0,
      aliasDuplicateObjects: false,
    })
  );
  writeFileSync(
    join(dir, READONLY_MCP),
    readOnlyMcp(loadTiers().policy.exec_profiles.reviewer.codex_readonly_marker)
  );
  writeFileSync(join(dir, '.gitignore'), 'hints/\nattempts/\nbudget-extra\n.archon.*\n');
  const config = join(dir, 'run-config.yaml');
  writeFileSync(config, YAML.stringify({ aliases: runAliases(plan.console ?? 'claude') }, {}));
  git(dir, 'init', '-q');
  const files = [
    '.archon',
    'engine.json',
    'plan.json',
    'policy.json',
    'briefs',
    '.gitignore',
    'run-config.yaml',
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
  return { dir, workflow, config, engine_hash };
}
