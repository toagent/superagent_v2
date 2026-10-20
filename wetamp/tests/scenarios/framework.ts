import { expect, spyOn } from 'bun:test';
import type {
  IAgentProvider,
  ProviderRegistry,
  SendQueryOptions,
} from '../../../packages/provider-contract/src';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { IWorkflowStore } from '@archon/workflows/store';
import { executeTestDagWorkflow, makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import {
  descriptor,
  createProvider,
} from '../../../packages/provider-contract/src/fixtures/test-provider/main';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturePlan, gitRepo, sh, tmp } from '../helpers';
import { generate } from '../../src/generate';
import { ledgerPath } from '../../src/cli';
import * as coordination from '../../src/coord';
import type { Plan } from '../../src/plan';
import { liveSourceRoots } from '../../../packages/workflows/src/workflow-source';
import { createWorkflowStore } from '../../../packages/core/src/workflows/store-adapter';
import { resetDatabase } from '../../../packages/core/src/db/connection';

// prettier-ignore
export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S13';

export interface ScenarioSpec {
  id: ScenarioId;
  risk: 'G1' | 'G2';
  passRound: 1 | 2;
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
  roles: string[];
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
    ARCHON_TELEMETRY_DISABLED: 'true',
    DATABASE_URL: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  resetDatabase();
  expect(home).not.toBe(join(saved.HOME ?? '', '.superagent'));
  expect(archonHome).not.toBe(join(saved.HOME ?? '', '.superagent', 'archon'));
  return { root, home, archonHome, target, worker, initial, saved, spec, roles: [] };
}

export function restore(f: ScenarioFixture): void {
  for (const key of Object.keys(process.env)) if (!(key in f.saved)) delete process.env[key];
  Object.assign(process.env, f.saved);
}

function scriptedProvider(f: ScenarioFixture): IAgentProvider {
  const base = createProvider();
  return {
    ...base,
    getCapabilities: () => ({ ...base.getCapabilities(), sessionFork: true }),
    async *sendQuery(_prompt: string, cwd: string, _resume?: string, options?: SendQueryOptions) {
      const id = options?.nodeConfig?.nodeId ?? '';
      f.roles.push(options?.env?.SUPERAGENT_ROLE ?? '');
      if (id.startsWith('code-')) {
        const edit = f.spec.agents.code;
        writeFileSync(join(cwd, edit.path), f.spec.id === 'S6' ? 'regression\n' : edit.content);
        sh(
          `git add '${edit.path}' && git -c user.name=scenario -c user.email=scenario@local commit -qm scenario-${f.spec.id}`,
          cwd
        );
      }
      if (id.startsWith('fix-')) {
        writeFileSync(join(cwd, 'fix.txt'), `${f.spec.id}\n`);
        sh(
          `git add fix.txt && git -c user.name=scenario -c user.email=scenario@local commit -qm fix-${f.spec.id}`,
          cwd
        );
      }
      if (id === 'review-m1-r1' && f.spec.id === 'S4') {
        writeFileSync(join(f.target, 'advanced.txt'), 'advanced\n');
        sh('git add advanced.txt && git commit -qm advanced', f.target);
      }
      if (id === 'review-m1-r1' && f.spec.id === 'S8') {
        const path = join(f.root, 'artifacts', 'diff-m1-r1.json');
        if (existsSync(path)) writeFileSync(path, `${readFileSync(path, 'utf8')} `);
      }
      const sample = schemaSample(
        options?.outputFormat?.schema as JsonSchema | undefined,
        id,
        editFiles(f)
      ) as Record<string, unknown>;
      if (id === 'review-m1-r1' && f.spec.passRound === 2) {
        sample.status = 'FAIL';
        sample.findings = [
          {
            id: 'scenario-r1',
            severity: 'high',
            file: f.spec.agents.code.path,
            line: 1,
            status: 'open',
            evidence: 'scripted first-round finding',
            failure_class: 'product',
            command: null,
            carry_over: false,
          },
        ];
      }
      if (id === 'review-m1-r2' && f.spec.passRound === 2)
        sample.findings = [
          {
            id: 'scenario-r1',
            severity: 'high',
            file: f.spec.agents.code.path,
            line: 1,
            status: 'closed',
            evidence: 'fixed in round two',
            failure_class: 'product',
            command: null,
            carry_over: true,
          },
        ];
      yield {
        type: 'result',
        text: JSON.stringify(sample),
        structuredOutput: sample,
        sessionId: `scenario-${f.spec.id.toLowerCase()}-${id}`,
        ...(_resume ? { resumed: true } : {}),
        resolvedModel: { id: id.startsWith('review-') ? 'fixture/reviewer' : 'fixture/coder' },
      };
      yield { type: 'settled' };
    },
  };
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};
const editFiles = (f: ScenarioFixture): string[] => [f.spec.agents.code.path];
function schemaSample(schema: JsonSchema | undefined, node: string, changed: string[]): unknown {
  if (!schema) return 'ok';
  if (schema.enum) return schema.enum.includes(null) ? null : schema.enum[0];
  const type = Array.isArray(schema.type)
    ? schema.type.find(value => value !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
      if (key === 'status') out[key] = node.startsWith('review-') ? 'PASS' : 'done';
      else if (key === 'changed_files') out[key] = changed;
      else if (key === 'error_class') out[key] = null;
      else out[key] = schemaSample(schema.properties?.[key], node, changed);
    }
    return out;
  }
  if (type === 'array') return [];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  return '';
}

function deps(store: IWorkflowStore, provider: IAgentProvider) {
  const registry: ProviderRegistry = {
    get: id =>
      id === descriptor.id
        ? {
            id: descriptor.id,
            displayName: descriptor.displayName,
            builtIn: false,
            credentials: { ...descriptor.credentials, vendorFor: () => undefined },
            parseConfig: raw => raw,
            capabilities: { ...descriptor.capabilities, sessionFork: true },
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
    store,
    getAgentProvider: () => provider,
    loadConfig: async () => config,
  };
  return { value, config };
}

const platform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getStreamingMode: () => 'batch',
  getPlatformType: () => 'test',
  sendStructuredEvent: async () => {},
};

export async function runInProcess(f: ScenarioFixture) {
  const id = `5ce0-${f.spec.id.slice(1).padStart(4, '0')}`;
  const store = createWorkflowStore();
  await store.createWorkflowRun({
    id,
    workflow_name: id,
    user_message: id,
    working_path: f.worker,
  });
  const run = await store.claimPendingWorkflowRun(id, f.worker);
  if (!run) throw new Error(`scenario run ${id} was not claimable`);
  const d = deps(store, scriptedProvider(f));
  const plan = JSON.parse(
    readFileSync(
      fixturePlan(f.root, f.target, value => {
        value.base_ref = 'scenario-target';
        value.environment = [];
        value.packages = [
          {
            id: 'p',
            title: f.spec.id,
            goal: f.spec.plan.goal,
            scope: { write: [f.spec.agents.code.path, 'fix.txt'] },
            accept: [{ cmd: f.spec.plan.accept, timeout_s: 5 }],
            risk: f.spec.risk,
            size: 'S',
          },
        ];
      }),
      'utf8'
    )
  ) as Plan;
  Object.assign(process.env, {
    WORKFLOW_ID: id,
    SUPERAGENT_MEMORY: 'off',
    NODE_ENV: 'test',
    SA_INTEGRATION_LOCK_TIMEOUT_MS: '2000',
  });
  const who = coordination.caller();
  coordination.coord().claim(coordination.repoScope(f.target), who);
  coordination.coord().claim(coordination.runScope({ run_id: id, repo: f.target }), who);
  const engine = spyOn(coordination, 'cleanEngine').mockReturnValue(f.initial);
  const identity = spyOn(coordination, 'caller').mockReturnValue(who);
  let generated: ReturnType<typeof generate>;
  try {
    generated = generate(plan, id, false, undefined, undefined, {
      checkout: f.target,
      branch: 'scenario-target',
      head: f.initial,
    });
  } finally {
    identity.mockRestore();
    engine.mockRestore();
  }
  if (f.spec.id === 'S13') {
    const takeover = { ...who, client: `${who.client}-takeover` };
    coordination
      .coord()
      .claim(coordination.repoScope(f.target), takeover, true, 'scenario takeover');
    coordination
      .coord()
      .claim(
        coordination.runScope({ run_id: id, repo: f.target }),
        takeover,
        true,
        'scenario takeover'
      );
  }
  mkdirSync(join(f.home, 'runs'), { recursive: true });
  writeFileSync(
    ledgerPath(id),
    JSON.stringify({
      run_id: id,
      archon_run_id: id,
      repo: f.target,
      branch: `scenario-${f.spec.id.toLowerCase()}`,
      plan: join(generated.dir, 'plan.json'),
      gen_dir: generated.dir,
      workflow: generated.workflow,
      delivery: { checkout: f.target, branch: 'scenario-target', head: f.initial },
    })
  );
  const raw = Bun.YAML.parse(
    readFileSync(
      join(generated.dir, '.archon/workflows', generated.workflow, `${generated.workflow}.yaml`),
      'utf8'
    )
  ) as { description?: string; nodes: Array<Record<string, unknown>> };
  const routeAi = (nodes: Array<Record<string, unknown>>): void => {
    for (const node of nodes) {
      if (node.command || node.prompt) {
        node.provider = descriptor.id;
        delete node.model;
      }
      const group = node.loop_group as { nodes?: Array<Record<string, unknown>> } | undefined;
      if (group?.nodes) routeAi(group.nodes);
    }
  };
  routeAi(raw.nodes);
  const workflow = makeTestResolvedWorkflow({
    name: generated.workflow,
    description: raw.description,
    provider: descriptor.id,
    nodes: raw.nodes,
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
    workflowSourceRoots: liveSourceRoots(generated.dir),
  });
  const persisted = await store.getWorkflowRun(id);
  const events = await store.listWorkflowEvents(id);
  return {
    ...d,
    generated,
    artifactsDir,
    events,
    terminal: {
      completed: persisted?.status === 'completed' ? [id] : [],
      failed: persisted?.status === 'failed' ? [id] : [],
    },
  };
}

export type ScenarioResult = Awaited<ReturnType<typeof runInProcess>>;

export function expectOutcome(
  f: ScenarioFixture,
  result: ScenarioResult,
  spec: { terminal: 'completed' | 'failed'; counts: Record<string, number>; published: boolean }
): void {
  const id = `5ce0-${f.spec.id.slice(1).padStart(4, '0')}`;
  expect(result.terminal).toEqual({
    completed: spec.terminal === 'completed' ? [id] : [],
    failed: spec.terminal === 'failed' ? [id] : [],
  });
  for (const [node, count] of Object.entries(spec.counts))
    expect(
      result.events.filter(
        event => event.event_type === 'node_completed' && event.step_name === node
      )
    ).toHaveLength(count);
  expect(result.events.filter(event => event.event_type === 'node_failed').length === 0).toBe(
    spec.terminal === 'completed'
  );
  const receipt = join(result.artifactsDir, 'publish-m1.json');
  expect(existsSync(receipt)).toBe(spec.published);
  if (spec.published) {
    expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe('published');
    expect(sh('git rev-parse scenario-target', f.target).trim()).toBe(
      sh('git rev-parse HEAD', f.worker).trim()
    );
  } else expect(sh('git rev-parse scenario-target', f.target).trim()).toBe(f.initial);
}
