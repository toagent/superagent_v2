import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (!process.argv.includes('--dry-run')) throw new Error('migrate: only --dry-run is implemented');
const home = process.env.HOME ?? homedir(),
  found = new Set<string>();
// prettier-ignore
try { for (const match of readFileSync(join(home, '.zshrc'), 'utf8').matchAll(/^\s*export\s+([A-Z_][A-Z0-9_]*)=/gm)) found.add(match[1]); } catch { /* absent */ }
// prettier-ignore
try { const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> }; for (const name of Object.keys(settings.env ?? {})) found.add(name); } catch { /* absent */ }
console.log(
  JSON.stringify({ dry_run: true, names: [...found].sort(), backup: '~/.wetamp/backups/' })
);
