import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spyOn, afterAll } from 'bun:test';
import * as coordination from '../src/coord';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { testTimeout } from '@archon/paths/test-utils';
import {
  diagnosis,
  deliverEngineDefects,
  episodes,
  foldEpisode,
  injectMemory,
  lessonText,
  lintPlan,
  maintainLessons,
  memoryData,
  memoryState,
  memoryTick,
  memoryWrite,
  priorKey,
  privateProject,
  saveEpisode,
  selectLessons,
  selectCandidates,
  reflectionQueue,
  taskTag,
  triage,
  triggered,
  type Episode,
  type Lesson,
} from '../src/memory';
import { curate, reconcileReflection, reflectOne, reflectionInput } from '../src/memory-reflect';
import { artifactsOf, main, type Ledger } from '../src/cli';
import { type RunView } from '../src/archon';
import { engineHash, generate } from '../src/generate';
import { install, loadTiers, snapshotPolicy } from '../src/config';
import { type Plan } from '../src/plan';
import { inspectBase } from '../src/preflight';
import { cockpitSignals, type Asks } from '../src/cockpit-signals';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import { checkoutFingerprint } from '../templates/.archon/scripts/checkout-integrity';
const fixtureEngine = gitRepo(tmp());
const originalCleanEngine = coordination.cleanEngine;
const engineBoundary = spyOn(coordination, 'cleanEngine').mockImplementation(() =>
  originalCleanEngine(fixtureEngine)
);

import e1 from './incidents/e1-settle.json';
import e2 from './incidents/e2-asks.json';
import replay from './incidents/ev1-memory.json';
import realData from './incidents/ev1b-real-data.json';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const zeros = { engine_suspect: 0, dup_ask: 0, orphan_hold: 0, stale_answer: 0 };
// Current verify artifacts carry an engine decision; the replay preserves the legacy shape.
const portEvidence = {
  ...replay['project-port'],
  decision: { kind: 'repair', reason: 'acceptance_failed', evidence: [], debt: [] },
};
let root: string, sa: string, plan: Plan, ledger: Ledger, raw: RunView;
const saved = new Map<string, string | undefined>();
const keys = [
  'HOME',
  'SUPERAGENT_ROLE',
  'SA_JOB_ID',
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SUPERAGENT_MEMORY',
  'SA_ARCHON_BIN',
  'SUPERAGENT_WRITE_ROOTS',
  'FAKE_EV1_RUN',
];
beforeEach(() => {
  for (const k of keys) saved.set(k, process.env[k]);
  root = tmp();
  sa = join(root, 'home');
  mkdirSync(sa);
  process.env.SUPERAGENT_HOME = sa;
  process.env.ARCHON_HOME = join(sa, 'archon');
  process.env.SUPERAGENT_MEMORY = 'on';
  plan = JSON.parse(
    readFileSync(
      fixturePlan(root, root, p => {
        p.packages = (p.packages as unknown[]).slice(0, 1);
      }),
      'utf8'
    )
  ) as Plan;
  plan.packages[0].scope.write = ['src/cli.ts'];
  plan.packages[0].accept = [{ cmd: 'bun test --port 39890', timeout_s: 30 }];
  ledger = {
    run_id: 'incident',
    archon_run_id: '00000000-0000-4000-8000-000000000001',
    repo: root,
    gen_dir: join(sa, 'gen', 'incident'),
    plan: join(root, 'plan.json'),
    branch: 'sa/incident',
    workflow: 'sa-incident',
    console: 'codex',
    started_at: new Date(NOW - 60000).toISOString(),
    transcript: '/forbidden-transcript',
    log: '',
    recoveries: [],
    engine_hash: 'fingerprint',
  };
  mkdirSync(ledger.gen_dir, { recursive: true });
  writeFileSync(join(ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(ledger.gen_dir, 'policy.json'), JSON.stringify(snapshotPolicy(loadTiers())));
  raw = {
    id: ledger.archon_run_id,
    status: 'failed',
    started_at: ledger.started_at,
    completed_at: new Date(NOW).toISOString(),
    output_root: sa,
    nodes: [{ nodeId: 'verify-core', state: 'failed' }],
  };
  mkdirSync(artifactsOf(raw), { recursive: true });
  writeFileSync(join(artifactsOf(raw), 'verify-core.json'), JSON.stringify(portEvidence));
});
afterEach(() => {
  for (const k of keys) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const episode = (patch: Partial<Episode> = {}): Episode => ({
  ...foldEpisode(ledger, plan, raw, [], {}, NOW),
  ...patch,
});
const lesson = (id: string, patch: Partial<Lesson> = {}): Lesson => ({
  id,
  tier: 'project',
  scope: root,
  tag: 'ts-cli',
  category: 'project',
  reasons: ['acceptance_failed'],
  when: 'port',
  do: 'free',
  dont: 'busy',
  why: 'test',
  evidence: ['incident'],
  mechanizable: false,
  status: 'trial',
  helpful: 0,
  harmful: 0,
  created_at: new Date(NOW).toISOString(),
  last_hit: new Date(NOW).toISOString(),
  ...patch,
});
const seed = (...lessons: Lesson[]): void => memoryWrite(() => ({ lessons }));
// Real Archon validation is covered by generate.test.ts and selftest; these tests inspect memory injection.
const fakeValidation = (): void => {
  const bin = join(root, 'validate-archon');
  writeFileSync(
    bin,
    '#!/usr/bin/env bash\n[ "$1" = validate ] && [ "$2" = workflows ] && exit 0\necho "unexpected archon command" >&2\nexit 1\n'
  );
  chmodSync(bin, 0o755);
  process.env.SA_ARCHON_BIN = bin;
};
const reflectionHarness = (e: Episode, output: unknown = { operations: [], reason: 'none' }) => {
  let status = 'running',
    launched = 0,
    failLaunch = false;
  const query = (args: string[]): Record<string, unknown> => {
    if (args[1] === 'runs')
      return {
        runs: launched
          ? [
              {
                id: 'reflect-run',
                status,
                workflow_name: 'memory-reflect',
                user_message: `memory-reflect:${e.id}\ninput`,
              },
            ]
          : [],
      };
    if (args[1] === 'run') {
      if (failLaunch) throw new Error('launch failed');
      launched++;
      return { id: 'reflect-run' };
    }
    return {
      events: [
        {
          event_type: 'node_completed',
          step_name: 'reflect',
          data: { structured_output: output, tokens: { input: 8, output: 2 } },
        },
      ],
    };
  };
  return {
    query,
    terminal: (next: string) => (status = next),
    rejectLaunch: (next: boolean) => (failLaunch = next),
    launches: () => launched,
  };
};

describe('EV1 incident replay', () => {
  test('runtime prose stays unclassified while structured unknown reasons remain defects', () => {
    writeFileSync(join(artifactsOf(raw), 'verify-core.json'), '{}');
    raw.metadata = { error: 'ordinary runtime failure' };
    expect(episode()).toMatchObject({
      reasons: ['unclassified'],
      category: 'transient',
      signature: 'unclassified',
    });
    writeFileSync(
      join(artifactsOf(raw), 'verify-core.json'),
      JSON.stringify({ ok: false, reason: 'unknown_protocol_reason' })
    );
    expect(episode()).toMatchObject({
      reasons: ['unregistered_reason', 'unclassified'],
      category: 'engine',
      signature: 'unregistered_reason',
    });
  });
  test('EV2 confined memory reads preserve repository-owned artifact evidence outside the memory home', () => {
    raw.output_root = join(root, 'project-output');
    mkdirSync(artifactsOf(raw), { recursive: true });
    writeFileSync(join(artifactsOf(raw), 'verify-core.json'), JSON.stringify(portEvidence));
    writeFileSync(
      join(artifactsOf(raw), 'verify-core.coder.json'),
      JSON.stringify({ error_class: 'task', prompt: 'FORBIDDEN', transcript: 'FORBIDDEN' })
    );
    const folded = episode();
    expect(folded).toMatchObject({
      reasons: ['acceptance_failed'],
      category: 'project',
      signature: 'acceptance_failed',
    });
    expect(JSON.stringify(folded)).not.toContain('FORBIDDEN');
    raw.output_root = tmp();
    mkdirSync(artifactsOf(raw), { recursive: true });
    writeFileSync(join(artifactsOf(raw), 'verify-core.json'), '{}');
    expect(() => episode()).toThrow('路径越界');
  });
  test('E1 actual settle evidence wins over task self-report, mechanizes without reflection', async () => {
    for (const [i, sample] of e1.entries()) {
      raw.nodes = [{ nodeId: sample.node, state: 'failed' }];
      writeFileSync(join(artifactsOf(raw), `${sample.node}.json`), JSON.stringify(sample.settle));
      writeFileSync(
        join(artifactsOf(raw), `${sample.node}.coder.json`),
        JSON.stringify({
          ...sample.coder,
          prompt: 'SECRET-PROMPT',
          transcript: 'SECRET-TRANSCRIPT',
        })
      );
      const e = episode({ id: `e1-${i}` });
      expect(e.category).toBe('engine');
      expect(saveEpisode(e)).toBe(true);
      expect(saveEpisode(e)).toBe(false);
      expect(existsSync(join(sa, 'memory/mechanize', `${e.signature}.json`))).toBe(true);
    }
    expect(await reflectOne(NOW)).toBe(false);
  });
  test('E2 real duplicate-ask shape and deterministic retries classify engine', () => {
    const asks: Asks = Object.fromEntries(
      e2.attempts.map(n => [
        `incident:auto_retry_exhausted:${n}`,
        { status: 'pending', hold: e2.hold, sent_at: new Date(NOW).toISOString() },
      ])
    );
    const signals = cockpitSignals([], asks, NOW);
    ledger.auto_retries = [1, 2].map(i => ({
      at: new Date(NOW + i).toISOString(),
      milestone: 'm1',
      reason: 'coder:task',
      deterministic: true,
      engine_hash: ledger.engine_hash,
    }));
    expect(episode().category).toBe('engine');
    expect(signals.dup_ask).toBeGreaterThan(0);
    expect(triage({ reasons: ['auto_retry_exhausted'], signals })).toBe('engine');
    const e = episode({
      id: 'e2',
      reasons: ['auto_retry_exhausted'],
      signals,
      category: triage({ reasons: ['auto_retry_exhausted'], signals }),
    });
    saveEpisode(e);
    expect(existsSync(join(sa, 'memory/mechanize', `${e.signature}.json`))).toBe(true);
  });
  test('result defects wait for terminal failure while live signal defects remain eligible', () => {
    const successful = [
      ['review_not_required'],
      ['review_not_required', 'environment'],
      ['review_not_required', 'environment', 'self_report_conflict'],
    ].map((reasons, i) =>
      episode({
        id: `successful-${String(i)}`,
        status: 'completed',
        acceptance: [{ cmd: 'accept', ok: true }],
        category: 'engine',
        signature: 'review_not_required',
        reasons,
      })
    );
    for (const e of successful) saveEpisode(e);
    expect(episodes().map(e => e.id)).toEqual(successful.map(e => e.id));
    expect(existsSync(join(sa, 'memory/mechanize'))).toBe(false);

    mkdirSync(join(sa, 'memory/mechanize'));
    writeFileSync(
      join(sa, 'memory/mechanize/review_not_required.json'),
      JSON.stringify({
        signature: 'review_not_required',
        reasons: ['review_not_required'],
        episodes: successful.map(e => e.id),
      })
    );
    deliverEngineDefects();
    expect(coordination.coord().messages()).toHaveLength(0);

    const pending = episode({
      id: 'result-defect',
      status: 'running',
      category: 'engine',
      signature: 'evidence_conflict',
      acceptance: [{ cmd: 'accept', ok: true }],
    });
    saveEpisode(pending);
    saveEpisode({ ...pending, status: 'paused' });
    expect(existsSync(join(sa, 'memory/mechanize/evidence_conflict.json'))).toBe(false);
    deliverEngineDefects();
    expect(coordination.coord().messages()).toHaveLength(0);
    saveEpisode({ ...pending, status: 'failed' });
    deliverEngineDefects();
    expect(coordination.coord().messages()[0].body).toContain('occurrences: 1');

    saveEpisode({ ...pending, id: 'live-defect', signature: 'orphan_hold', status: 'running' });
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .map(m => m.title)
    ).toContain('engine defect: orphan_hold');
  });
  test('engine mechanisms queue once, accumulate, and reopen after done', () => {
    const first = episode({ id: 'defect-a', category: 'engine', signature: 'engine_suspect' });
    saveEpisode(first);
    deliverEngineDefects();
    expect(coordination.coord().messages()).toHaveLength(1);
    const message = coordination.coord().messages()[0];
    expect(message).toMatchObject({ kind: 'bug', recipient: null });
    expect(message.body).not.toContain('SECRET');
    saveEpisode({ ...first, id: 'defect-b', project: '/another/project' });
    mkdirSync(join(sa, 'memory/projections'), { recursive: true });
    writeFileSync(
      join(sa, 'memory/projections/defect-a.json'),
      JSON.stringify({ ...first, signature: 'fixed' })
    );
    deliverEngineDefects();
    expect(coordination.coord().messages()).toHaveLength(1);
    const owner = { ...message.sender, client: 'engine-owner' };
    expect(coordination.coord().claim(message.scope, owner).inbox).toHaveLength(1);
    coordination.coord().ack(message.id, owner, 'done', 'fixed');
    deliverEngineDefects();
    const defects = coordination
      .coord()
      .messages()
      .filter(m => !m.type);
    expect(defects).toHaveLength(2);
    const regression = defects.find(m => m.title.includes('regression'))!;
    expect(regression.title).toBe('engine defect regression: engine_suspect');
    expect(
      JSON.parse(readFileSync(join(sa, 'memory/mechanize/engine_suspect.json'), 'utf8'))
    ).toMatchObject({
      handoff: { id: regression.id, state: 'queued', episodes: 1, seen: ['defect-b'] },
    });
    coordination.coord().ack(regression.id, owner, 'done', 'fixed again');
    writeFileSync(
      join(sa, 'memory/projections/defect-b.json'),
      JSON.stringify({ ...first, id: 'defect-b', signature: 'fixed' })
    );
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .filter(m => !m.type)
    ).toHaveLength(2);
    saveEpisode({ ...first, id: 'defect-c' });
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .filter(m => !m.type)
    ).toHaveLength(3);
  });
  test('legacy handoff counts map to the original mechanism episode prefix', () => {
    const first = episode({ id: 'legacy-a', category: 'engine', signature: 'engine_suspect' });
    saveEpisode(first);
    deliverEngineDefects();
    const message = coordination.coord().messages()[0],
      owner = { ...message.sender, client: 'engine-owner' },
      file = join(sa, 'memory/mechanize/engine_suspect.json'),
      mechanism = JSON.parse(readFileSync(file, 'utf8'));
    delete mechanism.handoff.seen;
    writeFileSync(file, JSON.stringify(mechanism));
    coordination.coord().claim(message.scope, owner);
    coordination.coord().ack(message.id, owner, 'done', 'fixed');
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .filter(m => !m.type)
    ).toHaveLength(1);
    saveEpisode({ ...first, id: 'legacy-b' });
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .filter(m => !m.type)
    ).toHaveLength(2);
  });
  test('engine handoff caps evidence at the ten newest episodes while retaining total occurrences', () => {
    for (let i = 0; i < 12; i++)
      saveEpisode(
        episode({
          id: `capped-${String(i).padStart(2, '0')}`,
          at: new Date(NOW + i).toISOString(),
          category: 'engine',
          signature: 'evidence_conflict',
        })
      );
    deliverEngineDefects();
    const message = coordination.coord().messages()[0];
    expect(message.evidence).toHaveLength(10);
    expect(message.body).toContain('occurrences: 12');
    expect(message.body).toContain('run_ids: capped-11,capped-10');
    expect(message.body).not.toContain('capped-01');
  });
  test('a corrupt mechanism does not block another engine signature', () => {
    const valid = episode({ id: 'valid-defect', category: 'engine', signature: 'zz-valid' });
    saveEpisode(valid);
    writeFileSync(join(sa, 'memory/mechanize/00-bad.json'), '{');
    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    deliverEngineDefects();
    expect(
      coordination
        .coord()
        .messages()
        .map(m => m.title)
    ).toContain('engine defect: zz-valid');
    expect(log).toHaveBeenCalledWith('memory: engine_handoff_failed');
    log.mockRestore();
  });
  test('M2-01 and xiaopan 57e6 become mechanisms', async () => {
    for (const key of ['M2-01', 'xiaopan-57e6'] as const) {
      const sample = replay[key],
        e = episode({ id: key, status: sample.status, reasons: [sample.reason] });
      Object.assign(e, diagnosis(e));
      expect(String(e.category)).toBe(sample.classification);
      saveEpisode(e);
      expect(existsSync(join(sa, 'memory/mechanize', `${e.signature}.json`))).toBe(true);
    }
    expect(await reflectOne(NOW)).toBe(false);
  });
  test('E5 is refused before the next run, with an explicit base fix', async () => {
    sh('git init -q -b feature-no-base', root);
    await expect(inspectBase(root)).rejects.toThrow('worktree.baseBranch');
    process.env.SUPERAGENT_WRITE_ROOTS = root;
    const path = fixturePlan(root, root);
    // loadPlan requires a descendant of the write root. Use a real second repo without a remote HEAD.
    const child = join(root, 'bare-project');
    mkdirSync(child);
    sh('git init -q -b feature-no-base', child);
    const next = { ...plan, repo: child };
    writeFileSync(path, JSON.stringify(next));
    expect(main(['run', path, '--fake', '--json'])).toBe(1);
    const failure = JSON.parse(
      readFileSync(join(sa, 'launch-failures', readdirSync(join(sa, 'launch-failures'))[0]), 'utf8')
    );
    expect(failure.phase).toBe('preflight');
    expect(failure.reason).toContain('worktree.baseBranch');
    expect(existsSync(join(sa, 'runs'))).toBe(false);
  });
  test('reflection produces candidates without authorizing production prompts or rewriting status', async () => {
    fakeValidation();
    const e = episode();
    expect(e.category).toBe('project');
    saveEpisode(e);
    const harness = reflectionHarness(e, {
      operations: [
        {
          op: 'ADD',
          lesson: {
            tier: 'project',
            scope: root,
            when: 'port',
            do: 'free',
            dont: 'busy',
            why: 'test',
            evidence: [e.id],
            mechanizable: false,
          },
        },
      ],
    });
    expect(reflectOne(NOW, harness.query)).toBe(true);
    harness.terminal('completed');
    expect(reflectOne(NOW, harness.query)).toBe(true);
    const learned = memoryState().lessons[0];
    expect(learned.scope).toBe(root);
    expect(learned.status).toBe('trial');
    seed(
      lesson('stable', { status: 'stable', helpful: 2 }),
      lesson('engine', { category: 'engine', helpful: 9 }),
      lesson('retired', { status: 'retired', helpful: 9 }),
      lesson('foreign', { scope: join(root, 'other'), helpful: 9 })
    );
    const generated = generate(plan, 'next', true);
    expect(readFileSync(join(generated.dir, 'briefs/core.md'), 'utf8')).not.toContain(
      '选取空闲端口'
    );
    const metadata = JSON.parse(readFileSync(join(generated.dir, 'engine.json'), 'utf8'));
    expect(metadata.lessons.core).toEqual(['stable', learned.id]);
    const entries = JSON.parse(readFileSync(join(generated.dir, 'learning.json'), 'utf8'))
      .selections.core.entries;
    expect(entries[0]).toMatchObject({ id: 'stable', source: 'reflection', status: 'active' });
    const other = generate({ ...plan, repo: join(root, 'other') }, 'other', true);
    expect(readFileSync(join(other.dir, 'briefs/core.md'), 'utf8')).not.toContain('选取空闲端口');
    maintainLessons(
      { id: 'next', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] },
      NOW
    );
    maintainLessons(
      { id: 'next', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] },
      NOW
    );
    expect(memoryState().lessons[0].harmful).toBe(1);
    maintainLessons(
      { id: 'third', reasons: ['acceptance_failed'], failed: true, ids: [learned.id] },
      NOW
    );
    expect(memoryState().lessons[0]).toMatchObject({ harmful: 2, status: 'retired' });
    expect(existsSync(join(sa, 'memory/mechanize', `lesson_${learned.id}.json`))).toBe(true);
    expect(selectLessons(root, 'ts-cli')).toHaveLength(0);
  });
});

describe('EV1 budgets and deterministic matching', () => {
  test('durable run is unique across repeated ticks and launch failure retries', () => {
    const e = episode();
    saveEpisode(e);
    const harness = reflectionHarness(e);
    harness.rejectLaunch(true);
    expect(reconcileReflection(NOW, at => reflectOne(at, harness.query))).toBe(false);
    expect(memoryState().entries).toHaveLength(0);
    harness.rejectLaunch(false);
    expect(reflectOne(NOW, harness.query)).toBe(true);
    expect(reflectOne(NOW, harness.query)).toBe(false);
    expect(harness.launches()).toBe(1);
  });
  test('completed and exhausted runs write exactly one distilled or degraded terminal', () => {
    const success = episode({ id: 'success' });
    saveEpisode(success);
    const done = reflectionHarness(success, {
      operations: [
        {
          op: 'ADD',
          lesson: {
            tier: 'project',
            scope: root,
            when: 'w',
            do: 'd',
            dont: '',
            why: 'y',
            evidence: [success.id],
            mechanizable: false,
          },
        },
      ],
    });
    reflectOne(NOW, done.query);
    done.terminal('completed');
    expect(reflectOne(NOW, done.query)).toBe(true);
    expect(memoryState().entries.at(-1)?.reflection?.state).toBe('produced');
    const failed = episode({ id: 'failed', signature: 'other' });
    saveEpisode(failed);
    const exhausted = reflectionHarness(failed);
    reflectOne(NOW, exhausted.query);
    exhausted.terminal('failed');
    expect(reflectOne(NOW, exhausted.query)).toBe(true);
    expect(memoryState().entries.filter(e => e.reflected === failed.id)).toHaveLength(1);
    expect(memoryState().entries.at(-1)).toMatchObject({
      lessons: [{ status: 'trial', evidence: [failed.id] }],
      reflection: { state: 'degraded' },
    });
  });
  test.each([
    ['invalid', { unexpected: true }],
    ['empty', { operations: [], reason: 'no evidence' }],
  ])('invalid or empty reflection output gets an injectable fallback (%s)', (_, output) => {
    fakeValidation();
    const e = episode();
    saveEpisode(e);
    const harness = reflectionHarness(e, output);
    expect(reflectOne(NOW, harness.query)).toBe(true);
    harness.terminal('completed');
    expect(reflectOne(NOW, harness.query)).toBe(true);
    const learned = memoryState().lessons[0];
    expect(learned).toMatchObject({
      tier: 'project',
      scope: root,
      tag: 'ts-cli',
      status: 'trial',
      evidence: [e.id],
    });
    const generated = generate(plan, `fallback-${String(_)}`, true);
    expect(
      JSON.parse(readFileSync(join(generated.dir, 'learning.json'), 'utf8')).selections.core.entries
    ).toContainEqual(expect.objectContaining({ id: learned.id, source: 'reflection' }));
  });
  test('daily ceiling leaves work queued and starts it next day', () => {
    mkdirSync(join(sa, 'memory'));
    writeFileSync(join(sa, 'memory/config.json'), JSON.stringify({ daily_tokens: 9216 }));
    const e = episode({ id: 'queued' });
    saveEpisode(e);
    memoryWrite(() => ({ lessons: [], day: memoryData(NOW).reflection.day, tokens: 9216 }));
    const harness = reflectionHarness(e);
    expect(reflectOne(NOW, harness.query)).toBe(false);
    expect(reflectOne(NOW + 86400000, harness.query)).toBe(true);
    expect(harness.launches()).toBe(1);
  });
  test('ordinary merges do not deduplicate by signature; abnormal episodes do', () => {
    const complete = (id: string) => episode({ id, status: 'completed', signature: 'same' });
    const abnormal = (id: string) => episode({ id, status: 'failed', signature: 'bad' });
    const all = [complete('a'), complete('b'), abnormal('x'), abnormal('y')];
    expect(reflectionQueue(all, [], NOW).map(e => e.id)).toEqual(['a', 'b', 'x']);
    memoryWrite(() => ({
      lessons: [],
      reflected: 'a',
      reflection: { episode: 'a', state: 'rejected' },
    }));
    expect(reflectionQueue(all, memoryState().entries, NOW).map(e => e.id)).toEqual(['b', 'x']);
  });
  test('five lessons maximum, two trials maximum, Chinese byte estimate <=600', () => {
    const stable = Array.from({ length: 6 }, (_, i) => lesson(`s${i}`, { status: 'stable' }));
    expect(lessonText(stable).ids).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(lessonText([lesson('t1'), lesson('t2'), lesson('t3')]).ids).toEqual(['t1', 't2']);
    const long = lessonText(
      stable.map(l => ({ ...l, when: '中'.repeat(70), do: '中'.repeat(70) }))
    );
    expect(Buffer.byteLength(long.text)).toBeLessThanOrEqual(600);
    expect(long.ids.length).toBeLessThan(5);
    expect(lessonText([lesson('giant', { do: '中'.repeat(240) })]).ids).toHaveLength(0);
  });
  test('reflection lessons enter data context without mutating briefs, commands or nodes', () => {
    seed(lesson('trial'), lesson('stable', { status: 'stable', helpful: 100 }));
    const dir = join(root, 'unqualified');
    mkdirSync(join(dir, 'briefs'), { recursive: true });
    writeFileSync(join(dir, 'briefs/core.md'), 'original brief');
    const nodes = [
      { id: 'code-core', command: 'sa-code', with: { brief: join(dir, 'briefs/core.md') } },
    ];
    const frozen = JSON.stringify(nodes);
    const before = readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8');
    expect(injectMemory(plan, dir, nodes)).toEqual({ core: ['stable', 'trial'] });
    expect(selectLessons(root, 'ts-cli')).toEqual([]);
    expect(readFileSync(join(dir, 'briefs/core.md'), 'utf8')).toBe('original brief');
    expect(JSON.stringify(nodes)).toBe(frozen);
    expect(readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8')).toBe(before);
  });
  test('role experiences target their mapped role; exact tags and project prevent leakage', () => {
    seed(
      lesson('project'),
      lesson('type', { tier: 'type', scope: 'ts-cli', status: 'stable' }),
      lesson('role', { tier: 'role', scope: 'strategist', status: 'stable' })
    );
    expect(selectCandidates('/another-project', 'ts-cli').map(l => l.id)).toEqual(['type']);
    expect(selectCandidates(root, 'docs').map(l => l.id)).toEqual([]);
    expect(selectCandidates(root, 'ts-cli', 'general').map(l => l.id)).not.toContain('role');
    expect(selectCandidates(root, 'ts-cli', 'strategist').map(l => l.id)).toContain('role');
  });
  test('memory off means no injection or reflection, and data does not change engine hash', async () => {
    fakeValidation();
    seed(lesson('x'));
    saveEpisode(episode());
    const before = engineHash();
    process.env.SUPERAGENT_MEMORY = 'off';
    const off = generate(plan, 'off', true);
    expect(readFileSync(join(off.dir, 'briefs/core.md'), 'utf8')).not.toContain('经验（自动');
    expect(JSON.parse(readFileSync(join(off.dir, 'engine.json'), 'utf8')).lessons).toEqual({});
    expect(await reflectOne(NOW)).toBe(false);
    process.env.SUPERAGENT_MEMORY = 'on';
    const on = generate(plan, 'on', true);
    expect(readFileSync(join(on.dir, 'briefs/core.md'), 'utf8')).not.toContain('[x]');
    expect(on.engine_hash).toBe(off.engine_hash);
    expect(engineHash()).toBe(before);
    expect(JSON.parse(readFileSync(join(on.dir, 'engine.json'), 'utf8'))).toMatchObject({
      workflow_hash: on.engine_hash,
      engine_hash: on.engine_hash,
      lessons: {},
    });
  });
  test('lesson retrieval failures are fail-open', () => {
    fakeValidation();
    mkdirSync(join(sa, 'memory'));
    writeFileSync(join(sa, 'memory/lessons.jsonl'), '{broken\n');
    const gen = generate(plan, 'broken', true);
    expect(existsSync(join(gen.dir, 'engine.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(gen.dir, 'engine.json'), 'utf8')).lessons).toEqual({});
  });
});

describe('EV1 lifecycle, privacy and priors', () => {
  test('episode projection is <=8KB and excludes source prompt, transcript and credentials', () => {
    writeFileSync(
      join(artifactsOf(raw), 'verify-core.json'),
      JSON.stringify({
        ...portEvidence,
        prompt: 'PRIVATE-PROMPT',
        transcript: 'PRIVATE-TRANSCRIPT',
        credentials: 'PRIVATE-CREDENTIAL',
      })
    );
    const e = episode({
      timeline: Array.from({ length: 400 }, () => ({
        node: 'verify-core',
        state: 'failed',
        started_at: null,
        duration_ms: null,
      })),
    });
    saveEpisode(e);
    const output = readFileSync(join(sa, 'memory/episodes/incident.json'), 'utf8');
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    for (const word of ['prompt', 'transcript', 'credentials', 'PRIVATE-', '/forbidden-transcript'])
      expect(output).not.toContain(word);
    expect(JSON.parse(output).acceptance).toEqual([{ cmd: 'bun test --port 39890', ok: false }]);
    raw.status = 'completed';
    ledger.recoveries = [new Date(NOW).toISOString()];
    expect(triggered(episode(), undefined, undefined, NOW)).toBe(true);
    expect(Buffer.byteLength(reflectionInput(episode()))).toBeLessThanOrEqual(8000);
  });
  test('private and iCloud projects only triage, never invoke reflection', async () => {
    process.env.HOME = root;
    const cloud = join(root, 'Library/CloudStorage/iClOuD Drive');
    mkdirSync(cloud, { recursive: true });
    symlinkSync(cloud, join(root, 'cloud-alias'));
    expect(privateProject(join(root, 'Library/CloudStorage/SynologyDrive'))).toBe(false);
    for (const p of [
      cloud,
      join(root, 'cloud-alias/new-repo'),
      '/repo/_private-client',
      '/repo/_private/client',
      '/Users/operator/Library/Mobile Documents/com~apple~CloudDocs/repo',
    ]) {
      expect(privateProject(p)).toBe(true);
      expect(reflectionQueue([episode({ project: p })], [], NOW)).toEqual([]);
      saveEpisode(episode({ id: `private-${p.includes('_private') ? 'a' : 'b'}`, project: p }));
    }
    expect(await reflectOne(NOW)).toBe(false);
    expect(memoryData(NOW).queued).toBe(0);
  });
  test('each trigger and five categories use evidence and registered policy', () => {
    const base = episode({ status: 'running', reasons: [], category: 'project', signals: zeros });
    expect(triggered(base, undefined, undefined, NOW)).toBe(false);
    for (const e of [
      episode({ status: 'cancelled' }),
      episode({ status: 'completed', asks: [{ hold: 'signoff', status: 'approved' }] }),
      episode({ p50_ratio: 2.1 }),
      episode({ findings: ['| f | high | src/cli.ts:1 | open | proof |'] }),
      episode({ signals: { ...zeros, engine_suspect: 1 } }),
    ])
      expect(triggered(e, undefined, undefined, NOW)).toBe(true);
    expect(triggered(base, new Date(NOW - 1800001).toISOString(), undefined, NOW)).toBe(true);
    expect(triggered(base, undefined, 30000, NOW)).toBe(true);
    expect(triage({ reasons: ['budget_tokens_exceeded'], signals: zeros })).toBe('engine');
    expect(triage({ reasons: ['review_failed'], signals: zeros })).toBe('role');
    expect(triage({ reasons: ['coder_output_invalid'], signals: zeros })).toBe('role');
    expect(triage({ reasons: ['coder_error:env'], signals: zeros })).toBe('engine');
    expect(triage({ reasons: ['environment'], signals: zeros })).toBe('transient');
    expect(triage({ reasons: ['acceptance_failed'], signals: zeros })).toBe('project');
    expect(taskTag(['docs/a.md', 'src/b.ts', 'a.vue', 'c.ts'])).toBe('docs+ts-cli');
  });
  test('feedback promotes helpful trials and retires harmful trials', () => {
    seed(
      lesson('winner'),
      lesson('old', { last_hit: new Date(NOW - 31 * 86400000).toISOString() })
    );
    for (const id of ['win1', 'win2'])
      maintainLessons({ id, reasons: [], failed: false, accepted: true, ids: ['winner'] }, NOW);
    expect(memoryState().lessons.find(l => l.id === 'winner')).toMatchObject({
      helpful: 2,
      status: 'stable',
    });
    for (const [id, failed] of [
      ['cancelled', false],
      ['unaccepted', false],
      ['failed', true],
    ] as const)
      maintainLessons({ id, reasons: [], failed, ids: ['winner'] }, NOW);
    expect(memoryState().lessons.find(l => l.id === 'winner')?.helpful).toBe(2);
    expect(memoryState().lessons.find(l => l.id === 'old')?.status).toBe('trial');
    seed(lesson('legacy', { status: 'stable' }));
    maintainLessons(undefined, NOW);
    expect(memoryState().lessons.find(l => l.id === 'legacy')?.status).toBe('stable');
    expect(selectLessons(root, 'ts-cli')).toEqual([]);
  });
  test('curator falls back after rejected edits, deduplicates ADD, and preserves feedback', () => {
    const e = episode(),
      valid = {
        tier: 'project',
        scope: root,
        when: 'port',
        do: 'free',
        dont: 'busy',
        why: 'evidence',
        evidence: ['incident'],
        mechanizable: false,
      };
    expect(
      curate(
        e,
        {
          operations: [
            { op: 'ADD', lesson: { ...valid, do: 'x'.repeat(241) } },
            { op: 'ADD', lesson: valid },
          ],
        },
        NOW
      ).lessons
    ).toHaveLength(1);
    seed(lesson('existing'));
    expect(curate(e, { operations: [{ op: 'ADD', lesson: valid }] }, NOW).lessons[0].id).toBe(
      'existing'
    );
    expect(
      curate(
        e,
        { operations: [{ op: 'EDIT', id: 'existing', lesson: { ...valid, scope: '/foreign' } }] },
        NOW
      ).lessons[0]
    ).toMatchObject({ id: `l-reflect-${e.id}`, status: 'trial' });
    expect(
      curate(e, { operations: [{ op: 'UPVOTE', id: 'existing' }] }, NOW).lessons[0]
    ).toMatchObject({ helpful: 0, votes: 1 });
    expect(curate(e, { operations: [], reason: '无可复用经验' }, NOW).result).toContain(
      '确定性保底'
    );
  });
  test('plan admission priors only warn with enough samples and retain a reasoned override', () => {
    const key = priorKey(root, plan.packages[0], loadTiers().tiers.general.pools.chatgpt[0]);
    mkdirSync(join(sa, 'memory'));
    const prior = {
      n: 5,
      duration: { p50: 600000, p90: 900000 },
      tokens: { n: 5, p50: 5000000, p90: 7000000 },
    };
    writeFileSync(join(sa, 'memory/priors.json'), JSON.stringify({ [key]: prior }));
    const next = {
      ...plan,
      deadline: new Date(NOW + 10000).toISOString(),
      budget: { weighted_tokens: 1000000 },
    };
    expect(lintPlan(next, undefined, NOW)).toMatchObject({ rejected: false });
    expect(lintPlan(next, '人工确认验收使用缓存', NOW)).toMatchObject({
      rejected: false,
      override: '人工确认验收使用缓存',
    });
    expect(lintPlan(next, ' ', NOW)).toMatchObject({ rejected: false });
    expect(lintPlan(next, ' ', NOW)).not.toHaveProperty('override');
    expect(lintPlan(next, undefined, NOW).warnings.join(' ')).toContain('5000000');
    expect(lintPlan(next, undefined, NOW).warnings.join(' ')).toContain(
      new Date(NOW + 600000).toISOString()
    );
    writeFileSync(join(sa, 'memory/priors.json'), JSON.stringify({ [key]: { ...prior, n: 4 } }));
    expect(lintPlan(next, undefined, NOW).rejected).toBe(false);
    expect(lintPlan(next, undefined, NOW).warnings).toEqual([]);
    seed(lesson('plan', { category: 'plan', do: '预算至少一个验收周期' }));
    expect(lintPlan(plan, undefined, NOW).warnings.join(' ')).not.toContain('预算至少一个验收周期');
  });
  test(
    'run admission warnings and override are recorded in the CLI ledgers with a stub engine',
    () => {
      const repo = gitRepo(root);
      sh('git switch -qc feature/fixture', repo);
      process.env.SUPERAGENT_WRITE_ROOTS = root;
      const next = {
        ...plan,
        repo,
        deadline: new Date(Date.now() + 60000).toISOString(),
        budget: { weighted_tokens: 1000000 },
      };
      const path = join(root, 'next.json');
      writeFileSync(path, JSON.stringify(next));
      mkdirSync(join(sa, 'memory'));
      writeFileSync(
        join(sa, 'memory/priors.json'),
        JSON.stringify({
          [priorKey(repo, next.packages[0], loadTiers().tiers.general.pools.chatgpt[0])]: {
            n: 5,
            duration: { p50: 600000, p90: 600000 },
            tokens: { n: 5, p50: 5000000, p90: 5000000 },
          },
        })
      );
      install();
      const stub = join(root, 'ack');
      writeFileSync(stub, '#!/bin/sh\necho \'{"ok":true,"runId":"fixture"}\'\n', { mode: 0o755 });
      process.env.SA_ARCHON_BIN = stub;
      expect(main(['run', path, '--fake'])).toBe(0);
      const first = readdirSync(join(sa, 'runs'))[0];
      const lint = JSON.parse(readFileSync(join(sa, 'runs', first), 'utf8')).plan_lint;
      expect(lint.rejected).toBe(false);
      expect(lint.warnings).toHaveLength(2);
      expect(lint.override).toBeUndefined();
      expect(existsSync(join(sa, 'launch-failures'))).toBe(false);
      const overlapReason = 'stub engine runs intentionally share the fixture scope';
      expect(
        main([
          'run',
          path,
          '--fake',
          '--lint-override',
          '明确的小样本验收',
          '--allow-overlap',
          overlapReason,
        ])
      ).toBe(0);
      const second = readdirSync(join(sa, 'runs')).find(file => file !== first)!;
      const secondLedger = JSON.parse(readFileSync(join(sa, 'runs', second), 'utf8'));
      expect(secondLedger.allow_overlap).toBe(overlapReason);
      expect(secondLedger.plan_lint).toMatchObject({
        override: '明确的小样本验收',
        rejected: false,
      });
    },
    testTimeout(15_000)
  );
  test('read-only memory API reports ten recent episodes and changes no files', () => {
    for (let i = 0; i < 12; i++)
      saveEpisode(
        episode({ id: `run${i}`, signature: `problem${i}`, at: new Date(NOW + i).toISOString() })
      );
    seed(lesson('stable', { status: 'stable' }));
    const before = readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8');
    expect(memoryData(NOW)).toMatchObject({
      states: { stable: 1 },
      categories: { project: 12 },
      queued: 12,
    });
    expect(memoryData(NOW).recent).toHaveLength(10);
    expect(main(['memory', '--json'])).toBe(0);
    expect(readFileSync(join(sa, 'memory/lessons.jsonl'), 'utf8')).toBe(before);
  });
  test('a paused archive folds once while terminal scoring reads final evidence', () => {
    seed(lesson('injected'));
    writeFileSync(
      join(ledger.gen_dir, 'engine.json'),
      JSON.stringify({ lessons: { 'code-core': ['injected'] } })
    );
    const held = {
      ...raw,
      status: 'paused',
      nodes: undefined,
      metadata: {
        wait: {
          nodeId: 'human',
          kind: 'event',
          event: 'sa.human',
          resumeAt: new Date(NOW + 600000).toISOString(),
          waitingSince: new Date(NOW - 31 * 60000).toISOString(),
        },
      },
      events: [],
    };
    const stub = join(root, 'archon-held');
    writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
    const file = join(root, 'held.json');
    writeFileSync(file, JSON.stringify(held));
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
    memoryTick({}, NOW, false);
    const path = join(sa, 'memory/episodes/incident.json'),
      archive = readFileSync(path, 'utf8');
    expect(memoryState().lessons[0].harmful).toBe(0);
    writeFileSync(
      join(artifactsOf(raw), 'verify-core.json'),
      JSON.stringify({ ok: false, reason: 'review_failed' })
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...held,
        status: 'failed',
        completed_at: new Date(NOW).toISOString(),
        events: [
          {
            event_type: 'node_failed',
            step_name: 'verify-core',
            created_at: new Date(NOW).toISOString(),
            data: { error: 'review_failed', duration_ms: 60000 },
          },
        ],
      })
    );
    memoryTick({}, NOW + 5000, false);
    memoryTick({}, NOW + 10000, false);
    expect(readFileSync(path, 'utf8')).toBe(archive);
    expect(memoryState().lessons[0]).toMatchObject({ helpful: 0, harmful: 0 });
  });
  test('event CLI shape produces timeline and tick folds once, recomputes real history priors', () => {
    const model = loadTiers().tiers.general.pools.chatgpt[0],
      unavailable = { source: 'unavailable', reason: 'not_reported' };
    const data = {
      node: { id: 'code-core', kind: 'agent', source: { kind: 'command', name: 'sa-code' } },
      invocation: { id: 'invoke', startedAt: ledger.started_at, loopPath: [] },
      attempt: { id: 'one', startedAt: ledger.started_at },
      binding: {
        provider: 'codex',
        model: { requested: model, resolved: { source: 'provider', value: model } },
      },
      timing: { startedAt: ledger.started_at },
      spend: {
        tokens: unavailable,
        costUsd: unavailable,
        stopReason: unavailable,
        numTurns: unavailable,
      },
      accounting: 'node',
    };
    const events = [
      { event_type: 'node_started', step_name: 'code-core', created_at: ledger.started_at, data },
      {
        event_type: 'node_completed',
        step_name: 'code-core',
        created_at: new Date(NOW).toISOString(),
        data: {
          ...data,
          timing: { startedAt: ledger.started_at, durationMs: 60000 },
          spend: {
            ...data.spend,
            tokens: { source: 'provider', value: { input: 100, output: 10 } },
          },
        },
      },
    ];
    const eventRun = { ...raw, nodes: undefined, events };
    expect(foldEpisode(ledger, plan, eventRun, events, {}, NOW).timeline).toContainEqual({
      node: 'code-core',
      state: 'completed',
      started_at: ledger.started_at,
      duration_ms: 60000,
    });
    const stub = join(root, 'archon-stub');
    writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
    const file = join(root, 'run.json');
    writeFileSync(file, JSON.stringify(eventRun));
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
    memoryTick({}, NOW, false);
    const episodePath = join(sa, 'memory/episodes/incident.json'),
      original = readFileSync(episodePath, 'utf8');
    memoryTick({}, NOW + 5000, false);
    expect(readFileSync(episodePath, 'utf8')).toBe(original);
    const priors = JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'));
    expect(priors[priorKey(root, plan.packages[0], model)]).toMatchObject({
      n: 1,
      duration: { p50: 60000 },
      tokens: { n: 1, p50: 110 },
    });
    const unknownEvents = events.map(e => ({
      ...e,
      data: { ...e.data, spend: { ...e.data.spend, tokens: unavailable } },
    }));
    writeFileSync(file, JSON.stringify({ ...eventRun, events: unknownEvents }));
    memoryTick({}, NOW + 10000, false);
    expect(readFileSync(episodePath, 'utf8')).toBe(original);
    const unknownPriors = JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'));
    expect(unknownPriors[priorKey(root, plan.packages[0], model)].tokens.n).toBe(1);
    // Only a changed ledger invalidates a terminal cache; changing native history alone does not query it.
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify({ ...ledger, intervened: true }));
    memoryTick({}, NOW + 15000, false);
    expect(
      JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'))[
        priorKey(root, plan.packages[0], model)
      ].tokens.n
    ).toBe(0);
    expect(foldEpisode(ledger, plan, eventRun, unknownEvents, {}, NOW).tokens[0].total).toBeNull();
    // R1-3: failed attempts (even without a failure class) remain in retry-success priors.
    const retryEvents = [
      {
        ...events[1],
        event_type: 'node_failed',
        data: { ...events[1].data, error: 'fixture failure' },
      },
      { ...events[1], data: { ...events[1].data, attempt: { ...data.attempt, id: 'retry' } } },
    ];
    writeFileSync(file, JSON.stringify({ ...eventRun, status: 'completed', events: retryEvents }));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify({ ...ledger, intervened: false }));
    expect(memoryTick({}, NOW + 20000, false).errors).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'))[
        priorKey(root, plan.packages[0], model)
      ]
    ).toMatchObject({ n: 1, duration: { p50: 60000 } });
    // A terminal run cannot turn a started-only attempt into a completed sample.
    writeFileSync(
      file,
      JSON.stringify({
        ...eventRun,
        status: 'completed',
        events: [
          ...retryEvents,
          { ...events[0], data: { ...data, attempt: { ...data.attempt, id: 'pending' } } },
        ],
      })
    );
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify({ ...ledger, intervened: true }));
    expect(memoryTick({}, NOW + 25000, false).errors).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'))[
        priorKey(root, plan.packages[0], model)
      ]
    ).toBeUndefined();

    delete process.env.FAKE_EV1_RUN;
  });
});

describe('EV1b production-shaped replay and incremental isolation', () => {
  test('sampled sinan, suspect, launch failure and sourced cancellation classify from evidence', () => {
    for (const sample of realData.runs) {
      const l = { ...ledger, run_id: sample.id, dispositions: sample.dispositions },
        run: RunView = {
          ...raw,
          id: sample.id,
          status: sample.status as RunView['status'],
          nodes: sample.nodes,
          started_at: sample.started_at,
          completed_at: sample.completed_at,
          metadata: { error: sample.failure },
        };
      const ids = [
        ...new Set(
          Object.keys(sample.artifacts)
            .filter(f => /^(verify|settle)-/.test(f) && !f.endsWith('.coder.json'))
            .map(f => f.replace(/^(verify|settle)-/, '').replace(/\.json$/, ''))
        ),
      ];
      const p = {
        ...plan,
        packages: (ids.length ? ids : ['core']).map(id => ({ ...plan.packages[0], id })),
      };
      mkdirSync(artifactsOf(run), { recursive: true });
      for (const [file, row] of Object.entries(sample.artifacts))
        writeFileSync(join(artifactsOf(run), file), JSON.stringify(row));
      if (sample.incident) mkdirSync(join(sa, 'incidents', sample.id), { recursive: true });
      const e = foldEpisode(l, p, run, sample.cancellations, {}, NOW),
        cancellation = sample.cancellations.length > 0 && !sample.incident;
      expect(e.category).toBe(cancellation ? 'transient' : 'engine');
      expect(e.signature).toBe(
        sample.incident
          ? 'engine_suspect'
          : sample.failure === 'base_branch_missing'
            ? 'base_branch_missing'
            : cancellation
              ? 'cancelled_source'
              : 'auto_retry'
      );
      saveEpisode(e);
      if (cancellation) {
        const missing = foldEpisode(l, p, run, [], {}, NOW);
        expect(missing.category).toBe('engine');
        expect(missing.signature).toBe('evidence_missing');
        saveEpisode({ ...missing, id: sample.id + '-missing' });
      }
    }
    const missing = JSON.parse(
      readFileSync(join(sa, 'memory/mechanize/evidence_missing.json'), 'utf8')
    );
    expect(missing.episodes).toHaveLength(4);
    expect(
      readdirSync(join(sa, 'memory/mechanize')).filter(f => f === 'evidence_missing.json')
    ).toHaveLength(1);
    expect(existsSync(join(sa, 'memory/mechanize/auto_retry.json'))).toBe(false);
    expect(
      episodes().filter(e => e.status === 'completed' && e.signature === 'auto_retry')
    ).toHaveLength(2);
  });
  test('HF5 episode hashes separate new holds, count historical duplicate reminder identities', () => {
    raw.status = 'completed';
    const a = foldEpisode(
      ledger,
      plan,
      raw,
      [],
      {
        'incident:budget:aaaaaaaaaaaaaaaa': { status: 'approved', id: 'a' },
        'incident:budget:bbbbbbbbbbbbbbbb': { status: 'pending', id: 'b' },
      },
      NOW
    );
    expect(a.signals.dup_ask).toBe(0);
    const b = foldEpisode(
      ledger,
      plan,
      raw,
      [],
      {
        'incident:budget:1': { status: 'superseded', id: 'a' },
        'incident:budget:2': { status: 'superseded', id: 'b' },
        'incident:budget:aaaaaaaaaaaaaaaa': {
          status: 'approved',
          id: 'a',
          legacy_key: 'incident:budget:1',
        },
      },
      NOW
    );
    expect(b.signals.dup_ask).toBe(1);
    expect(b.category).toBe('engine');
  });
  test('one escaped artifact only records an error; terminal runs including nontriggers stop querying', () => {
    const outside = tmp(),
      bad: RunView = { ...raw, id: 'bad-native', output_root: outside };
    mkdirSync(artifactsOf(bad), { recursive: true });
    writeFileSync(join(artifactsOf(bad), 'verify-core.json'), '{}');
    const good = { ...raw, id: 'good-native', events: [] },
      quiet = { ...raw, id: 'quiet-native', status: 'completed', events: [] };
    const queries = join(root, 'queries'),
      responses = join(root, 'responses');
    mkdirSync(responses);
    mkdirSync(join(sa, 'runs'));
    for (const [id, run] of [
      ['bad', { ...bad, events: [] }],
      ['good', good],
      ['quiet', quiet],
    ] as const) {
      writeFileSync(join(responses, run.id + '.json'), JSON.stringify(run));
      writeFileSync(
        join(sa, 'runs', id + '.json'),
        JSON.stringify({ ...ledger, run_id: id, archon_run_id: run.id })
      );
    }
    mkdirSync(artifactsOf(good), { recursive: true });
    writeFileSync(
      join(artifactsOf(good), 'verify-core.json'),
      JSON.stringify({ reason: 'acceptance_failed', ok: false })
    );
    const stub = join(root, 'incremental');
    writeFileSync(stub, `#!/bin/sh\necho "$3" >> '${queries}'\ncat "$FAKE_EV1_RUN/$3.json"\n`, {
      mode: 0o755,
    });
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = responses;
    const dry = memoryTick({}, NOW, true, true);
    expect(dry.errors).toEqual([{ id: 'bad', reason: 'path_outside' }]);
    expect(existsSync(join(sa, 'memory'))).toBe(false);
    memoryTick({}, NOW, false);
    expect(existsSync(join(sa, 'memory/episodes/good.json'))).toBe(true);
    expect(existsSync(join(sa, 'memory/episodes/quiet.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(sa, 'memory/errors.jsonl'), 'utf8').trim())).toEqual({
      id: 'bad',
      reason: 'path_outside',
    });
    const priorsAt = statSync(join(sa, 'memory/priors.json')).mtimeMs;
    writeFileSync(queries, '');
    memoryTick({}, NOW + 60000, false);
    expect(readFileSync(queries, 'utf8').trim()).toBe('bad-native');
    expect(statSync(join(sa, 'memory/priors.json')).mtimeMs).toBe(priorsAt);
    memoryTick({}, NOW + 86400000, false);
    expect(statSync(join(sa, 'memory/priors.json')).mtimeMs).toBeGreaterThanOrEqual(priorsAt);
  });
  test('native revision invalidates live cache while clock-only holds still trigger without queries', () => {
    const nativeHome = join(sa, 'archon');
    mkdirSync(nativeHome);
    const db = new Database(join(nativeHome, 'archon.db'));
    db.exec(
      'CREATE TABLE remote_agent_workflow_runs (id TEXT PRIMARY KEY, status TEXT, last_activity_at TEXT, completed_at TEXT, metadata TEXT); CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT)'
    );
    db.query('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, NULL, ?)').run(
      raw.id,
      'paused',
      new Date(NOW).toISOString(),
      '{}'
    );
    const activeRun = {
      ...raw,
      status: 'paused',
      started_at: new Date(NOW).toISOString(),
      completed_at: null,
      nodes: [],
      last_activity_at: new Date(NOW).toISOString(),
      metadata: {
        wait: {
          nodeId: 'gate',
          kind: 'event',
          event: 'sa.human',
          resumeAt: new Date(NOW + 3600000).toISOString(),
          waitingSince: new Date(NOW).toISOString(),
        },
      },
      events: [],
    };
    const file = join(root, 'active.json'),
      queries = join(root, 'live-queries'),
      stub = join(root, 'active-query');
    writeFileSync(file, JSON.stringify(activeRun));
    writeFileSync(stub, `#!/bin/sh\necho query >> '${queries}'\ncat "$FAKE_EV1_RUN"\n`, {
      mode: 0o755,
    });
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
    try {
      memoryTick({}, NOW, false);
      const aged = memoryTick({}, NOW + 610000, false);
      expect(aged.episodes[0]).toMatchObject({ category: 'engine', signature: 'orphan_hold' });
      expect(readFileSync(queries, 'utf8').trim().split('\n')).toHaveLength(1);
      writeFileSync(
        join(sa, 'runs/incident.json'),
        JSON.stringify({
          ...ledger,
          dispositions: [
            {
              at: new Date(NOW + 1).toISOString(),
              reason: 'gate',
              action: 'blocked',
              ok: false,
            },
          ],
        })
      );
      expect(memoryTick({}, NOW + 615000, false).episodes[0].signals.orphan_hold).toBe(0);
      db.query('INSERT INTO remote_agent_workflow_events VALUES (?)').run(raw.id);
      writeFileSync(file, JSON.stringify({ ...raw, events: [] }));
      memoryTick({}, NOW + 620000, false);
      expect(readFileSync(queries, 'utf8').trim().split('\n')).toHaveLength(3);
      memoryTick({}, NOW + 630000, false);
      expect(readFileSync(queries, 'utf8').trim().split('\n')).toHaveLength(3);
    } finally {
      db.close();
    }
  });
  test('green terminal failures conflict only without a registered reason', () => {
    const greenFailure = {
      status: 'failed',
      acceptance: [{ cmd: 'accept', ok: true }],
      signals: zeros,
    };
    expect(diagnosis({ ...greenFailure, reasons: ['review_failed'] })).toEqual({
      category: 'role',
      signature: 'review_failed',
    });
    for (const reasons of [[], ['unclassified']])
      expect(diagnosis({ ...greenFailure, reasons })).toEqual({
        category: 'engine',
        signature: 'evidence_conflict',
      });
  });
  test('real strategist job roles and cards replace other tag; done overrun is plan', () => {
    mkdirSync(join(sa, 'jobs'));
    for (const j of realData.jobs)
      writeFileSync(
        join(sa, 'jobs', j.id + '.json'),
        JSON.stringify({
          ...j,
          cwd: root,
          card: j.card ? join(root, j.card) : null,
          kind: 'codex',
          model: 'fixture',
          title: 'review',
          pid: 0,
          wrapper_pid: 0,
        })
      );
    writeFileSync(
      join(sa, 'jobs/unassigned.json'),
      JSON.stringify({
        id: 'unassigned',
        title: 'legacy task',
        card: null,
        log: null,
        cwd: root,
        kind: 'other',
        model: null,
        role: null,
        wrapper_pid: 0,
        pid: 0,
        started_at: new Date(NOW - 1000).toISOString(),
        ended_at: new Date(NOW).toISOString(),
        state: 'failed',
        exit_code: 143,
      })
    );
    const d = memoryTick({}, NOW, false, true);
    expect(existsSync(join(sa, 'memory'))).toBe(false);
    expect(d.episodes.length).toBeGreaterThan(0);
    expect(d.episodes.some(e => e.id === 'job-unassigned')).toBe(false);
    for (const e of d.episodes) {
      expect(e.tag).toStartWith('strategist:');
      expect(e.category).toBe(e.status === 'done' ? 'plan' : 'role');
    }
    expect(d.errors).toEqual([]);
  });
});

describe('FIXD review regressions', () => {
  // Conformance uses sa-check's written artifacts, including fields absent from hand-built fixtures.
  test.each([true, false])(
    'EV-R1-03 producer accept/settle/gate artifacts fold through memoryTick (success=%s)',
    success => {
      const repo = gitRepo(tmp()),
        script = join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts');
      // Preserve unknown failure evidence while the producer consumes its one repair attempt.
      const cmd = success ? 'exit 0' : 'exit 1';
      plan.packages[0].accept = [{ cmd, timeout_s: 5 }];
      plan.deadline = new Date(Date.now() + 3600000).toISOString();
      writeFileSync(join(ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
      const runCheck = (
        kind: string,
        tag: string,
        inputs: Record<string, string> = {},
        exitCode = 0
      ) => {
        const child = Bun.spawnSync([process.execPath, script], {
          cwd: repo,
          env: {
            ...process.env,
            ARTIFACTS_DIR: artifactsOf(raw),
            INPUTS_KIND: kind,
            INPUTS_TAG: tag,
            INPUTS_PLAN: join(ledger.gen_dir, 'plan.json'),
            INPUTS_POLICY: join(ledger.gen_dir, 'policy.json'),
            INPUTS_PKGS: 'core',
            INPUTS_RISK: 'G1',
            INPUTS_ARCHON: '',
            INPUTS_BASE: '',
            INPUTS_PREV: '',
            INPUTS_CODER: '',
            ...inputs,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(child.exitCode, child.stderr.toString()).toBe(exitCode);
        return readFileSync(join(artifactsOf(raw), `${tag}.json`), 'utf8');
      };
      const accept = runCheck('accept', 'verify-core');
      expect(JSON.parse(accept)).toMatchObject({
        ok: success,
        reason: success ? null : 'acceptance_failed',
        risk: 'G1',
        base_pass: null,
      });
      if (!success)
        expect(JSON.parse(accept)).toMatchObject({
          disposition: 'repair',
          decision: { kind: 'block' },
          failures: [{ command: cmd, failure_class: 'unknown' }],
        });
      const settle = runCheck(
        'settle',
        'settle-core',
        {
          INPUTS_FIRST: String(JSON.parse(accept).disposition),
          INPUTS_REPAIRED: success ? 'null' : JSON.stringify({ status: 'done', error_class: null }),
        },
        success ? 0 : 1
      );
      expect(JSON.parse(settle)).toMatchObject({
        ok: success,
        reason: success ? null : 'repair_exhausted:acceptance_failed',
        disposition: success ? 'advance' : 'fail',
        decision: { kind: success ? 'advance' : 'block' },
      });
      const gate = runCheck(
        'gate',
        'gate-m1-r1',
        {
          INPUTS_ROUND: '1',
          INPUTS_R1: success ? JSON.stringify({ status: 'PASS', findings: [], debt: [] }) : 'null',
          INPUTS_C1: settle,
          INPUTS_MILESTONE: 'm1',
          INPUTS_NEXT: '',
        },
        0
      );
      expect(JSON.parse(gate)).toMatchObject({
        verdict: success ? 'pass' : 'fix',
        reason: success ? null : 'acceptance_failed',
        decision: { kind: success ? 'advance' : 'repair' },
        grade: success ? 'PASS' : null,
      });
      raw.status = success ? 'completed' : 'failed';
      raw.nodes = [
        { nodeId: 'verify-core', state: success ? 'completed' : 'failed' },
        { nodeId: 'settle-core', state: success ? 'completed' : 'failed' },
      ];
      const file = join(root, 'producer-run.json'),
        stub = join(root, 'producer-archon');
      writeFileSync(file, JSON.stringify({ ...raw, events: [] }));
      writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
      process.env.SA_ARCHON_BIN = stub;
      process.env.FAKE_EV1_RUN = file;
      mkdirSync(join(sa, 'runs'));
      writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
      const folded = foldEpisode(ledger, plan, raw, [], {}, NOW);
      expect(folded.acceptance).toEqual([{ cmd, ok: success }]);
      expect(folded.reasons).toEqual(
        success ? [] : ['acceptance_failed', 'repair_exhausted:acceptance_failed']
      );
      expect(memoryTick({}, NOW, false).errors).toEqual([]);
      expect(
        JSON.parse(readFileSync(join(sa, 'memory/fold-index.json'), 'utf8')).terminal.incident
      ).toBeString();
      expect(memoryData(NOW).deliveries.incident).toMatchObject({
        status: raw.status,
        packages: 1,
      });
      expect(existsSync(join(sa, 'memory/errors.jsonl'))).toBe(false);
      if (success) expect(episodes()).toHaveLength(0);
      else
        expect(episodes()[0]).toMatchObject({ status: 'failed', acceptance: [{ cmd, ok: false }] });
    },
    testTimeout(15_000)
  );
  test('EV-R1-01 reflection includes redacted minimal failure evidence, never nested bodies', async () => {
    writeFileSync(
      join(artifactsOf(raw), 'gate-m1-r1.review.json'),
      JSON.stringify({
        status: 'FAIL',
        findings: [
          {
            id: 'f1',
            severity: 'high',
            status: 'open',
            file: 'CLIENT-FILE',
            evidence: {
              customer: 'CUSTOMER-SECRET',
              log: ['LOG-SECRET'],
              nested: { credential: 'UNLABELLED-SECRET' },
            },
          },
        ],
      })
    );
    const e = episode();
    e.acceptance[0].cmd = 'COMMAND-SECRET';
    e.dispositions = [{ at: e.at, reason: 'DISPOSITION-SECRET', action: 'ask', ok: true }];
    // Old episodes can still contain evidence text; the boundary must exclude it independently.
    e.findings.push('LEGACY-SECRET');
    saveEpisode(e);
    let input = '';
    expect(
      reflectOne(NOW, args => {
        if (args[1] === 'runs') return { runs: [] };
        input = args[3] ?? '';
        return { id: 'reflect-run' };
      })
    ).toBe(true);
    for (const secret of [
      'CLIENT-FILE',
      'CUSTOMER-SECRET',
      'LOG-SECRET',
      'UNLABELLED-SECRET',
      'DISPOSITION-SECRET',
    ])
      expect(input).not.toContain(secret);
    expect(input).toContain('acceptance_failed');
    expect(input).toContain('COMMAND-SECRET');
    expect(input).toContain('LEGACY-SECRET');
    expect(input).toContain('"findings":{"total":2}');
  });
  test('EV-R1-03 real gate null review folds end to end; null decision is invalid', () => {
    const repo = gitRepo(root),
      script = join(import.meta.dir, '../templates/.archon/scripts/sa-check.ts');
    const child = Bun.spawnSync([process.execPath, script], {
      cwd: repo,
      env: {
        ...process.env,
        ARTIFACTS_DIR: artifactsOf(raw),
        INPUTS_KIND: 'gate',
        INPUTS_ROUND: '1',
        INPUTS_R1: 'null',
        INPUTS_C1: JSON.stringify({
          ok: false,
          disposition: 'escalate',
          reason: 'acceptance_failed',
          diff_hash: 'x',
          same: false,
          risk: 'G1',
          checkout_fingerprint: checkoutFingerprint(args =>
            Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
          ),
        }),
        INPUTS_RISK: 'G1',
        INPUTS_TAG: 'gate-m1-r1',
        INPUTS_PLAN: join(ledger.gen_dir, 'plan.json'),
        INPUTS_POLICY: join(ledger.gen_dir, 'policy.json'),
        INPUTS_MILESTONE: 'm1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(readFileSync(join(artifactsOf(raw), 'gate-m1-r1.review.json'), 'utf8').trim()).toBe(
      'null'
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(
      JSON.parse(readFileSync(join(artifactsOf(raw), 'gate-m1-r1.json'), 'utf8')).verdict
    ).toBe('fix');
    const file = join(root, 'null-review-run.json'),
      stub = join(root, 'null-review-archon');
    writeFileSync(file, JSON.stringify({ ...raw, events: [] }));
    writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
    expect(memoryTick({}, NOW, false).errors).toEqual([]);
    expect(memoryData(NOW).all[0].status).toBe('failed');
    writeFileSync(join(artifactsOf(raw), 'gate-m1-r1.json'), 'null');
    expect(() => episode()).toThrow();
    writeFileSync(join(artifactsOf(raw), 'gate-m1-r1.json'), '[]');
    expect(() => episode()).toThrow();
  });
  test('EV-R1-04 paused archive later projects engine_suspect terminal and deduplicates mechanism', () => {
    const held = {
      ...raw,
      status: 'paused',
      completed_at: null,
      metadata: {
        wait: {
          nodeId: 'gate',
          kind: 'event',
          event: 'sa.human',
          resumeAt: new Date(NOW + 600000).toISOString(),
          waitingSince: new Date(NOW - 31 * 60000).toISOString(),
        },
      },
      events: [],
    };
    const file = join(root, 'changing-run.json'),
      stub = join(root, 'changing-archon');
    writeFileSync(file, JSON.stringify(held));
    writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    writeFileSync(join(sa, 'runs/incident.json'), JSON.stringify(ledger));
    expect(memoryTick({}, NOW, false).errors).toEqual([]);
    const archive = readFileSync(join(sa, 'memory/episodes/incident.json'), 'utf8');
    mkdirSync(join(sa, 'incidents', ledger.run_id), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ ...held, status: 'failed', completed_at: new Date(NOW).toISOString() })
    );
    expect(memoryTick({}, NOW + 1000, false).errors).toEqual([]);
    memoryTick({}, NOW + 2000, false);
    expect(readFileSync(join(sa, 'memory/episodes/incident.json'), 'utf8')).toBe(archive);
    expect(episodes()[0]).toMatchObject({
      status: 'failed',
      category: 'engine',
      signature: 'engine_suspect',
    });
    expect(memoryData(NOW).queued).toBe(0);
    expect(
      JSON.parse(readFileSync(join(sa, 'memory/mechanize/engine_suspect.json'), 'utf8')).episodes
    ).toEqual(['incident']);
  });
  test('EV-R1-05 cached usage priors derive weighted budget; EV-R1-06 normal terminal deliveries need no episode', () => {
    const model = loadTiers().tiers.general.pools.chatgpt[0],
      events = [
        {
          event_type: 'node_completed',
          step_name: 'code-core',
          created_at: new Date(NOW).toISOString(),
          data: {
            node: { id: 'code-core', kind: 'agent', source: { kind: 'command', name: 'sa-code' } },
            invocation: { id: 'invoke', startedAt: ledger.started_at, loopPath: [] },
            attempt: { id: 'one', startedAt: ledger.started_at },
            binding: {
              provider: 'codex',
              model: { requested: model, resolved: { source: 'provider', value: model } },
            },
            timing: { startedAt: ledger.started_at, durationMs: 60000 },
            spend: {
              costUsd: { source: 'unavailable', reason: 'not_reported' },
              stopReason: { source: 'unavailable', reason: 'not_reported' },
              numTurns: { source: 'unavailable', reason: 'not_reported' },
              tokens: { source: 'provider', value: { input: 100, cacheRead: 90, output: 10 } },
            },
            accounting: 'node',
          },
        },
      ];
    const file = join(root, 'normal-run.json'),
      stub = join(root, 'normal-archon');
    writeFileSync(file, JSON.stringify({ ...raw, status: 'completed', nodes: undefined, events }));
    writeFileSync(stub, '#!/bin/sh\ncat "$FAKE_EV1_RUN"\n', { mode: 0o755 });
    writeFileSync(
      join(artifactsOf(raw), 'verify-core.json'),
      JSON.stringify({ ok: true, reason: 'review_not_required' })
    );
    process.env.SA_ARCHON_BIN = stub;
    process.env.FAKE_EV1_RUN = file;
    mkdirSync(join(sa, 'runs'));
    foldEpisode(ledger, plan, { ...raw, status: 'completed', nodes: undefined }, events, {}, NOW);
    for (let i = 0; i < 5; i++)
      writeFileSync(
        join(sa, 'runs', `quiet${i}.json`),
        JSON.stringify({ ...ledger, run_id: `quiet${i}` })
      );
    expect(memoryTick({}, NOW, false).errors).toEqual([]);
    expect(episodes()).toHaveLength(5);
    expect(existsSync(join(sa, 'memory/mechanize/review_not_required.json'))).toBe(false);
    expect(coordination.coord().messages()).toHaveLength(0);
    const priors = JSON.parse(readFileSync(join(sa, 'memory/priors.json'), 'utf8'));
    expect(priors[priorKey(root, plan.packages[0], model)]).toMatchObject({
      n: 5,
      tokens: { n: 5, p50: 20 },
    });
    expect(
      lintPlan(
        {
          ...plan,
          deadline: new Date(NOW + 3600000).toISOString(),
          budget: { ...plan.budget, weighted_tokens: 50 },
        },
        undefined,
        NOW
      ).rejected
    ).toBe(false);
    expect(Object.values(memoryData(NOW).deliveries)).toEqual(
      Array(5).fill({ status: 'completed', packages: 1, tokens: 110 })
    );
  });
});

afterAll(() => engineBoundary.mockRestore());
