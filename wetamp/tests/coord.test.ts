import { afterEach, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import * as launchers from '../src/launcher';
import { join } from 'node:path';
import { testTimeout } from '@archon/paths/test-utils';
import {
  Coordination,
  ACK_TIMEOUT_MS,
  caller,
  cleanEngine,
  repoScope,
  runScope,
  same,
  presence,
  escalationTitle,
  type Identity,
  type Message,
  type Presence,
  type RunRef,
} from '../src/coord';
import { ownerLost } from '../src/archon';
import * as native from '../src/archon';
import * as landing from '../src/land';
import { main, scopeOverlaps, waitRun, type Ledger } from '../src/cli';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';

const req = createRequire(import.meta.url);
const ids = req('../hooks/identity.cjs') as {
  inspect: (pid: number) => { start: string };
  presence: typeof presence;
};
const hooks = req('../hooks/coord.cjs') as {
  hash: (v: unknown) => string;
  repoScope: typeof repoScope;
  unread: (sa: string, who: Identity, seen: string[]) => Message[];
};
const a: Identity = {
  client: 'codex',
  session_id: 'A',
  host: hostname(),
  pid: process.pid,
  pid_start: ids.inspect(process.pid).start,
};
const b: Identity = { ...a, client: 'claude', session_id: 'B' };
const online: Presence = { state: 'online', activity: 'idle' };
const input = {
  kind: 'bug' as const,
  title: 'fixture engine failure',
  body: 'Details for recipient only.',
  evidence: ['/tmp/evidence.json'],
  severity: 'normal' as const,
};
const oldEnv = { ...process.env };
afterEach(() => {
  process.env = { ...oldEnv };
});
function setup(probe: (who: Identity) => Presence = () => online) {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa');
  mkdirSync(sa);
  const c = new Coordination({ sa, runs: () => [], status: () => 'running', presence: probe });
  return { root, repo, sa, c, scope: repoScope(repo) };
}
// Virtual time exercises real flock contention without sleeping for minutes.
// prettier-ignore
test.each(['release', 'truncated', 'timeout', 'default'])('delivery scope wait: %s', kind => {
  const s = setup();
  s.c.claim(s.scope, a);
  const file = join(s.sa, 'coord/locks', hooks.hash(s.scope) + '.lock');
  const lease = native.lock(file);
  if (!lease.ok) throw new Error('fixture lock busy');
  let now = 0, released = false, entered = false;
  s.c.d.now = () => now;
  if (kind === 'truncated') writeFileSync(file, '{');
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const sleep = spyOn(Bun, 'sleepSync').mockImplementation(() => {
    expect(entered).toBe(false);
    now += 60_000;
    if (now === 180_000 && ['release', 'truncated'].includes(kind)) {
      lease.release(); released = true;
    }
  });
  try {
    const budget = kind === 'default' ? undefined : landing.integrationLockTimeout();
    const action = () => s.c.mutate(s.scope, a, () => { entered = true; return 'delivered'; }, undefined, budget);
    if (['release', 'truncated'].includes(kind)) {
      expect(action()).toBe('delivered');
      expect(now).toBe(180_000);
      expect(output.mock.calls.flat().join('\n')).toContain(kind === 'truncated' ? 'pid unknown' : `pid ${process.pid}`);
    } else {
      expect(action).toThrow(`holder pid ${process.pid}`);
      expect(now).toBe(budget ?? 120_000);
      expect(entered).toBe(false);
    }
  } finally {
    sleep.mockRestore(); output.mockRestore();
    if (!released) lease.release();
  }
});
test('1: two actual processes race for one scope under flock; exactly one owner and monotonic generations', async () => {
  const s = setup();
  const code = `import {Coordination} from ${JSON.stringify(join(import.meta.dir, '../src/coord/index.ts'))};
    const c=new Coordination({sa:process.env.SUPERAGENT_HOME,runs:()=>[],presence:()=>({state:'online',activity:'idle'})});
    const id={client:'codex',session_id:process.argv[1],host:'fixture',pid:process.pid,pid_start:'start'};
    try { c.claim(${JSON.stringify(s.scope)},id); process.exit(0); } catch {process.exit(1);}`;
  const procs = ['one', 'two'].map(id =>
    Bun.spawn([process.execPath, '-e', code, id], {
      env: { ...process.env, SUPERAGENT_HOME: s.sa },
      stdout: 'ignore',
      stderr: 'pipe',
    })
  );
  expect((await Promise.all(procs.map(p => p.exited))).sort()).toEqual([0, 1]);
  expect(s.c.owner(s.scope).generation).toBe(1);
  s.c.claim(s.scope, a, true, 'operator takeover');
  expect(s.c.owner(s.scope).generation).toBe(2);
});

test('reauthorize requires both owners and stale records remain fenced', () => {
  let oldOffline = false;
  const s = setup(who =>
    oldOffline && same(who, a) ? { state: 'offline' } : { state: 'online', activity: 'idle' }
  );
  const gen = join(s.root, 'gen'),
    run = { run_id: 'target', archon_run_id: 'engine', repo: s.repo, gen_dir: gen },
    runTarget = runScope(run),
    record = join(s.sa, 'coord/authorizations/target.json');
  mkdirSync(gen);
  writeFileSync(join(gen, 'delivery-authorization.json'), '{"original":true}\n');
  s.c.claim(s.scope, a);
  s.c.claim(runTarget, a);
  expect(() => s.c.claimRun(runTarget, b)).toThrow('普通认领');
  expect(existsSync(record)).toBe(false);
  expect(s.c.owner(s.scope).owner).toEqual(a);
  expect(s.c.owner(runTarget).owner).toEqual(a);
  oldOffline = true;
  expect(s.c.claimRun(runTarget, b)).toMatchObject({ controller: b, repository: b });
  const authorization = s.c.reauthorize(run, b);
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(authorization);
  const replay = () =>
    s.c.mutate(
      runTarget,
      authorization.run,
      () =>
        s.c.mutate(s.scope, authorization.run, () => 'published', authorization.repo.generation),
      authorization.run.generation
    );
  expect(replay()).toBe('published'); // Same-user copies of current identity + generations + leases are out of scope.
  rmSync(join(s.sa, 'coord/leases'), { recursive: true });
  expect(replay).toThrow('fencing');
  s.c.claim(s.scope, a, true, 'later takeover');
  s.c.claim(runTarget, a, true, 'later takeover');
  expect(replay).toThrow('fencing');
});
test('claimRun takeover preserves an online repository owner atomically', () => {
  let repoOffline = false;
  const runOwner = { ...a, session_id: 'run-owner' },
    s = setup(who =>
      same(who, a) ? (repoOffline ? { state: 'offline' } : online) : { state: 'offline' }
    ),
    target = runScope({ run_id: 'target', repo: s.repo });
  s.c.claim(s.scope, a);
  s.c.claim(target, runOwner);
  const before = [s.c.owner(target), s.c.owner(s.scope)];
  let message = '';
  try {
    s.c.claimRun(target, b, true, '用户授权接管 run');
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('codex A 负责（在线）');
  expect(message).toContain(`superagent handoff --to ${target.repo}`);
  expect(message).toContain(`superagent claim ${target.repo} --takeover --reason "<原话>"`);
  expect([s.c.owner(target), s.c.owner(s.scope)]).toEqual(before);
  repoOffline = true;
  expect(s.c.claimRun(target, b, true, '用户授权接管 run')).toMatchObject({
    controller: b,
    repository: b,
  });
});
test('claimRun takeover succeeds when the caller owns the repository', () => {
  const s = setup(who => (same(who, a) ? { state: 'offline' } : online)),
    target = runScope({ run_id: 'target', repo: s.repo });
  s.c.claim(s.scope, b);
  s.c.claim(target, a);
  expect(s.c.claimRun(target, b, true, '用户授权接管 run')).toMatchObject({
    controller: b,
    repository: b,
  });
});
test('2: PID reuse is offline and old identity/generation cannot mutate (three human-readable lines)', () => {
  const s = setup();
  const old = { ...a, pid_start: 'old-lifetime' };
  const actual = new Coordination({ sa: s.sa, runs: () => [] });
  s.c.claim(s.scope, old);
  expect(presence(old, s.sa)).toEqual({ state: 'offline' });
  actual.claim(s.scope, a);
  expect(actual.owner(s.scope).generation).toBe(2);
  expect(() => actual.mutate(s.scope, old, () => true, 1)).toThrow(
    /已拒绝：.*\n原因：.*\n可以：superagent handoff/
  );
  expect(() => actual.mutate(s.scope, a, () => true, 1)).toThrow(/fencing/);
});
test('3: online ordinary claim refused; explicit takeover requires a reason and notifies old owner', () => {
  const s = setup(),
    claimed = s.c.claim(s.scope, a);
  expect(s.c.mutate(s.scope, claimed.controller, () => true, claimed.controller.generation)).toBe(
    true
  );
  expect(() => s.c.claim(s.scope, b)).toThrow(/普通认领/);
  expect(() => s.c.claim(s.scope, b, true, '')).toThrow(/reason/);
  s.c.claim(s.scope, b, true, '用户原话：交给B');
  expect(s.c.inbox(a)[0]).toMatchObject({
    type: 'takeover',
    body: '用户原话：交给B',
    generation: 2,
  });
});
test('4: cross-host unknown never auto-transfers; timeout escalates through injected supervisor', () => {
  const s = setup(who => presence(who, ''));
  const remote = { ...a, host: 'remote-host' };
  s.c.claim(s.scope, remote);
  expect(() => s.c.claim(s.scope, b)).toThrow(/状态未知/);
  const out = s.c.handoff(s.scope, b, input),
    now = Date.now() + ACK_TIMEOUT_MS + 1000;
  const c = new Coordination({ sa: s.sa, runs: () => [], now: () => now });
  const calls: string[] = [];
  c.tick((_key, q) => {
    calls.push(q);
    return { id: 'stub-ask', status: 'pending' };
  });
  expect(calls).toHaveLength(1);
  expect(c.owner(s.scope).owner).toEqual(remote);
  expect(calls[0]).not.toContain(input.title);
  expect(calls[0]).toContain(String(out.id).slice(0, 12));
});
test('5: self, online, offline backlog and unowned route deterministically; next claim sees backlog', () => {
  const s = setup();
  s.c.claim(s.scope, a);
  expect(s.c.handoff(s.scope, a, input)).toMatchObject({ delivery: 'self', next: '自己处理' });
  expect(s.c.messages()).toHaveLength(0);
  const sent = s.c.handoff(s.scope, b, input);
  expect(sent).toMatchObject({ presence: online });
  const offline = new Coordination({
    sa: s.sa,
    runs: () => [],
    presence: () => ({ state: 'offline' }),
  });
  expect(
    offline.tick(() => {
      throw new Error('ordinary offline must remain queued');
    })
  ).toEqual([]);
  expect(offline.claim(s.scope, b).inbox).toHaveLength(1);
});
test('5: unowned finder claims and receives own task; urgent offline asks immediately and yes transfers', () => {
  const s = setup();
  expect(s.c.handoff(s.scope, b, input)).toMatchObject({ next: '已认领，由你处理' });
  expect(s.c.inbox(b)).toHaveLength(1);
  const other = setup();
  other.c.claim(other.scope, a);
  const c = new Coordination({
    sa: other.sa,
    runs: () => [],
    presence: () => ({ state: 'offline' }),
  });
  c.handoff(other.scope, b, { ...input, severity: 'urgent' });
  const titles: string[] = [];
  c.tick((_key, q) => {
    titles.push(q);
    return { id: 'stub', status: 'yes' };
  });
  expect(titles).toHaveLength(1);
  expect(c.owner(other.scope).owner).toEqual(b);
});
test('6: delivery and ack are idempotent; only recipient acks; sender receives durable receipt', () => {
  const s = setup();
  s.c.claim(s.scope, a);
  const one = s.c.handoff(s.scope, b, input),
    two = s.c.handoff(s.scope, b, input);
  expect(one.id).toBe(two.id);
  expect(s.c.messages()).toHaveLength(1);
  expect(() => s.c.ack(String(one.id), b, 'accepted', 'ok')).toThrow(/fencing/);
  expect(() => s.c.ack('../claims/foreign', a, 'done', '')).toThrow(/invalid message id/);
  s.c.ack(String(one.id), a, 'accepted', 'working');
  s.c.ack(String(one.id), a, 'accepted', 'working');
  expect(s.c.inbox(b)).toMatchObject([{ type: 'receipt', body: 'accepted: working' }]);
  expect(s.c.messages()).toHaveLength(2);
  s.c.ack(String(one.id), a, 'done', 'fixed');
  expect(s.c.messages().filter(m => m.type === 'receipt')).toHaveLength(2);
  expect(() => s.c.ack(String(one.id), a, 'accepted', 'again')).toThrow(/invalid state/);
});
test('handoff can fail immediately when the registry is busy', () => {
  const s = setup();
  mkdirSync(join(s.sa, 'coord'));
  const held = native.lock(join(s.sa, 'coord/registry.lock'));
  expect(held.ok).toBe(true);
  try {
    const started = Date.now();
    expect(() => s.c.handoff(s.scope, b, input, 0, false)).toThrow('coord: registry busy');
    expect(Date.now() - started).toBeLessThan(100);
  } finally {
    if (held.ok) held.release();
  }
});
test('7: handoff wakes A wait before querying provider', async () => {
  const s = setup(),
    project = gitRepo(tmp());
  s.c.claim(s.scope, a);
  s.c.claim(repoScope(project), b);
  mkdirSync(join(s.sa, 'live'));
  writeFileSync(join(s.sa, 'live/b.json'), JSON.stringify(b));
  const out = s.c.handoff(s.scope, b, input);
  // Use the real CLI caller identity to deliver an inbox item, then prove wait short-circuits getRun.
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
  });
  const { caller } = await import('../src/coord');
  const actor = caller();
  s.c.claim(s.scope, actor, true, 'wait fixture');
  const l = { run_id: 'fixture', repo: s.repo, archon_run_id: 'never-provider' } as Ledger;
  process.env.SA_ARCHON_BIN = '/nonexistent';
  const result = waitRun(l, 30);
  expect(result).toMatchObject({ state: 'inbox', exit: 3 });
  expect((result.inbox as Message[]).some(m => m.id === out.id)).toBe(true);
});
test('5/7: heartbeat delivers only once per recipient; no spawned hook transport', () => {
  const s = setup(),
    live = req('../hooks/live.cjs');
  // live names hash the raw session; derive its actual name with node crypto.
  const name = req('node:crypto')
    .createHash('sha256')
    .update('fixture-session')
    .digest('hex')
    .slice(0, 16);
  const beatFile = join(s.sa, 'live', `codex-${name}.json`);
  mkdirSync(join(s.sa, 'live'));
  const recipient = { ...a, session_id: 'fixture-session' };
  s.c.claim(s.scope, recipient);
  s.c.handoff(s.scope, b, input);
  writeFileSync(
    beatFile,
    JSON.stringify({ ...recipient, at: new Date().toISOString(), event: 'Stop', coord_seen: [] })
  );
  const p = { session_id: 'fixture-session', cwd: s.repo, hook_event_name: 'UserPromptSubmit' };
  expect(live.beat('codex', p, () => 'commander', { SUPERAGENT_HOME: s.sa })).toHaveLength(1);
  expect(live.beat('codex', p, () => 'commander', { SUPERAGENT_HOME: s.sa })).toHaveLength(0);
  expect(readFileSync(beatFile, 'utf8')).not.toContain(input.body);
});
test('8: dirty and uncommitted engine rejected; committed clean snapshot has exact commit SHA', () => {
  const root = tmp(),
    repo = gitRepo(root);
  const sha = sh('git rev-parse HEAD', repo).trim();
  expect(cleanEngine(repo)).toBe(sha);
  writeFileSync(join(repo, 'README.md'), 'dirty');
  expect(() => cleanEngine(repo)).toThrow(/不干净/);
  sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm fixed', repo);
  expect(cleanEngine(repo)).not.toBe(sha);
});
test('9: old ledger controller falls back to launcher; linked worktrees share repository identity; Orca disabled', () => {
  const s = setup(),
    runs: RunRef[] = [
      {
        run_id: 'old',
        archon_run_id: 'r',
        repo: s.repo,
        launcher: { ...a, client: 'codex', tty: null, cwd: s.repo },
      },
      {
        run_id: 'gone',
        archon_run_id: 'g',
        repo: join(s.root, 'deleted-repo'),
        launcher: { ...b, client: 'codex', session_id: 'C', tty: null, cwd: s.root },
      },
    ];
  const c = new Coordination({
    sa: s.sa,
    runs: () => runs,
    status: () => 'running',
    presence: () => online,
  });
  expect(c.owner(s.scope)).toMatchObject({
    owner: a,
    evidence: ['nonterminal run old legacy launcher'],
  });
  c.rolloverTransfer(runScope(runs[0]), a, b, 'token');
  expect(c.unfinishedRuns('A')).toEqual([]);
  expect(c.unfinishedRuns('B')).toEqual([{ run_id: 'old', status: 'running' }]);
  const wt = join(s.root, 'linked');
  sh(`git worktree add -q -b linked '${wt}'`, s.repo);
  expect(repoScope(wt)).toEqual(s.scope);
  expect(hooks.repoScope(join(wt, 'new.ts'))).toEqual(s.scope);
  process.env.SA_ORCA = '0';
  process.env.SA_ORCA_BIN = '/nonexistent';
  c.claim(s.scope, a);
  expect(c.handoff(s.scope, b, input).delivery).toBe('queued');
});
test('presence active/idle/offline/unknown comes from one verifier, not heartbeat expiry', () => {
  const s = setup();
  expect(presence(a, s.sa)).toEqual({ state: 'online', activity: 'idle' });
  mkdirSync(join(s.sa, 'live'));
  writeFileSync(join(s.sa, 'live/a.json'), JSON.stringify({ ...a, at: new Date().toISOString() }));
  expect(presence(a, s.sa)).toEqual({ state: 'online', activity: 'active' });
  expect(presence({ ...a, pid: 99999999 }, s.sa)).toEqual({ state: 'offline' });
  expect(presence({ ...a, pid_start: undefined }, s.sa)).toEqual({ state: 'unknown' });
});
// Only engine observation is stubbed: ancestry, identity, CLI claim and coordination storage are real.
for (const mode of ['inbox', 'takeover', 'completed'])
  test(`P5: orphaned wait retains its original inbox and fencing (${mode})`, async () => {
    const s = setup();
    const module = (file: string) => JSON.stringify(join(import.meta.dir, '../src', file));
    const file = (name: string) => JSON.stringify(join(s.root, name));
    const child = join(s.root, 'wait.ts');
    writeFileSync(
      child,
      `
import {spyOn} from 'bun:test';
import {existsSync,writeFileSync} from 'node:fs';
import * as native from ${module('archon.ts')};
import * as land from ${module('land.ts')};
import {caller,coord,runScope,repoScope} from ${module('coord/index.ts')};
import {main} from ${module('cli.ts')};
const before=caller(), parent=process.ppid, mode=${JSON.stringify(mode)};
let after, landed=false, observed=false, fencing=[];
const output=[];
spyOn(native,'getRun').mockImplementation(() => ({id:'engine',status:observed && mode==='completed'?'completed':'pending',nodes:[]}));
spyOn(native,'waitNotification').mockImplementation(() => {
  writeFileSync(${file('ready')},String(process.pid));
  const deadline=Date.now()+10000;
  while(process.ppid===parent && Date.now()<deadline) Bun.sleepSync(10);
  if(process.ppid===parent) throw new Error('background shell did not exit');
  after=caller(true);
  writeFileSync(${file('reparented')},String(process.ppid));
  while(!existsSync(${file('resume')}) && Date.now()<deadline) Bun.sleepSync(10);
  if(!existsSync(${file('resume')})) throw new Error('controller did not resume wait');
  observed=true;
});
spyOn(console,'log').mockImplementation(x=>output.push(JSON.parse(x)));
try {
  const code=main(['wait','background','--timeout','15','--json']);
  if(mode==='takeover') for(const scope of [repoScope(${JSON.stringify(s.repo)}),runScope({run_id:'background',repo:${JSON.stringify(s.repo)}})]) {
    try {coord().mutate(scope,before,()=>{throw new Error('mutation executed');},1);}
    catch(e) {fencing.push(e.message);}
  }
  writeFileSync(${file('result')},JSON.stringify({before,after,parent,reparented:process.ppid,landed,output,code,fencing}));
} catch(e) {writeFileSync(${file('result')},JSON.stringify({error:e.stack}));}
`
    );
    // A second live controller invokes the actual claim CLI, without overriding caller().
    writeFileSync(
      join(s.root, 'codex'),
      `
import {writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {inspectProcess} from ${module('launcher.ts')};
const who={client:'codex',session_id:'B',host:hostname(),pid:process.pid,pid_start:inspectProcess(process.pid).start};
writeFileSync(${JSON.stringify(join(s.sa, 'live/b.json'))},JSON.stringify({...who,at:new Date().toISOString()}));
const code=\`import {main} from ${module('cli.ts')};
let refused=false;
try {main(['claim',${JSON.stringify(s.repo)}]);} catch(e) {refused=e.message.includes('普通认领');}
if(!refused) throw new Error('online owner was not fenced');
for(const target of [${JSON.stringify(s.repo)},'background']) main(['claim',target,'--takeover','--reason','scratch operator authorized B']);\`;
const p=Bun.spawnSync([process.execPath,'-e',code],{stdout:'ignore',stderr:'pipe'});
if(p.exitCode!==0) throw new Error(p.stderr.toString());
`
    );
    const parent = join(s.root, 'claude');
    writeFileSync(
      parent,
      `
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {Coordination,repoScope,runScope} from ${module('coord/index.ts')};
import {inspectProcess} from ${module('launcher.ts')};
const sa=process.env.SUPERAGENT_HOME,repo=${JSON.stringify(s.repo)},mode=${JSON.stringify(mode)};
mkdirSync(join(sa,'live'),{recursive:true});mkdirSync(join(sa,'runs'),{recursive:true});
const who={client:'claude',session_id:'A',host:hostname(),pid:process.pid,pid_start:inspectProcess(process.pid).start};
const c=new Coordination({sa,runs:()=>[]}),run=runScope({run_id:'background',repo});
for(const scope of [repoScope(repo),run]) c.claim(scope,who);
writeFileSync(join(sa,'live/a.json'),JSON.stringify({...who,at:new Date().toISOString()}));
writeFileSync(join(sa,'runs/background.json'),JSON.stringify({run_id:'background',archon_run_id:'engine',repo,controller:{...who,generation:1},gen_dir:sa,branch:'feature',workflow:'fixture',recoveries:[]}));
writeFileSync(join(sa,'plan.json'),JSON.stringify({base_ref:'main',packages:[]}));
const awaitFile=async file=>{
  const deadline=Date.now()+15000;
  while(!existsSync(file) && Date.now()<deadline) await Bun.sleep(10);
  if(!existsSync(file)) throw new Error('missing handshake: '+file);
};
// Exit as soon as wait reaches its blocking boundary; never wait for the background child.
const shell=Bun.spawn(['bash','-c','"$1" "$2" & child=$!; while kill -0 "$child" 2>/dev/null && [ ! -f "$3" ]; do sleep 0.01; done','_',process.execPath,${JSON.stringify(child)},${file('ready')}],{stdout:'ignore',stderr:'inherit'});
if(await shell.exited!==0) throw new Error('parent shell failed');
await awaitFile(${file('reparented')});
if(mode==='takeover') {
  const p=Bun.spawn([process.execPath,${file('codex')}],{stdout:'ignore',stderr:'inherit'});
  if(await p.exited!==0) throw new Error('takeover failed');
}
let message;
if(mode!=='completed') message=c.handoff(run,mode==='takeover'?who:{...who,session_id:'sender'},${JSON.stringify(input)}).id;
writeFileSync(${file('resume')},'resume');
await awaitFile(${file('result')});
console.log(JSON.stringify({...JSON.parse(readFileSync(${file('result')},'utf8')),message,owner:c.owner(run),messages:c.messages()}));
`
    );
    const p = Bun.spawn([process.execPath, parent], {
      cwd: s.repo,
      env: {
        PATH: process.env.PATH,
        HOME: s.root,
        SUPERAGENT_HOME: s.sa,
        ARCHON_HOME: join(s.sa, 'archon'),
        SUPERAGENT_RELAY_QUOTA: 'off',
        SUPERAGENT_ROLE: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const result = JSON.parse(out);
    expect(result.error).toBeUndefined();
    expect(result.before).toMatchObject({ client: 'claude', session_id: 'A' });
    expect(result.reparented).not.toBe(result.parent);
    expect(result.after.client).toBe('shell');
    expect(result.after.pid).not.toBe(result.before.pid);
    expect(result.landed).toBe(false);
    if (mode === 'completed') {
      expect(result.output[0].state).toBe('completed');
      expect(result.output[0].delivery).toBeUndefined();
      expect(result.code).toBe(0);
    } else {
      expect(result.code).toBe(3);
      expect(result.output[0].state).toBe('inbox');
      const inbox = result.output[0].inbox as Message[];
      expect(inbox.length).toBeGreaterThan(0);
      for (const message of inbox) expect(same(message.recipient, result.before)).toBe(true);
      if (mode === 'inbox') expect(inbox.map(m => m.id)).toEqual([result.message]);
      else {
        expect(inbox.every(m => m.type === 'takeover' && m.generation === 2)).toBe(true);
        expect(inbox.map(m => m.id)).not.toContain(result.message);
        expect(result.messages.find((m: Message) => m.id === result.message).state).toBe('queued');
        expect(result.owner).toMatchObject({ generation: 2, owner: { session_id: 'B' } });
        expect(result.fencing).toHaveLength(2);
        for (const error of result.fencing) expect(error).toContain('owner/generation fencing');
      }
    }
  }, 30000);
test('P5: admission refusal uses owner presence and names run/repository scopes', () => {
  const s = setup();
  const c = new Coordination({ sa: s.sa, runs: () => [] });
  for (const [owner, state, label] of [
    [a, 'online', '在线'],
    [{ ...a, pid_start: 'old-lifetime' }, 'offline', '离线'],
    [{ ...a, host: 'remote' }, 'unknown', '状态未知'],
  ] as const) {
    for (const scope of [s.scope, runScope({ run_id: 'presence', repo: s.repo })]) {
      s.c.claim(scope, owner, true, 'presence fixture');
      expect(c.owner(scope).presence.state).toBe(state);
      for (const action of [
        () => c.admit(scope, b),
        () => req('../hooks/coord.cjs').admission(s.sa, scope, b),
      ]) {
        expect(action).toThrow(`（${label}）`);
        expect(action).toThrow(scope.kind === 'run' ? '这个运行由' : '这个仓库由');
      }
    }
  }
});
test('CLI mutation obeys owner fencing before invoking engine; read-only owner remains available', () => {
  const s = setup();
  s.c.claim(s.scope, a);
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
  });
  mkdirSync(join(s.sa, 'runs'));
  writeFileSync(
    join(s.sa, 'runs/r.json'),
    JSON.stringify({
      run_id: 'r',
      archon_run_id: 'provider',
      controller: { ...a, generation: 1 },
      repo: s.repo,
      gen_dir: s.root,
      branch: 'feature',
      workflow: 'fixture',
      recoveries: [],
    })
  );
  expect(() => main(['decide', 'r', 'retry'])).toThrow(/fencing/);
  expect(() => main(['cancel', 'r'])).toThrow(/fencing/);
  expect(escalationTitle({ ...input, id: 'abc123' } as Message, 'offline')).toContain('负责人离线');
});

test('ambiguous legacy controllers require explicit takeover; all previous owners are notified', () => {
  const s = setup();
  const c = new Coordination({
    sa: s.sa,
    runs: () =>
      [a, b].map((owner, i) => ({
        run_id: `r${i}`,
        archon_run_id: `p${i}`,
        repo: s.repo,
        controller: { ...owner, generation: i + 2 },
      })),
    status: () => 'running',
    presence: () => online,
  });
  expect(c.owner(s.scope).conflicts).toHaveLength(2);
  expect(() => c.claim(s.scope, a)).toThrow(/conflicting/);
  const next = { ...a, session_id: 'C' };
  c.claim(s.scope, next, true, 'operator resolves ambiguity');
  expect(c.owner(s.scope).generation).toBe(4);
  expect(c.inbox(a)[0].type).toBe('takeover');
  expect(c.inbox(b)[0].type).toBe('takeover');
});
test('hook legacy fallback, repository backlog after takeover, and released tombstone agree with CLI', () => {
  const s = setup();
  mkdirSync(join(s.sa, 'runs'));
  const l = {
    run_id: 'old',
    archon_run_id: 'p',
    repo: s.repo,
    launcher: { ...a, client: 'codex' as const, tty: null, cwd: s.repo },
  };
  writeFileSync(join(s.sa, 'runs/old.json'), JSON.stringify(l));
  mkdirSync(join(s.sa, 'live'));
  writeFileSync(join(s.sa, 'live/b.json'), JSON.stringify(b));
  const c = new Coordination({
    sa: s.sa,
    runs: () => [l],
    status: () => 'running',
    presence: () => online,
  });
  const runScope = c.scope('old');
  c.handoff(runScope, b, input);
  c.claim(s.scope, b, true, 'takeover');
  expect(c.owner(runScope).owner).toEqual(l.launcher);
  expect(hooks.unread(s.sa, a, []).filter(m => !m.type)).toHaveLength(1);
  c.claim(runScope, b, true, 'run takeover');
  expect(hooks.unread(s.sa, b, []).filter(m => !m.type)).toHaveLength(1);
  c.release(runScope, b);
  c.release(s.scope, b);
  expect(c.owner(runScope).owner).toBeNull();
  expect(hooks.unread(s.sa, a, []).filter(m => !m.type)).toHaveLength(0);
});
test('no stops re-asking for this owner; expired re-asks after an interval with a new key; stale yes is fenced', () => {
  const s = setup();
  s.c.claim(s.scope, a);
  s.c.handoff(s.scope, b, { ...input, severity: 'urgent' });
  let now = Date.now();
  const c = new Coordination({
    sa: s.sa,
    runs: () => [],
    now: () => now,
    presence: () => ({ state: 'offline' }),
  });
  const keys: string[] = [];
  c.tick(key => {
    keys.push(key);
    return { status: 'no' };
  });
  expect(
    c.tick(() => {
      throw new Error('must defer');
    })
  ).toEqual([]);
  now += 10 * ACK_TIMEOUT_MS;
  expect(
    c.tick(() => {
      throw new Error('no must not be re-asked');
    })
  ).toEqual([]);
  c.claim(s.scope, { ...a, session_id: 'C' }, true, 'new owner');
  c.tick(key => {
    keys.push(key);
    return { status: 'expired' };
  });
  now += ACK_TIMEOUT_MS + 1;
  c.tick(key => {
    keys.push(key);
    return { status: 'pending' };
  });
  expect(new Set(keys).size).toBe(3);
  expect(() =>
    c.tick(() => {
      c.claim(s.scope, { ...a, session_id: 'D' }, true, 'newer owner');
      return { status: 'yes' };
    })
  ).toThrow(/stale takeover/);
});
test('real CLI urgent and unknown-timeout use only temporary supervisor state and a Python stub', () => {
  const s = setup();
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    AGENT_SUPERVISOR_STATE: join(s.root, 'supervisor'),
    SA_SUPERVISOR: join(s.root, 'supervisor.py'),
  });
  mkdirSync(process.env.AGENT_SUPERVISOR_STATE!, { recursive: true });
  writeFileSync(
    process.env.SA_SUPERVISOR!,
    `import os,sys,json\np=os.environ['AGENT_SUPERVISOR_STATE']\nwith open(p+'/calls','a') as f: f.write(json.dumps(sys.argv[1:],ensure_ascii=False)+'\\n')\nprint('fixture-ask' if sys.argv[1]=='ask' else 'pending')\n`
  );
  const body = join(s.root, 'body.md');
  writeFileSync(body, input.body);
  s.c.claim(s.scope, { ...a, pid: 99999999 });
  expect(
    main([
      'handoff',
      '--to',
      s.repo,
      '--kind',
      'bug',
      '--title',
      'private title',
      '--body-file',
      body,
      '--severity',
      'urgent',
      '--json',
    ])
  ).toBe(0);
  const log = readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8');
  expect(log).toContain('负责人离线');
  expect(log).not.toContain('private title');
  expect(s.c.owner(s.scope).owner?.pid).toBe(99999999);
  const remote = { ...a, host: 'remote' };
  s.c.claim(s.scope, remote, true, 'fixture');
  const m = s.c.messages().find(m => !m.type)!;
  m.at = new Date(Date.now() - ACK_TIMEOUT_MS - 1000).toISOString();
  writeFileSync(join(s.sa, 'coord/inbox', m.id + '.json'), JSON.stringify(m));
  expect(
    main([
      'handoff',
      '--to',
      s.repo,
      '--kind',
      'bug',
      '--title',
      'private title',
      '--body-file',
      body,
      '--severity',
      'urgent',
      '--json',
    ])
  ).toBe(0);
  expect(readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8')).toContain(
    '状态未知'
  );
  expect(s.c.owner(s.scope).owner).toEqual(remote);

  const calls = readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8');
  mkdirSync(join(s.sa, 'console'), { recursive: true });
  writeFileSync(join(s.sa, 'console/decision-origin'), 'https://decision.example.test');
  s.c.claim(s.scope, { ...a, pid: 99999998 }, true, 'mobile fixture');
  expect(
    main([
      'handoff',
      '--to',
      s.repo,
      '--kind',
      'bug',
      '--title',
      'mobile title',
      '--body-file',
      body,
      '--severity',
      'urgent',
      '--json',
    ])
  ).toBe(0);
  expect(readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8')).toBe(calls);
  expect(Object.values(JSON.parse(readFileSync(join(s.sa, 'asks.json'), 'utf8')))).toContainEqual({
    status: 'pending',
  });
});
test('wait already blocking returns inbox after a new message arrives, before timeout', () => {
  const s = setup();
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
  });
  s.c.claim(s.scope, caller());
  const bin = join(s.root, 'archon');
  const message = {
    ...input,
    id: 'late-message',
    scope: s.scope,
    sender: b,
    recipient: caller(),
    generation: 1,
    state: 'queued',
    at: new Date().toISOString(),
  };
  const file = join(s.sa, 'coord/inbox/late-message.json');
  mkdirSync(join(s.sa, 'coord/inbox'), { recursive: true });
  // The wait boundary itself is the subject: its stub deposits mail during the first wait slice.
  writeFileSync(
    bin,
    `#!/usr/bin/env python3\nimport sys,json\nif sys.argv[2]=='get': print(json.dumps({'id':'p','status':'running','metadata':{'execution_owner':{'host':${JSON.stringify(hostname())},'pid':${String(process.pid)}}}}))\nelse:\n open(${JSON.stringify(file)},'w').write(${JSON.stringify(JSON.stringify(message))})\n print(json.dumps({'ok':True,'action':'wait','runId':'p','result':'deadline'}))\n`
  );
  sh(`chmod +x '${bin}'`, s.root);
  process.env.SA_ARCHON_BIN = bin;
  const start = Date.now();
  expect(
    waitRun(
      { run_id: 'late', archon_run_id: 'p', repo: s.repo, recoveries: [] } as unknown as Ledger,
      30
    )
  ).toMatchObject({ state: 'inbox', exit: 3 });
  expect(Date.now() - start).toBeLessThan(5000);
});

function registered(
  s: ReturnType<typeof setup>,
  controller = s.c.claim(s.scope, a).controller
): Ledger {
  const l = {
    run_id: 'ledger-id',
    archon_run_id: 'archon-id',
    repo: s.repo,
    controller,
    gen_dir: s.root,
    plan: 'plan.json',
    branch: 'sa/fixture',
    workflow: 'fixture',
    console: 'codex',
    started_at: new Date().toISOString(),
    recoveries: [],
    transcript: '',
    log: '',
  } as Ledger;
  mkdirSync(join(s.sa, 'runs'), { recursive: true });
  writeFileSync(join(s.sa, 'runs', l.run_id + '.json'), JSON.stringify(l));
  return l;
}
function isolated(s: ReturnType<typeof setup>): void {
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    AGENT_SUPERVISOR_STATE: join(s.root, 'supervisor'),
    SA_SUPERVISOR: join(s.root, 'disabled-supervisor'),
    SA_ORCA: '0',
    SA_COORD_ADMISSION: '',
  });
}
test('R1-01/06: actual hooks allow cd and nested-shell writes across owners', async () => {
  const s = setup(),
    other = gitRepo(tmp());
  s.c.claim(s.scope, a);
  mkdirSync(join(s.repo, 'owned path'));
  symlinkSync(join(s.repo, 'owned path'), join(other, 'link'));
  const commands = [
    `cd '${s.repo}' && echo x > tracked.txt`,
    `bash -c "cd '${s.repo}' && echo x > tracked.txt"`,
    `cd -- '${s.repo}' && echo x > tracked.txt`,
    `cd -P '${s.repo}' && echo x > tracked.txt`,
    `cd -L -- '${s.repo}' && echo x > tracked.txt`,
    `pushd '${s.repo}' && echo x > tracked.txt`,
    `(cd -- '${s.repo}' && echo x > tracked.txt)`,
    `cd -- '${s.repo}/owned path' && echo x > tracked.txt`,
    `cd -P link/.. && echo x > tracked.txt`,
    `/usr/bin/git -C '${s.repo}' status`,
  ];
  for (const [i, command] of commands.entries()) {
    const p = Bun.spawn(
      ['node', join(import.meta.dir, '../hooks/guard.cjs'), i % 2 ? 'codex' : 'claude'],
      {
        cwd: other,
        env: {
          ...process.env,
          SUPERAGENT_HOME: s.sa,
          ARCHON_HOME: join(s.sa, 'archon'),
          SUPERAGENT_ALLOW_COMMANDER_WRITE: '1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    p.stdin.write(
      JSON.stringify({
        session_id: 'foreign',
        cwd: other,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      })
    );
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).not.toContain('deny');
  }
});
test('INT-R1-01: actual Claude/Codex hooks allow Git across claimed locations', async () => {
  const s = setup(),
    other = gitRepo(tmp());
  s.c.claim(s.scope, a);
  const commands = [
    `git -C '${other}' -C '${s.repo}' add tracked.txt`,
    `git -C '${other}' -C '${s.repo}' -C . add tracked.txt`,
    `git --git-dir='${s.repo}/.git' --work-tree='${s.repo}' add tracked.txt`,
    `git --git-dir '${s.repo}/.git' --work-tree '${other}' add tracked.txt`,
    `git --git-dir '${other}/.git' --work-tree '${s.repo}' add tracked.txt`,
    `GIT_DIR='${s.repo}/.git' GIT_WORK_TREE='${s.repo}' git add tracked.txt`,
    `env GIT_DIR='${s.repo}/.git' GIT_WORK_TREE='${s.repo}' git add tracked.txt`,
    'git add tracked.txt',
    `git -C '${other}' add tracked.txt`,
    `git -C '${s.repo}' status`,
  ];
  for (const [i, command] of commands.entries()) {
    const p = Bun.spawn(
      ['node', join(import.meta.dir, '../hooks/guard.cjs'), i % 2 ? 'codex' : 'claude'],
      {
        cwd: other,
        env: {
          ...process.env,
          HOME: s.root,
          SUPERAGENT_HOME: s.sa,
          ARCHON_HOME: join(s.sa, 'archon'),
          SUPERAGENT_ALLOW_COMMANDER_WRITE: '1',
          GIT_DIR: i === 7 ? join(s.repo, '.git') : '',
          GIT_WORK_TREE: i === 7 ? s.repo : '',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    p.stdin.write(
      JSON.stringify({
        session_id: 'foreign',
        cwd: other,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      })
    );
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).not.toContain('deny');
  }
});
test(
  'R2-01: redline shares directory transitions and subshells keep the parent cwd',
  async () => {
    const s = setup();
    const secret = join(s.root, '.ssh');
    mkdirSync(secret);
    writeFileSync(join(secret, 'id_ed25519'), 'synthetic fixture');
    for (const role of ['', 'general'])
      for (const command of [
        'cd -LP -- "$HOME/.ssh" && cat id_ed25519',
        'pushd -- "$HOME/.ssh" && cat id_ed25519',
        'cd -P "$HOME/.ssh" && cat id_ed25519',
        '(cd "$HOME/.ssh" && cat id_ed25519)',
        'cd -L -- "$HOME/.ssh" && cat id_ed25519',
        'pushd "$HOME/.ssh" && cat id_ed25519',
        'cd "$HOME/.ssh" && pushd -- "$HOME" && popd && cat id_ed25519',
      ]) {
        const p = Bun.spawn(['node', join(import.meta.dir, '../hooks/guard.cjs'), 'claude'], {
          cwd: s.repo,
          env: { ...process.env, HOME: s.root, SUPERAGENT_HOME: s.sa, SUPERAGENT_ROLE: role },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        p.stdin.write(
          JSON.stringify({
            cwd: s.repo,
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command },
          })
        );
        p.stdin.end();
        expect(await new Response(p.stdout).text()).toContain('deny');
        expect(await p.exited).toBe(0);
      }
  },
  testTimeout(20_000)
);
test('R2-02: ledger, Archon and short IDs reject before recovering a dead executor or other mutations', async () => {
  const s = setup();
  isolated(s);
  const actor = caller();
  const l = registered(s, s.c.claim(s.scope, actor).controller);
  s.c.claim({ kind: 'run', id: l.run_id, repo: s.scope.id }, b, true, 'run taken over');
  const { Database } = await import('bun:sqlite');
  mkdirSync(process.env.ARCHON_HOME!, { recursive: true });
  const db = new Database(join(process.env.ARCHON_HOME!, 'archon.db'));
  const metadata = { execution_owner: { host: hostname(), pid: 99999999 } };
  db.run(
    'create table remote_agent_workflow_runs (id text primary key, status text, metadata text)'
  );
  db.run('insert into remote_agent_workflow_runs values (?, ?, ?)', [
    l.archon_run_id,
    'running',
    JSON.stringify(metadata),
  ]);
  const calls = join(s.root, 'mutations'),
    stub = join(s.root, 'engine');
  const run = { id: l.archon_run_id, status: 'running', working_path: s.repo, metadata };
  writeFileSync(
    stub,
    `#!/usr/bin/env python3\nimport sys,json\nif sys.argv[1:3]==['workflow','get']: print(${JSON.stringify(JSON.stringify(run))})\nelse:\n open(${JSON.stringify(calls)},'a').write(json.dumps(sys.argv[1:])+'\\n')\n print('{"ok":true}')\n`
  );
  chmodSync(stub, 0o755);
  process.env.SA_ARCHON_BIN = stub;
  const before = readFileSync(join(s.sa, 'runs', l.run_id + '.json'), 'utf8');
  try {
    for (const verb of ['recover', 'resume', 'cancel', 'decide', 'land'])
      for (const id of [l.run_id, l.archon_run_id, 'archon']) {
        expect(() => main([verb, id, 'retry'])).toThrow(/fencing/);
        expect(
          db.query('select status from remote_agent_workflow_runs where id=?').get(l.archon_run_id)
        ).toEqual({ status: 'running' });
        expect(readFileSync(join(s.sa, 'runs', l.run_id + '.json'), 'utf8')).toBe(before);
        expect(existsSync(calls)).toBe(false);
      }
  } finally {
    db.close();
  }
});
test(
  'R2-04: shim keeps run scope despite same-named directories, across two repositories and both IDs',
  async () => {
    const s = setup();
    isolated(s);
    const actor = caller(),
      other = gitRepo(tmp());
    const first = registered(s, s.c.claim(s.scope, actor).controller);
    const second = { ...first, run_id: 'ledger-other', archon_run_id: 'archon-other', repo: other };
    s.c.claim(repoScope(other), actor);
    writeFileSync(join(s.sa, 'runs', second.run_id + '.json'), JSON.stringify(second));
    for (const l of [first, second])
      s.c.claim({ kind: 'run', id: l.run_id, repo: repoScope(l.repo).id }, b, true, 'taken over');
    for (const l of [first, second]) mkdirSync(join(s.repo, l.run_id));
    const shim = join(import.meta.dir, '../bin/archon');
    for (const l of [first, second])
      for (const id of [l.run_id, l.archon_run_id]) {
        const p = Bun.spawn([shim, 'workflow', 'approve', id, '--json'], {
          cwd: s.repo,
          env: process.env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await new Response(p.stderr).text()).toContain('fencing');
        expect(await p.exited).toBe(1);
      }
  },
  testTimeout(15000)
);
test(
  'R1-02/03/04: both IDs and direct shim reject a stale controller before any continuation',
  async () => {
    const s = setup();
    isolated(s);
    const actor = caller();
    const l = registered(s, s.c.claim(s.scope, actor).controller);
    const runScope = { kind: 'run' as const, id: l.run_id, repo: s.scope.id };
    s.c.claim(runScope, b, true, 'run taken over');
    expect(s.c.owner(s.scope).owner).toEqual(actor); // Repo fallback would wrongly admit this actual caller.
    const calls = join(s.root, 'calls'),
      stub = join(s.root, 'engine');
    writeFileSync(
      stub,
      `#!/bin/sh\n[ "$*" = "workflow runs --all --limit 2147483647 --verbose --json" ] && { echo '{"runs":[]}'; exit 0; }\necho "$*" >> '${calls}'\nexit 1\n`
    );
    chmodSync(stub, 0o755);
    process.env.SA_ARCHON_BIN = stub;
    writeFileSync(join(s.sa, 'gc-tick'), String(Date.now()));
    for (const verb of ['cancel', 'resume', 'recover', 'decide', 'land'])
      for (const id of [l.run_id, l.archon_run_id])
        expect(() => main([verb, id, 'retry'])).toThrow(/fencing/);
    const { spyOn } = await import('bun:test');
    const output = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      main(['supervise-tick']);
      expect(JSON.stringify(output.mock.calls)).toContain('fencing');
    } finally {
      output.mockRestore();
    }
    const observed = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    expect(
      observed.every(call => call === `workflow get ${l.archon_run_id} --verbose --json`)
    ).toBe(true);
    const singleton = req('../src/coord/index.ts') as typeof import('../src/coord');
    for (const args of [
      ['workflow', 'abandon', l.archon_run_id],
      ['--json', 'workflow', 'abandon', l.run_id],
      ['workflow', 'run', 'fixture', `--adopt=${l.run_id}`, '--cwd', s.repo],
      ['workflow', 'event', 'emit', `--run-id=${l.archon_run_id}`, '--type', 'fixture'],
    ]) {
      const admittedRepo = singleton
        .coord()
        .mutate(s.scope, actor, () => singleton.coord().admissionEnv());
      const shim = Bun.spawn([join(import.meta.dir, '../bin/archon'), ...args], {
        cwd: s.repo,
        env: { ...process.env, ...admittedRepo },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await new Response(shim.stderr).text()).toContain('fencing');
      expect(await shim.exited).toBe(1);
    }
    mkdirSync(join(s.sa, 'live'));
    writeFileSync(join(s.sa, 'live/actor.json'), JSON.stringify(actor));
    await req('../hooks/shell-ast.cjs').init();
    // A random or replayed boolean/nonce is never an admission context.
    process.env.SA_COORD_ADMISSION = '00000000-0000-0000-0000-000000000000';
    const forged = Bun.spawn(
      [join(import.meta.dir, '../bin/archon'), 'workflow', 'abandon', l.archon_run_id],
      { cwd: s.repo, env: process.env, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(await new Response(forged.stderr).text()).toContain('unknown admission token');
    expect(await forged.exited).toBe(1);
  },
  testTimeout(15000)
);
test(
  'R1-04: admitted synchronous shim consumes verifiable context without deadlocking or changing generation',
  () => {
    const s = setup();
    isolated(s);
    const l = registered(s);
    process.env.SA_ARCHON_BIN = '';
    const { archon } = req('../src/archon.ts') as typeof import('../src/archon');
    const singleton = req('../src/coord/index.ts') as typeof import('../src/coord');
    const r = singleton
      .coord()
      .mutate({ kind: 'run' as const, id: l.run_id, repo: s.scope.id }, a, () =>
        archon(['workflow', 'abandon', l.archon_run_id], s.repo)
      );
    expect(r.err).not.toContain('fencing');
    expect(r.err).not.toContain('scope busy');
    expect(s.c.owner(s.scope).generation).toBe(1);
  },
  testTimeout(15000)
);
test('R1-07: a real process holds long admission while unrelated repo claim/handoff remain available', async () => {
  const s = setup(),
    unrelated = gitRepo(tmp()),
    ready = join(s.root, 'ready');
  const code = `import {Coordination} from ${JSON.stringify(join(import.meta.dir, '../src/coord/index.ts'))};
    import {writeFileSync} from 'node:fs';
    const c=new Coordination({sa:process.env.SUPERAGENT_HOME,runs:()=>[],presence:()=>({state:'online',activity:'idle'})});
    const scope=${JSON.stringify(s.scope)}, who=${JSON.stringify(a)}; c.claim(scope,who);
    await c.mutate(scope,who,async()=>{writeFileSync(${JSON.stringify(ready)},'ready');await Bun.sleep(11000);});`;
  const p = Bun.spawn([process.execPath, '-e', code], {
    env: { ...process.env, SUPERAGENT_HOME: s.sa },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(ready)).toBe(true);
    const began = Date.now(),
      scope = repoScope(unrelated);
    s.c.claim(scope, b);
    s.c.handoff(scope, a, input);
    expect(Date.now() - began).toBeLessThan(8000);
    expect(s.c.pending(scope)).toBe(1);
    expect(await p.exited).toBe(0);
  } finally {
    if (p.exitCode === null) p.kill();
  }
}, 25000);

test('R1-03/04: actual durable-wait database survives stale tick/shim, while a scoped current-owner wake completes it', async () => {
  const s = setup();
  isolated(s);
  process.env.SA_ARCHON_BIN = '';
  const workflows = join(s.repo, '.archon/workflows');
  mkdirSync(workflows, { recursive: true });
  const source = join(workflows, 'fence-wait.yaml');
  writeFileSync(
    source,
    'name: fence-wait\ndescription: fenced durable wait\nnodes:\n  - id: gate\n    wait:\n      attention: fixture\n  - id: done\n    depends_on: [gate]\n    bash: echo resumed > resumed.txt\n'
  );
  const shim = join(import.meta.dir, '../bin/archon');
  const launch = Bun.spawn([shim, 'workflow', 'run', 'fence-wait', '--cwd', s.repo, '--json'], {
    cwd: s.repo,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const launchOut = await new Response(launch.stdout).text(),
    launchErr = await new Response(launch.stderr).text();
  if ((await launch.exited) !== 0) throw new Error(`launch: ${launchErr} ${launchOut}`);
  const { Database } = await import('bun:sqlite');
  const db = new Database(join(s.sa, 'archon/archon.db'));
  const found = db.query('select id from remote_agent_workflow_runs').get() as {
    id: string;
  } | null;
  if (!found) {
    db.close();
    throw new Error(`launch fixture: ${launchErr} ${launchOut}`);
  }
  const ack = { runId: found.id };
  const controller = s.c.owner(s.scope).owner;
  if (!controller) throw new Error('fixture owner missing');
  const l = registered(s, { ...controller, generation: s.c.owner(s.scope).generation });
  l.archon_run_id = ack.runId;
  writeFileSync(join(s.sa, 'runs', l.run_id + '.json'), JSON.stringify(l));
  try {
    const record = db
      .query('select status, metadata from remote_agent_workflow_runs where id=?')
      .get(ack.runId) as { status: string; metadata: string };
    expect(record.status).toBe('paused');
    const metadata = JSON.parse(record.metadata);
    metadata.wait = {
      kind: 'time',
      owner: 'node',
      nodeId: 'gate',
      waitingSince: new Date(0).toISOString(),
      resumeAt: new Date(1).toISOString(),
    };
    db.query('update remote_agent_workflow_runs set metadata=? where id=?').run(
      JSON.stringify(metadata),
      ack.runId
    );
    writeFileSync(
      source,
      readFileSync(source, 'utf8').replace('attention: fixture', 'duration_ms: 1')
    );
    const scope = { kind: 'run' as const, id: l.run_id, repo: s.scope.id };
    s.c.claim(scope, b, true, 'takeover');
    mkdirSync(join(s.repo, l.run_id));
    const { spyOn } = await import('bun:test'),
      output = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      main(['supervise-tick']);
      expect(JSON.stringify(output.mock.calls)).toContain('fencing');
    } finally {
      output.mockRestore();
    }
    for (const id of [l.run_id, ack.runId, ack.runId.slice(0, 8)]) {
      const denied = Bun.spawn([shim, 'workflow', 'wake', id, '--json'], {
        cwd: s.repo,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await new Response(denied.stderr).text()).toContain('fencing');
      expect(await denied.exited).toBe(1);
    }
    expect(
      db.query('select status from remote_agent_workflow_runs where id=?').get(ack.runId)
    ).toMatchObject({ status: 'paused' });
    expect(existsSync(join(s.repo, 'resumed.txt'))).toBe(false);
    const singleton = req('../src/coord/index.ts') as typeof import('../src/coord'),
      native = await import('../src/archon');
    const admitted = singleton
      .coord()
      .mutate(scope, b, () => native.archon(['workflow', 'wake', ack.runId, '--json'], s.repo));
    if (admitted.code !== 0) throw new Error(`scoped wake: ${admitted.err} ${admitted.out}`);
    expect(
      db.query('select status from remote_agent_workflow_runs where id=?').get(ack.runId)
    ).toMatchObject({ status: 'completed' });
  } finally {
    db.close();
  }
}, 60000);

test('INT3: ledger scope wins over same-named paths; executor death does not transfer a live controller', () => {
  const s = setup();
  isolated(s);
  const controller = s.c.claim(s.scope, caller()).controller;
  const l = registered(s, controller);
  s.c.claim(runScope(l), controller);
  mkdirSync(join(s.repo, l.run_id));
  for (const target of [l.run_id, l.archon_run_id, 'archon']) {
    expect(s.c.scope(target)).toEqual(runScope(l));
    expect(req('../hooks/coord.cjs').targetScope(s.sa, target, s.repo)).toEqual(runScope(l));
  }
  expect(
    ownerLost({
      id: l.archon_run_id,
      status: 'running',
      metadata: {
        execution_owner: { host: hostname(), pid: 99999999 },
      },
    })
  ).toBe(true);
  expect(s.c.owner(runScope(l)).presence.state).toBe('online');
  expect(() => s.c.claim(s.scope, b)).toThrow('普通认领');
  s.c.claim(runScope(l), b, true, 'explicit takeover');
  let recovered = false;
  expect(() =>
    s.c.mutate(
      runScope(l),
      controller,
      () => {
        recovered = true;
      },
      controller.generation
    )
  ).toThrow('fencing');
  expect(recovered).toBe(false);
});

test('parallel runs claim independently of the online repository contact and fence takeovers', () => {
  const s = setup();
  s.c.claim(s.scope, b);
  const first = runScope({ run_id: 'first', repo: s.repo });
  const second = runScope({ run_id: 'second', repo: s.repo });
  const controller = s.c.claim(first, a).controller;
  s.c.claim(second, b);
  expect(s.c.mutate(first, a, () => 'dispatched', controller.generation)).toBe('dispatched');
  expect(s.c.owner(s.scope).owner).toEqual(b);
  expect(() => s.c.claim(first, b)).toThrow('普通认领');
  s.c.claim(first, b, true, 'operator request');
  expect(() => s.c.mutate(first, a, () => true, controller.generation)).toThrow('fencing');
  expect(s.c.mutate(second, b, () => true)).toBe(true);
});

test('scope overlap reports unreadable state and DATABASE_URL without treating either as clear', () => {
  const s = setup();
  isolated(s);
  const l = registered(s);
  const plan = { repo: s.repo, packages: [] } as unknown as import('../src/plan').Plan;
  expect(scopeOverlaps(plan)).toMatchObject([
    { run_id: l.run_id, paths: [], error: expect.any(String) },
  ]);
  process.env.DATABASE_URL = 'unsupported-fixture';
  expect(scopeOverlaps(plan)).toMatchObject([
    { run_id: 'unknown', error: expect.stringContaining('DATABASE_URL') },
  ]);
  const output = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    for (const verb of ['run', 'quick']) {
      expect(main([verb])).toBe(64);
      expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({
        reason: 'scope_overlap',
        overlap_warnings: [{ run_id: 'unknown', error: expect.stringContaining('SQLite-only') }],
      });
    }
    expect(() => main(['run', 'unused.json', '--allow-overlap', 'accepted'])).toThrow(
      'SQLite-only'
    );
  } finally {
    output.mockRestore();
  }
});

test.each([
  'overlap',
  'override',
  'completed',
  'disjoint',
  'deleted-repo',
  'unknown',
  'unreadable',
  'relative',
  'quick',
  'quick-override',
  'unknown-override',
  'state-unreadable',
  'database-override',
  'quick-database-override',
])('scope overlap admission: %s (repository contact remains independent)', async scenario => {
  const s = setup();
  sh('git switch -qc feature/fixture', s.repo);
  isolated(s);
  process.env.SUPERAGENT_WRITE_ROOTS = s.root;
  process.env.SUPERAGENT_MEMORY = 'off';
  const contact = s.c.claim(s.scope, b).controller;
  const plan = fixturePlan(s.root, s.repo);
  const l = registered(s, contact);
  l.started_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
  if (scenario === 'deleted-repo') {
    l.repo = join(s.root, 'deleted-repo');
    mkdirSync(l.repo);
    rmdirSync(l.repo);
  }
  l.plan = 'missing-original.json'; // Frozen plan wins over an unavailable original.
  if (scenario === 'completed') l.delivery_result = { status: 'blocked', reason: 'merge conflict' };
  if (scenario === 'relative' || scenario === 'unreadable') {
    l.gen_dir = join(s.root, 'missing-gen');
    l.plan = 'historical.json';
    if (scenario === 'relative') writeFileSync(join(s.repo, l.plan), readFileSync(plan));
  }
  writeFileSync(join(s.sa, 'runs', l.run_id + '.json'), JSON.stringify(l));
  writeFileSync(
    join(s.sa, 'runs', 'failed.json'),
    JSON.stringify({
      ...l,
      run_id: 'failed',
      repo: s.root, // Existing non-repository: terminal filtering must precede git.
      delivery_result: undefined,
      archon_run_id: 'failed-engine',
      state: 'failed',
      plan: 'missing.json',
    })
  );
  writeFileSync(
    join(s.sa, 'runs', 'completed.json'),
    JSON.stringify({
      ...l,
      run_id: 'completed',
      repo: s.root,
      delivery_result: undefined,
      archon_run_id: 'completed-engine',
      plan: 'missing.json',
    })
  );
  const { Database } = await import('bun:sqlite');
  mkdirSync(process.env.ARCHON_HOME!, { recursive: true });
  const db = new Database(join(process.env.ARCHON_HOME!, 'archon.db'));
  db.run('create table remote_agent_workflow_runs (id text primary key, status text)');
  db.run('insert into remote_agent_workflow_runs values (?, ?)', [
    l.archon_run_id,
    scenario === 'completed' ? 'completed' : 'running',
  ]);
  if (scenario.startsWith('unknown') || scenario === 'deleted-repo')
    db.run('delete from remote_agent_workflow_runs where id=?', [l.archon_run_id]);
  db.run('insert into remote_agent_workflow_runs values (?, ?)', ['completed-engine', 'completed']);
  if (scenario === 'state-unreadable') db.run('drop table remote_agent_workflow_runs');
  if (scenario.includes('database')) {
    process.env.DATABASE_URL = 'unsupported-fixture';
    writeFileSync(join(process.env.ARCHON_HOME!, '.env'), 'DATABASE_URL=\n');
  }
  const native = req('../src/archon.ts') as typeof import('../src/archon');
  const coordination = req('../src/coord/index.ts') as typeof import('../src/coord');
  const relay = req('../src/relay-quota.ts') as typeof import('../src/relay-quota');
  const launch = spyOn(native, 'archonJson').mockImplementation(args =>
    args[1] === 'get'
      ? { id: l.archon_run_id, status: 'running' }
      : { ok: true, runId: 'new-engine-run' }
  );
  const generator = req('../src/generate.ts') as typeof import('../src/generate');
  const generated = spyOn(generator, 'generate').mockReturnValue({
    dir: s.root,
    workflow: 'fixture',
    config: 'fixture',
    engine_hash: 'fixture',
    engine_commit: 'fixture',
  });
  const identity = spyOn(coordination, 'caller').mockReturnValue(a);
  const quota = spyOn(relay, 'relayQuota').mockReturnValue({ quota: 'fixture' });
  const outputs: string[] = [],
    output = spyOn(console, 'log').mockImplementation(value => outputs.push(String(value)));
  try {
    let input = plan;
    if (scenario === 'disjoint') {
      input = join(s.root, 'disjoint.json');
      const next = JSON.parse(readFileSync(plan, 'utf8'));
      for (const pkg of next.packages) pkg.scope.write = ['unrelated/**'];
      writeFileSync(input, JSON.stringify(next));
    }
    const args = scenario.startsWith('quick')
      ? ['quick', '--goal', 'overlap fixture', '--accept', 'true', '--repo', s.repo]
      : ['run', input];
    const allowed =
      scenario.includes('override') || ['disjoint', 'deleted-repo'].includes(scenario);
    const flags = scenario.includes('override') ? ['--allow-overlap', 'coordinated handoff'] : [];
    expect(main([...args, '--fake', ...flags]), outputs.join('\n')).toBe(allowed ? 0 : 64);
    const result = JSON.parse(outputs.at(-1)!);
    if (!allowed) {
      expect(result).toMatchObject({ status: 'rejected', reason: 'scope_overlap' });
      expect(result.overlap_warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ run_id: l.run_id })])
      );
      if (['unknown', 'unreadable', 'state-unreadable'].includes(scenario))
        expect(result.overlap_warnings[0].error).toBeString();
      expect(launch).not.toHaveBeenCalled();
      return;
    }
    expect(result.default_contact).toMatchObject(b);
    if (scenario.includes('override')) {
      expect(result.overlap_warnings).toMatchObject([
        { run_id: scenario.includes('database') ? 'unknown' : l.run_id, paths: expect.any(Array) },
      ]);
      expect(
        JSON.parse(readFileSync(join(s.sa, 'runs', result.run_id + '.json'), 'utf8')).allow_overlap
      ).toBe('coordinated handoff');
    } else expect(result.overlap_warnings).toEqual([]);
    expect(launch.mock.calls.some(([args]) => args[1] === 'get')).toBe(false);
    expect(s.c.owner(runScope({ run_id: result.run_id, repo: s.repo })).owner).toEqual(a);
    expect(s.c.owner(s.scope).owner).toEqual(b);
  } finally {
    db.close();
    launch.mockRestore();
    generated.mockRestore();
    identity.mockRestore();
    quota.mockRestore();
    output.mockRestore();
  }
});

test('Archon launch consumes the new run admission instead of the foreign repository contact', async () => {
  const s = setup();
  isolated(s);
  const { coord } = await import('../src/coord');
  const { archonEntry } = await import('../src/coord/archon-entry');
  const c = coord(),
    scope = runScope({ run_id: 'launch-intent', repo: s.repo });
  c.claim(s.scope, b);
  c.claim(scope, a);
  Object.assign(
    process.env,
    c.mutate(scope, a, () => c.admissionEnv())
  );
  const live = spyOn(c.d, 'presence').mockReturnValue(online);
  const invoke = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0 } as ReturnType<
    typeof Bun.spawnSync
  >);
  try {
    expect(await archonEntry(['workflow', 'run', 'fixture', '--cwd', s.repo])).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(c.owner(s.scope).owner).toEqual(b);
  } finally {
    invoke.mockRestore();
    live.mockRestore();
  }
});

test('Archon adopt admits only the same controller and repository', async () => {
  for (const mismatch of ['none', 'owner', 'repo']) {
    const s = setup();
    isolated(s);
    const old = registered(s),
      c = (await import('../src/coord')).coord();
    if (mismatch === 'owner') c.claim(runScope(old), b, true, 'fixture takeover');
    else if (mismatch === 'repo') {
      old.repo = gitRepo(tmp());
      writeFileSync(join(s.sa, 'runs', old.run_id + '.json'), JSON.stringify(old));
    }
    const next = runScope({ run_id: 'replacement-' + mismatch, repo: s.repo });
    c.claim(next, a);
    Object.assign(
      process.env,
      c.mutate(next, a, () => c.admissionEnv())
    );
    const spawned = { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
    const live = spyOn(c.d, 'presence').mockReturnValue(online),
      invoke = spyOn(Bun, 'spawnSync').mockReturnValue(spawned);
    try {
      const args = ['workflow', 'run', 'fixture', '--adopt', old.run_id, '--cwd', s.repo];
      const action = (await import('../src/coord/archon-entry')).archonEntry(args);
      if (mismatch === 'none') {
        expect(await action).toBe(0);
        expect(invoke).toHaveBeenCalledTimes(1);
      } else {
        await expect(action).rejects.toThrow('coord: admission scope mismatch');
        expect(invoke).not.toHaveBeenCalled();
      }
    } finally {
      invoke.mockRestore();
      live.mockRestore();
    }
  }
});

function renewalFixture() {
  const s = setup();
  const old = { ...a, pid: 99999999, pid_start: 'exited-lifetime' };
  s.c.claim(s.scope, old);
  process.env.SUPERAGENT_HOME = s.sa;
  const evidence = spyOn(launchers, 'launcher').mockReturnValue({
    ...a,
    client: 'codex',
    tty: null,
    cwd: s.repo,
  });
  return { ...s, old, evidence, actual: new Coordination({ sa: s.sa, runs: () => [] }) };
}

test('same-session renewal writes a new lease and history without takeover; stale leases stay fenced', () => {
  const s = renewalFixture();
  try {
    const next = s.actual.mutate(s.scope, a, controller => controller, 1);
    expect(next).toEqual({ ...a, generation: 2 });
    expect(req('../hooks/coord.cjs').admission(s.sa, s.scope, a, 2)).toEqual(next);
    expect(s.actual.inbox(s.old)).toEqual([]);
    expect(s.actual.messages()).toEqual([]);
    const claim = JSON.parse(
      readFileSync(join(s.sa, 'coord/claims', hooks.hash(s.scope) + '.json'), 'utf8')
    );
    expect(claim.history).toMatchObject([
      { owner: s.old, generation: 1 },
      { owner: a, generation: 2, reason: 'same-session-renewal' },
    ]);
    expect(() => s.actual.mutate(s.scope, s.old, () => true, 1)).toThrow('fencing');
    expect(() => s.actual.mutate(s.scope, a, () => true, 1)).toThrow('fencing');
    expect(s.actual.mutate(s.scope, a, () => true, 2)).toBe(true);
  } finally {
    s.evidence.mockRestore();
  }
});

test('same-session PID reuse renews, including legacy owner history', () => {
  const s = renewalFixture();
  try {
    const old = { ...a, pid_start: 'previous-lifetime' };
    const c = new Coordination({
      sa: s.sa,
      runs: () => [
        {
          run_id: 'legacy',
          archon_run_id: 'engine',
          repo: s.repo,
          controller: { ...old, generation: 7 },
        },
      ],
    });
    const scope = runScope({ run_id: 'legacy', repo: s.repo });
    expect(c.mutate(scope, a, x => x.generation, 7)).toBe(8);
    const claim = JSON.parse(
      readFileSync(join(s.sa, 'coord/claims', hooks.hash(scope) + '.json'), 'utf8')
    );
    expect(claim.history.map((entry: { owner: Identity }) => entry.owner)).toMatchObject([old, a]);
    expect(c.messages()).toEqual([]);
  } finally {
    s.evidence.mockRestore();
  }
});

for (const mode of [
  'host',
  'session',
  'client',
  'missing-session',
  'missing-start',
  'unknown',
  'live',
  'unverified',
  'self-reported',
  'stale',
  'double-live',
]) {
  test(`same-session renewal refuses ${mode} without executing or changing generation`, () => {
    const s = renewalFixture();
    try {
      const old: Identity = { ...s.old };
      if (mode === 'host') old.host = 'remote-host';
      if (mode === 'session') old.session_id = 'other-session';
      if (mode === 'client') old.client = 'claude';
      if (mode === 'missing-session') delete old.session_id;
      if (mode === 'missing-start') delete old.pid_start;
      if (mode === 'live')
        Object.assign(old, a, { pid: process.ppid, pid_start: ids.inspect(process.ppid).start });
      // Replace only the scratch claim; the original lease remains generation 1.
      const file = join(s.sa, 'coord/claims', hooks.hash(s.scope) + '.json');
      const claim = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...claim, owner: old }));
      let c = s.actual;
      if (mode === 'unknown')
        c = new Coordination({ sa: s.sa, runs: () => [], presence: () => ({ state: 'unknown' }) });
      if (mode === 'double-live')
        s.c.claim(runScope({ run_id: 'other', repo: s.repo }), {
          ...a,
          pid: process.ppid,
          pid_start: ids.inspect(process.ppid).start,
        });
      const who = mode === 'unverified' ? { ...a, pid_start: 'invented-lifetime' } : a;
      if (mode === 'unverified')
        s.evidence.mockReturnValue({ ...who, client: 'codex', tty: null, cwd: s.repo });
      if (mode === 'self-reported') {
        s.evidence.mockReturnValue(undefined);
        process.env.SUPERAGENT_SESSION_ID = a.session_id;
      }
      let executed = false;
      expect(() =>
        c.mutate(
          s.scope,
          who,
          () => {
            executed = true;
          },
          mode === 'stale' ? 0 : 1
        )
      ).toThrow('fencing');
      expect(executed).toBe(false);
      expect(c.owner(s.scope).generation).toBe(1);
      expect(c.messages()).toEqual([]);
    } finally {
      s.evidence.mockRestore();
    }
  });
}

// Keep both native launcher parents alive until both contenders have reported.
test(
  'two real same-session processes race to renew; only one acquires the lease',
  async () => {
    const s = setup();
    s.c.claim(s.scope, { ...a, client: 'claude', pid: 99999999, pid_start: 'exited' });
    const parent = join(s.root, 'claude');
    const child = join(s.root, 'renew.ts');
    writeFileSync(
      child,
      `
import {Coordination,caller} from ${JSON.stringify(join(import.meta.dir, '../src/coord/index.ts'))};
import {existsSync,writeFileSync} from 'node:fs';
const c=new Coordination({sa:process.env.SUPERAGENT_HOME,runs:()=>[]});
const who=caller();
while(!existsSync(${JSON.stringify(join(s.root, 'go'))})) await Bun.sleep(10);
let ok=false; try { c.mutate(${JSON.stringify(s.scope)},who,()=>{ok=true;},1); } catch {}
writeFileSync(process.argv[2],JSON.stringify({ok,who}));
`
    );
    writeFileSync(
      parent,
      `
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {hostname} from 'node:os';
import {inspectProcess} from ${JSON.stringify(join(import.meta.dir, '../src/launcher.ts'))};
const id=process.argv[2],root=${JSON.stringify(s.root)},sa=process.env.SUPERAGENT_HOME;
mkdirSync(sa+'/live',{recursive:true});
writeFileSync(sa+'/live/'+id+'.json',JSON.stringify({client:'claude',session_id:'A',pid:process.pid,pid_start:inspectProcess(process.pid).start,host:hostname(),cwd:${JSON.stringify(s.repo)},at:new Date().toISOString()}));
const p=Bun.spawn([process.execPath,${JSON.stringify(child)},root+'/'+id+'.json'],{env:{...process.env,SUPERAGENT_ROLE:''},stdout:'ignore',stderr:'inherit'});
await p.exited;
while(!existsSync(root+'/release')) await Bun.sleep(10);
`
    );
    const procs = ['one', 'two'].map(id =>
      Bun.spawn([process.execPath, parent, id], {
        env: { ...process.env, SUPERAGENT_HOME: s.sa, ARCHON_HOME: join(s.sa, 'archon') },
        stdout: 'ignore',
        stderr: 'pipe',
      })
    );
    try {
      writeFileSync(join(s.root, 'go'), '');
      const deadline = Date.now() + 10000;
      while (
        !['one', 'two'].every(id => existsSync(join(s.root, id + '.json'))) &&
        Date.now() < deadline
      )
        await Bun.sleep(20);
      const results = ['one', 'two'].map(id =>
        JSON.parse(readFileSync(join(s.root, id + '.json'), 'utf8'))
      );
      expect(results.filter(r => r.ok)).toHaveLength(1);
      expect(s.c.owner(s.scope)).toMatchObject({
        owner: results.find(r => r.ok).who,
        generation: 2,
      });
      expect(s.c.messages()).toEqual([]);
    } finally {
      writeFileSync(join(s.root, 'release'), '');
      await Promise.all(procs.map(p => p.exited));
    }
  },
  testTimeout(20000)
);
