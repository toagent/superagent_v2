// superagent 生成工作流的确定性节点（script: sa-check, runtime: bun）。由 INPUTS_KIND 选择：
//   env    plan 级与包级 environment 检查；失败即 exit 1（held:environment）
//   accept 执行 INPUTS_PKGS 的验收命令（退出码即结果）+ 工作区必须干净；INPUTS_BASE 非空时另存 diff 并在失败时
//          于 BASE 的临时工作树重跑失败命令（probe：base_pass=false 即基线本来就失败）
//   gate   第 INPUTS_ROUND 轮评审后的判定：pass / fix（进入下一轮修复）/ escalate（exit 1，升级给用户）
//   land   打印本地合入命令（永不 push）
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// 只引类型：Bun 转译时擦除，复制到 gen 目录后不依赖 src/
import type { Check, Plan } from '../../../src/plan';

interface Finding {
  id: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  status: 'open' | 'closed';
  evidence: string;
  carry_over: boolean;
}
interface Review {
  status: 'PASS' | 'FAIL' | 'INCOMPLETE';
  findings: Finding[];
  debt: string[];
}
interface Accept {
  ok: boolean;
  diff_hash: string;
  same: boolean;
}

const env = (k: string): string => process.env[`INPUTS_${k}`] ?? '';
const artifacts = process.env.ARTIFACTS_DIR ?? '';
const json = (k: string): unknown =>
  env(k) && env(k) !== 'null' ? (JSON.parse(env(k)) as unknown) : null;
const git = (...args: string[]): string => {
  const p = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
};
const plan = (): Plan => JSON.parse(readFileSync(env('PLAN'), 'utf8')) as Plan;
const emit = (o: unknown): void => {
  console.log(JSON.stringify(o));
};

/** 逐条执行；超时由 spawnSync 杀进程。返回失败条目。 */
function run(checks: Check[], log: string, cwd?: string): string[] {
  const failed: string[] = [];
  for (const c of checks) {
    const t0 = Date.now();
    const p = Bun.spawnSync(['bash', '-c', c.cmd], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: c.timeout_s * 1000,
    });
    const code = p.signalCode ? `signal ${p.signalCode}` : p.exitCode;
    appendFileSync(
      log,
      `$ ${c.cmd}\n${p.stdout.toString()}${p.stderr.toString()}# exit=${String(code)} ms=${String(Date.now() - t0)}\n\n`
    );
    if (code !== 0) failed.push(c.cmd);
  }
  return failed;
}

function accept(): void {
  const tag = env('TAG');
  const log = join(artifacts, `${tag}.log`);
  writeFileSync(log, '');
  const ids = env('PKGS').split(',').filter(Boolean);
  const pkgs = plan().packages.filter(p => ids.includes(p.id));
  const failed = run(
    pkgs.flatMap(p => p.accept),
    log
  );
  const dirty = git('status', '--porcelain').trim();
  if (dirty)
    appendFileSync(
      log,
      `# uncommitted changes (commit them; land only merges commits):\n${dirty}\n`
    );
  const base = env('BASE');
  const patch = base ? join(artifacts, `${tag}.patch`) : '';
  const diff = base ? git('diff', '--binary', base, 'HEAD') : '';
  if (base) writeFileSync(patch, diff);
  const hash = base ? createHash('sha256').update(diff).digest('hex').slice(0, 16) : '';
  emit({
    ok: failed.length === 0 && !dirty,
    failed,
    log,
    patch,
    diff_hash: hash,
    // 修复轮的 diff 与上一轮相同：修复没有改任何东西，评审节点据此跳过、gate 直接 escalate
    same: env('PREV') !== '' && hash === env('PREV'),
    base_pass:
      base && failed.length
        ? probe(
            base,
            pkgs.flatMap(p => p.accept).filter(c => failed.includes(c.cmd)),
            tag
          )
        : null,
    head: git('rev-parse', 'HEAD').trim(),
  });
}

/** 在 base 的临时 detached 工作树里重跑失败的验收命令：区分“本包引入”与“基线预存”失败。 */
function probe(base: string, checks: Check[], tag: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'sa-probe-'));
  git('worktree', 'add', '--detach', '-q', dir, base);
  try {
    return run(checks, join(artifacts, `${tag}.probe.log`), dir).length === 0;
  } finally {
    git('worktree', 'remove', dir);
  }
}

function environment(): void {
  const log = join(artifacts, 'environment.log');
  writeFileSync(log, '');
  const p = plan();
  const failed = run(
    [...(p.environment ?? []), ...p.packages.flatMap(k => k.environment ?? [])],
    log
  );
  emit({ ok: failed.length === 0, failed, log, head: git('rev-parse', 'HEAD').trim() });
  if (failed.length) process.exit(1);
}

const severities = (risk: string): string[] =>
  risk === 'G2' ? ['blocker', 'high', 'medium'] : ['blocker', 'high'];

/**
 * 逐轮推进的 open 阻塞发现 ID 集合。第 1 轮：open 的 blocker/high（G2 含 medium）。第 2/3 轮以上一轮集合为基准：
 * 只有本轮用原 id、carry_over:true、status:closed 且附 evidence 的条目才关闭；缺失、改 id、carry_over:false 一律仍 open。
 * 不在基准里的条目：新发现仅 open 的 blocker 阻塞，声明 carry_over 的按本级别阻塞。
 */
export function openBlocking(reviews: Review[], risk: string): Set<string> {
  const sev = severities(risk);
  let open = new Set<string>();
  reviews.forEach((r, i) => {
    const closed = (id: string): boolean =>
      r.findings.some(
        f => f.id === id && f.carry_over && f.status === 'closed' && f.evidence.trim() !== ''
      );
    const next = new Set([...open].filter(id => !closed(id)));
    for (const f of r.findings)
      if (
        f.status === 'open' &&
        !open.has(f.id) &&
        (i === 0 || f.carry_over ? sev.includes(f.severity) : f.severity === 'blocker')
      )
        next.add(f.id);
    open = next;
  });
  return open;
}

/** 评审债：评审给了 debt[] 就用它；为空时由未阻塞的 open 发现派生（G1 的 medium/low 不能无声消失）。 */
function debtOf(r: Review, open: Set<string>): string[] {
  if (r.debt.length) return r.debt;
  return r.findings
    .filter(f => f.status === 'open' && !open.has(f.id))
    .map(f => `${f.id} ${f.severity} ${f.file}:${String(f.line)}`);
}

export const MAX_ROUNDS = 3;
type Verdict = 'pass' | 'fix' | 'escalate';

/**
 * reviews[i]/rechecks[i] 为第 i+1 轮评审与其前的验收复跑（rechecks[0] = 首轮 diff 节点）。
 * 先判到期，再判修复无变化（same:true 时评审节点已跳过，reviews 末项为 null），最后才看能否 PASS。
 */
export function decide(input: {
  reviews: (Review | null)[];
  rechecks: Accept[];
  risk: string;
  expired?: boolean;
}): { verdict: Verdict; rounds: number; reason: string | null; debt: string[] } {
  const { rechecks } = input;
  const rounds = input.reviews.length;
  if (input.expired) return { verdict: 'escalate', rounds, reason: 'deadline', debt: [] };
  if (rechecks.at(-1)?.same) return { verdict: 'escalate', rounds, reason: 'no_change', debt: [] };
  const reviews = input.reviews.filter((r): r is Review => r !== null);
  const last = reviews.at(-1);
  if (!last || reviews.length !== rounds) throw new Error('gate: no review');
  const open = openBlocking(reviews, input.risk);
  const debt = debtOf(last, open);
  const acceptOk = rechecks.at(-1)?.ok ?? false;
  if (last.status === 'PASS' && open.size === 0 && acceptOk) {
    return { verdict: 'pass', rounds, reason: null, debt };
  }
  const reason = !acceptOk
    ? 'acceptance_failed'
    : { PASS: 'review_inconsistent', FAIL: 'review_failed', INCOMPLETE: 'review_incomplete' }[
        last.status
      ];
  if (rounds < MAX_ROUNDS && last.status !== 'INCOMPLETE')
    return { verdict: 'fix', rounds, reason, debt };
  return {
    verdict: 'escalate',
    rounds,
    reason: rounds >= MAX_ROUNDS ? `${reason}+review_limit` : reason,
    debt,
  };
}

const expired = (): boolean => Date.now() > Date.parse(plan().deadline);

function gate(): void {
  const round = Number(env('ROUND'));
  const pick = (k: string): unknown[] =>
    Array.from({ length: round }, (_, i) => json(`${k}${String(i + 1)}`));
  const reviews = pick('R') as (Review | null)[];
  const tag = env('TAG');
  const reviewFile = join(artifacts, `${tag}.review.json`);
  writeFileSync(reviewFile, JSON.stringify(reviews.at(-1), null, 2));
  const out = {
    ...decide({
      reviews,
      rechecks: pick('C') as Accept[],
      risk: env('RISK'),
      expired: expired(),
    }),
    milestone: env('MILESTONE'),
    review_file: reviewFile,
    head: git('rev-parse', 'HEAD').trim(),
  };
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  emit(out);
  if (out.verdict === 'escalate') {
    console.error(
      `${tag}: escalate (${out.reason ?? ''}) after ${String(out.rounds)} review round(s)`
    );
    process.exit(1);
  }
}

/** 打印合入命令与各里程碑末轮 gate 的评审债；plan deadline 已过则拒绝（exit 1），不给出合入命令。 */
function land(): void {
  if (expired()) {
    console.error(`land: plan deadline ${plan().deadline} passed; not producing merge commands`);
    process.exit(1);
  }
  const repo = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const target = env('BASE_REF').replace(/^origin\//, '');
  const ff =
    Bun.spawnSync(['git', 'merge-base', '--is-ancestor', `refs/heads/${target}`, 'HEAD'])
      .exitCode === 0;
  const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  // 轮次 ≤ 3：文件名字典序即轮次序，同一里程碑后写的覆盖先写的
  const last = new Map<string, string[]>();
  for (const f of readdirSync(artifacts)
    .filter(x => /^gate-.+-r\d+\.json$/.test(x))
    .sort()) {
    const g = JSON.parse(readFileSync(join(artifacts, f), 'utf8')) as { debt: string[] };
    last.set(f.replace(/-r\d+\.json$/, ''), g.debt);
  }
  const out = {
    branch,
    head: git('rev-parse', 'HEAD').trim(),
    commands: [
      `git -C ${q(repo)} switch ${q(target)}`,
      `git -C ${q(repo)} merge ${ff ? '--ff-only' : '--no-ff'} ${q(branch)}`,
    ],
    debt: [...last.values()].flat(),
  };
  writeFileSync(join(artifacts, 'land.json'), JSON.stringify(out, null, 2));
  emit(out);
}

if (import.meta.main) {
  const kinds: Partial<Record<string, () => void>> = { env: environment, accept, gate, land };
  const fn = kinds[env('KIND')];
  if (!fn) throw new Error(`sa-check: unknown INPUTS_KIND ${env('KIND')}`);
  fn();
}
