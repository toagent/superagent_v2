// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import { installMode } from './install-mode';
import { createHash } from 'node:crypto';
import { Intake, completion, intakeRoot, INTAKE_USAGE, type EvidenceReader } from './intake';
import { applyLand, captureDelivery, type DeliveryTarget } from './land';
import { integratedReceipt, type DeliveryOutcome, type DeliveryReceipt } from './land';
import type { Land } from '../templates/.archon/scripts/sa-check';
import { confined, workflowRoles } from './board/workflow';
import { budgetReason, readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import type { resolveAcceptanceContext } from './role-context';
import { saveIncident } from './incidents';
import { lintPlan, memoryData, memoryTick } from './memory';
import { publishLearning, proposeLearning, type LearningRequest } from './learning';
import {
  askKey,
  cockpitSignals,
  supersedeAsks,
  type HoldSignal,
  type Ask as BaseAsk,
} from './cockpit-signals';
import { launcher, type Launcher } from './launcher';
import { ownershipUnknown, recoveryAdmissionUnknown } from './recovery';
import {
  assertCommander,
  caller,
  control,
  coord,
  presence,
  repoScope,
  runScope,
  type Controller,
  type Identity,
} from './coord';
import { COORD_OPTIONS, coordinationCommand } from './coord/commands';
import { askQuestion, askName, HOLD_POLICY, reasonOf, type Hold, type Policy } from './reasons';
export { HOLD_POLICY, type Hold, type Policy } from './reasons';
import { Database } from 'bun:sqlite';
import {
  advanceExecutionAttempt,
  executionAdmissionLock,
} from '@archon/workflows/execution-lifecycle';
import {
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
  waitNotification,
  tail,
  type RecoverResult,
  type RunView,
} from './archon';
import {
  deliveryDecision,
  type Accept,
  type Review,
  budgetUsage,
  attemptPath,
  type DeliveryDecision,
  type decide as decideGate,
  validateRecovery,
  type RecoveryEvidence,
  type AuthorRun,
} from '../templates/.archon/scripts/sa-check';
import {
  WETAMP,
  budgetState,
  aliasDrift,
  codexWorkerProblem,
  home,
  loadTiers,
  resolveRoute,
  runAliases,
  writeAtomic,
} from './config';
import { engineHash, generate, newRunId } from './generate';
import { loadPlan, type Plan } from './plan';
import { redact } from './redact';
import { buildReport, reportSummary } from './report';
import { jobCli } from './jobs';
import { ROUTE_ROLE, TIERS } from './roles';
import { gc, scratchClean, type GcAction, type ScratchAction } from './gc';
import { readUsage, usageSummary, usageCli } from './usage';
import { refreshBudgetQuota, relayQuota } from './relay-quota';

const inheritedTmp = process.env.TMPDIR && resolve(process.env.TMPDIR);
if (
  inheritedTmp &&
  ['/tmp/sa-scratch', '/private/tmp/sa-scratch'].some(
    root => inheritedTmp === root || inheritedTmp.startsWith(root + '/')
  )
)
  delete process.env.TMPDIR;

export function intakeEvidence(repo: string): EvidenceReader {
  // Cache only raw engine reads for this query; every binding still validates its identity.
  const runs = new Map<string, RunView | undefined>();
  return binding => {
    if (!binding.run_id) return undefined;
    try {
      const l = loadLedger(binding.run_id);
      const frozenPlan = join(l.gen_dir, 'plan.json');
      if (resolve(l.repo) !== repo || resolve(frozenPlan) !== resolve(binding.plan))
        return undefined;
      const digest = createHash('sha256').update(readFileSync(frozenPlan)).digest('hex');
      if (digest !== binding.digest) return undefined;
      const key = JSON.stringify([l.repo, l.archon_run_id]);
      if (!runs.has(key)) {
        runs.set(key, undefined);
        runs.set(key, getRun(l.archon_run_id, l.repo));
      }
      const run = runs.get(key);
      if (!run) return undefined;
      const history = decisionsOf(artifactsOf(run), undefined, l);
      if (
        run.nodes?.some(
          n =>
            n.state === 'completed' &&
            n.nodeId.startsWith('gate-') &&
            !history.some(d => d.tag === n.nodeId && d.decision)
        )
      )
        return undefined;
      const decisions = currentDecisions(history).map(d => d.decision);
      if (decisions.some(d => !d)) return undefined;
      return {
        packages: planOf(l).packages,
        completed: classifyRun(l, run).state === 'completed',
        decisions: decisions.flatMap(d => (d ? [d] : [])),
      };
    } catch {
      return undefined;
    } // Missing/unreadable engine evidence is unknown, never a success.
  };
}

const OPTIONS = {
  ...COORD_OPTIONS,
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  apply: { type: 'boolean' },
  'lint-override': { type: 'string' },
  goal: { type: 'string' },
  'accept-timeout': { type: 'string' },
  console: { type: 'string' },
  accept: { type: 'string', multiple: true },
  scope: { type: 'string', multiple: true },
  risk: { type: 'string' },
  review: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  base: { type: 'string' },
  worktree: { type: 'string' },
  'task-kind': { type: 'string' },
  mode: { type: 'string' },
  repo: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  cwd: { type: 'string' },
  verbose: { type: 'boolean' },
  once: { type: 'boolean' },
  interval: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' }, // 输出本来就是 JSON；接受以兼容 superagent v1 调用方
  full: { type: 'boolean' },
  'by-engine': { type: 'string' },
  'baseline-days': { type: 'string' },
  'all-held': { type: 'boolean' },
  title: { type: 'string' },
  'request-ref': { type: 'string' },
  card: { type: 'string' },
  log: { type: 'string' },
  role: { type: 'string' },
  round: { type: 'string' },
  'author-model': { type: 'string', multiple: true },
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
  if (values['task-kind'] !== undefined)
    throw new Error(
      'job is a support operation; use quick for coding, or land --apply for an accepted run'
    );
  return { _: positionals, flags: values };
}

const print = (o: unknown): void => {
  console.log(JSON.stringify(o, null, 2));
};

/** 0 completed；1 failed；2 cancelled；3 held（等元帅/用户决策）；4 仍在运行（wait 超时或 status 查询）。 */
export const EXIT = { completed: 0, failed: 1, cancelled: 2, held: 3, running: 4 } as const;
/** 别名漂移：全局或目标 repo 的 @sa-* 别名与 tiers.json 渲染值不一致，run 拒绝启动。 */
export const EXIT_ALIAS_DRIFT = 5;
/** Temporary refusal: no run was created; the caller may retry after the launch lock is released. */
export const EXIT_ADMISSION = 75;
export const EXIT_USAGE = 64;

type IntegratedDelivery = Omit<DeliveryReceipt, 'status'> & { status: 'integrated' };
export interface Ledger {
  rejected?: string;
  gc?: GcAction[];
  plan_lint?: ReturnType<typeof lintPlan>;
  /** Explicit workflow identity; engine_hash alone may be the legacy combined UI hash. */
  workflow_hash?: string;
  engine_hash?: string;
  engine_commit?: string;
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
  delivery?: DeliveryTarget;
  delivery_result?: DeliveryOutcome | IntegratedDelivery | { status: 'blocked'; reason: string };
  workflow: string;
  console: string;
  started_at: string;
  transcript: string;
  log: string;
  /** Read-only compatibility projection for pre-P3 ledgers. */
  recoveries?: string[];
  /** Legacy control fields; ignored by execution admission. */
  progress_fp?: string;
  stalled?: number;
  /** supervise-tick 因 plan 截止已过取消 run 时写入。 */
  state?: 'failed';
  reason?: 'deadline';
  /** Read-only compatibility for historical overlay retries. */
  auto_retries?: AutoRetry[];
  /** supervise-tick 的处置记录（最近 20 条）。 */
  dispositions?: Disposition[];
  intervened?: boolean;
  /** Append-only explicit decisions; absent on historical runs with unknown coverage. */
  intervention_events?: (Pick<Disposition, 'at' | 'action' | 'ok' | 'error'> & {
    source: 'superagent' | 'cli' | 'commander';
    ask_id?: string;
    key?: string;
    reason?: string;
  })[];
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
      `ledger ${p}: not a JSON object (${
        o === null ? 'null' : Array.isArray(o) ? 'array' : typeof o
      })`
    );
  const bad = LEDGER_STRINGS.filter(k => typeof o[k] !== 'string');
  if (o.recoveries !== undefined && !Array.isArray(o.recoveries)) bad.push('recoveries');
  if (o.run_id !== run) bad.push('run_id≠file');
  if (bad.length) throw new Error(`ledger ${p}: bad ${bad.join(',')}`);
  return o as unknown as Ledger;
}

/** Ledger/GC mutations share Archon's recovery admission lock; reload under the lock. */
export function updateLedger(l: Ledger, f: (cur: Ledger) => void): void {
  const id = l.adoptions?.[0]?.from ?? l.archon_run_id;
  for (let i = 0; ; i++) {
    const k = executionAdmissionLock(home().archon, id);
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
    if (i >= 100) throw new Error(`ledger ${l.run_id}: execution admission ${id} busy`);
    waitClock.sleep(100);
  }
}

function intervention<
  T extends number | boolean | { ok: boolean; busy?: boolean; refused?: boolean },
>(
  l: Ledger,
  action: string,
  execute: () => T,
  ask?: { key: string; id?: string },
  started: () => boolean = () => true,
  reason?: string
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
          ...(reason ? { reason } : {}),
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

/** archon run 状态 → superagent 状态。environment 失败是“待决策”而非终局失败：decide retry 可 resume。 */
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
      const approval = run.metadata?.approval;
      if (approval?.nodeId.startsWith('human-'))
        return { state: 'held:human', exit: EXIT.held, node: approval.nodeId };
      return event?.startsWith('sa.human.')
        ? { state: 'held:human', exit: EXIT.held, node: run.metadata?.wait?.nodeId, event }
        : {
            state: 'held:paused',
            exit: EXIT.held,
            node: run.metadata?.approval?.nodeId ?? run.metadata?.wait?.nodeId,
          };
    }
    case 'failed':
      if (failed === 'environment')
        return { state: 'held:environment', exit: EXIT.held, node: failed };
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
/** Current evidence supersedes process history without removing it from decisionsOf. */
export const currentDecisions = (decisions: ReturnType<typeof decisionsOf>) =>
  decisions.filter(
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
                (other.tag.startsWith('gate-') && d.tag === other.tag.replace('gate-', 'diff-')))))
      )
  );
export const needsOf = (art: string, m?: string, l?: Ledger): Record<string, string>[] =>
  currentDecisions(decisionsOf(art, m, l)).flatMap(({ tag, decision }) =>
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
  const hold = holdOf(l, run, c);
  return {
    run_id: l.run_id,
    initiator: l.launcher ?? 'unknown',
    ...(hold ? blocker(l, hold) : {}),
    decisions: decisionSummary(l.run_id),
    engine:
      workflowIdentity(l) === engineHash()
        ? 'current'
        : `stale(${workflowIdentity(l)?.slice(0, 8) ?? 'unknown'})`,
    adoption: l.adoptions?.at(-1) ?? null,
    state: c.state,
    exit: c.exit,
    nodes: `${String(nodes.filter(n => n.state === 'completed').length)}/${String(
      nodes.length
    )} completed`,
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
    recoveries: l.recoveries?.length ?? 0,
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

const workflowIdentity = (l: Ledger): string | undefined => l.workflow_hash ?? l.engine_hash;
const adoptsRun = (l: Ledger, run: RunView): boolean =>
  ['failed', 'cancelled'].includes(run.status) && workflowIdentity(l) !== engineHash();

/** Read-only delivery evidence projection; ledger counters never decide execution lifecycle. */
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
  return c;
}

/** Explicit delivery retry/adoption; Archon owns admission and all execution transitions. */
function recoverRun(
  l: Ledger,
  prepare?: () => void,
  onEffect?: (effect: DecisionEffect) => void,
  reconciled?: string,
  evidenceFile?: string
): RecoverResult {
  let adopted:
    | {
        from: string;
        hash: string;
        engine_from: string | null;
        commit: string | undefined;
        carried: string[];
        dir: string;
      }
    | undefined;
  let restarted = false;
  return recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (run.status === 'completed') return 'status completed is not resumable';
      return undefined;
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
          reason: restarted
            ? 'zero_completed'
            : evidenceFile
              ? 'acceptance_continuation'
              : 'engine_stale',
          engine_commit: adopted.commit,
          carried: adopted.carried,
        });
        l.archon_run_id = to;
        l.engine_hash = adopted.hash;
        l.engine_commit = adopted.commit;
        l.workflow_hash = adopted.hash;
        l.gen_dir = adopted.dir;
        l.transcript = typeof ack.transcriptPath === 'string' ? ack.transcriptPath : '';
        l.log = typeof ack.logPath === 'string' ? ack.logPath : '';
      }
      if (adopted) saveLedger(l);
      onEffect?.({
        action: restarted ? 'restart' : adopted ? 'adopt' : 'resume',
        engine_run: l.archon_run_id,
      });
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
        if (!adoptsRun(l, run) && !(evidenceFile && ['failed', 'cancelled'].includes(run.status))) {
          if (evidenceFile) throw new Error('recovery: evidence requires terminal execution');
          // A terminal run with no completed nodes cannot resume; retain its frozen workflow.
          if (
            ['failed', 'cancelled'].includes(run.status) &&
            run.nodes &&
            !run.nodes.some(n => n.state === 'completed')
          ) {
            restarted = true;
            adopted = {
              from: run.id,
              hash: workflowIdentity(l) ?? engineHash(),
              engine_from: l.engine_hash ?? null,
              commit: l.engine_commit,
              carried: [],
              dir: l.gen_dir,
            };
            // prettier-ignore
            return ['workflow', 'run', l.workflow, '--branch', l.branch, '--supersedes', run.id,
              '--workflow-source', l.gen_dir, '--cwd', l.repo, '--detach'];
          }
          return undefined;
        }
        const metadata = readJson(join(l.gen_dir, 'engine.json')) as { fake?: boolean } | null;
        const plan = planOf(l);
        const recovery = evidenceFile
          ? (JSON.parse(readFileSync(evidenceFile, 'utf8')) as RecoveryEvidence)
          : undefined;
        if (recovery) {
          for (const [s, name] of [
            [recovery.plan, 'plan.json'],
            [recovery.policy, 'policy.json'],
            [recovery.contracts, 'accept-inputs.json'],
          ] as const)
            if (s.path !== join(l.gen_dir, name))
              throw new Error('recovery: frozen contract binding');
          if (!run.working_path) throw new Error('recovery: missing worktree');
          const load = (id: string) =>
            archonJson(
              ['workflow', 'get', id, '--verbose', '--events'],
              l.repo
            ) as unknown as AuthorRun;
          validateRecovery(recovery, plan, run.working_path, l.run_id, run.id, load);
        }
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
        const gen = generate(
          plan,
          l.run_id,
          metadata?.fake ?? false,
          l.engine_hash ?? 'unknown',
          {
            from: run.id,
            packages: carried,
            ...(recovery
              ? {
                  recovery: {
                    ...recovery,
                    admitted_by: caller(),
                    admitted_at: new Date().toISOString(),
                  },
                }
              : {}),
          },
          l.delivery
        );
        adopted = {
          from: run.id,
          hash: gen.engine_hash,
          engine_from: l.engine_hash ?? null,
          commit: gen.engine_commit,
          carried,
          dir: gen.dir,
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

/** Clock seam for deterministic ledger/recovery waits; production uses wall time. */
export const waitClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): void => {
    Bun.sleepSync(ms);
  },
};

/** Observe engine state and inbox; continuation is an explicit engine action. */
export function waitRun(l: Ledger, timeoutS: number, who = caller(true)): Record<string, unknown> {
  const deadline = waitClock.now() + timeoutS * 1000;
  for (;;) {
    const inbox = coord().surfaced(who);
    if (inbox.length) return { run_id: l.run_id, state: 'inbox', exit: EXIT.held, inbox };
    const run = getRun(l.archon_run_id, l.repo);
    const c = classifyRun(l, run);
    if (c.state === 'owner_lost')
      return { ...summary(l, run, c), action: `superagent recover ${l.run_id}` };
    const left = (deadline - waitClock.now()) / 1000;
    if (c.exit !== EXIT.running || left <= 0) return summary(l, run, c);
    waitNotification(l.archon_run_id, l.repo, left);
  }
}

/** Materialize and validate the ordinary plan contract before using the run launcher. */
export function quickPlan(a: Args): string {
  if (a.flags.card !== undefined && a.flags.goal !== undefined)
    throw new Error('quick requires either --goal <text> or --card <file>, not both');
  // Snapshot the full brief into the existing plan so later edits cannot change the run.
  const card = a.flags.card !== undefined ? readFileSync(a.flags.card, 'utf8') : undefined;
  const goal =
    a.flags.card !== undefined
      ? `执行卡片 ${basename(a.flags.card)}，完整要求见备注。`
      : a.flags.goal;
  if (!goal?.trim() || (card !== undefined && !card.trim()))
    throw new Error('quick requires --goal <text> or a non-empty --card <file>');
  if (!a.flags.accept?.length || a.flags.accept.some(cmd => !cmd.trim()))
    throw new Error('quick requires at least one non-empty --accept <cmd>');
  const acceptTimeout = Number(a.flags['accept-timeout'] ?? 180);
  if (!Number.isSafeInteger(acceptTimeout) || acceptTimeout <= 0)
    throw new Error('quick --accept-timeout must be a positive integer of seconds');
  const consoleClient = a.flags.console;
  if (consoleClient !== undefined && consoleClient !== 'codex' && consoleClient !== 'claude')
    throw new Error('quick --console must be codex|claude');
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
    ...(a.flags['request-ref'] !== undefined ? { request_ref: a.flags['request-ref'] } : {}),
    repo: git('rev-parse', '--show-toplevel'),
    base_ref: a.flags.base ?? git('symbolic-ref', '--short', 'HEAD'),
    ...(consoleClient !== undefined ? { console: consoleClient } : {}),
    // An explicitly requested independent review must never land as DEGRADED_PASS.
    ...(a.flags.review ? { mode: 'strict' as const } : {}),
    budget: { weighted_tokens: 0, unlimited_tokens: true },
    packages: [
      {
        id: 'quick',
        title: a.flags.card !== undefined ? basename(a.flags.card) : goal,
        goal,
        ...(card !== undefined ? { notes: card } : {}),
        size,
        risk,
        milestone: 'm1',
        scope: { write: a.flags.scope ?? ['**/*'] },
        accept: a.flags.accept.map(cmd => ({
          cmd,
          timeout_s: acceptTimeout,
          cache: !a.flags['no-cache'],
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

function preflight(): void {
  if (installMode() === 'worker')
    throw new Error('preflight: mode=worker; run requires the controller install');
  const { sa } = home();
  const fs = statfsSync(sa);
  console.warn(
    JSON.stringify({
      code: 'superagent.disk_observed',
      free_gb: (fs.bavail * fs.bsize) / 2 ** 30,
      path: sa,
    })
  );
}

function startRun(planPath: string, a: Args): number {
  if (process.env.DATABASE_URL)
    console.error('run: overlap check skipped: DATABASE_URL is set (SQLite status unavailable)');
  const run = newRunId();
  let phase: 'preflight' | 'admission' | 'engine' = 'preflight';
  let release: (() => void) | undefined;
  let mode: 'controller' | 'worker' | 'unknown' = 'unknown';
  let plan_lint: ReturnType<typeof lintPlan> | undefined;
  try {
    mode = installMode();
    preflight();
    const plan = loadPlan(planPath);
    const repo = repoScope(plan.repo),
      scope = runScope({ run_id: run, repo: plan.repo });
    const who = caller();
    const default_contact = coord().scoped(repo, () => {
      if (!coord().owner(repo).owner && !coord().owner(repo).conflicts.length)
        coord().claim(repo, who);
      return coord().owner(repo).owner;
    });
    return coord().scoped(scope, () => {
      const controller = coord().claim(scope, who).controller;
      return coord().mutate(scope, who, () => {
        plan_lint = lintPlan(plan, a.flags['lint-override']);
        if (plan_lint.rejected)
          throw new Error(`preflight: plan lint: ${plan_lint.warnings.join('; ')}`);
        phase = 'admission';
        const admission = admitRun();
        if (!admission.ok) {
          print({
            ok: false,
            phase,
            status: 'rejected',
            exit: EXIT_ADMISSION,
            reason: admission.reason,
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
        const overlap_warnings = (process.env.DATABASE_URL ? [] : ledgers()).flatMap(l => {
          try {
            if (
              'error' in l ||
              l.state === 'failed' ||
              repoScope(l.repo).id !== repo.id ||
              ['completed', 'failed', 'cancelled'].includes(coord().d.status(l))
            )
              return [];
            const previous = loadPlan(l.plan).packages.flatMap(p => p.scope.write);
            const prefix = (glob: string) => glob.split(/[*?{[]/, 1)[0];
            const paths = plan.packages
              .flatMap(p => p.scope.write)
              .filter(path =>
                previous.some(
                  other =>
                    path === other ||
                    new Bun.Glob(other).match(path) ||
                    new Bun.Glob(path).match(other) ||
                    (prefix(path) !== path &&
                      prefix(other) !== other &&
                      (prefix(path).startsWith(prefix(other)) ||
                        prefix(other).startsWith(prefix(path))))
                )
              );
            return paths.length ? [{ run_id: l.run_id, paths: [...new Set(paths)] }] : [];
          } catch (error) {
            console.error(`run: overlap check ${l.run_id}: ${String(error)}`);
            return [];
          }
        });
        const launchBranch = lastJson(checked.stdout.toString())?.launch_branch;
        const delivery =
          typeof launchBranch === 'string' && launchBranch ? captureDelivery(plan.repo) : undefined;
        phase = 'engine';
        const budget = budgetState(loadTiers(), plan.mode);
        const gen = generate(plan, run, a.flags.fake ?? false, undefined, undefined, delivery);
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
          engine_commit: gen.engine_commit,
          workflow_hash: gen.engine_hash,
          archon_run_id: '',
          plan: planPath,
          gen_dir: gen.dir,
          repo: plan.repo,
          branch,
          launch_branch: typeof launchBranch === 'string' ? launchBranch : undefined,
          delivery,
          workflow: gen.workflow,
          console: plan.console ?? 'claude',
          started_at: new Date().toISOString(),
          transcript: '',
          log: '',
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
          default_contact,
          overlap_warnings,
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

function health(cwd?: string, verbose = false): number {
  const hooks = Bun.spawnSync(['git', 'config', '--global', '--path', 'core.hooksPath'], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  const hooksPath = hooks.stdout.toString().trim();
  if (hooks.exitCode === 0 && hooksPath) {
    try {
      const unexpected = readdirSync(hooksPath).filter(
        name => !name.startsWith('.') && !['pre-commit', 'pre-push'].includes(name)
      );
      if (unexpected.length)
        console.warn(
          `health: ${hooksPath}: ${unexpected.join(', ')}；可能被 lefthook/husky install 写入全局 hooksPath`
        );
    } catch (error) {
      console.warn(`health: 无法读取全局 hooksPath ${hooksPath}: ${(error as Error).message}`);
    }
  }
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
  const upstreamFiles = upstreamDiff ? upstreamDiff.split('\n') : [];
  const upstreamClean = clean.exitCode === 0 && upstreamFiles.length === 0;
  const worker = codexWorkerProblem();
  const ok = doctor.code === 0 && upstreamClean && !drift.length && !worker;
  print({
    ok,
    mode,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    upstream_clean: upstreamClean,
    upstream_file_count: upstreamFiles.length,
    ...(!upstreamClean
      ? { reason: clean.exitCode === 0 ? 'upstream_dirty' : 'upstream_check_failed' }
      : {}),
    ...(verbose ? { upstream_files: upstreamFiles } : {}),
    codex_worker: worker ?? 'ok',
  });
  return ok ? 0 : drift.length ? EXIT_ALIAS_DRIFT : 1;
}

function resumeRun(
  l: Ledger,
  reconciled?: string,
  action = 'recover',
  evidenceFile?: string
): number {
  let started = false;
  // prepare runs under the recovery lock only after admission checks have passed.
  const res = intervention(
    l,
    action,
    () => recoverRun(l, () => (started = true), undefined, reconciled, evidenceFile),
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
const pastDeadline = (l: Ledger): boolean => {
  const deadline = planOf(l).deadline;
  return deadline !== undefined && Date.now() > Date.parse(deadline);
};
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
  prepare?: () => void,
  onEffect?: (effect: DecisionEffect) => void
): RecoverResult {
  const m = retryScope(l, node);
  if (!attemptable(l, m))
    throw new Error(`decide retry: ${node} escalated; fix on ${l.branch} or start a new run`);
  return recoverRun(
    l,
    () => {
      advanceExecutionAttempt(attemptPath(l.gen_dir, m));
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
  onEffect?: (effect: DecisionEffect) => void
): RecoverResult =>
  scopedRetry(l, c, c.node ?? '')
    ? retryGate(l, c.node ?? '', prepare, onEffect)
    : recoverRun(l, prepare, onEffect);

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
      const r = run.metadata?.approval
        ? approveRun(l)
        : signalHuman(run, { decision: 'approve' }, log, l.repo);
      print({ run_id: l.run_id, ...r });
      return r.ok ? 0 : 1;
    });
  }
  if (action === 'reject') {
    const ok = intervention(
      l,
      'cancel',
      () => cancelRun(l.archon_run_id, run.status, l.repo),
      undefined,
      undefined,
      'rejected'
    );
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
function brief(l: Ledger, json = false): number {
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  const s = summary(l, run, c);
  const art = artifactsOf(run);
  if (json) {
    print({
      ...s,
      execution: (run.nodes ?? []).flatMap(n =>
        n.execution
          ? [
              {
                node: n.nodeId,
                state: n.state,
                execution_ref: n.execution.path,
                policy: {
                  provider: n.execution.binding.provider,
                  model: n.execution.binding.model,
                  effort: n.execution.binding.effort,
                  tier: n.execution.binding.tier,
                },
                attempt: n.execution.attempt,
                timing: n.execution.timing,
                tokens: n.execution.spend.tokens,
              },
            ]
          : []
      ),
    });
    return c.exit;
  }
  const lines = [
    `${l.run_id} ${c.state}${c.node ? ` @${c.node}` : ''} nodes ${String(s.nodes)} branch ${
      l.branch
    }`,
  ];
  const ownership = coord().owner(runScope(l));
  lines.push(
    `controller: ${JSON.stringify(ownership.owner)} ${ownership.presence.state}; inbox: ${String(
      coord().pending(ownership.scope)
    )}`
  );
  const inbox = coord().inbox(caller(true));
  if (inbox.length) lines.push(`inbox: ${inbox.map(m => m.id).join(' ')}; superagent inbox`);
  lines.push(`engine: ${String(s.engine)}`);
  if (typeof s.next === 'string') lines.push(`blocked: ${String(s.reason)}；next: ${s.next}`);
  lines.push(`initiator: ${JSON.stringify(s.initiator)}`);
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
      `${f.slice(0, -5)}: ${decisionVerdict(d)}${d?.reason ? ` (${d.reason})` : ''} debt=${String(
        d?.debt.length ?? 0
      )}`
    );
  }
  if (l.reason === 'deadline') lines.push('plan 截止已过，已取消');
  if (typeof s.error === 'string') lines.push(`error: ${s.error}`);
  if (Array.isArray(s.land)) lines.push(...(s.land as string[]));
  for (const n of needsOf(art, undefined, l).slice(0, 3))
    lines.push(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
  lines.push(
    `evidence: ${art}`,
    `recoveries: ${String(l.recoveries?.length ?? 0)} auto_retries: ${String(
      l.auto_retries?.length ?? 0
    )}`
  );
  console.log(lines.slice(0, 20).join('\n'));
  return c.exit;
}

/** 在 run 的 worktree 里跑 plan 的验收命令（同 verify 节点脚本），退出码即结果。 */
function acceptRun(
  l: Ledger,
  pkg: string | undefined,
  cwd?: string,
  cacheArt?: string,
  report = true
): number {
  const run = archonJson(
    ['workflow', 'get', l.archon_run_id, '--verbose', '--events'],
    l.repo
  ) as unknown as RunView & { events: Parameters<typeof budgetUsage>[0] };
  if (!run.working_path) throw new Error(`accept: run ${l.run_id} has no worktree`);
  const plan = planOf(l);
  if (pkg && !plan.packages.some(p => p.id === pkg))
    throw new Error(`accept: unknown package ${pkg}`);
  const art = cacheArt ?? artifactsOf(run);
  const contracts = readJson(join(l.gen_dir, 'accept-inputs.json')) as Record<string, string>[];
  if (!Array.isArray(contracts)) throw new Error('accept: missing generated acceptance contract');
  const selected = pkg
    ? contracts.filter(c => c.tag === `verify-${pkg}`)
    : [...new Set(contracts.map(c => c.milestone))].map(m =>
        [...contracts]
          .reverse()
          .find(
            c =>
              c.milestone === m &&
              c.tag.startsWith('diff-') &&
              evidenceJson(l, art, `${c.tag}.json`)
          )
      );
  if (!selected.length || selected.some(c => !c))
    throw new Error('accept: missing acceptance evidence');
  const resolved = Bun.spawnSync([process.execPath, join(import.meta.dir, 'role-context.ts')], {
    stdin: Buffer.from(JSON.stringify({ run, contracts: selected, art })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (resolved.exitCode !== 0)
    throw new Error(`accept: input resolution failed: ${resolved.stderr.toString()}`);
  const { inputs: resolvedInputs, events_file } = JSON.parse(resolved.stdout.toString()) as Awaited<
    ReturnType<typeof resolveAcceptanceContext>
  >;
  mkdirSync(art, { recursive: true });
  let code = 0;
  for (const inputs of resolvedInputs) {
    const prior = evidenceJson(l, art, `${inputs.tag}.json`) as Accept | undefined;
    const gate = evidenceJson(l, art, `${inputs.tag.replace('diff-', 'gate-')}.json`);
    const p = Bun.spawnSync(
      [process.execPath, join(l.gen_dir, '.archon', 'scripts', 'sa-check.ts')],
      {
        cwd: cwd ?? run.working_path,
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(inputs).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v])
          ),
          INPUTS_TAG: `accept-${inputs.tag}`,
          INPUTS_EVENTS_FILE: events_file,
          WORKFLOW_ID: run.id,
          ARTIFACTS_DIR: art,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const out = lastJson(p.stdout.toString()) as (Record<string, unknown> & Accept) | undefined;
    const same =
      !!out?.contract_hash &&
      out.contract_hash === prior?.contract_hash &&
      !!out.diff_hash &&
      out.diff_hash === prior.diff_hash &&
      decisionOf(gate)?.kind === 'debt';
    const reviews = same
      ? (evidenceJson(l, art, `${inputs.tag.replace('diff-', 'gate-')}.review.json`) as
          | Review
          | undefined)
      : undefined;
    let { decision } = deliveryDecision({
      rechecks: out ? [out] : [],
      approved: { check: prior, decision: decisionOf(gate) },
      risk: out?.risk ?? inputs.risk,
      strict: plan.mode === 'strict',
      ...(reviews ? { reviews: [reviews] } : {}),
    });
    const limits = plan.budget;
    const used = budgetUsage(
      run.events,
      loadTiers().policy.budget_floor.S,
      readPolicyAttempts(art)
    );
    const reason = budgetReason(limits, used, false);
    if (p.exitCode !== 0)
      decision = { ...decision, kind: 'block', reason: out?.reason ?? 'engine_suspect' };
    if (reason)
      console.warn(JSON.stringify({ code: 'superagent.budget_observed', reason, used, limits }));
    const ok = ['advance', 'debt'].includes(decision.kind);
    if (report)
      print(
        out
          ? {
              ...out,
              decision,
              ok,
              ...(reason ? { budget_advisory: reason } : {}),
            }
          : { ok: false, error: tail(p.stderr.toString()) }
      );
    if (!ok) code = 1;
  }
  return code;
}

/** Plan and quick share real acceptance and the original audited landing admission. */
export function finalizeDelivery(id: string, automatic = false, who: Identity = caller()) {
  assertCommander();
  if (automatic && presence(who, home().sa).state !== 'online')
    throw new Error('coord: delivery caller is not verifiably online');
  const l = loadLedger(coord().resolveRun(id)?.run_id ?? id);
  const deliver = () =>
    control(
      l,
      controller => {
        if (!l.delivery)
          throw new Error('delivery: unknown legacy target; use a new quick/run contract');
        const target = l.delivery;
        const run = getRun(l.archon_run_id, l.repo),
          art = artifactsOf(run);
        const land = evidenceJson(l, art, 'land.json') as Land | undefined;
        if (!land) throw new Error('delivery: missing generated land evidence');
        const contract = createHash('sha256')
          .update(readFileSync(join(l.gen_dir, 'accept-inputs.json')))
          .digest('hex');
        let receipt: ReturnType<typeof applyLand>;
        intervention(l, 'land', () => {
          receipt = applyLand(run, land, cwd => acceptRun(l, undefined, cwd, art, false), {
            repo: l.repo,
            base_ref: planOf(l).base_ref,
            delivery: {
              task: l.run_id,
              target,
              contract,
              evidence: art,
              title: planOf(l)
                .packages.map(p => p.title)
                .join('; '),
              receipt: join(art, 'delivery.json'),
            },
          });
          return 0;
        });
        updateLedger(l, cur => {
          cur.controller = controller;
          cur.delivery_result =
            receipt?.status === 'manual_push' ? { ...receipt, status: 'integrated' } : receipt;
        });
        return receipt;
      },
      who,
      automatic ? (l.controller?.generation ?? 0) : undefined
    );
  return coord().mutate(repoScope(l.repo), who, deliver);
}

// supervise-tick：无人值守巡检（cron/launchd 周期调用 `superagent supervise-tick`）：唤醒到期的事件门、恢复 owner-lost，
// 其余非终态按 HOLD_POLICY 处置；需要拍板的投到 agent-supervisor（iPhone 提醒事项：勾选=是、删除=否），按回答执行。
export const ANSWERS = ['pending', 'yes', 'no', 'expired', 'superseded'];
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };
type DecisionEffect =
  | { action: 'approve' | 'reject' | 'resume' | 'adopt' | 'restart'; engine_run: string }
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
    case 'restart':
      action = '已提交同分支重启（保留旧run证据）';
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
  return `run=${name(run)}；节点=${name(node) || '未指定'}；答复=${
    answer === 'yes' ? '是' : '否'
  }；${action}；去向=${name(effect.engine_run)}；结果=动作已受理（不代表后续验收通过）`;
}
interface AnswerReceipt {
  key: string;
  body: string;
  at?: string;
  delivery?: 'pending' | 'sent' | 'failed';
  stage?: 'received' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  effect?: DecisionEffect;
  terminal_before?: string;
  error?: string;
}
interface AnswerIntent {
  answer: 'yes' | 'no';
  node: string;
  engine_run: string;
  effect?: DecisionEffect;
  terminal_before?: string;
}
interface DecisionContext {
  request_key: string;
  source: string;
  task_id: string;
  initiator: string;
  action: string;
  target: string;
  reason: string;
  recommendation: { choice: 'yes' | 'no'; reason: string };
  consequences: { yes: string; no: string };
}
type Ask = BaseAsk & {
  receipt?: AnswerReceipt;
  decision?: AnswerIntent;
  context?: DecisionContext;
};
export type Asks = Partial<Record<string, Ask>>;

function decisionSummary(run: string): Asks | { error: string } {
  try {
    return asksOf(run);
  } catch (e) {
    return { error: tail((e as Error).message, 200) };
  }
}
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

export function supervisor(args: string[]): string {
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
  const run = getRun(l.archon_run_id, l.repo);
  a.decision = { answer, node, engine_run: l.archon_run_id, terminal_before: terminalFact(run) };
  a.receipt = {
    key: `${a.id ?? 'unknown'}:${answer}:received`,
    stage: 'received',
    body: `run=${l.run_id}；答复=${answer}；任务已收到，执行结果尚未确认`,
    delivery: 'pending',
    at: new Date().toISOString(),
  };
  saveAsks(asks);
  const key = Object.entries(asks).find(([, value]) => value === a)?.[0];
  if (key) deliverReceipt(l, key, a, asks);
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
      if (a.receipt?.stage === 'received') {
        a.receipt.stage = 'unknown';
        a.receipt.key += ':unknown';
        a.receipt.body += '；执行效果未确认，请检查引擎证据，不会自动重放';
        a.receipt.delivery = 'pending';
        saveAsks(asks);
        deliverReceipt(l, key, a, asks);
      }
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
  a.receipt = {
    key: new Bun.CryptoHasher('sha256').update(`${a.id ?? key}:${answer}`).digest('hex'),
    body: decisionReceipt(l.run_id, node, answer, effect),
    stage: 'executing',
    effect,
    delivery: 'pending',
    terminal_before: a.decision?.terminal_before,
    at: new Date().toISOString(),
  };
  delete a.decision;
  saveAsks(asks);
  deliverReceipt(l, key, a, asks);
}

const terminalFact = (run: RunView): string =>
  `${run.id}:${run.status}:${run.completed_at ?? run.last_activity_at ?? ''}`;
function deliverReceipt(l: Ledger, key: string, a: Ask, asks: Asks): void {
  const r = a.receipt;
  if (!r?.stage || !a.id) return; // Legacy receipts have no execution binding.
  try {
    if (r.effect && r.stage === 'executing') {
      const run = getRun(r.effect.engine_run, l.repo);
      if (run.id !== r.effect.engine_run) throw new Error('receipt execution identity mismatch');
      const stage =
        r.effect.action === 'reject'
          ? run.status === 'cancelled'
            ? 'failed'
            : undefined
          : run.status === 'completed'
            ? 'succeeded'
            : run.status === 'failed' || run.status === 'cancelled'
              ? 'failed'
              : undefined;
      if (stage && terminalFact(run) !== r.terminal_before) {
        r.stage = r.effect.action === 'reject' ? 'failed' : stage;
        r.key += ':terminal';
        r.body +=
          r.effect.action === 'reject'
            ? '；用户拒绝：引擎已取消，被拒操作未执行'
            : `；执行=${r.effect.engine_run}；引擎结果=${stage}（不代表已合入或部署）`;
        r.delivery = 'pending';
        r.at = new Date().toISOString();
        saveAsks(asks);
      }
    }
    if (r.delivery === 'sent') return;
    supervisor([
      'ask-ack',
      a.id,
      '--receipt-json',
      JSON.stringify({
        key: r.key,
        request_key: a.context?.request_key ?? key,
        stage: r.stage,
        body: r.body,
      }),
    ]);
    r.delivery = 'sent';
    delete r.error;
  } catch (e) {
    r.delivery = 'failed';
    r.error = tail((e as Error).message, 200);
  }
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
  asks: Asks,
  context: (question: string) => DecisionContext
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
        conflict: `ask ${key}: ${String(found.length)} supervisor asks match${
          note ? `; ${note}` : ''
        }`,
      };
    a = asks[key] = found.length ? { ...a, id: found[0].id, status: 'pending' } : undefined;
  }
  if (!a) {
    asks[key] = { status: 'unknown' };
    saveAsks(asks);
    const title = text();
    const ctx = context(title);
    asks[key] = { status: 'unknown', context: ctx };
    saveAsks(asks);
    const marker = `；${askMarker(key)}`;
    const question = title.endsWith(marker)
      ? title
      : askName(title, 200 - Array.from(marker).length) + marker;
    const id = supervisor([
      'ask',
      '--question',
      question,
      '--ttl-hours',
      String(hours),
      '--context-json',
      JSON.stringify(ctx),
    ]);
    asks[key] = { id, status: 'pending', context: ctx };
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
  if (
    !intervention(
      l,
      'cancel',
      () => cancelRun(l.archon_run_id, run.status, l.repo),
      undefined,
      undefined,
      'deadline'
    )
  )
    return { ...x, ok: false };
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
  const w =
    run.metadata?.wait ??
    (run.metadata?.approval
      ? { nodeId: run.metadata.approval.nodeId, event: undefined, resumeAt: planOf(l).deadline }
      : undefined);
  if (!w) throw new Error(`run ${l.run_id}: held:human without engine gate metadata`);
  const key = askKey(l.run_id, 'signoff', holdEpisode(l, run, classifyRun(l, run)));
  const base = { run_id: l.run_id, event: w.event };
  // Native approval and legacy event gates share the plan's absolute deadline.
  if (pastDeadline(l)) return expireRun(l, run, asks, base);
  const p = pollAsk(
    key,
    () => decisionQuestion(l, run, classifyRun(l, run), 'signoff'),
    ttlHours(Date.parse(w.resumeAt ?? '')),
    asks,
    question => decisionContext(l, run, classifyRun(l, run), 'signoff', key, question)
  );
  if ('conflict' in p)
    return { ...base, action: 'none', ok: false, reason: `${p.conflict}; decide approve|reject` };
  const b = { ...base, ...(p.note ? { reason: p.note } : {}) };
  if (p.asked) return { ...b, action: 'ask', ok: true, ask: p.asked };
  if (p.a.status === 'yes' && pastDeadline(l)) return expireRun(l, run, asks, base);
  return answerAction(l, key, p.a, () => {
    // 持久意图先于动作；失败交 reconcile 判定，不重放副作用。
    if (p.a.status === 'yes') {
      beginAnswer(l, w.nodeId, p.a, 'yes', asks);
      const log = join(l.gen_dir, `signal-${w.nodeId}.log`);
      const r = run.metadata?.approval
        ? approveRun(l)
        : signalHuman(run, { decision: 'approve', ask: p.a.id }, log, l.repo);
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
 * 已记录的执行意图不重放；pending/expired 不动。
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
    () => decisionQuestion(l, run, c, hold),
    ttlHours(Date.parse(planOf(l).deadline ?? '')),
    asks,
    question => decisionContext(l, run, c, hold, key, question)
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
            ? recoverRun(l, undefined, onEffect)
            : p.yes === 'review'
              ? retryGate(l, `review-${(c.node ?? '').slice(5)}`, undefined, onEffect)
              : retry(l, c, undefined, onEffect);
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
          const run = getRun(l.archon_run_id, l.repo);
          if (!['completed', 'cancelled'].includes(run.status))
            archonDetached(
              ['workflow', 'wake', l.archon_run_id, '--json'],
              join(sa, 'wake.log'),
              l.repo
            );
          if (!(asks instanceof Error)) {
            for (const [key, a] of Object.entries(asks))
              if (key.startsWith(`${l.run_id}:`) && a) deliverReceipt(l, key, a, asks);
            if (reconcileAnswers(l, asks, out)) return undefined;
          }
          const action = dispose(l, asks, observed, run);
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
      const r = pollAsk(
        key,
        () => title,
        MAX_TTL_H,
        asks as Asks,
        () => coordinationContext(key)
      );
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
export function holdOf(l: Ledger, run: RunView, c: Classified): Hold | undefined {
  if (c.state === 'held:engine_suspect') return pastDeadline(l) ? 'deadline' : 'engine_suspect';
  if (c.state === 'held:human') return 'signoff';
  const h: Hold | undefined =
    c.state === 'held:gate'
      ? reasonHold(nodeReason(l, run, c))
      : c.state === 'held:environment'
        ? 'environment'
        : c.state === 'held:paused'
          ? run.metadata?.approval
            ? 'approval'
            : 'paused'
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

/** Entry timestamp is stable across polls; node distinguishes milestone signoffs. */
function holdEpisode(l: Ledger, run: RunView, c: Classified): string {
  return `${c.node ?? run.metadata?.wait?.nodeId ?? ''}@${
    run.metadata?.wait?.waitingSince ??
    run.completed_at ??
    run.last_activity_at ??
    run.started_at ??
    l.started_at
  }`;
}
function coordinationContext(key: string): DecisionContext {
  const message = coord()
    .messages()
    .find(m => key.startsWith(`coord:${m.id}:`));
  if (!message) throw new Error('coord decision context missing');
  return {
    request_key: key,
    source: 'superagent',
    task_id: message.id,
    initiator: JSON.stringify(message.sender),
    action: 'claim takeover',
    target: JSON.stringify(message.scope),
    reason: '交接未确认，需决定是否转移归属',
    recommendation: { choice: 'no', reason: '未明确授权前保留现有归属' },
    consequences: { yes: '转移该scope归属给交接发起者', no: '保留现有归属，继续等待' },
  };
}
function decisionContext(
  l: Ledger,
  run: RunView,
  c: Classified,
  hold: Hold,
  key: string,
  question: string
): DecisionContext {
  const p = HOLD_POLICY[hold];
  if (p.do !== 'ask' && p.do !== 'signoff') throw new Error(`not actionable: ${hold}`);
  return {
    request_key: key,
    source: 'superagent',
    task_id: l.run_id,
    initiator: l.launcher ? JSON.stringify(l.launcher) : 'unknown',
    action: p.do === 'signoff' ? 'approve' : p.yes,
    target: `${l.repo}:${run.id}:${c.node ?? run.metadata?.approval?.nodeId ?? run.metadata?.wait?.nodeId ?? 'unknown'}`,
    reason: question,
    recommendation: { choice: 'no', reason: '需操作员确认本次审批；未答复保持阻断' },
    consequences: {
      yes: p.yesText,
      no: '终止整个run（保留证据）',
    },
  };
}
function blocker(l: Ledger, hold: Hold): { reason: string; next: string } | undefined {
  const p = HOLD_POLICY[hold];
  return p.do === 'blocked'
    ? {
        reason: `${hold}: ${p.text}`,
        next: `${p.next}；superagent brief ${l.run_id}；条件修复后显式 superagent decide ${l.run_id} retry（红线不变）`,
      }
    : undefined;
}
/** 只展示注册原因、闭集枚举与数字；将军/评审自由文本只在 brief 中读取。 */
export function decisionQuestion(l: Ledger, run: RunView, c: Classified, hold: Hold): string {
  const blocked = blocker(l, hold);
  if (blocked) return `${blocked.reason}；${blocked.next}`;
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
  const progress = `已完成${String(
    (run.nodes ?? []).filter(n => n.state === 'completed').length
  )}/${String(workflowRoles(l)?.size ?? run.nodes?.length ?? 0)}节点`;
  let detail = reason;
  const compact = reason;
  if (hold === 'approval') detail = '等待批准';
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
    detail = `验收/评审${
      verdict === 'pass'
        ? '通过'
        : verdict === 'fix'
          ? '需修复'
          : verdict === 'escalate'
            ? '需升级处理'
            : '证据缺失'
    }`;
  }
  return askQuestion(
    hold,
    names,
    [`${detail}；${progress}`, `${compact}；${progress}`],
    () => ['', ''],
    askMarker(askKey(l.run_id, hold, holdEpisode(l, run, c)))
  );
}
/** 只投影引擎状态与明确决定；owner-lost 保留证据，恢复必须由操作员发起。 */
function dispose(
  l: Ledger,
  asks: Asks | Error,
  observed: HoldSignal[],
  run: RunView
): Action | undefined {
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
    return {
      run_id: l.run_id,
      action: 'none',
      ok: false,
      state: c.state,
      next: `superagent recover ${l.run_id}`,
    };
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
          : p.do === 'ask'
            ? askHold(l, run, c, hold, p, need(), extra)
            : p.do === 'blocked'
              ? {
                  run_id: l.run_id,
                  action: 'none',
                  ok: true,
                  held: true,
                  state: c.state,
                  ...blocker(l, hold),
                }
              : undefined;
    if (p.do === 'blocked' && x && l.dispositions?.at(-1)?.error !== x.next)
      record(l, hold, { ...x, action: 'blocked', ok: false, error: x.next });
    row.disposed ||= !!x && x.action !== 'none' && x.ok;
    if (!(asks instanceof Error) && !['ask', 'signoff', 'expire'].includes(p.do))
      supersedeAsks(asks, l.run_id);
    return x && record(l, hold, x);
  };
  const hold = holdOf(l, run, c);
  if (!hold && !(asks instanceof Error)) supersedeAsks(asks, l.run_id);
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
    bump(n, 'recoveries', l.recoveries?.length ?? 0);
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
export function report(engine?: { commit: string; baselineDays: number }): Record<string, unknown> {
  // F-02：坏 ledger 不进报表计算，单列在 unreadable，其余照常。
  const all = ledgers();
  const r = buildReport(
    all.flatMap(l => ('error' in l ? [] : [l])),
    engine
  );
  if (engine) return { ...r, unreadable_ledgers: all.filter(l => 'error' in l).length };
  const bad = all.flatMap(l => ('error' in l ? [`${l.run_id}: ${l.error}`] : []));
  return {
    ...r,
    decisions: loadAsks(),
    recorded_blockers: all.flatMap(l =>
      'error' in l
        ? []
        : (l.dispositions ?? [])
            .filter(d => d.action === 'blocked')
            .map(d => ({ run_id: l.run_id, initiator: l.launcher ?? 'unknown', ...d }))
    ),
    runs: all.length,
    unreadable: [...(r.unreadable as string[]), ...bad],
  };
}

const USAGE =
  'usage: superagent <owner [path|run]|claim [path|run] [--takeover --reason text]|release [path|run]|handoff --to path|run --kind bug|task|question|takeover-request --title t --body-file md|inbox [--all|--ack id accepted|rejected|done --note text]|plan check <file>|run <plan.json> [--fake] [--lint-override reason]|quick (--goal <text>|--card <file>) --accept <cmd> [--accept-timeout s] [--console codex|claude] [--accept <cmd>...] [--scope <glob>...] [--risk G0|G1|G2] [--review] [--no-cache] [--base <ref>] [--repo <path>]|wait <run> [--timeout s]|status|brief|land <run> [--apply]|resume|cancel <run> [--reason label]|recover <run> [--evidence file.json]|decide <run> approve|reject|retry [--pkg id --hint text]|decide --all-held retry|accept <run> [--pkg id]|report [--by-engine commit [--baseline-days N]]|memory|quota|usage [--since YYYYMMDD] [--refresh]|console start|stop|status|url [--open] (web alias)|gc [--dry-run]|scratch-clean [--session id] [--dry-run]|supervise-tick|health [--cwd repo] [--verbose]|board [run] [--once] [--interval s] [--limit n]|models [--mode mode]|job exec --title t [--card p] [--log p] [--role r] [--mode mode] [--worktree branch --base ref] -- cmd...|job clean id|jobs [--all]> (every verb accepts --json)';

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
    console.log(
      USAGE +
        `\ncontinuous intake: ${INTAKE_USAGE} [arguments] [--repo path]; context|resume [bytes] [cursor]; backlog [parent-task]`
    );
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
    case 'intake': {
      const command = need(target, INTAKE_USAGE);
      const argument = a._.at(2);
      const raw: unknown = ['receive', 'apply'].includes(command)
        ? JSON.parse(
            argument === '-'
              ? readFileSync(0, 'utf8')
              : readFileSync(need(argument, 'intake receive|apply <payload.json|->'), 'utf8')
          )
        : undefined;
      const envelope = raw !== null && typeof raw === 'object' && 'input' in raw ? raw : undefined;
      const input = envelope?.input;
      const repo = resolve(
        input !== null &&
          typeof input === 'object' &&
          'repo' in input &&
          typeof input.repo === 'string'
          ? input.repo
          : (a.flags.repo ?? process.cwd())
      );
      if (
        input !== undefined &&
        (input === null || typeof input !== 'object' || !('repo' in input) || input.repo !== repo)
      )
        throw new Error('intake: input.repo must be the absolute repository path');
      const store = new Intake(intakeRoot(home().sa, repo));
      const tasks = store.list();
      const readEvidence = intakeEvidence(repo);
      const view = (id: string): unknown => {
        const task = tasks.find(t => t.id === id);
        if (!task) throw new Error('intake: unknown task');
        return { ...task, completion: completion(task, readEvidence, tasks) };
      };
      switch (command) {
        case 'receive':
          print(store.receive(input));
          break;
        case 'apply': {
          const result = store.apply(
            input,
            envelope && 'actions' in envelope ? envelope.actions : undefined
          );
          print(result);
          return result.results?.some(r => r.status !== 'accepted') ? EXIT.held : 0;
        }
        case 'list':
          print(store.list().map(t => ({ id: t.id, revision: t.revision, repo: t.repo })));
          break;
        case 'input':
          print(
            store.input(
              need(argument, 'intake input <source> <session> <message>'),
              need(a._[3], 'intake input <source> <session> <message>'),
              need(a._[4], 'intake input <source> <session> <message>')
            )
          );
          break;
        case 'show':
          print(view(need(argument, 'intake show <task-id>')));
          break;
        case 'backlog':
          print(store.backlog(repo, readEvidence, argument));
          break;
        case 'context':
        case 'resume':
          print(store.context(repo, argument === undefined ? 8192 : Number(argument), a._[3]));
          break;
        default:
          throw new Error(`usage: superagent ${INTAKE_USAGE}`);
      }
      return 0;
    }
    case 'models': {
      refreshBudgetQuota();
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
                const r = pollAsk(
                  key,
                  () => title,
                  MAX_TTL_H,
                  asks,
                  () => coordinationContext(key)
                );
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
    case 'plan': {
      if (target !== 'check' || a._.length !== 3)
        throw new Error('usage: superagent plan check <file>');
      const plan = loadPlan(a._[2]);
      const plan_lint = lintPlan(plan, a.flags['lint-override']);
      if (plan_lint.rejected)
        throw new Error(`preflight: plan lint: ${plan_lint.warnings.join('; ')}`);
      print({ ok: true, plan_lint });
      return 0;
    }
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
      // Resolve before waiting: a background shell may exit and reparent this process.
      const who = caller(true);
      const l = ledger(),
        s = waitRun(l, t, who);
      if (s.state === 'completed') {
        try {
          const engine = readJson(join(l.gen_dir, 'engine.json'));
          if (
            !l.delivery ||
            !engine ||
            typeof engine !== 'object' ||
            !('fake' in engine) ||
            engine.fake !== false
          )
            s.delivery = {
              status: 'unknown',
              reason: 'legacy/fake or unverified launch; automatic delivery unavailable',
            };
          else s.delivery = finalizeDelivery(l.run_id, true, who);
        } catch (e) {
          const blocked = {
            status: 'blocked' as const,
            reason: e instanceof Error ? e.message : String(e),
          };
          s.delivery = blocked;
          // prettier-ignore
          updateLedger(l, cur => {
            if (cur.delivery_result?.status !== 'integrated' || !integratedReceipt({ ...cur.delivery_result, status: 'manual_push' }, cur.delivery_result.source, cur.delivery_result)) cur.delivery_result = blocked;
          });
        }
      }
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
        if (a.flags.evidence)
          throw new Error('recovery: evidence requires registered operator run');
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
      if (a.flags.evidence && a.flags.evidence.length !== 1)
        throw new Error('recovery: exactly one evidence file required');
      if (a.flags.evidence && verb !== 'recover')
        throw new Error('recovery: use recover --evidence');
      return controlled(
        resolved,
        () => resumeRun(resolved, a.flags.reconciled, verb, a.flags.evidence?.[0]),
        false
      );
    }
    case 'cancel': {
      const id = need(target, `${verb} <run>`);
      const reason = a.flags.reason ?? 'unstated';
      // Operational labels only: do not persist free-text messages or credentials.
      // prettier-ignore
      const reasons = ['unstated', 'superseded', 'replaced', 'deadline', 'operator', 'test', 'duplicate', 'obsolete', 'rejected'];
      if (!reasons.includes(reason))
        throw new Error(`cancel --reason must be an operational label: ${reasons.join('|')}`);
      // 未登记：按 archon run id 处理（selftest 用）
      const resolved = resolveTarget(id);
      const ok =
        'run_id' in resolved
          ? control(resolved, () =>
              intervention(
                resolved,
                'cancel',
                () =>
                  cancelRun(
                    resolved.archon_run_id,
                    getRun(resolved.archon_run_id, resolved.repo).status,
                    resolved.repo
                  ),
                undefined,
                undefined,
                reason
              )
            )
          : (() => {
              const run = resolved;
              if (!run.working_path)
                throw new Error('coord: 未登记 run 缺 working_path，无法验证仓库归属');
              return control(
                { run_id: run.id, archon_run_id: run.id, repo: run.working_path },
                () => {
                  const cancelled = cancelRun(run.id, run.status, run.working_path ?? undefined);
                  if (cancelled) {
                    const dir = join(home().sa, 'cancellations');
                    mkdirSync(dir, { recursive: true });
                    writeAtomic(
                      join(dir, `${encodeURIComponent(run.id)}.json`),
                      JSON.stringify({ reason })
                    );
                  }
                  return cancelled;
                }
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
      return brief(ledger(), !!a.flags.json);
    case 'land': {
      const l = ledger(true);
      if (a.flags.apply && l.delivery) {
        print(finalizeDelivery(l.run_id));
        return 0;
      }
      return controlled(l, () => {
        const run = getRun(l.archon_run_id, l.repo);
        let land = evidenceJson(l, artifactsOf(run), 'land.json');
        if (land === undefined) {
          console.error(`land: no land.json yet (state ${classify(run).state})`);
          return 1;
        }
        if (a.flags.apply) {
          applyLand(run, land as Land, cwd => acceptRun(l, undefined, cwd, artifactsOf(run)), {
            repo: l.repo,
            launch_branch: l.launch_branch,
            base_ref: planOf(l).base_ref,
          });
          return 0;
        }
        const inputs = join(l.gen_dir, 'accept-inputs.json');
        // prettier-ignore
        if (l.delivery && existsSync(inputs)) {
          const receipt = integratedReceipt(evidenceJson(l, artifactsOf(run), 'delivery.json') as DeliveryOutcome | undefined, (land as Land).head, {
            task: l.run_id, target: l.delivery, evidence: artifactsOf(run),
            contract: createHash('sha256').update(readFileSync(inputs)).digest('hex'),
          });
          if (receipt) {
            updateLedger(l, cur => { cur.delivery_result = { ...receipt, status: 'integrated' }; });
            land = { ...(land as Land), status: 'integrated', integrated: receipt.integrated };
          } else updateLedger(l, cur => { if (cur.delivery_result?.status === 'integrated') delete cur.delivery_result; });
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
      if (a.flags['by-engine'] !== undefined) {
        const commit = a.flags['by-engine'],
          baselineDays = Number(a.flags['baseline-days'] ?? 7);
        if (
          !/^[0-9a-f]{7,40}$/i.test(commit) ||
          !Number.isFinite(baselineDays) ||
          baselineDays <= 0
        )
          throw new Error(
            '--by-engine requires a commit hash and --baseline-days must be positive'
          );
        const check = Bun.spawnSync(['git', 'rev-parse', '--verify', `${commit}^{commit}`], {
          cwd: WETAMP,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (check.exitCode !== 0)
          throw new Error('--by-engine commit is unavailable in engine repository');
        print(report({ commit, baselineDays }));
        return 0;
      }
      const r = report();
      const full = readUsage();
      const output = { ...r, full_usage: { label: '全量（ccusage）', ...usageSummary(full) } };
      print(a.flags.full ? output : reportSummary(output));
      const usage = r.usage as { unreadable: string[] };
      return (r.unreadable as string[]).length || usage.unreadable.length ? 1 : 0;
    }
    case 'memory':
      if (a._[1] === 'propose') {
        const result = proposeLearning(
          loadLedger(need(a._[2], 'memory propose <run> <request-json>')),
          JSON.parse(need(a._[3], 'memory propose <run> <request-json>')) as LearningRequest
        );
        print(result);
        return result.status === 'prepared' ? 0 : 1;
      }
      if (a._[1] === 'publish') {
        const result = publishLearning();
        print(result);
        return result.status === 'available' ? 0 : 1;
      }
      print(a.flags['dry-run'] ? memoryTick(loadAsks(), Date.now(), false, true) : memoryData());
      return 0;
    case 'health':
      return health(a.flags.cwd, a.flags.verbose);
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
