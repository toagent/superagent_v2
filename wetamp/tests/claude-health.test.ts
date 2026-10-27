import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock } from '../src/archon';
import {
  PROBE_BACKOFF_MS,
  claudeProbeModel,
  readClaudeHealth,
  recordClaudeOutcome,
  refreshClaudeHealth,
  claudeHealthNotice,
} from '../src/claude-health';
import { loadTiers } from '../src/config';
import { tmp } from './helpers';

const saved = process.env.SUPERAGENT_HOME,
  savedTz = process.env.TZ;
afterEach(() => {
  if (saved === undefined) delete process.env.SUPERAGENT_HOME;
  else process.env.SUPERAGENT_HOME = saved;
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});
const useHome = (): string => {
  const home = tmp();
  mkdirSync(home, { recursive: true });
  process.env.SUPERAGENT_HOME = home;
  return home;
};
const failure = (patch: Record<string, unknown> = {}) => ({
  provider: 'claude',
  ok: false,
  class: 'overloaded',
  retries: 10,
  source: 'dispatch' as const,
  ...patch,
});

test('health trips on typed retry/quota boundaries, honors resetAt, and closes on success', () => {
  const home = useHome(),
    now = Date.parse('2026-10-27T01:00:00Z');
  expect(readClaudeHealth(now).state).toBe('up');
  expect(recordClaudeOutcome(failure({ class: 'auth' }), now).health.state).toBe('up');
  expect(recordClaudeOutcome(failure({ retries: 9 }), now).health.state).toBe('up');
  const resetAt = new Date(now + 20 * 60_000).toISOString();
  const down = recordClaudeOutcome(failure({ class: 'quota_exhausted', retries: 0, resetAt }), now);
  expect(down.health).toMatchObject({ state: 'down', next_probe_at: resetAt });
  expect(JSON.parse(readFileSync(join(home, 'claude-health.json'), 'utf8')).state).toBe('down');
  expect(
    recordClaudeOutcome({ provider: 'claude', ok: true, source: 'dispatch' }, now + 1).health.state
  ).toBe('up');
});

test('corruption becomes unknown and a due injected probe self-heals with bounded backoff', () => {
  const home = useHome(),
    now = Date.parse('2026-10-27T02:00:00Z'),
    path = join(home, 'claude-health.json');
  const tiers = loadTiers('./tests/fixtures/tiers.json');
  tiers.routing.commander.by_console.claude = ['claude-commander-only'];
  expect(claudeProbeModel(tiers)).toBe('claude-opus-5-5');
  expect(claudeProbeModel(tiers)).not.toBe(tiers.routing.commander.by_console.claude[0]);
  tiers.routing.reviewer.by_console.claude = ['gpt-6-astra'];
  expect(claudeProbeModel(tiers)).toBeUndefined();
  writeFileSync(path, '{');
  expect(readClaudeHealth(now).state).toBe('unknown');
  expect(refreshClaudeHealth(now, () => ({ ok: true, model: 'claude-test' })).health.state).toBe(
    'up'
  );
  writeFileSync(path, '{');
  const failed = refreshClaudeHealth(now + 1, () => ({
    ok: false,
    class: 'overloaded',
    evidence: `token=secret ${'x'.repeat(310)}`,
  })).health;
  expect(failed).toMatchObject({
    state: 'down',
    probe_failures: 1,
    cause: { class: 'overloaded', evidence: 'x'.repeat(300) },
  });
  if (failed.state === 'down')
    expect(Date.parse(failed.next_probe_at!)).toBe(now + 1 + PROBE_BACKOFF_MS[0]);
  process.env.TZ = 'Asia/Shanghai';
  expect(claudeHealthNotice(failed)).toContain('自 10:00');
});

test('newer observations beat stale probes, probe is single-flight, and persistence failures do not throw', () => {
  const home = useHome(),
    now = Date.parse('2026-10-27T03:00:00Z'),
    path = join(home, 'claude-health.json');
  writeFileSync(
    path,
    JSON.stringify({
      state: 'down',
      observed_at: new Date(now - 2).toISOString(),
      changed_at: new Date(now - 2).toISOString(),
      cause: { source: 'dispatch', class: 'overloaded', retries: 10 },
      next_probe_at: new Date(now - 1).toISOString(),
      probe_failures: 0,
    })
  );
  const raced = refreshClaudeHealth(now, () => {
    recordClaudeOutcome(failure(), now + 1);
    return { ok: true };
  });
  expect(raced.health).toMatchObject({
    state: 'down',
    observed_at: new Date(now + 1).toISOString(),
  });
  writeFileSync(
    path,
    JSON.stringify({
      state: 'down',
      observed_at: new Date(now).toISOString(),
      changed_at: new Date(now).toISOString(),
      cause: { source: 'dispatch', class: 'overloaded', retries: 10 },
      next_probe_at: new Date(now - 1).toISOString(),
      probe_failures: 0,
    })
  );
  const probeLease = lock(path + '.probe.lock');
  let calls = 0;
  expect(probeLease.ok).toBeTrue();
  try {
    refreshClaudeHealth(now, () => {
      calls++;
      return { ok: true };
    });
  } finally {
    if (probeLease.ok) probeLease.release();
  }
  expect(calls).toBe(0);
  process.env.SUPERAGENT_HOME = join(home, 'missing', 'child');
  expect(recordClaudeOutcome(failure(), now)).toMatchObject({
    persisted: false,
    error: expect.any(String),
  });
});
