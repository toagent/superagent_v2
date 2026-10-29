import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempTree } from '@archon/paths/test-utils';
import * as pluginProcess from '@archon/paths/plugin-process';
import {
  recordNodeProcessTrees,
  runStreamingSubprocess,
  type StreamedSubprocessError,
} from './subprocess-output';

describe('runStreamingSubprocess', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => removeTempTree(root))));

  async function run(
    script: string,
    options: { timeout?: number; secrets?: string[]; endTreeOnTimeout?: boolean } = {}
  ) {
    const root = await mkdtemp(join(tmpdir(), 'archon-subprocess-output-'));
    roots.push(root);
    const stdoutPath = join(root, 'stdout');
    const stderrPath = join(root, 'stderr');
    const result = await runStreamingSubprocess({
      cmd: process.execPath,
      args: ['-e', script],
      cwd: root,
      env: process.env,
      timeout: options.timeout ?? 5_000,
      credentialValues: options.secrets ?? [],
      stdoutPath,
      stderrPath,
      endTreeOnTimeout: options.endTreeOnTimeout,
    });
    return { root, stdoutPath, stderrPath, result };
  }

  async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  function processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  it('streams output larger than 2 MiB while retaining a bounded preview', async () => {
    const { stdoutPath, result } = await run(`process.stdout.write('x'.repeat(2_100_000))`);
    expect(result.stdout.bytes).toBe(2_100_000);
    expect(Buffer.byteLength(result.stdout.preview)).toBeLessThanOrEqual(32 * 1024);
    expect((await readFile(stdoutPath)).length).toBe(2_100_000);
  });

  it('preserves binary output in the artifact', async () => {
    const { stdoutPath, result } = await run(
      `process.stdout.write(Buffer.from([0,255,1,254,2,253]))`
    );
    expect(await readFile(stdoutPath)).toEqual(Buffer.from([0, 255, 1, 254, 2, 253]));
    expect(result.stdout.bytes).toBe(6);
  });

  it('redacts a credential split across chunks before writing it', async () => {
    const secret = 'cross-chunk-secret';
    const { stdoutPath, result } = await run(
      `process.stdout.write('cross-chunk-'); setTimeout(() => process.stdout.write('secret'), 10)`,
      { secrets: [secret] }
    );
    expect(await readFile(stdoutPath, 'utf8')).toBe('[REDACTED]');
    expect(result.stdout.preview).toBe('[REDACTED]');
  });

  it('keeps detached-owner jobs cancellable while recording foreground nodes', async () => {
    if (process.platform !== 'win32') {
      const ownerRoot = await mkdtemp(join(tmpdir(), 'archon-detached-owner-'));
      roots.push(ownerRoot);
      const moduleUrl = pathToFileURL(join(import.meta.dir, 'subprocess-output.ts')).href;
      const job =
        "const { spawn } = require('node:child_process'); " +
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); " +
        "require('fs').writeFileSync('job-pid', String(child.pid)); child.unref();";
      const ownerScript =
        `import { runStreamingSubprocess } from ${JSON.stringify(moduleUrl)}; ` +
        `await runStreamingSubprocess({cmd:process.execPath,args:['-e',${JSON.stringify(job)}],cwd:process.cwd(),env:process.env,timeout:5000,credentialValues:[],stdoutPath:'owner-out',stderrPath:'owner-err'}); ` +
        `require('fs').writeFileSync('node-complete', ''); await Bun.sleep(30_000);`;
      const owner = childProcess.spawn(process.execPath, ['-e', ownerScript], {
        cwd: ownerRoot,
        detached: true,
        stdio: 'ignore',
      });
      let jobPid: number | undefined;
      try {
        await waitUntil('unrecorded node completion', async () =>
          stat(join(ownerRoot, 'node-complete')).then(
            () => true,
            () => false
          )
        );
        jobPid = Number(await readFile(join(ownerRoot, 'job-pid'), 'utf8'));
        expect(processExists(jobPid)).toBe(true);
        process.kill(-owner.pid!, 'SIGTERM');
        await waitUntil('detached owner job cancellation', async () => !processExists(jobPid!));
      } finally {
        if (owner.exitCode === null) {
          try {
            process.kill(-owner.pid!, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    }

    const trees = recordNodeProcessTrees();
    try {
      const results: Awaited<ReturnType<typeof run>>[] = [];
      for (let index = 0; index < 200; index += 8) {
        results.push(
          ...(await Promise.all(Array.from({ length: 8 }, () => run(`process.stdout.write('ok')`))))
        );
      }
      expect(results.every(({ result }) => result.stdout.raw === undefined)).toBe(true);
      expect(results.map(({ result }) => result.stdout.preview)).toEqual(
        Array.from({ length: 200 }, () => 'ok')
      );
    } finally {
      trees.release();
    }
  });

  it('ends a timed-out subprocess tree before a grandchild can write', async () => {
    const grandchild =
      "require('fs').writeFileSync('started', ''); " +
      "setTimeout(() => require('fs').writeFileSync('leaked', ''), 1_000)";
    let failure: StreamedSubprocessError;
    const startedAt = Date.now();
    const trees = recordNodeProcessTrees();
    try {
      try {
        await run(
          `const { spawn } = require('node:child_process'); ` +
            `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); ` +
            `process.stdout.write('before-timeout'); setTimeout(() => {}, 10_000)`,
          { timeout: 200 }
        );
        throw new Error('expected subprocess timeout');
      } catch (error) {
        failure = error as StreamedSubprocessError;
      }
    } finally {
      trees.release();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.killed).toBe(true);
    expect(failure.code).toBeNull();
    expect(failure.stdout).toBe('before-timeout');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await stat(join(roots.at(-1)!, 'started'));
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await expect(stat(join(roots.at(-1)!, 'leaked'))).rejects.toMatchObject({ code: 'ENOENT' });

    if (process.platform !== 'win32') {
      const rootOnlyTrees = recordNodeProcessTrees();
      const rootOnly = await run(
        `const { spawn } = require('node:child_process'); ` +
          `spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('fs').writeFileSync('root-only-leaked', ''), 300)")}], ` +
          `{ stdio: 'ignore' }); setTimeout(() => {}, 10_000)`,
        { timeout: 50, endTreeOnTimeout: false }
      )
        .then(
          () => undefined,
          error => error as StreamedSubprocessError
        )
        .finally(() => rootOnlyTrees.release());
      expect(rootOnly?.killed).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 400));
      await stat(join(roots.at(-1)!, 'root-only-leaked'));

      const ownerRoot = await mkdtemp(join(tmpdir(), 'archon-subprocess-owner-'));
      roots.push(ownerRoot);
      const moduleUrl = pathToFileURL(join(import.meta.dir, 'subprocess-output.ts')).href;
      const ownerScript =
        `import { recordNodeProcessTrees, runStreamingSubprocess } from ${JSON.stringify(moduleUrl)}; ` +
        `recordNodeProcessTrees(); ` +
        `void runStreamingSubprocess({cmd:process.execPath,args:['-e',${JSON.stringify("require('fs').writeFileSync('owner-ready', ''); setTimeout(() => require('fs').writeFileSync('owner-leaked', ''), 800)")}],cwd:process.cwd(),env:process.env,timeout:10000,credentialValues:[],stdoutPath:'owner-out',stderrPath:'owner-err'}); ` +
        `await Bun.sleep(30_000);`;
      const owner = Bun.spawn([process.execPath, '-e', ownerScript], {
        cwd: ownerRoot,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      await waitUntil('recorded node startup', async () =>
        stat(join(ownerRoot, 'owner-ready')).then(
          () => true,
          () => false
        )
      );
      process.kill(owner.pid, 'SIGKILL');
      await owner.exited;
      await new Promise(resolve => setTimeout(resolve, 900));
      await expect(stat(join(ownerRoot, 'owner-leaked'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('reports tree termination failure instead of an ordinary timeout', async () => {
    const terminate = spyOn(pluginProcess, 'terminateTree').mockRejectedValue(
      new Error('group refused the signal')
    );
    const trees = recordNodeProcessTrees();
    try {
      const failure = await run(`setTimeout(() => {}, 10_000)`, { timeout: 50 }).then(
        () => undefined,
        error => error as StreamedSubprocessError
      );
      expect(failure?.treeSurvived).toBe(true);
      expect(failure?.message).toContain(
        'could not terminate subprocess tree: group refused the signal'
      );
    } finally {
      trees.release();
      terminate.mockRestore();
    }

    if (process.platform !== 'win32') {
      const realSpawn = childProcess.spawn;
      let spawnCalls = 0;
      const spawnWatcher = spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: readonly string[],
        options: SpawnOptions
      ): ChildProcess => {
        spawnCalls++;
        return spawnCalls === 2
          ? realSpawn('/archon-missing-node-lifeline', [], options)
          : realSpawn(command, [...args], options);
      }) as typeof childProcess.spawn);
      const watchedTrees = recordNodeProcessTrees();
      try {
        const failure = await run(`setTimeout(() => {}, 10_000)`).then(
          () => undefined,
          error => error as StreamedSubprocessError
        );
        expect(failure?.message).toContain('Could not start node owner-death watcher');
      } finally {
        watchedTrees.release();
        spawnWatcher.mockRestore();
      }
    }
  });
});
