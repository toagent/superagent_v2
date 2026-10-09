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
  ownerLost,
  recover,
  signalHuman,
  tail,
  type RecoverResult,
  type RunView,
} from './archon';
import type { decide as decideGate } from '../templates/.archon/scripts/sa-check';
import { WETAMP, home, loadTiers, renderAliases, assertAuthorNotReviewer } from './config';
import { generate, newRunId } from './generate';
import { loadPlan, type Plan } from './plan';

const OPTIONS = {
  timeout: { type: 'string' },
  pkg: { type: 'string' },
  hint: { type: 'string' },
  fake: { type: 'boolean' },
  'skip-selftest': { type: 'boolean' },
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

/** recover 成功即记入 ledger（brief/report 的恢复次数、waitRun 的停滞判断都读它）。 */
function recoverRun(l: Ledger): RecoverResult {
  const r = recover(l.archon_run_id, l.repo);
  if (r.ok) {
    l.recoveries.push(new Date().toISOString());
    saveLedger(l);
  }
  return r;
}

/** 分片等待：事件门不会唤醒 archon wait，所以每片 ≤30s 后重新 get；可证实 owner-lost 时自动 recover。 */
export function waitRun(l: Ledger, timeoutS: number): Record<string, unknown> {
  const deadline = Date.now() + timeoutS * 1000;
  let stalled = 0;
  let lastDone = -1;
  for (;;) {
    const run = getRun(l.archon_run_id, l.repo);
    const c = classify(run);
    if (c.state === 'owner_lost') {
      const done = (run.nodes ?? []).filter(n => n.state === 'completed').length;
      stalled = done === lastDone ? stalled + 1 : 1;
      lastDone = done;
      if (stalled > MAX_STALLED_RECOVERIES)
        return { ...summary(l, run, { ...c, exit: EXIT.failed }), reason: 'recover_no_progress' };
      const r = recoverRun(l);
      if (!r.ok) return { ...summary(l, run, { ...c, exit: EXIT.failed }), reason: r.reason };
      continue;
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
  const run = newRunId();
  const gen = generate(plan, run, a.flags.fake ?? false);
  const branch = `sa/${run}`;
  const args = ['workflow', 'run', gen.workflow, '--workflow-source', gen.dir, '--cwd', plan.repo];
  args.push('--branch', branch, '--from', plan.base_ref, '--detach');
  // 评审别名按控制台重绑：Codex 控制台用 Claude 军师池（config.renderAliases）
  if (plan.console === 'codex') args.push('--model', '@sa-reviewer=@sa-reviewer-codex');
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

function health(): number {
  const aliases = renderAliases(loadTiers());
  assertAuthorNotReviewer(aliases);
  const doctor = archon(['doctor']);
  const clean = Bun.spawnSync([join(WETAMP, 'scripts', 'check-upstream-clean.sh')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const upstreamDiff = clean.stdout.toString().trim();
  const ok = doctor.code === 0 && clean.exitCode === 0 && upstreamDiff === '';
  print({
    ok,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
  });
  return ok ? 0 : 1;
}

function resumeRun(l: Ledger): number {
  const res = recoverRun(l);
  print({ run_id: l.run_id, ...res });
  return res.ok ? 0 : 1;
}

function cancelRun(l: Ledger): boolean {
  return archonJson(['workflow', 'cancel', l.archon_run_id], l.repo).ok !== false;
}

const planOf = (l: Ledger): Plan =>
  JSON.parse(readFileSync(join(l.gen_dir, 'plan.json'), 'utf8')) as Plan;

/** approve：放行 sa.human.* 签收门；reject：取消 run；retry：可选写 hint 后 resume 失败节点。 */
function decide(l: Ledger, a: Args): number {
  const action = need(a._[2], 'decide <run> approve|reject|retry [--pkg id --hint text]');
  const run = getRun(l.archon_run_id, l.repo);
  const c = classify(run);
  if (action === 'approve') {
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
  return resumeRun(l);
}

/** ≤20 行纯文本：状态、各轮 gate 结论与评审债、签收提问状态、合入命令、证据路径。 */
function brief(l: Ledger): number {
  const run = getRun(l.archon_run_id, l.repo);
  const c = classify(run);
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
  id: string;
  status: string; // ANSWERS 之一，或执行后的 approved | rejected
}
type Action = Record<string, unknown> & { run_id: string; action: string; ok: boolean };

const asksPath = (): string => join(home().sa, 'asks.json');
type Asks = Partial<Record<string, Ask>>;
const loadAsks = (): Asks => (readJson(asksPath()) as Asks | undefined) ?? {};

/** 某个 run 的签收提问；键 `<run>:<event>:<resumeAt>` 唯一标识一次事件门暂停。 */
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

function human(l: Ledger, run: RunView, asks: Asks): Action {
  const w = run.metadata?.wait;
  if (!w?.event) throw new Error(`run ${l.run_id}: held:human without wait metadata`);
  const key = `${l.run_id}:${w.event}:${w.resumeAt}`;
  const base = { run_id: l.run_id, event: w.event };
  const a = asks[key];
  if (!a) {
    const hours = Math.min(
      MAX_TTL_H,
      Math.max(1, Math.ceil((Date.parse(w.resumeAt) - Date.now()) / 3600e3))
    );
    const q = `superagent ${l.run_id} ${w.event.slice('sa.human.'.length)} 红线签收：批准合入 ${basename(l.repo)}？`;
    const id = supervisor(['ask', '--question', q.slice(0, 120), '--ttl-hours', String(hours)]);
    asks[key] = { id, status: 'pending' };
    return { ...base, action: 'ask', ok: true, ask: id };
  }
  if (a.status === 'pending') {
    const st = supervisor(['ask-status', a.id]);
    if (!ANSWERS.includes(st))
      throw new Error(`supervisor ask-status: unexpected ${st.slice(0, 40)}`);
    a.status = st;
  }
  // yes/no 的执行失败保留原状态，下一次 tick 重试
  if (a.status === 'yes') {
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

export function superviseTick(): Action[] {
  const { sa } = home();
  archonDetached(['workflow', 'wake', '--json'], join(sa, 'wake.log'));
  const asks = loadAsks();
  const out: Action[] = [];
  for (const l of ledgers()) {
    try {
      const run = getRun(l.archon_run_id, l.repo);
      const c = classify(run);
      if (c.state === 'held:human') out.push(human(l, run, asks));
      else if (c.state === 'owner_lost')
        out.push({ run_id: l.run_id, action: 'recover', ...recoverRun(l) });
    } catch (e) {
      out.push({
        run_id: l.run_id,
        action: 'error',
        ok: false,
        error: tail((e as Error).message, 200),
      });
    }
  }
  writeFileSync(asksPath(), JSON.stringify(asks, null, 2) + '\n');
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
      const c = classify(run);
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
  'usage: superagent <run <plan.json> [--fake] [--skip-selftest]|wait <run> [--timeout s]|status|brief|land|resume|cancel|recover <run>|decide <run> approve|reject|retry [--pkg id --hint text]|accept <run> [--pkg id]|report|supervise-tick|health>';

export function main(argv: string[]): number {
  const a = parseArgs(argv);
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
      const c = classify(run);
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
      return actions.some(x => !x.ok) ? 1 : 0;
    }
    case 'report': {
      const r = report();
      print(r);
      return (r.unreadable as string[]).length ? 1 : 0;
    }
    case 'health':
      return health();
    default:
      console.error(USAGE);
      return 64;
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
