import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { lock, QUERY_TIMEOUT_MS } from './archon';
import { writeAtomic } from './config';
import {
  captureDelivery,
  checkoutChanges,
  integrationLockPath,
  publish,
  type DeliveryTarget,
} from './integration';
import { readJson, type Ledger } from './ledger';
import type { PublishReceipt } from './contract';
import type { Plan } from './plan';
import { scanText } from './secrets/scan';

interface Options {
  into?: string;
  dryRun?: boolean;
  messageFile?: string;
  accept?: string[];
}

interface Dependencies {
  home: string;
  ledgers: () => (Ledger | { run_id: string; error: string })[];
  state: (ledger: Ledger) => string;
  receipts: (ledger: Ledger) => string[];
  plan: (ledger: Ledger) => string | null;
  canMerge: (source: string) => boolean;
  orca: (parent: string, source: string, receipt: PublishReceipt, at: number) => Promise<void>;
}

interface Result {
  exit: number;
  value: Record<string, unknown>;
}
type Stage = 'composed' | 'accepted' | 'published' | 'synced' | 'done' | 'rejected';
interface Operation {
  id: string;
  at: number;
  stage: Stage;
  source: DeliveryTarget;
  parent: DeliveryTarget;
  T0: string;
  X0: string;
  U: string;
  X: string;
  C: string;
  tree: string;
  accept: { commit: string; tree: string; checked: number[]; skipped: boolean };
  warnings: string[];
}

const noTransport = 'sa-merge-no-network';
const localEnv = () => ({ ...process.env, GIT_ALLOW_PROTOCOL: noTransport });
const git = (cwd: string, args: string[], local = true) =>
  Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: local ? localEnv() : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
function checked(cwd: string, ...args: string[]): string {
  const result = git(cwd, args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trimEnd();
}

const lines = (text: string) => (text ? text.split('\n') : []);
const samePath = (path: string, target: string) => {
  try {
    return realpathSync(path) === target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(path) === target;
  }
};
const commonDir = (path: string) =>
  checked(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const keyOf = (source: string) => createHash('sha256').update(realpathSync(source)).digest('hex');
export const mergeLock = (source: string) =>
  lock(join(commonDir(source), `sa-merge-${keyOf(source)}.lock`));

class Refusal extends Error {
  constructor(
    readonly exit: number,
    readonly reason: string,
    readonly next_action: string,
    readonly evidence: Record<string, unknown> = {}
  ) {
    super(reason);
  }
}

const refuse = (reason: string, next: string, evidence?: Record<string, unknown>): never => {
  throw new Refusal(3, reason, next, evidence);
};

function ancestor(cwd: string, a: string, b: string): boolean {
  const result = git(cwd, ['merge-base', '--is-ancestor', a, b]);
  if (result.exitCode === 0 || result.exitCode === 1) return result.exitCode === 0;
  throw new Error('git merge-base --is-ancestor failed');
}

function terminalRuns(source: string, d: Dependencies): Ledger[] {
  const dir = join(d.home, 'intents');
  // Reconciliation saves the ledger before deleting the intent. Read in that order.
  for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
    const intentPath = join(dir, entry);
    let intent: { ledger: Ledger; host: string; pid: number; no_run_at?: string };
    try {
      intent = JSON.parse(readFileSync(intentPath, 'utf8')) as typeof intent;
      if (
        typeof intent.ledger.run_id !== 'string' ||
        (intent.ledger.delivery && typeof intent.ledger.delivery.checkout !== 'string')
      )
        throw new Error('invalid intent');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return refuse('intent_unreadable', '核对启动记录后再合并', { intent: intentPath });
    }
    const delivery = intent.ledger.delivery;
    if (delivery && samePath(delivery.checkout, source))
      refuse('launch_intent', '确认没有对应 run 且启动进程已退出后，由操作者移走 intent', {
        intent: intentPath,
        run_id: intent.ledger.run_id,
        host: intent.host,
        pid: intent.pid,
        started_at: intent.ledger.started_at,
        no_run_at: intent.no_run_at,
      });
  }

  const matched: Ledger[] = [];
  for (const ledger of d.ledgers()) {
    if ('error' in ledger)
      refuse('ledger_unreadable', '核对 run 记录后再合并', { run_id: ledger.run_id });
    if (!('delivery' in ledger)) continue;
    if (ledger.delivery && typeof ledger.delivery.checkout !== 'string')
      refuse('ledger_unreadable', '核对交付目标后再合并', { run_id: ledger.run_id });
    if (!ledger.delivery || !samePath(ledger.delivery.checkout, source)) continue;
    let state: string;
    try {
      state = d.state(ledger);
    } catch {
      state = 'unreadable';
    }
    if (!['completed', 'failed', 'cancelled', 'abandoned'].includes(state))
      refuse('run_not_terminal', '等任务结束或核实归属后再合并', { run_id: ledger.run_id, state });
    matched.push(ledger);
  }
  return matched;
}

const sha = /^[\da-f]{40}(?:[\da-f]{24})?$/;
// prettier-ignore
function coverage(source: DeliveryTarget, x: string, runs: Ledger[], d: Dependencies) {
  const { checkout, head } = source;
  const base = checked(checkout, 'merge-base', x, head);
  const commits = new Set(lines(checked(checkout, 'rev-list', `${base}..${head}`)));
  const uncovered = new Set(commits);
  const accept = new Map<string, number>();
  for (const run of runs) {
    let applies = false;
    for (const path of d.receipts(run)) {
      const receipt = readJson(path) as Partial<PublishReceipt> | undefined;
      if (receipt?.status !== 'published' || receipt.task !== run.run_id ||
          receipt.target?.branch !== source.branch || typeof receipt.target.checkout !== 'string' ||
          !samePath(receipt.target.checkout, checkout) ||
          !receipt.target_tip || !sha.test(receipt.target_tip) ||
          !receipt.integrated || !sha.test(receipt.integrated)) continue;
      if (!ancestor(checkout, receipt.target_tip, receipt.integrated)) continue;
      const introduced = lines(checked(checkout, 'rev-list', `${receipt.target_tip}..${receipt.integrated}`));
      for (const commit of introduced) {
        if (!commits.has(commit)) continue;
        uncovered.delete(commit);
        applies = true;
      }
    }
    if (!applies) continue;
    const path = d.plan(run);
    const plan = (path ? readJson(path) : undefined) as Pick<Plan, 'packages'> | undefined;
    if (!Array.isArray(plan?.packages) || plan.packages.length === 0)
      return refuse('accept_unreadable', '恢复对应 run 的 plan 后再合并', { run_id: run.run_id });
    for (const pkg of plan.packages) {
      if (!Array.isArray(pkg.accept) || !pkg.accept.length)
        refuse('accept_unreadable', '恢复对应 run 的 plan 后再合并', { run_id: run.run_id });
      for (const { cmd, timeout_s } of pkg.accept) {
        if (typeof cmd !== 'string' || !cmd.trim() || !Number.isFinite(timeout_s) || timeout_s <= 0)
          refuse('accept_unreadable', '恢复对应 run 的 plan 后再合并', { run_id: run.run_id });
        if (!accept.has(cmd)) accept.set(cmd, timeout_s * 1000);
      }
    }
  }
  return { commits: [...commits], uncovered: [...uncovered], accept };
}

function target(path: string): DeliveryTarget {
  try {
    return { ...captureDelivery(path), require_checkout: true };
  } catch {
    throw new Refusal(64, 'invalid_checkout', '指定存在且检出了分支的 worktree');
  }
}
const refTip = (destination: DeliveryTarget) =>
  checked(destination.checkout, 'rev-parse', `refs/heads/${destination.branch}`);
const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// prettier-ignore
export async function mergeTask(path: string, options: Options, d: Dependencies): Promise<Result> {
  let lease: ReturnType<typeof mergeLock> | undefined;
  const dry = options.dryRun;
  const output = (exit: number, value: Record<string, unknown>): Result =>
    dry ? { exit, value: JSON.parse(scanText(JSON.stringify(value))) as typeof value } : { exit, value };
  try {
    if (options.accept?.some(command => !command.trim()))
      throw new Refusal(64, 'invalid_accept', '提供非空的 --accept 命令');
    const source = target(path), cwd = source.checkout;
    const primary = checked(cwd, 'worktree', 'list', '--porcelain', '-z').split('\0')[0]?.slice(9);
    const parent = target(options.into ?? primary);
    if (parent.checkout === cwd || commonDir(parent.checkout) !== commonDir(cwd))
      throw new Refusal(64, 'invalid_parent', '指定同一仓库内的另一个检出');
    lease = mergeLock(cwd);
    if (!lease.ok) throw new Refusal(75, 'merge_lock_busy', '任务正在合并或接纳新 run，请稍后重试');

    const id = keyOf(cwd), dir = join(d.home, 'merges', id);
    const active = join(dir, 'active.json'), pin = `refs/superagent/merge/${id}`;
    let op = readJson(active) as Operation | undefined;
    if (op && (!/^[\da-f-]{36}$/.test(op.id) || !sha.test(op.C) || !sha.test(op.tree) ||
        op.source.checkout !== cwd || !['composed', 'accepted', 'published', 'synced', 'done', 'rejected'].includes(op.stage)))
      refuse('invalid_merge_state', '核对 active.json 后再恢复');
    if (op && op.parent.checkout !== parent.checkout)
      refuse('different_parent', '使用原合并的父检出恢复', { checkout: op.parent.checkout });
    const receiptPath = (name: string) => join(dir, op?.id ?? '', name);
    const save = (stage: Stage) => {
      if (!op) throw new Error('merge state unavailable');
      writeAtomic(active, json({ ...op, stage }));
      op.stage = stage;
    };
    const fence = () => {
      if (!d.canMerge(cwd)) refuse('source_owned', '请用 superagent handoff 交接任务检出');
    };
    const archive = (kind: 'failed' | 'done') => {
      if (!op) return;
      const current = git(cwd, ['rev-parse', '--verify', '--quiet', pin]);
      if (current.exitCode === 0 && current.stdout.toString().trim() === op.C)
        checked(cwd, 'update-ref', '-d', pin, op.C);
      renameSync(active, join(dir, `${kind}-${String(op.at)}-${op.id}.json`));
    };
    const receipt = (name: string): PublishReceipt | undefined => {
      const final = receiptPath(name), pending = final + '.pending';
      if (!existsSync(final) && existsSync(pending)) renameSync(pending, final);
      return readJson(final) as PublishReceipt | undefined;
    };
    const publishTo = (worktree: string, destination: DeliveryTarget, expected: string, name: string) =>
      publish({ worktree, target: destination, task: op?.id ?? id,
        contract: 'superagent merge', evidence: active, receipt: receiptPath(name),
        review: { required: false }, fence,
        gitAllowProtocol: noTransport,
      }, { target_tip: expected });
    const candidateFile = join(dir, 'candidate.json');
    const cleanCandidate = () => {
      const name = readJson(candidateFile);
      if (name === undefined) return;
      if (typeof name !== 'string' || !/^candidate-[\da-f-]{36}$/.test(name))
        refuse('invalid_candidate_state', '核对候选检出的归属再恢复');
      const root = join(dir, name as string);
      const worktree = join(root, 'worktree');
      if (existsSync(worktree)) {
        if (realpathSync(worktree) !== join(realpathSync(dir), name as string, 'worktree') ||
            commonDir(worktree) !== commonDir(cwd))
          refuse('invalid_candidate_state', '核对候选检出的归属再恢复');
        checked(cwd, 'worktree', 'remove', '--force', '--', worktree);
      }
      if (existsSync(root)) rmdirSync(root);
      unlinkSync(candidateFile);
    };
    function candidate<T>(base: string, use: (worktree: string) => T): T {
      cleanCandidate();
      const name = `candidate-${crypto.randomUUID()}`;
      const root = join(dir, name), worktree = join(root, 'worktree');
      mkdirSync(root, { mode: 0o700 });
      writeAtomic(candidateFile, json(name));
      try {
        checked(cwd, 'worktree', 'add', '--detach', '--', worktree, base);
        return use(worktree);
      } finally { cleanCandidate(); }
    }

    const isPublished = () => !!op && ancestor(cwd, op.C, refTip(op.parent));
    if (!dry && op?.stage === 'accepted' && isPublished()) {
      try { save('published'); }
      catch { return output(0, { status: 'published_pending', X0: op.X0, U: op.U, X: op.X, C: op.C,
        T0: op.T0, warnings: ['父检出已合入，重跑命令以恢复发布状态'] }); }
    }
    if (!dry && op && (op.stage === 'rejected' ||
        (['accepted', 'composed'].includes(op.stage) && refTip(op.parent) !== op.X))) {
      archive('failed');
      op = undefined;
    }
    if (!dry && op && ['accepted', 'composed'].includes(op.stage) &&
        (op.parent.branch !== parent.branch || op.source.branch !== source.branch))
      refuse('target_switched', '切回原分支后恢复合并');
    const pending = ({ X0, U, X, C, T0 }: Operation, warning: string) =>
      output(0, { status: 'published_pending', X0, U, X, C, T0, warnings: [warning] });
    const finish = async (operation: Operation) => {
      const { X0, U, X, C, T0, tree, at } = operation;
      let integrated: PublishReceipt | undefined;
      try { integrated = receipt('publish-parent.json'); } catch { /* pending receipt is recoverable */ }
      if (integrated?.integrated !== C)
        return pending(operation, '父检出已合入，重跑命令以恢复发布回执');
      if (operation.stage === 'published') {
        try {
          const result = candidate(C, worktree => publishTo(worktree, operation.source, T0, 'publish-task.json'));
          if (result.status !== 'published' &&
              !(result.status === 'advanced' && result.target_tip === C))
            operation.warnings.push(`任务检出同步待处理：${result.status}`);
          save('synced');
        } catch {
          return pending(operation, '父检出已合入，重跑命令以恢复任务检出同步');
        }
      }
      const parentCommand = `git -C ${shell(operation.parent.checkout)}`;
      const value = { ...integrated, X0, U, X, C, T0, tree, accept: operation.accept,
        warnings: operation.warnings, rollback: {
          ...(checked(operation.parent.checkout, 'rev-parse', 'HEAD') === C
            ? { local: `${parentCommand} reset --keep ${X}` } : {}),
          pushed: `${parentCommand} revert -m 1 ${C}`,
        },
      };
      try {
        cleanCandidate();
        writeAtomic(receiptPath('merge.json'), json(value));
        if (operation.stage !== 'done') {
          terminalRuns(cwd, d);
          fence();
          await d.orca(operation.parent.checkout, cwd, integrated, at);
          save('done');
        }
        archive('done');
        return output(0, value);
      } catch {
        return output(0, { ...value, status: 'published_pending',
          warnings: [...value.warnings, '父检出已合入，重跑命令以完成回执或 Orca 更新'] });
      }
    };
    if (!dry && op && ['published', 'synced', 'done'].includes(op.stage)) return await finish(op);

    for (const checkout of [cwd, parent.checkout]) {
      const paths = checkoutChanges(checkout);
      if (paths.length) refuse('target_dirty', '先提交或暂存检出的改动', { checkout, paths });
    }
    const runs = terminalRuns(cwd, d);
    fence();
    let message = '';
    if (!dry && !op) {
      if (!options.messageFile)
        throw new Refusal(64, 'message_file_required', '提供 --message-file <文件>');
      try { message = readFileSync(options.messageFile, 'utf8'); }
      catch { refuse('message_unreadable', '提供可读取的提交说明文件'); }
      if (!message.trim() || message !== scanText(message)) refuse('message_invalid', '提供非空且不含秘密的提交说明');
    }

    if (!op || dry) {
      const X0 = parent.head, T0 = source.head;
      const remote = git(parent.checkout, ['config', '--get', `branch.${parent.branch}.remote`]).stdout.toString().trim();
      const upstream = git(parent.checkout, ['config', '--get', `branch.${parent.branch}.merge`]).stdout.toString().trim();
      if (!remote || !upstream.startsWith('refs/heads/')) refuse('upstream_missing', '为父分支配置 upstream');
      const fetchLease = lock(integrationLockPath(commonDir(cwd), parent.branch));
      if (!fetchLease.ok) return refuse('target_busy', '父分支正在发布，请稍后重试');
      const U = (() => {
        try {
          const fetched = git(parent.checkout, ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-auto-maintenance', '--refmap=', '--', remote, upstream], false);
          if (fetched.exitCode !== 0) return refuse('fetch_failed', '核对父分支 upstream 和连接后重试');
          return checked(parent.checkout, 'rev-parse', 'FETCH_HEAD');
        } finally { fetchLease.release(); }
      })();
      const fastForward = X0 !== U && ancestor(cwd, X0, U);
      if (!fastForward && !ancestor(cwd, U, X0))
        refuse('upstream_diverged', '先人工处理父分支与 upstream 的分叉', { X0, U, T0 });
      const X = fastForward ? U : X0;
      const covered = coverage(source, X, runs, d);
      const commands = new Map<string, number | undefined>(covered.accept);
      for (const command of options.accept ?? []) if (!commands.has(command)) commands.set(command, undefined);
      const alreadyIncluded = ancestor(cwd, T0, X);
      const summary = { T0, X0, U, X, commits: covered.commits, uncovered: covered.uncovered };
      if (dry) return output(0, { status: 'dry_run', ...summary,
        composition: alreadyIncluded ? 'noop' : 'merge', fast_forward: fastForward, accept: [...commands.keys()],
        stat: checked(cwd, 'diff', '--stat', '--no-ext-diff', '--no-textconv', checked(cwd, 'merge-base', X, T0), T0),
        ...(op ? { active_stage: op.stage === 'accepted' && isPublished() ? 'published' : op.stage,
          C: op.C } : {}),
      });
      if (covered.uncovered.length && !options.accept?.some(cmd => cmd.trim()))
        refuse('accept_required', '为未覆盖提交提供 --accept', summary);
      const at = Date.now();
      const operation = { id: crypto.randomUUID(), at, stage: 'composed', source, parent,
        T0, X0, U, X, warnings: [] } as Omit<Operation, 'C' | 'tree' | 'accept'>;
      const align = () => {
        const aligned = candidate(U, worktree => publishTo(worktree, parent, X0, 'align.json'));
        if (aligned.status !== 'published') return refusalForPublish(aligned);
      };
      mkdirSync(dir, { recursive: true });
      if (fastForward) align();
      if (alreadyIncluded) return output(0, { status: 'noop', ...summary });

      const composed = candidate(X, worktree => {
        const merged = git(worktree, ['merge', '--no-ff', '--no-commit', T0]);
        if (merged.exitCode !== 0) {
          const files = checked(worktree, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
          if (files.length) {
            checked(worktree, 'merge', '--abort');
            return refuse('conflict', '在任务检出合入父分支并解决冲突后重试', { ...summary, files });
          }
          return refuse('compose_failed', '核对候选检出和 Git 配置');
        }
        const tree = checked(worktree, 'write-tree');
        if (tree === checked(worktree, 'rev-parse', `${X}^{tree}`)) return undefined;
        const previous = readdirSync(dir).filter(file => file.startsWith('failed-'));
        // A retry in the same second with the same message must get a fresh commit ID.
        const last = Math.max(0, ...previous.map(file => Number(file.split('-')[1]) || 0));
        operation.at = Math.max(at, (Math.floor(last / 1000) + 1) * 1000);
        const file = join(dir, `message-${operation.id}`);
        writeAtomic(file, message);
        const committed = Bun.spawnSync(['git', '-C', worktree, 'commit', '-F', file], {
          env: { ...localEnv(), GIT_COMMITTER_DATE: `@${String(Math.floor(operation.at / 1000))} +0000` },
          stdout: 'pipe', stderr: 'pipe', timeout: QUERY_TIMEOUT_MS,
        });
        if (committed.exitCode !== 0) return refuse('commit_failed', '核对提交 hook 后重试');
        const C = checked(worktree, 'rev-parse', 'HEAD');
        if (checked(worktree, 'rev-parse', 'HEAD^{tree}') !== tree)
          return refuse('hook_changed_tree', '先在任务检出提交所需改动再合并');
        if (checked(worktree, 'show', '-s', '--format=%P', C) !== `${X} ${T0}`)
          return refuse('merge_parents_changed', '核对提交 hook 后重试');
        const loggedMessage = checked(worktree, 'show', '-s', '--format=%B', C);
        if (scanText(loggedMessage) !== loggedMessage)
          return refuse('message_invalid', '核对提交 hook 生成的说明');
        checked(cwd, 'update-ref', pin, C);
        const next = { ...operation, C, tree, accept: { commit: C, tree, checked: [],
          skipped: covered.uncovered.length === 0 && tree === checked(cwd, 'rev-parse', `${T0}^{tree}`),
        } };
        mkdirSync(join(dir, next.id));
        writeAtomic(join(dir, next.id, 'commands.json'), json([...commands]));
        writeAtomic(active, json(next));
        return next;
      });
      if (!composed) return output(0, { status: 'noop', ...summary });
      op = composed;
    }

    if (op.stage === 'composed') {
      const commands = new Map(readJson(receiptPath('commands.json')) as [string, number | null][]);
      for (const command of options.accept ?? []) if (!commands.has(command)) commands.set(command, null);
      const failed = candidate(op.C, worktree => {
        if (op.accept.skipped) return false;
        op.accept.checked = [];
        for (const [index, [command, timeout]] of [...commands].entries()) {
          const log = receiptPath(`accept-${String(index + 1)}.log`);
          const result = Bun.spawnSync(['bash', '-c', command], {
            cwd: worktree, env: localEnv(), stdout: 'pipe', stderr: 'pipe', timeout: timeout ?? undefined,
          });
          writeFileSync(log, scanText(result.stdout.toString() + result.stderr.toString()));
          const exit = result.success ? 0 : result.exitCode || 1;
          op.accept.checked.push(exit);
          if (exit !== 0 || checked(worktree, 'rev-parse', 'HEAD') !== op.C ||
              checked(worktree, 'write-tree') !== op.tree ||
              checkoutChanges(worktree).some(change => change.startsWith('tracked: '))) return true;
        }
        return false;
      });
      if (failed) {
        save('rejected');
        const value = { status: 'rejected', reason: 'accept_failed', C: op.C, X: op.X, accept: op.accept };
        archive('failed');
        return output(1, value);
      }
      save('accepted');
    }
    if (op.stage !== 'accepted' || op.accept.commit !== op.C || op.accept.tree !== op.tree ||
        checked(cwd, 'rev-parse', `${op.C}^{tree}`) !== op.tree || op.accept.checked.some(exit => exit !== 0))
      return refuse('accept_state_invalid', '核对候选提交与验收记录');
    try {
      const result = candidate(op.C, worktree => publishTo(worktree, op.parent, op.X, 'publish-parent.json'));
      if (result.status !== 'published') return refusalForPublish(result);
    } catch (error) {
      // publish may have fast-forwarded the ref before its receipt rename failed.
      if (!isPublished()) throw error;
    }
    try { save('published'); }
    catch { return pending(op, '父检出已合入，重跑命令以恢复发布状态'); }
    return await finish(op);
  } catch (error) {
    try {
      if (error instanceof Refusal) return output(error.exit, {
        status: 'rejected', reason: error.reason, next_action: error.next_action, ...error.evidence,
      });
      if (!dry) return { exit: 3, value: { status: 'rejected', reason: 'merge_interrupted',
        next_action: '核对合并记录后重跑命令', evidence: scanText((error as Error).message),
      } };
    } catch { /* no unscanned diagnostics */ }
    return { exit: 3, value: { status: 'rejected', reason: 'merge_interrupted',
      next_action: '核对合并记录和脱敏工具后重跑命令',
    } };
  } finally {
    if (lease?.ok) lease.release();
  }
}

function refusalForPublish(
  result: Exclude<ReturnType<typeof publish>, { status: 'published' }>
): never {
  return refuse(
    result.status === 'rejected' ? result.reason : `target_${result.status}`,
    '核对父检出后重跑合并',
    { publish: result }
  );
}
