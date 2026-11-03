import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { acquireResource, RESOURCE_SLOTS } from '../templates/.archon/scripts/sa-check';
import { readHeavyQueue } from '../src/board/data';

const track = trackTempRoots();
const wetamp = join(import.meta.dir, '..');
const script = join(wetamp, 'scripts/test.sh');
const slot = join(wetamp, 'scripts/heavy-slot.sh');

function fixture(): { root: string; env: Record<string, string> } {
  const root = track(mkdtempSync(join(tmpdir(), 'heavy-lock-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'ordinary/wetamp'), { recursive: true });
  writeFileSync(join(root, 'active'), '0\n');
  writeFileSync(join(root, 'max'), '0\n');
  writeFileSync(
    join(root, 'job.sh'),
    `#!/bin/sh
set -eu
echo $$ > "$COUNTER_ROOT/pid.$JOB_ID"
while ! mkdir "$COUNTER_ROOT/mutex" 2>/dev/null; do sleep 0.01; done
active=$(cat "$COUNTER_ROOT/active"); active=$((active + 1)); echo "$active" > "$COUNTER_ROOT/active"
max=$(cat "$COUNTER_ROOT/max"); [ "$active" -le "$max" ] || echo "$active" > "$COUNTER_ROOT/max"
rmdir "$COUNTER_ROOT/mutex"; touch "$COUNTER_ROOT/started.$JOB_ID"
while ! mkdir "$COUNTER_ROOT/order-mutex" 2>/dev/null; do sleep 0.01; done
echo "$JOB_ID" >> "$COUNTER_ROOT/order"
rmdir "$COUNTER_ROOT/order-mutex"
sleep "\${DURATION:-0.15}"
while ! mkdir "$COUNTER_ROOT/mutex" 2>/dev/null; do sleep 0.01; done
active=$(cat "$COUNTER_ROOT/active"); echo $((active - 1)) > "$COUNTER_ROOT/active"
rmdir "$COUNTER_ROOT/mutex"
`
  );
  writeFileSync(
    join(bin, 'bun'),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$COUNTER_ROOT/args.$JOB_ID"\nexec "$COUNTER_ROOT/job.sh"\n'
  );
  chmodSync(join(root, 'job.sh'), 0o755);
  chmodSync(join(bin, 'bun'), 0o755);
  return {
    root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => !!e[1])
      ),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      COUNTER_ROOT: root,
      SA_HEAVY_LOCK_FILE: join(root, 'suite.lock'),
      SA_HEAVY_LOCK_HELD: '',
      SA_ACCEPTANCE: '1',
      TEST_WETAMP: join(root, 'ordinary/wetamp'),
    },
  };
}

function run(
  env: Record<string, string>,
  id: string,
  args: string[] = [],
  cwd = env.TEST_WETAMP ?? wetamp
) {
  return Bun.spawn([script, ...args], {
    cwd,
    env: { ...env, JOB_ID: id },
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

async function maxFor(extra: Record<string, string>, args: string[] = []): Promise<number> {
  const { root, env } = fixture();
  const processes = Array.from({ length: 4 }, (_, i) => run({ ...env, ...extra }, String(i), args));
  expect(await Promise.all(processes.map(p => p.exited))).toEqual([0, 0, 0, 0]);
  return Number(readFileSync(join(root, 'max'), 'utf8'));
}

test('complete suites use three machine-wide slots with a checked shared definition', async () => {
  expect(await maxFor({})).toBe(3);
  const source = readFileSync(slot, 'utf8');
  expect(source).toContain('heavy_slot_count=3');
  expect(RESOURCE_SLOTS['heavy-test']).toEqual([
    RESOURCE_SLOTS['heavy-test'][0],
    `${RESOURCE_SLOTS['heavy-test'][0]}.1`,
    `${RESOURCE_SLOTS['heavy-test'][0]}.2`,
  ]);
  expect(source).toContain('"$heavy_lock_file" "$heavy_lock_file.1" "$heavy_lock_file.2"');

  const { root, env } = fixture(),
    ready = join(root, 'legacy-ready');
  const legacy = Bun.spawn(
    process.platform === 'darwin'
      ? ['/usr/bin/lockf', '-k', env.SA_HEAVY_LOCK_FILE, 'sh', '-c', `touch '${ready}'; sleep 0.8`]
      : ['flock', env.SA_HEAVY_LOCK_FILE, 'sh', '-c', `touch '${ready}'; sleep 0.8`]
  );
  for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(10);
  const jobs = Array.from({ length: 3 }, (_, i) => run(env, `legacy-${String(i)}`));
  expect(await Promise.all(jobs.map(job => job.exited))).toEqual([0, 0, 0]);
  expect(Number(readFileSync(join(root, 'max'), 'utf8'))).toBe(2);
  expect(await legacy.exited).toBe(0);
});

test('an old waiter on slot zero remains mutually exclusive with new callers', async () => {
  if (process.platform !== 'darwin') return;
  const { root, env } = fixture(),
    blockerReady = join(root, 'blocker-ready'),
    oldStarted = join(root, 'old-started'),
    oldDone = join(root, 'old-done');
  const blocker = Bun.spawn([
    '/usr/bin/lockf',
    '-k',
    env.SA_HEAVY_LOCK_FILE,
    'sh',
    '-c',
    `touch '${blockerReady}'; sleep 0.4`,
  ]);
  for (let i = 0; i < 100 && !existsSync(blockerReady); i++) await Bun.sleep(10);
  const old = Bun.spawn([
    '/usr/bin/lockf',
    '-k',
    env.SA_HEAVY_LOCK_FILE,
    'sh',
    '-c',
    `touch '${oldStarted}'; sleep 0.7; touch '${oldDone}'`,
  ]);
  const side = [`${env.SA_HEAVY_LOCK_FILE}.1`, `${env.SA_HEAVY_LOCK_FILE}.2`].map(lock =>
    Bun.spawn(['/usr/bin/lockf', '-k', lock, 'sleep', '1.3'])
  );
  expect(await blocker.exited).toBe(0);
  for (let i = 0; i < 100 && !existsSync(oldStarted); i++) await Bun.sleep(10);
  const next = run(env, 'after-old');
  await Bun.sleep(200);
  expect(existsSync(oldDone)).toBe(false);
  expect(existsSync(join(root, 'started.after-old'))).toBe(false);
  expect(
    await Promise.all([old.exited, ...side.map(holder => holder.exited), next.exited])
  ).toEqual([0, 0, 0, 0]);
});

test('browser admission exposes exactly two machine-wide slots', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'browser-slots-')));
  const locks = [join(root, '0.lock'), join(root, '1.lock')];
  const first = await acquireResource('browser', 500, locks);
  const second = await acquireResource('browser', 500, locks);
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(await acquireResource('browser', 40, locks)).toBeUndefined();
  await first!.release();
  const next = await acquireResource('browser', 500, locks);
  expect(next).toBeDefined();
  await Promise.all([second!.release(), next!.release()]);
});

test('a complete suite uses at most one third of the machine CPUs', async () => {
  const { root, env } = fixture();
  expect(await run(env, 'budget').exited).toBe(0);
  const args = readFileSync(join(root, 'args.budget'), 'utf8').trim();
  expect(args).toEndWith(
    `--timeout 30000 --parallel=${Math.max(1, Math.floor(cpus().length / 3))} tests/ scripts/`
  );
});

test('killing a lock holder lets the next suite acquire the slot', async () => {
  const { root, env } = fixture();
  const holder = run({ ...env, DURATION: '10' }, 'holder');
  for (let i = 0; i < 100 && !existsSync(join(root, 'started.holder')); i++) await Bun.sleep(10);
  expect(existsSync(join(root, 'started.holder'))).toBe(true);
  const next = run(env, 'next');
  holder.kill('SIGKILL');
  await holder.exited;
  try {
    expect(await next.exited).toBe(0);
    expect(existsSync(join(root, 'started.next'))).toBe(true);
  } finally {
    const holderJob = Number(readFileSync(join(root, 'pid.holder'), 'utf8'));
    try {
      process.kill(holderJob, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
});

test('selectors and an inherited heavy slot bypass the lock', async () => {
  expect(await maxFor({}, ['tests/one.test.ts'])).toBeGreaterThan(1);
  expect(await maxFor({ SA_HEAVY_LOCK_HELD: '1' })).toBeGreaterThan(1);
  const { root, env } = fixture();
  const nested = Bun.spawn(
    [
      'bash',
      '-c',
      '. "$1"; heavy_exec env SA_HEAVY_LOCK_HELD=1 bash -c \'. "$1"; heavy_exec "$2"\' _ "$1" "$2"',
      '_',
      slot,
      join(root, 'job.sh'),
    ],
    { env: { ...env, JOB_ID: 'nested' }, stdout: 'ignore', stderr: 'pipe' }
  );
  expect(await nested.exited).toBe(0);
});

test('queued state publishes queue and live holder metadata, then cleans both', async () => {
  const { root, env } = fixture();
  const holderFile = `${env.SA_HEAVY_LOCK_FILE}.holder`;
  const holders = Array.from({ length: 3 }, (_, i) =>
    run({ ...env, DURATION: '0.8' }, `metadata-${String(i)}`)
  );
  for (let i = 0; i < 100 && !existsSync(holderFile); i++) await Bun.sleep(10);
  for (
    let i = 0;
    i < 100 && holders.some((_, n) => !existsSync(join(root, `started.metadata-${String(n)}`)));
    i++
  )
    await Bun.sleep(10);
  const metadata = readFileSync(holderFile, 'utf8');
  expect(metadata).toContain('pid=');
  expect(metadata).toContain('command=');
  const cwd = metadata
    .split('\n')
    .find(line => line.startsWith('cwd='))
    ?.slice(4);
  expect(cwd).toBeDefined();
  expect(realpathSync(cwd!)).toBe(realpathSync(env.TEST_WETAMP));
  expect(metadata).toContain('started_at=');
  const waiter = run({ ...env, DURATION: '0.1' }, 'waiter');
  const queueDir = `${env.SA_HEAVY_LOCK_FILE}.queue`;
  for (
    let i = 0;
    i < 100 &&
    (!existsSync(queueDir) || !readdirSync(queueDir).some(file => file.endsWith('.json')));
    i++
  )
    await Bun.sleep(10);
  const queued = JSON.parse(
    readFileSync(
      join(queueDir, readdirSync(queueDir).find(file => file.endsWith('.json'))!),
      'utf8'
    )
  );
  expect(queued.command).toContain('bun');
  expect(realpathSync(queued.cwd)).toBe(realpathSync(env.TEST_WETAMP));
  expect(readHeavyQueue(env.SA_HEAVY_LOCK_FILE)[0]?.holders).toHaveLength(3);
  expect(await Promise.all(holders.map(holder => holder.exited))).toEqual([0, 0, 0]);
  expect(await waiter.exited).toBe(0);
  expect(readdirSync(queueDir).filter(file => file.endsWith('.json'))).toEqual([]);
  expect(existsSync(holderFile)).toBe(false);

  writeFileSync(holderFile, 'pid=99999999\ncommand=stale\n');
  const inspected = Bun.spawnSync(['sh', '-c', '. "$1"; heavy_holder || true', '_', slot], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(inspected.stdout.toString()).toBe('');
});

test('background work yields to live foreground waiters and ignores dead ones', async () => {
  const { root, env } = fixture(),
    queue = `${env.SA_HEAVY_LOCK_FILE}.queue`;
  const holders = Array.from({ length: 3 }, (_, i) =>
    run({ ...env, DURATION: '0.5' }, `holder-${String(i)}`)
  );
  for (
    let i = 0;
    i < 100 && holders.some((_, n) => !existsSync(join(root, `started.holder-${String(n)}`)));
    i++
  )
    await Bun.sleep(10);
  const background = run({ ...env, SA_HEAVY_CLASS: 'background' }, 'background');
  for (
    let i = 0;
    i < 100 && (!existsSync(queue) || !readdirSync(queue).some(x => x.endsWith('.json')));
    i++
  )
    await Bun.sleep(10);
  expect(
    readdirSync(queue)
      .filter(x => x.endsWith('.json'))
      .map(x => JSON.parse(readFileSync(join(queue, x), 'utf8')))
      .some(x => x.class === 'background')
  ).toBe(true);
  const foreground = run(env, 'foreground');
  for (let i = 0; i < 100 && !readdirSync(queue).some(x => x.endsWith('.foreground')); i++)
    await Bun.sleep(10);
  expect(await Promise.all(holders.map(holder => holder.exited))).toEqual([0, 0, 0]);
  for (let i = 0; i < 100 && !existsSync(join(root, 'started.foreground')); i++)
    await Bun.sleep(10);
  expect(existsSync(join(root, 'started.foreground'))).toBe(true);
  expect(await foreground.exited).toBe(0);
  expect(await background.exited).toBe(0);
  expect(statSync(join(root, 'started.foreground')).mtimeMs).toBeLessThanOrEqual(
    statSync(join(root, 'started.background')).mtimeMs
  );

  writeFileSync(join(queue, '99999999.json.foreground'), '');
  expect(await run({ ...env, SA_HEAVY_CLASS: 'background' }, 'after-dead').exited).toBe(0);
  expect(existsSync(join(queue, '99999999.json.foreground'))).toBe(false);
});

test('foreground waiters acquire in queue order and skip a dead entry', async () => {
  const { root, env } = fixture(),
    queue = `${env.SA_HEAVY_LOCK_FILE}.queue`;
  const holders = Array.from({ length: 3 }, (_, i) =>
    run({ ...env, DURATION: String(4 + i * 0.6) }, `fifo-holder-${String(i)}`)
  );
  for (
    let i = 0;
    i < 100 && holders.some((_, n) => !existsSync(join(root, `started.fifo-holder-${String(n)}`)));
    i++
  )
    await Bun.sleep(10);
  writeFileSync(
    join(queue, '99999999.json'),
    JSON.stringify({ pid: 99999999, command: 'dead', cwd: '/', queued_at: '2000-01-01T00:00:00Z' })
  );
  writeFileSync(join(queue, '99999999.json.foreground'), '');
  const waiters = [],
    errors: Promise<string>[] = [];
  for (const id of ['fifo-1', 'fifo-2', 'fifo-3']) {
    const waiter = run(env, id);
    waiters.push(waiter);
    errors.push(new Response(waiter.stderr).text());
    await Bun.sleep(1100);
  }
  expect(await Promise.all([...holders, ...waiters].map(process => process.exited))).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
  const order = readFileSync(join(root, 'order'), 'utf8')
    .trim()
    .split('\n')
    .filter(id => /^fifo-\d$/.test(id));
  expect(order).toEqual(['fifo-1', 'fifo-2', 'fifo-3']);
  expect((await Promise.all(errors)).join('')).not.toContain('already locked');
  expect(existsSync(join(queue, '99999999.json.foreground'))).toBe(false);
});
