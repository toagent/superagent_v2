import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, writeAtomic } from './config';
import { lock } from './archon';
import { createLoader, type Snapshot } from './board/data';
import { cockpit, decisionHeader, REASONS, type Cockpit } from './board/cockpit';
import { presence, type Identity, type Presence } from './coord';
import {
  heartbeat,
  historicalReclaimRuns,
  shouldWriteHeartbeat,
  type Heartbeat,
} from './heartbeat';

export interface OrcaView {
  status: 'in-review' | 'in-progress' | 'completed';
  comment: string;
  needs: string[];
}

/** Reasons can originate in node outcomes: only registered phrases cross into Orca. */
export function orcaView(c: Cockpit, pulse: Heartbeat): OrcaView {
  const phrases = new Set<string>(Object.values(REASONS));
  const reason = (s: string): string =>
    s
      .split('+')
      .map(x =>
        Object.hasOwn(REASONS, x)
          ? REASONS[x as keyof typeof REASONS]
          : phrases.has(x)
            ? x
            : '待处置'
      )
      .join('、');
  const head = decisionHeader(c);
  const parts = pulse.marshals
    .filter(m => m.owner !== 'unknown')
    .map(m => m.line.replace(/[\r\n]+/g, ' '));
  const suffix = [
    ...(pulse.reclaim_pending ? [`待回收 ${String(pulse.reclaim_pending)}`] : []),
    ...(pulse.unowned ? [`归属未知 ${String(pulse.unowned)}`] : []),
    ...(pulse.unreadable ? [`不可读 ${String(pulse.unreadable)}`] : []),
  ];
  let kept = parts.length;
  const comment = (): string =>
    [
      head,
      ...parts.slice(0, kept),
      ...(kept < parts.length ? [`…+${String(parts.length - kept)}`] : []),
      ...suffix,
    ].join('｜');
  while (comment().length > 200 && kept > 0) kept--;
  return {
    status: c.needs.length
      ? 'in-review'
      : c.unfinished || c.active.length
        ? 'in-progress'
        : 'completed',
    comment: comment(),
    needs: [
      ...new Set(
        c.needs.map(r =>
          JSON.stringify([r.id, reason(r.reason || (r.state === 'held:human' ? 'signoff' : ''))])
        )
      ),
    ].sort(),
  };
}

export interface OrcaDeps {
  env: NodeJS.ProcessEnv;
  sa: () => string;
  exists: (path: string) => boolean;
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  lock: typeof lock;
  load: (signal: AbortSignal) => Promise<Snapshot>;
  presence: (owner: Identity) => Presence;
  now: () => number;
  exec: (bin: string, args: string[], signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  commandTimeoutMs: number;
}

// prettier-ignore
export const orcaBin = (env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined =>
  [env.SA_ORCA_BIN, '/usr/local/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca'].find((path): path is string => !!path && exists(path));

// prettier-ignore
export type AgentLaunch = { kind: 'launched'; outcome: unknown } | { kind: 'lost'; operation_id: string } | { kind: 'unknown'; evidence: string } | { kind: 'failed'; error: string };

const operationId = (value: unknown): string | undefined => {
  if (!record(value)) return undefined;
  for (const key of ['operation_id', 'operationId'])
    if (typeof value[key] === 'string' && value[key]) return value[key];
  for (const child of Object.values(value)) {
    const found = operationId(child);
    if (found) return found;
  }
  return undefined;
};

// prettier-ignore
export async function launchAgent(bin: string, args: string[], exec: (bin: string, args: string[]) => Promise<string> = (command, argv) => new Promise((resolve, reject) => {
  execFile(command, argv, (error, stdout, stderr) => { if (error) reject(Object.assign(new Error(error.message), { stdout, stderr })); else resolve(stdout); });
})): Promise<AgentLaunch> {
  try {
    const value = JSON.parse(await exec(bin, args)) as unknown;
    if (record(value) && value.ok === true) return { kind: 'launched', outcome: value.result ?? value };
    const id = operationId(value);
    if (id) return { kind: 'lost', operation_id: id };
    return { kind: 'failed', error: JSON.stringify(value) };
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    const evidence = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    try {
      const value = JSON.parse(e.stdout ?? '') as unknown;
      const id = operationId(value);
      if (id) return { kind: 'lost', operation_id: id };
      if (record(value) && value.ok === false)
        return { kind: 'failed', error: JSON.stringify(value) };
    } catch {
      // A dispatched launch without structured evidence is intentionally ambiguous.
    }
    return { kind: 'unknown', evidence };
  }
}

const abortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
};
const defaults: OrcaDeps = {
  env: process.env,
  sa: () => home().sa,
  exists: existsSync,
  read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  write: writeAtomic,
  lock,
  load: signal => createLoader(signal)(20),
  presence: owner => presence(owner, home().sa),
  now: Date.now,
  exec: (bin, args, signal) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { signal, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (signal.aborted) reject(abortError(signal));
        else if (error) reject(error instanceof Error ? error : new Error('orca command failed'));
        else resolve(stdout);
      });
    }),
  timeoutMs: 20_000,
  commandTimeoutMs: 10_000,
};
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Enforce a deadline even when an injected loader/executor does not settle on abort. */
async function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = (): void => undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function syncOrca(
  snapshotOrOverrides: Snapshot | Partial<OrcaDeps> = {},
  overrides: Partial<OrcaDeps> = {}
): Promise<{ synced: true } | { skipped: string } | { error: string }> {
  const snapshot = 'rows' in snapshotOrOverrides ? snapshotOrOverrides : undefined;
  const d = { ...defaults, ...(snapshot ? overrides : snapshotOrOverrides) };
  let held: ReturnType<typeof lock> | undefined;
  try {
    if (d.env.SA_ORCA === '0') return { skipped: 'disabled' };
    const board = join(d.sa(), 'orca-board'),
      state = join(d.sa(), 'orca-board.json');
    if (!d.exists(board)) return { skipped: 'no-board' };
    const bin = orcaBin(d.env, d.exists);
    if (!bin) return { skipped: 'no-orca' };
    held = d.lock(join(d.sa(), 'orca-board.lock'));
    if (!held.ok) return { skipped: 'locked' };
    const signal = AbortSignal.timeout(d.timeoutMs);
    const call = async (args: string[]): Promise<unknown> => {
      const child = AbortSignal.any([signal, AbortSignal.timeout(d.commandTimeoutMs)]);
      return JSON.parse(await bounded(child, () => d.exec(bin, args, child))) as unknown;
    };
    let probe: unknown;
    try {
      probe = await call(['status', '--json']);
    } catch (e) {
      if (e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)) throw e;
      return { skipped: 'unavailable' };
    }
    if (
      !record(probe) ||
      probe.ok !== true ||
      !record(probe.result) ||
      !record(probe.result.app) ||
      probe.result.app.running !== true ||
      !record(probe.result.runtime) ||
      probe.result.runtime.reachable !== true
    )
      return { skipped: 'unavailable' };
    const now = d.now(),
      source = snapshot ?? (await bounded(signal, () => d.load(signal))),
      c = cockpit(source, now);
    const pulse = heartbeat(source, c, now, d.presence, historicalReclaimRuns()),
      next = orcaView(c, pulse);
    signal.throwIfAborted();
    const saved = d.read(state);
    let previous: (OrcaView & { heartbeat: Heartbeat }) | undefined;
    if (saved !== undefined) {
      let p: unknown;
      try {
        p = JSON.parse(saved) as unknown;
      } catch {
        /* A corrupt projection cache has no history; rebuild after a successful set. */
      }
      if (
        record(p) &&
        (p.status === 'in-review' || p.status === 'in-progress' || p.status === 'completed') &&
        typeof p.comment === 'string' &&
        Array.isArray(p.needs) &&
        p.needs.every((s: unknown) => typeof s === 'string') &&
        record(p.heartbeat) &&
        typeof p.heartbeat.at === 'string' &&
        typeof p.heartbeat.reclaim_pending === 'number' &&
        typeof p.heartbeat.unowned === 'number' &&
        typeof p.heartbeat.unreadable === 'number' &&
        Array.isArray(p.heartbeat.marshals)
      )
        previous = {
          status: p.status,
          comment: p.comment,
          needs: p.needs,
          heartbeat: p.heartbeat as unknown as Heartbeat,
        };
    }
    if (
      !shouldWriteHeartbeat(previous?.heartbeat, pulse, now) &&
      previous?.status === next.status &&
      previous.comment.split('｜', 1)[0] === next.comment.split('｜', 1)[0] &&
      JSON.stringify(previous.needs) === JSON.stringify(next.needs)
    )
      return { skipped: 'unchanged' };
    const readFlag = next.needs.some(id => !previous?.needs.includes(id))
      ? ['--unread']
      : previous?.needs.length && !next.needs.length
        ? ['--read']
        : [];
    const result = await call([
      'worktree',
      'set',
      '--worktree',
      `path:${board}`,
      '--workspace-status',
      next.status,
      '--comment',
      next.comment,
      ...readFlag,
      '--json',
    ]);
    if (!record(result) || result.ok !== true) {
      const error = record(result) && record(result.error) ? result.error : undefined;
      throw new Error(
        error && typeof error.message === 'string' ? error.message : 'orca worktree set failed'
      );
    }
    signal.throwIfAborted();
    d.write(state, JSON.stringify({ ...next, heartbeat: pulse }) + '\n');
    return { synced: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (held?.ok) held.release();
  }
}
