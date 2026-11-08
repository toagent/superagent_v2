import { spawn } from 'node:child_process';
import { resolveBashPath } from '@archon/git';
import { configureIsolation, type WorktreeSetupExecutor } from '@archon/isolation';
import { terminateTree } from '@archon/paths/plugin-process';
import { loadRepoConfig } from '../config/config-loader';

type SetupFailureKind = 'exit' | 'signal' | 'spawn' | 'timeout';

export class WorktreeSetupCommandError extends Error {
  constructor(
    readonly commandIndex: number,
    readonly kind: SetupFailureKind,
    readonly exitCode?: number,
    readonly signal?: NodeJS.Signals,
    cause?: unknown
  ) {
    const detail =
      kind === 'timeout'
        ? 'timed out'
        : kind === 'exit'
          ? `failed with exit code ${String(exitCode)}`
          : kind === 'signal'
            ? `terminated by signal ${String(signal)}`
            : 'failed to start';
    super(`worktree.postCreate command ${commandIndex + 1} ${detail}`, { cause });
    this.name = 'WorktreeSetupCommandError';
  }
}

async function executeCommand(
  command: string,
  commandIndex: number,
  cwd: string,
  timeout: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveBashPath(), ['-c', command], {
      cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    let settled = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      termination = pid === undefined ? Promise.resolve() : terminateTree(pid);
      void termination.catch(() => child.kill('SIGKILL'));
    }, timeout);

    child.once('error', error => {
      clearTimeout(timer);
      finish(new WorktreeSetupCommandError(commandIndex, 'spawn', undefined, undefined, error));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      void (async (): Promise<void> => {
        try {
          if (termination) await termination;
          else if (pid !== undefined) await terminateTree(pid);
        } catch (error) {
          finish(
            new WorktreeSetupCommandError(
              commandIndex,
              timedOut ? 'timeout' : signal ? 'signal' : 'exit',
              code ?? undefined,
              signal ?? undefined,
              error
            )
          );
          return;
        }
        if (timedOut) {
          finish(new WorktreeSetupCommandError(commandIndex, 'timeout'));
        } else if (signal) {
          finish(new WorktreeSetupCommandError(commandIndex, 'signal', undefined, signal));
        } else if (code !== 0) {
          finish(new WorktreeSetupCommandError(commandIndex, 'exit', code ?? undefined));
        } else {
          finish();
        }
      })();
    });
  });
}

export const executeStandaloneWorktreeSetup: WorktreeSetupExecutor = async input => {
  for (const [commandIndex, command] of input.commands.entries()) {
    await executeCommand(command, commandIndex, input.workingPath, input.timeout);
  }
};

export function configureWorktreeIsolation(): void {
  configureIsolation(async repoPath => {
    const config = await loadRepoConfig(repoPath);
    return config.worktree ?? null;
  }, executeStandaloneWorktreeSetup);
}
