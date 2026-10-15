import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { home, writeAtomic } from './config';
import { archonJson, type RunView } from './archon';
import { artifactsOf, type Ledger } from './cli';
import { memoryState } from './memory';
import { callsOf } from './report';

// Qualification and recall belong exclusively to this installed owner, not wetamp feedback.
export const evolutionScript = join(
  homedir(),
  '.ai-agent-shared/skills/agent-evolution/scripts/evolution.py'
);
export interface LearningEntry {
  id: string;
  scope: string;
  domain: string;
  claim: string;
  applies_when: string;
  not_when: string;
  expires_at: string;
  evidence: { kind: string; source: string; sha256: string; verified_at: string; result: string }[];
}
export interface Learning {
  status: 'available' | 'unavailable' | 'disabled';
  data_only: true;
  reason?: string;
  stable?: string;
  fingerprint?: string;
  checksum?: string;
  hash?: string;
  entries: LearningEntry[];
}
const publication = () => join(home().sa, 'memory', 'publication.json');
function owner(args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync(['python3', evolutionScript, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10000,
  });
  if (result.exitCode !== 0) throw new Error('evolution rejected or unavailable');
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}
function snapshot(path: string) {
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > 8 * 1024 * 1024)
    throw new Error('publication boundary');
  const { stable, fingerprint, checksum } = JSON.parse(readFileSync(path, 'utf8')) as {
    stable: string;
    fingerprint: string;
    checksum: string;
  };
  return { stable, fingerprint, checksum };
}
export function publishLearning(): Learning {
  const stage = join(
    homedir(),
    '.ai-agent-shared/evolution/snapshots',
    `publication-${crypto.randomUUID()}.json`
  );
  let pending: string | undefined;
  try {
    const before = owner(['verify']);
    const exported = owner(['export', stage]);
    const snap = snapshot(stage);
    const after = owner(['verify']);
    // The owner checks schema, revision, checksum and its current fingerprint before publication.
    owner([
      'snapshot-recall',
      '--snapshot',
      stage,
      '--scope',
      'publication:check',
      '--domain',
      'engineering',
      '--query',
      'publication',
    ]);
    if (
      before.integrity !== 'ok' ||
      after.integrity !== 'ok' ||
      before.stable !== snap.stable ||
      after.stable !== snap.stable ||
      exported.stable !== snap.stable ||
      before.fingerprint !== snap.fingerprint ||
      after.fingerprint !== snap.fingerprint ||
      exported.checksum !== snap.checksum ||
      before.audit_count !== after.audit_count
    )
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
    return {
      status: 'unavailable',
      data_only: true,
      reason: 'verification/export/publication failed',
      entries: [],
    };
  } finally {
    rmSync(stage, { force: true });
    if (pending) rmSync(pending, { force: true });
  }
}
function recall(project: string, query: string, path: string): Learning {
  if (
    process.env.SUPERAGENT_MEMORY === 'off' ||
    project.includes('_private') ||
    project.includes('Mobile Documents')
  )
    return { status: 'disabled', data_only: true, entries: [] };
  try {
    const snap = snapshot(path);
    const result = owner([
      'snapshot-recall',
      '--snapshot',
      path,
      '--scope',
      `project:${realpathSync(project)}`,
      '--domain',
      'engineering',
      '--query',
      query,
    ]);
    const entries = result.entries as LearningEntry[];
    if (
      snapshot(path).checksum !== snap.checksum ||
      result.data_only !== true ||
      result.stable !== snap.stable ||
      !Array.isArray(entries) ||
      entries.length > 5 ||
      Buffer.byteLength(JSON.stringify(entries)) > 12000
    )
      throw new Error('recall boundary');
    return {
      status: 'available',
      data_only: true,
      ...snap,
      hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      entries,
    };
  } catch {
    return {
      status: 'unavailable',
      data_only: true,
      reason: 'publication missing or rejected (query limit 2000)',
      entries: [],
    };
  }
}
export function selectLearning(
  project: string,
  queries: Record<string, string>
): Record<string, Learning> {
  let path: string | undefined;
  try {
    if (
      process.env.SUPERAGENT_MEMORY !== 'off' &&
      !project.includes('_private') &&
      !project.includes('Mobile Documents')
    ) {
      const source = publication();
      snapshot(source);
      path = join(home().sa, 'memory', `.recall-${crypto.randomUUID()}.json`);
      writeAtomic(path, readFileSync(source, 'utf8'));
      chmodSync(path, 0o600);
    }
  } catch {
    /* Missing publication remains unavailable, with no legacy fallback. */
  }
  try {
    return Object.fromEntries(
      Object.entries(queries).map(([id, query]) => [id, recall(project, query, path ?? '')])
    );
  } finally {
    if (path) rmSync(path, { force: true });
  }
}
export function recallLearning(project: string, query: string): Learning {
  return selectLearning(project, { selection: query }).selection;
}

export interface LearningRequest {
  lesson: string;
  package: string;
  sha256: string;
  shareable?: boolean;
  keywords: string[];
  positive: string[];
  negative: string[];
  expires_at: string;
}
// Explicit control-plane seam: no model calls, review imports, promotion or stable writes.
export function proposeLearning(l: Ledger, request: LearningRequest): Record<string, unknown> {
  try {
    const safe = (path: string): string => {
      const absolute = resolve(path);
      if (
        ['_private', 'iCloud', 'Mobile Documents'].some(p => absolute.includes(p)) ||
        absolute
          .split(sep)
          .some(p =>
            [
              '.ssh',
              '.aws',
              '.netrc',
              '.npmrc',
              '.pypirc',
              'credentials',
              'transcript',
              'transcripts',
              'Keychains',
            ].includes(p)
          )
      )
        throw new Error('private source');
      for (let p = absolute; ; p = dirname(p)) {
        if (lstatSync(p).isSymbolicLink()) throw new Error('symlink source');
        if (p === dirname(p)) break;
      }
      return realpathSync(absolute);
    };
    if (
      process.env.SUPERAGENT_MEMORY === 'off' ||
      request.shareable !== true ||
      !/^[a-zA-Z0-9_-]+$/.test(request.package)
    )
      throw new Error('candidate boundary');
    const project = safe(l.repo),
      sa = safe(home().sa);
    const lesson = memoryState().lessons.find(e => e.id === request.lesson);
    if (
      !lesson ||
      lesson.tier !== 'project' ||
      lesson.scope !== project ||
      lesson.status !== 'trial' ||
      !lesson.evidence.includes(l.run_id)
    )
      throw new Error('candidate scope');
    const run = archonJson(
      ['workflow', 'get', l.archon_run_id, '--verbose', '--events'],
      l.repo
    ) as unknown as RunView & { events: Parameters<typeof callsOf>[1] };
    if (
      run.id !== l.archon_run_id ||
      !['completed', 'failed', 'cancelled'].includes(run.status) ||
      !run.working_path ||
      safe(run.working_path) !== project ||
      !run.output_root ||
      !Array.isArray(run.events)
    )
      throw new Error('run boundary');
    const art = safe(artifactsOf(run));
    if (![project, sa].some(root => art.startsWith(root + sep))) throw new Error('artifact escape');
    const events = run.events.filter(
      e =>
        ['node_completed', 'node_failed'].includes(e.event_type) &&
        [`code-${request.package}`, `repair-${request.package}`].includes(e.step_name ?? '')
    );
    const calls = callsOf(run.id, events, null),
      call = calls.at(0);
    if (
      events.length !== 1 ||
      events[0]?.workflow_run_id !== run.id ||
      calls.length !== 1 ||
      !call?.identity ||
      !call.provider ||
      call.provider === 'unknown' ||
      events[0]?.data?.binding?.model?.resolved?.source !== 'provider' ||
      call.model === 'unknown' ||
      !events[0]?.data?.binding?.model?.resolved?.value
    )
      throw new Error('execution identity unknown');
    const source = safe(join(art, `verify-${request.package}.json`));
    if (!lstatSync(source).isFile() || statSync(source).size > 8 * 1024 * 1024)
      throw new Error('source boundary');
    const bytes = readFileSync(source),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const evidence = JSON.parse(bytes.toString()) as { ok?: unknown; diff_hash?: unknown };
    if (
      sha256 !== request.sha256 ||
      typeof evidence.ok !== 'boolean' ||
      typeof evidence.diff_hash !== 'string'
    )
      throw new Error('source invalid or changed');
    safe(join(sa, 'memory'));
    const dir = join(sa, 'memory', 'evidence');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    safe(dir);
    const task = join(dir, crypto.randomUUID());
    mkdirSync(task, { mode: 0o700 });
    const frozen = join(task, 'original.json');
    writeFileSync(frozen, bytes, { flag: 'wx', mode: 0o400 });
    writeFileSync(
      join(task, 'provenance.json'),
      JSON.stringify({
        source,
        sha256,
        run: run.id,
        identity: call.identity,
        provider: call.provider,
        model: call.model,
        data_only: true,
      }),
      { flag: 'wx', mode: 0o400 }
    );
    const proposal = join(task, 'proposal.json');
    writeFileSync(
      proposal,
      JSON.stringify({
        lineage: `lesson-${lesson.id}`,
        reason: lesson.why,
        upsert: [
          {
            id: lesson.id,
            scope: `project:${project}`,
            domain: 'engineering',
            claim: lesson.do,
            applies_when: lesson.when,
            not_when: lesson.dont,
            keywords: request.keywords,
            expires_at: request.expires_at,
            shareable: true,
            probes: { positive: request.positive, negative: request.negative },
            evidence: [
              {
                kind: 'execution_verified',
                source: frozen,
                sha256,
                verified_at: new Date().toISOString(),
                result: 'Original engine verification artifact; semantic review still required',
              },
            ],
          },
        ],
        retire: [],
      }),
      { flag: 'wx', mode: 0o400 }
    );
    // Verify the frozen bytes, never a candidate's self-reported digest.
    if (
      createHash('sha256').update(readFileSync(frozen)).digest('hex') !== sha256 ||
      !readFileSync(source).equals(bytes)
    )
      throw new Error('source changed during freeze');
    const proposed = owner(['propose', proposal]);
    if (typeof proposed.candidate !== 'string') throw new Error('owner candidate missing');
    const evaluation = owner(['evaluate', proposed.candidate]);
    return {
      status: 'prepared',
      data_only: true,
      ...proposed,
      evaluation,
      sha256,
      evidence: task,
      model: call.model,
      identity: call.identity,
      qualification: 'requires independent reviews and promotion',
    };
  } catch {
    // Evidence preparation is optional and never changes the main run's lifecycle.
    return {
      status: 'unavailable',
      data_only: true,
      reason: 'candidate/source/identity/owner rejected or unknown',
    };
  }
}
