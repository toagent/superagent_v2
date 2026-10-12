import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { lock } from '../archon';
import { home, writeAtomic, WETAMP } from '../config';
import { launcher, inspectProcess, type Launcher } from '../launcher';

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
  files: (home: string, dir: string) => Message[];
  refusal: (action: string, owner: Identity | null, state: Presence['state']) => string;
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
  same = identity.same;
export const archonMutation = shared.archonMutation;
export const ownerLabel = (who: Identity | null): string =>
  who ? `${who.client} ${who.session_id?.slice(0, 8) ?? `pid:${String(who.pid)}`}` : '无主';
export const ACK_TIMEOUT_MS = 15 * 60_000;
export function repoScope(path: string): Extract<Scope, { kind: 'repo' }> {
  const scope = shared.repoScope(path);
  if (!scope) throw new Error(`coord: not a repository: ${path}`);
  return scope;
}
export const runScope = shared.runScope;
export function caller(readonly = false): Identity {
  if (
    !readonly &&
    ['general', 'strategist', 'reviewer', 'worker'].includes(process.env.SUPERAGENT_ROLE ?? '')
  )
    throw new Error('派生会话不参与认领或控制；请交回元帅');
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
  now: () => number;
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
  locked<T>(f: () => T): T {
    if (this.depth) return f();
    const root = join(this.d.sa, 'coord');
    mkdirSync(root, { recursive: true });
    for (let n = 0; ; n++) {
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
      if (n >= 200) throw new Error('coord: registry busy');
      Bun.sleepSync(50);
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
  scoped<T>(scope: Scope, f: () => T): T {
    const key = this.scopeLock(scope);
    if (this.scopes.has(key)) return f();
    const root = join(this.d.sa, 'coord', 'locks');
    mkdirSync(root, { recursive: true });
    for (let n = 0; ; n++) {
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
      if (n >= 2400) throw new Error('coord: scope busy');
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
  owner(scope: Scope): {
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
    const runs = claims.length
      ? []
      : this.d
          .runs(scope.kind === 'run' ? scope.id : undefined)
          .filter(l => {
            // A ledger whose repository no longer resolves cannot share a live repository's scope.
            if (scope.kind === 'run') return l.run_id === scope.id;
            if (shared.repoScope(l.repo)?.id !== repo.id || l.state === 'failed') return false;
            try {
              return !['completed', 'cancelled'].includes(this.d.status(l));
            } catch {
              return true;
            } // Unverifiable ownership remains evidence.
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
  private leaseKey(scope: Scope, who: Identity): string {
    return shared.hash([scope, identity.key(who)]);
  }
  private transfer(scope: Scope, who: Identity | null, reason: string): Claim {
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
    this.save('claims', shared.hash(scope), c);
    if (who) this.save('leases', this.leaseKey(scope, who), { generation: c.generation });
    for (const previous of view.owner ? [view.owner] : view.conflicts)
      if (!same(previous, who))
        this.notice('takeover', scope, who ?? previous, previous, c.generation, reason);
    return c;
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
        const view = this.owner(scope);
        if (view.conflicts.length && !takeover) throw new Error(view.next);
        if (view.owner && !same(view.owner, who) && view.presence.state !== 'offline' && !takeover)
          throw new Error(shared.refusal('普通认领', view.owner, view.presence.state));
        const existing = this.claimOf(scope);
        const c = same(view.owner, who) && existing ? existing : this.transfer(scope, who, reason);
        this.save('leases', this.leaseKey(scope, who), { generation: c.generation });
        return { controller: { ...who, generation: c.generation }, inbox: this.inbox(who) };
      })
    );
  }
  release(scope: Scope, who: Identity): void {
    this.mutate(scope, who, () => {
      this.locked(() => {
        this.transfer(scope, null, '主动释放');
      });
    });
  }
  admit(scope: Scope, who: Identity, expected?: number): Controller {
    return this.locked(() =>
      shared.admission(
        this.d.sa,
        scope,
        who,
        expected,
        join(this.d.sa, 'archon'),
        this.owner(scope)
      )
    );
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
  mutate<T>(scope: Scope, who: Identity, f: (controller: Controller) => T, expected?: number): T {
    return this.scoped(scope, () => {
      const controller = this.admit(scope, who, expected);
      const previous = this.active;
      this.active = { scope, controller };
      try {
        return f(controller);
      } finally {
        this.active = previous;
      }
    });
  }
  messages(): Message[] {
    return shared.files(this.d.sa, 'inbox');
  }
  inbox(who: Identity, all = false): Message[] {
    return this.messages().filter(
      m =>
        (all || !['done', 'rejected'].includes(m.state)) &&
        (m.type ? same(m.recipient, who) : same(this.owner(m.scope).owner ?? m.recipient, who))
    );
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
    input: Pick<Message, 'kind' | 'title' | 'body' | 'evidence' | 'severity'>
  ): Record<string, unknown> {
    return this.scoped(scope, () =>
      this.locked(() => {
        let view = this.owner(scope),
          claimed = false;
        if (view.conflicts.length) throw new Error(view.next);
        if (!view.owner) {
          this.claim(scope, sender);
          view = this.owner(scope);
          claimed = true;
        }
        if (same(view.owner, sender) && !claimed)
          return { routed_to: sender, presence: view.presence, delivery: 'self', next: '自己处理' };
        const id = shared.hash([scope, input.kind, input.title, [...input.evidence].sort()]);
        if (!shared.read(this.path('inbox', id)))
          this.save('inbox', id, {
            ...input,
            id,
            scope,
            sender,
            recipient: view.owner,
            generation: view.generation,
            state: 'queued',
            at: new Date(this.d.now()).toISOString(),
          });
        return {
          id,
          routed_to: view.owner,
          presence: view.presence,
          delivery: 'queued',
          next: claimed ? '已认领，由你处理' : '收件人必须通过 inbox --ack 答复',
        };
      })
    );
  }
  surfaced(who: Identity): Message[] {
    return this.locked(() =>
      this.inbox(who)
        .filter(m => ['queued', 'escalated'].includes(m.state) || !same(m.recipient, who))
        .map(m => {
          if (m.state === 'queued') m.state = 'surfaced';
          if (!m.type) {
            m.recipient = who;
            m.generation = this.owner(m.scope).generation;
          }
          this.save('inbox', m.id, m);
          return m;
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
          // 否=继续等 is the user's answer for this owner; re-asking every interval turned it into a nag.
          // A new owner generation is a different question, so it may ask again.
          if (m.ask?.status === 'no' && m.ask.generation === view.generation) return [];
          const held = this.d.runs().some(l => {
            try {
              return (
                repoScope(l.repo).id === (m.scope.kind === 'repo' ? m.scope.id : m.scope.repo) &&
                ['paused', 'failed'].includes(this.d.status(l))
              );
            } catch {
              return false;
            }
          });
          const immediate = view.presence.state === 'offline' && (m.severity === 'urgent' || held);
          if (!immediate && this.d.now() - Date.parse(m.at) < ACK_TIMEOUT_MS) return [];
          if (view.presence.state === 'offline' && !immediate) return [];
          if (same(view.owner, m.sender)) return [];
          const key = `coord:${m.id}:${String(view.generation)}:${String(m.ask_round ?? 0)}`;
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
            this.claim(m.scope, m.sender, true, '用户通过 supervisor 同意接管');
          }
          if (['no', 'expired'].includes(a.status)) {
            // Only an unanswered (expired) ask comes back after the interval; 'no' is fenced above.
            m.deferred_until = this.d.now() + ACK_TIMEOUT_MS;
            m.ask_round = (m.ask_round ?? 0) + 1;
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
  return `superagent 交接 ${m.id.slice(0, 12)} ${m.kind}：负责人${state === 'offline' ? '离线' : state === 'unknown' ? '状态未知' : '在线未答复'}；是=交给发现者处理 否=继续等`;
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
