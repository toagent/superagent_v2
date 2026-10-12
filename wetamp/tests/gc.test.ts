import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as archon from '../src/archon';
import * as coordination from '../src/coord';
import { artifactsOf, ledgerPath, loadLedger, main, type Ledger } from '../src/cli';
import { gc } from '../src/gc';
import { fixturePlan, gitRepo, tmp } from './helpers';

const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_WRITE_ROOTS', 'TMPDIR'] as const;
const originalEnv = keys.map(k => process.env[k]);
const views = new Map<string, archon.RunView>();
let query: ReturnType<typeof spyOn<typeof archon, 'getRun'>> | undefined;
afterEach(() => {
  query?.mockRestore();
  query = undefined;
  views.clear();
  keys.forEach((k, i) => {
    if (originalEnv[i] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[i];
  });
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
    output_root: join(root, 'output'),
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

test('merged completed run removes only its worktree and branch; second GC is idempotent', () => {
  const f = fixture();
  const unregistered = join(f.root, 'archon', 'workspaces', 'unregistered');
  mkdirSync(unregistered);
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
  expect(existsSync(f.path)).toBe(false);
  expect(f.branchExists()).toBe(false);
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(f.path);
  expect(existsSync(unregistered)).toBe(true);
  expect(existsSync(join(f.gen, 'plan.json'))).toBe(true);
  const bytes = readFileSync(ledgerPath(f.id), 'utf8');
  query?.mockClear();
  expect(gc()).toEqual([]);
  expect(query).toHaveBeenCalled();
  expect(readFileSync(ledgerPath(f.id), 'utf8')).toBe(bytes);
  expect(loadLedger(f.id).gc).toHaveLength(2);
});

test('unmerged completed run is retained and the same skip is recorded only once', () => {
  const f = fixture('completed', false);
  expect(gc()[0].reason).toContain('not merged');
  expect(gc()[0].action).toBe('skipped');
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
  expect(loadLedger(f.id).gc).toHaveLength(1);
});

test.each(['completed', 'cancelled', 'failed'] as const)(
  'merged %s run is collected without accept, even with a SHA base_ref',
  status => {
    const f = fixture(status);
    expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
    expect(existsSync(f.path)).toBe(false);
    expect(f.branchExists()).toBe(false);
  }
);

test('any local non-sa branch containing HEAD authorizes GC', () => {
  const f = fixture('cancelled', false);
  f.git('branch', 'landed', `sa/${f.id}`);
  expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
});

test('sa branches and remote refs alone do not authorize GC', () => {
  const f = fixture('completed', false);
  f.git('branch', 'sa/other', `sa/${f.id}`);
  f.git('update-ref', 'refs/remotes/origin/landed', f.git('rev-parse', `sa/${f.id}`));
  expect(gc()[0].reason).toContain('not merged');
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

test.each([true, false])('missing engine.json is non-fake (merged=%s)', merged => {
  const f = fixture('completed', merged);
  rmSync(join(f.gen, 'engine.json'));
  expect(gc().map(e => e.action)).toEqual(merged ? ['removed', 'removed'] : ['skipped']);
  expect(existsSync(f.path)).toBe(!merged);
  expect(f.branchExists()).toBe(!merged);
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

test.each(['full', 'partial', 'failed'] as const)(
  '%s accept reports verification without maintaining a GC authorization marker',
  mode => {
    const f = fixture();
    f.ledger.plan = fixturePlan(f.root, f.repo, p => {
      for (const pkg of p.packages as { accept: { cmd: string; timeout_s: number }[] }[])
        pkg.accept = [{ cmd: mode === 'failed' ? 'false' : 'true', timeout_s: 5 }];
    });
    writeFileSync(join(f.gen, 'plan.json'), readFileSync(f.ledger.plan));
    mkdirSync(join(f.gen, '.archon'));
    symlinkSync(
      join(import.meta.dir, '..', 'templates', '.archon', 'scripts'),
      join(f.gen, '.archon', 'scripts'),
      'dir'
    );
    f.ledger.controller = coordination
      .coord()
      .claim(coordination.repoScope(f.repo), coordination.caller()).controller;
    f.save();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['accept', f.id, ...(mode === 'partial' ? ['--pkg', 'core'] : [])])).toBe(
        mode === 'failed' ? 1 : 0
      );
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(ledgerPath(f.id), 'utf8')).not.toContain('accepted');
    expect(gc().map(e => e.action)).toEqual(['removed', 'removed']);
  }
);

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

test.each(['completed', 'failed', 'cancelled', 'running', 'paused', 'pending'] as const)(
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

test.each(['tracked', 'untracked'] as const)(
  'dirty %s worktree is retained with original git stderr',
  dirty => {
    const f = fixture();
    writeFileSync(join(f.path, dirty === 'tracked' ? 'change.txt' : 'untracked.txt'), 'dirty');
    const result = gc();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ object: 'worktree', action: 'skipped' });
    expect(result[0].reason).toContain('contains modified or untracked files');
    expect(loadLedger(f.id).gc?.[0].reason).toBe(result[0].reason);
    expect(existsSync(f.path)).toBe(true);
    expect(f.branchExists()).toBe(true);
  }
);

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

test('CLI --dry-run --json changes neither git objects nor ledger bytes', () => {
  const f = fixture();
  const before = readFileSync(ledgerPath(f.id), 'utf8'),
    tree = f.git('worktree', 'list', '--porcelain');
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(main(['gc', '--dry-run', '--json'])).toBe(0);
    const output = JSON.parse(String(log.mock.calls[0][0]));
    expect(output.gc.map((e: { action: string }) => e.action)).toEqual([
      'would_remove',
      'would_remove',
    ]);
  } finally {
    log.mockRestore();
  }
  expect(readFileSync(ledgerPath(f.id), 'utf8')).toBe(before);
  expect(f.git('worktree', 'list', '--porcelain')).toBe(tree);
  expect(existsSync(join(f.root, 'sa', 'runs', `${f.view.id}.lock`))).toBe(false);
  expect(existsSync(f.path)).toBe(true);
  expect(f.branchExists()).toBe(true);
});

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
    const lease = archon.lock(join(f.root, 'sa', 'runs', `${f.view.id}.lock`));
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
    expect(existsSync(f.path)).toBe(true);
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
  writeFileSync(join(stale, 'dirty'), 'disposable');
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
