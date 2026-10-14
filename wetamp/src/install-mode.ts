import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WETAMP } from './config';
export type InstallMode = 'controller' | 'worker';
export function installMode(): InstallMode {
  const configured = process.env.XDG_STATE_HOME;
  const file = join(
    configured === undefined || configured === '' ? join(homedir(), '.local/state') : configured,
    'superagent/install.json'
  );
  let ledger: unknown;
  try {
    ledger = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'controller';
    throw new Error('preflight: install mode unknown; repair install.json', { cause: e });
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger))
    throw new Error('preflight: install mode unknown; repair install.json');
  const record = ledger as Record<string, unknown>;
  if (record.wetamp !== WETAMP) return 'controller';
  if (record.role === 'worker' || record.role === 'controller') return record.role;
  throw new Error('preflight: install mode unknown; rerun install.sh');
}
