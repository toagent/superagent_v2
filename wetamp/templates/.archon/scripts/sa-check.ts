// superagent 生成工作流的确定性节点（script: sa-check, runtime: bun）。由 INPUTS_KIND 选择：
//   env    plan 级与包级 environment 检查；失败即 exit 1（held:environment）
//   accept 执行 INPUTS_PKGS 的验收命令（退出码即结果）+ 工作区必须干净；INPUTS_BASE 非空时另存 diff 并在失败时
//          于 BASE 的临时工作树重跑失败命令（probe：base_pass=false 即基线本来就失败）；按将军输出与验收结果给出
//          disposition（advance / repair / suspend + 稳定 reason，F-18），并按实际改动推断风险（F-13）
//   settle 包级收尾：首次验收 advance 直接透传；repair 后复验，仍不 advance 即 suspend（repair_exhausted:*）
//   gate   第 INPUTS_ROUND 轮评审后的判定：pass / fix（进入下一轮修复）/ escalate（exit 1，升级给用户）
//   land   打印本地合入命令（永不 push）
import reasons from './reasons.json';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// 只引类型：Bun 转译时擦除，复制到 gen 目录后不依赖 src/
import type { Check, Plan } from '../../../src/plan';

export interface Finding {
  id: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  status: 'open' | 'closed';
  evidence: string;
  carry_over: boolean;
}
export interface Review {
  status: 'PASS' | 'FAIL' | 'INCOMPLETE';
  findings: Finding[];
  debt: string[];
}
interface Coder {
  status: 'done' | 'blocked' | 'partial';
  error_class: string | null;
  needs?: unknown[];
}
type Disposition = 'advance' | 'repair' | 'suspend';
interface Accept {
  ok: boolean;
  diff_hash: string;
  same: boolean;
  head?: string;
  risk?: string | null;
  disposition?: Disposition;
  reason?: string | null;
}
/** generate 写入 <gen>/policy.json 的 tiers.policy 子集（一次生成、整 run 共用）。 */
interface Policy {
  risk_paths: string[];
  code_extensions: string[];
  exempt_paths: string[];
  budget_floor: Record<string, number>;
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
const policy = (): Policy => JSON.parse(readFileSync(env('POLICY'), 'utf8')) as Policy;
const emit = (o: unknown): void => {
  const code = (o as { reason?: unknown }).reason;
  if (typeof code === 'string' && !reasons.some(r => r.code === code))
    throw new Error(`unregistered reason: ${code}`);
  console.log(JSON.stringify(o));
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const glob = (g: string, p: string): boolean => new Bun.Glob(g).match(p);

/**
 * 逐条执行；超时由 spawnSync 杀进程。返回失败条目。plan 声明 cache:true 的检查在同一 tree、命令、超时与环境下
 * 复用本 run 已通过的结果（F-21）；未声明的（可能外写、依赖时间或随机性）每次实跑。只缓存通过，失败永远重跑。
 */
function run(checks: Check[], log: string, cwd?: string, envKey = ''): string[] {
  const failed: string[] = [];
  const tree = envKey && git('rev-parse', 'HEAD^{tree}').trim();
  for (const c of checks) {
    const hit =
      tree && c.cache
        ? join(artifacts, 'accept-cache', sha(JSON.stringify([tree, c.cmd, c.timeout_s, envKey])))
        : '';
    if (hit && existsSync(hit)) {
      appendFileSync(log, `$ ${c.cmd}\n# reused pass from ${readFileSync(hit, 'utf8')}\n\n`);
      continue;
    }
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
    else if (hit) {
      mkdirSync(dirname(hit), { recursive: true });
      writeFileSync(hit, env('TAG'));
    }
  }
  return failed;
}

/**
 * 存档将军输出供 supervise-tick 聚合 needs、评审核对 deviations。blocked 只在命中红线或 needs 非空时成立，
 * 否则按 partial 记（照常进入修复循环）。输出不是 JSON 时原样存档，不让验收因此失败。
 */
function saveCoder(tag: string, raw: string, errorClassIgnored = false): void {
  if (!raw) return;
  let out: Record<string, unknown>;
  try {
    const c = JSON.parse(raw) as Coder;
    const legit = c.error_class === 'redline' || (c.needs?.length ?? 0) > 0;
    out = { ...c, status: c.status === 'blocked' && !legit ? 'partial' : c.status };
  } catch {
    out = { raw };
  }
  writeFileSync(
    join(artifacts, `${tag}.coder.json`),
    JSON.stringify(
      {
        ...out,
        ...(errorClassIgnored ? { error_class_ignored: true } : {}),
        milestone: env('MILESTONE'),
      },
      null,
      2
    )
  );
}

/** 将军自己也解决不了、修复轮只会再烧一次调用的错误类：直接挂起交给处置表。 */
export const SUSPEND_CLASSES = [
  'env',
  'sandbox_denied',
  'permission_denied',
  'vendor_unavailable_all',
  'budget_exhausted',
  'plan_invalid',
  'scope_violation',
];

/**
 * I1：非法输出、红线与 blocked needs 优先挂起；其余以验收证据为准，自报冲突交评审核实。
 * 仅红验收按错误类挂起或修复；保持修复原因串，供 HOLD_POLICY 消费。
 */
export function disposition(
  raw: string,
  ok: boolean
): {
  disposition: Disposition;
  reason: string | null;
  error_class_ignored?: true;
  coder_partial?: true;
  self_report_conflict?: true;
} {
  const to = (d: Disposition, reason: string | null) => ({ disposition: d, reason });
  const green = ok ? to('advance', null) : to('repair', 'acceptance_failed');
  if (!raw || raw === 'null') return green;
  let c: Coder;
  try {
    c = JSON.parse(raw) as Coder;
  } catch {
    return to('suspend', 'coder_output_invalid');
  }
  if (c.error_class === 'redline') return to('suspend', 'coder_redline');
  if (c.status === 'blocked' && (c.needs?.length ?? 0) > 0) return to('suspend', 'coder_needs');
  if (ok)
    return {
      ...green,
      ...(c.status !== 'done' || c.error_class ? { self_report_conflict: true } : {}),
      ...(c.status === 'partial' ? { coder_partial: true } : {}),
      ...(c.error_class ? { error_class_ignored: true } : {}),
    };
  if (c.error_class && SUSPEND_CLASSES.includes(c.error_class))
    return to('suspend', `coder_error:${c.error_class}`);
  return to('repair', c.status === 'done' ? 'acceptance_failed' : 'coder_partial');
}

const RISKS = ['G0', 'G1', 'G2'];
const maxRisk = (...rs: (string | null | undefined)[]): string =>
  RISKS[Math.max(0, ...rs.map(r => RISKS.indexOf(r ?? '')))];

/** `git diff --raw -z -M` 的逐项：状态、两侧 mode、路径（重命名/复制为源与目标）。 */
function changes(base: string): { modes: string[]; paths: string[] }[] {
  const f = git('diff', '--raw', '-z', '-M', base, 'HEAD').split('\0');
  const out: { modes: string[]; paths: string[] }[] = [];
  for (let i = 0; i + 1 < f.length; ) {
    const [om, nm, , , st] = f[i].slice(1).split(' ');
    const n = /^[RC]/.test(st) ? 2 : 1;
    out.push({ modes: [om, nm], paths: f.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return out;
}

/**
 * F-13 交付门禁（不是沙箱）：实际 candidate tree 对照 scope.write。越界、gitlink/symlink 变动、命中 risk_paths
 * 一律推断 G2；声明 G0 却改了代码文件推断 G1。有效风险 = max(声明, 推断)，评审与 gate 都按它执行。
 */
export function scopeRisk(
  ch: { modes: string[]; paths: string[] }[],
  write: string[],
  pol: Policy,
  declared: string
): { risk: string; out_of_scope: string[] } {
  const inScope = (p: string): boolean =>
    pol.exempt_paths.some(g => glob(g, p)) ||
    write.some(w => p === w || p.startsWith(w.replace(/\/*$/, '/')) || glob(w, p));
  const out_of_scope = [...new Set(ch.flatMap(c => c.paths).filter(p => !inScope(p)))];
  const inferred = ch.map(c =>
    c.modes.some(m => m === '160000' || m === '120000') ||
    c.paths.some(p => pol.risk_paths.some(g => glob(g, p)))
      ? 'G2'
      : c.paths.some(p => pol.code_extensions.some(e => p.endsWith(e)))
        ? 'G1'
        : 'G0'
  );
  return { risk: maxRisk(declared, out_of_scope.length ? 'G2' : 'G0', ...inferred), out_of_scope };
}

/** 一次验收：coder 处置 + 命令 + 干净工作区；有 BASE 时另存全量 patch、相对 DELTA_BASE 的增量 patch 与交付范围。 */
function acceptOnce(tag: string, coder: string): Record<string, unknown> & Accept {
  const log = join(artifacts, `${tag}.log`);
  writeFileSync(log, '');
  const ids = env('PKGS').split(',').filter(Boolean);
  const p = plan();
  const pkgs = p.packages.filter(k => ids.includes(k.id));
  // 全量评审覆盖 base_ref 以来的累计交付，前序包的已批准写入范围仍有效。
  const scopeIds = (env('SCOPE_PKGS') || env('PKGS')).split(',');
  const covered = p.packages.filter(k => scopeIds.includes(k.id));
  const checks = pkgs.flatMap(k => k.accept);
  // 缓存目录在本 run 的 ARTIFACTS_DIR 下，进程环境由同一 engine 给出；键里只放 plan 声明的环境检查
  const envKey = sha(JSON.stringify([p.environment, pkgs.map(k => k.environment)]));
  const dirty = git('status', '--porcelain').trim();
  const failed = run(checks, log, undefined, dirty ? '' : envKey);
  if (dirty)
    appendFileSync(
      log,
      `# uncommitted changes (commit them; land only merges commits):\n${dirty}\n`
    );
  const base = env('BASE');
  const save = (name: string, from: string): string => {
    if (!base) return '';
    writeFileSync(join(artifacts, name), git('diff', '--binary', from, 'HEAD'));
    return join(artifacts, name);
  };
  const patch = save(`${tag}.patch`, base);
  const delta = env('DELTA_BASE') ? save(`${tag}.delta.patch`, env('DELTA_BASE')) : patch;
  const hash = patch ? sha(readFileSync(patch, 'utf8')).slice(0, 16) : '';
  const scope =
    base && env('RISK')
      ? scopeRisk(
          changes(base),
          covered.flatMap(k => k.scope.write),
          policy(),
          env('RISK')
        )
      : { risk: env('RISK') || null, out_of_scope: [] };
  const ok = failed.length === 0 && !dirty;
  const result = disposition(coder, ok);
  saveCoder(tag, coder, result.error_class_ignored);
  // 存档一份：supervise-tick 自动重试时据此写失败命令与日志尾的提示
  return {
    ok,
    ...result,
    failed,
    log,
    patch,
    delta,
    diff_hash: hash,
    // 修复轮的 diff 与上一轮相同：修复没有改任何东西，评审节点据此跳过、gate 直接 escalate
    same: env('PREV') !== '' && hash === env('PREV'),
    base_pass:
      base && failed.length
        ? probe(
            base,
            checks.filter(c => failed.includes(c.cmd)),
            tag
          )
        : null,
    ...scope,
    head: git('rev-parse', 'HEAD').trim(),
  };
}

/** 写 <tag>.json 并输出；挂起（含预算超限）exit 1，run 停在本节点，后续包与评审都不启动。 */
function finish(tag: string, out: Record<string, unknown> & Accept): void {
  if (out.disposition !== 'suspend') {
    const over = budget();
    if (over) Object.assign(out, { disposition: 'suspend', reason: over });
  }
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  emit(out);
  if (out.disposition === 'suspend') {
    console.error(`${tag}: suspend (${out.reason ?? ''})`);
    process.exit(1);
  }
}

function accept(): void {
  finish(env('TAG'), acceptOnce(env('TAG'), env('CODER')));
}

/**
 * 包内修复后的结算：没有修复（verify 已 advance）就沿用 verify 的验收证据；修过则用修复输出重验，
 * 仍未 advance 即挂起 repair_exhausted:<原因>——每包只有一次修复机会，不在包级循环烧调用。
 */
function settle(): void {
  const tag = env('TAG');
  const first = json('FIRST') as Record<string, unknown> & Accept;
  const repaired = env('REPAIRED');
  if (!repaired || repaired === 'null') {
    if (first.disposition !== 'advance')
      throw new Error(`${tag}: repair skipped but verify did not advance`);
    finish(tag, first);
    return;
  }
  const out = acceptOnce(tag, repaired);
  if (out.disposition === 'repair')
    Object.assign(out, { disposition: 'suspend', reason: `repair_exhausted:${out.reason ?? ''}` });
  finish(tag, out);
}

/** 在 base 的临时 detached 工作树里重跑失败的验收命令：区分“本包引入”与“基线预存”失败。 */
function probe(base: string, checks: Check[], tag: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'sa-probe-'));
  git('worktree', 'add', '--detach', '-q', dir, base);
  try {
    return run(checks, join(artifacts, `${tag}.probe.log`), dir).length === 0;
  } finally {
    // 不加 --force：验收命令在工作树里留下的文件不替人丢弃；删不掉就保留并报路径
    const rm = Bun.spawnSync(['git', 'worktree', 'remove', dir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (rm.exitCode !== 0)
      console.error(`probe: kept worktree ${dir}: ${rm.stderr.toString().trim()}`);
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

/** 第 2/3 轮的有效关闭：原 id、carry_over:true、status:closed 且附 evidence；同轮同 id 另有 open 条目则 open 胜出。 */
const closes = (r: Review, id: string): boolean =>
  r.findings.some(
    f => f.id === id && f.carry_over && f.status === 'closed' && f.evidence.trim() !== ''
  ) && !r.findings.some(f => f.id === id && f.status === 'open');

export interface Entry {
  id: string;
  severity: Finding['severity'];
  file: string;
  line: number;
  /** 首次出现的轮次（1 起）。 */
  round: number;
  evidence?: string;
  closed_round?: number;
}
export interface Ledger {
  blocking: Entry[];
  debt: Entry[];
  closed: Entry[];
}

/**
 * F-19 累计台账，只由各轮评审历史派生。基准轮（首份非空评审）：open 的 blocker/high（G2 含 medium）阻塞。
 * 之后只有 closes() 成立的条目才关闭；缺失、改 id、carry_over:false 一律仍 open。不在台账里的 id 一律是新发现——
 * 自报 carry_over:true 也不扩大阻塞集合：只有 blocker 阻塞，其余记债；已在台账里的条目升为 blocker 时转为阻塞。
 */
export function ledgerOf(reviews: (Review | null)[], risk: string): Ledger {
  const sev = severities(risk);
  const open = new Map<string, Entry & { blocks: boolean }>();
  const closed: Entry[] = [];
  let base = true;
  reviews.forEach((r, i) => {
    if (!r) return;
    for (const [id, e] of open)
      if (closes(r, id)) {
        open.delete(id);
        const { blocks: _, ...entry } = e;
        void _;
        const ev = r.findings.find(f => f.id === id)?.evidence ?? '';
        closed.push({ ...entry, evidence: ev, closed_round: i + 1 });
      }
    for (const f of r.findings) {
      if (f.status !== 'open') continue;
      const known = open.get(f.id);
      if (known) known.blocks ||= f.severity === 'blocker';
      else
        open.set(f.id, {
          id: f.id,
          severity: f.severity,
          file: f.file,
          line: f.line,
          round: i + 1,
          blocks: base ? sev.includes(f.severity) : f.severity === 'blocker',
        });
    }
    base = false;
  });
  const strip = (b: boolean): Entry[] =>
    [...open.values()]
      .filter(e => e.blocks === b)
      .map(({ blocks: _, ...e }) => {
        void _;
        return e;
      });
  return { blocking: strip(true), debt: strip(false), closed };
}

/** 台账阻塞 id 集合（cli gateHint 的读取口）。 */
export const openBlocking = (reviews: (Review | null)[], risk: string): Set<string> =>
  new Set(ledgerOf(reviews, risk).blocking.map(e => e.id));

/** 评审债 = 末份评审员 debt[] ∪ 台账里 open 且不阻塞的条目（派生项始终并入，不信任评审员只登记部分）。 */
const debtOf = (reviews: (Review | null)[], l: Ledger): string[] => [
  ...new Set([
    ...(reviews.filter(r => r !== null).at(-1)?.debt ?? []),
    ...l.debt.map(e => `${e.id} ${e.severity} ${e.file}:${String(e.line)}`),
  ]),
];

export const MAX_ROUNDS = 3;
type Verdict = 'pass' | 'fix' | 'escalate';

/**
 * reviews[i]/rechecks[i] 为第 i+1 轮评审与其前的验收复跑（rechecks[0] = 首轮 diff 节点）。
 * 先判到期，再判修复无变化（same:true 时评审节点已跳过），再拒重复 id，最后才看能否 PASS。
 * 验收未 advance 时本轮评审被跳过（review 为 null）：按 diff 的 reason 直接进入修复，不烧评审调用。
 */
export function decide(input: {
  reviews: (Review | null)[];
  rechecks: Accept[];
  risk: string;
  expired?: boolean;
}): { verdict: Verdict; rounds: number; reason: string | null; debt: string[]; ledger: Ledger } {
  const { reviews } = input;
  const rounds = reviews.length;
  const check = input.rechecks.at(-1);
  const ledger = ledgerOf(reviews, input.risk);
  const out = (verdict: Verdict, reason: string | null, debt: string[] = []) => ({
    verdict,
    rounds,
    reason,
    debt,
    ledger,
  });
  if (input.expired) return out('escalate', 'deadline');
  if (check?.same) return out('escalate', 'no_change');
  // 同一份评审里 id 重复（含同 id 既 closed 又 open）：账本无法唯一解释，不放行也不降为债务
  if (reviews.some(r => r && new Set(r.findings.map(f => f.id)).size !== r.findings.length))
    return out('escalate', 'invalid_review');
  const debt = debtOf(reviews, ledger);
  const last = reviews.at(-1);
  let reason: string;
  if (!last) {
    if (!check?.disposition || check.disposition === 'advance') throw new Error('gate: no review');
    reason = check.reason ?? 'acceptance_failed';
  } else {
    const ok = check?.ok ?? false;
    if (last.status === 'PASS' && ledger.blocking.length === 0 && ok)
      return out('pass', null, debt);
    reason = !ok
      ? 'acceptance_failed'
      : { PASS: 'review_inconsistent', FAIL: 'review_failed', INCOMPLETE: 'review_incomplete' }[
          last.status
        ];
  }
  if (rounds >= MAX_ROUNDS) return out('escalate', `${reason}+review_limit`, debt);
  return out(last?.status === 'INCOMPLETE' ? 'escalate' : 'fix', reason, debt);
}

const expired = (): boolean => Date.now() > Date.parse(plan().deadline);

interface Binding {
  provider?: string;
  model?: { requested?: string; resolved?: { source: string; value?: string; reason?: string } };
}
interface RunEvent {
  event_type: string;
  step_name?: string;
  data?: {
    binding?: Binding;
    spend?: {
      tokens?: { source: string; value?: { input: number; output: number; cacheRead?: number } };
    };
  };
}
let events: RunEvent[] | undefined;
/**
 * 执行层台账（Archon 事件里的 spend/binding）。INPUTS_ARCHON 为空（fake 生成）时调用方不查：身份记 fake、
 * 预算不检查。输出前可能有日志行，取最后一个能整体解析的顶层 `{` 起点。
 */
function runEvents(): RunEvent[] {
  if (events) return events;
  const id = process.env.WORKFLOW_ID;
  if (!id) throw new Error('sa-check: WORKFLOW_ID unset');
  const p = Bun.spawnSync(
    [env('ARCHON'), 'workflow', 'get', id, '--verbose', '--events', '--json'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (p.exitCode !== 0)
    throw new Error(`archon workflow get ${id}: ${p.stderr.toString().slice(-300)}`);
  const lines = p.stdout.toString().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return (events =
        (JSON.parse(lines.slice(i).join('\n')) as { events?: RunEvent[] }).events ?? []);
    } catch {
      // 该行只是日志里的 `{`，继续向前找真正的 JSON 起点
    }
  }
  throw new Error(`archon workflow get ${id}: no JSON in output`);
}
const AI_NODE = /^(code|repair|fix|review)-/;

/**
 * F-16：下一次模型调用前的预算检查。launch = AI 节点每次启动（含失败与重试）；token 按“除缓存读外”的
 * 已知用量（input − cacheRead + output，cacheRead 未报按 0 记，取上界）。缺回执的调用不当 0：
 * 每个按本 run 已知单次最大值（无已知时按 budget_floor.S）预留。超限返回稳定 reason。
 */
export function budgetUsage(
  events: RunEvent[],
  floor: number
): { launches: number; weighted_tokens: number; reserve: number } {
  const ev = events.filter(e => AI_NODE.test(e.step_name ?? ''));
  const used = ev
    .filter(e => e.event_type === 'node_completed' || e.event_type === 'node_failed')
    .map(e => e.data?.spend?.tokens)
    .map(t =>
      t?.source === 'provider' && t.value
        ? t.value.input - (t.value.cacheRead ?? 0) + t.value.output
        : null
    );
  const known = used.filter((n): n is number => n !== null);
  const reserve = Math.max(0, ...known) || floor;
  const total = known.reduce((a, n) => a + n, 0) + (used.length - known.length) * reserve;
  return {
    launches: ev.filter(e => e.event_type === 'node_started').length,
    weighted_tokens: total,
    reserve,
  };
}
function budget(): string | null {
  if (!env('ARCHON')) return null;
  let b = plan().budget;
  const dir = dirname(env('PLAN')),
    m = env('MILESTONE');
  const extra = join(dir, 'budget-extra');
  if (existsSync(extra)) {
    const g = JSON.parse(readFileSync(extra, 'utf8')) as {
      milestone: string;
      attempt: number;
      limits?: Plan['budget'];
    };
    const attempt = join(dir, 'attempts', m);
    if (
      g.milestone === m &&
      existsSync(attempt) &&
      Number(readFileSync(attempt, 'utf8')) === g.attempt
    ) {
      if (
        !g.limits ||
        !Number.isSafeInteger(g.limits.launches) ||
        (g.limits.launches ?? 0) <= 0 ||
        !Number.isFinite(g.limits.weighted_tokens) ||
        g.limits.weighted_tokens <= 0
      )
        throw new Error('budget-extra: invalid limits');
      b = g.limits;
    }
  }
  const u = budgetUsage(runEvents(), policy().budget_floor.S);
  if (b.launches !== undefined && u.launches >= b.launches) return 'budget_launches_exceeded';
  return u.weighted_tokens > b.weighted_tokens ? 'budget_tokens_exceeded' : null;
}

interface Ident {
  model: string | null;
  strength: 'provider' | 'pinned' | 'unknown' | 'fake';
}
/**
 * 执行层记录的实际模型。provider 回执最强；Codex 不回报实际模型（resolved: unsupported），以钉死的请求模型
 * 记为 pinned（较弱证据，gate 输出里可见）；其余为 unknown。
 */
export const identityOf = (b: Binding | undefined): Ident => {
  const m = b?.model;
  if (m?.resolved?.source === 'provider' && m.resolved.value)
    return { model: m.resolved.value, strength: 'provider' };
  if (m?.resolved?.reason === 'unsupported' && m.requested)
    return { model: m.requested, strength: 'pinned' };
  return { model: null, strength: 'unknown' };
};

/** F-14：不合格的原因；null = 合格独立评审（双方身份已知、实际模型不同）。 */
export function independence(authors: Ident[], reviewer: Ident): string | null {
  if (reviewer.strength === 'unknown') return 'reviewer_unknown';
  if (!authors.length || authors.some(a => a.strength === 'unknown')) return 'author_unknown';
  if (authors.some(a => a.model === reviewer.model)) return 'same_model';
  return null;
}

function gate(): void {
  const round = Number(env('ROUND'));
  const pick = (k: string): unknown[] =>
    Array.from({ length: round }, (_, i) => json(`${k}${String(i + 1)}`));
  const reviews = pick('R') as (Review | null)[];
  const rechecks = pick('C') as Accept[];
  const tag = env('TAG');
  const reviewFile = join(artifacts, `${tag}.review.json`);
  writeFileSync(reviewFile, JSON.stringify(reviews.at(-1), null, 2));
  const risk = maxRisk(env('RISK'), ...rechecks.map(c => c.risk));
  const d = decide({ reviews, rechecks, risk, expired: expired() });
  const ledgerFile = join(artifacts, `${tag}.ledger.json`);
  writeFileSync(ledgerFile, JSON.stringify(d.ledger, null, 2));
  const reviewed = reviews
    .map((r, i) => (r ? i : -1))
    .filter(i => i >= 0)
    .at(-1);
  let grade: string | null = null;
  let identity: { authors: Ident[]; reviewer: Ident } | null = null;
  if (d.verdict === 'pass') {
    const m = env('MILESTONE');
    const fake = { model: 'fake', strength: 'fake' } as const;
    const done = env('ARCHON') ? runEvents().filter(e => e.event_type === 'node_completed') : [];
    const author = new RegExp(
      `^((code|repair)-(${env('PKGS').split(',').join('|')})|fix-${m}-r\\d)$`
    );
    const reviewer = `review-${m}-r${String((reviewed ?? 0) + 1)}`;
    identity = env('ARCHON')
      ? {
          authors: done
            .filter(e => author.test(e.step_name ?? ''))
            .map(e => identityOf(e.data?.binding)),
          reviewer: identityOf(done.filter(e => e.step_name === reviewer).at(-1)?.data?.binding),
        }
      : { authors: [fake], reviewer: { ...fake, model: 'fake-reviewer' } };
    const why = independence(identity.authors, identity.reviewer);
    grade = why ? 'DEGRADED_PASS' : 'PASS';
    // strict 与 G2 不接受降级：等合格独立评审（escalate 给用户）；其余带原因显式降级放行
    if (why)
      Object.assign(
        d,
        plan().mode === 'strict' || risk === 'G2'
          ? { verdict: 'escalate', reason: `review_not_independent:${why}` }
          : { reason: `review_not_independent:${why}` }
      );
  }
  const over = d.verdict === 'fix' || (d.verdict === 'pass' && env('NEXT')) ? budget() : null;
  if (over) Object.assign(d, { verdict: 'escalate', reason: over });
  const { ledger: _, ...rest } = d;
  void _;
  const out = {
    ...rest,
    grade: d.verdict === 'pass' ? grade : null,
    risk,
    identity,
    milestone: env('MILESTONE'),
    review_file: reviewFile,
    ledger_file: ledgerFile,
    // 末份非空评审所见的 HEAD：下一轮 diff 以它为增量起点（F-20）；尚无评审为空，下一轮评审做全量
    reviewed_head: reviewed === undefined ? '' : (rechecks[reviewed].head ?? ''),
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
    const g = JSON.parse(readFileSync(join(artifacts, f), 'utf8')) as {
      debt: string[];
      grade?: string | null;
      reason?: string | null;
    };
    last.set(f.replace(/-r\d+\.json$/, ''), [
      ...g.debt,
      ...(g.grade === 'DEGRADED_PASS' ? [`DEGRADED_PASS ${g.reason ?? ''}`] : []),
    ]);
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
  const kinds: Partial<Record<string, () => void>> = {
    env: environment,
    accept,
    settle,
    gate,
    land,
  };
  const fn = kinds[env('KIND')];
  if (!fn) throw new Error(`sa-check: unknown INPUTS_KIND ${env('KIND')}`);
  fn();
}
