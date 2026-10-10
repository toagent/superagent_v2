import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { estimate, progressLabel, readEta, refreshEta, unknownProgress } from '../src/board/eta';
import { ProgressBar } from '../src/board/ProgressBar';
import { tmp } from './helpers';
import type { Ledger } from '../src/cli';
import { refreshUsage } from '../src/usage';

const now = Date.now(), iso = (seconds: number): string => new Date(now - seconds * 1000).toISOString();
const samples = ['code', 'verify'].flatMap(id => [1, 2, 3].map(i => ({ id: `${id}-${String(i)}`, seconds: id === 'code' ? 600 : 60 })));
const saved = { SUPERAGENT_HOME: process.env.SUPERAGENT_HOME, ARCHON_HOME: process.env.ARCHON_HOME, SA_ARCHON_BIN: process.env.SA_ARCHON_BIN };
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
test('long code and short verify use history duration weights, skipped nodes have zero weight', () => {
  const x = estimate([{ nodeId: 'code-a', state: 'completed', durationMs: 600000 }, { nodeId: 'verify-a', state: 'running', startedAt: iso(30) }, { nodeId: 'code-skipped', state: 'skipped' }], samples, 630, now);
  expect(x.weight).toBe(660); expect(x.progress).toEqual({ pct: 95, eta_s: 30, overrun_s: 0, basis: 'history' }); expect(x.progress.pct).not.toBe(50);
});
test('overrun never makes ETA negative and overlay reports 超', () => {
  const x = estimate([{ nodeId: 'code-a', state: 'running', startedAt: iso(780) }, { nodeId: 'verify-a', state: 'pending' }], samples, 780, now);
  expect(x.progress).toMatchObject({ eta_s: 60, overrun_s: 180 }); expect(progressLabel(x.progress)).toContain('超~3m');
});
test('sparse samples extrapolate observed throughput; no observations or missing start stay unknown', () => {
  const x = estimate([{ nodeId: 'code-a', state: 'completed', durationMs: 600000 }, { nodeId: 'verify-a', state: 'running', startedAt: iso(20) }], samples.slice(0, 2), 620, now);
  expect(x.progress.basis).toBe('linear'); expect(x.progress.eta_s).toBe(600); expect(progressLabel(x.progress)).toContain('剩~?10m');
  expect(estimate([{ nodeId: 'code-a', state: 'running' }], [], 10, now).progress).toEqual(unknownProgress());
  expect(progressLabel(unknownProgress())).toBe('?% 剩?');
  expect(estimate([{ nodeId: 'code-a', state: 'running' }], samples, 10, now).progress.basis).toBe('unknown');
});
test('overlaid Ink bar fills exact columns, text remains whole at 62/120 and narrow space falls back', () => {
  const progress = { pct: 47, eta_s: 720, overrun_s: 0, basis: 'history' as const };
  for (const width of [14, 30, 62, 120]) {
    const out = renderToString(createElement(ProgressBar, { progress, width }), { columns: width });
    expect(out).toContain('47% 剩~12m'); expect(out.split('\n')).toHaveLength(1); expect(Bun.stringWidth(out)).toBe(width);
  }
  expect(renderToString(createElement(ProgressBar, { progress, width: 13 }), { columns: 62 })).toBe('47% 剩~12m');
});
test('ETA cache derives complete node set from existing workflow and atomically replaces only its file', () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon'); mkdirSync(join(root, 'usage')); const wf = join(root, '.archon/workflows/w'); mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, 'w.yaml'), 'nodes:\n  - id: code-a\n  - id: verify-a\n');
  const ledger: Ledger = { run_id: 's', archon_run_id: 'a', repo: root, gen_dir: root, plan: 'plan.json', branch: 'b', workflow: 'w', console: 'codex', started_at: iso(600), transcript: '', log: '', recoveries: [] };
  refreshEta([{ ledger, run: { id: 'a', status: 'running', nodes: [{ nodeId: 'code-a', state: 'completed', durationMs: 600000 }] }, samples: [] }, { ledger, run: { id: 'past', status: 'completed' }, samples }], now);
  expect(readEta().s.progress).toMatchObject({ pct: 91, eta_s: 60, basis: 'history' });
  expect(JSON.parse(readFileSync(join(root, 'usage/eta.json'), 'utf8')).runs.s.weight).toBe(660);
  refreshEta([], now - 600001); expect(readEta()).toEqual({});
  writeFileSync(join(root, 'usage/eta.json'), JSON.stringify({ at: new Date().toISOString(), runs: { broken: { progress: { pct: 900 } } } })); expect(readEta()).toEqual({});
});
test('existing background usage query feeds ETA once, even events without session identities', async () => {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'archon');
  mkdirSync(join(root, 'runs')); const wf = join(root, '.archon/workflows/w'); mkdirSync(wf, { recursive: true }); writeFileSync(join(wf, 'w.yaml'), 'nodes:\n  - id: code-a\n  - id: verify-a\n');
  const ledger: Ledger = { run_id: 's', archon_run_id: 'a', repo: root, gen_dir: root, plan: 'plan.json', branch: 'b', workflow: 'w', console: 'codex', started_at: iso(630), transcript: '', log: '', recoveries: [] };
  writeFileSync(join(root, 'runs/s.json'), JSON.stringify(ledger));
  writeFileSync(join(root, 'run.json'), JSON.stringify({ id: 'a', status: 'running', nodes: [{ nodeId: 'code-a', state: 'completed', durationMs: 600000 }, { nodeId: 'verify-a', state: 'running', startedAt: iso(30) }], events: [] }));
  const bin = join(root, 'archon'); writeFileSync(bin, `#!/bin/sh\necho query >> '${root}/calls'\ncat '${root}/run.json'\n`); chmodSync(bin, 0o755); process.env.SA_ARCHON_BIN = bin;
  await refreshUsage(undefined, (client, mode) => Promise.resolve(mode === 'daily' ? { daily: [] } : { [client === 'claude' ? 'session' : 'sessions']: [] }));
  expect(readEta().s.progress).toMatchObject({ pct: 52, basis: 'linear' }); expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
});
