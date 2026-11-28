import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { parseArgs as parse } from 'node:util';
import { archonRunIds, getRun, type RunView } from './archon';
import { openTerminalScreen } from './board/screen';
import { confined } from './board/workflow';
import type { Asks } from './cli';
import { classifyRun, EXIT_USAGE, ledgers, loadAsks, print, saveAsk } from './cli-classify';
import { home } from './config';
import { caller, coord, repoScope, same } from './coord';
import { COORD_OPTIONS } from './coord/commands';
import type { answerNtfyDecision } from './decisions';
import { assertEngineAccess, currentEngineSnapshot } from './engine';
import type { Heartbeat, TickRecord, TickStage } from './heartbeat';
import { installMode } from './install-mode';
import { inspectProcess } from './launcher';
import { artifactsOf, readJson } from './ledger';
import { mergeTask } from './merge';
import {
  answerNtfyLocally,
  askNtfy,
  ntfyControl,
  ntfyDecisionStatus,
  ntfyDeliveryStatus,
  ntfyPauseInfo,
  parseNtfyAskSpec,
  publishPendingNtfy,
  queueNtfyAlert,
  type syncNtfy,
  type NtfyConfig,
  type NtfyOption,
} from './ntfy';
import type { answerHeldOwnerAsk } from './reclaim';
import { relayQuota } from './relay-quota';

// The board and decision handlers consume CLI projections themselves. Load them on demand.
const load = createRequire(import.meta.url);

export const OPTIONS = {
  ...COORD_OPTIONS,
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  user: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  apply: { type: 'boolean' },
  'lint-override': { type: 'string' },
  'allow-overlap': { type: 'string' },
  adopt: { type: 'string' },
  fresh: { type: 'boolean' },
  goal: { type: 'string' },
  'accept-timeout': { type: 'string' },
  environment: { type: 'string', multiple: true },
  console: { type: 'string' },
  accept: { type: 'string', multiple: true },
  scope: { type: 'string', multiple: true },
  risk: { type: 'string' },
  size: { type: 'string', metavar: 'S|M|L' },
  'review-reason': { type: 'string' },
  'review-whitelist': { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  base: { type: 'string' },
  worktree: { type: 'string' },
  mode: { type: 'string' },
  repo: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  cwd: { type: 'string' },
  verbose: { type: 'boolean' },
  days: { type: 'string' },
  once: { type: 'boolean' },
  interval: { type: 'string' },
  watch: { type: 'boolean' },
  limit: { type: 'string' },
  'terms-json': { type: 'string' },
  json: { type: 'boolean' }, // board/models/status/brief/wait 等命令的机器可读输出开关
  diagnose: { type: 'boolean' },
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
  'message-file': { type: 'string' },
  into: { type: 'string' },
  vault: { type: 'string' },
  host: { type: 'string', multiple: true },
  prune: { type: 'boolean' },
  open: { type: 'boolean' },
  schedule: { type: 'boolean' },
  runs: { type: 'string', multiple: true },
  'no-global': { type: 'boolean' },
  'bootstrap-evidence': { type: 'string' },
  scenario: { type: 'string' },
  matrix: { type: 'boolean' },
  parallel: { type: 'string' },
  source: { type: 'string' },
  spec: { type: 'string' },
  body: { type: 'string' },
  option: { type: 'string', multiple: true },
  'expires-at': { type: 'string' },
  'default-on-expiry': { type: 'string' },
  callback: { type: 'string' },
  id: { type: 'string' },
  recommend: { type: 'string' },
  why: { type: 'string' },
  priority: { type: 'string' },
  effect: { type: 'string', multiple: true },
  improve: { type: 'string', multiple: true },
} as const;

export interface Args {
  _: string[];
  flags: ReturnType<typeof parse<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];
}

export const quickSize = (size = 'S') => {
  if (size !== 'S' && size !== 'M' && size !== 'L') throw new Error('quick --size must be S|M|L');
  return size;
};

/** 严格模式：未知参数直接报错，不静默忽略。 */
export function parseArgs(argv: string[]): Args {
  const { values, positionals } = parse({ args: argv, options: OPTIONS, allowPositionals: true });
  if (positionals[0] === 'quick') quickSize(values.size);
  return { _: positionals, flags: values };
}

export type NtfyTickRecord = TickRecord &
  Partial<Record<'ntfy_sync' | 'ntfy_publish' | 'orca_delivery', TickStage>>;

export const superviseOwnerPath = (sa = home().sa): string => join(sa, 'supervise-owner.json');

export function superviseTickRunning(
  owner: unknown,
  now = Date.now(),
  alive = (pid: number, start: string): boolean => {
    const state = inspectProcess(pid);
    return state.state === 'online' && state.start === start;
  }
): boolean {
  if (!owner || typeof owner !== 'object') return false;
  const value = owner as Record<string, unknown>,
    age = now - (typeof value.started_at === 'string' ? Date.parse(value.started_at) : NaN);
  return (
    Number.isInteger(value.pid) &&
    typeof value.pid_start === 'string' &&
    age >= 0 &&
    age <= 600_000 &&
    alive(value.pid as number, value.pid_start)
  );
}

export const optional = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

// prettier-ignore
export const liveCallbackAsk = (asks: Asks, key: string, id: string): [string, NonNullable<Asks[string]>] | undefined => Object.entries(asks).find((entry): entry is [string, NonNullable<Asks[string]>] => !!entry[1] && entry[1].id === id && ['pending', 'unknown'].includes(entry[1].status) && (entry[0] === key || entry[1].legacy_key === key));

// prettier-ignore
export const ntfyExpiryCallback = (decision: Parameters<NonNullable<Parameters<typeof syncNtfy>[2]>>[0]): void => {
  if (decision.callback.kind !== 'ask') return;
  const asks = loadAsks(), entry = liveCallbackAsk(asks, decision.callback.key, decision.id);
  if (!entry) return;
  const [currentKey, current] = entry; current.status = 'expired'; saveAsk(asks, currentKey);
};

export const ntfyAnswerCallback =
  (
    answer: typeof answerNtfyDecision = (load('./decisions') as typeof import('./decisions'))
      .answerNtfyDecision,
    answerHeld: typeof answerHeldOwnerAsk = (load('./reclaim') as typeof import('./reclaim'))
      .answerHeldOwnerAsk
  ) =>
  async (
    decision: Parameters<Parameters<typeof syncNtfy>[0]>[0],
    option: string,
    source?: 'ntfy' | 'local'
  ) => {
    if (decision.callback.kind === 'decision') {
      await answer(decision.callback.id, option);
      return;
    }
    if (decision.callback.kind === 'external') {
      if (decision.originator)
        coord().receipt(
          decision.originator.scope,
          caller(true),
          decision.originator.identity,
          decision.id,
          `${decision.headline ?? decision.title}：${decision.options.find(item => item.id === option)?.label ?? option}${source === 'local' ? '（本地答复）' : ''}`
        );
      return;
    }
    if (decision.callback.kind === 'held') {
      const results = answerHeld(decision.callback.ref, decision.id, option),
        result = results.length ? results.join('；') : '无匹配 run',
        executed = results.some(item => item.includes(':ok:'));
      if (decision.originator)
        coord().receipt(
          decision.originator.scope,
          caller(true),
          decision.originator.identity,
          decision.id,
          `${decision.headline ?? decision.title}：${decision.options.find(item => item.id === option)?.label ?? option}${source === 'local' ? '（本地答复）' : ''}；${result}`
        );
      return { result, executed };
    }
    const callbackKey = decision.callback.key,
      asks = loadAsks(),
      entry = liveCallbackAsk(asks, callbackKey, decision.id);
    if (!entry) throw new Error('ntfy decision changed');
    const [currentKey, current] = entry;
    current.status = option;
    saveAsk(asks, currentKey);
    return undefined;
  };

export function need<T>(v: T | undefined, usage: string): T {
  if (v === undefined) throw new Error(`usage: superagent ${usage}`);
  return v;
}

export async function askCli(
  argv: string[],
  supplied: Partial<NtfyConfig> = {},
  emit: (value: unknown) => void = print
): Promise<number> {
  const a = parseArgs(argv);
  if (a._[1] === 'answer') {
    if (a._.length !== 4) throw new Error('usage: superagent ask answer <id> <option>');
    // prettier-ignore
    const result = await answerNtfyLocally(a._[2], a._[3], ntfyAnswerCallback(), supplied, ntfyExpiryCallback);
    emit({ id: a._[2], option: a._[3], source: 'local', ...result });
    return 0;
  }
  if (a._[1] === 'status') {
    if (a._.length !== 3) throw new Error('usage: superagent ask status <id>');
    const status = ntfyDecisionStatus(a._[2], supplied);
    if (!status) throw new Error('ask: unknown decision');
    emit(status);
    return 0;
  }
  if (a._.length !== 1) throw new Error('usage: superagent ask [structured flags]');
  const parseOption = (value: string): NtfyOption => {
    const [id, label, ...consequence] = value.split('=');
    if (!id || !label) throw new Error('--option must be id=label[=consequence]');
    return { id, label, ...(consequence.length ? { consequence: consequence.join('=') } : {}) };
  };
  const specPath = a.flags.spec;
  if (specPath) {
    const conflicting = [
      'source',
      'title',
      'body',
      'option',
      'expires-at',
      'default-on-expiry',
      'callback',
      'recommend',
      'why',
      'risk',
    ].find(flag => Reflect.get(a.flags, flag) !== undefined);
    if (conflicting) throw new Error(`--spec cannot be combined with --${conflicting}`);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(specPath, 'utf8'));
    } catch (error) {
      throw new Error(`ask spec: ${(error as Error).message}`);
    }
    const id = askNtfy(
      { ...parseNtfyAskSpec(value), originator: { identity: caller(), scope: coord().scope() } },
      supplied
    );
    return publishAsk(id, supplied, emit);
  }
  const source = need(a.flags.source, 'ask --source <source>'),
    title = need(a.flags.title, 'ask --title <title>'),
    body = need(a.flags.body, 'ask --body <body>'),
    callback = need(a.flags.callback, 'ask --callback <ref>'),
    expiresAt = need(a.flags['expires-at'], 'ask --expires-at <ISO time>'),
    risk = a.flags.risk ?? 'normal';
  if (risk !== 'normal' && risk !== 'red') throw new Error('--risk must be normal or red');
  const id = askNtfy(
    {
      source,
      title,
      body,
      options: (a.flags.option ?? []).map(parseOption),
      risk,
      expires_at: expiresAt,
      default_on_expiry: a.flags['default-on-expiry'],
      callback: { kind: 'external', ref: callback },
      dedupe_key: `external:${callback}`,
      originator: { identity: caller(), scope: coord().scope() },
      ...(a.flags.recommend
        ? {
            project: source,
            headline: title,
            purpose: body,
            why: a.flags.why,
            recommend: { option: a.flags.recommend, reason: a.flags.why ?? '' },
            source: { ref: callback, initiator: source, queued_at: new Date().toISOString() },
          }
        : {}),
    },
    supplied
  );
  return publishAsk(id, supplied, emit);
}

// prettier-ignore
export function askWaitHealth(
  ids: string[],
  supplied: Partial<NtfyConfig> = {},
  tick = readJson(join(home().sa, 'tick.json')) as NtfyTickRecord | undefined,
  now = Date.now(),
  superviseRunning = superviseTickRunning(optional(() => readJson(superviseOwnerPath())), now)
): { event: string; id: string; reason: string; next: string } | undefined {
  if (!ids.length) return undefined; for (const id of ids) {
    const decision = ntfyDecisionStatus(id, supplied);
    if (!decision || decision.status === 'superseded')
      return { event: 'withdrawn', id, reason: '问询已撤回', next: `在当前对话确认选择后运行 superagent ask answer ${id} <option>` };
    if (decision.status === 'expired' || Date.parse(decision.expires_at) <= now)
      return { event: 'expired', id, reason: '问询已过期', next: '重发问询或按到期默认值继续' };
  }
  if (ntfyPauseInfo(supplied))
    return { event: 'paused', id: ids[0], reason: 'ntfy 已暂停', next: '在当前对话确认选择后运行 superagent ask answer <id> <option>' };
  if (tick?.ntfy_publish && !tick.ntfy_publish.ok && ids.some(id => ntfyDecisionStatus(id, supplied)?.delivery === 'pending'))
    return { event: 'delivery_failed', id: ids[0], reason: `问询推送失败：${tick.ntfy_publish.error ?? 'unknown'}`, next: '在当前对话确认选择后运行 superagent ask answer <id> <option>' };
  const tickAt = Date.parse(tick?.at ?? '');
  if ((!Number.isFinite(tickAt) || now - tickAt > 180_000) && !superviseRunning)
    return { event: 'tick_stale', id: ids[0], reason: 'supervise-tick 超过 3 分钟未更新', next: '改走本地答复，并恢复 supervise-tick' };
  return undefined;
}

async function publishAsk(
  id: string,
  supplied: Partial<NtfyConfig>,
  emit: (value: unknown) => void
): Promise<number> {
  let delivery: 'sent' | 'pending';
  try {
    await publishPendingNtfy(supplied);
    delivery = ntfyDeliveryStatus('decision', id, supplied);
  } catch {
    delivery = 'pending';
  }
  emit({
    id,
    status: 'pending',
    delivery,
    next: '后台运行 superagent inbox --wait --timeout 7000 等待答复（答复约 60 秒内送达）',
  });
  return 0;
}

export async function notifyCli(
  argv: string[],
  supplied: Partial<NtfyConfig> = {},
  emit: (value: unknown) => void = print
): Promise<number> {
  const a = parseArgs(argv),
    usage = 'usage: superagent notify --id <id> --title <title> --body <body>';
  if (a._.length !== 1) throw new Error(usage);
  const required = (value: string | undefined): string => {
    if (!value?.trim()) throw new Error(usage);
    return value;
  };
  const id = required(a.flags.id),
    title = required(a.flags.title),
    body = required(a.flags.body);
  const priority = Number(a.flags.priority ?? 3);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5)
    throw new Error('--priority must be 1-5');
  const worker = installMode() === 'worker';
  if (worker && ntfyDeliveryStatus('alert', id, supplied) === 'sent') {
    emit({ id, delivery: 'sent' });
    return 0;
  }
  queueNtfyAlert(id, body, supplied, title, { priority, tags: ['large_blue_circle'] });
  let failure: Error | undefined;
  try {
    await publishPendingNtfy(supplied, worker);
  } catch (error) {
    failure = error instanceof Error ? error : new Error('ntfy publish failed');
  }
  const delivery = !worker && failure ? 'pending' : ntfyDeliveryStatus('alert', id, supplied);
  if (worker && delivery !== 'sent')
    throw failure ?? new Error('ntfy alert delivery pending; retry with the same --id');
  emit({ id, delivery });
  return 0;
}

export function ntfyCli(
  argv: string[],
  supplied: Partial<NtfyConfig> = {},
  emit: (value: unknown) => void = print
): number {
  const a = parseArgs(argv),
    action = a._[1];
  if (a._.length !== 2 || !['pause', 'resume', 'status'].includes(action))
    throw new Error('usage: superagent ntfy pause|resume|status');
  emit(ntfyControl(action as 'pause' | 'resume' | 'status', supplied));
  return 0;
}

export async function heartbeatCli(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (a._.length !== 1 || (a.flags.all && a.flags.cwd))
    throw new Error('usage: superagent heartbeat [--watch] [--cwd <absolute-path>|--all]');
  const { allMarshals, cwdFilter, panelModel, renderPanel } = load(
    './panel'
  ) as typeof import('./panel');
  const { queueTickStaleAlert } = load('./heartbeat') as typeof import('./heartbeat');
  let filter = allMarshals;
  let scopeLabel = '全部项目';
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
    scopeLabel = basename(cwd);
  }
  const readModel = () => {
    const pause = ntfyPauseInfo(),
      pauseCwd =
        pause?.by && 'cwd' in pause.by && typeof pause.by.cwd === 'string'
          ? basename(pause.by.cwd)
          : undefined;
    return panelModel(
      readJson(join(home().sa, 'heartbeat.json')) as Heartbeat | undefined,
      readJson(join(home().sa, 'tick.json')) as TickRecord | undefined,
      Date.now(),
      filter,
      scopeLabel,
      pause
        ? { at: pause.at, by: pause.by && pauseCwd ? `${pause.by.client} ${pauseCwd}` : null }
        : undefined
    );
  };
  const draw = (): string =>
    renderPanel(
      readJson(join(home().sa, 'heartbeat.json')) as Heartbeat | undefined,
      readJson(join(home().sa, 'tick.json')) as TickRecord | undefined,
      Date.now(),
      filter,
      process.stdout.columns || 100,
      process.stdout.isTTY,
      scopeLabel
    );
  if (!a.flags.watch) {
    console.log(draw());
    return 0;
  }
  const startedEngine = currentEngineSnapshot();
  let queuedTickAlert: string | undefined;
  const notifyTickStale = async (model: ReturnType<typeof readModel>): Promise<void> => {
    const previous = queuedTickAlert;
    queuedTickAlert = queueTickStaleAlert(model.health.stale, previous, alert => {
      queueNtfyAlert(
        alert.id,
        `${'━'.repeat(14)}\n要你做：重启 supervise-tick\n${'━'.repeat(14)}\n▍发生了什么\n引擎巡检已停 ${String(alert.minutes)} 分钟\n${'─'.repeat(14)}\n▍影响\nrun 状态、回收与通知无法持续更新\n${'─'.repeat(14)}\n▍已自动尝试\n已由 heartbeat 检测并发出告警\n${'─'.repeat(14)}\n▍怎么处理\n${alert.message}\n${'─'.repeat(14)}\n▍证据\n${join(home().sa, 'tick.json')}`,
        {},
        `引擎巡检停摆 ${String(alert.minutes)} 分钟`,
        { priority: 4, tags: ['red_circle'] }
      );
    });
    if (queuedTickAlert && ntfyDeliveryStatus('alert', queuedTickAlert) === 'pending')
      await publishPendingNtfy();
  };
  if (process.stdout.isTTY) {
    const [{ createElement }, { renderToString }, { HeartbeatFrame }] = await Promise.all([
      import('react'),
      import('ink'),
      import('./board/HeartbeatView'),
    ]);
    const quota = (): string | undefined => relayQuota().quota;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>(resolve => {
      resolveExit = resolve;
    });
    let model = readModel();
    await notifyTickStale(model);
    let fingerprint = JSON.stringify(model);
    let quotaValue = quota();
    const screen = openTerminalScreen({
      input: process.stdin,
      output: process.stdout,
      signals: process,
      onExit: resolveExit,
    });
    const render = (): void => {
      const width = process.stdout.columns || 100;
      screen.render(
        renderToString(
          createElement(HeartbeatFrame, {
            model,
            quota: quotaValue,
            now: Date.now(),
            width,
            rows: process.stdout.rows || 30,
          }),
          { columns: width }
        )
      );
    };
    const refresh = (): void => {
      const next = readModel();
      void notifyTickStale(next).catch((error: unknown) => {
        console.error(
          `heartbeat tick alert failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      const serialized = JSON.stringify(next);
      if (serialized === fingerprint) return;
      model = next;
      fingerprint = serialized;
      render();
    };
    const refreshQuota = (): void => {
      const next = quota();
      if (next === quotaValue) return;
      quotaValue = next;
      render();
    };
    const resize = (): void => {
      render();
    };
    process.stdout.on('resize', resize);
    render();
    const dataTimer = setInterval(refresh, 15_000);
    const clockTimer = setInterval(render, 500);
    const quotaTimer = setInterval(refreshQuota, 300_000);
    const promotionTimer = setInterval(() => {
      const code = heartbeatEngineExitCode(startedEngine);
      if (code) resolveExit(code);
    }, 15_000);
    try {
      return await exited;
    } finally {
      clearInterval(dataTimer);
      clearInterval(clockTimer);
      clearInterval(quotaTimer);
      clearInterval(promotionTimer);
      process.stdout.off('resize', resize);
      screen.close();
    }
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
      await notifyTickStale(readModel());
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
  if (!resolved || resolved === started) return 0;
  return (load('./board/App') as typeof import('./board/App')).ENGINE_CHANGED;
}

const drain = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      reject(error);
    };
    stream.once('error', failed);
    stream.end(() => {
      stream.off('error', failed);
      resolve();
    });
  });

export async function exitCli(code: number): Promise<never> {
  await Promise.allSettled([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}

// prettier-ignore
export async function mergeCli(argv: string[]): Promise<number> {
  const { _: [, source, ...extra], flags } = parseArgs(argv);
  const allowed = ['dry-run', 'message-file', 'accept', 'into', 'json'];
  if (!source || extra.length || Object.keys(flags).some(flag => !allowed.includes(flag))) {
    print({ status: 'rejected', reason: 'usage', next_action: 'superagent merge <task-worktree> --dry-run' });
    return EXIT_USAGE;
  }
  assertEngineAccess(argv);
  const who = caller();
  const native = new Map<string, RunView>();
  const result = await mergeTask(source, {
    dryRun: flags['dry-run'], messageFile: flags['message-file'], into: flags.into, accept: flags.accept,
  }, {
    home: home().sa,
    ledgers,
    canMerge: path => {
      const owner = coord().owner(repoScope(path));
      return owner.conflicts.length === 0 && (!owner.owner || same(owner.owner, who));
    },
    state: l => {
      const run = getRun(l.archon_run_id, l.repo);
      native.set(run.id, run);
      return ['pending', 'running', 'paused'].includes(run.status) ? run.status : classifyRun(l, run).state;
    },
    receipts: l => archonRunIds(l).flatMap(id => {
      let run: RunView;
      try { run = native.get(id) ?? getRun(id, l.repo); } catch { return []; }
      const dir = run.output_root && confined(l, artifactsOf(run));
      return dir ? [...new Bun.Glob('publish-*.json').scanSync({ cwd: dir })]
        .flatMap(file => confined(l, join(dir, file)) ?? []) : [];
    }),
    plan: l => confined(l, join(l.gen_dir, 'plan.json')),
    orca: (load('./orca') as typeof import('./orca')).syncOrcaMerge,
  });
  print(result.value);
  return result.exit;
}
