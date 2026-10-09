// plan → $SUPERAGENT_HOME/gen/<run>/：Archon 工作流源（git 仓库）+ 工作包 brief。
// 计划文本只进 brief 文件、经绝对路径传给节点：with:/command 正文是模板，`$` 无法转义。
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MAX_ROUNDS } from '../templates/.archon/scripts/sa-check';
import { archon, tail } from './archon';
import { WETAMP, home } from './config';
import { milestones, type Milestone, type Pkg, type Plan } from './plan';

const YAML = createRequire(join(WETAMP, '..', 'packages', 'server', 'package.json'))('yaml') as {
  stringify(v: unknown, opts: Record<string, unknown>): string;
};
type Node = Record<string, unknown>;

export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${ts}-${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`;
}

const outputSchema = (kind: 'coder' | 'reviewer' | 'accept' | 'head'): unknown =>
  (
    JSON.parse(readFileSync(join(WETAMP, 'schemas', 'output.schema.json'), 'utf8')) as {
      $defs: Record<string, unknown>;
    }
  ).$defs[kind];

const REVIEW_IDLE_MS = 15 * 60 * 1000;
const HOUR_MS = 3600 * 1000;
const MAX_WAIT_MS = 1000 * 365 * 24 * HOUR_MS; // Archon wait 上限 1000 年

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
 * 每个里程碑：start → 逐包 code/verify → 至多 3 轮 diff → review → gate（第 2、3 轮前有 when 守卫的 fix）；
 * 未走到的轮次被条件跳过，下一里程碑以 none_failed_min_one_success 汇合三个 gate；escalate 即 gate 失败、run 停下。
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
  const planPath = join(gen, 'plan.json');
  const brief = (p: Pkg): string => join(gen, 'briefs', `${p.id}.md`);
  const nodes: Node[] = [check('environment', [], { kind: 'env', plan: planPath })];
  let after: Node = { depends_on: ['environment'] };
  for (const m of ms) {
    const start = `start-${m.id}`;
    const base = `$${start}.output.head`;
    nodes.push({
      id: start,
      bash: `printf '{"head":"%s"}' "$(git rev-parse HEAD)"`,
      ...after,
      output_format: outputSchema('head'),
    });
    let prev = start;
    for (const p of m.packages) {
      const coder = fake
        ? { bash: fakeEdit(p, p.id) }
        : {
            command: 'sa-code',
            model: '@sa-coder',
            with: { pkg: p.id, brief: brief(p), hint: join(gen, 'hints', `${p.id}.md`) },
          };
      nodes.push({
        id: `code-${p.id}`,
        ...coder,
        depends_on: [prev],
        output_format: outputSchema('coder'),
      });
      nodes.push(
        check(
          `verify-${p.id}`,
          [`code-${p.id}`],
          { kind: 'accept', plan: planPath, pkgs: p.id, base, tag: `verify-${p.id}` },
          { output_format: outputSchema('accept') }
        )
      );
      prev = `verify-${p.id}`;
    }
    const briefs = m.packages.map(brief).join(' ');
    const rounds: Node = {};
    for (let r = 1; r <= MAX_ROUNDS; r++) {
      const t = `${m.id}-r${String(r)}`;
      const last = `${m.id}-r${String(r - 1)}`;
      if (r > 1) {
        nodes.push({
          id: `fix-${t}`,
          ...(fake
            ? { bash: fakeEdit(m.packages[0], `fix ${m.id} r${String(r)}`) }
            : {
                command: 'sa-fix',
                model: '@sa-coder',
                with: {
                  milestone: m.id,
                  round: r,
                  review: `$gate-${last}.output.review_file`,
                  accept_log: `$diff-${last}.output.log`,
                  briefs,
                  hints: join(gen, 'hints'),
                },
              }),
          depends_on: [prev],
          when: `$gate-${last}.output.verdict == 'fix'`,
          output_format: outputSchema('coder'),
        });
        prev = `fix-${t}`;
      }
      const ids = m.packages.map(p => p.id).join(',');
      nodes.push(
        check(
          `diff-${t}`,
          [prev],
          {
            kind: 'accept',
            plan: planPath,
            pkgs: ids,
            base,
            tag: `diff-${t}`,
            ...(r > 1 ? { prev: `$diff-${last}.output.diff_hash` } : {}),
          },
          { output_format: outputSchema('accept') }
        )
      );
      nodes.push({
        id: `review-${t}`,
        ...(r > 1 ? { when: `$diff-${t}.output.same != 'true'` } : {}),
        ...(fake
          ? { bash: fakeReview(r) }
          : {
              command: r === 1 ? 'sa-review' : 'sa-review-delta',
              model: '@sa-reviewer',
              idle_timeout: REVIEW_IDLE_MS,
              with: {
                milestone: m.id,
                risk: m.risk,
                round: r,
                briefs,
                diff: `$diff-${t}.output.patch`,
                accept_log: `$diff-${t}.output.log`,
                ...(r > 1 ? { prev: `$gate-${last}.output.review_file` } : {}),
              },
            }),
        depends_on: [`diff-${t}`],
        mutates_checkout: false,
        output_format: outputSchema('reviewer'),
      });
      rounds[`R${String(r)}`] = `$review-${t}.output`;
      rounds[`C${String(r)}`] = `$diff-${t}.output`;
      // 评审因修复无变化被跳过时 gate 仍要运行（读 diff 的 same 直接 escalate）；diff 也被跳过则本轮整体不走
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
            plan: planPath,
            tag: `gate-${t}`,
          },
          r > 1 ? { trigger_rule: 'none_failed_min_one_success' } : {}
        )
      );
      prev = `gate-${t}`;
    }
    const gates: Node = {
      depends_on: Array.from({ length: MAX_ROUNDS }, (_, i) => `gate-${m.id}-r${String(i + 1)}`),
      trigger_rule: 'none_failed_min_one_success',
    };
    if (m.human) {
      const deadline = Math.min(Math.max(Date.parse(plan.deadline) - now, HOUR_MS), MAX_WAIT_MS);
      nodes.push({
        id: `human-${m.id}`,
        wait: { event: `sa.human.${m.id}`, deadline_ms: deadline },
        ...gates,
      });
      // wait 到期也算完成（status: expired）；签收失败必须让 run 停下，而不是条件跳过后照常 land。
      // deadline_ms 是相对生成时刻的时长（recover/resume 后会重新计时），所以另按 plan 的绝对 deadline 核验
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

const safePath = (p: Pkg): string => p.scope.write[0].replace(/[^\w./-]/g, '_');
/** 桩编码：向包的首个写入路径追加一行并提交，输出 coder 结构。 */
const fakeEdit = (p: Pkg, line: string): string =>
  [
    `mkdir -p "$(dirname '${safePath(p)}')" && echo '${line}' >> '${safePath(p)}'`,
    `git add '${safePath(p)}' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'fake ${line}'`,
    `echo '{"status":"done","changed_files":["${safePath(p)}"],"quick_checks":[],"notes":"fake","blockers":[],"error_class":null}'`,
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
export function renderBrief(p: Pkg, hint: string): string {
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
    hint,
  };
  const tpl = readFileSync(join(WETAMP, 'templates', 'brief.md'), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

const git = (cwd: string, ...args: string[]): void => {
  const id = ['-c', 'user.name=superagent', '-c', 'user.email=superagent@localhost'];
  const p = Bun.spawnSync(['git', ...id, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} in ${cwd}: ${tail(p.stderr.toString())}`);
};

export interface Gen {
  dir: string;
  workflow: string;
}

/** 写 gen 目录、提交一次、`archon validate workflows`；校验失败抛错。 */
export function generate(plan: Plan, run: string, fake = false): Gen {
  const dir = join(home().sa, 'gen', run);
  const workflow = `sa-${run}`;
  const ms = milestones(plan);
  const wfDir = join(dir, '.archon', 'workflows', workflow);
  for (const d of [wfDir, join(dir, 'briefs'), join(dir, 'hints')])
    mkdirSync(d, { recursive: true });
  for (const sub of ['commands', 'scripts']) {
    cpSync(join(WETAMP, 'templates', '.archon', sub), join(dir, '.archon', sub), {
      recursive: true,
    });
  }
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  for (const p of plan.packages) {
    writeFileSync(
      join(dir, 'briefs', `${p.id}.md`),
      renderBrief(p, join(dir, 'hints', `${p.id}.md`))
    );
  }
  writeFileSync(
    join(wfDir, `${workflow}.yaml`),
    YAML.stringify(buildWorkflow(plan, ms, run, dir, fake), {
      lineWidth: 0,
      aliasDuplicateObjects: false,
    })
  );
  writeFileSync(join(dir, '.gitignore'), 'hints/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.archon', 'plan.json', 'briefs', '.gitignore');
  git(dir, 'commit', '-qm', `superagent ${run}`);
  const v = archon(['validate', 'workflows', workflow, '--cwd', dir]);
  if (v.code !== 0) throw new Error(`generated workflow invalid: ${tail(v.out + v.err)}`);
  return { dir, workflow };
}
