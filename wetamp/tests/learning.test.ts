import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evolutionScript, publishLearning, recallLearning } from '../src/learning';
import { injectMemory } from '../src/memory';
import { executionTable } from '../src/execution';
import { loadTiers } from '../src/config';
import { prepareContext } from '../templates/.archon/scripts/sa-context';
import type { Plan } from '../src/plan';
import { tmp } from './helpers';

test('LEARNING_PUBLICATION owner schema/recall, publication transaction and frozen code/review consumption', () => {
  const root = tmp(), gen = join(root, 'gen'), art = join(root, 'art');
  const saved = { ...process.env }, spawn = Bun.spawnSync;
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'archon');
  process.env.SUPERAGENT_MEMORY = 'on';
  mkdirSync(gen); mkdirSync(art); mkdirSync(join(gen, ".archon")); writeFileSync(join(gen, ".archon/principles.md"), "fixture principles");
  // Only the publication control-plane calls are simulated. The installed qualification
  // owner's exact schema, fingerprint, checksums, expiry and recall run as real Python.
  const make = (variant = '') => {
    const p = spawn(['python3', '-c', `import importlib.util,json,sys,datetime as dt
s=importlib.util.spec_from_file_location('owner',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
e={'id':'qualified','scope':'project:'+sys.argv[2],'domain':'engineering','claim':'Preserve complete contract boundaries','applies_when':'When changing contract boundaries','not_when':'Unrelated isolated documentation work','keywords':['contract'],'expires_at':(m.now()+dt.timedelta(days=1)).isoformat(),'shareable':True,'evidence':[{'kind':m.read_json(m.ROOT/'references/policy.json')['evidence_kinds'][0],'source':'fixture:isolated-evidence','sha256':'a'*64,'verified_at':m.stamp(),'result':'Isolated conformance fixture passes'}],'probes':{'positive':['contract'],'negative':['unrelated']}}
if sys.argv[3]=='expired': e['expires_at']=(m.now()-dt.timedelta(days=1)).isoformat()
r={'entries':[e]}; v={'schema':1,'fingerprint':m.fingerprint(),'stable':m.digest({'kind':'revision','value':r}),'revision':r,'audit_head':'b'*64,'audit_count':1,'exported_at':m.stamp()}
if sys.argv[3]=='stale': v['exported_at']=(m.now()-dt.timedelta(days=8)).isoformat()
if sys.argv[3]=='drift': v['fingerprint']='c'*64
v['checksum']=m.digest(v); print(json.dumps(v))`, evolutionScript, root, variant], { stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
  };
  let snap = make(), fail = false, concurrent = false, verifies = 0;
  const calls: string[] = [];
  const mock = spyOn(Bun, 'spawnSync').mockImplementation(((...args: Parameters<typeof Bun.spawnSync>) => {
    const argv = args[0] as string[], command = argv[2];
    calls.push(command!);
    if (command === 'verify' || command === 'export') {
      if (fail) return { exitCode: 2, stdout: Buffer.from(''), stderr: Buffer.from('rejected') } as ReturnType<typeof Bun.spawnSync>;
      if (command === 'export') { mkdirSync(dirname(argv[3]!), { recursive: true }); writeFileSync(argv[3]!, JSON.stringify(snap)); }
      const value = command === 'export' ? { stable: snap.stable, checksum: snap.checksum } :
        { integrity: 'ok', stable: concurrent && ++verifies > 1 ? 'changed' : snap.stable, fingerprint: snap.fingerprint, audit_count: 1 };
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.from('') } as ReturnType<typeof Bun.spawnSync>;
    }
    return spawn(...args);
  }) as typeof Bun.spawnSync);
  try {
    expect(publishLearning().status).toBe('available');
    expect(calls.slice(0, 4)).toEqual(['verify', 'export', 'verify', 'snapshot-recall']);
    const publication = join(process.env.SUPERAGENT_HOME!, 'memory/publication.json');
    expect(statSync(publication).mode & 0o777).toBe(0o600);
    const old = readFileSync(publication, 'utf8');
    fail = true; expect(publishLearning().status).toBe('unavailable');
    expect(readFileSync(publication, 'utf8')).toBe(old);
    fail = false; concurrent = true; expect(publishLearning().status).toBe('unavailable'); concurrent = false;
    expect(readFileSync(publication, 'utf8')).toBe(old);
    expect(recallLearning(root, 'contract').entries[0]?.claim).toBe(snap.revision.entries[0].claim);
    expect(recallLearning(tmp(), 'contract').entries).toEqual([]);
    expect(recallLearning(root, 'x'.repeat(2001)).status).toBe('unavailable');
    process.env.SUPERAGENT_MEMORY = 'off'; expect(recallLearning(root, 'contract').status).toBe('disabled');
    process.env.SUPERAGENT_MEMORY = 'on'; expect(recallLearning('/repo/_private', 'contract').status).toBe('disabled');
    const plan = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')) as Plan;
    plan.repo = root; for (const p of plan.packages) p.goal = 'contract boundaries';
    writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
    const table = executionTable(plan, loadTiers());
    writeFileSync(join(gen, 'execution.json'), JSON.stringify(table));
    expect(injectMemory(plan, gen, [])).toEqual(Object.fromEntries(plan.packages.map(p => [p.id, ['qualified']])));
    const contexts = Object.entries(table).filter(([, e]) => e.role === 'code' || e.role === 'review').map(([node]) =>
      prepareContext({ gen, artifacts: art, node, cwd: root, base: 'base', head: 'head', environment: 'fixture' }));
    expect(contexts.length).toBeGreaterThan(1);
    const bytes = contexts.map(p => readFileSync(p, 'utf8'));
    for (const b of bytes) expect(b).toContain('Preserve complete contract boundaries');
    for (const variant of ['expired', 'stale', 'drift']) {
      snap = make(variant); writeFileSync(publication, JSON.stringify(snap));
      expect(recallLearning(root, 'contract').entries).toEqual([]);
    }
    writeFileSync(publication, old.replace('Preserve complete', 'Tampered complete'));
    expect(recallLearning(root, 'contract').status).toBe('unavailable');
    injectMemory(plan, gen, []);
    expect(contexts.map(p => readFileSync(p, 'utf8'))).toEqual(bytes);
  } finally {
    mock.mockRestore();
    for (const k of ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_MEMORY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}, 15000);
