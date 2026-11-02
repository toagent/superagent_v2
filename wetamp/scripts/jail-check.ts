import { dlopen, FFIType } from 'bun:ffi';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const usage = (): never => {
  console.error('usage: bun scripts/jail-check.ts [--canary <dir>]');
  process.exit(64);
};

const args = process.argv.slice(2);
if (args.length) {
  if (args.length !== 2 || args[0] !== '--canary') usage();
  const canary = join(args[1], 'canary');
  const scratch = mkdtempSync(join(tmpdir(), 'ai-jail-check-'));
  const control = join(scratch, 'control');
  const node = Bun.which('node');
  if (!node) throw new Error('jail-check requires node for the canary');
  writeFileSync(control, 'ok\n');
  const readers: [string, string[]][] = [
    ['/bin/sh', ['-c', 'cat "$1"', 'sh']],
    ['/usr/bin/python3', ['-I', '-c', 'open(__import__("sys").argv[1]).read()']],
    [node, ['-e', 'require("node:fs").readFileSync(process.argv[1])']],
  ];
  try {
    for (const [program, prefix] of readers) {
      const blocked = Bun.spawnSync([program, ...prefix, canary], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const error = blocked.stderr.toString();
      if (blocked.exitCode === 0 || !/(Operation not permitted|EPERM)/i.test(error)) {
        console.error(
          `${basename(program)}: canary NOT blocked (${error.trim() || `exit ${String(blocked.exitCode)}`})`
        );
        process.exitCode = 1;
      } else console.log(`${basename(program)}: canary EPERM`);
      const allowed = Bun.spawnSync([program, ...prefix, control], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (allowed.exitCode !== 0) {
        console.error(
          `${basename(program)}: control unreadable: ${allowed.stderr.toString().trim()}`
        );
        process.exitCode = 1;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

if (process.platform !== 'darwin') throw new Error('jail-check requires macOS sandbox_check');
const lib = dlopen('libSystem.B.dylib', {
  sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const ps = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,command='], { stdout: 'pipe' });
if (ps.exitCode !== 0) throw new Error('ps failed');
let failed = false;
for (const line of ps.stdout.toString().split('\n')) {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match) continue;
  const pid = Number(match[1]),
    command = match[2];
  const first = basename(command.split(/\s+/, 1)[0]).replace(/\.exe$/, '');
  if (
    !['claude', 'codex', 'opencode', 'superagent'].includes(first) &&
    !/\bbun\b.*\/wetamp\/src\/cli\.ts(?:\s|$)/.test(command)
  )
    continue;
  const sandboxed = lib.symbols.sandbox_check(pid, null, 0) === 1;
  console.log(`${sandboxed ? 'sandboxed' : 'NOT'}\t${String(pid)}\t${command}`);
  if (!sandboxed) failed = true;
}
lib.close();
if (failed) process.exit(1);
