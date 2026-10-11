import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, writeAtomic } from './config';
import { lock } from './archon';
import { createLoader, type Snapshot } from './board/data';
import { cockpit, REASONS, type Cockpit } from './board/cockpit';

export interface OrcaView {
  status: 'in-review' | 'in-progress' | 'completed';
  comment: string;
  needs: string[];
}

/** Reasons can originate in node outcomes: only registered phrases cross into Orca. */
export function orcaView(c: Cockpit): OrcaView {
  const phrases = new Set<string>(Object.values(REASONS));
  const reason = (s: string): string => s.split('+').map(x =>
    Object.hasOwn(REASONS, x) ? REASONS[x as keyof typeof REASONS] : phrases.has(x) ? x : '待处置'
  ).join('、');
  const head = `跑 ${String(c.active.length)} · 等你 ${String(c.needs.length)}`;
  const parts = [
    ...c.needs.map(r => `? ${r.project} ${reason(r.reason || (r.state === 'held:human' ? 'signoff' : ''))}`),
    ...c.active.map(r => `${r.project} ${r.stage}`),
  ].map(s => s.replace(/[\r\n]+/g, ' '));
  let kept = parts.length;
  const comment = (): string => [head, ...parts.slice(0, kept),
    ...(kept < parts.length ? [`…+${String(parts.length - kept)}`] : [])].join('｜');
  while (comment().length > 200 && kept > 0) kept--;
  return {
    status: c.needs.length ? 'in-review' : c.unfinished || c.active.length ? 'in-progress' : 'completed',
    comment: comment(),
    needs: [...new Set(c.needs.map(r => JSON.stringify([r.id, reason(r.reason || (r.state === 'held:human' ? 'signoff' : ''))])))].sort(),
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
  now: () => number;
  exec: (bin: string, args: string[], signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  commandTimeoutMs: number;
}

const abortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
};
const defaults: OrcaDeps = {
  env: process.env, sa: () => home().sa, exists: existsSync,
  read: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  write: writeAtomic, lock, load: signal => createLoader(signal)(20), now: Date.now,
  exec: (bin, args, signal) => new Promise((resolve, reject) => {
    execFile(bin, args, { signal, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (signal.aborted) reject(abortError(signal));
      else if (error) reject(error instanceof Error ? error : new Error('orca command failed'));
      else resolve(stdout);
    });
  }),
  timeoutMs: 20_000, commandTimeoutMs: 10_000,
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Enforce a deadline even when an injected loader/executor does not settle on abort. */
async function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = (): void => undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { reject(abortError(signal)); };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([run(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function syncOrca(overrides: Partial<OrcaDeps> = {}): Promise<{ synced: true } | { skipped: string } | { error: string }> {
  const d = { ...defaults, ...overrides };
  let held: ReturnType<typeof lock> | undefined;
  try {
    if (d.env.SA_ORCA === '0') return { skipped: 'disabled' };
    const board = join(d.sa(), 'orca-board'), state = join(d.sa(), 'orca-board.json');
    if (!d.exists(board)) return { skipped: 'no-board' };
    const bin = [d.env.SA_ORCA_BIN, '/usr/local/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca']
      .find((p): p is string => !!p && d.exists(p));
    if (!bin) return { skipped: 'no-orca' };
    held = d.lock(join(d.sa(), 'orca-board.lock'));
    if (!held.ok) return { skipped: 'locked' };
    const signal = AbortSignal.timeout(d.timeoutMs);
    const call = async (args: string[]): Promise<unknown> => {
      const child = AbortSignal.any([signal, AbortSignal.timeout(d.commandTimeoutMs)]);
      return JSON.parse(await bounded(child, () => d.exec(bin, args, child))) as unknown;
    };
    let probe: unknown;
    try { probe = await call(['status', '--json']); }
    catch (e) {
      if (e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)) throw e;
      return { skipped: 'unavailable' };
    }
    if (!record(probe) || probe.ok !== true || !record(probe.result) ||
      !record(probe.result.app) || probe.result.app.running !== true ||
      !record(probe.result.runtime) || probe.result.runtime.reachable !== true) return { skipped: 'unavailable' };
    const next = orcaView(cockpit(await bounded(signal, () => d.load(signal)), d.now()));
    signal.throwIfAborted();
    const saved = d.read(state);
    let previous: OrcaView | undefined;
    if (saved !== undefined) {
      let p: unknown;
      try { p = JSON.parse(saved) as unknown; }
      catch { /* A corrupt projection cache has no history; rebuild after a successful set. */ }
      if (record(p) && (p.status === 'in-review' || p.status === 'in-progress' || p.status === 'completed') &&
        typeof p.comment === 'string' && Array.isArray(p.needs) && p.needs.every((s: unknown) => typeof s === 'string'))
        previous = { status: p.status, comment: p.comment, needs: p.needs };
    }
    if (previous?.status === next.status && previous.comment === next.comment &&
      JSON.stringify(previous.needs) === JSON.stringify(next.needs)) return { skipped: 'unchanged' };
    const readFlag = next.needs.some(id => !previous?.needs.includes(id)) ? ['--unread'] :
      previous?.needs.length && !next.needs.length ? ['--read'] : [];
    const result = await call(['worktree', 'set', '--worktree', `path:${board}`,
      '--workspace-status', next.status, '--comment', next.comment, ...readFlag, '--json']);
    if (!record(result) || result.ok !== true) {
      const error = record(result) && record(result.error) ? result.error : undefined;
      throw new Error(error && typeof error.message === 'string' ? error.message : 'orca worktree set failed');
    }
    signal.throwIfAborted();
    d.write(state, JSON.stringify(next) + '\n');
    return { synced: true };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  finally { if (held?.ok) held.release(); }
}
