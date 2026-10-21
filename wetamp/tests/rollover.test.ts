import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Coordination, repoScope, runScope, type Identity, type RunRef } from '../src/coord';
import { Rollover, type RolloverRecord } from '../src/rollover';
import { gitRepo, tmp } from './helpers';

// prettier-ignore
const a: Identity = { client: 'codex', session_id: 'old', host: hostname(), pid: 10, pid_start: 'a' };
const b: Identity = { ...a, session_id: 'new', pid: 11, pid_start: 'b' };

// prettier-ignore
function fixture(section = true) {
  const root = tmp(), repo = gitRepo(root), sa = join(root, 'sa');
  mkdirSync(join(sa, 'runs'), { recursive: true });
  const task = join(repo, '.context/sessions/session/task-stack.md'), transcript = join(root, 'rollout.jsonl');
  mkdirSync(join(sa, 'live'), { recursive: true });
  mkdirSync(join(task, '..'), { recursive: true });
  writeFileSync(task, `主任务: rollover\n状态: 执行中\n断点: next\n# 接手必读\n无\n# 在途\n无\n${section ? '# 已核实与更正\n无\n' : ''}`);
  writeFileSync(transcript, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } }) + '\n');
  writeFileSync(join(sa, 'live/a.json'), JSON.stringify({ ...a, transcript_path: transcript }));
  let who = a, now = 0;
  const runs: RunRef[] = [], c = new Coordination({ sa, runs: () => runs, status: () => 'running', presence: () => ({ state: 'online', activity: 'idle' }) });
  const taskCalls: string[][] = [],
    launchCalls: string[][] = [],
    launches: ({ kind: 'launched'; outcome: unknown } | { kind: 'lost'; operation_id: string } | { kind: 'unknown'; evidence: string } | { kind: 'failed'; error: string })[] = [{ kind: 'launched', outcome: { session: 'new' } }];
  const r = new Rollover({
    env: { ORCA_AGENT_SESSION_ID: 'orca', SA_ORCA_BIN: '/orca' },
    cwd: repo,
    coord: c,
    who: () => who,
    exists: path => path === '/orca' || Bun.file(path).size > 0,
    tasks: (_cwd, args) => { taskCalls.push(args); return args[0] === 'path' ? task : ''; },
    launch: async (_bin, args) => { launchCalls.push(args); return launches.shift()!; },
    repo: () => repo,
    token: () => 'a'.repeat(32),
    now: () => new Date(now),
    sleep: async ms => { now += ms; },
    jobs: () => [],
  });
  return { root, repo, sa, task, transcript, runs, c, r, taskCalls, launchCalls, launches, setWho: (v: Identity) => { who = v; } };
}

// prettier-ignore
test('start and accept transfer run/repo, reauthorize delivery and fence the old owner', async () => {
  const s = fixture(), gen = join(s.root, 'gen');
  mkdirSync(gen);
  writeFileSync(join(gen, 'delivery-authorization.json'), '{}');
  const run: RunRef = { run_id: 'run1', archon_run_id: 'engine', repo: s.repo, gen_dir: gen };
  s.runs.push(run);
  s.c.claimRun(runScope(run), a);
  writeFileSync(join(s.sa, 'runs/run1.json'), JSON.stringify(run));
  const started = await s.r.start();
  expect(started.token).toBe('a'.repeat(32));
  expect(s.taskCalls[1]).toEqual(['handoff', 'session']);
  expect(s.launchCalls[0]).toContain('gpt-test');
  expect(s.launchCalls[0].join(' ')).toContain(`path:${s.repo}`);
  expect(s.launchCalls[0].join(' ')).toContain(`accept ${started.token}`);
  expect(await s.r.start()).toEqual(started);
  expect(s.launchCalls).toHaveLength(1);
  const generation = s.c.owner(runScope(run)).generation,
    repoGeneration = s.c.owner(repoScope(s.repo)).generation;
  expect(() => s.r.accept(String(started.token))).toThrow('新会话');
  s.setWho(b);
  const accepted = s.r.accept(String(started.token));
  expect(accepted).toMatchObject({ state: 'accepted', repo: 'unchanged' });
  expect(s.taskCalls.slice(-2)).toEqual([['adopt', 'session', '--owner', 'new'], ['resume', 'session', '执行中']]);
  expect(s.c.owner(runScope(run)).owner?.session_id).toBe('new');
  expect(s.c.owner(repoScope(s.repo)).owner?.session_id).toBe('new');
  expect(s.c.owner(runScope(run)).generation).toBe(generation + 1);
  expect(s.c.owner(repoScope(s.repo)).generation).toBe(repoGeneration + 1);
  expect(() => s.c.mutate(runScope(run), a, () => null, 1)).toThrow('fencing');
  expect(readFileSync(join(s.sa, 'coord/authorizations/run1.json'), 'utf8')).toContain('original_sha256');
  expect(s.c.messages().some(message => message.type === 'takeover')).toBe(false);
});

test('accept transfers the recorded repository without runs and reports owner changes', async () => {
  const transferred = fixture();
  transferred.c.claim(repoScope(transferred.repo), a);
  const transferredStart = await transferred.r.start();
  transferred.setWho(b);
  expect(transferred.r.accept(String(transferredStart.token))).toMatchObject({
    repo: 'transferred',
  });
  expect(transferred.c.owner(repoScope(transferred.repo)).owner?.session_id).toBe('new');
  expect(
    JSON.parse(
      readFileSync(join(transferred.sa, `coord/rollovers/${transferredStart.token}.json`), 'utf8')
    ).repo_transfer
  ).toBe('transferred');

  const skipped = fixture(),
    other = { ...b, session_id: 'other' };
  skipped.c.claim(repoScope(skipped.repo), a);
  const skippedStart = await skipped.r.start();
  skipped.c.rolloverTransfer(repoScope(skipped.repo), a, other, 'other');
  skipped.setWho(b);
  expect(skipped.r.accept(String(skippedStart.token))).toMatchObject({
    repo: 'skipped:owner_changed',
  });
  expect(skipped.c.owner(repoScope(skipped.repo)).owner?.session_id).toBe('other');

  const unavailable = fixture();
  const unavailableStart = await unavailable.r.start();
  rmSync(unavailable.repo, { recursive: true, force: true });
  unavailable.setWho(b);
  expect(unavailable.r.accept(String(unavailableStart.token))).toMatchObject({
    repo: 'skipped:repository_unavailable',
  });
});

test('accept skips resume when the task stack had no prior status', async () => {
  const s = fixture();
  writeFileSync(s.task, readFileSync(s.task, 'utf8').replace('状态: 执行中\n', ''));
  const started = await s.r.start();
  s.setWho(b);
  expect(s.r.accept(String(started.token))).toMatchObject({ state: 'accepted' });
  expect(s.taskCalls.filter(call => call[0] === 'resume')).toEqual([]);
  expect(s.taskCalls.at(-1)).toEqual(['adopt', 'session', '--owner', 'new']);
});

// prettier-ignore
test('start rejects outside Orca before tasks and reports missing task sections without a record', async () => {
  const outside = fixture(), calls = outside.taskCalls.length;
  outside.r.d.env = {};
  await expect(outside.r.start()).rejects.toThrow('仅 Orca 内支持自动交接');
  expect(outside.taskCalls).toHaveLength(calls);
  expect(existsSync(join(outside.sa, 'coord/rollovers'))).toBe(false);
  const missingBin = fixture();
  missingBin.r.d.env.SA_ORCA_BIN = '/missing';
  missingBin.r.d.exists = () => false;
  await expect(missingBin.r.start()).rejects.toThrow('仅 Orca 内支持自动交接');
  expect(missingBin.taskCalls).toHaveLength(0);
  expect(existsSync(join(missingBin.sa, 'coord/rollovers'))).toBe(false);
  const missing = fixture(false);
  await expect(missing.r.start()).rejects.toThrow('已核实与更正');
  expect(missing.taskCalls).toHaveLength(1);
  expect(missing.launchCalls).toHaveLength(0);
  const failed = fixture();
  failed.r.d.tasks = (_cwd, args) => { if (args[0] === 'handoff') throw new Error('handoff failed'); return failed.task; };
  await expect(failed.r.start()).rejects.toThrow('handoff failed');
  expect(JSON.parse(readFileSync(join(failed.sa, `coord/rollovers/${'a'.repeat(32)}.json`), 'utf8')).state).toBe('cancelled');
});

// prettier-ignore
test('lost launch retries the same operation, then cancel restores and wait observes cancellation', async () => {
  const s = fixture();
  s.launches.splice(0, 1, { kind: 'lost', operation_id: 'op-1' }, { kind: 'launched', outcome: {} });
  await expect(s.r.start('manual')).rejects.toThrow('回包丢失');
  await s.r.start('manual');
  expect(s.launchCalls).toHaveLength(2);
  expect(s.launchCalls[1]).toEqual([...s.launchCalls[0].slice(0, -1), '--retry-launch', 'op-1', '--json']);
  expect(s.taskCalls.filter(call => call[0] === 'handoff')).toHaveLength(1);
  s.r.cancel('a'.repeat(32));
  expect(s.taskCalls.at(-1)).toEqual(['resume', 'session', '执行中']);
  s.setWho(b);
  expect(() => s.r.accept('a'.repeat(32))).toThrow('cancelled');
  expect(await s.r.wait('a'.repeat(32), 0)).toEqual({ state: 'cancelled', exit: 0 });
});

test('failed and interrupted launches stay explicit while transient live files are ignored', async () => {
  const failed = fixture();
  writeFileSync(join(failed.sa, 'live/partial.json'), '{');
  writeFileSync(join(failed.sa, 'live/a.json.99.tmp'), '{');
  failed.launches[0] = { kind: 'failed', error: 'bad selector' };
  await expect(failed.r.start()).rejects.toThrow('launch 失败');
  expect(failed.taskCalls.at(-1)).toEqual(['resume', 'session', '执行中']);
  expect(
    JSON.parse(readFileSync(join(failed.sa, `coord/rollovers/${'a'.repeat(32)}.json`), 'utf8'))
      .state
  ).toBe('cancelled');

  const interrupted = fixture();
  interrupted.r.d.launch = async () => {
    throw new Error('process crash');
  };
  await expect(interrupted.r.start()).rejects.toThrow('process crash');
  await expect(interrupted.r.start()).rejects.toThrow('无 operation id');
  expect(await interrupted.r.wait('a'.repeat(32), 1)).toEqual({ state: 'pending', exit: 2 });
});

test('accept resumes after supervisor and adopt failures without repeating completed steps', async () => {
  const s = fixture(),
    run: RunRef = { run_id: 'run1', archon_run_id: 'engine', repo: s.repo };
  s.runs.push(run);
  s.c.claimRun(runScope(run), a);
  writeFileSync(join(s.sa, 'runs/run1.json'), JSON.stringify(run));
  const started = await s.r.start();
  s.setWho(b);
  mkdirSync(join(s.root, 'supervisor/workers'), { recursive: true });
  writeFileSync(
    join(s.root, 'supervisor/workers/w.json'),
    JSON.stringify({ id: 'w', cwd: s.repo, session_id: 'old' })
  );
  s.r.d.env.AGENT_SUPERVISOR_STATE = join(s.root, 'supervisor');
  const supervisorCalls: string[][] = [];
  s.r.d.supervise = args => {
    supervisorCalls.push(args);
    if (supervisorCalls.length === 1) throw new Error('supervisor crash');
    return '';
  };
  let failAdopt = true;
  s.r.d.tasks = (_cwd, args) => {
    s.taskCalls.push(args);
    if (args[0] === 'adopt' && failAdopt) {
      failAdopt = false;
      throw new Error('adopt crash');
    }
    return '';
  };
  expect(() => s.r.accept(String(started.token))).toThrow('supervisor crash');
  const generation = s.c.owner(runScope(run)).generation;
  expect(() => {
    s.setWho(a);
    s.r.cancel(String(started.token));
  }).toThrow('不可取消');
  s.setWho(b);
  expect(() => s.r.accept(String(started.token))).toThrow('adopt crash');
  expect(s.r.accept(String(started.token))).toMatchObject({ state: 'accepted' });
  expect(s.c.owner(runScope(run)).generation).toBe(generation);
  expect(supervisorCalls).toHaveLength(2);
  expect(() => {
    s.setWho({ ...b, session_id: 'third' });
    s.r.accept(String(started.token));
  }).toThrow('accepted');
});

test('context renders a two-generation chain oldest first', async () => {
  const s = fixture(),
    token = 'b'.repeat(32),
    old = join(s.root, 'old.jsonl');
  writeFileSync(
    old,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'older' }] },
      },
    }) + '\n'
  );
  const latest = JSON.parse(
    readFileSync(join(s.sa, `coord/rollovers/${String((await s.r.start()).token)}.json`), 'utf8')
  ) as RolloverRecord;
  writeFileSync(
    s.transcript,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'newer' }] },
      },
    }) + '\n'
  );
  mkdirSync(join(s.sa, 'coord/rollovers'), { recursive: true });
  writeFileSync(
    join(s.sa, `coord/rollovers/${token}.json`),
    JSON.stringify({ ...latest, token, parent: null, transcript: old })
  );
  latest.parent = token;
  writeFileSync(join(s.sa, `coord/rollovers/${latest.token}.json`), JSON.stringify(latest));
  s.setWho(b);
  const out = await s.r.context(latest.token);
  expect(out.indexOf('older')).toBeLessThan(out.indexOf('newer'));
});

test('accept reports a run whose owner changed after start as skipped', async () => {
  const s = fixture(),
    other = { ...b, session_id: 'other' };
  const run: RunRef = { run_id: 'run1', archon_run_id: 'engine', repo: s.repo };
  s.runs.push(run);
  s.c.claimRun(runScope(run), a);
  writeFileSync(join(s.sa, 'runs/run1.json'), JSON.stringify(run));
  const started = await s.r.start();
  s.c.rolloverTransfer(runScope(run), a, other, 'other');
  s.setWho(b);
  expect(s.r.accept(String(started.token))).toMatchObject({
    runs: [{ run: 'run1', skipped: 'owner_changed' }],
  });
});

test('unavailable run repositories are excluded at start and skipped at accept', async () => {
  const stale = fixture(),
    staleRepo = gitRepo(join(stale.root, 'stale')),
    staleRun: RunRef = { run_id: 'stale', archon_run_id: 'stale-engine', repo: staleRepo };
  stale.runs.push(staleRun);
  stale.c.claimRun(runScope(staleRun), a);
  writeFileSync(join(stale.sa, 'runs/stale.json'), JSON.stringify(staleRun));
  rmSync(staleRepo, { recursive: true, force: true });
  const staleStarted = await stale.r.start();
  expect(
    JSON.parse(
      readFileSync(join(stale.sa, `coord/rollovers/${String(staleStarted.token)}.json`), 'utf8')
    ).runs
  ).toEqual([]);

  const s = fixture(),
    disappearingRepo = gitRepo(join(s.root, 'disappearing')),
    kept: RunRef = { run_id: 'kept', archon_run_id: 'kept-engine', repo: s.repo },
    disappearing: RunRef = {
      run_id: 'disappearing',
      archon_run_id: 'gone-engine',
      repo: disappearingRepo,
    };
  for (const run of [kept, disappearing]) {
    s.runs.push(run);
    s.c.claimRun(runScope(run), a);
    writeFileSync(join(s.sa, `runs/${run.run_id}.json`), JSON.stringify(run));
  }
  const started = await s.r.start();
  rmSync(disappearingRepo, { recursive: true, force: true });
  s.setWho(b);
  expect(s.r.accept(String(started.token))).toMatchObject({
    state: 'accepted',
    runs: [
      { run: 'kept', skipped: undefined },
      { run: 'disappearing', skipped: 'repository_unavailable' },
    ],
  });
  expect(s.c.owner(runScope(kept)).owner?.session_id).toBe('new');
});
