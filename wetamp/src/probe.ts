import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { lastJson } from './archon';
import { WETAMP } from './config';
import { redact } from './redact';

export type ProbeLevel = 'G1' | 'G2';

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

export function judgeProbe(value: ProbeJudgement): { ok: boolean; reason?: string } {
  if (value.timed_out) return { ok: false, reason: 'timeout' };
  if (value.launch_exit !== 0) return { ok: false, reason: 'launch_failed' };
  if (!value.launch_run_id) return { ok: false, reason: 'launch_run_id_missing' };
  if (value.wait_exit !== 0) return { ok: false, reason: 'wait_failed' };
  if (value.wait_run_id !== value.launch_run_id)
    return { ok: false, reason: 'wait_run_id_mismatch' };
  if (value.state !== 'completed' || value.delivery_state !== 'published')
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

const outputTail = (result: ReturnType<typeof Bun.spawnSync>): string => {
  const tail = (value: string): string => redact(value).trim().slice(-500);
  return `stdout:\n${tail(result.stdout?.toString() ?? '')}\nstderr:\n${tail(result.stderr?.toString() ?? '')}`;
};

export function runProbe(level: ProbeLevel, shimOverride?: string): ProbeEvidence {
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

  const env = { ...process.env, SUPERAGENT_HOME: canonicalSa, ARCHON_HOME: canonicalArchon };
  const judgement: ProbeJudgement = {
    launch_exit: -1,
    expected_commit: expectedCommit,
    expected_snapshot: snapshot,
  };
  let latest: ReturnType<typeof Bun.spawnSync> | undefined;
  const run = (args: string[]): ReturnType<typeof Bun.spawnSync> => {
    const remaining = limit - (Date.now() - started);
    if (remaining <= 0) {
      judgement.timed_out = true;
      throw new Error('timeout');
    }
    latest = Bun.spawnSync([shim, ...args], {
      cwd: repo,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: remaining,
      killSignal: 'SIGKILL',
    });
    return latest;
  };
  try {
    const goal =
        level === 'G1'
          ? '在 README.md 末尾追加一行 probe-g1'
          : '新增 src/add.ts 导出 add(a: number, b: number): number，并新增 src/add.test.ts 用 bun:test 断言 add(1,2)===3',
      accept = level === 'G1' ? 'grep -q probe-g1 README.md' : 'bun test',
      launched = run([
        'quick',
        '--goal',
        goal,
        '--accept',
        accept,
        '--risk',
        level,
        ...(level === 'G2' ? ['--review'] : []),
        '--json',
      ]),
      launch = lastJson(launched.stdout?.toString() ?? ''),
      runId = typeof launch?.run_id === 'string' ? launch.run_id : undefined;
    judgement.launch_exit = launched.exitCode;
    judgement.launch_run_id = runId;
    if (launched.exitCode === 0 && runId) {
      for (;;) {
        const remaining = limit - (Date.now() - started),
          waited = run([
            'wait',
            runId,
            '--timeout',
            String(Math.max(1, Math.floor(remaining / 1000))),
          ]),
          value = lastJson(waited.stdout?.toString() ?? '');
        judgement.wait_exit = waited.exitCode;
        judgement.wait_run_id = typeof value?.run_id === 'string' ? value.run_id : undefined;
        judgement.state = typeof value?.state === 'string' ? value.state : undefined;
        judgement.delivery_state =
          typeof value?.delivery_state === 'string' ? value.delivery_state : undefined;
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
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (Date.now() - started < limit && diagnostic !== 'timeout') throw error;
    judgement.diagnostic = diagnostic;
    judgement.timed_out = true;
  }
  const decision = judgeProbe(judgement);
  if (!decision.ok && latest)
    judgement.diagnostic = [judgement.diagnostic, outputTail(latest)].filter(Boolean).join('\n');
  const evidence: ProbeEvidence = {
    ok: decision.ok,
    level,
    ...(judgement.launch_run_id ? { run_id: judgement.launch_run_id } : {}),
    duration_ms: Date.now() - started,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(judgement.diagnostic ? { error: judgement.diagnostic } : {}),
    evidence_path: evidencePath,
  };
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, judgement }, null, 2) + '\n');
  chmodSync(evidencePath, 0o444);
  return evidence;
}
