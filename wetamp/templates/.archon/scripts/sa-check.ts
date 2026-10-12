// superagent 确定性节点（bun）：INPUTS_KIND 选择环境/验收/交付判定/合入命令；永不 push。
import reasons from './reasons.json';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
// 只引类型：Bun 转译时擦除，复制到 gen 目录后不依赖 src/
import type { Check, Plan } from '../../../src/plan';
import type { Ledger as OperatorLedger } from '../../../src/cli';
import { readPolicyAttempts, type PolicyAttempt } from './policy-attempts';
import { FAILURE_CLASSES, failureClass, type FailureClass } from './failure-class';

export interface Finding {
  id: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  status: 'open' | 'closed';
  evidence: string;
  carry_over: boolean;
  failure_class?: FailureClass;
  command?: string | null;
}
export interface Review {
  status: 'PASS' | 'FAIL' | 'INCOMPLETE';
  findings: Finding[];
  debt: string[];
}
interface Coder {
  status: 'done' | 'blocked' | 'partial';
  error_class: string | null;
  needs?: unknown[];
}
type Disposition = 'advance' | 'repair' | 'suspend';
export type DeliveryDecision = {
  [K in 'advance' | 'debt' | 'repair' | 'block']: {
    kind: K;
    reason: string | null;
    evidence: string[];
    debt: string[];
  };
}['advance' | 'debt' | 'repair' | 'block'];
export interface Accept {
  ok: boolean;
  decision?: DeliveryDecision;
  milestone?: string;
  diff_hash: string;
  same: boolean;
  head?: string;
  contract_hash?: string;
  risk?: string | null;
  disposition?: Disposition;
  reason?: string | null;
  failed?: string[];
  log?: string;
  base_pass?: boolean | null;
  base_results?: { cmd: string; pass: boolean }[];
  failures?: CheckFailure[];
  workspace_clean?: boolean;
}
export interface CheckFailure {
  command: string;
  failure_class: FailureClass;
  evidence: string;
  repair_rounds?: number;
  debt_reason?: 'repair_limit';
}
/** sa-check uses these fields from the complete frozen <gen>/policy.json. */
interface Policy {
  risk_paths: string[];
  code_extensions: string[];
  exempt_paths: string[];
  budget_floor: Record<string, number>;
}

const env = (k: string): string => process.env[`INPUTS_${k}`] ?? '';
export const CHECK_AUX_TIMEOUT_MS = 10_000;
// accept/settle: status, tree, full/delta patch, scope, probe add/prune, HEAD, events.
// env: HEAD only. The worst-path subprocess trace test enforces these counts.
export const CHECK_AUX_COUNTS = { accept: 9, env: 1 } as const;
// The watchdog owns separate pipes, so even an escaped descendant cannot hold this caller open.
// The shared budget includes TERM grace, KILL, pipe destruction and watchdog startup.
const AUX_WATCHDOG = `
import os, signal, subprocess, sys, time
ms = int(sys.argv[1])
grace = min(0.2, ms / 4000)
p = subprocess.Popen(sys.argv[2:], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
errors = []
def terminate(sig):
    try: os.killpg(p.pid, sig)
    except ProcessLookupError: pass
    except OSError as e: errors.append(str(e))
try:
    out, err = p.communicate(timeout=max(0.001, ms / 2000 - grace))
    code = p.returncode if p.returncode >= 0 else 128 - p.returncode
except subprocess.TimeoutExpired:
    terminate(signal.SIGTERM)
    time.sleep(grace)
    terminate(signal.SIGKILL)
    try: out, err = p.communicate(timeout=grace)
    except subprocess.TimeoutExpired as e:
        out, err = e.output or b'', e.stderr or b''
        p.stdout.close(); p.stderr.close()
    err += b'\\nauxiliary timed out: TERM -> SIGKILL; output pipes reclaimed'
    if errors: err += ('; termination errors: ' + '; '.join(errors)).encode()
    code = 124
sys.stdout.buffer.write(out); sys.stderr.buffer.write(err)
sys.exit(code)
`;
function auxiliary(cmd: string[]) {
  const bounded = ['accept', 'settle', 'env'].includes(env('KIND'));
  return Bun.spawnSync(
    bounded ? ['python3', '-c', AUX_WATCHDOG, String(CHECK_AUX_TIMEOUT_MS), ...cmd] : cmd,
    {
      stdout: 'pipe',
      stderr: 'pipe',
      ...(bounded ? { timeout: CHECK_AUX_TIMEOUT_MS, killSignal: 'SIGKILL' as const } : {}),
    }
  );
}
const artifacts = process.env.ARTIFACTS_DIR ?? '';
const json = (k: string): unknown =>
  env(k) && env(k) !== 'null' ? (JSON.parse(env(k)) as unknown) : null;
const git = (...args: string[]): string => {
  const p = auxiliary(['git', ...args]);
  if (p.exitCode !== 0 || p.signalCode)
    throw new Error(
      `git ${args[0]}: ${p.stderr.toString().trim()}${p.signalCode ? ` (signal ${p.signalCode})` : ''}`
    );
  return p.stdout.toString();
};
const plan = (): Plan => JSON.parse(readFileSync(env('PLAN'), 'utf8')) as Plan;
const policy = (): Policy => JSON.parse(readFileSync(env('POLICY'), 'utf8')) as Policy;
const emit = (o: unknown): void => {
  const code = (o as { reason?: unknown }).reason;
  if (typeof code === 'string' && !reasons.some(r => r.code === code))
    throw new Error(`unregistered reason: ${code}`);
  console.log(JSON.stringify(o));
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const glob = (g: string, p: string): boolean => new Bun.Glob(g).match(p);

// Publish a complete private key atomically; concurrent nodes share the winner's context.
function cacheKey(): Buffer {
  const dir = join(artifacts, 'accept-cache');
  const path = join(dir, '.key');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    const temp = join(dir, `.key-${randomBytes(16).toString('hex')}`);
    writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: 'wx' });
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(temp);
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('invalid acceptance cache key');
  return key;
}

/**
 * 逐条执行；超时由 spawnSync 杀进程。返回失败条目。检查默认在同一 tree、命令、超时与环境下
 * 复用本 run 的结果；身份仅证明传入环境，外部可变资源须声明 cache:false，每次实跑。
 */
function run(
  checks: Check[],
  log: string,
  cwd?: string,
  envKey = '',
  failures: CheckFailure[] = []
): string[] {
  const failed: string[] = [];
  // These variables belong to the engine node, not the project acceptance command (including probes).
  // Environment nodes keep their existing inherited environment.
  const commandEnv =
    env('KIND') === 'env'
      ? process.env
      : Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) =>
              !k.startsWith('INPUTS_') &&
              !['WORKFLOW_ID', 'ARTIFACTS_DIR', 'SA_COORD_ADMISSION', 'SUPERAGENT_ROLE'].includes(k)
          )
        );
  const tree = artifacts && envKey && git('rev-parse', 'HEAD^{tree}').trim();
  const environment =
    tree && checks.some(c => c.cache !== false)
      ? createHmac('sha256', cacheKey())
          .update(
            JSON.stringify(
              Object.keys(commandEnv)
                .sort()
                .map(k => [k, commandEnv[k]])
            )
          )
          .digest('hex')
      : '';
  for (const c of checks) {
    const hit =
      tree && c.cache !== false
        ? join(
            artifacts,
            'accept-cache',
            sha(
              JSON.stringify([
                'hmac-v1',
                FAILURE_CLASSES,
                tree,
                c.cmd,
                c.timeout_s,
                envKey,
                environment,
              ])
            )
          )
        : '';
    if (hit && existsSync(hit)) {
      const saved = JSON.parse(readFileSync(hit, 'utf8')) as {
        tag: string;
        failure: CheckFailure | null;
      };
      appendFileSync(
        log,
        `$ ${c.cmd}\n# reused ${saved.failure ? 'failure' : 'pass'} from ${saved.tag}\n\n`
      );
      if (saved.failure) {
        failed.push(c.cmd);
        failures.push(saved.failure);
      }
      continue;
    }
    const t0 = Date.now();
    const p = Bun.spawnSync(['bash', '-c', c.cmd], {
      cwd,
      env: commandEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: c.timeout_s * 1000,
    });
    const code = p.signalCode ? `signal ${p.signalCode}` : p.exitCode;
    appendFileSync(
      log,
      `$ ${c.cmd}\n${p.stdout.toString()}${p.stderr.toString()}# exit=${String(code)} ms=${String(Date.now() - t0)}\n\n`
    );
    if (code !== 0) {
      failed.push(c.cmd);
      // A validation command may emit one JSON object. Prose and coder reports never classify failures.
      let classification: unknown;
      try {
        const output: unknown = JSON.parse(p.stdout.toString());
        if (
          !p.signalCode &&
          output &&
          typeof output === 'object' &&
          'evidence' in output &&
          typeof output.evidence === 'string' &&
          output.evidence.trim() &&
          'failure_class' in output
        )
          classification = output.failure_class;
      } catch {
        /* Unstructured output fails closed. */
      }
      failures.push({
        command: c.cmd,
        failure_class: failureClass(classification),
        evidence: log,
      });
    }
    if (hit) {
      mkdirSync(dirname(hit), { recursive: true });
      writeFileSync(
        hit,
        JSON.stringify({
          tag: env('TAG'),
          failure: code === 0 ? null : failures.at(-1),
          exit: code,
          stdout: p.stdout.toString(),
          stderr: p.stderr.toString(),
        })
      );
    }
  }
  return failed;
}

/**
 * 存档将军输出供评审核对 deviations；控制状态仅消费交付判定。blocked 只在命中红线或 needs 非空时成立，
 * 否则按 partial 记（照常进入修复循环）。输出不是 JSON 时原样存档，不让验收因此失败。
 */
function saveCoder(tag: string, raw: string, errorClassIgnored = false): void {
  if (!raw) return;
  let out: Record<string, unknown>;
  try {
    const c = JSON.parse(raw) as Coder;
    const legit = c.error_class === 'redline' || (c.needs?.length ?? 0) > 0;
    out = { ...c, status: c.status === 'blocked' && !legit ? 'partial' : c.status };
  } catch {
    out = { raw };
  }
  writeFileSync(
    join(artifacts, `${tag}.coder.json`),
    JSON.stringify(
      {
        ...out,
        ...(errorClassIgnored ? { error_class_ignored: true } : {}),
        milestone: env('MILESTONE'),
      },
      null,
      2
    )
  );
}

/** Compatibility wiring is a projection of the delivery decision, never a second policy. */
export function disposition(
  raw: string,
  ok: boolean,
  check?: Accept,
  permissions: string[] = [],
  selfReportPath?: string
) {
  const { decision, audit } = deliveryDecision({
    rechecks: [check ?? { ok, diff_hash: '', same: false }],
    permissions,
    selfReport: raw,
    selfReportPath,
  });
  return {
    ...audit,
    decision,
    disposition: (decision.kind === 'block'
      ? 'suspend'
      : decision.kind === 'repair'
        ? 'repair'
        : 'advance') as Disposition,
    reason: decision.reason,
  };
}

const RISKS = ['G0', 'G1', 'G2'] as const;
const maxRisk = (...rs: (string | null | undefined)[]): Plan['packages'][number]['risk'] =>
  RISKS[Math.max(0, ...rs.map(r => RISKS.findIndex(v => v === r)))];

/** Routing and the gate consume the same structured acceptance risks, never infer them twice. */
export const effectiveRisk = (
  declared: string,
  rechecks: Pick<Accept, 'risk'>[]
): Plan['packages'][number]['risk'] => maxRisk(declared, ...rechecks.map(c => c.risk));

/** `git diff --raw -z -M` 的逐项：状态、两侧 mode、路径（重命名/复制为源与目标）。 */
function changes(base: string): { modes: string[]; paths: string[] }[] {
  const f = git('diff', '--raw', '-z', '-M', base, 'HEAD').split('\0');
  const out: { modes: string[]; paths: string[] }[] = [];
  for (let i = 0; i + 1 < f.length; ) {
    const [om, nm, , , st] = f[i].slice(1).split(' ');
    const n = /^[RC]/.test(st) ? 2 : 1;
    out.push({ modes: [om, nm], paths: f.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return out;
}

/**
 * F-13 交付门禁（不是沙箱）：实际 candidate tree 对照 scope.write。越界、gitlink/symlink 变动、命中 risk_paths
 * 一律推断 G2；声明 G0 却改了代码文件推断 G1。有效风险 = max(声明, 推断)，评审与 gate 都按它执行。
 */
export function scopeRisk(
  ch: { modes: string[]; paths: string[] }[],
  write: string[],
  pol: Policy,
  declared: string
): { risk: string; out_of_scope: string[] } {
  const inScope = (p: string): boolean =>
    pol.exempt_paths.some(g => glob(g, p)) ||
    write.some(w => p === w || p.startsWith(w.replace(/\/*$/, '/')) || glob(w, p));
  const out_of_scope = [...new Set(ch.flatMap(c => c.paths).filter(p => !inScope(p)))];
  const inferred = ch.map(c =>
    c.modes.some(m => m === '160000' || m === '120000') ||
    c.paths.some(p => pol.risk_paths.some(g => glob(g, p)))
      ? 'G2'
      : c.paths.some(p => pol.code_extensions.some(e => p.endsWith(e)))
        ? 'G1'
        : 'G0'
  );
  return { risk: maxRisk(declared, out_of_scope.length ? 'G2' : 'G0', ...inferred), out_of_scope };
}

/** 一次验收：coder 处置 + 命令 + 干净工作区；有 BASE 时另存全量 patch、相对 DELTA_BASE 的增量 patch 与交付范围。 */
function acceptOnce(tag: string, coder: string): Record<string, unknown> & Accept {
  const log = join(artifacts, `${tag}.log`);
  // R1-1: retries may reuse this tag; cached failures still reference its original output.
  appendFileSync(log, '');
  const ids = env('PKGS').split(',').filter(Boolean);
  const p = plan();
  const pkgs = p.packages.filter(k => ids.includes(k.id));
  // 全量评审覆盖 base_ref 以来的累计交付，前序包的已批准写入范围仍有效。
  const scopeIds = (env('SCOPE_PKGS') || env('PKGS')).split(',');
  const covered = p.packages.filter(k => scopeIds.includes(k.id));
  const checks = pkgs.flatMap(k => k.accept);
  // 声明环境契约与实际传入环境分别绑定；缓存上下文只属于本 run 的 ARTIFACTS_DIR。
  const envKey = sha(JSON.stringify(environmentChecks(p)));
  const dirty = git('status', '--porcelain').trim();
  const failures: CheckFailure[] = [];
  const failed = run(checks, log, undefined, dirty ? '' : envKey, failures);
  if (dirty)
    appendFileSync(
      log,
      `# uncommitted changes (commit them; land only merges commits):\n${dirty}\n`
    );
  const base = env('BASE');
  const save = (name: string, from: string): string => {
    if (!base) return '';
    writeFileSync(join(artifacts, name), git('diff', '--binary', from, 'HEAD'));
    return join(artifacts, name);
  };
  const patch = save(`${tag}.patch`, base);
  const delta = env('DELTA_BASE') ? save(`${tag}.delta.patch`, env('DELTA_BASE')) : patch;
  const hash = patch ? sha(readFileSync(patch, 'utf8')).slice(0, 16) : '';
  const scope =
    base && env('RISK')
      ? scopeRisk(
          changes(base),
          covered.flatMap(k => k.scope.write),
          policy(),
          env('RISK')
        )
      : { risk: env('RISK') || null, out_of_scope: [] };
  const ok = failed.length === 0 && !dirty;
  // Generated diff artifact names are the engine's structured channel, not vendor prose.
  // On the final allowed round, unresolved acceptance must stop dispatching repairs.
  const reviewRound =
    Array.from(
      { length: MAX_ROUNDS },
      (_, i) => `diff-${env('MILESTONE')}-r${String(i + 1)}`
    ).indexOf(tag) + 1;
  const baseResults =
    base && failed.length
      ? probe(
          base,
          checks.filter(c => failed.includes(c.cmd)),
          tag
        )
      : [];
  if (baseResults.length) appendFileSync(log, `# base_results: ${JSON.stringify(baseResults)}\n`);
  else if (base && failed.length)
    appendFileSync(log, `# baseline unknown: see ${join(artifacts, `${tag}.probe.log`)}\n`);
  const result = disposition(
    coder,
    ok,
    {
      ok,
      diff_hash: hash,
      same: false,
      failed,
      failures,
      workspace_clean: !dirty,
      log,
      base_pass: baseResults.length ? baseResults.some(r => r.pass) : null,
    },
    env('ARCHON') ? permissionEvidence(runEvents(), ids, env('MILESTONE')) : [],
    join(artifacts, `${tag}.coder.json`)
  );
  if (reviewRound >= MAX_ROUNDS && result.disposition === 'repair')
    Object.assign(result, {
      disposition: 'suspend',
      reason: 'acceptance_failed+review_limit',
      decision: { ...result.decision, kind: 'block', reason: 'acceptance_failed+review_limit' },
    });
  saveCoder(tag, coder, result.error_class_ignored);
  // 存档一份：supervise-tick 自动重试时据此写失败命令与日志尾的提示
  return {
    ok,
    milestone: env('MILESTONE'),
    ...result,
    failed,
    failures,
    workspace_clean: !dirty,
    log,
    patch,
    delta,
    diff_hash: hash,
    contract_hash: sha(
      JSON.stringify([
        p,
        ids,
        scopeIds,
        base,
        env('RISK'),
        env('POLICY') ? readFileSync(env('POLICY'), 'utf8') : null,
      ])
    ),
    // 相同 diff 跳过新评审；gate 仍须核验候选、契约与既有独立评审证据。
    same: env('PREV') !== '' && hash === env('PREV'),
    base_results: baseResults,
    base_pass: baseResults.length ? baseResults.some(r => r.pass) : null,
    ...scope,
    head: git('rev-parse', 'HEAD').trim(),
  };
}

/** 写 <tag>.json 并输出；挂起（含预算超限）exit 1，run 停在本节点，后续包与评审都不启动。 */
function finish(tag: string, out: Record<string, unknown> & Accept): void {
  if (out.disposition !== 'suspend') {
    const over = budget();
    if (over)
      Object.assign(out, {
        disposition: 'suspend',
        reason: over,
        decision: { ...out.decision, kind: 'block', reason: over },
      });
  }
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  // Audit/control evidence stays in the artifact; downstream packages consume only delivered data.
  emit(
    env('KIND') === 'settle' && out.disposition !== 'suspend' ? { diff_hash: out.diff_hash } : out
  );
  if (out.disposition === 'suspend') {
    console.error(`${tag}: suspend (${out.reason ?? ''})`);
    process.exit(1);
  }
}

function accept(): void {
  finish(env('TAG'), acceptOnce(env('TAG'), env('CODER')));
}

/**
 * 包内修复后的结算：没有修复（verify 已 advance）就沿用 verify 的验收证据；修过则用修复输出重验，
 * 仍未 advance 即挂起 repair_exhausted:<原因>——每包只有一次修复机会，不在包级循环烧调用。
 */
function settle(): void {
  const tag = env('TAG');
  const first = json('FIRST') as Record<string, unknown> & Accept;
  const repaired = env('REPAIRED');
  if (!repaired || repaired === 'null') {
    if (first.disposition !== 'advance')
      throw new Error(`${tag}: repair skipped but verify did not advance`);
    finish(tag, first);
    return;
  }
  const out = acceptOnce(tag, repaired);
  if (out.disposition === 'repair')
    Object.assign(out, {
      disposition: 'suspend',
      reason: `repair_exhausted:${out.reason ?? ''}`,
      decision: { ...out.decision, kind: 'block', reason: `repair_exhausted:${out.reason ?? ''}` },
    });
  finish(tag, out);
}

/** 在 base 的临时 detached 工作树里准备同一环境后重跑失败命令；无法准备时不作基线结论。 */
function probe(base: string, checks: Check[], tag: string): NonNullable<Accept['base_results']> {
  const log = join(artifacts, `${tag}.probe.log`),
    setup = environmentChecks(plan());
  writeFileSync(log, setup.length ? '' : '# baseline unknown: no environment commands declared\n');
  if (!setup.length) return [];
  const dir = mkdtempSync(join(artifacts, `probe-${tag}-`));
  try {
    git('worktree', 'add', '--detach', '-q', dir, base);
    if (run(setup, log, dir).length) {
      appendFileSync(log, '# baseline unknown: environment preparation failed\n');
      return [];
    }
    return checks.map(c => ({
      cmd: c.cmd,
      pass: run([c], log, dir).length === 0,
    }));
  } finally {
    let retained = dir;
    const warn = (e: unknown): void => {
      const message = `probe: kept worktree ${retained}: ${String(e)}`;
      console.error(message);
      try {
        appendFileSync(log, `${message}\n`);
      } catch {
        /* stderr retains the evidence. */
      }
    };
    try {
      const trash = join(artifacts, '.trash');
      mkdirSync(trash, { recursive: true });
      const target = join(trash, basename(dir));
      renameSync(dir, target);
      retained = target;
      try {
        git('worktree', 'prune', '--expire', 'now');
      } catch (e) {
        warn(e);
      }
      // Engine-owned probe output is disposable; deletion must not delay the node.
      spawn('rm', ['-rf', '--', target], { detached: true, stdio: 'ignore' })
        .on('error', warn)
        .on('exit', code => {
          if (code) warn(`background delete exit ${String(code)}`);
        })
        .unref();
    } catch (e) {
      warn(e);
    }
  }
}

export const environmentChecks = (p: Plan): Check[] =>
  (p.environment ?? []).concat(p.packages.flatMap(k => k.environment ?? []));

function environment(): void {
  const log = join(artifacts, 'environment.log');
  writeFileSync(log, '');
  const failed = run(environmentChecks(plan()), log);
  emit({ ok: failed.length === 0, failed, log, head: git('rev-parse', 'HEAD').trim() });
  if (failed.length) process.exit(1);
}

const severities = (risk: string): string[] =>
  risk === 'G2' ? ['blocker', 'high', 'medium'] : ['blocker', 'high'];

/** 第 2/3 轮的有效关闭：原 id、carry_over:true、status:closed 且附 evidence；同轮同 id 另有 open 条目则 open 胜出。 */
const closes = (r: Review, id: string): boolean =>
  r.findings.some(
    f => f.id === id && f.carry_over && f.status === 'closed' && f.evidence.trim() !== ''
  ) && !r.findings.some(f => f.id === id && f.status === 'open');

export interface Entry {
  id: string;
  severity: Finding['severity'];
  file: string;
  line: number;
  /** 首次出现的轮次（1 起）。 */
  round: number;
  evidence?: string;
  closed_round?: number;
  failure_class?: FailureClass;
  command?: string | null;
  repair_rounds?: number;
  debt_reason?: 'non_product' | 'repair_limit';
}
export interface Ledger {
  blocking: Entry[];
  debt: Entry[];
  closed: Entry[];
}

/**
 * F-19/FC 累计台账，由评审与验证历史派生。基准轮（首份非空评审）：product 的 blocker/high（G2 含 medium）阻塞。
 * 之后只有 closes() 成立的条目才关闭；缺失、改 id、carry_over:false 一律仍 open。不在台账里的 id 一律是新发现——
 * 自报 carry_over:true 也不扩大阻塞集合：只有 blocker 阻塞，其余记债；已在台账里的条目升为 blocker 时转为阻塞。
 */
export function ledgerOf(
  reviews: (Review | null)[],
  risk: string,
  options: {
    strict?: boolean;
    rechecks?: Accept[];
  } = {}
): Ledger {
  const sev = severities(risk);
  const open = new Map<string, Entry & { blocks: boolean; eligible: boolean }>();
  const closed: Entry[] = [];
  let base = true;
  reviews.forEach((r, i) => {
    for (const e of open.values()) if (e.blocks) e.repair_rounds = (e.repair_rounds ?? 0) + 1;
    const check = options.rechecks?.[i];
    // Commands are stable keys. Only validator or reviewer evidence may classify them.
    const checks: Finding[] = (check?.failed ?? []).map(command => {
      const reviewed = r?.findings.filter(f => f.command === command && f.status === 'open') ?? [];
      const classifications = reviewed.map(f =>
        failureClass(f.evidence.trim() ? f.failure_class : undefined)
      );
      const validated = check?.failures?.find(f => f.command === command);
      if (validated)
        classifications.push(
          failureClass(validated.evidence.trim() ? validated.failure_class : undefined)
        );
      return {
        id: `check:${sha(command).slice(0, 16)}`,
        severity: 'blocker',
        file: command,
        line: 0,
        status: 'open',
        carry_over: i > 0,
        command,
        // A non-product finding cannot hide a product or unclassified failure in the same command.
        failure_class: classifications.includes('unknown')
          ? 'unknown'
          : classifications.includes('product')
            ? 'product'
            : (classifications[0] ?? 'unknown'),
        evidence: validated?.evidence.length
          ? validated.evidence
          : reviewed.map(f => f.evidence).join('\n'),
      };
    });
    if (!r && !check) return;
    const current = r ?? { status: 'FAIL', findings: [], debt: [] };
    for (const [id, e] of open)
      if (
        closes(current, id) ||
        (e.command &&
          (check?.ok ||
            (check?.failed &&
              !check.failed.includes(e.command) &&
              check.workspace_clean !== false)))
      ) {
        open.delete(id);
        const { blocks: _, eligible: __, ...entry } = e;
        void _;
        void __;
        const ev = current.findings.find(f => f.id === id)?.evidence ?? '';
        closed.push({ ...entry, evidence: ev, closed_round: i + 1 });
      }
    for (const f of [...current.findings, ...checks]) {
      if (f.status !== 'open') continue;
      const known = open.get(f.id);
      const classification = failureClass(f.evidence.trim() ? f.failure_class : undefined);
      const nonProduct = ['test_env', 'fixture', 'baseline', 'test_data'].includes(classification);
      if (known) {
        known.eligible ||= f.severity === 'blocker';
        Object.assign(known, {
          failure_class: classification,
          evidence: f.evidence,
          blocks: classification === 'unknown' || (!nonProduct && known.eligible),
          debt_reason: nonProduct ? 'non_product' : undefined,
        });
      } else
        open.set(f.id, {
          id: f.id,
          severity: f.severity,
          file: f.file,
          line: f.line,
          round: i + 1,
          evidence: f.evidence,
          failure_class: classification,
          command: f.command,
          repair_rounds: 0,
          ...(nonProduct ? { debt_reason: 'non_product' as const } : {}),
          blocks:
            classification === 'unknown' ||
            (!nonProduct && (base ? sev.includes(f.severity) : f.severity === 'blocker')),
          eligible: base ? sev.includes(f.severity) : f.severity === 'blocker',
        });
    }
    if (r) base = false;
  });
  const strip = (b: boolean): Entry[] =>
    [...open.values()]
      .filter(e => e.blocks === b)
      .map(({ blocks: _, eligible: __, ...e }) => {
        void _;
        void __;
        return e;
      });
  return { blocking: strip(true), debt: strip(false), closed };
}

/** 评审债 = 末份评审员 debt[] ∪ 台账里 open 且不阻塞的条目（派生项始终并入，不信任评审员只登记部分）。 */
const debtOf = (reviews: (Review | null)[], l: Ledger): string[] => [
  ...new Set([
    ...(reviews.filter(r => r !== null).at(-1)?.debt ?? []),
    ...l.debt.map(
      e =>
        `${e.id} ${e.severity} ${e.file}:${String(e.line)}` +
        (e.debt_reason
          ? ` [${e.failure_class ?? 'product'} ${e.debt_reason}] ${e.evidence ?? ''}`
          : '')
    ),
  ]),
];

export const MAX_ROUNDS = 3;
type Verdict = 'pass' | 'fix' | 'escalate';

/** reviews[i]/rechecks[i] 对应第 i+1 轮；权限拒绝优先，自报只有 environment needs 可阻断失败验收。 */
export function deliveryDecision(input: {
  selfReport?: string;
  selfReportPath?: string;
  reviews?: (Review | null)[];
  permissions?: string[];
  reviewRequired?: boolean;
  rechecks: Accept[];
  risk?: string;
  expired?: boolean;
  qualifiedReview?: boolean;
  strict?: boolean;
}) {
  let coder: Coder | undefined;
  try {
    coder = JSON.parse(input.selfReport ?? '') as Coder;
  } catch {
    /* Self-report is diagnostic only. */
  }
  const audit = {
    ...(coder && (coder.status !== 'done' || coder.error_class || coder.needs?.length)
      ? { self_report_conflict: true as const }
      : {}),
    ...(coder?.status === 'partial' ? { coder_partial: true as const } : {}),
    ...(coder?.error_class ? { error_class_ignored: true as const } : {}),
  };
  const reviews = input.reviews ?? [];
  const rounds = reviews.length;
  const check = input.rechecks.at(-1);
  const ledger = ledgerOf(reviews.length ? reviews : [null], input.risk ?? 'G1', {
    strict: input.strict,
    rechecks: input.rechecks,
  });
  const evidence = [
    ...new Set([
      ...(input.permissions ?? []),
      ...input.rechecks.flatMap(c => [...(c.decision?.evidence ?? []), ...(c.log ? [c.log] : [])]),
      ...[...ledger.blocking, ...ledger.debt].flatMap(e => (e.evidence ? [e.evidence] : [])),
    ]),
  ];
  const out = (kind: DeliveryDecision['kind'], reason: string | null, debt: string[] = []) => ({
    decision: { kind: kind === 'advance' && debt.length ? 'debt' : kind, reason, evidence, debt },
    rounds,
    ledger,
    audit,
  });
  if (input.permissions?.length || check?.decision?.reason === 'coder_redline')
    return out('block', 'coder_redline');
  if (!check) return out('block', 'engine_suspect');
  if (
    !check.ok &&
    Array.isArray(coder?.needs) &&
    coder.needs.some(n => n && typeof n === 'object' && 'cap' in n && n.cap === 'environment')
  ) {
    if (input.selfReportPath) evidence.push(input.selfReportPath);
    return out('block', 'environment');
  }
  if (ledger.blocking.some(e => e.failure_class === 'unknown')) {
    evidence.push('diagnosis required: supply structured failure_class and evidence');
    return out('block', 'acceptance_failed');
  }
  const unknown = check.failures?.some(
    f =>
      f.failure_class === 'test_env' || (f.failure_class === 'baseline' && check.base_pass === null)
  );
  if (unknown) return out('block', 'environment');
  const accepted =
    check.workspace_clean !== false &&
    (check.ok ||
      ((check.failed?.length ?? 0) > 0 &&
        check.failed?.every(command =>
          ledger.debt.some(e => e.command === command && e.debt_reason === 'non_product')
        )));
  if (!input.reviews) {
    const debt = debtOf(reviews, ledger);
    return accepted ? out('advance', null, debt) : out('repair', 'acceptance_failed', debt);
  }
  if (input.expired) return out('block', 'deadline');
  // 同一份评审里 id 重复（含同 id 既 closed 又 open）：账本无法唯一解释，不放行也不降为债务
  if (reviews.some(r => r && new Set(r.findings.map(f => f.id)).size !== r.findings.length))
    return out('block', 'invalid_review');
  if (
    accepted &&
    input.reviewRequired === false &&
    reviews.every(r => r === null) &&
    !input.strict &&
    input.risk !== 'G2'
  )
    return out('advance', 'review_not_required', debtOf(reviews, ledger));
  if (check.same) {
    const prior = reviews
      .map((r, i) => (r ? i : -1))
      .filter(i => i >= 0)
      .at(-1);
    const accepted = prior === undefined ? undefined : input.rechecks[prior];
    const review = prior === undefined ? undefined : reviews[prior];
    // Missing legacy evidence cannot prove equivalence; open debt also forbids reuse.
    const reusable =
      input.qualifiedReview === true &&
      reviews.at(-1) === null &&
      check.ok &&
      check.decision?.kind === 'advance' &&
      review?.status === 'PASS' &&
      ledger.blocking.length === 0 &&
      ledger.debt.length === 0 &&
      review.debt.length === 0 &&
      !!check.head &&
      accepted?.head === check.head &&
      !!check.diff_hash &&
      accepted.diff_hash === check.diff_hash &&
      !!check.contract_hash &&
      accepted.contract_hash === check.contract_hash &&
      accepted.risk === check.risk &&
      check.risk === input.risk;
    return reusable ? out('advance', null) : out('block', 'no_change');
  }
  const debt = debtOf(reviews, ledger);
  const last = reviews.at(-1);
  // A completed review's FAIL can describe only classified debt. Empty/unclassified FAIL stays a failure.
  const debtOnly =
    ledger.blocking.length === 0 &&
    ledger.debt.some(e => e.debt_reason) &&
    (last?.status === 'PASS' || (last?.status === 'FAIL' && last.findings.length > 0));
  if (accepted && debtOnly) return out('advance', null, debt);
  let reason: string;
  if (!last) {
    if (accepted) throw new Error('gate: no review');
    reason = check.reason ?? 'acceptance_failed';
  } else {
    const ok = accepted ?? false;
    if (last.status === 'PASS' && ledger.blocking.length === 0 && ok)
      return out('advance', null, debt);
    reason = !ok
      ? 'acceptance_failed'
      : { PASS: 'review_inconsistent', FAIL: 'review_failed', INCOMPLETE: 'review_incomplete' }[
          last.status
        ];
  }
  if (rounds >= MAX_ROUNDS) return out('block', `${reason}+review_limit`, debt);
  return out(last?.status === 'INCOMPLETE' ? 'block' : 'repair', reason, debt);
}

export function decide(input: Parameters<typeof deliveryDecision>[0]) {
  const { decision, ...rest } = deliveryDecision(input);
  return {
    ...rest,
    decision,
    verdict: (decision.kind === 'block'
      ? 'escalate'
      : decision.kind === 'repair'
        ? 'fix'
        : 'pass') as Verdict,
    reason: decision.reason,
    debt: decision.debt,
  };
}

const expired = (): boolean => Date.now() > Date.parse(plan().deadline);

interface Binding {
  provider?: string;
  model?: { requested?: string; resolved?: { source: string; value?: string; reason?: string } };
}
interface RunEvent {
  event_type: string;
  step_name?: string;
  data?: {
    attemptId?: string;
    structured_output?: { attempt?: string };
    event?: import('../../../../packages/provider-contract/src/events').ProviderEvent;
    hook_event?: string;
    exit_code?: number;
    binding?: Binding;
    spend?: {
      tokens?: { source: string; value?: { input: number; output: number; cacheRead?: number } };
    };
  };
}
/** Counter changes clear their scope; an unchanged always_run counter preserves denials. */
export function permissionEvidence(events: RunEvent[], pkgs: string[], m: string): string[] {
  const nodes = new Map<string, string>();
  for (const id of pkgs)
    for (const node of [`code-${id}`, `repair-${id}`]) nodes.set(node, `package-attempt-${id}`);
  const scope = `attempt-${m}`;
  for (let r = 1; r <= MAX_ROUNDS; r++) nodes.set(`fix-${m}-r${String(r)}`, scope);
  const attempts = new Map<string, string>(),
    counters = new Map<string, string>(),
    denied = new Map<string, string>();
  events.forEach((e, i) => {
    const node = e.step_name ?? '';
    const count =
      e.event_type === 'node_completed' ? e.data?.structured_output?.attempt : undefined;
    if (typeof count === 'string' && counters.get(node) !== count) {
      for (const [member, owner] of nodes)
        if (node === owner || node === scope) denied.delete(member);
      counters.set(node, count);
    }
    if (!nodes.has(node)) return;
    const attempt = e.event_type === 'provider_event' ? e.data?.attemptId : undefined;
    if (e.event_type === 'node_started' || (attempt && attempts.get(node) !== attempt))
      denied.delete(node);
    if (attempt) attempts.set(node, attempt);
    const hook = e.event_type === 'provider_event' ? e.data?.event : undefined;
    const refusal =
      (hook?.type === 'warning' && hook.permissionDenied === true) ||
      (hook?.type === 'hook' && hook.hookEvent === 'PreToolUse' && hook.exitCode === 2);
    const legacy =
      e.event_type === 'hook_activity' &&
      e.data?.hook_event === 'PreToolUse' &&
      e.data.exit_code === 2;
    if (refusal || legacy) denied.set(node, `events:${node}:${String(i)}`);
  });
  return [...denied.values()];
}
let events: RunEvent[] | undefined;
/**
 * 执行层台账（Archon 事件里的 spend/binding）。INPUTS_ARCHON 为空（fake 生成）时调用方不查：身份记 fake、
 * 预算不检查。输出前可能有日志行，取最后一个能整体解析的顶层 `{` 起点。
 */
function runEvents(): RunEvent[] {
  if (events) return events;
  const id = process.env.WORKFLOW_ID;
  if (!id) throw new Error('sa-check: WORKFLOW_ID unset');
  const p = auxiliary([env('ARCHON'), 'workflow', 'get', id, '--verbose', '--events', '--json']);
  if (p.exitCode !== 0 || p.signalCode)
    throw new Error(
      `archon workflow get ${id}: ${p.stderr.toString().slice(-300)}${p.signalCode ? ` (signal ${p.signalCode})` : ''}`
    );
  const lines = p.stdout.toString().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return (events =
        (JSON.parse(lines.slice(i).join('\n')) as { events?: RunEvent[] }).events ?? []);
    } catch {
      // 该行只是日志里的 `{`，继续向前找真正的 JSON 起点
    }
  }
  throw new Error(`archon workflow get ${id}: no JSON in output`);
}
const AI_NODE = /^(code|repair|fix|review)-/;

/**
 * F-16：下一次模型调用前的预算检查。launch = AI 节点每次启动（含失败与重试）；token 按“除缓存读外”的
 * 已知用量（input − cacheRead + output，cacheRead 未报按 0 记，取上界）。缺回执的调用不当 0：
 * 每个按本 run 已知单次最大值（无已知时按 budget_floor.S）预留。超限返回稳定 reason。
 */
export function budgetUsage(
  events: RunEvent[],
  floor: number,
  attempts: PolicyAttempt[] = [],
  accounting: 'reserved' | 'reported' = 'reserved'
): { launches: number; weighted_tokens: number; reserve: number } {
  const owned = new Set(attempts.map(a => a.node));
  const ev = events.filter(e => AI_NODE.test(e.step_name ?? '') && !owned.has(e.step_name ?? ''));
  const used = ev
    .filter(e => e.event_type === 'node_completed' || e.event_type === 'node_failed')
    .map(e => e.data?.spend?.tokens)
    .map(t =>
      t?.source === 'provider' && t.value
        ? t.value.input - (t.value.cacheRead ?? 0) + t.value.output
        : null
    )
    .concat(
      attempts.map(a =>
        a.tokens ? a.tokens.input - (a.tokens.cacheRead ?? 0) + a.tokens.output : null
      )
    );
  const known = used.filter((n): n is number => n !== null);
  const reserve = Math.max(0, ...known) || floor;
  const starts = ev.filter(e => e.event_type === 'node_started').length;
  const balance = new Map<string, number>();
  for (const e of ev) {
    const delta =
      e.event_type === 'node_started'
        ? 1
        : e.event_type === 'node_completed' || e.event_type === 'node_failed'
          ? -1
          : 0;
    const node = e.step_name ?? '';
    balance.set(node, (balance.get(node) ?? 0) + delta);
  }
  const missing = [...balance.values()].reduce((sum, count) => sum + Math.max(0, count), 0);
  // Titles show reported spend; admission always includes reservations for missing receipts.
  const total =
    known.reduce((a, n) => a + n, 0) +
    (accounting === 'reserved' ? (used.length - known.length + missing) * reserve : 0);
  return {
    launches: starts + attempts.length,
    weighted_tokens: total,
    reserve,
  };
}
/** A leading dot cannot be a schema-valid milestone; legacy milestone paths stay intact. */
export const attemptPath = (dir: string, scope: string): string =>
  join(dir, 'attempts', ...(scope.startsWith('pkg/') ? ['.packages', scope.slice(4)] : [scope]));

/** Absent counters mean zero; malformed or unreadable counters must never become retry state. */
export function readAttempt(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`invalid attempt counter: ${path}`);
  return n;
}
/** 生效额度的唯一判定：grant 只覆盖同里程碑的同一次 attempt。 */
export function effectiveBudget(
  base: Plan['budget'],
  grant: {
    milestone: string;
    attempt: number;
    limits?: Plan['budget'];
  } | null,
  milestone: string,
  attempt: number | null
): Plan['budget'] {
  if (grant && (!Number.isSafeInteger(grant.attempt) || grant.attempt < 0))
    throw new Error('budget-extra: invalid attempt');
  if (grant?.milestone !== milestone || attempt === null || attempt !== grant.attempt) return base;
  if (
    !grant.limits ||
    !Number.isSafeInteger(grant.limits.launches) ||
    (grant.limits.launches ?? 0) <= 0 ||
    !Number.isFinite(grant.limits.weighted_tokens) ||
    grant.limits.weighted_tokens <= 0
  )
    throw new Error('budget-extra: invalid limits');
  return grant.limits;
}
function budget(nextLaunch = true): string | null {
  if (!env('ARCHON')) return null;
  const dir = dirname(env('PLAN')),
    m = env('MILESTONE');
  const extra = join(dir, 'budget-extra');
  const g = existsSync(extra)
    ? (JSON.parse(readFileSync(extra, 'utf8')) as Parameters<typeof effectiveBudget>[1])
    : null;
  const attempt = join(dir, 'attempts', m);
  const b = effectiveBudget(plan().budget, g, m, readAttempt(attempt));
  const u = budgetUsage(runEvents(), policy().budget_floor.S, readPolicyAttempts(artifacts));
  if (b.launches !== undefined && (nextLaunch ? u.launches >= b.launches : u.launches > b.launches))
    return 'budget_launches_exceeded';
  return u.weighted_tokens > b.weighted_tokens ? 'budget_tokens_exceeded' : null;
}

interface Ident {
  model: string | null;
  strength: 'provider' | 'pinned' | 'unknown' | 'fake';
}
/**
 * 执行层记录的实际模型。provider 回执最强；Codex 不回报实际模型（resolved: unsupported），以钉死的请求模型
 * 记为 pinned（较弱证据，gate 输出里可见）；其余为 unknown。
 */
export const identityOf = (b: Binding | undefined): Ident => {
  const m = b?.model;
  if (m?.resolved?.source === 'provider' && m.resolved.value)
    return { model: m.resolved.value, strength: 'provider' };
  if (m?.resolved?.reason === 'unsupported' && m.requested)
    return { model: m.requested, strength: 'pinned' };
  return { model: null, strength: 'unknown' };
};

/** Provider receipts remain strongest; a fallback's pinned model must replace the original request. */
export function attemptIdentity(attempts: PolicyAttempt[], node: string, binding?: Binding): Ident {
  const attempt = attempts.filter(a => a.node === node).at(-1);
  if (!attempt) return identityOf(binding);
  if (attempt.status !== 'completed') return { model: null, strength: 'unknown' };
  if (attempt.resolved) return { model: attempt.resolved, strength: 'provider' };
  return attempt.provider === 'codex'
    ? { model: attempt.model, strength: 'pinned' }
    : { model: null, strength: 'unknown' };
}

/** F-14：不合格的原因；null = 合格独立评审（双方身份已知、实际模型不同）。 */
export function independence(authors: Ident[], reviewer: Ident): string | null {
  if (reviewer.strength === 'unknown') return 'reviewer_unknown';
  if (!authors.length || authors.some(a => a.strength === 'unknown')) return 'author_unknown';
  if (authors.some(a => a.model === reviewer.model)) return 'same_model';
  return null;
}

function gate(): void {
  const round = Number(env('ROUND'));
  const pick = (k: string): unknown[] =>
    Array.from({ length: round }, (_, i) => json(`${k}${String(i + 1)}`));
  const reviews = pick('R') as (Review | null)[];
  const rechecks = pick('C') as Accept[];
  const tag = env('TAG');
  const reviewFile = join(artifacts, `${tag}.review.json`);
  writeFileSync(reviewFile, JSON.stringify(reviews.at(-1), null, 2));
  const risk = effectiveRisk(env('RISK'), rechecks);
  const decision = {
    reviews,
    rechecks,
    risk,
    strict: plan().mode === 'strict',
    expired: expired(),
    reviewRequired: env('REVIEW') !== '0',
    permissions:
      env('ARCHON') && !expired()
        ? permissionEvidence(runEvents(), env('PKGS').split(','), env('MILESTONE'))
        : [],
  };
  let d = decide(decision);
  const tested = d.reason === 'review_not_required';
  const reviewed = reviews
    .map((r, i) => (r ? i : -1))
    .filter(i => i >= 0)
    .at(-1);
  const m = env('MILESTONE');
  const fake = { model: 'fake', strength: 'fake' } as const;
  let identity: { authors: Ident[]; reviewer: Ident } | null = null;
  if (
    reviewed !== undefined &&
    (d.verdict === 'pass' ||
      (d.reason === 'no_change' && rechecks.at(-1)?.ok && reviews.at(-1) === null))
  ) {
    const done = env('ARCHON') ? runEvents().filter(e => e.event_type === 'node_completed') : [];
    const author = new RegExp(
      `^((code|repair)-(${env('PKGS').split(',').join('|')})|fix-${m}-r\\d)$`
    );
    const reviewer = `review-${m}-r${String(reviewed + 1)}`;
    const attempts = readPolicyAttempts(artifacts);
    identity = env('ARCHON')
      ? {
          authors: done
            .filter(e => author.test(e.step_name ?? ''))
            .map(e => attemptIdentity(attempts, e.step_name ?? '', e.data?.binding)),
          reviewer: attemptIdentity(
            attempts,
            reviewer,
            done.filter(e => e.step_name === reviewer).at(-1)?.data?.binding
          ),
        }
      : { authors: [fake], reviewer: { ...fake, model: 'fake-reviewer' } };
  }
  const why = identity ? independence(identity.authors, identity.reviewer) : 'reviewer_unknown';
  if (identity && rechecks.at(-1)?.same) d = decide({ ...decision, qualifiedReview: why === null });
  const ledgerFile = join(artifacts, `${tag}.ledger.json`);
  writeFileSync(ledgerFile, JSON.stringify(d.ledger, null, 2));
  let grade: string | null = tested ? 'TESTED' : null;
  if (d.verdict === 'pass' && !tested) {
    grade = why ? 'DEGRADED_PASS' : 'PASS';
    if (why)
      Object.assign(
        d,
        plan().mode === 'strict' || risk === 'G2'
          ? { verdict: 'escalate', reason: `review_not_independent:${why}` }
          : { reason: `review_not_independent:${why}` }
      );
  }
  const over =
    d.verdict === 'fix' || d.verdict === 'pass'
      ? budget(d.verdict === 'fix' || Boolean(env('NEXT')))
      : null;
  if (over) Object.assign(d, { verdict: 'escalate', reason: over });
  if (d.verdict === 'pass' && rechecks.at(-1)?.same && reviewed !== undefined)
    writeFileSync(reviewFile, JSON.stringify(reviews[reviewed], null, 2));
  d.decision = {
    ...d.decision,
    kind:
      d.verdict === 'escalate'
        ? 'block'
        : d.verdict === 'fix'
          ? 'repair'
          : d.debt.length
            ? 'debt'
            : 'advance',
    reason: d.reason,
    debt: d.debt,
  };
  const { ledger: _, ...rest } = d;
  void _;
  const out = {
    ...rest,
    grade: d.verdict === 'pass' ? grade : null,
    risk,
    identity,
    milestone: env('MILESTONE'),
    review_file: reviewFile,
    ledger_file: ledgerFile,
    // 末份非空评审所见的 HEAD：下一轮 diff 以它为增量起点（F-20）；尚无评审为空，下一轮评审做全量
    reviewed_head: reviewed === undefined ? '' : (rechecks[reviewed].head ?? ''),
    head: git('rev-parse', 'HEAD').trim(),
  };
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  emit(out);
  if (out.verdict === 'escalate') {
    console.error(
      `${tag}: escalate (${out.reason ?? ''}) after ${String(out.rounds)} review round(s)`
    );
    process.exit(1);
  }
}

// prettier-ignore
export function landTarget(repo: string, base: string, launch: () => string | undefined): string | undefined {
  const local = (name: string): boolean => {
    const p = auxiliary(['git', '-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    if (p.exitCode !== 0 && p.exitCode !== 1) throw new Error(p.stderr.toString());
    return p.exitCode === 0;
  };
  const target = [base.replace(/^refs\/heads\//, ''), base.replace(/^origin\//, '')].find(local);
  const branch = !target && /^[a-f0-9]{7,64}$/i.test(base) ? launch() : undefined;
  return target ?? (typeof branch === 'string' && local(branch) ? branch : undefined);
}

/** 打印合入命令与各里程碑末轮 gate 的评审债；plan deadline 已过则拒绝（exit 1），不给出合入命令。 */
function land() {
  if (expired()) {
    console.error(`land: plan deadline ${plan().deadline} passed; not producing merge commands`);
    process.exit(1);
  }
  const repo = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const base = env('BASE_REF');
  const target = landTarget(repo, base, () => {
    const path = env('OPERATOR_LEDGER');
    const ledger =
      path && existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as Pick<OperatorLedger, 'launch_branch'>)
        : undefined;
    return ledger?.launch_branch;
  });
  const ff =
    target !== undefined &&
    Bun.spawnSync(['git', 'merge-base', '--is-ancestor', `refs/heads/${target}`, 'HEAD'])
      .exitCode === 0;
  const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  // 轮次 ≤ 3：文件名字典序即轮次序，同一里程碑后写的覆盖先写的
  const last = new Map<string, string[]>();
  for (const f of readdirSync(artifacts)
    .filter(x => /^gate-.+-r\d+\.json$/.test(x))
    .sort()) {
    const g = JSON.parse(readFileSync(join(artifacts, f), 'utf8')) as {
      debt: string[];
      grade?: string | null;
      reason?: string | null;
    };
    last.set(f.replace(/-r\d+\.json$/, ''), [
      ...g.debt,
      ...(g.grade === 'DEGRADED_PASS' ? [`DEGRADED_PASS ${g.reason ?? ''}`] : []),
    ]);
  }
  const out = {
    branch,
    repo,
    target,
    ff,
    head: git('rev-parse', 'HEAD').trim(),
    ...(!target
      ? {
          reason: 'land_target_unknown',
          error: `No existing local merge target for base_ref ${base}; no recorded launch branch applies.`,
          action:
            'Choose and verify a local branch with git show-ref --verify refs/heads/<branch>, then review and merge manually.',
        }
      : {}),
    commands: target
      ? [
          `git -C ${q(repo)} switch ${q(target)}`,
          `git -C ${q(repo)} merge ${ff ? '--ff-only' : '--no-ff'} ${q(branch)}`,
        ]
      : [],
    debt: [...last.values()].flat(),
  };
  writeFileSync(join(artifacts, 'land.json'), JSON.stringify(out, null, 2));
  emit(out);
  if (!target) process.exit(1);
  return out;
}
export type Land = ReturnType<typeof land>;

if (import.meta.main) {
  const kinds: Partial<Record<string, () => void>> = {
    env: environment,
    accept,
    settle,
    gate,
    land,
  };
  const fn = kinds[env('KIND')];
  if (!fn) throw new Error(`sa-check: unknown INPUTS_KIND ${env('KIND')}`);
  fn();
}
