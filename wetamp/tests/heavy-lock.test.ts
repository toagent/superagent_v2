import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();
const wetamp = join(import.meta.dir, '..');
const script = join(wetamp, 'scripts/test.sh');

function fixture(): { root: string; env: Record<string, string> } {
  const root = track(mkdtempSync(join(tmpdir(), 'heavy-lock-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
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
    },
  };
}

function run(env: Record<string, string>, id: string, args: string[] = []) {
  return Bun.spawn([script, ...args], {
    cwd: wetamp,
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
});

test('a complete suite leaves two CPUs free for the machine', async () => {
  const { root, env } = fixture();
  expect(await run(env, 'budget').exited).toBe(0);
  const args = readFileSync(join(root, 'args.budget'), 'utf8').trim();
  expect(args).toEndWith(`--parallel=${Math.max(1, cpus().length - 2)} tests/ scripts/`);
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
});
