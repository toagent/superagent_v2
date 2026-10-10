// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import { saveIncident } from './incidents';
import { askKey, cockpitSignals, supersedeAsks, type HoldSignal, type Ask, type Asks } from './cockpit-signals';
export type { Asks } from './cockpit-signals';
import { launcher, type Launcher } from './launcher';
import { HOLD_POLICY, reasonOf, type Hold, type Policy } from './reasons';
export { HOLD_POLICY, type Hold, type Policy } from './reasons';
import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs as parse } from 'node:util';
import {
  archon,
  archonDetached,
  archonJson,
  getRun,
  lastJson,
  lock,
  ownerLost,
  pidAlive,
  QUERY_TIMEOUT_MS,
  recover,
  signalHuman,
  tail,
  type RecoverResult,
  type RunView,
} from './archon';
import {
  openBlocking,
  budgetUsage,
  type Review,
  type decide as decideGate,
} from '../templates/.archon/scripts/sa-check';
import {
  WETAMP,
  aliasDrift,
  codexWorkerProblem,
  home,
  loadTiers,
  receiptProblem,
  runAliases,
  writeAtomic,
  type Receipt,
} from './config';
import { engineHash, generate, newRunId } from './generate';
import { loadPlan, milestones, type Plan } from './plan';
import { redact } from './redact';
import { buildReport } from './report';
import { readUsage, usageSummary, usageCli } from './usage';

const OPTIONS = {
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  'skip-selftest': { type: 'boolean' },
  cwd: { type: 'string' },
  once: { type: 'boolean' },
  interval: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' }, // 输出本来就是 JSON；接受以兼容 superagent v1 调用方
  'all-held': { type: 'boolean' },
  title: { type: 'string' },
  card: { type: 'string' },
  log: { type: 'string' },
  role: { type: 'string' },
  all: { type: 'boolean' },
  since: { type: 'string' },
  refresh: { type: 'boolean' },
  open: { type: 'boolean' },
} as const;
interface Args {
  _: string[];
  flags: ReturnType<typeof parse<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];
}
/** 严格模式：未知参数直接报错，不静默忽略。 */
export function parseArgs(argv: string[]): Args {
  const { values, positionals } = parse({ args: argv, options: OPTIONS, allowPositionals: true });
  return { _: positionals, flags: values };
}

const print = (o: unknown): void => {
  console.log(JSON.stringify(o, null, 2));
};

/** 0 completed；1 failed；2 cancelled；3 held（等元帅/用户决策）；4 仍在运行（wait 超时或 status 查询）。 */
export const EXIT = { completed: 0, failed: 1, cancelled: 2, held: 3, running: 4 } as const;
/** 别名漂移：全局或目标 repo 的 @sa-* 别名与 tiers.json 渲染值不一致，run 拒绝启动。 */
export const EXIT_ALIAS_DRIFT = 5;
export const EXIT_USAGE = 64;

export interface Ledger {
  engine_hash?: string;
  adoptions?: {
    at: string;
    from: string;
    to: string;
    engine_from: string | null;
    engine_to: string;
    reason: string;
  }[];
  launcher?: Launcher;
  run_id: string;
  archon_run_id: string;
  plan: string;
  gen_dir: string;
  repo: string;
  branch: string;
  workflow: string;
  console: string;
  started_at: string;
  transcript: string;
  log: string;
  recoveries: string[];
  /** 最近一次 recover 时已完成节点集合的指纹，及在该指纹上连续 recover 的次数（旧 ledger 无这两项）。 */
  progress_fp?: string;
  stalled?: number;
  /** supervise-tick 因 plan 截止已过取消 run 时写入。 */
  state?: 'failed';
  reason?: 'deadline';
  /** supervise-tick 的自动重试；reason 前缀即类别（gate:<gate reason> / environment / coder:<节点> / paused）。与 stalled 互不影响。 */
  auto_retries?: AutoRetry[];
  /** supervise-tick 的处置记录（最近 20 条）。 */
  dispositions?: Disposition[];
  budget_grants?: {
    at: string;
    milestone: string;
    attempt: number;
    launches: number;
    weighted_tokens: number;
  }[];
  /** 启动进程没写成 ledger、由 tick 按启动意图对账补写的时间。 */
  reconciled_at?: string;
}
export interface AutoRetry {
  deterministic?: true;
  engine_hash?: string;
  milestone: string;
  at: string;
  reason: string;
}

export const ledgerPath = (run: string): string => join(home().sa, 'runs', `${run}.json`);
const saveLedger = (l: Ledger): void => {
  writeAtomic(ledgerPath(l.run_id), JSON.stringify(l, null, 2) + '\n');
};

const LEDGER_STRINGS = ['run_id', 'archon_run_id', 'gen_dir', 'repo', 'branch', 'workflow'];
/** 读并校验 ledger；坏文件抛带路径的错误，不当成空对象。 */
export function loadLedger(run: string): Ledger {
  const p = ledgerPath(run);
  if (!existsSync(p)) throw new Error(`unknown run ${run} (no ${p})`);
  let o: Partial<Record<string, unknown>> | null;
  try {
    o = JSON.parse(readFileSync(p, 'utf8')) as typeof o;
  } catch (e) {
    throw new Error(`ledger ${p}: ${(e as Error).message}`);
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o))
    throw new Error(
      `ledger ${p}: not a JSON object (${o === null ? 'null' : Array.isArray(o) ? 'array' : typeof o})`
    );
  const bad = LEDGER_STRINGS.filter(k => typeof o[k] !== 'string');
  if (!Array.isArray(o.recoveries)) bad.push('recoveries');
  if (o.run_id !== run) bad.push('run_id≠file');
  if (bad.length) throw new Error(`ledger ${p}: bad ${bad.join(',')}`);
  return o as unknown as Ledger;
}

/** ledger 的读改写与 recover 同锁（runs/<archon id>.lock），锁忙最多等 10 秒；改完同步回调用方的副本。 */
function updateLedger(l: Ledger, f: (cur: Ledger) => void): void {
  const path = join(home().sa, 'runs', `${l.adoptions?.[0]?.from ?? l.archon_run_id}.lock`);
  for (let i = 0; ; i++) {
    const k = lock(path);
    if (k.ok) {
      try {
        const cur = loadLedger(l.run_id);
        f(cur);
        saveLedger(cur);
        Object.assign(l, cur);
        return;
      } finally {
        k.release();
      }
    }
    if (i >= 100) throw new Error(`ledger ${l.run_id}: ${path} busy`);
    Bun.sleepSync(100);
  }
}

export interface Classified {
  state: string;
  exit: number;
  node?: string;
  event?: string;
}

/** archon run 状态 → superagent 状态。gate/environment 失败是“待决策”而非终局失败：decide retry 可 resume。 */
export function classify(run: RunView): Classified {
  const failed = run.nodes?.find(n => n.state === 'failed')?.nodeId;
  switch (run.status) {
    case 'completed':
      return { state: 'completed', exit: EXIT.completed };
    case 'cancelled':
      return { state: 'cancelled', exit: EXIT.cancelled };
    case 'paused': {
      const event = run.metadata?.wait?.event;
      return event?.startsWith('sa.human.')
        ? { state: 'held:human', exit: EXIT.held, node: run.metadata?.wait?.nodeId, event }
        : { state: 'held:paused', exit: EXIT.held, node: run.metadata?.wait?.nodeId };
    }
    case 'failed':
      if (failed === 'environment')
        return { state: 'held:environment', exit: EXIT.held, node: failed };
      if (failed?.startsWith('gate-')) return { state: 'held:gate', exit: EXIT.held, node: failed };
      return { state: 'failed', exit: EXIT.failed, node: failed };
    default:
      return { state: ownerLost(run) ? 'owner_lost' : run.status, exit: EXIT.running };
  }
}

export const artifactsOf = (run: RunView): string =>
  join(run.output_root ?? '', 'artifacts', 'runs', run.id);
export const readJson = (p: string): unknown =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
export type Gate = ReturnType<typeof decideGate>;
/** 各轮 gate 结论文件，按里程碑、轮次排序（轮次 ≤ 3，字典序即轮次序）。 */
export const gatesOf = (art: string): string[] =>
  existsSync(art)
    ? readdirSync(art)
        .filter(f => /^gate-.+-r\d+\.json$/.test(f))
        .sort()
    : [];
/** 将军输出存档（sa-check accept 写的 `<tag>.coder.json`），可按里程碑过滤。 */
interface CoderOut {
  tag: string;
  milestone?: string;
  error_class?: string | null;
  needs?: { cap: string; why: string; minimal_ask: string }[];
}
const codersOf = (art: string, m?: string): CoderOut[] =>
  (existsSync(art) ? readdirSync(art).filter(f => f.endsWith('.coder.json')) : [])
    .map(f => ({ ...(readJson(join(art, f)) as CoderOut), tag: f.slice(0, -'.coder.json'.length) }))
    .filter(c => m === undefined || c.milestone === m);
/** 聚合 needs[]（每条带来源 tag）：status/brief/board 展示，自动重试据此保持 held。 */
export const needsOf = (art: string, m?: string): Record<string, string>[] =>
  codersOf(art, m).flatMap(c => (c.needs ?? []).map(n => ({ tag: c.tag, ...n })));

/** 登记过的 run id（runs/*.json 去掉扩展名）。 */
export const ledgerIds = (): string[] => {
  const dir = join(home().sa, 'runs');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
    : [];
};
/** 逐条读取：坏 ledger 变成 {run_id, error}，不拖垮其他 run。 */
const ledgers = (): (Ledger | { run_id: string; error: string })[] =>
  ledgerIds().map(id => {
    try {
      return loadLedger(id);
    } catch (e) {
      return { run_id: id, error: tail((e as Error).message, 200) };
    }
  });

/** ≤20 行的摘要：元帅只读这个和证据路径。 */
function summary(l: Ledger, run: RunView, c: Classified): Record<string, unknown> {
  const nodes = run.nodes ?? [];
  const art = artifactsOf(run);
  const needs = needsOf(art);
  return {
    run_id: l.run_id,
    engine:
      l.engine_hash === engineHash()
        ? 'current'
        : `stale(${l.engine_hash?.slice(0, 8) ?? 'unknown'})`,
    adoption: l.adoptions?.at(-1) ?? null,
    state: c.state,
    exit: c.exit,
    nodes: `${String(nodes.filter(n => n.state === 'completed').length)}/${String(nodes.length)} completed`,
    ...(c.node ? { node: c.node } : {}),
    ...(c.event ? { event: c.event } : {}),
    ...(c.node?.startsWith('gate-') ? { gate: readJson(join(art, `${c.node}.json`)) } : {}),
    ...(c.state === 'failed' ? failure(l, run, c.node) : {}),
    ...(c.state === 'completed'
      ? {
          land: (readJson(join(art, 'land.json')) as { commands?: string[] } | undefined)?.commands,
        }
      : {}),
    evidence: art,
    recoveries: l.recoveries.length,
    auto_retries: l.auto_retries?.length ?? 0,
    ...(needs.length ? { needs } : {}),
    ...(l.reason ? { reason: l.reason } : {}),
  };
}

/**
 * failed 的原因：有失败节点取节点 error；没有（启动失败、executor 在节点外出错、进程被信号终止）则取引擎写的
 * run 级 error（终局记录优先）与停止原因类别，并给出能看到全文的证据路径。错误文本先脱敏再截尾。
 */
function failure(l: Ledger, run: RunView, node: string | undefined): Record<string, unknown> {
  const cut = (s: string): string => tail(redact(s), 200);
  if (node) return { error: cut(run.nodes?.find(n => n.nodeId === node)?.error ?? '') };
  const why = run.metadata?.stop_reason;
  // 停止原因是引擎枚举值；不是枚举形状的就不当原因转述
  const token = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z_]{1,40}$/.test(v) ? v : undefined;
  const reason = token(why?.reason);
  const signal = token(why?.signal);
  const paths = [run.transcript_path, l.log, l.transcript].filter(
    (p): p is string => typeof p === 'string' && p !== '' && existsSync(p)
  );
  return {
    error: cut(run.terminal_record?.error ?? run.metadata?.error ?? ''),
    ...(reason ? { stop_reason: signal ? `${reason}:${signal}` : reason } : {}),
    evidence_paths: paths,
  };
}

const MAX_STALLED_RECOVERIES = 3;

const progressOf = (run: RunView): string =>
  new Bun.CryptoHasher('sha256')
    .update(
      (run.nodes ?? [])
        .filter(n => n.state === 'completed')
        .map(n => n.nodeId)
        .sort()
        .join('\n')
    )
    .digest('hex')
    .slice(0, 16);

const stalledOut = (l: Ledger, run: RunView): boolean =>
  l.progress_fp === progressOf(run) && (l.stalled ?? 0) >= MAX_STALLED_RECOVERIES;

/** classify + ledger：同一完成节点集合上已 recover 满 3 次的 owner-lost run 不再自动恢复，等元帅。 */
export function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
  if ((run.status === 'failed' || run.status === 'paused') && c.node) {
    const reason = nodeReason(run, c);
    const pkg = c.node.replace(/^(verify|settle|code|repair)-/, '');
    // settle 是修复后的复验；其红证据不能被首次 verify 的旧绿证据覆盖。
    const evidence = join(artifactsOf(run), `${c.node.startsWith('settle-') ? c.node : `verify-${pkg}`}.json`);
    const verify = readJson(evidence) as { ok?: boolean } | null;
    const started = run.nodes?.find(n => n.nodeId === c.node)?.startedAt;
    const current = !started || !/^(code|repair)-/.test(c.node) || (existsSync(evidence) && statSync(evidence).mtimeMs >= Date.parse(started));
    const deliberate = ['needs', 'redline', 'budget', 'coder_blocked'].includes(reasonHold(reason));
    if ((reason && !reasonOf(reason)) || (/^(verify|settle)-/.test(c.node) && !reason) || (/^(verify|settle|code|repair)-/.test(c.node) && current && verify?.ok === true && !deliberate))
      return { ...c, state: 'held:engine_suspect', exit: EXIT.held };
  }
  return c.state === 'owner_lost' && stalledOut(l, run)
    ? { state: 'held:recover_no_progress', exit: EXIT.held }
    : c;
}

/**
 * 所有恢复（wait、resume、decide retry、supervise-tick）的唯一入口。锁内重读 ledger 与 run：完成节点集合
 * 与上次相同且已连续 recover 3 次即拒绝（recover_no_progress）；fresh=true（decide retry）是元帅的显式决定，清零重计。
 * 计数、指纹、恢复时间同样在锁内写回 ledger：释放锁后才落盘会让交错的第二次 recover 读到旧计数。
 * auto（supervise-tick 自动重试）有自己的次数上限：不看也不改 stalled/recoveries，只追加 auto_retries。
 */
function recoverRun(
  l: Ledger,
  fresh = false,
  auto?: AutoRetry,
  prepare?: () => void
): RecoverResult {
  let fp = '';
  let adopted: { from: string; hash: string; engine_from: string | null } | undefined;
  return recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (run.status === 'completed') return 'status completed is not resumable';
      if (auto?.deterministic) {
        if (l.engine_hash === engineHash() || l.auto_retries?.some(r => r.engine_hash === auto.engine_hash)) return 'deterministic retry already used for this engine';
        if (!['failed', 'cancelled'].includes(run.status)) return 'deterministic retry requires terminal adopt';
        // 先记一次授权的尝试：启动失败也不重复烧同一指纹的调用。
        (l.auto_retries ??= []).push(auto);
        saveLedger(l);
      }
      if (auto) return undefined;
      if (fresh) l.stalled = 0;
      fp = progressOf(run);
      return stalledOut(l, run) ? 'recover_no_progress' : undefined;
    },
    ack => {
      if (adopted) {
        const to = String(ack.runId);
        (l.adoptions ??= []).push({
          at: new Date().toISOString(),
          from: adopted.from,
          to,
          engine_from: adopted.engine_from,
          engine_to: adopted.hash,
          reason: 'engine_stale',
        });
        l.archon_run_id = to;
        l.engine_hash = adopted.hash;
        l.transcript = typeof ack.transcriptPath === 'string' ? ack.transcriptPath : '';
        l.log = typeof ack.logPath === 'string' ? ack.logPath : '';
      }
      if (auto) {
        if (!l.auto_retries?.some(r => r.at === auto.at)) (l.auto_retries ??= []).push(auto);
      } else {
        l.stalled = (l.progress_fp === fp ? (l.stalled ?? 0) : 0) + 1;
        l.progress_fp = fp;
        l.recoveries.push(new Date().toISOString());
      }
      saveLedger(l);
    },
    prepare,
    {
      lockId: l.adoptions?.[0]?.from ?? l.archon_run_id,
      resolveId: () => {
        Object.assign(l, loadLedger(l.run_id));
        return l.archon_run_id;
      },
      adopt: run => {
        // Live and paused owners retain their snapshot; terminal recovery may change source.
        if (!['failed', 'cancelled'].includes(run.status) || l.engine_hash === engineHash())
          return undefined;
        const metadata = readJson(join(l.gen_dir, 'engine.json')) as { fake?: boolean } | null;
        const gen = generate(
          planOf(l),
          l.run_id,
          metadata?.fake ?? false,
          l.engine_hash ?? 'unknown'
        );
        adopted = { from: run.id, hash: gen.engine_hash, engine_from: l.engine_hash ?? null };
        return [
          'workflow',
          'run',
          l.workflow,
          '--adopt',
          run.id,
          '--workflow-source',
          gen.dir,
          '--cwd',
          l.repo,
          '--detach',
        ];
      },
    }
  );
}

/** 分片等待：事件门不会唤醒 archon wait，所以每片 ≤30s 后重新 get；可证实 owner-lost 时自动 recover。 */
export function waitRun(l: Ledger, timeoutS: number): Record<string, unknown> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const run = getRun(l.archon_run_id, l.repo);
    const c = classifyRun(l, run);
    if (c.state === 'owner_lost') {
      const r = recoverRun(l);
      if (r.ok) continue;
      // 另一进程正在恢复：稍候重读状态；到期仍是 owner_lost 则按运行中返回（exit 4），不报失败
      if (r.busy) {
        if (Date.now() >= deadline) return { ...summary(l, run, c), reason: r.reason };
        Bun.sleepSync(1000);
        continue;
      }
      const held = r.reason === 'recover_no_progress';
      return {
        ...summary(
          l,
          run,
          held
            ? { state: 'held:recover_no_progress', exit: EXIT.held }
            : { ...c, exit: EXIT.failed }
        ),
        reason: r.reason,
      };
    }
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (c.exit !== EXIT.running || left <= 0) return summary(l, run, c);
    archon(
      ['workflow', 'wait', l.archon_run_id, '--json', '--timeout', String(Math.min(30, left))],
      l.repo
    );
  }
}

const MIN_FREE_GB = 2;

function preflight(skipSelftest: boolean): void {
  const { sa } = home();
  const fs = statfsSync(sa);
  if ((fs.bavail * fs.bsize) / 2 ** 30 < MIN_FREE_GB)
    throw new Error(`preflight: < ${String(MIN_FREE_GB)}GB free under ${sa}`);
  if (skipSelftest) return;
  const why = receiptProblem(readJson(join(sa, 'selftest.json')) as Partial<Receipt> | undefined);
  if (why)
    throw new Error(
      `preflight: no valid selftest receipt: ${why}; fix: wetamp/scripts/selftest.sh (real, not --fake)`
    );
}

function startRun(planPath: string, a: Args): number {
  const run = newRunId();
  let phase: 'preflight' | 'engine' = 'preflight';
  try {
    preflight(a.flags['skip-selftest'] ?? false);
    const plan = loadPlan(planPath);
    const checked = Bun.spawnSync([process.execPath, join(WETAMP, 'src/preflight.ts'), plan.repo], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
    if (checked.exitCode !== 0) {
      const reason = lastJson(checked.stdout.toString())?.reason;
      throw new Error(typeof reason === 'string' ? reason : 'preflight: base branch inspection failed');
    }
    const drift = aliasDrift(plan.repo);
    if (drift.length) {
      const failure = { run_id: run, ok: false, phase, reason: 'alias_drift', drift, fix: 'wetamp/scripts/install.sh' };
      mkdirSync(join(home().sa, 'launch-failures'), { recursive: true });
      writeAtomic(join(home().sa, 'launch-failures', `${run}.json`), JSON.stringify(failure) + '\n');
      print(failure);
      return EXIT_ALIAS_DRIFT;
    }
    phase = 'engine';
    const gen = generate(plan, run, a.flags.fake ?? false);
    const branch = `sa/${run}`;
    const args = ['workflow', 'run', gen.workflow, '--workflow-source', gen.dir, '--cwd', plan.repo];
    args.push('--branch', branch, '--from', plan.base_ref, '--detach', '--config', gen.config);
    const l: Ledger = {
      run_id: run,
      engine_hash: gen.engine_hash,
      archon_run_id: '',
      plan: planPath,
      gen_dir: gen.dir,
      repo: plan.repo,
      branch,
      workflow: gen.workflow,
      console: plan.console ?? 'claude',
      started_at: new Date().toISOString(),
      transcript: '',
      log: '',
      recoveries: [],
      launcher: launcher(home().sa),
    };
    // 先落启动意图再启动：进程死在 archon 建 run 与写 ledger 之间时，tick 按工作流名对账（reconcileIntents）
    const intent: Intent = { ledger: l, host: hostname(), pid: process.pid };
    mkdirSync(join(home().sa, 'intents'), { recursive: true });
    writeAtomic(intentPath(run), JSON.stringify(intent, null, 2) + '\n');
    const ack = archonJson(args, plan.repo);
    if (ack.ok !== true || typeof ack.runId !== 'string')
      throw new Error(`archon run: ${tail(JSON.stringify(ack))}`);
    Object.assign(l, {
      archon_run_id: ack.runId,
      transcript: String(ack.transcriptPath),
      log: String(ack.logPath),
    });
    mkdirSync(join(home().sa, 'runs'), { recursive: true });
    saveLedger(l);
    rmSync(intentPath(run), { force: true });
    print({ run_id: run, archon_run_id: l.archon_run_id, branch, gen_dir: gen.dir });
    return 0;
  } catch (e) {
    const failure = { run_id: run, ok: false, phase, reason: redact((e as Error).message) };
    mkdirSync(join(home().sa, 'launch-failures'), { recursive: true });
    writeAtomic(join(home().sa, 'launch-failures', `${run}.json`), JSON.stringify(failure) + '\n');
    print(failure);
    return 1;
  }
}

/** 启动意图：ledger 草稿（archon_run_id 待定）+ 启动进程；结论 no_run 写回意图，run 出现前每个 tick 都再查。 */
interface Intent {
  ledger: Ledger;
  host: string;
  pid: number;
  no_run_at?: string;
}
const intentPath = (run: string): string => join(home().sa, 'intents', `${run}.json`);
const INTENT_GRACE_MS = 10 * 60e3;

/**
 * 对账没写成 ledger 的启动：已有 ledger → 删意图；启动进程还活着或未过 10 分钟 → 不动；archon.db 里按工作流名
 * （sa-<run>，每个 run 唯一）找到一个 run → 补写 ledger 并删意图；找不到 → 意图记 no_run 并报一次，不重启；多于一个 → 报错交人。
 */
function reconcileIntents(): Action[] {
  const dir = join(home().sa, 'intents');
  if (!existsSync(dir)) return [];
  const out: Action[] = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('.'))) {
    const id = f.slice(0, -5);
    try {
      const it = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Intent;
      if (existsSync(ledgerPath(id))) {
        rmSync(join(dir, f), { force: true });
        continue;
      }
      const launching = it.host === hostname() && pidAlive(it.pid);
      if (launching || Date.now() < Date.parse(it.ledger.started_at) + INTENT_GRACE_MS) continue;
      const db = new Database(join(home().archon, 'archon.db'), { readonly: true });
      let rows: { id: string }[];
      try {
        rows = db
          .query('select id from remote_agent_workflow_runs where workflow_name = ?')
          .all(it.ledger.workflow) as { id: string }[];
      } finally {
        db.close();
      }
      if (rows.length > 1)
        throw new Error(`${String(rows.length)} archon runs named ${it.ledger.workflow}`);
      if (rows.length === 1) {
        saveLedger({
          ...it.ledger,
          archon_run_id: rows[0].id,
          reconciled_at: new Date().toISOString(),
        });
        rmSync(join(dir, f), { force: true });
        out.push({ run_id: id, action: 'reconcile', ok: true, archon_run_id: rows[0].id });
      } else if (!it.no_run_at) {
        writeAtomic(
          join(dir, f),
          JSON.stringify({ ...it, no_run_at: new Date().toISOString() }, null, 2) + '\n'
        );
        out.push({
          run_id: id,
          action: 'reconcile',
          ok: false,
          reason: `launch intent without an archon run; start again with superagent run ${it.ledger.plan}`,
        });
      }
    } catch (e) {
      out.push({
        run_id: id,
        action: 'error',
        ok: false,
        error: tail(`intent: ${(e as Error).message}`, 200),
      });
    }
  }
  return out;
}

function health(cwd?: string): number {
  const aliases = runAliases('claude');
  const drift = aliasDrift(cwd);
  const doctor = archon(['doctor']);
  const clean = Bun.spawnSync([join(WETAMP, 'scripts', 'check-upstream-clean.sh')], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  const upstreamDiff = clean.stdout.toString().trim();
  const worker = codexWorkerProblem();
  const ok =
    doctor.code === 0 && clean.exitCode === 0 && upstreamDiff === '' && !drift.length && !worker;
  print({
    ok,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
    codex_worker: worker ?? 'ok',
  });
  return ok ? 0 : drift.length ? EXIT_ALIAS_DRIFT : 1;
}

function resumeRun(l: Ledger, fresh = false): number {
  const res = recoverRun(l, fresh);
  if (!res.ok && res.busy) return busyExit(l, res);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
}

/** 手动 resume / decide retry 撞上 recover 锁：重读状态后按当前状态退出（多为运行中 4 或 held 3），不当业务失败 1。 */
function busyExit(l: Ledger, res: RecoverResult): number {
  const c = classifyRun(l, getRun(l.archon_run_id, l.repo));
  print({ run_id: l.run_id, ...res, state: c.state });
  return c.exit;
}

/**
 * 终止 run 的唯一入口（cancel、decide reject、supervise-tick 的截止与“否”）。引擎的 cancel 只停 running 的 run，
 * paused/failed 须 abandon（同样记 cancelled 并释放 worktree 与 slot）。cancel 被拒时不解析拒绝文本：重读状态，
 * 期间已离开 running（如刚停在事件门）就改走 abandon。
 */
function cancelRun(id: string, status: RunView['status'], cwd?: string): boolean {
  const end = (s: RunView['status']): boolean =>
    archonJson(['workflow', s === 'running' ? 'cancel' : 'abandon', id], cwd).ok === true;
  if (end(status)) return true;
  if (status !== 'running') return false;
  const now = getRun(id, cwd).status;
  return now !== 'running' && end(now);
}

const planOf = (l: Ledger): Plan =>
  JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;

/** 过了 plan 的绝对 deadline，签收节点与 land 都会拒绝、supervise-tick 会取消 run；approve 在此提前拒绝，不发无效 signal。 */
const pastDeadline = (l: Ledger): boolean => Date.now() > Date.parse(planOf(l).deadline);
const PAST_DEADLINE =
  'plan deadline passed: decide reject, or start a new run with a later deadline';

/** 生成时带 attempt-<m> 节点的工作流（本版起都有）才能让 resume 重跑该里程碑的编码与修复。 */
const attemptable = (l: Ledger, m: string): boolean => {
  const wf = join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`);
  return existsSync(wf) && readFileSync(wf, 'utf8').includes(`id: attempt-${m}\n`);
};
/** attempt-<m>（always_run）读这个计数：数值变了，依赖它的 code/verify/fix/diff 节点在 resume 时重跑。 */
function bumpAttempt(l: Ledger, m: string): number {
  const dir = join(l.gen_dir, 'attempts');
  mkdirSync(dir, { recursive: true });
  const n = Number(readJson(join(dir, m)) ?? 0) + 1;
  writeAtomic(join(dir, m), String(n));
  return n;
}
const gateMilestone = (node: string): string => node.replace(/^gate-(.+)-r\d+$/, '$1');
const milestoneOf = (l: Ledger, node: string): string =>
  /^(verify|settle|code|repair)-/.test(node)
    ? (planOf(l).packages.find(p => node.replace(/^(verify|settle|code|repair)-/, '') === p.id)
        ?.milestone ?? 'm1')
    : gateMilestone(node.replace(/^fix-/, 'gate-'));

/** held:gate 的恢复：里程碑计数加一后 resume，重跑本里程碑编码→验收→评审；旧工作流无 attempt 节点则拒绝。 */
function retryGate(
  l: Ledger,
  node: string,
  fresh: boolean,
  auto?: AutoRetry,
  prepare?: () => void,
  key?: string
): RecoverResult {
  const m = milestoneOf(l, node);
  if (!attemptable(l, m))
    throw new Error(`decide retry: ${node} escalated; fix on ${l.branch} or start a new run`);
  return recoverRun(l, fresh, auto, () => {
    if (key && (readJson(join(l.gen_dir, 'budget-extra')) as { key?: string } | null)?.key === key)
      return;
    bumpAttempt(l, m);
    prepare?.();
  });
}

/** decide retry 的恢复部分：held:gate 走 retryGate，其余 resume 失败节点。 */
const retry = (l: Ledger, c: Classified, prepare?: () => void, key?: string): RecoverResult =>
  c.state === 'held:gate' || /^(verify|settle)-/.test(c.node ?? '')
    ? retryGate(l, c.node ?? '', true, undefined, prepare, key)
    : recoverRun(l, true, undefined, prepare);

/** decide --all-held retry：对所有 held（签收门除外）的 run 逐个 retry，单个失败不影响其余。 */
function retryAllHeld(): number {
  const out = ledgers().flatMap((l): Record<string, unknown>[] => {
    try {
      if ('error' in l) throw new Error(l.error);
      const c = classifyRun(l, getRun(l.archon_run_id, l.repo));
      if (!c.state.startsWith('held:') || c.state === 'held:human') return [];
      return [{ run_id: l.run_id, state: c.state, ...retry(l, c) }];
    } catch (e) {
      return [{ run_id: l.run_id, ok: false, reason: tail((e as Error).message, 200) }];
    }
  });
  print(out);
  return out.every(x => x.ok === true || x.busy === true) ? 0 : 1;
}

/** approve：放行 sa.human.* 签收门；reject：终止 run（cancelRun）；retry：可选写 hint 后 resume（held:gate 重跑整个里程碑）。 */
function decide(l: Ledger, a: Args): number {
  const action = need(a._[2], 'decide <run> approve|reject|retry [--pkg id --hint text]');
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  if (!holdOf(l, run, c)) {
    print({ run_id: l.run_id, ok: false, reason: `decide refused: run ${run.status} is not currently held` });
    return 1;
  }
  if (action === 'approve') {
    if (pastDeadline(l)) {
      print({ run_id: l.run_id, ok: false, reason: PAST_DEADLINE });
      return 1;
    }
    const log = join(l.gen_dir, `signal-${c.node ?? 'none'}.log`);
    const r = signalHuman(run, { decision: 'approve' }, log, l.repo);
    print({ run_id: l.run_id, ...r });
    return r.ok ? 0 : 1;
  }
  if (action === 'reject') {
    const ok = cancelRun(l.archon_run_id, run.status, l.repo);
    print({ run_id: l.run_id, decision: 'reject', ok });
    return ok ? 0 : 1;
  }
  if (action !== 'retry') throw new Error(`decide: unknown action ${action}`);
  const { hint, pkg } = a.flags;
  if (hint !== undefined) {
    if (pkg === undefined || !planOf(l).packages.some(p => p.id === pkg))
      throw new Error('decide retry --hint needs --pkg <package id from the plan>');
    writeFileSync(join(l.gen_dir, 'hints', `${pkg}.md`), hint + '\n');
  }
  const res = retry(l, c);
  if (!res.ok && res.busy) return busyExit(l, res);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
}

/** ≤20 行纯文本：状态、各轮 gate 结论与评审债、签收提问状态、合入命令、证据路径。 */
function brief(l: Ledger): number {
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  const s = summary(l, run, c);
  const art = artifactsOf(run);
  const lines = [
    `${l.run_id} ${c.state}${c.node ? ` @${c.node}` : ''} nodes ${String(s.nodes)} branch ${l.branch}`,
  ];
  lines.push(`engine: ${String(s.engine)}`);
  if (l.adoptions?.length) lines.push(`adoption: ${JSON.stringify(l.adoptions.at(-1))}`);
  for (const f of gatesOf(art)) {
    const g = readJson(join(art, f)) as Gate;
    lines.push(
      `${f.slice(0, -5)}: ${g.verdict}${g.reason ? ` (${g.reason})` : ''} debt=${String(g.debt.length)}`
    );
  }
  try {
    for (const [k, v] of Object.entries(asksOf(l.run_id)))
      lines.push(`ask ${k}: ${v?.status ?? '?'}`);
  } catch (e) {
    lines.push(`asks: ${tail((e as Error).message, 120)}`);
  }
  if (l.reason === 'deadline') lines.push('plan 截止已过，已取消');
  if (typeof s.error === 'string') lines.push(`error: ${s.error}`);
  if (Array.isArray(s.land)) lines.push(...(s.land as string[]));
  for (const n of needsOf(art).slice(0, 3))
    lines.push(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
  lines.push(
    `evidence: ${art}`,
    `recoveries: ${String(l.recoveries.length)} auto_retries: ${String(l.auto_retries?.length ?? 0)}`
  );
  console.log(lines.slice(0, 20).join('\n'));
  return c.exit;
}

/** 在 run 的 worktree 里跑 plan 的验收命令（同 verify 节点脚本），退出码即结果。 */
function acceptRun(l: Ledger, pkg: string | undefined): number {
  const run = getRun(l.archon_run_id, l.repo);
  if (!run.working_path) throw new Error(`accept: run ${l.run_id} has no worktree`);
  const ids = planOf(l)
    .packages.map(p => p.id)
    .filter(id => pkg === undefined || id === pkg);
  if (!ids.length) throw new Error(`accept: unknown package ${String(pkg)}`);
  const art = join(home().sa, 'accept', l.run_id);
  mkdirSync(art, { recursive: true });
  const p = Bun.spawnSync(
    [process.execPath, join(l.gen_dir, '.archon', 'scripts', 'sa-check.ts')],
    {
      cwd: run.working_path,
      env: {
        ...process.env,
        INPUTS_KIND: 'accept',
        INPUTS_PLAN: join(l.gen_dir, 'plan.json'),
        INPUTS_PKGS: ids.join(','),
        INPUTS_TAG: 'accept',
        ARTIFACTS_DIR: art,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const out = lastJson(p.stdout.toString());
  print(out ?? { ok: false, error: tail(p.stderr.toString()) });
  return out?.ok === true ? 0 : 1;
}

// supervise-tick：无人值守巡检（cron/launchd 周期调用 `superagent supervise-tick`）：唤醒到期的事件门、恢复 owner-lost，
// 其余非终态按 HOLD_POLICY 处置；需要拍板的投到 agent-supervisor（iPhone 提醒事项：勾选=是、删除=否），按回答执行。
export const ANSWERS = ['pending', 'yes', 'no', 'expired', 'superseded'];
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };

type Held = [Hold, Record<string, unknown>];

const asksPath = (): string => join(home().sa, 'asks.json');
/** 读不出就抛错：把截断或损坏的 asks.json 当空表，会让每个挂起再投一遍提醒。 */
const loadAsks = (): Asks => {
  const p = asksPath();
  if (!existsSync(p)) return {};
  try {
    const a = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error('not an object');
    return a as Asks;
  } catch (e) {
    throw new Error(`asks ${p}: ${(e as Error).message}`);
  }
};
const saveAsks = (asks: Asks): void => {
  writeAtomic(asksPath(), JSON.stringify(asks, null, 2) + '\n');
};

/** 某个 run 的提问；键 `<run>:<挂起类别>`：resumeAt 变了也不重投。 */
export const asksOf = (run: string): Asks =>
  Object.fromEntries(Object.entries(loadAsks()).filter(([k]) => k.startsWith(`${run}:`)));

const MAX_TTL_H = 72;
const ttlHours = (until: number): number =>
  Number.isFinite(until)
    ? Math.min(MAX_TTL_H, Math.max(1, Math.ceil((until - Date.now()) / 3600e3)))
    : MAX_TTL_H;
const supervisorPy = (): string =>
  process.env.SA_SUPERVISOR ??
  join(homedir(), '.ai-agent-shared', 'skills', 'agent-supervisor', 'scripts', 'supervisor.py');

function supervisor(args: string[]): string {
  const p = Bun.spawnSync(['python3', supervisorPy(), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  if (p.exitCode !== 0)
    throw new Error(
      `supervisor ${args[0]} exit ${String(p.exitCode)}: ${tail(p.stderr.toString(), 200)}`
    );
  return p.stdout.toString().trim();
}

/**
 * supervisor 的 ask 记录（SKILL 约定位置 `$AGENT_SUPERVISOR_STATE/asks/<id>.json`），只取 id 与问题文本。
 * 读不出或缺字段的记录逐个跳过并计数，不拖垮其他提问的对账。
 */
function askRecords(): { records: { id: string; question: string }[]; anomalous: number } {
  const dir = join(
    process.env.AGENT_SUPERVISOR_STATE ?? join(homedir(), '.local', 'state', 'agent-supervisor'),
    'asks'
  );
  const records: { id: string; question: string }[] = [];
  let anomalous = 0;
  for (const f of existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.json')) : []) {
    try {
      const r = readJson(join(dir, f)) as { id?: unknown; question?: unknown } | null;
      if (typeof r?.id === 'string' && typeof r.question === 'string')
        records.push({ id: r.id, question: r.question });
      else anomalous++;
    } catch {
      anomalous++;
    }
  }
  return { records, anomalous };
}

/**
 * 一条提醒的投递与对账（签收与挂起共用）。问题以 `superagent <key> ` 开头、≤120 字。先落 unknown 再调 ask；
 * supervisor 的 create() 先落盘再投递，非零退出或 tick 崩溃时提问可能已存在：unknown 先按前缀找回 id，找不到才重投。
 * 返回本次投递的 id（asked）或当前回答；多条记录同前缀时不猜，交给人。
 */
function pollAsk(
  key: string,
  text: string,
  hours: number,
  asks: Asks
): { a: Ask; asked?: string; note?: string } | { conflict: string } {
  let a = asks[key];
  let note: string | undefined;
  if (a !== undefined && a.id === undefined) {
    const { records, anomalous } = askRecords();
    if (anomalous) note = `${String(anomalous)} anomalous ask records`;
    const found = records.filter(r => r.question.startsWith(`superagent ${key} `) || (a?.legacy_key && r.question.startsWith(`superagent ${a.legacy_key} `)));
    if (found.length > 1)
      return {
        conflict: `ask ${key}: ${String(found.length)} supervisor asks match${note ? `; ${note}` : ''}`,
      };
    a = asks[key] = found.length ? { ...a, id: found[0].id, status: 'pending' } : undefined;
  }
  if (!a) {
    asks[key] = { status: 'unknown' };
    saveAsks(asks);
    const q = `superagent ${key} ${text}`.slice(0, 120);
    const id = supervisor(['ask', '--question', q, '--ttl-hours', String(hours)]);
    asks[key] = { id, status: 'pending' };
    saveAsks(asks);
    return { a: asks[key], asked: id, note };
  }
  if (a.status === 'pending' && a.id) {
    const st = supervisor(['ask-status', a.id]);
    if (!ANSWERS.includes(st))
      throw new Error(`supervisor ask-status: unexpected ${st.slice(0, 40)}`);
    a.status = st;
  }
  return { a, note };
}

/** plan 截止已过：终止 run（保留证据），该 run 未执行的提问记 expired，ledger 记 failed/deadline；不提醒。 */
function expireRun(l: Ledger, run: RunView, asks: Asks | Error, base: object): Action {
  const x = { run_id: l.run_id, ...base, action: 'cancel', reason: 'deadline' };
  if (!cancelRun(l.archon_run_id, run.status, l.repo)) return { ...x, ok: false };
  if (!(asks instanceof Error))
    for (const [k, a] of Object.entries(asks))
      if (k.startsWith(`${l.run_id}:`) && a && !['approved', 'rejected'].includes(a.status))
        asks[k] = { ...a, status: 'expired' };
  updateLedger(l, cur => {
    Object.assign(cur, { state: 'failed', reason: 'deadline' });
  });
  return { ...x, ok: true };
}

function human(l: Ledger, run: RunView, asks: Asks): Action {
  const w = run.metadata?.wait;
  if (!w?.event) throw new Error(`run ${l.run_id}: held:human without wait metadata`);
  const key = askKey(l.run_id, 'signoff');
  const base = { run_id: l.run_id, event: w.event };
  // 引擎的 wait.deadline_ms 从进入等待起计时，生成时无法折算成 plan 的绝对截止：由这里与 signoff 节点兜住
  if (pastDeadline(l)) return expireRun(l, run, asks, base);
  const text = `红线签收：批准合入 ${basename(l.repo)}？`;
  const p = pollAsk(key, text, ttlHours(Date.parse(w.resumeAt)), asks);
  if ('conflict' in p)
    return { ...base, action: 'none', ok: false, reason: `${p.conflict}; decide approve|reject` };
  const b = { ...base, ...(p.note ? { reason: p.note } : {}) };
  if (p.asked) return { ...b, action: 'ask', ok: true, ask: p.asked };
  // yes/no 的执行失败保留原状态，下一次 tick 重试
  if (p.a.status === 'yes') {
    // 等回答期间可能已过截止：过期的“是”不再批准
    if (pastDeadline(l)) return expireRun(l, run, asks, base);
    const log = join(l.gen_dir, `signal-${w.nodeId}.log`);
    const r = signalHuman(run, { decision: 'approve', ask: p.a.id }, log, l.repo);
    if (r.ok) p.a.status = 'approved';
    return { ...b, action: 'approve', ...r };
  }
  if (p.a.status === 'no') {
    const ok = cancelRun(l.archon_run_id, run.status, l.repo);
    if (ok) p.a.status = 'rejected';
    return { ...b, action: 'reject', ok };
  }
  // expired：不替用户决定；事件门到期后 signoff 节点失败，run 停在 failed 等元帅
  return { ...b, action: 'none', ok: true, ask: p.a.status };
}

/** Archon 审批门（非 sa.human.*）的“是”：approve --detach 放行并续跑。 */
function approveRun(l: Ledger): RecoverResult {
  const ack = archonJson(['workflow', 'approve', l.archon_run_id, '--detach'], l.repo);
  return ack.ok === true
    ? { ok: true, resumed: ack }
    : { ok: false, reason: tail(JSON.stringify(ack)) };
}

/**
 * HOLD_POLICY 的 ask 行：同一 (run, hold) 仅投递一次；attempt 不参与。
 * 执行失败保留回答，下一 tick 重试；pending/expired 不动。
 */
function askHold(
  l: Ledger,
  run: RunView,
  c: Classified,
  hold: Hold,
  p: Extract<Policy, { do: 'ask' }>,
  asks: Asks,
  extra: Record<string, unknown>
): Action {
  const key = askKey(l.run_id, hold);
  const base = { run_id: l.run_id, state: c.state, reason: hold, ...extra };
  const r = pollAsk(key, p.text, ttlHours(Date.parse(planOf(l).deadline)), asks);
  if ('conflict' in r)
    return { ...base, action: 'none', ok: false, error: `${r.conflict}; decide retry|reject` };
  const b = { ...base, ...(r.note ? { note: r.note } : {}) };
  if (r.asked) return { ...b, action: 'ask', ok: true, ask: r.asked };
  if (r.a.status === 'yes') {
    const res =
      p.yes === 'approve'
        ? approveRun(l)
        : p.yes === 'resume'
          ? recoverRun(l, true)
          : p.yes === 'review'
            ? retryGate(l, `review-${(c.node ?? '').slice(5)}`, true)
            : retry(
                l,
                c,
                hold === 'budget'
                  ? () => {
                      grantBudget(l, c.node ?? '', key);
                    }
                  : undefined,
                hold === 'budget' ? key : undefined
              );
    if (res.ok) r.a.status = 'approved';
    const out = res.ok
      ? { ok: true }
      : { ok: false, error: res.reason, ...(res.busy ? { busy: true } : {}) };
    return { ...b, action: p.yes, ...out };
  }
  if (r.a.status === 'no') {
    const ok = cancelRun(l.archon_run_id, run.status, l.repo);
    if (ok) r.a.status = 'rejected';
    return { ...b, action: 'reject', ok };
  }
  return { ...b, action: 'none', ok: true, ask: r.a.status };
}

/** 单实例：launchd 与手动调用重叠时，后到者跳过（exit 0），不重复投递或恢复。asks.json 的唯一写者。 */
export function superviseTick(): ReturnType<typeof tick> | { skipped: 'locked' } {
  const { sa } = home();
  mkdirSync(sa, { recursive: true });
  const l = lock(join(sa, 'supervise.lock'));
  if (!l.ok) return { skipped: 'locked' };
  try {
    return tick(sa);
  } finally {
    l.release();
  }
}

/** 逐 run 隔离：坏 ledger、读不出的 asks.json 只让受影响的 run 报 action:error，其余照常处置；asks 读坏时不回写。
 *  没有 ledger 的 run 的 asks 条目随回写丢弃（坏 ledger 仍算有）。 */
function tick(sa: string): { actions: Action[] } & ReturnType<typeof cockpitSignals> {
  archonDetached(['workflow', 'wake', '--json'], join(sa, 'wake.log'));
  let asks: Asks | Error;
  try {
    asks = loadAsks();
  } catch (e) {
    asks = e as Error;
  }
  const observed: HoldSignal[] = [];
  const out: Action[] = reconcileIntents();
  const live = new Set<string>();
  for (const l of ledgers()) {
    live.add(l.run_id);
    try {
      if ('error' in l) throw new Error(l.error);
      const x = dispose(l, asks, observed);
      if (x) out.push(x);
    } catch (e) {
      out.push({
        run_id: l.run_id,
        action: 'error',
        ok: false,
        error: tail((e as Error).message, 200),
      });
    }
  }
  if (!(asks instanceof Error)) {
    // gc.sh 删掉 ledger 后留下的条目在这里丢：asks.json 只有 tick 一个写者
    asks = Object.fromEntries(Object.entries(asks).filter(([k]) => live.has(k.split(':')[0])));
    for (const [key, a] of Object.entries(asks)) {
      if (a?.status !== 'superseded' || a.stale_answer) continue;
      if (!a.id) {
        const records = askRecords().records.filter(r => r.question.startsWith(`superagent ${key} `));
        if (records.length === 1) a.id = records[0].id;
      }
      if (!a.id || Object.values(asks).some(live => live && live.id === a.id && live.status !== 'superseded')) continue;
      try { a.stale_answer = ['yes', 'no'].includes(supervisor(['ask-status', a.id])); }
      catch (e) { out.push({ run_id: 'asks', action: 'error', ok: false, error: tail((e as Error).message, 200) }); }
    }
    saveAsks(asks);
  }
  return { actions: out, ...cockpitSignals(observed, asks instanceof Error ? {} : asks) };
}

/** run → 挂起原因；undefined 不归 tick 管（运行中、终态、非编码节点失败）。签收自己处理截止，其余过了截止即 deadline。 */
function holdOf(l: Ledger, run: RunView, c: Classified): Hold | undefined {
  if (c.state === 'held:engine_suspect') return pastDeadline(l) ? 'deadline' : 'engine_suspect';
  if (c.state === 'held:human') return 'signoff';
  const h: Hold | undefined =
    c.state === 'held:gate'
      ? reasonHold(nodeReason(run, c))
      : c.state === 'held:environment'
        ? 'environment'
        : c.state === 'held:recover_no_progress'
          ? 'recover_no_progress'
          : c.state === 'held:paused'
            ? run.metadata?.approval
              ? 'approval'
              : 'paused'
            : c.state === 'failed' && /^(verify|settle)-/.test(c.node ?? '')
              ? reasonHold(nodeReason(run, c))
              : c.state === 'failed' && /^(code|fix)-/.test(c.node ?? '')
                ? 'coder'
                : undefined;
  return h && pastDeadline(l) ? 'deadline' : h;
}

const nodeReason = (run: RunView, c: Classified): string => {
  const out = readJson(join(artifactsOf(run), `${c.node ?? ''}.json`)) as {
    reason?: unknown;
  } | null;
  return typeof out?.reason === 'string' ? out.reason : '';
};
export const reasonHold = (reason: string): Hold => reasonOf(reason)?.hold ?? 'engine_suspect';

/** 一次明确授权覆盖本里程碑 attempt；后续里程碑恢复原预算。额度基于实际台账，不折算金额。 */
function grantBudget(l: Ledger, node: string, key: string): void {
  const plan = planOf(l),
    m = milestoneOf(l, node);
  const ack = archonJson(['workflow', 'get', l.archon_run_id, '--verbose', '--events'], l.repo) as {
    events?: Parameters<typeof budgetUsage>[0];
  };
  if (!Array.isArray(ack.events)) throw new Error('budget grant: events missing');
  const usage = budgetUsage(ack.events, loadTiers().policy.budget_floor.S);
  const launches = 2 * plan.packages.filter(p => (p.milestone ?? 'm1') === m).length + 5;
  const weighted_tokens = Math.max(plan.budget.weighted_tokens, launches * usage.reserve);
  const attempt = Number(readJson(join(l.gen_dir, 'attempts', m)));
  const grant = { at: new Date().toISOString(), milestone: m, attempt, launches, weighted_tokens };
  writeAtomic(
    join(l.gen_dir, 'budget-extra'),
    JSON.stringify({
      ...grant,
      key,
      limits: {
        launches: Math.max(plan.budget.launches ?? 0, usage.launches) + launches,
        weighted_tokens:
          Math.max(plan.budget.weighted_tokens, usage.weighted_tokens) + weighted_tokens,
      },
    })
  );
  (l.budget_grants ??= []).push(grant);
  saveLedger(l);
}

/** 一个 run 的处置：owner-lost 恢复，其余按 HOLD_POLICY 分派；自动处置转出的挂起原因（用尽、needs…）再查一次表。 */
function dispose(l: Ledger, asks: Asks | Error, observed: HoldSignal[]): Action | undefined {
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  const row: HoldSignal = { run_id: l.run_id, since: run.metadata?.wait?.waitingSince ?? run.completed_at ?? run.last_activity_at ?? l.started_at, disposed: false };
  observed.push(row);
  if (c.state === 'held:engine_suspect') saveIncident(l.run_id, artifactsOf(run), c.node ?? '', planOf(l), { run: l.engine_hash ?? null, current: engineHash() });
  if (c.state === 'owner_lost')
    return record(l, 'owner_lost', { run_id: l.run_id, action: 'recover', ...recoverRun(l) });
  const need = (): Asks => {
    if (asks instanceof Error) throw asks;
    return asks;
  };
  const act = (hold: Hold, extra: Record<string, unknown> = {}): Action | undefined => {
    row.hold = hold;
    row.disposed = l.dispositions?.some(d => d.reason === hold && d.ok && Date.parse(d.at) >= Date.parse(row.since)) ?? false;
    const p: Policy = HOLD_POLICY[hold];
    if (!(asks instanceof Error) && ['ask', 'signoff'].includes(p.do) && !(hold === 'signoff' && pastDeadline(l))) supersedeAsks(asks, l.run_id, hold);
    const x =
      p.do === 'signoff'
        ? human(l, run, need())
        : p.do === 'expire'
          ? expireRun(l, run, asks, {})
          : p.do === 'resume'
            ? pausedHold(l, run, c)
            : p.do === 'ask'
              ? askHold(l, run, c, hold, p, need(), extra)
              : autoRetry(l, run, c);
    if (Array.isArray(x)) return act(...x);
    row.disposed ||= !!x && x.action !== 'none' && x.ok;
    if (!(asks instanceof Error) && !['ask', 'signoff', 'expire'].includes(p.do)) supersedeAsks(asks, l.run_id);
    return x && record(l, hold, x);
  };
  const hold = holdOf(l, run, c);
  if (!hold && !(asks instanceof Error)) supersedeAsks(asks, l.run_id);
  if (hold === 'engine_suspect' && l.engine_hash && l.engine_hash !== engineHash() && run.status === 'failed') return act('gate');
  return hold && act(hold);
}

export interface Disposition {
  at: string;
  reason: string;
  action: string;
  ok: boolean;
  error?: string;
}
const MAX_DISPOSITIONS = 20;

/**
 * 自动处置记入 ledger.dispositions（最近 20 条，board 详情可见）；action none 与撞上 recover 锁（busy，下一轮重读状态）
 * 都不是处置。记不下时动作照常返回并带 record_error。
 */
function record(l: Ledger, reason: string, x: Action): Action {
  if (x.action === 'none' || x.busy === true) return x;
  const error = x.error ?? x.reason ?? '';
  const d: Disposition = {
    at: new Date().toISOString(),
    reason,
    action: x.action,
    ok: x.ok,
    ...(x.ok
      ? {}
      : { error: tail(typeof error === 'string' ? error : JSON.stringify(error), 200) }),
  };
  try {
    updateLedger(l, cur => {
      cur.dispositions = [...(cur.dispositions ?? []), d].slice(-MAX_DISPOSITIONS);
    });
    return x;
  } catch (e) {
    return { ...x, record_error: tail((e as Error).message, 200) };
  }
}

const PAUSE_GRACE_MS = 10 * 60e3;
const MAX_PAUSE_RESUMES = 2;
/** 非签收、非审批的暂停：到期（resumeAt，或 attention 的 waitingSince）+10 分钟仍未被 wake 唤醒才自动 resume，有上限。 */
function pausedHold(l: Ledger, run: RunView, c: Classified): Action | Held | undefined {
  const w = run.metadata?.wait;
  if (Date.now() < Date.parse(w?.resumeAt ?? w?.waitingSince ?? '') + PAUSE_GRACE_MS)
    return undefined;
  const tries = (l.auto_retries ?? []).filter(r => r.reason === 'paused').length;
  if (tries >= MAX_PAUSE_RESUMES) return ['auto_retry_exhausted', { auto_retries: tries }];
  const auto = { milestone: 'paused', at: new Date().toISOString(), reason: 'paused' };
  const r = recoverRun(l, false, auto);
  return {
    run_id: l.run_id,
    action: 'auto_retry',
    state: c.state,
    ...auto,
    attempt: tries + 1,
    ...r,
  };
}

const BACKOFF_S = 120;
const MAX_BACKOFF_S = 1800;
/**
 * held:gate / held:environment / 编码节点失败的自动重试（docs/00「自动重试」）。重试不了时返回挂起原因交 HOLD_POLICY：
 * needs、红线、gate 截止、次数用尽、连续两次修复无变化、旧工作流无 attempt 节点。environment 首次立即重试，
 * 之后按 120s·2^(n-1)（≤30 分钟）退避，未到点返回 none/backoff。gate 重试先给里程碑每个包追加提示。
 */
function autoRetry(l: Ledger, run: RunView, c: Classified): Action | Held {
  const node = c.node ?? '';
  const plan = planOf(l);
  const art = artifactsOf(run);
  let kind: 'gate' | 'environment' | 'coder';
  let m: string;
  let reason: string;
  let gate: (Gate & { milestone?: string }) | undefined;
  if (c.state === 'held:gate') {
    gate = readJson(join(art, `${node}.json`)) as typeof gate;
    [kind, m, reason] = ['gate', gateMilestone(node), `gate:${gate?.reason ?? '?'}`];
  } else if (c.state === 'held:environment') {
    [kind, m, reason] = ['environment', 'environment', 'environment'];
  } else {
    m = milestoneOf(l, node);
    const why = nodeReason(run, c);
    kind = reasonHold(why) === 'environment' ? 'environment' : 'coder';
    reason = `${kind}:${why || node}`;
  }
  const tries = (l.auto_retries ?? []).filter(
    r => r.milestone === m && r.reason.split(':')[0] === kind
  );
  const needs = needsOf(art, m);
  const hold = (h: Hold): Held => [
    h,
    { auto_retries: tries.length, ...(needs.length ? { needs } : {}) },
  ];
  if (needs.length) return hold('needs');
  if (codersOf(art, m).some(x => x.error_class === 'redline')) return hold('redline');
  const cause = reasonOf(c.state === 'held:engine_suspect' ? 'engine_suspect' : nodeReason(run, c) || kind);
  if (!cause) return hold('engine_suspect');
  if (cause.hold === 'deadline') return hold('deadline');
  if (cause.hold === 'no_change') return hold('no_change');
  if (cause.determinism === 'deterministic' && (!l.engine_hash || l.engine_hash === engineHash())) return hold('auto_retry_exhausted');
  if (cause.determinism === 'deterministic' && l.auto_retries?.some(r => r.engine_hash === engineHash())) return hold('auto_retry_exhausted');
  if (cause.determinism === 'deterministic' && !['failed', 'cancelled'].includes(run.status)) return hold('auto_retry_exhausted');
  if (cause.determinism !== 'deterministic' && tries.length >= loadTiers().policy.auto_retry[kind]) return hold('auto_retry_exhausted');
  const pkgHold = /^(verify|settle)-/.test(node);
  if ((kind === 'gate' || pkgHold) && !attemptable(l, m)) return hold('no_attempt_node');
  const last = tries.at(-1);
  if (kind === 'environment' && last) {
    const wait = Math.min(MAX_BACKOFF_S, BACKOFF_S * 2 ** (tries.length - 1)) * 1000;
    const next = Date.parse(last.at) + wait;
    if (Date.now() < next)
      return {
        run_id: l.run_id,
        action: 'none',
        ok: true,
        state: c.state,
        reason: 'backoff',
        next: new Date(next).toISOString(),
      };
  }
  const auto = { milestone: m, at: new Date().toISOString(), reason, engine_hash: engineHash(), ...(cause.determinism === 'deterministic' ? { deterministic: true as const } : {}) };
  let r: RecoverResult;
  if (kind === 'gate') {
    const text = gateHint(plan, art, node, gate, tries.length + 1);
    for (const p of plan.packages.filter(x => (x.milestone ?? 'm1') === m))
      appendFileSync(join(l.gen_dir, 'hints', `${p.id}.md`), text);
    r = retryGate(l, node, false, auto);
  } else if (pkgHold) {
    const out = readJson(join(art, `${node}.json`)) as { log?: string } | null;
    const log =
      out?.log && existsSync(out.log)
        ? readFileSync(out.log, 'utf8').split('\n').slice(-60).join('\n')
        : '';
    for (const p of plan.packages.filter(x => (x.milestone ?? 'm1') === m))
      appendFileSync(
        join(l.gen_dir, 'hints', `${p.id}.md`),
        `\n## 自动重试 ${String(tries.length + 1)}：${node}\nreason：${reason}\n${redact(log)}\n`
      );
    r = retryGate(l, node, false, auto);
  } else r = recoverRun(l, false, auto);
  return {
    run_id: l.run_id,
    action: 'auto_retry',
    state: c.state,
    ...auto,
    attempt: tries.length + 1,
    ...r,
  };
}

/** 追加到 hints/<包>.md 的提示：失败的验收命令与日志尾、基线预存说明、未关闭的阻塞发现、gate 原因。 */
function gateHint(plan: Plan, art: string, node: string, g: Gate | undefined, n: number): string {
  const m = gateMilestone(node);
  const acc = readJson(join(art, `${node.replace(/^gate-/, 'diff-')}.json`)) as
    | { failed?: string[]; base_pass?: boolean | null; log?: string }
    | undefined;
  const out = [`\n## 自动重试 ${String(n)}：${node} escalate（${g?.reason ?? '?'}）\n`];
  if (acc?.failed?.length) {
    out.push('失败的验收命令：', ...acc.failed.map(x => `- \`${x}\``), '');
    if (acc.base_pass === false)
      out.push('此失败在基线已存在，不是你引入的，与本包无关就记 deviations 并继续。', '');
    const log = acc.log && existsSync(acc.log) ? readFileSync(acc.log, 'utf8').trimEnd() : '';
    if (log) out.push('验收日志尾：', '```', ...log.split('\n').slice(-60), '```', '');
  }
  const rounds = gatesOf(art)
    .filter(f => gateMilestone(f.slice(0, -5)) === m && f.slice(0, -5) <= node)
    .map(f => readJson(join(art, f.replace(/\.json$/, '.review.json'))) as Review | null)
    .filter((r): r is Review => r != null);
  const risk = milestones(plan).find(x => x.id === m)?.risk ?? 'G1';
  const open = openBlocking(rounds, risk);
  const last = new Map(rounds.flatMap(r => r.findings).map(f => [f.id, f]));
  const findings = [...open].flatMap(id => {
    const f = last.get(id);
    return f
      ? [`- ${id} [${f.severity}] ${f.file}:${String(f.line)} ${tail(f.evidence, 200)}`]
      : [];
  });
  if (findings.length) out.push('未关闭的阻塞发现：', ...findings, '');
  out.push(`gate reason：${g?.reason ?? '?'}`, '');
  return out.join('\n');
}

type Count = Partial<Record<string, number>>;
const bump = (o: Count, k: string, n = 1): void => {
  o[k] = (o[k] ?? 0) + n;
};

/** 一个 run 的 ledger 与 `workflow get` 结果；查询失败时 run 是那次的错误。 */
export interface Pair {
  ledger: Ledger;
  run: RunView | Error;
}

/** 计数（token 用量后置）：state:*、各里程碑末轮 rounds:*、first_pass（首轮即 pass 的里程碑）、failed:<节点 id 前缀>、
 *  escalate:<原因>、node_s:<前缀>（累计秒）、debt（末轮评审债条数）、recoveries。读不到的 run 单列，不吞错。report 与 board 共用。 */
export function summarize(pairs: Pair[]): Record<string, unknown> {
  const n: Count = {};
  const unreadable: string[] = [];
  for (const { ledger: l, run } of pairs) {
    bump(n, 'recoveries', l.recoveries.length);
    try {
      if (run instanceof Error) throw run;
      const c = classifyRun(l, run);
      bump(n, `state:${c.state}`);
      for (const x of run.nodes ?? [])
        bump(n, `node_s:${x.nodeId.split('-')[0]}`, Math.round((x.durationMs ?? 0) / 1e3));
      if (run.status === 'failed' && !c.node?.startsWith('gate-'))
        bump(n, `failed:${c.node?.split('-')[0] ?? '?'}`);
      const last = new Map<string, Gate & { round: string }>();
      for (const f of gatesOf(artifactsOf(run))) {
        const [, m, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
        last.set(m, { ...(readJson(join(artifactsOf(run), f)) as Gate), round });
        if (round === '1' && last.get(m)?.verdict === 'pass') bump(n, 'first_pass');
      }
      for (const g of last.values()) {
        bump(n, `rounds:${g.round}`);
        bump(n, 'debt', g.debt.length);
        if (g.verdict === 'escalate') bump(n, `escalate:${g.reason ?? '?'}`);
      }
    } catch (e) {
      unreadable.push(`${l.run_id}: ${tail((e as Error).message, 200)}`);
    }
  }
  return { runs: pairs.length, ...Object.fromEntries(Object.entries(n).sort()), unreadable };
}

/** 全部登记 run 的计数摘要与用量台账（F-22，见 report.ts）。 */
export function report(): Record<string, unknown> {
  // F-02：坏 ledger 不进报表计算，单列在 unreadable，其余照常。
  const all = ledgers();
  const r = buildReport(all.flatMap(l => ('error' in l ? [] : [l])));
  const bad = all.flatMap(l => ('error' in l ? [`${l.run_id}: ${l.error}`] : []));
  return { ...r, runs: all.length, unreadable: [...(r.unreadable as string[]), ...bad] };
}

const USAGE =
  'usage: superagent <run <plan.json> [--fake] [--skip-selftest]|wait <run> [--timeout s]|status|brief|land|resume|cancel|recover <run>|decide <run> approve|reject|retry [--pkg id --hint text]|decide --all-held retry|accept <run> [--pkg id]|report|usage [--since YYYYMMDD] [--refresh]|web serve|start|stop|status|url [--open]|supervise-tick|health [--cwd repo]|board [run] [--once] [--interval s] [--limit n]|job exec --title t [--card p] [--log p] [--role r] -- cmd...|jobs [--all]> (every verb accepts --json)';

export function main(argv: string[]): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [verb, target] = a._;
  const ledger = (): Ledger => loadLedger(need(target, `${verb} <run>`));
  switch (verb) {
    case 'run':
      return startRun(need(target, 'run <plan.json>'), a);
    case 'wait': {
      const t = Number(a.flags.timeout ?? 3000);
      if (!Number.isFinite(t) || t <= 0) {
        console.error(`--timeout must be a positive number of seconds\n${USAGE}`);
        return EXIT_USAGE;
      }
      const s = waitRun(ledger(), t);
      print(s);
      return Number(s.exit);
    }
    case 'status': {
      const l = ledger();
      const run = getRun(l.archon_run_id, l.repo);
      const c = classifyRun(l, run);
      print(summary(l, run, c));
      return c.exit;
    }
    case 'resume':
    case 'recover': {
      const id = need(target, `${verb} <run>`);
      if (!existsSync(ledgerPath(id))) {
        const res = recover(id); // 未登记：按 archon run id 处理（selftest 用）
        print({ run_id: id, ...res });
        return res.ok ? 0 : 1;
      }
      return resumeRun(loadLedger(id));
    }
    case 'cancel': {
      const id = need(target, `${verb} <run>`);
      // 未登记：按 archon run id 处理（selftest 用）
      const l = existsSync(ledgerPath(id)) ? loadLedger(id) : undefined;
      const rid = l?.archon_run_id ?? id;
      const ok = cancelRun(rid, getRun(rid, l?.repo).status, l?.repo);
      print({ run_id: id, ok });
      return ok ? 0 : 1;
    }
    case 'decide':
      if (a.flags['all-held']) {
        if (target !== 'retry') throw new Error('usage: superagent decide --all-held retry');
        return retryAllHeld();
      }
      return decide(ledger(), a);
    case 'brief':
      return brief(ledger());
    case 'land': {
      const l = ledger();
      const run = getRun(l.archon_run_id, l.repo);
      const land = readJson(join(artifactsOf(run), 'land.json'));
      if (land === undefined) {
        console.error(`land: no land.json yet (state ${classify(run).state})`);
        return 1;
      }
      print(land);
      return 0;
    }
    case 'accept':
      return acceptRun(ledger(), a.flags.pkg);
    case 'supervise-tick': {
      const actions = superviseTick();
      print(actions);
      if (!('actions' in actions)) return 0;
      return actions.actions.some(x => !x.ok && x.busy !== true) ? 1 : 0;
    }
    case 'report': {
      const r = report();
      const full = readUsage();
      print({ ...r, full_usage: { label: '全量（ccusage）', ...usageSummary(full) } });
      const usage = r.usage as { unreadable: string[] };
      return (r.unreadable as string[]).length || usage.unreadable.length ? 1 : 0;
    }
    case 'health':
      return health(a.flags.cwd);
    case 'board':
    case 'job':
    case 'jobs':
      console.error(`${verb} is async: run it through bin/superagent`);
      return EXIT_USAGE;
    default:
      console.error(USAGE);
      return EXIT_USAGE;
  }
}

function need<T>(v: T | undefined, usage: string): T {
  if (v === undefined) throw new Error(`usage: superagent ${usage}`);
  return v;
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    // board（带 ink/react 依赖）与 job/jobs 是异步动词：在这里分流，其余动词启动时不加载 React。
    // 参数非法时 verb 取不到，交给 main 报用法
    const verb = ((): string | undefined => {
      try {
        return parseArgs(argv)._[0];
      } catch {
        return undefined;
      }
    })();
    if (verb === 'board') process.exit(await (await import('./board/index')).board(argv));
    if (verb === 'usage') process.exit(await usageCli(argv));
    if (verb === 'web') process.exit(await (await import('./web/server')).webCli(argv));
    if (verb === 'job' || verb === 'jobs')
      process.exit(await (await import('./jobs')).jobCli(argv));
    process.exit(main(argv));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}
