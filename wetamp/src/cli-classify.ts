import { parseDbTimestamp } from '@archon/workflows/duration';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { workflowEventRowSchema } from '../../packages/workflows/src/schemas/workflow-event';
import { providerEventEnvelopeSchema } from '../../packages/workflows/src/schemas/provider-event';
import {
  type DeliveryDecision,
  type decide as decideGate,
} from '../templates/.archon/scripts/sa-check';
import {
  archonJson,
  archonRunIds,
  errorExcerpt,
  lastJson,
  lock,
  ownerLost,
  QUERY_TIMEOUT_MS,
  tail,
  type RunView,
} from './archon';
import { confined, OUTSIDE, workflowRoles } from './board/workflow';
import type { Asks, Ledger } from './cli';
import { gitHead, home, writeAtomic } from './config';
import { coord, type Controller } from './coord';
import type { Continuation, ReviewCheckpoint } from './generate';
import {
  authoredNodeId,
  deliveryProjection,
  landEvidence,
  publishProjection,
  targetCheckout,
  type DeliveryTarget,
} from './land';
import { artifactsOf, evidenceJson, ledgerPath, loadLedger, readJson } from './ledger';
import type { NodeLeaseRecord } from './node-lease';
import { nodeProgress } from './node-progress';
import type { Plan } from './plan';
import {
  CLASSIFIED_HOLD_REASONS,
  HOLD_POLICY,
  holdAction,
  reasonOf,
  type ClassifiedHold,
  type Hold,
} from './reasons';
import { ownershipUnknown, recoveryAdmissionAction, recoveryAdmissionUnknown } from './recovery';
import { redact } from './redact';

// Generation and ledger metrics reach the CLI through existing consumers. Load them on demand.
const load = createRequire(import.meta.url);

export const print = (o: unknown): void => {
  console.log(JSON.stringify(o, null, 2));
};

/** 0 completed；1 failed；2 cancelled；3 held（等元帅/用户决策）；4 仍在运行（wait 超时或 status 查询）。 */
export const EXIT = { completed: 0, failed: 1, cancelled: 2, held: 3, running: 4 } as const;
export const EXIT_USAGE = 64;

export const nodeLeaseNextAction = (runId: string): string =>
  `superagent wait ${runId}；或 superagent cancel ${runId} --reason operator`;

export const planOf = (l: Ledger): Plan =>
  JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;

/** 过了 plan 的绝对 deadline，签收节点与 land 都会拒绝、supervise-tick 会取消 run；approve 在此提前拒绝，不发无效 signal。 */
export const pastDeadline = (l: Ledger): boolean => {
  const deadline = planOf(l).deadline;
  return deadline !== undefined && Date.now() > Date.parse(deadline);
};

export const asksPath = (): string => join(home().sa, 'asks.json');

/** 读不出就抛错：把截断或损坏的 asks.json 当空表，会让每个挂起再投一遍提醒。 */
export const loadAsks = (): Asks => {
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

export const withFileLock = <T>(path: string, label: string, operation: () => T): T => {
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

export const withAsksLock = <T>(operation: () => T): T =>
  withFileLock(join(home().sa, 'asks.lock'), 'asks', operation);

export const writeAsks = (asks: Asks): void => {
  writeAtomic(asksPath(), JSON.stringify(asks, null, 2) + '\n');
};

/** Persist exactly one decision key; other runs and coord writers retain their latest values. */
export const saveAsk = (asks: Asks, key: string): void => {
  withAsksLock(() => {
    const latest = loadAsks();
    if (asks[key] === undefined) Reflect.deleteProperty(latest, key);
    else latest[key] = asks[key];
    writeAsks(latest);
  });
};

/** 某个 run 的提问；键 `<run>:<挂起类别>`：resumeAt 变了也不重投。 */
export const asksOf = (run: string): Asks =>
  Object.fromEntries(Object.entries(loadAsks()).filter(([k]) => k.startsWith(`${run}:`)));

export function decisionSummary(run: string): Asks | { error: string } {
  try {
    return asksOf(run);
  } catch (e) {
    return { error: tail((e as Error).message, 200) };
  }
}

export interface Classified {
  state: string;
  exit: number;
  node?: string;
  event?: string;
}

export { CLASSIFIED_HOLD_REASONS };
export const heldState = <T extends ClassifiedHold>(hold: T): `held:${T}` => `held:${hold}`;

/** archon run 状态 → superagent 状态。environment 失败是“待决策”而非终局失败：decide retry 可 resume。 */
export function classify(run: RunView): Classified {
  if (!['completed', 'cancelled'].includes(run.status) && recoveryAdmissionUnknown(run))
    return { state: heldState('recovery_admission_unknown'), exit: EXIT.held };
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
      if (approval?.nodeId.startsWith('human-scope-'))
        return { state: heldState('scope'), exit: EXIT.held, node: approval.nodeId };
      if (
        approval?.nodeId.startsWith('human-') &&
        (approval as typeof approval & { resolved?: string }).resolved === 'rejected'
      )
        return { state: heldState('rework'), exit: EXIT.held, node: approval.nodeId };
      if (approval?.nodeId.startsWith('human-'))
        return { state: heldState('human'), exit: EXIT.held, node: approval.nodeId };
      if (
        approval?.nodeId.startsWith('target-dirty-') ||
        (approval?.nodeId.startsWith('integrate-') && bodyGateId?.startsWith('target-dirty-'))
      )
        return { state: heldState('target_dirty'), exit: EXIT.held, node: approval.nodeId };
      return event?.startsWith('sa.human.')
        ? { state: heldState('human'), exit: EXIT.held, node: run.metadata?.wait?.nodeId, event }
        : {
            state: heldState('paused'),
            exit: EXIT.held,
            node: run.metadata?.approval?.nodeId ?? run.metadata?.wait?.nodeId,
          };
    }
    case 'failed':
      if (failed === 'environment')
        return { state: heldState('environment'), exit: EXIT.held, node: failed };
      return { state: 'failed', exit: EXIT.failed, node: failed };
    default:
      // A pending row is Archon's detached launch before its child claims it: no execution owner
      // exists yet, so that absence is not ambiguity. Report pending and keep waiting; only
      // recovery must refuse to act on it.
      //
      // A running row that records no owner at all and has started no node is the same
      // launch, one step later: the child wins the pending-to-running claim and records its
      // execution owner in a separate write, sampling the checkout in between, so a wait
      // issued right after launch can read that gap. Keep waiting instead of reporting a hold
      // the run will outlive. A recorded owner this host cannot verify — another host, or a
      // reused pid — is genuine ambiguity, and so is an absent owner once a node has started:
      // that run was executing and nobody is claiming it.
      if (
        run.status === 'running' &&
        ownershipUnknown(run) &&
        (run.metadata?.execution_owner || run.nodes?.length)
      )
        return { state: heldState('owner_unknown'), exit: EXIT.held };
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

const coderReceiptFields = (l: Ledger, art: string) => {
  const receipts = existsSync(art)
    ? readdirSync(art)
        .filter(file => file.endsWith('.coder.json'))
        .flatMap(file => {
          const value = evidenceJson(l, art, file) as Record<string, unknown> | undefined;
          return value ? [value] : [];
        })
    : [];
  const unverified = [
    ...new Set(
      receipts.flatMap(value =>
        Array.isArray(value.unverified)
          ? value.unverified.filter((item): item is string => typeof item === 'string')
          : []
      )
    ),
  ];
  const deviations = receipts
    .flatMap((value): unknown[] =>
      Array.isArray(value.deviations) ? (value.deviations as unknown[]) : []
    )
    .filter(
      (item): item is { path: string; why: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { path?: unknown }).path === 'string' &&
        typeof (item as { why?: unknown }).why === 'string'
    )
    .filter(
      (item, index, all) =>
        all.findIndex(other => other.path === item.path && other.why === item.why) === index
    );
  return { unverified, deviations };
};

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
export const ledgers = (ids = ledgerIds()): (Ledger | { run_id: string; error: string })[] =>
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
        const atMs = parseDbTimestamp(at);
        if (Number.isFinite(atMs) && (!latest || atMs >= parseDbTimestamp(latest.at)))
          latest = { run_id: id, node: e.step_name, at, type };
      }
    } catch { missing.push(id); }
  }
  return { latest, complete: missing.length === 0, missing };
}

export const reasonToken = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_:+-]{0,79}$/.test(v) ? v : undefined;

export function targetCheckoutAction(l: Ledger, delivery: DeliveryTarget): string {
  const listed = Bun.spawnSync(
    ['git', '-C', delivery.checkout, 'worktree', 'list', '--porcelain', '-z'],
    { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
  );
  const occupied =
    listed.exitCode === 0 ? targetCheckout(listed.stdout.toString(), delivery.branch) : undefined;
  const prefix =
    occupied && resolve(occupied) !== resolve(delivery.checkout)
      ? `先在 ${occupied} 切走 ${delivery.branch}，再`
      : '';
  return `${prefix}把 ${delivery.checkout} 切回 ${delivery.branch} 后执行 superagent land --apply ${l.run_id}`;
}

export const coderBudgetExceeded = (run: RunView, c: Classified): boolean => {
  const lifecycle = run.nodes?.find(n => n.nodeId === c.node)?.execution?.lifecycle;
  return (
    /^(code|fix|repair)-/.test(c.node ?? '') &&
    lifecycle?.status === 'failed' &&
    lifecycle.providerFailure?.class === 'budget_exceeded'
  );
};

export const nodeReason = (l: Ledger, run: RunView, c: Classified): string => {
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

/** run → 挂起原因；undefined 不归 tick 管（运行中、终态、非编码节点失败）。签收自己处理截止，其余过了截止即 deadline。 */
export function holdOf(l: Ledger, run: RunView, c: Classified): Hold | undefined {
  if (c.state === 'held:engine_suspect') return pastDeadline(l) ? 'deadline' : 'engine_suspect';
  if (c.state === 'held:target_switched') return pastDeadline(l) ? 'deadline' : 'target_switched';
  if (c.state === 'held:human') return 'signoff';
  const h: Hold | undefined =
    c.state === 'held:gate' || c.state === 'held:reclaim_pending'
      ? reasonHold(nodeReason(l, run, c))
      : c.state === 'held:environment'
        ? 'environment'
        : c.state === 'held:paused' || c.state === 'held:scope' || c.state === 'held:target_dirty'
          ? run.metadata?.approval
            ? 'approval'
            : 'paused'
          : c.state === 'failed' && /^(code|fix|repair)-/.test(c.node ?? '')
            ? 'coder'
            : undefined;
  return h && pastDeadline(l) ? 'deadline' : h;
}

export function blocker(l: Ledger, hold: Hold): { reason: string; next: string } | undefined {
  const p = HOLD_POLICY[hold];
  return p.do === 'blocked'
    ? {
        reason: `${hold}: ${p.text}`,
        next: `${p.next}；superagent brief ${l.run_id}；条件修复后显式 ${holdAction(l.run_id, hold)}（红线不变）`,
      }
    : undefined;
}

// prettier-ignore
export function terminalProjection(l: Ledger, run: RunView, c: Classified) {
  if (c.exit === EXIT.running) return { delivery_state: 'pending' as const, receipt: undefined };
  const art = artifactsOf(run),
    node = run.nodes?.find(n => n.nodeId === c.node),
    landError = [...(l.intervention_events ?? [])]
      .reverse()
      .find(e => e.action === 'land' && !e.ok)?.error,
    landReason = l.delivery_result?.status === 'blocked'
      ? reasonToken(l.delivery_result.reason)
      : landError?.startsWith('land_') ? reasonToken(landError.slice(5)) : undefined,
    registered = reasonToken(c.node ? nodeReason(l, run, c) : undefined),
    integrationReason = c.state === 'held:target_switched' ? 'target_switched'
      : ['held:target_dirty', 'target_dirty'].includes(c.state) ? 'target_dirty'
      : ['sync_conflict', 'target_checkout_changed', 'target_advanced', 'review_stale'].includes(c.state) ? c.state : undefined,
    reason = landReason ?? integrationReason ?? (registered && reasonOf(registered) ? registered : undefined) ??
      holdOf(l, run, c) ?? reasonToken(run.metadata?.stop_reason?.reason) ?? 'unclassified',
    evidence = [
      landReason && join(art, 'delivery.json'),
      ['target_dirty', 'target_checkout_changed', 'target_switched'].includes(reason) && c.node && join(art, `${authoredNodeId(c.node)}.json`),
      c.node && join(art, `${c.node}.json`),
      run.transcript_path, l.log, l.transcript, art, ledgerPath(l.run_id),
    ].find((p): p is string => typeof p === 'string' && p !== '' && existsSync(p)) ??
      ledgerPath(l.run_id),
    published = publishProjection(l, run),
    integrated = l.delivery_result?.status === 'integrated' || !!deliveryProjection(l),
    blocked = landReason ?? (/^(?:land|deliver|publish)(?:-.+)?$/.test(authoredNodeId(c.node ?? '')) && node?.state === 'failed'),
    reauthorize = reauthorizationHint(l, run, c),
    action = c.state === 'held:recovery_admission_unknown' ? recoveryAdmissionAction(l.run_id)
      : reauthorize ?? (reason === 'target_protected' ? '在 feature 分支重跑'
      : reason === 'target_dirty' ? `superagent land --apply ${l.run_id}`
      : ['target_checkout_changed', 'target_switched'].includes(reason) && l.delivery ? targetCheckoutAction(l, l.delivery)
      : c.state === 'owner_lost' ? `superagent recover ${l.run_id}`
      : c.state === 'held:human' ? `superagent decide ${l.run_id} approve`
      : c.state === 'held:paused' ? `superagent resume ${l.run_id}`
      : c.state.startsWith('held:') ? holdAction(l.run_id, reason)
      : ['sync_conflict', 'target_advanced', 'review_stale'].includes(c.state) ? `superagent recover ${l.run_id}`
      : ['failed', 'cancelled'].includes(c.state) ? `superagent recover ${l.run_id}`
      : c.state === 'abandoned' ? 'none' : '读 evidence_path');
  const delivery_state = published ? 'published' as const : integrated ? 'integrated' as const : blocked ? 'blocked' as const : 'not_reached' as const;
  return {
    delivery_state, receipt: { state: c.state, failed_node: c.node ?? null, reason, evidence_path: evidence, action },
    ...(c.state === 'held:recovery_admission_unknown' ? { action } : c.state === 'held:owner_unknown'
      ? { action: `Inspect archon workflow get ${run.id} --verbose and its owner; resolve or abandon explicitly.` } : {}),
  };
}

export function reauthorizationHint(l: Ledger, run: RunView, c: Classified): string | undefined {
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

export const workflowIdentity = (l: Ledger): string | undefined => l.workflow_hash ?? l.engine_hash;

/** ≤20 行的摘要：元帅只读这个和证据路径。 */
export function summary(
  l: Ledger,
  run: RunView,
  c: Classified,
  lease?: NodeLeaseRecord
): Record<string, unknown> {
  const nodes = run.nodes ?? [];
  const roles = workflowRoles(l);
  const art = artifactsOf(run);
  const landFile = landEvidence(run)?.file;
  confined(l, art);
  const needs = needsOf(art, undefined, l);
  const receiptFields = coderReceiptFields(l, art);
  const outOfScope = c.exit === EXIT.running ? [] : outOfScopeOf(l, art);
  const hold = lease ? undefined : holdOf(l, run, c);
  const projection = lease
    ? {
        delivery_state: 'pending' as const,
        receipt: {
          state: c.state,
          failed_node: lease.node,
          reason: 'budget_exceeded',
          evidence_path: lease.evidence ?? artifactsOf(run),
          action: nodeLeaseNextAction(l.run_id),
        },
      }
    : terminalProjection(l, run, c);
  return {
    run_id: l.run_id,
    initiator: l.launcher ?? 'unknown',
    ...(hold ? blocker(l, hold) : {}),
    decisions: decisionSummary(l.run_id),
    engine:
      workflowIdentity(l) === (load('./generate') as typeof import('./generate')).engineHash()
        ? 'current'
        : `stale(${workflowIdentity(l)?.slice(0, 8) ?? 'unknown'})`,
    adoption: l.adoptions?.at(-1) ?? null,
    package_history: l.adoptions?.at(-1)?.packages ?? {},
    last_activity: lastActivity(l),
    progress: nodeProgress(
      run,
      planOf(l),
      Date.now(),
      roles
        ? new Set([...roles].flatMap(([id, role]) => (role === 'coder' ? [id] : [])))
        : undefined
    ),
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
    ...receiptFields,
    ...(outOfScope.length ? { out_of_scope: outOfScope } : {}),
    recoveries: l.recoveries?.length ?? 0,
    auto_retries: l.auto_retries?.length ?? 0,
    ...(needs.length ? { needs } : {}),
    ...(l.reason ? { reason: l.reason } : {}),
    ...(Object.values(l.node_leases ?? {}).some(lease => lease.engine_run === run.id)
      ? { node_leases: l.node_leases }
      : {}),
    ...(lease ? { reason: 'budget_exceeded', next: nodeLeaseNextAction(l.run_id) } : {}),
  };
}

/**
 * failed 的原因：有失败节点取节点 error；没有（启动失败、executor 在节点外出错、进程被信号终止）则取引擎写的
 * run 级 error（终局记录优先）与停止原因类别，并给出能看到全文的证据路径。错误文本先脱敏再截断。
 */
export function failure(
  l: Ledger,
  run: RunView,
  node: string | undefined
): Record<string, unknown> {
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

/** Read-only delivery evidence projection; ledger counters never decide execution lifecycle. */
export function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
  const { abandoned } = load('./ledger-metrics') as typeof import('./ledger-metrics');
  if (abandoned(l)) return { ...c, state: 'abandoned', exit: EXIT.cancelled };
  if (run.status === 'cancelled') return c;
  if (coderBudgetExceeded(run, c)) return { ...c, state: heldState('gate'), exit: EXIT.held };
  if ((run.status === 'failed' || run.status === 'paused') && c.node) {
    const art = artifactsOf(run),
      failedNodes =
        run.status === 'failed' ? (run.nodes ?? []).filter(n => n.state === 'failed') : [];
    if (run.status === 'failed') {
      const currentAttemptStartedAt = parseDbTimestamp(
          failedNodes.find(node => node.nodeId === c.node)?.startedAt ?? ''
        ),
        evidenceNode = failedNodes.find(
          node =>
            /^(?:re)?sync-.+$|^publish-.+$/.test(authoredNodeId(node.nodeId)) &&
            (node.nodeId === c.node ||
              (Number.isFinite(currentAttemptStartedAt) &&
                parseDbTimestamp(node.startedAt ?? '') >= currentAttemptStartedAt))
        )?.nodeId,
        projected = evidenceNode ? { ...c, node: evidenceNode } : c,
        authored = authoredNodeId(evidenceNode ?? c.node);
      const publish = /^(?:re)?sync-.+$|^publish-.+$/.test(authored)
        ? (evidenceJson(l, art, `${authored}.json`) as { reason?: unknown } | undefined)
        : undefined;
      if (publish?.reason === 'reclaim_pending')
        return { ...projected, state: heldState('reclaim_pending'), exit: EXIT.held };
      if (publish?.reason === 'target_dirty') return { ...projected, state: 'target_dirty' };
      if (publish?.reason === 'target_switched')
        return { ...projected, state: heldState('target_switched'), exit: EXIT.held };
      if (publish?.reason === 'target_checkout_changed')
        return { ...projected, state: 'target_checkout_changed' };
      if (publish?.reason === 'target_advanced') return { ...projected, state: 'target_advanced' };
      if (publish?.reason === 'review_stale') return { ...projected, state: 'review_stale' };
      const sync = authored
        .replace(/^resolve-context-/, '')
        .replace(/^resolve-/, '')
        .replace(/-ready$/, '');
      if (/^(?:re)?sync-.+$/.test(sync)) {
        const evidence = evidenceJson(l, art, `${sync}.json`) as { status?: unknown } | undefined;
        if (evidence?.status === 'conflict') return { ...projected, state: 'sync_conflict' };
      }
    }
    const controlNode = [c.node, ...failedNodes.map(node => node.nodeId)].find(node => {
      const decision = decisionOf(evidenceJson(l, art, `${authoredNodeId(node)}.json`));
      return (
        decision?.kind === 'block' &&
        ['coder_partial', 'coder_needs', 'acceptance_adjudication', 'finding_stuck'].includes(
          decision.reason ?? ''
        )
      );
    });
    if (controlNode) return { ...c, node: controlNode, state: heldState('gate'), exit: EXIT.held };
    const decision = decisionOf(evidenceJson(l, art, `${c.node}.json`));
    if (/^(verify|diff|settle)-/.test(c.node) && decision?.reason === 'scope_approval')
      return { ...c, state: heldState('scope'), exit: EXIT.held };
    if (
      /^(verify|settle|gate)-/.test(c.node) &&
      (!decision || decision.kind === 'advance' || decision.kind === 'debt')
    )
      return { ...c, state: heldState('engine_suspect'), exit: EXIT.held };
  }
  return c;
}

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

export function reviewCheckpoints(
  l: Ledger,
  run: RunView
): NonNullable<Continuation['baselines']>['checkpoints'] {
  if (!run.working_path) return {};
  try {
    const reviews: NonNullable<NonNullable<Continuation['baselines']>['checkpoints']> = {},
      art = artifactsOf(run),
      head = gitHead(run.working_path),
      hashes = recoveryOutputHashes(run.id, l.repo);
    for (const file of evidenceGates(l, art)) {
      const admitted = recoveryReviewCheckpoint(l, art, file, head, hashes);
      if (admitted?.reason)
        console.warn(JSON.stringify({ code: 'superagent.checkpoint_rejected', ...admitted }));
      if (admitted) reviews[admitted.milestone] = admitted.checkpoint;
    }
    return reviews;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(OUTSIDE)) throw error;
    console.warn(
      JSON.stringify({ code: 'superagent.checkpoint_rejected', reason: 'artifacts_outside' })
    );
    return {};
  }
}

export function continuation(l: Ledger): Continuation | undefined {
  let current = l;
  const seen = new Set<string>();
  for (;;) {
    const base = planOf(current).base_ref,
      match = /^(?:refs\/heads\/)?sa\/(.+)$/.exec(base);
    if (!match) {
      const resolved = Bun.spawnSync(
        ['git', '-C', l.repo, 'rev-parse', '--verify', `${base}^{commit}`],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: QUERY_TIMEOUT_MS,
        }
      );
      return resolved.exitCode === 0
        ? { from: l.run_id, packages: [], baselines: { review: resolved.stdout.toString().trim() } }
        : undefined;
    }
    if (seen.has(match[1])) return undefined;
    seen.add(match[1]);
    try {
      current = loadLedger(coord().resolveRun(match[1])?.run_id ?? match[1]);
    } catch {
      return undefined;
    }
  }
}

export function planContinuation(plan: Plan): Continuation | undefined {
  const match = /^(?:refs\/heads\/)?sa\/(.+)$/.exec(plan.base_ref);
  if (!match) return undefined;
  try {
    return continuation(loadLedger(coord().resolveRun(match[1])?.run_id ?? match[1]));
  } catch {
    return undefined;
  }
}
