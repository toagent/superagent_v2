import { expect, spyOn, test } from 'bun:test';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore, WorkflowEventInput } from '@archon/workflows/store';
import { executeTestDagWorkflow, makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../src/generate';
import { ledgerPath } from '../src/cli';
import { diffHash } from '../templates/.archon/scripts/sa-check';
import * as coordination from '../src/coord';
import type { Plan } from '../src/plan';
import { fixtureEnv, fixturePlan, gitRepo, sh, tmp } from './helpers';

type WorkflowNode = {
  id: string;
  bash?: string;
  script?: string;
  runtime?: string;
  depends_on?: string[];
  when?: string;
  with?: Record<string, unknown>;
  output_format?: unknown;
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
            risk: 'G2',
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
  return {
    saved,
    repo,
    worker,
    runId,
    artifact,
    authorization: join(generated.dir, 'delivery-authorization.json'),
    workflow,
    nodes: allNodes(workflow.nodes),
  };
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
      const sync = f.nodes.find(node => node.id === 'resync-m1')!;
      const publish = f.nodes.find(node => node.id === 'publish-m1')!;
      expect(sync.bash).toContain('INPUTS_OUTPUT=resync-m1');
      const env = fixtureEnv({
        SUPERAGENT_HOME: process.env.SUPERAGENT_HOME!,
        ARCHON_HOME: process.env.ARCHON_HOME!,
        WORKFLOW_ID: f.runId,
        ARTIFACTS_DIR: f.artifact,
        NODE_ENV: 'test',
        SUPERAGENT_ROLE: 'worker',
        SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
      });
      if (mode === 'conflict') {
        const failed = Bun.spawnSync(['bash', '-c', sync.bash!], {
          cwd: f.worker,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(failed.exitCode).toBe(1);
        expect(JSON.parse(failed.stdout.toString()).status).toBe('conflict');
        expect(readFileSync(join(f.artifact, 'sync-m1-1.json'), 'utf8')).toContain(
          '"status": "conflict"'
        );
        expect(readFileSync(join(f.artifact, 'resync-m1.json'), 'utf8')).toContain(
          '"status": "conflict"'
        );
        return;
      }
      let synced = runBash(sync.bash!, f.worker, env);
      expect(readFileSync(join(f.artifact, 'resync-m1.json'), 'utf8')).toContain('"generation": 1');
      const writeGate = (base: string): string => {
        const head = sh('git rev-parse HEAD', f.worker).trim();
        const patch = Bun.spawnSync(
          [
            'git',
            '-C',
            f.worker,
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--binary',
            base,
            'HEAD',
            '--',
          ],
          { stdout: 'pipe' }
        ).stdout;
        const serialized = JSON.stringify({
          verdict: 'pass',
          reviewed_head: head,
          reviewed_diff_hash: diffHash(patch),
        });
        writeFileSync(join(f.artifact, 'gate-m1-r1.json'), serialized);
        return createHash('sha256').update(serialized).digest('hex');
      };
      let gateSha256 = writeGate(String(synced.target_tip));
      const publishCommand = (tip: string) =>
        `INPUTS_GATE_R1_SHA256=${gateSha256} INPUTS_TARGET_TIP=${tip} INPUTS_REVIEW_REQUIRED=1 bun -e '${publish.script!.replaceAll("'", "'\\''")}'`;
      const publishAt = (tip: string) => runBash(publishCommand(tip), f.worker, env);
      if (mode === 'advanced') {
        writeFileSync(join(f.repo, 'advanced.txt'), 'advanced\n');
        sh('git add advanced.txt && git commit -qm advanced', f.repo);
        expect(publishAt(String(synced.target_tip)).status).toBe('advanced');
        synced = runBash(sync.bash!, f.worker, env);
        expect(readFileSync(join(f.artifact, 'sync-m1-2.json'), 'utf8')).toContain(
          '"generation": 2'
        );
        expect(readFileSync(join(f.artifact, 'resync-m1.json'), 'utf8')).toContain(
          '"generation": 2'
        );
      }
      if (mode === 'dirty') {
        const dirty = join(f.repo, 'dirty.txt');
        writeFileSync(dirty, 'dirty\n');
        const failed = Bun.spawnSync(['bash', '-c', publishCommand(String(synced.target_tip))], {
          cwd: f.worker,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(failed.exitCode).toBe(1);
        expect(JSON.parse(failed.stdout.toString())).toEqual({
          status: 'dirty',
          paths: ['untracked: "dirty.txt"'],
          reason: 'target_dirty',
        });
        unlinkSync(dirty);
      }
      if (mode === 'normal') {
        const gatePath = join(f.artifact, 'gate-m1-r1.json');
        writeFileSync(
          gatePath,
          JSON.stringify({
            ...JSON.parse(readFileSync(gatePath, 'utf8')),
            reviewed_diff_hash: 'tampered',
          })
        );
        const rejected = Bun.spawnSync(['bash', '-c', publishCommand(String(synced.target_tip))], {
          cwd: f.worker,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(rejected.exitCode).toBe(1);
        expect(rejected.stderr.toString()).toContain('integration: gate evidence mismatch');
        gateSha256 = writeGate(String(synced.target_tip));
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

test.each(['sync', 'publish'] as const)(
  '%s entry rejects missing authorization and mismatched workflow under worker role',
  action => {
    const f = setup('normal');
    try {
      const node = f.nodes.find(candidate => candidate.id === `${action}-m1`)!;
      const command =
        action === 'publish'
          ? `INPUTS_TARGET_TIP=unused INPUTS_REVIEW_REQUIRED=1 bun -e '${node.script!.replaceAll("'", "'\\''")}'`
          : node.bash!;
      const env = fixtureEnv({
        SUPERAGENT_HOME: process.env.SUPERAGENT_HOME!,
        ARCHON_HOME: process.env.ARCHON_HOME!,
        WORKFLOW_ID: 'other-run',
        ARTIFACTS_DIR: f.artifact,
        NODE_ENV: 'test',
        SUPERAGENT_ROLE: 'worker',
        SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
      });
      const invoke = () =>
        Bun.spawnSync(['bash', '-c', command], {
          cwd: f.worker,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 15_000,
        });
      let result = invoke();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('integration: authorization/run mismatch');

      env.WORKFLOW_ID = f.runId;
      unlinkSync(f.authorization);
      result = invoke();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('integration: authorization/run mismatch');
    } finally {
      restoreEnv(f.saved);
    }
  }
);

const workflowRun = (id: string): WorkflowRun => ({
  origin: { conversationId: 'delivery-e2e' },
  id,
  workflow_name: 'delivery-e2e',
  conversation_id: 'delivery-e2e',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'running',
  outcome: null,
  user_message: 'delivery e2e',
  metadata: {},
  started_at: new Date(),
  completed_at: null,
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  output_root: null,
  checkout_baseline: null,
  adopted_from_run_id: null,
});

const executorDeps = (run: WorkflowRun) => {
  const events: WorkflowEventInput[] = [];
  const terminal = { completed: [] as string[], failed: [] as string[] };
  const observe: IWorkflowStore['createWorkflowEvent'] = async event => {
    events.push(event);
  };
  const persist: IWorkflowStore['persistWorkflowEvent'] = async event => {
    events.push(event);
  };
  const persistIfRunning: IWorkflowStore['persistWorkflowEventIfRunning'] = async event => {
    events.push(event);
    return { persisted: true };
  };
  const store = {
    createWorkflowEvent: observe,
    persistWorkflowEvent: persist,
    persistWorkflowEventIfRunning: persistIfRunning,
    getWorkflowRunStatus: async () => 'running' as const,
    getWorkflowRun: async () => run,
    updateWorkflowActivity: async () => {},
    updateWorkflowRun: async () => {},
    completeWorkflowRun: async id => {
      terminal.completed.push(id);
    },
    failWorkflowRun: async id => {
      terminal.failed.push(id);
    },
    findChildRuns: async () => [],
    listWorkflowNodeSessions: async () => [],
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowNodeSession: async () => {},
    upsertWorkflowRunNodeSession: async () => {},
  } satisfies Partial<IWorkflowStore>;
  const provider = {
    id: 'claude',
    displayName: 'Test',
    builtIn: true,
    credentials: { kind: 'static' as const, specs: [], vendorFor: () => undefined },
    parseConfig: (raw: Record<string, unknown>) => raw,
    capabilities: {
      backgroundWork: 'none' as const,
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      plugins: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false as const,
      requiresAllPropertiesRequired: false,
      envInjection: false,
      costControl: false,
      costReporting: false,
      effortControl: false,
      fallbackModel: false,
      sandbox: false,
      settingSources: false,
      nativeTools: false,
      containerExec: false,
    },
  };
  const deps: WorkflowDeps = {
    providers: { get: id => (id === provider.id ? provider : undefined), list: () => [provider] },
    store: store as unknown as IWorkflowStore,
    getAgentProvider: () => {
      throw new Error('delivery executor fixture has no AI nodes');
    },
    loadConfig: async () => ({
      assistant: 'claude',
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
  };
  return { deps, events, terminal };
};

const executorPlatform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getStreamingMode: () => 'batch',
  getPlatformType: () => 'test',
  sendStructuredEvent: async () => {},
};

const executorConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
};

const gateOutputSchema = {
  type: 'object',
  properties: {
    verdict: { enum: ['pass', 'fix'] },
    reviewed_head: { type: 'string' },
    reviewed_diff_hash: { type: 'string' },
    artifact_sha256: { type: 'string' },
  },
  required: ['verdict', 'reviewed_head', 'reviewed_diff_hash', 'artifact_sha256'],
};

const executorWorkflow = (f: ReturnType<typeof setup>, passRound: 1 | 2) => {
  const integration = structuredClone(f.workflow.nodes.find(node => node.id === 'integrate-m1')!);
  const body = integration.loop_group!.nodes;
  const finalAccept = body.find(node => node.id === 'final-accept-m1')!;
  delete finalAccept.script;
  delete finalAccept.runtime;
  delete finalAccept.with;
  delete finalAccept.output_format;
  finalAccept.bash = 'printf accepted';

  const head = sh('git rev-parse HEAD', f.worker).trim();
  const target = sh('git rev-parse delivery-target', f.repo).trim();
  const patch = Bun.spawnSync(
    [
      'git',
      '-C',
      f.worker,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      target,
      'HEAD',
      '--',
    ],
    { stdout: 'pipe' }
  ).stdout;
  const reviewedDiffHash = diffHash(patch);
  const gateIds = integration.depends_on!;
  const gates = gateIds.map((id, index): WorkflowNode => {
    const round = index + 1;
    const verdict = round < passRound ? 'fix' : 'pass';
    const evidence = JSON.stringify({
      verdict,
      reviewed_head: head,
      reviewed_diff_hash: reviewedDiffHash,
    });
    writeFileSync(join(f.artifact, `${id}.json`), evidence);
    const output = JSON.stringify({
      ...JSON.parse(evidence),
      artifact_sha256: createHash('sha256').update(evidence).digest('hex'),
    });
    return {
      id,
      bash: `printf '%s' '${output}'`,
      ...(round > 1
        ? {
            depends_on: [gateIds[index - 1]!],
            when: `$${gateIds[index - 1]!}.output.verdict == 'fix'`,
          }
        : {}),
      output_format: gateOutputSchema,
    };
  });
  return makeTestResolvedWorkflow({
    name: `delivery-pass-r${String(passRound)}`,
    nodes: [...gates, integration],
  });
};

test.each([1, 2] as const)(
  'real DAG executor publishes G2 milestone when gate r%s passes and later rounds skip',
  async passRound => {
    const f = setup('normal');
    try {
      const run = workflowRun(f.runId);
      const { deps, events, terminal } = executorDeps(run);
      const stateDir = join(process.env.SUPERAGENT_HOME!, 'state');
      const logDir = join(process.env.SUPERAGENT_HOME!, 'logs');
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(logDir, { recursive: true });
      await executeTestDagWorkflow({
        deps,
        platform: executorPlatform,
        conversationId: 'delivery-e2e',
        cwd: f.worker,
        workflow: executorWorkflow(f, passRound),
        workflowRun: run,
        workflowProvider: 'claude',
        workflowModel: undefined,
        artifactsDir: f.artifact,
        stateDir,
        logDir,
        baseBranch: 'delivery-target',
        docsDir: 'docs/',
        config: executorConfig,
      });
      expect(events.some(event => event.event_type === 'node_failed')).toBeFalse();
      expect(
        events.some(
          event => event.event_type === 'node_completed' && event.step_name === 'integrate-m1'
        )
      ).toBeTrue();
      expect(terminal).toEqual({ completed: [run.id], failed: [] });
      expect(
        events.filter(
          event =>
            event.event_type === 'node_completed' && event.step_name === 'integrate-m1.publish-m1'
        )
      ).toHaveLength(1);
      expect(sh('git rev-parse delivery-target', f.repo).trim()).toBe(
        sh('git rev-parse HEAD', f.worker).trim()
      );
      for (let round = passRound + 1; round <= 6; round++) {
        expect(
          events.some(
            event =>
              event.event_type === 'node_skipped' && event.step_name === `gate-m1-r${String(round)}`
          )
        ).toBeTrue();
      }
    } finally {
      restoreEnv(f.saved);
    }
  },
  60_000
);

test('land.ts without INPUTS_ACTION rejects the removed legacy delivery entrypoint', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/land.ts')], {
    env: fixtureEnv({ INPUTS_ACTION: '', INPUTS_RUN: '' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('legacy delivery removed; run is terminal');
});
