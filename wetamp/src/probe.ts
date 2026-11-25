import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import { lastJson } from './archon';
import { WETAMP, type Console } from './config';
import { redact } from './redact';

export type ProbeLevel = 'G1' | 'G2';
export const PROBE_SCENARIOS = ['simple', 'repair', 'review', 'scope', 'outage'] as const;
export type ProbeScenario = (typeof PROBE_SCENARIOS)[number] | 'default';

type Attempts = ReturnType<typeof readPolicyAttempts>;
interface ScenarioEvidence extends ProbeEvidence {
  console: Console;
  scenario: ProbeScenario;
  attempts: Pick<Attempts[number], 'node' | 'provider' | 'model' | 'status' | 'reassignment'>[];
  rounds: number;
  state: string | null;
  delivery_state: string | null;
}

export interface ProbeJudgement {
  timed_out?: boolean;
  launch_exit: number;
  launch_run_id?: string;
  wait_exit?: number;
  wait_run_id?: string;
  state?: string;
  delivery_state?: string;
  ledger_run_id?: string;
  engine_commit?: string;
  engine_snapshot?: string;
  diagnostic?: string;
  expected_commit: string;
  expected_snapshot: string;
}

export interface ProbeEvidence {
  ok: boolean;
  level: ProbeLevel;
  run_id?: string;
  duration_ms: number;
  reason?: string;
  error?: string;
  evidence_path: string;
}

export function judgeProbe(
  value: ProbeJudgement,
  expectScope = false
): { ok: boolean; reason?: string } {
  if (value.timed_out) return { ok: false, reason: 'timeout' };
  if (value.launch_exit !== 0) return { ok: false, reason: 'launch_failed' };
  if (!value.launch_run_id) return { ok: false, reason: 'launch_run_id_missing' };
  if (value.wait_exit !== (expectScope ? 3 : 0)) return { ok: false, reason: 'wait_failed' };
  if (value.wait_run_id !== value.launch_run_id)
    return { ok: false, reason: 'wait_run_id_mismatch' };
  if (expectScope && (value.state !== 'held:scope' || value.delivery_state !== 'not_reached'))
    return { ok: false, reason: 'scope_not_held' };
  if (!expectScope && (value.state !== 'completed' || value.delivery_state !== 'published'))
    return { ok: false, reason: 'not_published' };
  if (value.ledger_run_id !== value.launch_run_id)
    return { ok: false, reason: 'ledger_run_id_mismatch' };
  if (value.engine_commit !== value.expected_commit)
    return { ok: false, reason: 'engine_commit_mismatch' };
  if (value.engine_snapshot !== value.expected_snapshot)
    return { ok: false, reason: 'engine_snapshot_mismatch' };
  return { ok: true };
}

const git = (repo: string, args: string[]): void => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`);
};

type CommandResult = Pick<ReturnType<typeof Bun.spawnSync>, 'exitCode'> & {
  stdout: Uint8Array | string;
  stderr: Uint8Array | string;
};
interface Command {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}
const spawnOptions = {
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  killSignal: 'SIGKILL',
} as const;

const outputTail = (result: CommandResult): string => {
  const tail = (value: string): string => redact(value).trim().slice(-500);
  return `stdout:\n${tail(result.stdout.toString())}\nstderr:\n${tail(result.stderr.toString())}`;
};

export function scenarioFor(
  level: ProbeLevel,
  scenario: ProbeScenario,
  stamp = ''
): { goal: string; accept: string; scope?: string } {
  const simple = {
    goal: '在 README.md 末尾追加一行 probe-g1',
    accept: 'grep -q probe-g1 README.md',
  };
  switch (scenario) {
    case 'repair': {
      const file = "'" + stamp.replaceAll("'", "'\\''") + "'";
      // The engine retries a failing command on the same HEAD before dispatching repair.
      const accept = [
        'if [ "${SA_ACCEPTANCE:-}" != 1 ]; then grep -qx probe-first README.md; exit $?; fi',
        '[ "$(git rev-list --count HEAD)" != 1 ] || exit 0',
        'head=$(git rev-parse HEAD) || exit 1',
        `[ -f ${file} ] || printf '%s\\n' "$head" > ${file} || exit 1`,
        `if [ "$head" = "$(cat ${file})" ] || ! grep -qx probe-repaired README.md; then`,
        '  echo "追加独立一行 probe-repaired，保留 probe-first 并提交修复" >&2; exit 1; fi',
        'grep -qx probe-first README.md',
      ].join('\n');
      return { goal: '只在 README.md 末尾追加一行 probe-first 并提交', accept, scope: 'README.md' };
    }
    case 'review':
    case 'scope':
      return {
        goal:
          '新建 src/auth/probe.ts，内容为 export const probe = true; 并提交。' +
          (scenario === 'scope'
            ? '验收通过后按任务书提交唯一 scope_decision，请求此必需文件的写范围裁决。'
            : ''),
        accept: "grep -Fxq 'export const probe = true;' src/auth/probe.ts",
        scope: scenario === 'scope' ? 'README.md' : 'src/auth/probe.ts',
      };
    case 'default':
      if (level === 'G2')
        return {
          goal: '新增 src/add.ts 导出 add(a: number, b: number): number，并新增 src/add.test.ts 用 bun:test 断言 add(1,2)===3',
          accept: 'bun test',
        };
  }
  return simple;
}

function scenarioFailure(
  scenario: ProbeScenario,
  console: Console,
  coding: Attempts,
  attempts: Attempts,
  gatewayRequests: number,
  repairRejected: boolean
): string | undefined {
  const agy = (a: Attempts[number]) => a.provider === 'agy' || a.provider === 'gemini';
  const completed = coding.filter(a => a.status === 'completed');
  if (!completed.some(a => a.node === 'code-quick')) return 'coding_evidence_missing';
  if (scenario === 'outage') {
    const failed = coding.findIndex(a => agy(a) && a.status === 'failed');
    if (
      !gatewayRequests ||
      failed < 0 ||
      !coding
        .slice(failed + 1)
        .some(
          a =>
            a.node === 'code-quick' &&
            a.provider === 'codex' &&
            a.status === 'completed' &&
            a.reassignment?.from === 'agy' &&
            a.reassignment.reason === 'vendor_failure'
        )
    )
      return 'outage_failover_missing';
  } else if (console === 'gemini' && completed.some(a => !agy(a))) {
    return 'neon_coding_missing';
  }
  if (scenario === 'repair' && (!repairRejected || !completed.some(a => a.node === 'repair-quick')))
    return 'repair_evidence_missing';
  const family = (a: Attempts[number]) => (agy(a) ? 'gemini' : a.provider);
  if (
    scenario === 'review' &&
    !attempts.some(
      a =>
        a.node.startsWith('review-') &&
        a.status === 'completed' &&
        completed.every(coder => family(coder) !== family(a))
    )
  )
    return 'cross_vendor_review_missing';
  return undefined;
}

// One command sequence serves the synchronous promotion caller and the asynchronous suite.
function* probe(
  level: ProbeLevel,
  shimOverride?: string,
  suite?: { console: Console; scenario: ProbeScenario; gateway?: URL; requests?: () => number }
): Generator<Command, ProbeEvidence | ScenarioEvidence, CommandResult> {
  const started = Date.now(),
    limit = level === 'G1' ? 15 * 60_000 : 30 * 60_000,
    sa = process.env.SUPERAGENT_HOME,
    archon = process.env.ARCHON_HOME;
  if (!sa || !archon) throw new Error('probe: SUPERAGENT_HOME/ARCHON_HOME unset');
  mkdirSync(sa, { recursive: true });
  mkdirSync(archon, { recursive: true });
  const canonicalSa = realpathSync(sa),
    canonicalArchon = realpathSync(archon);
  if (!canonicalArchon.startsWith(canonicalSa + sep))
    throw new Error('probe: ARCHON_HOME must be beneath SUPERAGENT_HOME');

  const probes = join(canonicalSa, 'probes');
  mkdirSync(probes, { recursive: true });
  if (realpathSync(probes) !== probes) throw new Error('probe: probes directory is a symlink');
  const root = mkdtempSync(join(probes, `${level.toLowerCase()}-`)),
    repo = join(root, `probe-${basename(root)}`),
    evidencePath = join(root, 'evidence.json'),
    snapshot = realpathSync(resolve(WETAMP, '..')),
    shim = shimOverride ?? join(snapshot, 'wetamp', 'bin', 'superagent-shim'),
    expectedCommit = Bun.spawnSync(['git', '-C', snapshot, 'rev-parse', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
      .stdout.toString()
      .trim();
  mkdirSync(join(repo, '.archon'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# probe\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"probe","type":"module"}\n');
  writeFileSync(join(repo, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: probe\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-qm', 'init']);
  git(repo, ['switch', '-q', '-c', 'probe']);

  const env = {
    ...process.env,
    SUPERAGENT_HOME: canonicalSa,
    ARCHON_HOME: canonicalArchon,
    SUPERAGENT_WRITE_ROOTS: root,
    ...(suite ? { DATABASE_URL: '' } : {}),
    ...(suite?.gateway ? { AGY_LLM_GATEWAY_URL: suite.gateway.href } : {}),
  };
  const judgement: ProbeJudgement = {
    launch_exit: -1,
    expected_commit: expectedCommit,
    expected_snapshot: snapshot,
  };
  let latest: CommandResult | undefined;
  let attempts: Attempts = [],
    repairRejected = false;
  const run = function* (args: string[]): Generator<Command, CommandResult, CommandResult> {
    const remaining = limit - (Date.now() - started);
    if (remaining <= 0) {
      judgement.timed_out = true;
      throw new Error('timeout');
    }
    latest = yield { args: [shim, ...args], cwd: repo, env, timeout: remaining };
    return latest;
  };
  try {
    const scenario = suite?.scenario ?? 'default';
    const { goal, accept, scope } = scenarioFor(level, scenario, join(root, 'first-head'));
    const risk = scenario === 'default' ? level : 'G1';
    const launched = yield* run([
        'quick',
        '--goal',
        goal,
        '--accept',
        accept,
        '--risk',
        risk,
        ...(risk === 'G2' ? ['--review-reason', 'engine probe G2'] : []),
        ...(suite ? ['--console', suite.console] : []),
        ...(scope ? ['--scope', scope] : []),
        '--json',
      ]),
      launch = lastJson(launched.stdout.toString()),
      runId =
        typeof launch?.run_id === 'string' && (!suite || /^[\w-]+$/.test(launch.run_id))
          ? launch.run_id
          : undefined;
    judgement.launch_exit = launched.exitCode;
    judgement.launch_run_id = runId;
    if (launched.exitCode === 0 && runId) {
      let artifactPath: unknown;
      for (;;) {
        const remaining = limit - (Date.now() - started),
          waited = yield* run([
            'wait',
            runId,
            '--json',
            '--timeout',
            String(Math.max(1, Math.floor(remaining / 1000))),
          ]),
          value = lastJson(waited.stdout.toString());
        judgement.wait_exit = waited.exitCode;
        judgement.wait_run_id = typeof value?.run_id === 'string' ? value.run_id : undefined;
        judgement.state = typeof value?.state === 'string' ? value.state : undefined;
        judgement.delivery_state =
          typeof value?.delivery_state === 'string' ? value.delivery_state : undefined;
        artifactPath = value?.evidence;
        if (!['running', 'inbox'].includes(judgement.state ?? '') || Date.now() - started >= limit)
          break;
      }
      const ledger = JSON.parse(
        readFileSync(join(canonicalSa, 'runs', `${runId}.json`), 'utf8')
      ) as Record<string, unknown>;
      judgement.ledger_run_id = typeof ledger.run_id === 'string' ? ledger.run_id : undefined;
      judgement.engine_commit =
        typeof ledger.engine_commit === 'string' ? ledger.engine_commit : undefined;
      judgement.engine_snapshot =
        typeof ledger.engine_snapshot === 'string'
          ? realpathSync(ledger.engine_snapshot)
          : undefined;
      if (
        suite &&
        judgement.wait_run_id === runId &&
        ledger.console === suite.console &&
        typeof artifactPath === 'string' &&
        basename(artifactPath) === ledger.archon_run_id
      ) {
        const dir = realpathSync(artifactPath);
        if (!dir.startsWith(canonicalArchon + sep))
          throw new Error('probe: artifacts outside ARCHON_HOME');
        for (const path of ['policy-attempts.json', 'verify-quick.json'].map(file =>
          join(dir, file)
        ))
          if (existsSync(path) && realpathSync(path) !== path)
            throw new Error('probe: symlinked artifact');
        attempts = readPolicyAttempts(dir);
        if (scenario === 'repair') {
          const verified = JSON.parse(readFileSync(join(dir, 'verify-quick.json'), 'utf8')) as {
            disposition?: unknown;
            reason?: unknown;
          };
          repairRejected =
            verified.disposition === 'repair' && verified.reason === 'acceptance_failed';
        }
      }
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const timedOut = Date.now() - started >= limit || diagnostic === 'timeout';
    if (!suite && !timedOut) throw error;
    judgement.diagnostic = redact(diagnostic);
    judgement.timed_out = timedOut;
  }
  const coding = attempts.filter(a => /^(code|repair|fix|resolve)-/.test(a.node));
  const base = judgeProbe(judgement, suite?.scenario === 'scope');
  const reason =
    suite && base.ok
      ? judgement.diagnostic
        ? 'evidence_unreadable'
        : scenarioFailure(
            suite.scenario,
            suite.console,
            coding,
            attempts,
            suite.requests?.() ?? 0,
            repairRejected
          )
      : base.reason;
  const decision = { ok: base.ok && !reason && !judgement.diagnostic, reason };
  if (!decision.ok && latest)
    judgement.diagnostic = [judgement.diagnostic, outputTail(latest)].filter(Boolean).join('\n');
  const evidence: ProbeEvidence | ScenarioEvidence = {
    ok: decision.ok,
    level,
    ...(judgement.launch_run_id ? { run_id: judgement.launch_run_id } : {}),
    duration_ms: Date.now() - started,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(judgement.diagnostic ? { error: judgement.diagnostic } : {}),
    evidence_path: evidencePath,
    ...(suite
      ? {
          console: suite.console,
          scenario: suite.scenario,
          attempts: coding.map(({ node, provider, model, resolved, status, reassignment }) => ({
            node,
            provider,
            model: resolved ?? model,
            status,
            ...(reassignment ? { reassignment } : {}),
          })),
          rounds: new Set(coding.map(a => a.node)).size,
          state: judgement.state ?? null,
          delivery_state: judgement.delivery_state ?? null,
        }
      : {}),
  };
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, judgement }, null, 2) + '\n');
  chmodSync(evidencePath, 0o444);
  return evidence;
}

export function runProbe(level: ProbeLevel, shimOverride?: string): ProbeEvidence {
  const sequence = probe(level, shimOverride);
  let step = sequence.next();
  while (!step.done) {
    const { args, ...options } = step.value;
    step = sequence.next(Bun.spawnSync(args, { ...options, ...spawnOptions }));
  }
  return step.value;
}

export async function runScenarioProbe(
  level: ProbeLevel,
  console: Console,
  scenario: ProbeScenario,
  shimOverride?: string
): Promise<ScenarioEvidence> {
  if (scenario === 'outage' && console !== 'gemini')
    throw new Error('probe: outage requires gemini');
  let requests = 0;
  const gateway =
    scenario === 'outage'
      ? Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch() {
            requests++;
            return Response.json(
              {
                error: {
                  code: 503,
                  message: 'upstream timeout - LLM provider did not respond',
                  status: 'UNAVAILABLE',
                },
              },
              { status: 503 }
            );
          },
        })
      : undefined;
  try {
    const sequence = probe(level, shimOverride, {
      console,
      scenario,
      gateway: gateway?.url,
      requests: () => requests,
    });
    let step = sequence.next();
    while (!step.done) {
      const { args, ...options } = step.value;
      const child = Bun.spawn(args, { ...options, ...spawnOptions });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      step = sequence.next({ exitCode, stdout, stderr });
    }
    if (!('console' in step.value)) throw new Error('probe: scenario evidence missing');
    return step.value;
  } finally {
    await gateway?.stop(true);
  }
}

export async function runProbeMatrix(level: ProbeLevel, parallel: number, run = runScenarioProbe) {
  const shared = PROBE_SCENARIOS.filter(s => s !== 'outage');
  const cells = (['claude', 'gemini'] as const).flatMap(console =>
    shared.map(scenario => ({ console, scenario }))
  );
  const results: ScenarioEvidence[] = [];
  // Isolate the outage from other cells that share provider health and cooldown state.
  for (let i = 0; i < cells.length; i += parallel)
    results.push(
      ...(await Promise.all(
        cells.slice(i, i + parallel).map(c => run(level, c.console, c.scenario))
      ))
    );
  results.push(await run(level, 'gemini', 'outage'));
  const comparisons = PROBE_SCENARIOS.map(scenario => {
    const claude = results.find(r => r.scenario === scenario && r.console === 'claude') ?? null;
    const gemini = results.find(r => r.scenario === scenario && r.console === 'gemini');
    if (!gemini) throw new Error(`probe: matrix result missing for Gemini/${scenario}`);
    if (!claude) return { scenario, claude, gemini, consistent: null };
    const consistent =
      claude.ok === gemini.ok &&
      claude.state === gemini.state &&
      claude.delivery_state === gemini.delivery_state;
    return { scenario, claude, gemini, consistent };
  });
  const consistent = comparisons.every(c => c.consistent === null || c.consistent);
  return { ok: consistent && results.every(r => r.ok), consistent, comparisons };
}
