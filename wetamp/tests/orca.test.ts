import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cockpit, type Cockpit, type CockpitRun } from '../src/board/cockpit';
import { unreadableRow, type Snapshot } from '../src/board/data';
import { unknownProgress } from '../src/board/eta';
import { orcaView, syncOrca, type OrcaDeps } from '../src/orca';

const item = (id: string, extra: Partial<CockpitRun> = {}): CockpitRun => ({
  id, project: id, title: 'plan title', state: 'running', stage: '编码 m1/1',
  progress: unknownProgress(), progressText: '73%', elapsed: '12m05s', tokens: '99K',
  role: '将军', round: '1', reason: '', question: 'private question', waiting: '3h', ...extra,
});
const view = (active: CockpitRun[] = [], needs: CockpitRun[] = []): Cockpit => ({
  ...cockpit({ at: '2026-10-11T00:00:00Z', summary: {}, rows: [] }),
  active, needs, runs: [], tokens: '99K', roleTokens: [], tokenRows: null,
  metrics: { completed: 0, decided: 0, firstPass: 0, asks: 0, debt: 0 },
});
const frame = (active: string[] = [], needs: string[] = [], why = 'review_limit'): Snapshot => ({
  at: '2026-10-11T00:00:00Z', summary: {},
  rows: [...new Set([...active, ...needs])].map(id => ({
    ...unreadableRow(id, ''), repo: id, state: active.includes(id) ? 'running' : 'held:gate',
    nativeState: active.includes(id) ? 'running' : 'failed', lastEvent: '2026-10-11T00:00:00Z',
    nodes: { current: 'code-core', currentRole: 'coder', total: 1, done: 0 },
    engine: { title: 'plan', milestones: ['m1'], currentMilestone: 'm1', states: [],
      firstPass: false, reason: why, dispositions: [] },
  })),
  asks: Object.fromEntries(needs.map(id => [`${id}:${why}:episode`, { status: 'pending' }])),
});

function harness(s: Snapshot = frame()) {
  const sa = '/scratch-orca', bin = '/test/orca';
  const calls: { bin: string; args: string[]; signal: AbortSignal }[] = [];
  const writes: { path: string; text: string }[] = [];
  const h = {
    snapshot: s, saved: undefined as string | undefined,
    probe: { ok: true, result: { app: { running: true }, runtime: { reachable: true } } } as unknown,
    result: { ok: true } as unknown, loads: 0, locks: [] as string[], releases: 0,
  };
  const deps: OrcaDeps = {
    env: { SA_ORCA_BIN: bin }, sa: () => sa,
    exists: path => [bin, join(sa, 'orca-board')].includes(path),
    read: path => { expect(path).toBe(join(sa, 'orca-board.json')); return h.saved; },
    write: (path, text) => { writes.push({ path, text }); h.saved = text; },
    lock: path => { h.locks.push(path); return { ok: true, release: () => { h.releases++; } }; },
    load: async signal => { expect(signal).toBeInstanceOf(AbortSignal); h.loads++; return h.snapshot; },
    now: () => Date.parse('2026-10-11T00:00:00Z'),
    exec: async (path, args, signal) => {
      calls.push({ bin: path, args, signal });
      return JSON.stringify(args[0] === 'status' ? h.probe : h.result);
    },
    timeoutMs: 2000, commandTimeoutMs: 1000,
  };
  return { h, deps, calls, writes, sets: () => calls.filter(c => c.args[0] === 'worktree') };
}

describe('orcaView', () => {
  test('empty, active and needs use cockpit counts and prioritize needs', () => {
    expect(orcaView(view())).toEqual({ status: 'completed', comment: '跑 0 · 等你 0', needs: [] });
    expect(orcaView(view([item('BestIFA')])).status).toBe('in-progress');
    const v = orcaView(view([item('BestIFA'), item('wt-hf10', { stage: '评审' })],
      [item('xiaopan-translator', { reason: '三轮评审用尽' })]));
    expect(v.status).toBe('in-review');
    expect(v.comment).toBe('跑 2 · 等你 1｜? xiaopan-translator 三轮评审用尽｜BestIFA 编码 m1/1｜wt-hf10 评审');
    expect(v.comment).not.toMatch(/%|12m05s|99K|private question|3h/);
  });
  test('drops whole trailing entries with omitted count and keeps the header', () => {
    const v = orcaView(view(Array.from({ length: 6 }, (_, i) => item(`p${i}-${'项'.repeat(75)}`)),
      [item('need', { reason: 'review_limit' })]));
    expect(v.comment.length).toBeLessThanOrEqual(200);
    expect(v.comment).toStartWith('跑 6 · 等你 1｜? need 三轮评审用尽｜p0-');
    expect(v.comment).toEndWith('｜…+5');
    expect(orcaView(view([item('项'.repeat(300))])).comment).toBe('跑 1 · 等你 0｜…+1');
  });
  test('node free text is excluded; needs identities are sorted unique pairs', () => {
    const v = orcaView(view([], [item('b', { reason: 'secret-node-summary' }), item('a', { reason: 'review_limit' }), item('a', { reason: 'review_limit' })]));
    expect(v.comment).not.toContain('secret-node-summary');
    expect(v.comment).toContain('待处置');
    expect(v.needs).toEqual(['["a","三轮评审用尽"]', '["b","待处置"]']);
  });
});

describe('syncOrca (injected only)', () => {
  test('disabled, missing board and missing binary perform no commands or loads', async () => {
    for (const mode of ['disabled', 'no-board', 'no-orca']) {
      const s = harness();
      if (mode === 'disabled') { s.deps.env.SA_ORCA = '0'; s.deps.sa = () => { throw new Error('must not resolve home'); }; }
      else s.deps.exists = path => mode === 'no-orca' && path.endsWith('/orca-board');
      expect(await syncOrca(s.deps)).toEqual({ skipped: mode });
      expect(s.calls).toHaveLength(0); expect(s.h.loads).toBe(0); expect(s.writes).toHaveLength(0);
      expect(s.h.locks).toHaveLength(0);
    }
  });
  test('busy projection lock skips before probing or loading', async () => {
    const s = harness();
    s.deps.lock = path => { s.h.locks.push(path); return { ok: false, reason: 'locked' }; };
    expect(await syncOrca(s.deps)).toEqual({ skipped: 'locked' });
    expect(s.h.locks).toEqual(['/scratch-orca/orca-board.lock']);
    expect(s.calls).toHaveLength(0); expect(s.h.loads).toBe(0); expect(s.writes).toHaveLength(0);
    expect(s.h.releases).toBe(0);
  });
  test('binary resolution prefers override, then absolute installation locations', async () => {
    for (const bin of ['/test/orca', '/usr/local/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca']) {
      const s = harness();
      s.deps.exists = path => path.endsWith('/orca-board') || path === bin;
      expect(await syncOrca(s.deps)).toEqual({ synced: true });
      expect(s.calls.every(c => c.bin === bin)).toBe(true);
    }
  });
  test('non-running/unreachable/failed/invalid probes never set, start or load', async () => {
    for (const probe of [
      { ok: true, result: { app: { running: false }, runtime: { reachable: true } } },
      { ok: true, result: { app: { running: true }, runtime: { reachable: false } } },
      { ok: false }, null, { ok: true, result: {} },
    ]) {
      const s = harness(); s.h.probe = probe;
      expect(await syncOrca(s.deps)).toEqual({ skipped: 'unavailable' });
      expect(s.calls.map(c => c.args)).toEqual([['status', '--json']]);
      expect(s.h.loads).toBe(0); expect(s.writes).toHaveLength(0);
      expect(s.h.releases).toBe(1);
    }
    const s = harness(); s.deps.exec = async () => { throw new Error('not reachable'); };
    expect(await syncOrca(s.deps)).toEqual({ skipped: 'unavailable' });
  });
  test('unchanged successful projection skips set, while changed needs mark unread/read', async () => {
    const s = harness(frame(['active'], ['held']));
    expect(await syncOrca(s.deps)).toEqual({ synced: true });
    expect(s.sets()[0]?.args).toContain('--unread');
    expect(s.writes[0]?.path).toBe('/scratch-orca/orca-board.json');
    expect(await syncOrca(s.deps)).toEqual({ skipped: 'unchanged' });
    expect(s.sets()).toHaveLength(1); expect(s.writes).toHaveLength(1);
    expect(s.h.locks).toEqual(Array(2).fill('/scratch-orca/orca-board.lock'));
    expect(s.h.releases).toBe(2);
    s.h.snapshot = frame(['active'], ['held', 'new']); await syncOrca(s.deps);
    expect(s.sets().at(-1)?.args).toContain('--unread');
    s.h.snapshot = frame(['active']); await syncOrca(s.deps);
    expect(s.sets().at(-1)?.args).toContain('--read');
  });
  test('active-only changes and removal of some needs preserve manual read status', async () => {
    const s = harness(frame(['one'], ['held', 'other'])); await syncOrca(s.deps);
    for (const snapshot of [frame(['two'], ['held', 'other']), frame(['two'], ['held'])]) {
      s.h.snapshot = snapshot; expect(await syncOrca(s.deps)).toEqual({ synced: true });
      const args = s.sets().at(-1)?.args;
      expect(args).not.toContain('--unread'); expect(args).not.toContain('--read');
    }
    const active = harness(frame(['one'])); await syncOrca(active.deps);
    expect(active.sets()[0]?.args).not.toContain('--unread');
    active.h.snapshot = frame(['two']); await syncOrca(active.deps);
    expect(active.sets().at(-1)?.args).not.toContain('--read');
  });
  test('EV liveness expiry updates the Orca projection without changing read status', async () => {
    const s = harness(frame(['active']));
    expect(await syncOrca(s.deps)).toEqual({ synced: true });
    s.deps.now = () => Date.parse('2026-10-11T00:10:00Z');
    expect(await syncOrca(s.deps)).toEqual({ synced: true });
    const args = s.sets().at(-1)?.args;
    expect(args).toContain('completed');
    expect(args).toContain('跑 0 · 等你 0');
    expect(args).not.toContain('--read');
    expect(args).not.toContain('--unread');
  });
  test('same run with a new registered need marks unread', async () => {
    const s = harness(frame([], ['held'])); await syncOrca(s.deps);
    s.h.snapshot = frame([], ['held'], 'budget'); await syncOrca(s.deps);
    expect(s.sets().at(-1)?.args).toContain('--unread');
  });
  test('ok:false does not overwrite state; the next tick retries', async () => {
    const s = harness(frame(['one']));
    await syncOrca(s.deps); const saved = s.h.saved;
    s.h.snapshot = frame([], ['held']); s.h.result = { ok: false, error: { code: 'unavailable', message: 'offline' } };
    expect(await syncOrca(s.deps)).toEqual({ error: 'offline' });
    expect(s.h.saved).toBe(saved); expect(s.writes).toHaveLength(1);
    s.h.result = { ok: true }; expect(await syncOrca(s.deps)).toEqual({ synced: true });
    expect(s.sets()).toHaveLength(3); expect(s.sets().at(-1)?.args).toContain('--unread');
  });
  test('command timeouts return an error and abort the child signal', async () => {
    for (const verb of ['status', 'worktree']) {
      const s = harness(); const execute = s.deps.exec;
      let child: AbortSignal | undefined;
      s.deps.commandTimeoutMs = 5;
      s.deps.exec = async (bin, args, signal) => {
        if (args[0] !== verb) return execute(bin, args, signal);
        child = signal;
        return new Promise(() => undefined);
      };
      const result = await syncOrca(s.deps);
      expect('error' in result).toBe(true); expect(child?.aborted).toBe(true);
      expect(s.writes).toHaveLength(0);
      expect(s.h.releases).toBe(1);
    }
  });
  test('overall timeout aborts snapshot loading and never writes an incomplete view', async () => {
    const s = harness(); let loading: AbortSignal | undefined;
    s.deps.timeoutMs = 5;
    s.deps.load = signal => { loading = signal; return new Promise(() => undefined); };
    expect('error' in await syncOrca(s.deps)).toBe(true);
    expect(loading?.aborted).toBe(true); expect(s.sets()).toHaveLength(0); expect(s.writes).toHaveLength(0);
  });
  test('bad JSON and invalid cache shapes rebuild as no history and mark needs unread', async () => {
    for (const saved of ['{broken', '{}', 'null', '[]',
      '{"status":"invalid","comment":"old","needs":[]}',
      '{"status":"completed","comment":1,"needs":[]}',
      '{"status":"completed","comment":"old","needs":[1]}']) {
      const s = harness(frame([], ['held'])); s.h.saved = saved;
      expect(await syncOrca(s.deps)).toEqual({ synced: true });
      expect(s.sets()).toHaveLength(1); expect(s.sets()[0]?.args).toContain('--unread');
      expect(s.writes).toHaveLength(1); expect(s.writes[0]?.path).toBe('/scratch-orca/orca-board.json');
      expect(JSON.parse(s.h.saved ?? '')).toEqual(orcaView(cockpit(s.h.snapshot, s.deps.now())));
      expect(s.h.releases).toBe(1);
    }
  });
  test('unrelated time/token changes do not rewrite; read/write errors remain visible', async () => {
    const s = harness(frame(['active'])); await syncOrca(s.deps);
    s.deps.now = () => Date.parse('2026-10-11T00:01:00Z');
    expect(orcaView(cockpit(s.h.snapshot, s.deps.now())).comment).not.toContain('%');
    expect(await syncOrca(s.deps)).toEqual({ skipped: 'unchanged' });
    const read = s.deps.read;
    s.deps.read = () => { throw new Error('permission denied'); };
    expect(await syncOrca(s.deps)).toEqual({ error: 'permission denied' });
    expect(s.sets()).toHaveLength(1); expect(s.writes).toHaveLength(1);
    s.deps.read = read; s.h.saved = '{}'; s.deps.write = () => { throw new Error('disk full'); };
    expect(await syncOrca(s.deps)).toEqual({ error: 'disk full' });
    expect(s.writes).toHaveLength(1); expect(s.h.saved).toBe('{}');
    expect(s.h.releases).toBe(4);
  });
});
