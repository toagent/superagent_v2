import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock, type Lock } from './archon';
import { loadTiers, resolveRoute, type Tiers } from './config';
import { redact } from './redact';
export const TRIP_RETRIES = 10,
  PROBE_BACKOFF_MS = [5, 10, 20, 30].map(n => n * 60_000),
  CLAUDE_PROBE_TIMEOUT_MS = 45_000,
  CLAUDE_PROBE_BUDGET_USD = 0.05;
type Cause = { source: 'dispatch' | 'job' | 'probe'; class: string; retries: number } & Partial<
  Record<'model' | 'run' | 'node' | 'evidence', string>
>;
type Times = Partial<Record<'observed_at' | 'changed_at' | 'next_probe_at', string>>;
export type ClaudeHealth = Times & {
  state: 'up' | 'down' | 'unknown';
  cause?: Cause;
  probe_failures: number;
};
export type ClaudeOutcome = Partial<Omit<Cause, 'source'>> & {
  provider: string;
  ok: boolean;
  resetAt?: string;
  source: Cause['source'];
};
type Probe = () => { ok: boolean; class?: string; model?: string; evidence?: string };
const path = (suffix = ''): string =>
  join(process.env.SUPERAGENT_HOME ?? '', `claude-health.json${suffix}`);
const date = (v: unknown): v is string => typeof v === 'string' && !isNaN(Date.parse(v));
const valid = (h: ClaudeHealth): boolean =>
  Number.isInteger(h.probe_failures) &&
  h.probe_failures >= 0 &&
  (h.state === 'up' ||
    (h.state === 'down' &&
      date(h.observed_at) &&
      date(h.changed_at) &&
      date(h.next_probe_at) &&
      !!h.cause?.class &&
      Number.isInteger(h.cause.retries)));
export function readClaudeHealth(now: number): ClaudeHealth {
  try {
    if (!process.env.SUPERAGENT_HOME || !existsSync(path()))
      return { state: 'up', probe_failures: 0 };
    const health = JSON.parse(readFileSync(path(), 'utf8')) as ClaudeHealth;
    if (!valid(health) || !Number.isFinite(now)) throw new Error('invalid state');
    return health;
  } catch {
    return { state: 'unknown', probe_failures: 0 };
  }
}
function acquire(suffix: string, wait: number): Extract<Lock, { ok: true }> | Error {
  if (!process.env.SUPERAGENT_HOME) return new Error('SUPERAGENT_HOME unset');
  try {
    let lease = lock(path(suffix));
    if (!lease.ok && wait) {
      Bun.sleepSync(wait);
      lease = lock(path(suffix));
    }
    return lease.ok ? lease : new Error('health lock timeout');
  } catch (error) {
    return error as Error;
  }
}
function persist(health: ClaudeHealth, observed: number) {
  const lease = acquire('.lock', 2000);
  if (lease instanceof Error) return { health, persisted: false, error: lease.message };
  try {
    const current = readClaudeHealth(observed);
    if (Date.parse(current.observed_at ?? '') > observed)
      return { health: current, persisted: true };
    writeFileSync(path('.tmp'), JSON.stringify(health) + '\n');
    renameSync(path('.tmp'), path());
    return { health, persisted: true };
  } catch (error) {
    return { health, persisted: false, error: (error as Error).message };
  } finally {
    lease.release();
  }
}
function health(h: ClaudeHealth, o: ClaudeOutcome, n: number, p = h.probe_failures) {
  const at = new Date(n).toISOString();
  const state: ClaudeHealth['state'] = o.ok ? 'up' : 'down',
    cause: Cause = {
      source: o.source,
      class: o.ok ? 'success' : (o.class ?? 'unknown'),
      retries: o.retries ?? 0,
      model: o.model,
      run: o.run,
      node: o.node,
      evidence: o.evidence,
    };
  return {
    state,
    observed_at: at,
    changed_at: h.state === state ? (h.changed_at ?? at) : at,
    cause,
    probe_failures: o.ok ? 0 : p,
    ...(!o.ok ? { next_probe_at: new Date(Date.parse(o.resetAt ?? '') || n).toISOString() } : {}),
  };
}
export function recordClaudeOutcome(o: ClaudeOutcome, now = Date.now()) {
  const h = readClaudeHealth(now),
    retries = o.retries ?? 0;
  if (o.provider !== 'claude') return { health: h, persisted: true };
  const trip = claudeOutcomeTrips(o);
  if (!o.ok && !trip) return { health: h, persisted: true }; // SDK ceilings below TRIP_RETRIES stay node-local.
  const next = Math.max(now + PROBE_BACKOFF_MS[0], Date.parse(o.resetAt ?? '') || 0);
  return persist(health(h, { ...o, retries, resetAt: new Date(next).toISOString() }, now), now);
}
export const claudeOutcomeTrips = (o: ClaudeOutcome): boolean =>
  o.class === 'quota_exhausted' ||
  (!o.ok &&
    (o.retries ?? 0) >= TRIP_RETRIES &&
    !['auth', 'misconfigured', 'budget_exceeded'].includes(o.class ?? ''));
export const claudeProbeModel = (tiers: Tiers): string | undefined =>
  resolveRoute(tiers, 'claude', 'auto', 'review', 'G1', 1, [], false, {
    budget: { degraded: false, notice: '' },
    claude: { state: 'up', probe_failures: 0 },
  }).candidates.find(candidate => candidate.provider === 'claude')?.model;
function probeClaude(): ReturnType<Probe> {
  const model = claudeProbeModel(loadTiers());
  if (!model) return { ok: false, class: 'probe_failed' };
  const script = `import { probeClaudeAvailability } from '@archon/providers';
const model = process.env.ARCHON_CLAUDE_PROBE_MODEL!;
const result = await probeClaudeAvailability({ model, timeoutMs: ${String(CLAUDE_PROBE_TIMEOUT_MS)}, budgetUsd: ${String(CLAUDE_PROBE_BUDGET_USD)} });
console.log(JSON.stringify({ ok: result.ok, class: result.failure?.class, evidence: result.failure?.evidence, model }));`;
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: import.meta.dir,
    env: { ...process.env, ARCHON_CLAUDE_PROBE_MODEL: model },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CLAUDE_PROBE_TIMEOUT_MS + 5_000,
  });
  if (child.exitCode !== 0)
    return { ok: false, class: 'probe_failed', model, evidence: child.stderr.toString() };
  try {
    const result = JSON.parse(child.stdout.toString()) as ReturnType<Probe>;
    return {
      ...result,
      evidence: [result.evidence, child.stderr.toString()].filter(Boolean).join('\n'),
    };
  } catch (error) {
    return {
      ok: false,
      class: 'probe_failed',
      model,
      evidence: `${String(error)}\n${child.stderr.toString()}`,
    };
  }
}
export function refreshClaudeHealth(now = Date.now(), probe?: Probe) {
  const h = readClaudeHealth(now);
  if (h.state === 'up' || (h.state === 'down' && Date.parse(h.next_probe_at ?? '') > now))
    return { health: h, persisted: true };
  const lease = acquire('.probe.lock', 0);
  if (lease instanceof Error) return { health: h, persisted: false, error: lease.message };
  try {
    const result = (probe ?? probeClaude)(),
      evidence = result.evidence ? redact(result.evidence).trim().slice(-300) : undefined,
      outcome: ClaudeOutcome = {
        provider: 'claude',
        ok: result.ok,
        source: 'probe',
        class: result.class,
        retries: 0,
        model: result.model,
        evidence,
      };
    if (result.ok) return recordClaudeOutcome(outcome, now);
    const failures = Math.min(h.probe_failures + 1, PROBE_BACKOFF_MS.length);
    outcome.class ??= 'probe_failed';
    outcome.resetAt = new Date(now + PROBE_BACKOFF_MS[failures - 1]).toISOString();
    return persist(health(h, outcome, now, failures), now);
  } catch {
    return { health: h, persisted: true };
  } finally {
    lease.release();
  }
}
export function claudeHealthNotice(h: ClaudeHealth): string {
  if (h.state === 'up') return '';
  if (h.state === 'unknown') return '全 Codex 模式：Claude 状态未知（invalid_state）；下次探测立即';
  return `全 Codex 模式：Claude 不可用，自 ${localHealthTime(h.changed_at)}（${String(h.cause?.class)}，连续重试 ${String(h.cause?.retries)} 次）；下次探测 ${localHealthTime(h.next_probe_at)}`;
}
export const localHealthTime = (value?: string): string =>
  new Date(value ?? '').toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: process.env.TZ,
  });
export function claudeAdmission(mode: string | undefined, h: ClaudeHealth) {
  if (mode !== 'single:claude' || h.state === 'up') return { ok: true } as const;
  return { ok: false, reason: 'claude_unavailable', detail: claudeHealthNotice(h) } as const;
}
