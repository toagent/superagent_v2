import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '../../packages/paths/src/test-utils';
import { Intake, completion, intakeRoot, type Action, type Input } from '../src/intake';
import { nativeIntake } from '../src/intake-hook';
import type { DeliveryDecision } from '../templates/.archon/scripts/sa-check';

const track = trackTempRoots();
const root = (): string => track(mkdtempSync(join(tmpdir(), 'sa-intake-')));
const input = (message: string): Input => ({
  source: 'test',
  session: 'session',
  message,
  text: 'explicit project request',
  repo: '/repo',
  actor: 'operator',
  owner: 'commander',
});
const create = (ref = 'a'): Extract<Action, { kind: 'create' }> => ({
  kind: 'create',
  ref,
  brief: 'problem, value, why now, outcome, invariants',
  acceptance: 'focused checks',
});
const apply = (s: Intake, message: string, actions: Action[]) => s.apply(input(message), actions);
const newTask = (s: Intake, message = 'create'): string =>
  apply(s, message, [create()]).results![0]!.task!;
const launch = (task: string, revision = 1, launch_id = 'launch'): Action => ({
  kind: 'launch',
  task,
  expected_revision: revision,
  launch_id,
  plan: '/plan.json',
  digest: 'sha256',
});
const bind = (
  task: string,
  launch_id = 'launch',
  run_id = 'run'
): Extract<Action, { kind: 'bind' }> => ({
  kind: 'bind',
  task,
  launch_id,
  run_id,
  plan: '/plan.json',
  digest: 'sha256',
});
const amend = (task: string, expected_revision = 1): Extract<Action, { kind: 'amend' }> => ({
  kind: 'amend',
  task,
  expected_revision,
  brief: 'new contract',
  acceptance: 'new checks',
});

test('new tasks preserve old run, receive/apply deduplicate only stable source identity', () => {
  const dir = root(),
    s = new Intake(dir),
    a = newTask(s);
  apply(s, 'launch', [launch(a), bind(a)]);
  const b = newTask(s, 'another-message');
  expect(a).not.toBe(b);
  expect(new Intake(dir).list()).toHaveLength(2);
  expect(s.show(a).runs[0]!.run_id).toBe('run');
  const received = s.receive(input('receive'));
  expect(received.actions).toBeUndefined();
  const first = apply(s, 'receive', [create()]);
  expect(apply(s, 'receive', [create()])).toEqual(first);
  expect(() => s.apply({ ...input('receive'), text: 'changed' }, [create()])).toThrow(
    'payload conflict'
  );
  expect(() => apply(s, 'receive', [create('different')])).toThrow('payload conflict');
  expect(s.list()).toHaveLength(3);
  expect(s.input('test', 'session', 'receive')).toEqual(first);
});

test('same message atomic references, partial ambiguity, invalid actions and rollback', () => {
  const s = new Intake(root());
  const receipt = apply(s, 'multi', [
    { ...create(), group: 'pair' },
    { ...amend('$a'), group: 'pair' },
    { kind: 'clarify', fragment: 'which repository?' },
    create('independent'),
  ]);
  expect(receipt.results!.map(r => r.status)).toEqual([
    'accepted',
    'accepted',
    'pending',
    'accepted',
  ]);
  expect(s.show(receipt.results![0]!.task!).revision).toBe(2);
  const before = s.list();
  const rejected = apply(s, 'rollback', [
    { ...create(), group: 'pair' },
    { ...amend('$a', 9), group: 'pair' },
  ]);
  expect(rejected.results!.every(r => r.status === 'rejected')).toBe(true);
  expect(s.list()).toEqual(before);
  const pending = apply(s, 'group-ambiguity', [
    { ...create(), group: 'pair' },
    { kind: 'clarify', fragment: '?', group: 'pair' },
  ]);
  expect(pending.results!.every(r => r.status === 'pending')).toBe(true);
  expect(s.list()).toEqual(before);
  expect(s.apply(input('invalid'), [null, create()]).results!.map(r => r.status)).toEqual([
    'rejected',
    'accepted',
  ]);
  expect(apply(s, 'ungrouped-ref', [create(), amend('$a')]).results![1]!.status).toBe('rejected');
});

test('CAS, scope, dependency existence and cycles reject without changing the task', () => {
  const s = new Intake(root()),
    a = newTask(s),
    b = newTask(s, 'b');
  expect(apply(s, 'deps', [{ ...amend(a), dependencies: [b] }]).results![0]!.status).toBe(
    'accepted'
  );
  expect(apply(s, 'stale', [amend(a)]).results![0]!.reason).toContain('revision conflict');
  expect(apply(s, 'cycle', [{ ...amend(b), dependencies: [a] }]).results![0]!.reason).toContain(
    'dependency cycle'
  );
  expect(
    apply(s, 'missing', [{ ...amend(b), dependencies: ['missing'] }]).results![0]!.reason
  ).toContain('unknown task');
  expect(s.apply({ ...input('owner'), owner: 'other' }, [amend(b)]).results![0]!.reason).toContain(
    'scope mismatch'
  );
  expect(s.show(b).revision).toBe(1);
});

test('old question answers stay bound to old revision and engine gate', () => {
  const s = new Intake(root()),
    a = newTask(s);
  apply(s, 'setup', [
    launch(a),
    bind(a),
    {
      kind: 'question',
      task: a,
      expected_revision: 1,
      id: 'q1',
      run_id: 'run',
      gate: 'gate-m1-r1',
      prompt: 'approve this run?',
    },
    amend(a),
  ]);
  const answer: Action = { kind: 'answer', task: a, question: 'q1', value: 'approve' };
  expect(apply(s, 'answer', [answer]).results![0]!.status).toBe('accepted');
  expect(s.show(a).questions[0]).toMatchObject({
    revision: 1,
    run_id: 'run',
    gate: 'gate-m1-r1',
    answer: { value: 'approve' },
  });
  expect(s.show(a).revision).toBe(2);
  expect(JSON.stringify(s.context('/repo'))).toContain('answer_recorded');
  expect(apply(s, 'second-answer', [answer]).results![0]!.reason).toContain('not open');
  expect(
    apply(s, 'bad-question', [
      {
        kind: 'question',
        task: a,
        expected_revision: 2,
        id: 'q2',
        run_id: 'run',
        gate: 'new-gate',
        prompt: '?',
      },
    ]).results![0]!.reason
  ).toContain('run mismatch');
});

test('unknown dispatch is not retryable; explicit binding and cancel preserve history', () => {
  const dir = root(),
    s = new Intake(dir),
    a = newTask(s);
  apply(s, 'intent', [launch(a)]);
  expect(new Intake(dir).show(a).runs[0]!.dispatch).toBe('dispatch_unknown');
  expect(apply(s, 'redispatch', [launch(a, 1, 'new')]).results![0]!.status).toBe('rejected');
  expect(apply(s, 'wrong-receipt', [{ ...bind(a), digest: 'other' }]).results![0]!.status).toBe(
    'rejected'
  );
  apply(s, 'receipt', [bind(a)]);
  apply(s, 'cancel', [{ kind: 'cancel', task: a, expected_revision: 1 }]);
  expect(s.show(a).cancellations).toHaveLength(1);
  expect(s.show(a).runs[0]!.dispatch).toBe('accepted');
  expect('state' in s.show(a)).toBe(false);
});

test('only engine evidence for current revision can project completion', () => {
  const s = new Intake(root()),
    a = newTask(s);
  apply(s, 'run', [launch(a), bind(a)]);
  const decision: DeliveryDecision = {
    kind: 'advance',
    reason: null,
    evidence: ['accept.json'],
    debt: [],
    requirements: {
      status: 'verified',
      items: [
        {
          package: 'p',
          id: 'r',
          text: 'requirement',
          status: 'verified',
          evidence: ['accept.json'],
        },
      ],
    },
  };
  const green = () => ({ completed: true, decisions: [decision] });
  expect(completion(s.show(a), green)).toBe('verified');
  expect(completion(s.show(a), () => undefined)).toBe('unknown');
  expect(completion(s.show(a), () => ({ completed: true, decisions: [] }))).toBe('unknown');
  apply(s, 'revision', [amend(a)]);
  expect(completion(s.show(a), green)).toBe('unknown');
});

test('bounded restart context retains pending pointers without injecting full history', () => {
  const dir = root(),
    s = new Intake(dir);
  s.receive({ ...input('raw'), text: 'x'.repeat(100000) });
  for (let n = 0; n < 12; n++) newTask(s, String(n));
  apply(s, 'pending', [{ kind: 'clarify', fragment: 'which target?' }]);
  const context = new Intake(dir).context('/repo', 1024);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(1024);
  expect(context.truncated).toBe(true);
  expect(JSON.stringify(context)).not.toContain('x'.repeat(100));
  expect(s.context('/another').tasks).toHaveLength(0);
  expect(() => s.context('/repo', 12)).toThrow('budget');
});

test('process crash before/after atomic rename releases lock and cannot duplicate create', () => {
  const module = resolve(import.meta.dir, '../src/intake.ts'),
    config = resolve(import.meta.dir, '../src/config.ts');
  for (const afterCommit of [false, true]) {
    const dir = root(),
      payload = { input: input('crash'), actions: [create()] };
    const child = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
      import { spyOn } from 'bun:test'; import * as c from ${JSON.stringify(config)};
      import { Intake } from ${JSON.stringify(module)};
      const original = c.writeAtomic;
      spyOn(c, 'writeAtomic').mockImplementation((p,t) => { ${afterCommit ? 'original(p,t);' : ''} process.exit(9); });
      new Intake(${JSON.stringify(dir)}).apply(${JSON.stringify(payload.input)}, ${JSON.stringify(payload.actions)});
    `,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(child.exitCode).toBe(9);
    const s = new Intake(dir),
      result = s.apply(payload.input, payload.actions);
    expect(s.list()).toHaveLength(1);
    expect(s.apply(payload.input, payload.actions)).toEqual(result);
  }
});

test('concurrent writers cannot both amend expected revision 1', async () => {
  const dir = root(),
    s = new Intake(dir),
    a = newTask(s),
    module = resolve(import.meta.dir, '../src/intake.ts');
  const children = [1, 2].map(n =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `
    import { Intake } from ${JSON.stringify(module)};
    try { console.log(JSON.stringify(new Intake(${JSON.stringify(dir)}).apply(${JSON.stringify(input('cas' + n))}, ${JSON.stringify([amend(a)])}).results)); }
    catch (e) { console.log(JSON.stringify({ error: e.message })); }
  `,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
  );
  const receipts = await Promise.all(
    children.map(async child => {
      expect(await child.exited).toBe(0);
      return JSON.parse(await new Response(child.stdout).text()) as unknown;
    })
  );
  expect(receipts.filter(r => JSON.stringify(r).includes('accepted'))).toHaveLength(1);
  expect(s.show(a).revision).toBe(2);
});

test('actual CLI supports scratch receive/apply/list/show/resume with no model call', () => {
  const dir = root(),
    repo = resolve(import.meta.dir, '../..'),
    payload = join(dir, 'payload.json');
  writeFileSync(payload, JSON.stringify({ input: { ...input('cli'), repo }, actions: [create()] }));
  const cli = (...args: string[]) =>
    Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'intake', ...args],
      {
        cwd: repo,
        env: {
          ...process.env,
          SUPERAGENT_HOME: dir,
          ARCHON_HOME: join(dir, 'archon'),
          DATABASE_URL: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  expect(cli('receive', payload).exitCode).toBe(0);
  const result = cli('apply', payload);
  expect(result.exitCode).toBe(0);
  const id = (JSON.parse(result.stdout.toString()) as { results: { task: string }[] }).results[0]!
    .task;
  expect(cli('list').exitCode).toBe(0);
  expect(JSON.parse(cli('show', id).stdout.toString()).completion).toBe('unknown');
  expect(JSON.parse(cli('resume', '1024').stdout.toString()).tasks[0].id).toBe(id);
});

test('INTAKE_NATIVE node/bun transport scopes capture, restore, stable turns and advisories', () => {
  const repo = realpathSync(root()),
    home = root();
  expect(Bun.spawnSync(['git', 'init', repo]).exitCode).toBe(0);
  const store = new Intake(intakeRoot(home, repo));
  const seed = { ...input('seed'), source: 'codex', repo };
  const a = store.apply(seed, [create()]).results![0]!.task!;
  store.apply({ ...seed, message: 'claude-seed', source: 'claude' }, [create('claude')]);
  const transport = (payload: unknown, client = 'codex', extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(['node', resolve(import.meta.dir, '../hooks/intake.cjs'), client], {
      env: {
        ...process.env,
        SUPERAGENT_HOME: home,
        SUPERAGENT_ROLE: '',
        AI_DISPATCH_ROLE: '',
        TWIN_AGENT_REMOTE: '',
        ...extra,
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe('');
    expect(r.stdout.toString()).not.toContain('PRIVATE PROMPT BODY');
    return r.stdout.toString();
  };
  const hook = (
    payload: Record<string, unknown>,
    client = 'codex',
    extra: Record<string, string> = {}
  ) => {
    const result = nativeIntake(payload, client, {
      ...process.env,
      SUPERAGENT_HOME: home,
      SUPERAGENT_ROLE: '',
      AI_DISPATCH_ROLE: '',
      TWIN_AGENT_REMOTE: '',
      ...extra,
    });
    expect(result).toEqual(
      result === undefined
        ? undefined
        : {
            hookSpecificOutput: {
              hookEventName: payload.hook_event_name,
              additionalContext: expect.any(String),
            },
          }
    );
    const output = result === undefined ? '' : JSON.stringify(result) + '\n';
    expect(Buffer.byteLength(output)).toBeLessThan(8192);
    expect(output).not.toContain('PRIVATE PROMPT BODY');
    return output;
  };
  const p = {
    cwd: repo,
    session_id: 'session',
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'turn',
    prompt: 'PRIVATE PROMPT BODY',
  };
  const out = transport(p);
  expect(out).toContain(a);
  expect(out).toContain('uninterpreted');
  expect(out).toContain('problem, value');
  expect(Buffer.byteLength(out)).toBeLessThan(8192);
  expect(hook(p)).toBe(out);
  hook({ ...p, turn_id: 'turn2' });
  expect(store.input('codex', 'session', 'turn2').input.text).toBe(p.prompt);
  expect(hook({ ...p, hook_event_name: 'SessionStart' })).toContain('turn2');
  expect(hook({ ...p, hook_event_name: 'SessionStart', session_id: 'new-session' })).toContain(a);
  store.apply(store.input('codex', 'session', 'turn').input, []);
  expect(JSON.stringify(store.context(repo))).not.toContain('[\"codex\",\"session\",\"turn\"]');
  const before = readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8');
  expect(hook(p, 'codex', { SUPERAGENT_ROLE: 'worker' })).toBe('');
  expect(hook({ ...p, agent_type: 'general', agent_id: 'child' })).toBe('');
  expect(readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8')).toBe(before);
  expect(
    Bun.spawnSync([
      'git',
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'scratch',
    ]).exitCode
  ).toBe(0);
  const worktree = join(root(), 'worker');
  expect(Bun.spawnSync(['git', '-C', repo, 'worktree', 'add', '--detach', worktree]).exitCode).toBe(
    0
  );
  const workerStore = new Intake(intakeRoot(home, realpathSync(worktree)));
  workerStore.apply({ ...seed, repo: realpathSync(worktree) }, [create()]);
  expect(hook({ ...p, cwd: worktree })).toBe('');
  const unregistered = realpathSync(root());
  Bun.spawnSync(['git', 'init', unregistered]);
  expect(hook({ ...p, cwd: unregistered })).toBe('');
  expect(hook({ ...p, turn_id: undefined })).toContain('advisory');
  expect(hook({ ...p, session_id: 'unbound' })).toContain('advisory');
  expect(hook({ ...p, prompt: 'conflicting body' })).toContain('advisory');
  hook(p, 'claude');
  hook(p, 'claude');
  const state = JSON.parse(readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8'));
  expect(
    state.inputs.filter(
      (r: { input: Input }) => r.input.source === 'claude' && r.input.text === p.prompt
    )
  ).toHaveLength(2);
  writeFileSync(join(intakeRoot(home, repo), 'state.json'), '{corrupt');
  expect(hook(p)).toContain('advisory');
});

test('INTAKE_NATIVE interleaved tasks keep old execution and typed answer/amend associations', () => {
  const store = new Intake(root()),
    a = newTask(store);
  apply(store, 'run-a', [
    launch(a),
    bind(a),
    {
      kind: 'question',
      task: a,
      expected_revision: 1,
      id: 'q',
      run_id: 'run',
      gate: 'g',
      prompt: 'approve?',
    },
  ]);
  apply(store, 'status-a', []);
  const b = newTask(store, 'b');
  apply(store, 'answer-a', [{ kind: 'answer', task: a, question: 'q', value: 'yes' }]);
  apply(store, 'amend-b', [amend(b)]);
  expect(store.list()).toHaveLength(2);
  expect(store.show(a).runs[0]!.run_id).toBe('run');
  expect(store.show(a).questions[0]!.answer!.value).toBe('yes');
  expect(store.show(b).revision).toBe(2);
  expect(store.show(a).cancellations).toEqual([]);
});
