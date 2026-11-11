import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { superviseTickCli } from '../src/cli';
import { refreshClaudeHealth } from '../src/claude-health';
import { tmp } from './helpers';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

// prettier-ignore
test('tick refreshes due Claude health and publishes after synced actions', async () => {
  const root = tmp(), sa = join(root, 'sa'), archon = join(root, 'archon'), calls: string[] = [];
  mkdirSync(sa); mkdirSync(archon);
  writeFileSync(join(sa, 'claude-health.json'), '{');
  Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: archon, DATABASE_URL: '' });
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  let handled = false;
  try {
    await superviseTickCli(
      async () => undefined, async () => undefined, {},
      async () => { calls.push('load'); if (!handled) throw new Error('stale decision'); return { at: new Date().toISOString(), summary: {}, rows: [] }; },
      () => undefined, () => undefined,
      async () => { calls.push('sync'); return { accepted: 1, ignored: 0, failed: 0 }; },
      async () => undefined,
      () => refreshClaudeHealth(Date.now(), () => { calls.push('probe'); return { ok: true }; }),
      (_mode, emit) => { calls.push('actions'); handled = true; emit?.({}); return 0; }
    );
    expect(calls).toEqual(['sync', 'actions', 'probe', 'load']);
    expect(existsSync(join(sa, 'heartbeat.json'))).toBeTrue();
  } finally {
    log.mockRestore();
  }
});
