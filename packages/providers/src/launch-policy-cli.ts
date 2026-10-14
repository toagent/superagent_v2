/** Native Claude CLI output adapter: scope verification precedes forwarding any model output. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:os';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { withPluginScopeCheck } from './claude/plugins';

export async function runScopedClaude(
  command: string[],
  format: 'text' | 'json' | 'stream-json',
  input?: Uint8Array
): Promise<number> {
  const child = spawn(command[0], command.slice(1), {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve(signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1))
    );
  });
  const off = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
    const forward = (): void => {
      child.kill(signal);
    };
    process.on(signal, forward);
    return () => process.off(signal, forward);
  });
  const events = async function* (): AsyncGenerator<SDKMessage> {
    for await (const line of createInterface({ input: child.stdout! })) {
      if (!line.trim()) continue;
      // CLI and SDK share this native wire channel; the scope guard validates init's plugin rows.
      const event = JSON.parse(line) as SDKMessage;
      if (!event || typeof event.type !== 'string')
        throw new Error('execution: invalid Claude CLI event');
      yield event;
    }
  };
  let resultSeen = false;
  try {
    if (input !== undefined) {
      // A registered job supplies finite bytes, never an inherited terminal stream.
      await new Promise<void>((resolve, reject) => {
        child.stdin!.once('error', reject);
        child.stdin!.end(input, resolve);
      });
    }
    for await (const event of withPluginScopeCheck(events(), [])) {
      if (format === 'stream-json') process.stdout.write(JSON.stringify(event) + '\n');
      if (event.type === 'result') {
        resultSeen = true;
        if (format === 'json') process.stdout.write(JSON.stringify(event) + '\n');
        if (format === 'text' && 'result' in event) process.stdout.write(event.result + '\n');
      }
    }
    const code = await exited;
    if (!code && !resultSeen) throw new Error('execution: Claude CLI ended without a result');
    return code;
  } catch (error) {
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
    process.exitCode = await runScopedClaude(JSON.parse(command) as string[], format, input);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'execution: Claude CLI failed');
    process.exitCode = 1;
  }
}
