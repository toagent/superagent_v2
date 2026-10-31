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
  operatorGrant,
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
  coordination?: { message: string; generation: number };
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
  if (options.length > 3) disabled ??= 'ntfy 每条通知最多支持三个选项；请在 Mac 处理';
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
  const decisions: Decision[] = failoverDecisions(),
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
export function coordinationDecisions(c = coord()): Decision[] {
  return c
    .messages()
    .flatMap(m => {
      if (
        m.type ||
        m.state !== 'escalated' ||
        !m.ask ||
        !['pending', 'unknown'].includes(m.ask.status)
      )
        return [];
      const view = c.owner(m.scope);
      if (
        view.conflicts.length ||
        view.generation !== m.ask.generation ||
        !same(view.owner, m.ask.owner)
      )
        return [];
      return [
        {
          id: digest(JSON.stringify(['coord', m.id, m.ask.generation, m.ask.question])),
          run: `coord:${m.id}`,
          engine: 'coord',
          node: m.id,
          pause: String(m.ask.generation),
          question: m.ask.question,
          reason: 'COORD 交接需要操作者决定',
          context: m.title,
          options: [
            { id: 'yes', label: '是', consequence: '交给发现者处理' },
            { id: 'no', label: '否', consequence: '继续等待当前负责人' },
          ],
          coordination: { message: m.id, generation: m.ask.generation },
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const FAILOVER_PREFIX = 'coord:claude-failover:';
export const latestFailover = <T extends { status?: string }>(
  asks: Partial<Record<string, T>>,
  statuses?: string[]
) =>
  Object.entries(asks)
    .filter(
      ([key, ask]) =>
        key.startsWith(FAILOVER_PREFIX) && (!statuses || statuses.includes(ask?.status ?? ''))
    )
    .sort(([a], [b]) => b.localeCompare(a))
    .at(0);
export function failoverDecisions(): Decision[] {
  try {
    const asks = JSON.parse(readFileSync(join(home().sa, 'asks.json'), 'utf8')) as Record<
      string,
      { status?: string; context?: { reason?: string } }
    >;
    const entry = latestFailover(asks, ['pending', 'unknown']);
    if (!entry) return [];
    const [key] = entry,
      ask = asks[key];
    const reason = ask.context?.reason ?? 'Claude 不可用，是否由 Codex 元帅接手？';
    return [
      {
        id: digest(JSON.stringify(['failover', key, ask.context])),
        run: `failover:${key.slice(FAILOVER_PREFIX.length)}`,
        engine: 'failover',
        node: key,
        pause: key.slice(FAILOVER_PREFIX.length),
        question: reason.replace('勾选=启动接手；删除=保持现状', '请选择处理方式'),
        reason: 'Claude 熔断：在途 run 的元帅接续需要操作者决定',
        context: reason,
        options: [
          {
            id: 'yes',
            label: '启动 Codex 元帅接手',
            consequence:
              '按仓库启动 Codex 元帅，复核 owner/generation 后显式接管；Claude 已恢复则不接管',
          },
          { id: 'no', label: '保持现状', consequence: 'ownership 不变' },
        ],
      },
    ];
  } catch {
    return [];
  }
}
export function applyCoordIntents(
  asks: Partial<Record<string, { status: string; context?: unknown }>>,
  answer = (id: string, generation: number, persist: (key: string) => void): boolean =>
    coord().answerEscalation(id, generation, persist),
  store = new DeviceStore()
) {
  let intents: { receipt: Receipt; authorized: boolean }[];
  try {
    intents = store.transaction(state =>
      state.receipts
        .filter(r => r.stage === 'intent' && /^(coord|failover):/.test(r.run))
        .map(receipt => ({
          receipt: { ...receipt },
          authorized: state.devices.some(
            device => device.id === receipt.device && isAuthorizedDevice(device)
          ),
        }))
    );
  } catch {
    return [{ run_id: 'coord', action: 'error', ok: false, error: 'coord intent read failed' }];
  }
  const actions: { run_id: string; action: string; ok: boolean; error: string }[] = [];
  for (const intent of intents) {
    let guard: ReturnType<DeviceStore['deviceLock']> | undefined;
    try {
      guard = store.deviceLock(intent.receipt.device);
      const authorized =
        intent.authorized &&
        store.transaction(state =>
          state.devices.some(
            device => device.id === intent.receipt.device && isAuthorizedDevice(device)
          )
        );
      const choice = intent.receipt.decision;
      let accepted: boolean;
      if (intent.receipt.run.startsWith('failover:')) {
        const ask = asks[intent.receipt.node],
          latest = latestFailover(asks)?.[0];
        accepted =
          authorized &&
          (choice === 'yes' || choice === 'no') &&
          latest === intent.receipt.node &&
          ['pending', 'unknown', choice].includes(ask?.status ?? '') &&
          intent.receipt.id === digest(JSON.stringify(['failover', latest, ask?.context]));
        if (accepted && ask) ask.status = choice;
      } else {
        const staleAsk = new Error('stale coord ask');
        const keyPrefix = `${intent.receipt.run}:${intent.receipt.pause}:`,
          validChoice = choice === 'yes' || choice === 'no';
        accepted =
          authorized &&
          validChoice &&
          Object.entries(asks).some(
            ([key, ask]) => key.startsWith(keyPrefix) && ask?.status === choice
          );
        if (!accepted && authorized && validChoice)
          try {
            accepted = answer(intent.receipt.run.slice(6), Number(intent.receipt.pause), key => {
              const ask = asks[key];
              if (!ask || !['pending', 'unknown'].includes(ask.status)) throw staleAsk;
              ask.status = choice;
            });
          } catch (error) {
            if (error !== staleAsk) throw error;
          }
      }
      store.transaction(state => {
        const current = state.receipts.find(r => r.id === intent.receipt.id);
        if (current?.stage === 'intent') current.stage = accepted ? 'accepted' : 'rejected';
      });
    } catch {
      actions.push({
        run_id: 'coord',
        action: 'error',
        ok: false,
        error: 'coord intent retryable failure',
      });
    } finally {
      guard?.release();
    }
  }
  return actions;
}

/** The mobile hot path shares the board's bounded, cached, parallel and timed loader. */
export async function loadCurrentDecisions(): Promise<DecisionInbox> {
  return (inboxPending ??= (async () => {
    const { createLoader } = await import('./board/data');
    inboxLoader ??= createLoader();
    const inbox = decisionsFromSnapshot(await inboxLoader(DECISION_SCAN_LIMIT));
    inbox.decisions.push(...coordinationDecisions(), ...failoverDecisions());
    inbox.decisions.sort((a, b) => a.id.localeCompare(b.id));
    return inbox;
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
  choice: string,
  loadInbox: () => Promise<DecisionInbox> = loadCurrentDecisions
): Promise<Receipt> {
  const deferredCandidate = isOperatorDevice(device)
    ? [...coordinationDecisions(), ...failoverDecisions()].find(d => d.id === id)
    : undefined;
  const candidate = isOperatorDevice(device)
    ? (deferredCandidate ?? (await loadInbox()).decisions.find(d => d.id === id))
    : undefined;
  if (isOperatorDevice(device)) requireThat(candidate, 409, '决定已变化，请重读');
  if (candidate?.coordination ?? candidate?.engine === 'failover') {
    requireThat(['yes', 'no'].includes(choice), 400, '不支持此选项');
    const deviceGuard = store.deviceLock(device.id);
    try {
      const current = [...coordinationDecisions(), ...failoverDecisions()].find(d => d.id === id);
      if (!current) throw new BoundaryError(409, '决定已变化，请重读');
      requireThat(current.coordination ?? current.engine === 'failover', 409, '决定已变化，请重读');
      return store.transaction(s => {
        requireThat(
          s.devices.some(d => d.id === device.id && isAuthorizedDevice(d)),
          401
        );
        requireThat(
          !s.receipts.some(r => r.id === id),
          409,
          '该决定已有答复；请查看回执，不会重放'
        );
        const receipt: Receipt = {
          id,
          device: device.id,
          run: current.run,
          engine: current.engine,
          node: current.node,
          pause: current.pause,
          decision: choice,
          at: new Date().toISOString(),
          stage: 'intent',
        };
        s.receipts.push(receipt);
        return receipt;
      });
    } finally {
      deviceGuard.release();
    }
  }
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
              reason: 'human_decision',
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

/** HMAC verification happens in ntfy.ts; this durable operator identity reuses the same CAS path. */
export async function answerNtfyDecision(
  id: string,
  choice: string,
  store = new DeviceStore()
): Promise<Receipt> {
  const device = store.transaction(state => {
    const existing = state.devices.find(candidate => candidate.id === 'ntfy-channel');
    if (existing) {
      existing.authorized = true;
      existing.revoked = false;
      existing.grant = operatorGrant();
      return { ...existing };
    }
    const created: Device = {
      id: 'ntfy-channel',
      session: '',
      csrf: '',
      authorized: true,
      grant: operatorGrant(),
    };
    state.devices.push(created);
    return { ...created };
  });
  return answerDecision(store, device, id, choice);
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
  const deferredDecisions =
    isOperatorDevice(device) && id
      ? [...coordinationDecisions(), ...failoverDecisions()]
      : undefined;
  const inbox = isOperatorDevice(device)
    ? (operatorInbox ??
      (id &&
      (deferredDecisions?.some(d => d.id === id) || /^(coord|failover):/.test(receipt?.run ?? ''))
        ? { decisions: deferredDecisions ?? [], unknown: [] }
        : await loadCurrentDecisions()))
    : (() => {
        try {
          const l = loadLedger(device.grant.run),
            decision = describeDecision(l, getRun(device.grant.engine, l.repo));
          return { decisions: decision ? [decision] : [], unknown: [] };
        } catch {
          return { decisions: [], unknown: [device.grant.run] };
        }
      })();
  const selectedDeferred = id
    ? inbox.decisions.find(d => d.id === id && (d.coordination ?? d.engine === 'failover'))
    : inbox.decisions.find(d => (d.coordination ?? d.engine === 'failover') && !d.disabled);
  const deferredReceipt =
    receipt &&
    /^(coord|failover):/.test(receipt.run) &&
    (id
      ? receipt.id === id
      : selectedDeferred
        ? receipt.id === selectedDeferred.id
        : inbox.decisions.length === 0)
      ? receipt
      : undefined;
  if (selectedDeferred || deferredReceipt) {
    const lastRead = new Date().toISOString();
    store.transaction(s => {
      const current = s.devices.find(d => d.id === device.id);
      requireThat(current && isAuthorizedDevice(current), 401);
      current.lastRead = lastRead;
    });
    return {
      decision: selectedDeferred,
      decisions: inbox.decisions,
      unknown: inbox.unknown.length,
      receipt: deferredReceipt,
      status: selectedDeferred ? 'paused' : 'completed',
      lastRead,
      events: [],
      stale: false,
      note: selectedDeferred
        ? '等待操作者决定'
        : deferredReceipt?.stage === 'rejected'
          ? '决定已变化，答复未执行'
          : '决定已接收，后续由监督 tick 执行',
    };
  }
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
