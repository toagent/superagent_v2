import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { acquireResource, RESOURCE_SLOTS } from '../templates/.archon/scripts/sa-check';

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

test('four complete suites share one machine-wide slot', async () => {
  expect(await maxFor({})).toBe(1);
  expect(readFileSync(slot, 'utf8')).toContain(RESOURCE_SLOTS['heavy-test'][0]);
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

test('a complete suite uses at most half the machine CPUs', async () => {
  const { root, env } = fixture();
  expect(await run(env, 'budget').exited).toBe(0);
  const args = readFileSync(join(root, 'args.budget'), 'utf8').trim();
  expect(args).toEndWith(
    `--timeout 30000 --parallel=${Math.max(1, Math.floor(cpus().length / 2))} tests/ scripts/`
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
  const { env } = fixture();
  const holderFile = `${env.SA_HEAVY_LOCK_FILE}.holder`;
  const holder = run({ ...env, DURATION: '0.5' }, 'metadata');
  for (let i = 0; i < 100 && !existsSync(holderFile); i++) await Bun.sleep(10);
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
  expect(await holder.exited).toBe(0);
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
  const holder = run({ ...env, DURATION: '0.4' }, 'holder');
  for (let i = 0; i < 100 && !existsSync(join(root, 'started.holder')); i++) await Bun.sleep(10);
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
  expect(await holder.exited).toBe(0);
  for (let i = 0; i < 100 && !existsSync(join(root, 'started.foreground')); i++)
    await Bun.sleep(10);
  expect(existsSync(join(root, 'started.foreground'))).toBe(true);
  expect(existsSync(join(root, 'started.background'))).toBe(false);
  expect(await foreground.exited).toBe(0);
  expect(await background.exited).toBe(0);

  writeFileSync(join(queue, '99999999.json.foreground'), '');
  expect(await run({ ...env, SA_HEAVY_CLASS: 'background' }, 'after-dead').exited).toBe(0);
  expect(existsSync(join(queue, '99999999.json.foreground'))).toBe(false);
});
