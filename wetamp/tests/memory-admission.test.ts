import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { jobCli, memoryReading, readJobs, type Job, type MemoryReading } from '../src/jobs';
import { tmp } from './helpers';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SA_ADMIT', 'SA_ADMIT_MIN_FREE', 'SA_ADMIT_MAX_WAIT'] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
let root: string;
let stderr: ReturnType<typeof spyOn<typeof console, 'error'>>;
beforeEach(() => {
  root = tmp();
  Object.assign(process.env, { SUPERAGENT_HOME: root, ARCHON_HOME: join(root, 'archon'), SA_ADMIT: '', SA_ADMIT_MIN_FREE: '25', SA_ADMIT_MAX_WAIT: '1800' });
  stderr = spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  stderr.mockRestore();
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const sample = (pressure = 1, free = 50): MemoryReading => ({ pressure, free, source: 'sysctl' });
const args = (): string[] => ['job', 'exec', '--title', 'memory-test', '--', 'touch', join(root, 'spawned')];
const only = (): Job => {
  const files = readdirSync(join(root, 'jobs')).filter(f => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(root, 'jobs', files[0]), 'utf8')) as Job;
};
const messages = (): string => stderr.mock.calls.flat().join('\n');

test('normal admits immediately, including the threshold boundary', async () => {
  let probes = 0;
  const code = await jobCli(args(), () => { probes++; expect(only()).toMatchObject({ state: 'queued', pid: 0 }); return sample(1, 25); }, () => { throw new Error('must not wait'); });
  expect(code).toBe(0); expect(probes).toBe(1);
  expect(only()).toMatchObject({ state: 'done', exit_code: 0 });
  expect(only().pid).toBeGreaterThan(0); expect(only().reason).toBeUndefined();
  expect(existsSync(join(root, 'spawned'))).toBe(true); expect(messages()).toBe('');
});

for (const reading of [sample(2, 80), sample(4, 80), sample(1, 24)]) {
  test(`pressure ${String(reading.pressure)}, free ${String(reading.free)} waits then admits`, async () => {
    let probes = 0, waits = 0;
    expect(await jobCli(args(), () => probes++ === 0 ? reading : sample(), async (ms, signal) => {
      waits++; expect(ms).toBe(15000); expect(signal.aborted).toBe(false);
      expect(only()).toMatchObject({ state: 'queued', reason: 'memory', memory: reading, pid: 0 });
      expect(readJobs().jobs[0].state).toBe('queued');
      expect(existsSync(join(root, 'spawned'))).toBe(false);
    })).toBe(0);
    expect(waits).toBe(1); expect(probes).toBe(2); expect(messages()).toContain('queued 等内存');
  });
}

test('timeout is 75, preserves the last reading and never spawns', async () => {
  process.env.SA_ADMIT_MAX_WAIT = '0';
  expect(await jobCli(args(), () => sample(2, 90), () => { throw new Error('no wait after deadline'); })).toBe(75);
  expect(only()).toMatchObject({ state: 'failed', exit_code: 75, pid: 0, memory: sample(2, 90) });
  expect(existsSync(join(root, 'spawned'))).toBe(false);
  expect(messages()).toContain('timed out; pressure=2 free=90% source=sysctl');
});

test('15s retry is capped by the 20s deadline; recovery at timeout never starts a child', async () => {
  let at = Date.now(), probes = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => at);
  const waits: number[] = [];
  process.env.SA_ADMIT_MAX_WAIT = '20';
  try {
    expect(await jobCli(args(), () => ++probes === 3 ? sample() : sample(2), async ms => { waits.push(ms); at += ms; })).toBe(75);
    expect(waits).toEqual([15000, 5000]); expect(probes).toBe(3);
    expect(only()).toMatchObject({ state: 'failed', exit_code: 75, pid: 0, memory: sample() });
    expect(existsSync(join(root, 'spawned'))).toBe(false);
  } finally { clock.mockRestore(); }
});

test('sysctl failure or malformed output uses os percentage, reports fallback and enforces the same threshold', async () => {
  const fallback = memoryReading(() => { throw new Error('unavailable'); }, () => 40);
  expect(fallback).toEqual({ pressure: null, free: 40, source: 'os' });
  expect(memoryReading(() => [1, NaN], () => 40)).toEqual(fallback);
  expect(memoryReading(() => [1, 40])).toEqual(sample(1, 40));
  expect(await jobCli(args(), () => fallback)).toBe(0);
  expect(messages()).toContain('fallback os.freemem()/os.totalmem()');
  process.env.SA_ADMIT_MAX_WAIT = '0'; process.env.SA_ADMIT_MIN_FREE = '41';
  const before = readdirSync(join(root, 'jobs')).length;
  expect(await jobCli(args(), () => fallback)).toBe(75);
  expect(readdirSync(join(root, 'jobs')).length).toBe(before + 1);
});

test('SA_ADMIT=off skips the probe and announces bypass', async () => {
  process.env.SA_ADMIT = 'off';
  process.env.SA_ADMIT_MIN_FREE = 'invalid'; process.env.SA_ADMIT_MAX_WAIT = 'invalid';
  expect(await jobCli(args(), () => { throw new Error('must not probe'); })).toBe(0);
  expect(messages()).toBe('job: SA_ADMIT=off; memory admission skipped');
});

test('invalid thresholds fail visibly without spawning or leaving queued work', async () => {
  process.env.SA_ADMIT_MAX_WAIT = 'NaN';
  await expect(jobCli(args(), () => sample())).rejects.toThrow('invalid SA_ADMIT');
  expect(only()).toMatchObject({ state: 'failed', exit_code: 1, pid: 0 });
  expect(existsSync(join(root, 'spawned'))).toBe(false);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  test(`HF7-R1-01 real OS ${signal} during the probe never starts a child`, async () => {
    const wetamp = join(import.meta.dir, '..');
    const source = `
      import { jobCli, readJobs } from ${JSON.stringify(join(wetamp, 'src/jobs.ts'))};
      const code = await jobCli(${JSON.stringify(args())}, () => {
        const queued = readJobs().jobs[0];
        if (queued.state !== 'queued' || queued.pid !== 0) throw new Error('probe must run before spawn');
        process.kill(process.pid, ${JSON.stringify(signal)});
        return { pressure: 1, free: 90, source: 'sysctl' };
      });
      process.exit(code);
    `;
    const p = Bun.spawn(['bun', '--eval', source], {
      cwd: wetamp, env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await p.exited).toBe(code);
      expect(only()).toMatchObject({ state: 'failed', exit_code: code, signal, pid: 0 });
      expect(existsSync(join(root, 'spawned'))).toBe(false);
      expect(await new Response(p.stderr).text()).toBe('');
    } finally { if (p.exitCode === null) { p.kill('SIGTERM'); await p.exited; } }
  });
  test(`queued ${signal} exits ${String(code)} without spawning and removes handlers`, async () => {
    const listeners = process.listenerCount(signal);
    expect(await jobCli(args(), () => sample(2), async (_ms, stop) => {
      expect(only().state).toBe('queued'); process.emit(signal); expect(stop.aborted).toBe(true);
    })).toBe(code);
    expect(only()).toMatchObject({ state: 'failed', exit_code: code, signal, pid: 0 });
    expect(existsSync(join(root, 'spawned'))).toBe(false);
    expect(process.listenerCount(signal)).toBe(listeners);
  });
}

test('queued list, activity collection and real wait cancellation are visible without running the command', async () => {
  const wetamp = join(import.meta.dir, '..');
  const p = Bun.spawn(['bun', 'src/cli.ts', ...args()], { cwd: wetamp, env: { ...process.env, SA_ADMIT_MIN_FREE: '101' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(root, 'jobs')) && readdirSync(join(root, 'jobs')).some(f => f.endsWith('.json')) && only().memory) break;
      await Bun.sleep(20);
    }
    expect(only()).toMatchObject({ state: 'queued', reason: 'memory', pid: 0 });
    const list = Bun.spawn(['bun', 'src/cli.ts', 'jobs'], { cwd: wetamp, env: process.env, stdout: 'pipe', stderr: 'pipe' });
    expect(await list.exited).toBe(0);
    expect(await new Response(list.stdout).text()).toContain('queued');
    const board = Bun.spawn(['bun', 'src/board/index.ts', 'board', '--once', '--json'], { cwd: wetamp, env: { ...process.env, NODE_ENV: 'test', TWIN_AGENT_QUEUE_CLIENT: '/nonexistent' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await board.exited).toBe(0);
    const s = JSON.parse(await new Response(board.stdout).text()) as { jobs: Job[] };
    expect(s.jobs.find(j => j.id === only().id)?.state).toBe('queued');
    p.kill('SIGTERM'); expect(await p.exited).toBe(143);
    expect(only()).toMatchObject({ state: 'failed', exit_code: 143, signal: 'SIGTERM', pid: 0 });
    expect(existsSync(join(root, 'spawned'))).toBe(false);
  } finally { if (p.exitCode === null) { p.kill('SIGTERM'); await p.exited; } }
});
