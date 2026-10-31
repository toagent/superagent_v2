import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lock } from './archon';
import { home, writeAtomic } from './config';

export interface NtfyOption {
  id: string;
  label: string;
  consequence?: string;
}

export interface NtfyAsk {
  source: string;
  title: string;
  body: string;
  options: NtfyOption[];
  risk: 'normal' | 'red';
  expires_at: string;
  default_on_expiry?: string;
  callback:
    | { kind: 'ask'; key: string }
    | { kind: 'decision'; id: string }
    | { kind: 'external'; ref: string };
  dedupe_key?: string;
}

interface SignedAnswer {
  id: string;
  option: string;
  nonce: string;
  exp: number;
  sig: string;
}

interface StoredDecision extends NtfyAsk {
  id: string;
  status: 'pending' | 'answered' | 'expired' | 'failed';
  delivery: 'pending' | 'sent';
  actions: SignedAnswer[];
  answer?: string;
  red_phase?: 'request' | 'confirm';
}

interface NtfyState {
  version: 1;
  cursor?: string;
  decisions: Record<string, StoredDecision>;
  used_nonces: Record<string, number>;
  alerts: { id: string; title?: string; message: string }[];
  ignored: number;
  callback_failures: number;
}

export interface NtfyConfig {
  baseUrl: string;
  publisherToken: string;
  answerToken: string;
  answerKey: string;
  statePath: string;
  fetch: typeof fetch;
  now: () => number;
}

const defaultConfig = (): NtfyConfig => ({
  baseUrl: process.env.SA_NTFY_URL ?? 'https://notify.wetamp.com',
  publisherToken: join(homedir(), '.config/superagent/ntfy-publisher.token'),
  answerToken: join(homedir(), '.config/superagent/ntfy-answer.token'),
  answerKey: join(home().sa, 'ntfy/answer.key'),
  statePath: join(home().sa, 'ntfy/state.json'),
  fetch,
  now: Date.now,
});

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const ntfyEnabled = (supplied: Partial<NtfyConfig>): boolean =>
  (supplied.baseUrl !== undefined &&
    supplied.publisherToken !== undefined &&
    supplied.answerToken !== undefined &&
    supplied.answerKey !== undefined &&
    supplied.statePath !== undefined &&
    supplied.fetch !== undefined) ||
  canonical(home().sa) === canonical(join(process.env.HOME ?? homedir(), '.superagent'));

const emptyState = (): NtfyState => ({
  version: 1,
  decisions: {},
  used_nonces: {},
  alerts: [],
  ignored: 0,
  callback_failures: 0,
});

function secureSecret(path: string, name: string, create = false): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (create && !existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32).toString('hex') + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`ntfy ${name} file unavailable`);
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(`ntfy ${name} file must be mode 600`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`ntfy ${name} file is empty`);
  return value;
}

function readState(path: string): NtfyState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    const value = parsed as Partial<NtfyState>;
    if (
      value.version !== 1 ||
      !value.decisions ||
      !value.used_nonces ||
      !Array.isArray(value.alerts)
    )
      return emptyState();
    return { ...value, callback_failures: value.callback_failures ?? 0 } as NtfyState;
  } catch {
    return emptyState();
  }
}

function saveState(path: string, state: NtfyState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, JSON.stringify(state, null, 2) + '\n');
  chmodSync(path, 0o600);
}

function stateLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  return lock(path + '.lock');
}

const signatureInput = (answer: Omit<SignedAnswer, 'sig'>): string =>
  `${answer.id}|${answer.option}|${answer.nonce}|${String(answer.exp)}`;

function signedAnswer(id: string, option: string, exp: number, key: string): SignedAnswer {
  const answer = { id, option, nonce: randomBytes(18).toString('base64url'), exp };
  return {
    ...answer,
    sig: createHmac('sha256', key).update(signatureInput(answer)).digest('hex'),
  };
}

function validSignature(answer: SignedAnswer, key: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(answer.sig)) return false;
  const expected = createHmac('sha256', key).update(signatureInput(answer)).digest();
  const actual = Buffer.from(answer.sig, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateAsk(request: NtfyAsk, now: number): void {
  if (!request.source.trim() || !request.title.trim() || !request.body.trim())
    throw new Error('ntfy ask requires source, title and body');
  if (!request.options.length || request.options.length > 3)
    throw new Error('ntfy ask requires one to three options');
  if (new Set(request.options.map(option => option.id)).size !== request.options.length)
    throw new Error('ntfy ask option ids must be unique');
  const expires = Date.parse(request.expires_at);
  if (!Number.isFinite(expires) || expires <= now)
    throw new Error('ntfy ask expiry must be future');
  if (request.risk === 'red' && request.default_on_expiry !== undefined)
    throw new Error('red ntfy asks cannot default on expiry');
  if (
    request.default_on_expiry !== undefined &&
    !request.options.some(option => option.id === request.default_on_expiry)
  )
    throw new Error('ntfy ask default must name an option');
}

export function askNtfy(request: NtfyAsk, supplied: Partial<NtfyConfig> = {}): string {
  const config = { ...defaultConfig(), ...supplied };
  validateAsk(request, config.now());
  const guard = stateLock(config.statePath);
  if (!guard.ok) throw new Error('ntfy state busy');
  try {
    const state = readState(config.statePath);
    const existing = request.dedupe_key
      ? Object.values(state.decisions).find(
          decision =>
            decision.dedupe_key === request.dedupe_key &&
            decision.status === 'pending' &&
            Date.parse(decision.expires_at) > config.now()
        )
      : undefined;
    if (existing) return existing.id;
    const key = secureSecret(config.answerKey, 'answer key', true);
    const id = randomUUID();
    const expires = Math.floor(Date.parse(request.expires_at) / 1000);
    state.decisions[id] = {
      ...request,
      id,
      status: 'pending',
      delivery: 'pending',
      actions:
        request.risk === 'red'
          ? [signedAnswer(id, '__request__', expires, key)]
          : request.options.map(option => signedAnswer(id, option.id, expires, key)),
      ...(request.risk === 'red' ? { red_phase: 'request' as const } : {}),
    };
    saveState(config.statePath, state);
    return id;
  } finally {
    guard.release();
  }
}

function actionFor(
  decision: StoredDecision,
  signed: SignedAnswer,
  answerToken: string,
  baseUrl: string
) {
  const label =
    decision.red_phase === 'request'
      ? '申请批准'
      : decision.red_phase === 'confirm'
        ? '确认批准'
        : (decision.options.find(option => option.id === signed.option)?.label ?? signed.option);
  return {
    action: 'http',
    label,
    url: `${baseUrl}/sa-answers`,
    method: 'POST',
    headers: { Authorization: `Bearer ${answerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
    clear: true,
  };
}

function receipt(state: NtfyState, id: string, title: string, message: string): void {
  state.alerts.push({ id, title, message });
}

async function publish(
  config: NtfyConfig,
  topic: 'sa-decisions' | 'sa-alerts',
  body: Record<string, unknown>
): Promise<void> {
  const publisher = secureSecret(config.publisherToken, 'publisher token');
  let response: Response;
  try {
    response = await config.fetch(config.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, ...body }),
    });
  } catch {
    throw new Error('ntfy publish unavailable');
  }
  if (!response.ok) throw new Error(`ntfy publish failed (${String(response.status)})`);
}

async function flush(config: NtfyConfig, state: NtfyState): Promise<void> {
  for (const decision of Object.values(state.decisions)) {
    if (decision.status !== 'pending' || decision.delivery !== 'pending') continue;
    const answer = secureSecret(config.answerToken, 'answer token');
    await publish(config, 'sa-decisions', {
      title: decision.red_phase === 'confirm' ? `确认：${decision.title}` : decision.title,
      message:
        decision.red_phase === 'confirm'
          ? `${decision.body}\n影响：${decision.options[0]?.consequence ?? decision.options[0]?.label}`
          : decision.body,
      actions: decision.actions.map(action => actionFor(decision, action, answer, config.baseUrl)),
    });
    decision.delivery = 'sent';
  }
  while (state.alerts.length) {
    await publish(config, 'sa-alerts', {
      ...(state.alerts[0].title ? { title: state.alerts[0].title } : {}),
      message: state.alerts[0].message,
    });
    state.alerts.shift();
  }
}

function parseAnswer(message: unknown): SignedAnswer | undefined {
  try {
    const value = JSON.parse(String(message)) as Record<string, unknown>;
    return typeof value.id === 'string' &&
      typeof value.option === 'string' &&
      typeof value.nonce === 'string' &&
      typeof value.exp === 'number' &&
      typeof value.sig === 'string'
      ? (value as unknown as SignedAnswer)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function syncNtfy(
  onAnswer: (decision: NtfyAsk & { id: string }, option: string) => void | Promise<void>,
  supplied: Partial<NtfyConfig> = {},
  onExpire: (decision: NtfyAsk & { id: string }) => void | Promise<void> = () => undefined
): Promise<{ accepted: number; ignored: number; failed: number }> {
  if (!ntfyEnabled(supplied)) return { accepted: 0, ignored: 0, failed: 0 };
  const config = { ...defaultConfig(), ...supplied };
  const guard = stateLock(config.statePath);
  if (!guard.ok) return { accepted: 0, ignored: 0, failed: 0 };
  let accepted = 0;
  let ignored = 0;
  let failed = 0;
  try {
    const state = readState(config.statePath);
    try {
      const publisher = secureSecret(config.publisherToken, 'publisher token');
      const url = new URL(`${config.baseUrl}/sa-answers/json`);
      url.searchParams.set('poll', '1');
      if (state.cursor) url.searchParams.set('since', state.cursor);
      let response: Response;
      try {
        response = await config.fetch(url, {
          headers: { Authorization: `Bearer ${publisher}` },
        });
      } catch {
        throw new Error('ntfy poll unavailable');
      }
      if (!response.ok) throw new Error(`ntfy poll failed (${String(response.status)})`);
      const key = secureSecret(config.answerKey, 'answer key', true);
      const lines = (await response.text()).split('\n').filter(Boolean);
      for (const line of lines) {
        let event: { id?: unknown; event?: unknown; message?: unknown };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          ignored++;
          continue;
        }
        if (typeof event.id !== 'string') {
          ignored++;
          continue;
        }
        const answer = event.event === 'message' ? parseAnswer(event.message) : undefined;
        if (!answer) {
          ignored++;
          state.cursor = event.id;
          continue;
        }
        const decision = Reflect.get(state.decisions, answer.id) as StoredDecision | undefined;
        const expected = decision?.actions.some(
          action =>
            decision.status === 'pending' &&
            action.nonce === answer.nonce &&
            action.option === answer.option &&
            action.exp === answer.exp
        );
        let rejection: string | undefined;
        if (!decision) rejection = '该决策未找到或已过期，未执行';
        else if (decision.status === 'expired') rejection = '该决策已过期，未执行';
        else if (decision.status === 'failed') rejection = '该决策处理失败，未执行';
        else if (decision.status === 'answered' || answer.nonce in state.used_nonces)
          rejection = '该决策已处理，本次点按忽略';
        else if (answer.exp < Math.floor(config.now() / 1000)) rejection = '该决策已过期，未执行';
        else if (!expected || !validSignature(answer, key)) rejection = '回答签名无效，未执行';
        if (rejection) {
          ignored++;
          state.cursor = event.id;
          receipt(state, event.id, `未执行｜${decision?.title ?? '未知决策'}`, rejection);
          continue;
        }
        if (!decision) continue;
        if (decision.risk === 'red' && decision.red_phase === 'request') {
          state.used_nonces[answer.nonce] = config.now();
          decision.red_phase = 'confirm';
          decision.delivery = 'pending';
          decision.actions = [
            signedAnswer(
              decision.id,
              decision.options[0].id,
              Math.floor(config.now() / 1000) + 300,
              key
            ),
          ];
          state.cursor = event.id;
          receipt(state, event.id, `已收到批准申请｜${decision.title}`, '请在新通知中确认');
          continue;
        }
        state.used_nonces[answer.nonce] = config.now();
        state.cursor = event.id;
        try {
          await onAnswer(decision, answer.option);
          decision.status = 'answered';
          decision.answer = answer.option;
          const label =
            decision.options.find(option => option.id === answer.option)?.label ?? answer.option;
          receipt(state, event.id, `已记录：${label}｜${decision.title}`, '本次点按已执行');
          accepted++;
        } catch {
          decision.status = 'failed';
          receipt(state, event.id, `未执行｜${decision.title}`, '处理失败，请使用命令行重试');
          failed++;
          state.callback_failures++;
        }
      }
      for (const decision of Object.values(state.decisions)) {
        const expires = Math.min(
          Math.floor(Date.parse(decision.expires_at) / 1000),
          ...decision.actions.map(action => action.exp)
        );
        if (decision.status !== 'pending' || expires >= Math.floor(config.now() / 1000)) continue;
        if (decision.risk === 'normal' && decision.default_on_expiry) {
          try {
            await onAnswer(decision, decision.default_on_expiry);
            decision.status = 'answered';
            decision.answer = decision.default_on_expiry;
            const label =
              decision.options.find(option => option.id === decision.default_on_expiry)?.label ??
              decision.default_on_expiry;
            receipt(
              state,
              decision.id,
              `已记录：${label}｜${decision.title}`,
              '已按到期默认值执行'
            );
            accepted++;
          } catch {
            decision.status = 'expired';
            failed++;
            state.callback_failures++;
          }
        } else {
          decision.status = 'expired';
          try {
            await onExpire(decision);
          } catch {
            failed++;
            state.callback_failures++;
          }
        }
      }
      state.ignored += ignored;
      for (const [nonce, usedAt] of Object.entries(state.used_nonces))
        if (usedAt < config.now() - 7 * 86400_000) Reflect.deleteProperty(state.used_nonces, nonce);
      await flush(config, state);
    } finally {
      saveState(config.statePath, state);
    }
    return { accepted, ignored, failed };
  } finally {
    guard.release();
  }
}

export function queueNtfyAlert(
  id: string,
  message: string,
  supplied: Partial<NtfyConfig> = {}
): void {
  const config = { ...defaultConfig(), ...supplied };
  const guard = stateLock(config.statePath);
  if (!guard.ok) throw new Error('ntfy state busy');
  try {
    const state = readState(config.statePath);
    if (!state.alerts.some(alert => alert.id === id)) state.alerts.push({ id, message });
    saveState(config.statePath, state);
  } finally {
    guard.release();
  }
}

export function ntfyDecisionStatus(
  id: string,
  supplied: Partial<NtfyConfig> = {}
): { id: string; status: StoredDecision['status']; answer?: string } | undefined {
  const config = { ...defaultConfig(), ...supplied };
  const decision = Reflect.get(readState(config.statePath).decisions, id) as
    | StoredDecision
    | undefined;
  return (
    decision && {
      id,
      status: decision.status,
      ...(decision.answer ? { answer: decision.answer } : {}),
    }
  );
}

export async function publishPendingNtfy(supplied: Partial<NtfyConfig> = {}): Promise<void> {
  if (!ntfyEnabled(supplied)) return;
  const config = { ...defaultConfig(), ...supplied };
  const guard = stateLock(config.statePath);
  if (!guard.ok) return;
  try {
    const state = readState(config.statePath);
    try {
      await flush(config, state);
    } finally {
      saveState(config.statePath, state);
    }
  } finally {
    guard.release();
  }
}
