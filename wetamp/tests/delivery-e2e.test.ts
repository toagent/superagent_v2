import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../src/generate';
import { ledgerPath } from '../src/cli';
import * as coordination from '../src/coord';
import type { Plan } from '../src/plan';
import { fixtureEnv, fixturePlan, gitRepo, sh, tmp } from './helpers';

type WorkflowNode = {
  id: string;
  bash?: string;
  loop_group?: { nodes: WorkflowNode[] };
};

const allNodes = (nodes: WorkflowNode[]): WorkflowNode[] =>
  nodes.flatMap(node => [node, ...allNodes(node.loop_group?.nodes ?? [])]);

const runBash = (command: string, cwd: string, env: NodeJS.ProcessEnv) => {
  const result = Bun.spawnSync(['bash', '-c', command], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
};

const setup = (mode: 'normal' | 'advanced' | 'dirty' | 'conflict') => {
  const saved = { ...process.env };
  const root = tmp(),
    home = join(root, 'home'),
    repo = gitRepo(root),
    worker = join(root, 'worker'),
    runId = `de1e-${({ normal: '0001', advanced: '0002', dirty: '0003', conflict: '0004' } as const)[mode]}`;
  sh('git branch -m delivery-target && git config user.name t && git config user.email t@l', repo);
  const targetHead = sh('git rev-parse HEAD', repo).trim();
  sh(`git worktree add -qb sa/${runId} '${worker}' delivery-target`, repo);
  writeFileSync(join(worker, 'feature.txt'), 'integrated\n');
  sh('git add feature.txt && git commit -qm feature', worker);
  if (mode === 'conflict') {
    writeFileSync(join(repo, 'README.md'), 'target\n');
    sh('git add README.md && git commit -qm target-conflict', repo);
    writeFileSync(join(worker, 'README.md'), 'run\n');
    sh('git add README.md && git commit -qm run-conflict', worker);
  }
  Object.assign(process.env, {
    SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'),
    SUPERAGENT_MEMORY: 'off',
    SUPERAGENT_ROLE: '',
    WORKFLOW_ID: runId,
    NODE_ENV: 'test',
    SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const who = coordination.caller();
  const launcherPreload = join(root, 'launcher.cjs');
  writeFileSync(
    launcherPreload,
    `require(${JSON.stringify(join(import.meta.dir, '../hooks/live.cjs'))}).launcher = () => (${JSON.stringify(who)});\n`
  );
  process.env.BUN_OPTIONS = `${process.env.BUN_OPTIONS ?? ''} --preload=${launcherPreload}`.trim();
  mkdirSync(join(home, 'runs'), { recursive: true });
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
            scope: { write: ['feature.txt', 'README.md'] },
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
  coordination.coord().claim(coordination.repoScope(repo), who);
  coordination.coord().claim(coordination.runScope({ run_id: runId, repo }), who);
  const engine = spyOn(coordination, 'cleanEngine').mockReturnValue(targetHead);
  const identity = spyOn(coordination, 'caller').mockReturnValue(who);
  let generated: ReturnType<typeof generate>;
  try {
    generated = generate(plan, runId, false, undefined, undefined, delivery);
  } finally {
    identity.mockRestore();
    engine.mockRestore();
  }
  writeFileSync(
    ledgerPath(runId),
    JSON.stringify({
      run_id: runId,
      archon_run_id: runId,
      repo,
      branch: `sa/${runId}`,
      plan: join(generated.dir, 'plan.json'),
      gen_dir: generated.dir,
      workflow: generated.workflow,
      delivery,
    })
  );
  const artifact = join(home, 'artifacts', 'runs', runId);
  mkdirSync(artifact, { recursive: true });
  const workflow = Bun.YAML.parse(
    readFileSync(
      join(generated.dir, '.archon/workflows', generated.workflow, `${generated.workflow}.yaml`),
      'utf8'
    )
  ) as { nodes: WorkflowNode[] };
  return { saved, repo, worker, runId, artifact, nodes: allNodes(workflow.nodes) };
};

const restoreEnv = (saved: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
};

test.each(['normal', 'advanced', 'dirty', 'conflict'] as const)(
  'generated sync/final-accept/publish handles %s target state',
  mode => {
    const f = setup(mode);
    try {
      const sync = f.nodes.find(node => node.id === 'sync-m1')!;
      const publish = f.nodes.find(node => node.id === 'publish-m1')!;
      const env = fixtureEnv({
        SUPERAGENT_HOME: process.env.SUPERAGENT_HOME!,
        ARCHON_HOME: process.env.ARCHON_HOME!,
        WORKFLOW_ID: f.runId,
        ARTIFACTS_DIR: f.artifact,
        NODE_ENV: 'test',
        SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
      });
      let synced = runBash(sync.bash!, f.worker, env);
      if (mode === 'conflict') {
        expect(synced.status).toBe('conflict');
        const tip = String(synced.target_tip);
        const merge = Bun.spawnSync(['git', 'merge', '--no-edit', tip], {
          cwd: f.worker,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(merge.exitCode).not.toBe(0);
        writeFileSync(join(f.worker, 'README.md'), 'resolved\n');
        sh('git add README.md && git commit -qm resolved', f.worker);
        synced = {
          ...synced,
          status: 'resolved',
          merge_base: tip,
          head: sh('git rev-parse HEAD', f.worker).trim(),
        };
      }
      const writeGate = (): void => {
        const head = sh('git rev-parse HEAD', f.worker).trim();
        writeFileSync(
          join(f.artifact, 'gate-m1-r1.json'),
          JSON.stringify({ verdict: 'pass', reviewed_head: head, reviewed_diff_hash: 'accepted' })
        );
        writeFileSync(
          join(f.artifact, 'diff-m1-r1.json'),
          JSON.stringify({ diff_hash: 'accepted' })
        );
      };
      writeGate();
      const publishAt = (tip: string) =>
        runBash(publish.bash!.replace('$resync-m1-ready.output.target_tip', tip), f.worker, env);
      if (mode === 'advanced') {
        writeFileSync(join(f.repo, 'advanced.txt'), 'advanced\n');
        sh('git add advanced.txt && git commit -qm advanced', f.repo);
        expect(publishAt(String(synced.target_tip)).status).toBe('advanced');
        synced = runBash(sync.bash!, f.worker, env);
        writeGate();
      }
      if (mode === 'dirty') {
        const dirty = join(f.repo, 'dirty.txt');
        writeFileSync(dirty, 'dirty\n');
        expect(publishAt(String(synced.target_tip)).status).toBe('dirty');
        unlinkSync(dirty);
      }
      expect(publishAt(String(synced.target_tip)).status).toBe('published');
      const head = sh('git rev-parse HEAD', f.worker).trim();
      expect(sh('git rev-parse delivery-target', f.repo).trim()).toBe(head);
      expect(sh(`git diff --name-only ${String(synced.target_tip)} HEAD`, f.worker)).not.toContain(
        'advanced.txt'
      );
    } finally {
      restoreEnv(f.saved);
    }
  },
  30_000
);

test('land.ts without INPUTS_ACTION keeps the legacy delivery entrypoint', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/land.ts')], {
    env: fixtureEnv({ INPUTS_ACTION: '', INPUTS_RUN: '' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('delivery: missing run id');
});
