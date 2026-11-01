import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// prettier-ignore
import { Coordination, runScope, same, type Identity, type Presence, type RunRef } from '../src/coord';
import { lock } from '../src/archon';
import { Reclaimer, reclaimCoord } from '../src/reclaim';
import { gitRepo, tmp } from './helpers';

// prettier-ignore
const a: Identity = { client: 'codex', session_id: 'dead', host: hostname(), pid: 111, pid_start: 'old' };
// prettier-ignore
const b: Identity = { client: 'claude', session_id: 'live', host: hostname(), pid: 222, pid_start: 'new' };
const hooks = createRequire(import.meta.url)('../hooks/coord.cjs') as {
  hash(value: unknown): string;
};
// prettier-ignore
function setup(probe: (who: Identity) => Presence = who => same(who, a) ? { state: 'offline' } : { state: 'online', activity: 'idle' }) {
  const root = tmp(), repo = gitRepo(root), sa = join(root, 'sa'), gen = join(root, 'gen'); mkdirSync(join(sa, 'runs'), { recursive: true }); mkdirSync(join(root, 'archon'), { recursive: true }); mkdirSync(gen);
  process.env.SUPERAGENT_HOME = sa; process.env.ARCHON_HOME = join(root, 'archon');
  const run: RunRef = { run_id: 'r1', archon_run_id: 'engine', repo, gen_dir: gen }, ledger = { ...run, plan: 'p', branch: 'feature', workflow: 'w', console: '', started_at: '', transcript: '', log: '' };
  writeFileSync(join(sa, 'runs/r1.json'), JSON.stringify(ledger)); writeFileSync(join(gen, 'delivery-authorization.json'), '{}');
  const c = new Coordination({ sa, runs: () => [run], status: () => 'running', presence: probe }); c.claim({ kind: 'repo', id: runScope(run).repo }, b); c.claim(runScope(run), a);
  return { root, sa, run, c };
}

// prettier-ignore
test('reclaim observes confirmed death, journals three states, transfers, reauthorizes, records evidence and reroutes inbox', () => {
  let state: Presence['state'] = 'online'; const s = setup(who => same(who, a) ? state === 'online' ? { state, activity: 'idle' } : { state } : { state: 'online', activity: 'idle' }); let now = 0; const r = new Reclaimer(s.c, () => now, () => ({ id: 'engine', status: 'running' }));
  s.c.handoff(runScope(s.run), b, { kind: 'task', title: 'existing', body: 'body', evidence: [], severity: 'normal' });
  r.observe(); state = 'offline'; r.observe(); now = 120_000; const out = r.reclaim(r.observe());
  expect(out.transferred).toEqual(['r1']); expect(s.c.owner(runScope(s.run)).owner).toEqual(b);
  expect(JSON.parse(readFileSync(join(s.sa, 'reclaim/journal.json'), 'utf8')).map((x: { state: string }) => x.state)).toEqual(['transferring', 'transferred', 'reauthorized']);
  expect(existsSync(join(s.sa, 'coord/authorizations/r1.json'))).toBe(true); expect(s.c.inbox(b).some(m => m.title === 'existing')).toBe(true);
  const ledger = JSON.parse(readFileSync(join(s.sa, 'runs/r1.json'), 'utf8')); expect(ledger.intervention_events.at(-1)).toMatchObject({ action: 'reclaim:owner_offline', ok: true, evidence: { from: a, observation: { first_offline_at: 0, last_offline_at: 120_000, count: 2 } } });
  expect(s.c.messages().some(m => m.type === 'takeover' && same(m.recipient, a))).toBe(false);
});

// prettier-ignore
test('reclaim resets changed evidence, ignores unknown, leaves unclaimed and critical runs, then completes reauthorization failure', () => {
  let state: Presence['state'] = 'online', target: Presence['state'] = 'online', now = 0; const probe = (who: Identity): Presence => { const value = who.client === a.client ? state : target; return value === 'online' ? { state: value, activity: 'idle' } : { state: value }; }, s = setup(probe), running = { id: 'engine', status: 'running' as const, nodes: [] as { nodeId: string; state: string }[] }, r = new Reclaimer(s.c, () => now, () => running);
  r.observe(); s.c.rolloverTransfer(runScope(s.run), a, { ...a, session_id: 'changed' }, 'token'); state = 'offline'; now = 120_000; expect(r.observe()[0]).toMatchObject({ count: 1, last_online_at: undefined });
  state = 'unknown'; expect(r.observe()).toEqual([]); state = 'offline'; s.c.rolloverTransfer(runScope(s.run), { ...a, session_id: 'changed' }, a, 'back');
  const observation = { run: 'r1', repo: s.run.repo, owner: a, generation: s.c.owner(runScope(s.run)).generation, last_online_at: 0, first_offline_at: 0, last_offline_at: 120_000, count: 2 };
  target = 'offline'; expect(r.reclaim([observation]).unclaimed).toEqual(['r1']); target = 'online';
  running.nodes = [{ nodeId: 'publish-m1', state: 'running' }]; expect(r.reclaim([observation]).skipped).toEqual(['r1']); running.nodes = [];
  const scopeLock = join(s.sa, 'coord/locks', hooks.hash({ kind: 'repo', id: runScope(s.run).repo }) + '.lock'), held = lock(scopeLock); if (!held.ok) throw new Error('fixture lock'); expect(r.reclaim([observation]).skipped).toEqual(['r1']); held.release();
  const fail = spyOn(s.c, 'reauthorize').mockImplementation(() => { throw new Error('fixture'); }); expect(r.reclaim([observation]).pending).toEqual(['r1']); fail.mockRestore();
  const failed = JSON.parse(readFileSync(join(s.sa, 'runs/r1.json'), 'utf8')).intervention_events.at(-1); expect(failed).toMatchObject({ action: 'reclaim:reauthorize_failed', evidence: { observation: { first_offline_at: 0, last_offline_at: 120_000, count: 2 } } });
  expect(JSON.parse(readFileSync(join(s.sa, 'reclaim/journal.json'), 'utf8')).at(-1).state).toBe('transferred'); expect(r.complete().transferred).toEqual(['r1']);
  expect(JSON.parse(readFileSync(join(s.sa, 'reclaim/journal.json'), 'utf8')).at(-1).state).toBe('reauthorized'); expect(s.c.inbox(b).some(m => m.title === '回收续授权失败')).toBe(true);
});

// prettier-ignore
test('reclaim fails closed on a corrupt journal and isolates run probe failures', () => {
  const corrupt = setup(), journal = join(corrupt.sa, 'reclaim/journal.json'); mkdirSync(join(corrupt.sa, 'reclaim')); writeFileSync(journal, '{');
  expect(() => new Reclaimer(corrupt.c).reclaim([])).toThrow(); expect(readFileSync(journal, 'utf8')).toBe('{');
  const bad = setup(), view = bad.c.owner(runScope(bad.run)), observation = { run: 'r1', repo: bad.run.repo, owner: a, generation: view.generation, last_online_at: 0, first_offline_at: 0, last_offline_at: 120_000, count: 2 };
  const result = new Reclaimer(bad.c, Date.now, () => { throw new Error('archon workflow get failed'); }).reclaim([observation]);
  expect(result.skipped).toEqual(['r1']); expect(bad.c.owner(runScope(bad.run)).owner).toEqual(a);
});

test('reclaim leaves historically offline owners untouched and batch statuses preserve ownership evidence', () => {
  const s = setup();
  let now = 0;
  const r = new Reclaimer(s.c, () => now);
  r.observe();
  now = 120_000;
  expect(r.reclaim(r.observe()).historical).toEqual(['r1']);
  expect(s.c.owner(runScope(s.run)).owner).toEqual(a);
  const statuses = new Map([
      ['failed', 'failed'],
      ['done', 'completed'],
      ['cancelled', 'cancelled'],
    ] as const),
    c = reclaimCoord(statuses, s.c);
  c.d.runs = () => [{ ...s.run, archon_run_id: 'failed' }];
  let probes = 0;
  expect(
    new Reclaimer(c, Date.now, () => {
      probes++;
      throw new Error('provider probe');
    }).observe()
  ).toHaveLength(1);
  expect(probes).toBe(0);
  c.d.runs = () => [
    { ...s.run, rejected: 'engine', intervention_events: [{ action: 'abandon', ok: true }] },
  ];
  expect(new Reclaimer(c).observe()).toEqual([]);
  const evidence = (id: string): boolean =>
    c.isRunOwnershipEvidence({ ...s.run, run_id: id, archon_run_id: id });
  expect(['failed', 'done', 'cancelled', 'missing'].map(evidence)).toEqual([
    true,
    false,
    false,
    true,
  ]);
});

test('reclaim observation isolates deleted repositories in saved and current evidence', () => {
  const s = setup(),
    missing = { ...s.run, run_id: 'missing', repo: join(s.root, 'deleted') },
    stale = { ...missing, run_id: 'stale' };
  mkdirSync(join(s.sa, 'reclaim'));
  writeFileSync(
    join(s.sa, 'reclaim/observations.json'),
    JSON.stringify([{ run: missing.run_id, repo: missing.repo, owner: a, generation: 1, count: 1 }])
  );
  s.c.d.runs = () => [missing, s.run];
  const r = new Reclaimer(s.c, Date.now, () => ({ id: 'engine', status: 'running' }));
  expect(r.observe().map(item => item.run)).toEqual(['r1']);
  // prettier-ignore
  writeFileSync(join(s.sa, 'runs/stale.json'), JSON.stringify({ ...stale, plan: 'p', branch: 'feature', workflow: 'w', console: '', started_at: '', transcript: '', log: '' }));
  s.c.d.runs = () => [missing, stale, s.run];
  // prettier-ignore
  const generation = s.c.owner(runScope(s.run)).generation,
    observation = (run: string, repo: string) => ({ run, repo, owner: a, generation, last_online_at: 0, first_offline_at: 0, last_offline_at: 120_000, count: 2 }),
    result = r.reclaim([observation(stale.run_id, stale.repo), observation(s.run.run_id, s.run.repo)]);
  // prettier-ignore
  expect(result).toMatchObject({ transferred: ['r1'], skipped: ['missing', 'stale'], skip_reasons: { missing: 'repository_unavailable', stale: 'repository_unavailable' } });
});

// prettier-ignore
test('accepted rollover rehabilitates legacy evidence while aged terminal ownership is abandoned', () => {
  const successor = { ...a, session_id: 'successor' }, s = setup(who => same(who, b) ? { state: 'online', activity: 'idle' } : { state: 'offline' }), scope = runScope(s.run);
  s.c.rolloverTransfer(scope, a, successor, 'first'); s.c.rolloverTransfer(scope, successor, a, 'accepted');
  mkdirSync(join(s.sa, 'coord/rollovers'), { recursive: true }); writeFileSync(join(s.sa, 'coord/rollovers/accepted.json'), JSON.stringify({ token: 'wrong', state: 'accepted', to: a, accepted_at: new Date(1).toISOString() }));
  const generation = s.c.owner(scope).generation, legacy = { run: 'r1', repo: s.run.repo, owner: a, generation, first_offline_at: 2, last_offline_at: 120_002, count: 2 };
  expect(new Reclaimer(s.c, () => 120_002).reclaim([legacy]).historical).toEqual(['r1']); writeFileSync(join(s.sa, 'coord/rollovers/accepted.json'), JSON.stringify({ token: 'accepted', state: 'accepted', to: a, accepted_at: new Date(1).toISOString() }));
  expect(new Reclaimer(s.c, () => 120_002, () => ({ id: 'engine', status: 'running' })).reclaim([legacy]).transferred).toEqual(['r1']);
  let target: Presence['state'] = 'online', heir: Presence['state'] = 'online'; const next = { ...b, session_id: 'heir' }, probe = (who: Identity): Presence => { const state = same(who, a) ? 'offline' : same(who, next) ? heir : target; return state === 'online' ? { state, activity: 'idle' } : { state }; }, old = setup(probe), oldScope = runScope(old.run), observation = { ...legacy, generation: old.c.owner(oldScope).generation, first_offline_at: 0, last_offline_at: 86_400_000 }; old.c.d.status = () => 'failed';
  const reject = () => JSON.parse(readFileSync(join(old.sa, 'runs/r1.json'), 'utf8')).rejected; new Reclaimer(old.c, () => 86_400_000).reclaim([observation]); expect(reject()).toBeUndefined(); target = 'offline'; mkdirSync(join(old.sa, 'coord/rollovers'), { recursive: true }); writeFileSync(join(old.sa, 'coord/rollovers/heir.json'), JSON.stringify({ state: 'accepted', from: a, to: next, accepted_at: new Date(1).toISOString() })); new Reclaimer(old.c, () => 86_400_000).reclaim([observation]); expect(reject()).toBeUndefined(); heir = 'offline';
  new Reclaimer(old.c, () => 86_399_999).reclaim([observation]); expect(reject()).toBeUndefined(); new Reclaimer(old.c, () => 86_400_000).reclaim([observation]);
  expect(JSON.parse(readFileSync(join(old.sa, 'runs/r1.json'), 'utf8'))).toMatchObject({ rejected: 'engine', intervention_events: [{ action: 'abandon', origin: 'engine', ok: true }] });
});

// prettier-ignore
test('tick retires lost jobs after one hour and batches responsibility alerts by owner and project', () => {
  let now = 0; const notifier = { ...b, session_id: 'notify-session' }, s = setup(who => same(who, notifier) ? { state: 'online', activity: 'idle' } : { state: 'offline' }); mkdirSync(join(s.sa, 'jobs')); writeFileSync(join(s.sa, 'jobs/lost.json'), JSON.stringify({ id: 'lost', title: 'lost', kind: 'codex', tier: 'general', cwd: s.run.repo, launcher: a, wrapper_pid: 99999999, pid: 99999999, started_at: new Date(0).toISOString(), state: 'running' }));
  const waiting = (id: string) => ({ id, ...(id === 'lost' ? { kind: 'job' } : {}), since: new Date(0).toISOString(), waited_s: 0, waiting_for: `处理${id}`, next: `next-${id}` }), heartbeat = (ids: string[]) => writeFileSync(join(s.sa, 'heartbeat.json'), JSON.stringify({ marshals: [{ owner: notifier, project: 'BestIFA', waiting: ids.map(waiting) }] }));
  const r = new Reclaimer(s.c, () => now, () => ({ id: 'engine', status: 'running' })), state = () => JSON.parse(readFileSync(join(s.sa, 'ntfy/state.json'), 'utf8')), ended = () => JSON.parse(readFileSync(join(s.sa, 'jobs/lost.json'), 'utf8')).ended_at;
  heartbeat(['late-a', 'late-b', 'lost']); r.tick(); expect(ended()).toBeUndefined(); now = 59 * 60_000; r.tick(); expect(ended()).toBeUndefined();
  expect(state().alerts).toHaveLength(1); expect(state().alerts[0]).toMatchObject({ title: 'BestIFA 元帅（claude notify-s）有 3 项超 30 分钟未处理', message: 'late-a 处理late-a → next-late-a\nlate-b 处理late-b → next-late-b\nlost 处理lost → next-lost' });
  r.tick(); expect(state().alerts).toHaveLength(1); heartbeat(['late-a', 'late-b', 'late-c', 'lost']); now = 61 * 60_000; r.tick();
  expect(ended()).toBeDefined(); expect(state().alerts).toHaveLength(2); expect(state().alerts[1].message).not.toContain('lost');
});
