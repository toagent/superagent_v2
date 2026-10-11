import { afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  Coordination,
  ACK_TIMEOUT_MS,
  caller,
  cleanEngine,
  repoScope,
  presence,
  escalationTitle,
  type Identity,
  type Message,
  type Presence,
} from '../src/coord';
import { main, waitRun, type Ledger } from '../src/cli';
import { gitRepo, sh, tmp } from './helpers';

const req = createRequire(import.meta.url);
const ids = req('../hooks/identity.cjs') as {
  inspect: (pid: number) => { start: string };
  presence: typeof presence;
};
const hooks = req('../hooks/coord.cjs') as {
  hash: (v: unknown) => string;
  repoScope: typeof repoScope;
  writeReason: (
    p: unknown,
    client: string,
    env: NodeJS.ProcessEnv,
    shell?: string,
    readonly?: (a: string[]) => boolean
  ) => string | null;
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
test('7: BestIFA B cannot write engine E; handoff wakes A wait before querying provider', async () => {
  const s = setup(),
    project = gitRepo(tmp());
  s.c.claim(s.scope, a);
  s.c.claim(repoScope(project), b);
  mkdirSync(join(s.sa, 'live'));
  writeFileSync(join(s.sa, 'live/b.json'), JSON.stringify(b));
  const payload = {
    cwd: project,
    session_id: b.session_id,
    tool_name: 'Write',
    tool_input: { file_path: join(s.repo, 'engine.ts') },
  };
  const why = hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa });
  expect(why).toContain('superagent handoff');
  expect(why?.split('\n')).toHaveLength(3);
  expect(
    hooks.writeReason(
      { ...payload, tool_input: { file_path: join(project, 'app.ts') } },
      'claude',
      { SUPERAGENT_HOME: s.sa }
    )
  ).toBeNull();
  await req('../hooks/shell-ast.cjs').init();
  expect(
    hooks.writeReason(
      { ...payload, tool_name: 'Bash', tool_input: {} },
      'claude',
      { SUPERAGENT_HOME: s.sa },
      `echo bad > '${s.repo}/engine.ts'`,
      () => true
    )
  ).toContain('handoff');
  expect(
    hooks.writeReason(
      { ...payload, tool_name: 'Bash', tool_input: {} },
      'claude',
      { SUPERAGENT_HOME: s.sa },
      `cp '${s.repo}/README.md' '${project}/copy.md'`,
      () => false
    )
  ).toBeNull();
  expect(
    hooks.writeReason(
      { ...payload, cwd: s.repo, tool_name: 'Bash', tool_input: {} },
      'claude',
      { SUPERAGENT_HOME: s.sa },
      'python3 -c "print(1)"',
      () => false
    )
  ).toBeNull();
  expect(
    hooks.writeReason(
      { ...payload, tool_name: 'Bash', tool_input: {} },
      'claude',
      { SUPERAGENT_HOME: s.sa },
      `sed -i '' 's/a/b/' '${s.repo}/engine.ts'`,
      () => false
    )
  ).toContain('handoff');
  const out = s.c.handoff(s.scope, b, input);
  // Use the real CLI caller identity to deliver an inbox item, then prove wait short-circuits getRun.
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    SUPERAGENT_ROLE: '',
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
  const s = setup();
  const c = new Coordination({
    sa: s.sa,
    runs: () => [
      {
        run_id: 'old',
        archon_run_id: 'r',
        repo: s.repo,
        launcher: { ...a, client: 'codex', tty: null, cwd: s.repo },
      },
    ],
    status: () => 'running',
    presence: () => online,
  });
  expect(c.owner(s.scope)).toMatchObject({
    owner: a,
    evidence: ['nonterminal run old legacy launcher'],
  });
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
test('CLI mutation obeys owner fencing before invoking engine; read-only owner remains available', () => {
  const s = setup();
  s.c.claim(s.scope, a);
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    SUPERAGENT_ROLE: '',
  });
  mkdirSync(join(s.sa, 'runs'));
  writeFileSync(
    join(s.sa, 'runs/r.json'),
    JSON.stringify({
      run_id: 'r',
      archon_run_id: 'provider',
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
  const payload = {
    cwd: s.repo,
    session_id: b.session_id,
    tool_name: 'Write',
    tool_input: { file_path: 'new.ts' },
  };
  expect(hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa })).toContain('handoff');
  const runScope = c.scope('old');
  c.handoff(runScope, b, input);
  c.claim(s.scope, b, true, 'takeover');
  expect(hooks.unread(s.sa, b, []).filter(m => !m.type)).toHaveLength(1);
  c.release(s.scope, b);
  expect(c.owner(runScope).owner).toBeNull();
  expect(hooks.unread(s.sa, a, []).filter(m => !m.type)).toHaveLength(0);
  expect(hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa })).toBeNull();
});
test('no defers urgent escalation for a full interval; new question key and stale yes are fenced', () => {
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
  now += ACK_TIMEOUT_MS + 1;
  c.tick(key => {
    keys.push(key);
    return { status: 'pending' };
  });
  expect(keys[0]).not.toBe(keys[1]);
  expect(() =>
    c.tick(() => {
      c.claim(s.scope, { ...a, session_id: 'C' }, true, 'new owner');
      return { status: 'yes' };
    })
  ).toThrow(/stale takeover/);
});
test('real CLI urgent and unknown-timeout use only temporary supervisor state and a Python stub', () => {
  const s = setup();
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    SUPERAGENT_ROLE: '',
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
});
test('wait already blocking returns inbox after a new message arrives, before timeout', () => {
  const s = setup();
  Object.assign(process.env, {
    SUPERAGENT_HOME: s.sa,
    ARCHON_HOME: join(s.sa, 'archon'),
    SUPERAGENT_ROLE: '',
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
    `#!/usr/bin/env python3\nimport sys,json\nif sys.argv[2]=='get': print(json.dumps({'id':'p','status':'running','metadata':{'execution_owner':{'host':'remote','pid':1}}}))\nelse:\n open(${JSON.stringify(file)},'w').write(${JSON.stringify(JSON.stringify(message))})\n print('{}')\n`
  );
  sh(`chmod +x '${bin}'`, s.root);
  process.env.SA_ARCHON_BIN = bin;
  const start = Date.now();
  expect(waitRun({ run_id: 'late', archon_run_id: 'p', repo: s.repo } as Ledger, 30)).toMatchObject(
    { state: 'inbox', exit: 3 }
  );
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
    SUPERAGENT_ROLE: '',
    AGENT_SUPERVISOR_STATE: join(s.root, 'supervisor'),
    SA_SUPERVISOR: join(s.root, 'disabled-supervisor'),
    SA_ORCA: '0',
    SA_COORD_ADMISSION: '',
  });
}
test('R1-01/06: actual hook rejects cd and nested-shell writes; absolute git status stays open', async () => {
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
    const p = Bun.spawn(['node', join(import.meta.dir, '../hooks/guard.cjs'), 'claude'], {
      cwd: other,
      env: {
        ...process.env,
        SUPERAGENT_HOME: s.sa,
        ARCHON_HOME: join(s.sa, 'archon'),
        SUPERAGENT_ROLE: '',
        SUPERAGENT_ALLOW_COMMANDER_WRITE: '1',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
    if (i < commands.length - 1) expect(out).toContain('已拒绝');
    else expect(out).not.toContain('deny');
  }
});
test('R2-01: redline shares directory transitions and subshells keep the parent cwd', async () => {
  const s = setup(),
    other = gitRepo(tmp());
  const secret = join(s.root, '.ssh');
  mkdirSync(secret);
  writeFileSync(join(secret, 'id_ed25519'), 'synthetic fixture');
  for (const command of [
    `cd -- '${secret}' && cat id_ed25519`,
    `cd -P '${secret}' && cat id_ed25519`,
    `pushd '${secret}' && cat id_ed25519`,
    `(cd -L '${secret}' && cat id_ed25519)`,
  ]) {
    const p = Bun.spawn(['node', join(import.meta.dir, '../hooks/guard.cjs'), 'claude'], {
      cwd: s.repo,
      env: { ...process.env, HOME: s.root, SUPERAGENT_HOME: s.sa, SUPERAGENT_ROLE: 'general' },
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
  s.c.claim(repoScope(other), a);
  await req('../hooks/shell-ast.cjs').init();
  expect(
    hooks.writeReason(
      { cwd: s.repo, tool_name: 'Bash', tool_input: {} },
      'claude',
      { SUPERAGENT_HOME: s.sa },
      `(cd -- '${other}' && pwd); echo x > local.txt`,
      () => true
    )
  ).toBeNull();
});
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
test('R2-04: shim keeps run scope despite same-named directories, across two repositories and both IDs', async () => {
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
}, 15000);
test('R1-02/03/04: both IDs and direct shim/hook reject a stale controller before any continuation', async () => {
  const s = setup();
  isolated(s);
  const actor = caller();
  const l = registered(s, s.c.claim(s.scope, actor).controller);
  const runScope = { kind: 'run' as const, id: l.run_id, repo: s.scope.id };
  s.c.claim(runScope, b, true, 'run taken over');
  expect(s.c.owner(s.scope).owner).toEqual(actor); // Repo fallback would wrongly admit this actual caller.
  const calls = join(s.root, 'calls'),
    stub = join(s.root, 'engine');
  writeFileSync(stub, `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`);
  chmodSync(stub, 0o755);
  process.env.SA_ARCHON_BIN = stub;
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
  expect(existsSync(calls)).toBe(false);
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
  expect(
    hooks.writeReason(
      { cwd: s.repo, session_id: actor.session_id, tool_name: 'Bash', tool_input: {} },
      actor.client,
      process.env,
      `wetamp/bin/archon workflow abandon ${l.archon_run_id}`,
      () => false
    )
  ).toContain('fencing');
  expect(
    hooks.writeReason(
      { cwd: s.repo, session_id: actor.session_id, tool_name: 'Bash', tool_input: {} },
      actor.client,
      process.env,
      `wetamp/bin/archon --json workflow event emit --run-id=${l.archon_run_id} --type fixture`,
      () => false
    )
  ).toContain('fencing');
  // A random or replayed boolean/nonce is never an admission context.
  process.env.SA_COORD_ADMISSION = '00000000-0000-0000-0000-000000000000';
  const forged = Bun.spawn(
    [join(import.meta.dir, '../bin/archon'), 'workflow', 'abandon', l.archon_run_id],
    { cwd: s.repo, env: process.env, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await new Response(forged.stderr).text()).toContain('unknown admission token');
  expect(await forged.exited).toBe(1);
}, 15000);
test('R1-04: admitted synchronous shim consumes verifiable context without deadlocking or changing generation', () => {
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
}, 15000);
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
  await launch.exited;
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
