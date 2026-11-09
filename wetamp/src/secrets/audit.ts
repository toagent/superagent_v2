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

const occurrenceCount = (text: string, patterns: string[]): number => {
  const spans: [number, number][] = [];
  for (const pattern of patterns)
    for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1))
      spans.push([at, at + pattern.length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let count = 0,
    end = -1;
  for (const [start, nextEnd] of spans)
    if (start >= end) {
      count++;
      end = nextEnd;
    } else end = Math.max(end, nextEnd);
  return count;
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
    const count = occurrenceCount(text, patterns);
    if (count) findings.push({ path, count });
  }
  return { ok: findings.length === 0, scanned, findings };
}
