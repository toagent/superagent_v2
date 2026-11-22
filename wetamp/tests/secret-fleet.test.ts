import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncFleet } from '../src/secrets/fleet';
import { emptySummary } from '../src/secrets/sync';
import { tmp } from './helpers';

test('fleet CLI uses batch SSH and reports fresh, missing and disconnected hosts', () => {
  const home = tmp(),
    bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, '.config/superagent'), { recursive: true });
  writeFileSync(join(home, '.config/superagent/op-sa.token'), 'synthetic-only');
  writeFileSync(join(bin, 'op'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const ssh = `#!/bin/sh
[ "$1 $2 $3" = "-T -o BatchMode=yes" ] || exit 255
while [ "$1" != -- ]; do shift; done
shift
[ "$1" != offline ] || { echo "synthetic-stderr" >&2; exit 255; }
case "$2" in
  *'launchctl print'*) [ "$1" != missing ] && exit 0; exit 69;;
  *'launchctl kickstart'*) [ "$1" != missing ] || exit 69
     [ "$1" != ready ] || touch "$HOME/$1.ready";;
  *) sec=00; [ ! -f "$HOME/$1.ready" ] || sec=01
     printf '{"ok":true,"at":"2026-11-22T01:00:%s.000Z","synced":["ONLY"],"unchanged":[],"pruned":[],"failed":[],"error":null}\\n' "$sec";;
esac
`;
  writeFileSync(join(bin, 'ssh'), ssh, { mode: 0o755 });
  const path = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const env = { ...process.env, HOME: home, PATH: path };
  const cli = join(import.meta.dir, '../src/cli.ts');
  const args = ['secret', 'sync', '--host', 'ready', '--host', 'missing', '--host', 'offline'];
  const result = Bun.spawnSync([process.execPath, cli, ...args], { env });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).not.toContain('synthetic-stderr');
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    ok: false,
    hosts: {
      local: { ok: true },
      ready: { ok: true, synced: ['ONLY'] },
      missing: { ok: false, error: expect.stringContaining('LaunchAgent') },
      offline: { ok: false, error: expect.stringContaining('SSH') },
    },
  });
  const run = (command: string, args: string[]) => spawnSync(command, args, { env });
  const timeout = syncFleet(['stale'], false, () => emptySummary(null), run, 30);
  expect(timeout.hosts.stale?.error).toContain('超时');
});
