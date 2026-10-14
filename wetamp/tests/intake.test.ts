import { expect, spyOn, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '../../packages/paths/src/test-utils';
import { Intake, completion, intakeRoot, type Action, type Input } from '../src/intake';
import { decisionsOf, main, needsOf } from '../src/cli';
import * as archon from '../src/archon';
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
const launch = (
  task: string,
  revision = 1,
  launch_id = 'launch'
): Extract<Action, { kind: 'launch' }> => ({
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
    a = apply(s, 'create', [{ ...create(), requirements: [{ id: 'A', text: 'A' }] }]).results![0]!
      .task!;
  apply(s, 'run', [
    {
      ...launch(a),
      requirement_map: [{ task_requirement_id: 'A', package: 'p', requirement_id: 'r' }],
    },
    bind(a),
  ]);
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
  const packages = [
    { id: 'p', requirements: [{ id: 'r', text: 'requirement', verified_by: [0] }] },
  ];
  const green = () => ({ completed: true, decisions: [decision], packages });
  expect(completion(s.show(a), green, s.list())).toBe('verified');
  expect(completion(s.show(a), () => undefined, s.list())).toBe('unknown');
  expect(
    completion(s.show(a), () => ({ completed: true, decisions: [], packages }), s.list())
  ).toBe('unknown');
  apply(s, 'revision', [amend(a)]);
  expect(completion(s.show(a), green, s.list())).toBe('unknown');
  const historical = structuredClone(s.show(a).runs);
  expect(
    apply(s, 'remap', [
      { ...launch(a, 2, 'remap'), requirement_map: historical[0]!.requirement_map },
      bind(a, 'remap'),
    ]).results!.map(r => r.status)
  ).toEqual(['accepted', 'accepted']);
  expect(completion(s.show(a), green, s.list())).toBe('verified');
  expect(s.show(a).runs.slice(0, 1)).toEqual(historical);
  expect(
    apply(s, 'same-revision', [
      { ...launch(a, 2, 'duplicate'), group: 'duplicate' },
      { ...bind(a, 'duplicate'), group: 'duplicate' },
    ]).results![1]!.reason
  ).toContain('run already bound');
  const other = newTask(s, 'other-task');
  expect(apply(s, 'cross-task', [launch(other), bind(other)]).results![1]!.reason).toContain(
    'run already bound'
  );
  apply(s, 'third-revision', [amend(a, 2)]);
  const changed = { plan: '/other-plan.json', digest: 'other-digest' };
  expect(
    apply(s, 'changed-identity', [
      { ...launch(a, 3, 'changed'), ...changed },
      { ...bind(a, 'changed'), ...changed },
    ]).results![1]!.reason
  ).toContain('run already bound');
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

test.each([false, true])(
  'CLI completion requires frozen identity (%s) and final evidence',
  bindFrozen => {
    const dir = root(),
      repo = resolve(import.meta.dir, '../..'),
      plan = join(dir, 'plan.json'),
      sourcePlan = join(dir, 'input-plan.json');
    const art = join(dir, 'artifacts/runs/run'),
      oldHome = process.env.SUPERAGENT_HOME;
    const oldArchonHome = process.env.ARCHON_HOME;
    mkdirSync(art, { recursive: true });
    mkdirSync(join(dir, 'runs'));
    const frozen = JSON.stringify({
      packages: [
        {
          id: 'p',
          accept: [{ cmd: 'old-check', timeout_s: 1 }],
          requirements: [{ id: 'r', text: 'r', verified_by: [0] }],
        },
      ],
    });
    const original = frozen.replace('old-check', 'new-check-not-run');
    writeFileSync(plan, frozen);
    writeFileSync(sourcePlan, original);
    const s = new Intake(intakeRoot(dir, repo));
    const id = s.apply({ ...input('create'), repo }, [
      { ...create(), requirements: [{ id: 'A', text: 'A' }] },
    ]).results![0]!.task!;
    const receipt = {
      plan: bindFrozen ? plan : sourcePlan,
      digest: createHash('sha256')
        .update(bindFrozen ? frozen : original)
        .digest('hex'),
    };
    s.apply({ ...input('bind'), repo }, [
      {
        ...launch(id),
        ...receipt,
        requirement_map: [{ task_requirement_id: 'A', package: 'p', requirement_id: 'r' }],
      },
      { ...bind(id), ...receipt },
    ]);
    writeFileSync(
      join(dir, 'runs/run.json'),
      JSON.stringify({
        run_id: 'run',
        archon_run_id: 'run',
        repo,
        plan: sourcePlan,
        gen_dir: dir,
        branch: 'test',
        workflow: 'test',
      })
    );
    const run = {
      id: 'run',
      status: 'completed',
      output_root: dir,
      nodes: [{ nodeId: 'gate-m1-r2', state: 'completed' }],
    };
    const get = spyOn(archon, 'getRun').mockImplementation(() => run as archon.RunView);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const green: DeliveryDecision = {
      kind: 'advance',
      reason: null,
      evidence: ['accept.json'],
      debt: [],
      requirements: {
        status: 'verified',
        items: [
          { package: 'p', id: 'r', text: 'r', status: 'verified', evidence: ['accept.json'] },
        ],
      },
    };
    const put = (tag: string, decision: unknown) =>
      writeFileSync(join(art, `${tag}.json`), JSON.stringify({ milestone: 'm1', decision }));
    const show = () => {
      main(['intake', 'show', id, '--repo', repo]);
      return JSON.parse(String(log.mock.calls.at(-1)![0])).completion;
    };
    process.env.SUPERAGENT_HOME = dir;
    process.env.ARCHON_HOME = join(dir, 'archon');
    try {
      put('verify-p', { ...green, kind: 'repair' });
      put('settle-p', green);
      put('diff-m1-r1', { ...green, kind: 'repair' });
      put('gate-m1-r1', { ...green, kind: 'repair' });
      put('diff-m1-r2', green);
      put('gate-m1-r2', green);
      if (!bindFrozen) {
        expect(show()).toBe('unknown');
        return;
      }
      expect(show()).toBe('verified');
      const statePath = join(intakeRoot(dir, repo), 'state.json'),
        saved = readFileSync(statePath, 'utf8');
      const task = s.show(id),
        parent = { ...task, id: 'parent', runs: [] };
      const invalid = ['plan', 'digest'].map(field => ({
        ...task,
        id: field,
        runs: task.runs.map(r => ({ ...r, [field]: 'wrong' })),
      }));
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          inputs: [],
          tasks: [parent, { ...task, parent: parent.id }, ...invalid],
        })
      );
      for (let n = 0; n < 2; n++) {
        get.mockClear();
        main(['intake', 'backlog', '--repo', repo]);
        const out = JSON.parse(String(log.mock.calls.at(-1)![0]));
        expect(out.tasks.map((t: { completion: string }) => t.completion)).toEqual([
          'unknown',
          'verified',
          'unknown',
          'unknown',
        ]);
        expect(get).toHaveBeenCalledTimes(1);
      }
      writeFileSync(statePath, saved);
      writeFileSync(sourcePlan, '{"changed":true}');
      expect(show()).toBe('verified');
      expect(decisionsOf(art).filter(d => d.decision?.kind === 'repair')).toHaveLength(3);
      expect(needsOf(art)).toEqual([]);
      put('gate-m1-r2', { ...green, kind: 'block', reason: 'coder_redline' });
      expect(show()).toBe('unknown');
      expect(needsOf(art)).toHaveLength(1);
      for (const decision of [
        undefined,
        { verdict: 'pass' },
        { ...green, requirements: undefined },
        { ...green, requirements: { status: 'verified', items: [] } },
      ]) {
        put('gate-m1-r2', decision);
        expect(show()).toBe('unknown');
      }
      writeFileSync(join(art, 'gate-m1-r2.json'), '{');
      expect(show()).toBe('unknown');
      unlinkSync(join(art, 'gate-m1-r2.json'));
      expect(show()).toBe('unknown');
      put('gate-m1-r2', green);
      run.status = 'running';
      expect(show()).toBe('unknown');
      run.status = 'completed';
      writeFileSync(plan, '{"changed":true}');
      expect(show()).toBe('unknown');
    } finally {
      get.mockRestore();
      log.mockRestore();
      if (oldHome === undefined) delete process.env.SUPERAGENT_HOME;
      else process.env.SUPERAGENT_HOME = oldHome;
      if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = oldArchonHome;
    }
  }
);

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
      spyOn(c, 'writeAtomic').mockImplementation((p,t) => { ${
        afterCommit ? 'original(p,t);' : ''
      } process.exit(9); });
      new Intake(${JSON.stringify(dir)}).apply(${JSON.stringify(payload.input)}, ${JSON.stringify(
        payload.actions
      )});
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
    try { console.log(JSON.stringify(new Intake(${JSON.stringify(dir)}).apply(${JSON.stringify(
      input('cas' + n)
    )}, ${JSON.stringify([amend(a)])}).results)); }
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
  const backlog = JSON.parse(cli('backlog', id).stdout.toString());
  expect(backlog.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  expect(backlog.tasks[0].reason).toBe('no_requirements');
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
  expect(out).toContain('until next is null');
  expect(out).toContain('backlog');
  expect(out).toContain('problem, value');
  expect(Buffer.byteLength(out)).toBeLessThan(8192);
  expect(hook(p)).toBe(out);
  hook({ ...p, turn_id: 'turn2' });
  expect(store.input('codex', 'session', 'turn2').input.text).toBe(p.prompt);
  expect(hook({ ...p, hook_event_name: 'SessionStart' })).toContain('turn2');
  expect(hook({ ...p, hook_event_name: 'SessionStart', session_id: 'new-session' })).toContain(a);
  store.apply(store.input('codex', 'session', 'turn').input, []);
  expect(JSON.stringify(store.context(repo))).not.toContain('["codex","session","turn"]');
  const before = readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8');
  for (const role of ['general', 'reviewer']) {
    const env = { SUPERAGENT_ROLE: role };
    expect(transport({ ...p, hook_event_name: 'SessionStart' }, 'codex', env)).toBe('');
    expect(transport({ ...p, turn_id: `derived-${role}` }, 'codex', env)).toBe('');
  }
  expect(readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8')).toBe(before);
  expect(
    transport({ ...p, hook_event_name: 'SessionStart' }, 'codex', {
      SUPERAGENT_ROLE: 'commander',
    })
  ).toContain(a);
  expect(
    transport({ ...p, turn_id: 'commander-turn' }, 'codex', {
      SUPERAGENT_ROLE: 'commander',
    })
  ).toContain('commander-turn');
  expect(store.input('codex', 'session', 'commander-turn').input.text).toBe(p.prompt);
  const afterCommander = readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8');
  expect(hook(p, 'codex', { SUPERAGENT_ROLE: 'worker' })).toBe('');
  expect(hook({ ...p, agent_type: 'general', agent_id: 'child' })).toBe('');
  expect(readFileSync(join(intakeRoot(home, repo), 'state.json'), 'utf8')).toBe(afterCommander);
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

test('explicit obligations inherit and only append; malformed maps and remapping bind reject', () => {
  const s = new Intake(root()),
    A = { id: 'A', text: 'original A' },
    B = { id: 'B', text: 'B' };
  const id = apply(s, 'create', [{ ...create(), requirements: [A] }]).results![0]!.task!;
  apply(s, 'inherit', [amend(id)]);
  expect(s.show(id).revisions.at(-1)!.requirements).toEqual([A]);
  for (const requirements of [[B], [{ ...A, text: 'changed' }], [A, A], []]) {
    expect(
      apply(s, 'reject-' + JSON.stringify(requirements), [{ ...amend(id, 2), requirements }])
        .results![0]!.status
    ).toBe('rejected');
    expect(s.show(id).revision).toBe(2);
  }
  apply(s, 'append', [{ ...amend(id, 2), requirements: [A, B] }]);
  expect(s.show(id).revisions.at(-1)!.requirements).toEqual([A, B]);
  const map = { task_requirement_id: 'A', package: 'p', requirement_id: 'r' };
  for (const requirement_map of [
    [],
    [map, map],
    [map, { ...map, task_requirement_id: 'B' }],
    [{ ...map, task_requirement_id: 'missing' }],
  ])
    expect(
      apply(s, 'badmap-' + JSON.stringify(requirement_map), [{ ...launch(id, 3), requirement_map }])
        .results![0]!.status
    ).toBe('rejected');
  apply(s, 'launch', [{ ...launch(id, 3), requirement_map: [map] }]);
  expect(
    s.apply(input('remap-bind'), [{ ...bind(id), requirement_map: [map] }]).results![0]!.status
  ).toBe('rejected');
  apply(s, 'bind', [bind(id)]);
  expect(s.show(id).runs[0]!.requirement_map).toEqual([map]);
});

test('coverage unions current revision exact targets and every descendant blocks its parent', () => {
  const s = new Intake(root()),
    requirements = [
      { id: 'A', text: 'A' },
      { id: 'B', text: 'B' },
    ];
  const id = apply(s, 'parent', [{ ...create(), requirements }]).results![0]!.task!;
  const map = (id: string) => [{ task_requirement_id: id, package: 'p', requirement_id: id }];
  const packages = [{ id: 'p', requirements: requirements.map(r => ({ ...r, verified_by: [0] })) }];
  const decision = (id: string): DeliveryDecision => ({
    kind: 'advance',
    reason: null,
    debt: [],
    evidence: ['accept'],
    requirements: {
      status: 'verified',
      items: [{ package: 'p', id, text: id, status: 'verified', evidence: ['accept'] }],
    },
  });
  const evidence = (r: { launch_id: string }) => ({
    completed: true,
    decisions: [decision(r.launch_id)],
    packages,
  });
  apply(s, 'a', [{ ...launch(id, 1, 'A'), requirement_map: map('A') }, bind(id, 'A', 'run-a')]);
  expect(completion(s.show(id), evidence, s.list())).toBe('unknown');
  expect(s.backlog('/repo', evidence).tasks[0]!.covered).toEqual(['A']);
  apply(s, 'b', [{ ...launch(id, 1, 'B'), requirement_map: map('B') }, bind(id, 'B', 'run-b')]);
  expect(completion(s.show(id), evidence, s.list())).toBe('verified');
  expect(completion(s.show(id), r => ({ ...evidence(r), packages: [] }), s.list())).toBe('unknown');
  expect(
    completion(s.show(id), r => ({ ...evidence(r), decisions: [decision('wrong')] }), s.list())
  ).toBe('unknown');
  expect(
    completion(
      s.show(id),
      () => {
        throw new Error('unreadable');
      },
      s.list()
    )
  ).toBe('unknown');
  const child = apply(s, 'child', [{ ...create(), parent: id, requirements: [requirements[0]!] }])
    .results![0]!.task!;
  expect(completion(s.show(id), evidence, s.list())).toBe('unknown');
  apply(s, 'child-run', [
    { ...launch(child, 1, 'A'), requirement_map: map('A') },
    bind(child, 'A', 'child-run'),
  ]);
  expect(completion(s.show(id), evidence, s.list())).toBe('verified');
  const grandchild = apply(s, 'grandchild', [{ ...create(), parent: child }]).results![0]!.task!;
  apply(s, 'cancel-grandchild', [{ kind: 'cancel', task: grandchild, expected_revision: 1 }]);
  expect(completion(s.show(id), evidence, s.list())).toBe('unknown');
  const backlog = s.backlog('/repo', evidence, id);
  expect(backlog.tasks.map(t => t.id)).toEqual([id, child, grandchild]);
  expect(backlog.obligations).toBe(3);
  expect(backlog.tasks[2]!.reason).toBe('cancelled_intent');
  apply(s, 'amend-grandchild', [amend(grandchild)]);
  expect(s.backlog('/repo', evidence, id).tasks[2]!.cancellation_intents).toHaveLength(1);
  expect(s.backlog('/repo', evidence, id).tasks[2]!.reason).toBe('no_requirements');
  apply(s, 'new-revision', [amend(id)]);
  expect(s.backlog('/repo', evidence, id).tasks[0]!.covered).toEqual([]);
  const invalid = structuredClone(s.list());
  invalid.find(t => t.id === id)!.parent = grandchild;
  expect(completion(invalid[0]!, evidence, invalid)).toBe('unknown');
  expect(completion({ ...s.show(child), parent: 'missing' }, evidence, s.list())).toBe('unknown');
  const legacy = newTask(s, 'legacy');
  apply(s, 'legacy-run', [launch(legacy), bind(legacy, 'launch', 'legacy-run')]);
  expect(completion(s.show(legacy), evidence, s.list())).toBe('unknown');
});

test('fixed-bound context visits all ID/key pointers once despite continuous append and detects reordered history', () => {
  const dir = root(),
    s = new Intake(dir),
    ids: string[] = [],
    keys: string[] = [];
  for (let n = 0; n < 16; n++) {
    const result = apply(s, 'task-' + n, [
      { ...create(), requirements: [{ id: 'A', text: 'x'.repeat(12000) }] },
    ]);
    ids.push(result.results![0]!.task!);
    const raw = input('raw-' + n);
    s.receive(raw);
    keys.push(JSON.stringify([raw.source, raw.session, raw.message]));
  }
  const seenTasks: string[] = [],
    seenInputs: string[] = [];
  let cursor: string | undefined,
    pages = 0,
    firstCursor = '';
  do {
    const page = s.context('/repo', 1024, cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
    expect(page.coverage.tasks.total).toBe(16);
    expect(page.coverage.inputs.total).toBe(16);
    expect(page.coverage.tasks.shown).toBe(page.tasks.length);
    expect(page.coverage.inputs.shown).toBe(page.inputs.length);
    seenTasks.push(...page.tasks.map(t => (t as { id: string }).id));
    seenInputs.push(...page.inputs.map(t => (t as { key: string }).key));
    if (pages === 0) {
      expect(JSON.stringify(page)).toContain('intake show');
      firstCursor = page.next!;
    } else {
      expect(page.coverage.tasks.later).toBe(pages);
      expect(page.coverage.inputs.later).toBe(pages);
    }
    cursor = page.next ?? undefined;
    newTask(s, 'later-task-' + pages);
    s.receive(input('later-input-' + pages));
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(seenTasks).toEqual(ids);
  expect(seenInputs).toEqual(keys);
  expect(s.context('/repo', 65536).coverage.tasks.total).toBe(16 + pages);
  expect(() => s.context('/repo', 128)).toThrow('metadata');
  expect(() => s.context('/repo', 1024, 'not-a-cursor')).toThrow('cursor');
  expect(() => s.context('/other', 1024, firstCursor)).toThrow('cursor');
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  state.tasks.reverse();
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  expect(() => s.context('/repo', 1024, firstCursor)).toThrow('cursor');
});
