import { expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../src/generate';
import { ledgerPath, loadLedger } from '../src/cli';
import * as coordination from '../src/coord';
import type { Plan } from '../src/plan';
import { parseWholeOutputRef } from '../../packages/workflows/src/output-ref';
import { directAuxiliaryPreload, fixtureEnv, fixturePlan, gitRepo, sh, tmp } from './helpers';
test.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'generated deliver command integrates the run branch into its target (prefix=%s, conflict=%s)',
  (prefix, conflict) => {
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
        BUN_OPTIONS:
          `${process.env.BUN_OPTIONS ?? ''} --preload=${directAuxiliaryPreload()}`.trim(),
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
      if (prefix) {
        plan.packages[0].milestone = 'm1';
        plan.packages.push({
          ...plan.packages[0],
          id: 'later',
          milestone: 'm2',
          accept: [{ cmd: 'exit 1', timeout_s: 5 }],
        });
      }
      const landNode = prefix ? 'land-m1' : 'land',
        deliverNode = prefix ? 'deliver-m1' : 'deliver';
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
        join(art, `${landNode}.json`),
        JSON.stringify({
          branch: ledger.branch,
          head: sourceHead,
          ...(prefix ? { milestone: 'm1' } : {}),
        })
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
            { nodeId: landNode, state: 'completed' },
            { nodeId: deliverNode, state: 'running' },
          ],
          events: [...producers].map(step_name => ({
            step_name,
            event_type: 'node_completed',
            data: { node_output: JSON.stringify(output), structured_output: output },
          })),
        })
      );
      const workflow = Bun.YAML.parse(
        readFileSync(
          join(gen.dir, '.archon/workflows', gen.workflow, `${gen.workflow}.yaml`),
          'utf8'
        )
      ) as { nodes: { id: string; bash?: string; with?: Record<string, string> }[] };
      if (prefix) {
        const inputs = workflow.nodes.find(n => n.id === landNode)!.with!;
        const produced = Bun.spawnSync(
          [process.execPath, join(gen.dir, '.archon/scripts/sa-check.ts')],
          {
            cwd: worker,
            env: {
              ...fixtureEnv(),
              ARTIFACTS_DIR: art,
              ...Object.fromEntries(
                Object.entries(inputs).map(([k, v]) => [`INPUTS_${k.toUpperCase()}`, v])
              ),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        expect(produced.exitCode, produced.stderr.toString()).toBe(0);
        const evidence = JSON.parse(readFileSync(join(art, `${landNode}.json`), 'utf8'));
        expect(evidence).toMatchObject({ head: sourceHead, milestone: 'm1', packages: ['p'] });
        expect(evidence.commands[1]).toContain(sourceHead);
      }
      if (conflict) {
        writeFileSync(join(repo, 'feature.txt'), 'target\n');
        sh('git add feature.txt && git commit -qm target-feature', repo);
      }
      const command = workflow.nodes.find(node => node.id === deliverNode)?.bash!;
      const result = Bun.spawnSync(['bash', '-c', command], {
        cwd: repo,
        env: fixtureEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      });
      const outputText = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, outputText).toBe(0);
      if (conflict) {
        // 非末里程碑冲突只推迟：节点成功、后续里程碑可启动，目标分支不动，下次交付补验收它。
        const deferred = loadLedger(runId);
        expect(JSON.parse(result.stdout.toString())).toEqual({
          status: 'deferred',
          reason: 'merge_conflicts',
          milestone: 'm1',
        });
        expect(deferred.deferred_deliveries).toEqual(['m1']);
        expect(deferred.delivery_result).toBeUndefined();
        expect(sh('git log -1 --format=%s delivery-target', repo).trim()).toBe('target-feature');
        expect(sh('git status --porcelain', repo)).toBe('');
        return;
      }
      expect(sh(`git merge-base --is-ancestor ${sourceHead} delivery-target`, repo)).toBe('');
      expect(loadLedger(runId).delivery_result).toMatchObject({
        status: 'integrated',
        source: sourceHead,
      });
      if (prefix) {
        writeFileSync(join(worker, 'later.txt'), 'unaccepted');
        sh('git add later.txt && git commit -qm later', worker);
        const stateFile = join(stub, 'get-000.json');
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        state.status = 'failed';
        state.nodes[1].state = 'completed';
        state.nodes.push(
          { nodeId: 'code-later', state: 'failed' },
          { nodeId: 'land-m2', state: 'skipped' }
        );
        writeFileSync(stateFile, JSON.stringify(state));
        const retried = Bun.spawnSync(['bash', '-c', command], {
          cwd: repo,
          env: fixtureEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 15000,
        });
        expect(retried.exitCode, retried.stderr.toString()).toBe(0);
        expect(sh('git rev-parse HEAD', repo).trim()).toBe(sourceHead);
        expect(loadLedger(runId).delivery_result).toMatchObject({
          status: 'integrated',
          source: sourceHead,
        });
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
  30_000
);
