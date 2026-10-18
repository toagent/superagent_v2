import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { runStreamingSubprocess, type StreamedSubprocessError } from './subprocess-output';

describe('runStreamingSubprocess', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => removeTempTree(root))));

  async function run(script: string, options: { timeout?: number; secrets?: string[] } = {}) {
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
    });
    return { root, stdoutPath, stderrPath, result };
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

  it('kills timed-out subprocesses and retains their partial output', async () => {
    let failure: StreamedSubprocessError;
    try {
      await run(`process.stdout.write('before-timeout', () => setTimeout(() => {}, 10_000))`, {
        timeout: 1_000,
      });
      throw new Error('expected subprocess timeout');
    } catch (error) {
      failure = error as StreamedSubprocessError;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.killed).toBe(true);
    expect(failure.code).toBeNull();
    expect(failure.stdout).toBe('before-timeout');
  });
});
