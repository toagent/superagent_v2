import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lock } from './archon';
import { home, writeAtomic } from './config';
import { caller, coord, same, type Identity, type Scope } from './coord';

export interface NtfyOption {
  id: string;
  label: string;
  consequence?: string;
  timing?: string;
  effect?: string;
  reversible?: string;
  risk?: string;
}

export interface NtfyAsk {
  originator?: { identity: Identity; scope: Scope };
  source: string | { ref: string; initiator?: string; queued_at?: string };
  title: string;
  body: string;
  options: NtfyOption[];
  risk: 'normal' | 'red';
  expires_at: string;
  default_on_expiry?: string;
  callback:
    | { kind: 'ask'; key: string }
    | { kind: 'decision'; id: string }
    | { kind: 'held'; ref: string }
    | { kind: 'external'; ref: string };
  dedupe_key?: string;
  project?: string;
  headline?: string;
  purpose?: string;
  why?: string;
  recommend?: { option: string; reason: string };
}

// prettier-ignore
export function parseNtfyAskSpec(value: unknown): NtfyAsk {
  const fail = (field: string): never => { throw new Error(`ask spec field ${field} is invalid`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('$');
  const spec = value as Record<string, unknown>;
  const text = (item: unknown, field: string, optional = false): string | undefined => {
    if (item === undefined && optional) return undefined;
    if (typeof item !== 'string' || !item.trim()) fail(field);
    return item as string;
  };
  const object = (item: unknown, field: string): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(field);
    return item as Record<string, unknown>;
  };
  const fields = (item: Record<string, unknown>, field: string, required: string[], optional: string[] = []): void => {
    required.forEach(key => text(item[key], `${field}.${key}`));
    optional.forEach(key => text(item[key], `${field}.${key}`, true));
  };
  const rawSource = spec.source;
  if (typeof rawSource === 'string') text(rawSource, 'source');
  else fields(object(rawSource, 'source'), 'source', ['ref'], ['initiator', 'queued_at']);
  let source = rawSource;
  if (spec.source_ref !== undefined) {
    const ref = object(spec.source_ref, 'source_ref');
    fields(ref, 'source_ref', ['ref'], ['initiator', 'queued_at']);
    source = { ref: ref.ref, ...(ref.queued_at ? { queued_at: ref.queued_at } : {}),
      ...(ref.initiator || typeof rawSource === 'string' ? { initiator: ref.initiator ?? rawSource } : {}) };
  }
  const rawOptions = Array.isArray(spec.options) ? spec.options : fail('options');
  const options = rawOptions.map((option, index) => {
    const field = `options[${String(index)}]`, parsed = object(option, field);
    fields(parsed, field, ['id', 'label'], ['consequence', 'timing', 'effect', 'reversible', 'risk']);
    return parsed as unknown as NtfyOption;
  });
  if (spec.recommend !== undefined) fields(object(spec.recommend, 'recommend'), 'recommend', ['option', 'reason']);
  const callback = object(spec.callback, 'callback');
  if (!['ask', 'decision', 'external'].includes(String(callback.kind))) fail('callback.kind');
  fields(callback, 'callback', ['kind', callback.kind === 'ask' ? 'key' : callback.kind === 'decision' ? 'id' : 'ref']);
  const risk = text(spec.risk, 'risk');
  if (risk !== 'normal' && risk !== 'red') fail('risk');
  ['default_on_expiry', 'dedupe_key', 'project', 'headline', 'purpose', 'why'].forEach(field => text(spec[field], field, true));
  const request = { ...spec }; Reflect.deleteProperty(request, 'source_ref');
  return { ...request, source, title: text(spec.title, 'title'), body: text(spec.body, 'body'), risk,
    expires_at: text(spec.expires_at, 'expires_at'), options, callback } as unknown as NtfyAsk;
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
  created_at: string;
  status: 'pending' | 'answered' | 'expired' | 'failed' | 'superseded';
  delivery: 'pending' | 'sent';
  actions: SignedAnswer[];
  answer?: string;
  handled_at?: string;
  error?: { code: string; message: string; source?: DecisionSourceState };
  red_phase?: 'request' | 'confirm';
}

export interface DecisionSourceState {
  status: string;
  at?: string;
}

export interface NtfyAnswerOutcome {
  result: string;
  executed: boolean;
}
const answerOutcome = (value: unknown): NtfyAnswerOutcome | undefined => {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>,
    result = record.result,
    executed = record.executed;
  return typeof result === 'string' && typeof executed === 'boolean'
    ? { result, executed }
    : undefined;
};

interface NtfyState {
  version: 1;
  seq?: number;
  cursor?: string;
  decisions: Record<string, StoredDecision>;
  used_nonces: Record<string, number>;
  alerts: { id: string; title?: string; message: string; priority?: number; tags?: string[] }[];
  alert_ids: string[];
  sent: Record<string, number>;
  limited: Record<string, number>;
  activity: { at: number; kind: 'decision' | 'alert' | 'limited' | 'deduplicated' }[];
  summary_at?: number;
  ignored: number;
  callback_failures: number;
  health_events?: Record<string, number>;
}

export interface NtfyConfig {
  baseUrl: string;
  publisherToken: string;
  answerToken: string;
  answerKey: string;
  statePath: string;
  fetch: typeof fetch;
  now: () => number;
  actor?: () => Identity | null;
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
  alert_ids: [],
  sent: {},
  limited: {},
  activity: [],
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
    return {
      ...value,
      alert_ids: Array.isArray(value.alert_ids)
        ? value.alert_ids
        : value.alerts.map(alert => alert.id),
      sent: value.sent ?? {},
      limited: value.limited ?? {},
      activity: Array.isArray(value.activity) ? value.activity : [],
      callback_failures: value.callback_failures ?? 0,
    } as NtfyState;
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
  if (
    (typeof request.source === 'string' && !request.source.trim()) ||
    !request.title.trim() ||
    !request.body.trim()
  )
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
    const id = request.callback.kind === 'held' ? request.callback.ref : randomUUID();
    if (request.callback.kind === 'held' && Object.hasOwn(state.decisions, id))
      Reflect.deleteProperty(state.sent, `decision:${id}:normal`);
    const expires = Math.floor(Date.parse(request.expires_at) / 1000);
    state.decisions[id] = {
      ...request,
      id,
      created_at: new Date(config.now()).toISOString(),
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

function receipt(state: NtfyState, id: string, title: string, message: string, now: number): void {
  if (state.sent[`alert:${id}`] || state.alerts.some(alert => alert.id === id)) {
    state.activity.push({ at: now, kind: 'deduplicated' });
    return;
  }
  const executed = title.startsWith('已记录'),
    processing = title.startsWith('已收到：');
  const parts = title.split('｜'),
    structured = parts.indexOf('需你决定');
  const project = structured >= 0 ? parts[structured + 1] : 'superagent';
  const problem = structured >= 0 ? parts[structured + 2] : parts.at(-1);
  // prettier-ignore
  state.alerts.push(structured >= 0
    ? { id, ...receiptPresentation({ outcome: processing ? 'processing' : executed ? 'executed' : 'not_executed', project, headline: problem ?? '决策回执', selection: parts[0]?.split('：').at(-1) ?? '未知', result: message, next: processing || executed ? '引擎继续执行' : '操作员重读最新决策', source: id }) }
    : { id, title, message, priority: 2, tags: [executed ? 'green_circle' : 'white_circle'] });
  state.alert_ids.push(id);
}

// prettier-ignore
function callbackError(error: unknown): { code: string; message: string; source?: DecisionSourceState } {
  const raw =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : 'callback_failed';
  const source = error && typeof error === 'object' && 'source' in error ? error.source : undefined;
  return {
    code,
    message: code === 'decision_changed' ? '决定已变化，请重读' : '回调处理失败',
    ...(source &&
    typeof source === 'object' &&
    'status' in source &&
    typeof source.status === 'string'
      ? { source: source as DecisionSourceState }
      : {}),
  };
}

const optionLabel = (decision: StoredDecision, option: string): string =>
  decision.options.find(candidate => candidate.id === option)?.label ?? option;

const shortTopic = (title: string): string =>
  Array.from(title.split('：', 1)[0] ?? title)
    .slice(0, 40)
    .join('');

const supersededReceipt = (decision: StoredDecision, option: string): [string, string] => {
  const label = optionLabel(decision, option);
  const source = decision.error?.source;
  const sourceText = source
    ? `这条${source.at ? `在 ${source.at} ` : ''}已 ${source.status}`
    : '这条已失效';
  return [
    `未执行｜${label}｜${shortTopic(decision.title)}`,
    `你点的选项：${label}；${sourceText}（由引擎在 ${decision.handled_at ?? '未知时间'} 标记失效）；你的选择未改变任何状态`,
  ];
};

// prettier-ignore
export function supersedeNtfyDecisions(activeIds: Iterable<string>, supplied: Partial<NtfyConfig> = {}, sourceOf: (id: string) => DecisionSourceState | undefined = () => undefined, kind: 'decision' | 'held' = 'decision'): void {
  const config = { ...defaultConfig(), ...supplied };
  const active = new Set(activeIds);
  const guard = stateLock(config.statePath);
  if (!guard.ok) throw new Error('ntfy state busy');
  try {
    const state = readState(config.statePath);
    for (const decision of Object.values(state.decisions)) {
      if (decision.status !== 'pending' || decision.callback.kind !== kind || active.has(kind === 'decision' && decision.callback.kind === 'decision' ? decision.callback.id : decision.id)) continue;
      const source = sourceOf(decision.callback.kind === 'decision' ? decision.callback.id : decision.id);
      decision.status = 'superseded';
      decision.handled_at = new Date(config.now()).toISOString();
      decision.error = {
        code: 'decision_changed',
        message: '决定已变化，请重读',
        ...(source ? { source } : {}),
      };
    }
    saveState(config.statePath, state);
  } finally {
    guard.release();
  }
}

async function publish(
  config: NtfyConfig,
  state: NtfyState,
  topic: 'sa-decisions' | 'sa-alerts',
  body: Record<string, unknown>
): Promise<void> {
  const publisher = secureSecret(config.publisherToken, 'publisher token');
  const seq = (state.seq ?? 0) + 1;
  const message = body.message;
  // prettier-ignore
  const publishedAt = new Date(config.now()).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replaceAll('/', '-');
  let response: Response;
  try {
    response = await config.fetch(config.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        ...body,
        title: `#${String(seq)} ${publishedAt}｜${typeof body.title === 'string' ? body.title : ''}`,
        message:
          typeof message === 'string' && !message.startsWith('━') && !message.startsWith('─')
            ? `${HEAVY}\n${message}`
            : message,
      }),
    });
  } catch {
    throw new Error('ntfy publish unavailable');
  }
  if (!response.ok) throw new Error(`ntfy publish failed (${String(response.status)})`);
  state.seq = seq;
  saveState(config.statePath, state);
}

const HOUR = 3_600_000;
const RETENTION = 7 * 86_400_000;

function prune(state: NtfyState, now: number): void {
  const retained = now - RETENTION;
  state.activity = state.activity.filter(event => event.at >= retained);
  for (const values of [state.sent, state.limited])
    for (const [key, at] of Object.entries(values))
      if (at < retained) Reflect.deleteProperty(values, key);
}

function recordLimited(state: NtfyState, keys: string[], now: number): void {
  for (const key of keys) {
    if ((state.limited[key] ?? 0) >= now - HOUR) continue;
    state.limited[key] = now;
    state.activity.push({ at: now, kind: 'limited' });
  }
}

const pausedPath = (config: NtfyConfig): string => join(dirname(config.statePath), 'paused');

export function ntfyPauseInfo(
  supplied: Partial<NtfyConfig> = {}
): { at: string; by: Identity | null } | null {
  const marker = pausedPath({ ...defaultConfig(), ...supplied });
  if (!existsSync(marker)) return null;
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8')) as { at?: unknown; by?: unknown };
    const by = value.by as Partial<Identity> | null;
    const validBy = by === null || (typeof by.client === 'string' && typeof by.pid === 'number');
    if (typeof value.at === 'string' && validBy) return { at: value.at, by: by as Identity | null };
  } catch {
    /* Legacy or malformed marker: fall back to mtime. */
  }
  return { at: statSync(marker).mtime.toISOString(), by: null };
}

const HEAVY = '━'.repeat(14),
  LIGHT = '─'.repeat(14);
// prettier-ignore
export function receiptPresentation(input: { outcome: 'processing' | 'executed' | 'not_executed'; project: string; headline: string; selection: string; result: string; next: string; source: string }): { title: string; message: string; priority: number; tags: string[] } {
  const done = input.outcome === 'executed', processing = input.outcome === 'processing';
  return { title: `${processing ? '正在执行' : done ? '已执行' : '未执行'}｜${input.project}｜${input.headline}`, message: `${HEAVY}\n结论：${input.result}\n${HEAVY}\n▍你的选择\n${input.selection}\n${LIGHT}\n▍引擎做了什么\n${input.result}\n${LIGHT}\n▍现在的状态\n${processing ? '正在执行' : done ? '已生效' : '未改变状态'}\n${LIGHT}\n▍接下来谁做什么\n${input.next}\n${LIGHT}\n▍还需要你吗\n${processing || done ? '否' : '是'}\n${LIGHT}\n来源：${input.source}`, priority: 2, tags: [done ? 'green_circle' : 'white_circle'] };
}
const section = (title: string, body?: string): string[] =>
  body?.trim() ? [`▍${title}`, body.trim()] : [];
// prettier-ignore
function decisionPresentation(decision: StoredDecision): { title: string; message: string; priority: number; tags: string[] } {
  if (!decision.project && !decision.headline && !decision.purpose && !decision.why && !decision.recommend && typeof decision.source === 'string')
    return { title: decision.title, message: decision.body, priority: decision.risk === 'red' ? 5 : 4, tags: [decision.risk === 'red' ? 'red_circle' : 'orange_circle'] };
  const source = typeof decision.source === 'string' ? undefined : decision.source;
  const expires = new Date(decision.expires_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replaceAll('/', '-');
  let purpose = Array.from(decision.purpose ?? '').slice(0, 300).join('');
  const render = () => {
    const recommendation = decision.recommend ? [HEAVY, `建议：选「${decision.recommend.option}」——${decision.recommend.reason}`, `同意就直接点「${decision.recommend.option}」`, HEAVY] : [];
    const options = decision.options.map(option => `• ${[option.label, option.timing, option.effect ?? option.consequence, option.reversible && `可回滚：${option.reversible}`].filter(Boolean).join('｜')}`);
    if (decision.default_on_expiry)
      options.push(`• 不处理｜= ${optionLabel(decision, decision.default_on_expiry)}｜${expires} 过期`);
    const risks = decision.options.flatMap(option => option.risk ? [`• 选${option.label}：${option.risk}`] : []);
    const queued = source?.queued_at ? new Date(source.queued_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replaceAll('/', '-') : undefined;
    const origin = source ? [source.ref, source.initiator, queued].filter(Boolean).join('｜') : '';
    return [
      ...recommendation,
      ...section('一句话', decision.headline ?? decision.title),
      LIGHT,
      ...section('选项对比', options.join('\n')),
      ...(purpose ? [LIGHT, ...section('这个任务是什么', purpose)] : []),
      ...(decision.why ? [LIGHT, ...section('为什么找你', decision.why)] : []),
      ...(risks.length ? [LIGHT, ...section('风险与代价', risks.join('\n'))] : []),
      ...(decision.recommend ? [LIGHT, ...section('建议理由', decision.recommend.reason)] : []),
      ...(origin ? [LIGHT, `来源：${origin}`] : []),
    ].join('\n');
  };
  let message = render();
  while (Buffer.byteLength(message) > 4000 && purpose.length) { purpose = purpose.slice(0, -1); message = render(); }
  if (purpose !== (decision.purpose ?? '').slice(0, 300) && source?.ref)
    message += `\n详情：superagent brief ${source.ref}`;
  return { title: ['需你决定', decision.project, decision.headline ?? decision.title].filter(Boolean).join('｜'), message, priority: decision.risk === 'red' ? 5 : 4, tags: [decision.risk === 'red' ? 'red_circle' : 'orange_circle'] };
}

async function flush(config: NtfyConfig, state: NtfyState): Promise<void> {
  const now = config.now();
  prune(state, now);
  if (existsSync(pausedPath(config))) return;
  const recent = state.activity.filter(event => event.at >= now - HOUR);
  let decisionSlots = Math.max(0, 6 - recent.filter(event => event.kind === 'decision').length);
  const decisionLimitedKeys: string[] = [];
  for (const decision of Object.values(state.decisions)) {
    if (decision.status !== 'pending' || decision.delivery !== 'pending') continue;
    const key = `decision:${decision.id}:${decision.red_phase ?? 'normal'}`;
    if (state.sent[key]) {
      decision.delivery = 'sent';
      state.activity.push({ at: now, kind: 'deduplicated' });
      continue;
    }
    if (decisionSlots === 0) {
      decisionLimitedKeys.push(key);
      recordLimited(state, [key], now);
      continue;
    }
    const answer = secureSecret(config.answerToken, 'answer token');
    const presented = decisionPresentation(decision);
    await publish(config, state, 'sa-decisions', {
      ...presented,
      title: decision.red_phase === 'confirm' ? `确认：${presented.title}` : presented.title,
      message:
        decision.red_phase === 'confirm'
          ? `${presented.message}\n影响：${decision.options[0]?.consequence ?? decision.options[0]?.label}`
          : presented.message,
      actions: decision.actions.map(action => actionFor(decision, action, answer, config.baseUrl)),
    });
    decision.delivery = 'sent';
    state.sent[key] = now;
    state.activity.push({ at: now, kind: 'decision' });
    decisionSlots--;
  }
  const alertCount = recent.filter(event => event.kind === 'alert').length;
  let alertSlots = Math.max(0, 10 - alertCount);
  const pending = state.alerts.filter(alert => !state.sent[`alert:${alert.id}`]);
  const needsSummary = decisionLimitedKeys.length > 0 || pending.length > alertSlots;
  const canSummarize = needsSummary && alertSlots > 0 && (state.summary_at ?? 0) < now - HOUR;
  const regularSlots = Math.max(0, alertSlots - (canSummarize ? 1 : 0));
  while (state.alerts.length && regularSlots > 0 && alertSlots > (canSummarize ? 1 : 0)) {
    const alert = state.alerts[0];
    const key = `alert:${alert.id}`;
    if (state.sent[key]) {
      state.alerts.shift();
      state.activity.push({ at: now, kind: 'deduplicated' });
      continue;
    }
    await publish(config, state, 'sa-alerts', {
      ...(alert.title ? { title: alert.title } : {}),
      message: alert.message,
      priority: alert.priority ?? 3,
      tags: alert.tags ?? ['large_blue_circle'],
    });
    state.sent[key] = now;
    state.activity.push({ at: now, kind: 'alert' });
    state.alerts.shift();
    alertSlots--;
  }
  const limitedKeys = decisionLimitedKeys.concat(
    state.alerts.filter(alert => !state.sent[`alert:${alert.id}`]).map(alert => `alert:${alert.id}`)
  );
  recordLimited(state, limitedKeys, now);
  if (canSummarize && limitedKeys.length) {
    await publish(config, state, 'sa-alerts', {
      title: 'superagent 推送已限流',
      message: `另有 ${String(limitedKeys.length)} 条未推送，见 superagent brief`,
      priority: 2,
      tags: ['white_circle'],
    });
    state.summary_at = now;
    state.activity.push({ at: now, kind: 'alert' });
  }
  state.alert_ids = state.alerts.map(alert => alert.id);
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

// prettier-ignore
export type NtfyAnswerHandler = (decision: NtfyAsk & { id: string }, option: string, source?: 'ntfy' | 'local') => unknown;
export async function syncNtfy(
  onAnswer: NtfyAnswerHandler,
  supplied: Partial<NtfyConfig> = {},
  onExpire: (decision: NtfyAsk & { id: string }) => void | Promise<void> = () => undefined,
  source: 'ntfy' | 'local' = 'ntfy',
  advanceCursor = true
): Promise<{ accepted: number; ignored: number; failed: number }> {
  if (!ntfyEnabled(supplied)) return { accepted: 0, ignored: 0, failed: 0 };
  const config = { ...defaultConfig(), ...supplied };
  const guard = stateLock(config.statePath);
  if (!guard.ok) return { accepted: 0, ignored: 0, failed: 0 };
  let accepted = 0;
  let ignored = 0;
  let failed = 0;
  try {
    const state = readState(config.statePath),
      setCursor = (id: string): void => {
        if (advanceCursor) state.cursor = id;
      };
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
          setCursor(event.id);
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
        const gate =
          decision?.callback.kind === 'ask' ? decision.callback.key.split(':')[1] : undefined;
        let rejection: string | undefined;
        if (!decision) rejection = '该决策未找到或已过期，未执行';
        else if (decision.status === 'expired') rejection = '该决策已过期，未执行';
        else if (decision.status === 'superseded')
          rejection = supersededReceipt(decision, answer.option)[1];
        else if (decision.status === 'failed')
          rejection = `这条在 ${decision.handled_at ?? '未知时间'} 处理失败，本次未执行`;
        else if (decision.status === 'answered' || answer.nonce in state.used_nonces)
          rejection = '该决策已处理，本次点按忽略';
        else if (answer.exp < Math.floor(config.now() / 1000)) rejection = '该决策已过期，未执行';
        else if (!expected || !validSignature(answer, key)) rejection = '回答签名无效，未执行';
        if (rejection) {
          ignored++;
          setCursor(event.id);
          receipt(
            state,
            `receipt:${answer.id}:rejected`,
            decision?.status === 'superseded'
              ? supersededReceipt(decision, answer.option)[0]
              : decision?.status === 'failed'
                ? `未执行｜${optionLabel(decision, answer.option)}｜${decisionPresentation(decision).title}`
                : `未执行｜${decision ? decisionPresentation(decision).title : '未知决策'}`,
            rejection,
            config.now()
          );
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
          setCursor(event.id);
          receipt(
            state,
            `receipt:${decision.id}:request`,
            `已收到批准申请｜${decisionPresentation(decision).title}`,
            '请在新通知中确认',
            config.now()
          );
          continue;
        }
        state.used_nonces[answer.nonce] = config.now();
        setCursor(event.id);
        try {
          const outcome = answerOutcome(await onAnswer(decision, answer.option, source));
          decision.status = 'answered';
          decision.answer = answer.option;
          const label = optionLabel(decision, answer.option),
            executed = outcome?.executed ?? true;
          receipt(
            state,
            `receipt:${decision.id}:${answer.option}`,
            `${gate ? '已收到' : executed ? '已记录' : '未执行'}：${label}｜${decisionPresentation(decision).title}`,
            gate
              ? `已收到你的『${label}』，正在执行（门禁 ${gate}）`
              : `${outcome?.result ?? '本次答复已执行'}${source === 'local' ? '（本地答复）' : ''}`,
            config.now()
          );
          accepted++;
        } catch (error) {
          decision.answer = answer.option;
          decision.handled_at = new Date(config.now()).toISOString();
          decision.error = callbackError(error);
          decision.status = decision.error.code === 'decision_changed' ? 'superseded' : 'failed';
          const label = optionLabel(decision, answer.option);
          const staleReceipt = supersededReceipt(decision, answer.option);
          receipt(
            state,
            `receipt:${decision.id}:failed`,
            decision.status === 'superseded'
              ? staleReceipt[0]
              : `未执行｜${label}｜${decisionPresentation(decision).title}`,
            decision.status === 'superseded'
              ? staleReceipt[1]
              : `处理失败（${decision.error.code}）；你的选择未改变任何状态`,
            config.now()
          );
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
              `receipt:${decision.id}:${decision.default_on_expiry}`,
              `已记录：${label}｜${decisionPresentation(decision).title}`,
              '已按到期默认值执行',
              config.now()
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
        if (usedAt < config.now() - RETENTION) Reflect.deleteProperty(state.used_nonces, nonce);
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
  supplied: Partial<NtfyConfig> = {},
  title?: string,
  presentation: { priority?: number; tags?: string[] } = {}
): void {
  const config = { ...defaultConfig(), ...supplied };
  const guard = stateLock(config.statePath);
  if (!guard.ok) throw new Error('ntfy state busy');
  try {
    const state = readState(config.statePath);
    const key = `alert:${id}`;
    if (state.sent[key] || state.alert_ids.includes(id)) {
      state.activity.push({ at: config.now(), kind: 'deduplicated' });
    } else {
      state.alert_ids.push(id);
      state.alerts.push({ id, message, ...(title ? { title } : {}), ...presentation });
    }
    saveState(config.statePath, state);
  } finally {
    guard.release();
  }
}

export function ntfyControl(
  action: 'pause' | 'resume' | 'status',
  supplied: Partial<NtfyConfig> = {}
): {
  paused: boolean;
  paused_at?: string;
  paused_by?: Identity | null;
  sent: number;
  limited: number;
  deduplicated: number;
} {
  const config = { ...defaultConfig(), ...supplied },
    marker = pausedPath(config);
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  if (action === 'pause' && !existsSync(marker)) {
    let by: Identity | null = null;
    try {
      by = config.actor ? config.actor() : caller(true);
    } catch {
      /* Pausing still succeeds when caller identity is unavailable. */
    }
    writeFileSync(marker, JSON.stringify({ at: new Date(config.now()).toISOString(), by }), {
      mode: 0o600,
    });
  }
  if (action === 'resume' && existsSync(marker)) unlinkSync(marker);
  const pause = ntfyPauseInfo(config),
    state = readState(config.statePath),
    cutoff = config.now() - HOUR,
    activity = state.activity.filter(event => event.at >= cutoff);
  return {
    paused: pause !== null,
    ...(pause ? { paused_at: pause.at, paused_by: pause.by } : {}),
    sent: activity.filter(event => event.kind === 'decision' || event.kind === 'alert').length,
    limited: activity.filter(event => event.kind === 'limited').length,
    deduplicated: activity.filter(event => event.kind === 'deduplicated').length,
  };
}

// prettier-ignore
export function ntfyDecisionStatus(id: string, supplied: Partial<NtfyConfig> = {}): { id: string; status: StoredDecision['status']; delivery: StoredDecision['delivery']; expires_at: string; title: string; answer?: string } | undefined {
  const config = { ...defaultConfig(), ...supplied };
  const decision = Reflect.get(readState(config.statePath).decisions, id) as
    | StoredDecision
    | undefined;
  return (
    decision && {
      id,
      status: decision.status,
      delivery: decision.delivery,
      expires_at: decision.expires_at,
      title: decision.headline ?? decision.title,
      ...(decision.answer ? { answer: decision.answer } : {}),
    }
  );
}

// prettier-ignore
export function claimNtfyHealthEvent(id: string, event: string, supplied: Partial<NtfyConfig> = {}): boolean {
  const config = { ...defaultConfig(), ...supplied }, guard = stateLock(config.statePath);
  if (!guard.ok) return false;
  try {
    const state = readState(config.statePath), key = `${id}:${event}`, seen = state.health_events ?? {};
    if (Object.hasOwn(seen, key)) return false;
    state.health_events = { ...seen, [key]: config.now() }; saveState(config.statePath, state); return true;
  } finally { guard.release(); }
}

// prettier-ignore
export async function answerNtfyLocally(id: string, option: string, onAnswer: Parameters<typeof syncNtfy>[0], supplied: Partial<NtfyConfig> = {}, onExpire: Parameters<typeof syncNtfy>[2] = () => undefined): Promise<{ accepted: number; ignored: number; failed: number }> {
  const config = { ...defaultConfig(), ...supplied },
    decision = Reflect.get(readState(config.statePath).decisions, id) as StoredDecision | undefined,
    actor = config.actor?.() ?? caller();
  if (!decision) throw new Error('ask: unknown decision');
  const originator = decision.originator;
  if (!originator || !((actor.session_id && actor.session_id === originator.identity.session_id) || same(coord().owner(originator.scope).owner, actor))) throw new Error('ask: local answer is not authorized');
  if (decision.risk === 'red') throw new Error('ask: red decisions require ntfy confirmation');
  const selected = decision.actions.find(action => action.option === option);
  if (!decision.options.some(candidate => candidate.id === option) || !selected)
    throw new Error('ask: invalid option');
  let delivered = false;
  try {
    return await syncNtfy(
      onAnswer,
      {
        ...config,
        fetch: (async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url).pathname === '/sa-answers/json' && !delivered) {
            delivered = true;
            return new Response(JSON.stringify({ id: randomUUID(), event: 'message', message: JSON.stringify(selected) }));
          }
          return config.fetch(input, init);
        }) as typeof fetch,
      },
      onExpire,
      'local',
      false
    );
  } catch (error) {
    const settled = ntfyDecisionStatus(id, config);
    if (settled?.status === 'answered') return { accepted: 1, ignored: 0, failed: 0 };
    if (settled?.status === 'failed' || settled?.status === 'superseded')
      return { accepted: 0, ignored: 0, failed: 1 };
    throw error;
  }
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

export function ntfyDeliveryStatus(
  kind: 'decision' | 'alert',
  id: string,
  supplied: Partial<NtfyConfig> = {}
): 'sent' | 'pending' {
  const state = readState({ ...defaultConfig(), ...supplied }.statePath);
  if (kind === 'decision') {
    const decision = Reflect.get(state.decisions, id) as StoredDecision | undefined;
    return decision ? decision.delivery : 'pending';
  }
  return state.sent[`alert:${id}`] ? 'sent' : 'pending';
}
