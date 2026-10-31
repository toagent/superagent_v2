import { describe, expect, test, spyOn } from 'bun:test';
import { testTimeout } from '@archon/paths/test-utils';
import * as archonModule from '../src/archon';
import * as coordination from '../src/coord';
import { engineHash } from '../src/generate';
import { fixtureArchon, fixtureOptions } from './fixtures/archon-stub';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { lastJson, recover, reusedOwnerPid, type RunView } from '../src/archon';
import { classify, EXIT, main, loadLedger, type Ledger } from '../src/cli';
import { recoverySnapshot, unknownEffects } from '../src/recovery';
import { loadTiers, snapshotPolicy, WETAMP } from '../src/config';
import { gitRepo, fixtureEnv, sh, tmp } from './helpers';
import {
  validateRecovery,
  recoveryHash,
  ledgerOf,
  type RecoveryEvidence,
  type RecoveryAuthorCoverage,
  type Review,
  type Accept,
  reviewRoundLimit,
} from '../templates/.archon/scripts/sa-check';
import type { Plan } from '../src/plan';

const MAX_ROUNDS = reviewRoundLimit(snapshotPolicy(loadTiers()));

test('recover refuses a deleted working_path before admission or launch', () => {
  // prettier-ignore
  const root = tmp(), repo = gitRepo(root), home = join(root, 'home'), dir = join(root, 'stub');
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'used'), { recursive: true });
  const missing = join(root, 'missing-worktree');
  // prettier-ignore
  writeFileSync(join(dir, 'get-000.json'), JSON.stringify({ id: 'old', status: 'failed', working_path: missing }));
  const env = { ...process.env };
  // prettier-ignore
  Object.assign(process.env, { ...fixtureEnv(), SUPERAGENT_HOME: home, ARCHON_HOME: join(home, 'archon') });
  // prettier-ignore
  const transport = spyOn(archonModule, 'archon').mockImplementation(args => fixtureArchon(dir, args));
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    // prettier-ignore
    const ledger: Ledger = { run_id: 'operator', archon_run_id: 'old', repo, branch: 'sa/operator', workflow: 'sa-operator', workflow_hash: engineHash(), engine_hash: engineHash(), gen_dir: join(root, 'gen'), plan: '', console: 'codex', started_at: '', log: '', transcript: '', controller: coordination.coord().claim(coordination.repoScope(repo), coordination.caller()).controller };
    writeFileSync(join(home, 'runs/operator.json'), JSON.stringify(ledger));
    expect(main(['recover', 'operator'])).toBe(1);
    // prettier-ignore
    expect(JSON.parse(output.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({ reason: 'environment', working_path: missing });
    expect(existsSync(join(home, 'archon/execution-admissions/old.json'))).toBe(false);
    expect(readFileSync(join(dir, 'calls'), 'utf8')).not.toContain('workflow resume');
  } finally {
    transport.mockRestore();
    output.mockRestore();
    process.env = env;
  }
});

test('recover resumes when working_path was not recorded', () => {
  // prettier-ignore
  const root = tmp(), repo = gitRepo(root), home = join(root, 'home'), dir = join(root, 'stub');
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'used'), { recursive: true });
  const run = { id: 'old', status: 'failed' };
  writeFileSync(join(dir, 'get-000.json'), JSON.stringify(run));
  const env = { ...process.env };
  // prettier-ignore
  Object.assign(process.env, { ...fixtureEnv(), SUPERAGENT_HOME: home, ARCHON_HOME: join(home, 'archon') });
  const transport = spyOn(archonModule, 'archon').mockImplementation(args =>
    args[1] === 'get' ? { code: 0, out: JSON.stringify(run), err: '' } : fixtureArchon(dir, args)
  );
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    // prettier-ignore
    const ledger: Ledger = { run_id: 'operator', archon_run_id: 'old', repo, branch: 'sa/operator', workflow: 'sa-operator', workflow_hash: engineHash(), engine_hash: engineHash(), gen_dir: join(root, 'gen'), plan: '', console: 'codex', started_at: '', log: '', transcript: '', controller: coordination.coord().claim(coordination.repoScope(repo), coordination.caller()).controller };
    writeFileSync(join(home, 'runs/operator.json'), JSON.stringify(ledger));
    expect(main(['recover', 'operator'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain(
      'workflow resume old --detach --json'
    );
  } finally {
    transport.mockRestore();
    output.mockRestore();
    process.env = env;
  }
});

test.each([false, true])(
  'RETRY_NODE_PROGRESS completed=%s selects restart or resume',
  completed => {
    const root = tmp(),
      repo = gitRepo(root),
      home = join(root, 'home'),
      dir = join(root, 'stub');
    mkdirSync(join(home, 'runs'), { recursive: true });
    mkdirSync(join(dir, 'used'), { recursive: true });
    const run: RunView = {
      id: 'old',
      status: 'failed',
      working_path: repo,
      nodes: [
        ...(completed ? [{ nodeId: 'prepare', state: 'completed' }] : []),
        { nodeId: 'environment', state: 'failed', error: 'environment fixture failure' },
      ],
    };
    writeFileSync(join(dir, 'get-000.json'), JSON.stringify(run));
    fixtureOptions(dir, {
      launchReply: { ok: true, runId: 'new', logPath: 'new-log', transcriptPath: 'new-transcript' },
    });
    const env = { ...process.env };
    Object.assign(process.env, {
      ...fixtureEnv(),
      SUPERAGENT_HOME: home,
      ARCHON_HOME: join(home, 'archon'),
    });
    const transport = spyOn(archonModule, 'archon').mockImplementation(args =>
      fixtureArchon(dir, args)
    );
    const clean = spyOn(coordination, 'cleanEngine').mockReturnValue('a'.repeat(40));
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ledger: Ledger = {
        run_id: 'operator',
        archon_run_id: 'old',
        repo,
        branch: 'sa/operator',
        workflow: 'sa-operator',
        workflow_hash: engineHash(),
        engine_hash: engineHash(),
        gen_dir: join(root, 'gen'),
        plan: '',
        console: 'codex',
        started_at: '',
        log: 'old-log',
        transcript: 'old-transcript',
        controller: coordination.coord().claim(coordination.repoScope(repo), coordination.caller())
          .controller,
      };
      mkdirSync(ledger.gen_dir);
      writeFileSync(join(ledger.gen_dir, 'plan.json'), JSON.stringify({ packages: [] }));
      writeFileSync(join(home, 'runs/operator.json'), JSON.stringify(ledger));
      expect(main(['decide', 'operator', 'retry'])).toBe(0);
      const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
      if (completed) {
        expect(calls).toContain('workflow resume old --detach --json');
        expect(calls.some(c => c.startsWith('workflow run'))).toBe(false);
        expect(loadLedger('operator').archon_run_id).toBe('old');
      } else {
        expect(calls).toContain(
          `workflow run sa-operator --branch sa/operator --supersedes old --workflow-source ${ledger.gen_dir} --cwd ${repo} --detach --json`
        );
        expect(calls.some(c => c.startsWith('workflow resume'))).toBe(false);
        expect(loadLedger('operator')).toMatchObject({
          run_id: 'operator',
          archon_run_id: 'new',
          controller: ledger.controller,
          gen_dir: ledger.gen_dir,
          log: 'new-log',
          transcript: 'new-transcript',
          adoptions: [{ from: 'old', to: 'new', reason: 'zero_completed' }],
        });
        expect(JSON.parse(readFileSync(join(dir, 'get-000.json'), 'utf8'))).toEqual(run);
      }
    } finally {
      transport.mockRestore();
      clean.mockRestore();
      output.mockRestore();
      process.env = env;
    }
  }
);

function checkRecovery(limit: number): void {
  const root = tmp(),
    repo = gitRepo(root),
    jobs = join(root, 'jobs');
  mkdirSync(jobs);
  mkdirSync(join(root, 'artifacts/runs/old'), { recursive: true });
  const save = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return { path, sha256: recoveryHash(path) };
  };
  const base = sh('git rev-parse HEAD', repo).trim();
  // Protocol fixtures stay compact so the recorded-round chain is visible together.
  // prettier-ignore
  const p: Plan = { repo, base_ref: base, budget: { weighted_tokens: 100000 }, packages: [{
    id: 'pkg', title: 'pkg', goal: 'recover', risk: 'G2', size: 'S', scope: { write: ['README.md'] },
    accept: [{ cmd: 'test -f README.md', timeout_s: 5 }],
  }] };
  // prettier-ignore
  const original = { id: 'old', output_root: root, events: [{ event_type: 'node_completed', step_name: 'code-pkg',
    data: { binding: { model: { requested: 'author', resolved: { source: 'provider' as const, value: 'author' } } } },
  }] };
  // prettier-ignore
  const e: RecoveryEvidence = { run_id: 'operator', engine_run_id: 'old', base, candidate: '', packages: ['pkg'],
    admission: { kind: 'owner_legacy_snapshot', reason: 'Owner admits current snapshots, not historical input hashes' },
    plan: save('plan.json', p), policy: save('policy.json', snapshotPolicy(loadTiers())),
    contracts: save('accept-inputs.json', []), exception: save('exception.json', {}), author_coverage: save('authors.json', {}), rounds: [],
  };
  let previous = base;
  const native = (id: string, role: 'general' | 'strategist', result: string, model: string) => {
    const card = join(root, `${id}.md`);
    writeFileSync(card, 'frozen card');
    // prettier-ignore
    const job = save(`jobs/${id}.json`, { id, state: 'done', exit_code: 0, role, session_id: id, card, kind: 'claude', cwd: repo });
    const path = join(root, `${id}.jsonl`);
    // prettier-ignore
    const entries = [ { type: 'user', sessionId: id, message: { content: card } },
      { type: 'assistant', sessionId: id, message: { model, content: [{ type: 'text', text: result }] } } ];
    writeFileSync(path, entries.map(x => JSON.stringify(x)).join('\n'));
    return { job_id: id, job, native: { path, sha256: recoveryHash(path) } };
  };
  for (let i = 0; i <= limit; i++) {
    writeFileSync(join(repo, 'README.md'), `round ${String(i)}`);
    sh(
      `git add README.md && git -c user.name=t -c user.email=t@l commit -qm round-${String(i)}`,
      repo
    );
    const head = sh('git rev-parse HEAD', repo).trim();
    // prettier-ignore
    const raw = { conclusion: i === limit ? 'PASS' : 'FAIL', new_blockers: [], findings: [
      { id: 'H1', severity: 'high', disposition: i ? 'CLOSED' : 'OPEN', evidence: 'actual closure evidence' },
      { id: 'L1', severity: 'low', disposition: 'DEBT', evidence: 'retained debt' },
    ] };
    // prettier-ignore
    const review: Review = { status: i === limit ? 'PASS' : 'FAIL', debt: [], findings: raw.findings.map(f => ({
      id: f.id, severity: f.severity as 'high' | 'low', file: 'README.md', line: 1,
      status: f.disposition === 'CLOSED' ? 'closed' : 'open', evidence: f.evidence, carry_over: i > 0, failure_class: 'product',
    })) };
    const result = JSON.stringify(raw),
      reviewer = native(`review-${String(i)}`, 'strategist', result, 'reviewer');
    // prettier-ignore
    e.rounds.push({ logical_round: i + 1, descriptor_round: Math.min(i + 1, limit),
      freeze: save(`freeze-${String(i)}.json`, { run_id: e.run_id, base, head, previous, worktree: repo,
        ...(i === limit ? { logical_review_round: limit + 1, cli_descriptor_round: limit, user_exception: { reply: 'yes', scope: 'one final review beyond the limit' } } : {}),
        files: { 'README.md': recoveryHash(join(repo, 'README.md')) } }),
      source: save(`review-${String(i)}.json`, raw), review, reviewer,
      provider_result: { ...save(`provider-${String(i)}.json`, { type: 'result', subtype: 'success', is_error: false, session_id: reviewer.job_id, result, modelUsage: { reviewer: {} } }), json_offset: 0, json_length: Buffer.byteLength(result) },
      authors: [native(`author-${String(i)}`, 'general', 'implemented', 'author'),
        ...(i === 2 ? [native('author-2-extra', 'general', 'implemented', 'author')] : [])], coverage: { base: previous, head, files: ['README.md'] },
    });
    previous = head;
  }
  e.candidate = previous;
  e.exception = e.rounds[limit].freeze;
  const roster: RecoveryAuthorCoverage = {
    run_id: e.run_id,
    engine_run_id: e.engine_run_id,
    base,
    candidate: e.candidate,
    rounds: e.rounds.map(r => ({
      logical_round: r.logical_round,
      freeze: r.freeze,
      job_ids: r.authors.map(a => a.job_id),
    })),
  };
  e.author_coverage = save('authors.json', roster);
  const run = (value = e) =>
    validateRecovery(value, p, repo, 'operator', 'old', () => original, jobs);
  const out = run();
  expect(ledgerOf(out.reviews, 'G2').debt.map(x => x.id)).toEqual(['L1']);
  const invalid = (change: (x: RecoveryEvidence) => void, reason: string) => {
    const copy = structuredClone(e);
    change(copy);
    expect(() => run(copy)).toThrow(reason);
  };
  // prettier-ignore
  const cases: [(x: RecoveryEvidence) => void, string][] = [
    [x => { x.engine_run_id = 'wrong'; }, 'run binding'],
    [x => { x.candidate = base; }, 'candidate drift'],
    [x => { x.rounds.pop(); }, 'complete rounds'],
    [x => { x.rounds[limit].review.status = 'FAIL'; }, 'non-PASS final'],
    [x => { x.rounds[limit].reviewer.job_id = 'wrong'; }, 'job registry binding'],
    [x => { x.rounds[0].authors = []; }, 'support author coverage'],
    [x => { x.author_coverage.sha256 = 'wrong'; }, 'source drift'],
    [x => { delete (x as Partial<RecoveryEvidence>).author_coverage; }, 'support author coverage required'],
    ...(limit === MAX_ROUNDS ? [] : [
      [x => { x.admission.kind = 'wrong' as 'owner_legacy_snapshot'; }, 'owner admission'],
      [x => { x.plan.sha256 = 'wrong'; }, 'source drift'],
      [x => { x.rounds[1].coverage.base = base; }, 'incremental coverage'],
      [x => { x.rounds[1].coverage.files = []; }, 'missing coverage'],
      [x => { x.rounds[1].review.findings.shift(); }, 'finding coverage'],
      [x => { x.rounds[1].review.findings[0].evidence = ''; }, 'finding interpretation'],
      [x => { x.rounds[2].authors.pop(); }, 'support author coverage'],
      [x => { x.rounds[2].authors[1] = x.rounds[2].authors[0]; }, 'support author coverage'],
      [x => { x.rounds[2].authors[1] = x.rounds[1].authors[0]; }, 'support author coverage'],
    ] as [(x: RecoveryEvidence) => void, string][]),
  ];
  for (const [change, reason] of cases) invalid(change, reason);
  // A ref-shaped option must fail before Git can write its --output destination.
  const destination = join(root, 'injected-diff');
  for (const head of [`--output=${destination}`, '--stat', 'HEAD']) {
    invalid(x => {
      const f = JSON.parse(readFileSync(x.rounds[1].freeze.path, 'utf8')) as { head: string };
      f.head = head;
      x.rounds[1].freeze = save('invalid-freeze.json', f);
      x.rounds[1].coverage.head = head;
    }, 'invalid freeze refs');
    expect(existsSync(destination)).toBe(false);
  }
  if (limit !== MAX_ROUNDS) {
    const frozen = save('recovery.json', e),
      current = save('current.json', { id: 'new', adopted_from_run_id: 'old', events: [] });
    const bin = join(root, 'archon');
    const old = save('original.json', original);
    writeFileSync(bin, `#!/bin/sh\ncat '${old.path}'\n`);
    chmodSync(bin, 0o755);
    // prettier-ignore
    const env = { ...fixtureEnv(), WORKFLOW_ID: 'new', ARTIFACTS_DIR: join(root, 'artifacts'), SUPERAGENT_HOME: root,
      INPUTS_ARCHON: bin, INPUTS_EVENTS_FILE: current.path, INPUTS_PLAN: e.plan.path, INPUTS_POLICY: e.policy.path,
      INPUTS_BASE: base, INPUTS_PKGS: 'pkg', INPUTS_SCOPE_PKGS: 'pkg', INPUTS_RISK: 'G2', INPUTS_MILESTONE: 'm1',
    };
    const check = (input: Record<string, string>) =>
      Bun.spawnSync([process.execPath, join(WETAMP, 'templates/.archon/scripts/sa-check.ts')], {
        cwd: repo,
        env: { ...env, ...input },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15000,
      });
    const accepted = check({ INPUTS_KIND: 'accept', INPUTS_TAG: `diff-m1-r${String(limit + 1)}` });
    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
    const finalCheck = JSON.parse(
      readFileSync(join(root, `artifacts/diff-m1-r${String(limit + 1)}.json`), 'utf8')
    ) as Accept;
    const gate = check({
      INPUTS_KIND: 'gate',
      INPUTS_TAG: `gate-m1-r${String(limit + 1)}`,
      INPUTS_ROUND: String(limit + 1),
      INPUTS_OPERATOR_ID: e.run_id,
      INPUTS_RECOVERY_EVIDENCE: frozen.path,
      INPUTS_RECOVERY_SHA256: frozen.sha256,
      INPUTS_C1: 'null',
      INPUTS_C2: 'null',
      INPUTS_C3: 'null',
      [`INPUTS_C${String(limit + 1)}`]: JSON.stringify(finalCheck),
    });
    expect(gate.exitCode, gate.stderr.toString()).toBe(0);
    const result = JSON.parse(
      readFileSync(join(root, `artifacts/gate-m1-r${String(limit + 1)}.json`), 'utf8')
    ) as { verdict: string; grade: string; debt: string[] };
    expect(result.verdict).toBe('pass');
    expect(result.grade).toBe('PASS');
    expect(result.debt.length).toBeGreaterThan(0);
    writeFileSync(frozen.path, '{}');
    expect(
      check({
        INPUTS_KIND: 'gate',
        INPUTS_RECOVERY_EVIDENCE: frozen.path,
        INPUTS_RECOVERY_SHA256: frozen.sha256,
      }).exitCode
    ).not.toBe(0);
  }
  const author = e.rounds[limit].authors[0];
  const text = readFileSync(author.native.path, 'utf8').replace(
    '"model":"author"',
    '"model":"reviewer"'
  );
  writeFileSync(author.native.path, text);
  author.native.sha256 = recoveryHash(author.native.path);
  expect(() => run()).toThrow('review not independent');
}

test.each([3, MAX_ROUNDS])(
  'RECOVERY_CONTINUATION recorded limit %i binds full native history and rejects unsafe reuse',
  checkRecovery,
  testTimeout(10_000)
);

async function until(check: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error('barrier timed out');
    await Bun.sleep(50);
  }
}

describe('recovery ownership and effects', () => {
  test('owner lost after a node started, remote owner, and reused PID are held with no guessed terminal transition', () => {
    // Detached launch before the child claims the row: still starting, wait keeps waiting.
    expect(classify({ id: 'r', status: 'pending' })).toEqual({
      state: 'pending',
      exit: EXIT.running,
    });
    // A claim binds the owner with the status, so a running row recording no owner has
    // either not reached that write (still starting, keep waiting) or lost it after a node
    // began — only the latter is ambiguity about a live execution.
    expect(classify({ id: 'r', status: 'running' })).toEqual({
      state: 'running',
      exit: EXIT.running,
    });
    for (const r of [
      { id: 'r', status: 'running', nodes: [{ nodeId: 'code', state: 'running' }] },
      { id: 'r', status: 'running', metadata: { execution_owner: { host: 'remote', pid: 10 } } },
    ] satisfies RunView[])
      expect(classify(r)).toEqual({ state: 'held:owner_unknown', exit: EXIT.held });
    const reused: RunView = {
      id: 'r',
      status: 'running',
      started_at: '2000-01-01T00:00:00Z',
      metadata: { execution_owner: { host: hostname(), pid: process.pid } },
    };
    expect(reusedOwnerPid(reused)).toBe(true);
    expect(classify(reused).state).toBe('held:owner_unknown');
  });

  test('land is instruction generation: missing or mismatched output is unknown; matching checkout output reconciles', () => {
    const root = tmp(),
      repo = gitRepo(root),
      artifacts = join(root, 'artifacts/runs/r');
    mkdirSync(artifacts, { recursive: true });
    const run: RunView = {
      id: 'r',
      status: 'running',
      output_root: root,
      working_path: repo,
      nodes: [{ nodeId: 'land', state: 'running' }],
    };
    expect(unknownEffects(run)).toEqual(['land']);
    const receipt = {
      branch: 'main',
      head: sh('git rev-parse HEAD', repo).trim(),
      commands: ['switch main', 'merge branch'],
    };
    writeFileSync(join(artifacts, 'land.json'), JSON.stringify({ ...receipt, head: 'old' }));
    expect(unknownEffects(run)).toEqual(['land']);
    writeFileSync(join(artifacts, 'land.json'), JSON.stringify(receipt));
    expect(unknownEffects(run)).toEqual([]);
    run.nodes = [{ nodeId: 'land-m2', state: 'running' }];
    writeFileSync(join(artifacts, 'land-m1.json'), JSON.stringify(receipt));
    expect(unknownEffects(run)).toEqual(['land-m2']);
    writeFileSync(join(artifacts, 'land-m2.json'), JSON.stringify(receipt));
    expect(unknownEffects(run)).toEqual([]);
    run.nodes?.push(
      { nodeId: 'code-W1', state: 'running' },
      { nodeId: 'verify-W2', state: 'running' }
    );
    expect(unknownEffects(run)).toEqual(['code-W1', 'verify-W2']);
    run.status = 'paused';
    run.metadata = { approval: { nodeId: 'code-W1' } };
    expect(unknownEffects(run)).toEqual(['verify-W2']);
  });

  test('running PUBLISH requires durable authorization before recovery can replay it', () => {
    const root = tmp(),
      repo = gitRepo(root),
      sa = join(root, 'sa'),
      gen = join(root, 'gen');
    mkdirSync(join(sa, 'runs'), { recursive: true });
    mkdirSync(gen);
    const ledger = {
      run_id: 'r',
      archon_run_id: 'r',
      repo,
      branch: 'sa/r',
      gen_dir: gen,
      workflow: 'sa-r',
      delivery: { checkout: repo, branch: 'main', head: sh('git rev-parse HEAD', repo).trim() },
    };
    writeFileSync(join(sa, 'runs/r.json'), JSON.stringify(ledger));
    const env = { ...process.env };
    Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: join(sa, 'archon') });
    try {
      const run: RunView = {
        id: 'r',
        status: 'running',
        working_path: repo,
        nodes: [{ nodeId: 'integrate-m1.publish-m1', state: 'running' }],
      };
      expect(unknownEffects(run)).toEqual(['integrate-m1.publish-m1']);
      writeFileSync(join(gen, 'delivery-authorization.json'), '{}');
      expect(unknownEffects(run)).toEqual([]);
    } finally {
      process.env = env;
    }
  });

  test(
    'DURABLE_DELIVERY recovery preserves unknown legacy land effects',
    () => {
      const root = tmp(),
        sa = join(root, 'sa'),
        ah = join(sa, 'archon'),
        bin = join(root, 'archon');
      mkdirSync(ah, { recursive: true });
      const run: RunView = {
        id: 'r',
        status: 'running',
        metadata: { execution_owner: { host: hostname(), pid: 4194305 } },
        nodes: [{ nodeId: 'land', state: 'running', startedAt: '2026-10-11T00:00:00Z' }],
      };
      writeFileSync(
        bin,
        `#!/usr/bin/env bash\nif [ "$2" = get ]; then cat '${join(root, 'run.json')}'; else echo resume >> '${join(root, 'calls')}'; echo '{"ok":true}'; fi\n`
      );
      chmodSync(bin, 0o755);
      writeFileSync(join(root, 'run.json'), JSON.stringify(run));
      const db = new Database(join(ah, 'archon.db'));
      db.run(
        'create table remote_agent_workflow_runs(id text, status text, metadata text, started_at text)'
      );
      db.run('insert into remote_agent_workflow_runs values (?, ?, ?, null)', [
        'r',
        'running',
        JSON.stringify(run.metadata),
      ]);
      const env = { ...process.env };
      Object.assign(process.env, {
        ...fixtureEnv(),
        SUPERAGENT_HOME: sa,
        ARCHON_HOME: ah,
        SA_ARCHON_BIN: bin,
      });
      try {
        expect(recover('r')).toMatchObject({
          held: true,
          reason: 'effects_unknown',
          nodes: ['land'],
        });
        expect(
          recover('r', undefined, undefined, undefined, undefined, undefined, 'old')
        ).toMatchObject({ reason: 'effects_unknown' });
        expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
          status: 'running',
        });
        expect(existsSync(join(root, 'calls'))).toBe(false);
        expect(
          recover('r', undefined, undefined, undefined, undefined, undefined, recoverySnapshot(run))
            .ok
        ).toBe(true);
        expect(recover('r')).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
      } finally {
        process.env = env;
        db.close();
      }
    },
    testTimeout(10_000)
  );

  test('lost launch acknowledgements fence both resume and engine adoption without repeating launch', () => {
    for (const adopt of [false, true]) {
      const root = tmp(),
        sa = join(root, 'sa'),
        ah = join(sa, 'archon'),
        bin = join(root, 'archon');
      mkdirSync(ah, { recursive: true });
      const run: RunView = {
        id: 'r',
        status: 'failed',
        metadata: {
          execution_owner: { host: hostname(), pid: process.pid },
          superagent_recovery: {
            token: 'previous-generation',
            owner: { host: hostname(), pid: 4194305 },
            started_at: null,
          },
        },
      };
      writeFileSync(
        bin,
        `#!/usr/bin/env bash\nif [ "$2" = get ]; then echo '${JSON.stringify(run)}'; else echo launch >> '${join(root, 'calls')}'; fi\n`
      );
      chmodSync(bin, 0o755);
      const env = { ...process.env };
      Object.assign(process.env, {
        ...fixtureEnv(),
        SUPERAGENT_HOME: sa,
        ARCHON_HOME: ah,
        SA_ARCHON_BIN: bin,
      });
      try {
        const strategy = adopt
          ? {
              lockId: 'r',
              resolveId: () => 'r',
              adopt: () => ['workflow', 'run', 'fixture', '--detach', '--json'],
            }
          : undefined;
        const first = recover('r', undefined, undefined, undefined, undefined, strategy);
        expect(first).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
        if (!first.ok) expect(existsSync(first.evidence ?? '')).toBe(true);
        expect(classify(run).state).toBe('held:recovery_admission_unknown');
        expect(recover('r', undefined, undefined, undefined, undefined, strategy)).toMatchObject({
          held: true,
          reason: 'recovery_admission_unknown',
        });
        expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
        writeFileSync(join(ah, 'execution-admissions/r.json'), '{broken');
        expect(classify(run).state).toBe('held:recovery_admission_unknown');
        expect(recover('r')).toMatchObject({ held: true, reason: 'recovery_admission_unknown' });
      } finally {
        process.env = env;
      }
    }
  });
});

describe('stop-gate kernel lock (Node processes)', () => {
  const hook = join(WETAMP, 'hooks/stop-gate.cjs');
  const child = (file: string, body: string) =>
    Bun.spawn(
      [
        'node',
        '-e',
        `const {withState}=require(${JSON.stringify(hook)}); try {withState(${JSON.stringify(file)}, s=>{${body}})} catch(e) {console.error(e.message); process.exit(2)}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );

  test('a slow live owner outlives the former 15s stale threshold without losing its lock', async () => {
    const root = tmp(),
      file = join(root, 'state.json'),
      ready = join(root, 'ready');
    const first = child(
      file,
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,16000); s.count=(s.count||0)+1;`
    );
    try {
      await until(() => existsSync(ready));
      const ino = statSync(`${file}.lock`).ino;
      utimesSync(`${file}.lock`, new Date(0), new Date(0));
      const second = child(file, 's.count=(s.count||0)+1;');
      expect(await second.exited).toBe(2);
      expect(await new Response(second.stderr).text()).toContain('状态锁忙');
      expect(statSync(`${file}.lock`).ino).toBe(ino);
      expect(await first.exited).toBe(0);
      expect(await child(file, 's.count=(s.count||0)+1;').exited).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 2 });
      expect(statSync(`${file}.lock`).ino).toBe(ino);
    } finally {
      first.kill();
      await first.exited;
    }
  }, 30000);

  test('SIGKILL releases the lock, and an old lock file remains a single inode', async () => {
    const root = tmp(),
      file = join(root, 'state.json'),
      ready = join(root, 'ready');
    const first = child(
      file,
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);`
    );
    try {
      await until(() => existsSync(ready));
      first.kill('SIGKILL');
      await first.exited;
      expect(await child(file, 's.recovered=true;').exited).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ recovered: true });
    } finally {
      first.kill();
      await first.exited;
    }
  });
});

test('real Archon CAS/new-owner barrier fences two complete recover CLI processes', async () => {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa'),
    gen = join(root, 'gen');
  const barrier = join(root, 'owner-barrier'),
    release = join(root, 'owner-release');
  mkdirSync(join(gen, '.archon/workflows'), { recursive: true });
  writeFileSync(
    join(gen, '.archon/workflows/fence.yaml'),
    `name: fence\ndescription: deterministic recovery ownership barrier fixture\nnodes:\n  - id: start\n    bash: echo ready\n  - id: work\n    depends_on: [start]\n    bash: echo $$ > "$ARTIFACTS_DIR/child.pid"; exec sleep 60\n`
  );
  sh(
    'git init -q && git add .archon && git -c user.name=t -c user.email=t@l commit -qm fixture',
    gen
  );
  const driver = join(root, 'archon-driver.ts');
  const dbSource = join(WETAMP, '../packages/core/src/db/workflows.ts');
  const cliSource = join(WETAMP, '../packages/cli/src/cli.ts');
  writeFileSync(
    driver,
    `import {spyOn} from 'bun:test';
    import * as db from ${JSON.stringify(dbSource)};
    import {existsSync, writeFileSync} from 'node:fs';
    const update=db.updateWorkflowRun;
    if (process.env.REC_BARRIER === '1' && !process.argv.includes('--detach')) spyOn(db,'updateWorkflowRun').mockImplementation(async (id, input)=>{
      if (input.metadata?.execution_owner) {writeFileSync(${JSON.stringify(barrier)}, String(process.pid));
        for (const end=Date.now()+30000; !existsSync(${JSON.stringify(release)});) {if(Date.now()>end) throw Error('owner barrier deadline'); await Bun.sleep(20);}}
      return update(id,input);
    });
    await import(${JSON.stringify(cliSource)});`
  );
  const shim = join(root, 'archon');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec '${process.execPath}' '${driver}' "$@"\n`);
  chmodSync(shim, 0o755);
  const env = {
    ...fixtureEnv(),
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: join(sa, 'archon'),
    SA_ARCHON_BIN: shim,
    XDG_STATE_HOME: join(root, 'state'),
    DATABASE_URL: '',
    SA_SKIP_DOCTOR: '1',
    SA_LAUNCHD_DIR: join(root, 'LaunchAgents'),
    REC_BARRIER: '0',
  };
  const call = (args: string[]) => {
    const p = Bun.spawnSync([shim, ...args], {
      cwd: repo,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    });
    if (p.exitCode !== 0)
      throw new Error(`archon fixture ${args[1]}: ${p.stderr.toString()} ${p.stdout.toString()}`);
    return lastJson(p.stdout.toString());
  };
  let owner: number | undefined, nodePid: number | undefined, runId: string | undefined;
  try {
    const install = Bun.spawnSync(['bash', join(WETAMP, 'scripts/install.sh')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    });
    if (install.exitCode !== 0) {
      throw new Error(`install fixture: ${install.stderr.toString()} ${install.stdout.toString()}`);
    }
    expect(install.exitCode).toBe(0);
    const ack = call([
      'workflow',
      'run',
      'fence',
      '--workflow-source',
      gen,
      '--cwd',
      repo,
      '--detach',
      '--json',
    ]);
    runId = String(ack?.runId);
    let view: RunView | undefined;
    await until(() => {
      view = call(['workflow', 'get', runId ?? '', '--verbose', '--json']) as unknown as RunView;
      return view.nodes?.some(n => n.nodeId === 'work' && n.state === 'running') ?? false;
    });
    owner = view?.metadata?.execution_owner?.pid;
    expect(owner).toBeDefined();
    const pidPath = join(view?.output_root ?? '', 'artifacts/runs', runId, 'child.pid');
    await until(() => existsSync(pidPath));
    nodePid = Number(readFileSync(pidPath, 'utf8'));
    process.kill(owner ?? -1, 'SIGKILL');
    await until(() => {
      try {
        process.kill(owner ?? -1, 0);
        return false;
      } catch {
        return true;
      }
    });
    process.kill(nodePid, 'SIGKILL');
    const before = call(['workflow', 'get', runId, '--verbose', '--json']) as unknown as RunView;
    const recoverCli = (reconciled?: string) =>
      Bun.spawn(
        [
          join(WETAMP, 'bin/superagent'),
          'recover',
          runId ?? '',
          ...(reconciled ? ['--reconciled', reconciled] : []),
        ],
        { cwd: repo, env: { ...env, REC_BARRIER: '1' }, stdout: 'pipe', stderr: 'pipe' }
      );
    const first = recoverCli(recoverySnapshot(before));
    const firstOut = new Response(first.stdout).text(),
      firstErr = new Response(first.stderr).text();
    const firstCode = await first.exited;
    if (firstCode !== 0) {
      const result = lastJson(await firstOut);
      const evidence =
        typeof result?.evidence === 'string' ? readFileSync(result.evidence, 'utf8') : '';
      throw new Error(`first recover: ${await firstOut} ${await firstErr} ${evidence}`);
    }
    expect(lastJson(await firstOut)?.ok).toBe(true);
    await until(() => existsSync(barrier));
    const second = recoverCli();
    expect(await second.exited).toBe(EXIT.held);
    expect(lastJson(await new Response(second.stdout).text())).toMatchObject({
      ok: false,
      held: true,
      reason: 'recovery_admission_unknown',
    });
    const between = call(['workflow', 'get', runId, '--verbose', '--json']) as unknown as RunView;
    expect(between.status).toBe('running');
    expect(between.metadata?.execution_owner?.pid).toBe(owner);
    writeFileSync(release, 'release');
    await until(() => {
      const current = call([
        'workflow',
        'get',
        runId ?? '',
        '--verbose',
        '--json',
      ]) as unknown as RunView;
      return current.metadata?.execution_owner?.pid !== owner;
    });
  } finally {
    writeFileSync(release, 'release');
    if (runId) call(['workflow', 'abandon', runId, '--json']);
    for (const pid of [owner, nodePid])
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
  }
}, 120000);
