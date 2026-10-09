// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 EXIT。
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archon, archonJson, getRun, ownerLost, recover, tail, type RunView } from './archon';
import { WETAMP, home, loadTiers, renderAliases, assertAuthorNotReviewer } from './config';
import { generate, newRunId } from './generate';
import { loadPlan } from './plan';

interface Args {
  _: string[];
  flags: Partial<Record<string, string | true>>;
}
export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) {
      a._.push(s);
      continue;
    }
    const eq = s.indexOf('=');
    const next = argv.at(i + 1);
    if (eq > 0) a.flags[s.slice(2, eq)] = s.slice(eq + 1);
    else if (next !== undefined && !next.startsWith('--')) {
      a.flags[s.slice(2)] = next;
      i++;
    } else a.flags[s.slice(2)] = true;
  }
  return a;
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
      const r = recover(l.archon_run_id, l.repo);
      if (!r.ok) return { ...summary(l, run, { ...c, exit: EXIT.failed }), reason: r.reason };
      l.recoveries.push(new Date().toISOString());
      saveLedger(l);
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
  preflight(a.flags['skip-selftest'] === true);
  const plan = loadPlan(planPath);
  const run = newRunId();
  const gen = generate(plan, run, a.flags.fake === true);
  const branch = `sa/${run}`;
  const ack = archonJson(
    [
      'workflow',
      'run',
      gen.workflow,
      '--workflow-source',
      gen.dir,
      '--cwd',
      plan.repo,
      '--branch',
      branch,
      '--from',
      plan.base_ref,
      '--detach',
    ],
    plan.repo
  );
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
  print({
    run_id: run,
    archon_run_id: l.archon_run_id,
    branch,
    gen_dir: gen.dir,
    transcript: l.transcript,
  });
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

const USAGE =
  'usage: superagent <run <plan.json> [--fake] [--skip-selftest]|wait <run> [--timeout s]|status|get|resume|cancel|recover <run>|health>';

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
    case 'get': {
      const l = ledger();
      print({ ledger: l, archon: getRun(l.archon_run_id, l.repo) });
      return 0;
    }
    case 'resume':
    case 'recover': {
      const id = need(target, `${verb} <run>`);
      if (!existsSync(ledgerPath(id))) {
        const res = recover(id); // 未登记：按 archon run id 处理（selftest 用）
        print({ run_id: id, ...res });
        return res.ok ? 0 : 1;
      }
      const l = loadLedger(id);
      const res = recover(l.archon_run_id, l.repo);
      if (res.ok) {
        l.recoveries.push(new Date().toISOString());
        saveLedger(l);
      }
      print({ run_id: l.run_id, ...res });
      return res.ok ? 0 : 1;
    }
    case 'cancel': {
      const l = ledger();
      const r = archonJson(['workflow', 'cancel', l.archon_run_id], l.repo);
      print({ run_id: l.run_id, ok: r.ok !== false });
      return r.ok === false ? 1 : 0;
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
