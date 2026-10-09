// plan → $SUPERAGENT_HOME/gen/<run>/：Archon 工作流源（git 仓库）+ 工作包 brief。
// 计划文本只进 brief 文件、经绝对路径传给节点：with:/command 正文是模板，`$` 无法转义。
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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

const outputSchema = (kind: 'coder' | 'reviewer'): unknown =>
  (
    JSON.parse(readFileSync(join(WETAMP, 'schemas', 'output.schema.json'), 'utf8')) as {
      $defs: Record<string, unknown>;
    }
  ).$defs[kind];

const ACCEPT_OUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    failed: { type: 'array', items: { type: 'string' } },
    log: { type: 'string' },
    patch: { type: 'string' },
    diff_hash: { type: 'string' },
    head: { type: 'string' },
  },
  required: ['ok', 'failed', 'log', 'patch', 'diff_hash', 'head'],
};

const check = (id: string, deps: string[], inputs: Node, extra: Node = {}): Node => ({
  id,
  script: 'sa-check',
  runtime: 'bun',
  ...(deps.length ? { depends_on: deps } : {}),
  with: inputs,
  ...extra,
});

/** 纯函数：plan + 里程碑 → 工作流对象（黄金测试比对此结果）。 */
/** fake：编码节点换成 bash 桩（写 scope.write[0] 并提交），供测试与 selftest 免模型调用跑通整条 DAG。 */
export function buildWorkflow(
  plan: Plan,
  ms: Milestone[],
  run: string,
  gen: string,
  fake = false
): Node {
  const planPath = join(gen, 'plan.json');
  const nodes: Node[] = [check('environment', [], { kind: 'env', plan: planPath })];
  let prev = 'environment';
  for (const m of ms) {
    for (const p of m.packages) {
      const coder = fake
        ? { bash: fakeCoder(p) }
        : {
            command: 'sa-code',
            model: '@sa-coder',
            with: {
              pkg: p.id,
              brief: join(gen, 'briefs', `${p.id}.md`),
              hint: join(gen, 'hints', `${p.id}.md`),
            },
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
          { kind: 'accept', plan: planPath, pkgs: p.id, tag: `verify-${p.id}` },
          { output_format: ACCEPT_OUT }
        )
      );
      prev = `verify-${p.id}`;
    }
    const verify = Object.fromEntries(
      m.packages.map((p, i) => [`verify_${String(i)}`, `$verify-${p.id}.output.ok`])
    );
    nodes.push(
      check(`gate-${m.id}`, [prev], { kind: 'gate', milestone: m.id, risk: m.risk, ...verify })
    );
    prev = `gate-${m.id}`;
  }
  nodes.push(check('land', [prev], { kind: 'land', base_ref: plan.base_ref }));
  return {
    name: `sa-${run}`,
    description: `superagent run ${run}: ${String(plan.packages.length)} package(s), ${String(ms.length)} milestone(s)`,
    nodes,
  };
}

const fakeCoder = (p: Pkg): string => {
  const f = p.scope.write[0].replace(/[^\w./-]/g, '_');
  return [
    `mkdir -p "$(dirname '${f}')" && echo '${p.id}' > '${f}'`,
    `git add '${f}' && git -c user.name=sa -c user.email=sa@localhost commit -qm 'fake ${p.id}'`,
    `echo '{"status":"done","changed_files":["${f}"],"quick_checks":[],"notes":"fake","blockers":[],"error_class":null}'`,
  ].join('\n');
};

export function renderBrief(p: Pkg, hint: string): string {
  const list = (xs: string[] | undefined): string =>
    xs?.length ? xs.map(x => `- \`${x}\``).join('\n') : '- （无）';
  return [
    `# 工作包 ${p.id}：${p.title}`,
    '',
    `风险 ${p.risk}，规模 ${p.size}`,
    '',
    '## 目标',
    '',
    p.goal,
    '',
    '## 只允许写这些路径',
    '',
    list(p.scope.write),
    '',
    '## 建议先读',
    '',
    list(p.scope.read_hint),
    '',
    '## 验收命令（引擎在你结束后于 worktree 根目录执行，退出码即结果；工作区须已提交干净）',
    '',
    list(p.accept.map(c => c.cmd)),
    '',
    '## 备注',
    '',
    p.notes ?? '（无）',
    '',
    `若文件 \`${hint}\` 存在，必须先完整阅读：那是元帅对上一次失败给出的提示。`,
    '',
  ].join('\n');
}

const git = (cwd: string, ...args: string[]): void => {
  const p = Bun.spawnSync(
    ['git', '-c', 'user.name=superagent', '-c', 'user.email=superagent@localhost', ...args],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
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
    YAML.stringify(buildWorkflow(plan, ms, run, dir, fake), { lineWidth: 0, aliasDuplicateObjects: false })
  );
  writeFileSync(join(dir, '.gitignore'), 'hints/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.archon', 'plan.json', 'briefs', '.gitignore');
  git(dir, 'commit', '-qm', `superagent ${run}`);
  const v = archon(['validate', 'workflows', workflow, '--cwd', dir]);
  if (v.code !== 0) throw new Error(`generated workflow invalid: ${tail(v.out + v.err)}`);
  return { dir, workflow };
}
