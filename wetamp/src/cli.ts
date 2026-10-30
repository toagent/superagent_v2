import { applyCoordIntents, describeDecision, type DecisionInbox } from './decisions';
import { FAILOVER_PREFIX, latestFailover } from './decisions';
import { workflowEventRowSchema } from '../../packages/workflows/src/schemas/workflow-event';
import { runAttention } from '../../packages/workflows/src/schemas/workflow-run';
import { providerEventEnvelopeSchema } from '../../packages/workflows/src/schemas/provider-event';
// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import { installMode } from './install-mode';
import { createHash } from 'node:crypto';
import { Intake, completion, intakeRoot, INTAKE_USAGE, type EvidenceReader } from './intake';
import {
  captureDelivery,
  checkoutChanges,
  protectedTarget,
  deliveryProjection,
  landEvidence,
  publishProjection,
  authoredNodeId,
  type DeliveryTarget,
} from './land';
import { type DeliveryOutcome, type DeliveryReceipt } from './land';
import { artifactsOf, evidenceJson, ledgerPath, loadLedger, readJson } from './ledger';
export { artifactsOf, evidenceJson, ledgerPath, loadLedger, readJson } from './ledger';
import type { Land } from '../templates/.archon/scripts/sa-check';
import { confined, workflowRoles } from './board/workflow';
import { saveIncident } from './incidents';
import { lintPlan, memoryData, memoryTick } from './memory';
import { reconcileReflection } from './memory-reflect';
import { publishLearning, proposeLearning, type LearningRequest } from './learning';
import {
  askKey,
  cockpitSignals,
  supersedeAsks,
  unresolved,
  type HoldSignal,
  type Ask as BaseAsk,
} from './cockpit-signals';
import { launcher, type Launcher } from './launcher';
import {
  executionOwnership,
  ownershipUnknown,
  recoveryAdmissionUnknown,
  recoverySnapshot,
} from './recovery';
// prettier-ignore
import { caller, control, coord, identityKey, repoScope, runScope, same, presence, type Controller } from './coord';
import { createLoader, type Snapshot } from './board/data';
import { cockpit } from './board/cockpit';
import { ENGINE_CHANGED } from './board/App';
import { collectGenerals, generalAttention } from './stall';
import { allMarshals, cwdFilter, panelModel, renderPanel } from './panel';
// prettier-ignore
import { heartbeat, heartbeatSummary, shouldWriteHeartbeat, tickHealth, type Heartbeat, type HeartbeatSummary, type TickRecord } from './heartbeat';
import { COORD_OPTIONS, coordinationCommand } from './coord/commands';
import { reclaimOnce, reclaimTick } from './reclaim';
import {
  askQuestion,
  askName,
  CANCELLATION_REASONS,
  HOLD_POLICY,
  reasonOf,
  type Hold,
  type Policy,
} from './reasons';
export { HOLD_POLICY, type Hold, type Policy } from './reasons';
import { Database } from 'bun:sqlite';
import {
  advanceExecutionAttempt,
  executionAdmissionLock,
} from '@archon/workflows/execution-lifecycle';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs as parse } from 'node:util';
import {
  archon,
  archonDetached,
  archonJson,
  archonRunIds,
  admitRun,
  dueWorkflowContinuations,
  getRun,
  lastJson,
  lock,
  ownerLost,
  pidAlive,
  QUERY_TIMEOUT_MS,
  recover,
  reportRunRevisions,
  runStatuses,
  signalHuman,
  waitNotification,
  tail,
  errorExcerpt,
  type RecoverResult,
  type RunView,
} from './archon';
import {
  attemptPath,
  reviewRoundLimit,
  type DeliveryDecision,
  type decide as decideGate,
  validateRecovery,
  type RecoveryEvidence,
  type AuthorRun,
} from '../templates/.archon/scripts/sa-check';
import {
  WETAMP,
  aliasDrift,
  codexWorkerProblem,
  gitHead,
  home,
  loadTiers,
  resolveRoute,
  routeNotice,
  routeState,
  runAliases,
  writeAtomic,
} from './config';
import {
  claudeAdmission,
  localHealthTime,
  readClaudeHealth,
  refreshClaudeHealth,
} from './claude-health';
import { launchAgent, orcaBin, type AgentLaunch } from './orca';
import { engineHash, generate, newRunId, type ReviewCheckpoint } from './generate';
import { loadPlan, milestones, type Plan } from './plan';
import { checkSyntaxErrors, planPrecheck } from './plan-precheck';
import { applyPlanRules, freezePlanRules } from './plan-rules';
import { redact } from './redact';
import { buildReport, consolidationMetrics, reportSummary } from './report';
import { abandoned } from './ledger-metrics';
import { jobCli } from './jobs';
import { ROUTE_ROLE, TIERS } from './roles';
import { gc, scratchClean, type GcAction, type ScratchAction } from './gc';
import { readUsage, usageSummary, usageCli } from './usage';
import { refreshBudgetQuota, relayQuota } from './relay-quota';
import { capabilityDrift } from './capabilities';
import {
  assertEngineAccess,
  autoPromote,
  currentEngineSnapshot,
  engineCommand,
  fixedEngineSnapshot,
  runEngineSnapshot,
  runningEngineSnapshot,
  staleEngineSnapshot,
} from './engine';

export const consoleLaunchdLabel = (): string =>
  process.env.SA_CONSOLE_LABEL ?? 'com.wetamp.superagent-console';
export const consoleLaunchdPlist = (): string =>
  join(
    process.env.SA_LAUNCHD_DIR ?? join(homedir(), 'Library/LaunchAgents'),
    `${consoleLaunchdLabel()}.plist`
  );

const inheritedTmp = process.env.TMPDIR && resolve(process.env.TMPDIR);
if (
  inheritedTmp &&
  ['/tmp/sa-scratch', '/private/tmp/sa-scratch'].some(
    root => inheritedTmp === root || inheritedTmp.startsWith(root + '/')
  )
)
  delete process.env.TMPDIR;

export function intakeEvidence(repo: string, query: typeof getRun = getRun): EvidenceReader {
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
        runs.set(key, query(l.archon_run_id, l.repo));
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

export const OPTIONS = {
  ...COORD_OPTIONS,
  timeout: { type: 'string' },
  user: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  apply: { type: 'boolean' },
  'lint-override': { type: 'string' },
  'allow-overlap': { type: 'string' },
  adopt: { type: 'string' },
  goal: { type: 'string' },
  'accept-timeout': { type: 'string' },
  environment: { type: 'string', multiple: true },
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
  watch: { type: 'boolean' },
  limit: { type: 'string' },
  json: { type: 'boolean' }, // 输出本来就是 JSON；接受以兼容 superagent v1 调用方
  full: { type: 'boolean' },
  'by-engine': { type: 'string' },
  'baseline-days': { type: 'string' },
  'all-held': { type: 'boolean' },
  mine: { type: 'boolean' },
  status: { type: 'string' },
  before: { type: 'string' },
  title: { type: 'string' },
  'request-ref': { type: 'string' },
  card: { type: 'string' },
  'prompt-file': { type: 'string' },
  output: { type: 'string' },
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
  schedule: { type: 'boolean' },
  runs: { type: 'string', multiple: true },
  'no-global': { type: 'boolean' },
  'bootstrap-evidence': { type: 'string' },
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

export const print = (o: unknown): void => {
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
  allow_overlap?: string;
  plan_lint?: ReturnType<typeof lintPlan>;
  /** Explicit workflow identity; engine_hash alone may be the legacy combined UI hash. */
  workflow_hash?: string;
  engine_hash?: string;
  engine_commit?: string;
  /** Absolute engine checkout pinned when this run was launched. */
  engine_snapshot?: string;
  engine_snapshot_identity?: 'current' | 'served' | 'candidate';
  /** Append-only record of explicit `engine adopt`; workflow-run adoption is separate. */
  engine_adoptions?: { at: string; from: string | null; to: string }[];
  adoptions?: {
    at: string;
    from: string;
    to: string;
    engine_from: string | null;
    engine_to: string;
    reason: string;
    engine_commit?: string;
    carried?: string[];
    coded?: string[];
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
    origin?: 'engine' | 'operator';
    ask_id?: string;
    key?: string;
    reason?: string;
    actor?: Controller;
    evidence?: Record<string, unknown>;
  })[];
  /** A held automatic recovery stays paused until an explicit recovery decision clears it. */
  auto_recover_paused?: string;
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

const serializeLedger = (l: Ledger): string => JSON.stringify(l, null, 2) + '\n';
const saveLedger = (l: Ledger, content = serializeLedger(l)): void => {
  writeAtomic(ledgerPath(l.run_id), content);
};

/** Ledger/GC mutations share Archon's recovery admission lock; reload under the lock. */
export function updateLedger(l: Ledger, f: (cur: Ledger) => void): void {
  const id = l.adoptions?.[0]?.from ?? l.archon_run_id;
  for (let i = 0; ; i++) {
    const k = executionAdmissionLock(home().archon, id);
    if (k.ok) {
      try {
        const cur = loadLedger(l.run_id);
        const before = serializeLedger(cur);
        f(cur);
        const after = serializeLedger(cur);
        if (after !== before) saveLedger(cur, after);
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

export function intervention<
  T extends number | boolean | { ok: boolean; busy?: boolean; refused?: boolean },
>(
  l: Ledger,
  action: string,
  execute: () => T,
  ask?: { key: string; id?: string },
  started: () => boolean = () => true,
  reason?: string,
  origin: NonNullable<Ledger['intervention_events']>[number]['origin'] = 'operator',
  actor?: Controller
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
          origin,
          source: ask ? 'superagent' : caller(true).client === 'shell' ? 'cli' : 'commander',
          ...(ask ? { key: ask.key, ask_id: ask.id } : {}),
          ...(actor ? { actor } : {}),
          ok,
          reason: reason ?? action,
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
    ? intervention(
        l,
        a.status === 'no' ? 'cancel' : 'answer',
        execute,
        { key, id: a.id },
        undefined,
        a.status === 'no' ? 'rejected' : 'human_decision'
      )
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
      const bodyGateId = (approval as (typeof approval & { bodyGateId?: string }) | undefined)
        ?.bodyGateId;
      if (
        approval?.nodeId.startsWith('human-') &&
        (approval as typeof approval & { resolved?: string }).resolved === 'rejected'
      )
        return { state: 'held:rework', exit: EXIT.held, node: approval.nodeId };
      if (approval?.nodeId.startsWith('human-'))
        return { state: 'held:human', exit: EXIT.held, node: approval.nodeId };
      if (
        approval?.nodeId.startsWith('target-dirty-') ||
        (approval?.nodeId.startsWith('integrate-') && bodyGateId?.startsWith('target-dirty-'))
      )
        return { state: 'held:target_dirty', exit: EXIT.held, node: approval.nodeId };
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

export type Gate = ReturnType<typeof decideGate>;
/** 各轮 gate 结论文件，按里程碑、轮次排序（轮次 ≤ 3，字典序即轮次序）。 */
export const gatesOf = (art: string): string[] =>
  existsSync(art)
    ? readdirSync(art)
        .filter(f => /^gate-.+-r\d+\.json$/.test(f))
        .sort()
    : [];
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
const outOfScopeOf = (l: Ledger, art: string): string[] => [
  ...new Set(
    decisionsOf(art, undefined, l).flatMap(({ tag }) => {
      const value = evidenceJson(l, art, `${tag}.json`) as { out_of_scope?: unknown } | undefined;
      return tag.startsWith('diff-') && Array.isArray(value?.out_of_scope)
        ? value.out_of_scope.filter((path): path is string => typeof path === 'string')
        : [];
    })
  ),
];
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
const ledgers = (ids = ledgerIds()): (Ledger | { run_id: string; error: string })[] =>
  ids.map(id => {
    try {
      return loadLedger(id);
    } catch (e) {
      return { run_id: id, error: tail((e as Error).message, 200) };
    }
  });

/** Event metadata only: never expose model text or tool arguments in status. */
// prettier-ignore
export function lastActivity(l: Pick<Ledger, 'archon_run_id' | 'adoptions' | 'repo'>, query = archonJson) {
  let latest: { run_id: string; node: string; at: string; type: string } | null = null;
  const missing: string[] = [];
  for (const id of archonRunIds(l)) {
    try {
      const result = query(['workflow', 'get', id, '--verbose', '--events'], l.repo);
      if (!Array.isArray(result.events)) { missing.push(id); continue; }
      for (const raw of result.events) {
        const parsed = workflowEventRowSchema.safeParse(raw);
        if (!parsed.success) continue;
        const e = parsed.data;
        if (!e.step_name) continue;
        const provider = providerEventEnvelopeSchema.safeParse(e.data);
        const type = e.event_type === 'provider_event' ? (provider.success ? provider.data.event.type : null) : e.event_type;
        if (!type || type === 'heartbeat') continue;
        const at = provider.success ? provider.data.observedAt : e.created_at;
        if (Number.isFinite(Date.parse(at)) && (!latest || Date.parse(at) >= Date.parse(latest.at)))
          latest = { run_id: id, node: e.step_name, at, type };
      }
    } catch { missing.push(id); }
  }
  return { latest, complete: missing.length === 0, missing };
}

const reasonToken = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_:+-]{0,79}$/.test(v) ? v : undefined;

// prettier-ignore
function terminalProjection(l: Ledger, run: RunView, c: Classified) {
  if (c.exit === EXIT.running) return { delivery_state: 'pending' as const };
  const art = artifactsOf(run),
    node = run.nodes?.find(n => n.nodeId === c.node),
    landError = [...(l.intervention_events ?? [])]
      .reverse()
      .find(e => e.action === 'land' && !e.ok)?.error,
    landReason = l.delivery_result?.status === 'blocked'
      ? reasonToken(l.delivery_result.reason)
      : landError?.startsWith('land_') ? reasonToken(landError.slice(5)) : undefined,
    registered = reasonToken(c.node ? nodeReason(l, run, c) : undefined),
    integrationReason = ['held:target_dirty', 'target_dirty'].includes(c.state) ? 'target_dirty'
      : ['sync_conflict', 'target_advanced', 'review_stale'].includes(c.state) ? c.state : undefined,
    reason = landReason ?? integrationReason ?? (registered && reasonOf(registered) ? registered : undefined) ??
      holdOf(l, run, c) ?? reasonToken(run.metadata?.stop_reason?.reason) ?? 'unclassified',
    evidence = [
      landReason && join(art, 'delivery.json'),
      reason === 'target_dirty' && c.node && join(art, `${authoredNodeId(c.node)}.json`),
      c.node && join(art, `${c.node}.json`),
      run.transcript_path, l.log, l.transcript, art, ledgerPath(l.run_id),
    ].find((p): p is string => typeof p === 'string' && p !== '' && existsSync(p)) ??
      ledgerPath(l.run_id),
    published = publishProjection(l, run),
    integrated = l.delivery_result?.status === 'integrated' || !!deliveryProjection(l),
    blocked = landReason ?? (/^(?:land|deliver|publish)(?:-.+)?$/.test(authoredNodeId(c.node ?? '')) && node?.state === 'failed'),
    reauthorize = reauthorizationHint(l, run, c),
    action = reauthorize ?? (reason === 'target_protected' ? '在 feature 分支重跑'
      : reason === 'target_dirty' ? `superagent land --apply ${l.run_id}`
      : c.state === 'owner_lost' ? `superagent recover ${l.run_id}`
      : c.state === 'held:human' ? `superagent decide ${l.run_id} approve`
      : c.state === 'held:paused' ? `superagent resume ${l.run_id}`
      : c.state.startsWith('held:') ? `superagent decide ${l.run_id} retry`
      : ['sync_conflict', 'target_advanced', 'review_stale'].includes(c.state) ? `superagent recover ${l.run_id}`
      : ['failed', 'cancelled'].includes(c.state) ? `superagent recover ${l.run_id}` : '读 evidence_path');
  const delivery_state = published ? 'published' as const : integrated ? 'integrated' as const : blocked ? 'blocked' as const : 'not_reached' as const;
  return { delivery_state, receipt: { state: c.state, failed_node: c.node ?? null, reason, evidence_path: evidence, action } };
}

function reauthorizationHint(l: Ledger, run: RunView, c: Classified): string | undefined {
  const error = c.node ? run.nodes?.find(n => n.nodeId === c.node)?.error : undefined;
  if (!error?.includes('owner/generation fencing')) return;
  try {
    const original = JSON.parse(
      readFileSync(join(l.gen_dir, 'delivery-authorization.json'), 'utf8')
    ) as { run?: Controller };
    if (!original.run || coord().d.presence(original.run).state !== 'offline') return;
    return `superagent claim ${l.run_id}\nsuperagent reauthorize ${l.run_id}`;
  } catch {
    return undefined;
  }
}

/** ≤20 行的摘要：元帅只读这个和证据路径。 */
function summary(l: Ledger, run: RunView, c: Classified): Record<string, unknown> {
  const nodes = run.nodes ?? [];
  const art = artifactsOf(run);
  const landFile = landEvidence(run)?.file;
  confined(l, art);
  const needs = needsOf(art, undefined, l);
  const outOfScope = c.exit === EXIT.running ? [] : outOfScopeOf(l, art);
  const hold = holdOf(l, run, c);
  const projection = terminalProjection(l, run, c);
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
    last_activity: lastActivity(l),
    state: c.state,
    exit: c.exit,
    ...projection,
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
          land: landFile
            ? (evidenceJson(l, art, landFile) as { commands?: string[] } | undefined)?.commands
            : undefined,
        }
      : {}),
    evidence: art,
    delivery: decisionsOf(art, undefined, l).map(d => ({
      tag: d.tag,
      decision: d.decision ?? 'unknown',
    })),
    ...(outOfScope.length ? { out_of_scope: outOfScope } : {}),
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
 * run 级 error（终局记录优先）与停止原因类别，并给出能看到全文的证据路径。错误文本先脱敏再截断。
 */
function failure(l: Ledger, run: RunView, node: string | undefined): Record<string, unknown> {
  const cut = (s: string): string => errorExcerpt(redact(s), 200);
  if (node) return { error: cut(run.nodes?.find(n => n.nodeId === node)?.error ?? '') };
  const why = run.metadata?.stop_reason;
  // 停止原因是引擎枚举值；不是枚举形状的就不当原因转述
  const reason = reasonToken(why?.reason);
  const signal = reasonToken(why?.signal);
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
const adoptsRun = (l: Ledger, run: RunView, staleSnapshot = false): boolean =>
  ['failed', 'cancelled'].includes(run.status) &&
  (staleSnapshot || workflowIdentity(l) !== engineHash());

/** Read-only delivery evidence projection; ledger counters never decide execution lifecycle. */
export function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
  if (coderBudgetExceeded(run, c)) return { ...c, state: 'held:gate', exit: EXIT.held };
  if ((run.status === 'failed' || run.status === 'paused') && c.node) {
    const art = artifactsOf(run);
    if (run.status === 'failed') {
      const authored = authoredNodeId(c.node);
      const publish = /^(?:re)?sync-.+$|^publish-.+$/.test(authored)
        ? (evidenceJson(l, art, `${authored}.json`) as { reason?: unknown } | undefined)
        : undefined;
      if (publish?.reason === 'reclaim_pending')
        return { ...c, state: 'held:reclaim_pending', exit: EXIT.held };
      if (publish?.reason === 'target_dirty') return { ...c, state: 'target_dirty' };
      if (publish?.reason === 'target_advanced') return { ...c, state: 'target_advanced' };
      if (publish?.reason === 'review_stale') return { ...c, state: 'review_stale' };
      const sync = authored
        .replace(/^resolve-context-/, '')
        .replace(/^resolve-/, '')
        .replace(/-ready$/, '');
      if (/^(?:re)?sync-.+$/.test(sync)) {
        const evidence = evidenceJson(l, art, `${sync}.json`) as { status?: unknown } | undefined;
        if (evidence?.status === 'conflict') return { ...c, state: 'sync_conflict' };
      }
    }
    const controlNode = [
      c.node,
      ...(run.status === 'failed'
        ? (run.nodes ?? []).filter(n => n.state === 'failed').map(n => n.nodeId)
        : []),
    ].find(node => {
      const decision = decisionOf(evidenceJson(l, art, `${node}.json`));
      return (
        decision?.kind === 'block' &&
        ['coder_partial', 'coder_needs', 'acceptance_adjudication', 'finding_stuck'].includes(
          decision.reason ?? ''
        )
      );
    });
    if (controlNode) return { ...c, node: controlNode, state: 'held:gate', exit: EXIT.held };
    const decision = decisionOf(evidenceJson(l, art, `${c.node}.json`));
    if (
      /^(verify|settle|gate)-/.test(c.node) &&
      (!decision || decision.kind === 'advance' || decision.kind === 'debt')
    )
      return { ...c, state: 'held:engine_suspect', exit: EXIT.held };
  }
  return c;
}

const coderBudgetExceeded = (run: RunView, c: Classified): boolean => {
  const lifecycle = run.nodes?.find(n => n.nodeId === c.node)?.execution?.lifecycle;
  return (
    /^(code|fix|repair)-/.test(c.node ?? '') &&
    lifecycle?.status === 'failed' &&
    lifecycle.providerFailure?.class === 'budget_exceeded'
  );
};

/** A successor's immutable start sample is the first durable HEAD evidence after coding. */
const codedHead = (run: RunView, pkg: string): string | undefined => {
  const latest = (id: string) => [...(run.nodes ?? [])].reverse().find(n => n.nodeId === id);
  const successor =
    latest(`repair-${pkg}`)?.state === 'completed'
      ? `settle-${pkg}`
      : latest(`code-${pkg}`)?.state === 'completed'
        ? `verify-${pkg}`
        : undefined;
  const sample = [...(run.nodes ?? [])].reverse().find(n => n.nodeId === successor)?.execution
    ?.attempt.checkoutStart;
  return sample?.kind === 'git' &&
    sample.worktree.status === 'clean' &&
    typeof sample.commit === 'string'
    ? sample.commit
    : undefined;
};

export function recoveryReviewCheckpoint(
  l: Ledger,
  art: string,
  file: string,
  head: string,
  outputHashes: Readonly<Partial<Record<string, string>>>
):
  | {
      milestone: string;
      checkpoint?: ReviewCheckpoint;
      reason?: `${'gate' | 'diff'}_hash_${'missing' | 'mismatch'}`;
    }
  | undefined {
  const match = /^gate-(.+)-r(\d+)\.json$/.exec(file);
  if (!match) return undefined;
  try {
    const readBound = (name: string, kind: 'gate' | 'diff') => {
      const path = confined(l, join(art, name)),
        expected = outputHashes[name.replace('.json', '')];
      if (!expected) return { reason: `${kind}_hash_missing` as const };
      if (!path) return { reason: `${kind}_hash_mismatch` as const };
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== expected)
        return { reason: `${kind}_hash_mismatch` as const };
      return { value: JSON.parse(bytes.toString('utf8')) as unknown };
    };
    const gateBound = readBound(file, 'gate');
    if ('reason' in gateBound) return { milestone: match[1], reason: gateBound.reason };
    const diffBound = readBound(file.replace('gate-', 'diff-'), 'diff');
    if ('reason' in diffBound) return { milestone: match[1], reason: diffBound.reason };
    const gate = gateBound.value as Record<string, unknown> | undefined;
    const diff = diffBound.value as Record<string, unknown> | undefined;
    const decision = decisionOf(gate),
      inferredLedger = join(art, file.replace('.json', '.ledger.json')),
      ledger = confined(
        l,
        typeof gate?.ledger_file === 'string' ? gate.ledger_file : inferredLedger
      );
    const valid =
      decision &&
      ['advance', 'debt'].includes(decision.kind) &&
      gate?.head_trusted === true &&
      gate.reviewed_head === head &&
      typeof gate.reviewed_diff_hash === 'string' &&
      /^[0-9a-f]{16}$/.test(gate.reviewed_diff_hash) &&
      typeof diff?.contract_hash === 'string' &&
      /^[0-9a-f]{64}$/.test(diff.contract_hash) &&
      diff.head === gate.reviewed_head &&
      diff.diff_hash === gate.reviewed_diff_hash &&
      ledger &&
      readJson(ledger);
    return {
      milestone: match[1],
      ...(valid
        ? {
            checkpoint: {
              gate: { ...gate, decision, ledger_file: ledger },
              check: diff,
            } as ReviewCheckpoint,
          }
        : {}),
    };
  } catch {
    return { milestone: match[1] };
  }
}

export const recoveryOutputHashes = (
  runId: string,
  repo: string,
  query: typeof archonJson = archonJson
): Record<string, string> => {
  try {
    const view = query(['workflow', 'get', runId, '--verbose', '--events'], repo) as {
      events?: unknown;
    };
    if (!Array.isArray(view.events)) return {};
    return Object.fromEntries(
      view.events.flatMap(event => {
        const row = event as { event_type?: unknown; step_name?: unknown; data?: unknown },
          data = row.data as { structured_output?: unknown; node_output?: unknown } | null,
          output =
            data?.structured_output ??
            (typeof data?.node_output === 'string' ? lastJson(data.node_output) : undefined);
        const hash = (output as { artifact_sha256?: unknown } | null)?.artifact_sha256;
        return row.event_type === 'node_completed' &&
          typeof row.step_name === 'string' &&
          typeof hash === 'string' &&
          /^[0-9a-f]{64}$/.test(hash)
          ? [[row.step_name, hash]]
          : [];
      })
    );
  } catch {
    return {};
  }
};

/** Explicit delivery retry/adoption; Archon owns admission and all execution transitions. */
function recoverRun(
  l: Ledger,
  prepare?: () => void,
  onEffect?: (effect: DecisionEffect) => void,
  reconciled?: string,
  evidenceFile?: string,
  admit?: (run: RunView) => string | undefined
): RecoverResult & { working_path?: string } {
  let staleSnapshot = false;
  let invalidWorkingPath: string | undefined;
  let adopted:
    | {
        from: string;
        hash: string;
        engine_from: string | null;
        commit: string | undefined;
        carried: string[];
        coded: string[];
        dir: string;
        snapshot_from?: string;
        snapshot_to?: string;
      }
    | undefined;
  let restarted = false;
  const prepareContinuation = (): void => {
    prepare?.();
    if (!adopted || resolve(adopted.dir) === resolve(l.gen_dir)) return;
    for (const name of ['attempts', 'hints', 'approvals']) {
      const source = join(l.gen_dir, name);
      if (existsSync(source))
        cpSync(source, join(adopted.dir, name), { recursive: true, force: true });
    }
  };
  const result = recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (
        run.working_path &&
        !statSync(run.working_path, { throwIfNoEntry: false })?.isDirectory()
      ) {
        invalidWorkingPath = run.working_path;
        return 'environment';
      }
      staleSnapshot = staleEngineSnapshot(l);
      if (l.rejected === run.id) return 'rejected run is not resumable';
      if (staleSnapshot && currentEngineSnapshot() !== runningEngineSnapshot())
        return `engine identity: run ${l.run_id} continuation requires current engine`;
      if (staleSnapshot && !['failed', 'cancelled'].includes(run.status))
        return `engine identity: run ${l.run_id} is pinned to another snapshot`;
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
          coded: adopted.coded,
        });
        l.archon_run_id = to;
        l.engine_hash = adopted.hash;
        l.engine_commit = adopted.commit;
        l.workflow_hash = adopted.hash;
        l.gen_dir = adopted.dir;
        if (adopted.snapshot_to) {
          (l.engine_adoptions ??= []).push({
            at: new Date().toISOString(),
            from: adopted.snapshot_from ?? null,
            to: adopted.snapshot_to,
          });
          l.engine_snapshot = adopted.snapshot_to;
          l.engine_snapshot_identity = 'current';
        }
        l.transcript = typeof ack.transcriptPath === 'string' ? ack.transcriptPath : '';
        l.log = typeof ack.logPath === 'string' ? ack.logPath : '';
      }
      if (adopted) saveLedger(l);
      onEffect?.({
        action: restarted ? 'restart' : adopted ? 'adopt' : 'resume',
        engine_run: l.archon_run_id,
      });
    },
    prepareContinuation,
    {
      lockId: l.adoptions?.[0]?.from ?? l.archon_run_id,
      operatorId: l.run_id,
      resolveId: () => {
        Object.assign(l, loadLedger(l.run_id));
        return l.archon_run_id;
      },
      adopt: run => {
        // Live and paused owners retain their snapshot; terminal recovery may change source.
        if (
          !adoptsRun(l, run, staleSnapshot) &&
          !(evidenceFile && ['failed', 'cancelled'].includes(run.status))
        ) {
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
              coded: [],
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
        const carriedEvidence: Record<string, string> = {};
        const carried = plan.packages
          .filter(p => {
            if (!run.working_path || !run.output_root) return false;
            try {
              const art = artifactsOf(run);
              const file = existsSync(join(art, `settle-${p.id}.json`))
                ? `settle-${p.id}.json`
                : `verify-${p.id}.json`;
              const evidencePath = confined(l, join(art, file));
              if (!evidencePath) return false;
              const evidence = readJson(evidencePath) as
                | { disposition?: unknown; head?: unknown }
                | undefined;
              const accepted =
                ['advance', 'debt'].includes(decisionOf(evidence)?.kind ?? '') &&
                typeof evidence?.head === 'string' &&
                Bun.spawnSync(['git', 'merge-base', '--is-ancestor', '--', evidence.head, 'HEAD'], {
                  cwd: run.working_path,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  timeout: QUERY_TIMEOUT_MS,
                }).exitCode === 0;
              if (accepted) carriedEvidence[p.id] = evidencePath;
              return accepted;
            } catch {
              // Missing, invalid or inaccessible acceptance evidence never skips coding.
              return false;
            }
          })
          .map(p => p.id);
        const coded = plan.packages
          .filter(p => {
            if (!run.working_path || carried.includes(p.id)) return false;
            try {
              const head = codedHead(run, p.id);
              return (
                head !== undefined &&
                Bun.spawnSync(['git', 'merge-base', '--is-ancestor', '--', head, 'HEAD'], {
                  cwd: run.working_path,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  timeout: QUERY_TIMEOUT_MS,
                }).exitCode === 0
              );
            } catch {
              return false;
            }
          })
          .map(p => p.id);
        const reviews: Partial<Record<string, ReviewCheckpoint>> = {};
        // prettier-ignore
        if (run.working_path) {
          const art = artifactsOf(run), head = gitHead(run.working_path), hashes = recoveryOutputHashes(run.id, l.repo);
          for (const file of evidenceGates(l, art)) {
            const admitted = recoveryReviewCheckpoint(l, art, file, head, hashes);
            if (admitted?.reason) console.warn(JSON.stringify({ code: 'superagent.checkpoint_rejected', ...admitted }));
            if (admitted) reviews[admitted.milestone] = admitted.checkpoint;
          }
        }
        const gen = generate(
          plan,
          l.run_id,
          metadata?.fake ?? false,
          l.engine_hash ?? 'unknown',
          {
            from: run.id,
            packages: carried,
            freshDirectory: staleSnapshot,
            evidence: carriedEvidence,
            coded,
            reviews,
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
          l.delivery,
          runningEngineSnapshot()
        );
        freezePlanRules(plan, gen.dir, l.gen_dir);
        adopted = {
          from: run.id,
          hash: gen.engine_hash,
          engine_from: l.engine_hash ?? null,
          commit: gen.engine_commit,
          carried,
          coded,
          dir: gen.dir,
          ...(staleSnapshot
            ? { snapshot_from: fixedEngineSnapshot(l), snapshot_to: runningEngineSnapshot() }
            : {}),
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
    reconciled,
    admit
  );
  return invalidWorkingPath && !result.ok
    ? { ...result, working_path: invalidWorkingPath }
    : result;
}

const clearAutoRecoverPause = (l: Ledger): string | undefined => {
  const current = loadLedger(l.run_id);
  if (current.auto_recover_paused !== undefined) {
    delete current.auto_recover_paused;
    saveLedger(current);
    Object.assign(l, current);
  }
  return undefined;
};

const AUTO_RECOVER_WINDOW_MS = 60 * 60_000;
const AUTO_RECOVER_LIMIT = 2;
const reserveAutoRecovery = (l: Ledger, run: RunView): string | undefined => {
  if (executionOwnership(run).state !== 'offline') return 'auto_recover_owner_not_offline';
  const current = loadLedger(l.run_id);
  if (current.auto_recover_paused) return `auto_recover_paused:${current.auto_recover_paused}`;
  const now = Date.now();
  const recent = (current.intervention_events ?? []).filter(event => {
    const at = Date.parse(event.at);
    return (
      event.action === 'auto_recover' && Number.isFinite(at) && now - at < AUTO_RECOVER_WINDOW_MS
    );
  });
  if (recent.length >= AUTO_RECOVER_LIMIT) return 'auto_recover_rate_limited';
  (current.intervention_events ??= []).push({
    at: new Date(now).toISOString(),
    action: 'auto_recover',
    origin: 'engine',
    source: 'superagent',
    ok: true,
    reason: 'owner_lost',
  });
  saveLedger(current);
  Object.assign(l, current);
  return undefined;
};

/** Clock seam for deterministic ledger/recovery waits; production uses wall time. */
export const waitClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): void => {
    Bun.sleepSync(ms);
  },
};

const waitHeartbeat = (who: ReturnType<typeof caller>): HeartbeatSummary => {
  const now = Date.now();
  try {
    const value = readJson(join(home().sa, 'heartbeat.json')) as Heartbeat | undefined;
    if (!value) return { available: false, reason: 'heartbeat.json missing' };
    const summary = heartbeatSummary(value, who, now);
    if (!summary.available) return summary;
    let tick: TickRecord | undefined;
    try {
      tick = readJson(join(home().sa, 'tick.json')) as TickRecord | undefined;
    } catch {
      /* reported as a missing tick */
    }
    const warnings = [...(summary.warnings ?? []), ...tickHealth(tick, now).messages];
    return { ...summary, ...(warnings.length ? { warnings } : {}) };
  } catch (error) {
    return {
      available: false,
      reason: `heartbeat.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** Observe engine state and inbox; continuation is an explicit engine action. */
export function waitRun(l: Ledger, timeoutS: number, who = caller(true)): Record<string, unknown> {
  const deadline = waitClock.now() + timeoutS * 1000;
  for (;;) {
    const inbox = coord()
      .surfaced(who)
      .filter(message => ['queued', 'surfaced', 'escalated'].includes(message.state));
    if (inbox.length) return { run_id: l.run_id, state: 'inbox', exit: EXIT.held, inbox };
    const run = getRun(l.archon_run_id, l.repo);
    const c = classifyRun(l, run);
    if (c.state === 'owner_lost')
      return { ...summary(l, run, c), action: `superagent recover ${l.run_id}` };
    const left = (deadline - waitClock.now()) / 1000;
    if (c.exit !== EXIT.running) return summary(l, run, c);
    const general = generalAttention(l.run_id, identityKey(who), waitClock.now());
    if (general)
      return { ...summary(l, run, c), attention: general, heartbeat: waitHeartbeat(who) };
    if (left <= 0) return { ...summary(l, run, c), timed_out: true, heartbeat: waitHeartbeat(who) };
    const notification = waitNotification(l.archon_run_id, l.repo, Math.min(left, 60));
    if (notification.kind !== 'attention') continue;
    const refreshedInbox = coord()
      .surfaced(who)
      .filter(message => ['queued', 'surfaced', 'escalated'].includes(message.state));
    if (refreshedInbox.length)
      return { run_id: l.run_id, state: 'inbox', exit: EXIT.held, inbox: refreshedInbox };
    const refreshed = getRun(l.archon_run_id, l.repo);
    const refreshedClass = classifyRun(l, refreshed);
    if (refreshedClass.state === 'owner_lost')
      return { ...summary(l, refreshed, refreshedClass), action: `superagent recover ${l.run_id}` };
    if (refreshedClass.exit !== EXIT.running) return summary(l, refreshed, refreshedClass);
    return {
      ...summary(l, refreshed, refreshedClass),
      attention: notification.attention,
      heartbeat: waitHeartbeat(who),
    };
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
  if (a.flags.environment?.some(cmd => !cmd.trim()))
    throw new Error('quick --environment requires a non-empty <cmd>');
  const acceptTimeout = Number(a.flags['accept-timeout'] ?? 900);
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
    ...(a.flags.environment
      ? { environment: a.flags.environment.map(cmd => ({ cmd, timeout_s: acceptTimeout })) }
      : {}),
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

export function scopeOverlaps(plan: Plan): { run_id: string; paths: string[]; error?: string }[] {
  try {
    if (process.env.DATABASE_URL) throw new Error('DATABASE_URL: SQLite status unavailable');
    const scope = repoScope(plan.repo).id;
    return ledgers().flatMap<{ run_id: string; paths: string[]; error?: string }>(l => {
      try {
        if ('error' in l) throw new Error(l.error);
        // Only a missing path is clear; permission and other filesystem errors stay unknown.
        if (!statSync(l.repo, { throwIfNoEntry: false })) return [];
        let status: string;
        try {
          status = coord().d.status(l);
        } catch (error) {
          if (repoScope(l.repo).id !== scope) return [];
          throw error;
        }
        if (
          ['completed', 'failed', 'cancelled'].includes(status) &&
          (!l.delivery_result || l.delivery_result.status === 'integrated')
        )
          return [];
        if (repoScope(l.repo).id !== scope) return [];
        if (status === 'unknown') throw new Error('run status unavailable');
        const frozen = join(l.gen_dir, 'plan.json');
        const previous = loadPlan(
          existsSync(frozen) ? frozen : resolve(l.repo, l.plan)
        ).packages.flatMap(p => p.scope.write);
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
        return [{ run_id: l.run_id, paths: [], error: redact(String(error)) }];
      }
    });
  } catch (error) {
    return [{ run_id: 'unknown', paths: [], error: redact(String(error)) }];
  }
}

function checkedPlan(planPath: string, override?: string) {
  const rules = applyPlanRules(loadPlan(planPath), override);
  const plan_lint = lintPlan(rules.plan, override),
    precheck = planPrecheck(rules.plan, rules.plan.repo, override);
  plan_lint.warnings.push(...rules.warnings, ...precheck.blocking, ...precheck.info);
  plan_lint.rejected ||= rules.rejected || precheck.blocking.length > 0;
  if (override?.trim()) plan_lint.override = redact(override).slice(0, 240);
  return { plan: rules.plan, plan_lint, rules_added: rules.added };
}

function startRun(planPath: string, a: Args): number {
  const allow_overlap = a.flags['allow-overlap']?.trim();
  if (a.flags['allow-overlap'] !== undefined && !allow_overlap)
    throw new Error('--allow-overlap requires a non-empty reason');
  const run = newRunId();
  let phase: 'preflight' | 'admission' | 'engine' = 'preflight';
  let release: (() => void) | undefined;
  let mode: 'controller' | 'worker' | 'unknown' = 'unknown';
  let plan_lint: ReturnType<typeof lintPlan> | undefined;
  try {
    mode = installMode();
    preflight();
    const rulesChecked = checkedPlan(planPath, a.flags['lint-override']),
      plan = rulesChecked.plan,
      adoptId = a.flags.adopt?.trim();
    const health = refreshClaudeHealth().health,
      admissionHealth = claudeAdmission(plan.mode, health);
    if (!admissionHealth.ok) {
      print({ ...admissionHealth, status: 'rejected' });
      return EXIT_USAGE;
    }
    const routing = routeState(loadTiers(), plan.mode, Date.now(), health);
    if (a.flags.adopt !== undefined && !adoptId)
      throw new Error('--adopt requires a non-empty run id');
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
        plan_lint = rulesChecked.plan_lint;
        const syntaxErrors = checkSyntaxErrors(plan);
        if (syntaxErrors.length)
          throw new Error(`preflight: check syntax: ${syntaxErrors.join('; ')}`);
        if (plan_lint.rejected)
          throw new Error(`preflight: plan lint: ${plan_lint.warnings.join('; ')}`);
        // Report unreadable scope evidence before capacity inspection can fail on the same DB.
        const conflicts = scopeOverlaps(plan);
        if (conflicts.length && !allow_overlap) {
          print({
            ok: false,
            status: 'rejected',
            reason: 'scope_overlap',
            overlap_warnings: conflicts,
          });
          return EXIT_USAGE;
        }
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
        // Recheck under the shared launch lock so concurrent starts cannot both pass.
        const overlap_warnings = scopeOverlaps(plan);
        if (overlap_warnings.length && !allow_overlap) {
          print({ ok: false, status: 'rejected', reason: 'scope_overlap', overlap_warnings });
          return EXIT_USAGE;
        }
        const launchBranch = lastJson(checked.stdout.toString())?.launch_branch;
        const delivery =
          typeof launchBranch === 'string' && launchBranch ? captureDelivery(plan.repo) : undefined;
        if (delivery && protectedTarget(delivery.branch)) {
          print({
            ok: false,
            status: 'rejected',
            reason: 'target_protected',
            target: delivery.branch,
            action: '在非保护分支（feature 分支）上启动：git switch -c <新分支> 后重跑',
          });
          return EXIT_USAGE;
        }
        const paths = delivery ? checkoutChanges(delivery.checkout) : [];
        if (paths.length) {
          print({
            ok: false,
            status: 'rejected',
            reason: 'target_dirty',
            paths: paths.slice(0, 20),
            action: '先 commit/stash 目标检出的改动后重跑',
          });
          return EXIT_USAGE;
        }
        let adopted: { ledger: Ledger; run: RunView } | undefined;
        if (adoptId) {
          const oldLedger = loadLedger(coord().resolveRun(adoptId)?.run_id ?? adoptId);
          if (!same(coord().owner(runScope(oldLedger)).owner, who))
            throw new Error(
              `adopt: run ${oldLedger.run_id} is not controlled by the current caller`
            );
          if (repoScope(oldLedger.repo).id !== repo.id)
            throw new Error(`adopt: run ${oldLedger.run_id} belongs to a different repo`);
          const oldRun = getRun(oldLedger.archon_run_id, oldLedger.repo),
            oldPlan = planOf(oldLedger),
            oldPkg = oldPlan.packages[0],
            nextPkg = plan.packages[0];
          if (!['failed', 'cancelled', 'completed'].includes(oldRun.status))
            throw new Error(`adopt: archon run ${oldRun.id} is not terminal (${oldRun.status})`);
          if (oldPlan.packages.length !== 1 || plan.packages.length !== 1)
            throw new Error('adopt: old and new plans must each contain exactly one package');
          if (
            oldPkg.id !== nextPkg.id ||
            (oldPkg.milestone ?? 'm1') !== (nextPkg.milestone ?? 'm1')
          )
            throw new Error('adopt: package id and milestone must match the old plan');
          if (
            (oldPlan.console ?? 'claude') !== (plan.console ?? 'claude') ||
            (oldPlan.mode ?? 'auto') !== (plan.mode ?? 'auto')
          )
            throw new Error('adopt: new plan AI configuration conflicts with the adopted run');
          adopted = { ledger: oldLedger, run: oldRun };
        }
        phase = 'engine';
        const engine = runEngineSnapshot();
        const gen = generate(
          plan,
          run,
          a.flags.fake ?? false,
          undefined,
          undefined,
          delivery,
          engine.path,
          routing
        );
        freezePlanRules(plan, gen.dir);
        const branch = adopted?.ledger.branch ?? `sa/${run}`;
        if (adopted) {
          const art = artifactsOf(adopted.run),
            pkg = plan.packages[0].id;
          const handoff = existsSync(art)
            ? readdirSync(art)
                .filter(f => f.endsWith('.coder.json'))
                .map(f => ({ f, mtime: statSync(join(art, f)).mtimeMs }))
                .sort((x, y) => y.mtime - x.mtime)
                .flatMap(({ f }) => {
                  try {
                    const value = JSON.parse(readFileSync(join(art, f), 'utf8')) as Record<
                      string,
                      unknown
                    >;
                    return typeof value.status === 'string' ? [value] : [];
                  } catch {
                    return [];
                  }
                })[0]
            : undefined;
          if (handoff) {
            const fields: Record<string, unknown> = {};
            for (const key of ['status', 'needs', 'blockers', 'changed_files'])
              if (handoff[key] !== undefined) fields[key] = handoff[key];
            writeFileSync(
              join(gen.dir, 'hints', `${pkg}.md`),
              `# Prior structured handoff\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n`
            );
          }
        }
        const args = [
          'workflow',
          'run',
          gen.workflow,
          '--workflow-source',
          gen.dir,
          '--cwd',
          plan.repo,
        ];
        if (adopted) args.push('--adopt', adopted.run.id, '--detach');
        else
          args.push(
            '--branch',
            branch,
            '--from',
            plan.base_ref,
            '--detach',
            '--config',
            gen.config
          );
        const adoptions = adopted
          ? [
              ...(adopted.ledger.adoptions ?? []),
              {
                at: new Date().toISOString(),
                from: adopted.run.id,
                to: '',
                engine_from: adopted.ledger.engine_hash ?? null,
                engine_to: gen.engine_hash,
                reason: 'plan_replacement',
                engine_commit: gen.engine_commit,
                carried: [],
                coded: [],
              },
            ]
          : undefined;
        const l: Ledger = {
          allow_overlap,
          plan_lint,
          run_id: run,
          engine_hash: gen.engine_hash,
          engine_commit: gen.engine_commit,
          engine_snapshot: engine.path,
          engine_snapshot_identity: engine.identity,
          workflow_hash: gen.engine_hash,
          archon_run_id: '',
          plan: planPath,
          gen_dir: gen.dir,
          repo: plan.repo,
          branch,
          launch_branch: adopted
            ? branch
            : typeof launchBranch === 'string'
              ? launchBranch
              : undefined,
          adoptions,
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
        if (l.adoptions?.at(-1)?.to === '') l.adoptions[l.adoptions.length - 1].to = ack.runId;
        mkdirSync(join(home().sa, 'runs'), { recursive: true });
        saveLedger(l);
        rmSync(intentPath(run), { force: true });
        // prettier-ignore
        const recent = ledgers().flatMap(previous => {
          try {
            if ('error' in previous) return [];
            const age = Date.now() - Date.parse(previous.started_at);
            if (previous.run_id === run || repoScope(previous.repo).id !== repo.id ||
              !Number.isFinite(age) || age < 0 || age > 86400000) return [];
            const priorRun = getRun(previous.archon_run_id, previous.repo);
            if (!['completed', 'failed', 'cancelled'].includes(priorRun.status)) return [];
            const projection = terminalProjection(previous, priorRun, classifyRun(previous, priorRun));
            return projection.receipt && projection.receipt.reason !== 'unclassified'
              ? [{ ...projection.receipt, run: previous.run_id, at: previous.started_at }]
              : [];
          } catch { return []; }
        });
        // prettier-ignore
        const recent_failures = [...new Set(recent.map(r => r.reason))].flatMap(reason => {
          const matches = recent.filter(r => r.reason === reason).sort((x, y) => y.at.localeCompare(x.at));
          return matches.length >= 2 ? [{ reason, count: matches.length, last_run: matches[0].run, action: matches[0].action }] : [];
        });
        const quota = relayQuota(gen.dir, 'start');
        const notice = routeNotice(routing, false);
        if (notice) quota.quota = [quota.quota, notice].filter(Boolean).join(' · ');
        print({
          run_id: run,
          archon_run_id: l.archon_run_id,
          branch,
          gen_dir: gen.dir,
          mode: 'controller',
          default_contact,
          overlap_warnings,
          plan_lint,
          ...(recent_failures.length ? { recent_failures } : {}),
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
        const adoptions = it.ledger.adoptions?.map(a => (a.to ? a : { ...a, to: rows[0].id }));
        saveLedger({
          ...it.ledger,
          archon_run_id: rows[0].id,
          adoptions,
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
  const capabilities = capabilityDrift(
    join(WETAMP, 'capabilities.json'),
    process.env.HOME ?? homedir()
  );
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
  const consoleDir = join(home().sa, 'console'),
    consoleError = join(consoleDir, 'error');
  let consoleProblem: string | undefined;
  if (existsSync(join(consoleDir, 'decision-origin'))) {
    let error = existsSync(consoleError) ? readFileSync(consoleError, 'utf8').trim() : '';
    try {
      const state = readJson(join(home().sa, 'web.json')) as { pid?: unknown } | undefined;
      if (!pidAlive(Number(state?.pid))) error ||= 'console not running';
    } catch {
      error ||= 'console not running';
    }
    if (error) consoleProblem = `${error}; inspect ${join(home().sa, 'console.log')}`;
  }
  const tick = tickHealth(
    readJson(join(home().sa, 'tick.json')) as TickRecord | undefined,
    Date.now()
  );
  const ok =
    tick.ok &&
    doctor.code === 0 &&
    upstreamClean &&
    !drift.length &&
    !capabilities.length &&
    !worker &&
    !consoleProblem;
  print({
    ok,
    mode,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    capability_drift: capabilities,
    upstream_clean: upstreamClean,
    upstream_file_count: upstreamFiles.length,
    ...(!upstreamClean
      ? { reason: clean.exitCode === 0 ? 'upstream_dirty' : 'upstream_check_failed' }
      : {}),
    ...(verbose ? { upstream_files: upstreamFiles } : {}),
    codex_worker: worker ?? 'ok',
    tick,
    ...(consoleProblem ? { console: { ok: false, reason: consoleProblem } } : {}),
  });
  return ok ? 0 : drift.length || capabilities.length ? EXIT_ALIAS_DRIFT : 1;
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
    () =>
      recoverRun(
        l,
        () => (started = true),
        undefined,
        reconciled,
        evidenceFile,
        () => clearAutoRecoverPause(l)
      ),
    undefined,
    () => started
  );
  if (!res.ok && res.busy) return busyExit(l, res);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : res.held ? EXIT.held : 1;
}

// prettier-ignore
const refuseAbandoned = (l: Ledger): boolean => abandoned(l) ? (print({ run_id: l.run_id, ok: false, type: 'abandoned', reason: 'run was abandoned' }), true) : false;
// prettier-ignore
const abandonError = (run_id: string, type: string, error: unknown) => ({ run_id, type, reason: tail(error instanceof Error ? error.message : String(error), 200) });
// prettier-ignore
function abandon(a: Args): number {
  const reason = a.flags.reason?.trim();
  if (!reason) throw new Error('abandon requires --reason <text>');
  const who = caller();
  let entries: (Ledger | ReturnType<typeof abandonError>)[];
  if (a.flags.mine) {
    if (a._.length !== 1 || !a.flags.status)
      throw new Error('usage: superagent abandon --mine --status failed,cancelled [--before YYYY-MM-DD] --reason <text>');
    const statuses = new Set(a.flags.status.split(',').filter(Boolean));
    const before = a.flags.before ? Date.parse(`${a.flags.before}T00:00:00Z`) : Infinity;
    if (!statuses.size || (a.flags.before && !/^\d{4}-\d{2}-\d{2}$/.test(a.flags.before)) || Number.isNaN(before))
      throw new Error('abandon: invalid --status or --before');
    entries = ledgers().flatMap((l): (Ledger | ReturnType<typeof abandonError>)[] => {
      if ('error' in l) return [];
      try {
        if (!same(coord().owner(runScope(l)).owner, who)) return [];
        const run = getRun(l.archon_run_id, l.repo);
        return statuses.has(run.status) && Date.parse(l.started_at) < before ? [l] : [];
      } catch (e) {
        return [abandonError(l.run_id, 'run_unavailable', e)];
      }
    });
    print({ runs: entries.map(entry => entry.run_id) });
  } else {
    if (a._.length < 2) throw new Error('usage: superagent abandon <run>... --reason <text>');
    entries = a._.slice(1).map(run_id => {
      try {
        return loadLedger(coord().resolveRun(run_id)?.run_id ?? run_id);
      } catch (e) {
        return abandonError(run_id, 'unknown_run', e);
      }
    });
  }
  const results = entries.map(l => {
    if ('type' in l) return { ...l, ok: false };
    try {
      if (!same(coord().owner(runScope(l)).owner, who))
        return { ...abandonError(l.run_id, 'not_controller', 'caller is not controller'), ok: false };
      return control(l, controller => {
        let run: RunView;
        try { run = getRun(l.archon_run_id, l.repo); }
        catch (e) { return { ...abandonError(l.run_id, 'run_unavailable', e), ok: false }; }
        if (['running', 'pending'].includes(run.status)) return { run_id: l.run_id, ok: false, type: 'active', reason: run.status };
        if (run.status === 'completed') return { run_id: l.run_id, ok: false, type: 'completed', reason: run.status };
        const prior = abandoned(l);
        if (!prior) try {
          intervention(l, 'abandon', () => true, undefined, undefined, reason, 'operator', controller);
          updateLedger(l, cur => { cur.rejected = run.id; });
        } catch (e) { return { ...abandonError(l.run_id, 'persistence_failed', e), ok: false }; }
        return { run_id: l.run_id, ok: true, type: prior ? 'already_abandoned' : 'abandoned' };
      }, who);
    } catch (e) {
      return { ...abandonError(l.run_id, 'control_refused', e), ok: false };
    }
  });
  print(results);
  return results.every(result => result.ok) ? 0 : 1;
}

/** 手动 resume / decide retry 撞上 recover 锁：重读状态后按当前状态退出（多为运行中 4 或 held 3），不当业务失败 1。 */
function busyExit(l: Ledger, res: RecoverResult): number {
  const c = classifyRun(l, getRun(l.archon_run_id, l.repo));
  print({ run_id: l.run_id, ...res, state: c.state });
  return c.exit;
}

/** Running cancel preserves core's exact-owner stop result; abandon remains explicit by status. */
function cancelRun(id: string, status: RunView['status'], cwd?: string) {
  const result = archonJson(['workflow', status === 'running' ? 'cancel' : 'abandon', id], cwd);
  return { ...result, ok: result.ok === true };
}

export const planOf = (l: Ledger): Plan =>
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
  /^diff-(.+)-r\d+$/.exec(node)?.[1] ??
  (/^(verify|settle|code|repair)-/.test(node)
    ? (planOf(l).packages.find(p => node.replace(/^(verify|settle|code|repair)-/, '') === p.id)
        ?.milestone ?? 'm1')
    : gateMilestone(node.replace(/^fix-/, 'gate-')));

/** Bump the generated scope before resume; missing counters fail explicitly. */
function retryGate(
  l: Ledger,
  node: string,
  prepare?: () => void,
  onEffect?: (effect: DecisionEffect) => void,
  run?: RunView
): RecoverResult {
  const m = retryScope(l, node);
  if (!attemptable(l, m))
    throw new Error(`decide retry: ${node} escalated; fix on ${l.branch} or start a new run`);
  if (run) {
    const art = artifactsOf(run);
    const gate = evidenceJson(l, art, `${node}.json`) as
      | { decision?: DeliveryDecision }
      | undefined;
    if (gate?.decision?.reason === 'finding_stuck') {
      const ledger = evidenceJson(l, art, `${node}.ledger.json`) as
        | { review_rounds_used?: Record<string, unknown> }
        | undefined;
      const used = ledger?.review_rounds_used?.[m];
      const frozen = JSON.parse(readFileSync(join(l.gen_dir, 'policy.json'), 'utf8')) as Parameters<
        typeof reviewRoundLimit
      >[0];
      if (!Number.isSafeInteger(used) || (used as number) <= 0)
        throw new Error('decide retry: finding_stuck review round evidence missing');
      if ((used as number) >= reviewRoundLimit(frozen))
        throw new Error('decide retry: finding_stuck exhausted review rounds; start a new run');
    }
  }
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
  onEffect?: (effect: DecisionEffect) => void,
  run?: RunView
): RecoverResult =>
  scopedRetry(l, c, c.node ?? '')
    ? retryGate(l, c.node ?? '', prepare, onEffect, run)
    : recoverRun(l, prepare, onEffect);

function advanceAttempts(paths: string[]): () => void {
  const snapshots = paths.map(path => ({
    path,
    ...(existsSync(path) ? { raw: readFileSync(path, 'utf8') } : {}),
  }));
  const rollback = (): void => {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.raw === undefined) rmSync(snapshot.path, { force: true });
      else writeAtomic(snapshot.path, snapshot.raw);
    }
  };
  try {
    for (const path of paths) advanceExecutionAttempt(path);
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}

// prettier-ignore
function approveAdjudication(l: Ledger, run: RunView, c: Classified,
  onEffect?: (effect: DecisionEffect) => void): RecoverResult {
  const node = c.node, out = evidenceJson(l, artifactsOf(run), `${c.node ?? ''}.json`) as
    { adjudication?: Record<string, unknown> } | undefined;
  const a = out?.adjudication;
  if (!node || !a || !['diff_hash', 'contract_hash', 'command', 'failure_digest'].every(k =>
    typeof a[k] === 'string' && a[k] !== '') || !Array.isArray(a.failed_tests) ||
    !a.failed_tests.every(v => typeof v === 'string'))
    throw new Error('acceptance adjudication evidence missing or invalid');
  mkdirSync(join(l.gen_dir, 'approvals'), { recursive: true });
  const path = join(l.gen_dir, 'approvals', `${node}.json`);
  let approvals: Record<string, unknown>[] = [];
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    approvals = Array.isArray(saved.approvals) ? saved.approvals as Record<string, unknown>[] : [saved];
  } catch { /* first approval */ }
  const approval = { diff_hash: a.diff_hash, contract_hash: a.contract_hash,
    command: a.command, failed_tests: a.failed_tests, failure_digest: a.failure_digest,
    at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify({ ...approval, approvals: [...approvals, approval] }) + '\n');
  return retry(l, c, undefined, onEffect, run);
}

/** decide --all-held retry：对所有 held（签收门除外）的 run 逐个 retry，单个失败不影响其余。 */
function retryAllHeld(): number {
  const out = ledgers().flatMap((l): Record<string, unknown>[] => {
    try {
      if ('error' in l) throw new Error(l.error);
      if (abandoned(l)) return [];
      const run = getRun(l.archon_run_id, l.repo);
      const c = classifyRun(l, run);
      if (!c.state.startsWith('held:') || c.state === 'held:human') return [];
      let started = false;
      const execute = () => ({
        run_id: l.run_id,
        state: c.state,
        ...retry(l, c, () => (started = true), undefined, run),
      });
      return [control(l, () => intervention(l, 'decide', execute, undefined, () => started))];
    } catch (e) {
      return [{ run_id: l.run_id, ok: false, reason: tail((e as Error).message, 200) }];
    }
  });
  print(out);
  return out.every(x => x.ok === true || x.busy === true) ? 0 : 1;
}

/** approve：放行签收；reject --pkg：从目标包返工；无 --pkg 的 reject 终止 run。 */
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
  if (c.state === 'held:rework' && action !== 'retry') {
    print({ run_id: l.run_id, ok: false, reason: 'signoff rework only accepts decide retry' });
    return 1;
  }
  if (action === 'approve') {
    if (pastDeadline(l)) {
      print({ run_id: l.run_id, ok: false, reason: PAST_DEADLINE });
      return 1;
    }
    const reason = c.node ? nodeReason(l, run, c) : '';
    if (c.state === 'held:gate' && reason === 'acceptance_adjudication') {
      const res = intervention(l, 'decide', () => approveAdjudication(l, run, c));
      print({ run_id: l.run_id, decision: 'approve', ...res });
      return res.ok ? 0 : res.held ? EXIT.held : 1;
    }
    if (c.state !== 'held:human' && c.state !== 'held:target_dirty') {
      print({ run_id: l.run_id, ok: false, reason: 'run is not waiting for a human signoff' });
      return 1;
    }
    const log = join(l.gen_dir, `signal-${c.node ?? 'none'}.log`);
    return intervention(l, 'decide', () => {
      const r = run.metadata?.approval
        ? approveRun(l)
        : signalHuman(run, { decision: 'approve' }, log, l.repo, l.engine_snapshot);
      print({ run_id: l.run_id, ...r });
      return r.ok ? 0 : 1;
    });
  }
  if (action === 'reject') {
    const { hint, pkg } = a.flags;
    if (pkg !== undefined) {
      if (hint === undefined) throw new Error('decide reject --pkg needs --hint <text>');
      if (c.state !== 'held:human' || !run.metadata?.approval)
        throw new Error('decide reject --pkg requires a native human signoff gate');
      const plan = planOf(l);
      const milestone = milestones(plan).find(m => `human-${m.id}` === c.node);
      const index = milestone?.packages.findIndex(p => p.id === pkg) ?? -1;
      if (!milestone || index < 0)
        throw new Error(`decide reject: package ${pkg} is not in signoff ${c.node ?? 'unknown'}`);
      const scopes = [...milestone.packages.slice(index).map(p => `pkg/${p.id}`), milestone.id];
      const unavailable = scopes.find(scope => !attemptable(l, scope));
      if (unavailable)
        throw new Error(
          `decide reject: ${unavailable} escalated; fix on ${l.branch} or start a new run`
        );
      writeFileSync(join(l.gen_dir, 'hints', `${pkg}.md`), hint + '\n');
      const rollback = advanceAttempts(scopes.map(scope => attemptPath(l.gen_dir, scope)));
      try {
        const rejected = rejectRun(l, hint);
        if (!rejected.ok) throw new Error(rejected.reason ?? 'native reject failed');
      } catch (error) {
        rollback();
        throw error;
      }
      const res = recoverRun(l);
      print({ run_id: l.run_id, decision: 'reject', package: pkg, ...res });
      return res.ok ? 0 : res.held ? EXIT.held : 1;
    }
    const ok = intervention(
      l,
      'cancel',
      () => cancelRun(l.archon_run_id, run.status, l.repo).ok,
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
  if (c.state === 'held:rework' && (a.flags.pkg !== undefined || a.flags.hint !== undefined))
    throw new Error('decide retry after signoff rejection does not accept --pkg or --hint');
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
    () => retry(l, c, () => (started = true), undefined, run),
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
  const typed = s.receipt as
    | { state: string; failed_node: string | null; reason: string; action: string }
    | undefined;
  if (typed)
    lines.push(
      `receipt: ${typed.state} ${typed.failed_node ?? '-'} ${typed.reason} → ${typed.action}`
    );
  lines.push(`last_activity: ${JSON.stringify(s.last_activity)}`);
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
  if (c.node && nodeReason(l, run, c) === 'acceptance_adjudication') {
    const a = (evidenceJson(l, art, `${c.node}.json`) as { adjudication?: unknown } | null)
      ?.adjudication;
    lines.push(`adjudication: ${JSON.stringify(a ?? 'missing')}`);
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

// supervise-tick：无人值守巡检（cron/launchd 周期调用 `superagent supervise-tick`）：唤醒到期的事件门、恢复 owner-lost，
// 其余非终态按 HOLD_POLICY 处置；需要拍板的投到 agent-supervisor（iPhone 提醒事项：勾选=是、删除=否），按回答执行。
export const ANSWERS = ['pending', 'yes', 'no', 'expired', 'superseded'];
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };
type DecisionEffect =
  | { action: 'approve' | 'reject' | 'resume' | 'adopt' | 'restart' | 'wait'; engine_run: string }
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
    case 'wait':
      action = '已确认继续等待';
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
  /** Snapshot shown by the auto-recovery ask; a later answer reconciles exactly this state. */
  reconciled_snapshot?: string;
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
const withFileLock = <T>(path: string, label: string, operation: () => T): T => {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const held = lock(path);
    if (!held.ok) {
      Bun.sleepSync(5);
      continue;
    }
    try {
      return operation();
    } finally {
      held.release();
    }
  }
  throw new Error(`${label}: lock busy`);
};
const withAsksLock = <T>(operation: () => T): T =>
  withFileLock(join(home().sa, 'asks.lock'), 'asks', operation);
const writeAsks = (asks: Asks): void => {
  writeAtomic(asksPath(), JSON.stringify(asks, null, 2) + '\n');
};
/** Persist exactly one decision key; other runs and coord writers retain their latest values. */
const saveAsk = (asks: Asks, key: string): void => {
  withAsksLock(() => {
    const latest = loadAsks();
    if (asks[key] === undefined) Reflect.deleteProperty(latest, key);
    else latest[key] = asks[key];
    writeAsks(latest);
  });
};
const saveDelta = <T extends Record<string, unknown>>(
  before: T,
  after: T,
  latest: () => T,
  write: (value: T) => void,
  lockPath: string,
  label: string
): void => {
  withFileLock(lockPath, label, () => {
    const merged = latest();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const old = JSON.stringify(before[key]);
      if (old === JSON.stringify(after[key]) || old !== JSON.stringify(merged[key])) continue;
      if (after[key] === undefined) Reflect.deleteProperty(merged, key);
      else Reflect.set(merged, key, after[key]);
    }
    write(merged);
  });
};
/** Apply only changes made by the global scheduler, without overwriting concurrent run updates. */
const saveAsksDelta = (before: Asks, after: Asks): void => {
  saveDelta(before, after, loadAsks, writeAsks, join(home().sa, 'asks.lock'), 'asks');
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
  const key = Object.entries(asks).find(([, value]) => value === a)?.[0];
  if (key) {
    saveAsk(asks, key);
    deliverReceipt(l, key, a, asks);
  }
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
        saveAsk(asks, key);
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
  intervention(
    l,
    effect.action === 'reject' ? 'cancel' : 'answer',
    () => true,
    { key, id: a.id },
    undefined,
    effect.action === 'reject' ? 'rejected' : 'human_decision'
  );
  if (effect.action === 'reject')
    updateLedger(l, cur => {
      cur.rejected = effect.engine_run;
    });
  if (a.decision) {
    a.decision.effect = effect;
    saveAsk(asks, key);
  }
  a.status = answer === 'yes' ? 'approved' : 'rejected';
  a.receipt = {
    key: new Bun.CryptoHasher('sha256').update(`${a.id ?? key}:${answer}`).digest('hex'),
    body: decisionReceipt(l.run_id, node, answer, effect),
    stage: effect.action === 'wait' ? 'succeeded' : 'executing',
    effect,
    delivery: 'pending',
    terminal_before: a.decision?.terminal_before,
    at: new Date().toISOString(),
  };
  delete a.decision;
  saveAsk(asks, key);
  deliverReceipt(l, key, a, asks);
}

const terminalFact = (run: RunView): string =>
  `${run.id}:${run.status}:${run.completed_at ?? run.last_activity_at ?? ''}`;
function deliverReceipt(l: Ledger | undefined, key: string, a: Ask, asks: Asks): void {
  const r = a.receipt;
  if (!r?.stage || !a.id) return; // Legacy receipts have no execution binding.
  try {
    if (r.effect && r.stage === 'executing') {
      if (!l) throw new Error('receipt effect requires a run');
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
        saveAsk(asks, key);
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
  saveAsk(asks, key);
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
    saveAsk(asks, key);
    const title = text();
    const ctx = context(title);
    asks[key] = { status: 'unknown', context: ctx };
    saveAsk(asks, key);
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
    saveAsk(asks, key);
    return { a: asks[key], asked: id, note };
  }
  if (a.status === 'pending' && a.id) {
    const st = supervisor(['ask-status', a.id]);
    if (!ANSWERS.includes(st))
      throw new Error(`supervisor ask-status: unexpected ${st.slice(0, 40)}`);
    a.status = st;
    saveAsk(asks, key);
  }
  return { a, note };
}

function pollCoordAsk(sa: string, asks: Asks, key: string, title: string) {
  if (existsSync(join(sa, 'console/decision-origin'))) {
    const current = asks[key];
    if (current) return { id: current.id, status: current.status };
    asks[key] = { status: 'pending' };
    saveAsk(asks, key);
    return { status: 'pending' };
  }
  const result = pollAsk(
    key,
    () => title,
    MAX_TTL_H,
    asks,
    () => coordinationContext(key)
  );
  if ('conflict' in result) throw new Error(result.conflict);
  return { id: result.a.id, status: result.a.status };
}

/** plan 截止已过：终止 run（保留证据），该 run 未执行的提问记 expired，ledger 记 failed/deadline；不提醒。 */
function expireRun(l: Ledger, run: RunView, asks: Asks | Error, base: object): Action {
  const x = { run_id: l.run_id, ...base, action: 'cancel', reason: 'deadline' };
  if (
    !intervention(
      l,
      'cancel',
      () => cancelRun(l.archon_run_id, run.status, l.repo).ok,
      undefined,
      undefined,
      'deadline'
    )
  )
    return { ...x, ok: false };
  if (!(asks instanceof Error))
    for (const [k, a] of Object.entries(asks))
      if (k.startsWith(`${l.run_id}:`) && a && !['approved', 'rejected'].includes(a.status)) {
        asks[k] = { ...a, status: 'expired' };
        saveAsk(asks, k);
      }
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
        : signalHuman(run, { decision: 'approve', ask: p.a.id }, log, l.repo, l.engine_snapshot);
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
      const result = cancelRun(l.archon_run_id, run.status, l.repo);
      if (result.ok)
        consumeAnswer(
          l,
          w.nodeId,
          key,
          p.a,
          'no',
          { action: 'reject', engine_run: l.archon_run_id },
          asks
        );
      return { ...b, action: 'reject', ...result };
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

function rejectRun(l: Ledger, reason: string): { ok: boolean; reason?: string } {
  const ack = archonJson(['workflow', 'reject', l.archon_run_id, reason], l.repo);
  return ack.ok === true && ack.cancelled === false
    ? { ok: true }
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
  const episode = holdEpisode(l, run, c, hold);
  const key = askKey(l.run_id, hold, episode);
  const base = { run_id: l.run_id, state: c.state, reason: hold, ...extra };
  const r = pollAsk(
    key,
    () => decisionQuestion(l, run, c, hold, key),
    ttlHours(Date.parse(planOf(l).deadline ?? '')),
    asks,
    question => decisionContext(l, run, c, hold, key, question)
  );
  if ('conflict' in r)
    return { ...base, action: 'none', ok: false, error: `${r.conflict}; decide retry|reject` };
  if (hold === 'auto_recover' && !r.a.reconciled_snapshot) {
    r.a.reconciled_snapshot = recoverySnapshot(run);
    saveAsk(asks, key);
  }
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
        saveAsk(asks, key);
      };
      if (p.yes === 'cancel') {
        const result = cancelRun(l.archon_run_id, run.status, l.repo);
        if (result.ok)
          consumeAnswer(
            l,
            c.node ?? '',
            key,
            r.a,
            'yes',
            { action: 'reject', engine_run: l.archon_run_id },
            asks
          );
        return { ...b, action: 'cancel', ok: result.ok, result };
      }
      const res =
        p.yes === 'approve'
          ? approveRun(l)
          : p.yes === 'adjudicate'
            ? approveAdjudication(l, run, c, onEffect)
            : p.yes === 'resume'
              ? recoverRun(l, undefined, onEffect, r.a.reconciled_snapshot, undefined, () =>
                  clearAutoRecoverPause(l)
                )
              : p.yes === 'review'
                ? retryGate(l, `review-${(c.node ?? '').slice(5)}`, undefined, onEffect)
                : retry(l, c, undefined, onEffect, run);
      if (res.ok) {
        if (!effect) throw new Error('decision recovery succeeded without an execution receipt');
        consumeAnswer(l, c.node ?? '', key, r.a, 'yes', effect, asks);
      }
      if (!res.ok && (res.busy || res.refused)) {
        delete r.a.decision;
        saveAsk(asks, key);
      }
      const out = res.ok
        ? { ok: true }
        : { ok: false, error: res.reason, ...(res.busy ? { busy: true } : {}) };
      return { ...b, action: p.yes, ...out };
    }
    if (r.a.status === 'no') {
      beginAnswer(l, c.node ?? '', r.a, 'no', asks);
      if ('noText' in p) {
        consumeAnswer(
          l,
          c.node ?? '',
          key,
          r.a,
          'no',
          { action: 'wait', engine_run: l.archon_run_id },
          asks
        );
        return { ...b, action: 'wait', ok: true };
      }
      const result = cancelRun(l.archon_run_id, run.status, l.repo);
      if (result.ok)
        consumeAnswer(
          l,
          c.node ?? '',
          key,
          r.a,
          'no',
          { action: 'reject', engine_run: l.archon_run_id },
          asks
        );
      return { ...b, action: 'reject', ...result };
    }
    return { ...b, action: 'none', ok: true, ask: r.a.status };
  });
}

interface TickMode {
  schedule?: boolean;
  runs?: string[];
  noGlobal?: boolean;
}

interface MaintenanceTasks {
  memory: (asks: Asks) => unknown;
  reflection: () => unknown;
  gc: () => GcAction[];
  scratch: () => ScratchAction[];
}

export function maintenanceTick(
  sa = home().sa,
  tasks: MaintenanceTasks = {
    memory: memoryTick,
    reflection: reconcileReflection,
    gc,
    scratch: scratchClean,
  }
): Record<string, unknown> {
  const held = lock(join(sa, 'maintenance.lock'));
  if (!held.ok) {
    const skipped = {
      at: new Date().toISOString(),
      maintenance: { ok: true, duration_ms: 0, skipped: 'maintenance_running' },
    };
    writeAtomic(join(sa, 'maintenance.json'), JSON.stringify(skipped, null, 2) + '\n');
    return skipped;
  }
  const maintenanceStarted = Date.now();
  const record: Record<string, unknown> = { at: new Date().toISOString() };
  const run = (name: string, task: () => unknown): unknown => {
    const started = Date.now();
    try {
      const value = task();
      record[name] = { ok: true, duration_ms: Date.now() - started };
      return value;
    } catch (e) {
      record[name] = {
        ok: false,
        duration_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
      return undefined;
    }
  };
  try {
    let asks: Asks = {};
    try {
      asks = loadAsks();
    } catch {
      /* A corrupt ask cache must not block maintenance. */
    }
    run('memory', () => tasks.memory(asks));
    run('reflection', tasks.reflection);
    const gcStamp = join(sa, 'gc-tick');
    if (!existsSync(gcStamp) || Date.now() - statSync(gcStamp).mtimeMs >= 15 * 60_000) {
      writeAtomic(gcStamp, String(Date.now()));
      run('gc', tasks.gc);
    } else record.gc = { ok: true, duration_ms: 0, skipped: 'not-due' };
    run('scratch', tasks.scratch);
    const failed = Object.values(record).some(
      value => value && typeof value === 'object' && 'ok' in value && value.ok === false
    );
    record.maintenance = { ok: !failed, duration_ms: Date.now() - maintenanceStarted };
    writeAtomic(join(sa, 'maintenance.json'), JSON.stringify(record, null, 2) + '\n');
    return record;
  } finally {
    held.release();
  }
}

const launchMaintenance = (): void => {
  const child = Bun.spawn([process.execPath, import.meta.path, 'maintenance-tick'], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env },
  });
  child.unref();
};

const rotateTickLog = (sa: string): void => {
  const file = join(sa, 'supervise-tick.log');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size <= 10 * 1024 * 1024) return;
  for (let generation = 3; generation > 1; generation--) {
    const source = `${file}.${String(generation - 1)}`;
    if (existsSync(source)) renameSync(source, `${file}.${String(generation)}`);
  }
  renameSync(file, `${file}.1`);
};

/** Activated engines separate the global scheduler from snapshot-scoped executors. */
export function superviseTick(mode: TickMode = {}):
  | ReturnType<typeof tick>
  | { skipped: 'locked' }
  | (ReturnType<typeof scheduleTickGroups> & {
      global: ReturnType<typeof tick>;
      promotion?: ReturnType<typeof autoPromote>;
    }) {
  const { sa } = home();
  mkdirSync(sa, { recursive: true });
  const current = currentEngineSnapshot();
  if (!current) {
    const l = lock(join(sa, 'supervise.lock'));
    if (!l.ok) return { skipped: 'locked' };
    try {
      rotateTickLog(sa);
      return tick(sa);
    } finally {
      l.release();
    }
  }
  if (mode.noGlobal) {
    const runs = new Set(mode.runs ?? []);
    const version = basename(runEngineSnapshot().path).replaceAll(/[^0-9A-Za-z.-]/g, '_');
    const l = lock(join(sa, `supervise.${version}.lock`));
    if (!l.ok) return { skipped: 'locked' };
    try {
      return tick(sa, runs, false);
    } finally {
      l.release();
    }
  }
  const l = lock(join(sa, 'supervise.lock'));
  if (!l.ok) return { skipped: 'locked' };
  let scheduled: ReturnType<typeof scheduleTickGroups> & { global: ReturnType<typeof tick> };
  try {
    rotateTickLog(sa);
    const revisions = optional(reportRunRevisions) ?? null,
      asks = optional(loadAsks),
      statuses = optional(runStatuses) ?? null,
      inputs = ledgers().flatMap(ledger => {
        if ('error' in ledger) return [];
        const fixed = fixedEngineSnapshot(ledger),
          snapshot = fixed && existsSync(fixed) ? fixed : undefined,
          stat = statSync(ledgerPath(ledger.run_id)),
          status = statuses?.get(ledger.archon_run_id);
        return [[ledger, stat, snapshot, status] satisfies TickInput];
      });
    const cached = readTickCache(sa),
      candidates = inputs.some(input =>
        settledInTick(input, revisions?.get(input[0].archon_run_id), cached, asks, new Set())
      );
    const due = candidates ? optional(() => new Set(dueWorkflowContinuations())) : undefined;
    scheduled = {
      ...scheduleTickGroups(inputs, cached, revisions, asks, due),
      global: tick(sa, new Set(), true),
    };
  } finally {
    l.release();
  }
  return { ...scheduled, promotion: autoPromote() };
}

const optional = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};
const readTickCache = (sa: string): Record<string, string> => {
  const value = optional(() => readJson(join(sa, 'supervise-terminal.json')));
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === 'string')
    ? (value as Record<string, string>)
    : {};
};
type TickStat = Pick<Stats, 'mtimeMs' | 'size'>;
type TickInput = [Ledger, TickStat, string?, RunView['status']?];
const tickFingerprint = (l: Ledger, stat: TickStat, revision?: string): string | undefined =>
  revision ? JSON.stringify([l.archon_run_id, stat.mtimeMs, stat.size, revision]) : undefined;
const hasUnresolvedAsk = (l: Ledger, asks: Asks | undefined): boolean =>
  asks === undefined ||
  Object.entries(asks).some(
    ([key, ask]) => key.startsWith(`${l.run_id}:`) && (ask ? unresolved(ask) : false)
  );
export const settledInTick = (
  [l, stat]: TickInput,
  revision: string | undefined,
  cache: Record<string, string>,
  asks: Asks | undefined,
  due?: Set<string>
): boolean =>
  !!tickFingerprint(l, stat, revision) &&
  cache[l.run_id] === tickFingerprint(l, stat, revision) &&
  !hasUnresolvedAsk(l, asks) &&
  due !== undefined &&
  !due.has(l.archon_run_id);
export function scheduleTickGroups(
  inputs: TickInput[],
  cache: Record<string, string>,
  revisions: Map<string, string> | null,
  asks: Asks | undefined,
  due: Set<string> | undefined
) {
  const grouped = new Map<string, string[]>(),
    unavailable: string[] = [];
  for (const input of inputs) {
    const [ledger, , snapshot, status] = input;
    if (ledger.rejected === ledger.archon_run_id && !hasUnresolvedAsk(ledger, asks)) continue;
    if (settledInTick(input, revisions?.get(ledger.archon_run_id), cache, asks, due)) continue;
    if (snapshot) grouped.set(snapshot, [...(grouped.get(snapshot) ?? []), ledger.run_id]);
    else if (!['completed', 'cancelled'].includes(status ?? 'unknown'))
      unavailable.push(ledger.run_id);
  }
  return {
    groups: [...grouped].map(([snapshot, runs]) => ({ snapshot, runs })),
    unavailable: { count: unavailable.length, runs: unavailable.slice(0, 5) },
  };
}

/** 逐 run 隔离：坏 ledger、读不出的 asks.json 只让受影响的 run 报 action:error，其余照常处置；asks 读坏时不回写。
 *  没有 ledger 的 run 的 asks 条目随回写丢弃（坏 ledger 仍算有）。 */
function tick(
  sa: string,
  selected?: Set<string>,
  global = true
): {
  actions: Action[];
  gc: GcAction[];
  gc_ms?: number;
  scratch: ScratchAction[];
  skipped_terminal: number;
  repeated_errors: number;
} & ReturnType<typeof cockpitSignals> {
  let asks: Asks | Error;
  try {
    asks = loadAsks();
  } catch (e) {
    asks = e as Error;
  }
  const initialAsks = asks instanceof Error ? undefined : structuredClone(asks);
  const observed: HoldSignal[] = [];
  const out: Action[] = global ? reconcileIntents() : [];
  let dueContinuations: Set<string> | Error | undefined;
  const continuations = (): Set<string> | Error => {
    if (dueContinuations !== undefined) return dueContinuations;
    try {
      return (dueContinuations = new Set(dueWorkflowContinuations()));
    } catch (e) {
      dueContinuations = e as Error;
      out.push({
        run_id: 'continuations',
        action: 'error',
        ok: false,
        error: dueContinuations.message,
      });
      return dueContinuations;
    }
  };
  const inputs = ledgers(selected ? [...selected] : undefined);
  let revisions: Map<string, string> | null = null;
  try {
    revisions = reportRunRevisions(
      selected ? inputs.flatMap(l => ('error' in l ? [] : [l.archon_run_id])) : undefined
    );
  } catch (e) {
    console.error(`supervise-tick revision cache unavailable: ${(e as Error).message}`);
  }
  const cached = readTickCache(sa),
    terminal: Record<string, string> = { ...cached },
    live = new Set<string>(global ? ledgerIds() : []);
  let skippedTerminal = 0,
    repeatedErrors = 0,
    errorCached = false;
  for (const l of inputs) {
    live.add(l.run_id);
    let errorInput = l.run_id;
    try {
      const stamp = statSync(ledgerPath(l.run_id));
      errorInput = JSON.stringify([
        l.run_id,
        stamp.mtimeMs,
        stamp.size,
        'error' in l ? null : (revisions?.get(l.archon_run_id) ?? null),
      ]);
      if ('error' in l) throw new Error(l.error);
      if (!global && resolve(fixedEngineSnapshot(l) ?? '') !== runningEngineSnapshot())
        throw new Error('engine identity: executor run snapshot mismatch');
      const actor = l.controller ?? l.launcher;
      if (!actor)
        throw new Error(
          'coord: run 没有可验证 controller/launcher；请先 claim 并显式 resume/decide'
        );
      const revision = revisions?.get(l.archon_run_id),
        fingerprint = tickFingerprint(l, stamp, revision),
        hasAsk =
          !(asks instanceof Error) &&
          Object.entries(asks).some(([key, ask]) =>
            key.startsWith(`${l.run_id}:`) && ask ? unresolved(ask) : false
          );
      const cacheHit = fingerprint && cached[l.run_id] === fingerprint && !hasAsk;
      const due = cacheHit ? continuations() : undefined;
      if (cacheHit && due instanceof Set && !due.has(l.archon_run_id)) {
        terminal[l.run_id] = fingerprint;
        skippedTerminal++;
        continue;
      }
      let confirmedTerminal: string | undefined;
      const x = control(
        l,
        controller => {
          const due = continuations();
          const run = getRun(l.archon_run_id, l.repo);
          // prettier-ignore
          if (abandoned(l)) { if (!(asks instanceof Error)) supersedeAsks(asks, l.run_id); return { run_id: l.run_id, action: 'none', ok: true, state: 'abandoned' }; }
          const settledStatus =
            ['completed', 'cancelled'].includes(run.status) ||
            (run.status === 'failed' &&
              due instanceof Set &&
              !due.has(l.archon_run_id) &&
              (planOf(l).deadline === undefined || pastDeadline(l)));
          if (fingerprint && settledStatus) confirmedTerminal = fingerprint;
          if (
            due instanceof Set &&
            due.has(l.archon_run_id) &&
            !['completed', 'cancelled'].includes(run.status)
          )
            archonDetached(
              ['workflow', 'wake', l.archon_run_id, '--json'],
              join(sa, 'wake.log'),
              l.repo,
              false,
              l.engine_snapshot
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
      else if (confirmedTerminal && !hasAsk) terminal[l.run_id] = confirmedTerminal;
    } catch (e) {
      const action = {
        run_id: l.run_id,
        action: 'error',
        ok: false,
        error: tail((e as Error).message, 200),
      } satisfies Action;
      const signature = `error:${JSON.stringify([errorInput, action.error])}`;
      if (cached[l.run_id] === signature) repeatedErrors++;
      else out.push(action);
      terminal[l.run_id] = signature;
      errorCached = true;
    }
  }
  if (global)
    for (const run of Object.keys(terminal))
      if (!live.has(run)) Reflect.deleteProperty(terminal, run);
  if (revisions || errorCached)
    try {
      saveDelta(
        cached,
        terminal,
        () => readTickCache(sa),
        value => {
          writeAtomic(join(sa, 'supervise-terminal.json'), JSON.stringify(value));
        },
        join(sa, 'supervise-terminal.lock'),
        'supervise-terminal'
      );
    } catch (e) {
      console.error(`supervise-tick cache write failed: ${(e as Error).message}`);
    }
  if (global && !(asks instanceof Error)) {
    const mobile = existsSync(join(sa, 'console/decision-origin')),
      currentAsks = asks;
    if (mobile) out.push(...applyCoordIntents(currentAsks));
    for (const action of coord().tick((key, title) => pollCoordAsk(sa, currentAsks, key, title)))
      out.push({ run_id: 'coord', action: 'coord', ok: true, ...action });
    // gc.sh 删掉 ledger 后留下的条目在这里丢：asks.json 只有 tick 一个写者
    asks = Object.fromEntries(
      Object.entries(asks).filter(([k]) => k.startsWith('coord:') || live.has(k.split(':')[0]))
    );
    for (const [key, a] of mobile ? [] : Object.entries(asks)) {
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
    if (initialAsks) saveAsksDelta(initialAsks, asks);
  }
  if (!global && initialAsks && !(asks instanceof Error)) saveAsksDelta(initialAsks, asks);
  return {
    actions: out,
    skipped_terminal: skippedTerminal,
    repeated_errors: repeatedErrors,
    ...cockpitSignals(observed, asks instanceof Error ? {} : asks),
    gc: [],
    scratch: [],
  };
}

/** run → 挂起原因；undefined 不归 tick 管（运行中、终态、非编码节点失败）。签收自己处理截止，其余过了截止即 deadline。 */
export function holdOf(l: Ledger, run: RunView, c: Classified): Hold | undefined {
  if (c.state === 'held:engine_suspect') return pastDeadline(l) ? 'deadline' : 'engine_suspect';
  if (c.state === 'held:human') return 'signoff';
  const h: Hold | undefined =
    c.state === 'held:gate' || c.state === 'held:reclaim_pending'
      ? reasonHold(nodeReason(l, run, c))
      : c.state === 'held:environment'
        ? 'environment'
        : c.state === 'held:paused' || c.state === 'held:target_dirty'
          ? run.metadata?.approval
            ? 'approval'
            : 'paused'
          : c.state === 'failed' && /^(code|fix|repair)-/.test(c.node ?? '')
            ? 'coder'
            : undefined;
  return h && pastDeadline(l) ? 'deadline' : h;
}

const nodeReason = (l: Ledger, run: RunView, c: Classified): string => {
  if (coderBudgetExceeded(run, c)) return 'coder_budget';
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

/** Entry timestamp is stable across polls; stalled episodes follow provider progress, not heartbeats. */
function holdEpisode(l: Ledger, run: RunView, c: Classified, hold?: Hold): string {
  if (hold === 'stalled') {
    const attention = runAttention(run as Parameters<typeof runAttention>[0]);
    if (attention?.kind !== 'stalled_tool_calls') throw new Error('stalled attention missing');
    return attention.calls
      .map(call => `${call.nodeId}@${call.lastProgressAt}`)
      .sort()
      .join('|');
  }
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
      no: p.do === 'ask' && 'noText' in p ? p.noText : '终止整个run（保留证据）',
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
export function decisionQuestion(
  l: Ledger,
  run: RunView,
  c: Classified,
  hold: Hold,
  requestKey?: string
): string {
  const blocked = blocker(l, hold);
  if (blocked) return `${blocked.reason}；${blocked.next}`;
  if (hold === 'auto_recover') {
    // prettier-ignore
    const reason = c.state === 'held:reclaim_pending' ? (reasonOf('reclaim_pending')?.description ?? 'reclaim_pending') : (l.auto_recover_paused ?? 'recovery_admission_unknown');
    return askQuestion(
      hold,
      [basename(l.repo), l.run_id],
      [reason, reason],
      () => ['', ''],
      askMarker(requestKey ?? askKey(l.run_id, hold, holdEpisode(l, run, c, hold)))
    );
  }
  if (hold === 'stalled') {
    const attention = runAttention(run as Parameters<typeof runAttention>[0]);
    if (attention?.kind !== 'stalled_tool_calls') throw new Error('stalled attention missing');
    const call = attention.calls.reduce((a, b) => (a.stalledForMs >= b.stalledForMs ? a : b));
    const detail = `沉默${String(Math.floor(call.stalledForMs / 1000))}秒`;
    return askQuestion(
      hold,
      [basename(l.repo), call.nodeId],
      [detail, detail],
      () => ['', ''],
      askMarker(requestKey ?? askKey(l.run_id, hold, holdEpisode(l, run, c, hold)))
    );
  }
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
  else if (hold === 'acceptance_adjudication') {
    const a = out.adjudication as
      | { cases?: unknown; counts?: unknown; known?: unknown; report?: unknown }
      | undefined;
    detail = `用例${JSON.stringify(a?.cases ?? [])}；计数${JSON.stringify(a?.counts ?? {})}；known${JSON.stringify(a?.known ?? [])}；证据${typeof a?.report === 'string' ? a.report : '缺失'}`;
  } else if (hold === 'signoff') {
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
/** Project engine state and perform only policy-authorized automatic actions. */
function dispose(
  l: Ledger,
  asks: Asks | Error,
  observed: HoldSignal[],
  run: RunView
): Action | undefined {
  const c = classifyRun(l, run);
  const attention = runAttention(run as Parameters<typeof runAttention>[0]);
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
  const need = (): Asks => {
    if (asks instanceof Error) throw asks;
    return asks;
  };
  if (c.state === 'held:owner_unknown' || c.state === 'held:recovery_admission_unknown')
    return {
      run_id: l.run_id,
      action: 'none',
      ok: false,
      held: true,
      state: c.state,
      next: `Inspect archon workflow get ${run.id} --verbose; resolve ownership or abandon explicitly.`,
    };
  if (c.state === 'owner_lost') {
    const askPaused = (): Action =>
      record(
        l,
        'auto_recover',
        askHold(l, run, c, 'auto_recover', HOLD_POLICY.auto_recover, need(), {
          recovery_reason: l.auto_recover_paused,
        })
      );
    if (l.auto_recover_paused) return askPaused();
    const result = recoverRun(l, undefined, undefined, undefined, undefined, current =>
      reserveAutoRecovery(l, current)
    );
    if (!result.ok && result.held) {
      updateLedger(l, current => {
        current.auto_recover_paused ??= result.reason;
      });
      return askPaused();
    }
    if (!result.ok && result.refused)
      return {
        run_id: l.run_id,
        action: 'none',
        ok: true,
        state: c.state,
        next: result.reason,
      };
    return {
      run_id: l.run_id,
      action: 'auto_recover',
      ok: result.ok,
      ...(result.ok ? {} : { error: result.reason }),
    };
  }
  const reauthorize = reauthorizationHint(l, run, c);
  if (reauthorize)
    return { run_id: l.run_id, action: 'none', ok: false, state: c.state, next: reauthorize };
  const act = (hold: Hold, extra: Record<string, unknown> = {}): Action | undefined => {
    row.hold = hold;
    row.disposed =
      l.dispositions?.some(
        d => d.reason === hold && d.ok && Date.parse(d.at) >= Date.parse(row.since)
      ) ?? false;
    const p: Policy = HOLD_POLICY[hold];
    if (
      ['ask', 'signoff'].includes(p.do) &&
      existsSync(join(home().sa, 'console/decision-origin'))
    ) {
      const decision = describeDecision(l, run);
      if (decision && !decision.disabled)
        return {
          run_id: l.run_id,
          action: 'none',
          ok: false,
          held: true,
          transport: 'mobile',
          decision: decision.id,
          reason: '请在手机查看；未配对/未订阅不等于已通知，查看 console mobile-health',
        };
    }

    if (
      !(asks instanceof Error) &&
      ['ask', 'signoff'].includes(p.do) &&
      !(hold === 'signoff' && pastDeadline(l))
    )
      supersedeAsks(asks, l.run_id, hold, holdEpisode(l, run, c, hold));
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
  if (attention?.kind === 'stalled_tool_calls') return act('stalled');
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
export function reportSince(argv: readonly string[] = process.argv): string {
  const flag =
    argv.find(a => a.startsWith('--since='))?.slice(8) ?? argv[argv.indexOf('--since') + 1];
  const since = argv.some(a => a === '--since' || a.startsWith('--since='))
    ? /^\d{8}$/.test(flag)
      ? `${flag.slice(0, 4)}-${flag.slice(4, 6)}-${flag.slice(6, 8)}T00:00:00.000Z`
      : flag
    : '';
  if (since && !Number.isFinite(Date.parse(since)))
    throw new Error('--since must be YYYYMMDD or an ISO timestamp');
  return since;
}

export function summarize(pairs: Pair[], includeConsolidation = true): Record<string, unknown> {
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
  const summary = {
    runs: pairs.length,
    ...Object.fromEntries(Object.entries(n).sort()),
    unreadable,
  };
  if (!includeConsolidation) return summary;
  const since = reportSince();
  const titles = Bun.spawnSync(
    [
      'git',
      'log',
      ...(since ? [`--since=${since}`] : []),
      '--until=now',
      '--format=%s',
      '--',
      'wetamp',
    ],
    { cwd: join(WETAMP, '..'), stdout: 'pipe', stderr: 'pipe' }
  );
  return {
    ...summary,
    consolidation: consolidationMetrics(
      pairs,
      titles.exitCode === 0 ? titles.stdout.toString().trim().split('\n').filter(Boolean) : null,
      { since: since || 'all', until: 'now' }
    ),
  };
}

/** 全部登记 run 的计数摘要与用量台账（F-22，见 report.ts）。 */
export function report(engine?: { commit: string; baselineDays: number }): Record<string, unknown> {
  // F-02：坏 ledger 不进报表计算，单列在 unreadable，其余照常。
  const all = ledgers();
  const r = buildReport(
    all.flatMap(l => ('error' in l ? [] : [l])),
    engine,
    { humanDecisions: !engine }
  );
  if (engine) return { ...r, unreadable_ledgers: all.filter(l => 'error' in l).length };
  const bad = all.flatMap(l => ('error' in l ? [`${l.run_id}: ${l.error}`] : []));
  return {
    ...r,
    decisions: loadAsks(),
    human_decisions: {
      ...(r.human_decisions as DecisionInbox),
      unknown: [
        ...(r.human_decisions as DecisionInbox).unknown,
        ...all.flatMap(l => ('error' in l ? [l.run_id] : [])),
      ],
    },
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

type OptionName = keyof typeof OPTIONS;
interface CommandUsage {
  command: string;
  positionals?: string;
  flags: readonly OptionName[];
}

// task-kind is globally parsed only to preserve its targeted compatibility error.
// prettier-ignore
export const CLI_GLOBAL_OPTIONS = ['help', 'json', 'task-kind'] as const satisfies readonly OptionName[];
// prettier-ignore
export const CLI_COMMAND_USAGE: readonly CommandUsage[] = [
  { command: 'reclaim', flags: ['json'] },
  { command: 'owner', positionals: '[path|run]', flags: [] },
  { command: 'claim', positionals: '[path|run]', flags: ['takeover', 'reason'] },
  { command: 'reauthorize', positionals: '<run>', flags: [] },
  { command: 'release', positionals: '[path|run]', flags: [] },
  { command: 'handoff', flags: ['to', 'kind', 'title', 'body-file', 'evidence', 'severity'] },
  { command: 'inbox', positionals: '[accepted|rejected|done]', flags: ['all', 'ack', 'note'] },
  { command: 'plan', positionals: 'check <file>', flags: ['lint-override'] },
  { command: 'run', positionals: '<plan.json>', flags: ['fake', 'lint-override', 'allow-overlap', 'adopt'] },
  { command: 'quick', flags: ['goal', 'card', 'accept', 'accept-timeout', 'environment', 'console', 'scope', 'risk', 'review', 'no-cache', 'base', 'repo', 'request-ref', 'allow-overlap'] },
  { command: 'wait', positionals: '<run>', flags: ['timeout'] },
  { command: 'status', flags: [] },
  { command: 'brief', flags: [] },
  { command: 'land', positionals: '<run>', flags: ['apply'] },
  { command: 'resume', positionals: '<run>', flags: ['reconciled'] },
  { command: 'cancel', positionals: '<run>', flags: ['reason'] },
  { command: 'recover', positionals: '<run>', flags: ['evidence', 'reconciled'] },
  { command: 'abandon', positionals: '<run>...', flags: ['mine', 'status', 'before', 'reason'] },
  { command: 'decide', positionals: '<run> approve|reject|retry', flags: ['pkg', 'hint', 'all-held'] },
  { command: 'accept', positionals: '<run>', flags: ['pkg'] },
  { command: 'report', flags: ['full', 'since', 'by-engine', 'baseline-days'] },
  { command: 'memory', positionals: '[propose|publish]', flags: ['dry-run'] },
  { command: 'quota', flags: [] },
  { command: 'usage', flags: ['since', 'repo', 'refresh'] },
  { command: 'console', positionals: 'start|stop|status|url', flags: ['open'] },
  { command: 'gc', flags: ['dry-run'] },
  { command: 'scratch-clean', flags: ['session', 'dry-run'] },
  { command: 'supervise-tick', flags: ['schedule', 'runs', 'no-global'] },
  { command: 'maintenance-tick', flags: [] },
  { command: 'engine', positionals: 'promote <sha> | probe [G1|G2] | rollback | status | adopt <run> <sha> | gate-legacy', flags: ['bootstrap-evidence'] },
  { command: 'health', flags: ['cwd', 'verbose'] },
  { command: 'heartbeat', flags: ['watch', 'cwd', 'all'] },
  { command: 'board', positionals: '[run]', flags: ['once', 'interval', 'limit'] },
  { command: 'models', flags: ['mode'] },
  { command: 'job exec', positionals: '[-- <cmd...>]', flags: ['title', 'request-ref', 'card', 'prompt-file', 'output', 'log', 'role', 'mode', 'risk', 'round', 'author-model', 'worktree', 'base'] },
  { command: 'job clean', positionals: '<id>', flags: [] },
  { command: 'jobs', flags: ['all'] },
  { command: 'rollover', positionals: '<start|accept|wait|cancel|status|context> [token]', flags: ['reason', 'user', 'timeout'] },
];

const optionUsage = (name: OptionName): string => {
  const option = OPTIONS[name];
  const value = option.type === 'string' ? ` <${name}>${'multiple' in option ? '...' : ''}` : '';
  return ` [--${name}${value}]`;
};
export const USAGE = [
  'usage: superagent <command> [options]',
  ...CLI_COMMAND_USAGE.map(
    ({ command, positionals, flags }) =>
      `  ${command}${positionals ? ` ${positionals}` : ''}${flags.map(optionUsage).join('')}`
  ),
  '  global: [--help] [--json] (--task-kind is rejected)',
].join('\n');

function tickOutput(
  mode: TickMode = {},
  emit: (value: Record<string, unknown>) => void = value => {
    console.log(JSON.stringify(value));
  }
): number {
  const actions = superviseTick(mode);
  if (!('actions' in actions)) {
    emit(actions);
    return 0;
  }
  const gc = actions.gc.filter(item => item.action !== 'skipped'),
    scratch = actions.scratch.filter(item => item.action !== 'skipped');
  emit({
    ...actions,
    gc,
    scratch,
    gc_skipped: actions.gc.length - gc.length,
    scratch_skipped: actions.scratch.length - scratch.length,
  });
  return actions.actions.some(x => !x.ok && x.busy !== true) ? 1 : 0;
}

/** Console availability must not gate the unattended heartbeat. */
// prettier-ignore
export async function superviseTickCli(refresh = async (): Promise<unknown> => (await import('./web/server')).refreshConsole(), sync = async (snapshot: Snapshot): Promise<unknown> => (await import('./orca')).syncOrca(snapshot), mode: TickMode = {}, load = async (): Promise<Snapshot> => createLoader()(20), reclaimTask = reclaimTick, startMaintenance: () => unknown = import.meta.main ? launchMaintenance : () => undefined): Promise<number> {
  const errors: string[] = [];
  const stages = {} as Omit<TickRecord, 'at'>;
  const result = async (stage: keyof typeof stages, run: () => unknown, errorLabel: string = stage): Promise<unknown> => {
    const started = Date.now();
    try {
      const value = await run();
      stages[stage] = { ok: true, duration_ms: Date.now() - started, ...(value && typeof value === 'object' && 'skipped' in value ? { skipped: String(value.skipped) } : {}) };
      return value;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      stages[stage] = { ok: false, duration_ms: Date.now() - started, error };
      errors.push(`${errorLabel} failed: ${error}`);
      return undefined;
    }
  };
  if (!mode.noGlobal) await result('reclaim', reclaimTask);
  else stages.reclaim = { ok: true, duration_ms: 0, skipped: 'no-global' };
  let snapshot: Snapshot | undefined;
  if (!mode.noGlobal) snapshot = (await result('collect', async () => { const value = await load(); value.general = collectGenerals(value); return value; })) as Snapshot | undefined;
  else stages.collect = { ok: true, duration_ms: 0, skipped: 'no-global' };
  if (snapshot)
    await result('publish', () => {
      const path = join(home().sa, 'heartbeat.json'), now = Date.now();
      const next = heartbeat(snapshot, cockpit(snapshot, now), now, who => presence(who, home().sa));
      let previous: Heartbeat | undefined;
      try { previous = readJson(path) as Heartbeat | undefined; } catch { /* corrupt cache is replaced */ }
      const changed = shouldWriteHeartbeat(previous, next, now);
      if (changed) writeAtomic(path, JSON.stringify(next, null, 2) + '\n');
      return changed ? undefined : { skipped: 'unchanged' };
    });
  else stages.publish = { ok: true, duration_ms: 0, skipped: mode.noGlobal ? 'no-global' : 'collect-failed' };
  await result('console', () => mode.noGlobal ? { skipped: 'no-global' } : refresh(), 'console refresh');
  let output: Record<string, unknown> = {};
  const exit = ((await result('actions', () => tickOutput(mode, value => (output = value)))) as number | undefined) ?? 1;
  if (exit)
    stages.actions = {
      ok: false,
      duration_ms: stages.actions?.duration_ms ?? 0,
      error: 'tick actions failed',
    };
  await result('failover', () => mode.noGlobal ? { skipped: 'no-global' } : claudeCommanderFailover(), 'commander failover');
  await result('orca', async () => {
    if (mode.noGlobal) return { skipped: 'no-global' };
    const synced = snapshot ? await sync(snapshot) : { skipped: 'collect-failed' };
    if (synced && typeof synced === 'object' && 'error' in synced) throw new Error(String(synced.error));
    return synced;
  }, 'orca sync');
  const details = ['actions', 'gc', 'scratch'].flatMap(key =>
    Array.isArray(output[key])
      ? (output[key] as Record<string, unknown>[]).filter(item => item.action !== 'none')
      : []
  );
  const global = output.global as { gc_ms?: unknown } | undefined;
  const unavailable = output.unavailable as { count?: number } | undefined;
  const gcMs = typeof output.gc_ms === 'number' ? output.gc_ms : typeof global?.gc_ms === 'number' ? global.gc_ms : undefined;
  if (!mode.noGlobal) writeAtomic(join(home().sa, 'tick.json'), JSON.stringify({ at: new Date().toISOString(), ...stages }, null, 2) + '\n');
  if (!mode.noGlobal)
    try {
      startMaintenance();
    } catch (e) {
      const record = {
        at: new Date().toISOString(),
        maintenance: {
          ok: false,
          duration_ms: 0,
          error: e instanceof Error ? e.message : String(e),
        },
      };
      writeAtomic(join(home().sa, 'maintenance.json'), JSON.stringify(record, null, 2) + '\n');
    }
  console.log(
    JSON.stringify({
      heartbeat: new Date().toISOString(),
      action_count: details.length,
      error_count: details.filter(item => item.ok === false).length + errors.length,
      ...(gcMs === undefined ? {} : { gc_ms: gcMs }),
      ...(Array.isArray(output.groups) ? { groups: output.groups } : {}),
      ...(typeof unavailable?.count === 'number' && unavailable.count > 0 ? { unavailable } : {}),
      ...(details.length ? { details } : {}),
      ...(errors.length ? { errors } : {}),
    })
  );
  return exit;
}

export async function claudeCommanderFailover(
  health = () => readClaudeHealth(Date.now()),
  runs = () => coord().ownedNonterminalRuns('claude'),
  bin = orcaBin,
  launch = launchAgent,
  now = () => new Date()
): Promise<Record<string, unknown>> {
  const held = lock(join(home().sa, 'supervise.lock'));
  if (!held.ok) return { skipped: 'locked' };
  try {
    const state = health(),
      asks = loadAsks(),
      key =
        state.state === 'down' && state.changed_at
          ? `${FAILOVER_PREFIX}${state.changed_at}`
          : latestFailover(asks, ['yes', 'no'])?.[0];
    if (!key) return { skipped: 'claude_up' };
    const owned = runs();
    if (!owned.length) return { skipped: 'no_claude_commander_runs' };
    const projects = [...new Set(owned.map(run => basename(run.repo)))],
      ids = owned.map(run => run.run_id).join('、'),
      since = localHealthTime(key.slice(FAILOVER_PREFIX.length)),
      reason = `${String(state.cause?.class)} 连续重试 ${String(state.cause?.retries)} 次`,
      question = `${projects.join('、')}：Claude 不可用（自 ${since}，${reason}）。是否由 Codex 元帅接手 ${ids}？勾选=启动接手；删除=保持现状`;
    const context = (title: string): DecisionContext => ({
      request_key: key,
      source: 'supervise-tick',
      task_id: ids,
      initiator: 'superagent',
      action: '启动 Codex 元帅复核并接手',
      target: projects.join('、'),
      reason: title,
      recommendation: { choice: 'yes', reason: '恢复在途 run 的元帅决策能力' },
      consequences: { yes: '启动 Codex 元帅；复核后显式接管', no: 'ownership 不变' },
    });
    const mobile = existsSync(join(home().sa, 'console/decision-origin'));
    let polled;
    if (mobile) {
      const a = asks[key] ?? { status: 'pending', context: context(question) };
      asks[key] ??= a;
      saveAsk(asks, key);
      polled = { a };
    } else polled = pollAsk(key, () => question, MAX_TTL_H, asks, context);
    if ('conflict' in polled) throw new Error(polled.conflict);
    const a = polled.a;
    const receipt = (stage: AnswerReceipt['stage'], body: string): void => {
      a.receipt ??= { key: `${key}:result`, stage, body, at: now().toISOString() };
      if (mobile) saveAsk(asks, key);
      else deliverReceipt(undefined, key, a, asks);
    };
    if (['approved', 'rejected'].includes(a.status)) return { skipped: 'answered' };
    if (!['yes', 'no'].includes(a.status)) return { status: a.status, asked: polled.asked };
    a.status = a.status === 'yes' ? 'approved' : 'rejected';
    saveAsk(asks, key);
    if (a.status === 'rejected') {
      receipt('succeeded', '已保持现状；ownership 未变');
      return { status: 'rejected' };
    }
    const recovered = health();
    if (recovered.state === 'up') {
      receipt(
        'succeeded',
        `Claude 已于 ${localHealthTime(recovered.observed_at ?? now().toISOString())} 恢复，未接管；ownership 未变`
      );
      return { status: 'recovered' };
    }
    const model = resolveRoute(loadTiers(), 'codex', 'single:chatgpt', 'command').candidates[0]
        .model,
      checked = now().toISOString(),
      executable = bin(),
      results: AgentLaunch[] = [];
    const manual = owned
      .map(
        run =>
          `superagent brief ${run.run_id}；复核 owner/generation=${String(run.generation)}；superagent claim ${run.run_id} --takeover --reason ${JSON.stringify(`${question}；用户于 ${checked} 勾选`)}；superagent reauthorize ${run.run_id}`
      )
      .join('；');
    if (executable)
      for (const repo of [...new Set(owned.map(run => run.repo))]) {
        const selected = owned.filter(run => run.repo === repo),
          prompt = `Claude 熔断接手。逐 run 执行：${selected.map(run => `先 superagent brief ${run.run_id}；再用 superagent owner ${run.run_id} --json 复核 owner 仍为 ${JSON.stringify(run.owner)} 且 generation=${String(run.generation)}，不一致立即停止；然后 superagent claim ${run.run_id} --takeover --reason ${JSON.stringify(`${question}；用户于 ${checked} 勾选`)}；再 superagent reauthorize ${run.run_id} 并继续该 run`).join('\n')}`;
        const args = ['agent', 'launch', '--agent', 'codex', '--focus', '--json'];
        args.push('--worktree', `path:${repo}`);
        args.push('--model', model);
        args.push('--prompt', prompt);
        results.push(await launch(executable, args));
      }
    const stage: AnswerReceipt['stage'] =
      !executable || results.some(r => r.kind === 'failed')
        ? 'failed'
        : results.some(r => r.kind !== 'launched')
          ? 'unknown'
          : 'succeeded';
    receipt(
      stage,
      stage === 'succeeded'
        ? `已按 ${String(results.length)} 个仓库启动 Codex 元帅；ownership 由新元帅复核后显式变更`
        : `未确认启动；ownership 未变。人工执行：${manual}`
    );
    return { status: stage, launches: results.length };
  } finally {
    held.release();
  }
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
  if (
    ['run', 'quick'].includes(verb) &&
    process.env.DATABASE_URL &&
    !a.flags['allow-overlap']?.trim()
  ) {
    print({
      ok: false,
      status: 'rejected',
      reason: 'scope_overlap',
      overlap_warnings: [
        {
          run_id: 'unknown',
          paths: [],
          error:
            'DATABASE_URL: status unavailable; SQLite-only runtime requires a separate SQLite ARCHON_HOME',
        },
      ],
    });
    return EXIT_USAGE;
  }
  assertEngineAccess(argv);
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
    case 'reclaim':
      print(reclaimOnce());
      return 0;
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
        mode = a.flags.mode ?? 'auto',
        health = refreshClaudeHealth().health,
        state = routeState(tiers, mode, Date.now(), health);
      // prettier-ignore
      const models = Object.fromEntries((['claude', 'codex'] as const).map(c => [c,
        Object.fromEntries(TIERS.map(r => [r, resolveRoute(tiers, c, mode, ROUTE_ROLE[r], 'G1', 1, [], false, state).candidates.map(a => a.model)]))]));
      if (a.flags.json) print({ ...models, budget: state.budget, route_state: state });
      else
        for (const [c, roles] of Object.entries(models))
          for (const [r, candidates] of Object.entries(roles))
            console.log(`${c} ${r}: ${candidates.join(', ')}`);
      if (!a.flags.json && routeNotice(state)) console.log(routeNotice(state));
      return 0;
    }
    case 'owner':
    case 'claim':
    case 'reauthorize':
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
              coord().tick((key, title) => pollCoordAsk(home().sa, asks, key, title));
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
      const { plan_lint, rules_added } = checkedPlan(a._[2], a.flags['lint-override']);
      if (plan_lint.rejected)
        throw new Error(`preflight: plan lint: ${plan_lint.warnings.join('; ')}`);
      print({ ok: true, plan_lint, rules_added });
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
      if (s.state === 'completed') s.delivery = deliveryProjection(l);
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
      if (refuseAbandoned(resolved)) return 1;
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
      if (!(CANCELLATION_REASONS as readonly string[]).includes(reason))
        throw new Error(`cancel --reason must be an operational label: ${CANCELLATION_REASONS.join('|')}`);
      // 未登记：按 archon run id 处理（selftest 用）
      const resolved = resolveTarget(id);
      const result =
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
                  if (cancelled.ok) {
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
      print({ run_id: id, ...result });
      return result.ok ? 0 : 1;
    }
    case 'abandon':
      return abandon(a);
    case 'decide':
      if (a.flags['all-held']) {
        if (target !== 'retry') throw new Error('usage: superagent decide --all-held retry');
        return retryAllHeld();
      }
      {
        const l = ledger(true);
        if (refuseAbandoned(l)) return 1;
        return controlled(l, () => decide(l, a), false);
      }
    case 'brief':
      return brief(ledger(), !!a.flags.json);
    case 'land': {
      const historical = process.env.SA_HISTORICAL_RUN === target && !a.flags.apply;
      const l = ledger(!historical);
      if (a.flags.apply) {
        if (refuseAbandoned(l)) return 1;
        const run = getRun(l.archon_run_id, l.repo);
        const c = classifyRun(l, run);
        if (run.nodes?.some(n => /^(?:sync|publish)-.+$/.test(authoredNodeId(n.nodeId)))) {
          const receipt = publishProjection(l, run);
          if (receipt) {
            print(receipt);
            return 0;
          }
          return controlled(
            l,
            () => {
              if (c.state === 'held:target_dirty') {
                const result = intervention(l, 'land', () => approveRun(l));
                print({ run_id: l.run_id, action: 'retry_publish', ...result });
                return result.ok ? 0 : result.held ? EXIT.held : 1;
              }
              return resumeRun(l, undefined, 'land');
            },
            false
          );
        }
        throw new Error('legacy delivery removed; run is terminal');
      }
      const display = (): number => {
        const run = getRun(l.archon_run_id, l.repo);
        const c = classify(run);
        const diagnosticNode = /^land(?:-.+)?$/.test(c.node ?? '')
          ? c.node
          : !run.nodes?.length
            ? 'land'
            : undefined;
        const evidence =
          landEvidence(run) ?? (diagnosticNode ? landEvidence(run, diagnosticNode) : undefined);
        let land = evidence && evidenceJson(l, artifactsOf(run), evidence.file);
        if (land === undefined) {
          console.error(`land: no land.json yet (state ${c.state})`);
          return 1;
        }
        const receipt = deliveryProjection(l);
        if (receipt)
          land = { ...(land as Land), status: 'integrated', integrated: receipt.integrated };
        const needs = needsOf(artifactsOf(run), undefined, l);
        print(
          a.flags.json && needs.length ? { ...(land as Record<string, unknown>), needs } : land
        );
        if (!a.flags.json)
          for (const n of needs) console.log(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
        return (land as { reason?: string }).reason === 'land_target_unknown' ? 1 : 0;
      };
      return historical ? display() : controlled(l, display);
    }
    case 'accept': {
      ledger();
      throw new Error('legacy delivery removed; run is terminal');
    }
    case 'gc':
      print({ gc: gc(a.flags['dry-run']) });
      return 0;
    case 'scratch-clean':
      print({ scratch: scratchClean(a.flags.session, a.flags['dry-run']) });
      return 0;
    case 'supervise-tick':
      return tickOutput({
        schedule: a.flags.schedule,
        runs: a.flags.runs,
        noGlobal: a.flags['no-global'],
      });
    case 'maintenance-tick':
      print(maintenanceTick());
      return 0;
    case 'engine': {
      const result = engineCommand([
        ...a._.slice(1),
        ...(a.flags['bootstrap-evidence']
          ? ['--bootstrap-evidence', a.flags['bootstrap-evidence']]
          : []),
      ]);
      print(result);
      return ['gate-legacy', 'probe'].includes(a._[1] ?? '') && !(result as { ok?: boolean }).ok
        ? 1
        : 0;
    }
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
    case 'heartbeat':
      console.error('heartbeat is async: run it through bin/superagent');
      return EXIT_USAGE;
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

async function heartbeatCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (a._.length !== 1 || (a.flags.all && a.flags.cwd))
    throw new Error('usage: superagent heartbeat [--watch] [--cwd <absolute-path>|--all]');
  let filter = allMarshals;
  if (!a.flags.all) {
    let cwd = a.flags.cwd;
    if (!cwd) {
      const git = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (git.exitCode !== 0)
        throw new Error('heartbeat: current directory is not inside a git repository');
      cwd = git.stdout.toString().trim();
    }
    filter = cwdFilter(cwd);
  }
  const readModel = () =>
    panelModel(
      readJson(join(home().sa, 'heartbeat.json')) as Heartbeat | undefined,
      readJson(join(home().sa, 'tick.json')) as TickRecord | undefined,
      Date.now(),
      filter
    );
  const draw = (): string =>
    renderPanel(
      readJson(join(home().sa, 'heartbeat.json')) as Heartbeat | undefined,
      readJson(join(home().sa, 'tick.json')) as TickRecord | undefined,
      Date.now(),
      filter,
      process.stdout.columns || 100,
      process.stdout.isTTY
    );
  if (!a.flags.watch) {
    console.log(draw());
    return 0;
  }
  const startedEngine = currentEngineSnapshot();
  if (process.stdout.isTTY) {
    const [{ createElement }, ink, { HeartbeatView }] = await Promise.all([
      import('react'),
      import('ink'),
      import('./board/HeartbeatView'),
    ]);
    const quota = (): string | undefined => relayQuota().quota;
    let watchExit = 0;
    const app = ink.render(
      createElement(HeartbeatView, {
        initial: readModel(),
        load: readModel,
        initialQuota: quota(),
        loadQuota: quota,
        beforeRefresh: () => (watchExit = heartbeatEngineExitCode(startedEngine)),
      }),
      { alternateScreen: true, incrementalRendering: true, maxFps: 4 }
    );
    await app.waitUntilExit();
    return watchExit;
  }
  let resolveStop: (value: 'stop') => void = () => undefined;
  const interrupted = new Promise<'stop'>(resolve => {
    resolveStop = resolve;
  });
  const stop = (): void => {
    resolveStop('stop');
  };
  process.once('SIGINT', stop);
  try {
    for (;;) {
      process.stdout.write(`\x1b[2J\x1b[H${draw()}\n`);
      if ((await Promise.race([Bun.sleep(15_000), interrupted])) === 'stop') break;
      const exit = heartbeatEngineExitCode(startedEngine);
      if (exit) return exit;
    }
  } finally {
    process.removeListener('SIGINT', stop);
  }
  return 0;
}

export function heartbeatEngineExitCode(
  started: string | undefined,
  current: () => string | undefined = currentEngineSnapshot
): number {
  if (!started) return 0;
  const resolved = current();
  return resolved && resolved !== started ? ENGINE_CHANGED : 0;
}

// Keep this module synchronous: land loads operator evidence lazily via require().
async function runCli(): Promise<void> {
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
    if (
      [
        'board',
        'usage',
        'heartbeat',
        'supervise-tick',
        'console',
        'web',
        'job',
        'jobs',
        'rollover',
      ].includes(verb ?? '')
    )
      assertEngineAccess(argv);
    if (verb === 'board') process.exit(await (await import('./board/index')).board(argv));
    if (verb === 'usage') process.exit(await usageCli(argv));
    if (verb === 'heartbeat') process.exit(await heartbeatCli(argv));
    if (verb === 'supervise-tick') {
      const parsed = parseArgs(argv);
      process.exit(
        await superviseTickCli(undefined, undefined, {
          schedule: parsed.flags.schedule,
          runs: parsed.flags.runs,
          noGlobal: parsed.flags['no-global'],
        })
      );
    }
    if (verb === 'console' || verb === 'web')
      process.exit(await (await import('./web/server')).webCli(argv));
    if (verb === 'job' || verb === 'jobs') process.exit(await jobCli(argv));
    if (verb === 'rollover') {
      const parsed = parseArgs(argv),
        command = parsed._[1],
        token = parsed._[2];
      const result = await (
        await import('./rollover')
      ).rolloverCommand(command, token, {
        reason: parsed.flags.reason,
        user: parsed.flags.user,
        timeout: parsed.flags.timeout ? Number(parsed.flags.timeout) : undefined,
      });
      if (parsed.flags.json) print(result.value);
      // prettier-ignore
      else console.log(typeof result.value === 'string' ? result.value : Array.isArray(result.value) ? result.value.map(v => JSON.stringify(v)).join('\n') : JSON.stringify(result.value));
      process.exit(result.exit);
    }
    process.exit(main(argv));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}
// Let Bun finish evaluating the entry module before land can require it back.
if (import.meta.main) queueMicrotask(() => void runCli());
