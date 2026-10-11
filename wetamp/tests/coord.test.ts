import { afterEach, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Coordination, ACK_TIMEOUT_MS, caller, cleanEngine, repoScope, presence, escalationTitle, type Identity, type Message, type Presence } from '../src/coord';
import { main, waitRun, type Ledger } from '../src/cli';
import { gitRepo, sh, tmp } from './helpers';

const req = createRequire(import.meta.url);
const ids = req('../hooks/identity.cjs') as { inspect: (pid: number) => { start: string }; presence: typeof presence };
const hooks = req('../hooks/coord.cjs') as { hash: (v: unknown) => string; repoScope: typeof repoScope;
  writeReason: (p: unknown, client: string, env: NodeJS.ProcessEnv, shell?: string, readonly?: (a: string[]) => boolean) => string | null;
  unread: (sa: string, who: Identity, seen: string[]) => Message[] };
const a: Identity = { client: 'codex', session_id: 'A', host: hostname(), pid: process.pid, pid_start: ids.inspect(process.pid).start };
const b: Identity = { ...a, client: 'claude', session_id: 'B' };
const online: Presence = { state: 'online', activity: 'idle' };
const input = { kind: 'bug' as const, title: 'fixture engine failure', body: 'Details for recipient only.', evidence: ['/tmp/evidence.json'], severity: 'normal' as const };
const oldEnv = { ...process.env };
afterEach(() => { process.env = { ...oldEnv }; });
function setup(probe: (who: Identity) => Presence = () => online) {
  const root = tmp(), repo = gitRepo(root), sa = join(root, 'sa'); mkdirSync(sa);
  const c = new Coordination({ sa, runs: () => [], status: () => 'running', presence: probe });
  return { root, repo, sa, c, scope: repoScope(repo) };
}
test('1: two actual processes race for one scope under flock; exactly one owner and monotonic generations', async () => {
  const s = setup();
  const code = `import {Coordination} from ${JSON.stringify(join(import.meta.dir, '../src/coord/index.ts'))};
    const c=new Coordination({sa:process.env.SUPERAGENT_HOME,runs:()=>[],presence:()=>({state:'online',activity:'idle'})});
    const id={client:'codex',session_id:process.argv[1],host:'fixture',pid:process.pid,pid_start:'start'};
    try { c.claim(${JSON.stringify(s.scope)},id); process.exit(0); } catch {process.exit(1);}`;
  const procs = ['one', 'two'].map(id => Bun.spawn([process.execPath, '-e', code, id], { env: { ...process.env, SUPERAGENT_HOME: s.sa }, stdout: 'ignore', stderr: 'pipe' }));
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
  expect(() => actual.mutate(s.scope, old, () => true, 1)).toThrow(/已拒绝：.*\n原因：.*\n可以：superagent handoff/);
  expect(() => actual.mutate(s.scope, a, () => true, 1)).toThrow(/fencing/);
});
test('3: online ordinary claim refused; explicit takeover requires a reason and notifies old owner', () => {
  const s = setup(), claimed = s.c.claim(s.scope, a);
  expect(s.c.mutate(s.scope, claimed.controller, () => true, claimed.controller.generation)).toBe(true);
  expect(() => s.c.claim(s.scope, b)).toThrow(/普通认领/);
  expect(() => s.c.claim(s.scope, b, true, '')).toThrow(/reason/);
  s.c.claim(s.scope, b, true, '用户原话：交给B');
  expect(s.c.inbox(a)[0]).toMatchObject({ type: 'takeover', body: '用户原话：交给B', generation: 2 });
});
test('4: cross-host unknown never auto-transfers; timeout escalates through injected supervisor', () => {
  const s = setup(who => presence(who, ''));
  const remote = { ...a, host: 'remote-host' }; s.c.claim(s.scope, remote);
  expect(() => s.c.claim(s.scope, b)).toThrow(/状态未知/);
  const out = s.c.handoff(s.scope, b, input), now = Date.now() + ACK_TIMEOUT_MS + 1000;
  const c = new Coordination({ sa: s.sa, runs: () => [], now: () => now });
  const calls: string[] = []; c.tick((_key, q) => { calls.push(q); return { id: 'stub-ask', status: 'pending' }; });
  expect(calls).toHaveLength(1); expect(c.owner(s.scope).owner).toEqual(remote);
  expect(calls[0]).not.toContain(input.title); expect(calls[0]).toContain(String(out.id).slice(0, 12));
});
test('5: self, online, offline backlog and unowned route deterministically; next claim sees backlog', () => {
  const s = setup(); s.c.claim(s.scope, a);
  expect(s.c.handoff(s.scope, a, input)).toMatchObject({ delivery: 'self', next: '自己处理' });
  expect(s.c.messages()).toHaveLength(0);
  const sent = s.c.handoff(s.scope, b, input); expect(sent).toMatchObject({ presence: online });
  const offline = new Coordination({ sa: s.sa, runs: () => [], presence: () => ({ state: 'offline' }) });
  expect(offline.tick(() => { throw new Error('ordinary offline must remain queued'); })).toEqual([]);
  expect(offline.claim(s.scope, b).inbox).toHaveLength(1);
});
test('5: unowned finder claims and receives own task; urgent offline asks immediately and yes transfers', () => {
  const s = setup();
  expect(s.c.handoff(s.scope, b, input)).toMatchObject({ next: '已认领，由你处理' });
  expect(s.c.inbox(b)).toHaveLength(1);
  const other = setup(); other.c.claim(other.scope, a);
  const c = new Coordination({ sa: other.sa, runs: () => [], presence: () => ({ state: 'offline' }) });
  c.handoff(other.scope, b, { ...input, severity: 'urgent' });
  const titles: string[] = []; c.tick((_key, q) => { titles.push(q); return { id: 'stub', status: 'yes' }; });
  expect(titles).toHaveLength(1); expect(c.owner(other.scope).owner).toEqual(b);
});
test('6: delivery and ack are idempotent; only recipient acks; sender receives durable receipt', () => {
  const s = setup(); s.c.claim(s.scope, a);
  const one = s.c.handoff(s.scope, b, input), two = s.c.handoff(s.scope, b, input);
  expect(one.id).toBe(two.id); expect(s.c.messages()).toHaveLength(1);
  expect(() => s.c.ack(String(one.id), b, 'accepted', 'ok')).toThrow(/fencing/);
  expect(() => s.c.ack('../claims/foreign', a, 'done', '')).toThrow(/invalid message id/);
  s.c.ack(String(one.id), a, 'accepted', 'working'); s.c.ack(String(one.id), a, 'accepted', 'working');
  expect(s.c.inbox(b)).toMatchObject([{ type: 'receipt', body: 'accepted: working' }]);
  expect(s.c.messages()).toHaveLength(2);
  s.c.ack(String(one.id), a, 'done', 'fixed');
  expect(s.c.messages().filter(m => m.type === 'receipt')).toHaveLength(2);
  expect(() => s.c.ack(String(one.id), a, 'accepted', 'again')).toThrow(/invalid state/);
});
test('7: BestIFA B cannot write engine E; handoff wakes A wait before querying provider', async () => {
  const s = setup(), project = gitRepo(tmp()); s.c.claim(s.scope, a); s.c.claim(repoScope(project), b);
  mkdirSync(join(s.sa, 'live')); writeFileSync(join(s.sa, 'live/b.json'), JSON.stringify(b));
  const payload = { cwd: project, session_id: b.session_id, tool_name: 'Write', tool_input: { file_path: join(s.repo, 'engine.ts') } };
  const why = hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa });
  expect(why).toContain('superagent handoff'); expect(why?.split('\n')).toHaveLength(3);
  expect(hooks.writeReason({ ...payload, tool_input: { file_path: join(project, 'app.ts') } }, 'claude', { SUPERAGENT_HOME: s.sa })).toBeNull();
  await req('../hooks/shell-ast.cjs').init();
  expect(hooks.writeReason({ ...payload, tool_name: 'Bash', tool_input: {} }, 'claude', { SUPERAGENT_HOME: s.sa }, `echo bad > '${s.repo}/engine.ts'`, () => true)).toContain('handoff');
  expect(hooks.writeReason({ ...payload, tool_name: 'Bash', tool_input: {} }, 'claude', { SUPERAGENT_HOME: s.sa }, `cp '${s.repo}/README.md' '${project}/copy.md'`, () => false)).toBeNull();
  expect(hooks.writeReason({ ...payload, cwd: s.repo, tool_name: 'Bash', tool_input: {} }, 'claude', { SUPERAGENT_HOME: s.sa }, 'python3 -c "print(1)"', () => false)).toBeNull();
  expect(hooks.writeReason({ ...payload, tool_name: 'Bash', tool_input: {} }, 'claude', { SUPERAGENT_HOME: s.sa }, `sed -i '' 's/a/b/' '${s.repo}/engine.ts'`, () => false)).toContain('handoff');
  const out = s.c.handoff(s.scope, b, input);
  // Use the real CLI caller identity to deliver an inbox item, then prove wait short-circuits getRun.
  Object.assign(process.env, { SUPERAGENT_HOME: s.sa, ARCHON_HOME: join(s.sa, 'archon'), SUPERAGENT_ROLE: '' });
  const { caller } = await import('../src/coord'); const actor = caller(); s.c.claim(s.scope, actor, true, 'wait fixture');
  const l = { run_id: 'fixture', repo: s.repo, archon_run_id: 'never-provider' } as Ledger;
  process.env.SA_ARCHON_BIN = '/nonexistent';
  const result = waitRun(l, 30); expect(result).toMatchObject({ state: 'inbox', exit: 3 });
  expect((result.inbox as Message[]).some(m => m.id === out.id)).toBe(true);
});
test('5/7: heartbeat delivers only once per recipient; no spawned hook transport', () => {
  const s = setup(), live = req('../hooks/live.cjs');
  // live names hash the raw session; derive its actual name with node crypto.
  const name = req('node:crypto').createHash('sha256').update('fixture-session').digest('hex').slice(0, 16);
  const beatFile = join(s.sa, 'live', `codex-${name}.json`); mkdirSync(join(s.sa, 'live'));
  const recipient = { ...a, session_id: 'fixture-session' }; s.c.claim(s.scope, recipient); s.c.handoff(s.scope, b, input);
  writeFileSync(beatFile, JSON.stringify({ ...recipient, at: new Date().toISOString(), event: 'Stop', coord_seen: [] }));
  const p = { session_id: 'fixture-session', cwd: s.repo, hook_event_name: 'UserPromptSubmit' };
  expect(live.beat('codex', p, () => 'commander', { SUPERAGENT_HOME: s.sa })).toHaveLength(1);
  expect(live.beat('codex', p, () => 'commander', { SUPERAGENT_HOME: s.sa })).toHaveLength(0);
  expect(readFileSync(beatFile, 'utf8')).not.toContain(input.body);
});
test('8: dirty and uncommitted engine rejected; committed clean snapshot has exact commit SHA', () => {
  const root = tmp(), repo = gitRepo(root);
  const sha = sh('git rev-parse HEAD', repo).trim(); expect(cleanEngine(repo)).toBe(sha);
  writeFileSync(join(repo, 'README.md'), 'dirty'); expect(() => cleanEngine(repo)).toThrow(/不干净/);
  sh('git add README.md && git -c user.name=t -c user.email=t@l commit -qm fixed', repo);
  expect(cleanEngine(repo)).not.toBe(sha);
});
test('9: old ledger controller falls back to launcher; linked worktrees share repository identity; Orca disabled', () => {
  const s = setup();
  const c = new Coordination({ sa: s.sa, runs: () => [{ run_id: 'old', archon_run_id: 'r', repo: s.repo,
    launcher: { ...a, client: 'codex', tty: null, cwd: s.repo } }], status: () => 'running', presence: () => online });
  expect(c.owner(s.scope)).toMatchObject({ owner: a, evidence: ['nonterminal run old legacy launcher'] });
  const wt = join(s.root, 'linked'); sh(`git worktree add -q -b linked '${wt}'`, s.repo);
  expect(repoScope(wt)).toEqual(s.scope); expect(hooks.repoScope(join(wt, 'new.ts'))).toEqual(s.scope);
  process.env.SA_ORCA = '0'; process.env.SA_ORCA_BIN = '/nonexistent';
  c.claim(s.scope, a); expect(c.handoff(s.scope, b, input).delivery).toBe('queued');
});
test('presence active/idle/offline/unknown comes from one verifier, not heartbeat expiry', () => {
  const s = setup();
  expect(presence(a, s.sa)).toEqual({ state: 'online', activity: 'idle' });
  mkdirSync(join(s.sa, 'live')); writeFileSync(join(s.sa, 'live/a.json'), JSON.stringify({ ...a, at: new Date().toISOString() }));
  expect(presence(a, s.sa)).toEqual({ state: 'online', activity: 'active' });
  expect(presence({ ...a, pid: 99999999 }, s.sa)).toEqual({ state: 'offline' });
  expect(presence({ ...a, pid_start: undefined }, s.sa)).toEqual({ state: 'unknown' });
});
test('CLI mutation obeys owner fencing before invoking engine; read-only owner remains available', () => {
  const s = setup(); s.c.claim(s.scope, a);
  Object.assign(process.env, { SUPERAGENT_HOME: s.sa, ARCHON_HOME: join(s.sa, 'archon'), SUPERAGENT_ROLE: '' });
  mkdirSync(join(s.sa, 'runs'));
  writeFileSync(join(s.sa, 'runs/r.json'), JSON.stringify({ run_id: 'r', archon_run_id: 'provider', repo: s.repo,
    gen_dir: s.root, branch: 'feature', workflow: 'fixture', recoveries: [] }));
  expect(() => main(['decide', 'r', 'retry'])).toThrow(/fencing/);
  expect(() => main(['cancel', 'r'])).toThrow(/fencing/);
  expect(escalationTitle({ ...input, id: 'abc123' } as Message, 'offline')).toContain('负责人离线');
});

test('ambiguous legacy controllers require explicit takeover; all previous owners are notified', () => {
  const s = setup();
  const c = new Coordination({ sa: s.sa, runs: () => [a, b].map((owner, i) => ({ run_id: `r${i}`, archon_run_id: `p${i}`,
    repo: s.repo, controller: { ...owner, generation: i + 2 } })), status: () => 'running', presence: () => online });
  expect(c.owner(s.scope).conflicts).toHaveLength(2);
  expect(() => c.claim(s.scope, a)).toThrow(/conflicting/);
  const next = { ...a, session_id: 'C' }; c.claim(s.scope, next, true, 'operator resolves ambiguity');
  expect(c.owner(s.scope).generation).toBe(4);
  expect(c.inbox(a)[0].type).toBe('takeover'); expect(c.inbox(b)[0].type).toBe('takeover');
});
test('hook legacy fallback, repository backlog after takeover, and released tombstone agree with CLI', () => {
  const s = setup(); mkdirSync(join(s.sa, 'runs'));
  const l = { run_id: 'old', archon_run_id: 'p', repo: s.repo, launcher: { ...a, client: 'codex' as const, tty: null, cwd: s.repo } };
  writeFileSync(join(s.sa, 'runs/old.json'), JSON.stringify(l));
  mkdirSync(join(s.sa, 'live')); writeFileSync(join(s.sa, 'live/b.json'), JSON.stringify(b));
  const c = new Coordination({ sa: s.sa, runs: () => [l], status: () => 'running', presence: () => online });
  const payload = { cwd: s.repo, session_id: b.session_id, tool_name: 'Write', tool_input: { file_path: 'new.ts' } };
  expect(hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa })).toContain('handoff');
  const runScope = c.scope('old'); c.handoff(runScope, b, input); c.claim(s.scope, b, true, 'takeover');
  expect(hooks.unread(s.sa, b, []).filter(m => !m.type)).toHaveLength(1);
  c.release(s.scope, b);
  expect(c.owner(runScope).owner).toBeNull(); expect(hooks.unread(s.sa, a, []).filter(m => !m.type)).toHaveLength(0);
  expect(hooks.writeReason(payload, 'claude', { SUPERAGENT_HOME: s.sa })).toBeNull();
});
test('no defers urgent escalation for a full interval; new question key and stale yes are fenced', () => {
  const s = setup(); s.c.claim(s.scope, a); s.c.handoff(s.scope, b, { ...input, severity: 'urgent' });
  let now = Date.now(); const c = new Coordination({ sa: s.sa, runs: () => [], now: () => now, presence: () => ({ state: 'offline' }) });
  const keys: string[] = []; c.tick((key) => { keys.push(key); return { status: 'no' }; });
  expect(c.tick(() => { throw new Error('must defer'); })).toEqual([]);
  now += ACK_TIMEOUT_MS + 1; c.tick(key => { keys.push(key); return { status: 'pending' }; });
  expect(keys[0]).not.toBe(keys[1]);
  expect(() => c.tick(() => { c.claim(s.scope, { ...a, session_id: 'C' }, true, 'new owner'); return { status: 'yes' }; })).toThrow(/stale takeover/);
});
test('real CLI urgent and unknown-timeout use only temporary supervisor state and a Python stub', () => {
  const s = setup(); Object.assign(process.env, { SUPERAGENT_HOME: s.sa, ARCHON_HOME: join(s.sa, 'archon'), SUPERAGENT_ROLE: '',
    AGENT_SUPERVISOR_STATE: join(s.root, 'supervisor'), SA_SUPERVISOR: join(s.root, 'supervisor.py') });
  mkdirSync(process.env.AGENT_SUPERVISOR_STATE!, { recursive: true });
  writeFileSync(process.env.SA_SUPERVISOR!, `import os,sys,json\np=os.environ['AGENT_SUPERVISOR_STATE']\nwith open(p+'/calls','a') as f: f.write(json.dumps(sys.argv[1:],ensure_ascii=False)+'\\n')\nprint('fixture-ask' if sys.argv[1]=='ask' else 'pending')\n`);
  const body = join(s.root, 'body.md'); writeFileSync(body, input.body);
  s.c.claim(s.scope, { ...a, pid: 99999999 });
  expect(main(['handoff', '--to', s.repo, '--kind', 'bug', '--title', 'private title', '--body-file', body, '--severity', 'urgent', '--json'])).toBe(0);
  const log = readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8');
  expect(log).toContain('负责人离线'); expect(log).not.toContain('private title'); expect(s.c.owner(s.scope).owner?.pid).toBe(99999999);
  const remote = { ...a, host: 'remote' }; s.c.claim(s.scope, remote, true, 'fixture');
  const m = s.c.messages().find(m => !m.type)!; m.at = new Date(Date.now() - ACK_TIMEOUT_MS - 1000).toISOString();
  writeFileSync(join(s.sa, 'coord/inbox', m.id + '.json'), JSON.stringify(m));
  expect(main(['handoff', '--to', s.repo, '--kind', 'bug', '--title', 'private title', '--body-file', body, '--severity', 'urgent', '--json'])).toBe(0);
  expect(readFileSync(join(process.env.AGENT_SUPERVISOR_STATE!, 'calls'), 'utf8')).toContain('状态未知');
  expect(s.c.owner(s.scope).owner).toEqual(remote);
});
test('wait already blocking returns inbox after a new message arrives, before timeout', () => {
  const s = setup(); Object.assign(process.env, { SUPERAGENT_HOME: s.sa, ARCHON_HOME: join(s.sa, 'archon'), SUPERAGENT_ROLE: '' });
  s.c.claim(s.scope, caller());
  const bin = join(s.root, 'archon');
  const message = { ...input, id: 'late-message', scope: s.scope, sender: b, recipient: caller(), generation: 1, state: 'queued', at: new Date().toISOString() };
  const file = join(s.sa, 'coord/inbox/late-message.json');
  mkdirSync(join(s.sa, 'coord/inbox'), { recursive: true });
  // The wait boundary itself is the subject: its stub deposits mail during the first wait slice.
  writeFileSync(bin, `#!/usr/bin/env python3\nimport sys,json\nif sys.argv[2]=='get': print(json.dumps({'id':'p','status':'running','metadata':{'execution_owner':{'host':'remote','pid':1}}}))\nelse:\n open(${JSON.stringify(file)},'w').write(${JSON.stringify(JSON.stringify(message))})\n print('{}')\n`);
  sh(`chmod +x '${bin}'`, s.root); process.env.SA_ARCHON_BIN = bin;
  const start = Date.now(); expect(waitRun({ run_id: 'late', archon_run_id: 'p', repo: s.repo } as Ledger, 30)).toMatchObject({ state: 'inbox', exit: 3 });
  expect(Date.now() - start).toBeLessThan(5000);
});
