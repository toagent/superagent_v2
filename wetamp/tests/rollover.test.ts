import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Coordination, repoScope, runScope, type Identity, type RunRef } from '../src/coord';
import { Rollover } from '../src/rollover';
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
  return { root, repo, sa, task, runs, c, r, taskCalls, launchCalls, launches, setWho: (v: Identity) => { who = v; } };
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
  s.setWho(b);
  const accepted = s.r.accept(String(started.token));
  expect(accepted).toMatchObject({ state: 'accepted' });
  expect(s.c.owner(runScope(run)).owner?.session_id).toBe('new');
  expect(s.c.owner(repoScope(s.repo)).owner?.session_id).toBe('new');
  expect(() => s.c.mutate(runScope(run), a, () => null, 1)).toThrow('fencing');
  expect(readFileSync(join(s.sa, 'coord/authorizations/run1.json'), 'utf8')).toContain('original_sha256');
  expect(s.c.messages().some(message => message.type === 'takeover')).toBe(false);
});

// prettier-ignore
test('start rejects outside Orca before tasks and reports missing task sections without a record', async () => {
  const outside = fixture(), calls = outside.taskCalls.length;
  outside.r.d.env = {};
  await expect(outside.r.start()).rejects.toThrow('仅 Orca 内支持自动交接');
  expect(outside.taskCalls).toHaveLength(calls);
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
  expect(s.launchCalls[1]).toEqual(['agent', 'launch', '--retry-launch', 'op-1', '--json']);
  expect(s.taskCalls.filter(call => call[0] === 'handoff')).toHaveLength(1);
  s.r.cancel('a'.repeat(32));
  expect(s.taskCalls.at(-1)).toEqual(['resume', 'session', '执行中']);
  s.setWho(b);
  expect(() => s.r.accept('a'.repeat(32))).toThrow('cancelled');
  expect(await s.r.wait('a'.repeat(32), 0)).toEqual({ state: 'cancelled', exit: 0 });
});
