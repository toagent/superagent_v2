import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { lock, runStatuses } from '../archon';
import { home, writeAtomic, WETAMP } from '../config';
import { launcher, inspectProcess, type Launcher } from '../launcher';

const { readProcessHeartbeats } = createRequire(import.meta.url)('../../hooks/identity.cjs') as {
  readProcessHeartbeats: (identity: Identity, home: string) => Identity[];
};

export interface Identity {
  client: string;
  session_id?: string;
  host?: string;
  pid: number;
  pid_start?: string;
}
interface Admission {
  scope: Scope;
  controller: Controller;
  parent?: { pid: number; start?: string };
}
export type Controller = Identity & { generation: number };
export type Scope = { kind: 'repo'; id: string } | { kind: 'run'; id: string; repo: string };
export type Presence =
  | { state: 'online'; activity: 'active' | 'idle' }
  | { state: 'offline' | 'unknown' };
interface Claim {
  scope: Scope;
  owner: Identity | null;
  generation: number;
  since: string;
  reason: string;
  history: { owner: Identity | null; generation: number; at: string; reason: string }[];
}
export interface RunRef {
  run_id: string;
  archon_run_id: string;
  repo: string;
  controller?: Controller;
  launcher?: Launcher;
  state?: string;
  rejected?: string;
  intervention_events?: { action: string; ok: boolean }[];
  gen_dir?: string;
}
export interface DeliveryReauthorization {
  run: Controller;
  repo: Controller;
  original_sha256: string;
  at: string;
}
export type MessageState = 'queued' | 'surfaced' | 'accepted' | 'rejected' | 'done' | 'escalated';
export interface Message {
  id: string;
  scope: Scope;
  sender: Identity;
  recipient: Identity | null;
  generation: number;
  kind: 'bug' | 'task' | 'question' | 'takeover-request';
  title: string;
  body: string;
  evidence: string[];
  dedupe_key?: string;
  severity: 'normal' | 'urgent';
  state: MessageState;
  at: string;
  note?: string;
  type?: 'receipt' | 'takeover';
  source?: string;
  ask?: {
    id?: string;
    question: string;
    status: string;
    generation: number;
    owner: Identity | null;
  };
  ask_round?: number;
  deferred_until?: number;
}
const shared = createRequire(import.meta.url)('../../hooks/coord.cjs') as {
  repoScope: (path: string) => Extract<Scope, { kind: 'repo' }> | null;
  runScope: (run: Pick<RunRef, 'run_id' | 'repo'>) => Extract<Scope, { kind: 'run' }>;
  resolveRun: (home: string, target: string) => RunRef | undefined;
  archonMutation: (args: string[]) => boolean;
  isRunOwnershipEvidence: (run: RunRef, status?: string) => boolean;
  admission: (
    home: string,
    scope: Scope,
    who: Identity,
    expected?: number,
    archon?: string,
    view?: { owner: Identity | null; generation: number }
  ) => Controller;
  hash: (value: unknown) => string;
  read: (file: string) => unknown;
  files: <T = Message>(home: string, dir: string) => T[];
  refusal: (
    action: string,
    owner: Identity | null,
    state: Presence['state'],
    scope?: Scope
  ) => string;
  resolveOwner: (
    scope: Scope,
    claims: Claim[],
    runs: { scope: Scope; owner?: Identity; generation: number; evidence: string }[]
  ) => { owner: Identity | null; generation: number; conflicts: Identity[]; evidence: string[] };
};
const identity = createRequire(import.meta.url)('../../hooks/identity.cjs') as {
  same: (a: Identity | null | undefined, b: Identity | null | undefined) => boolean;
  key: (who: Identity) => (string | number | null)[];
  presence: (who: Identity, home: string) => Presence;
};
export const presence = identity.presence,
  same = identity.same,
  identityKey = identity.key;
export const archonMutation = shared.archonMutation;
export const scopeRepoName = (scope: Scope): string => {
  const path = scope.kind === 'repo' ? scope.id : scope.repo;
  return basename(basename(path) === '.git' ? dirname(path) : path);
};
export const ownerLabel = (who: Identity | null): string =>
  who ? `${who.client} ${who.session_id?.slice(0, 8) ?? `pid:${String(who.pid)}`}` : '无主';
export const ACK_TIMEOUT_MS = 15 * 60_000;
// Keep operator-facing queues bounded and observable without inventing another lock protocol.
export const QUEUE_WAIT: Readonly<{
  timeoutMs: number;
  retryMs: number;
  progressMs: number;
}> = Object.freeze({ timeoutMs: 120_000, retryMs: 50, progressMs: 30_000 });
export class CoordRegistryWaitError extends Error {
  readonly reason = 'coord_registry_timeout';
  constructor(readonly waitMs: number) {
    super(`coord: registry wait timed out after ${String(waitMs)}ms`);
    this.name = 'CoordRegistryWaitError';
  }
}
export function repoScope(path: string): Extract<Scope, { kind: 'repo' }> {
  const scope = shared.repoScope(path);
  if (!scope) throw new Error(`coord: not a repository: ${path}`);
  return scope;
}
export const runScope = shared.runScope;
export function assertCommander(): void {
  const role = process.env.SUPERAGENT_ROLE ?? '';
  if (['general', 'strategist', 'reviewer', 'worker'].includes(role))
    throw new Error(`派生会话不参与认领或控制；请交回元帅（当前角色：${role}）`);
}
export function caller(readonly = false): Identity {
  if (!readonly) assertCommander();
  const who = launcher(home().sa);
  if (who?.pid_start) return who;
  // A human shell is also an explicit local controller; use its parent lifetime, never the short-lived CLI PID.
  const p = inspectProcess(process.ppid);
  if (p.state !== 'online' || !p.start) throw new Error('coord: 无法验证调用者进程身份');
  return { client: 'shell', host: hostname(), pid: process.ppid, pid_start: p.start };
}
export function cleanEngine(root = WETAMP): string {
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error('换版拒绝：引擎必须位于已提交的 git 检出');
    return p.stdout.toString();
  };
  const top = git('rev-parse', '--show-toplevel').trim();
  const dirty = git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    .split('\0')
    .filter(Boolean);
  if (
    dirty.some(
      row =>
        !(
          row.startsWith('?? ') &&
          /(?:^|\/)node_modules$/.test(row.slice(3)) &&
          lstatSync(join(top, row.slice(3))).isSymbolicLink()
        )
    )
  )
    throw new Error('换版拒绝：引擎工作树不干净；请先提交并评审，再 adopt/retry');
  return git('rev-parse', '--verify', 'HEAD^{commit}').trim();
}
interface Deps {
  sa: string;
  runs: (id?: string) => RunRef[];
  status: (l: RunRef) => string;
  statuses: () => Map<string, string> | null | undefined;
  now: () => number;
  sleep: (ms: number) => void;
  presence: (who: Identity) => Presence;
}
interface Stores {
  claims: Claim;
  leases: { generation: number };
  inbox: Message;
}
export class Coordination {
  private depth = 0;
  private scopes = new Set<string>();
  private active?: Admission;
  readonly d: Deps;
  constructor(overrides: Partial<Deps> = {}) {
    const sa = overrides.sa ?? home().sa;
    this.d = {
      sa,
      now: Date.now,
      sleep: Bun.sleepSync,
      presence: who => presence(who, sa),
      runs: id => {
        const dir = join(sa, 'runs');
        // A run's owner must not depend on unrelated ledgers being readable.
        const names = existsSync(dir) ? readdirSync(dir) : [];
        return names
          .filter(n => n.endsWith('.json') && (!id || n === `${id}.json`))
          .map(n => {
            const l = shared.read(join(dir, n)) as RunRef | null;
            if (!l || typeof l.repo !== 'string' || typeof l.run_id !== 'string')
              throw new Error(`coord: invalid ledger ${n}`);
            return l;
          });
      },
      status: l => {
        if (l.state === 'failed') return 'failed';
        const db = new Database(join(home().archon, 'archon.db'), { readonly: true });
        try {
          const r = db
            .query('select status from remote_agent_workflow_runs where id=?')
            .get(l.archon_run_id) as { status: string } | null;
          return r?.status ?? 'unknown';
        } finally {
          db.close();
        }
      },
      statuses: overrides.status
        ? () => undefined
        : () => {
            try {
              return runStatuses();
            } catch {
              return null;
            }
          },
      ...overrides,
    };
  }
  private path(dir: string, key: string): string {
    return join(this.d.sa, 'coord', dir, key + '.json');
  }
  private read<K extends keyof Stores>(dir: K, key: string): Stores[K] | null {
    const value = shared.read(this.path(dir, key));
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`coord: corrupt ${dir}`);
    return value as Stores[K];
  }
  private save(dir: string, key: string, value: unknown): void {
    this.locked(() => {
      const file = this.path(dir, key);
      mkdirSync(dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(value) + '\n');
    });
  }
  locked<T>(f: () => T, waitMs = QUEUE_WAIT.timeoutMs): T {
    if (this.depth) return f();
    const root = join(this.d.sa, 'coord');
    mkdirSync(root, { recursive: true });
    const deadline = this.d.now() + waitMs;
    let nextProgress = this.d.now() + QUEUE_WAIT.progressMs;
    for (;;) {
      const k = lock(join(root, 'registry.lock'));
      if (k.ok) {
        this.depth++;
        try {
          return f();
        } finally {
          this.depth--;
          k.release();
        }
      }
      const now = this.d.now();
      if (now >= deadline) throw new CoordRegistryWaitError(waitMs);
      if (now >= nextProgress) {
        console.error('coord: waiting for registry lock');
        nextProgress = now + QUEUE_WAIT.progressMs;
      }
      Bun.sleepSync(Math.min(QUEUE_WAIT.retryMs, deadline - now));
    }
  }
  private scopeLock(scope: Scope): string {
    return join(
      this.d.sa,
      'coord',
      'locks',
      shared.hash(scope.kind === 'run' ? { kind: 'repo', id: scope.repo } : scope) + '.lock'
    );
  }
  scoped<T>(scope: Scope, f: () => T, waitMs = 120_000): T {
    const key = this.scopeLock(scope);
    if (this.scopes.has(key)) return f();
    const root = join(this.d.sa, 'coord', 'locks');
    mkdirSync(root, { recursive: true });
    const deadline = this.d.now() + waitMs;
    let nextNotice = 0,
      holder = 'pid unknown';
    for (;;) {
      const k = lock(key);
      if (k.ok) {
        this.scopes.add(key);
        const release = (): void => {
          this.scopes.delete(key);
          k.release();
        };
        try {
          const r = f();
          if (r instanceof Promise) return r.finally(release) as T;
          release();
          return r;
        } catch (e) {
          release();
          throw e;
        }
      }
      const now = this.d.now();
      if (now >= nextNotice || now >= deadline) {
        try {
          const info = shared.read(key) as { pid?: unknown } | null;
          if (typeof info?.pid === 'number') holder = `pid ${String(info.pid)}`;
        } catch (e) {
          // The holder truncates metadata after flock; partial JSON still means busy.
          if (!(e instanceof SyntaxError)) throw e;
        }
        if (now >= deadline)
          throw new Error(
            `coord: scope busy; holder ${holder}; lock ${key}; wait for holder to finish, then retry delivery`
          );
        if (waitMs > 120_000) console.error(`coord: waiting for ${holder}; lock ${key}`);
        nextNotice = now + 30_000;
      }
      Bun.sleepSync(50);
    }
  }
  resolveRun(id: string): RunRef | undefined {
    return shared.resolveRun(this.d.sa, id);
  }
  admissionEnv(inheritLock = false): Record<string, string> {
    if (!this.active) return {};
    const token = randomUUID();
    this.locked(() => {
      this.save('admissions', token, {
        ...this.active,
        parent: inheritLock
          ? { pid: process.pid, start: inspectProcess(process.pid).start }
          : undefined,
      });
    });
    return { SA_COORD_ADMISSION: token };
  }
  consume(token: string): Admission {
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('coord: invalid admission token');
    return this.locked(() => {
      const file = this.path('admissions', token),
        value = shared.read(file) as typeof this.active;
      if (!value) throw new Error('coord: unknown admission token');
      rmSync(file);
      return value;
    });
  }
  scope(target = process.cwd()): Scope {
    const l = this.resolveRun(target);
    return l ? runScope(l) : repoScope(resolve(target));
  }
  private claimOf(scope: Scope): Claim | null {
    const c = this.read('claims', shared.hash(scope));
    if (
      c &&
      (!Number.isSafeInteger(c.generation) ||
        c.generation < 1 ||
        !Array.isArray(c.history) ||
        shared.hash(c.scope) !== shared.hash(scope))
    )
      throw new Error('coord: corrupt claim');
    return c;
  }
  isRunOwnershipEvidence(
    run: RunRef,
    statuses: ReturnType<Deps['statuses']> | false = false
  ): boolean {
    if (!shared.isRunOwnershipEvidence(run)) return false;
    let status: string | undefined;
    try {
      status = statuses
        ? statuses.get(run.archon_run_id)
        : statuses === null
          ? undefined
          : this.d.status(run);
    } catch {
      // Unreadable engine state remains ownership evidence.
    }
    return shared.isRunOwnershipEvidence(run, status);
  }
  private ownerWithStatuses(
    scope: Scope,
    statuses: ReturnType<Deps['statuses']> | false = false
  ): {
    scope: Scope;
    owner: Identity | null;
    generation: number;
    conflicts: Identity[];
    presence: Presence;
    evidence: string[];
    next: string;
  } {
    const repo: Scope = scope.kind === 'run' ? { kind: 'repo', id: scope.repo } : scope;
    const claims = [this.claimOf(scope)].filter((c): c is Claim => !!c);
    const snapshot =
      claims.length || scope.kind === 'run' || statuses !== false ? statuses : this.d.statuses();
    const runs = claims.length
      ? []
      : this.d
          .runs(scope.kind === 'run' ? scope.id : undefined)
          .filter(l => {
            if (scope.kind === 'run') return l.run_id === scope.id;
            // A ledger whose repository no longer resolves cannot share a live repository's scope.
            return (
              this.isRunOwnershipEvidence(l, snapshot) && shared.repoScope(l.repo)?.id === repo.id
            );
          })
          .map(l => ({
            scope: runScope(l),
            owner: l.controller ?? l.launcher,
            generation: l.controller?.generation ?? 0,
            evidence: `nonterminal run ${l.run_id} ${l.controller ? 'controller' : 'legacy launcher'}`,
          }));
    const view = shared.resolveOwner(scope, claims, runs);
    if (!view.owner && !view.conflicts.length) view.evidence.push('no owner');
    return {
      scope,
      ...view,
      presence: view.owner ? this.d.presence(view.owner) : { state: 'unknown' },
      next: view.conflicts.length
        ? 'conflicting controllers: claim --takeover --reason "<原话>" required'
        : view.owner
          ? 'superagent handoff --to <path|run>'
          : 'superagent claim <path|run>',
    };
  }
  owner(scope: Scope): ReturnType<Coordination['ownerWithStatuses']> {
    return this.ownerWithStatuses(scope);
  }
  unfinishedRuns(sessionId: string): { run_id: string; status: string }[] {
    const statuses = this.d.statuses();
    return this.d.runs().flatMap(l => {
      if (!this.isRunOwnershipEvidence(l, statuses)) return [];
      let owner: Identity | null = l.controller ?? l.launcher ?? null;
      try {
        owner = this.ownerWithStatuses(runScope(l), statuses).owner;
      } catch {
        // Shipped ledgers may outlive their repository; their recorded owner remains the only source.
      }
      if (owner?.session_id !== sessionId) return [];
      try {
        const status = this.d.status(l);
        return [{ run_id: l.run_id, status }];
      } catch {
        return [{ run_id: l.run_id, status: 'unknown' }];
      }
    });
  }
  ownedNonterminalRuns(client: string) {
    const statuses = this.d.statuses();
    return this.d.runs().flatMap(l => {
      if (!this.isRunOwnershipEvidence(l, statuses)) return [];
      const view = this.ownerWithStatuses(runScope(l), statuses);
      return view.owner?.client === client && !view.conflicts.length
        ? [{ run_id: l.run_id, repo: l.repo, owner: view.owner, generation: view.generation }]
        : [];
    });
  }
  private leaseKey(scope: Scope, who: Identity): string {
    return shared.hash([scope, identity.key(who)]);
  }
  // prettier-ignore
  private transfer(scope: Scope, who: Identity | null, reason: string, renewal = false, notify = true): Claim {
    const old = this.claimOf(scope),
      view = this.owner(scope),
      at = new Date(this.d.now()).toISOString();
    const generation = Math.max(old?.generation ?? 0, view.generation) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('coord: generation exhausted');
    const c: Claim = {
      scope,
      owner: who,
      generation,
      since: at,
      reason,
      history: [...(old?.history ?? []), { owner: who, generation, at, reason }],
    };
    if (renewal && !old && view.owner)
      c.history.unshift({ owner: view.owner, generation: view.generation, at, reason });
    this.save('claims', shared.hash(scope), c);
    if (who) this.save('leases', this.leaseKey(scope, who), { generation: c.generation });
    for (const previous of view.owner ? [view.owner] : view.conflicts)
      if (notify && !renewal && !same(previous, who))
        this.notice('takeover', scope, who ?? previous, previous, c.generation, reason);
    return c;
  }
  // prettier-ignore
  rolloverTransfer(scope: Scope, from: Identity, to: Identity, token: string): { status: 'transferred' | 'unchanged' | 'skipped'; generation?: number; reason?: string } {
    return this.scoped(scope, () =>
      this.locked(() => {
        const owner = this.owner(scope).owner;
        if (same(owner, to)) return { status: 'unchanged', generation: this.owner(scope).generation };
        if (!same(owner, from)) return { status: 'skipped', reason: 'owner_changed' };
        const claim = this.transfer(scope, to, `rollover:${token}`, false, false);
        return { status: 'transferred', generation: claim.generation };
      })
    );
  }
  // prettier-ignore
  reclaimRun(
    scope: Extract<Scope, { kind: 'run' }>,
    expected: { key: ReturnType<typeof identity.key>; generation: number },
    to: Identity
  ): { status: 'transferred' | 'skipped'; generation?: number; reason?: string } {
    return this.scoped(scope, () =>
      this.locked(() => {
        const view = this.owner(scope),
          repo = this.owner({ kind: 'repo', id: scope.repo });
        if (
          !view.owner ||
          JSON.stringify(identity.key(view.owner)) !== JSON.stringify(expected.key) ||
          view.generation !== expected.generation
        )
          return { status: 'skipped', reason: 'owner_changed' };
        if (same(view.owner, to)) return { status: 'skipped', reason: 'same_owner' };
        if (view.presence.state !== 'offline')
          return { status: 'skipped', reason: 'owner_not_offline' };
        if (!repo.owner || !same(repo.owner, to) || repo.presence.state !== 'online')
          return { status: 'skipped', reason: 'target_not_online_repo_owner' };
        const claim = this.transfer(scope, to, 'reclaim:owner_offline', false, false);
        return { status: 'transferred', generation: claim.generation };
      })
    );
  }
  private identityCompletion(owner: Identity | null, who: Identity): boolean {
    if (
      !owner ||
      owner.session_id ||
      !who.session_id ||
      owner.client !== who.client ||
      owner.host !== who.host ||
      owner.pid !== who.pid ||
      owner.pid_start !== who.pid_start
    )
      return false;
    try {
      const matching = readProcessHeartbeats(who, this.d.sa);
      return matching.length === 1 && matching[0]?.session_id === who.session_id;
    } catch (error) {
      console.error(
        `coord identity completion heartbeat read failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
  private claimState(scope: Scope, who: Identity, takeover: boolean) {
    const view = this.owner(scope),
      completion = !takeover && this.identityCompletion(view.owner, who);
    if (view.conflicts.length && !takeover) throw new Error(view.next);
    if (
      view.owner &&
      !same(view.owner, who) &&
      !completion &&
      view.presence.state !== 'offline' &&
      !takeover
    )
      throw new Error(shared.refusal('普通认领', view.owner, view.presence.state, scope));
    return { view, existing: this.claimOf(scope), completion };
  }
  private applyClaim(
    scope: Scope,
    who: Identity,
    reason: string,
    state: ReturnType<Coordination['claimState']>
  ): Controller {
    const claim =
      same(state.view.owner, who) && state.existing
        ? state.existing
        : this.transfer(
            scope,
            who,
            state.completion
              ? `身份补全：唯一 live 会话以相同 client/host/pid/pid_start 关联 ${String(who.session_id)}`
              : reason,
            false,
            !state.completion
          );
    this.save('leases', this.leaseKey(scope, who), { generation: claim.generation });
    return { ...who, generation: claim.generation };
  }
  claim(
    scope: Scope,
    who: Identity,
    takeover = false,
    reason = '认领'
  ): { controller: Controller; inbox: Message[] } {
    return this.scoped(scope, () =>
      this.locked(() => {
        if (!who.host || !who.pid_start) throw new Error('coord: claim needs verifiable identity');
        if (takeover && !reason.trim()) throw new Error('claim --takeover needs --reason "<原话>"');
        const controller = this.applyClaim(
          scope,
          who,
          reason,
          this.claimState(scope, who, takeover)
        );
        return { controller, inbox: this.inbox(who) };
      })
    );
  }
  claimRun(
    scope: Extract<Scope, { kind: 'run' }>,
    who: Identity,
    takeover = false,
    reason = '认领'
  ): { controller: Controller; repository: Controller; inbox: Message[] } {
    return this.scoped(scope, () =>
      this.locked(() => {
        if (!who.host || !who.pid_start) throw new Error('coord: claim needs verifiable identity');
        if (takeover && !reason.trim()) throw new Error('claim --takeover needs --reason "<原话>"');
        const repo = { kind: 'repo' as const, id: scope.repo };
        const runState = this.claimState(scope, who, takeover),
          repoState = this.claimState(repo, who, takeover);
        if (
          takeover &&
          repoState.view.owner &&
          !same(repoState.view.owner, who) &&
          repoState.view.presence.state !== 'offline'
        )
          throw new Error(
            shared
              .refusal('run 级接管', repoState.view.owner, repoState.view.presence.state, repo)
              .replace('<path|run>', scope.repo)
              .replace('claim --takeover', `claim ${scope.repo} --takeover`)
          );
        const controller = this.applyClaim(scope, who, reason, runState),
          repository = this.applyClaim(repo, who, reason, repoState);
        return { controller, repository, inbox: this.inbox(who) };
      })
    );
  }
  reauthorize(run: RunRef, who: Identity): DeliveryReauthorization {
    const genDir = run.gen_dir;
    if (!genDir || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(run.run_id))
      throw new Error('reauthorize: invalid run ledger');
    return this.mutate(runScope(run), who, runController => {
      const repository = this.owner(repoScope(run.repo));
      if (!repository.owner) throw new Error('reauthorize: repository contact unavailable');
      const original = readFileSync(join(genDir, 'delivery-authorization.json'));
      const authorization = {
        run: runController,
        repo: { ...repository.owner, generation: repository.generation },
        original_sha256: createHash('sha256').update(original).digest('hex'),
        at: new Date(this.d.now()).toISOString(),
      };
      this.save('authorizations', run.run_id, authorization);
      return authorization;
    });
  }
  release(scope: Scope, who: Identity): void {
    this.mutate(scope, who, () => {
      this.locked(() => {
        this.transfer(scope, null, '主动释放');
      });
    });
  }
  admit(scope: Scope, who: Identity, expected?: number): Controller {
    const admit = (): Controller =>
      this.locked(() => {
        let view = this.owner(scope);
        const previous = view.owner;
        // Only the native launcher evidence can authorize a process-lifetime change.
        if (
          this.scopes.has(this.scopeLock(scope)) &&
          previous &&
          !same(previous, who) &&
          previous.session_id &&
          previous.pid_start &&
          previous.session_id === who.session_id &&
          previous.client === who.client &&
          previous.host === who.host &&
          who.host === hostname() &&
          who.pid_start &&
          same(launcher(this.d.sa), who) &&
          view.presence.state === 'offline' &&
          inspectProcess(who.pid).start === who.pid_start &&
          (expected === undefined || expected === view.generation) &&
          !shared
            .files<Claim>(this.d.sa, 'claims')
            .some(
              c =>
                c.owner?.client === who.client &&
                c.owner.session_id === who.session_id &&
                !same(c.owner, who) &&
                this.d.presence(c.owner).state !== 'offline'
            )
        ) {
          expected = this.transfer(scope, who, 'same-session-renewal', true).generation;
          view = this.owner(scope);
        }
        return shared.admission(this.d.sa, scope, who, expected, join(this.d.sa, 'archon'), view);
      });
    return same(this.owner(scope).owner, who) ? admit() : this.scoped(scope, admit);
  }
  inherited(a: Admission): boolean {
    if (a.parent?.pid !== process.ppid || a.parent.start !== inspectProcess(a.parent.pid).start)
      return false;
    const file = this.scopeLock(a.scope),
      k = lock(file);
    if (k.ok) {
      k.release();
      return false;
    }
    return (shared.read(file) as { pid: number }).pid === a.parent.pid;
  }
  mutate<T>(
    scope: Scope,
    who: Identity,
    f: (controller: Controller) => T,
    expected?: number,
    waitMs?: number
  ): T {
    return this.scoped(
      scope,
      () => {
        const controller = this.admit(scope, who, expected);
        const previous = this.active;
        this.active = { scope, controller };
        try {
          return f(controller);
        } finally {
          this.active = previous;
        }
      },
      waitMs
    );
  }
  messages(): Message[] {
    return shared.files(this.d.sa, 'inbox');
  }
  private routedMessages(
    who: Identity,
    all: boolean
  ): { message: Message; owner?: ReturnType<Coordination['ownerWithStatuses']> }[] {
    let statuses: ReturnType<Deps['statuses']> | false = false;
    const owners = new Map<string, ReturnType<Coordination['ownerWithStatuses']>>(),
      routed: { message: Message; owner?: ReturnType<Coordination['ownerWithStatuses']> }[] = [];
    for (const message of this.messages()) {
      if (!all && ['done', 'rejected'].includes(message.state)) continue;
      if (message.type) {
        if (same(message.recipient, who)) routed.push({ message });
      } else {
        const key = shared.hash(message.scope);
        let owner = owners.get(key);
        if (!owner) {
          if (statuses === false) statuses = this.d.statuses();
          owner = this.ownerWithStatuses(message.scope, statuses);
          owners.set(key, owner);
        }
        if (same(owner.owner ?? message.recipient, who)) routed.push({ message, owner });
      }
    }
    return routed;
  }
  inbox(who: Identity, all = false): Message[] {
    return this.routedMessages(who, all).map(({ message }) => message);
  }
  waitInbox(who: Identity, timeoutMs: number): Message[] | null {
    const seen = new Set(this.inbox(who).map(message => message.id)),
      deadline = this.d.now() + timeoutMs;
    while (this.d.now() < deadline) {
      this.d.sleep(Math.min(3_000, deadline - this.d.now()));
      const messages = this.inbox(who).filter(message => !seen.has(message.id));
      if (messages.length) return messages;
    }
    return null;
  }
  receipt(scope: Scope, sender: Identity, recipient: Identity, ask: string, option: string): void {
    const at = new Date(this.d.now()).toISOString();
    this.notice('receipt', scope, sender, recipient, 0, `ask ${ask}：${option}（${at}）`, ask);
  }
  private notice(
    type: 'receipt' | 'takeover',
    scope: Scope,
    sender: Identity,
    recipient: Identity,
    generation: number,
    body: string,
    source = ''
  ): void {
    const id = shared.hash([type, scope, source, generation, sender, recipient]);
    if (!shared.read(this.path('inbox', id)))
      this.save('inbox', id, {
        id,
        type,
        scope,
        sender,
        recipient,
        generation,
        kind: 'task',
        title: type === 'takeover' ? '归属已转移' : '交接回执',
        body,
        evidence: [],
        severity: 'normal',
        state: 'queued',
        at: new Date(this.d.now()).toISOString(),
        source,
      });
  }
  handoff(
    scope: Scope,
    sender: Identity,
    input: Pick<Message, 'kind' | 'title' | 'body' | 'evidence' | 'dedupe_key' | 'severity'>,
    waitMs = 120_000,
    claimUnowned = true
  ): Record<string, unknown> {
    const deliver = (): Record<string, unknown> =>
      this.locked(() => {
        let view = this.owner(scope),
          claimed = false;
        if (view.conflicts.length) throw new Error(view.next);
        if (!view.owner && claimUnowned) {
          this.claim(scope, sender);
          view = this.owner(scope);
          claimed = true;
        }
        if (same(view.owner, sender) && !claimed)
          return {
            routed_to: sender,
            presence: view.presence,
            delivery: 'self',
            next: '自己处理',
          };
        const matching = input.dedupe_key
            ? this.messages().filter(
                message =>
                  shared.hash(message.scope) === shared.hash(scope) &&
                  message.kind === input.kind &&
                  message.dedupe_key === input.dedupe_key
              )
            : [],
          duplicate = matching.find(message => !['done', 'rejected'].includes(message.state)),
          at = new Date(this.d.now()).toISOString();
        if (duplicate) {
          duplicate.evidence = [...new Set([...duplicate.evidence, ...input.evidence])];
          duplicate.at = at;
          this.save('inbox', duplicate.id, duplicate);
          return {
            id: duplicate.id,
            routed_to: view.owner,
            presence: view.presence,
            delivery: 'queued',
            next: '已追加到现有交接',
          };
        }
        const id = shared.hash([
          scope,
          input.kind,
          input.title,
          [...input.evidence].sort(),
          ...(input.dedupe_key ? [input.dedupe_key, matching.length] : []),
        ]);
        if (!shared.read(this.path('inbox', id)))
          this.save('inbox', id, {
            ...input,
            id,
            scope,
            sender,
            recipient: view.owner,
            generation: view.generation,
            state: 'queued',
            at,
          });
        return {
          id,
          routed_to: view.owner,
          presence: view.presence,
          delivery: 'queued',
          next: claimed ? '已认领，由你处理' : '收件人必须通过 inbox --ack 答复',
        };
      }, waitMs);
    return this.scoped(scope, deliver, waitMs);
  }
  surfaced(who: Identity): Message[] {
    const candidates = this.routedMessages(who, false).flatMap(({ message, owner }) => {
      if (!['queued', 'escalated'].includes(message.state) && same(message.recipient, who))
        return [];
      const next = { ...message };
      if (next.state === 'queued') next.state = 'surfaced';
      if (!next.type) {
        next.recipient = who;
        next.generation = owner?.generation ?? next.generation;
      }
      return [{ before: JSON.stringify(message), next }];
    });
    return this.locked(() =>
      candidates.flatMap(({ before, next }) => {
        const current = this.read('inbox', next.id);
        if (!current || JSON.stringify(current) !== before) return [];
        this.save('inbox', next.id, next);
        return [next];
      })
    );
  }
  ack(id: string, who: Identity, state: 'accepted' | 'rejected' | 'done', note: string): void {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('inbox: invalid message id');
    const initial = this.read('inbox', id);
    if (!initial) throw new Error('inbox: unknown id');
    this.scoped(initial.scope, () => {
      this.locked(() => {
        const m = this.read('inbox', id);
        if (!m) throw new Error('inbox: unknown id');
        const apply = (): void => {
          if (m.state === state && m.note === note) {
            if (!m.type)
              this.notice(
                'receipt',
                m.scope,
                who,
                m.sender,
                this.owner(m.scope).generation,
                `${state}: ${note}`,
                `${id}:${state}`
              );
            return;
          }
          if (
            ['done', 'rejected'].includes(m.state) ||
            (m.state === 'accepted' && state !== 'done')
          )
            throw new Error('inbox: invalid state transition');
          m.state = state;
          m.note = note;
          this.save('inbox', id, m);
          if (!m.type)
            this.notice(
              'receipt',
              m.scope,
              who,
              m.sender,
              this.owner(m.scope).generation,
              `${state}: ${note}`,
              `${id}:${state}`
            );
        };
        if (m.type) {
          if (!same(m.recipient, who)) throw new Error('inbox: only recipient can ack');
          apply();
        } else this.mutate(m.scope, who, apply);
      });
    });
  }
  pending(scope: Scope): number {
    return this.messages().filter(
      m =>
        shared.hash(m.scope) === shared.hash(scope) &&
        !m.type &&
        ['queued', 'surfaced', 'accepted', 'escalated'].includes(m.state)
    ).length;
  }
  answerEscalation(id: string, generation: number, persist: (key: string) => void): boolean {
    if (!/^[0-9a-f]{64}$/.test(id)) return false;
    const initial = this.read('inbox', id);
    if (!initial) return false;
    return this.scoped(initial.scope, () =>
      this.locked(() => {
        const m = this.read('inbox', id),
          view = m && this.owner(m.scope);
        if (
          !m ||
          m.type ||
          m.state !== 'escalated' ||
          !m.ask ||
          !['pending', 'unknown'].includes(m.ask.status) ||
          m.ask.generation !== generation ||
          !view ||
          view.conflicts.length ||
          view.generation !== generation ||
          !same(view.owner, m.ask.owner)
        )
          return false;
        persist(`coord:${m.id}:${String(generation)}:0`);
        return true;
      })
    );
  }
  // Supervisor is an injected transport. Every answer is fenced against the owner/generation asked about.
  tick(
    ask: (key: string, question: string) => { id?: string; status: string }
  ): Record<string, unknown>[] {
    return this.messages()
      .filter(m => !m.type && ['queued', 'surfaced', 'escalated'].includes(m.state))
      .flatMap(m =>
        this.scoped(m.scope, () => {
          const view = this.owner(m.scope);
          if (view.conflicts.length) throw new Error(view.next);
          if ((m.deferred_until ?? 0) > this.d.now()) return [];
          // An answer or expiry settles this owner's question. A new owner generation may ask once.
          if (
            m.ask &&
            ['no', 'expired'].includes(m.ask.status) &&
            m.ask.generation === view.generation
          )
            return [];
          const immediate = view.presence.state === 'offline' && m.severity === 'urgent';
          if (!immediate && this.d.now() - Date.parse(m.at) < ACK_TIMEOUT_MS) return [];
          if (view.presence.state === 'offline' && !immediate) return [];
          if (same(view.owner, m.sender)) return [];
          const key = `coord:${m.id}:${String(view.generation)}:0`;
          const title = escalationTitle(m, view.presence.state);
          const a = ask(key, title);
          m.state = 'escalated';
          m.ask = { ...a, question: title, generation: view.generation, owner: view.owner };
          this.save('inbox', m.id, m);
          if (a.status === 'yes') {
            if (
              m.ask.generation !== this.owner(m.scope).generation ||
              !same(m.ask.owner, this.owner(m.scope).owner)
            )
              throw new Error('coord: stale takeover answer');
            this.claim(
              m.scope,
              m.sender,
              true,
              `${scopeRepoName(m.scope)} 已于 ${new Date(this.d.now()).toISOString()} 经用户批准转给 ${m.sender.client}`
            );
          }
          if (['no', 'expired'].includes(a.status)) {
            m.state = 'queued';
            this.save('inbox', m.id, m);
          }
          return [
            {
              id: m.id,
              action: a.status === 'yes' ? 'takeover' : 'coord_ask',
              controller: view.owner,
              generation: view.generation,
              ...a,
            },
          ];
        })
      );
  }
}
// No free-form title/body/path reaches the reminder transport (HF9 boundary).
export function escalationTitle(m: Message, state: Presence['state']): string {
  const repo = scopeRepoName(m.scope);
  return `superagent ${repo} ${m.kind} 交接 ${m.id.slice(0, 12)}：负责人${state === 'offline' ? '离线' : state === 'unknown' ? '状态未知' : '在线未答复'}；是=${m.sender.client} 成为 ${repo} 负责人，可直接修改该仓库代码；否=继续等待当前负责人，不转移 ${repo} 归属`;
}
let singleton: Coordination | undefined;
export function coord(): Coordination {
  if (singleton?.d.sa !== home().sa) singleton = new Coordination();
  return singleton;
}
export function control<T>(
  l: RunRef,
  f: (controller: Controller) => T,
  who = caller(),
  expected?: number
): T {
  const c = coord(),
    scope = runScope(l);
  if (!c.owner(scope).owner && expected === undefined) c.claim(scope, who);
  return c.mutate(scope, who, f, expected);
}
