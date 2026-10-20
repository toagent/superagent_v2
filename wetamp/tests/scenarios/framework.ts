import { expect } from 'bun:test';
import type {
  IAgentProvider,
  ProviderRegistry,
  SendQueryOptions,
} from '../../../packages/provider-contract/src';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore, WorkflowEventInput } from '@archon/workflows/store';
import { executeTestDagWorkflow, makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import {
  descriptor,
  createProvider,
} from '../../../packages/provider-contract/src/fixtures/test-provider/main';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { receiptPath } from '../../../packages/plugin-manifest/src/store';
import { fixtureEnv, gitRepo, sh, tmp } from '../helpers';

export interface ScenarioSpec {
  id: 'S1' | 'S2';
  risk: 'G1' | 'G2';
  passRound: 1;
  plan: { goal: string; accept: string };
  agents: { code: { path: string; content: string } };
  expected: { terminal: 'completed'; publishCount: 1 };
}

export interface ScenarioFixture {
  root: string;
  home: string;
  archonHome: string;
  target: string;
  worker: string;
  initial: string;
  saved: NodeJS.ProcessEnv;
  spec: ScenarioSpec;
}

export function scenario(spec: ScenarioSpec): ScenarioFixture {
  const root = tmp();
  const target = gitRepo(root);
  const worker = join(root, 'worker');
  sh(
    'git branch -m scenario-target && git config user.name t && git config user.email t@l',
    target
  );
  const initial = sh('git rev-parse HEAD', target).trim();
  sh(`git worktree add -qb scenario-${spec.id.toLowerCase()} '${worker}' scenario-target`, target);
  const home = join(root, 'home');
  const archonHome = join(home, 'archon');
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    SUPERAGENT_HOME: home,
    ARCHON_HOME: archonHome,
    SUPERAGENT_ROLE: 'worker',
    ARCHON_TELEMETRY_DISABLED: 'true',
    DATABASE_URL: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  expect(home).not.toBe(join(saved.HOME ?? '', '.superagent'));
  expect(archonHome).not.toBe(join(saved.HOME ?? '', '.superagent', 'archon'));
  return { root, home, archonHome, target, worker, initial, saved, spec };
}

export function restore(f: ScenarioFixture): void {
  for (const key of Object.keys(process.env)) if (!(key in f.saved)) delete process.env[key];
  Object.assign(process.env, f.saved);
}

function scriptedProvider(f: ScenarioFixture): IAgentProvider {
  const base = createProvider();
  return {
    ...base,
    async *sendQuery(prompt: string, cwd: string, resume?: string, options?: SendQueryOptions) {
      if (prompt === 'scenario:S2:code') {
        expect(process.env.SUPERAGENT_ROLE).toBe('worker');
        const edit = f.spec.agents.code;
        writeFileSync(join(cwd, edit.path), edit.content);
        sh(
          `git add '${edit.path}' && git -c user.name=scenario -c user.email=scenario@local commit -qm scenario-S2`,
          cwd
        );
        yield { type: 'result', text: 'applied', sessionId: 'scenario-s2' };
        yield { type: 'settled' };
        return;
      }
      yield* base.sendQuery(prompt, cwd, resume, options);
    },
  };
}

function workflowRun(id: string): WorkflowRun {
  return {
    origin: { conversationId: id },
    id,
    workflow_name: id,
    conversation_id: id,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: id,
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
  };
}

function deps(run: WorkflowRun, provider: IAgentProvider) {
  const events: WorkflowEventInput[] = [];
  const terminal = { completed: [] as string[], failed: [] as string[] };
  const store = {
    createWorkflowEvent: async (event: WorkflowEventInput) => {
      events.push(event);
    },
    persistWorkflowEvent: async (event: WorkflowEventInput) => {
      events.push(event);
    },
    persistWorkflowEventIfRunning: async (event: WorkflowEventInput) => {
      events.push(event);
      return { persisted: true as const };
    },
    getWorkflowRunStatus: async () => 'running' as const,
    getWorkflowRun: async () => run,
    updateWorkflowActivity: async () => {},
    updateWorkflowRun: async () => {},
    completeWorkflowRun: async (id: string) => {
      terminal.completed.push(id);
    },
    failWorkflowRun: async (id: string) => {
      terminal.failed.push(id);
    },
    findChildRuns: async () => [],
    listWorkflowNodeSessions: async () => [],
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowNodeSession: async () => {},
    upsertWorkflowRunNodeSession: async () => {},
  } satisfies Partial<IWorkflowStore>;
  const registry: ProviderRegistry = {
    get: id =>
      id === descriptor.id
        ? {
            id: descriptor.id,
            displayName: descriptor.displayName,
            builtIn: false,
            credentials: { ...descriptor.credentials, vendorFor: () => undefined },
            parseConfig: raw => raw,
            capabilities: descriptor.capabilities,
          }
        : undefined,
    list: () => [],
  };
  const config: WorkflowConfig = {
    assistant: descriptor.id,
    assistants: { claude: {}, codex: {} },
    commands: {},
  };
  const value: WorkflowDeps = {
    providers: registry,
    store: store as unknown as IWorkflowStore,
    getAgentProvider: () => provider,
    loadConfig: async () => config,
  };
  return { value, events, terminal, config };
}

const platform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getStreamingMode: () => 'batch',
  getPlatformType: () => 'test',
  sendStructuredEvent: async () => {},
};

export async function runInProcess(f: ScenarioFixture) {
  const id = 'scenario-s2';
  const run = workflowRun(id);
  const d = deps(run, scriptedProvider(f));
  const publish = `test "$SUPERAGENT_ROLE" = worker && expected=$(git -C '${f.target}' rev-parse scenario-target) && head=$(git rev-parse HEAD) && test "$expected" = '${f.initial}' && git -C '${f.target}' update-ref refs/heads/scenario-target "$head" "$expected" && printf '{"status":"published"}'`;
  const workflow = makeTestResolvedWorkflow({
    name: id,
    description: f.spec.plan.goal,
    provider: descriptor.id,
    nodes: [
      { id: 'code', prompt: 'scenario:S2:code' },
      {
        id: 'accept-r1',
        depends_on: ['code'],
        bash: `test "$SUPERAGENT_ROLE" = worker && ${f.spec.plan.accept} && printf pass`,
      },
      {
        id: 'accept-r2',
        depends_on: ['accept-r1'],
        when: "$accept-r1.output != 'pass'",
        bash: 'exit 91',
      },
      {
        id: 'publish',
        depends_on: ['accept-r1', 'accept-r2'],
        trigger_rule: 'none_failed_min_one_success',
        bash: publish,
      },
    ],
  });
  const stateDir = join(f.root, 'state'),
    logDir = join(f.root, 'logs'),
    artifactsDir = join(f.root, 'artifacts');
  for (const path of [stateDir, logDir, artifactsDir]) mkdirSync(path, { recursive: true });
  await executeTestDagWorkflow({
    deps: d.value,
    platform,
    conversationId: id,
    cwd: f.worker,
    workflow,
    workflowRun: run,
    workflowProvider: descriptor.id,
    workflowModel: undefined,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch: 'scenario-target',
    docsDir: 'docs/',
    config: d.config,
  });
  return d;
}

function installProvider(f: ScenarioFixture): void {
  const plugins = join(f.archonHome, 'plugins');
  const executable = join(plugins, 'archon-provider-test-provider');
  const wrapper = join(plugins, 'scenario-provider.ts');
  mkdirSync(plugins, { recursive: true });
  const pluginApi = join(
    import.meta.dir,
    '../../../packages/provider-contract/src/plugin/index.ts'
  );
  const fixture = join(
    import.meta.dir,
    '../../../packages/provider-contract/src/fixtures/test-provider/main.ts'
  );
  const edit = f.spec.agents.code;
  writeFileSync(
    wrapper,
    `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { serveProvider } from ${JSON.stringify(pluginApi)};\nimport { descriptor, createProvider } from ${JSON.stringify(fixture)};\nawait serveProvider({ descriptor, create: () => { const base = createProvider(); return { ...base, async *sendQuery(prompt,cwd,resume,options) { if (prompt === 'scenario:S1:code') { writeFileSync(join(cwd,${JSON.stringify(edit.path)}),${JSON.stringify(edit.content)}); writeFileSync(join(cwd,'role.txt'),options?.env?.SUPERAGENT_ROLE ?? ''); const a=Bun.spawnSync(['git','add',${JSON.stringify(edit.path)},'role.txt'],{cwd}); const c=Bun.spawnSync(['git','-c','user.name=scenario','-c','user.email=scenario@local','commit','-qm','scenario-S1'],{cwd}); yield {type:'result',text:a.exitCode || c.exitCode ? 'git-failed' : 'applied',sessionId:'scenario-s1'}; yield {type:'settled'}; return; } yield* base.sendQuery(prompt,cwd,resume,options); } }; } });\n`
  );
  writeFileSync(executable, `#!/bin/sh\nexec bun ${JSON.stringify(wrapper)}\n`, { mode: 0o755 });
  const receipt = receiptPath(plugins, 'scenario/test-provider');
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      id: 'scenario/test-provider',
      manifest: {
        schemaVersion: 1,
        kind: 'provider',
        name: 'test-provider',
        description: 'scenario fixture',
        executable: 'archon-provider-test-provider',
      },
      tag: 'v1',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: 'archon-provider-test-provider', sha256: 'b'.repeat(64) }],
      descriptor,
    })
  );
  mkdirSync(f.archonHome, { recursive: true });
  writeFileSync(
    join(f.archonHome, 'config.yaml'),
    `assistant: test-provider\nenv:\n  SUPERAGENT_ROLE: worker\nassistants:\n  test-provider: {}\n`
  );
}

export function runDetached(f: ScenarioFixture) {
  installProvider(f);
  const source = join(f.root, 'source'),
    dir = join(source, '.archon', 'workflows', 'scenario-s1');
  mkdirSync(dir, { recursive: true });
  const target = JSON.stringify(f.target),
    initial = JSON.stringify(f.initial);
  const nodes = [
    { id: 'code', prompt: 'scenario:S1:code', provider: descriptor.id },
    {
      id: 'accept',
      depends_on: ['code'],
      bash: `test "$SUPERAGENT_ROLE" = worker && test "$(cat role.txt)" = worker && ${f.spec.plan.accept} && git diff --quiet && printf accepted`,
    },
    {
      id: 'sync',
      depends_on: ['accept'],
      bash: `test "$SUPERAGENT_ROLE" = worker && tip=$(git -C ${target} rev-parse scenario-target) && test "$tip" = ${initial} && printf '{"status":"synced","target_tip":"%s"}' "$tip"`,
    },
    {
      id: 'publish',
      depends_on: ['sync'],
      bash: `test "$SUPERAGENT_ROLE" = worker && head=$(git rev-parse HEAD) && git -C ${target} update-ref refs/heads/scenario-target "$head" ${initial} && printf '{"status":"published","target_tip":"%s"}' "$head"`,
    },
  ];
  writeFileSync(
    join(dir, 'scenario-s1.yaml'),
    Bun.YAML.stringify({
      name: 'scenario-s1',
      description: f.spec.plan.goal,
      provider: descriptor.id,
      worktree: { enabled: false },
      nodes,
    })
  );
  const env = fixtureEnv({
    HOME: f.home,
    SUPERAGENT_HOME: f.home,
    ARCHON_HOME: f.archonHome,
    SUPERAGENT_ROLE: '',
    ARCHON_TELEMETRY_DISABLED: 'true',
    DATABASE_URL: '',
  });
  const cli = join(import.meta.dir, '../../bin/archon');
  const launch = Bun.spawnSync(
    [
      cli,
      'workflow',
      'run',
      'scenario-s1',
      '--workflow-source',
      source,
      '--cwd',
      f.worker,
      '--no-worktree',
      '--detach',
      '--json',
      '--config',
      join(f.archonHome, 'config.yaml'),
    ],
    { cwd: f.worker, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  );
  expect(launch.exitCode, launch.stdout.toString() + launch.stderr.toString()).toBe(0);
  const runId = (JSON.parse(launch.stdout.toString()) as { runId: string }).runId;
  const wait = Bun.spawnSync(
    [cli, 'workflow', 'wait', runId, '--cwd', f.worker, '--json', '--timeout', '60'],
    { cwd: f.worker, env, stdout: 'pipe', stderr: 'pipe', timeout: 70_000 }
  );
  expect(wait.exitCode, wait.stderr.toString()).toBe(0);
  const get = Bun.spawnSync(
    [cli, 'workflow', 'get', runId, '--cwd', f.worker, '--json', '--verbose', '--events'],
    { cwd: f.worker, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }
  );
  expect(get.exitCode, get.stderr.toString()).toBe(0);
  return JSON.parse(get.stdout.toString()) as {
    status: string;
    events: Array<{ event_type: string; step_name?: string; data?: unknown }>;
  };
}
