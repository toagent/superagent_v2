import { homedir } from 'node:os';
import { QUERY_TIMEOUT_MS } from './archon';

export const supervisorPy = (): string =>
  process.env.SA_SUPERVISOR ??
  `${homedir()}/.ai-agent-shared/skills/agent-supervisor/scripts/supervisor.py`;

export function supervisor(args: string[]): string {
  const p = Bun.spawnSync(['python3', supervisorPy(), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
    env: { ...process.env },
  });
  if (p.exitCode !== 0)
    throw new Error(
      `supervisor ${args[0]} exit ${String(p.exitCode)}: ${p.stderr.toString().slice(-200)}`
    );
  return p.stdout.toString().trim();
}
