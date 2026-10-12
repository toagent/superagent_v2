// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import { installMode } from './install-mode';
import { confined, workflowRoles } from './board/workflow';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import { saveIncident } from './incidents';
import { lintPlan, memoryData, memoryTick } from './memory';
import {
  askKey,
  cockpitSignals,
  supersedeAsks,
  type HoldSignal,
  type Ask as BaseAsk,
} from './cockpit-signals';
import { launcher, type Launcher } from './launcher';
import { ownershipUnknown, recoveryAdmissionUnknown } from './recovery';
import { caller, cleanEngine, control, coord, repoScope, runScope, type Controller } from './coord';
import { COORD_OPTIONS, coordinationCommand } from './coord/commands';
import { askQuestion, askName, HOLD_POLICY, reasonOf, type Hold, type Policy } from './reasons';
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
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs as parse } from 'node:util';
import {
  archon,
  archonDetached,
  archonJson,
  admitRun,
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
  budgetUsage,
  effectiveBudget,
  readAttempt,
  attemptPath,
  type DeliveryDecision,
  type Ledger as ReviewLedger,
  type Accept,
  type decide as decideGate,
} from '../templates/.archon/scripts/sa-check';
import {
  WETAMP,
  budgetState,
  aliasDrift,
  codexWorkerProblem,
  home,
  loadTiers,
  resolveRoute,
  receiptIssue,
  runAliases,
  runCapacity,
  writeAtomic,
  type Receipt,
} from './config';
import { engineHash, generate, newRunId } from './generate';
import { loadPlan, type Plan } from './plan';
import { redact } from './redact';
import { buildReport } from './report';
import { jobCli } from './jobs';
import { ROUTE_ROLE, TIERS } from './roles';
import { gc, scratchClean, type GcAction, type ScratchAction } from './gc';
import { readUsage, usageSummary, usageCli } from './usage';
import { relayQuota } from './relay-quota';

const inheritedTmp = process.env.TMPDIR && resolve(process.env.TMPDIR);
if (
  inheritedTmp &&
  ['/tmp/sa-scratch', '/private/tmp/sa-scratch'].some(
    root => inheritedTmp === root || inheritedTmp.startsWith(root + '/')
  )
)
  delete process.env.TMPDIR;

const OPTIONS = {
  ...COORD_OPTIONS,
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  'skip-selftest': { type: 'boolean' },
  'lint-override': { type: 'string' },
  goal: { type: 'string' },
  accept: { type: 'string', multiple: true },
  scope: { type: 'string', multiple: true },
  risk: { type: 'string' },
  review: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  base: { type: 'string' },
  worktree: { type: 'string' },
  mode: { type: 'string' },
  repo: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
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
  reconciled: { type: 'string' }, // explicit external-effect reconciliation, bound to a run snapshot
  session: { type: 'string' },
  'dry-run': { type: 'boolean' },
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
/** Temporary refusal: no run was created; the caller may retry after capacity is available. */
export const EXIT_ADMISSION = 75;
export const EXIT_USAGE = 64;

export interface Ledger {
  rejected?: string;
  gc?: GcAction[];
  plan_lint?: ReturnType<typeof lintPlan>;
  /** Explicit workflow identity; engine_hash alone may be the legacy combined UI hash. */
  workflow_hash?: string;
  engine_hash?: string;
  adoptions?: {
    at: string;
    from: string;
    to: string;
    engine_from: string | null;
    engine_to: string;
    reason: string;
    engine_commit?: string;
    carried?: string[];
  }[];
  launcher?: Launcher;
  controller?: Controller;
  run_id: string;
  archon_run_id: string;
  plan: string;
  gen_dir: string;
  repo: string;
  branch: string;
  launch_branch?: string;
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
  intervened?: boolean;
  /** Append-only explicit decisions; absent on historical runs with unknown coverage. */
  intervention_events?: (Pick<Disposition, 'at' | 'action' | 'ok' | 'error'> & {
    source: 'superagent' | 'cli' | 'commander';
    ask_id?: string;
    key?: string;
  })[];
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
export function updateLedger(l: Ledger, f: (cur: Ledger) => void): void {
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

function intervention<
  T extends number | boolean | { ok: boolean; busy?: boolean; refused?: boolean },
>(
  l: Ledger,
  action: string,
  execute: () => T,
  ask?: { key: string; id?: string },
  started: () => boolean = () => true
): T {
  let ok = false;
  let skipped = false;
  let error = 'action_failed';
  try {
    const result = execute();
    skipped = typeof result === 'object' && (result.busy === true || result.refused === true);
    ok =
      typeof result === 'number' ? result === 0 : typeof result === 'boolean' ? result : result.ok;
    if (typeof result === 'number') error = `exit:${String(result)}`;
    return result;
  } catch (e) {
    error = e instanceof Error ? e.name : 'thrown'; // Never persist command output or message contents.
    throw e;
  } finally {
    if (!skipped && started())
      updateLedger(l, cur => {
        if (ask && cur.intervention_events?.some(e => e.key === ask.key)) return;
        (cur.intervention_events ??= []).push({
          at: new Date().toISOString(),
          action,
          source: ask ? 'superagent' : caller(true).client === 'shell' ? 'cli' : 'commander',
          ...(ask ? { key: ask.key, ask_id: ask.id } : {}),
          ok,
          ...(!ok ? { error } : {}),
        });
      });
  }
}

const answerAction = <T extends { ok: boolean }>(
  l: Ledger,
  key: string,
  a: Ask,
  execute: () => T
): T =>
  a.status === 'yes' || a.status === 'no'
    ? intervention(l, 'answer', execute, { key, id: a.id })
    : execute();

export interface Classified {
  state: string;
  exit: number;
  node?: string;
  event?: string;
}

/** archon run 状态 → superagent 状态。gate/environment 失败是“待决策”而非终局失败：decide retry 可 resume。 */
export function classify(run: RunView): Classified {
  if (!['completed', 'cancelled'].includes(run.status) && recoveryAdmissionUnknown(run))
    return { state: 'held:recovery_admission_unknown', exit: EXIT.held };
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
      // A pending row is Archon's detached launch before its child claims it: no execution owner
      // exists yet, so that absence is not ambiguity. Report pending and keep waiting; only
      // recovery must refuse to act on it.
      if (run.status === 'running' && ownershipUnknown(run))
        return { state: 'held:owner_unknown', exit: EXIT.held };
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
export const evidenceJson = (l: Ledger, art: string, file: string): unknown => {
  const path = confined(l, join(art, file));
  return path ? readJson(path) : undefined;
};
export const evidenceGates = (l: Ledger, art: string): string[] => {
  const path = confined(l, art);
  return path ? gatesOf(path).filter(f => confined(l, join(path, f))) : [];
};
/** Old artifacts have unknown delivery coverage; never reconstruct a decision from self-report. */
export const decisionOf = (value: unknown): DeliveryDecision | undefined => {
  const d = (value as { decision?: DeliveryDecision } | null)?.decision;
  return d &&
    ['advance', 'debt', 'repair', 'block'].includes(d.kind) &&
    (d.reason === null || typeof d.reason === 'string') &&
    Array.isArray(d.evidence) &&
    d.evidence.every(e => typeof e === 'string') &&
    Array.isArray(d.debt) &&
    d.debt.every(e => typeof e === 'string')
    ? d
    : undefined;
};
export const decisionVerdict = (d: DeliveryDecision | undefined): string =>
  d ? (d.kind === 'block' ? 'escalate' : d.kind === 'repair' ? 'fix' : 'pass') : 'unknown';
export const decisionsOf = (art: string, m?: string, l?: Ledger) =>
  (existsSync(art)
    ? readdirSync(art).filter(
        f =>
          f.endsWith('.json') &&
          ['verify-', 'settle-', 'diff-', 'gate-'].some(prefix => f.startsWith(prefix)) &&
          !['.coder.json', '.review.json', '.ledger.json'].some(suffix => f.endsWith(suffix))
      )
    : []
  )
    .sort()
    .map(file => {
      const out = (l ? evidenceJson(l, art, file) : readJson(join(art, file))) as
        | { milestone?: string }
        | undefined;
      return { tag: file.slice(0, -5), milestone: out?.milestone, decision: decisionOf(out) };
    })
    .filter(d => m === undefined || d.milestone === m);
export const needsOf = (art: string, m?: string, l?: Ledger): Record<string, string>[] =>
  decisionsOf(art, m, l)
    .filter(
      (d, _, all) =>
        !all.some(
          other =>
            other !== d &&
            ((d.tag.startsWith('verify-') && other.tag === d.tag.replace('verify-', 'settle-')) ||
              (d.milestone &&
                other.milestone === d.milestone &&
                (other.tag.startsWith('gate-') || other.tag.startsWith('diff-')) &&
                ((!d.tag.startsWith('gate-') && !d.tag.startsWith('diff-')) ||
                  Number(other.tag.slice(other.tag.lastIndexOf('-r') + 2)) >
                    Number(d.tag.slice(d.tag.lastIndexOf('-r') + 2)) ||
                  (other.tag.startsWith('gate-') &&
                    d.tag === other.tag.replace('gate-', 'diff-')))))
        )
    )
    .flatMap(({ tag, decision }) =>
      decision?.kind === 'block' && decision.reason === 'coder_redline'
        ? [
            {
              tag,
              cap: 'permission',
              why: decision.evidence.join(', '),
              minimal_ask: '检查记录的权限拒绝事件并明确授权或调整任务范围。',
            },
          ]
        : []
    );

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
  confined(l, art);
  const needs = needsOf(art, undefined, l);
  return {
    run_id: l.run_id,
    engine:
      workflowIdentity(l) === engineHash()
        ? 'current'
        : `stale(${workflowIdentity(l)?.slice(0, 8) ?? 'unknown'})`,
    adoption: l.adoptions?.at(-1) ?? null,
    state: c.state,
    exit: c.exit,
    nodes: `${String(nodes.filter(n => n.state === 'completed').length)}/${String(nodes.length)} completed`,
    ...(c.node ? { node: c.node } : {}),
    ...(c.event ? { event: c.event } : {}),
    ...(c.node?.startsWith('gate-')
      ? {
          gate: {
            decision: decisionOf(evidenceJson(l, art, `${c.node}.json`)) ?? 'unknown',
          },
        }
      : {}),
    ...(c.state === 'failed' ? failure(l, run, c.node) : {}),
    ...(c.state === 'completed'
      ? {
          land: (evidenceJson(l, art, 'land.json') as { commands?: string[] } | undefined)
            ?.commands,
        }
      : {}),
    evidence: art,
    delivery: decisionsOf(art, undefined, l).map(d => ({
      tag: d.tag,
      decision: d.decision ?? 'unknown',
    })),
    ...(c.state === 'held:owner_unknown' || c.state === 'held:recovery_admission_unknown'
      ? {
          action: `Inspect archon workflow get ${run.id} --verbose and its owner; resolve or abandon explicitly.`,
        }
      : {}),
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
const workflowIdentity = (l: Ledger): string | undefined => l.workflow_hash ?? l.engine_hash;
const adoptsRun = (l: Ledger, run: RunView): boolean =>
  ['failed', 'cancelled'].includes(run.status) && workflowIdentity(l) !== engineHash();

/** classify + ledger：同一完成节点集合上已 recover 满 3 次的 owner-lost run 不再自动恢复，等元帅。 */
export function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
  if ((run.status === 'failed' || run.status === 'paused') && c.node) {
    const decision = decisionOf(evidenceJson(l, artifactsOf(run), `${c.node}.json`));
    if (
      /^(verify|settle|gate)-/.test(c.node) &&
      (!decision || decision.kind === 'advance' || decision.kind === 'debt')
    )
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
  prepare?: () => void,
  onEffect?: (effect: DecisionEffect) => void,
  reconciled?: string
): RecoverResult {
  let fp = '';
  let adopted:
    | { from: string; hash: string; engine_from: string | null; commit: string; carried: string[] }
    | undefined;
  return recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (run.status === 'completed') return 'status completed is not resumable';
      if (auto?.deterministic) {
        if (
          workflowIdentity(l) === engineHash() ||
          l.auto_retries?.some(r => r.engine_hash === auto.engine_hash)
        )
          return 'deterministic retry already used for this engine';
        if (!['failed', 'cancelled'].includes(run.status))
          return 'deterministic retry requires terminal adopt';
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
          engine_commit: adopted.commit,
          carried: adopted.carried,
        });
        l.archon_run_id = to;
        l.engine_hash = adopted.hash;
        l.workflow_hash = adopted.hash;
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
      onEffect?.({ action: adopted ? 'adopt' : 'resume', engine_run: l.archon_run_id });
    },
    prepare,
    {
      lockId: l.adoptions?.[0]?.from ?? l.archon_run_id,
      operatorId: l.run_id,
      resolveId: () => {
        Object.assign(l, loadLedger(l.run_id));
        return l.archon_run_id;
      },
      adopt: run => {
        // Live and paused owners retain their snapshot; terminal recovery may change source.
        if (!adoptsRun(l, run)) return undefined;
        const commit = cleanEngine();
        const metadata = readJson(join(l.gen_dir, 'engine.json')) as { fake?: boolean } | null;
        const plan = planOf(l);
        const carried = plan.packages
          .filter(p => {
            if (!run.working_path || !run.output_root) return false;
            try {
              const art = artifactsOf(run);
              const file = existsSync(join(art, `settle-${p.id}.json`))
                ? `settle-${p.id}.json`
                : `verify-${p.id}.json`;
              const evidence = evidenceJson(l, art, file) as
                | { disposition?: unknown; head?: unknown }
                | undefined;
              return (
                ['advance', 'debt'].includes(decisionOf(evidence)?.kind ?? '') &&
                typeof evidence?.head === 'string' &&
                Bun.spawnSync(['git', 'merge-base', '--is-ancestor', '--', evidence.head, 'HEAD'], {
                  cwd: run.working_path,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  timeout: QUERY_TIMEOUT_MS,
                }).exitCode === 0
              );
            } catch {
              // Missing, invalid or inaccessible acceptance evidence never skips coding.
              return false;
            }
          })
          .map(p => p.id);
        const gen = generate(plan, l.run_id, metadata?.fake ?? false, l.engine_hash ?? 'unknown', {
          from: run.id,
          packages: carried,
        });
        if (cleanEngine() !== commit)
          throw new Error('换版拒绝：引擎提交在生成期间变化，请重新 retry');
        adopted = {
          from: run.id,
          hash: gen.engine_hash,
          engine_from: l.engine_hash ?? null,
          commit,
          carried,
        };
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
    },
    reconciled
  );
}

/** 每秒重查 inbox 和事件门；可证实 owner-lost 时校验归属后恢复。 */
export function waitRun(l: Ledger, timeoutS: number): Record<string, unknown> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const inbox = coord().surfaced(caller(true));
    if (inbox.length) return { run_id: l.run_id, state: 'inbox', exit: EXIT.held, inbox };
    const run = getRun(l.archon_run_id, l.repo);
    const c = classifyRun(l, run);
    if (c.state === 'owner_lost') {
      let r: RecoverResult;
      try {
        r = control(l, () => recoverRun(l));
      } catch (e) {
        return { ...summary(l, run, c), reason: (e as Error).message };
      }
      if (r.ok) continue;
      // 另一进程正在恢复：稍候重读状态；到期仍是 owner_lost 则按运行中返回（exit 4），不报失败
      if (r.busy) {
        if (Date.now() >= deadline) return { ...summary(l, run, c), reason: r.reason };
        Bun.sleepSync(1000);
        continue;
      }
      const held = r.held ?? r.reason === 'recover_no_progress';
      return {
        ...summary(
          l,
          run,
          held ? { state: `held:${r.reason}`, exit: EXIT.held } : { ...c, exit: EXIT.failed }
        ),
        reason: r.reason,
        ...(r.held ? { action: r.action, snapshot: r.snapshot, nodes: r.nodes } : {}),
      };
    }
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (c.exit !== EXIT.running || left <= 0) return summary(l, run, c);
    archon(
      ['workflow', 'wait', l.archon_run_id, '--json', '--timeout', String(Math.min(1, left))],
      l.repo
    );
  }
}

const MIN_FREE_GB = 2;
const SELFTEST_TIMEOUT_MS = 20 * 60_000;

const QUICK_BUDGET_MULTIPLIER = 4;

/** Materialize and validate the ordinary plan contract before using the run launcher. */
export function quickPlan(a: Args): string {
  const goal = a.flags.goal;
  if (!goal?.trim()) throw new Error('quick requires --goal <text>');
  if (!a.flags.accept?.length || a.flags.accept.some(cmd => !cmd.trim()))
    throw new Error('quick requires at least one non-empty --accept <cmd>');
  const risk = a.flags.risk ?? 'G1';
  if (risk !== 'G0' && risk !== 'G1' && risk !== 'G2')
    throw new Error('quick --risk must be G0|G1|G2');
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd: a.flags.repo ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: QUERY_TIMEOUT_MS,
    });
    if (p.exitCode !== 0) throw new Error(`quick git ${args[0]}: ${tail(p.stderr.toString())}`);
    return p.stdout.toString().trim();
  };
  const size = 'S';
  const plan: Plan = {
    repo: git('rev-parse', '--show-toplevel'),
    base_ref: a.flags.base ?? git('symbolic-ref', '--short', 'HEAD'),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    budget: { weighted_tokens: loadTiers().policy.budget_floor[size] * QUICK_BUDGET_MULTIPLIER },
    packages: [
      {
        id: 'quick',
        title: goal,
        goal,
        size,
        risk,
        milestone: 'm1',
        scope: { write: a.flags.scope ?? ['**/*'] },
        accept: a.flags.accept.map(cmd => ({
          cmd,
          timeout_s: 180,
          ...(a.flags['no-cache'] ? {} : { cache: true }),
        })),
        ...(a.flags.review ? { review: true } : {}),
      },
    ],
  };
  const path = join(home().sa, 'plans', `quick-${newRunId()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(plan, null, 2) + '\n');
  loadPlan(path);
  return path;
}

function preflight(skipSelftest: boolean): void {
  if (installMode() === 'worker')
    throw new Error('preflight: mode=worker; run requires the controller install');
  const { sa } = home();
  const fs = statfsSync(sa);
  if ((fs.bavail * fs.bsize) / 2 ** 30 < MIN_FREE_GB)
    throw new Error(`preflight: < ${String(MIN_FREE_GB)}GB free under ${sa}`);
  if (skipSelftest) return;
  const issue = () =>
    receiptIssue(readJson(join(sa, 'selftest.json')) as Partial<Receipt> | undefined);
  let why = issue();
  if (why && why.kind !== 'invalid') {
    const lease = lock(join(sa, 'selftest.lock'));
    if (!lease.ok) throw new Error('preflight: selftest 正在运行，稍后重试');
    try {
      why = issue();
      if (why && why.kind !== 'invalid') {
        console.error(`preflight: ${why.kind}; running real selftest synchronously`);
        let bin = join(WETAMP, 'scripts/selftest.sh');
        if (process.env.NODE_ENV === 'test') bin = process.env.SA_SELFTEST_BIN ?? bin;
        const timeout =
          (process.env.NODE_ENV === 'test' && Number(process.env.SA_SELFTEST_TIMEOUT_MS)) ||
          SELFTEST_TIMEOUT_MS;
        // The supervisor stays outside the child's group so it can kill descendants and reap bash.
        const supervisor = `use Time::HiRes qw(alarm); my $ms = shift; my $pid = fork // die "fork: $!";
          if (!$pid) { setpgrp(0, 0) or die "setpgrp: $!"; exec "bash", @ARGV; die "exec: $!"; }
          $SIG{ALRM} = sub { kill 'KILL', -$pid; waitpid($pid, 0); exit 124; };
          alarm($ms / 1000); waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8);`;
        const p = Bun.spawnSync(['perl', '-e', supervisor, String(timeout), bin], {
          env: process.env,
          timeout: timeout + 1000,
          killSignal: 'SIGKILL',
        });
        const log = redact(p.stdout.toString() + p.stderr.toString());
        if (p.exitedDueToTimeout || p.exitCode !== 0)
          why.message += `; selftest ${p.exitedDueToTimeout || p.exitCode === 124 ? 'timed out' : `exit ${String(p.exitCode)}`}; log tail:\n${log.split('\n').slice(-20).join('\n')}`;
        else why = issue();
      }
    } finally {
      lease.release();
    }
  }
  if (why)
    throw new Error(
      `preflight: no valid selftest receipt: ${why.message}; fix: wetamp/scripts/selftest.sh (real, not --fake)`
    );
}

function startRun(planPath: string, a: Args): number {
  const run = newRunId();
  let phase: 'preflight' | 'admission' | 'engine' = 'preflight';
  let release: (() => void) | undefined;
  let mode: 'controller' | 'worker' | 'unknown' = 'unknown';
  let plan_lint: ReturnType<typeof lintPlan> | undefined;
  try {
    mode = installMode();
    preflight(a.flags['skip-selftest'] ?? false);
    const plan = loadPlan(planPath);
    const scope = repoScope(plan.repo);
    return coord().scoped(scope, () => {
      const who = caller();
      const controller = coord().claim(scope, who).controller;
      return coord().mutate(scope, who, () => {
        plan_lint = lintPlan(plan, a.flags['lint-override']);
        if (plan_lint.rejected)
          throw new Error(`preflight: plan lint: ${plan_lint.warnings.join('; ')}`);
        phase = 'admission';
        const admission = admitRun(runCapacity());
        if (!admission.ok) {
          print({
            ok: false,
            phase,
            status: 'rejected',
            exit: EXIT_ADMISSION,
            reason: admission.reason,
            capacity: admission.capacity,
            active: admission.active,
          });
          return EXIT_ADMISSION;
        }
        release = admission.release;
        phase = 'preflight';
        const checked = Bun.spawnSync(
          [process.execPath, join(WETAMP, 'src/preflight.ts'), plan.repo],
          {
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: QUERY_TIMEOUT_MS,
          }
        );
        if (checked.exitCode !== 0) {
          const reason = lastJson(checked.stdout.toString())?.reason;
          throw new Error(
            typeof reason === 'string' ? reason : 'preflight: base branch inspection failed'
          );
        }
        const drift = aliasDrift(plan.repo);
        if (drift.length) {
          const failure = {
            run_id: run,
            ok: false,
            phase,
            reason: 'alias_drift',
            drift,
            fix: 'wetamp/scripts/install.sh',
          };
          mkdirSync(join(home().sa, 'launch-failures'), { recursive: true });
          writeAtomic(
            join(home().sa, 'launch-failures', `${run}.json`),
            JSON.stringify(failure) + '\n'
          );
          print(failure);
          return EXIT_ALIAS_DRIFT;
        }
        const launchBranch = lastJson(checked.stdout.toString())?.launch_branch;
        phase = 'engine';
        const budget = budgetState(loadTiers(), plan.mode);
        const gen = generate(plan, run, a.flags.fake ?? false);
        const branch = `sa/${run}`;
        const args = [
          'workflow',
          'run',
          gen.workflow,
          '--workflow-source',
          gen.dir,
          '--cwd',
          plan.repo,
        ];
        args.push('--branch', branch, '--from', plan.base_ref, '--detach', '--config', gen.config);
        const l: Ledger = {
          plan_lint,
          run_id: run,
          engine_hash: gen.engine_hash,
          workflow_hash: gen.engine_hash,
          archon_run_id: '',
          plan: planPath,
          gen_dir: gen.dir,
          repo: plan.repo,
          branch,
          launch_branch: typeof launchBranch === 'string' ? launchBranch : undefined,
          workflow: gen.workflow,
          console: plan.console ?? 'claude',
          started_at: new Date().toISOString(),
          transcript: '',
          log: '',
          recoveries: [],
          intervention_events: [],
          launcher: launcher(home().sa),
          controller,
        };
        // 先落启动意图再启动：进程死在 archon 建 run 与写 ledger 之间时，tick 按工作流名对账（reconcileIntents）
        const intent: Intent = { ledger: l, host: hostname(), pid: process.pid };
        mkdirSync(join(home().sa, 'intents'), { recursive: true });
        writeAtomic(intentPath(run), JSON.stringify(intent, null, 2) + '\n');
        const ack = admission.launch(args, plan.repo);
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
        const quota = relayQuota(gen.dir, 'start');
        if (budget.degraded) quota.quota = [quota.quota, budget.notice].filter(Boolean).join(' · ');
        print({
          run_id: run,
          archon_run_id: l.archon_run_id,
          branch,
          gen_dir: gen.dir,
          mode: 'controller',
          plan_lint,
          ...quota,
        });
        return 0;
      });
    });
  } catch (e) {
    const failure = {
      run_id: run,
      ok: false,
      phase,
      mode,
      plan_lint,
      reason: redact((e as Error).message),
    };
    mkdirSync(join(home().sa, 'launch-failures'), { recursive: true });
    writeAtomic(join(home().sa, 'launch-failures', `${run}.json`), JSON.stringify(failure) + '\n');
    print(failure);
    return 1;
  } finally {
    release?.();
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
  const mode = installMode();
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
    mode,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
    codex_worker: worker ?? 'ok',
  });
  return ok ? 0 : drift.length ? EXIT_ALIAS_DRIFT : 1;
}

function resumeRun(l: Ledger, fresh = false, reconciled?: string, action = 'recover'): number {
  let started = false;
  // prepare runs under the recovery lock only after admission checks have passed.
  const res = intervention(
    l,
    action,
    () => recoverRun(l, fresh, undefined, () => (started = true), undefined, reconciled),
    undefined,
    () => started
  );
  if (!res.ok && res.busy) return busyExit(l, res);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : res.held ? EXIT.held : 1;
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

/** Read actual generated nodes: old workflows retain their milestone-only retry semantics. */
const attemptable = (l: Ledger, scope: string): boolean =>
  workflowRoles(l)?.has(
    scope.startsWith('pkg/') ? `package-attempt-${scope.slice(4)}` : `attempt-${scope}`
  ) ?? false;
const retryScope = (l: Ledger, node: string): string => {
  const pkg = /^(verify|settle|code|repair)-/.test(node)
    ? node.replace(/^(verify|settle|code|repair)-/, '')
    : '';
  return pkg && attemptable(l, `pkg/${pkg}`) ? `pkg/${pkg}` : milestoneOf(l, node);
};
/** always_run reads this scope count; only dependent nodes lose their resume cache. */
function bumpAttempt(l: Ledger, m: string): number {
  const path = attemptPath(l.gen_dir, m);
  const n = readAttempt(path) + 1;
  if (!Number.isSafeInteger(n)) throw new Error(`attempt counter exhausted: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, String(n));
  return n;
}
const gateMilestone = (node: string): string => node.replace(/^gate-(.+)-r\d+$/, '$1');
const milestoneOf = (l: Ledger, node: string): string =>
  /^(verify|settle|code|repair)-/.test(node)
    ? (planOf(l).packages.find(p => node.replace(/^(verify|settle|code|repair)-/, '') === p.id)
        ?.milestone ?? 'm1')
    : gateMilestone(node.replace(/^fix-/, 'gate-'));

/** Bump the generated scope before resume; missing counters fail explicitly. */
function retryGate(
  l: Ledger,
  node: string,
  fresh: boolean,
  auto?: AutoRetry,
  prepare?: () => void,
  key?: string,
  onEffect?: (effect: DecisionEffect) => void
): RecoverResult {
  const m = retryScope(l, node);
  if (!attemptable(l, m))
    throw new Error(`decide retry: ${node} escalated; fix on ${l.branch} or start a new run`);
  return recoverRun(
    l,
    fresh,
    auto,
    () => {
      if (
        key &&
        (readJson(join(l.gen_dir, 'budget-extra')) as { key?: string } | null)?.key === key
      )
        return;
      bumpAttempt(l, m);
      prepare?.();
    },
    effect =>
      onEffect?.(
        effect.action === 'adopt'
          ? effect
          : {
              action: m.startsWith('pkg/')
                ? 'retry_package'
                : node.startsWith('review-')
                  ? 'review'
                  : 'retry_milestone',
              target: m.startsWith('pkg/') ? m.slice(4) : m,
              engine_run: effect.engine_run,
            }
      )
  );
}

const scopedRetry = (l: Ledger, c: Classified, node: string): boolean =>
  c.state === 'held:gate' ||
  /^(gate|verify|settle)-/.test(node) ||
  (/^(code|repair)-/.test(node) && retryScope(l, node).startsWith('pkg/'));

/** Package holds bump their own count; gates bump the milestone; old coder nodes resume. */
const retry = (
  l: Ledger,
  c: Classified,
  prepare?: () => void,
  key?: string,
  onEffect?: (effect: DecisionEffect) => void
): RecoverResult =>
  scopedRetry(l, c, c.node ?? '')
    ? retryGate(l, c.node ?? '', true, undefined, prepare, key, onEffect)
    : recoverRun(l, true, undefined, prepare, onEffect);

/** decide --all-held retry：对所有 held（签收门除外）的 run 逐个 retry，单个失败不影响其余。 */
function retryAllHeld(): number {
  const out = ledgers().flatMap((l): Record<string, unknown>[] => {
    try {
      if ('error' in l) throw new Error(l.error);
      const c = classifyRun(l, getRun(l.archon_run_id, l.repo));
      if (!c.state.startsWith('held:') || c.state === 'held:human') return [];
      let started = false;
      const execute = () => ({
        run_id: l.run_id,
        state: c.state,
        ...retry(l, c, () => (started = true)),
      });
      return [control(l, () => intervention(l, 'decide', execute, undefined, () => started))];
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
    print({
      run_id: l.run_id,
      ok: false,
      reason: `decide refused: run ${run.status} is not currently held`,
    });
    return 1;
  }
  if (action === 'approve') {
    if (pastDeadline(l)) {
      print({ run_id: l.run_id, ok: false, reason: PAST_DEADLINE });
      return 1;
    }
    if (c.state !== 'held:human') {
      print({ run_id: l.run_id, ok: false, reason: 'run is not waiting for a human signoff' });
      return 1;
    }
    const log = join(l.gen_dir, `signal-${c.node ?? 'none'}.log`);
    return intervention(l, 'decide', () => {
      const r = signalHuman(run, { decision: 'approve' }, log, l.repo);
      print({ run_id: l.run_id, ...r });
      return r.ok ? 0 : 1;
    });
  }
  if (action === 'reject') {
    const ok = intervention(l, 'decide', () => cancelRun(l.archon_run_id, run.status, l.repo));
    if (ok)
      updateLedger(l, cur => {
        cur.rejected = run.id;
      });
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
  let started = false;
  const res = intervention(
    l,
    'decide',
    () => retry(l, c, () => (started = true)),
    undefined,
    () => started
  );
  if (!res.ok && res.busy) return busyExit(l, res);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : res.held ? EXIT.held : 1;
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
  const ownership = coord().owner(runScope(l));
  lines.push(
    `controller: ${JSON.stringify(ownership.owner)} ${ownership.presence.state}; inbox: ${String(coord().pending(ownership.scope))}`
  );
  const inbox = coord().inbox(caller(true));
  if (inbox.length) lines.push(`inbox: ${inbox.map(m => m.id).join(' ')}; superagent inbox`);
  lines.push(`engine: ${String(s.engine)}`);
  if (l.adoptions?.length) lines.push(`adoption: ${JSON.stringify(l.adoptions.at(-1))}`);
  try {
    const asks = asksOf(l.run_id),
      receipt = latestReceipt(asks);
    if (receipt) lines.push(`receipt: ${receipt.body}`);
    for (const [k, v] of Object.entries(asks)) lines.push(`ask ${k}: ${v?.status ?? '?'}`);
  } catch (e) {
    lines.push(`asks: ${tail((e as Error).message, 120)}`);
  }
  for (const f of evidenceGates(l, art)) {
    const d = decisionOf(evidenceJson(l, art, f));
    lines.push(
      `${f.slice(0, -5)}: ${decisionVerdict(d)}${d?.reason ? ` (${d.reason})` : ''} debt=${String(d?.debt.length ?? 0)}`
    );
  }
  if (l.reason === 'deadline') lines.push('plan 截止已过，已取消');
  if (typeof s.error === 'string') lines.push(`error: ${s.error}`);
  if (Array.isArray(s.land)) lines.push(...(s.land as string[]));
  for (const n of needsOf(art, undefined, l).slice(0, 3))
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
type DecisionEffect =
  | { action: 'approve' | 'reject' | 'resume' | 'adopt'; engine_run: string }
  | { action: 'retry_package' | 'retry_milestone' | 'review'; engine_run: string; target: string };
/** Only engine identifiers and the acknowledged execution branch enter a receipt. */
function decisionReceipt(
  run: string,
  node: string,
  answer: 'yes' | 'no',
  effect: DecisionEffect
): string {
  const name = (v: string): string => askName(v, 80);
  let action: string;
  switch (effect.action) {
    case 'approve':
      action = '已批准等待门并提交续跑';
      break;
    case 'reject':
      action = '已终止整个run（保留证据）';
      break;
    case 'resume':
      action = '已提交原run续跑';
      break;
    case 'adopt':
      action = '已新开run从首个节点重跑';
      break;
    case 'retry_package':
      action = `已提交包${name(effect.target)}编码→验收重跑`;
      break;
    case 'retry_milestone':
      action = `已提交里程碑${name(effect.target)}累计验收→评审重跑`;
      break;
    case 'review':
      action = `已提交${name(effect.target)}本轮评审重跑`;
      break;
  }
  return `run=${name(run)}；节点=${name(node) || '未指定'}；答复=${answer === 'yes' ? '是' : '否'}；${action}；去向=${name(effect.engine_run)}；结果=动作已受理（不代表后续验收通过）`;
}
interface AnswerReceipt {
  key: string;
  body: string;
  at?: string;
  delivery?: 'pending' | 'sent' | 'failed';
  error?: string;
}
interface AnswerIntent {
  answer: 'yes' | 'no';
  node: string;
  engine_run: string;
  effect?: DecisionEffect;
}
type Ask = BaseAsk & { receipt?: AnswerReceipt; decision?: AnswerIntent };
export type Asks = Partial<Record<string, Ask>>;

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

/** Legacy receipts lack timestamps; ties retain their persisted order. */
const latestReceipt = (asks: Asks): AnswerReceipt | undefined =>
  Object.values(asks)
    .flatMap(a => (a?.receipt ? [a.receipt] : []))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
    .at(-1);

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
    env: { ...process.env },
  });
  if (p.exitCode !== 0)
    throw new Error(
      `supervisor ${args[0]} exit ${String(p.exitCode)}: ${tail(p.stderr.toString(), 200)}`
    );
  return p.stdout.toString().trim();
}

/** Publish the occurrence before any engine action; an interrupted decision is never replayed. */
function beginAnswer(l: Ledger, node: string, a: Ask, answer: 'yes' | 'no', asks: Asks): void {
  a.decision = { answer, node, engine_run: l.archon_run_id };
  saveAsks(asks);
}

/** Cancellation has a terminal engine fact. Other unacknowledged effects remain explicitly unknown. */
function reconcileAnswers(l: Ledger, asks: Asks, out: Action[]): boolean {
  let unresolved = false;
  for (const [key, a] of Object.entries(asks)) {
    if (!key.startsWith(`${l.run_id}:`) || !a?.decision) continue;
    const d = a.decision;
    try {
      const run = getRun(d.effect?.engine_run ?? d.engine_run, l.repo);
      const effect =
        d.effect ??
        (d.answer === 'no' && run.status === 'cancelled'
          ? { action: 'reject' as const, engine_run: run.id }
          : undefined);
      if (!effect)
        throw new Error(
          'decision_effect_unknown: inspect engine evidence; action will not be replayed'
        );
      consumeAnswer(l, d.node, key, a, d.answer, effect, asks);
      out.push({ run_id: l.run_id, action: 'receipt_reconciled', ok: true });
    } catch (e) {
      unresolved = true;
      out.push({
        run_id: l.run_id,
        action: 'decision_reconcile',
        ok: false,
        error: tail((e as Error).message, 200),
      });
    }
  }
  return unresolved;
}

/** Persist the acknowledged effect with consumption so later ticks cannot replay the action. */
function consumeAnswer(
  l: Ledger,
  node: string,
  key: string,
  a: Ask,
  answer: 'yes' | 'no',
  effect: DecisionEffect,
  asks: Asks
): void {
  // Reconciled acknowledgements use the same decision key as the original execution.
  intervention(l, 'answer', () => true, { key, id: a.id });
  if (effect.action === 'reject')
    updateLedger(l, cur => {
      cur.rejected = effect.engine_run;
    });
  if (a.decision) {
    a.decision.effect = effect;
    saveAsks(asks);
  }
  a.status = answer === 'yes' ? 'approved' : 'rejected';
  delete a.decision;
  a.receipt = {
    key: new Bun.CryptoHasher('sha256').update(`${a.id ?? key}:${answer}`).digest('hex'),
    body: decisionReceipt(l.run_id, node, answer, effect),
    at: new Date().toISOString(),
  };
  saveAsks(asks);
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
 * 一条提醒的投递与对账（签收与挂起共用）。≤200字的标题末尾是 key 的128位摘要，旧前缀仍可找回。
 * 先落 unknown 再调 ask；supervisor 先落盘再投递，失败或崩溃时先对账，找不到才重投；多条匹配不猜。
 */
const askMarker = (key: string): string =>
  `[sa:${new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32)}]`;
const matchesAsk = (question: string, key: string): boolean =>
  question.endsWith(`；${askMarker(key)}`) || question.startsWith(`superagent ${key} `);
function pollAsk(
  key: string,
  text: () => string,
  hours: number,
  asks: Asks
): { a: Ask; asked?: string; note?: string } | { conflict: string } {
  let a = asks[key];
  let note: string | undefined;
  if (a !== undefined && a.id === undefined) {
    const { records, anomalous } = askRecords();
    if (anomalous) note = `${String(anomalous)} anomalous ask records`;
    const found = records.filter(
      r => matchesAsk(r.question, key) || (a?.legacy_key && matchesAsk(r.question, a.legacy_key))
    );
    if (found.length > 1)
      return {
        conflict: `ask ${key}: ${String(found.length)} supervisor asks match${note ? `; ${note}` : ''}`,
      };
    a = asks[key] = found.length ? { ...a, id: found[0].id, status: 'pending' } : undefined;
  }
  if (!a) {
    asks[key] = { status: 'unknown' };
    saveAsks(asks);
    const id = supervisor(['ask', '--question', text(), '--ttl-hours', String(hours)]);
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
  const key = askKey(l.run_id, 'signoff', holdEpisode(l, run, classifyRun(l, run)));
  const base = { run_id: l.run_id, event: w.event };
  // 引擎的 wait.deadline_ms 从进入等待起计时，生成时无法折算成 plan 的绝对截止：由这里与 signoff 节点兜住
  if (pastDeadline(l)) return expireRun(l, run, asks, base);
  const p = pollAsk(
    key,
    () => decisionQuestion(l, run, classifyRun(l, run), 'signoff'),
    ttlHours(Date.parse(w.resumeAt)),
    asks
  );
  if ('conflict' in p)
    return { ...base, action: 'none', ok: false, reason: `${p.conflict}; decide approve|reject` };
  const b = { ...base, ...(p.note ? { reason: p.note } : {}) };
  if (p.asked) return { ...b, action: 'ask', ok: true, ask: p.asked };
  if (p.a.status === 'yes' && pastDeadline(l)) return expireRun(l, run, asks, base);
  return answerAction(l, key, p.a, () => {
    // yes/no 的执行失败保留原状态，下一次 tick 重试
    if (p.a.status === 'yes') {
      beginAnswer(l, w.nodeId, p.a, 'yes', asks);
      const log = join(l.gen_dir, `signal-${w.nodeId}.log`);
      const r = signalHuman(run, { decision: 'approve', ask: p.a.id }, log, l.repo);
      if (r.ok)
        consumeAnswer(
          l,
          w.nodeId,
          key,
          p.a,
          'yes',
          { action: 'approve', engine_run: l.archon_run_id },
          asks
        );
      return { ...b, action: 'approve', ...r };
    }
    if (p.a.status === 'no') {
      beginAnswer(l, w.nodeId, p.a, 'no', asks);
      const ok = cancelRun(l.archon_run_id, run.status, l.repo);
      if (ok)
        consumeAnswer(
          l,
          w.nodeId,
          key,
          p.a,
          'no',
          { action: 'reject', engine_run: l.archon_run_id },
          asks
        );
      return { ...b, action: 'reject', ok };
    }
    // expired：不替用户决定；事件门到期后 signoff 节点失败，run 停在 failed 等元帅
    return { ...b, action: 'none', ok: true, ask: p.a.status };
  });
}

/** Archon 审批门（非 sa.human.*）的“是”：approve --detach 放行并续跑。 */
function approveRun(l: Ledger): RecoverResult {
  const ack = archonJson(['workflow', 'approve', l.archon_run_id, '--detach'], l.repo);
  return ack.ok === true
    ? { ok: true, resumed: ack }
    : { ok: false, reason: tail(JSON.stringify(ack)) };
}

/**
 * HOLD_POLICY 的 ask 行：同一 (run, hold, episode) 仅投递一次；新挂起必须新问。
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
  const key = askKey(l.run_id, hold, holdEpisode(l, run, c));
  const base = { run_id: l.run_id, state: c.state, reason: hold, ...extra };
  const r = pollAsk(
    key,
    () => decisionQuestion(l, run, c, hold, extra),
    ttlHours(Date.parse(planOf(l).deadline)),
    asks
  );
  if ('conflict' in r)
    return { ...base, action: 'none', ok: false, error: `${r.conflict}; decide retry|reject` };
  const b = { ...base, ...(r.note ? { note: r.note } : {}) };
  if (r.asked) return { ...b, action: 'ask', ok: true, ask: r.asked };
  return answerAction(l, key, r.a, () => {
    if (r.a.status === 'yes') {
      beginAnswer(l, c.node ?? '', r.a, 'yes', asks);
      let effect: DecisionEffect | undefined =
        p.yes === 'approve' ? { action: 'approve', engine_run: l.archon_run_id } : undefined;
      const onEffect = (actual: DecisionEffect): void => {
        effect = actual;
        if (r.a.decision) r.a.decision.effect = actual;
        saveAsks(asks);
      };
      const res =
        p.yes === 'approve'
          ? approveRun(l)
          : p.yes === 'resume'
            ? recoverRun(l, true, undefined, undefined, onEffect)
            : p.yes === 'review'
              ? retryGate(
                  l,
                  `review-${(c.node ?? '').slice(5)}`,
                  true,
                  undefined,
                  undefined,
                  undefined,
                  onEffect
                )
              : retry(
                  l,
                  c,
                  hold === 'budget'
                    ? () => {
                        grantBudget(l, c.node ?? '', key);
                      }
                    : undefined,
                  hold === 'budget' ? key : undefined,
                  onEffect
                );
      if (res.ok) {
        if (!effect) throw new Error('decision recovery succeeded without an execution receipt');
        consumeAnswer(l, c.node ?? '', key, r.a, 'yes', effect, asks);
      }
      if (!res.ok && (res.busy || res.refused)) {
        delete r.a.decision;
        saveAsks(asks);
      }
      const out = res.ok
        ? { ok: true }
        : { ok: false, error: res.reason, ...(res.busy ? { busy: true } : {}) };
      return { ...b, action: p.yes, ...out };
    }
    if (r.a.status === 'no') {
      beginAnswer(l, c.node ?? '', r.a, 'no', asks);
      const ok = cancelRun(l.archon_run_id, run.status, l.repo);
      if (ok)
        consumeAnswer(
          l,
          c.node ?? '',
          key,
          r.a,
          'no',
          { action: 'reject', engine_run: l.archon_run_id },
          asks
        );
      return { ...b, action: 'reject', ok };
    }
    return { ...b, action: 'none', ok: true, ask: r.a.status };
  });
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
function tick(
  sa: string
): { actions: Action[]; gc: GcAction[]; scratch: ScratchAction[] } & ReturnType<
  typeof cockpitSignals
> {
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
      const actor = l.controller ?? l.launcher;
      if (!actor)
        throw new Error(
          'coord: run 没有可验证 controller/launcher；请先 claim 并显式 resume/decide'
        );
      const x = control(
        l,
        controller => {
          archonDetached(
            ['workflow', 'wake', l.archon_run_id, '--json'],
            join(sa, 'wake.log'),
            l.repo
          );
          if (!(asks instanceof Error) && reconcileAnswers(l, asks, out)) return undefined;
          const action = dispose(l, asks, observed);
          return action ? { ...action, controller, generation: controller.generation } : undefined;
        },
        actor,
        l.controller?.generation
      );
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
    for (const action of coord().tick((key, title) => {
      const r = pollAsk(key, () => title, MAX_TTL_H, asks as Asks);
      if ('conflict' in r) throw new Error(r.conflict);
      return { id: r.a.id, status: r.a.status };
    }))
      out.push({ run_id: 'coord', action: 'coord', ok: true, ...action });
    // gc.sh 删掉 ledger 后留下的条目在这里丢：asks.json 只有 tick 一个写者
    asks = Object.fromEntries(
      Object.entries(asks).filter(([k]) => k.startsWith('coord:') || live.has(k.split(':')[0]))
    );
    for (const [key, a] of Object.entries(asks)) {
      if (a?.status !== 'superseded' || a.stale_answer) continue;
      if (!a.id) {
        const records = askRecords().records.filter(r => matchesAsk(r.question, key));
        if (records.length === 1) a.id = records[0].id;
      }
      if (
        !a.id ||
        Object.values(asks).some(live => live && live.id === a.id && live.status !== 'superseded')
      )
        continue;
      try {
        a.stale_answer = ['yes', 'no'].includes(supervisor(['ask-status', a.id]));
      } catch (e) {
        out.push({
          run_id: 'asks',
          action: 'error',
          ok: false,
          error: tail((e as Error).message, 200),
        });
      }
    }
    saveAsks(asks);
  }
  memoryTick(asks instanceof Error ? {} : asks);
  // supervise.lock serializes the persisted throttle; reserve before the slow GC.
  const gcStamp = join(sa, 'gc-tick'),
    due = !existsSync(gcStamp) || Date.now() - statSync(gcStamp).mtimeMs >= 15 * 60_000;
  if (due) writeAtomic(gcStamp, String(Date.now()));
  return {
    actions: out,
    ...cockpitSignals(observed, asks instanceof Error ? {} : asks),
    gc: due ? gc() : [],
    scratch: scratchClean(),
  };
}

/** run → 挂起原因；undefined 不归 tick 管（运行中、终态、非编码节点失败）。签收自己处理截止，其余过了截止即 deadline。 */
function holdOf(l: Ledger, run: RunView, c: Classified): Hold | undefined {
  if (c.state === 'held:engine_suspect') return pastDeadline(l) ? 'deadline' : 'engine_suspect';
  if (c.state === 'held:human') return 'signoff';
  const h: Hold | undefined =
    c.state === 'held:gate'
      ? reasonHold(nodeReason(l, run, c))
      : c.state === 'held:environment'
        ? 'environment'
        : c.state === 'held:recover_no_progress'
          ? 'recover_no_progress'
          : c.state === 'held:paused'
            ? run.metadata?.approval
              ? 'approval'
              : 'paused'
            : c.state === 'failed' && /^(verify|settle)-/.test(c.node ?? '')
              ? reasonHold(nodeReason(l, run, c))
              : c.state === 'failed' && /^(code|fix|repair)-/.test(c.node ?? '')
                ? 'coder'
                : undefined;
  return h && pastDeadline(l) ? 'deadline' : h;
}

const nodeReason = (l: Ledger, run: RunView, c: Classified): string => {
  const out = evidenceJson(l, artifactsOf(run), `${c.node ?? ''}.json`) as {
    reason?: unknown;
  } | null;
  return (
    decisionOf(out)?.reason ??
    (/^(verify|settle|gate)-/.test(c.node ?? '')
      ? ''
      : typeof out?.reason === 'string'
        ? out.reason
        : '')
  );
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
  const attempt = readAttempt(join(l.gen_dir, 'attempts', m));
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

/** Entry timestamp is stable across polls; node distinguishes milestone signoffs. */
function holdEpisode(l: Ledger, run: RunView, c: Classified): string {
  return `${c.node ?? run.metadata?.wait?.nodeId ?? ''}@${run.metadata?.wait?.waitingSince ?? run.completed_at ?? run.last_activity_at ?? run.started_at ?? l.started_at}`;
}
/** 展示与实际 retryGate/resume 分支一致；settle 是包的最终验收节点。 */
function decisionRecovery(
  l: Ledger,
  run: RunView,
  c: Classified,
  hold: Hold,
  limit: number
): [string, string] {
  const p = HOLD_POLICY[hold],
    node = c.node ?? run.metadata?.wait?.nodeId ?? '恢复节点';
  if (p.do !== 'ask' || p.yes === 'approve') return ['', ''];
  const gate = p.yes === 'review' || (p.yes === 'retry' && scopedRetry(l, c, node));
  let target = `从${askName(node, limit)}续跑`;
  if (gate) {
    const m = milestoneOf(l, p.yes === 'review' ? `review-${(c.node ?? '').slice(5)}` : node);
    if (!attemptable(l, p.yes === 'review' ? m : retryScope(l, node)))
      return [`重试${askName(m, limit)}（缺少attempt节点，无法重跑）`, ''];
    if (p.yes === 'review') target = `重跑${askName(m, limit)}本轮评审`;
    else if (retryScope(l, node) !== m)
      target = `重派${askName(node.replace(/^(verify|settle|code|repair)-/, ''), limit)}编码→验收`;
    else target = `重跑${askName(m, limit)}累计验收→评审`;
  }
  return [
    target,
    adoptsRun(l, run)
      ? l.workflow_hash
        ? '（引擎已升级，将新开run从首个节点重跑）'
        : '（旧run身份未确认，将新开run从首个节点重跑）'
      : '',
  ];
}
/** 只展示注册原因、闭集枚举与数字；将军/评审自由文本只在 brief 中读取。 */
export function decisionQuestion(
  l: Ledger,
  run: RunView,
  c: Classified,
  hold: Hold,
  extra: Record<string, unknown> = {}
): string {
  const plan = planOf(l),
    node = c.node ?? run.metadata?.approval?.nodeId ?? '恢复节点';
  const m = hold === 'signoff' ? node.replace(/^human-/, '') : milestoneOf(l, node);
  const read = (f: string): Record<string, unknown> => {
    try {
      return (evidenceJson(l, artifactsOf(run), f) as Record<string, unknown> | null) ?? {};
    } catch {
      return {};
    }
  };
  const out = read(`${node}.json`),
    pkg = plan.packages.find(p => p.id === node.replace(/^(verify|settle|code|repair)-/, ''));
  const reason = reasonOf(decisionOf(out)?.reason ?? '')?.description ?? '证据缺失';
  const names = [basename(l.repo), pkg?.title ?? m, node];
  const progress = `已完成${String((run.nodes ?? []).filter(n => n.state === 'completed').length)}/${String(workflowRoles(l)?.size ?? run.nodes?.length ?? 0)}节点`;
  let detail = reason,
    compact = reason;
  if (hold === 'needs') {
    let needs: Record<string, string>[] = [];
    try {
      needs = needsOf(artifactsOf(run), m, l).filter(x => x.tag === node);
    } catch {
      /* Missing display evidence does not block an operator question. */
    }
    detail = needs.length ? `能力请求${String(needs.length)}项` : '证据缺失';
  } else if (hold === 'budget') {
    detail = '证据缺失';
    try {
      const ack = archonJson(
        ['workflow', 'get', l.archon_run_id, '--verbose', '--events'],
        l.repo
      ) as { events?: Parameters<typeof budgetUsage>[0] };
      if (Array.isArray(ack.events)) {
        const u = budgetUsage(
          ack.events,
          loadTiers().policy.budget_floor.S,
          readPolicyAttempts(artifactsOf(run))
        );
        const limits = effectiveBudget(
          plan.budget,
          (readJson(join(l.gen_dir, 'budget-extra')) ?? null) as Parameters<
            typeof effectiveBudget
          >[1],
          m,
          readAttempt(join(l.gen_dir, 'attempts', m))
        );
        detail =
          `调用已用/上限${String(u.launches)}/${String(limits.launches ?? '无限制')}，` +
          `加权token已用/上限${String(u.weighted_tokens)}/${String(limits.weighted_tokens)}`;
        compact =
          out.reason === 'budget_tokens_exceeded'
            ? `加权token已用/上限${String(u.weighted_tokens)}/${String(limits.weighted_tokens)}`
            : `调用已用/上限${String(u.launches)}/${String(limits.launches ?? '无限制')}`;
      }
    } catch {
      /* 展示证据缺失 */
    }
  } else if (hold === 'review_limit' || hold === 'review_not_independent') {
    const ledger = read(`${node}.ledger.json`);
    detail =
      `轮次${typeof out.rounds === 'number' ? String(out.rounds) : '证据缺失'}，` +
      `未决${Array.isArray(ledger.blocking) ? String(ledger.blocking.length) : '证据缺失'}；${reason}`;
  } else if (hold === 'approval') detail = '等待批准';
  else if (hold === 'signoff') {
    let files: string[] = [];
    try {
      files = evidenceGates(l, artifactsOf(run));
    } catch {
      /* 展示证据缺失 */
    }
    const verdict = decisionVerdict(
      decisionOf(
        read(files.filter(f => f.startsWith(`gate-${m}-r`)).at(-1) ?? 'missing-signoff.json')
      )
    );
    detail = `验收/评审${verdict === 'pass' ? '通过' : verdict === 'fix' ? '需修复' : verdict === 'escalate' ? '需升级处理' : '证据缺失'}`;
  } else if (hold !== 'redline' && hold !== 'coder_blocked') {
    const check = Array.isArray(out.failed)
      ? out
      : read(`diff-${m}-r${String(typeof out.rounds === 'number' ? out.rounds : 1)}.json`);
    if (Array.isArray(check.failed) && check.failed.length) {
      const failed = check.failed;
      detail += `；失败检查${
        plan.packages
          .flatMap(p =>
            p.accept.flatMap((a, i) =>
              failed.includes(a.cmd) ? [`${askName(p.id, 4)}验收#${String(i + 1)}`] : []
            )
          )
          .slice(0, 3)
          .join('、') || '证据缺失'
      }`;
    }
    if (hold === 'auto_retry_exhausted')
      detail += `；已重试${String(typeof extra.auto_retries === 'number' ? extra.auto_retries : (l.auto_retries?.length ?? 0))}次`;
    if (hold === 'recover_no_progress')
      detail = `已恢复${String(l.stalled ?? 0)}次，完成节点集合未变化`;
  }
  return askQuestion(
    hold,
    names,
    [`${detail}；${progress}`, `${compact}；${progress}`],
    limit => decisionRecovery(l, run, c, hold, limit),
    askMarker(askKey(l.run_id, hold, holdEpisode(l, run, c)))
  );
}
/** 一个 run 的处置：owner-lost 恢复，其余按 HOLD_POLICY 分派；自动处置转出的挂起原因（用尽、needs…）再查一次表。 */
function dispose(l: Ledger, asks: Asks | Error, observed: HoldSignal[]): Action | undefined {
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  const row: HoldSignal = {
    run_id: l.run_id,
    since:
      run.metadata?.wait?.waitingSince ?? run.completed_at ?? run.last_activity_at ?? l.started_at,
    disposed: false,
  };
  observed.push(row);
  if (c.state === 'held:engine_suspect')
    saveIncident(l.run_id, artifactsOf(run), c.node ?? '', planOf(l), {
      run: workflowIdentity(l) ?? null,
      current: engineHash(),
    });
  if (c.state === 'held:owner_unknown' || c.state === 'held:recovery_admission_unknown')
    return {
      run_id: l.run_id,
      action: 'none',
      ok: false,
      held: true,
      state: c.state,
      next: `Inspect archon workflow get ${run.id} --verbose; resolve ownership or abandon explicitly.`,
    };
  if (c.state === 'owner_lost')
    return record(l, 'owner_lost', { run_id: l.run_id, action: 'recover', ...recoverRun(l) });
  const need = (): Asks => {
    if (asks instanceof Error) throw asks;
    return asks;
  };
  const act = (hold: Hold, extra: Record<string, unknown> = {}): Action | undefined => {
    row.hold = hold;
    row.disposed =
      l.dispositions?.some(
        d => d.reason === hold && d.ok && Date.parse(d.at) >= Date.parse(row.since)
      ) ?? false;
    const p: Policy = HOLD_POLICY[hold];
    if (
      !(asks instanceof Error) &&
      ['ask', 'signoff'].includes(p.do) &&
      !(hold === 'signoff' && pastDeadline(l))
    )
      supersedeAsks(asks, l.run_id, hold, holdEpisode(l, run, c));
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
    if (!(asks instanceof Error) && !['ask', 'signoff', 'expire'].includes(p.do))
      supersedeAsks(asks, l.run_id);
    return x && record(l, hold, x);
  };
  const hold = holdOf(l, run, c);
  if (!hold && !(asks instanceof Error)) supersedeAsks(asks, l.run_id);
  if (
    hold === 'engine_suspect' &&
    workflowIdentity(l) &&
    workflowIdentity(l) !== engineHash() &&
    run.status === 'failed'
  )
    return act('gate');
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
    [kind, m, reason] = ['gate', gateMilestone(node), `gate:${decisionOf(gate)?.reason ?? '?'}`];
  } else if (c.state === 'held:environment') {
    [kind, m, reason] = ['environment', 'environment', 'environment'];
  } else {
    m = milestoneOf(l, node);
    const why = nodeReason(l, run, c);
    kind = reasonHold(why) === 'environment' ? 'environment' : 'coder';
    reason = `${kind}:${why || node}`;
  }
  const tries = (l.auto_retries ?? []).filter(
    r => r.milestone === m && r.reason.split(':')[0] === kind
  );
  const needs = needsOf(art, m, l);
  const hold = (h: Hold): Held => [
    h,
    { auto_retries: tries.length, ...(needs.length ? { needs } : {}) },
  ];
  if (needs.length) return hold('needs');
  const cause = reasonOf(
    c.state === 'held:engine_suspect' ? 'engine_suspect' : nodeReason(l, run, c) || kind
  );
  if (!cause) return hold('engine_suspect');
  if (cause.hold === 'redline') return hold('redline');
  if (cause.hold === 'deadline') return hold('deadline');
  if (cause.hold === 'no_change') return hold('no_change');
  if (
    cause.determinism === 'deterministic' &&
    (!workflowIdentity(l) || workflowIdentity(l) === engineHash())
  )
    return hold('auto_retry_exhausted');
  if (
    cause.determinism === 'deterministic' &&
    l.auto_retries?.some(r => r.engine_hash === engineHash())
  )
    return hold('auto_retry_exhausted');
  if (cause.determinism === 'deterministic' && !['failed', 'cancelled'].includes(run.status))
    return hold('auto_retry_exhausted');
  if (cause.determinism !== 'deterministic' && tries.length >= loadTiers().policy.auto_retry[kind])
    return hold('auto_retry_exhausted');
  const pkgHold = /^(verify|settle)-/.test(node);
  if ((kind === 'gate' || pkgHold) && !attemptable(l, retryScope(l, node)))
    return hold('no_attempt_node');
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
  const auto = {
    milestone: m,
    at: new Date().toISOString(),
    reason,
    engine_hash: engineHash(),
    ...(cause.determinism === 'deterministic' ? { deterministic: true as const } : {}),
  };
  let r: RecoverResult;
  if (kind === 'gate') {
    const text = gateHint(art, node, gate, tries.length + 1);
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

/** Retry guidance projects the recorded decision and its evidence. */
function gateHint(art: string, node: string, g: Gate | undefined, n: number): string {
  const acc = readJson(join(art, `${node.replace(/^gate-/, 'diff-')}.json`)) as Accept | undefined;
  const out = [`\n## 自动重试 ${String(n)}：${node} escalate（${decisionOf(g)?.reason ?? '?'}）\n`];
  if (acc?.failed?.length) {
    out.push('失败的验收命令：', ...acc.failed.map(x => `- \`${x}\``), '');
    out.push(
      `交付判定：${decisionOf(acc)?.kind ?? 'unknown'}；基线状态未知时查阅 probe 证据。`,
      ''
    );
    const log = acc.log && existsSync(acc.log) ? readFileSync(acc.log, 'utf8').trimEnd() : '';
    if (log) out.push('验收日志尾：', '```', ...log.split('\n').slice(-60), '```', '');
  }
  const ledger = readJson(join(art, `${node}.ledger.json`)) as ReviewLedger | undefined;
  const findings = (ledger?.blocking ?? []).map(
    f => `- ${f.id} [${f.severity}] ${f.file}:${String(f.line)} ${tail(f.evidence ?? '', 200)}`
  );
  if (findings.length) out.push('未关闭的阻塞发现：', ...findings, '');
  out.push(`gate reason：${decisionOf(g)?.reason ?? '?'}`, '');
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
      const last = new Map<string, { decision: DeliveryDecision | undefined; round: string }>();
      for (const f of evidenceGates(l, artifactsOf(run))) {
        const [, m, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
        last.set(m, { decision: decisionOf(evidenceJson(l, artifactsOf(run), f)), round });
        if (round === '1' && decisionVerdict(last.get(m)?.decision) === 'pass')
          bump(n, 'first_pass');
      }
      for (const g of last.values()) {
        bump(n, `rounds:${g.round}`);
        bump(n, 'debt', g.decision?.debt.length ?? 0);
        if (g.decision?.kind === 'block') bump(n, `escalate:${g.decision.reason ?? '?'}`);
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
  'usage: superagent <owner [path|run]|claim [path|run] [--takeover --reason text]|release [path|run]|handoff --to path|run --kind bug|task|question|takeover-request --title t --body-file md|inbox [--all|--ack id accepted|rejected|done --note text]|run <plan.json> [--fake] [--skip-selftest] [--lint-override reason]|quick --goal <text> --accept <cmd> [--accept <cmd>...] [--scope <glob>...] [--risk G0|G1|G2] [--review] [--no-cache] [--base <ref>] [--repo <path>]|wait <run> [--timeout s]|status|brief|land|resume|cancel|recover <run>|decide <run> approve|reject|retry [--pkg id --hint text]|decide --all-held retry|accept <run> [--pkg id]|report|memory|quota|usage [--since YYYYMMDD] [--refresh]|console start|stop|status|url [--open] (web alias)|gc [--dry-run]|scratch-clean [--session id] [--dry-run]|supervise-tick|health [--cwd repo]|board [run] [--once] [--interval s] [--limit n]|models [--mode mode]|job exec --title t [--card p] [--log p] [--role r] [--mode mode] [--worktree branch --base ref] -- cmd...|job clean id|jobs [--all]> (every verb accepts --json)';

function tickOutput(consoleError?: string): number {
  const actions = superviseTick();
  print({ ...actions, ...(consoleError !== undefined ? { console_error: consoleError } : {}) });
  if (!('actions' in actions)) return 0;
  return actions.actions.some(x => !x.ok && x.busy !== true) ? 1 : 0;
}

/** Console availability must not gate the unattended heartbeat. */
export async function superviseTickCli(
  refresh = async (): Promise<unknown> => (await import('./web/server')).refreshConsole(),
  sync = async (): Promise<unknown> => (await import('./orca')).syncOrca()
): Promise<number> {
  let error: string | undefined;
  try {
    await refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error(`supervise-tick: console refresh failed: ${error.replace(/[\r\n]+/g, ' ')}`);
  }
  const exit = tickOutput(error);
  try {
    const result = await sync();
    if (result && typeof result === 'object' && 'error' in result)
      throw new Error(String(result.error));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`supervise-tick: orca sync failed: ${reason.replace(/[\r\n]+/g, ' ')}`);
  }
  return exit;
}

export function main(argv: string[]): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [verb, target] = a._;
  if (a.flags.help || verb === 'help') {
    console.log(USAGE);
    return 0;
  }
  const resolveTarget = (id: string): Ledger | RunView => {
    const registered = coord().resolveRun(id);
    if (registered) return loadLedger(registered.run_id);
    const run = getRun(id),
      resolved = coord().resolveRun(run.id);
    return resolved ? loadLedger(resolved.run_id) : run;
  };
  const ledger = (mutation = false): Ledger => {
    const id = need(target, `${verb} <run>`);
    if (!mutation) return loadLedger(coord().resolveRun(id)?.run_id ?? id);
    const resolved = resolveTarget(id);
    return 'run_id' in resolved ? resolved : loadLedger(resolved.id);
  };
  const controlled = (l: Ledger, f: () => number, record = true): number =>
    control(l, controller => {
      const code = record ? intervention(l, verb, f) : f();
      if (code === 0)
        updateLedger(l, cur => {
          cur.controller = controller;
        });
      return code;
    });
  switch (verb) {
    case 'models': {
      const tiers = loadTiers(),
        mode = a.flags.mode ?? 'auto';
      // prettier-ignore
      const models = Object.fromEntries((['claude', 'codex'] as const).map(c => [c,
        Object.fromEntries(TIERS.map(r => [r, resolveRoute(tiers, c, mode, ROUTE_ROLE[r]).candidates.map(a => a.model)]))]));
      const budget = budgetState(tiers, mode);
      if (a.flags.json) print({ ...models, budget });
      else
        for (const [c, roles] of Object.entries(models))
          for (const [r, candidates] of Object.entries(roles))
            console.log(`${c} ${r}: ${candidates.join(', ')}`);
      if (!a.flags.json && budget.notice) console.log(budget.notice);
      return 0;
    }
    case 'owner':
    case 'claim':
    case 'release':
    case 'handoff':
    case 'inbox':
      {
        const result = coordinationCommand(a);
        if (verb === 'handoff') {
          const k = lock(join(home().sa, 'supervise.lock'));
          if (k.ok) {
            try {
              const asks = loadAsks();
              coord().tick((key, title) => {
                const r = pollAsk(key, () => title, MAX_TTL_H, asks);
                if ('conflict' in r) throw new Error(r.conflict);
                return { id: r.a.id, status: r.a.status };
              });
              saveAsks(asks);
            } finally {
              k.release();
            }
          }
        }
        print(result);
      }
      return 0;
    case 'run':
      return startRun(need(target, 'run <plan.json>'), a);
    case 'quick':
      return startRun(quickPlan(a), a);
    case 'wait': {
      const t = Number(a.flags.timeout ?? 3000);
      if (!Number.isFinite(t) || t <= 0) {
        console.error(`--timeout must be a positive number of seconds\n${USAGE}`);
        return EXIT_USAGE;
      }
      const l = ledger(),
        s = waitRun(l, t);
      // prettier-ignore
      print({ ...s, ...(['completed', 'failed', 'cancelled'].includes(String(s.state)) ? relayQuota(l.gen_dir, 'end') : {}) });
      return Number(s.exit);
    }
    case 'quota': {
      const { quota } = relayQuota();
      if (quota) console.log(quota);
      return 0;
    }
    case 'status': {
      const l = ledger();
      const run = getRun(l.archon_run_id, l.repo);
      const c = classifyRun(l, run);
      print({ ...summary(l, run, c), receipt: latestReceipt(asksOf(l.run_id))?.body ?? null });
      return c.exit;
    }
    case 'resume':
    case 'recover': {
      const id = need(target, `${verb} <run>`);
      const resolved = resolveTarget(id);
      if (!('run_id' in resolved)) {
        const run = resolved;
        if (!run.working_path)
          throw new Error('coord: 未登记 run 缺 working_path，无法验证仓库归属');
        const res = control({ run_id: run.id, archon_run_id: run.id, repo: run.working_path }, () =>
          recover(
            run.id,
            run.working_path ?? undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            a.flags.reconciled
          )
        );
        print({ run_id: id, ...res });
        return res.ok ? 0 : res.held ? EXIT.held : res.busy ? EXIT.running : 1;
      }
      return controlled(
        resolved,
        () => resumeRun(resolved, false, a.flags.reconciled, verb),
        false
      );
    }
    case 'cancel': {
      const id = need(target, `${verb} <run>`);
      // 未登记：按 archon run id 处理（selftest 用）
      const resolved = resolveTarget(id);
      const ok =
        'run_id' in resolved
          ? control(resolved, () =>
              intervention(resolved, 'cancel', () =>
                cancelRun(
                  resolved.archon_run_id,
                  getRun(resolved.archon_run_id, resolved.repo).status,
                  resolved.repo
                )
              )
            )
          : (() => {
              const run = resolved;
              if (!run.working_path)
                throw new Error('coord: 未登记 run 缺 working_path，无法验证仓库归属');
              return control(
                { run_id: run.id, archon_run_id: run.id, repo: run.working_path },
                () => cancelRun(run.id, run.status, run.working_path ?? undefined)
              );
            })();
      print({ run_id: id, ok });
      return ok ? 0 : 1;
    }
    case 'decide':
      if (a.flags['all-held']) {
        if (target !== 'retry') throw new Error('usage: superagent decide --all-held retry');
        return retryAllHeld();
      }
      {
        const l = ledger(true);
        return controlled(l, () => decide(l, a), false);
      }
    case 'brief':
      return brief(ledger());
    case 'land': {
      const l = ledger(true);
      return controlled(l, () => {
        const run = getRun(l.archon_run_id, l.repo);
        const land = evidenceJson(l, artifactsOf(run), 'land.json');
        if (land === undefined) {
          console.error(`land: no land.json yet (state ${classify(run).state})`);
          return 1;
        }
        const needs = needsOf(artifactsOf(run), undefined, l);
        print(
          a.flags.json && needs.length ? { ...(land as Record<string, unknown>), needs } : land
        );
        if (!a.flags.json)
          for (const n of needs) console.log(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
        return (land as { reason?: string }).reason === 'land_target_unknown' ? 1 : 0;
      });
    }
    case 'accept': {
      const l = ledger(true);
      return controlled(l, () => acceptRun(l, a.flags.pkg));
    }
    case 'gc':
      print({ gc: gc(a.flags['dry-run']) });
      return 0;
    case 'scratch-clean':
      print({ scratch: scratchClean(a.flags.session, a.flags['dry-run']) });
      return 0;
    case 'supervise-tick':
      return tickOutput();
    case 'report': {
      const r = report();
      const full = readUsage();
      print({ ...r, full_usage: { label: '全量（ccusage）', ...usageSummary(full) } });
      const usage = r.usage as { unreadable: string[] };
      return (r.unreadable as string[]).length || usage.unreadable.length ? 1 : 0;
    }
    case 'memory':
      print(a.flags['dry-run'] ? memoryTick(loadAsks(), Date.now(), false, true) : memoryData());
      return 0;
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
    if (verb === 'supervise-tick') process.exit(await superviseTickCli());
    if (verb === 'console' || verb === 'web')
      process.exit(await (await import('./web/server')).webCli(argv));
    if (verb === 'job' || verb === 'jobs') process.exit(await jobCli(argv));
    process.exit(main(argv));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}
