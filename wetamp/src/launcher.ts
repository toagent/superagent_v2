// Shared owner resolution lives in live.cjs; this boundary exposes only identity metadata.
import { createRequire } from 'node:module';
export interface Launcher {
  client: 'claude' | 'codex' | 'opencode';
  pid: number;
  tty: string | null;
  cwd: string;
  session_id?: string;
}
export const { launcher, cliOf } = createRequire(import.meta.url)('../hooks/live.cjs') as {
  launcher: (home: string) => Launcher | undefined;
  cliOf: (argv: string[]) => { kind: Launcher['client']; headless: boolean } | null;
};
