import { approvalContextSchema } from '@archon/workflows/schemas/workflow-run';
import { getRun, archonJson, lock, reportRunRevisions, type RunView } from './archon';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
import type { Snapshot } from './board/data';
import { home, writeAtomic } from './config';

export class DecisionError extends Error {}
function requireDecision(ok: unknown, message: string): asserts ok {
  if (!ok) throw new DecisionError(message);
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface DecisionReceipt {
  id: string;
  run: string;
  engine: string;
  node: string;
  pause: string;
  decision: string;
  at: string;
  stage: 'intent' | 'accepted' | 'rejected' | 'resuming' | 'unknown';
  error?: { phase: string; name: string; code?: string; message?: string };
}
interface DecisionState {
  receipts: DecisionReceipt[];
}
export class DecisionStore {
  constructor(readonly root = join(home().sa, 'decisions')) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  transaction<T>(fn: (state: DecisionState) => T): T {
    const guard = lock(join(this.root, 'state.lock'));
    if (!guard.ok) throw new DecisionError('决策状态忙，请重读');
    try {
      const file = join(this.root, 'state.json');
      const state: DecisionState = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as DecisionState)
        : { receipts: [] };
      const result = fn(state);
      const temporary = file + '.tmp';
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
      return result;
    } finally {
      guard.release();
    }
  }
  decisionLock(id: string) {
    requireDecision(/^[a-f0-9]{64}$/.test(id), '决策 ID 无效');
    const guard = lock(join(this.root, `decision-${id}.lock`));
    if (!guard.ok) throw new DecisionError('决策正在处理，请重读');
    return guard;
  }
}

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
  store = new DecisionStore()
) {
  let intents: DecisionReceipt[];
  try {
    intents = store.transaction(state =>
      state.receipts
        .filter(r => r.stage === 'intent' && /^(coord|failover):/.test(r.run))
        .map(receipt => ({ ...receipt }))
    );
  } catch {
    return [{ run_id: 'coord', action: 'error', ok: false, error: 'coord intent read failed' }];
  }
  const actions: { run_id: string; action: string; ok: boolean; error: string }[] = [];
  for (const receipt of intents) {
    let guard: ReturnType<DecisionStore['decisionLock']> | undefined;
    try {
      guard = store.decisionLock(receipt.id);
      const choice = receipt.decision;
      let accepted: boolean;
      if (receipt.run.startsWith('failover:')) {
        const ask = asks[receipt.node],
          latest = latestFailover(asks)?.[0];
        accepted =
          (choice === 'yes' || choice === 'no') &&
          latest === receipt.node &&
          ['pending', 'unknown', choice].includes(ask?.status ?? '') &&
          receipt.id === digest(JSON.stringify(['failover', latest, ask?.context]));
        if (accepted && ask) ask.status = choice;
      } else {
        const staleAsk = new Error('stale coord ask');
        const keyPrefix = `${receipt.run}:${receipt.pause}:`,
          validChoice = choice === 'yes' || choice === 'no';
        accepted =
          validChoice &&
          Object.entries(asks).some(
            ([key, ask]) => key.startsWith(keyPrefix) && ask?.status === choice
          );
        if (!accepted && validChoice)
          try {
            accepted = answer(receipt.run.slice(6), Number(receipt.pause), key => {
              const ask = asks[key];
              if (!ask || !['pending', 'unknown'].includes(ask.status)) throw staleAsk;
              ask.status = choice;
            });
          } catch (error) {
            if (error !== staleAsk) throw error;
          }
      }
      store.transaction(state => {
        const current = state.receipts.find(r => r.id === receipt.id);
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

/** Notification publishing shares the board's bounded, cached, parallel and timed loader. */
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
export async function answerDecision(
  store: DecisionStore,
  id: string,
  choice: string,
  loadInbox: () => Promise<DecisionInbox> = loadCurrentDecisions
): Promise<DecisionReceipt> {
  const deferredCandidate = [...coordinationDecisions(), ...failoverDecisions()].find(
    decision => decision.id === id
  );
  const candidate = deferredCandidate ?? (await loadInbox()).decisions.find(d => d.id === id);
  requireDecision(candidate, '决定已变化，请重读');
  if (candidate.coordination ?? candidate.engine === 'failover') {
    requireDecision(['yes', 'no'].includes(choice), '不支持此选项');
    const decisionGuard = store.decisionLock(id);
    try {
      const current = [...coordinationDecisions(), ...failoverDecisions()].find(d => d.id === id);
      requireDecision(current, '决定已变化，请重读');
      requireDecision(current.coordination ?? current.engine === 'failover', '决定已变化，请重读');
      return store.transaction(s => {
        requireDecision(!s.receipts.some(r => r.id === id), '该决定已有答复；请查看回执，不会重放');
        const receipt: DecisionReceipt = {
          id,
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
      decisionGuard.release();
    }
  }
  const l = loadLedger(candidate.run),
    c = coord(),
    scope = runScope(l);
  const decisionGuard = store.decisionLock(id);
  try {
    return await c.scoped(
      scope,
      async () => {
        const old = store.transaction(s => s.receipts.find(r => r.id === id));
        requireDecision(!old, '该决定已有答复；请查看回执，不会重放');
        const run = getRun(l.archon_run_id, l.repo),
          d = describeDecision(l, run, c.owner(scope));
        requireDecision(d && !d.disabled && d.id === id && d.controller, '决定已变化，请重读');
        requireDecision(
          d.options.some(o => o.id === choice),
          '不支持此选项'
        );
        const controller = d.controller;
        c.admit(scope, controller, controller.generation);
        const receipt: DecisionReceipt = {
          id,
          run: d.run,
          engine: d.engine,
          node: d.node,
          pause: d.pause,
          decision: choice,
          at: new Date().toISOString(),
          stage: 'intent',
        };
        store.transaction(s => {
          requireDecision(!s.receipts.some(r => r.id === id), '该决定已有答复');
          s.receipts.push(receipt);
        });
        const stage = (value: DecisionReceipt['stage']) => {
          receipt.stage = value;
          store.transaction(s => {
            const r = s.receipts.find(r => r.id === id);
            requireDecision(r, '决策回执缺失');
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
              ask_id: 'ntfy',
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
                requireDecision(ack.ok === true, '引擎已接收，续跑尚未确认');
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
            requireDecision(r, '决策回执缺失');
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
              message: error instanceof DecisionError ? error.message : undefined,
            };
          });
          throw error;
        }
        return receipt;
      },
      0
    );
  } finally {
    decisionGuard.release();
  }
}

/** HMAC verification happens in ntfy.ts; durable receipts enforce one accepted answer. */
export async function answerNtfyDecision(
  id: string,
  choice: string,
  store = new DecisionStore(),
  answer = answerDecision
): Promise<DecisionReceipt> {
  return answer(store, id, choice);
}
