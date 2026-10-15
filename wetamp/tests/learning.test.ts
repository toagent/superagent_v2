import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { evolutionScript, publishLearning, recallLearning, proposeLearning } from '../src/learning';
import { injectMemory, memoryWrite, type Lesson } from '../src/memory';
import type { Ledger } from '../src/cli';
import { executionTable } from '../src/execution';
import { loadTiers } from '../src/config';
import { prepareContext } from '../templates/.archon/scripts/sa-context';
import type { Plan } from '../src/plan';
import { tmp } from './helpers';

test('LEARNING_EVIDENCE LEARNING_PUBLICATION owner schema/recall, publication transaction and frozen code/review consumption', () => {
  const root = tmp(),
    gen = join(root, 'gen'),
    art = join(root, 'art');
  const saved = { ...process.env },
    spawn = Bun.spawnSync;
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'archon');
  process.env.SUPERAGENT_MEMORY = 'on';
  mkdirSync(gen);
  mkdirSync(art);
  mkdirSync(join(gen, '.archon'));
  writeFileSync(join(gen, '.archon/principles.md'), 'fixture principles');
  // Only the publication control-plane calls are simulated. The installed qualification
  // owner's exact schema, fingerprint, checksums, expiry and recall run as real Python.
  const make = (variant = '') => {
    const p = spawn(
      [
        'python3',
        '-c',
        `import importlib.util,json,sys,datetime as dt
s=importlib.util.spec_from_file_location('owner',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
e={'id':'qualified','scope':'project:'+sys.argv[2],'domain':'engineering','claim':'Preserve complete contract boundaries','applies_when':'When changing contract boundaries','not_when':'Unrelated isolated documentation work','keywords':['contract'],'expires_at':(m.now()+dt.timedelta(days=1)).isoformat(),'shareable':True,'evidence':[{'kind':m.read_json(m.ROOT/'references/policy.json')['evidence_kinds'][0],'source':'fixture:isolated-evidence','sha256':'a'*64,'verified_at':m.stamp(),'result':'Isolated conformance fixture passes'}],'probes':{'positive':['contract'],'negative':['unrelated']}}
if sys.argv[3]=='expired': e['expires_at']=(m.now()-dt.timedelta(days=1)).isoformat()
r={'entries':[e]}; v={'schema':1,'fingerprint':m.fingerprint(),'stable':m.digest({'kind':'revision','value':r}),'revision':r,'audit_head':'b'*64,'audit_count':1,'exported_at':m.stamp()}
if sys.argv[3]=='stale': v['exported_at']=(m.now()-dt.timedelta(days=8)).isoformat()
if sys.argv[3]=='drift': v['fingerprint']='c'*64
v['checksum']=m.digest(v); print(json.dumps(v))`,
        evolutionScript,
        root,
        variant,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
  };
  let snap = make(),
    fail = false,
    concurrent = false,
    verifies = 0;
  const calls: string[] = [];
  const mock = spyOn(Bun, 'spawnSync').mockImplementation(((
    ...args: Parameters<typeof Bun.spawnSync>
  ) => {
    const argv = args[0] as string[],
      command = argv[2];
    calls.push(command!);
    if (command === 'verify' || command === 'export') {
      if (fail)
        return {
          exitCode: 2,
          stdout: Buffer.from(''),
          stderr: Buffer.from('rejected'),
        } as ReturnType<typeof Bun.spawnSync>;
      if (command === 'export') {
        mkdirSync(dirname(argv[3]!), { recursive: true });
        writeFileSync(argv[3]!, JSON.stringify(snap));
      }
      const value =
        command === 'export'
          ? { stable: snap.stable, checksum: snap.checksum }
          : {
              integrity: 'ok',
              stable: concurrent && ++verifies > 1 ? 'changed' : snap.stable,
              fingerprint: snap.fingerprint,
              audit_count: 1,
            };
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>;
    }
    return spawn(...args);
  }) as typeof Bun.spawnSync);
  try {
    expect(publishLearning().status).toBe('available');
    expect(calls.slice(0, 4)).toEqual(['verify', 'export', 'verify', 'snapshot-recall']);
    const publication = join(process.env.SUPERAGENT_HOME!, 'memory/publication.json');
    expect(statSync(publication).mode & 0o777).toBe(0o600);
    const old = readFileSync(publication, 'utf8');
    fail = true;
    expect(publishLearning().status).toBe('unavailable');
    expect(readFileSync(publication, 'utf8')).toBe(old);
    fail = false;
    concurrent = true;
    expect(publishLearning().status).toBe('unavailable');
    concurrent = false;
    expect(readFileSync(publication, 'utf8')).toBe(old);
    expect(recallLearning(root, 'contract').entries[0]?.claim).toBe(snap.revision.entries[0].claim);
    expect(recallLearning(tmp(), 'contract').entries).toEqual([]);
    expect(recallLearning(root, 'x'.repeat(2001)).status).toBe('unavailable');
    process.env.SUPERAGENT_MEMORY = 'off';
    expect(recallLearning(root, 'contract').status).toBe('disabled');
    process.env.SUPERAGENT_MEMORY = 'on';
    expect(recallLearning('/repo/_private', 'contract').status).toBe('disabled');
    const plan = JSON.parse(
      readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
    ) as Plan;
    plan.repo = root;
    for (const p of plan.packages) p.goal = 'contract boundaries';
    writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
    const table = executionTable(plan, loadTiers());
    writeFileSync(join(gen, 'execution.json'), JSON.stringify(table));
    expect(injectMemory(plan, gen, [])).toEqual(
      Object.fromEntries(plan.packages.map(p => [p.id, ['qualified']]))
    );
    const contexts = Object.entries(table)
      .filter(([, e]) => e.role === 'code' || e.role === 'review')
      .map(([node]) =>
        prepareContext({
          gen,
          artifacts: art,
          node,
          cwd: root,
          base: 'base',
          head: 'head',
          environment: 'fixture',
        })
      );
    expect(contexts.length).toBeGreaterThan(1);
    const bytes = contexts.map(p => readFileSync(p, 'utf8'));
    for (const b of bytes) expect(b).toContain('Preserve complete contract boundaries');
    for (const variant of ['expired', 'stale', 'drift']) {
      snap = make(variant);
      writeFileSync(publication, JSON.stringify(snap));
      expect(recallLearning(root, 'contract').entries).toEqual([]);
    }
    writeFileSync(publication, old.replace('Preserve complete', 'Tampered complete'));
    expect(recallLearning(root, 'contract').status).toBe('unavailable');
    injectMemory(plan, gen, []);
    expect(contexts.map(p => readFileSync(p, 'utf8'))).toEqual(bytes);
    rmSync(publication);
    const next = join(root, 'next');
    mkdirSync(next);
    writeFileSync(join(next, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(next, 'execution.json'), JSON.stringify(table));
    expect(Object.values(injectMemory(plan, next, [])).flat()).toEqual([]);
    const [node] = Object.entries(table).find(([, e]) => e.role === 'code')!;
    expect(
      readFileSync(
        prepareContext({
          gen: next,
          artifacts: art,
          node,
          cwd: root,
          base: 'base',
          head: 'head',
          environment: 'fixture',
        }),
        'utf8'
      )
    ).not.toContain('Preserve complete contract boundaries');
    expect(contexts.map(p => readFileSync(p, 'utf8'))).toEqual(bytes);
  } finally {
    mock.mockRestore();
    for (const k of ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_MEMORY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}, 15000);

test('LEARNING_EVIDENCE freezes original bytes and actual identity, submits only to the real qualification owner', () => {
  const root = tmp(),
    sa = join(root, 'sa'),
    store = join(root, 'owner'),
    art = join(sa, 'artifacts/runs/native');
  const saved = { ...process.env },
    spawn = Bun.spawnSync;
  process.env.SUPERAGENT_HOME = sa;
  process.env.ARCHON_HOME = join(root, 'archon');
  process.env.SUPERAGENT_MEMORY = 'on';
  mkdirSync(art, { recursive: true });
  const owner = (...args: string[]) => {
    const p = spawn(['python3', evolutionScript, '--home', store, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
  };
  const initial = owner('init'),
    file = join(art, 'verify-core.json'),
    bytes = Buffer.from(JSON.stringify({ ok: false, diff_hash: 'head' }));
  writeFileSync(file, bytes);
  const lesson = {
    id: 'contract-lesson',
    tier: 'project',
    scope: root,
    status: 'trial',
    when: 'When changing contract boundaries',
    do: 'Preserve complete contract boundaries',
    dont: 'Unrelated isolated documentation work',
    why: 'Original failed execution needs a regression',
    evidence: ['run'],
  } as Lesson;
  memoryWrite(() => ({ lessons: [lesson] }));
  const request = {
    lesson: lesson.id,
    package: 'core',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    shareable: true as const,
    keywords: ['contract'],
    positive: ['contract'],
    negative: ['unrelated'],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  const ledger = { run_id: 'run', archon_run_id: 'native', repo: root } as Ledger;
  const event = {
    workflow_run_id: 'native',
    event_type: 'node_completed',
    step_name: 'code-core',
    data: {
      invocation: { id: 'invocation' },
      attempt: { id: 'attempt' },
      binding: {
        provider: 'codex',
        model: {
          requested: 'untrusted-request',
          resolved: { source: 'provider', value: 'actual-provider-model' },
        },
      },
    },
  };
  const run = {
    id: 'native',
    status: 'completed',
    working_path: root,
    output_root: sa,
    events: [event],
  };
  const calls: string[] = [];
  const mock = spyOn(Bun, 'spawnSync').mockImplementation(((
    ...args: Parameters<typeof Bun.spawnSync>
  ) => {
    const argv = args[0] as string[];
    if (argv[1] === evolutionScript) {
      calls.push(argv[2]!);
      return spawn([argv[0]!, argv[1]!, '--home', store, ...argv.slice(2)], args[1]);
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(run)),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>;
  }) as typeof Bun.spawnSync);
  try {
    const reject = () => expect(proposeLearning(ledger, request).status).toBe('unavailable');
    rmSync(file);
    reject();
    writeFileSync(file, '{');
    reject();
    writeFileSync(file, '{}');
    reject();
    writeFileSync(file, bytes);
    expect(proposeLearning(ledger, { ...request, package: '../transcript' }).status).toBe(
      'unavailable'
    );
    expect(proposeLearning(ledger, { ...request, sha256: '0'.repeat(64) }).status).toBe(
      'unavailable'
    );
    rmSync(file);
    symlinkSync(join(root, 'missing'), file);
    reject();
    rmSync(file);
    writeFileSync(file, bytes);
    run.output_root = tmp();
    reject();
    run.output_root = sa;
    expect(proposeLearning({ ...ledger, repo: tmp() }, request).status).toBe('unavailable');
    expect(proposeLearning({ ...ledger, repo: join(root, '_private') }, request).status).toBe(
      'unavailable'
    );
    event.data.binding.model.resolved.source = 'request';
    reject();
    event.data.binding.model.resolved.source = 'provider';
    event.data.binding.model.resolved.value = 'unknown';
    reject();
    event.data.binding.model.resolved.value = 'actual-provider-model';
    run.events.push(event);
    reject();
    run.events.pop();
    event.workflow_run_id = 'other-run';
    reject();
    event.workflow_run_id = 'native';
    expect(calls).toEqual([]);
    event.event_type = 'node_started';
    reject();
    event.event_type = 'node_failed';
    run.status = 'failed';
    const result = proposeLearning(ledger, request);
    expect(result.status).toBe('prepared');
    expect(result.model).toBe('actual-provider-model');
    expect(calls).toEqual(['propose', 'evaluate']);
    expect(readFileSync(join(result.evidence as string, 'original.json'))).toEqual(bytes);
    expect(
      JSON.parse(readFileSync(join(result.evidence as string, 'provenance.json'), 'utf8')).sha256
    ).toBe(request.sha256);
    expect(statSync(join(result.evidence as string, 'original.json')).mode & 0o777).toBe(0o400);
    const candidate = owner('show', result.candidate as string);
    expect(JSON.stringify(candidate)).toContain(`project:${root}`);
    expect(owner('verify').stable).toBe(initial.stable);
    const denied = spawn(
      ['python3', evolutionScript, '--home', store, 'promote', result.candidate as string],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    expect(denied.exitCode).toBe(2);
    expect(owner('verify').stable).toBe(initial.stable);
    expect(
      owner(
        'recall',
        '--scope',
        `project:${root}`,
        '--domain',
        'engineering',
        '--query',
        'contract'
      ).entries
    ).toEqual([]);
  } finally {
    mock.mockRestore();
    for (const k of ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_MEMORY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}, 15000);
