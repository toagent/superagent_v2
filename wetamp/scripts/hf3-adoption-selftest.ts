// Invoked only from selftest --fake, inside its scratch installation/home/repository.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archonJson, getRun, type RunView } from '../src/archon';
import { main, loadLedger, ledgerPath, type Ledger } from '../src/cli';
import { WETAMP, home, writeAtomic } from '../src/config';
import { caller, coord, repoScope } from '../src/coord';
import { generate } from '../src/generate';
import type { Plan } from '../src/plan';

const [repo, timeout] = process.argv.slice(2);
assert(repo && timeout, 'scratch repo and timeout required');
// Commit the disposable toolkit so retry sees a real engine change.
const toolkit = dirname(WETAMP);
const engineGit = (...args: string[]): string => {
  const p = Bun.spawnSync(['git', '-C', toolkit, ...args], { stdout: 'pipe', stderr: 'pipe' });
  assert.equal(p.exitCode, 0, p.stderr.toString());
  return p.stdout.toString().trim();
};
engineGit('init', '-q', '-b', 'fixture');
writeFileSync(join(toolkit, '.gitignore'), 'node_modules\npackages\n');
engineGit('add', '--', '.gitignore', 'wetamp');
engineGit(
  '-c',
  'user.name=sa',
  '-c',
  'user.email=sa@localhost',
  'commit',
  '-qm',
  'scratch toolkit'
);
const runId = 'selftest-hf3';
const ready = join(home().sa, 'hf3-ready');
const plan = JSON.parse(
  readFileSync(join(WETAMP, 'tests/fixtures/plan-two-pkgs.json'), 'utf8')
) as Plan;
plan.repo = repo;
plan.packages = [plan.packages[0]];
plan.packages[0].accept = [{ cmd: `test -f '${ready}'`, timeout_s: 10 }];
const gen = generate(plan, runId, true);
const c = coord(),
  scope = repoScope(repo),
  who = caller(),
  { controller } = c.claim(scope, who);
const ack = c.mutate(scope, who, () =>
  archonJson(
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
  )
);
assert.equal(ack.ok, true);
assert.equal(typeof ack.runId, 'string');
const current = String(ack.runId);
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
  controller,
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
try {
  const failed = await awaitTerminal();
  assert.equal(failed.status, 'failed');
  assert(failed.nodes?.some(n => n.nodeId === 'settle-core' && n.state === 'failed'));
  assert(failed.nodes?.some(n => n.nodeId === 'code-core' && n.state === 'completed'));
  console.error(`HF3 1/3 run=${current} status=failed node=settle-core code=completed`);
  appendFileSync(
    join(WETAMP, 'templates/.archon/scripts/sa-check.ts'),
    '\n// HF3 scratch engine change\n'
  );
  engineGit('add', '--', 'wetamp/templates/.archon/scripts/sa-check.ts');
  engineGit(
    '-c',
    'user.name=sa',
    '-c',
    'user.email=sa@localhost',
    'commit',
    '-qm',
    'scratch engine change'
  );
  console.error(`HF3 2/3 engine=${engineGit('rev-parse', 'HEAD')} changed=true`);
  // A changed engine adopts the run; settle-core never advanced, so no package is carried.
  assert.equal(main(['decide', runId, 'retry']), 0);
  const next = loadLedger(runId);
  assert.notEqual(next.archon_run_id, current);
  assert.equal(next.adoptions?.length, 1);
  assert.equal(next.adoptions[0].from, current);
  assert.deepEqual(next.adoptions[0].carried, []);
  console.error(`HF3 3/3 retry=adopted run=${next.archon_run_id} from=${current} carried=none`);
} finally {
  // Every run here belongs to this selftest. Abandon only a nonterminal owned run.
  for (const id of new Set([current, loadLedger(runId).archon_run_id])) {
    const run = getRun(id, repo);
    if (!['failed', 'cancelled', 'completed'].includes(run.status))
      c.mutate(c.scope(runId), who, () =>
        archonJson(['workflow', run.status === 'running' ? 'cancel' : 'abandon', id], repo)
      );
  }
}
