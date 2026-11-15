import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { RunView } from '../src/archon';
import { caller } from '../src/coord';
import { EXIT, loadLedger, main, waitRun, type Ledger } from '../src/cli';
import { NODE_LEASE, nodeLeaseDecision } from '../src/node-lease';
import { executionOwnership } from '../src/recovery';
import { inspectProcess } from '../src/launcher';
import { engineHash } from '../src/generate';
import { gitRepo, tmp } from './helpers';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test('近期工作树进展只续租一次，并在 1.5 倍预算停下', () => {
  const now = Date.parse('2026-11-15T10:20:00Z'),
    startedAt = '2026-11-15T10:00:00Z',
    run = { id: 'engine', status: 'running' } as RunView,
    // prettier-ignore
    progress = { node: 'code-core', startedAt, progressAt: now - NODE_LEASE.progress_window_ms, entries: 'a', mtime: now, state: 'working', spinning: false, idle_s: 0, waiting_command: false, cpu: 0 } as const,
    node = { nodeId: 'code-core', startedAt, budget_s: 1200 },
    extended = nodeLeaseDecision(run, node, undefined, progress, now);
  expect(extended.action).toBe('extend');
  if (extended.action !== 'extend') throw new Error('expected extension');
  expect(nodeLeaseDecision(run, node, extended.lease, progress, now + 599_000).action).toBe('none');
  expect(nodeLeaseDecision(run, node, extended.lease, progress, now + 600_000).action).toBe('stop');
});

test('并行节点只唤醒一次，单节点取消后可从真实 CLI 续作', () => {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa'),
    archon = join(root, 'archon'),
    gen = join(sa, 'gen', 'lease'),
    runs = join(sa, 'runs'),
    artifacts = join(sa, 'output', 'artifacts', 'runs', 'engine'),
    bin = join(root, 'archon-stub.ts'),
    runFile = join(root, 'run.json'),
    calls = join(root, 'calls');
  mkdirSync(join(gen, '.archon/workflows/wf'), { recursive: true });
  mkdirSync(join(gen, 'hints'));
  mkdirSync(runs, { recursive: true });
  mkdirSync(archon);
  Object.assign(process.env, {
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: archon,
    SA_ARCHON_BIN: bin,
    SUPERAGENT_MEMORY: 'off',
    DATABASE_URL: '',
  });
  const owner = caller(true),
    startedAt = new Date(Date.now() - 21 * 60_000).toISOString(),
    activeAt = new Date().toISOString(),
    processState = inspectProcess(owner.pid);
  if (processState.state !== 'online') throw new Error('fixture owner offline');
  // prettier-ignore
  const plan = { repo, base_ref: 'main', budget: { weighted_tokens: 0 }, packages: ['core', 'api'].map(id => ({ id, title: id, goal: 'g', scope: { write: ['src/**'] }, accept: [{ cmd: 'true', timeout_s: 1 }], risk: 'G1', size: 'S' })) };
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(
    join(gen, '.archon/workflows/wf/wf.yaml'),
    Bun.YAML.stringify({
      name: 'wf',
      // prettier-ignore
      nodes: [{ id: 'package-attempt-core' }, ...['core', 'api'].map(id => ({ id: `code-${id}`, prompt: 'x', model: '@sa-coder' }))],
    })
  );
  // prettier-ignore
  const engineRun = { id: 'engine', status: 'running', working_path: repo, output_root: join(sa, 'output'), started_at: startedAt, metadata: { execution_owner: { host: hostname(), pid: owner.pid, bound_at: new Date(Date.parse(processState.start) + 1000).toISOString() } }, nodes: [{ nodeId: 'start-m1', state: 'completed' }, { nodeId: 'code-core', state: 'running', startedAt }, { nodeId: 'code-api', state: 'running', startedAt: activeAt }] };
  writeFileSync(runFile, JSON.stringify(engineRun));
  expect(executionOwnership(engineRun as RunView)).toEqual({ state: 'online' });
  const launcher = { ...owner, tty: null, cwd: repo } as Ledger['launcher'];
  // prettier-ignore
  const ledger: Ledger = { run_id: 'lease', archon_run_id: 'engine', plan: join(gen, 'plan.json'), gen_dir: gen, repo, branch: 'sa/lease', workflow: 'wf', workflow_hash: engineHash(), engine_hash: engineHash(), console: 'codex', started_at: startedAt, transcript: '', log: '', launcher };
  writeFileSync(join(runs, 'lease.json'), JSON.stringify(ledger));
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\nimport {appendFileSync,readFileSync,writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2), p=${JSON.stringify(runFile)}; appendFileSync(${JSON.stringify(calls)},a.join(' ')+'\\n');\nif(a[1]==='get') console.log(readFileSync(p,'utf8')); else if(a[1]==='due') console.log(JSON.stringify({ok:true,runs:[]})); else if(a[1]==='cancel'){const r=JSON.parse(readFileSync(p,'utf8'));r.status='cancelled';r.metadata.execution_owner.pid=999999;for(const n of r.nodes)if(n.state==='running')n.state='cancelled';writeFileSync(p,JSON.stringify(r));console.log(JSON.stringify({ok:true}));} else console.log(JSON.stringify({ok:true}));\n`
  );
  chmodSync(bin, 0o755);
  expect(main(['supervise-tick'])).toBe(0);
  expect(readFileSync(calls, 'utf8')).not.toContain('workflow cancel engine --json');
  expect(loadLedger('lease').node_leases?.['code-core']).toMatchObject({ budget_s: 1200 });
  expect(waitRun(loadLedger('lease'), 1)).toMatchObject({ state: 'held:gate', exit: EXIT.held });
  expect(waitRun(loadLedger('lease'), 0)).toMatchObject({ state: 'running', timed_out: true });
  // prettier-ignore
  engineRun.nodes = [{ nodeId: 'start-m1', state: 'completed' }, { nodeId: 'code-core', state: 'running', startedAt: new Date(Date.now() - 22 * 60_000).toISOString() }];
  writeFileSync(runFile, JSON.stringify(engineRun));
  expect(main(['supervise-tick'])).toBe(0);
  expect(readFileSync(calls, 'utf8')).toContain('workflow cancel engine --json');
  const report = JSON.parse(readFileSync(join(artifacts, 'node-lease-code-core.json'), 'utf8'));
  expect(report).toMatchObject({ reason: 'budget_exceeded', extended: false });
  expect(report.next_action).toMatch(/^superagent recover lease --reconciled [0-9a-f]{64}$/);
  const cancelled = JSON.parse(readFileSync(runFile, 'utf8'));
  const db = new Database(join(archon, 'archon.db'));
  db.run(
    'create table remote_agent_workflow_runs (id text, status text, metadata text, started_at text)'
  );
  // prettier-ignore
  db.run('insert into remote_agent_workflow_runs values (?, ?, ?, ?)', ['engine', 'cancelled', JSON.stringify(cancelled.metadata), cancelled.started_at]);
  db.close();
  expect(main(report.next_action.split(' ').slice(1))).toBe(0);
  expect(readFileSync(calls, 'utf8')).toContain('workflow resume engine --detach --json');
});
