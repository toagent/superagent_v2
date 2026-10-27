/** Native Claude CLI output adapter: preserves native capabilities while forwarding model output. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:os';
import { writeFile } from 'node:fs/promises';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { classifyClaudeResultMessage } from './claude/provider';
import { foldClaudeOutcome, withClaudeRetries, type ClaudeOutcome } from './claude/outcome';

export async function runScopedClaude(
  command: string[],
  format: 'text' | 'json' | 'stream-json',
  input?: Uint8Array,
  outcomePath?: string
): Promise<number> {
  const child = spawn(command[0], command.slice(1), {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve(signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1));
    });
  });
  const off = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
    const forward = (): void => {
      child.kill(signal);
    };
    process.on(signal, forward);
    return (): void => {
      process.off(signal, forward);
    };
  });
  const events = async function* (): AsyncGenerator<SDKMessage> {
    const stdout = child.stdout;
    if (!stdout) throw new Error('execution: Claude CLI stdout pipe is missing');
    for await (const line of createInterface({ input: stdout })) {
      if (!line.trim()) continue;
      // CLI and SDK share this native wire channel.
      const event = JSON.parse(line) as SDKMessage;
      if (!event || typeof event.type !== 'string')
        throw new Error('execution: invalid Claude CLI event');
      yield event;
    }
  };
  let resultSeen = false;
  let retries = 0;
  let outcome: ClaudeOutcome = { ok: true };
  try {
    if (input !== undefined) {
      const stdin = child.stdin;
      if (!stdin) throw new Error('execution: Claude CLI stdin pipe is missing');
      // A registered job supplies finite bytes, never an inherited terminal stream.
      await new Promise<void>((resolve, reject) => {
        stdin.once('error', reject);
        stdin.end(input, resolve);
      });
    }
    for await (const event of events()) {
      retries = foldClaudeOutcome([event], undefined, retries).retries;
      if (format === 'stream-json') process.stdout.write(JSON.stringify(event) + '\n');
      if (event.type === 'result') {
        resultSeen = true;
        const failure = classifyClaudeResultMessage(event);
        outcome = failure ? { failure: withClaudeRetries(failure, retries) } : { ok: true };
        if (format === 'json') process.stdout.write(JSON.stringify(event) + '\n');
        if (format === 'text' && 'result' in event) process.stdout.write(event.result + '\n');
      }
    }
    const code = await exited;
    if (!code && !resultSeen) throw new Error('execution: Claude CLI ended without a result');
    if (outcomePath) await writeFile(outcomePath, JSON.stringify(outcome) + '\n');
    return code;
  } catch (error) {
    if (outcomePath) {
      const evidence = error instanceof Error ? error.message : 'Claude CLI failed';
      await writeFile(
        outcomePath,
        JSON.stringify({ failure: withClaudeRetries({ class: 'unknown', evidence }, retries) }) +
          '\n'
      );
    }
    child.kill('SIGTERM');
    await exited.catch(() => undefined);
    throw error;
  } finally {
    for (const remove of off) remove();
  }
}

if (import.meta.main) {
  try {
    const [format, command, inputFlag, ...extra] = process.argv.slice(2);
    if (format !== 'text' && format !== 'json' && format !== 'stream-json')
      throw new Error('execution: unsupported Claude output format');
    if (extra.length || (inputFlag !== undefined && inputFlag !== '--job-input'))
      throw new Error('execution: unsupported Claude input option');
    if (inputFlag && process.stdin.isTTY)
      throw new Error('execution: registered job input must not be a terminal');
    const input = inputFlag ? new Uint8Array(await Bun.stdin.arrayBuffer()) : undefined;
    process.exitCode = await runScopedClaude(
      JSON.parse(command) as string[],
      format,
      input,
      process.env.ARCHON_PROVIDER_OUTCOME
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'execution: Claude CLI failed');
    process.exitCode = 1;
  }
}
