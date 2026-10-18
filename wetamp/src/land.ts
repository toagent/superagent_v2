import type { Ledger } from './cli';
import { createRequire } from 'node:module';
// Load operator evidence only at the delivery boundary, not during config bootstrap.
const operator = () => createRequire(import.meta.url)('./cli.ts') as typeof import('./cli');
import {
  assertCommander,
  caller,
  control,
  coord,
  repoScope,
  same,
  type Controller,
  type Identity,
} from './coord';
import { budgetReason, readPolicyAttempts } from '../templates/.archon/scripts/policy-attempts';
import type { resolveAcceptanceContext } from './role-context';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archonJson, getRun, lastJson, tail, lock, QUERY_TIMEOUT_MS, type RunView } from './archon';
import { loadTiers } from './config';
import { redact } from './redact';
import {
  deliveryDecision,
  budgetUsage,
  landTarget,
  type Accept,
  type Review,
  type Land,
} from '../templates/.archon/scripts/sa-check';
import type { Plan } from './plan';
/** Fixed codes are safe for intervention persistence; diagnostics stay in message. */
export class LandError extends Error {
  constructor(
    code:
      | 'codegraph_exclude_failed'
      | 'delivery_git_failed'
      | 'not_ready'
      | 'repository_missing'
      | 'target_missing'
      | 'target_protected'
      | 'git_failed'
      | 'integration_lock_timeout'
      | 'delivery_target_changed'
      | 'target_dirty'
      | 'source_head_drifted'
      | 'source_dirty'
      | 'source_tree_changed'
      | 'target_history_changed'
      | 'target_history_check_failed'
      | 'integration_ancestry_failed'
      | 'candidate_ancestry_failed'
      | 'merge_conflicts'
      | 'submodule_init_failed'
      | 'environment_failed'
      | 'acceptance_failed'
      | 'candidate_changed'
      | 'target_checkout_changed'
      | 'target_advanced'
      | 'integration_outcome_unknown',
    message: string
  ) {
    super(message);
    this.name = `land_${code}`;
  }
}
/** Shared Git metadata keeps the main index out of every worktree's clean checks. */
export function excludeCodegraph(repo: string): void {
  const result = Bun.spawnSync(
    ['git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0)
    throw new LandError(
      'codegraph_exclude_failed',
      'codegraph: cannot resolve common info/exclude'
    );
  const file = result.stdout.toString().trim();
  if (!existsSync(file) || !readFileSync(file, 'utf8').split('\n').includes('.codegraph/'))
    appendFileSync(file, '\n.codegraph/\n');
}
export interface DeliveryTarget {
  checkout: string;
  branch: string;
  head: string;
}
export const protectedTarget = (branch: string): boolean =>
  /^(main|master|dev|develop|release-.*)$/.test(branch);
export interface LocalDelivery {
  task: string;
  target: DeliveryTarget;
  contract: string;
  receipt: string;
  title: string;
  evidence: string;
}
export interface DeliveryReceipt {
  task: string;
  source: string;
  target: DeliveryTarget;
  contract: string;
  evidence: string;
  accepted: string;
  reused?: { paths: string[]; tree: string };
  integrated: string;
  target_tip: string;
  status: 'manual_push';
  push: string;
}
export type DeliveryOutcome =
  | DeliveryReceipt
  | (Omit<DeliveryReceipt, 'accepted' | 'target_tip' | 'status'> & {
      status: 'unknown';
      reason: string;
    });
/** A receipt is evidence only while both accepted commits remain in the target history. */
// prettier-ignore
export function integratedReceipt(receipt: DeliveryOutcome | undefined, source: string, expected: Pick<LocalDelivery, 'task' | 'target' | 'contract' | 'evidence'>): DeliveryReceipt | undefined {
  if (!receipt || receipt.status !== 'manual_push' || receipt.task !== expected.task ||
    receipt.source !== source || receipt.contract !== expected.contract || receipt.evidence !== expected.evidence ||
    receipt.target.checkout !== expected.target.checkout || receipt.target.branch !== expected.target.branch || receipt.target.head !== expected.target.head ||
    receipt.accepted !== receipt.integrated || ![source, receipt.accepted].every(sha => /^[a-f0-9]{40}$/.test(sha))) return;
  const ancestor = (from: string, to: string) => Bun.spawnSync(
    ['git', '-C', expected.target.checkout, 'merge-base', '--is-ancestor', from, to],
    { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }
  ).exitCode === 0;
  return ancestor(expected.target.head, receipt.accepted) && ancestor(source, receipt.accepted) && ancestor(receipt.accepted, `refs/heads/${expected.target.branch}`) ? receipt : undefined;
}
export function captureDelivery(checkout: string): DeliveryTarget {
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', checkout, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0)
      throw new LandError('delivery_git_failed', `delivery: ${p.stderr.toString().trim()}`);
    return p.stdout.toString().trim();
  };
  return {
    checkout: realpathSync(git('rev-parse', '--show-toplevel')),
    branch: git('symbolic-ref', '--short', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
  };
}
export const integrationLockTimeout = (): number =>
  (process.env.NODE_ENV === 'test' && Number(process.env.SA_INTEGRATION_LOCK_TIMEOUT_MS)) ||
  20 * 60_000;
// prettier-ignore
export function applyLand(run: RunView, land: Pick<Land, 'branch' | 'head'> & Partial<Land>, verify: (cwd: string) => number, context?: { repo: string; base_ref: string; launch_branch?: string; delivery?: LocalDelivery; plan?: Plan; cacheReady?: (cwd: string) => boolean }): DeliveryOutcome | undefined {
  if ((!['completed', 'running'].includes(run.status) || !run.nodes?.some(n => n.nodeId === 'land' && n.state === 'completed')) ||
    (run.status !== 'completed' && (!context?.delivery || !run.nodes.some(n => n.nodeId === 'deliver' && n.state === 'running') || run.nodes.some(n => n.nodeId !== 'deliver' && !['completed', 'skipped'].includes(n.state)))))
    throw new LandError('not_ready', 'land: run is not ready for integration');
  const delivery = context?.delivery;
  const repo = delivery?.target.checkout ?? land.repo ?? context?.repo; if (!repo) throw new LandError('repository_missing', 'land: missing repository');
  const target = delivery?.target.branch ?? land.target ?? (context && landTarget(repo, context.base_ref, () => context.launch_branch)); if (!target) throw new LandError('target_missing', 'land: missing integration target');
  if (delivery && protectedTarget(target)) throw new LandError('target_protected', 'delivery: protected target branch');
  const gitAt = (cwd: string, ...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
    if (p.exitCode !== 0) throw new LandError('git_failed', `land: ${p.stderr.toString().trim()}`);
    return p.stdout.toString().trimEnd();
  };
  const git = (...args: string[]): string => gitAt(repo, ...args);
  const targetCheckout = () => git('worktree', 'list', '--porcelain', '-z').split('\0\0').find(record => record.split('\0').includes(`branch refs/heads/${target}`))?.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  const lockfile = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), `sa-land-${createHash('sha256').update(target).digest('hex')}.lock`);
  let lease = lock(lockfile);
  const deadline = Date.now() + integrationLockTimeout();
  while (!lease.ok && Date.now() < deadline) { Bun.sleepSync(50); lease = lock(lockfile); }
  if (!lease.ok) throw new LandError('integration_lock_timeout', 'land: timed out waiting for integration lock');
  try {
  const checkout = targetCheckout();
  if (delivery && (!checkout || realpathSync(checkout) !== delivery.target.checkout || gitAt(checkout, 'symbolic-ref', '--short', 'HEAD') !== target)) throw new LandError('delivery_target_changed', 'delivery: target checkout/branch changed');
  const clean = () => {
    const records = checkout ? gitAt(checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0') : [];
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const row = records[i]; if (!row) continue;
      paths.push(`${row.startsWith('??') ? 'untracked' : 'tracked'}: ${JSON.stringify(row.slice(3))}`);
      if (/[RC]/.test(row.slice(0, 2))) i++; // porcelain -z includes a second rename/copy path.
    }
    if (paths.length) throw new LandError('target_dirty', `land: target checkout is dirty\n${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n... ${String(paths.length - 20)} more paths` : ''}`);
  };
  clean();
  const tree = git('rev-parse', `${land.head}^{tree}`);
  const sameTree = () => {
    if (delivery && git('rev-parse', land.branch) !== land.head) throw new LandError('source_head_drifted', 'delivery: source HEAD drifted');
    if (delivery && run.working_path && gitAt(run.working_path, 'status', '--porcelain', '--untracked-files=all')) throw new LandError('source_dirty', 'delivery: source checkout is dirty');
    if (git('rev-parse', `${land.branch}^{tree}`) !== tree) throw new LandError('source_tree_changed', 'land: branch tree differs from accepted tree');
  };
  sameTree();
  const targetHistory = (tip: string) => {
    if (!delivery) return;
    const p = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', delivery.target.head, tip], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
    if (p.exitCode === 1) throw new LandError('target_history_changed', 'delivery: target HEAD is not a descendant of launch HEAD');
    if (p.exitCode !== 0) throw new LandError('target_history_check_failed', `delivery: cannot verify launch HEAD ancestry: ${p.stderr.toString().trim()}`);
  };
  targetHistory(git('rev-parse', `refs/heads/${target}`));
  const ancestor = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', land.head, `refs/heads/${target}`], { stdout: 'pipe', stderr: 'pipe' });
  if (ancestor.exitCode > 1) throw new LandError('integration_ancestry_failed', `delivery: ${ancestor.stderr.toString().trim()}`);
  // Git evidence, never a supplied receipt, determines whether integration already happened.
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const push = `git -C ${q(repo)} push origin ${q(target)}`;
  if (ancestor.exitCode === 0) {
    const integrated = git('rev-parse', `refs/heads/${target}`);
    if (!delivery) { console.log(`land: already integrated ${integrated}; acceptance unknown; manual push: ${push}`); return; }
    let prior: unknown;
    if (existsSync(delivery.receipt)) {
      try { prior = JSON.parse(readFileSync(delivery.receipt, 'utf8')); }
      catch { /* An unreadable receipt requires fresh acceptance below. */ }
    }
    const reconciled = integratedReceipt(prior as DeliveryOutcome | undefined, land.head, delivery);
    if (reconciled?.integrated === integrated && reconciled.push === push && typeof reconciled.target_tip === 'string' &&
      Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', reconciled.target_tip, integrated], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0) return reconciled;
    // Ancestry proves integration, not acceptance: reuse the candidate path below.
  }
  let receipt: DeliveryReceipt | undefined;
  for (let attempt = 0; ; attempt++) {
  const tip = git('rev-parse', `refs/heads/${target}`);
  targetHistory(tip);
  const root = mkdtempSync(join(tmpdir(), 'sa-land-')), candidate = join(root, 'wt');
  try {
    git('worktree', 'add', '--detach', candidate, tip);
    const ff = Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', tip, land.head], { stdout: 'pipe', stderr: 'pipe' });
    if (ff.exitCode > 1) throw new LandError('candidate_ancestry_failed', `land: ${ff.stderr.toString().trim()}`);
    try { gitAt(candidate, 'merge', ff.exitCode === 0 ? '--ff-only' : '--no-ff', '-m', delivery ? `${delivery.title}\n\nTask: ${delivery.task}\nAcceptance contract: ${delivery.contract}\nLocal delivery; manual push required.` : `Merge ${land.branch}`, land.head); }
    catch (e) {
      const conflicts = gitAt(candidate, 'diff', '--name-only', '--diff-filter=U');
      if (!conflicts) throw e;
      const solver = Bun.which('mergiraf', { PATH: process.env.PATH });
      if (solver) for (const file of conflicts.split('\n')) {
        const solved = Bun.spawnSync([solver, 'solve', file], { cwd: candidate, stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS });
        if (solved.exitCode === 0) gitAt(candidate, 'add', '--', file);
      }
      const remaining = gitAt(candidate, 'diff', '--name-only', '--diff-filter=U');
      if (remaining) {
        gitAt(candidate, 'merge', '--abort');
        throw new LandError('merge_conflicts', `land: merge conflicts:\n${remaining}\nnext: git -C ${repo} merge --no-ff ${land.branch}`);
      }
      gitAt(candidate, 'commit', '--no-edit');
    }
    const prepareSubmodules = (cwd: string, sources: string[]): void => {
      if (!existsSync(join(cwd, '.gitmodules'))) return;
      const entries = gitAt(cwd, 'config', '--file', '.gitmodules', '--list', '-z');
      for (const entry of entries.split('\0').filter(entry => /^submodule\..*\.path\n/.test(entry))) {
        const [key, path] = entry.split('\n'), name = key.slice(10, -5), dest = join(cwd, path);
        const commit = gitAt(cwd, 'rev-parse', `HEAD:${path}`), url = gitAt(cwd, 'config', '--file', '.gitmodules', '--get', `submodule.${name}.url`);
        const local = sources.flatMap(source => [join(source, path), join(gitAt(source, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'modules', name)]);
        const cached = local.find(source => (existsSync(join(source, '.git')) || existsSync(join(source, 'HEAD'))) && Bun.spawnSync(['git', '-C', source, 'cat-file', '-e', `${commit}^{commit}`], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }).exitCode === 0);
        const command = (dir: string, ...args: string[]): void => {
          const p = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 20 * 60_000 });
          if (p.exitedDueToTimeout || p.exitCode !== 0)
            throw new LandError('submodule_init_failed', `land: submodule initialization failed (exit ${String(p.exitCode)}${p.exitedDueToTimeout ? ', timed out' : ''}); paths: ${redact(dest)}; log tail:\n${redact(p.stdout.toString() + p.stderr.toString()).split('\n').slice(-20).join('\n')}`);
        };
        // Standalone clones keep all configuration inside the candidate, never the shared superproject.
        command(cwd, '-c', 'protocol.file.allow=always', 'clone', '--no-checkout', '--', cached ?? url, dest);
        if (!cached && Bun.spawnSync(['git', '-C', dest, 'cat-file', '-e', `${commit}^{commit}`], { stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS }).exitCode !== 0)
          command(dest, 'fetch', 'origin', commit);
        command(dest, 'checkout', '--detach', commit);
        prepareSubmodules(dest, [dest, ...(cached ? [cached] : [])]);
      }
    };
    const accepted = gitAt(candidate, 'rev-parse', 'HEAD');
    const log = join(delivery?.evidence ?? mkdtempSync(join(tmpdir(), 'sa-land-env-')), 'land-environment.log');
    const timed = <T>(stage: 'environment' | 'acceptance' | 'integrate', action: () => T): T => {
      const start = performance.now();
      try { return action(); }
      finally { appendFileSync(log, `# land stage=${stage} attempt=${String(attempt)} ms=${String(performance.now() - start)}\n`); }
    };
    timed('environment', () => {
    if (context?.cacheReady?.(candidate)) return;
    prepareSubmodules(candidate, [...new Set([repo, ...(run.working_path ? [run.working_path] : [])])]);
    const script = `import { prepareEnvironment } from ${JSON.stringify(join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts'))}; const { plan, log } = await Bun.stdin.json(); const out = await prepareEnvironment(process.cwd(), plan, log, true); console.log(JSON.stringify(out)); process.exitCode = out.ok ? 0 : 1;`;
    const prepared = Bun.spawnSync([process.execPath, '-e', script], { cwd: candidate, env: { ...process.env, INPUTS_KIND: 'env' }, stdin: Buffer.from(JSON.stringify({ plan: context?.plan ?? { packages: [] }, log })), stdout: 'pipe', stderr: 'pipe' });
    if (prepared.exitCode !== 0) throw new LandError('environment_failed', `land: environment preparation failed; log: ${log}; ${redact(prepared.stdout.toString() + prepared.stderr.toString()).slice(-4000)}`);
    });
    if (timed('acceptance', () => verify(candidate)) !== 0) throw new LandError('acceptance_failed', 'land: acceptance failed');
    if (gitAt(candidate, 'rev-parse', 'HEAD') !== accepted || gitAt(candidate, 'status', '--porcelain', '--untracked-files=all')) throw new LandError('candidate_changed', 'land: acceptance changed candidate checkout');
    sameTree(); clean();
    if (targetCheckout() !== checkout) throw new LandError('target_checkout_changed', 'land: target checkout changed during acceptance; retry land --apply');
    if (git('rev-parse', `refs/heads/${target}`) !== tip) {
      if (attempt < 2) continue;
      throw new LandError('target_advanced', 'land: target advanced during acceptance after 2 retries');
    }
    timed('integrate', () => {
    if (accepted !== tip) {
      if (checkout) gitAt(checkout, 'merge', '--ff-only', accepted);
      else git('update-ref', `refs/heads/${target}`, accepted, tip);
    }
    });
    if (checkout && existsSync(join(checkout, '.codegraph'))) {
      try {
        excludeCodegraph(checkout);
        const sync = Bun.spawnSync([Bun.which('codegraph', {PATH: process.env.PATH}) ?? 'codegraph', 'sync'], {cwd: checkout, stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS});
        if (sync.exitCode !== 0) console.error(JSON.stringify({event: 'codegraph.sync_failed', exit: sync.exitCode}));
      } catch { console.error(JSON.stringify({event: 'codegraph.sync_failed'})); }
    }
    if (!delivery) console.log(`land: integrated ${accepted} in ${checkout ?? repo}`);
    if (delivery) {
      const integrated = git('rev-parse', `refs/heads/${target}`);
      if (integrated !== accepted) throw new LandError('integration_outcome_unknown', 'delivery: target changed after integration; outcome unknown');
      receipt = { task: delivery.task, source: land.head, target: delivery.target, target_tip: tip, contract: delivery.contract, evidence: delivery.evidence, accepted, integrated, status: 'manual_push', push };
      const temp = `${delivery.receipt}.${String(process.pid)}.tmp`;
      writeFileSync(temp, JSON.stringify(receipt, null, 2));
      renameSync(temp, delivery.receipt);
    }
    break;
  } finally {
    try { if (existsSync(candidate)) git('worktree', 'remove', '--force', candidate); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  }
  for (const args of delivery ? [] : [...(run.working_path ? [['worktree', 'remove', run.working_path]] : []), ['branch', '-d', land.branch]]) {
    try { git(...args); } catch (e) { console.error(`land: kept ${String(args.at(-1))}: ${(e as Error).message}`); }
  }
  return receipt;
  } finally { lease.release(); }
}

/** 在 run 的 worktree 里跑 plan 的验收命令（同 verify 节点脚本），退出码即结果。 */
export function acceptRun(
  l: Ledger,
  pkg: string | undefined,
  cwd?: string,
  cacheArt?: string,
  report = true,
  cacheOnly = false
): number {
  const { artifactsOf, decisionOf, evidenceJson, planOf, print, readJson } = operator();
  const run = archonJson(
    ['workflow', 'get', l.archon_run_id, '--verbose', '--events'],
    l.repo
  ) as unknown as RunView & { events: Parameters<typeof budgetUsage>[0] };
  if (!run.working_path) throw new Error(`accept: run ${l.run_id} has no worktree`);
  const plan = planOf(l);
  if (pkg && !plan.packages.some(p => p.id === pkg))
    throw new Error(`accept: unknown package ${pkg}`);
  const art = cacheArt ?? artifactsOf(run);
  const contracts = readJson(join(l.gen_dir, 'accept-inputs.json')) as Record<string, string>[];
  if (!Array.isArray(contracts)) throw new Error('accept: missing generated acceptance contract');
  const selected = pkg
    ? contracts.filter(c => c.tag === `verify-${pkg}`)
    : [...new Set(contracts.map(c => c.milestone))].map(m =>
        [...contracts]
          .reverse()
          .find(
            c =>
              c.milestone === m &&
              c.tag.startsWith('diff-') &&
              evidenceJson(l, art, `${c.tag}.json`)
          )
      );
  if (!selected.length || selected.some(c => !c))
    throw new Error('accept: missing acceptance evidence');
  const resolved = Bun.spawnSync([process.execPath, join(import.meta.dir, 'role-context.ts')], {
    stdin: Buffer.from(JSON.stringify({ run, contracts: selected, art })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (resolved.exitCode !== 0)
    throw new Error(`accept: input resolution failed: ${resolved.stderr.toString()}`);
  const { inputs: resolvedInputs, events_file } = JSON.parse(resolved.stdout.toString()) as Awaited<
    ReturnType<typeof resolveAcceptanceContext>
  >;
  mkdirSync(art, { recursive: true });
  let code = 0;
  for (const inputs of resolvedInputs) {
    const prior = evidenceJson(l, art, `${inputs.tag}.json`) as Accept | undefined;
    const gate = evidenceJson(l, art, `${inputs.tag.replace('diff-', 'gate-')}.json`);
    // prettier-ignore
    const p = Bun.spawnSync(
      cacheOnly
        ? [process.execPath, '-e', `import { acceptanceCacheReady } from ${JSON.stringify(join(l.gen_dir, '.archon', 'scripts', 'sa-check.ts'))}; process.exitCode = acceptanceCacheReady(process.cwd()) ? 0 : 1;`]
        : [process.execPath, join(l.gen_dir, '.archon', 'scripts', 'sa-check.ts')],
      {
        cwd: cwd ?? run.working_path,
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(inputs).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v])
          ),
          INPUTS_TAG: `accept-${inputs.tag}`,
          INPUTS_EVENTS_FILE: events_file,
          WORKFLOW_ID: run.id,
          ARTIFACTS_DIR: art,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    if (cacheOnly) {
      if (p.exitCode !== 0) code = 1;
      continue;
    }
    const out = lastJson(p.stdout.toString()) as (Record<string, unknown> & Accept) | undefined;
    const same =
      !!out?.contract_hash &&
      out.contract_hash === prior?.contract_hash &&
      !!out.diff_hash &&
      out.diff_hash === prior.diff_hash &&
      decisionOf(gate)?.kind === 'debt';
    const reviews = same
      ? (evidenceJson(l, art, `${inputs.tag.replace('diff-', 'gate-')}.review.json`) as
          | Review
          | undefined)
      : undefined;
    let { decision } = deliveryDecision({
      rechecks: out ? [out] : [],
      approved: { check: prior, decision: decisionOf(gate) },
      risk: out?.risk ?? inputs.risk,
      strict: plan.mode === 'strict',
      ...(reviews ? { reviews: [reviews] } : {}),
    });
    const limits = plan.budget;
    const used = budgetUsage(
      run.events,
      loadTiers().policy.budget_floor.S,
      readPolicyAttempts(art)
    );
    const reason = budgetReason(limits, used, false);
    if (p.exitCode !== 0)
      decision = { ...decision, kind: 'block', reason: out?.reason ?? 'engine_suspect' };
    if (reason)
      console.warn(JSON.stringify({ code: 'superagent.budget_observed', reason, used, limits }));
    const ok = ['advance', 'debt'].includes(decision.kind);
    if (report)
      print(
        out
          ? {
              ...out,
              decision,
              ok,
              ...(reason ? { budget_advisory: reason } : {}),
            }
          : { ok: false, error: tail(p.stderr.toString()) }
      );
    if (!ok) code = 1;
  }
  return code;
}

/** Plan and quick share real acceptance and the original audited landing admission. */
export function finalizeDelivery(
  id: string,
  automatic = false,
  who: Identity = caller(),
  authorization?: DeliveryAuthorization
) {
  const { artifactsOf, evidenceJson, intervention, loadLedger, planOf, updateLedger } = operator();
  if (!authorization) assertCommander();
  const l = loadLedger(coord().resolveRun(id)?.run_id ?? id);
  if (
    authorization &&
    (!same(who, authorization.run) ||
      !same(who, authorization.repo) ||
      ![authorization.run, authorization.repo].every(
        c => Number.isSafeInteger(c.generation) && c.generation > 0
      ) ||
      process.env.WORKFLOW_ID !== l.archon_run_id)
  )
    throw new Error('delivery: authorization/run mismatch');
  const deliver = () =>
    control(
      l,
      controller => {
        const target = l.delivery;
        const run = getRun(l.archon_run_id, l.repo),
          art = artifactsOf(run);
        const land = evidenceJson(l, art, 'land.json') as Land | undefined;
        if (!land) throw new Error('delivery: missing generated land evidence');
        let receipt: ReturnType<typeof applyLand>;
        intervention(
          l,
          'land',
          () => {
            receipt = applyLand(run, land, cwd => acceptRun(l, undefined, cwd, art, false), {
              repo: l.repo,
              plan: planOf(l),
              cacheReady: cwd => acceptRun(l, undefined, cwd, art, false, true) === 0,
              base_ref: planOf(l).base_ref,
              launch_branch: l.launch_branch,
              delivery: target ? localDelivery(l, art, target) : undefined,
            });
            return 0;
          },
          undefined,
          undefined,
          undefined,
          automatic || authorization ? 'engine' : 'operator'
        );
        updateLedger(l, cur => {
          cur.controller = controller;
          cur.delivery_result =
            receipt?.status === 'manual_push' ? { ...receipt, status: 'integrated' } : receipt;
        });
        return receipt;
      },
      who,
      authorization?.run.generation ?? (automatic ? (l.controller?.generation ?? 0) : undefined)
    );
  return coord().mutate(
    repoScope(l.repo),
    who,
    deliver,
    authorization?.repo.generation,
    integrationLockTimeout()
  );
}

export interface DeliveryAuthorization {
  run: Controller;
  repo: Controller;
}
const localDelivery = (l: Ledger, evidence: string, target: DeliveryTarget): LocalDelivery => ({
  task: l.run_id,
  target,
  evidence,
  title: operator()
    .planOf(l)
    .packages.map(p => p.title)
    .join('; '),
  receipt: join(evidence, 'delivery.json'),
  contract: createHash('sha256')
    .update(readFileSync(join(l.gen_dir, 'accept-inputs.json')))
    .digest('hex'),
});
/** Observation never advances Git or rewrites the ledger. */
export function deliveryProjection(l: Ledger, run: RunView): DeliveryReceipt | undefined {
  const { artifactsOf, evidenceJson } = operator();
  if (!l.delivery) return;
  const art = artifactsOf(run),
    land = evidenceJson(l, art, 'land.json') as Land | undefined;
  const inputs = join(l.gen_dir, 'accept-inputs.json');
  if (!land || !existsSync(inputs)) return;
  return integratedReceipt(
    evidenceJson(l, art, 'delivery.json') as DeliveryOutcome | undefined,
    land.head,
    localDelivery(l, art, l.delivery)
  );
}
// Finish entry evaluation before loading the operator's circular import.
if (import.meta.main)
  queueMicrotask(() => {
    if (!process.env.INPUTS_RUN) throw new Error('delivery: missing run id');
    const { loadLedger, print, readJson } = operator();
    const l = loadLedger(process.env.INPUTS_RUN);
    const { run, repo } = (readJson(join(l.gen_dir, 'delivery-authorization.json')) ??
      {}) as Partial<DeliveryAuthorization>;
    if (!run || !repo) throw new Error('delivery: missing durable authorization');
    print(finalizeDelivery(l.run_id, false, run, { run, repo }));
  });

/** Re-entry is safe only for our generated, authorized delivery, after all gates. */
export function deliveryRecoverable(run: RunView): boolean {
  try {
    const ref = coord().resolveRun(run.id);
    if (!ref) return false;
    const l = operator().loadLedger(ref.run_id);
    return (
      l.archon_run_id === run.id &&
      !!l.delivery &&
      existsSync(join(l.gen_dir, 'delivery-authorization.json')) &&
      !!run.nodes?.some(n => n.nodeId === 'land' && n.state === 'completed') &&
      run.nodes.every(n => n.nodeId === 'deliver' || ['completed', 'skipped'].includes(n.state))
    );
  } catch {
    return false;
  }
}
