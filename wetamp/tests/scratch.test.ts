import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as archon from '../src/archon';
import * as memory from '../src/memory';
import type { Ledger } from '../src/cli';
import type { ScratchAction } from '../src/gc';
import { loadPlan, writeRoots } from '../src/plan';
import { fixturePlan, gitRepo, tmp } from './helpers';

const require = createRequire(import.meta.url);
const scratchRoot = join(tmp(), 'scratch'),
  scratchPreload = join(tmp(), 'scratch-preload.cjs');
writeFileSync(
  scratchPreload,
  `const fs = require('node:fs'), path = require('node:path');
let violations = 0;
const restores = [];
const check = value => {
  if (value instanceof URL) value = require('node:url').fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const p = path.resolve(value);
  if (['/tmp/sa-scratch', '/private/tmp/sa-scratch'].some(r => p === r || p.startsWith(r + '/'))) {
    violations++; throw new Error('production scratch access: ' + p);
  }
};
const wrap = fn => function(...args) { args.forEach(check); return fn.apply(this, args); };
for (const api of [fs, fs.promises]) for (const key of Object.keys(api)) {
  if (typeof api[key] !== 'function' || /^[A-Z]/.test(key)) continue;
  const fn = api[key], native = fn.native;
  api[key] = wrap(fn);
  restores.push(() => { api[key] = fn; });
  if (native) api[key].native = wrap(native);
}
require('node:module').syncBuiltinESMExports();
// Bun defaults to its startup environment; forward the scoped preload to descendants.
if (typeof Bun !== 'undefined') for (const key of ['spawn', 'spawnSync']) {
  const spawn = Bun[key]; Bun[key] = (cmd, options = {}) => {
    if (!Array.isArray(cmd)) { options = cmd; cmd = options.cmd; }
    if (['bun', 'node'].includes(path.basename(cmd[0]))) { const i = cmd[1] === 'run' ? 2 : cmd[2] === 'run' ? 3 : 1; cmd = [...cmd.slice(0, i), path.basename(cmd[0]) === 'bun' ? '--preload' : '--require', __filename, ...cmd.slice(i)]; }
    return spawn(cmd, {...options, env: {...process.env, ...options.env}});
  };
  restores.push(() => { Bun[key] = spawn; });
}
process.on('exit', () => { if (violations) process.exitCode = 1; });
const scratch = require(${JSON.stringify(join(import.meta.dir, '..', 'hooks', 'scratch.cjs'))});
const key = Symbol.for('superagent.test.scratch.default');
if (!globalThis[key]) {
  if (scratch.ROOT !== '/tmp/sa-scratch') throw new Error('production default changed');
  globalThis[key] = true;
}
if (scratch.ROOT !== ${JSON.stringify(scratchRoot)}) Object.assign(scratch, scratch.createScratch(${JSON.stringify(scratchRoot)}));
module.exports = {violations: () => violations, restore: () => {
  for (const restore of restores.reverse()) restore();
  require('node:module').syncBuiltinESMExports();
}};`
);
const boundary = require(scratchPreload) as { violations: () => number; restore: () => void };
const collection = await import('../src/gc');
const { gc, scratchClean } = collection;
const { ledgerPath, main, superviseTick } = await import('../src/cli');
type Context = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
interface Owner {
  client: string;
  session: string;
  pid: number;
  pid_start: string;
  created: string;
}
const scratch = require('../hooks/scratch.cjs') as {
  ROOT: string;
  createScratch: (root: string) => typeof scratch;
  start: (payload: { session_id: string }, client: string, env?: NodeJS.ProcessEnv) => Context;
  clean: (
    session: string | undefined,
    dry: boolean,
    referenced: (path: string) => boolean
  ) => ScratchAction[];
  cleanOne: (path: string, dry: boolean, referenced: (path: string) => boolean) => ScratchAction;
};
const live = require('../hooks/live.cjs') as {
  owner: () => { pid: number; tty: string | null } | null;
};
const identity = require('../hooks/identity.cjs') as {
  inspect: (pid: number) => { state: string; start?: string };
};
const guard = require('../hooks/guard.cjs') as {
  decide: (payload: object, client: string, env?: NodeJS.ProcessEnv) => Context | null;
};
const dirs: string[] = [];
const keys = [
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SUPERAGENT_WRITE_ROOTS',
  'SUPERAGENT_ROLE',
] as const;
const saved = keys.map(k => process.env[k]);
let ownerSpy: ReturnType<typeof spyOn<typeof live, 'owner'>> | undefined;
let query: ReturnType<typeof spyOn<typeof archon, 'getRun'>> | undefined;
afterAll(() => boundary.restore());
afterEach(async () => {
  expect(boundary.violations()).toBe(0);
  ownerSpy?.mockRestore();
  ownerSpy = undefined;
  query?.mockRestore();
  query = undefined;
  for (const dir of dirs.splice(0)) await removeTempTree(dir);
  keys.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
});

function setup(client = 'claude') {
  const root = tmp(),
    session = `test-${crypto.randomUUID()}`,
    dir = join(scratch.ROOT, `${client}-${session}`);
  Object.assign(process.env, {
    SUPERAGENT_HOME: join(root, 'sa'),
    ARCHON_HOME: join(root, 'archon'),
    SUPERAGENT_WRITE_ROOTS: [root, scratchRoot].join(require('node:path').delimiter),
  });
  dirs.push(dir);
  ownerSpy = spyOn(live, 'owner').mockReturnValue({ pid: process.pid, tty: null });
  const context = scratch.start({ session_id: session }, client, {});
  const file = join(dir, '.owner.json');
  const owner = JSON.parse(readFileSync(file, 'utf8')) as Owner;
  const exited = (): void => {
    const p = spawnSync('true');
    expect(p.status).toBe(0);
    writeFileSync(
      file,
      JSON.stringify({ ...owner, pid: p.pid, pid_start: 'exited fixture process' })
    );
  };
  return { root, session, dir, file, owner, context, exited };
}
function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
const logInfo = (): { size: number; mtime: number } | null => {
  const file = join(scratch.ROOT, '.log');
  return existsSync(file) ? { size: statSync(file).size, mtime: statSync(file).mtimeMs } : null;
};

test('explicit root rejects relative paths, root symlinks and canonical parent drift', () => {
  ownerSpy = spyOn(live, 'owner').mockReturnValue({ pid: process.pid, tty: null });
  expect(() => scratch.createScratch('relative')).toThrow('normalized absolute');
  expect(() => scratch.createScratch('/tmp/../tmp/root')).toThrow('normalized absolute');
  const root = tmp(),
    target = join(root, 'target'),
    link = join(root, 'link');
  mkdirSync(target);
  symlinkSync(target, link);
  const linked = scratch.createScratch(link);
  expect(() => linked.start({ session_id: 'probe' }, 'claude')).toThrow('root invalid');
  expect(linked.clean(undefined, false, () => false)[0].reason).toBe('scratch root invalid');
  const parent = join(root, 'parent');
  symlinkSync(target, parent);
  const drifted = scratch.createScratch(join(parent, 'scratch'));
  require('node:fs').unlinkSync(parent);
  const changedTarget = tmp();
  symlinkSync(changedTarget, parent);
  expect(() => drifted.start({ session_id: 'probe' }, 'claude')).toThrow('root invalid');
  // refusal must happen before mkdir can write into the changed target.
  expect(existsSync(join(changedTarget, 'scratch'))).toBe(false);
});

test.each(['node', process.execPath])('fs boundary fails closed in %s subprocess', executable => {
  const p = Bun.spawnSync(
    [executable, '-e', "try { require('node:fs').readdirSync('/tmp/sa-scratch'); } catch {}"],
    { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(p.exitCode).toBe(1);
});

test('guard SessionStart records client process identity, creates 0700 scratch and writes CLAUDE_ENV_FILE', () => {
  const f = setup(),
    envFile = join(f.root, 'claude-env');
  expect(
    guard.decide(
      { hook_event_name: 'SessionStart', session_id: f.session, cwd: f.root },
      'claude',
      { CLAUDE_ENV_FILE: envFile }
    )
  ).toEqual(f.context);
  expect(f.owner).toMatchObject({
    client: 'claude',
    session: f.session,
    pid: process.pid,
    pid_start: identity.inspect(process.pid).start,
  });
  expect(Date.parse(f.owner.created)).not.toBeNaN();
  expect(statSync(f.dir).mode & 0o777).toBe(0o700);
  expect(readFileSync(envFile, 'utf8')).toBe(`export TMPDIR='${f.dir}/'\n`);
  const temp = spawnSync(
    'bash',
    ['-c', 'source "$1"; mktemp -d "$TMPDIR/probe.XXXXXX"', 'scratch-test', envFile],
    { encoding: 'utf8' }
  );
  expect(temp.status).toBe(0);
  expect(temp.stdout.trim()).toStartWith(f.dir + '/');
  expect(realpathSync(f.dir)).toStartWith(realpathSync(scratchRoot) + '/');
});

test('Codex SessionStart emits exactly the scratch context line without modifying Claude env', () => {
  const f = setup('codex'),
    envFile = join(f.root, 'claude-env');
  const output = guard.decide(
    { hook_event_name: 'SessionStart', session_id: f.session, cwd: f.root },
    'codex',
    { CLAUDE_ENV_FILE: envFile }
  );
  expect(output?.hookSpecificOutput.additionalContext).toBe(`scratch: ${f.dir}/`);
  expect(output?.hookSpecificOutput.additionalContext.split('\n')).toHaveLength(1);
  expect(existsSync(envFile)).toBe(false);
  expect(
    guard.decide({ hook_event_name: 'SessionStart', session_id: f.session }, 'codex', {
      SUPERAGENT_ROLE: 'general',
    })
  ).toBeNull();
});

test('scratch-clean force removes a dirty linked worktree but preserves node_modules target and branch', () => {
  const f = setup(),
    repo = gitRepo(f.root),
    wt = join(f.dir, 'wt'),
    target = join(f.root, 'modules');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'keep');
  git(repo, 'worktree', 'add', '-b', 'scratch-fixture', wt);
  writeFileSync(join(wt, 'README.md'), 'dirty disposable tree');
  symlinkSync(target, join(wt, 'node_modules'));
  f.exited();
  expect(scratchClean(f.session)).toEqual([
    { path: f.dir, action: 'removed', reason: 'scratch owner exited' },
  ]);
  expect(existsSync(f.dir)).toBe(false);
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt);
  expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/scratch-fixture')).not.toBe(
    ''
  );
  expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('keep');
  expect(statSync(target).isDirectory()).toBe(true);
});

test('independent repository with an outside worktree retains the entire directory', () => {
  const f = setup(),
    repo = gitRepo(f.dir),
    outside = join(f.root, 'outside');
  git(repo, 'worktree', 'add', '-b', 'outside-fixture', outside);
  writeFileSync(join(f.dir, 'keep'), 'keep');
  f.exited();
  expect(scratchClean(f.session)[0]).toMatchObject({
    action: 'skipped',
    reason: 'scratch repository has an outside worktree',
  });
  expect(readFileSync(join(f.dir, 'keep'), 'utf8')).toBe('keep');
  expect(existsSync(outside)).toBe(true);
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(outside);
});

test('live and unknown owners are retained; exited owners are removed', () => {
  const f = setup();
  expect(scratchClean(f.session)[0].reason).toBe('scratch owner alive or unknown');
  const inspect = spyOn(identity, 'inspect').mockReturnValue({ state: 'unknown' });
  try {
    expect(scratchClean(f.session)[0].action).toBe('skipped');
  } finally {
    inspect.mockRestore();
  }
  expect(existsSync(f.dir)).toBe(true);
  f.exited();
  expect(scratchClean(f.session)[0].action).toBe('removed');
  expect(scratchClean(f.session)).toEqual([]);
});

test.each(['exited', 'reused'] as const)(
  '%s owner is reclaimed without losing scratch contents; unmarked directories remain unclaimed',
  state => {
    const f = setup();
    writeFileSync(join(f.dir, 'keep'), 'session data');
    if (state === 'exited') f.exited();
    else
      writeFileSync(f.file, JSON.stringify({ ...f.owner, pid_start: 'different process start' }));
    expect(scratch.start({ session_id: f.session }, 'claude', {})).toEqual(f.context);
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toMatchObject({
      pid: process.pid,
      pid_start: f.owner.pid_start,
    });
    expect(readFileSync(join(f.dir, 'keep'), 'utf8')).toBe('session data');
    expect(scratchClean(f.session)[0].action).toBe('skipped');
    f.exited();
    expect(scratchClean(f.session)[0].action).toBe('removed');
    mkdirSync(f.dir);
    writeFileSync(join(f.dir, 'keep'), 'unowned');
    expect(() => scratch.start({ session_id: f.session }, 'claude', {})).toThrow();
    expect(existsSync(f.file)).toBe(false);
    expect(readFileSync(join(f.dir, 'keep'), 'utf8')).toBe('unowned');
  }
);

test('symbolic links, nested directories and outside paths are refused', () => {
  const f = setup(),
    outside = join(f.root, 'outside'),
    nested = join(f.dir, 'nested');
  mkdirSync(outside);
  mkdirSync(nested);
  writeFileSync(join(outside, 'keep'), 'keep');
  const link = join(scratch.ROOT, `codex-${f.session}`);
  dirs.push(link);
  symlinkSync(outside, link);
  expect(scratch.cleanOne(link, false, () => false).action).toBe('skipped');
  expect(scratch.cleanOne(outside, false, () => false).action).toBe('skipped');
  expect(scratch.cleanOne(nested, false, () => false).action).toBe('skipped');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
  expect(() => scratch.start({ session_id: '../../outside' }, 'claude', {})).toThrow(
    'session path invalid'
  );
});

test('nonterminal run plan copies referencing either scratch spelling retain the directory', () => {
  const f = setup();
  f.exited();
  mkdirSync(join(f.root, 'sa', 'plans'), { recursive: true });
  mkdirSync(join(f.root, 'sa', 'runs'));
  mkdirSync(join(f.root, 'gen'));
  const plan = join(f.root, 'sa', 'plans', 'active.json');
  writeFileSync(plan, JSON.stringify({ repo: realpathSync(f.dir) }));
  writeFileSync(join(f.root, 'gen', 'plan.json'), '{}');
  const l: Ledger = {
    run_id: 'active',
    archon_run_id: 'engine-active',
    plan,
    gen_dir: join(f.root, 'gen'),
    repo: f.root,
    branch: 'sa/active',
    workflow: 'active',
    console: 'codex',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
  };
  writeFileSync(ledgerPath(l.run_id), JSON.stringify(l));
  query = spyOn(archon, 'getRun').mockReturnValue({ id: l.archon_run_id, status: 'running' });
  expect(scratchClean(f.session)[0].reason).toContain('nonterminal run plan');
  expect(existsSync(f.dir)).toBe(true);
  query.mockImplementation(() => {
    throw new Error('Archon unavailable');
  });
  expect(scratchClean(f.session)[0].reason).toBe('Archon unavailable');
  query.mockReturnValue({ id: l.archon_run_id, status: 'completed' });
  expect(scratchClean(f.session)[0].action).toBe('removed');
});

test('a relative launch plan path falls back to the gen copy instead of blocking every directory', () => {
  const f = setup();
  f.exited();
  mkdirSync(join(f.root, 'sa', 'runs'), { recursive: true });
  mkdirSync(join(f.root, 'gen'));
  writeFileSync(join(f.root, 'gen', 'plan.json'), JSON.stringify({ repo: realpathSync(f.dir) }));
  const l: Ledger = {
    run_id: 'relative',
    archon_run_id: 'engine-relative',
    plan: '.context/sessions/missing/plan.json',
    gen_dir: join(f.root, 'gen'),
    repo: f.root,
    branch: 'sa/relative',
    workflow: 'relative',
    console: 'codex',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
  };
  writeFileSync(ledgerPath(l.run_id), JSON.stringify(l));
  query = spyOn(archon, 'getRun').mockReturnValue({ id: l.archon_run_id, status: 'running' });
  expect(scratchClean(f.session)[0].reason).toContain('nonterminal run plan');
  query.mockReturnValue({ id: l.archon_run_id, status: 'completed' });
  expect(scratchClean(f.session)[0].action).toBe('removed');
});

// prettier-ignore
test('a missing absolute launch plan does not block unrelated scratch cleanup', () => {
  const f = setup();
  f.exited();
  mkdirSync(join(f.root, 'sa', 'runs'), { recursive: true });
  mkdirSync(join(f.root, 'gen'));
  writeFileSync(join(f.root, 'gen', 'plan.json'), '{}');
  const l: Ledger = {
    run_id: 'missing-launch', archon_run_id: 'engine-missing', plan: join(f.root, 'missing.json'),
    gen_dir: join(f.root, 'gen'), repo: f.root, branch: 'sa/missing-launch', workflow: 'missing',
    console: 'codex', started_at: '', transcript: '', log: '', recoveries: [],
  };
  writeFileSync(ledgerPath(l.run_id), JSON.stringify(l));
  expect(scratchClean(f.session)[0].action).toBe('removed');
});

test('CLI dry-run leaves the worktree, symlink, owner and log unchanged', () => {
  const f = setup(),
    repo = gitRepo(f.root),
    wt = join(f.dir, 'wt'),
    target = join(f.root, 'modules');
  mkdirSync(target);
  git(repo, 'worktree', 'add', '-b', 'dry-fixture', wt);
  symlinkSync(target, join(wt, 'node_modules'));
  f.exited();
  const before = logInfo(),
    owner = readFileSync(f.file, 'utf8'),
    trees = git(repo, 'worktree', 'list', '--porcelain');
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(main(['scratch-clean', '--session', f.session, '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0])).scratch[0].action).toBe('would_remove');
  } finally {
    log.mockRestore();
  }
  expect(logInfo()).toEqual(before);
  expect(readFileSync(f.file, 'utf8')).toBe(owner);
  expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(trees);
  expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
});

test('GC-A releases an outside fake worktree so the next scratch cleanup succeeds', () => {
  const f = setup(),
    repo = gitRepo(f.dir),
    id = 'fake-fixture',
    gen = join(f.root, 'gen');
  const wt = join(f.root, 'archon', 'workspaces', 'owner', 'repo', 'worktrees', 'sa', id);
  mkdirSync(join(wt, '..'), { recursive: true });
  git(repo, 'worktree', 'add', '-b', `sa/${id}`, wt);
  mkdirSync(gen);
  mkdirSync(join(f.root, 'sa', 'runs'), { recursive: true });
  const plan = fixturePlan(f.root, repo);
  writeFileSync(join(gen, 'plan.json'), readFileSync(plan));
  writeFileSync(join(gen, 'engine.json'), '{"fake":true}');
  const l: Ledger = {
    run_id: id,
    archon_run_id: 'engine-fake',
    plan,
    gen_dir: gen,
    repo,
    branch: `sa/${id}`,
    workflow: 'fake',
    console: 'codex',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
  };
  writeFileSync(ledgerPath(id), JSON.stringify(l));
  query = spyOn(archon, 'getRun').mockReturnValue({
    id: l.archon_run_id,
    status: 'completed',
    working_path: wt,
  });
  f.exited();
  expect(scratchClean(f.session)[0].action).toBe('skipped');
  expect(gc(false, [f.root]).map(e => e.action)).toEqual(['removed', 'removed']);
  expect(scratchClean(f.session)[0].action).toBe('removed');
  expect(existsSync(wt)).toBe(false);
  expect(existsSync(repo)).toBe(false);
  expect(existsSync(ledgerPath(id))).toBe(true);
  query.mockImplementation(() => {
    throw new Error('historical repo no longer exists');
  });
  const session = `test-${crypto.randomUUID()}`,
    dir = join(scratch.ROOT, `claude-${session}`);
  dirs.push(dir);
  scratch.start({ session_id: session }, 'claude', {});
  const exited = spawnSync('true');
  expect(exited.status).toBe(0);
  writeFileSync(
    join(dir, '.owner.json'),
    JSON.stringify({ ...f.owner, session, pid: exited.pid, pid_start: 'exited fixture process' })
  );
  expect(scratchClean(session)[0].action).toBe('removed');
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(ledgerPath(id))).toBe(true);
});

test('production plan root stays configured while temporary scratch is explicitly admitted', () => {
  const f = setup(),
    repo = gitRepo(f.dir);
  expect(writeRoots()).toContain('/tmp/sa-scratch');
  expect(loadPlan(fixturePlan(f.root, repo)).repo).toBe(realpathSync(repo));
});

test('cleanup excludes takeover until deletion finishes, including canonical path aliases', () => {
  const f = setup();
  f.exited();
  let takeoverError: unknown;
  const result = scratch.cleanOne(realpathSync(f.dir), false, () => {
    try {
      scratch.start({ session_id: f.session }, 'claude', {});
    } catch (error) {
      takeoverError = error;
    }
    return false;
  });
  expect(takeoverError).toBeInstanceOf(Error);
  expect((takeoverError as Error).message).toBe('状态锁忙');
  expect(result.action).toBe('removed');
  expect(existsSync(f.dir)).toBe(false);
  expect(scratch.start({ session_id: f.session }, 'claude', {})).toEqual(f.context);
  writeFileSync(join(f.dir, 'keep'), 'resumed session');
  expect(scratch.cleanOne(f.dir, false, () => false).reason).toBe('scratch owner alive or unknown');
  expect(readFileSync(join(f.dir, 'keep'), 'utf8')).toBe('resumed session');
}, 10000);

test.each(['online', 'unknown'] as const)('different %s owner cannot be reclaimed', state => {
  const f = setup(),
    prior = { ...f.owner, pid: 2000000000 };
  writeFileSync(f.file, JSON.stringify(prior));
  const inspect = identity.inspect;
  const probe = spyOn(identity, 'inspect').mockImplementation(pid =>
    pid === prior.pid ? { state, start: prior.pid_start } : inspect(pid)
  );
  try {
    expect(() => scratch.start({ session_id: f.session }, 'claude', {})).toThrow('owner mismatch');
  } finally {
    probe.mockRestore();
  }
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual(prior);
});

test.each(['claude', 'codex'])(
  'guard %s SessionStart emits both scratch context and inbox notifications',
  client => {
    const f = setup(client),
      preload = join(f.root, 'preload.cjs');
    const guardFile = join(import.meta.dir, '..', 'hooks', 'guard.cjs');
    writeFileSync(
      preload,
      `const live = require(${JSON.stringify(join(import.meta.dir, '..', 'hooks', 'live.cjs'))});
    live.owner = () => ({pid: ${process.pid}, tty: null});
    live.beat = () => [{id: 'handoff-fixture', kind: 'task'}];`
    );
    const p = Bun.spawnSync(
      ['node', '--require', scratchPreload, '--require', preload, guardFile, client],
      {
        stdin: Buffer.from(
          JSON.stringify({ hook_event_name: 'SessionStart', session_id: f.session, cwd: f.root })
        ),
        env: {
          ...process.env,
          HOME: f.root,
          CLAUDE_ENV_FILE: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toBe('');
    const output = JSON.parse(p.stdout.toString()) as Context;
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toStartWith(`scratch: ${f.dir}/\n`);
    expect(output.hookSpecificOutput.additionalContext).toContain('handoff-fixture');
    expect(output.hookSpecificOutput.additionalContext).toContain('superagent inbox');
  }
);

test.each([
  '/tmp/sa-scratch/session/',
  '/private/tmp/sa-scratch/session/',
  '/tmp/sa-scratch',
  '/tmp/sa-scratch-other/',
])('CLI startup scopes TMPDIR removal to scratch paths (%s)', dir => {
  const f = setup(),
    probe = join(f.root, 'archon-probe');
  writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "${TMPDIR-unset}"\n', { mode: 0o700 });
  const script = `await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'cli.ts'))});
    const engine = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'archon.ts'))});
    const p = engine.archon(['workflow', 'status']);
    process.stdout.write(p.out); process.exit(p.code);`;
  const p = Bun.spawnSync([process.execPath, '--preload', scratchPreload, '-e', script], {
    env: { ...process.env, TMPDIR: dir, HOME: f.root, SA_ARCHON_BIN: probe },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.exitCode).toBe(0);
  expect(p.stderr.toString()).toBe('');
  expect(p.stdout.toString().trim()).toBe(dir === '/tmp/sa-scratch-other/' ? dir : 'unset');
});

test('supervise-tick persists a 15-minute GC throttle while scratch cleanup runs every tick', () => {
  const f = setup(),
    clean = spyOn(scratch, 'clean').mockReturnValue([]);
  const collect = spyOn(collection, 'gc').mockReturnValue([]);
  const fold = spyOn(memory, 'memoryTick').mockReturnValue({
    categories: { engine: 0, plan: 0, project: 0, role: 0, transient: 0 },
    episodes: [],
    errors: [],
  });
  try {
    const result = superviseTick();
    expect(result).toHaveProperty('scratch', []);
    expect(clean).toHaveBeenCalledWith(undefined, false, expect.any(Function));
    const stamp = join(f.root, 'sa', 'gc-tick');
    expect(existsSync(stamp)).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    const before = statSync(stamp).mtimeMs;
    superviseTick();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(statSync(stamp).mtimeMs).toBe(before);
    const old = new Date(Date.now() - 15 * 60_000);
    utimesSync(stamp, old, old);
    superviseTick();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(clean).toHaveBeenCalledTimes(3);
    expect(existsSync(f.dir)).toBe(true);
  } finally {
    clean.mockRestore();
    fold.mockRestore();
    collect.mockRestore();
  }
});
