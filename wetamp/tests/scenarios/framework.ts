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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { fixturePlan, gitRepo, sh, tmp, trackTestChild } from '../helpers';
import { engineHash, generate, type Carried } from '../../src/generate';
import { classifyRun, loadLedger, ledgerPath, main } from '../../src/cli';
import type { RunView } from '../../src/archon';
import * as coordination from '../../src/coord';
import * as archonModule from '../../src/archon';
import type { Plan } from '../../src/plan';
import { untilStatus } from '../../src/contract';
import { liveSourceRoots } from '../../../packages/workflows/src/workflow-source';
import { createWorkflowStore } from '../../../packages/core/src/workflows/store-adapter';
import { resetDatabase } from '../../../packages/core/src/db/connection';
import { cancelWorkflowRun, failWorkflowRun } from '../../../packages/core/src/db/workflows';
import { createCodebase } from '../../../packages/core/src/db/codebases';

// prettier-ignore
export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S12' | 'S13' | 'S14a' | 'S14b' | 'S14c' | 'S15' | 'S16' | 'S17' | 'S18' | 'S19' | 'S20' | 'S21';

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
  blockNode?: string;
  blockAfterCompletedNode?: string;
  blockMarker?: string;
  blockRelease?: string;
  blockMs?: number;
  runId?: string;
  targetAfterInjection?: string;
  carried?: Carried;
  engineSnapshot?: string;
  omitNewFindingOnRetry?: boolean;
  reviewCalls?: Record<string, number>;
  agentCalls?: Record<string, number>;
}

export interface GeneratedContinuation {
  runId: string;
  from: string;
  dir: string;
  workflow: string;
  engine_hash?: string;
  engine_commit?: string;
}

export function copyableFixtureEntry(source: string): boolean {
  if (source.includes('/node_modules') || source.includes('/.git/') || source.endsWith('/.git'))
    return false;
  const stat = lstatSync(source);
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

export function scenario(
  spec: ScenarioSpec,
  options: {
    target?: string;
    suffix?: string;
    blockNode?: string;
    blockAfterCompletedNode?: string;
    blockMarker?: string;
    blockRelease?: string;
    blockMs?: number;
    home?: string;
    runId?: string;
  } = {}
): ScenarioFixture {
  const root = tmp();
  const target = options.target ?? gitRepo(root);
  const worker = join(root, 'worker');
  if (!options.target)
    sh(
      'git branch -m scenario-target && git config user.name t && git config user.email t@l',
      target
    );
  const initial = sh('git rev-parse HEAD', target).trim();
  const branch = `scenario-${spec.id.toLowerCase()}${options.suffix ? `-${options.suffix}` : ''}`;
  sh(`git worktree add -qb '${branch}' '${worker}' scenario-target`, target);
  const home = options.home ?? join(root, 'home');
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
    SUPERAGENT_ROLE: '',
  });
  resetDatabase();
  expect(home).not.toBe(join(saved.HOME ?? '', '.superagent'));
  expect(archonHome).not.toBe(join(saved.HOME ?? '', '.superagent', 'archon'));
  return {
    root,
    home,
    archonHome,
    target,
    worker,
    initial,
    saved,
    spec,
    roles: [],
    blockNode: options.blockNode,
    blockAfterCompletedNode: options.blockAfterCompletedNode,
    blockMarker: options.blockMarker,
    blockRelease: options.blockRelease,
    blockMs: options.blockMs,
    runId: options.runId,
  };
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
      const agentCall = ((f.agentCalls ??= {})[id] = (f.agentCalls?.[id] ?? 0) + 1);
      f.roles.push(options?.env?.SUPERAGENT_ROLE ?? '');
      if (id.startsWith('code-')) {
        const edit =
          id === 'code-p2'
            ? { path: 'scenario-2.txt', content: `${f.spec.id}-2\n` }
            : f.spec.agents.code;
        writeFileSync(join(cwd, edit.path), edit.content);
        sh(
          `git add '${edit.path}' && git -c user.name=scenario -c user.email=scenario@local commit -qm scenario-${f.spec.id}`,
          cwd
        );
        if (f.spec.id === 'S5') {
          writeFileSync(join(f.target, edit.path), 'target-side\n');
          sh(`git add '${edit.path}' && git commit -qm target-conflict`, f.target);
        }
      }
      if (id === 'resolve-sync-review-m1' && f.spec.id === 'S5') {
        const targetTip = sh('git rev-parse scenario-target', f.target).trim();
        sh(`git merge -s ours --no-edit '${targetTip}'`, cwd);
      }
      if (
        id === 'resolve-resync-m1' &&
        ['S18', 'S19', 'S20', 'S21'].includes(f.spec.id) &&
        !(f.spec.id === 'S21' && agentCall === 1)
      ) {
        const targetTip = sh('git rev-parse scenario-target', f.target).trim();
        sh(`git merge -s ours --no-edit '${targetTip}'`, cwd);
        if (f.spec.id === 'S20') {
          writeFileSync(join(cwd, 'require-fix.txt'), 'required\n');
          sh('git add require-fix.txt && git commit --amend --no-edit -q', cwd);
        }
      }
      if (id.startsWith('fix-')) {
        writeFileSync(join(cwd, 'fix.txt'), `${f.spec.id}-${String(f.roles.length)}\n`);
        sh(
          `git add fix.txt && git -c user.name=scenario -c user.email=scenario@local commit -qm fix-${f.spec.id}`,
          cwd
        );
      }
      if (id === f.blockNode) {
        const marker = f.blockMarker;
        if (!marker) throw new Error('scenario block marker missing');
        writeFileSync(marker, id);
        while (!f.blockRelease || !existsSync(f.blockRelease)) await Bun.sleep(25);
      }
      if (id === 'review-m1-r1' && f.spec.id === 'S8') {
        const runId = `5ce0-${f.spec.id.slice(1).padStart(4, '0')}`,
          path = join(f.archonHome, 'artifacts', 'runs', runId, 'diff-m1-r1.json');
        if (existsSync(path)) writeFileSync(path, `${readFileSync(path, 'utf8')} `);
      }
      if (id === 'review-m1-r1' && f.spec.id === 'S6') {
        writeFileSync(join(f.target, 'target-regression.txt'), 'regression\n');
        sh('git add target-regression.txt && git commit -qm target-regression', f.target);
        f.targetAfterInjection = sh('git rev-parse scenario-target', f.target).trim();
      }
      if (id === 'review-m1-r1' && f.spec.id === 'S16') {
        const runId = '5ce0-0016',
          ledger = JSON.parse(readFileSync(ledgerPath(runId), 'utf8')),
          originalPath = join(ledger.gen_dir, 'delivery-authorization.json'),
          original = readFileSync(originalPath),
          old = JSON.parse(original.toString()).run,
          current = { ...old, pid: old.pid + 100_000, pid_start: `${old.pid_start}-restart` },
          later = { ...old, pid: old.pid + 200_000, pid_start: `${old.pid_start}-later` },
          c = coordination.coord(),
          repo = coordination.repoScope(f.target),
          run = coordination.runScope({ run_id: runId, repo: f.target }),
          artifacts = join(f.root, 'reauthorize-probe'),
          probe = () =>
            Bun.spawnSync([process.execPath, join(import.meta.dir, '../../src/land.ts')], {
              cwd: f.worker,
              env: {
                ...process.env,
                INPUTS_ACTION: 'sync',
                INPUTS_RUN: runId,
                INPUTS_MILESTONE: 'probe',
                ARTIFACTS_DIR: artifacts,
              },
              stdout: 'pipe',
              stderr: 'pipe',
            }).exitCode;
        mkdirSync(artifacts, { recursive: true });
        c.claim(repo, current, true, 'controller restarted');
        c.claim(run, current, true, 'controller restarted');
        const failures = [probe()];
        c.reauthorize(ledger, current);
        writeFileSync(originalPath, Buffer.concat([original, Buffer.from(' ')]));
        failures.push(probe());
        writeFileSync(originalPath, original);
        rmSync(join(f.home, 'coord/leases'), { recursive: true });
        failures.push(probe());
        c.claim(repo, current);
        c.claim(run, current);
        c.claim(repo, later, true, 'later takeover');
        c.claim(run, later, true, 'later takeover');
        failures.push(probe());
        expect(failures.every(code => code !== 0)).toBeTrue();
        c.claim(repo, current, true, 'restore controller');
        c.claim(run, current, true, 'restore controller');
        c.reauthorize(ledger, current);
      }
      const sample = schemaSample(
        options?.outputFormat?.schema as JsonSchema | undefined,
        id,
        editFiles(f)
      ) as Record<string, unknown>;
      if (f.spec.id === 'S21' && id === 'resolve-resync-m1' && agentCall === 1) {
        sample.status = 'blocked';
        sample.error_class = 'task';
        sample.blockers = ['injected conflict resolution failure'];
      }
      const reviewCall = id.startsWith('review-')
        ? ((f.reviewCalls ??= {})[id] = (f.reviewCalls?.[id] ?? 0) + 1)
        : 0;
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
      if (f.spec.id === 'S18' && /^review-resync-m1-r[12]$/.test(id)) {
        const closed = id.endsWith('r2');
        sample.status = closed ? 'PASS' : 'FAIL';
        // prettier-ignore
        sample.findings = [{ id: 'scenario-resync-r1', severity: 'high', file: f.spec.agents.code.path,
          line: 1, status: closed ? 'closed' : 'open', evidence: closed ? 'fixed in round two' : 'scripted finding',
          failure_class: 'product', command: null, carry_over: closed }];
      }
      if (f.spec.id === 'S17' && id.startsWith('review-m1-r')) {
        const finding = (findingId: string, status: 'open' | 'closed') => ({
          id: findingId,
          severity: 'blocker',
          file: f.spec.agents.code.path,
          line: 1,
          status,
          evidence: `${findingId} ${status} in ${id}`,
          failure_class: 'product',
          command: null,
          carry_over: reviewCall > 1,
        });
        sample.status = reviewCall === 1 ? 'FAIL' : 'PASS';
        sample.findings =
          reviewCall === 1
            ? [finding('A', 'open'), ...(id.endsWith('-r3') ? [finding('B', 'open')] : [])]
            : id.endsWith('-r1')
              ? [
                  finding('A', 'closed'),
                  ...(f.omitNewFindingOnRetry ? [] : [finding('B', 'closed')]),
                ]
              : [];
      }
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

export async function runInProcess(
  f: ScenarioFixture,
  continuation?: GeneratedContinuation,
  stopAfter?: string
) {
  const id = continuation?.runId ?? f.runId ?? `5ce0-${f.spec.id.slice(1).padStart(4, '0')}`;
  const store = createWorkflowStore();
  const codebaseId = continuation
    ? (await store.getWorkflowRun(continuation.from))?.codebase_id
    : (
        await createCodebase({
          name: id,
          default_cwd: f.target,
          default_branch: 'scenario-target',
          ai_assistant_type: descriptor.id,
          kind: 'repo',
        })
      ).id;
  if (!codebaseId) throw new Error(`scenario run ${id} missing codebase identity`);
  await store.createWorkflowRun({
    id,
    codebase_id: codebaseId,
    workflow_name: id,
    user_message: id,
    working_path: f.worker,
    adopted_from_run_id: continuation?.from,
    metadata: { execution_owner: { host: hostname(), pid: process.pid } },
  });
  const run = await store.claimPendingWorkflowRun(id, f.worker);
  if (!run) throw new Error(`scenario run ${id} was not claimable`);
  const d = deps(store, scriptedProvider(f));
  const persistEvent = store.persistWorkflowEvent.bind(store);
  store.persistWorkflowEvent = async event => {
    await persistEvent(event);
    if (
      event.event_type === 'node_completed' &&
      event.step_name === 'gate-m1-r1' &&
      ['S18', 'S19', 'S20', 'S21'].includes(f.spec.id)
    ) {
      writeFileSync(join(f.target, f.spec.agents.code.path), 'target-side\n');
      sh(`git add '${f.spec.agents.code.path}' && git commit -qm target-resync-conflict`, f.target);
      f.targetAfterInjection = sh('git rev-parse scenario-target', f.target).trim();
    }
    if (event.event_type === 'node_completed' && event.step_name === f.blockAfterCompletedNode) {
      if (!f.blockMarker) throw new Error('scenario completion block marker missing');
      writeFileSync(f.blockMarker, event.step_name ?? 'unknown');
      if (f.blockMs !== undefined) await Bun.sleep(f.blockMs);
      else while (!f.blockRelease || !existsSync(f.blockRelease)) await Bun.sleep(25);
    }
  };
  const plan = JSON.parse(
    readFileSync(
      fixturePlan(f.root, f.target, value => {
        value.base_ref = 'scenario-target';
        value.environment = [];
        const packages: Record<string, unknown>[] = [
          {
            id: 'p',
            title: f.spec.id,
            goal: f.spec.plan.goal,
            scope: { write: [f.spec.agents.code.path, 'fix.txt', 'require-fix.txt'] },
            accept: [{ cmd: f.spec.plan.accept, timeout_s: 5 }],
            risk: f.spec.risk,
            size: 'S',
          },
        ];
        if (f.spec.id === 'S10')
          packages.push({
            id: 'p2',
            title: 'S10 second milestone',
            goal: 'S10 second generated delivery',
            scope: { write: ['scenario-2.txt'] },
            accept: [{ cmd: 'test "$(cat scenario-2.txt)" = S10-2', timeout_s: 5 }],
            risk: f.spec.risk,
            size: 'S',
            milestone: 'm2',
            deps: ['p'],
          });
        value.packages = packages;
      }),
      'utf8'
    )
  ) as Plan;
  Object.assign(process.env, {
    WORKFLOW_ID: id,
    SUPERAGENT_MEMORY: 'off',
    NODE_ENV: 'test',
    // Covers multi-pass scenario publishes and CI Git variance, but exposes leaks within 30s.
    SA_INTEGRATION_LOCK_TIMEOUT_MS: '30000',
  });
  const shell = coordination.caller();
  const who = { ...shell, client: `${shell.client}-scenario-authorized` };
  let controller: ReturnType<typeof coordination.caller> | undefined;
  if (!continuation) {
    coordination.coord().claim(coordination.repoScope(f.target), who);
    controller = coordination
      .coord()
      .claim(coordination.runScope({ run_id: id, repo: f.target }), who).controller;
  }
  const engine = spyOn(coordination, 'cleanEngine').mockReturnValue(f.initial);
  const identity = spyOn(coordination, 'caller').mockReturnValue(who);
  let generated: ReturnType<typeof generate> | GeneratedContinuation;
  try {
    // prettier-ignore
    generated = continuation ?? generate(plan, id, false, undefined, f.carried, { checkout: f.target, branch: 'scenario-target', head: f.initial }, f.engineSnapshot);
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
  if (!continuation) {
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
        engine_hash: generated.engine_hash,
        workflow_hash: generated.engine_hash,
        engine_commit: generated.engine_commit,
        engine_snapshot: f.engineSnapshot,
        delivery: { checkout: f.target, branch: 'scenario-target', head: f.initial },
        controller,
      })
    );
  }
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
      if (f.spec.id === 'S17' && node.context) delete node.context;
      const group = node.loop_group as { nodes?: Array<Record<string, unknown>> } | undefined;
      if (group?.nodes) routeAi(group.nodes);
    }
  };
  routeAi(raw.nodes);
  if (stopAfter !== undefined) {
    const integration = raw.nodes.find(node => node.id === 'integrate-m1');
    const group = integration?.loop_group as Record<string, unknown> | undefined;
    expect(group).toMatchObject({
      max_iterations: 3,
      until_bash: untilStatus({ id: 'publish-m1', conditional: false } as const, 'published'),
    });
    expect(group).not.toHaveProperty('interactive');
    const last = raw.nodes.findIndex(node => node.id === stopAfter);
    if (last < 0) throw new Error(`focused scenario missing ${stopAfter}`);
    raw.nodes = raw.nodes.slice(0, last + 1);
  }
  const workflow = makeTestResolvedWorkflow({
    name: generated.workflow,
    description: raw.description,
    provider: descriptor.id,
    nodes: raw.nodes,
  });
  const stateDir = join(f.root, 'state'),
    logDir = join(f.root, 'logs'),
    artifactsDir = join(f.archonHome, 'artifacts', 'runs', id);
  for (const path of [stateDir, logDir, artifactsDir]) mkdirSync(path, { recursive: true });
  await store.updateWorkflowRun(id, { output_root: f.archonHome });
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
    runId: id,
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

export const runGateContract = (f: ScenarioFixture) => runInProcess(f, undefined, 'gate-m1-r1');

export type ScenarioResult = Awaited<ReturnType<typeof runInProcess>>;
export type ScenarioEvidence = Pick<
  ScenarioResult,
  'runId' | 'artifactsDir' | 'events' | 'terminal'
>;

export async function recoverCarriedScenario(
  spec: ScenarioSpec,
  terminal: 'failed' | 'cancelled' = 'failed'
) {
  const scratch = tmp(),
    ready = join(scratch, 'ready.json'),
    marker = join(scratch, 'blocked'),
    root = realpathSync(join(import.meta.dir, '../../..')),
    currentSnapshot = join(scratch, 'engine-current'),
    oldSnapshot = join(scratch, 'engine-a');
  cpSync(root, currentSnapshot, {
    recursive: true,
    filter: copyableFixtureEntry,
  });
  sh(
    'git init -q -b 2.0.0 && git config user.name scenario && git config user.email scenario@local && git add packages wetamp package.json bun.lock && git commit -qm engine-current',
    currentSnapshot
  );
  writeFileSync(join(currentSnapshot, '.git/info/exclude'), '*\n');
  cpSync(currentSnapshot, oldSnapshot, { recursive: true, filter: copyableFixtureEntry });
  sh(
    'git init -q -b 1.0.0 && git config user.name scenario && git config user.email scenario@local && printf "\\nA\\n" >> wetamp/templates/brief.md && git add packages wetamp package.json bun.lock && git commit -qm engine-A',
    oldSnapshot
  );
  writeFileSync(join(oldSnapshot, '.git/info/exclude'), '*\n');
  for (const snapshot of [currentSnapshot, oldSnapshot]) {
    symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'));
    symlinkSync(join(root, 'wetamp/node_modules'), join(snapshot, 'wetamp/node_modules'));
    for (const name of readdirSync(join(root, 'packages')))
      if (existsSync(join(root, 'packages', name, 'node_modules')))
        symlinkSync(
          join(root, 'packages', name, 'node_modules'),
          join(snapshot, 'packages', name, 'node_modules')
        );
  }
  const child = Bun.spawn(
    [process.execPath, 'test', join(oldSnapshot, 'wetamp/tests/scenarios/detached-runner.ts')],
    {
      env: {
        ...process.env,
        SCENARIO_ID: spec.id,
        SCENARIO_PASS_ROUND: String(spec.passRound),
        SCENARIO_RISK: spec.risk,
        SCENARIO_ENGINE_SNAPSHOT: oldSnapshot,
        SCENARIO_RESULT: join(scratch, 'unused.json'),
        SCENARIO_READY: ready,
        SCENARIO_BLOCK_AFTER_COMPLETED_NODE: 'diff-m1-r2',
        SCENARIO_BLOCK_MARKER: marker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  trackTestChild(child);
  for (const end = Date.now() + 60_000; !existsSync(marker) && Date.now() < end; ) {
    if (child.exitCode !== null)
      throw new Error(
        `scenario executor exited: ${(await new Response(child.stdout).text()).slice(-2000)} ${(await new Response(child.stderr).text()).slice(-2000)}`
      );
    await Bun.sleep(25);
  }
  if (!existsSync(marker)) {
    child.kill('SIGKILL');
    await child.exited;
    throw new Error(
      `scenario executor marker timeout: ${(await new Response(child.stdout).text()).slice(-2000)} ${(await new Response(child.stderr).text()).slice(-2000)}`
    );
  }
  child.kill('SIGKILL');
  await child.exited;
  const state = JSON.parse(readFileSync(ready, 'utf8')) as Pick<
      ScenarioFixture,
      'root' | 'home' | 'archonHome' | 'target' | 'worker'
    > & { runId: string },
    saved = { ...process.env };
  Object.assign(process.env, {
    HOME: state.home,
    SUPERAGENT_HOME: state.home,
    ARCHON_HOME: state.archonHome,
  });
  resetDatabase();
  try {
    await failWorkflowRun(state.runId, 'scenario executor crashed', {
      exitReason: 'unhandled_error',
    });
    if (terminal === 'cancelled') await cancelWorkflowRun(state.runId);
    const sha = sh('git rev-parse HEAD', currentSnapshot).trim(),
      engine = join(state.home, 'engine'),
      oldEngineHash = loadLedger(state.runId).workflow_hash;
    mkdirSync(join(engine, 'receipts'), { recursive: true });
    symlinkSync(currentSnapshot, join(engine, sha));
    symlinkSync(join(engine, sha), join(engine, 'current'));
    writeFileSync(
      join(engine, 'receipts', `${sha}.json`),
      JSON.stringify({ sha, at: new Date().toISOString(), protocol_version: 1 })
    );
    const old = loadLedger(state.runId),
      who = coordination.caller();
    old.controller = coordination
      .coord()
      .claim(
        coordination.runScope({ run_id: state.runId, repo: state.target }),
        who,
        true,
        'scenario recovery'
      ).controller;
    coordination
      .coord()
      .claim(coordination.repoScope(state.target), who, true, 'scenario recovery');
    expect(old.engine_snapshot).toBe(oldSnapshot);
    expect(oldEngineHash).not.toBeUndefined();
    old.engine_hash = engineHash();
    old.workflow_hash = old.engine_hash;
    writeFileSync(join(old.gen_dir, 'hints', 'p.md'), 'retry hint\n');
    mkdirSync(join(old.gen_dir, 'attempts'), { recursive: true });
    writeFileSync(join(old.gen_dir, 'attempts', 'm1'), '0\n');
    mkdirSync(join(old.gen_dir, 'approvals'), { recursive: true });
    writeFileSync(join(old.gen_dir, 'approvals', 'verify-p.json'), '{"approved":true}\n');
    coordination.coord().reauthorize(old, who);
    writeFileSync(ledgerPath(state.runId), JSON.stringify(old));
    rmSync(oldSnapshot, { recursive: true, force: true });
    const adoptedId = `adopted-${terminal}-${state.runId}`,
      wrapper = join(scratch, 'archon-adopt'),
      resultPath = join(scratch, `${terminal}.json`),
      runnerLog = join(scratch, `${terminal}.log`),
      launcherPreload = join(scratch, 'launcher.cjs');
    writeFileSync(
      launcherPreload,
      `require(${JSON.stringify(join(currentSnapshot, 'wetamp/hooks/live.cjs'))}).launcher = () => (${JSON.stringify(who)});\n`
    );
    writeFileSync(
      wrapper,
      `#!/bin/sh
set -eu
if [ "$1 $2" = "workflow run" ]; then
  workflow=$3; from=$5; source=$7
  (sleep 1; SCENARIO_ADOPTED_ID=${adoptedId} SCENARIO_ADOPT_FROM="$from" SCENARIO_WORKFLOW_SOURCE="$source" SCENARIO_WORKFLOW="$workflow" SCENARIO_RESUME_STATE=${ready} SCENARIO_RESULT=${resultPath} ${process.execPath} test ${join(currentSnapshot, 'wetamp/tests/scenarios/detached-runner.ts')}) >${runnerLog} 2>&1 &
  printf '{"ok":true,"runId":"%s"}\n' '${adoptedId}'
  exit 0
fi
exec ${join(currentSnapshot, 'wetamp/bin/archon')} "$@"
`
    );
    sh(`chmod +x '${wrapper}'`, scratch);
    process.env.SA_ARCHON_BIN = wrapper;
    const resumed = Bun.spawnSync(
      [join(currentSnapshot, 'wetamp/bin/superagent-shim'), 'resume', state.runId],
      {
        env: {
          ...process.env,
          BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${launcherPreload}`.trim(),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 240_000,
      }
    );
    expect(resumed.exitCode, resumed.stdout.toString() + resumed.stderr.toString()).toBe(0);
    for (const end = Date.now() + 240_000; !existsSync(resultPath) && Date.now() < end; )
      await Bun.sleep(25);
    expect(existsSync(resultPath), readFileSync(runnerLog, 'utf8').slice(-4000)).toBeTrue();
    const adopted = loadLedger(state.runId),
      f: ScenarioFixture = {
        ...state,
        initial: sh('git rev-parse scenario-target', state.target).trim(),
        saved: { ...process.env },
        roles: [],
        spec,
      };
    const store = createWorkflowStore(),
      persisted = await store.getWorkflowRun(adoptedId);
    const result: ScenarioEvidence = {
      runId: adoptedId,
      artifactsDir: join(state.archonHome, 'artifacts', 'runs', adoptedId),
      events: await store.listWorkflowEvents(adoptedId),
      terminal: {
        completed: persisted?.status === 'completed' ? [adoptedId] : [],
        failed: persisted?.status === 'failed' ? [adoptedId] : [],
      },
    };
    if (process.env.SCENARIO_EXPECT_CARRIED_MUTATION === '1')
      console.error(
        JSON.stringify(
          result.events.map(event => ({
            nodeId: event.step_name,
            ...(event.data?.reason === 'when_condition' ? { when: event.data.cause } : {}),
          }))
        )
      );
    return {
      f,
      result,
      adopted,
      oldSnapshot,
      root: currentSnapshot,
      oldGenDir: old.gen_dir,
      originalRunId: state.runId,
    };
  } finally {
    resetDatabase();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** Continue a killed scenario from the real store snapshot; completed nodes stay rehydrated. */
export async function resumeInProcess(f: ScenarioFixture): Promise<ScenarioEvidence> {
  Object.assign(process.env, {
    HOME: f.home,
    SUPERAGENT_HOME: f.home,
    ARCHON_HOME: f.archonHome,
  });
  const id = f.runId ?? `5ce0-${f.spec.id.slice(1).padStart(4, '0')}`,
    generatedDir = join(f.home, 'gen', id),
    workflowName = `sa-${id}`,
    store = createWorkflowStore(),
    candidate = await store.getWorkflowRun(id);
  if (!candidate) throw new Error(`scenario run ${id} missing during resume`);
  const snapshot = await store.getDagResumeSnapshot(id);
  const run = await store.resumeWorkflowRun(id);
  const d = deps(store, scriptedProvider(f));
  const raw = Bun.YAML.parse(
    readFileSync(
      join(generatedDir, '.archon/workflows', workflowName, `${workflowName}.yaml`),
      'utf8'
    )
  ) as { description?: string; nodes: Array<Record<string, unknown>> };
  const routeAi = (nodes: Array<Record<string, unknown>>): void => {
    for (const node of nodes) {
      if (node.command || node.prompt) {
        node.provider = descriptor.id;
        delete node.model;
      }
      if (f.spec.id === 'S17' && node.context) delete node.context;
      const group = node.loop_group as { nodes?: Array<Record<string, unknown>> } | undefined;
      if (group?.nodes) routeAi(group.nodes);
    }
  };
  routeAi(raw.nodes);
  const workflow = makeTestResolvedWorkflow({
    name: workflowName,
    description: raw.description,
    provider: descriptor.id,
    nodes: raw.nodes,
  });
  const artifactsDir = join(f.archonHome, 'artifacts', 'runs', id);
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
    stateDir: join(f.root, 'state'),
    logDir: join(f.root, 'logs'),
    baseBranch: 'scenario-target',
    docsDir: 'docs/',
    config: d.config,
    workflowSourceRoots: liveSourceRoots(generatedDir),
    priorCompletedNodes: snapshot.completedNodeOutputs,
  });
  const persisted = await store.getWorkflowRun(id);
  return {
    runId: id,
    artifactsDir,
    events: await store.listWorkflowEvents(id),
    terminal: {
      completed: persisted?.status === 'completed' ? [id] : [],
      failed: persisted?.status === 'failed' ? [id] : [],
    },
  };
}

/** Exercise the public retry command while the real scenario store remains the execution owner. */
export function retryScenario(
  f: ScenarioFixture,
  result: ScenarioEvidence,
  options: { package?: boolean } = {}
): string {
  const ledger = loadLedger(result.runId);
  const states = new Map<string, 'completed' | 'failed'>();
  for (const event of result.events)
    if (
      event.step_name &&
      (event.event_type === 'node_completed' || event.event_type === 'node_failed')
    )
      states.set(event.step_name, event.event_type === 'node_failed' ? 'failed' : 'completed');
  const view: RunView = {
    id: result.runId,
    status: 'failed',
    working_path: f.worker,
    output_root: f.archonHome,
    nodes: [...states].map(([nodeId, state]) => ({ nodeId, state })),
  };
  const original = archonModule.archon;
  const identity = spyOn(coordination, 'caller').mockReturnValue(ledger.controller!);
  const stub = spyOn(archonModule, 'archon').mockImplementation((args, cwd, intent, timeout) =>
    args[0] === 'workflow' && args[1] === 'get'
      ? { code: 0, out: JSON.stringify(view), err: '' }
      : args[0] === 'workflow' && args[1] === 'resume'
        ? { code: 0, out: JSON.stringify({ ok: true, runId: result.runId }), err: '' }
        : original(args, cwd, intent, timeout)
  );
  try {
    const state = classifyRun(ledger, view).state;
    const args =
      options.package === false
        ? ['decide', result.runId, 'retry']
        : ['decide', result.runId, 'retry', '--pkg', 'p', '--hint', 'close findings'];
    expect(main(args)).toBe(0);
    return state;
  } finally {
    stub.mockRestore();
    identity.mockRestore();
  }
}

export function expectOutcome(
  f: ScenarioFixture,
  result: ScenarioEvidence,
  spec: { terminal: 'completed' | 'failed'; counts: Record<string, number>; published: boolean }
): void {
  const id = result.runId;
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
  } else
    expect(sh('git rev-parse scenario-target', f.target).trim()).toBe(
      f.targetAfterInjection ?? f.initial
    );
}

export function completedOutput(result: ScenarioEvidence, node: string): Record<string, unknown> {
  const event = result.events.find(
    value => value.event_type === 'node_completed' && value.step_name === node
  );
  expect(event, `${node} did not complete`).toBeDefined();
  const output =
    event?.data?.structured_output ??
    (typeof event?.data?.node_output === 'string' ? JSON.parse(event.data.node_output) : undefined);
  expect(output && typeof output === 'object').toBeTrue();
  return output as Record<string, unknown>;
}

export function expectPublishedGate(result: ScenarioEvidence, round: number): void {
  expectGate(result, round);
  expect(
    JSON.parse(readFileSync(join(result.artifactsDir, 'publish-m1.json'), 'utf8'))
  ).toMatchObject({ status: 'published' });
}

export function expectGate(result: ScenarioEvidence, round: number): void {
  const output = completedOutput(result, `gate-m1-r${String(round)}`);
  const file = join(result.artifactsDir, `gate-m1-r${String(round)}.json`);
  expect(output.artifact_sha256).toBe(
    new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex')
  );
}
