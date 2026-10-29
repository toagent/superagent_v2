import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeLaunchdPath(path: string, home = process.env.HOME): string {
  const current = home ? join(home, '.nvm/current/bin') : '';
  const versions = home ? `${join(home, '.nvm/versions/node')}/` : '';
  const codexTmp = home ? join(home, '.codex/tmp') : '';
  const seen = new Set<string>();
  return path
    .split(':')
    .flatMap(part => {
      if (codexTmp && (part === codexTmp || part.startsWith(`${codexTmp}/`))) return [];
      if (part.includes('/node_modules/@openai/codex/') && part.endsWith('/codex-path')) return [];
      const version = versions && part.startsWith(versions) ? part.slice(versions.length, -4) : '';
      const normalized =
        version && !version.includes('/') && part.endsWith('/bin') && existsSync(current)
          ? current
          : part;
      return seen.has(normalized) ? [] : (seen.add(normalized), [normalized]);
    })
    .join(':');
}
