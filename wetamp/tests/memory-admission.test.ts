import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobCli, memoryReading, type Job, type MemoryReading } from '../src/jobs';
import { tmp } from './helpers';

const keys = [
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SUPERAGENT_RELAY_QUOTA',
  'SA_ADMIT',
  'SA_ADMIT_MIN_FREE',
  'SA_ADMIT_MAX_WAIT',
] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
let root: string;
let stderr: ReturnType<typeof spyOn<typeof console, 'error'>>;
beforeEach(() => {
  root = tmp();
  writeFileSync(
    join(root, 'relay-quota.json'),
    JSON.stringify({ at: Date.now(), claude_daily_usd: 0 })
  );
  Object.assign(process.env, {
    SUPERAGENT_HOME: root,
    SUPERAGENT_RELAY_QUOTA: 'off',
    ARCHON_HOME: join(root, 'archon'),
    SA_ADMIT: '',
    SA_ADMIT_MIN_FREE: '25',
    SA_ADMIT_MAX_WAIT: '1800',
  });
  stderr = spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  stderr.mockRestore();
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const sample = (pressure = 1, free = 50): MemoryReading => ({ pressure, free, source: 'sysctl' });
const args = (): string[] => [
  'job',
  'exec',
  '--title',
  'memory-test',
  '--',
  'touch',
  join(root, 'spawned'),
];
const only = (): Job => {
  const files = readdirSync(join(root, 'jobs')).filter(f => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(root, 'jobs', files[0]), 'utf8')) as Job;
};
const messages = (): string => stderr.mock.calls.flat().join('\n');

for (const reading of [
  sample(2, 1),
  sample(4, 0),
  { pressure: null, free: 0, source: 'os' } as const,
]) {
  test(`BYPASS_CAPACITY job immediately starts and records low memory ${JSON.stringify(reading)}`, async () => {
    // Retired environment controls must have no effect, even when malformed.
    process.env.SA_ADMIT_MIN_FREE = 'invalid';
    process.env.SA_ADMIT_MAX_WAIT = 'invalid';
    let probes = 0;
    expect(
      await jobCli(args(), () => {
        probes++;
        return reading;
      })
    ).toBe(0);
    expect(probes).toBe(1);
    expect(only()).toMatchObject({ state: 'done', exit_code: 0, memory: reading });
    expect(only().pid).toBeGreaterThan(0);
    expect(only().reason).toBeUndefined();
    expect(existsSync(join(root, 'spawned'))).toBe(true);
    expect(messages()).toBe('');
  });
}
test('memory observation reports unavailable sysctl honestly', () => {
  const fallback: MemoryReading = { pressure: null, free: 0, source: 'os' };
  expect(
    memoryReading(
      () => {
        throw new Error('unavailable');
      },
      () => 0
    )
  ).toEqual(fallback);
  expect(
    memoryReading(
      () => [1, NaN],
      () => 0
    )
  ).toEqual(fallback);
});

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
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
      cwd: wetamp,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      expect(await p.exited).toBe(code);
      expect(only()).toMatchObject({ state: 'failed', exit_code: code, signal, pid: 0 });
      expect(existsSync(join(root, 'spawned'))).toBe(false);
      expect(await new Response(p.stderr).text()).toBe('');
    } finally {
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  });
}
