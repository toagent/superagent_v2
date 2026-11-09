import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exactPatterns, managedSecrets, type ManagedSecret } from './scan';

export interface TranscriptFinding {
  path: string;
  count: number;
}

export interface TranscriptAudit {
  ok: boolean;
  scanned: number;
  findings: TranscriptFinding[];
}

interface AuditOptions {
  home?: string;
  days?: number;
  now?: number;
  secrets?: ManagedSecret[];
  env?: NodeJS.ProcessEnv;
}

const files = (root: string, cutoff: number, accept: (path: string) => boolean): string[] => {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && accept(path)) {
        try {
          if (statSync(path).mtimeMs >= cutoff) found.push(path);
        } catch {
          // A transcript may disappear while health is scanning it.
        }
      }
    }
  };
  visit(root);
  return found;
};

export function auditTranscripts(options: AuditOptions = {}): TranscriptAudit {
  const env = options.env ?? process.env,
    home = options.home ?? env.HOME ?? homedir(),
    days = options.days ?? 7,
    cutoff = (options.now ?? Date.now()) - days * 86_400_000,
    patterns = exactPatterns(options.secrets ?? managedSecrets({ ...env, HOME: home })).map(
      secret => secret.value
    ),
    xdg = env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
    targets = [
      ...files(join(home, '.claude', 'projects'), cutoff, path => path.endsWith('.jsonl')),
      ...files(join(home, '.codex', 'sessions'), cutoff, () => true),
      ...files(join(xdg, 'opencode', 'storage'), cutoff, () => true),
    ],
    findings: TranscriptFinding[] = [];
  let scanned = 0;
  for (const path of targets) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    let count = 0;
    for (const pattern of patterns)
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + pattern.length))
        count++;
    if (count) findings.push({ path, count });
  }
  return { ok: findings.length === 0, scanned, findings };
}
