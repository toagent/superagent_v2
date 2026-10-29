import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { redactCredentialValues } from '@archon/paths/credential-redaction';
import * as pluginProcess from '@archon/paths/plugin-process';
import { buildTruncationMarker } from './utils/output-truncation';
const PREVIEW_BYTES = 32 * 1024;
const TAIL_BYTES = 8 * 1024;
const REDACTION = Buffer.from('[REDACTED]');
const OWNER_LIFELINE = 'IFS= read -r line || kill -s KILL -- "-$1"';
export interface StreamedOutput {
  preview: string;
  tail: string;
  bytes: number;
  raw?: string;
}
export type StreamedSubprocessError = Error & {
  stdout?: string;
  stderr?: string;
  stdoutTail?: string;
  stderrTail?: string;
  cmd?: string;
  spawnargs?: string[];
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  treeSurvived?: true;
};
class ByteRedactor {
  private pending = Buffer.alloc(0);
  private readonly secrets: Buffer[];
  private readonly holdBytes: number;
  constructor(values: readonly string[]) {
    this.secrets = values
      .map(value => Buffer.from(value))
      .filter(value => value.length > 0)
      .sort((a, b) => b.length - a.length);
    this.holdBytes = Math.max(0, ...this.secrets.map(value => value.length - 1));
  }
  push(chunk: Buffer, final = false): Buffer {
    const input = Buffer.concat([this.pending, chunk]);
    const safeEnd = final ? input.length : Math.max(0, input.length - this.holdBytes);
    const output: Buffer[] = [];
    let rawStart = 0;
    let cursor = 0;
    while (cursor < safeEnd) {
      const match = this.secrets.find(secret =>
        input.subarray(cursor, cursor + secret.length).equals(secret)
      );
      if (!match) {
        cursor++;
        continue;
      }
      if (rawStart < cursor) output.push(input.subarray(rawStart, cursor));
      output.push(REDACTION);
      cursor += match.length;
      rawStart = cursor;
    }
    if (rawStart < cursor) output.push(input.subarray(rawStart, cursor));
    this.pending = input.subarray(cursor);
    if (final && this.pending.length > 0) {
      output.push(this.pending);
      this.pending = Buffer.alloc(0);
    }
    return Buffer.concat(output);
  }
}
async function capture(
  stream: Readable,
  path: string,
  secrets: readonly string[],
  retainRaw = false
): Promise<StreamedOutput> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'w');
  const redactor = new ByteRedactor(secrets);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0),
    bytes = 0;
  const raw: Buffer[] | undefined = retainRaw ? [] : undefined;
  const write = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    await file.write(chunk);
    bytes += chunk.length;
    if (head.length < PREVIEW_BYTES) {
      head = Buffer.concat([head, chunk.subarray(0, PREVIEW_BYTES - head.length)]);
    }
    tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
  };
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      raw?.push(chunk);
      await write(redactor.push(chunk));
    }
    await write(redactor.push(Buffer.alloc(0), true));
  } finally {
    await file.close();
  }
  const rawOutput = raw ? { raw: Buffer.concat(raw).toString('utf8') } : {},
    truncated = bytes > PREVIEW_BYTES;
  if (!truncated) {
    const text = head.toString('utf8');
    return { preview: text, tail: text, bytes, ...rawOutput };
  }
  const marker = buildTruncationMarker(bytes);
  let prefix = head.subarray(0, PREVIEW_BYTES - Buffer.byteLength(marker));
  while (prefix.length > 0 && ((prefix.at(-1) ?? 0) & 0xc0) === 0x80)
    prefix = prefix.subarray(0, -1);
  return {
    preview: prefix.toString('utf8') + marker,
    tail: tail.toString('utf8'),
    bytes,
    ...rawOutput,
  };
}
export async function runStreamingSubprocess(options: {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  credentialValues: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  retainRawStdout?: boolean;
  endTreeOnTimeout?: boolean;
}): Promise<{ stdout: StreamedOutput; stderr: StreamedOutput }> {
  const endTreeOnTimeout = options.endTreeOnTimeout !== false;
  const child = spawn(options.cmd, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: endTreeOnTimeout && process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lifelineError: StreamedSubprocessError | undefined;
  // A detached node group would otherwise escape Ctrl-C, detached-run cancellation, or
  // an owner crash. This watcher lives outside both groups and kills the node on pipe EOF.
  const lifeline =
    endTreeOnTimeout && process.platform !== 'win32' && child.pid !== undefined
      ? spawn('/bin/sh', ['-c', OWNER_LIFELINE, 'archon-node-lifeline', String(child.pid)], {
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      : undefined;
  lifeline?.once('error', error => {
    lifelineError = new Error(`Could not start node owner-death watcher: ${error.message}`);
    child.kill('SIGKILL');
  });
  const disarmLifeline = (): void => {
    lifeline?.stdin?.end('\n');
    lifeline?.unref();
  };
  let spawnError: StreamedSubprocessError | undefined;
  let timedOut = false;
  let exited = false;
  let termination: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const streams = Promise.all([
    capture(child.stdout, options.stdoutPath, options.credentialValues, options.retainRawStdout),
    capture(child.stderr, options.stderrPath, options.credentialValues),
  ]).catch(error => {
    if (spawnError || terminationError)
      return [
        { preview: '', tail: '', bytes: 0 },
        { preview: '', tail: '', bytes: 0 },
      ];
    throw error;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid === undefined || exited) return;
    if (!endTreeOnTimeout) {
      child.kill('SIGTERM');
      return;
    }
    termination = pluginProcess.terminateTree(child.pid, 'SIGTERM').catch((error: unknown) => {
      terminationError = error instanceof Error ? error : new Error(String(error));
      if (!exited) child.kill('SIGKILL');
      // Tree termination failed, so a surviving descendant may keep either pipe open.
      child.stdout.destroy();
      child.stderr.destroy();
    });
  }, options.timeout);
  timer.unref();
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolve => {
      child.once('error', error => {
        spawnError = error as StreamedSubprocessError;
      });
      child.once('close', (code, signal) => {
        exited = true;
        disarmLifeline();
        resolve({ code, signal });
      });
    }
  );
  let outcome: Awaited<typeof completion>;
  try {
    outcome = await Promise.race([
      completion,
      streams.then(() => new Promise<never>(() => undefined)),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  await termination;
  const [stdout, stderr] = await streams;
  if (!spawnError && !lifelineError && outcome.code === 0 && !timedOut) return { stdout, stderr };
  const command = redactCredentialValues(
    [options.cmd, ...options.args].join(' '),
    options.credentialValues
  );
  const error =
    spawnError ??
    lifelineError ??
    new Error(
      terminationError
        ? `Command timed out after ${String(options.timeout)} ms; could not terminate subprocess tree: ${terminationError.message}`
        : `Command failed: ${command}`
    );
  error.message = redactCredentialValues(error.message, options.credentialValues);
  if (error.stack) error.stack = redactCredentialValues(error.stack, options.credentialValues);
  Object.assign(error, {
    stdout: stdout.preview,
    stderr: stderr.preview,
    stdoutTail: stdout.tail,
    stderrTail: stderr.tail,
    cmd: command,
    spawnargs: options.args.map(arg => redactCredentialValues(arg, options.credentialValues)),
    code: timedOut ? null : (spawnError?.code ?? outcome.code),
    killed: timedOut,
    signal: timedOut && process.platform === 'win32' ? 'SIGTERM' : outcome.signal,
    ...(terminationError ? { treeSurvived: true as const } : {}),
  });
  throw error;
}
