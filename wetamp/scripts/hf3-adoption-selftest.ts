// Invoked only from selftest --fake, inside its scratch installation/home/repository.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonJson, getRun, type RunView } from '../src/archon';
import { main, loadLedger, ledgerPath, type Ledger } from '../src/cli';
import { WETAMP, home, writeAtomic } from '../src/config';
import { generate } from '../src/generate';
import type { Plan } from '../src/plan';
import {
  capturedSourceRoots,
  loadWorkflowSource,
} from '../../packages/workflows/src/workflow-source';
import { workflowSourceMetadataSchema } from '../../packages/workflows/src/schemas/workflow-run';

const [repo, timeout] = process.argv.slice(2);
assert(repo && timeout, 'scratch repo and timeout required');
const runId = 'selftest-hf3';
const ready = join(home().sa, 'hf3-ready');
const plan = JSON.parse(
  readFileSync(join(WETAMP, 'tests/fixtures/plan-two-pkgs.json'), 'utf8')
) as Plan;
plan.repo = repo;
plan.packages = [plan.packages[0]];
plan.packages[0].accept = [{ cmd: `test -f '${ready}'`, timeout_s: 10 }];
const gen = generate(plan, runId, true);
const ack = archonJson(
  [
    'workflow',
    'run',
    gen.workflow,
    '--workflow-source',
    gen.dir,
    '--cwd',
    repo,
    '--branch',
    `sa/${runId}`,
    '--from',
    'main',
    '--detach',
    '--config',
    gen.config,
  ],
  repo
);
assert.equal(ack.ok, true);
assert.equal(typeof ack.runId, 'string');
let current = String(ack.runId);
const ledger: Ledger = {
  run_id: runId,
  archon_run_id: current,
  engine_hash: gen.engine_hash,
  plan: join(gen.dir, 'plan.json'),
  gen_dir: gen.dir,
  repo,
  branch: `sa/${runId}`,
  workflow: gen.workflow,
  console: 'claude',
  started_at: new Date().toISOString(),
  transcript: String(ack.transcriptPath),
  log: String(ack.logPath),
  recoveries: [],
};
writeAtomic(ledgerPath(runId), JSON.stringify(ledger));
const awaitTerminal = async (): Promise<RunView> => {
  for (const deadline = Date.now() + Number(timeout) * 1000; Date.now() < deadline; ) {
    const run = getRun(current, repo);
    if (['failed', 'cancelled', 'completed', 'paused'].includes(run.status)) return run;
    await Bun.sleep(500);
  }
  throw new Error(`HF3 timed out: ${current}`);
};
const git = (...args: string[]): string => {
  const p = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(p.exitCode, 0, p.stderr.toString());
  return p.stdout.toString().trim();
};
try {
  const failed = await awaitTerminal();
  assert.equal(failed.status, 'failed');
  assert(failed.nodes?.some(n => n.nodeId === 'settle-core' && n.state === 'failed'));
  assert(failed.working_path);
  const oldHead = git('-C', failed.working_path, 'rev-parse', 'HEAD');
  console.error(`HF3 1/5 old=${current} status=failed node=settle-core head=${oldHead}`);
  const marker = '// HF3 scratch template adoption proof';
  appendFileSync(join(WETAMP, 'templates/.archon/scripts/sa-check.ts'), `\n${marker}\n`);
  writeFileSync(ready, 'ready');
  assert.equal(main(['decide', runId, 'retry']), 0);
  const next = loadLedger(runId);
  assert.notEqual(next.archon_run_id, current);
  assert.equal(next.adoptions?.at(-1)?.from, current);
  current = next.archon_run_id;
  console.error(`HF3 2/5 new=${current} adoption=${String(next.adoptions.at(-1)?.reason)}`);
  const finished = await awaitTerminal();
  const metadata = archonJson(['workflow', 'get', current, '--verbose'], repo).metadata;
  assert(metadata && typeof metadata === 'object' && 'workflow_source' in metadata);
  const record = workflowSourceMetadataSchema.parse(metadata.workflow_source);
  const capture = await loadWorkflowSource(record.root, record.digest, record.source_config);
  const source = capturedSourceRoots(capture.anchor);
  assert(source.project);
  const snapshot = join(source.project, '.archon/scripts/sa-check.ts');
  assert(readFileSync(snapshot, 'utf8').includes(marker));
  console.error(`HF3 3/5 snapshot=${snapshot} marker=true`);
  assert.equal(finished.working_path, failed.working_path);
  git('-C', failed.working_path, 'merge-base', '--is-ancestor', oldHead, 'HEAD');
  console.error('HF3 4/5 worktree=same old_commit=preserved');
  assert.equal(finished.status, 'completed');
  console.error(`HF3 5/5 status=${finished.status} engine=current`);
} finally {
  // Every run here belongs to this selftest. Abandon only a nonterminal owned run.
  const run = getRun(current, repo);
  if (!['failed', 'cancelled', 'completed'].includes(run.status))
    archonJson(['workflow', run.status === 'running' ? 'cancel' : 'abandon', current], repo);
}
