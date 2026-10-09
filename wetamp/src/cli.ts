// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import {
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
import type { decide as decideGate } from '../templates/.archon/scripts/sa-check';
import { WETAMP, aliasDrift, home, runAliases } from './config';
import { generate, newRunId } from './generate';
import { loadPlan, type Plan } from './plan';

const OPTIONS = {
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  'skip-selftest': { type: 'boolean' },
  cwd: { type: 'string' },
  json: { type: 'boolean' }, // 输出本来就是 JSON；接受以兼容 superagent v1 调用方
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
}

const ledgerPath = (run: string): string => join(home().sa, 'runs', `${run}.json`);
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

const artifactsOf = (run: RunView): string =>
  join(run.output_root ?? '', 'artifacts', 'runs', run.id);
const readJson = (p: string): unknown =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
type Gate = ReturnType<typeof decideGate>;
/** 各轮 gate 结论文件，按里程碑、轮次排序（轮次 ≤ 3，字典序即轮次序）。 */
const gatesOf = (art: string): string[] =>
  existsSync(art)
    ? readdirSync(art)
        .filter(f => /^gate-.+-r\d+\.json$/.test(f))
        .sort()
    : [];
const ledgers = (): Ledger[] => {
  const dir = join(home().sa, 'runs');
  const ids = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  return ids.map(f => loadLedger(f.slice(0, -5)));
};

/** ≤20 行的摘要：元帅只读这个和证据路径。 */
function summary(l: Ledger, run: RunView, c: Classified): Record<string, unknown> {
  const nodes = run.nodes ?? [];
  const art = artifactsOf(run);
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
function classifyRun(l: Ledger, run: RunView): Classified {
  const c = classify(run);
  return c.state === 'owner_lost' && stalledOut(l, run)
    ? { state: 'held:recover_no_progress', exit: EXIT.held }
    : c;
}

/**
 * 所有恢复（wait、resume、decide retry、supervise-tick）的唯一入口。锁内重读 ledger 与 run：完成节点集合
 * 与上次相同且已连续 recover 3 次即拒绝（recover_no_progress）；fresh=true（decide retry）是元帅的显式决定，清零重计。
 * 计数、指纹、恢复时间同样在锁内写回 ledger：释放锁后才落盘会让交错的第二次 recover 读到旧计数。
 */
function recoverRun(l: Ledger, fresh = false): RecoverResult {
  let fp = '';
  return recover(
    l.archon_run_id,
    l.repo,
    run => {
      Object.assign(l, loadLedger(l.run_id));
      if (fresh) l.stalled = 0;
      fp = progressOf(run);
      return stalledOut(l, run) ? 'recover_no_progress' : undefined;
    },
    () => {
      l.stalled = (l.progress_fp === fp ? (l.stalled ?? 0) : 0) + 1;
      l.progress_fp = fp;
      l.recoveries.push(new Date().toISOString());
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
  const ok = doctor.code === 0 && clean.exitCode === 0 && upstreamDiff === '' && !drift.length;
  print({
    ok,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    alias_drift: drift,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
  });
  return ok ? 0 : drift.length ? EXIT_ALIAS_DRIFT : 1;
}

function resumeRun(l: Ledger, fresh = false): number {
  const res = recoverRun(l, fresh);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
}

function cancelRun(l: Ledger): boolean {
  return archonJson(['workflow', 'cancel', l.archon_run_id], l.repo).ok !== false;
}

const planOf = (l: Ledger): Plan =>
  JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;

/** 过了 plan 的绝对 deadline，签收节点与 land 都会拒绝；approve 在此提前拒绝，不发无效 signal。 */
const pastDeadline = (l: Ledger): boolean => Date.now() > Date.parse(planOf(l).deadline);
const PAST_DEADLINE =
  'plan deadline passed: decide reject, or start a new run with a later deadline';

/** approve：放行 sa.human.* 签收门；reject：取消 run；retry：可选写 hint 后 resume 失败节点。 */
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
    const ok = cancelRun(l);
    print({ run_id: l.run_id, decision: 'reject', ok });
    return ok ? 0 : 1;
  }
  if (action !== 'retry') throw new Error(`decide: unknown action ${action}`);
  // resume 只重跑失败的 gate 节点，输入不变、结论不变：escalate 需要人改分支或开新 run
  if (c.state === 'held:gate')
    throw new Error(
      `decide retry: ${c.node ?? 'gate'} escalated; fix on ${l.branch} or start a new run`
    );
  const { hint, pkg } = a.flags;
  if (hint !== undefined) {
    if (pkg === undefined || !planOf(l).packages.some(p => p.id === pkg))
      throw new Error('decide retry --hint needs --pkg <package id from the plan>');
    writeFileSync(join(l.gen_dir, 'hints', `${pkg}.md`), hint + '\n');
  }
  return resumeRun(l, true);
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
  if (typeof s.error === 'string') lines.push(`error: ${s.error}`);
  if (Array.isArray(s.land)) lines.push(...(s.land as string[]));
  lines.push(`evidence: ${art}`, `recoveries: ${String(l.recoveries.length)}`);
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
// 把红线签收投到 agent-supervisor（iPhone 提醒事项：勾选=是、删除=否），按回答 signal 或 cancel。
const ANSWERS = ['pending', 'yes', 'no', 'expired'];
interface Ask {
  id?: string; // 先落 unknown 再调 ask；ask 中途崩溃或非零退出都保留 unknown，下一 tick 对账
  status: string; // ANSWERS 之一、unknown，或执行后的 approved | rejected
}
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };

const asksPath = (): string => join(home().sa, 'asks.json');
type Asks = Partial<Record<string, Ask>>;
const loadAsks = (): Asks => (readJson(asksPath()) as Asks | undefined) ?? {};
const saveAsks = (asks: Asks): void => {
  writeFileSync(asksPath(), JSON.stringify(asks, null, 2) + '\n');
};

/** 某个 run 的签收提问；键 `<run>:<里程碑>:<放行的 gate 轮次>`：recover/resume 后事件门重新等待（resumeAt 变）也不重投。 */
const asksOf = (run: string): Asks =>
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

/** supervisor 的 ask 记录（SKILL 约定位置 `$AGENT_SUPERVISOR_STATE/asks/<id>.json`），只取 id 与问题文本。 */
function askRecords(): { id: string; question: string }[] {
  const dir = join(
    process.env.AGENT_SUPERVISOR_STATE ?? join(homedir(), '.local', 'state', 'agent-supervisor'),
    'asks'
  );
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(dir, f)) as { id?: unknown; question?: unknown })
    .filter(
      (r): r is { id: string; question: string } =>
        typeof r.id === 'string' && typeof r.question === 'string'
    );
}

function human(l: Ledger, run: RunView, asks: Asks): Action {
  const w = run.metadata?.wait;
  if (!w?.event) throw new Error(`run ${l.run_id}: held:human without wait metadata`);
  const m = w.event.slice('sa.human.'.length);
  const round = gatesOf(artifactsOf(run)).filter(f => f.startsWith(`gate-${m}-r`)).length;
  const key = `${l.run_id}:${m}:${String(round)}`;
  const base = { run_id: l.run_id, event: w.event };
  // 问题以 key 开头：ask 结果未知时据此在 supervisor 的 ask 记录里找回 id
  const q = `superagent ${key} 红线签收：批准合入 ${basename(l.repo)}？`.slice(0, 120);
  let a = asks[key];
  if (a?.id === undefined && a !== undefined) {
    // supervisor 的 create() 先落盘再投递：非零退出或 tick 崩溃时提问可能已存在，重投会多出一条提醒
    const found = askRecords().filter(r => r.question.startsWith(`superagent ${key} `));
    if (found.length > 1)
      return {
        ...base,
        action: 'none',
        ok: false,
        reason: `ask ${key}: ${String(found.length)} supervisor asks match; decide approve|reject`,
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
    if (pastDeadline(l)) return { ...base, action: 'none', ok: true, reason: PAST_DEADLINE };
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
    const ok = cancelRun(l);
    if (ok) a.status = 'rejected';
    return { ...base, action: 'reject', ok };
  }
  // expired：不替用户决定；事件门到期后 signoff 节点失败，run 停在 failed 等元帅
  return { ...base, action: 'none', ok: true, ask: a.status };
}

/** 单实例：launchd 与手动调用重叠时，后到者跳过（exit 0），不重复投递或恢复；锁文件不可读则跳过并报告（exit 1）。 */
export function superviseTick():
  | Action[]
  | { skipped: 'locked' }
  | { skipped: 'lock_unreadable'; path: string } {
  const { sa } = home();
  mkdirSync(sa, { recursive: true });
  const path = join(sa, 'supervise.lock');
  const l = lock(path);
  if (!l.ok) return l.reason === 'locked' ? { skipped: 'locked' } : { skipped: l.reason, path };
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

type Count = Partial<Record<string, number>>;
const bump = (o: Count, k: string, n = 1): void => {
  o[k] = (o[k] ?? 0) + n;
};

/** 全部登记 run 的计数（token 用量后置）：state:*、各里程碑末轮 rounds:*、first_pass（首轮即 pass 的里程碑）、
 *  failed:<节点 id 前缀>、escalate:<原因>、node_s:<前缀>（累计秒）、debt（末轮评审债条数）、recoveries。读不到的 run 单列，不吞错。 */
export function report(): Record<string, unknown> {
  const n: Count = {};
  const unreadable: string[] = [];
  const all = ledgers();
  for (const l of all) {
    bump(n, 'recoveries', l.recoveries.length);
    try {
      const run = getRun(l.archon_run_id, l.repo);
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
  return { runs: all.length, ...Object.fromEntries(Object.entries(n).sort()), unreadable };
}

const USAGE =
  'usage: superagent <run <plan.json> [--fake] [--skip-selftest]|wait <run> [--timeout s]|status|brief|land|resume|cancel|recover <run>|decide <run> approve|reject|retry [--pkg id --hint text]|accept <run> [--pkg id]|report|supervise-tick|health [--cwd repo]> (every verb accepts --json)';

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
      const l = ledger();
      const ok = cancelRun(l);
      print({ run_id: l.run_id, ok });
      return ok ? 0 : 1;
    }
    case 'decide':
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
      if (!Array.isArray(actions)) return actions.skipped === 'locked' ? 0 : 1;
      return actions.some(x => !x.ok) ? 1 : 0;
    }
    case 'report': {
      const r = report();
      print(r);
      return (r.unreadable as string[]).length ? 1 : 0;
    }
    case 'health':
      return health(a.flags.cwd);
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
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}
