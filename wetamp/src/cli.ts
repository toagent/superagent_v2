// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs as parse } from 'node:util';
import {
  archon,
  archonDetached,
  archonJson,
  getRun,
  lastJson,
  lock,
  ownerLost,
  recover,
  signalHuman,
  tail,
  type RecoverResult,
  type RunView,
} from './archon';
import {
  openBlocking,
  type Review,
  type decide as decideGate,
} from '../templates/.archon/scripts/sa-check';
import { WETAMP, aliasDrift, codexWorkerProblem, home, loadTiers, runAliases } from './config';
import { generate, newRunId } from './generate';
import { loadPlan, milestones, type Plan } from './plan';
import { buildReport } from './report';

const OPTIONS = {
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  'skip-selftest': { type: 'boolean' },
  cwd: { type: 'string' },
  once: { type: 'boolean' },
  interval: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' }, // 输出本来就是 JSON；接受以兼容 superagent v1 调用方
  'all-held': { type: 'boolean' },
  title: { type: 'string' },
  card: { type: 'string' },
  log: { type: 'string' },
  all: { type: 'boolean' },
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
export const EXIT_USAGE = 64;

export interface Ledger {
  run_id: string;
  archon_run_id: string;
  plan: string;
  gen_dir: string;
  repo: string;
  branch: string;
  workflow: string;
  console: string;
  started_at: string;
  transcript: string;
  log: string;
  recoveries: string[];
  /** 最近一次 recover 时已完成节点集合的指纹，及在该指纹上连续 recover 的次数（旧 ledger 无这两项）。 */
  progress_fp?: string;
  stalled?: number;
  /** supervise-tick 因 plan 截止已过取消 held:human 的 run 时写入。 */
  state?: 'failed';
  reason?: 'deadline';
  /** supervise-tick 的自动重试；reason 前缀即类别（gate:<gate reason> / environment / coder:<节点>）。与 stalled 互不影响。 */
  auto_retries?: AutoRetry[];
}
export interface AutoRetry {
  milestone: string;
  at: string;
  reason: string;
}

export const ledgerPath = (run: string): string => join(home().sa, 'runs', `${run}.json`);
const saveLedger = (l: Ledger): void => {
  writeFileSync(ledgerPath(l.run_id), JSON.stringify(l, null, 2) + '\n');
};

export function loadLedger(run: string): Ledger {
  const p = ledgerPath(run);
  if (!existsSync(p)) throw new Error(`unknown run ${run} (no ${p})`);
  return JSON.parse(readFileSync(p, 'utf8')) as Ledger;
}

export interface Classified {
  state: string;
  exit: number;
  node?: string;
  event?: string;
}

/** archon run 状态 → superagent 状态。gate/environment 失败是“待决策”而非终局失败：decide retry 可 resume。 */
export function classify(run: RunView): Classified {
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
/** 将军输出存档（sa-check accept 写的 `<tag>.coder.json`），可按里程碑过滤。 */
interface CoderOut {
  tag: string;
  milestone?: string;
  error_class?: string | null;
  needs?: { cap: string; why: string; minimal_ask: string }[];
}
const codersOf = (art: string, m?: string): CoderOut[] =>
  (existsSync(art) ? readdirSync(art).filter(f => f.endsWith('.coder.json')) : [])
    .map(f => ({ ...(readJson(join(art, f)) as CoderOut), tag: f.slice(0, -'.coder.json'.length) }))
    .filter(c => m === undefined || c.milestone === m);
/** 聚合 needs[]（每条带来源 tag）：status/brief/board 展示，自动重试据此保持 held。 */
export const needsOf = (art: string, m?: string): Record<string, string>[] =>
  codersOf(art, m).flatMap(c => (c.needs ?? []).map(n => ({ tag: c.tag, ...n })));

/** 登记过的 run id（runs/*.json 去掉扩展名）。 */
export const ledgerIds = (): string[] => {
  const dir = join(home().sa, 'runs');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
    : [];
};
const ledgers = (): Ledger[] => ledgerIds().map(loadLedger);

/** ≤20 行的摘要：元帅只读这个和证据路径。 */
function summary(l: Ledger, run: RunView, c: Classified): Record<string, unknown> {
  const nodes = run.nodes ?? [];
  const art = artifactsOf(run);
  const needs = needsOf(art);
  return {
    run_id: l.run_id,
    state: c.state,
    exit: c.exit,
    nodes: `${String(nodes.filter(n => n.state === 'completed').length)}/${String(nodes.length)} completed`,
    ...(c.node ? { node: c.node } : {}),
    ...(c.event ? { event: c.event } : {}),
    ...(c.node?.startsWith('gate-') ? { gate: readJson(join(art, `${c.node}.json`)) } : {}),
    ...(c.state === 'failed'
      ? { error: tail(nodes.find(n => n.nodeId === c.node)?.error ?? '', 200) }
      : {}),
    ...(c.state === 'completed'
      ? {
          land: (readJson(join(art, 'land.json')) as { commands?: string[] } | undefined)?.commands,
        }
      : {}),
    evidence: art,
    recoveries: l.recoveries.length,
    auto_retries: l.auto_retries?.length ?? 0,
    ...(needs.length ? { needs } : {}),
    ...(l.reason ? { reason: l.reason } : {}),
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

/** classify + ledger：同一完成节点集合上已 recover 满 3 次的 owner-lost run 不再自动恢复，等元帅。 */
export function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
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
function recoverRun(l: Ledger, fresh = false, auto?: AutoRetry): RecoverResult {
  let fp = '';
  return recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (auto) return undefined;
      if (fresh) l.stalled = 0;
      fp = progressOf(run);
      return stalledOut(l, run) ? 'recover_no_progress' : undefined;
    },
    () => {
      if (auto) (l.auto_retries ??= []).push(auto);
      else {
        l.stalled = (l.progress_fp === fp ? (l.stalled ?? 0) : 0) + 1;
        l.progress_fp = fp;
        l.recoveries.push(new Date().toISOString());
      }
      saveLedger(l);
    }
  );
}

/** 分片等待：事件门不会唤醒 archon wait，所以每片 ≤30s 后重新 get；可证实 owner-lost 时自动 recover。 */
export function waitRun(l: Ledger, timeoutS: number): Record<string, unknown> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const run = getRun(l.archon_run_id, l.repo);
    const c = classifyRun(l, run);
    if (c.state === 'owner_lost') {
      const r = recoverRun(l);
      if (r.ok) continue;
      const held = r.reason === 'recover_no_progress';
      return {
        ...summary(
          l,
          run,
          held
            ? { state: 'held:recover_no_progress', exit: EXIT.held }
            : { ...c, exit: EXIT.failed }
        ),
        reason: r.reason,
      };
    }
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (c.exit !== EXIT.running || left <= 0) return summary(l, run, c);
    archon(
      ['workflow', 'wait', l.archon_run_id, '--json', '--timeout', String(Math.min(30, left))],
      l.repo
    );
  }
}

const MIN_FREE_GB = 2;
const SELFTEST_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function preflight(skipSelftest: boolean): void {
  const { sa } = home();
  const fs = statfsSync(sa);
  if ((fs.bavail * fs.bsize) / 2 ** 30 < MIN_FREE_GB)
    throw new Error(`preflight: < ${String(MIN_FREE_GB)}GB free under ${sa}`);
  if (skipSelftest) return;
  const st = readJson(join(sa, 'selftest.json')) as { ok?: boolean; at?: string } | undefined;
  if (!st?.ok || !st.at || Date.now() - Date.parse(st.at) > SELFTEST_MAX_AGE_MS) {
    throw new Error('preflight: no passing selftest within 7 days; run wetamp/scripts/selftest.sh');
  }
}

function startRun(planPath: string, a: Args): number {
  preflight(a.flags['skip-selftest'] ?? false);
  const plan = loadPlan(planPath);
  const drift = aliasDrift(plan.repo);
  if (drift.length) {
    print({ ok: false, reason: 'alias_drift', drift, fix: 'wetamp/scripts/install.sh' });
    return EXIT_ALIAS_DRIFT;
  }
  const run = newRunId();
  const gen = generate(plan, run, a.flags.fake ?? false);
  const branch = `sa/${run}`;
  const args = ['workflow', 'run', gen.workflow, '--workflow-source', gen.dir, '--cwd', plan.repo];
  args.push('--branch', branch, '--from', plan.base_ref, '--detach', '--config', gen.config);
  const ack = archonJson(args, plan.repo);
  if (ack.ok !== true || typeof ack.runId !== 'string')
    throw new Error(`archon run: ${tail(JSON.stringify(ack))}`);
  const l: Ledger = {
    run_id: run,
    archon_run_id: ack.runId,
    plan: planPath,
    gen_dir: gen.dir,
    repo: plan.repo,
    branch,
    workflow: gen.workflow,
    console: plan.console ?? 'claude',
    started_at: new Date().toISOString(),
    transcript: String(ack.transcriptPath),
    log: String(ack.logPath),
    recoveries: [],
  };
  mkdirSync(join(home().sa, 'runs'), { recursive: true });
  saveLedger(l);
  print({ run_id: run, archon_run_id: l.archon_run_id, branch, gen_dir: gen.dir });
  return 0;
}

function health(cwd?: string): number {
  const aliases = runAliases('claude');
  const drift = aliasDrift(cwd);
  const doctor = archon(['doctor']);
  const clean = Bun.spawnSync([join(WETAMP, 'scripts', 'check-upstream-clean.sh')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const upstreamDiff = clean.stdout.toString().trim();
  const worker = codexWorkerProblem();
  const ok =
    doctor.code === 0 && clean.exitCode === 0 && upstreamDiff === '' && !drift.length && !worker;
  print({
    ok,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
    codex_worker: worker ?? 'ok',
  });
  return ok ? 0 : drift.length ? EXIT_ALIAS_DRIFT : 1;
}

function resumeRun(l: Ledger, fresh = false): number {
  const res = recoverRun(l, fresh);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
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

/** 生成时带 attempt-<m> 节点的工作流（本版起都有）才能让 resume 重跑该里程碑的编码与修复。 */
const attemptable = (l: Ledger, m: string): boolean => {
  const wf = join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`);
  return existsSync(wf) && readFileSync(wf, 'utf8').includes(`id: attempt-${m}\n`);
};
/** attempt-<m>（always_run）读这个计数：数值变了，依赖它的 code/verify/fix/diff 节点在 resume 时重跑。 */
function bumpAttempt(l: Ledger, m: string): number {
  const dir = join(l.gen_dir, 'attempts');
  mkdirSync(dir, { recursive: true });
  const n = Number(readJson(join(dir, m)) ?? 0) + 1;
  writeFileSync(join(dir, m), String(n));
  return n;
}
const gateMilestone = (node: string): string => node.replace(/^gate-(.+)-r\d+$/, '$1');

/** held:gate 的恢复：里程碑计数加一后 resume，重跑本里程碑编码→验收→评审；旧工作流无 attempt 节点则拒绝。 */
function retryGate(l: Ledger, node: string, fresh: boolean, auto?: AutoRetry): RecoverResult {
  const m = gateMilestone(node);
  if (!attemptable(l, m))
    throw new Error(`decide retry: ${node} escalated; fix on ${l.branch} or start a new run`);
  bumpAttempt(l, m);
  return recoverRun(l, fresh, auto);
}

/** decide retry 的恢复部分：held:gate 走 retryGate，其余 resume 失败节点。 */
const retry = (l: Ledger, c: Classified): RecoverResult =>
  c.state === 'held:gate' ? retryGate(l, c.node ?? '', true) : recoverRun(l, true);

/** decide --all-held retry：对所有 held（签收门除外）的 run 逐个 retry，单个失败不影响其余。 */
function retryAllHeld(): number {
  const out = ledgers().flatMap((l): Record<string, unknown>[] => {
    try {
      const c = classifyRun(l, getRun(l.archon_run_id, l.repo));
      if (!c.state.startsWith('held:') || c.state === 'held:human') return [];
      return [{ run_id: l.run_id, state: c.state, ...retry(l, c) }];
    } catch (e) {
      return [{ run_id: l.run_id, ok: false, reason: tail((e as Error).message, 200) }];
    }
  });
  print(out);
  return out.every(x => x.ok === true) ? 0 : 1;
}

/** approve：放行 sa.human.* 签收门；reject：终止 run（cancelRun）；retry：可选写 hint 后 resume（held:gate 重跑整个里程碑）。 */
function decide(l: Ledger, a: Args): number {
  const action = need(a._[2], 'decide <run> approve|reject|retry [--pkg id --hint text]');
  const run = getRun(l.archon_run_id, l.repo);
  const c = classifyRun(l, run);
  if (action === 'approve') {
    if (pastDeadline(l)) {
      print({ run_id: l.run_id, ok: false, reason: PAST_DEADLINE });
      return 1;
    }
    const log = join(l.gen_dir, `signal-${c.node ?? 'none'}.log`);
    const r = signalHuman(run, { decision: 'approve' }, log, l.repo);
    print({ run_id: l.run_id, ...r });
    return r.ok ? 0 : 1;
  }
  if (action === 'reject') {
    const ok = cancelRun(l.archon_run_id, run.status, l.repo);
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
  const res = retry(l, c);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
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
  for (const f of gatesOf(art)) {
    const g = readJson(join(art, f)) as Gate;
    lines.push(
      `${f.slice(0, -5)}: ${g.verdict}${g.reason ? ` (${g.reason})` : ''} debt=${String(g.debt.length)}`
    );
  }
  for (const [k, v] of Object.entries(asksOf(l.run_id)))
    lines.push(`ask ${k}: ${v?.status ?? '?'}`);
  if (l.reason === 'deadline') lines.push('plan 截止已过，已取消');
  if (typeof s.error === 'string') lines.push(`error: ${s.error}`);
  if (Array.isArray(s.land)) lines.push(...(s.land as string[]));
  for (const n of needsOf(art).slice(0, 3)) lines.push(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
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

// supervise-tick：无人值守巡检（cron/launchd 周期调用 `superagent supervise-tick`）：唤醒到期的事件门、恢复 owner-lost、
// 把红线签收投到 agent-supervisor（iPhone 提醒事项：勾选=是、删除=否），按回答 signal 或终止 run。
const ANSWERS = ['pending', 'yes', 'no', 'expired'];
interface Ask {
  id?: string; // 先落 unknown 再调 ask；ask 中途崩溃或非零退出都保留 unknown，下一 tick 对账
  status: string; // ANSWERS 之一、unknown，或执行后的 approved | rejected
}
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };

const asksPath = (): string => join(home().sa, 'asks.json');
export type Asks = Partial<Record<string, Ask>>;
const loadAsks = (): Asks => (readJson(asksPath()) as Asks | undefined) ?? {};
const saveAsks = (asks: Asks): void => {
  writeFileSync(asksPath(), JSON.stringify(asks, null, 2) + '\n');
};

/** 某个 run 的签收提问；键 `<run>:<里程碑>:<放行的 gate 轮次>`：recover/resume 后事件门重新等待（resumeAt 变）也不重投。 */
export const asksOf = (run: string): Asks =>
  Object.fromEntries(Object.entries(loadAsks()).filter(([k]) => k.startsWith(`${run}:`)));

const MAX_TTL_H = 72;
const supervisorPy = (): string =>
  process.env.SA_SUPERVISOR ??
  join(homedir(), '.ai-agent-shared', 'skills', 'agent-supervisor', 'scripts', 'supervisor.py');

function supervisor(args: string[]): string {
  const p = Bun.spawnSync(['python3', supervisorPy(), ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0)
    throw new Error(
      `supervisor ${args[0]} exit ${String(p.exitCode)}: ${tail(p.stderr.toString(), 200)}`
    );
  return p.stdout.toString().trim();
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

function human(l: Ledger, run: RunView, asks: Asks): Action {
  const w = run.metadata?.wait;
  if (!w?.event) throw new Error(`run ${l.run_id}: held:human without wait metadata`);
  const m = w.event.slice('sa.human.'.length);
  const round = gatesOf(artifactsOf(run)).filter(f => f.startsWith(`gate-${m}-r`)).length;
  const key = `${l.run_id}:${m}:${String(round)}`;
  const base: { run_id: string; event: string; reason?: string } = {
    run_id: l.run_id,
    event: w.event,
  };
  const expire = (): Action => {
    if (!cancelRun(l.archon_run_id, run.status, l.repo))
      return { ...base, action: 'cancel', ok: false, reason: 'deadline' };
    asks[key] = { ...asks[key], status: 'expired' };
    saveLedger({ ...loadLedger(l.run_id), state: 'failed', reason: 'deadline' });
    return { ...base, action: 'cancel', ok: true, reason: 'deadline' };
  };
  // 引擎的 wait.deadline_ms 从进入等待起计时，生成时无法折算成 plan 的绝对截止：由这里与 signoff 节点兜住
  if (pastDeadline(l)) return expire();
  // 问题以 key 开头：ask 结果未知时据此在 supervisor 的 ask 记录里找回 id
  const q = `superagent ${key} 红线签收：批准合入 ${basename(l.repo)}？`.slice(0, 120);
  let a = asks[key];
  if (a?.id === undefined && a !== undefined) {
    // supervisor 的 create() 先落盘再投递：非零退出或 tick 崩溃时提问可能已存在，重投会多出一条提醒
    const { records, anomalous } = askRecords();
    if (anomalous) base.reason = `${String(anomalous)} anomalous ask records`;
    const found = records.filter(r => r.question.startsWith(`superagent ${key} `));
    if (found.length > 1)
      return {
        ...base,
        action: 'none',
        ok: false,
        reason: `ask ${key}: ${String(found.length)} supervisor asks match; decide approve|reject${base.reason ? `; ${base.reason}` : ''}`,
      };
    a = asks[key] = found.length ? { id: found[0].id, status: 'pending' } : undefined;
  }
  if (!a) {
    const hours = Math.min(
      MAX_TTL_H,
      Math.max(1, Math.ceil((Date.parse(w.resumeAt) - Date.now()) / 3600e3))
    );
    asks[key] = { status: 'unknown' };
    saveAsks(asks);
    const id = supervisor(['ask', '--question', q, '--ttl-hours', String(hours)]);
    asks[key] = { id, status: 'pending' };
    saveAsks(asks);
    return { ...base, action: 'ask', ok: true, ask: id };
  }
  if (a.status === 'pending' && a.id) {
    const st = supervisor(['ask-status', a.id]);
    if (!ANSWERS.includes(st))
      throw new Error(`supervisor ask-status: unexpected ${st.slice(0, 40)}`);
    a.status = st;
  }
  // yes/no 的执行失败保留原状态，下一次 tick 重试
  if (a.status === 'yes') {
    // 等回答期间可能已过截止：过期的“是”不再批准
    if (pastDeadline(l)) return expire();
    const r = signalHuman(
      run,
      { decision: 'approve', ask: a.id },
      join(l.gen_dir, `signal-${w.nodeId}.log`),
      l.repo
    );
    if (r.ok) a.status = 'approved';
    return { ...base, action: 'approve', ...r };
  }
  if (a.status === 'no') {
    const ok = cancelRun(l.archon_run_id, run.status, l.repo);
    if (ok) a.status = 'rejected';
    return { ...base, action: 'reject', ok };
  }
  // expired：不替用户决定；事件门到期后 signoff 节点失败，run 停在 failed 等元帅
  return { ...base, action: 'none', ok: true, ask: a.status };
}

/** 单实例：launchd 与手动调用重叠时，后到者跳过（exit 0），不重复投递或恢复。 */
export function superviseTick(): Action[] | { skipped: 'locked' } {
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

function tick(sa: string): Action[] {
  archonDetached(['workflow', 'wake', '--json'], join(sa, 'wake.log'));
  const asks = loadAsks();
  const out: Action[] = [];
  for (const l of ledgers()) {
    try {
      const run = getRun(l.archon_run_id, l.repo);
      const c = classifyRun(l, run);
      if (c.state === 'held:human') out.push(human(l, run, asks));
      else if (c.state === 'owner_lost')
        out.push({ run_id: l.run_id, action: 'recover', ...recoverRun(l) });
      else if (c.state === 'held:recover_no_progress')
        out.push({ run_id: l.run_id, action: 'none', ok: true, state: c.state });
      else if (c.exit === EXIT.held || c.state === 'failed') {
        const x = autoRetry(l, run, c);
        if (x) out.push(x);
      }
    } catch (e) {
      out.push({
        run_id: l.run_id,
        action: 'error',
        ok: false,
        error: tail((e as Error).message, 200),
      });
    }
  }
  saveAsks(asks);
  return out;
}

/**
 * held:gate / held:environment / 编码节点失败的自动重试（docs/00「自动重试」）。只有次数用尽、有 needs、命中红线、
 * 截止已过，或连续两次修复无变化时保持 held。gate 重试先给里程碑每个包追加提示，再走 decide retry 同一恢复入口。
 */
function autoRetry(l: Ledger, run: RunView, c: Classified): Action | undefined {
  const node = c.node ?? '';
  if (!['held:gate', 'held:environment', 'failed'].includes(c.state)) return undefined;
  const plan = planOf(l);
  const art = artifactsOf(run);
  let kind: 'gate' | 'environment' | 'coder';
  let m: string;
  let reason: string;
  let gate: (Gate & { milestone?: string }) | undefined;
  if (c.state === 'held:gate') {
    gate = readJson(join(art, `${node}.json`)) as typeof gate;
    [kind, m, reason] = ['gate', gateMilestone(node), `gate:${gate?.reason ?? '?'}`];
  } else if (c.state === 'held:environment') {
    [kind, m, reason] = ['environment', 'environment', 'environment'];
  } else if (c.state === 'failed' && /^(code|fix)-/.test(node)) {
    const pkg = plan.packages.find(p => `code-${p.id}` === node);
    m = node.startsWith('fix-') ? node.replace(/^fix-(.+)-r\d+$/, '$1') : (pkg?.milestone ?? 'm1');
    [kind, reason] = ['coder', `coder:${node}`];
  } else return undefined;
  const tries = (l.auto_retries ?? []).filter(
    r => r.milestone === m && r.reason.split(':')[0] === kind
  );
  const needs = needsOf(art, m);
  const hold = (why: string): Action => ({
    run_id: l.run_id,
    action: 'none',
    ok: true,
    state: c.state,
    reason: why,
    auto_retries: tries.length,
    ...(needs.length ? { needs } : {}),
  });
  if (needs.length) return hold('needs');
  if (codersOf(art, m).some(x => x.error_class === 'redline')) return hold('redline');
  if (reason.includes('deadline') || pastDeadline(l)) return hold('deadline');
  if (tries.length >= loadTiers().policy.auto_retry[kind]) return hold('auto_retry_exhausted');
  if (reason.includes('no_change') && tries.at(-1)?.reason.includes('no_change'))
    return hold('no_change');
  const auto = { milestone: m, at: new Date().toISOString(), reason };
  let r: RecoverResult;
  if (kind === 'gate') {
    if (!attemptable(l, m)) return hold('no_attempt_node');
    const text = gateHint(plan, art, node, gate, tries.length + 1);
    for (const p of plan.packages.filter(x => (x.milestone ?? 'm1') === m))
      appendFileSync(join(l.gen_dir, 'hints', `${p.id}.md`), text);
    r = retryGate(l, node, false, auto);
  } else r = recoverRun(l, false, auto);
  return { run_id: l.run_id, action: 'auto_retry', state: c.state, ...auto, attempt: tries.length + 1, ...r };
}

/** 追加到 hints/<包>.md 的提示：失败的验收命令与日志尾、基线预存说明、未关闭的阻塞发现、gate 原因。 */
function gateHint(plan: Plan, art: string, node: string, g: Gate | undefined, n: number): string {
  const m = gateMilestone(node);
  const acc = readJson(join(art, `${node.replace(/^gate-/, 'diff-')}.json`)) as
    | { failed?: string[]; base_pass?: boolean | null; log?: string }
    | undefined;
  const out = [`\n## 自动重试 ${String(n)}：${node} escalate（${g?.reason ?? '?'}）\n`];
  if (acc?.failed?.length) {
    out.push('失败的验收命令：', ...acc.failed.map(x => `- \`${x}\``), '');
    if (acc.base_pass === false)
      out.push('此失败在基线已存在，不是你引入的，与本包无关就记 deviations 并继续。', '');
    const log = acc.log && existsSync(acc.log) ? readFileSync(acc.log, 'utf8').trimEnd() : '';
    if (log) out.push('验收日志尾：', '```', ...log.split('\n').slice(-60), '```', '');
  }
  const rounds = gatesOf(art)
    .filter(f => gateMilestone(f.slice(0, -5)) === m && f.slice(0, -5) <= node)
    .map(f => readJson(join(art, f.replace(/\.json$/, '.review.json'))) as Review | null)
    .filter((r): r is Review => r !== null && r !== undefined);
  const risk = milestones(plan).find(x => x.id === m)?.risk ?? 'G1';
  const open = openBlocking(rounds, risk);
  const last = new Map(rounds.flatMap(r => r.findings).map(f => [f.id, f]));
  const findings = [...open].flatMap(id => {
    const f = last.get(id);
    return f ? [`- ${id} [${f.severity}] ${f.file}:${String(f.line)} ${tail(f.evidence, 200)}`] : [];
  });
  if (findings.length) out.push('未关闭的阻塞发现：', ...findings, '');
  out.push(`gate reason：${g?.reason ?? '?'}`, '');
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
      const last = new Map<string, Gate & { round: string }>();
      for (const f of gatesOf(artifactsOf(run))) {
        const [, m, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
        last.set(m, { ...(readJson(join(artifactsOf(run), f)) as Gate), round });
        if (round === '1' && last.get(m)?.verdict === 'pass') bump(n, 'first_pass');
      }
      for (const g of last.values()) {
        bump(n, `rounds:${g.round}`);
        bump(n, 'debt', g.debt.length);
        if (g.verdict === 'escalate') bump(n, `escalate:${g.reason ?? '?'}`);
      }
    } catch (e) {
      unreadable.push(`${l.run_id}: ${tail((e as Error).message, 200)}`);
    }
  }
  return { runs: pairs.length, ...Object.fromEntries(Object.entries(n).sort()), unreadable };
}

/** 全部登记 run 的计数摘要与用量台账（F-22，见 report.ts）。 */
export function report(): Record<string, unknown> {
  return buildReport(ledgers());
}

const USAGE =
  'usage: superagent <run <plan.json> [--fake] [--skip-selftest]|wait <run> [--timeout s]|status|brief|land|resume|cancel|recover <run>|decide <run> approve|reject|retry [--pkg id --hint text]|decide --all-held retry|accept <run> [--pkg id]|report|supervise-tick|health [--cwd repo]|board [run] [--once] [--interval s] [--limit n]|job exec --title t [--card p] [--log p] -- cmd...|jobs [--all]> (every verb accepts --json)';

export function main(argv: string[]): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [verb, target] = a._;
  const ledger = (): Ledger => loadLedger(need(target, `${verb} <run>`));
  switch (verb) {
    case 'run':
      return startRun(need(target, 'run <plan.json>'), a);
    case 'wait': {
      const s = waitRun(ledger(), Number(a.flags.timeout ?? 3000));
      print(s);
      return Number(s.exit);
    }
    case 'status': {
      const l = ledger();
      const run = getRun(l.archon_run_id, l.repo);
      const c = classifyRun(l, run);
      print(summary(l, run, c));
      return c.exit;
    }
    case 'resume':
    case 'recover': {
      const id = need(target, `${verb} <run>`);
      if (!existsSync(ledgerPath(id))) {
        const res = recover(id); // 未登记：按 archon run id 处理（selftest 用）
        print({ run_id: id, ...res });
        return res.ok ? 0 : 1;
      }
      return resumeRun(loadLedger(id));
    }
    case 'cancel': {
      const id = need(target, `${verb} <run>`);
      // 未登记：按 archon run id 处理（selftest 用）
      const l = existsSync(ledgerPath(id)) ? loadLedger(id) : undefined;
      const rid = l?.archon_run_id ?? id;
      const ok = cancelRun(rid, getRun(rid, l?.repo).status, l?.repo);
      print({ run_id: id, ok });
      return ok ? 0 : 1;
    }
    case 'decide':
      if (a.flags['all-held']) {
        if (target !== 'retry') throw new Error('usage: superagent decide --all-held retry');
        return retryAllHeld();
      }
      return decide(ledger(), a);
    case 'brief':
      return brief(ledger());
    case 'land': {
      const l = ledger();
      const run = getRun(l.archon_run_id, l.repo);
      const land = readJson(join(artifactsOf(run), 'land.json'));
      if (land === undefined) {
        console.error(`land: no land.json yet (state ${classify(run).state})`);
        return 1;
      }
      print(land);
      return 0;
    }
    case 'accept':
      return acceptRun(ledger(), a.flags.pkg);
    case 'supervise-tick': {
      const actions = superviseTick();
      print(actions);
      if (!Array.isArray(actions)) return 0;
      return actions.some(x => !x.ok) ? 1 : 0;
    }
    case 'report': {
      const r = report();
      print(r);
      const usage = r.usage as { unreadable: string[] };
      return (r.unreadable as string[]).length || usage.unreadable.length ? 1 : 0;
    }
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
    if (verb === 'job' || verb === 'jobs')
      process.exit(await (await import('./jobs')).jobCli(argv));
    process.exit(main(argv));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}
