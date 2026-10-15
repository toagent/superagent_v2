import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryReceipt, LocalDelivery } from '../src/land';
import { directAuxiliaryPreload, fixturePlan, tmp } from './helpers';
import * as archon from '../src/archon';
import { finalizeDelivery } from '../src/land';
import { ledgerPath, loadLedger, type Ledger } from '../src/cli';
import * as coordination from '../src/coord';
import { generate } from '../src/generate';
import type { Plan } from '../src/plan';
import { parseWholeOutputRef } from '../../packages/workflows/src/output-ref';

// Git, receipts, acceptance and leases are real; finalizeDelivery stubs engine queries
// and checkout inspection. Fault injection uses fresh processes; tmp() owns SIGKILL residue.
function fixture() {
  const root = tmp();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: root,
    NODE_ENV: 'test',
    SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
  };
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
    });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    return p.stdout.toString().trim();
  };
  git(repo, 'init', '-q', '-b', 'delivery-target');
  git(repo, 'config', 'user.name', 'Delivery test');
  git(repo, 'config', 'user.email', 'delivery@example.invalid');
  git(repo, 'commit', '--allow-empty', '-qm', 'seed');
  const worker = join(root, 'worker');
  git(repo, 'worktree', 'add', '-qb', 'sa/fault', worker);
  writeFileSync(join(worker, 'feature.txt'), 'feature\n');
  git(worker, 'add', 'feature.txt');
  git(worker, 'commit', '-qm', 'feature');
  const source = git(worker, 'rev-parse', 'HEAD');
  // Force a genuine merge commit so counting merges proves more than a no-op FF.
  writeFileSync(join(repo, 'target.txt'), 'target\n');
  git(repo, 'add', 'target.txt');
  git(repo, 'commit', '-qm', 'target advancement');
  const original = git(repo, 'rev-parse', 'HEAD');
  const art = join(root, 'art');
  mkdirSync(art);
  const delivery: LocalDelivery = {
    task: 'fault',
    target: { checkout: repo, branch: 'delivery-target', head: original },
    contract: 'fault-contract',
    title: 'Fault delivery',
    evidence: art,
    receipt: join(art, 'delivery.json'),
  };
  const marker = join(root, 'killed.json');
  const checks = join(root, 'acceptance.jsonl');
  const script = join(root, 'deliver.ts');
  writeFileSync(
    script,
    `
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { applyLand, integratedReceipt } from ${JSON.stringify(join(import.meta.dir, '../src/land.ts'))};
const delivery = ${JSON.stringify(delivery)};
const spawn = Bun.spawnSync;
// Wrap only the actual target update, not candidate creation or reconciliation.
// SIGKILL prevents finally blocks from releasing leases or writing receipts.
Bun.spawnSync = (args, options) => {
  const update = Array.isArray(args) && args[0] === 'git' &&
    args[1] === '-C' && args[2] === delivery.target.checkout &&
    args[3] === 'merge' && args[4] === '--ff-only';
  const kill = () => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, phase: process.argv[2] }));
    process.kill(process.pid, 'SIGKILL');
  };
  if (update && process.argv[2] === 'before') kill();
  const result = spawn(args, options);
  if (update && result.exitCode === 0 && process.argv[2] === 'after') kill();
  return result;
};
const receipt = applyLand(
  { id: 'fault', status: 'running', working_path: ${JSON.stringify(worker)}, nodes: [
    { nodeId: 'land', state: 'completed' }, { nodeId: 'deliver', state: 'running' }
  ] },
  { branch: 'sa/fault', head: ${JSON.stringify(source)} },
  cwd => {
    const head = spawn(['git', '-C', cwd, 'rev-parse', 'HEAD'], { stdout: 'pipe' });
    if (head.exitCode !== 0 || readFileSync(cwd + '/feature.txt', 'utf8') !== 'feature\\n' ||
        readFileSync(cwd + '/target.txt', 'utf8') !== 'target\\n') return 1;
    appendFileSync(${JSON.stringify(checks)}, JSON.stringify({ head: head.stdout.toString().trim() }) + '\\n');
    return 0;
  },
  { repo: delivery.target.checkout, base_ref: 'delivery-target', delivery }
);
if (!integratedReceipt(receipt, ${JSON.stringify(source)}, delivery)) throw new Error('unreconciled receipt');
console.log(JSON.stringify(receipt));
`
  );
  const execute = (phase = 'recover') =>
    Bun.spawnSync([process.execPath, script, phase], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    });
  const recover = () => {
    const p = execute();
    expect(p.exitedDueToTimeout).toBe(false);
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    const receipt = JSON.parse(readFileSync(delivery.receipt, 'utf8')) as DeliveryReceipt;
    expect(JSON.parse(p.stdout.toString())).toEqual(receipt);
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(receipt).toMatchObject({
      status: 'manual_push',
      integrated: head,
      accepted: head,
      source,
    });
    expect(git(repo, 'rev-list', '--merges', `${original}..HEAD`)).toBe(head);
    expect(git(repo, 'rev-list', '--count', `${original}..HEAD`)).toBe('2');
    expect(git(repo, 'show', '-s', '--format=%P', 'HEAD')).toBe(`${original} ${source}`);
    git(repo, 'merge-base', '--is-ancestor', source, 'HEAD');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    return receipt;
  };
  const acceptance = () =>
    readFileSync(checks, 'utf8')
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { head: string }).head);
  return {
    root,
    worker,
    source,
    env,
    repo,
    git,
    original,
    marker,
    delivery,
    execute,
    recover,
    acceptance,
  };
}

test('DURABLE_DELIVERY finalizeDelivery persists integrated ledger and repeats without another integration', () => {
  const f = fixture();
  const saved = { ...process.env };
  const home = join(f.root, 'home');
  mkdirSync(join(home, 'runs'), { recursive: true });
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'),
    SUPERAGENT_MEMORY: 'off',
    BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${directAuxiliaryPreload()}`,
  });
  let transport: ReturnType<typeof spyOn<typeof archon, 'archon'>> | undefined;
  try {
    const checks = join(f.root, 'finalize-checks');
    const plan = JSON.parse(
      readFileSync(
        fixturePlan(f.root, f.repo, p => {
          p.base_ref = f.original;
          p.environment = [];
          p.packages = [
            {
              id: 'p',
              title: 'Finalize delivery',
              risk: 'G1',
              size: 'S',
              scope: { write: ['feature.txt'] },
              accept: [
                {
                  cmd: `test "$(cat feature.txt)" = feature && test "$(cat target.txt)" = target && git rev-parse HEAD >> '${checks}'`,
                  timeout_s: 5,
                },
              ],
            },
          ];
        }),
        'utf8'
      )
    ) as Plan;
    // Generation's engine checkout guard is covered separately; this test runs before commit.
    const engine = spyOn(coordination, 'cleanEngine').mockReturnValue(f.original);
    let gen: ReturnType<typeof generate>;
    try {
      gen = generate(plan, 'fault', true);
    } finally {
      engine.mockRestore();
    }
    const ledger: Ledger = {
      run_id: 'fault',
      archon_run_id: 'fault',
      repo: f.repo,
      branch: 'sa/fault',
      plan: join(gen.dir, 'plan.json'),
      gen_dir: gen.dir,
      workflow: 'sa-fault',
      console: 'codex',
      started_at: '',
      transcript: '',
      log: '',
      delivery: f.delivery.target,
    };
    const who = coordination.caller();
    ledger.controller = coordination.coord().claim(coordination.repoScope(f.repo), who).controller;
    const authorization = {
      repo: ledger.controller,
      run: coordination.coord().claim(coordination.runScope(ledger), who).controller,
    };
    process.env.WORKFLOW_ID = ledger.archon_run_id;
    writeFileSync(ledgerPath('fault'), JSON.stringify(ledger));
    const art = join(home, 'artifacts/runs/fault');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'land.json'), JSON.stringify({ branch: 'sa/fault', head: f.source }));
    const contracts = JSON.parse(
      readFileSync(join(gen.dir, 'accept-inputs.json'), 'utf8')
    ) as Record<string, string>[];
    const contract = contracts.find(c => c.tag === 'diff-m1-r1')!;
    // Prior gate evidence selects the contract; acceptance still runs on the real merge candidate.
    writeFileSync(join(art, `${contract.tag}.json`), JSON.stringify({ ok: true }));
    const output = {
      head: f.source,
      reviewed_head: f.source,
      status: 'done',
      error_class: null,
      needs: [],
    };
    const producers = new Set(
      Object.values(contract)
        .map(v => parseWholeOutputRef(v)?.nodeId)
        .filter(Boolean)
    );
    const run = {
      id: 'fault',
      status: 'running',
      working_path: f.worker,
      output_root: home,
      nodes: [
        { nodeId: 'land', state: 'completed' },
        { nodeId: 'deliver', state: 'running' },
      ],
      events: [...producers].map(step_name => ({
        step_name,
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(output), structured_output: output },
      })),
    };
    // Only the external engine query is a fixture; acceptance, Git, leases and ledger writes are real.
    transport = spyOn(archon, 'archon').mockImplementation(args => {
      expect(args.slice(0, 3)).toEqual(['workflow', 'get', 'fault']);
      return { code: 0, out: JSON.stringify(run), err: '' };
    });
    expect(loadLedger('fault').delivery_result).toBeUndefined();
    const receipt = finalizeDelivery('fault', false, who, authorization);
    if (receipt?.status !== 'manual_push') throw new Error('delivery did not integrate');
    const head = f.git(f.repo, 'rev-parse', 'HEAD');
    expect(receipt).toMatchObject({
      status: 'manual_push',
      integrated: head,
      accepted: head,
      source: f.source,
    });
    expect(loadLedger('fault').delivery_result).toEqual({ ...receipt, status: 'integrated' });
    expect(readFileSync(checks, 'utf8').trim()).toBe(head);
    expect(finalizeDelivery('fault', false, who, authorization)).toEqual(receipt);
    expect(loadLedger('fault').delivery_result).toEqual({ ...receipt, status: 'integrated' });
    expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(f.git(f.repo, 'rev-list', '--merges', `${f.original}..HEAD`)).toBe(head);
    expect(f.git(f.repo, 'rev-list', '--count', `${f.original}..HEAD`)).toBe('2');
    expect(readFileSync(checks, 'utf8').trim()).toBe(head);
    expect(f.git(f.repo, 'status', '--porcelain')).toBe('');
  } finally {
    transport?.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 15000);

test.each(['before', 'after'])(
  'DURABLE_DELIVERY SIGKILL %s target update recovers exactly once',
  phase => {
    const f = fixture();
    const killed = f.execute(phase);
    expect(killed.exitedDueToTimeout).toBe(false);
    expect(killed.signalCode).toBe('SIGKILL');
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({ phase });
    expect(existsSync(f.delivery.receipt)).toBe(false);
    const interrupted = f.git(f.repo, 'rev-parse', 'HEAD');
    if (phase === 'before') expect(interrupted).toBe(f.original);
    else {
      expect(interrupted).not.toBe(f.original);
      expect(f.git(f.repo, 'rev-list', '--merges', `${f.original}..HEAD`)).toBe(interrupted);
    }
    const receipt = f.recover();
    if (phase === 'after') {
      expect(receipt.integrated).toBe(interrupted);
      expect(receipt.target_tip).toBe(interrupted);
    } else expect(receipt.target_tip).toBe(f.original);
    expect(f.acceptance()).toHaveLength(2);
    expect(f.acceptance().at(-1)).toBe(receipt.integrated);
    expect(f.recover()).toEqual(receipt);
    expect(f.acceptance()).toHaveLength(2);
  },
  15000
);

test.each(['missing', 'corrupt'])(
  'DURABLE_DELIVERY %s receipt reconciles history without another integration',
  kind => {
    const f = fixture();
    const first = f.recover();
    if (kind === 'missing') unlinkSync(f.delivery.receipt);
    else writeFileSync(f.delivery.receipt, '{broken');
    const recovered = f.recover();
    expect(recovered.integrated).toBe(first.integrated);
    expect(recovered.target_tip).toBe(first.integrated);
    expect(f.acceptance()).toEqual([first.integrated, first.integrated]);
    expect(f.recover()).toEqual(recovered);
    expect(f.acceptance()).toHaveLength(2);
  },
  15000
);
