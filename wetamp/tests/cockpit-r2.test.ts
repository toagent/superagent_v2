import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'ink';
import fixture from './fixtures/cockpit-r2.json';
import { tmp } from './helpers';
import { attribute, usageEvidence, type UsageSession } from '../src/usage';
import { etaInput, readEta, refreshEta } from '../src/board/eta';
import { cockpit } from '../src/board/cockpit';
import { Frame } from '../src/board/App';
import { rowOf, type Snapshot } from '../src/board/data';
import type { Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { isTier } from '../src/roles';

const now = Date.parse(fixture.captured_at);
const saved = { SUPERAGENT_HOME: process.env.SUPERAGENT_HOME, ARCHON_HOME: process.env.ARCHON_HOME, SA_ARCHON_BIN: process.env.SA_ARCHON_BIN };
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
function setup(): string {
  const root = tmp(); process.env.SUPERAGENT_HOME = root; process.env.ARCHON_HOME = join(root, 'engine');
  mkdirSync(join(root, 'runs')); mkdirSync(join(root, 'live')); mkdirSync(join(root, 'jobs')); mkdirSync(join(root, 'usage'));
  for (const x of fixture.inputs) {
    const l = { ...x.ledger, repo: root, gen_dir: join(root, x.ledger.workflow) };
    const dir = join(l.gen_dir, '.archon/workflows', l.workflow); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, l.workflow + '.yaml'), Bun.YAML.stringify({ nodes: x.roles.map(([id, role]) => ({ id, ...(role === 'coder' ? { model: '@sa-coder' } : role === 'reviewer' ? { model: '@sa-reviewer' } : {}) })) }));
    writeFileSync(join(root, 'runs', l.run_id + '.json'), JSON.stringify(l));
    writeFileSync(join(root, l.archon_run_id + '.json'), JSON.stringify(x.run));
  }
  fixture.live.forEach((l, i) => writeFileSync(join(root, 'live', i + '.json'), JSON.stringify({ ...l, cwd: root })));
  writeFileSync(join(root, 'jobs/j.json'), JSON.stringify({ ...fixture.job, cwd: root }));
  const stub = join(root, 'query'); writeFileSync(stub, `#!/bin/sh\necho query >> '${root}/calls'\ncat '${root}/'"$3"'.json'\n`, { mode: 0o755 }); process.env.SA_ARCHON_BIN = stub;
  return root;
}
test('real --events envelopes omit nodes; all ended ledger samples feed numeric ETA, without evidence writes', () => {
  const root = setup(); const e = usageEvidence();
  expect(fixture.inputs.every(x => !('nodes' in x.run))).toBe(true);
  expect(e.eta).toHaveLength(fixture.inputs.length);
  expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(fixture.inputs.length);
  const active = e.eta.find(x => x.run.status === 'running')!;
  expect(active.run.nodes!.filter(n => n.state === 'completed').length).toBeGreaterThan(7);
  expect(active.run.nodes!.some(n => n.state === 'running' && n.startedAt)).toBe(true);
  expect(readEta()).toEqual({}); // collection is read-only, refresh is the sole writer
  refreshEta(e.eta, now);
  const cache = JSON.parse(readFileSync(join(root, 'usage/eta.json'), 'utf8'));
  expect(cache.runs['run-0'].progress.pct).toBeGreaterThan(0);
  expect(cache.runs['run-0'].progress.eta_s).toBeGreaterThan(0);
  expect(cache.runs['run-0'].weight).toBeGreaterThan(0);
  expect(e.eta.filter(x => x.run.status === 'completed').flatMap(x => x.samples).length).toBeGreaterThan(active.samples.length);
});
test('real claims/jobs/live identities recover roles, enrich null-role jobs and keep unmatched or other-client sessions unassigned', () => {
  setup(); const evidence = usageEvidence();
  const sessions = structuredClone([...fixture.usage, fixture.unknown_usage]) as UsageSession[];
  const index = Object.fromEntries(sessions.filter(s => s.owner).map(s => [`${s.client}:${s.id}`, s.owner!]));
  attribute(sessions, evidence.claims, index);
  for (const l of fixture.live) {
    const s = sessions.find(s => s.client === l.client && s.id === l.session_id);
    if (s) expect(s.owner?.role).toBe('role' in l && isTier(l.role) ? l.role : l.derived ? 'general' : 'commander');
  }
  expect(sessions.find(s => s.id === fixture.job.session_id && s.client === 'codex')?.owner?.role).toBe('general');
  expect(sessions.find(s => s.id === fixture.job.session_id && s.client === 'claude')?.owner?.role).toBeNull();
  expect(sessions.at(-1)?.owner?.role).toBeNull();
  expect(evidence.claims.some(c => c.owner.kind === 'run' && c.owner.role === 'strategist')).toBe(true);
});
test('completed real runs with pending asks stay in results; stale asks do not hide running work; 62/120 render numeric progress', () => {
  setup(); const evidence = usageEvidence(); refreshEta(evidence.eta, now);
  const eta = JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME!, 'usage/eta.json'), 'utf8')).runs;
  const snap: Snapshot = { at: fixture.captured_at, summary: {}, asks: fixture.asks, eta, rows: evidence.eta.map(x => rowOf(x.ledger, x.run, { now, roles: new Map(fixture.inputs.find(f => f.ledger.run_id === x.ledger.run_id)!.roles as [string, 'coder' | 'reviewer' | 'script'][]) })) };
  expect(cockpit(snap, now).needs).toEqual([]);
  snap.asks = { ...snap.asks, 'run-0:budget:1': { status: 'pending' } };
  expect(cockpit(snap, now).active).toHaveLength(1);
  const failed = { ...snap.rows[0], state: 'failed', nodes: { ...snap.rows[0].nodes, current: 'code-package-1' } };
  expect(cockpit({ ...snap, rows: [failed] }, now).needs).toHaveLength(1);
  expect(cockpit({ ...snap, rows: [{ ...failed, nodes: { ...failed.nodes, current: 'land' } }] }, now).needs).toEqual([]);
  for (const width of [62, 120]) {
    const out = renderToString(createElement(Frame, { snap, width, height: 100, home: '/fixture', interval: 5, sel: -1, activeOnly: false, detail: null, now: new Date(now), footer: false }), { columns: width });
    expect(out).toMatch(/\d+% (剩~|超~)/); expect(out).not.toContain('?%'); expect(out).not.toContain('需要你');
    expect(out.split('\n').every(l => Bun.stringWidth(l) <= width)).toBe(true);
  }
});
test('event replay resets previous timing and cached success preserves completed duration', () => {
  const x = fixture.inputs[0]; const l = x.ledger as Ledger; const run = x.run as unknown as RunView;
  const completion = x.run.events.find(e => e.event_type === 'node_completed' && e.step_name.startsWith('code-'))!;
  const replay = { ...completion, event_type: 'node_skipped_prior_success', data: {} };
  const a = etaInput(l, run, [completion, replay]); expect(a.run.nodes![0].durationMs).toBe(completion.data.duration_ms);
  const reset = { ...replay, event_type: 'node_always_run_reset' };
  const b = etaInput(l, run, [completion, reset]); expect(b.run.nodes![0]).toEqual({ nodeId: completion.step_name, state: 'pending' });
});
