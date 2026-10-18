// superagent 确定性节点（bun）：INPUTS_KIND 选择环境/验收/交付判定/合入命令；永不 push。
import reasons from './reasons.json';
import { checkoutFingerprint } from './checkout-integrity';
import { prepareContext } from './sa-context';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
// 只引类型：Bun 转译时擦除，复制到 gen 目录后不依赖 src/
import type { Check, Plan, Pkg } from '../../../src/plan';
import type { Ledger as OperatorLedger } from '../../../src/cli';
import { budgetReason, readPolicyAttempts, type PolicyAttempt } from './policy-attempts';
import { FAILURE_CLASSES, failureClass, type FailureClass } from './failure-class';
import { nativeEvidence } from './native-models';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';
import { envPrecheck, provisionEnvironment } from './env-precheck';

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
  blockers?: string[];
}
type Disposition = 'advance' | 'repair' | 'adjudicate' | 'fail';
type RequirementContract = Pick<Pkg, 'id' | 'accept' | 'requirements'>;
interface CommandResult {
  check: Check;
  pass: boolean | null;
  evidence: string;
  exit?: number | string;
  structured?: StructuredCases;
}
// prettier-ignore
interface StructuredCases { complete: boolean; tests: number; ids: string[]; skipped: string[]; failures: { id: string; type: string; message: string; body_hash: string }[]; failure_digest: string; report: string }
// prettier-ignore
interface Adjudication { diff_hash: string; contract_hash: string; command: string; failed_tests: string[]; failure_digest: string; report: string; counts: { candidate: number; base: number; expected: number; expected_base: number }; known: { id: string; reason: string }[]; cases: { id: string; message: string; base: 'failed' | 'passed' }[] }
export interface Completion {
  status: 'legacy' | 'verified' | 'unmet' | 'unknown';
  items: {
    package: string;
    id: string;
    text: string;
    status: 'verified' | 'unmet' | 'unknown';
    evidence: string[];
  }[];
}
export type DeliveryDecision = {
  [K in 'advance' | 'debt' | 'repair' | 'block']: {
    kind: K;
    reason: string | null;
    evidence: string[];
    debt: string[];
    requirements?: Completion;
    blockers?: Coder['blockers'];
    needs?: Coder['needs'];
  };
}['advance' | 'debt' | 'repair' | 'block'];
export interface Accept {
  ok: boolean;
  decision?: DeliveryDecision;
  milestone?: string;
  diff_hash: string;
  same: boolean;
  reviewed?: boolean;
  no_changes?: boolean;
  head?: string;
  checkout_fingerprint?: string;
  contract_hash?: string;
  risk?: string | null;
  out_of_scope?: string[];
  disposition?: Disposition;
  reason?: string | null;
  failed?: string[];
  log?: string;
  base_pass?: boolean | null;
  // prettier-ignore
  base_results?: { cmd: string; pass: boolean | null; reason?: string; structured?: StructuredCases }[];
  baseline?: 'comparable' | 'incomparable';
  baseline_reason?: string;
  failures?: CheckFailure[];
  workspace_clean?: boolean;
  requirement_contract?: RequirementContract[];
  command_results?: CommandResult[];
  adjudication?: Adjudication;
}
// prettier-ignore
export interface CheckFailure {
  command: string; failure_class: FailureClass; evidence: string;
  repair_rounds?: number; debt_reason?: 'repair_limit';
  failed_tests?: string[]; failure_digest?: string; adjudicated?: boolean;
}
/** sa-check uses these fields from the complete frozen <gen>/policy.json. */
interface Policy {
  risk_paths: string[];
  code_extensions: string[];
  exempt_paths: string[];
  budget_floor: Record<string, number>;
}
interface ReviewEffortPolicy {
  effort: {
    reviewer: Record<string, string>;
    G2_reviewer: Record<string, string>;
  };
}

/** The shared R1..Rn policy ladder is the sole owner of the review-round limit. */
export function reviewRoundLimit(policy: ReviewEffortPolicy): number {
  const rounds = (values: Record<string, string>): string[] =>
    Object.keys(values).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const expected = rounds(policy.effort.reviewer);
  if (
    !expected.length ||
    expected.some((round, index) => round !== `R${String(index + 1)}`) ||
    JSON.stringify(rounds(policy.effort.G2_reviewer)) !== JSON.stringify(expected)
  )
    throw new Error('tiers.policy.effort: reviewer round ladders must be equal and contiguous');
  return expected.length;
}

const env = (k: string): string => process.env[`INPUTS_${k}`] ?? '';
export const CHECK_AUX_TIMEOUT_MS = 10_000;
// Elapsed auxiliary time has one shared cap, independent of subprocess count.
export const CHECK_AUX_BUDGET_MS = 130_000;
let auxiliaryElapsed = 0;
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
  const timeout = Math.floor(
    Math.min(CHECK_AUX_TIMEOUT_MS, CHECK_AUX_BUDGET_MS - auxiliaryElapsed)
  );
  if (bounded && timeout <= 0) throw new Error('auxiliary time budget exhausted');
  const started = performance.now();
  const result = Bun.spawnSync(
    bounded ? ['python3', '-c', AUX_WATCHDOG, String(timeout), ...cmd] : cmd,
    {
      stdout: 'pipe',
      stderr: 'pipe',
      ...(bounded ? { timeout, killSignal: 'SIGKILL' as const } : {}),
    }
  );
  if (bounded) auxiliaryElapsed += performance.now() - started;
  return result;
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
const policy = (): Policy & ReviewEffortPolicy =>
  JSON.parse(readFileSync(env('POLICY'), 'utf8')) as Policy & ReviewEffortPolicy;
const emit = (o: unknown): void => {
  const code = (o as { reason?: unknown }).reason;
  if (typeof code === 'string' && !reasons.some(r => r.code === code))
    throw new Error(`unregistered reason: ${code}`);
  console.log(JSON.stringify(o));
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const glob = (g: string, p: string): boolean => new Bun.Glob(g).match(p);
const readCheckoutFingerprint = (value?: string): string => {
  if (!value || value.startsWith('[')) return value ?? '';
  try {
    const path = realpathSync(value);
    return dirname(path) === realpathSync(artifacts) && basename(path).endsWith('.fingerprint.json')
      ? readFileSync(path, 'utf8')
      : '';
  } catch {
    return '';
  }
};
// prettier-ignore
const xmlText = (s: string): string => s.replace(/&(?:lt|gt|amp|quot|apos);/g,
  x => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" })[x] ?? x);
// prettier-ignore
const attrs = (s: string): Record<string, string | undefined> => Object.fromEntries(
  [...s.matchAll(/([:\w.-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1], xmlText(m[3])]));
// prettier-ignore
function validXml(xml: string): boolean {
  const tags = [...xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:"[^"]*"|'[^']*'|[^'">])*>/g)], stack: string[] = [];
  const bad = /&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);)/i, attr = /\s+([:\w.-]+)\s*=\s*(["'])(.*?)\2/gs;
  let end = 0, roots = 0;
  for (const match of tags) {
    const text = xml.slice(end, match.index), token = match[0]; end = match.index + token.length;
    if (bad.test(text) || (!stack.length && text.trim())) return false;
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) { if (!stack.length) return false; continue; }
    if (token.startsWith('<!')) return false;
    const raw = token.slice(1, -1).trim(), closing = raw.startsWith('/'), name = /^\/?([:\w.-]+)/.exec(raw)?.[1];
    if (!name) return false;
    if (closing) { if (raw !== `/${name}` || stack.pop() !== name) return false; continue; }
    const selfClosing = /\/\s*$/.test(raw), tail = raw.slice(name.length).replace(/\/\s*$/, ''), parsed = [...tail.matchAll(attr)];
    if (tail.replace(attr, '').trim() || parsed.some(m => m[3].includes('<') || bad.test(m[3])) || new Set(parsed.map(m => m[1])).size !== parsed.length) return false;
    if (!stack.length && ++roots > 1) return false;
    if (!selfClosing) stack.push(name);
  }
  return roots === 1 && !stack.length && !xml.slice(end).trim() && !bad.test(xml.slice(end));
}
// prettier-ignore
function junitCases(path: string, expected: string[], started: number): StructuredCases | undefined {
  try {
    if (!existsSync(path) || statSync(path).mtimeMs < started) return;
    const xml = readFileSync(path, 'utf8');
    if (!validXml(xml)) return;
    const elements = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    if (/<error\b/.test(elements)) return;
    if (![...elements.matchAll(/<testsuite\b([^>]*)>/g)].some(m => Number(attrs(m[1]).tests) > 0))
      return;
    const cases = [...elements.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
    const ids: string[] = [], skipped: string[] = [], failures: StructuredCases['failures'] = [];
    for (const match of cases) {
      const a = attrs(match[1]),
        id = `${a.classname ?? ''}::${a.name ?? ''}`,
        body = match[2] || '';
      if (!a.classname || !a.name || ids.includes(id) || /<error\b/.test(body)) return;
      ids.push(id);
      if (/<skipped\b/.test(body)) skipped.push(id);
      const f = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(body);
      if (f) {
        const fa = attrs(f[1] || f[3] || ''), text = xmlText(f[2] || '');
        failures.push({ id, type: fa.type ?? '', message: fa.message ?? '', body_hash: sha(text) });
      }
    }
    const sorted = [...failures].sort((a, b) => a.id.localeCompare(b.id));
    const complete = ids.length > 0 && new Set(ids).size === ids.length &&
      JSON.stringify([...ids].sort()) === JSON.stringify([...expected].sort());
    return {
      complete,
      tests: ids.length,
      ids,
      skipped,
      failures: sorted,
      failure_digest: sha(JSON.stringify(sorted.map(f => [f.id, f.type, f.message, f.body_hash]))),
      report: path,
    };
  } catch {
    return;
  }
}

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

// Pack scripts cannot import the engine; tests enforce this copy against its owner.
export const NODE_CONTRACT_ENV: readonly string[] = [
  'ARTIFACTS_DIR',
  'STATE_DIR',
  'LOG_DIR',
  'ADOPTED_RUN_DIR',
  'WORKFLOW_ID',
  'BASE_BRANCH',
  'USER_MESSAGE',
  'ARGUMENTS',
  'LOOP_USER_INPUT',
  'LOOP_PREV_OUTPUT',
  'REJECTION_REASON',
  'CONTEXT',
  'EXTERNAL_CONTEXT',
  'ISSUE_CONTEXT',
  'TYPED_ARTIFACTS_FILE',
  'ARCHON_NODE_EXECUTION',
];
// Shell/session and engine invocation metadata is not part of the project command contract.
// Keep this auth exception aligned with packages/paths/src/strip-cwd-env.ts.
const CLAUDE_CODE_AUTH_ENV = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);
const RUNTIME_ENVIRONMENT = [
  /^_$/,
  /^(?:PWD|OLDPWD|SHLVL|TERM.*|COLORTERM|TTY|TMUX.*|ZELLIJ.*|ITERM_.*|SSH_TTY|LC_TERMINAL.*)$/,
  /^(?:ARCHON|SUPERAGENT)_(?:RUN|SESSION|NODE|WORKFLOW|DETACHED)(?:_.*)?$/,
  /^(?:CLAUDE_PID|AI_AGENT|CODEX_COMPANION(?:_.*)?)$/,
];
const runtimeEnvironment = (key: string): boolean =>
  RUNTIME_ENVIRONMENT.some(pattern => pattern.test(key)) ||
  key === 'CLAUDECODE' ||
  (key.startsWith('CLAUDE_CODE_') && !CLAUDE_CODE_AUTH_ENV.has(key));
export const projectEnvironment = (values: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(values).filter(
      ([k]) =>
        !k.startsWith('INPUTS_') &&
        !NODE_CONTRACT_ENV.includes(k) &&
        !runtimeEnvironment(k) &&
        !['SA_COORD_ADMISSION', 'SUPERAGENT_ROLE'].includes(k)
    )
  ),
  PYTHONDONTWRITEBYTECODE: '1',
});
export const environmentIdentity = (values: NodeJS.ProcessEnv): string =>
  createHmac('sha256', cacheKey())
    .update(
      JSON.stringify(
        Object.keys(values)
          .sort()
          .map(k => [k, values[k]])
      )
    )
    .digest('hex');

const acceptanceCachePath = (
  tree: string,
  check: Check,
  envKey: string,
  environment: string
): string =>
  join(
    artifacts,
    'accept-cache',
    sha(
      JSON.stringify([
        'hmac-v2',
        FAILURE_CLASSES,
        tree,
        check.cmd,
        check.timeout_s,
        'junit-v2',
        check.report ?? null,
        check.known_failures ?? null,
        envKey,
        environment,
      ])
    )
  );

/** Read-only landing probe: preparation is unnecessary only when every check has usable evidence. */
export function acceptanceCacheReady(cwd = process.cwd()): boolean {
  const p = plan(),
    ids = env('PKGS').split(',').filter(Boolean);
  const packages = p.packages.filter(pkg => ids.includes(pkg.id));
  const checks = packages.flatMap(pkg => pkg.accept);
  // prettier-ignore
  const requirements = packages.map(({ id, accept, requirements }) => ({ id, accept, ...(requirements ? { requirements } : {}) }));
  // prettier-ignore
  const envKey = sha(JSON.stringify(packages.some(pkg => pkg.requirements) ? [environmentChecks(p), requirements] : environmentChecks(p)));
  const tree = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', 'HEAD^{tree}'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHECK_AUX_TIMEOUT_MS,
  });
  if (tree.exitCode !== 0) return false;
  const environment = environmentIdentity(projectEnvironment(process.env));
  return checks.every(check => {
    if (check.cache === false) return false;
    const path = acceptanceCachePath(tree.stdout.toString().trim(), check, envKey, environment);
    if (!existsSync(path)) return false;
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as {
        failure?: CheckFailure | null;
        pass?: boolean;
        exit?: number | string;
        structured?: StructuredCases;
      };
      if (saved.failure || saved.pass === false || (saved.exit !== undefined && saved.exit !== 0))
        return false;
      if (!check.report) return true;
      const structured = saved.structured;
      return (
        !!structured &&
        typeof structured === 'object' &&
        'complete' in structured &&
        structured.complete
      );
    } catch {
      return false;
    }
  });
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
  failures: CheckFailure[] = [],
  results: CommandResult[] = []
): string[] {
  const failed: string[] = [];
  // These variables belong to the engine node, not the project acceptance command (including probes).
  // Environment nodes keep their existing inherited environment.
  const commandEnv = env('KIND') === 'env' ? process.env : projectEnvironment(process.env);
  const treeResult =
    artifacts && envKey
      ? auxiliary(
          cwd ? ['git', '-C', cwd, 'rev-parse', 'HEAD^{tree}'] : ['git', 'rev-parse', 'HEAD^{tree}']
        )
      : undefined;
  const tree = treeResult?.exitCode === 0 ? treeResult.stdout.toString().trim() : '';
  const environment =
    tree && checks.some(c => c.cache !== false) ? environmentIdentity(commandEnv) : '';
  for (const c of checks) {
    const hit = tree && c.cache !== false ? acceptanceCachePath(tree, c, envKey, environment) : '';
    if (hit && existsSync(hit)) {
      const saved = JSON.parse(readFileSync(hit, 'utf8')) as {
        tag: string;
        failure: CheckFailure | null;
        pass?: boolean;
        exit?: number | string;
        stdout?: string;
        stderr?: string;
        structured?: StructuredCases;
      };
      if (
        saved.failure ||
        saved.pass === false ||
        (saved.exit !== undefined && saved.exit !== 0) ||
        (c.report && saved.structured?.complete !== true)
      ) {
        // Older or incomplete adapter output cannot prove structured acceptance.
      } else {
        appendFileSync(
          log,
          `$ ${c.cmd}\n# reused pass from ${saved.tag}\n${saved.stdout ?? ''}${saved.stderr ?? ''}\n`
        );
        results.push({
          check: c,
          pass: saved.pass ?? (saved.exit === undefined ? null : true),
          exit: saved.exit,
          evidence: log,
          ...(saved.structured ? { structured: saved.structured } : {}),
        });
        continue;
      }
    }
    const t0 = Date.now();
    let reportPath = '';
    let expected: string[] = [];
    if (c.report) {
      reportPath = resolve(cwd ?? process.cwd(), c.report.junit);
      const rel = relative(cwd ?? process.cwd(), reportPath);
      if (rel === '..' || rel.startsWith('../') || rel === '')
        throw new Error('junit report path escapes cwd');
      rmSync(reportPath, { force: true });
      if (c.report.collect) {
        const collected = Bun.spawnSync(['bash', '-c', c.report.collect], {
          cwd,
          env: commandEnv,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: c.timeout_s * 1000,
        });
        if (collected.exitCode === 0 && !collected.signalCode)
          expected = collected.stdout
            .toString()
            .split(/\r?\n/)
            .map(x => x.trim())
            .filter(Boolean);
      }
    }
    const p = Bun.spawnSync(['bash', '-c', c.cmd], {
      cwd,
      env: commandEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: c.timeout_s * 1000,
    });
    const code = p.signalCode ? `signal ${p.signalCode}` : p.exitCode;
    const structured = reportPath ? junitCases(reportPath, expected, t0) : undefined;
    const consistent =
      !structured ||
      (!p.signalCode &&
        (code === 0) === (structured.failures.length === 0) &&
        (code === 0 || structured.failures.length > 0));
    if (structured && !consistent) structured.complete = false;
    const passed = code === 0 && (!c.report || structured?.complete === true);
    results.push({
      check: c,
      pass: passed,
      evidence: log,
      exit: code,
      ...(structured ? { structured } : {}),
    });
    appendFileSync(
      log,
      `$ ${c.cmd}\n${p.stdout.toString()}${p.stderr.toString()}# exit=${String(code)} ms=${String(Date.now() - t0)}\n\n`
    );
    if (!passed) {
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
      const failure: CheckFailure = {
        command: c.cmd,
        failure_class: failureClass(classification),
        evidence: log,
        ...(structured
          ? {
              failed_tests: structured.failures.map(f => f.id),
              failure_digest: structured.failure_digest,
            }
          : {}),
      };
      if (structured?.complete) failure.failure_class = 'unknown';
      failures.push(failure);
    }
    if (hit && passed) {
      mkdirSync(dirname(hit), { recursive: true });
      writeFileSync(
        hit,
        JSON.stringify({
          tag: env('TAG'),
          failure: null,
          pass: passed,
          exit: code,
          stdout: p.stdout.toString(),
          stderr: p.stderr.toString(),
          structured,
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

/** Route structured blocks without turning acceptance failures into human waits. */
export function nextDisposition(decision: DeliveryDecision): Disposition {
  const reason = reasons.find(r => r.code === decision.reason);
  if (
    decision.kind === 'block' &&
    ['coder_partial', 'coder_needs', 'no_change'].includes(decision.reason ?? '')
  )
    return 'fail';
  if (decision.kind === 'block') {
    if (decision.reason === 'acceptance_adjudication') return 'adjudicate';
    return reason?.hold === 'review_limit' || reason?.hold === 'redline' ? 'fail' : 'repair';
  }
  return decision.kind === 'repair' ? 'repair' : 'advance';
}

/** Compatibility wiring is a projection of the delivery decision, never a second policy. */
export function disposition(
  raw: string,
  ok: boolean,
  check?: Accept,
  permissions: string[] = [],
  selfReportPath?: string,
  reviewRounds?: number
) {
  const { decision: judged, audit } = deliveryDecision({
    rechecks: [check ?? { ok, diff_hash: '', same: false }],
    permissions,
    selfReport: raw,
    selfReportPath,
    reviewRounds: reviewRounds ?? null,
  });
  const decision = judged;
  return {
    ...audit,
    decision,
    disposition: nextDisposition(decision),
    reason: decision.reason,
  };
}

const RISKS = ['G0', 'G1', 'G2'] as const;
const maxRisk = (...rs: (string | null | undefined)[]): Plan['packages'][number]['risk'] =>
  RISKS[Math.max(0, ...rs.map(r => RISKS.findIndex(v => v === r)))];

/** Routing and the gate consume the same structured acceptance risks, never infer them twice. */
export const effectiveRisk = (
  declared: string,
  rechecks: (Pick<Accept, 'risk'> | null)[]
): Plan['packages'][number]['risk'] => maxRisk(declared, ...rechecks.map(c => c?.risk));

/** `git diff --raw -z -M` 的逐项：状态、两侧 mode、路径（重命名/复制为源与目标）。 */
function changes(base: string): { modes: string[]; paths: string[] }[] {
  const f = git(
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--raw',
    '-z',
    '-M',
    base,
    'HEAD',
    '--'
  ).split('\0');
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
 * F-13 交付证据（不是沙箱）：实际 candidate tree 对照 scope.write 并记录越界路径。
 * gitlink/symlink 或 risk_paths 推断 G2；代码文件推断 G1。有效风险 = max(声明, 推断)。
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
  const riskGlob = (g: string, p: string): boolean =>
    glob(g.toLowerCase(), (g.includes('/') ? p : basename(p)).toLowerCase());
  const inferred = ch.map(c =>
    c.modes.some(m => m === '160000' || m === '120000') ||
    c.paths.some(p => pol.risk_paths.some(g => riskGlob(g, p)))
      ? 'G2'
      : c.paths.some(p => pol.code_extensions.some(e => p.endsWith(e)))
        ? 'G1'
        : 'G0'
  );
  return { risk: maxRisk(declared, ...inferred), out_of_scope };
}

/** Shared with land's read-only reuse probe; a commit binds the accepted tree. */
// prettier-ignore
export function acceptanceContractHash(): string {
  return sha(JSON.stringify([plan(), env('PKGS').split(',').filter(Boolean), (env('SCOPE_PKGS') || env('PKGS')).split(','), env('BASE'), env('RISK'), environmentIdentity(projectEnvironment(process.env)), env('POLICY') ? readFileSync(env('POLICY'), 'utf8') : null]));
}
// prettier-ignore
export function reusableAcceptance(prior: Accept | undefined, head: string): boolean {
  const checks = plan().packages.filter(k => env('PKGS').split(',').includes(k.id)).flatMap(k => k.accept);
  return prior?.ok === true && prior.workspace_clean === true && prior.head === head && prior.contract_hash === acceptanceContractHash() && checks.every(c => c.cache !== false) && JSON.stringify(prior.command_results?.map(r => r.check)) === JSON.stringify(checks) && prior.command_results?.every(r => r.pass === true) === true;
}

/** Node-bound evidence may cover cache:false checks; it is not a cross-execution cache. */
function reusableNodeAcceptance(prior: Accept | undefined, head: string): boolean {
  const checks = plan()
    .packages.filter(k => env('PKGS').split(',').includes(k.id))
    .flatMap(k => k.accept);
  return (
    prior?.ok === true &&
    prior.workspace_clean === true &&
    prior.head === head &&
    prior.contract_hash === acceptanceContractHash() &&
    JSON.stringify(prior.command_results?.map(r => r.check)) === JSON.stringify(checks) &&
    prior.command_results?.every(r => r.pass === true) === true
  );
}

function nodeAcceptance(path: string, head: string): Accept | undefined {
  if (!path) return undefined;
  try {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as Accept;
    return reusableNodeAcceptance(prior, head) ? prior : undefined;
  } catch {
    return undefined;
  }
}

/** 一次验收：coder 处置 + 命令 + 干净工作区；有 BASE 时另存全量 patch、相对 DELTA_BASE 的增量 patch 与交付范围。 */
function acceptOnce(
  tag: string,
  coder: string
): Record<string, unknown> & Accept & { patch: string; delta: string } {
  const log = join(artifacts, `${tag}.log`);
  // retries may reuse this tag; cached failures still reference its original output.
  appendFileSync(log, '');
  const ids = env('PKGS').split(',').filter(Boolean);
  const p = plan();
  const pkgs = p.packages.filter(k => ids.includes(k.id));
  // 后续里程碑的 BASE 是前序 land head；前序包的已批准写入范围对本次增量仍有效。
  const scopeIds = (env('SCOPE_PKGS') || env('PKGS')).split(',');
  const covered = p.packages.filter(k => scopeIds.includes(k.id));
  const checks = pkgs.flatMap(k => k.accept);
  const requirementContract = pkgs.map(({ id, accept, requirements }) => ({
    id,
    accept,
    ...(requirements ? { requirements } : {}),
  }));
  // 声明环境契约与实际传入环境分别绑定；缓存上下文只属于本 run 的 ARTIFACTS_DIR。
  const envKey = sha(
    JSON.stringify(
      pkgs.some(k => k.requirements)
        ? [environmentChecks(p), requirementContract]
        : environmentChecks(p)
    )
  );
  const dirty = git('status', '--porcelain').trim();
  const failures: CheckFailure[] = [];
  const commandResults: CommandResult[] = [];
  if (dirty)
    appendFileSync(
      log,
      `# uncommitted changes (commit them; land only merges commits):\n${dirty}\n`
    );
  const base = env('BASE');
  const save = (name: string, from: string): string => {
    if (!base) return '';
    writeFileSync(
      join(artifacts, name),
      git('diff', '--no-ext-diff', '--no-textconv', '--binary', from, 'HEAD', '--')
    );
    return join(artifacts, name);
  };
  const patch = save(`${tag}.patch`, base);
  const delta = env('DELTA_BASE') ? save(`${tag}.delta.patch`, env('DELTA_BASE')) : patch;
  const noChanges = delta ? readFileSync(delta, 'utf8').length === 0 : undefined;
  const hash = patch ? sha(readFileSync(patch, 'utf8')).slice(0, 16) : '';
  const head = git('rev-parse', 'HEAD').trim();
  const prior = dirty ? undefined : nodeAcceptance(env('ACCEPTANCE_EVIDENCE'), head);
  const failed = prior
    ? []
    : run(checks, log, undefined, dirty ? '' : envKey, failures, commandResults);
  if (prior?.command_results) {
    commandResults.push(...prior.command_results);
    appendFileSync(log, `# reused stable acceptance from ${env('ACCEPTANCE_EVIDENCE')}\n`);
  }
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
  const reviewRounds = env('MILESTONE') || env('ARCHON') ? maxRounds() : undefined;
  // Generated diff artifact names are the engine's structured channel, not vendor prose.
  // On the final allowed round, unresolved acceptance must stop dispatching repairs.
  const reviewRound =
    Array.from(
      { length: reviewRounds ?? 0 },
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
  const incomparable =
    base && failed.length && (!baseResults.length || baseResults.some(r => r.pass === null));
  const baseline = {
    base_pass: incomparable || !baseResults.length ? null : baseResults.some(r => r.pass),
    ...(base && failed.length
      ? {
          baseline: incomparable ? ('incomparable' as const) : ('comparable' as const),
          baseline_reason: incomparable
            ? baseResults
                .filter(r => r.pass === null)
                .map(r => r.reason)
                .join('; ') || 'baseline environment unavailable; see probe log'
            : '',
        }
      : {}),
  };
  if (baseResults.length) appendFileSync(log, `# base_results: ${JSON.stringify(baseResults)}\n`);
  else if (base && failed.length)
    appendFileSync(log, `# baseline unknown: see ${join(artifacts, `${tag}.probe.log`)}\n`);
  let adjudication: Adjudication | undefined;
  // prettier-ignore
  for (const failure of failures) {
    const candidate = commandResults.find(r => r.check.cmd === failure.command)?.structured;
    const baselineResult = baseResults.find(r => r.cmd === failure.command)?.structured;
    if (!candidate || !baselineResult || !candidate.complete || !baselineResult.complete) continue;
    if (candidate.skipped.some(id => !baselineResult.skipped.includes(id))) continue;
    const known = checks.find(c => c.cmd === failure.command)?.known_failures ?? [];
    const baseFailed = new Set(baselineResult.failures.map(f => f.id));
    const unexplained = candidate.failures.filter(
      f => !baseFailed.has(f.id) && !known.some(k => k.id === f.id)
    );
    if (unexplained.length) {
      failure.failure_class = 'product';
      continue;
    }
    if (p.mode === 'strict' || scope.risk === 'G2') continue;
    const pending: Adjudication = {
      diff_hash: hash,
      contract_hash: acceptanceContractHash(),
      command: failure.command,
      failed_tests: candidate.failures.map(f => f.id).sort(),
      failure_digest: candidate.failure_digest,
      report: candidate.report,
      counts: { candidate: candidate.tests, base: baselineResult.tests,
        expected: candidate.ids.length, expected_base: baselineResult.ids.length },
      known: known.filter(k => candidate.failures.some(f => f.id === k.id)),
      cases: candidate.failures.map(f => ({ id: f.id, message: f.message,
        base: baseFailed.has(f.id) ? 'failed' : 'passed' })),
    };
    const approvalPath = join(dirname(env('PLAN')), 'approvals', `${tag}.json`);
    let approvals: Partial<Adjudication>[] = [];
    try {
      const saved = JSON.parse(readFileSync(approvalPath, 'utf8')) as
        Partial<Adjudication> & { approvals?: Partial<Adjudication>[] };
      approvals = Array.isArray(saved.approvals) ? saved.approvals : [saved];
    } catch { /* not adjudicated */ }
    const identity = ['diff_hash', 'contract_hash', 'command', 'failure_digest'] as const;
    const approved = approvals.find(a => identity.every(k => a[k] === pending[k]) &&
      JSON.stringify(a.failed_tests) === JSON.stringify(pending.failed_tests));
    if (approved) {
      failure.failure_class = candidate.failures.some(f => known.some(k => k.id === f.id))
        ? 'test_env'
        : 'baseline';
      failure.adjudicated = true;
      failure.evidence = `${approvalPath}; ${candidate.report}`;
    } else adjudication ??= pending;
  }
  const result = disposition(
    coder,
    ok,
    {
      ok,
      requirement_contract: requirementContract,
      command_results: commandResults,
      diff_hash: hash,
      no_changes: noChanges,
      same: false,
      failed,
      failures,
      ...(adjudication ? { adjudication } : {}),
      workspace_clean: !dirty,
      log,
      ...baseline,
    },
    env('ARCHON') && reviewRounds !== undefined
      ? permissionEvidence(runEvents(), ids, env('MILESTONE'), reviewRounds)
      : [],
    join(artifacts, `${tag}.coder.json`),
    reviewRounds
  );
  if (reviewRounds !== undefined && reviewRound >= reviewRounds && result.disposition === 'repair')
    Object.assign(result, {
      disposition: 'fail',
      reason: 'acceptance_failed+review_limit',
      decision: { ...result.decision, kind: 'block', reason: 'acceptance_failed+review_limit' },
    });
  saveCoder(tag, coder, result.error_class_ignored);
  const fingerprint = join(artifacts, `${tag}.fingerprint.json`);
  writeFileSync(
    fingerprint,
    checkoutFingerprint(args => auxiliary(['git', ...args]))
  );
  // 存档一份：supervise-tick 自动重试时据此写失败命令与日志尾的提示
  return {
    ok,
    requirement_contract: requirementContract,
    command_results: commandResults,
    milestone: env('MILESTONE'),
    ...result,
    failed,
    failures,
    ...(adjudication ? { adjudication } : {}),
    workspace_clean: !dirty,
    log,
    patch,
    delta,
    no_changes: noChanges,
    diff_hash: hash,
    contract_hash: acceptanceContractHash(),
    // 相同 diff 跳过新评审；gate 仍须核验候选、契约与既有独立评审证据。
    same: env('PREV') !== '' && hash === env('PREV'),
    reviewed: env('REVIEWED_DIFF_HASH') !== '' && hash === env('REVIEWED_DIFF_HASH'),
    base_results: baseResults,
    ...baseline,
    ...scope,
    head,
    checkout_fingerprint: fingerprint,
  };
}

/** 写 <tag>.json 并输出；失败 exit 1，run 终止在本节点，后续包与评审都不启动。 */
function finish(
  tag: string,
  out: Record<string, unknown> &
    Accept &
    Partial<Pick<ReturnType<typeof acceptOnce>, 'patch' | 'delta'>>
): void {
  const over = out.disposition === 'fail' ? null : budget();
  if (over) Object.assign(out, { budget_advisory: over });
  const gen = dirname(env('PLAN'));
  if (existsSync(join(gen, 'execution.json'))) {
    const reviewRound =
      Array.from(
        { length: maxRounds() },
        (_, i) => `diff-${env('MILESTONE')}-r${String(i + 1)}`
      ).indexOf(tag) + 1;
    const node = reviewRound
      ? `review-${env('MILESTONE')}-r${String(reviewRound)}`
      : tag === `verify-${env('PKGS')}`
        ? `repair-${env('PKGS')}`
        : '';
    if (node) {
      const context = prepareContext({
        gen,
        artifacts,
        node,
        cwd: process.cwd(),
        base: env('BASE'),
        head: out.head ?? '',
        deltaBase: env('DELTA_BASE'),
        acceptance: out,
        patch: out.patch ?? '',
        delta: out.delta ?? '',
        environment: environmentIdentity(projectEnvironment(process.env)),
      });
      writeFileSync(
        join(artifacts, `${node}.context.json`),
        JSON.stringify({
          path: context,
          attempt: readAttempt(attemptPath(gen, env('MILESTONE'))),
        })
      );
    }
  }
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  // Audit/control evidence stays in the artifact; downstream packages consume only delivered data.
  const delivered = { diff_hash: out.diff_hash, head: out.head };
  emit(env('KIND') === 'settle' && out.disposition !== 'fail' ? delivered : out);
  if (out.disposition === 'fail' || out.disposition === 'adjudicate') {
    console.error(`${tag}: failed (${out.reason ?? ''})`);
    process.exit(1);
  }
}

function accept(): void {
  const tag = env('TAG'),
    carried = env('CARRIED_EVIDENCE'),
    attempt = env('ATTEMPT');
  if (!carried || attempt !== '0') {
    finish(tag, acceptOnce(tag, env('CODER')));
    return;
  }
  const prior = JSON.parse(readFileSync(carried, 'utf8')) as Record<string, unknown> & Accept;
  const kind = prior.decision?.kind;
  if (kind !== 'advance' && kind !== 'debt')
    throw new Error(`carried evidence decision must be advance/debt, got ${String(kind)}`);
  if (typeof prior.head !== 'string') throw new Error('carried evidence head is missing');
  const ancestor = auxiliary(['git', 'merge-base', '--is-ancestor', '--', prior.head, 'HEAD']);
  if (ancestor.exitCode !== 0 || ancestor.signalCode)
    throw new Error(`carried evidence head is not an ancestor of HEAD: ${prior.head}`);
  const out = { ...prior, tag };
  writeFileSync(join(artifacts, `${tag}.json`), JSON.stringify(out, null, 2));
  emit(out);
}

/**
 * 包内修复后的结算：没有修复（verify 已 advance）就沿用 verify 的验收证据；修过则用修复输出重验，
 * 仍未 advance 即失败 repair_exhausted:<原因>——每包只有一次修复机会，不在包级循环烧调用。
 */
function settle(): void {
  const tag = env('TAG');
  const first = env('FIRST');
  const repaired = env('REPAIRED');
  if (!repaired || repaired === 'null') {
    if (first !== 'advance') throw new Error(`${tag}: repair skipped but verify did not advance`);
    const verifyArtifact = join(artifacts, `${tag.replace(/^settle-/, 'verify-')}.json`);
    finish(
      tag,
      JSON.parse(readFileSync(verifyArtifact, 'utf8')) as Record<string, unknown> & Accept
    );
    return;
  }
  const out = acceptOnce(tag, repaired);
  if (out.disposition === 'repair') {
    const reason = reasons.some(r => r.code === `repair_exhausted:${out.reason ?? ''}`)
      ? `repair_exhausted:${out.reason ?? ''}`
      : 'acceptance_failed+review_limit';
    Object.assign(out, {
      disposition: 'fail',
      repair_reason: out.reason,
      reason,
      decision: { ...out.decision, kind: 'block', reason },
    });
  }
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
    return checks.map(c => {
      const failures: CheckFailure[] = [],
        results: CommandResult[] = [];
      const passed =
        run([c], log, dir, sha(JSON.stringify(['probe', base])), failures, results).length === 0;
      // Exit 1 alone cannot distinguish assertions from setup errors. Only a
      // structured non-environment failure proves the baseline actually ran.
      const comparable =
        passed ||
        (results[0]?.exit === 1 &&
          failures.every(f => f.failure_class !== 'unknown' && f.failure_class !== 'test_env'));
      return {
        cmd: c.cmd,
        pass: comparable ? passed : null,
        ...(results[0]?.structured ? { structured: results[0].structured } : {}),
        ...(!comparable
          ? {
              reason: `baseline incomparable: exit=${String(results[0]?.exit)}; failure_class=${failures[0]?.failure_class ?? 'unknown'}`,
            }
          : {}),
      };
    });
  } catch (error) {
    appendFileSync(log, `# baseline unknown: ${String(error)}\n`);
    return [];
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

export const environmentChecks = (p: Pick<Plan, 'environment' | 'packages'>): Check[] =>
  (p.environment ?? []).concat(p.packages.flatMap(k => k.environment ?? []));

// prettier-ignore
async function environment(): Promise<void> {
  const log = join(artifacts, 'environment.log');
  const notes: string[] = [];
  let owned = false;
  try {
    const current = runEvidence(), receipt = current.metadata?.owned_worktree, source = plan().repo;
    owned = current.id === process.env.WORKFLOW_ID && !!receipt?.envId && !!receipt.creationId &&
      !!current.working_path && realpathSync(current.working_path) === process.cwd() &&
      !!source && realpathSync(source) !== process.cwd() &&
      realpathSync(git('rev-parse', '--git-dir').trim()) !== realpathSync(git('rev-parse', '--git-common-dir').trim());
  } catch (e) { notes.push(`worktree ownership unavailable: ${String(e)}`); }
  if (!owned) notes.push('Recovery skipped: current checkout is not proven to be created and owned by this run.');
  const out = { ...await prepareEnvironment(process.cwd(), plan(), log, owned), notes, head: git('rev-parse', 'HEAD').trim() };
  writeFileSync(join(artifacts, 'environment.json'), JSON.stringify(out));
  emit(out);
  if (!out.ok) process.exit(1);
}
/** Recovery authorization belongs to the caller that established checkout ownership. */
// prettier-ignore
export async function prepareEnvironment(cwd: string, p: Parameters<typeof environmentChecks>[0], log: string, owned: boolean) {
  writeFileSync(log, '');
  const { environment: precheck, provisioned } = owned ? await provisionEnvironment(cwd) :
    { environment: envPrecheck(cwd), provisioned: [] };
  appendFileSync(log, `${JSON.stringify(precheck)}\n`);
  const failures: CheckFailure[] = precheck.failures.map(f => ({
    command: 'env-precheck', failure_class: f.failure_class, evidence: log,
  }));
  const failed = precheck.ok ? run(environmentChecks(p), log, cwd, '', failures) : ['env-precheck'];
  return { ok: failed.length === 0, failed, failures, precheck, provisioned, log };
}

const severities = (risk: string): string[] =>
  risk === 'G2' ? ['blocker', 'high', 'medium'] : ['blocker', 'high'];

/** 第 2 轮及以后的有效关闭：原 id、carry_over:true、status:closed 且附 evidence；同轮同 id 另有 open 条目则 open 胜出。 */
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
    rechecks?: (Accept | null)[];
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
          blocks: !nonProduct && known.eligible,
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
          blocks: !nonProduct && (base ? sev.includes(f.severity) : f.severity === 'blocker'),
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

const maxRounds = (): number => reviewRoundLimit(policy());
type Verdict = 'pass' | 'fix' | 'escalate';
type DecisionCandidate = Pick<DeliveryDecision, 'kind' | 'reason'>;
interface DecisionFacts {
  candidate: DecisionCandidate;
  verified: boolean;
  unchanged: boolean;
}
const CONVERGENCE_REASONS = new Set([
  'acceptance_failed',
  'review_failed',
  'review_inconsistent',
  'no_change',
]);
const DECISION_RULES: {
  when: (facts: DecisionFacts) => boolean;
  decide: (facts: DecisionFacts) => DecisionCandidate;
}[] = [
  {
    when: facts => facts.verified && CONVERGENCE_REASONS.has(facts.candidate.reason ?? ''),
    decide: () => ({ kind: 'advance', reason: null }),
  },
  {
    when: facts =>
      facts.unchanged &&
      ['repair', 'block'].includes(facts.candidate.kind) &&
      CONVERGENCE_REASONS.has(facts.candidate.reason ?? ''),
    decide: () => ({ kind: 'block', reason: 'no_change' }),
  },
  { when: () => true, decide: facts => facts.candidate },
];

/** Ordered convergence policy: verified delivery wins; unchanged real failures stop repair. */
function convergenceDecision(facts: DecisionFacts): DecisionCandidate {
  const rule = DECISION_RULES.find(candidate => candidate.when(facts));
  return rule ? rule.decide(facts) : facts.candidate;
}

function rotatingFailures(rechecks: (Accept | null)[], reviews: (Review | null)[]): boolean {
  const recent = rechecks.slice(-3);
  if (
    recent.length !== 3 ||
    recent.some(c => !c?.head || !c.contract_hash) ||
    new Set(recent.map(c => c?.head)).size !== 1 ||
    new Set(recent.map(c => c?.contract_hash)).size !== 1
  )
    return false;
  const identities = recent.map(c => {
    const ids = new Set<string>();
    c?.failed?.forEach(command => ids.add(`command:${command}`));
    c?.failures?.forEach(failure => {
      failure.failed_tests?.forEach(id => ids.add(`test:${id}`));
      if (!failure.failed_tests?.length && failure.failure_digest)
        ids.add(`digest:${failure.failure_digest}`);
    });
    c?.command_results?.forEach(result =>
      result.structured?.failures.forEach(failure => ids.add(`test:${failure.id}`))
    );
    return JSON.stringify([...ids].sort());
  });
  if (identities.some(identity => identity === '[]') || new Set(identities).size !== 3)
    return false;
  const productIds = reviews
    .slice(-3)
    .map(
      review =>
        new Set(
          review?.findings
            .filter(f => f.status === 'open' && f.failure_class === 'product')
            .map(f => f.id) ?? []
        )
    );
  return ![...productIds[0]].some(id => productIds[1].has(id) && productIds[2].has(id));
}

/** reviews[i]/rechecks[i] 对应第 i+1 轮；权限拒绝优先，未完成自报只阻断已证实的空交付。 */
export function deliveryDecision(input: {
  approved?: { check?: Accept; decision?: DeliveryDecision };
  selfReport?: string;
  selfReportPath?: string;
  reviews?: (Review | null)[];
  permissions?: string[];
  reviewRequired?: boolean;
  rechecks: (Accept | null)[];
  risk?: string;
  expired?: boolean;
  qualifiedReview?: boolean;
  strict?: boolean;
  packages?: RequirementContract[];
  reviewRounds: number | null;
}) {
  let coder: Coder | undefined;
  try {
    coder = JSON.parse(input.selfReport ?? '') as Coder;
  } catch {
    /* Self-report is diagnostic only. */
  }
  const adjudication =
    coder?.status !== 'done' &&
    ['scope_violation', 'plan_invalid'].includes(coder?.error_class ?? '') &&
    coder?.needs?.length;
  const audit = {
    ...(coder && (coder.status !== 'done' || coder.error_class || coder.needs?.length)
      ? { self_report_conflict: true as const }
      : {}),
    ...(coder?.status === 'partial' ? { coder_partial: true as const } : {}),
    ...(coder?.error_class && !adjudication ? { error_class_ignored: true as const } : {}),
  };
  const reviews = input.reviews ?? [];
  const rounds = reviews.length;
  const check = input.rechecks.at(-1);
  const packages = input.packages ?? check?.requirement_contract;
  let offset = 0;
  const items: Completion['items'] = [];
  const matching = JSON.stringify(packages) === JSON.stringify(check?.requirement_contract);
  for (const p of packages ?? []) {
    for (const r of p.requirements ?? []) {
      const results = r.verified_by.map(i => {
        const result = check?.command_results?.[offset + i];
        return matching &&
          result?.evidence.trim() &&
          JSON.stringify(result.check) === JSON.stringify(p.accept[i])
          ? result
          : undefined;
      });
      items.push({
        package: p.id,
        id: r.id,
        text: r.text,
        status: results.some(c => c?.pass === false)
          ? 'unmet'
          : results.length && results.every(c => c?.pass === true)
            ? 'verified'
            : 'unknown',
        evidence: results.flatMap(c => (c ? [c.evidence] : [])),
      });
    }
    offset += p.accept.length;
  }
  const completion: Completion = {
    items,
    status: !items.length
      ? 'legacy'
      : items.some(r => r.status === 'unmet')
        ? 'unmet'
        : items.some(r => r.status === 'unknown') || packages?.some(p => !p.requirements)
          ? 'unknown'
          : 'verified',
  };
  const ledger = ledgerOf(reviews.length ? reviews : [null], input.risk ?? 'G1', {
    strict: input.strict,
    rechecks: input.rechecks,
  });
  if (ledger.blocking.length && completion.status === 'verified') completion.status = 'unmet';
  const evidence = [
    ...new Set([
      ...(input.permissions ?? []),
      ...input.rechecks.flatMap(c => [
        ...(c?.decision?.evidence ?? []),
        ...(c?.log ? [c.log] : []),
      ]),
      ...[...ledger.blocking, ...ledger.debt].flatMap(e => (e.evidence ? [e.evidence] : [])),
    ]),
  ];
  // Compare causal inputs, not round-specific log paths or diagnostic self-reports.
  // prettier-ignore
  const signature = (i: number) => { const c = input.rechecks.at(i); return JSON.stringify([c?.head, c?.diff_hash, c?.contract_hash, c?.ok, c?.workspace_clean, c?.failed, c?.failures, c?.decision?.evidence, reviews.at(i)]); };
  const repeated = !!check?.head && input.rechecks.length > 1 && signature(-1) === signature(-2);
  const unchanged = !!check && (check.same || repeated);
  const accepted = !!(
    completion.status !== 'unmet' &&
    check?.workspace_clean !== false &&
    ((check?.ok ?? false) ||
      ((check?.failed?.length ?? 0) > 0 &&
        check?.failed?.every(command =>
          ledger.debt.some(e => e.command === command && e.debt_reason === 'non_product')
        )))
  );
  const prior = reviews
    .map((review, i) => (review ? i : -1))
    .filter(i => i >= 0)
    .at(-1);
  const priorCheck = prior === undefined ? undefined : input.rechecks[prior];
  const priorReview = prior === undefined ? undefined : reviews[prior];
  const reusable =
    input.qualifiedReview === true &&
    reviews.at(-1) === null &&
    check?.ok === true &&
    check.decision?.kind === 'advance' &&
    ledger.blocking.length === 0 &&
    ledger.debt.length === 0 &&
    priorReview?.status === 'PASS' &&
    priorReview.debt.length === 0 &&
    !!check.head &&
    priorCheck?.head === check.head &&
    !!check.diff_hash &&
    priorCheck.diff_hash === check.diff_hash &&
    !!check.contract_hash &&
    priorCheck.contract_hash === check.contract_hash &&
    priorCheck.risk === check.risk &&
    check.risk === input.risk;
  const reviewSatisfied =
    !input.reviews ||
    reviews.at(-1)?.status === 'PASS' ||
    reusable ||
    (input.reviewRequired === false && !input.strict && input.risk !== 'G2');
  const verified =
    reusable ||
    (accepted &&
      completion.status === 'verified' &&
      ledger.blocking.length === 0 &&
      ledger.debt.length === 0 &&
      reviewSatisfied);
  const out = (kind: DeliveryDecision['kind'], reason: string | null, debt: string[] = []) => {
    const selected = convergenceDecision({ candidate: { kind, reason }, verified, unchanged });
    if (selected.reason === 'no_change')
      evidence.push('repair input unchanged: same diff or identical adjacent head and evidence');
    return {
      decision: {
        kind: selected.kind === 'advance' && debt.length ? 'debt' : selected.kind,
        reason: selected.reason,
        evidence,
        debt,
        requirements: completion,
      },
      rounds,
      ledger,
      audit,
    };
  };
  if (input.permissions?.length || check?.decision?.reason === 'coder_redline')
    return out('block', 'coder_redline');
  if (!check) return out('block', 'engine_suspect');
  if (check.decision?.reason === 'coder_needs' || adjudication) {
    if (input.selfReportPath) evidence.push(input.selfReportPath);
    const result = out('block', 'coder_needs');
    Object.assign(result.decision, {
      blockers: coder?.blockers ?? check.decision?.blockers ?? [],
      needs: coder?.needs ?? check.decision?.needs ?? [],
    });
    return result;
  }
  if (check.no_changes === true && coder && coder.status !== 'done') {
    const result = out('block', coder.needs?.length ? 'coder_needs' : 'coder_partial');
    Object.assign(result.decision, { blockers: coder.blockers ?? [], needs: coder.needs ?? [] });
    return result;
  }
  if (check.decision?.reason === 'coder_partial') {
    const result = out('block', 'coder_partial');
    Object.assign(result.decision, check.decision);
    return result;
  }
  if (items.some(r => r.status === 'unknown')) return out('block', 'acceptance_failed');
  if (check.adjudication) return out('block', 'acceptance_adjudication');
  if (
    !check.ok &&
    Array.isArray(coder?.needs) &&
    coder.needs.some(n => n && typeof n === 'object' && 'cap' in n && n.cap === 'environment')
  ) {
    if (input.selfReportPath) evidence.push(input.selfReportPath);
    return out('block', 'environment');
  }
  if (rotatingFailures(input.rechecks, reviews)) {
    evidence.push('structured failures rotated across three checks at the same head and contract');
    return out('block', 'environment');
  }
  if (ledger.blocking.some(e => e.failure_class === 'unknown')) {
    evidence.push('diagnosis required: supply structured failure_class and evidence');
    return out('block', 'acceptance_failed');
  }
  const unknown = check.failures?.some(
    f =>
      !f.adjudicated &&
      (f.failure_class === 'test_env' ||
        (f.failure_class === 'baseline' &&
          (check.base_pass === null || check.baseline === 'incomparable')))
  );
  if (unknown) return out('block', 'environment');
  const approved = input.approved?.check;
  if (
    input.approved &&
    !check.ok &&
    (input.strict ||
      input.risk === 'G2' ||
      input.approved.decision?.kind !== 'debt' ||
      !approved ||
      !check.contract_hash ||
      check.contract_hash !== approved.contract_hash ||
      !check.diff_hash ||
      check.diff_hash !== approved.diff_hash ||
      !approved.failed?.every(command =>
        approved.failures?.some(
          f =>
            f.command === command &&
            f.evidence.trim() &&
            ['baseline', 'fixture', 'test_data', 'test_env'].includes(f.failure_class)
        )
      ) ||
      check.failed?.some(command => !approved.failed?.includes(command)))
  )
    return out('block', 'acceptance_failed');
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
  const debt = debtOf(reviews, ledger);
  const last = reviews.at(-1);
  // Non-blocking findings remain debt even when the reviewer labels the review FAIL.
  const debtOnly =
    ledger.blocking.length === 0 &&
    ledger.debt.length > 0 &&
    (last?.status === 'PASS' || (last?.status === 'FAIL' && last.findings.length > 0));
  if (accepted && debtOnly) return out('advance', null, debt);
  let reason: string;
  if (!last) {
    if (accepted && unchanged) return out('block', 'review_failed', debt);
    if (accepted) throw new Error('gate: no review');
    reason = check.reason ?? 'acceptance_failed';
  } else {
    const ok = accepted;
    if (last.status === 'PASS' && ledger.blocking.length === 0 && ok)
      return out('advance', null, debt);
    reason = !ok
      ? 'acceptance_failed'
      : { PASS: 'review_inconsistent', FAIL: 'review_failed', INCOMPLETE: 'review_incomplete' }[
          last.status
        ];
  }
  if (input.reviewRounds !== null && rounds >= input.reviewRounds)
    return out('block', `${reason}+review_limit`, debt);
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

const expired = (): boolean => {
  const deadline = plan().deadline;
  return deadline !== undefined && Date.now() > Date.parse(deadline);
};

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
export function permissionEvidence(
  events: RunEvent[],
  pkgs: string[],
  m: string,
  reviewRounds: number
): string[] {
  const nodes = new Map<string, string>();
  for (const id of pkgs)
    for (const node of [`code-${id}`, `repair-${id}`]) nodes.set(node, `package-attempt-${id}`);
  const scope = `attempt-${m}`;
  for (let r = 1; r <= reviewRounds; r++) nodes.set(`fix-${m}-r${String(r)}`, scope);
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
    // Only the boundary's machine category is redline evidence. Generic SDK denials
    // and legacy exit codes remain in the event ledger as diagnostics.
    const categories = [
      'destruction',
      'shared_history',
      'external',
      'privacy',
      'authorization',
      'delegation',
    ];
    if (
      hook?.type === 'warning' &&
      hook.permissionDenied === true &&
      categories.some(category => hook.code === `superagent.permission.${category}`)
    )
      denied.set(node, `events:${node}:${String(i)}`);
  });
  return [...denied.values()];
}
export interface AuthorRun {
  id: string;
  codebase_id?: string | null;
  adopted_from_run_id?: string | null;
  output_root?: string | null;
  events: RunEvent[];
  working_path?: string | null;
  metadata?: { owned_worktree?: OwnedWorktree };
}
let evidence: AuthorRun | undefined;
/**
 * 执行层台账（Archon 事件里的 spend/binding）。INPUTS_ARCHON 为空（fake 生成）时调用方不查：身份记 fake、
 * 预算不检查。输出前可能有日志行，取最后一个能整体解析的顶层 `{` 起点。
 */
function runEvidence(id = process.env.WORKFLOW_ID): AuthorRun {
  if (evidence && id === process.env.WORKFLOW_ID) return evidence;
  if (!id) throw new Error('sa-check: WORKFLOW_ID unset');
  if (env('EVENTS_FILE') && id === process.env.WORKFLOW_ID) {
    const saved = JSON.parse(readFileSync(env('EVENTS_FILE'), 'utf8')) as AuthorRun;
    if (saved.id !== id || !Array.isArray(saved.events))
      throw new Error('sa-check: invalid authoritative events');
    return (evidence = saved);
  }
  const p = auxiliary([env('ARCHON'), 'workflow', 'get', id, '--verbose', '--events', '--json']);
  if (p.exitCode !== 0 || p.signalCode)
    throw new Error(
      `archon workflow get ${id}: ${p.stderr.toString().slice(-300)}${p.signalCode ? ` (signal ${p.signalCode})` : ''}`
    );
  const lines = p.stdout.toString().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const saved = JSON.parse(lines.slice(i).join('\n')) as AuthorRun;
      if (!Array.isArray(saved.events)) throw new Error('invalid events');
      if (id === process.env.WORKFLOW_ID) evidence = saved;
      return saved;
    } catch {
      // 该行只是日志里的 `{`，继续向前找真正的 JSON 起点
    }
  }
  throw new Error(`archon workflow get ${id}: no JSON in output`);
}
const runEvents = (): RunEvent[] => runEvidence().events;
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
function budget(nextLaunch = true): string | null {
  if (!env('ARCHON')) return null;
  const b = plan().budget;
  const u = budgetUsage(runEvents(), policy().budget_floor.S, readPolicyAttempts(artifacts));
  const reason = budgetReason(b, u, nextLaunch);
  if (reason) {
    console.warn(
      JSON.stringify({ code: 'superagent.budget_observed', reason, used: u, limits: b })
    );
  }
  return reason;
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

/** Author reservations survive interruption; reviewers still require a completed attempt. */
export function attemptIdentity(
  attempts: PolicyAttempt[],
  node: string,
  binding?: Binding,
  author = false
): Ident {
  const attempt = attempts.filter(a => a.node === node).at(-1);
  if (!attempt) return identityOf(binding);
  if (attempt.status !== 'completed' && !author) return { model: null, strength: 'unknown' };
  if (attempt.resolved) return { model: attempt.resolved, strength: 'provider' };
  // absent tracking on an interrupted legacy attempt cannot prove its author model.
  return attempt.provider === 'codex' &&
    (attempt.status === 'completed' || attempt.rerouted_models !== undefined)
    ? { model: attempt.model, strength: 'pinned' }
    : { model: null, strength: 'unknown' };
}

/** Read each generation's own receipts; ancestry grants no access to its candidate or contract. */
export function readAuthorEvidence(
  run: AuthorRun,
  attempts: PolicyAttempt[],
  pkgs: string[],
  milestone: string | string[],
  reviewRounds: number,
  load: (id: string) => AuthorRun
): Ident[] {
  const authors: Ident[] = [],
    seen = new Set<string>(),
    covered = new Set<string>(),
    repo = run.codebase_id;
  const unknown: Ident = { model: null, strength: 'unknown' };
  const owns = (node: string) =>
    pkgs.some(p => node === `code-${p}` || node === `repair-${p}`) ||
    [milestone]
      .flat()
      .some(m =>
        Array.from({ length: reviewRounds }, (_, i) => `fix-${m}-r${String(i + 1)}`).includes(node)
      );
  for (;;) {
    if (seen.has(run.id) || !Array.isArray(run.events)) return [...authors, unknown];
    seen.add(run.id);
    const receipts = attempts.filter(a => owns(a.node));
    authors.push(
      ...receipts.flatMap(a =>
        a.provider === 'codex' && a.rerouted_models !== undefined
          ? [...new Set([a.resolved ?? a.model, a.model, ...a.rerouted_models])].map(model => ({
              model,
              strength: 'pinned' as const,
            }))
          : [attemptIdentity([a], a.node, undefined, true)]
      )
    );
    const nodes = new Set(
      run.events
        .filter(
          e =>
            owns(e.step_name ?? '') &&
            ['node_started', 'node_completed', 'node_failed'].includes(e.event_type)
        )
        .map(e => e.step_name ?? '')
    );
    // R1-2: evidence for one package cannot stand in for another carried package.
    for (const p of pkgs)
      if (
        [...receipts.map(a => a.node), ...nodes].some(n => n === `code-${p}` || n === `repair-${p}`)
      )
        covered.add(p);
    for (const node of nodes) {
      if (receipts.some(a => a.node === node)) continue;
      const history = run.events.filter(
        e =>
          e.step_name === node &&
          ['node_started', 'node_completed', 'node_failed'].includes(e.event_type)
      );
      for (const e of history.filter(e => e.event_type !== 'node_started'))
        authors.push(
          e.event_type === 'node_completed' ? attemptIdentity([], node, e.data?.binding) : unknown
        );
      if (history.at(-1)?.event_type === 'node_started') authors.push(unknown);
    }
    const prior = run.adopted_from_run_id;
    if (!prior && seen.size > 1 && !receipts.length && !nodes.size) authors.push(unknown);
    if (!prior) return pkgs.every(p => covered.has(p)) ? authors : [...authors, unknown];
    try {
      run = load(prior);
      if (run.id !== prior || !repo || run.codebase_id !== repo || !run.output_root)
        return [...authors, unknown];
      attempts = readPolicyAttempts(join(run.output_root, 'artifacts', 'runs', run.id));
    } catch {
      return [...authors, unknown];
    }
  }
}

/** F-14：不合格的原因；null = 合格独立评审（双方身份已知、实际模型不同）。 */
export function independence(authors: Ident[], reviewer: Ident): string | null {
  if (reviewer.strength === 'unknown') return 'reviewer_unknown';
  if (!authors.length || authors.some(a => a.strength === 'unknown')) return 'author_unknown';
  if (authors.some(a => a.model === reviewer.model)) return 'same_model';
  return null;
}

interface RecoverySource {
  path: string;
  sha256: string;
}
interface RecoveryActor {
  job_id: string;
  job: RecoverySource;
  native: RecoverySource;
}
/** Present owner admission of the complete legacy roster, not historical launch evidence. */
export interface RecoveryAuthorCoverage {
  run_id: string;
  engine_run_id: string;
  base: string;
  candidate: string;
  rounds: { logical_round: number; freeze: RecoverySource; job_ids: string[] }[];
}
export interface RecoveryEvidence {
  run_id: string;
  engine_run_id: string;
  base: string;
  candidate: string;
  packages: string[];
  admission: { kind: 'owner_legacy_snapshot'; reason: string };
  plan: RecoverySource;
  policy: RecoverySource;
  contracts: RecoverySource;
  exception: RecoverySource;
  author_coverage: RecoverySource;
  rounds: {
    logical_round: number;
    descriptor_round: number;
    freeze: RecoverySource;
    source: RecoverySource;
    review: Review;
    reviewer: RecoveryActor;
    provider_result: RecoverySource & { json_offset: number | null; json_length: number | null };
    authors: RecoveryActor[];
    coverage: { base: string; head: string; files: string[] };
  }[];
}
export const recoveryHash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
/** Owner interpretation is a present admission, not a claim of historical input immutability. */
export function validateRecovery(
  e: RecoveryEvidence,
  p: Plan,
  cwd: string,
  runId: string,
  engineId: string,
  load: (id: string) => AuthorRun,
  jobs = join(process.env.SUPERAGENT_HOME ?? '', 'jobs')
) {
  const require: (ok: unknown, why: string) => asserts ok = (ok, why) => {
    if (!ok) throw new Error(`recovery: ${why}`);
  };
  const bytes = (s: RecoverySource): string => {
    const text = readFileSync(s.path, 'utf8');
    require(sha(text) === s.sha256, 'source drift');
    return text;
  };
  const source = (s: RecoverySource): unknown => JSON.parse(bytes(s));
  const command = (...args: string[]): string => {
    const r = Bun.spawnSync(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CHECK_AUX_TIMEOUT_MS,
    });
    require(r.exitCode === 0, 'git evidence unavailable');
    return r.stdout.toString().trim();
  };
  const admission = e.admission as { kind: string; reason: string } | undefined;
  require(admission?.kind === 'owner_legacy_snapshot' &&
    admission.reason.trim(), 'owner admission required');
  require(e.run_id === runId && e.engine_run_id === engineId, 'run binding');
  require(/^[a-f0-9]{40}$/.test(e.base) && /^[a-f0-9]{40}$/.test(e.candidate), 'invalid refs');
  require(command('rev-parse', 'HEAD') === e.candidate &&
    !command('status', '--porcelain'), 'candidate drift');
  require(command('rev-parse', p.base_ref) === e.base &&
    command('merge-base', e.base, e.candidate) === e.base, 'base drift');
  require(JSON.stringify(source(e.plan)) === JSON.stringify(p), 'plan drift');
  const reviewRounds = reviewRoundLimit(source(e.policy) as ReviewEffortPolicy);
  source(e.contracts);
  require(JSON.stringify([...e.packages].sort()) ===
    JSON.stringify(p.packages.map(k => k.id).sort()), 'package coverage');
  const limit = e.rounds.at(-1)?.descriptor_round;
  require(typeof limit === 'number' &&
    Number.isInteger(limit) &&
    limit > 0 &&
    limit <= reviewRounds &&
    e.rounds.length === limit + 1, 'complete rounds through recorded limit + 1 required');
  require(e.author_coverage, 'support author coverage required');
  const roster = source(e.author_coverage) as Omit<RecoveryAuthorCoverage, 'rounds'> & {
    rounds?: RecoveryAuthorCoverage['rounds'];
  };
  require(roster.run_id === runId &&
    roster.engine_run_id === engineId &&
    roster.base === e.base &&
    roster.candidate === e.candidate &&
    roster.rounds?.length === e.rounds.length, 'support author coverage binding');
  const exception = source(e.exception) as {
    logical_review_round: number;
    cli_descriptor_round: number;
    user_exception?: { reply?: string; scope?: string };
  };
  require(e.exception.path === e.rounds[limit].freeze.path &&
    e.exception.sha256 === e.rounds[limit].freeze.sha256 &&
    exception.logical_review_round === limit + 1 &&
    exception.cli_descriptor_round === limit &&
    exception.user_exception?.reply?.trim() &&
    exception.user_exception.scope?.trim(), 'round beyond recorded limit exception');
  const original = load(engineId);
  require(original.id === engineId && original.output_root, 'original engine binding');
  const milestones = p.packages.map(k => k.milestone ?? 'm1');
  require(new Set(milestones).size === 1, 'single milestone required');
  const authors = readAuthorEvidence(
    original,
    readPolicyAttempts(join(original.output_root, 'artifacts', 'runs', engineId)),
    e.packages,
    milestones,
    reviewRounds,
    load
  );
  const permissions = [
    ...new Set(
      milestones.flatMap(m => permissionEvidence(original.events, e.packages, m, reviewRounds))
    ),
  ];
  const actor = (a: RecoveryActor, role: 'general' | 'strategist') => {
    require(a.job.path === join(jobs, `${a.job_id}.json`), 'job registry binding');
    const j = source(a.job) as import('../../../src/jobs').Job;
    require(j.id === a.job_id &&
      j.state === 'done' &&
      j.exit_code === 0 &&
      j.role === role &&
      j.session_id &&
      j.card, 'job not qualified');
    const n = nativeEvidence(bytes(a.native), j.kind);
    require(n.sessions.length === 1 &&
      n.sessions[0] === j.session_id &&
      n.models.length === 1 &&
      n.inputs.includes(j.card), 'native identity binding');
    return {
      native: n,
      job: j,
      identity: {
        model: n.models[0],
        strength: j.kind === 'codex' ? ('pinned' as const) : ('provider' as const),
      },
    };
  };
  let previous = e.base;
  const reviews: Review[] = [],
    reviewers: Ident[] = [],
    support_permissions: { round: number; denials: unknown[] }[] = [];
  for (const [i, r] of e.rounds.entries()) {
    require(r.logical_round === i + 1 &&
      r.descriptor_round === Math.min(i + 1, limit), 'round continuity');
    const f = source(r.freeze) as {
      run_id?: string;
      original_run?: string;
      base: string;
      head: string;
      previous?: string;
      worktree: string;
      files: Record<string, string> | { path: string; sha256: string }[];
    };
    require(/^[a-f0-9]{40}$/.test(f.head) &&
      (f.previous === undefined || /^[a-f0-9]{40}$/.test(f.previous)), 'invalid freeze refs');
    require((f.run_id ?? f.original_run) === runId &&
      f.base === e.base &&
      (i === 0 || f.previous === previous), 'freeze binding');
    // Actor selection must equal the separately frozen roster admitted by the owner.
    const expected = roster.rounds[i],
      selected = r.authors.map(a => a.job_id),
      jobIds = expected.job_ids as string[] | undefined;
    require(expected.logical_round === r.logical_round &&
      expected.freeze.path === r.freeze.path &&
      expected.freeze.sha256 === r.freeze.sha256 &&
      jobIds?.length &&
      new Set(jobIds).size === jobIds.length &&
      new Set(selected).size === selected.length &&
      JSON.stringify([...jobIds].sort()) ===
        JSON.stringify(selected.sort()), 'support author coverage');
    require(r.coverage.base === previous && r.coverage.head === f.head, 'incremental coverage');
    const files = Array.isArray(f.files)
      ? f.files
      : Object.entries(f.files).map(([path, sha256]) => ({ path, sha256 }));
    const changed = command('diff', '--name-only', '--end-of-options', previous, f.head)
      .split('\n')
      .filter(Boolean)
      .sort();
    require(JSON.stringify(changed) === JSON.stringify([...r.coverage.files].sort()) &&
      JSON.stringify(changed) ===
        JSON.stringify(files.map(x => x.path).sort()), 'missing coverage');
    for (const s of files)
      require(sha(
        Bun.spawnSync(['git', 'show', '--end-of-options', `${f.head}:${s.path}`], {
          cwd,
        }).stdout.toString()
      ) === s.sha256, 'blob drift');
    const raw = source(r.source) as {
      conclusion: string;
      findings: { id: string; severity: string; disposition?: string; evidence?: string }[];
      new_blockers?: unknown[];
    };
    const reviewer = actor(r.reviewer, 'strategist');
    require(reviewer.job.cwd === f.worktree, 'review worktree binding');
    const provider = source(r.provider_result) as {
      type: string;
      subtype: string;
      is_error: boolean;
      session_id: string;
      result: string;
      modelUsage: Record<string, unknown>;
      permission_denials?: unknown[];
    };
    require(provider.type === 'result' &&
      provider.subtype === 'success' &&
      !provider.is_error &&
      provider.session_id === reviewer.job.session_id &&
      provider.result === reviewer.native.final &&
      JSON.stringify(Object.keys(provider.modelUsage)) === JSON.stringify(reviewer.native.models) &&
      (i !== limit || !provider.permission_denials?.length), 'provider binding');
    support_permissions.push({ round: i + 1, denials: provider.permission_denials ?? [] });
    if (r.provider_result.json_offset !== null) {
      const { json_offset: offset, json_length: length } = r.provider_result;
      const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
      require(isSafeInteger(offset) &&
        offset >= 0 &&
        isSafeInteger(length) &&
        length > 0, 'JSON boundary');
      require(JSON.stringify(
        JSON.parse(
          Buffer.from(provider.result)
            .subarray(offset, offset + length)
            .toString()
        )
      ) === JSON.stringify(raw), 'provider JSON drift');
    } else
      require(i === 0 &&
        r.provider_result.json_length === null, 'typed legacy interpretation only for R1');
    require(r.review.status === raw.conclusion &&
      !r.review.debt.length &&
      (i === limit
        ? raw.conclusion === 'PASS' && Array.isArray(raw.new_blockers) && !raw.new_blockers.length
        : raw.conclusion === 'FAIL'), 'non-PASS final');
    require(r.review.findings.length === raw.findings.length &&
      new Set(raw.findings.map(x => x.id)).size === raw.findings.length, 'finding coverage');
    for (const [n, finding] of r.review.findings.entries()) {
      const old = raw.findings[n],
        closed = ['CLOSED', 'NOT_A_DEFECT'].includes(old.disposition ?? '');
      require(finding.failure_class === 'product' &&
        finding.id === old.id &&
        finding.severity === old.severity &&
        ['blocker', 'high', 'medium', 'low'].includes(finding.severity) &&
        finding.status === (closed ? 'closed' : 'open') &&
        finding.carry_over === i > 0 &&
        finding.evidence.trim() &&
        (!old.evidence || finding.evidence === old.evidence), 'finding interpretation');
    }
    require(r.authors.length, 'support author coverage');
    authors.push(
      ...r.authors.map(a => {
        const author = actor(a, 'general');
        require(author.job.cwd === f.worktree, 'author worktree binding');
        return author.identity;
      })
    );
    reviewers.push(reviewer.identity);
    reviews.push(r.review);
    previous = f.head;
  }
  require(previous === e.candidate &&
    !ledgerOf(reviews, 'G2', { strict: p.mode === 'strict' }).blocking.length, 'unclosed findings');
  for (const reviewer of reviewers)
    require(independence(authors, reviewer) === null, 'review not independent');
  require(command('rev-parse', 'HEAD') === e.candidate &&
    !command('status', '--porcelain'), 'candidate drift');
  return {
    reviews,
    identity: { authors, reviewer: reviewers[reviewers.length - 1] },
    permissions,
    support_permissions,
    legacy_input_binding: e.admission,
  };
}

function gate(): void {
  const round = Number(env('ROUND'));
  const pick = (k: string): unknown[] =>
    Array.from({ length: round }, (_, i) => json(`${k}${String(i + 1)}`));
  if (env('RECOVERY_EVIDENCE') && recoveryHash(env('RECOVERY_EVIDENCE')) !== env('RECOVERY_SHA256'))
    throw new Error('recovery: admission drift');
  const recovery = env('RECOVERY_EVIDENCE')
    ? (JSON.parse(readFileSync(env('RECOVERY_EVIDENCE'), 'utf8')) as RecoveryEvidence)
    : null;
  if (recovery && runEvidence().adopted_from_run_id !== recovery.engine_run_id)
    throw new Error('recovery: execution adoption binding');
  const reused = recovery
    ? validateRecovery(
        recovery,
        plan(),
        process.cwd(),
        env('OPERATOR_ID'),
        recovery.engine_run_id,
        runEvidence
      )
    : null;
  const reviews = reused?.reviews ?? (pick('R') as (Review | null)[]);
  const rechecks = pick('C') as Accept[];
  if (recovery && rechecks.at(-1)?.head !== recovery.candidate)
    throw new Error('recovery: acceptance candidate drift');
  const tag = env('TAG');
  const reviewFile = join(artifacts, `${tag}.review.json`);
  writeFileSync(reviewFile, JSON.stringify(reviews.at(-1), null, 2));
  const risk = effectiveRisk(env('RISK'), rechecks);
  const reviewRounds = maxRounds();
  const decision = {
    reviews,
    rechecks,
    packages: plan()
      .packages.filter(p => env('PKGS').split(',').includes(p.id))
      .map(({ id, accept, requirements }) => ({
        id,
        accept,
        ...(requirements ? { requirements } : {}),
      })),
    risk,
    strict: plan().mode === 'strict',
    expired: expired(),
    reviewRequired: env('REVIEW') !== '0',
    reviewRounds,
    permissions:
      reused?.permissions ??
      (env('ARCHON') && !expired()
        ? permissionEvidence(runEvents(), env('PKGS').split(','), env('MILESTONE'), reviewRounds)
        : []),
  };
  let d = decide(decision);
  if (d.verdict === 'escalate' && !decision.expired && nextDisposition(d.decision) === 'repair')
    Object.assign(d, { verdict: d.rounds >= reviewRounds ? 'escalate' : 'fix' });
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
    const reviewer = `review-${m}-r${String(reviewed + 1)}`;
    const attempts = readPolicyAttempts(artifacts);
    const pkgs = (env('SCOPE_PKGS') || env('PKGS')).split(',');
    const milestones = plan()
      .packages.filter(p => pkgs.includes(p.id))
      .map(p => p.milestone ?? 'm1');
    identity =
      reused?.identity ??
      (env('ARCHON')
        ? {
            authors: readAuthorEvidence(
              runEvidence(),
              attempts,
              pkgs,
              milestones,
              reviewRounds,
              runEvidence
            ),
            reviewer: attemptIdentity(
              attempts,
              reviewer,
              done.filter(e => e.step_name === reviewer).at(-1)?.data?.binding
            ),
          }
        : { authors: [fake], reviewer: { ...fake, model: 'fake-reviewer' } });
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
  try {
    if (
      !rechecks.at(-1)?.checkout_fingerprint ||
      checkoutFingerprint(args => auxiliary(['git', ...args])) !==
        readCheckoutFingerprint(rechecks.at(-1)?.checkout_fingerprint)
    )
      throw new Error('tracked checkout changed or review fingerprint missing');
  } catch (error) {
    Object.assign(d, { verdict: 'escalate', reason: 'review_modified_checkout' });
    d.decision.evidence.push(String(error));
  }
  const over =
    d.verdict === 'fix' || d.verdict === 'pass'
      ? budget(d.verdict === 'fix' || Boolean(env('NEXT')))
      : null;
  if (over) Object.assign(d, { budget_advisory: over });
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
    ...(reused
      ? {
          legacy_input_binding: reused.legacy_input_binding,
          support_permissions: reused.support_permissions,
          recovery_evidence: env('RECOVERY_EVIDENCE'),
        }
      : {}),
    milestone: env('MILESTONE'),
    review_file: reviewFile,
    ledger_file: ledgerFile,
    // 末份非空评审所见的 HEAD：下一轮 diff 以它为增量起点（F-20）。
    reviewed_head: reviewed === undefined ? '' : (rechecks[reviewed]?.head ?? ''),
    // 与 reviewed_head 分开记录：只有 hash 相同才能证明当前候选已经评审。
    reviewed_diff_hash: reviewed === undefined ? '' : (rechecks[reviewed]?.diff_hash ?? ''),
    head: git('rev-parse', 'HEAD').trim(),
    head_trusted: d.reason !== 'review_modified_checkout',
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
    console.error(
      `land: plan deadline ${String(plan().deadline)} passed; not producing merge commands`
    );
    process.exit(1);
  }
  const repo =
    env('TARGET_CHECKOUT') ||
    dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const base = env('BASE_REF');
  const target =
    env('TARGET_BRANCH') ||
    landTarget(repo, base, () => {
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
  const head = git('rev-parse', 'HEAD').trim();
  const out = {
    branch,
    repo,
    target,
    ff,
    head,
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
          `git -C ${q(repo)} merge ${ff ? '--ff-only' : '--no-ff'} ${q(env('MILESTONE') ? head : branch)}`,
        ]
      : [],
    debt: [...last.values()].flat(),
    ...(env('MILESTONE') ? { milestone: env('MILESTONE'), packages: env('PKGS').split(',') } : {}),
  };
  writeFileSync(join(artifacts, env('OUTPUT') || 'land.json'), JSON.stringify(out, null, 2));
  emit(out);
  if (!target) process.exit(1);
  return out;
}
export type Land = ReturnType<typeof land>;

if (import.meta.main) {
  const kinds: Partial<Record<string, () => unknown>> = {
    env: environment,
    accept,
    settle,
    gate,
    land,
  };
  const fn = kinds[env('KIND')];
  try {
    if (!fn) throw new Error(`sa-check: unknown INPUTS_KIND ${env('KIND')}`);
    await fn();
  } catch (error) {
    const engine_error = error instanceof Error ? error.message : String(error);
    emit({ ok: false, disposition: 'fail', reason: 'engine_suspect', engine_error });
    console.error(engine_error);
    process.exitCode = 1;
  }
}
