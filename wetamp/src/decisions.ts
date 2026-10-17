import { approvalContextSchema } from '@archon/workflows/schemas/workflow-run';
import { getRun, archonJson, reportRunRevisions, type RunView } from './archon';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyRun,
  holdOf,
  ledgerIds,
  loadLedger,
  planOf,
  updateLedger,
  type Ledger,
} from './cli';
import { coord, runScope, same, type Controller } from './coord';
import {
  BoundaryError,
  DeviceStore,
  digest,
  isAuthorizedDevice,
  isOperatorDevice,
  requireThat,
  type Device,
  type Receipt,
} from './web/device-store';
import type { Snapshot } from './board/data';
import { home, writeAtomic } from './config';

export interface Decision {
  id: string;
  run: string;
  engine: string;
  node: string;
  pause: string;
  question: string;
  reason: string;
  context: string;
  options: { id: string; label: string; consequence: string }[];
  disabled?: string;
  controller?: Controller;
}
/** Engine metadata and the current wetamp hold are the shared owner, never asks history. */
export function describeDecision(
  l: Ledger,
  run: RunView,
  ownership?: ReturnType<ReturnType<typeof coord>['owner']>
): Decision | undefined {
  const hold = holdOf(l, run, classifyRun(l, run));
  if (run.status !== 'paused' || !['signoff', 'approval'].includes(hold ?? '')) return;
  ownership ??= coord().owner(runScope(l));
  const parsed = approvalContextSchema.safeParse(run.metadata?.approval);
  const gate = parsed.success ? parsed.data : undefined;
  if (gate?.resolved) return;
  const plan = planOf(l);
  if (run.id !== l.archon_run_id) return;
  const controller = ownership.owner
    ? { ...ownership.owner, generation: ownership.generation }
    : undefined;
  const node = gate?.nodeId ?? run.metadata?.wait?.nodeId ?? '';
  const pause = gate?.pauseId ?? '';
  const id = digest(JSON.stringify([l.run_id, run.id, gate, controller, plan]));
  const deadline = plan.deadline === undefined ? Infinity : Date.parse(plan.deadline);
  let disabled =
    !gate || !pause || (gate.type && gate.type !== 'approval')
      ? '此门缺少原生 occurrence 或不支持手机处理'
      : !controller || ownership.conflicts.length || ownership.presence.state !== 'online'
        ? 'owner 存活或归属未知，请在 Mac 处理'
        : !(deadline > Date.now())
          ? '计划已到期或截止时间未知'
          : undefined;
  const options = gate?.decisionsAuthored
    ? (gate.decisions ?? []).map(d => ({
        id: d.id,
        label: d.label ?? d.id,
        consequence: `执行工作流声明的「${d.label ?? d.id}」分支；不代表已执行完成`,
      }))
    : hold === 'signoff' && !gate?.onRejectPrompt
      ? [
          {
            id: 'approve',
            label: '批准签收并续跑',
            consequence: '放行本次签收门，不自动合入或部署',
          },
          { id: 'reject', label: '终止本次运行', consequence: '取消整个 run，保留执行证据' },
        ]
      : [];
  if (gate?.captureResponse || gate?.onRejectPrompt || gate?.bodyGateId)
    disabled ??= '此门需要 Mac 上的额外上下文或反馈';
  if (!options.length || (gate?.decisionsAuthored && gate.decisions?.some(d => !d.label)))
    disabled ??= '缺少具名选项与后果；请在 Mac 处理';
  return {
    id,
    run: l.run_id,
    engine: run.id,
    node,
    pause,
    controller,
    question: gate?.message ?? '旧式人工签收门',
    reason: hold === 'signoff' ? '交付里程碑要求人工签收' : '工作流明确要求人工选择',
    context: plan.packages.map(p => p.title).join(' / '),
    options,
    disabled,
  };
}
const DECISION_CACHE_VERSION = 2;
interface DecisionCache {
  version: number;
  terminal: Record<string, string>;
}
const decisionCachePath = (): string => join(home().sa, 'report-decisions.json');
function readDecisionCache(): DecisionCache {
  const path = decisionCachePath();
  if (!existsSync(path)) return { version: DECISION_CACHE_VERSION, terminal: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('version or shape mismatch');
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== DECISION_CACHE_VERSION ||
      value.terminal === null ||
      typeof value.terminal !== 'object' ||
      Array.isArray(value.terminal) ||
      !Object.values(value.terminal).every(entry => typeof entry === 'string')
    )
      throw new Error('version or shape mismatch');
    return { version: DECISION_CACHE_VERSION, terminal: value.terminal as Record<string, string> };
  } catch (e) {
    console.error(`superagent report cache ignored: ${(e as Error).message}`);
    return { version: DECISION_CACHE_VERSION, terminal: {} };
  }
}
export function currentDecisions(query = getRun): { decisions: Decision[]; unknown: string[] } {
  const decisions: Decision[] = [],
    unknown: string[] = [];
  const cache = readDecisionCache(),
    revisions = reportRunRevisions();
  const terminal: Record<string, string> = {};
  for (const id of ledgerIds()) {
    try {
      const l = loadLedger(id),
        stamp = statSync(join(home().sa, 'runs', `${id}.json`)),
        revision = revisions?.get(l.archon_run_id),
        fingerprint = revision
          ? JSON.stringify([l.archon_run_id, stamp.mtimeMs, stamp.size, revision])
          : null;
      if (fingerprint && cache.terminal[id] === fingerprint) {
        terminal[id] = fingerprint;
        continue;
      }
      const run = query(l.archon_run_id, l.repo);
      const d = describeDecision(l, run);
      if (d) decisions.push(d);
      if (fingerprint && ['completed', 'cancelled'].includes(run.status))
        terminal[id] = fingerprint;
    } catch {
      unknown.push(id);
    }
  }
  if (revisions)
    try {
      writeAtomic(
        decisionCachePath(),
        JSON.stringify({ version: DECISION_CACHE_VERSION, terminal })
      );
    } catch (e) {
      console.error(`superagent report cache write failed: ${(e as Error).message}`);
    }
  return { decisions: decisions.sort((a, b) => a.run.localeCompare(b.run)), unknown };
}
export type DecisionInbox = ReturnType<typeof currentDecisions>;
export const DECISION_SCAN_LIMIT = 100;
let inboxLoader: ((limit: number) => Promise<Snapshot>) | undefined;
let inboxPending: Promise<DecisionInbox> | undefined;

export function decisionsFromSnapshot(snapshot: Snapshot): DecisionInbox {
  const decisions = snapshot.rows
    .flatMap(row => (!row.stale && row.humanDecision ? [row.humanDecision] : []))
    .sort((a, b) => a.run.localeCompare(b.run));
  const unknown = snapshot.rows
    .filter(row => (row.stale || row.state === 'unreadable') && !row.missing)
    .map(row => row.run_id);
  return { decisions, unknown };
}

/** The mobile hot path shares the board's bounded, cached, parallel and timed loader. */
export async function loadCurrentDecisions(): Promise<DecisionInbox> {
  return (inboxPending ??= (async () => {
    const { createLoader } = await import('./board/data');
    inboxLoader ??= createLoader();
    return decisionsFromSnapshot(await inboxLoader(DECISION_SCAN_LIMIT));
  })().finally(() => {
    inboxPending = undefined;
  }));
}
export function authorizeDecision(run: string): Decision {
  const l = loadLedger(run),
    d = describeDecision(l, getRun(l.archon_run_id, l.repo));
  requireThat(d && !d.disabled && d.controller, 409, '当前没有可授权的手机决策');
  return d;
}
export async function answerDecision(
  store: DeviceStore,
  device: Device,
  id: string,
  choice: string
): Promise<Receipt> {
  const candidate = isOperatorDevice(device)
    ? (await loadCurrentDecisions()).decisions.find(d => d.id === id)
    : undefined;
  if (isOperatorDevice(device)) requireThat(candidate, 409, '决定已变化，请重读');
  const l = loadLedger(candidate?.run ?? device.grant.run),
    c = coord(),
    scope = runScope(l);
  const deviceGuard = store.deviceLock(device.id);
  try {
    return await c.scoped(
      scope,
      async () => {
        // Re-read revocation inside the same bounded operation before the CAS.
        store.transaction(s => {
          requireThat(
            s.devices.some(d => d.id === device.id && isAuthorizedDevice(d)),
            401
          );
        });
        const old = store.transaction(s => s.receipts.find(r => r.id === id));
        requireThat(!old, 409, '该决定已有答复；请查看回执，不会重放');
        const run = getRun(l.archon_run_id, l.repo),
          d = describeDecision(l, run, c.owner(scope));
        requireThat(
          d &&
            !d.disabled &&
            d.id === id &&
            d.controller &&
            (isOperatorDevice(device) || d.engine === device.grant.engine),
          409,
          '决定已变化，请重读'
        );
        if (!isOperatorDevice(device))
          requireThat(
            same(d.controller, device.grant.controller) &&
              d.controller.generation === device.grant.controller.generation,
            409,
            '授权 owner 已变化'
          );
        requireThat(
          d.options.some(o => o.id === choice),
          400,
          '不支持此选项'
        );
        const controller = isOperatorDevice(device) ? d.controller : device.grant.controller;
        c.admit(scope, controller, controller.generation);
        const receipt: Receipt = {
          id,
          device: device.id,
          run: d.run,
          engine: d.engine,
          node: d.node,
          pause: d.pause,
          decision: choice,
          at: new Date().toISOString(),
          stage: 'intent',
        };
        store.transaction(s => {
          requireThat(!s.receipts.some(r => r.id === id), 409);
          s.receipts.push(receipt);
        });
        const stage = (value: Receipt['stage']) => {
          receipt.stage = value;
          store.transaction(s => {
            const r = s.receipts.find(r => r.id === id);
            requireThat(r, 500);
            r.stage = value;
          });
        };
        let phase = 'respond';
        try {
          const { createSqlWorkflowOperations } =
            await import('../../packages/core/src/workflows/sql-host');
          await createSqlWorkflowOperations().respondToWorkflow(
            d.engine,
            choice,
            undefined,
            { kind: 'operator' },
            { nodeId: d.node, pauseId: d.pause }
          );
          stage('accepted');
          phase = 'ledger';
          updateLedger(l, cur => {
            (cur.intervention_events ??= []).push({
              at: receipt.at,
              action: 'answer',
              origin: 'operator',
              source: 'cli',
              ok: true,
              key: id,
              ask_id: device.id,
            });
          });
          phase = 'resume';
          const now = getRun(d.engine, l.repo);
          if (now.status === 'paused') {
            c.mutate(
              scope,
              controller,
              () => {
                const ack = archonJson(['workflow', 'resume', d.engine, '--detach'], l.repo);
                requireThat(ack.ok === true, 503, '引擎已接收，续跑尚未确认');
              },
              controller.generation
            );
            stage('resuming');
          }
        } catch (error) {
          if (receipt.stage === 'intent') stage('unknown');
          // Keep machine diagnostics, never provider bodies, request contents or credentials.
          store.transaction(s => {
            const r = s.receipts.find(r => r.id === id);
            requireThat(r, 500);
            r.error = {
              phase,
              name: error instanceof Error ? error.name : 'UnknownError',
              code:
                error &&
                typeof error === 'object' &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : undefined,
              message: error instanceof BoundaryError ? error.message : undefined,
            };
          });
          throw error;
        }
        return receipt;
      },
      0
    );
  } finally {
    deviceGuard.release();
  }
}
export async function decisionState(
  device: Device,
  id?: string,
  store = new DeviceStore(),
  operatorInbox?: DecisionInbox
) {
  const receipt = store.transaction(s =>
    s.receipts.filter(r => (!id || r.id === id) && r.device === device.id).at(-1)
  );
  const inbox = isOperatorDevice(device)
    ? (operatorInbox ?? (await loadCurrentDecisions()))
    : (() => {
        try {
          const l = loadLedger(device.grant.run),
            decision = describeDecision(l, getRun(device.grant.engine, l.repo));
          return { decisions: decision ? [decision] : [], unknown: [] };
        } catch {
          return { decisions: [], unknown: [device.grant.run] };
        }
      })();
  if (isOperatorDevice(device) && !id && !receipt && !inbox.decisions.length) {
    const lastRead = new Date().toISOString();
    store.transaction(s => {
      const current = s.devices.find(d => d.id === device.id);
      requireThat(current && isAuthorizedDevice(current), 401);
      current.lastRead = lastRead;
    });
    return {
      decision: undefined,
      decisions: [],
      unknown: inbox.unknown.length,
      receipt: undefined,
      status: inbox.unknown.length ? 'unknown' : 'idle',
      lastRead,
      events: [],
      stale: false,
      note: inbox.unknown.length
        ? '部分 ledger 无法读取；不推断没有待处理事项'
        : '当前没有待处理的 Archon 受管审批',
    };
  }
  try {
    const selected = id
        ? inbox.decisions.find(d => d.id === id)
        : (inbox.decisions.find(d => !d.disabled) ?? inbox.decisions[0]),
      l = loadLedger(selected?.run ?? receipt?.run ?? device.grant.run),
      engine = selected?.engine ?? receipt?.engine ?? device.grant.engine,
      run = getRun(engine, l.repo);
    requireThat(run.id === engine && l.archon_run_id === run.id, 409);
    const d = selected ?? describeDecision(l, run);
    if (
      !isOperatorDevice(device) &&
      d &&
      (!d.controller ||
        !same(d.controller, device.grant.controller) ||
        d.controller.generation !== device.grant.controller.generation)
    )
      d.disabled = '授权 owner 已变化，请在 Mac 重新授权';
    const decision = d && (!id || d.id === id) ? d : undefined;
    const { listWorkflowEvents } = await import('../../packages/core/src/db/workflow-events');
    const events = (await listWorkflowEvents(run.id))
      .slice(-50)
      .map(e => ({ type: e.event_type, node: e.step_name, at: e.created_at }));
    const lastRead = new Date().toISOString();
    store.transaction(s => {
      const d = s.devices.find(d => d.id === device.id);
      requireThat(d && isAuthorizedDevice(d), 401);
      d.lastRead = lastRead;
    });
    return {
      decision,
      decisions: inbox.decisions,
      unknown: inbox.unknown.length,
      receipt: receipt?.id === decision?.id || !decision ? receipt : undefined,
      status: run.status,
      lastRead,
      events,
      stale: !!id && !decision && !receipt,
      note: '引擎完成不等于已合入、部署或交付验收通过',
    };
  } catch {
    return {
      receipt,
      decisions: inbox.decisions,
      unknown: inbox.unknown.length,
      lastRead: device.lastRead,
      status: id || receipt ? 'unknown' : 'idle',
      events: [],
      stale: !!id && !receipt,
      note: '观察丢失；不自动重放答复',
    };
  }
}
