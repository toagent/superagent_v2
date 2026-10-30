import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { Database } from 'bun:sqlite';
import * as archon from '../src/archon';
import { executionAdmissionLock } from '@archon/workflows/execution-lifecycle';
import { testTimeout } from '@archon/paths/test-utils';
import { lock } from '../src/archon';
import { inspectProcess } from '../src/launcher';
import * as coordination from '../src/coord';
import { artifactsOf, ledgerPath, loadLedger, main, type Ledger } from '../src/cli';
import { collectEngineSnapshots, gc as collect } from '../src/gc';
import { fixturePlan, gitRepo, tmp } from './helpers';

const keys = [
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SUPERAGENT_WRITE_ROOTS',
  'TMPDIR',
  'SA_ARCHON_BIN',
  'SUPERAGENT_ROLE',
  'SA_JOB_ID',
  'SA_LAUNCHD_DIR',
] as const;
const originalEnv = keys.map(k => process.env[k]);
const gc = (dryRun = false, ruleVersion?: string) =>
  collect(dryRun, [process.env.TMPDIR!], ruleVersion);
const realTrees = () => Bun.spawnSync(['git', 'worktree', 'list', '--porcelain']).stdout.toString();
const initialTrees = realTrees();
afterAll(() => expect(realTrees()).toBe(initialTrees));
const views = new Map<string, archon.RunView>();
let query: ReturnType<typeof spyOn<typeof archon, 'getRun'>> | undefined;
let revisions: ReturnType<typeof spyOn<typeof archon, 'reportRunRevisions'>> | undefined;
let statuses: ReturnType<typeof spyOn<typeof archon, 'runStatuses'>> | undefined;
afterEach(() => {
  query?.mockRestore();
  revisions?.mockRestore();
  statuses?.mockRestore();
  query = undefined;
  revisions = undefined;
  statuses = (delete process.env.DATABASE_URL, undefined);
  views.clear();
  keys.forEach((k, i) => {
    if (originalEnv[i] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[i];
  });
});

test('batch status avoids getRun and null or missing entries fall back', () => {
  const f = fixture('running');
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  statuses = spyOn(archon, 'runStatuses').mockReturnValue(new Map([[f.view.id, 'running']]));
  gc(false, 'mapped');
  expect(query).not.toHaveBeenCalled();
  statuses.mockReturnValue(null);
  gc(false, 'null');
  expect(query).toHaveBeenCalledTimes(1);
  statuses.mockReturnValue(new Map());
  gc(false, 'missing');
  expect(query).toHaveBeenCalledTimes(2);
});

function fixture(
  status: archon.RunView['status'] = 'completed',
  merged = true,
  fake = false,
  commits = true
) {
  const root = tmp(),
    repo = gitRepo(root),
    id = 'gc-fixture';
  process.env.TMPDIR = join(root, 'tmp');
  mkdirSync(process.env.TMPDIR);
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'archon');
  process.env.SUPERAGENT_WRITE_ROOTS = root;
  mkdirSync(join(root, 'sa', 'runs'), { recursive: true });
  const path = join(root, 'archon', 'workspaces', 'owner', 'repo', 'worktrees', 'sa', id);
  mkdirSync(join(path, '..'), { recursive: true });
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const base = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-b', `sa/${id}`, path);
  if (commits) {
    writeFileSync(join(path, 'change.txt'), 'run commit');
    git('-C', path, 'add', 'change.txt');
    git('-C', path, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'run');
  }
  if (merged) git('merge', '--ff-only', `sa/${id}`);
  const gen = join(root, 'gen');
  mkdirSync(gen);
  writeFileSync(
    join(gen, 'plan.json'),
    readFileSync(
      fixturePlan(root, repo, p => {
        p.base_ref = base;
      })
    )
  );
  writeFileSync(join(gen, 'engine.json'), JSON.stringify({ fake }));
  const ledger: Ledger = {
    run_id: id,
    archon_run_id: 'engine-fixture',
    plan: '',
    gen_dir: gen,
    repo,
    branch: `sa/${id}`,
    workflow: `sa-${id}`,
    console: 'codex',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
  };
  const save = (): void => writeFileSync(ledgerPath(id), JSON.stringify(ledger));
  save();
  const view: archon.RunView = {
    id: ledger.archon_run_id,
    status,
    working_path: path,
    output_root: join(root, 'sa', 'output'),
  };
  views.set(view.id, view);
  query = spyOn(archon, 'getRun').mockImplementation(id => {
    const run = views.get(id);
    if (!run) throw new Error('Archon record unavailable');
    return run;
  });
  const branchExists = (): boolean =>
    git('for-each-ref', '--format=%(refname)', `refs/heads/sa/${id}`) !== '';
  return { root, repo, id, path, gen, git, ledger, save, view, branchExists };
}

// prettier-ignore
function adoptingRun(f: ReturnType<typeof fixture>, id: string, status: archon.RunView['status'], from = f.view.id) {
  const db = new Database(join(f.root, 'archon', 'archon.db'));
  // prettier-ignore
  db.run('CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (id TEXT, status TEXT, adopted_from_run_id TEXT)');
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?)', [id, status, from]);
  db.close();
}
test('rejected source is retained until its live adopter completes', () => {
  const f = fixture('cancelled');
  f.ledger.rejected = f.view.id;
  f.save();
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  adoptingRun(f, 'terminal-adopter', 'failed');
  adoptingRun(f, 'live-adopter', 'running', 'terminal-adopter');
  expect(gc()[0]).toMatchObject({ action: 'skipped', reason: 'adopted by live run live-adopter' });
  expect([existsSync(f.path), f.branchExists()]).toEqual([true, true]);
  // prettier-ignore
  const db = new Database(join(f.root, 'archon', 'archon.db'));
  db.run("UPDATE remote_agent_workflow_runs SET status = 'completed'");
  db.close();
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
});
test.each(['running', 'completed', 'failed', 'cancelled'] as const)(
  '%s adopter uses batch state over stale SQLite',
  status => {
    const f = fixture('cancelled');
    f.ledger.rejected = f.view.id;
    f.save();
    adoptingRun(f, 'stale-adopter', 'completed');
    process.env.DATABASE_URL = 'postgres://fixture';
    // prettier-ignore
    const batch = spyOn(archon, 'archonJson').mockImplementation(() => { delete process.env.DATABASE_URL; return { runs: [{ id: `${status}-adopter`, status, adopted_from_run_id: f.view.id }] }; });
    // prettier-ignore
    expect([gc().map(e => e.action), batch.mock.calls.length]).toEqual([status === 'running' ? ['skipped'] : ['removed', 'removed'], 1]);
    batch.mockRestore();
  }
);

test('adoption query failure retains the run without disabling revision cache', () => {
  const f = fixture();
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  statuses = spyOn(archon, 'runStatuses').mockReturnValue(new Map([[f.view.id, 'completed']]));
  const batch = spyOn(archon, 'archonJson')
    .mockImplementationOnce(() => {
      throw new Error('adoptions offline');
    })
    .mockReturnValue({ runs: [] });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(gc(false, 'isolated')[0]).toMatchObject({
      action: 'skipped',
      reason: 'live adoption state unavailable',
    });
    expect([statuses.mock.calls.length, revisions.mock.calls.length]).toEqual([1, 1]);
    expect(
      JSON.parse(readFileSync(join(f.root, 'sa', 'gc-inputs.json'), 'utf8'))[f.id]
    ).toBeUndefined();
    expect(error).toHaveBeenCalledWith('gc live adoption state unavailable: adoptions offline');
    expect(gc(false, 'isolated').map(event => event.action)).toEqual(['removed', 'removed']);
  } finally {
    batch.mockRestore();
    error.mockRestore();
  }
});

test('merged completed run removes only its worktree and branch; second GC is idempotent', () => {
  const f = fixture();
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  const unregistered = join(f.root, 'archon', 'workspaces', 'unregistered');
  mkdirSync(unregistered);
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
  expect(existsSync(f.path)).toBe(false);
  expect(f.branchExists()).toBe(false);
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(f.path);
  expect(existsSync(unregistered)).toBe(true);
  expect(existsSync(join(f.gen, 'plan.json'))).toBe(true);
  const path = ledgerPath(f.id),
    bytes = readFileSync(path, 'utf8'),
    old = new Date(1_000_000);
  utimesSync(path, old, old);
  query?.mockClear();
  expect(gc()).toEqual([]);
  expect(query).toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(statSync(path).mtimeMs).toBe(old.getTime());
  expect(loadLedger(f.id).gc).toHaveLength(2);
  writeFileSync(join(f.repo, 'main.txt'), 'main');
  f.git('add', 'main.txt');
  f.git('-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'main');
  query?.mockClear();
  expect(gc()).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

test('unchanged skipped ledger uses cache and branch SHA changes invalidate it', () => {
  const f = fixture('failed', false);
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  expect(gc()[0].reason).toContain('not merged');
  query?.mockClear();
  expect(gc()).toEqual([]);
  expect(query).not.toHaveBeenCalled();
  expect(gc(false, 'changed')[0].reason).toContain('not merged');
  expect(query).toHaveBeenCalledTimes(1);
  const cache = join(f.root, 'sa', 'gc-inputs.json');
  writeFileSync(
    cache,
    JSON.stringify({
      [f.id]: { ...JSON.parse(readFileSync(cache, 'utf8'))[f.id], rule_version: undefined },
    })
  );
  query?.mockClear();
  expect(gc()[0].reason).toContain('not merged');
  expect(query).toHaveBeenCalledTimes(1);
  writeFileSync(join(f.path, 'next.txt'), 'next');
  f.git('-C', f.path, 'add', 'next.txt');
  f.git('-C', f.path, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'next');
  expect(gc()[0].reason).toContain('not merged');
  expect(query).toHaveBeenCalledTimes(2);
});

test('another sa worktree advancing does not invalidate a cached ledger', () => {
  const f = fixture('paused', false);
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  expect(gc()[0].reason).toContain('paused');
  const other = join(f.root, 'other');
  f.git('worktree', 'add', '-b', 'sa/other', other);
  writeFileSync(join(other, 'other.txt'), 'other');
  f.git('-C', other, 'add', 'other.txt');
  f.git('-C', other, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'other');
  query?.mockClear();
  expect(gc()).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

test('a non-sa branch advancing invalidates a cached ledger while its sa branch exists', () => {
  const f = fixture('failed', false);
  revisions = spyOn(archon, 'reportRunRevisions').mockReturnValue(new Map([[f.view.id, 'r1']]));
  expect(gc()[0].reason).toContain('not merged');
  expect(f.branchExists()).toBe(true);
  writeFileSync(join(f.repo, 'main.txt'), 'main');
  f.git('add', 'main.txt');
  f.git('-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'main');
  query?.mockClear();
  expect(gc()[0].reason).toContain('not merged');
  expect(query).toHaveBeenCalledTimes(1);
});

test('unmerged completed run removes its clean worktree but retains its branch', () => {
  const f = fixture('completed', false);
  expect(gc(true).map(e => e.action)).toEqual(['would_remove', 'skipped']);
  expect(gc().map(e => e.action)).toEqual(['removed', 'skipped']);
  expect(existsSync(f.path)).toBe(false);
  expect(f.branchExists()).toBe(true);
});

test.each(['completed', 'cancelled', 'failed'] as const)(
  'merged %s run follows the recoverability contract',
  status => {
    const retained = status === 'failed';
    const f = fixture(status);
    expect(gc().map(e => e.action)).toEqual(retained ? ['skipped'] : ['removed', 'removed']);
    expect([existsSync(f.path), f.branchExists()]).toEqual([retained, retained]);
  }
);

test('any local non-sa branch containing HEAD authorizes GC', () => {
  const f = fixture('cancelled', false);
  f.git('branch', 'landed', `sa/${f.id}`);
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
});

test('sa branches and remote refs alone do not authorize GC', () => {
  const f = fixture('failed', false);
  f.git('branch', 'sa/other', `sa/${f.id}`);
  f.git('update-ref', 'refs/remotes/origin/landed', f.git('rev-parse', `sa/${f.id}`));
  expect(gc()[0].reason).toContain('not merged');
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

test.each([true, false])('missing engine.json is non-fake (merged=%s)', merged => {
  const f = fixture('failed', merged);
  rmSync(join(f.gen, 'engine.json'));
  expect(gc().map(e => e.action)).toEqual(['skipped']);
  expect([existsSync(f.path), f.branchExists()]).toEqual([true, true]);
  const cancelled = fixture('cancelled', merged);
  rmSync(join(cancelled.gen, 'engine.json'));
  expect(gc().map(e => e.action)).toEqual(merged ? ['removed', 'removed'] : ['skipped']);
});

test.each(['malformed', 'directory'] as const)('engine.json %s errors retain data', error => {
  const f = fixture();
  if (error === 'malformed') writeFileSync(join(f.gen, 'engine.json'), '{');
  else {
    rmSync(join(f.gen, 'engine.json'));
    mkdirSync(join(f.gen, 'engine.json'));
  }
  expect(gc()[0].action).toBe('skipped');
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

test('rejected terminal run removes its worktree but retains its unmerged branch', () => {
  const f = fixture('cancelled', false);
  f.ledger.rejected = f.view.id;
  f.save();
  expect(gc().map(e => e.action)).toEqual(['removed', 'skipped']);
  expect(existsSync(f.path)).toBe(false);
  expect(f.branchExists()).toBe(true);
  gc();
  expect(loadLedger(f.id).gc).toHaveLength(2);
});

test.each(['failed', 'cancelled', 'running', 'paused', 'pending'] as const)(
  '%s non-rejected run is retained',
  status => {
    const f = fixture(status, false);
    expect(gc()[0].reason).toContain('recoverable');
    expect(existsSync(f.path)).toBe(true);
    expect(f.branchExists()).toBe(true);
  }
);

test.each(['running', 'paused', 'pending'] as const)(
  'nonterminal %s run is retained even if merged, fake and rejected',
  status => {
    const f = fixture(status, true, true, false);
    f.ledger.rejected = f.view.id;
    f.save();
    expect(gc()[0].reason).toContain('recoverable');
    expect(existsSync(f.path)).toBe(true);
    expect(f.branchExists()).toBe(true);
  }
);

test('failed fake run stays retryable while unmerged', () => {
  const f = fixture('failed', false, true);
  expect(gc()[0]).toMatchObject({ object: 'worktree', action: 'skipped' });
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

test.each(['completed', 'cancelled'] as const)(
  'terminal fake %s run can remove an unmerged branch',
  status => {
    const f = fixture(status, false, true);
    expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
    expect(existsSync(f.path)).toBe(false);
    expect(f.branchExists()).toBe(false);
  }
);

test.each(['tracked', 'untracked'] as const)('dirty %s worktree is retained', dirty => {
  const f = fixture('completed', false);
  writeFileSync(join(f.path, dirty === 'tracked' ? 'change.txt' : 'untracked.txt'), 'dirty');
  const result = gc();
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ object: 'worktree', action: 'skipped' });
  expect(result[0].reason).toBe('worktree dirty');
  expect(loadLedger(f.id).gc?.[0].reason).toBe(result[0].reason);
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

// prettier-ignore
test('submodule worktrees are force-removed only when the submodule is clean', () => {
  for (const dirty of [false, true]) {
    const f = fixture(),
      module = join(f.root, 'module');
    mkdirSync(module);
    f.git('-C', module, 'init', '-q', '-b', 'main');
    writeFileSync(join(module, 'README.md'), 'module');
    f.git('-C', module, 'add', 'README.md');
    f.git('-C', module, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'init');
    f.git('-c', 'protocol.file.allow=always', '-C', f.path, 'submodule', 'add', '-q', module, 'module');
    f.git('-C', f.path, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qam', 'submodule');
    f.git('merge', '--ff-only', `sa/${f.id}`);
    if (dirty) writeFileSync(join(f.path, 'module', 'README.md'), 'dirty');
    expect(gc(true)[0].action).toBe(dirty ? 'skipped' : 'would_remove');
    expect(gc()[0].action).toBe(dirty ? 'skipped' : 'removed');
    expect(existsSync(f.path)).toBe(dirty);
  }
});

test.each(['path', 'branch', 'outside', 'symlink'] as const)(
  '%s registration mismatch is retained',
  mismatch => {
    const f = fixture();
    if (mismatch === 'path') f.view.working_path = join(f.path, 'missing');
    if (mismatch === 'branch') f.git('-C', f.path, 'switch', '-c', 'other');
    if (mismatch === 'outside') f.view.working_path = f.repo;
    if (mismatch === 'symlink') {
      const alias = join(f.root, 'archon', 'workspaces', 'alias');
      symlinkSync(f.repo, alias);
      f.view.working_path = alias;
    }
    expect(gc()[0].action).toBe('skipped');
    expect(existsSync(f.path)).toBe(true);
    expect(f.branchExists()).toBe(true);
  }
);

test('terminal half-deleted worktree removes an empty directory but retains unknown content', () => {
  for (const unknown of [false, true]) {
    const f = fixture(),
      parked = `${f.path}-parked`;
    renameSync(f.path, parked);
    f.git('worktree', 'prune', '--expire', 'now');
    renameSync(parked, f.path);
    for (const entry of readdirSync(f.path))
      rmSync(join(f.path, entry), { recursive: true, force: true });
    if (unknown) writeFileSync(join(f.path, 'unknown'), 'keep');
    const result = gc().find(e => e.object === 'worktree');
    expect(result?.action).toBe(unknown ? 'skipped' : 'removed');
    expect(result?.reason).toContain(unknown ? 'unknown entries' : 'half-deleted');
    expect(existsSync(f.path)).toBe(unknown);
  }
});

test(
  'CLI --dry-run --json changes neither git objects nor ledger bytes',
  () => {
    const f = fixture();
    const before = readFileSync(ledgerPath(f.id), 'utf8'),
      tree = f.git('worktree', 'list', '--porcelain');
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['gc', '--dry-run', '--json'])).toBe(0);
      const output = JSON.parse(String(log.mock.calls[0][0]));
      expect(
        output.gc
          .filter((e: { run_id: string }) => e.run_id === f.id)
          .map((e: { action: string }) => e.action)
      ).toEqual(['would_remove', 'would_remove']);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(ledgerPath(f.id), 'utf8')).toBe(before);
    expect(f.git('worktree', 'list', '--porcelain')).toBe(tree);
    expect(existsSync(join(f.root, 'sa', 'runs', `${f.view.id}.lock`))).toBe(false);
    expect(existsSync(f.path)).toBe(true);
    expect(f.branchExists()).toBe(true);
  },
  testTimeout(30_000)
);

test.each(['archon', 'plan', 'git'] as const)('%s error is a recorded skip', failure => {
  const f = fixture();
  if (failure === 'archon') views.clear();
  if (failure === 'plan') writeFileSync(join(f.gen, 'plan.json'), '{');
  if (failure === 'git') f.ledger.repo = join(f.root, 'missing-repo');
  if (failure === 'git') {
    writeFileSync(
      join(f.gen, 'plan.json'),
      JSON.stringify({ repo: f.ledger.repo, base_ref: 'main' })
    );
    f.save();
  }
  expect(gc()[0].action).toBe('skipped');
  expect(loadLedger(f.id).gc).toHaveLength(1);
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

test('changed branch SHA refuses deletion and an unmerged replacement is retained on retry', () => {
  const f = fixture();
  f.git('switch', '-c', 'sa/replacement');
  writeFileSync(join(f.repo, 'next.txt'), 'replacement');
  f.git('add', 'next.txt');
  f.git('-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'next');
  const replacement = f.git('rev-parse', 'HEAD'),
    original = Bun.spawnSync;
  function intercept<
    const In extends Bun.SpawnOptions.Writable = 'ignore',
    const Out extends Bun.SpawnOptions.Readable = 'pipe',
    const Err extends Bun.SpawnOptions.Readable = 'pipe',
  >(
    command:
      | string[]
      | (Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err> & { cmd: string[]; onExit?: undefined }),
    options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>
  ): Bun.SyncSubprocess<Out, Err> {
    const cmd = Array.isArray(command) ? command : command.cmd;
    if (cmd.includes('update-ref') && cmd.includes('-d'))
      original(['git', '-C', f.repo, 'update-ref', `refs/heads/sa/${f.id}`, replacement]);
    return Array.isArray(command) ? original(command, options) : original(command);
  }
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation(intercept);
  try {
    expect(gc().map(e => e.action)).toEqual(['removed', 'skipped']);
  } finally {
    spawn.mockRestore();
  }
  expect(existsSync(f.path)).toBe(false);
  expect(f.git('rev-parse', `refs/heads/sa/${f.id}`)).toBe(replacement);
  expect(loadLedger(f.id).gc?.[1].reason).toContain('but expected');
  expect(gc()[0].reason).toContain('not merged');
  expect(f.branchExists()).toBe(true);
});

test('run observation and deletion hold the existing recovery lock', () => {
  const f = fixture();
  query?.mockImplementation(() => {
    const lease = executionAdmissionLock(join(f.root, 'archon'), f.view.id);
    if (lease.ok) lease.release();
    expect(lease.ok).toBe(false);
    return f.view;
  });
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
});

test('successful decide reject records engine identity; cancelled alone remains recoverable', () => {
  const f = fixture('paused', false);
  f.view.metadata = {
    wait: {
      nodeId: 'human-m1',
      kind: 'event',
      event: 'sa.human.m1',
      resumeAt: '2099-01-01T00:00:00Z',
    },
  };
  f.ledger.controller = coordination
    .coord()
    .claim(coordination.repoScope(f.repo), coordination.caller()).controller;
  f.save();
  const cancel = spyOn(archon, 'archonJson').mockImplementation(() => {
    f.view.status = 'cancelled';
    return { ok: true };
  });
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(main(['decide', f.id, 'reject'])).toBe(0);
  } finally {
    cancel.mockRestore();
    log.mockRestore();
  }
  expect(loadLedger(f.id).rejected).toBe(f.view.id);
  expect(gc().map(e => e.action)).toEqual(['removed', 'skipped']);
});

function probes(f: ReturnType<typeof fixture>) {
  const art = artifactsOf(f.view),
    probe = join(art, 'probe-leftover'),
    trash = join(art, '.trash');
  mkdirSync(trash, { recursive: true });
  f.git('worktree', 'add', '--detach', probe, 'HEAD');
  writeFileSync(join(probe, 'generated.txt'), 'disposable');
  f.git('worktree', 'add', '--detach', join(trash, 'probe-registered'), 'HEAD');
  mkdirSync(join(trash, 'probe-renamed'));
  return { art, probe, trash };
}

test.each(['completed', 'failed', 'cancelled'] as const)(
  'terminal %s probe output is collected even with an unmerged run branch',
  status => {
    const f = fixture(status, false),
      p = probes(f);
    const result = gc();
    expect(
      result.filter(e => e.reason === 'terminal probe').every(e => e.action === 'removed')
    ).toBe(true);
    expect(existsSync(p.probe)).toBe(false);
    expect(existsSync(p.trash)).toBe(false);
    expect(existsSync(f.path)).toBe(status !== 'completed');
    expect(f.branchExists()).toBe(true);
    expect(f.git('worktree', 'list', '--porcelain')).not.toContain(p.art);
  }
);

test.each(['running', 'paused', 'pending'] as const)('%s probe output is retained', status => {
  const f = fixture(status),
    p = probes(f);
  gc();
  expect(existsSync(p.probe)).toBe(true);
  expect(existsSync(p.trash)).toBe(true);
});

test('probe dry-run lists artifacts and stale legacy worktrees without deleting or unregistering them', () => {
  const f = fixture(),
    p = probes(f);
  const stale = join(process.env.TMPDIR!, 'sa-probe-stale'),
    fresh = join(process.env.TMPDIR!, 'sa-probe-fresh');
  f.git('worktree', 'add', '--detach', stale, 'HEAD');
  f.git('worktree', 'add', '--detach', fresh, 'HEAD');
  rmSync(join(stale, 'README.md'));
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(stale, old, old);
  const before = f.git('worktree', 'list', '--porcelain');
  const dry = gc(true);
  expect(dry.find(e => e.path === stale)?.action).toBe('would_remove');
  expect(dry.some(e => e.path === fresh)).toBe(false);
  expect(existsSync(p.probe)).toBe(true);
  expect(existsSync(p.trash)).toBe(true);
  expect(f.git('worktree', 'list', '--porcelain')).toBe(before);
  gc();
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(stale);
});

test('engine gc removes read-only failed candidates and preserves protected or live snapshots', () => {
  const f = fixture('running', false),
    root = join(f.root, 'sa', 'engine');
  const shas = {
    current: 'aaaaaaa',
    bootstrap: 'bbbbbbb',
    previous: 'ccccccc',
    failed: 'ddddddd',
    failedRef: '1111111',
    cancelledRef: '2222222',
    running: 'eeeeeee',
    unknown: 'fffffff',
    console: '3333333',
  };
  for (const sha of Object.values(shas)) {
    mkdirSync(join(root, sha), { recursive: true });
    writeFileSync(join(root, sha, 'file'), sha);
  }
  symlinkSync(join(root, shas.current), join(root, 'current'));
  mkdirSync(join(root, 'receipts'));
  mkdirSync(join(root, 'promotions'));
  for (const [sha, at] of [
    [shas.bootstrap, '2026-01-01'],
    [shas.previous, '2026-01-02'],
    [shas.current, '2026-01-03'],
  ])
    writeFileSync(join(root, 'receipts', `${sha}.json`), JSON.stringify({ sha, at }));
  writeFileSync(
    join(root, 'promotions', `${shas.failed}.json`),
    JSON.stringify({ status: 'failed' })
  );
  writeFileSync(
    join(root, 'promotions', `${shas.console}.json`),
    JSON.stringify({ status: 'failed' })
  );
  const identity = inspectProcess(process.pid);
  expect(identity.state).toBe('online');
  writeFileSync(
    join(root, 'promotions', `${shas.running}.json`),
    JSON.stringify({
      status: 'running',
      host: hostname(),
      pid: process.pid,
      pid_start: identity.state === 'online' ? identity.start : '',
    })
  );
  chmodSync(join(root, shas.failed, 'file'), 0o444);
  chmodSync(join(root, shas.failed), 0o555);
  f.ledger.engine_snapshot = join(root, shas.failedRef);
  f.save();
  f.view.status = 'failed';
  const cancelled = {
    ...f.ledger,
    run_id: 'cancelled-ref',
    archon_run_id: 'cancelled-ref',
    engine_snapshot: join(root, shas.cancelledRef),
  };
  writeFileSync(ledgerPath(cancelled.run_id), JSON.stringify(cancelled));
  views.set(cancelled.archon_run_id, {
    ...f.view,
    id: cancelled.archon_run_id,
    status: 'cancelled',
  });
  const dry = collectEngineSnapshots(true);
  expect(dry.find(e => e.path === join(root, shas.failed))?.action).toBe('would_remove');
  expect(dry.find(e => e.path === join(root, shas.cancelledRef))?.action).toBe('would_remove');
  expect(dry.find(e => e.path === join(root, shas.failedRef))).toBeUndefined();
  expect(dry.find(e => e.path === join(root, shas.unknown))?.action).toBe('skipped');
  process.env.SA_LAUNCHD_DIR = join(f.root, 'LaunchAgents');
  mkdirSync(process.env.SA_LAUNCHD_DIR);
  const plist = join(process.env.SA_LAUNCHD_DIR, 'com.wetamp.superagent-console.plist');
  const consolePlist = `<plist><dict><key>ProgramArguments</key><array><string>${join(root, shas.console, 'wetamp/src/cli.ts')}</string></array></dict></plist>`;
  writeFileSync(plist, consolePlist);
  expect(collectEngineSnapshots(true).find(e => e.path === join(root, shas.console))).toMatchObject(
    { action: 'skipped', reason: 'console snapshot retained' }
  );
  writeFileSync(plist, 'invalid');
  expect(collectEngineSnapshots(true)[0]?.reason).toContain(
    'console plist unreadable; all engine snapshots retained'
  );
  writeFileSync(plist, consolePlist);
  collectEngineSnapshots(false);
  expect(existsSync(join(root, shas.failed))).toBe(false);
  expect(existsSync(join(root, shas.cancelledRef))).toBe(false);
  for (const sha of [
    shas.current,
    shas.bootstrap,
    shas.previous,
    shas.failedRef,
    shas.running,
    shas.unknown,
    shas.console,
  ])
    expect(existsSync(join(root, sha))).toBe(true);
});

test('engine gc removes only stale engine probes while the promotion lock is free', () => {
  const f = fixture('running', false),
    root = process.env.TMPDIR!,
    engine = join(f.root, 'sa', 'engine'),
    old = join(root, 'sa-engine-probe-old'),
    fresh = join(root, 'sa-engine-probe-fresh'),
    other = join(root, 'other-probe-old');
  for (const path of [old, fresh, other]) {
    mkdirSync(join(path, 'sa'), { recursive: true });
    writeFileSync(join(path, 'sa', 'file'), 'x');
  }
  const stale = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(old, stale, stale);
  utimesSync(other, stale, stale);
  chmodSync(join(old, 'sa'), 0o555);
  chmodSync(old, 0o555);
  mkdirSync(engine, { recursive: true });
  const held = lock(join(engine, 'engine.lock'));
  expect(held.ok).toBe(true);
  expect(gc().some(e => e.reason === 'stale engine probe')).toBe(false);
  expect(existsSync(old)).toBe(true);
  if (held.ok) held.release();
  expect(gc().find(e => e.path === old)?.action).toBe('removed');
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
});

test.each(['clean', 'deleted', 'modified', 'untracked', 'staged', 'symlink'])(
  'legacy probe collection retains unsafe state: %s',
  state => {
    const f = fixture();
    const alternate = join(f.root, 'alternate');
    mkdirSync(alternate);
    const path = join(alternate, 'sa-probe-case');
    f.git('worktree', 'add', '--detach', path, 'HEAD');
    if (state === 'deleted') rmSync(join(path, 'README.md'));
    if (state === 'modified') writeFileSync(join(path, 'README.md'), 'changed');
    if (state === 'untracked' || state === 'staged') writeFileSync(join(path, 'new'), 'keep');
    if (state === 'staged') f.git('-C', path, 'add', 'new');
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(path, old, old);
    if (state === 'symlink') symlinkSync(path, join(alternate, 'sa-probe-link'));
    const roots = [process.env.TMPDIR!, alternate, alternate];
    const safe = state === 'clean' || state === 'deleted' || state === 'symlink';
    expect(collect(true, roots).find(e => e.path === path)?.action).toBe(
      safe ? 'would_remove' : 'skipped'
    );
    expect(collect(false, roots).filter(e => e.path === path)).toHaveLength(1);
    expect(existsSync(path)).toBe(!safe);
    expect(f.git('worktree', 'list', '--porcelain').includes(path)).toBe(!safe);
    if (state === 'symlink')
      expect(collect(true, roots).some(e => e.path?.endsWith('sa-probe-link'))).toBe(false);
  }
);

test.each(['old', 'fresh', 'referenced', 'alias', 'bad-ledger', 'symlink', 'root-symlink'])(
  'gen snapshots preserve references and unsafe paths: %s',
  state => {
    const f = fixture('running', false),
      root = join(f.root, 'sa', 'gen'),
      path = join(root, 'snapshot');
    mkdirSync(path, { recursive: true });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    if (state !== 'fresh') utimesSync(path, old, old);
    if (state === 'referenced' || state === 'alias') {
      f.ledger.gen_dir = state === 'alias' ? join(f.root, 'alias') : path;
      if (state === 'alias') symlinkSync(path, f.ledger.gen_dir);
      f.save();
    }
    if (state === 'bad-ledger') writeFileSync(ledgerPath(f.id), '{');
    if (state === 'symlink') symlinkSync(f.gen, join(root, 'link'));
    if (state === 'root-symlink') {
      rmSync(root, { recursive: true });
      symlinkSync(f.gen, root);
    }
    const events = () => gc(true).filter(e => e.object === 'gen');
    expect(events().some(e => e.action === 'would_remove')).toBe(
      state === 'old' || state === 'symlink'
    );
    if (state !== 'root-symlink') expect(existsSync(path)).toBe(true);
    expect(events().some(e => e.action === 'skipped' && e.reason.length > 0)).toBe(state !== 'old');
    const removed = gc().filter(e => e.object === 'gen' && e.action === 'removed');
    expect(removed.map(e => e.path)).toEqual(state === 'old' || state === 'symlink' ? [path] : []);
    expect(gc().some(e => e.object === 'gen' && e.action === 'removed')).toBe(false);
    expect(existsSync(join(f.gen, 'plan.json'))).toBe(true);
    if (state === 'symlink') expect(existsSync(join(root, 'link'))).toBe(true);
  }
);
