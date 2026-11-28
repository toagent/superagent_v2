import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { exactPatterns, managedSecrets, scanStat, type ManagedSecret } from './scan';

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

const AGY_MAX_BYTES = 64 * 1024 * 1024;
const agyDb = (path: string): boolean => /\.db(?:-wal)?$/.test(path);
const files = (home: string, root: string, accept: (path: string) => boolean): string[] => {
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
      else if (entry.isFile() && accept(path)) found.push(path);
    }
  };
  if (scanStat(home, root)?.isDirectory()) visit(root);
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
    home = resolve(options.home ?? env.HOME ?? homedir()),
    days = options.days ?? 7,
    cutoff = (options.now ?? Date.now()) - days * 86_400_000,
    patterns = exactPatterns(options.secrets ?? managedSecrets({ ...env, HOME: home })).map(
      secret => secret.value
    ),
    targets = [
      ...files(home, join(home, '.claude/projects'), path => path.endsWith('.jsonl')),
      ...files(home, join(home, '.codex/sessions'), () => true),
    ],
    agy = [
      ...files(home, join(home, '.gemini/antigravity-cli/conversations'), agyDb),
      ...files(
        home,
        join(
          home,
          'Library/Application Support/orca/antigravity-chat/antigravity-acp/conversations'
        ),
        agyDb
      ),
      join(home, '.gemini/GEMINI.md'),
    ],
    findings: TranscriptFinding[] = [];
  let scanned = 0;
  for (const [index, path] of [...targets, ...agy].entries()) {
    const limit = index < targets.length ? Infinity : AGY_MAX_BYTES;
    if (!scanStat(home, path)?.isFile()) continue;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mtimeMs < cutoff || stat.size > limit) continue;
      const count = occurrenceCount(readFileSync(fd, 'utf8'), patterns);
      scanned++;
      if (count)
        findings.push({
          path: patterns.reduce((label, pattern) => label.replaceAll(pattern, '[REDACTED]'), path),
          count,
        });
    } catch {
      continue;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { ok: findings.length === 0, scanned, findings };
}
