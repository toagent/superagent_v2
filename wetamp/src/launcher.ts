// Shared owner resolution lives in live.cjs; this boundary exposes only identity metadata.
import { createRequire } from 'node:module';

const CLIENTS = ['claude', 'codex', 'agy'] as const;
export const isAgentClient = (client: unknown): client is Launcher['client'] =>
  CLIENTS.some(supported => supported === client);

export interface Launcher {
  client: (typeof CLIENTS)[number];
  pid: number;
  tty: string | null;
  cwd: string;
  session_id?: string;
  host?: string;
  pid_start?: string;
}
export const { launcher, cliOf } = createRequire(import.meta.url)('../hooks/live.cjs') as {
  launcher: (home: string, env?: NodeJS.ProcessEnv) => Launcher | undefined;
  cliOf: (
    argv: string[],
    controller?: boolean
  ) => { kind: Launcher['client']; headless: boolean } | null;
};

export const { inspect: inspectProcess } = createRequire(import.meta.url)(
  '../hooks/identity.cjs'
) as {
  inspect: (
    pid: number
  ) => { state: 'online'; start: string } | { state: 'offline' | 'unknown'; start?: undefined };
};
