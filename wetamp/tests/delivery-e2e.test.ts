import { expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../src/generate';
import { ledgerPath, loadLedger } from '../src/cli';
import * as coordination from '../src/coord';
import type { Plan } from '../src/plan';
import { parseWholeOutputRef } from '../../packages/workflows/src/output-ref';
import { directAuxiliaryPreload, fixtureEnv, fixturePlan, gitRepo, sh, tmp } from './helpers';
test('generated deliver command integrates the run branch into its target', () => {
  const saved = { ...process.env };
  const root = tmp(),
    home = join(root, 'home'),
    repo = gitRepo(root),
    worker = join(root, 'worker'),
    runId = 'de1e-e2e';
  try {
    sh(
      'git branch -m delivery-target && git config user.name t && git config user.email t@l',
      repo
    );
    const targetHead = sh('git rev-parse HEAD', repo).trim();
    sh(`git worktree add -qb sa/${runId} '${worker}' delivery-target`, repo);
    writeFileSync(join(worker, 'feature.txt'), 'integrated\n');
    sh('git add feature.txt && git commit -qm feature', worker);
    const sourceHead = sh('git rev-parse HEAD', worker).trim();
    mkdirSync(join(home, 'runs'), { recursive: true });
    const stub = join(root, 'archon-stub');
    mkdirSync(stub);
    const bin = join(stub, 'archon');
    writeFileSync(
      bin,
      `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fixtures/archon-stub.ts')}' '${stub}' "$@"\n`
    );
    chmodSync(bin, 0o755);
    Object.assign(process.env, {
      SUPERAGENT_HOME: home,
      ARCHON_HOME: join(home, 'archon'),
      SUPERAGENT_MEMORY: 'off',
      SUPERAGENT_ROLE: '',
      SA_ARCHON_BIN: bin,
      WORKFLOW_ID: runId,
      NODE_ENV: 'test',
      SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${directAuxiliaryPreload()}`.trim(),
    });
    const plan = JSON.parse(
      readFileSync(
        fixturePlan(root, repo, p => {
          p.base_ref = 'delivery-target';
          p.environment = [];
          p.packages = [
            {
              id: 'p',
              title: 'Delivery E2E',
              goal: 'Integrate feature.txt.',
              scope: { write: ['feature.txt'] },
              accept: [{ cmd: 'test "$(cat feature.txt)" = integrated', timeout_s: 5 }],
              risk: 'G0',
              size: 'S',
            },
          ];
        }),
        'utf8'
      )
    ) as Plan;
    const delivery = { checkout: repo, branch: 'delivery-target', head: targetHead };
    const who = coordination.caller();
    coordination.coord().claim(coordination.repoScope(repo), who);
    coordination.coord().claim(coordination.runScope({ run_id: runId, repo }), who);
    const engine = spyOn(coordination, 'cleanEngine').mockReturnValue(targetHead);
    let gen: ReturnType<typeof generate>;
    try {
      gen = generate(plan, runId, false, undefined, undefined, delivery);
    } finally {
      engine.mockRestore();
    }
    const ledger = {
      run_id: runId,
      archon_run_id: runId,
      repo,
      branch: `sa/${runId}`,
      plan: join(gen.dir, 'plan.json'),
      gen_dir: gen.dir,
      workflow: gen.workflow,
      delivery,
    };
    writeFileSync(ledgerPath(runId), JSON.stringify(ledger));
    const art = join(home, 'artifacts', 'runs', runId);
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(art, 'land.json'),
      JSON.stringify({ branch: ledger.branch, head: sourceHead })
    );
    const contracts = JSON.parse(
      readFileSync(join(gen.dir, 'accept-inputs.json'), 'utf8')
    ) as Record<string, string>[];
    const contract = contracts.find(c => c.tag === 'diff-m1-r1')!;
    writeFileSync(join(art, `${contract.tag}.json`), JSON.stringify({ ok: true }));
    // prettier-ignore
    const output = { head: sourceHead, reviewed_head: sourceHead, status: 'done', error_class: null, needs: [] };
    const producers = new Set(
      Object.values(contract)
        .map(value => parseWholeOutputRef(value)?.nodeId)
        .filter(Boolean)
    );
    writeFileSync(
      join(stub, 'get-000.json'),
      JSON.stringify({
        id: runId,
        status: 'running',
        working_path: worker,
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
      })
    );
    const workflow = Bun.YAML.parse(
      readFileSync(join(gen.dir, '.archon/workflows', gen.workflow, `${gen.workflow}.yaml`), 'utf8')
    ) as { nodes: { id: string; bash?: string }[] };
    const command = workflow.nodes.find(node => node.id === 'deliver')?.bash!;
    const result = Bun.spawnSync(['bash', '-c', command], {
      cwd: repo,
      env: fixtureEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const outputText = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, outputText).toBe(0);
    expect(sh(`git merge-base --is-ancestor ${sourceHead} delivery-target`, repo)).toBe('');
    expect(loadLedger(runId).delivery_result).toMatchObject({
      status: 'integrated',
      source: sourceHead,
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}, 30_000);
