import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { home, writeAtomic } from './config';

// Qualification and recall belong exclusively to this installed owner, not wetamp feedback.
export const evolutionScript = join(homedir(), '.ai-agent-shared/skills/agent-evolution/scripts/evolution.py');
export interface LearningEntry {
  id: string; scope: string; domain: string; claim: string; applies_when: string; not_when: string;
  expires_at: string; evidence: { kind: string; source: string; sha256: string; verified_at: string; result: string }[];
}
export interface Learning {
  status: 'available' | 'unavailable' | 'disabled'; data_only: true;
  reason?: string; stable?: string; fingerprint?: string; checksum?: string; hash?: string;
  entries: LearningEntry[];
}
const publication = () => join(home().sa, 'memory', 'publication.json');
function owner(args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync(['python3', evolutionScript, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  if (result.exitCode !== 0) throw new Error('evolution rejected or unavailable');
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}
function snapshot(path: string) {
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > 8 * 1024 * 1024)
    throw new Error('publication boundary');
  const { stable, fingerprint, checksum } = JSON.parse(readFileSync(path, 'utf8')) as { stable: string; fingerprint: string; checksum: string };
  return { stable, fingerprint, checksum };
}
export function publishLearning(): Learning {
  const stage = join(homedir(), '.ai-agent-shared/evolution/snapshots', `publication-${crypto.randomUUID()}.json`);
  let pending: string | undefined;
  try {
    const before = owner(['verify']);
    const exported = owner(['export', stage]);
    const snap = snapshot(stage);
    const after = owner(['verify']);
    // The owner checks schema, revision, checksum and its current fingerprint before publication.
    owner(['snapshot-recall', '--snapshot', stage, '--scope', 'publication:check', '--domain', 'engineering', '--query', 'publication']);
    if (before.integrity !== 'ok' || after.integrity !== 'ok' ||
        before.stable !== snap.stable || after.stable !== snap.stable || exported.stable !== snap.stable ||
        before.fingerprint !== snap.fingerprint || after.fingerprint !== snap.fingerprint || exported.checksum !== snap.checksum ||
        before.audit_count !== after.audit_count)
      throw new Error('publication changed during verification');
    const dir = join(home().sa, 'memory');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('publication boundary');
    chmodSync(dir, 0o700);
    pending = join(dir, `.publication-${crypto.randomUUID()}.json`);
    writeAtomic(pending, readFileSync(stage, 'utf8'));
    chmodSync(pending, 0o600);
    renameSync(pending, publication());
    return { status: 'available', data_only: true, ...snap, entries: [] };
  } catch {
    return { status: 'unavailable', data_only: true, reason: 'verification/export/publication failed', entries: [] };
  } finally {
    rmSync(stage, { force: true });
    if (pending) rmSync(pending, { force: true });
  }
}
function recall(project: string, query: string, path: string): Learning {
  if (process.env.SUPERAGENT_MEMORY === 'off' || project.includes('_private') || project.includes('Mobile Documents'))
    return { status: 'disabled', data_only: true, entries: [] };
  try {
    const snap = snapshot(path);
    const result = owner(['snapshot-recall', '--snapshot', path, '--scope', `project:${realpathSync(project)}`,
      '--domain', 'engineering', '--query', query]);
    const entries = result.entries as LearningEntry[];
    if (snapshot(path).checksum !== snap.checksum || result.data_only !== true || result.stable !== snap.stable || !Array.isArray(entries) ||
        entries.length > 5 || Buffer.byteLength(JSON.stringify(entries)) > 12000)
      throw new Error('recall boundary');
    return { status: 'available', data_only: true, ...snap,
      hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
  } catch {
    return { status: 'unavailable', data_only: true, reason: 'publication missing or rejected (query limit 2000)', entries: [] };
  }
}
export function selectLearning(project: string, queries: Record<string, string>): Record<string, Learning> {
  let path: string | undefined;
  try {
    if (process.env.SUPERAGENT_MEMORY !== 'off' && !project.includes('_private') && !project.includes('Mobile Documents')) {
      const source = publication();
      snapshot(source);
      path = join(home().sa, 'memory', `.recall-${crypto.randomUUID()}.json`);
      writeAtomic(path, readFileSync(source, 'utf8'));
      chmodSync(path, 0o600);
    }
  } catch { /* Missing publication remains unavailable, with no legacy fallback. */ }
  try {
    return Object.fromEntries(Object.entries(queries).map(([id, query]) => [id, recall(project, query, path ?? '')]));
  } finally { if (path) rmSync(path, { force: true }); }
}
export function recallLearning(project: string, query: string): Learning {
  return selectLearning(project, { selection: query }).selection!;
}
