import { admitExecution, resumeExecution } from '@archon/workflows/execution-lifecycle';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as coordModule from '../src/coord';
import * as launcherModule from '../src/launcher';
import * as relay from '../src/relay-quota';
import * as saCheck from '../templates/.archon/scripts/sa-check';
import { Database } from 'bun:sqlite';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as archonMod from '../src/archon';
import * as cliMod from '../src/cli';
import * as gcMod from '../src/gc';
import type { RunView } from '../src/archon';
import {
  classify,
  classifyRun,
  decisionQuestion,
  EXIT,
  EXIT_ALIAS_DRIFT,
  EXIT_USAGE,
  HOLD_POLICY,
  ledgerPath,
  loadLedger,
  maintenanceTick,
  main,
  parseArgs,
  quickPlan,
  superviseTickCli,
  updateLedger,
  waitForRunAdmission,
  waitRun,
  type Hold,
  type Ledger,
  type Policy,
} from '../src/cli';
import { gitHead, renderAliases, loadTiers, resolveRoute, WETAMP } from '../src/config';
import { redact } from '../src/redact';
import { buildWorkflow, engineHash, generate, renderBrief } from '../src/generate';
import { capsOf, loadPlan, milestones, type Plan } from '../src/plan';
import { detailOf, redact as boardRedact } from '../src/board/detail';
import { rowOf, type Snapshot } from '../src/board/data';
import { fixturePlan, gitRepo, sh, tmp } from './helpers';
import { fixtureArchon, fixtureOptions } from './fixtures/archon-stub';
import { nativeSpawnSync } from './preload';
import { continuationOnCurrent } from '../src/engine';
import { Reclaimer, reclaimTick } from '../src/reclaim';

const req = createRequire(import.meta.url);
const generatorModule = req('../src/generate.ts') as typeof import('../src/generate');
const realGenerate = generate;
const fastGenerate = (...args: Parameters<typeof generate>): ReturnType<typeof generate> => {
  const [plan, run, fake = false, previousHash, carried, delivery, engineSnapshot, routingState] =
    args;
  const dir = join(process.env.SUPERAGENT_HOME!, 'gen', run);
  const workflow = `sa-${run}`;
  const archon = join(dir, '.archon');
  if (previousHash !== undefined) {
    if (existsSync(archon)) renameSync(archon, `${archon}.old`);
    rmSync(join(dir, 'review-checkpoints'), { recursive: true, force: true });
  }
  const workflowDir = join(archon, 'workflows', workflow);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, `${workflow}.yaml`),
    Bun.YAML.stringify(
      buildWorkflow(
        plan,
        milestones(plan),
        run,
        dir,
        fake,
        Date.now(),
        loadTiers(),
        carried,
        delivery,
        engineSnapshot,
        routingState
      )
    )
  );
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'engine.json'), JSON.stringify({ fake }));
  return {
    dir,
    workflow,
    config: join(dir, 'run-config.yaml'),
    engine_hash: engineHash(),
    engine_commit: 'a'.repeat(40),
  };
};
const engineRecoverLock = () => {
  const root = join(process.env.ARCHON_HOME ?? '', 'execution-admissions');
  mkdirSync(root, { recursive: true });
  return archonMod.lock(join(root, 'r.lock'));
};
const BIN = join(import.meta.dir, '..', 'bin', 'superagent');
const fixtureDecision = (
  kind: 'advance' | 'debt' | 'repair' | 'block',
  reason: string | null = null
) => ({
  kind,
  reason,
  evidence: [],
  debt: [],
});
let engineBoundary: ReturnType<typeof spyOn<typeof coordModule, 'cleanEngine'>> | undefined;
const cleanEngine = coordModule.cleanEngine;
const isolatedEnvKeys = [
  'BUN_OPTIONS',
  'SUPERAGENT_MEMORY',
  'GIT_CONFIG_GLOBAL',
  'SA_ARCHON_BIN',
  'SA_ENGINE_AUTO_PROMOTE',
  'SA_SUPERVISOR',
  'SUPERAGENT_WRITE_ROOTS',
  'AGENT_SUPERVISOR_STATE',
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
] as const;
const originalEnv = Object.fromEntries(isolatedEnvKeys.map(key => [key, process.env[key]]));
beforeEach(() => {
  // Scratch commits must not execute the operator's unrelated global Git hooks
  // or signing setup. Repository-local configuration still applies.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
});
const fixtureSpies: { mockRestore(): void }[] = [];
let fixtureCaller: ReturnType<typeof coordModule.caller> | undefined;
const restoreFixtures = (): void => {
  for (const spy of fixtureSpies.splice(0).reverse()) spy.mockRestore();
};
afterEach(() => {
  restoreFixtures();
  for (const key of isolatedEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  engineBoundary?.mockRestore();
  engineBoundary = undefined;
});
const run = (status: RunView['status'], extra: Partial<RunView> = {}): RunView => ({
  id: 'r',
  status,
  ...(status === 'running'
    ? { metadata: { execution_owner: { host: hostname(), pid: process.pid } } }
    : {}),
  ...extra,
});

describe('P3 engine lifecycle contracts', () => {
  test('run admission waits for capacity and returns a typed timeout', () => {
    let elapsed = 0,
      attempts = 0;
    fixtureSpies.push(
      spyOn(cliMod.waitClock, 'now').mockImplementation(() => elapsed),
      spyOn(cliMod.waitClock, 'sleep').mockImplementation(ms => {
        elapsed += ms;
      })
    );
    const admit = (): ReturnType<typeof archonMod.admitRun> =>
      ++attempts === 3
        ? { ok: true, active: 0, launch: () => ({}), release: () => {} }
        : { ok: false, reason: 'admission_busy' };
    expect(waitForRunAdmission(admit)).toMatchObject({ ok: true });
    expect(waitForRunAdmission(() => ({ ok: false, reason: 'admission_busy' }))).toEqual({
      ok: false,
      reason: 'admission_timeout',
    });
    expect(waitForRunAdmission(() => ({ ok: false, reason: 'launch_reserved' }))).toEqual({
      ok: false,
      reason: 'launch_reserved',
    });
  });
  test('delivery defaults: concurrent admission launches exactly once and pending work retains capacity', () => {
    const root = tmp();
    let active = 0,
      launches = 0;
    const host = {
      root,
      inspectProcess: () => ({ state: 'unknown' as const }),
      countActive: () => active,
      launch: () => {
        launches++;
        active++;
        return { ok: true };
      },
    };
    const first = admitExecution(host);
    expect(first.ok).toBe(true);
    expect(admitExecution(host)).toMatchObject({ ok: false, reason: 'admission_busy' });
    if (!first.ok) throw new Error('admission refused');
    first.launch(['workflow', 'run']);
    first.release();
    expect(admitExecution(host)).toMatchObject({ ok: false, reason: 'launch_reserved' });
    expect(launches).toBe(1);
  });
  test('delivery defaults: live or unknown execution owners never reach claim or dispatch', () => {
    for (const state of ['online', 'unknown'] as const) {
      let writes = 0;
      const result = resumeExecution(
        {
          root: tmp(),
          inspectProcess: () => (state === 'online' ? { state, start: '2026-01-01' } : { state }),
          getRun: () =>
            run('running', {
              metadata: { execution_owner: { host: hostname(), pid: process.pid } },
            }),
          liveOwnerAnswering: () => true,
          claimInterrupted: () => {
            writes++;
            return true;
          },
          launch: () => {
            writes++;
            return { code: 0, out: '{"ok":true}', err: '' };
          },
          parseAck: JSON.parse,
        },
        'r'
      );
      expect(result.ok).toBe(false);
      expect(writes).toBe(0);
    }
  });
  test('native delivery approval uses engine approve and preserves signoff classification', () => {
    const s = stub([run('paused', { metadata: { approval: { nodeId: 'human-m1' } } })]);
    writeFileSync(join(s.ledger.gen_dir, 'plan.json'), JSON.stringify({ deadline: '2099-01-01' }));
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(0);
    expect(s.calls()).toContain('workflow approve r --detach --json');
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
  });
});

describe('redact (shared redact (cli and board))', () => {
  test('board re-exports the shared implementation and redacts the corpus identically', () => {
    expect(boardRedact).toBe(redact);
    const corpus = [
      'Authorization: Bearer abc.def\ntoken=xyz123 "api_key": "s3cr3t" PASSWORD=hunter2 ok=1',
      'Authorization: ApiKey synthetic_credential',
      'password="alpha beta"',
      "secret='a b'",
      '{"api_key":"k k"}',
      '"token":"a \\"b\\" c" tail',
      '{"h":"Authorization: Basic zz\\"q","n":1}',
      'run Bearer abc.def now',
      'worker spawn failed: client_secret=x; refresh-token: y, plain text',
    ];
    expect(corpus.map(redact)).toEqual(corpus.map(boardRedact));
  });
});

test('plan check validates without dispatch or launch-failure writes', () => {
  const s = stub([]),
    repo = gitRepo(s.root);
  const path = fixturePlan(s.root, repo);
  const failures = join(s.root, 'home', 'launch-failures');
  mkdirSync(failures, { recursive: true });
  writeFileSync(join(failures, 'existing.json'), '{}');
  const invoke = (args: string[] = []) =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '../src/cli.ts'), 'plan', 'check', path, ...args],
      {
        env: { ...process.env, SUPERAGENT_WRITE_ROOTS: s.root },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  const valid = invoke();
  expect(valid.exitCode).toBe(0);
  expect(JSON.parse(valid.stdout.toString())).toMatchObject({
    ok: true,
    plan_lint: { rejected: false },
  });
  mkdirSync(join(repo, '.superagent'));
  writeFileSync(
    join(repo, '.superagent/rules.json'),
    JSON.stringify({
      frozen: ['core.txt'],
      required_checks: [{ when: ['core.txt'], check: { cmd: 'required', timeout_s: 1 } }],
    })
  );
  expect(invoke().stderr.toString()).toContain('intersects frozen path');
  process.env.SUPERAGENT_MEMORY = 'on';
  const episodes = join(s.root, 'home/memory/episodes');
  mkdirSync(episodes, { recursive: true });
  // prettier-ignore
  for (let i = 0; i < 3; i++)
    writeFileSync(join(episodes, `repeat-${i}.json`), JSON.stringify({ id: `repeat-${i}`,
      project: repo, reasons: ['ruler_invalid'], at: new Date().toISOString() }));
  expect(invoke().stderr.toString()).toContain('acceptance 3 次');
  const overridden = invoke(['--lint-override', 'approved exception']);
  expect(overridden.exitCode).toBe(0);
  expect(JSON.parse(overridden.stdout.toString())).toMatchObject({
    rules_added: 1,
    plan_lint: { rejected: false, override: 'approved exception' },
  });
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.packages[0].goal = 'x'.repeat(2001);
  writeFileSync(path, JSON.stringify(plan));
  const invalid = invoke();
  expect(invalid.exitCode).not.toBe(0);
  let schemaError = '';
  try {
    loadPlan(path);
  } catch (e) {
    schemaError = (e as Error).message;
  }
  expect(schemaError).toContain('2000');
  expect(invalid.stderr.toString()).toContain(schemaError);
  expect(readdirSync(failures)).toEqual(['existing.json']);
  expect(readFileSync(join(failures, 'existing.json'), 'utf8')).toBe('{}');
  expect(s.calls()).toEqual([]);
});

test('plan precheck blocking ignores lint override', () => {
  const s = stub([]),
    repo = gitRepo(s.root),
    path = fixturePlan(s.root, repo);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.packages[0].accept = [{ cmd: 'bun test missing.test.ts', timeout_s: 1 }];
  writeFileSync(path, JSON.stringify(plan));
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, '../src/cli.ts'),
      'plan',
      'check',
      path,
      '--lint-override',
      'cannot bypass precheck',
    ],
    { env: { ...process.env, SUPERAGENT_WRITE_ROOTS: s.root }, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('base_ref 不存在 missing.test.ts');
  expect(s.calls()).toEqual([]);
});

describe('quick', () => {
  test('delivery defaults: validated quick plan resolves git defaults without an implicit deadline', () => {
    const root = tmp(),
      repo = gitRepo(root);
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_WRITE_ROOTS'] as const;
    const saved = keys.map(k => process.env[k]);
    const cwd = process.cwd();
    try {
      Object.assign(process.env, {
        SUPERAGENT_HOME: join(root, 'sa'),
        ARCHON_HOME: join(root, 'archon'),
        SUPERAGENT_WRITE_ROOTS: root,
      });
      mkdirSync(join(repo, 'src'));
      process.chdir(join(repo, 'src'));
      const path = quickPlan(
        parseArgs([
          'quick',
          '--goal',
          'deliver',
          '--accept',
          'true',
          '--accept',
          'echo ok',
          '--request-ref',
          'urgent-1015',
        ])
      );
      expect(path.startsWith(join(root, 'sa', 'plans', 'quick-'))).toBe(true);
      const plan = loadPlan(path);
      expect(plan.request_ref).toBe('urgent-1015');
      const rawPlan = JSON.parse(readFileSync(path, 'utf8'));
      expect(rawPlan.request_ref).toBe('urgent-1015');
      expect(rawPlan).not.toHaveProperty('environment');
      expect(plan.repo).toBe(repo);
      expect(plan.base_ref).toBe('main');
      expect(plan.budget).toEqual({ weighted_tokens: 0, unlimited_tokens: true });
      expect(plan.deadline).toBeUndefined();
      expect(plan.environment).toBeUndefined();
      expect(() =>
        buildWorkflow(
          plan,
          milestones(plan),
          'quick-defaults',
          '/GEN',
          false,
          Date.now() + 48 * 3600_000
        )
      ).not.toThrow();
      expect(plan.packages).toHaveLength(1);
      expect(plan.packages[0]).toMatchObject({
        id: 'quick',
        title: 'deliver',
        goal: 'deliver',
        size: 'S',
        risk: 'G1',
        scope: { write: ['**/*'] },
      });
      expect(plan.packages[0].accept).toEqual([
        { cmd: 'true', timeout_s: 900, cache: true },
        { cmd: 'echo ok', timeout_s: 900, cache: true },
      ]);
      expect(milestones(plan)).toHaveLength(1);
      const explicit = loadPlan(
        quickPlan(
          parseArgs([
            'quick',
            '--goal',
            'explicit',
            '--accept',
            'true',
            '--environment',
            'bun install --frozen-lockfile',
            '--environment',
            'bun run prepare',
            '--accept-timeout',
            '120',
            '--no-cache',
            '--repo',
            repo,
            '--base',
            'HEAD',
            '--scope',
            'src/**',
            '--scope',
            'tests/**',
            '--risk',
            'G2',
            '--review',
            '--json',
          ])
        )
      );
      expect(explicit.base_ref).toBe('HEAD');
      expect(explicit.packages[0]).toMatchObject({
        risk: 'G2',
        review: true,
        scope: { write: ['src/**', 'tests/**'] },
      });
      expect(explicit.packages[0].accept[0]).toHaveProperty('cache', false);
      expect(explicit.environment).toEqual([
        { cmd: 'bun install --frozen-lockfile', timeout_s: 120 },
        { cmd: 'bun run prepare', timeout_s: 120 },
      ]);
    } finally {
      process.chdir(cwd);
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
  test('card snapshots full instructions and reuses the strict six-round workflow', () => {
    const root = tmp(),
      repo = gitRepo(root),
      card = join(root, 'card.md');
    const keys = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_WRITE_ROOTS'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, {
      SUPERAGENT_HOME: join(root, 'sa'),
      ARCHON_HOME: join(root, 'archon'),
      SUPERAGENT_WRITE_ROOTS: root,
    });
    const brief =
      '# Task\nProblem, why now, outcome, invariants and acceptance.\n' +
      'Long context. '.repeat(2000);
    writeFileSync(card, brief);
    const args = [
      'quick',
      '--card',
      card,
      '--repo',
      repo,
      '--base',
      'HEAD',
      '--accept',
      'true',
      '--accept-timeout',
      '120',
      '--console',
      'codex',
      '--review',
    ];
    try {
      const path = quickPlan(parseArgs(args));
      writeFileSync(card, 'changed later');
      const plan = loadPlan(path, [root]);
      expect(plan.packages[0].notes).toBe(brief);
      expect(plan.packages[0].goal).toContain('card.md');
      expect(renderBrief(plan.packages[0], '', capsOf(plan, plan.packages[0]))).toContain(brief);
      expect(plan.packages[0].title).toBe('card.md');
      expect(plan.packages[0].accept[0].timeout_s).toBe(120);
      expect(plan.console).toBe('codex');
      expect(plan.mode).toBe('strict');
      expect(milestones(plan)[0].review).toBe(true);
      const workflow = buildWorkflow(plan, milestones(plan), 'card', '/GEN', true);
      expect(JSON.stringify(workflow)).toContain('gate-m1-r6');
      expect(JSON.stringify(workflow)).not.toContain('gate-m1-r7');
      expect(() => quickPlan(parseArgs([...args, '--goal', 'conflicting']))).toThrow('not both');
      for (const timeout of ['0', '-1', '1.5', 'NaN', 'Infinity', ''])
        expect(() => quickPlan(parseArgs([...args, '--accept-timeout', timeout]))).toThrow(
          '--accept-timeout'
        );
      expect(() => quickPlan(parseArgs([...args, '--console', 'other']))).toThrow('--console');
      writeFileSync(card, ' ');
      expect(() => quickPlan(parseArgs(args))).toThrow('non-empty');
      expect(() => quickPlan(parseArgs([...args, '--card', join(root, 'missing')]))).toThrow();
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
  test('missing or empty arguments fail before launch; help advertises quick', () => {
    for (const args of [
      [],
      ['--accept', 'true'],
      ['--goal', 'x'],
      ['--goal', ' ', '--accept', 'true'],
      ['--goal', 'x', '--accept', ' '],
    ])
      expect(() => quickPlan(parseArgs(['quick', ...args]))).toThrow(/quick requires/);
    expect(() =>
      quickPlan(parseArgs(['quick', '--goal', 'x', '--accept', 'true', '--risk', 'G3']))
    ).toThrow('--risk');
    expect(() =>
      quickPlan(parseArgs(['quick', '--goal', 'x', '--accept', 'true', '--environment', ' ']))
    ).toThrow('--environment');
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['--help'])).toBe(0);
      expect(cliMod.CLI_COMMAND_USAGE.find(command => command.command === 'quick')?.flags).toEqual(
        expect.arrayContaining(['card', 'environment'])
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('parseArgs', () => {
  test('positionals, --k v, --k=v and boolean flags', () => {
    expect(parseArgs(['wait', 'x', '--timeout', '5', '--pkg=core', '--fake'])).toEqual({
      _: ['wait', 'x'],
      flags: { timeout: '5', pkg: 'core', fake: true },
    });
  });
  test('unknown flags fail instead of being ignored', () => {
    expect(() => parseArgs(['run', 'p.json', '--skip-selftests'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['run', 'p.json', '--skip-selftest'])).toThrow(/Unknown option/);
  });
  test('main: unknown flag exits 64 with usage; --json is an accepted no-op on any verb', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['status', 'x', '--frob'])).toBe(EXIT_USAGE);
      expect(String(err.mock.calls[0]?.[0])).toContain('usage: superagent');
    } finally {
      err.mockRestore();
    }
    expect(parseArgs(['report', '--json']).flags).toEqual({ json: true });
  });
  test('wait --timeout rejects NaN, Infinity and non-positive values with usage (64), before loading the ledger', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const t of ['abc', 'Infinity', '-Infinity', '0', '-5', ''])
        expect(main(['wait', 'no-such-run', '--timeout', t])).toBe(EXIT_USAGE);
      expect(String(err.mock.calls[0]?.[0])).toContain('--timeout must be a positive number');
    } finally {
      err.mockRestore();
    }
  });
});

describe('classify', () => {
  test('completed → 0', () =>
    expect(classify(run('completed'))).toEqual({ state: 'completed', exit: EXIT.completed }));
  test('cancelled → 2', () => expect(classify(run('cancelled')).exit).toBe(EXIT.cancelled));
  test('paused at sa.human.* → held:human with event', () => {
    const c = classify(
      run('paused', {
        metadata: {
          wait: { nodeId: 'human-m1', kind: 'event', event: 'sa.human.m1', resumeAt: 't' },
        },
      })
    );
    expect(c).toEqual({
      state: 'held:human',
      exit: EXIT.held,
      node: 'human-m1',
      event: 'sa.human.m1',
    });
  });
  test('paused after a native signoff rejection → held:rework', () => {
    const approval = { nodeId: 'human-m1', resolved: 'rejected' } as NonNullable<
      NonNullable<RunView['metadata']>['approval']
    >;
    expect(classify(run('paused', { metadata: { approval } }))).toEqual({
      state: 'held:rework',
      exit: EXIT.held,
      node: 'human-m1',
    });
  });
  test('paused elsewhere → held:paused', () =>
    expect(classify(run('paused')).state).toBe('held:paused'));
  test('failed environment → held:environment', () => {
    expect(
      classify(run('failed', { nodes: [{ nodeId: 'environment', state: 'failed' }] })).state
    ).toBe('held:environment');
  });
  test('NO_HOLD failed gate → failed', () => {
    expect(
      classify(
        run('failed', {
          nodes: [
            { nodeId: 'verify-a', state: 'completed' },
            { nodeId: 'gate-m1', state: 'failed' },
          ],
        })
      )
    ).toEqual({ state: 'failed', exit: EXIT.failed, node: 'gate-m1' });
  });
  test('other failure → failed with node', () => {
    expect(classify(run('failed', { nodes: [{ nodeId: 'code-a', state: 'failed' }] }))).toEqual({
      state: 'failed',
      exit: EXIT.failed,
      node: 'code-a',
    });
  });
  test('running with live owner → running', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: hostname(), pid: process.pid } } })
      )
    ).toEqual({ state: 'running', exit: EXIT.running });
  });
  test('running with dead local owner → owner_lost', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: hostname(), pid: 2 ** 22 + 1 } } })
      ).state
    ).toBe('owner_lost');
  });
  test('dead pid on another host is not owner_lost (ownership unknowable)', () => {
    expect(
      classify(
        run('running', { metadata: { execution_owner: { host: 'elsewhere', pid: 2 ** 22 + 1 } } })
      ).state
    ).toBe('held:owner_unknown');
  });
  test('running with no node events yet keeps waiting; a started node makes a missing owner a hold', () => {
    expect(classify(run('running', { metadata: {} }))).toEqual({
      state: 'running',
      exit: EXIT.running,
    });
    expect(
      classify(run('running', { metadata: {}, nodes: [{ nodeId: 'code', state: 'running' }] }))
        .state
    ).toBe('held:owner_unknown');
  });
});

/**
 * archon 桩：get 依次返回 stub/get-<n>.json（最后一份重复）；run 回 runId=r；其余调用回 {"ok":true}；
 * 全部调用记入 calls。cancel/abandon 按引擎契约对桩内当前状态（下一次 get 返回的那份）执行：cancel 只接受
 * running，abandon 拒绝 completed/cancelled，拒绝时与真 CLI 一样回 {"ok":false,"error":<文本>}。
 * ledger 的 gen_dir 含 plan.json（core、api 两包）与 hints/。
 */
function stub(responses: RunView[]): {
  dir: string;
  root: string;
  ledger: Ledger;
  calls: () => string[];
  due: ReturnType<typeof spyOn<typeof archonMod, 'dueWorkflowContinuations'>>;
  gc: ReturnType<typeof spyOn<typeof gcMod, 'gc'>>;
  scratch: ReturnType<typeof spyOn<typeof gcMod, 'scratchClean'>>;
} {
  restoreFixtures();
  fixtureSpies.push(spyOn(launcherModule, 'launcher').mockReturnValue(undefined));
  const root = tmp();
  sh('git init -q -b fixture', root);
  // These tests isolate recovery calls; cleanEngine itself has real dirty/committed fixtures in coord.test.ts.
  engineBoundary?.mockRestore();
  engineBoundary = spyOn(coordModule, 'cleanEngine').mockReturnValue('a'.repeat(40));
  const dir = join(root, 'stub');
  mkdirSync(join(dir, 'used'), { recursive: true });
  responses.forEach((r, i) =>
    writeFileSync(join(dir, `get-${String(i).padStart(3, '0')}.json`), JSON.stringify(r))
  );
  const bin = join(dir, 'archon');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nif [[ "$1 $2" == "workflow runs" ]]; then printf '%s\\n' '{"runs":[]}'; exit 0; fi\nexec '${process.execPath}' '${join(import.meta.dir, 'fixtures/archon-stub.ts')}' '${dir}' "$@"\n`
  );
  chmodSync(bin, 0o755);
  const home = join(root, 'home');
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(home, 'archon'), { recursive: true });
  Object.assign(process.env, {
    // Memory selection/reflection has its own tests; it must not run in CLI control fixtures.
    SUPERAGENT_MEMORY: 'off',
    SA_ARCHON_BIN: bin,
    SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'),
    AGENT_SUPERVISOR_STATE: join(root, 'sv-state'),
  });
  let elapsed = 0;
  const due = spyOn(archonMod, 'dueWorkflowContinuations').mockReturnValue(['r']),
    scratch = spyOn(gcMod, 'scratchClean').mockReturnValue([]),
    gc = spyOn(gcMod, 'gc').mockReturnValue([]);
  fixtureSpies.push(
    // Scratch cleanup has dedicated real-process coverage in scratch.test.ts.
    // Control fixtures must not scan or clean unrelated operator sessions.
    scratch,
    gc,
    spyOn(cliMod.waitClock, 'now').mockImplementation(() => Date.now() + elapsed),
    spyOn(cliMod.waitClock, 'sleep').mockImplementation(ms => {
      elapsed += ms;
    }),
    spyOn(coordModule, 'caller').mockReturnValue((fixtureCaller ??= coordModule.caller())),
    due,
    spyOn(archonMod, 'archon').mockImplementation((args, _cwd, intent) => {
      if (args[1] === 'wait') elapsed += Number(args[args.indexOf('--timeout') + 1]) * 1000;
      if (intent) {
        // The stub launch has no surviving executor, just like its executable entry.
        const reservation = JSON.parse(readFileSync(intent.path, 'utf8'));
        writeFileSync(
          intent.path,
          JSON.stringify({
            ...reservation,
            pid: 2 ** 22 + 1,
            pid_start: 'fixture',
            host: hostname(),
          })
        );
      }
      return fixtureArchon(dir, args);
    }),
    spyOn(archonMod, 'archonDetached').mockImplementation(args => {
      fixtureArchon(dir, args);
      return process.pid;
    })
  );
  const ledger: Ledger = {
    run_id: 'sa1',
    engine_hash: engineHash(),
    archon_run_id: 'r',
    plan: '',
    gen_dir: join(root, 'gen'),
    repo: root,
    branch: 'sa/sa1',
    workflow: 'sa-sa1',
    console: 'claude',
    started_at: '',
    transcript: '',
    log: '',
    recoveries: [],
    controller: coordModule.coord().claim(coordModule.repoScope(root), coordModule.caller())
      .controller,
  };
  writeFileSync(join(home, 'runs', 'sa1.json'), JSON.stringify(ledger));
  mkdirSync(join(root, 'gen', 'hints'), { recursive: true });
  writeFileSync(
    join(root, 'gen', 'plan.json'),
    JSON.stringify({ packages: [{ id: 'core' }, { id: 'api' }] })
  );
  const calls = (): string[] =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
      : [];
  return { dir, root, ledger, calls, due, gc, scratch };
}

function activateEngineFixture(s: ReturnType<typeof stub>): string {
  const snapshot = realpathSync(join(WETAMP, '..')),
    engine = join(s.root, 'home', 'engine');
  mkdirSync(engine, { recursive: true });
  symlinkSync(snapshot, join(engine, 'current'));
  process.env.SA_ENGINE_AUTO_PROMOTE = '0';
  s.ledger.engine_snapshot = snapshot;
  writeFileSync(ledgerPath(s.ledger.run_id), JSON.stringify(s.ledger));
  return snapshot;
}

test('legacy deferred_deliveries is ignored without rewriting the ledger', () => {
  const s = stub([run('completed')]);
  const path = ledgerPath('sa1');
  const historical = JSON.stringify({ ...s.ledger, deferred_deliveries: ['m1'] });
  writeFileSync(path, historical);
  expect(JSON.parse(captured(() => main(['status', 'sa1'])).out)).not.toHaveProperty(
    'deferred_deliveries'
  );
  expect(readFileSync(path, 'utf8')).toBe(historical);
});

describe('HF3 latest-engine recovery', () => {
  const setup = (hash?: string, fastRecovery = true) => {
    const s = stub([run('failed')]);
    fixtureSpies.push(
      spyOn(generatorModule, 'generate').mockImplementation((...args) =>
        args[3] === undefined || fastRecovery ? fastGenerate(...args) : realGenerate(...args)
      )
    );
    const plan = JSON.parse(readFileSync(fixturePlan(s.root, s.root), 'utf8')) as Plan;
    plan.deadline = new Date(Date.now() + 3600_000).toISOString();
    const gen = generate(plan, 'sa1', true);
    s.ledger.gen_dir = gen.dir;
    s.ledger.engine_hash = hash;
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    return s;
  };
  test('same fingerprint resumes without changing the run id', () => {
    const s = setup(engineHash());
    expect(captured(() => main(['resume', 'sa1'])).code).toBe(0);
    expect(s.calls()).toContain('workflow resume r --detach --json');
    expect(loadLedger('sa1').adoptions).toBeUndefined();
  });
  test.each([false, true])(
    'HF10 BestIFA identity overrides legacy UI hash; workflow changed=%s',
    changed => {
      const s = setup('old-ui-hash');
      s.ledger.workflow_hash = changed ? 'old-workflow' : engineHash();
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      expect(captured(() => main(['resume', 'sa1'])).code).toBe(0);
      expect(s.calls().some(c => c.includes('--adopt'))).toBe(changed);
      expect(s.calls().some(c => c.startsWith('workflow resume'))).toBe(!changed);
      expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).engine).toBe('current');
    }
  );
  test('AD: stale terminal runs with completed work adopt and reverify', () => {
    for (const [status, nodeId] of [
      ['failed', 'code-core'],
      ['cancelled', 'fix-m1-r2'],
    ] as const) {
      const s = setup('old', true);
      writeFileSync(
        join(s.dir, 'get-000.json'),
        JSON.stringify(run(status, { nodes: [{ nodeId, state: 'completed' }] }))
      );
      const result = captured(() => main(['resume', 'sa1']));
      expect(result.code).toBe(0);
      expect(loadLedger('sa1').adoptions?.at(-1)).toMatchObject({
        from: 'r',
        to: 'r2',
        carried: [],
      });
      expect(s.calls().some(c => c.includes('--adopt r'))).toBe(true);
      expect(existsSync(join(s.ledger.gen_dir, '.archon.old'))).toBe(true);
    }
  });
  test.each([
    'verify',
    'settle',
    'repair',
    'missing',
    'unrelated',
    'invalid',
    'invalid-settle',
    'settle-repair',
    'no-worktree',
    'coded',
    'coded-dirty',
    'coded-unrelated',
  ])('P2: adoption carries only accepted ancestors (%s)', sample => {
    const s = setup('old');
    const worktree = gitRepo(s.root);
    const head = sh('git rev-parse HEAD', worktree).trim();
    sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm later', worktree);
    const unrelated = sh(
      'git -c user.name=t -c user.email=t@l commit-tree HEAD^{tree} -m unrelated',
      worktree
    ).trim();
    const art = join(s.root, 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    if (sample !== 'missing' && !sample.startsWith('coded'))
      writeFileSync(
        join(art, 'verify-core.json'),
        sample === 'invalid'
          ? '{invalid'
          : JSON.stringify({
              disposition: sample === 'repair' ? 'repair' : 'advance',
              decision: fixtureDecision(sample === 'repair' ? 'repair' : 'advance'),
              head: sample === 'unrelated' ? unrelated : head,
            })
      );
    if (sample === 'settle' || sample === 'invalid-settle' || sample === 'settle-repair') {
      writeFileSync(
        join(art, 'verify-core.json'),
        JSON.stringify({ decision: fixtureDecision('repair'), head })
      );
      if (sample !== 'settle')
        writeFileSync(
          join(art, 'verify-core.json'),
          JSON.stringify({ decision: fixtureDecision('advance'), head })
        );
      writeFileSync(
        join(art, 'settle-core.json'),
        sample === 'invalid-settle'
          ? '{invalid'
          : JSON.stringify({
              decision: fixtureDecision(sample === 'settle-repair' ? 'repair' : 'advance'),
              head,
            })
      );
    }
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(
        run('failed', {
          working_path: sample === 'no-worktree' ? null : worktree,
          output_root: s.root,
          nodes: [
            { nodeId: 'code-core', state: 'completed' },
            ...(sample.startsWith('coded')
              ? [
                  {
                    nodeId: 'verify-core',
                    state: 'failed',
                    execution: {
                      attempt: {
                        checkoutStart: {
                          kind: 'git',
                          sampledAt: new Date().toISOString(),
                          commit: sample === 'coded-unrelated' ? unrelated : head,
                          tree: head,
                          worktree:
                            sample === 'coded-dirty'
                              ? {
                                  status: 'dirty',
                                  content: 'incomplete',
                                  staged: 0,
                                  unstaged: 1,
                                  untracked: 0,
                                }
                              : { status: 'clean' },
                        },
                      },
                    } as never,
                  },
                ]
              : []),
            { nodeId: 'gate-m1-r1', state: 'failed' },
          ],
        })
      )
    );
    writeFileSync(join(s.ledger.gen_dir, 'engine.json'), JSON.stringify({ fake: false }));
    const retry = captured(() => main(['decide', 'sa1', 'retry']));
    expect(retry).toMatchObject({ code: 0 });
    const l = loadLedger('sa1');
    const nodes = (
      Bun.YAML.parse(
        readFileSync(
          join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`),
          'utf8'
        )
      ) as {
        nodes: {
          id: string;
          bash?: string;
          command?: string;
          script?: string;
          when?: string;
          with?: Record<string, unknown>;
        }[];
      }
    ).nodes;
    const code = nodes.find(n => n.id === 'code-core');
    expect(nodes.find(n => n.id === 'verify-core')?.with?.delta_base).toBe(
      '$sync-m1-ready.output.head'
    );
    const carried = sample === 'verify' || sample === 'settle';
    expect(l.adoptions?.at(-1)?.carried).toEqual(carried ? ['core'] : []);
    const coded = sample === 'coded';
    expect(l.adoptions?.at(-1)?.coded).toEqual(coded ? ['core'] : []);
    if (carried || coded) {
      expect(code?.when).toBe("$package-attempt-core.output.attempt != '0'");
      const binding = nodes.find(n => n.id === 'verify-core')?.with?.coder as {
        if_skipped: unknown;
      };
      expect(binding.if_skipped).toMatchObject({
        status: 'done',
        error_class: null,
        notes: `${carried ? 'carried' : 'coded'} from r`,
      });
    } else expect(code?.when).toBeUndefined();
    expect(code?.command).toBe('sa-code');
    expect(nodes.find(n => n.id === 'code-api')?.command).toBe('sa-code');
    expect(nodes.find(n => n.id === 'verify-core')?.script).toBe('sa-check');
    expect(nodes.find(n => n.id === 'repair-core')?.command).toBe('sa-repair');
    expect(nodes.find(n => n.id === 'settle-core')?.script).toBe('sa-check');
    expect(sh('git rev-parse HEAD', worktree).trim()).not.toBe(head);
  });
  test('review checkpoint admission accepts only complete matching evidence', () => {
    const cases: {
      name: string;
      admitted: boolean;
      edit?: (gate: Record<string, unknown>, diff: Record<string, unknown>) => void;
      gateRaw?: string;
      ledgerRaw?: string | null;
      hash?: 'missing' | 'gate' | 'diff';
    }[] = [
      { name: 'advance', admitted: true },
      { name: 'debt', admitted: true, edit: gate => (gate.decision = fixtureDecision('debt')) },
      { name: 'block', admitted: false, edit: gate => (gate.decision = fixtureDecision('block')) },
      { name: 'untrusted-head', admitted: false, edit: gate => (gate.head_trusted = false) },
      {
        name: 'forged-gate',
        admitted: false,
        hash: 'gate',
        edit: (gate, diff) => (gate.reviewed_head = diff.head),
      },
      {
        name: 'diff-head-drift',
        admitted: false,
        edit: (_gate, diff) => (diff.head = 'f'.repeat(40)),
      },
      {
        name: 'forged-diff',
        admitted: false,
        hash: 'diff',
        edit: (_gate, diff) => (diff.contract_hash = 'c'.repeat(64)),
      },
      {
        name: 'invalid-review-hash',
        admitted: false,
        edit: gate => (gate.reviewed_diff_hash = 'not-a-hash'),
      },
      {
        name: 'invalid-contract-hash',
        admitted: false,
        edit: (_gate, diff) => (diff.contract_hash = 'not-a-hash'),
      },
      { name: 'missing-ledger', admitted: false, ledgerRaw: null },
      { name: 'unreadable-gate', admitted: false, gateRaw: '{' },
      { name: 'missing-engine-hash', admitted: false, hash: 'missing' },
    ];
    const s = setup('old'),
      worktree = gitRepo(s.root),
      head = sh('git rev-parse HEAD', worktree).trim(),
      art = join(s.root, 'artifacts', 'runs', 'r'),
      ledger = join(art, 'gate-m1-r1.ledger.json');
    mkdirSync(art, { recursive: true });
    for (const sample of cases) {
      if (sample.ledgerRaw === null) rmSync(ledger, { force: true });
      else writeFileSync(ledger, sample.ledgerRaw ?? '{}');
      const gate: Record<string, unknown> = {
        decision: fixtureDecision('advance'),
        head_trusted: true,
        reviewed_head: sample.hash === 'gate' ? 'f'.repeat(40) : head,
        reviewed_diff_hash: 'd'.repeat(16),
        ledger_file: ledger,
      };
      const diff: Record<string, unknown> = {
        head,
        diff_hash: 'd'.repeat(16),
        contract_hash: sample.hash === 'diff' ? 'e'.repeat(64) : 'c'.repeat(64),
      };
      const originalGate = JSON.stringify(gate),
        originalDiff = JSON.stringify(diff);
      sample.edit?.(gate, diff);
      const gateRaw = sample.gateRaw ?? JSON.stringify(gate),
        diffRaw = JSON.stringify(diff),
        sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex'),
        hashes =
          sample.hash === 'missing'
            ? {}
            : {
                'gate-m1-r1': sha(sample.hash === 'gate' ? originalGate : gateRaw),
                'diff-m1-r1': sha(sample.hash === 'diff' ? originalDiff : diffRaw),
              };
      writeFileSync(join(art, 'gate-m1-r1.json'), gateRaw);
      writeFileSync(join(art, 'diff-m1-r1.json'), diffRaw);
      const result = cliMod.recoveryReviewCheckpoint(
        s.ledger,
        art,
        'gate-m1-r1.json',
        head,
        hashes
      );
      if (sample.hash)
        expect(result?.reason).toBe(
          sample.hash === 'missing' ? 'gate_hash_missing' : `${sample.hash}_hash_mismatch`
        );
      expect(result?.checkpoint !== undefined, sample.name).toBe(sample.admitted);
    }
    const event = (step_name: string, data: Record<string, unknown>) => ({
      event_type: 'node_completed',
      step_name,
      data,
    });
    expect(
      cliMod.recoveryOutputHashes('r', s.root, () => ({
        events: [
          event('gate-m1-r1', { node_output: JSON.stringify({ artifact_sha256: 'a'.repeat(64) }) }),
          event('diff-m1-r1', { structured_output: { artifact_sha256: 'b'.repeat(64) } }),
        ],
      }))
    ).toEqual({ 'gate-m1-r1': 'a'.repeat(64), 'diff-m1-r1': 'b'.repeat(64) });
  });
  test('old ledger adopts with fresh source and preserves runtime files', () => {
    const s = setup(undefined, false);
    const engine = gitRepo(tmp());
    engineBoundary!.mockImplementation(() => cleanEngine(engine));
    const commit = gitHead(engine);
    const historical = readFileSync(ledgerPath('sa1'), 'utf8');
    expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).engine).toBe('stale(unknown)');
    expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(historical);
    expect(loadLedger('sa1').engine_commit).toBeUndefined();
    const dir = s.ledger.gen_dir;
    mkdirSync(join(dir, 'attempts'));
    writeFileSync(join(dir, 'attempts', 'm1'), '7');
    writeFileSync(join(dir, 'budget-extra'), '{"launches":9}');
    const plan = readFileSync(join(dir, 'plan.json'), 'utf8');
    expect(captured(() => main(['resume', 'sa1'])).code).toBe(0);
    expect(s.calls().at(-1)).toBe(
      `workflow run sa-sa1 --adopt r --workflow-source ${dir} --cwd ${s.root} --detach --json`
    );
    const l = loadLedger('sa1');
    expect(l).toMatchObject({
      run_id: 'sa1',
      archon_run_id: 'r2',
      branch: 'sa/sa1',
      engine_hash: engineHash(),
      engine_commit: commit,
    });
    expect(l.recoveries).toHaveLength(0);
    expect(JSON.parse(captured(() => main(['status', 'sa1'])).out)).toMatchObject({
      engine: 'current',
      adoption: { from: 'r', to: 'r2' },
    });
    expect(captured(() => main(['brief', 'sa1'])).out).toContain('adoption:');
    expect(l.adoptions).toEqual([
      expect.objectContaining({
        from: 'r',
        to: 'r2',
        engine_from: null,
        engine_to: engineHash(),
        reason: 'engine_stale',
        engine_commit: commit,
      }),
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'engine.json'), 'utf8')).engine_commit).toBe(commit);
    expect(existsSync(join(dir, '.archon.unknown'))).toBe(true);
    expect(readFileSync(join(dir, 'plan.json'), 'utf8')).toBe(plan);
    expect(readFileSync(join(dir, 'attempts', 'm1'), 'utf8')).toBe('7');
    expect(readFileSync(join(dir, 'budget-extra'), 'utf8')).toBe('{"launches":9}');
    expect(
      readdirSync(join(process.env.SUPERAGENT_HOME ?? '', 'runs')).some(f => f.endsWith('.tmp'))
    ).toBe(false);
  });
  test('stale failed/cancelled adopt; stale paused owner keeps its snapshot', () => {
    for (const status of ['cancelled', 'paused'] as const) {
      const s = setup('old', true);
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(run(status)));
      expect(captured(() => main(['resume', 'sa1'])).code).toBe(0);
      expect(
        s
          .calls()
          .at(-1)
          ?.startsWith(status !== 'paused' ? 'workflow run sa-sa1 --adopt r' : 'workflow resume r')
      ).toBe(true);
    }
  });
  test('busy lock leaves source, attempts, and recovery counters intact', () => {
    const s = setup('old');
    const held = engineRecoverLock();
    if (!held.ok) throw new Error('lock not taken');
    try {
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      const sleep = spyOn(Bun, 'sleepSync').mockImplementation(() => {});
      try {
        expect(() => updateLedger(s.ledger, () => {})).toThrow('execution admission r busy');
      } finally {
        sleep.mockRestore();
      }
      const { out } = captured(() => main(['resume', 'sa1']));
      expect(JSON.parse(out)).toMatchObject({ busy: true });
      expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
      expect(existsSync(join(s.ledger.gen_dir, '.archon.old'))).toBe(false);
      expect(s.calls().some(c => c.includes('--adopt'))).toBe(false);
    } finally {
      held.release();
    }
  });
  test('no-op ledger update does not rewrite the file', () => {
    const s = setup('old'),
      path = ledgerPath(s.ledger.run_id),
      old = new Date(1_000_000);
    utimesSync(path, old, old);
    updateLedger(s.ledger, () => {});
    expect(statSync(path).mtimeMs).toBe(old.getTime());
  });
  test('an unconfirmed adoption does not publish its engine or consume a recovery; repeat launch is held', () => {
    const s = setup('old');
    fixtureOptions(s.dir, { adoptionReply: { ok: false, error: 'fixture refusal' } });
    const before = readFileSync(ledgerPath('sa1'), 'utf8');
    expect(captured(() => main(['resume', 'sa1'])).code).toBe(EXIT.held);
    const { intervention_events, ...unchanged } = loadLedger('sa1');
    expect(unchanged).toEqual(JSON.parse(before));
    expect(intervention_events).toMatchObject([{ action: 'resume', ok: false }]);
    fixtureOptions(s.dir, {});
    expect(captured(() => main(['resume', 'sa1'])).code).toBe(EXIT.held);
    expect(loadLedger('sa1').archon_run_id).toBe('r');
    expect(loadLedger('sa1').recoveries).toHaveLength(0);
    expect(loadLedger('sa1').engine_commit).toBeUndefined();
    expect(loadLedger('sa1').adoptions).toBeUndefined();
    expect(s.calls().filter(c => c.includes('--adopt'))).toHaveLength(1);
  });
});

const humanWait = (resumeAt = '2099-01-01T00:00:00.000Z'): RunView =>
  run('paused', {
    metadata: { wait: { nodeId: 'human-m2', kind: 'event', event: 'sa.human.m2', resumeAt } },
  });

const LOST = { host: hostname(), pid: 2 ** 22 + 1 };
/** archon.db 的 runs 表（只含 recover 读写的列），行 r 处于 running、metadata 记着 owner。 */
function runsDb(owner: { host: string; pid: number }): Database {
  const db = new Database(join(process.env.ARCHON_HOME ?? '', 'archon.db'));
  db.run(
    'create table remote_agent_workflow_runs (id text, status text, metadata text, started_at text)'
  );
  db.run("insert into remote_agent_workflow_runs values ('r', 'running', ?, null)", [
    JSON.stringify({ execution_owner: owner }),
  ]);
  return db;
}

function revisionDb(): Database {
  const db = new Database(join(process.env.ARCHON_HOME ?? '', 'archon.db'));
  db.exec(`create table remote_agent_workflow_runs (id text, status text, last_activity_at text, completed_at text, metadata text);
    create table remote_agent_workflow_events (workflow_run_id text);`);
  db.run("insert into remote_agent_workflow_runs values ('r', 'completed', 'a', 'b', '{}')");
  return db;
}

/** 后台子进程（signal/wake）异步写 calls：轮询到出现为止。 */
async function eventually(calls: () => string[], prefix: string): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    const hit = calls().find(c => c.startsWith(prefix));
    if (hit) return hit;
    await Bun.sleep(50);
  }
  return undefined;
}

/** main() 打印的 stdout 文本。 */
function captured(fn: () => number): { code: number; out: string } {
  const spy = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const code = fn();
    return { code, out: spy.mock.calls.map(c => String(c[0])).join('\n') };
  } finally {
    spy.mockRestore();
  }
}
const featureRepo = (root: string): string => {
  const repo = gitRepo(root);
  sh('git switch -qc feature/fixture', repo);
  return repo;
};

describe('waitRun (archon stub)', () => {
  test('terminal status and wait expose non-empty out-of-scope evidence', () => {
    const s = stub([run('completed')]);
    const output = join(s.root, 'out'),
      art = join(output, 'artifacts/runs/r');
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(run('completed', { output_root: output }))
    );
    const diff = join(art, 'diff-m1-r1.json');
    writeFileSync(diff, JSON.stringify({ out_of_scope: [] }));
    expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).out_of_scope).toBeUndefined();
    writeFileSync(diff, JSON.stringify({ out_of_scope: ['fixtures/golden.json'] }));
    for (const command of ['status', 'wait'])
      expect(
        JSON.parse(captured(() => main([command, 'sa1', '--timeout', '1'])).out).out_of_scope
      ).toEqual(['fixtures/golden.json']);
  });
  test('wait --json retains long errors at node, terminal record and metadata boundaries', () => {
    const first =
      'TypeError: require() async module "/workspace/wetamp/src/cli.ts" is unsupported. use "await import()" instead.';
    const error =
      first +
      '\n' +
      '    at main (/workspace/wetamp/src/cli.ts:530:12)\n'.repeat(30) +
      'Bun v1.4.3';
    for (const extra of [
      { nodes: [{ nodeId: 'code-quick', state: 'failed' as const, error }] },
      { terminal_record: { error } },
      { metadata: { error } },
    ]) {
      stub([run('failed', extra)]);
      const result = captured(() => main(['wait', 'sa1', '--json', '--timeout', '1']));
      const out = JSON.parse(result.out);
      expect(result.code).toBe(EXIT.failed);
      expect(out).toMatchObject({ run_id: 'sa1', state: 'failed', exit: EXIT.failed });
      expect(out.error).toStartWith(first);
      expect(out.error).toEndWith('Bun v1.4.3');
      expect(out.error.length).toBeLessThanOrEqual(200);
    }
  });
  test('wait ignores accepted inbox and wakes when a new queued message arrives', () => {
    const s = stub([run('running')]);
    const message: coordModule.Message = {
      id: 'fixture',
      scope: coordModule.runScope(s.ledger),
      sender: coordModule.caller(),
      recipient: null,
      generation: 1,
      kind: 'question',
      title: 'fixture',
      body: '',
      evidence: [],
      severity: 'normal',
      state: 'queued',
      at: '',
    };
    const accepted = { ...message, id: 'accepted', state: 'accepted' as const };
    const inbox = spyOn(coordModule.coord(), 'surfaced')
      .mockReturnValueOnce([accepted])
      .mockReturnValue([message]);
    try {
      const result = waitRun(s.ledger, 60);
      expect(result).toMatchObject({ state: 'inbox', exit: EXIT.held });
      expect(result.heartbeat).toBeUndefined();
      expect(s.calls().filter(c => c.startsWith('workflow get'))).toHaveLength(1);
      expect(s.calls().filter(c => c.startsWith('workflow wait'))).toHaveLength(1);
    } finally {
      inbox.mockRestore();
    }
  });
  test('wait native notification preserves cancellation and human holds', () => {
    for (const state of [run('cancelled'), humanWait()]) {
      const s = stub([run('running'), state]);
      expect(waitRun(s.ledger, 60)).toMatchObject({
        state: state.status === 'cancelled' ? 'cancelled' : 'held:human',
        exit: state.status === 'cancelled' ? EXIT.cancelled : EXIT.held,
        delivery_state: 'not_reached',
        receipt: { state: state.status === 'cancelled' ? 'cancelled' : 'held:human' },
      });
      expect(s.calls().filter(c => c.startsWith('workflow wait'))).toHaveLength(1);
    }
  });
  test('wait returns persistent attention after one full refresh', () => {
    const attention = {
      kind: 'stalled_tool_calls' as const,
      runId: 'r',
      status: 'running' as const,
      calls: [],
    };
    const wait = spyOn(archonMod, 'waitNotification').mockReturnValue({
      kind: 'attention',
      attention,
    });
    const running = stub([run('running')]);
    const inbox = spyOn(coordModule.coord(), 'surfaced');
    try {
      expect(waitRun(running.ledger, 3)).toMatchObject({
        state: 'running',
        exit: EXIT.running,
        attention,
      });
      expect(wait).toHaveBeenCalledTimes(1);
      expect(inbox).toHaveBeenCalledTimes(2);
      expect(
        running.calls().filter(c => c.startsWith('workflow get') && !c.includes('--events'))
      ).toHaveLength(2);
      expect(cliMod.waitClock.sleep).not.toHaveBeenCalled();
      wait.mockClear();
      const terminal = stub([run('running'), run('completed')]);
      expect(waitRun(terminal.ledger, 3).state).toBe('completed');
      expect(wait).toHaveBeenCalledTimes(1);
    } finally {
      inbox.mockRestore();
      wait.mockRestore();
    }
  });
  test('brief --json obtains the structured receipt summary with one state query', () => {
    const s = stub([run('completed', { nodes: [] })]);
    s.ledger.delivery_result = { status: 'integrated' } as NonNullable<Ledger['delivery_result']>;
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    const out = JSON.parse(captured(() => main(['brief', 'sa1', '--json'])).out);
    expect(out).toMatchObject({
      run_id: 'sa1',
      state: 'completed',
      delivery_state: 'integrated',
      receipt: { state: 'completed' },
      execution: [],
    });
    expect(
      s.calls().filter(c => c.startsWith('workflow get') && !c.includes('--events'))
    ).toHaveLength(1);
    expect(
      s.calls().filter(c => c.startsWith('workflow get') && c.includes('--events'))
    ).toHaveLength(1);
  });
  test.each([20, 60, 0.125])(
    'wait %ss uses one native notification for the remaining deadline',
    seconds => {
      const s = stub([run('running')]);
      expect(waitRun(s.ledger, seconds)).toMatchObject({ state: 'running', exit: EXIT.running });
      const waits = s.calls().filter(c => c.startsWith('workflow wait'));
      expect(waits).toHaveLength(1);
      expect(
        s.calls().filter(c => c.startsWith('workflow get') && !c.includes('--events'))
      ).toHaveLength(2);
      expect(
        s.calls().filter(c => c.startsWith('workflow get') && c.includes('--events'))
      ).toHaveLength(1);
      expect(Number(waits[0]!.split('--timeout ')[1])).toBeLessThanOrEqual(seconds);
      expect(Number(waits[0]!.split('--timeout ')[1])).toBeGreaterThan(0);
    }
  );
  // prettier-ignore
  test('wait slices notifications and acknowledges each general episode per marshal', () => {
    const s = stub([run('running')]), who = coordModule.caller(), other = { ...who, pid: who.pid + 1 };
    const stall = (at: number, runs: Record<string, object>) => writeFileSync(join(s.root, 'home/stall.json'), JSON.stringify({ at: new Date(at).toISOString(), runs }));
    const episode = (id: string) => ({ node: 'code-core', startedAt: new Date().toISOString(), entries: '', mtime: 0, progressAt: 0,
      state: 'idle', idle_s: 301, waiting_command: true, cpu: 12, root: { pid: 7, command: 'bun test' }, episode: { id, since: new Date().toISOString() } });
    const nativeWait = archonMod.waitNotification; let waits = 0;
    const sliced = spyOn(archonMod, 'waitNotification').mockImplementation((...args) => {
      const result = nativeWait(...args); if (++waits === 1) stall(Date.now(), { sa1: episode('e1') }); return result;
    });
    try {
      expect(waitRun(s.ledger, 120, who)).toMatchObject({ attention: { kind: 'general_idle', node: 'code-core', episode_id: 'e1', root: { pid: 7 } } });
      expect(sliced.mock.calls[0]?.[2]).toBeLessThanOrEqual(60);
      expect(waitRun(s.ledger, 10, who).attention).toBeUndefined();
      stall(Date.now(), { sa1: episode('e2') });
      expect(waitRun(s.ledger, 0, who)).toMatchObject({ attention: { episode_id: 'e2' } });
      const ack = readdirSync(join(s.root, 'home/stall-acks')).map(file => readFileSync(join(s.root, 'home/stall-acks', file), 'utf8')).join('');
      expect(ack).toContain('e2'); expect(ack).not.toContain('e1');
      expect(waitRun(s.ledger, 0, other)).toMatchObject({ attention: { episode_id: 'e2' } });
      stall(Date.now(), { other: episode('e3') }); expect(waitRun(s.ledger, 0, who).attention).toBeUndefined();
      stall(Date.now() - 181_000, { sa1: episode('e4') }); expect(waitRun(s.ledger, 0, who).attention).toBeUndefined();
    } finally { sliced.mockRestore(); }
  });
  test('running then completed: native wait returns 0 with land commands', () => {
    const s = stub([
      run('running', { nodes: [{ nodeId: 'a', state: 'running' }] }),
      run('completed', { output_root: '/none', nodes: [{ nodeId: 'a', state: 'completed' }] }),
    ]);
    const quota = spyOn(relay, 'relayQuota').mockReturnValue({ quota: 'relay fixture' });
    const out = JSON.parse(captured(() => main(['wait', 'sa1', '--timeout', '60'])).out);
    expect(out.quota).toBe('relay fixture');
    quota.mockRestore();
    expect(out).toMatchObject({
      run_id: 'sa1',
      state: 'completed',
      exit: 0,
      nodes: '1/1 completed',
    });
    expect(s.calls().filter(c => c.startsWith('workflow wait'))).toHaveLength(1);
  });
  // prettier-ignore
  test('one hour without events returns only at the requested deadline', () => {
    const s = stub([run('running')]), who = coordModule.caller();
    writeFileSync(join(s.root, 'home/heartbeat.json'), JSON.stringify({
      at: new Date(Date.now() - 19 * 60_000).toISOString(), reclaim_pending: 0,
      marshals: [
        { owner: who, owner_key: [], cwd: '/a', project: 'a', line: 'mine', running: [{ id: 'mine' }], waiting: [{ id: 'wait' }] },
        { owner: { ...who, pid: 8 }, owner_key: [], cwd: '/b', project: 'b', line: 'other', running: [{ id: 'other' }], waiting: [] },
      ],
    }));
    writeFileSync(join(s.root, 'home/tick.json'), JSON.stringify({
      at: new Date(Date.now() - 4 * 60_000).toISOString(), collect: { ok: true }, publish: { ok: true }, orca: { ok: true }, console: { ok: true }, failover: { ok: true }, actions: { ok: true },
    }));
    const timedOut = captured(() => main(['wait', 'sa1', '--timeout', '3600']));
    expect(timedOut.code).toBe(EXIT.running);
    expect(JSON.parse(timedOut.out)).toMatchObject({ state: 'running', exit: EXIT.running, timed_out: true,
      heartbeat: { available: true, line: 'mine', running: [{ id: 'mine' }], waiting: [{ id: 'wait' }], warnings: ['心跳过期 19m', '未收到巡检心跳 4m'] },
    });
    const waits = s.calls().filter(c => c.startsWith('workflow wait'));
    expect(waits).toHaveLength(60);
    expect(waits.every(call => Number(call.split('--timeout ')[1]) <= 60)).toBe(true);
    stub([run('running')]);
    const short = JSON.parse(captured(() => main(['wait', 'sa1', '--timeout', '60'])).out);
    expect(short).toMatchObject({ state: 'running', exit: EXIT.running, timed_out: true, heartbeat: { available: false } });
    expect(short).not.toHaveProperty('timeout_capped');
    expect(waitRun(stub([run('completed')]).ledger, 0, who).heartbeat).toBeUndefined();
  });
  test('wait transport failure is reported without changing the run or retrying execution', () => {
    const s = stub([run('running')]);
    const before = JSON.stringify(s.ledger);
    const wait = spyOn(archonMod, 'waitNotification').mockImplementation(() => {
      throw new Error('workflow wait transport unavailable');
    });
    try {
      expect(() => waitRun(s.ledger, 60)).toThrow('transport unavailable');
      expect(wait).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(s.ledger)).toBe(before);
      expect(s.calls().every(c => c.startsWith('workflow get'))).toBe(true);
    } finally {
      wait.mockRestore();
    }
  });
  test('held gate without a delivery artifact is unknown', () => {
    const s = stub([
      run('failed', { output_root: '/x', nodes: [{ nodeId: 'gate-m1', state: 'failed' }] }),
    ]);
    const art = join('/x', 'artifacts', 'runs', 'r');
    expect(waitRun(s.ledger, 5)).toMatchObject({
      state: 'held:engine_suspect',
      exit: EXIT.held,
      node: 'gate-m1',
      evidence: art,
    });
    expect(
      JSON.parse(captured(() => main(['wait', 'sa1', '--timeout', '1'])).out)
    ).not.toHaveProperty('quota');
  });
  test('early failure without a failed node: run error (redacted) and stop reason, with evidence paths', () => {
    const s = stub([]);
    const log = join(s.root, 'launch.log');
    writeFileSync(log, 'x');
    writeFileSync(
      join(s.root, 'stub', 'get-000.json'),
      JSON.stringify(
        run('failed', {
          metadata: {
            error: 'stale row error',
            stop_reason: { reason: 'launch_failed' },
          },
          terminal_record: { error: 'worker spawn failed: api_key=sk-live-123 Bearer abc.def' },
          transcript_path: join(s.root, 'missing.jsonl'),
        })
      )
    );
    const l = { ...s.ledger, log };
    const out = waitRun(l, 5);
    expect(out).toMatchObject({
      state: 'failed',
      exit: EXIT.failed,
      stop_reason: 'launch_failed',
      delivery_state: 'not_reached',
      receipt: { reason: 'launch_failed' },
    });
    expect(out.error).toBe('worker spawn failed: api_key=*** Bearer ***');
    expect(out.evidence_paths).toEqual([log]); // 不存在的 transcript 不列
    expect(out.node).toBeUndefined();
  });
  test('deliver LandError is typed as a blocked delivery', () => {
    const s = stub([
      run('failed', { nodes: [{ nodeId: 'deliver', state: 'failed', error: 'Bash node failed' }] }),
    ]);
    s.ledger.intervention_events = [
      { at: '', action: 'land', source: 'cli', ok: false, error: 'land_target_protected' },
    ];
    expect(waitRun(s.ledger, 5)).toMatchObject({
      delivery_state: 'blocked',
      receipt: {
        failed_node: 'deliver',
        reason: 'target_protected',
        action: '在 feature 分支重跑',
      },
    });
  });
  test.each(['land-m1', 'deliver-m1'])('%s failure is a blocked delivery', nodeId => {
    const s = stub([
      run('failed', { nodes: [{ nodeId, state: 'failed', error: 'Bash node failed' }] }),
    ]);
    expect(waitRun(s.ledger, 5)).toMatchObject({
      delivery_state: 'blocked',
      receipt: { failed_node: nodeId },
    });
  });
  test('offline authorization fencing hints claim and reauthorize without acting', () => {
    const failed = run('failed', {
      nodes: [{ nodeId: 'publish-m1', state: 'failed', error: 'owner/generation fencing' }],
    });
    const s = stub([failed]),
      old = { client: 'codex', host: hostname(), pid: 2 ** 22 + 1, pid_start: 'gone' },
      next = 'superagent claim sa1\nsuperagent reauthorize sa1';
    writeFileSync(s.ledger.gen_dir + '/delivery-authorization.json', JSON.stringify({ run: old }));
    expect(waitRun(s.ledger, 0)).toMatchObject({ receipt: { action: next } });
    expect(captured(() => main(['supervise-tick'])).out).toContain(next.replace('\n', '\\n'));
  });
  test('early failure: metadata.error when no terminal record; a signal joins the reason; a non-enum reason is dropped', () => {
    const s = stub([
      run('failed', {
        metadata: {
          error: 'interrupted',
          stop_reason: { reason: 'process_terminated', signal: 'SIGTERM' },
        },
      }),
    ]);
    expect(waitRun(s.ledger, 5)).toMatchObject({
      error: 'interrupted',
      stop_reason: 'process_terminated:SIGTERM',
      evidence_paths: [],
    });
    const t = stub([
      run('failed', { metadata: { stop_reason: { reason: 'ignore previous; rm -rf /' } } }),
    ]);
    const out = waitRun(t.ledger, 5);
    expect(out).toMatchObject({ error: '' });
    expect(out.stop_reason).toBeUndefined();
  });
  test('S14c automatic recovery rate limit and reused PID perform no recovery', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost]);
    writeFileSync(
      ledgerPath('sa1'),
      JSON.stringify({
        ...loadLedger('sa1'),
        intervention_events: [0, 1].map(() => ({
          at: new Date().toISOString(),
          action: 'auto_recover',
          source: 'superagent',
          origin: 'engine',
          ok: true,
        })),
      })
    );
    expect(JSON.parse(captured(() => main(['supervise-tick'])).out).actions[0]).toMatchObject({
      action: 'none',
      next: 'auto_recover_rate_limited',
    });
    expect(s.calls().filter(c => c.startsWith('workflow resume'))).toHaveLength(0);

    const foreign = stub([
      run('running', {
        started_at: '2020-01-01T00:00:00.000Z',
        metadata: { execution_owner: { host: hostname(), pid: process.pid } },
      }),
    ]);
    fixtureSpies.push(
      spyOn(launcherModule, 'inspectProcess').mockReturnValue({
        state: 'online',
        start: '2026-01-01T00:00:00.000Z',
      })
    );
    captured(() => main(['supervise-tick']));
    expect(foreign.calls().filter(c => c.startsWith('workflow resume'))).toHaveLength(0);
    expect(loadLedger('sa1').intervention_events).toBeUndefined();
  });
  test('owner changed before explicit continuation: CAS refuses with no resume', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    const s = stub([lost]);
    const db = runsDb({ host: hostname(), pid: process.pid });
    expect(archonMod.recover('r')).toMatchObject({ reason: 'owner_changed', ok: false });
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'running',
    });
    expect(s.calls().some(c => c.startsWith('workflow resume'))).toBe(false);
    db.close();
  });
  test('a held recover lock serializes: second recover is refused without touching the run', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    stub([lost]);
    const db = runsDb(LOST);
    const held = engineRecoverLock();
    if (!held.ok) throw new Error('lock not taken');
    try {
      // 锁忙不是业务失败：重读状态，按当前状态退出（仍是 owner_lost → 运行中 4）
      const { code, out } = captured(() => main(['resume', 'sa1']));
      expect(code).toBe(EXIT.running);
      expect(JSON.parse(out)).toMatchObject({
        ok: false,
        busy: true,
        reason: 'recover_locked',
        state: 'owner_lost',
      });
      // wait 撞上锁：稍候重读，到期按运行中返回，不报 failed
      expect(waitRun(loadLedger('sa1'), 1)).toMatchObject({
        state: 'owner_lost',
        exit: EXIT.running,
      });
      expect(loadLedger('sa1').recoveries).toHaveLength(0);
    } finally {
      held.release();
    }
    expect(db.query('select status from remote_agent_workflow_runs').get()).toEqual({
      status: 'running',
    });
    db.close();
  });
  test('a leftover lock file nobody holds (empty, junk, or a dead pid) does not block recover', () => {
    const lost = run('running', { metadata: { execution_owner: LOST } });
    for (const junk of ['', '{"pid":', JSON.stringify({ ...LOST, at: '' })]) {
      stub([lost, lost, run('completed')]);
      runsDb(LOST).close();
      mkdirSync(join(process.env.ARCHON_HOME ?? '', 'execution-admissions'), { recursive: true });
      writeFileSync(join(process.env.ARCHON_HOME ?? '', 'execution-admissions/r.lock'), junk);
      expect(archonMod.recover('r').ok).toBe(true);
    }
  });
});

describe('verbs (archon stub)', () => {
  const abandon = (...ids: string[]) =>
    captured(() => main(['abandon', ...ids, '--reason', 'obsolete']));
  // prettier-ignore
  test('abandon isolates invalid runs, preserves decide rejection, and filters --mine', () => {
    const s = stub([run('failed')]);
    const other = { ...s.ledger.controller!, pid: s.ledger.controller!.pid + 1 };
    writeFileSync(ledgerPath('sa1'), JSON.stringify({ ...s.ledger, controller: other }));
    const mixed = abandon('missing', 'sa1').out;
    expect(mixed).toContain('"type": "unknown_run"'); expect(mixed).toContain('"type": "not_controller"');
    const own = stub([run('failed')]);
    const started_at = '2026-01-01T00:00:00Z';
    writeFileSync(ledgerPath('sa1'), JSON.stringify({ ...own.ledger, started_at }));
    writeFileSync(ledgerPath('sa2'), JSON.stringify({ ...own.ledger, run_id: 'sa2', controller: other, started_at }));
    const selected = captured(() => main(['abandon', '--mine', '--status', 'failed,cancelled', '--reason', 'obsolete']));
    expect(selected.out).toContain('"runs": [\n    "sa1"');
    expect(selected.out).not.toContain('"sa2"');
    expect(loadLedger('sa1').rejected).toBe('r');
    expect(loadLedger('sa2').rejected).toBeUndefined();
    stub([humanWait()]);
    captured(() => main(['decide', 'sa1', 'reject']));
    expect(captured(() => main(['recover', 'sa1'])).out).not.toContain('run was abandoned');
  });
  test('cancel records an operational reason on its append-only receipt', () => {
    stub([run('running')]);
    expect(captured(() => main(['cancel', 'sa1', '--reason', 'superseded'])).code).toBe(0);
    expect(loadLedger('sa1').intervention_events?.at(-1)).toMatchObject({
      action: 'cancel',
      ok: true,
      reason: 'superseded',
    });
  });
  test('cancel without reason records unstated and rejects labels outside the closed set', () => {
    stub([run('running')]);
    expect(() => main(['cancel', 'sa1', '--reason', 'invented_label'])).toThrow(
      'operational label'
    );
    expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
    expect(loadLedger('sa1').intervention_events?.at(-1)).toMatchObject({
      action: 'cancel',
      ok: true,
      reason: 'unstated',
    });
  });
  test('cancel rejects free text and credential-shaped reasons before any action', () => {
    const s = stub([run('running')]);
    expect(() => main(['cancel', 'sa1', '--reason', 'token=secret'])).toThrow('operational label');
    expect(s.calls()).toHaveLength(0);
  });
  test('status prints summary and exits with the classified code', () => {
    stub([
      run('paused', {
        metadata: {
          wait: { nodeId: 'human-m1', kind: 'event', event: 'sa.human.m1', resumeAt: 't' },
        },
      }),
    ]);
    expect(main(['status', 'sa1'])).toBe(EXIT.held);
  });
  test('cancel: a running run goes through archon workflow cancel with the archon run id', () => {
    const s = stub([run('running')]);
    expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
    expect(s.calls()).toContain('workflow cancel r --json');
    expect(s.calls().some(c => c.startsWith('workflow abandon'))).toBe(false);
    expect(loadLedger('sa1').intervention_events?.at(-1)?.reason).toBe('unstated');
  });
  test('cancel: a paused or failed run is abandoned (the engine refuses cancel for them)', () => {
    for (const r of [humanWait(), run('failed')]) {
      const s = stub([r]);
      expect(captured(() => main(['cancel', 'sa1'])).code).toBe(0);
      expect(s.calls()).toContain('workflow abandon r --json');
      expect(s.calls().some(c => c.startsWith('workflow cancel'))).toBe(false);
    }
  });
  test('cancel: a run that paused between get and cancel returns the refusal without guessing abandon', () => {
    const s = stub([run('running'), humanWait()]);
    const { code, out } = captured(() => main(['cancel', 'sa1']));
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({
      run_id: 'sa1',
      ok: false,
      action: 'cancel',
      error: expect.stringContaining("Cannot cancel run with status 'paused'"),
    });
    expect(s.calls().filter(c => c.startsWith('workflow get'))).toHaveLength(1);
    expect(s.calls().filter(c => /^workflow (cancel|abandon)/.test(c))).toEqual([
      'workflow cancel r --json',
    ]);
  });
  test('cancel: a completed run is refused by abandon and exits 1', () => {
    const s = stub([run('completed')]);
    const { code, out } = captured(() => main(['cancel', 'sa1']));
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({
      run_id: 'sa1',
      ok: false,
      action: 'abandon',
      error: expect.stringContaining("Cannot abandon run with status 'completed'"),
    });
    expect(s.calls()).toContain('workflow abandon r --json');
  });
  test('resume refuses a run whose owner may be alive', () => {
    stub([run('running', { metadata: { execution_owner: { host: 'elsewhere', pid: 1 } } })]);
    expect(main(['resume', 'sa1'])).toBe(EXIT.held);
  });
  test('unknown run id fails clearly', () => {
    stub([]);
    expect(() => main(['wait', 'nope'])).toThrow(/unknown run nope/);
  });
  test('unknown verb prints usage and exits 64', () => {
    expect(main(['frobnicate'])).toBe(64);
  });
});

describe('run (archon stub)', () => {
  test('successful start warns after two recent failures with the same typed reason', () => {
    const s = stub([run('failed', { metadata: { stop_reason: { reason: 'launch_failed' } } })]),
      repo = featureRepo(s.root),
      started_at = new Date().toISOString();
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    for (const id of ['old-a', 'old-b'])
      writeFileSync(ledgerPath(id), JSON.stringify({ ...s.ledger, run_id: id, repo, started_at }));
    const out = JSON.parse(
      captured(() =>
        main(['run', fixturePlan(s.root, repo), '--fake', '--allow-overlap', 'fixture'])
      ).out
    );
    expect(out.recent_failures, JSON.stringify(out)).toEqual([
      expect.objectContaining({
        reason: 'launch_failed',
        count: 2,
        action: expect.stringContaining('superagent recover'),
      }),
    ]);
  });
  test.each([
    ['run', 'main'],
    ['run', 'dev'],
    ['run', 'release-1.2'],
    ['quick', 'main'],
  ] as const)('%s rejects protected delivery target %s before generation', (command, branch) => {
    const s = stub([]),
      repo = gitRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    if (branch !== 'main') sh(`git switch -qc ${branch}`, repo);
    const before = readdirSync(join(s.root, 'home/runs'));
    const args =
      command === 'run'
        ? ['run', fixturePlan(s.root, repo)]
        : ['quick', '--repo', repo, '--goal', 'x', '--accept', 'true'];
    const result = captured(() => main(args));
    expect(result.code).toBe(EXIT_USAGE);
    expect(JSON.parse(result.out)).toEqual({
      ok: false,
      status: 'rejected',
      reason: 'target_protected',
      target: branch,
      action: '在非保护分支（feature 分支）上启动：git switch -c <新分支> 后重跑',
    });
    expect(readdirSync(join(s.root, 'home/runs'))).toEqual(before);
    expect(s.calls().some(c => c.startsWith('workflow run'))).toBe(false);
  });
  // prettier-ignore
  test('run rejects an untracked delivery target before generation', () => {
    const s = stub([]), repo = featureRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    writeFileSync(join(repo, 'untracked.txt'), 'local');
    const before = readdirSync(join(s.root, 'home/runs'));
    const result = captured(() => main(['run', fixturePlan(s.root, repo)]));
    expect(result.code).toBe(EXIT_USAGE);
    expect(JSON.parse(result.out)).toEqual({
      ok: false, status: 'rejected', reason: 'target_dirty', paths: ['untracked: "untracked.txt"'],
      action: '先 commit/stash 目标检出的改动后重跑',
    });
    expect(readdirSync(join(s.root, 'home/runs'))).toEqual(before);
    expect(s.calls().some(c => c.startsWith('workflow run'))).toBe(false);
  });
  test('BYPASS_CAPACITY run launches with eight active runs and observes low disk', () => {
    const s = stub([]),
      repo = featureRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    engineBoundary!.mockImplementation(() => cleanEngine(repo));
    const db = new Database(join(process.env.ARCHON_HOME!, 'archon.db'));
    db.exec('create table remote_agent_workflow_runs (id text, status text)');
    for (let i = 0; i < 8; i++)
      db.query('insert into remote_agent_workflow_runs values (?, ?)').run(String(i), 'running');
    db.close();
    const disk = spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 } as ReturnType<
      typeof fs.statfsSync
    >);
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = captured(() => main(['run', fixturePlan(s.root, repo), '--fake']));
      expect(result.code, result.out).toBe(0);
      expect(s.calls().some(c => c.startsWith('workflow run'))).toBe(true);
      expect(
        warning.mock.calls.flat().some(v => String(v).includes('superagent.disk_observed'))
      ).toBe(true);
    } finally {
      disk.mockRestore();
      warning.mockRestore();
    }
  });
  test.each(['dirty', 'changed'] as const)(
    'P4a failed generation publishes no ledger: %s',
    sample => {
      const s = stub([]),
        repo = featureRepo(s.root),
        engine = gitRepo(tmp());
      process.env.SUPERAGENT_WRITE_ROOTS = s.root;
      engineBoundary!.mockImplementation(() => cleanEngine(engine));
      if (sample === 'dirty') writeFileSync(join(engine, 'dirty'), 'changed');
      const validation = spyOn(archonMod, 'archon').mockImplementation(args => {
        if (sample === 'changed' && args[0] === 'validate')
          sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm changed', engine);
        return fixtureArchon(s.dir, args);
      });
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      try {
        const result = captured(() => main(['run', fixturePlan(s.root, repo)]));
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out).reason).toContain(
          sample === 'dirty' ? '工作树不干净' : '引擎提交在生成期间变化'
        );
        expect(readdirSync(join(s.root, 'home/runs'))).toEqual(['sa1.json']);
        expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
        expect(s.calls().some(c => c.startsWith('workflow run'))).toBe(false);
      } finally {
        validation.mockRestore();
      }
    }
  );
  for (const detached of [false, true])
    test(`LAND run records plan.repo launch branch, detached=${String(detached)}, with a SHA comparison base`, () => {
      const s = stub([]),
        repo = gitRepo(s.root);
      process.env.SUPERAGENT_WRITE_ROOTS = s.root;
      if (!detached) {
        mkdirSync(join(repo, '.superagent'));
        writeFileSync(
          join(repo, '.superagent/rules.json'),
          JSON.stringify({
            frozen: ['core.txt'],
            required_checks: [{ when: ['core.txt'], check: { cmd: 'required', timeout_s: 1 } }],
          })
        );
        sh(
          'git add .superagent/rules.json && git -c user.name=t -c user.email=t@l commit -qm rules',
          repo
        );
      }
      const sha = sh('git rev-parse HEAD', repo).trim();
      engineBoundary!.mockImplementation(() => cleanEngine(repo));
      sh(detached ? 'git switch -q --detach HEAD' : 'git switch -qc feature/launch', repo);
      const plan = fixturePlan(s.root, repo, p => {
        p.base_ref = sha;
      });
      const quota = spyOn(relay, 'relayQuota').mockReturnValue({ quota: 'relay fixture' });
      const result = captured(() =>
        main([
          'run',
          plan,
          '--fake',
          ...(!detached ? ['--lint-override', 'approved exception'] : []),
        ])
      );
      expect(JSON.parse(result.out).quota).toBe('relay fixture');
      quota.mockRestore();
      expect(result.code, result.out).toBe(0);
      const id = JSON.parse(result.out).run_id as string;
      const ledger = loadLedger(id);
      expect(ledger.engine_commit).toBe(sha);
      expect(
        JSON.parse(readFileSync(join(ledger.gen_dir, 'engine.json'), 'utf8')).engine_commit
      ).toBe(sha);
      expect(ledger.intervention_events).toEqual([]);
      expect(ledger.launch_branch).toBe(detached ? undefined : 'feature/launch');
      expect(JSON.parse(readFileSync(join(ledger.gen_dir, 'plan.json'), 'utf8')).base_ref).toBe(
        sha
      );
      expect(s.calls().find(c => c.startsWith('workflow run'))).toContain(`--from ${sha}`);
      if (!detached) {
        expect(ledger.plan_lint?.override).toBe('approved exception');
        expect(
          JSON.parse(readFileSync(join(ledger.gen_dir, 'plan.json'), 'utf8')).packages[0].accept.at(
            -1
          ).cmd
        ).toBe('required');
        const frozenRules = readFileSync(join(ledger.gen_dir, 'project-rules.json'), 'utf8');
        fixtureSpies.push(spyOn(generatorModule, 'generate').mockImplementation(fastGenerate));
        engineBoundary!.mockReturnValue(sha);
        writeFileSync(
          join(repo, '.superagent/rules.json'),
          JSON.stringify({
            required_checks: [{ when: ['core.txt'], check: { cmd: 'changed', timeout_s: 1 } }],
          })
        );
        Object.assign(ledger, { engine_hash: 'old', workflow_hash: 'old' });
        writeFileSync(ledgerPath(id), JSON.stringify(ledger));
        writeFileSync(
          join(s.dir, 'get-000.json'),
          JSON.stringify(run('failed', { nodes: [{ nodeId: 'code-core', state: 'completed' }] }))
        );
        expect(captured(() => main(['resume', id])).code).toBe(0);
        const resumed = loadLedger(id);
        expect(s.calls().some(call => call.includes('--adopt'))).toBe(true);
        expect(
          JSON.parse(
            readFileSync(join(resumed.gen_dir, 'plan.json'), 'utf8')
          ).packages[0].accept.at(-1).cmd
        ).toBe('required');
        expect(
          JSON.parse(readFileSync(join(resumed.gen_dir, 'project-rules.json'), 'utf8')).rules
            .required_checks[0].check.cmd
        ).toBe('required');
        expect(readFileSync(join(resumed.gen_dir, 'project-rules.json'), 'utf8')).toBe(frozenRules);
      }
    });
  test('E5 run preflight refuses before engine launch and failure ledger records the phase', () => {
    const s = stub([]);
    const repo = join(s.root, 'repo');
    mkdirSync(repo);
    sh('git init -q -b feature/fixture', repo);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const result = captured(() => main(['run', fixturePlan(s.root, repo)]));
    expect(result.code).toBe(1);
    const failure = JSON.parse(result.out);
    expect(failure).toMatchObject({
      phase: 'preflight',
      reason: expect.stringContaining('worktree.baseBranch'),
    });
    expect(
      JSON.parse(
        readFileSync(join(s.root, 'home/launch-failures', `${failure.run_id}.json`), 'utf8')
      )
    ).toEqual(failure);
    expect(s.calls().some(c => c.startsWith('workflow run'))).toBe(false);
  });
  test('engine launch rejection is recorded separately from preflight', () => {
    const s = stub([]),
      repo = featureRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    fixtureOptions(s.dir, { launchReply: { ok: false, error: 'fixture_launch_rejected' } });
    const result = captured(() => main(['run', fixturePlan(s.root, repo), '--fake']));
    expect(result.code).toBe(1);
    const failure = JSON.parse(result.out);
    expect(failure).toMatchObject({
      phase: 'engine',
      reason: expect.stringContaining('fixture_launch_rejected'),
    });
    expect(
      JSON.parse(
        readFileSync(join(s.root, 'home/launch-failures', `${failure.run_id}.json`), 'utf8')
      )
    ).toEqual(failure);
  });
  const start = (console?: string): string[] => {
    const s = stub([]);
    const repo = featureRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const plan = fixturePlan(s.root, repo, p => (console ? (p.console = console) : undefined));
    expect(captured(() => main(['run', plan])).code).toBe(0);
    return s.calls().filter(c => c.startsWith('workflow run'));
  };
  test.each([undefined, { fake: true }, { expires_at: '2020-01-01' }])(
    'delivery defaults: launch succeeds with selftest receipt %j',
    receipt => {
      const s = stub([]),
        repo = featureRepo(s.root);
      fixtureSpies.push(spyOn(generatorModule, 'generate').mockImplementation(fastGenerate));
      process.env.SUPERAGENT_WRITE_ROOTS = s.root;
      const plan = fixturePlan(s.root, repo, p => {
        delete p.deadline;
        delete p.budget;
      });
      if (receipt) writeFileSync(join(s.root, 'home', 'selftest.json'), JSON.stringify(receipt));
      else rmSync(join(s.root, 'home', 'selftest.json'), { force: true });
      expect(captured(() => main(['run', plan])).code).toBe(0);
    }
  );
  /** workflow run 的 --config 文件里钉住的别名。 */
  const pinned = (call: string): Record<string, unknown> => {
    const m = /--config (\S+)/.exec(call);
    expect(m).not.toBeNull();
    return (
      Bun.YAML.parse(readFileSync(m?.[1] ?? '', 'utf8')) as { aliases: Record<string, unknown> }
    ).aliases;
  };
  const want = renderAliases(loadTiers());
  test.each(['codex', 'claude'] as const)(
    'console=%s pins routed models and effort in the run config layer',
    console => {
      const call = start(console)[0];
      expect(call).not.toContain('--model');
      const tiers = loadTiers();
      const coder = resolveRoute(tiers, console).candidates[0];
      const reviewers = resolveRoute(tiers, console, 'auto', 'review', 'G1', 1, [
        coder.model,
      ]).candidates;
      const reviewer = reviewers[0];
      expect(pinned(call)).toEqual({
        '@sa-coder': { ...coder, effort: 'high' },
        '@sa-reviewer': { ...reviewer, effort: 'high' },
        '@sa-reviewer-alt': {
          ...(reviewers.find(a => a.provider !== reviewer.provider) ?? reviewers.at(1) ?? reviewer),
          effort: 'high',
        },
        '@sa-reviewer-G0': resolveRoute(tiers, console, 'auto', 'review', 'G0', 1, [coder.model])
          .candidates[0],
      });
      expect(coder.provider).toBe('codex');
      expect(reviewer.model).not.toBe(coder.model);
    }
  );
  const drifted = (where: 'global' | 'repo'): { code: number; out: string; calls: string[] } => {
    const s = stub([]);
    const repo = gitRepo(s.root);
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const dir = where === 'global' ? join(s.root, 'home', 'archon') : join(repo, '.archon');
    mkdirSync(dir, { recursive: true });
    const alias = { ...want['@sa-reviewer'], model: 'other-model' };
    writeFileSync(
      join(dir, 'config.yaml'),
      Bun.YAML.stringify({ aliases: { '@sa-reviewer': alias } })
    );
    const r = captured(() => main(['run', fixturePlan(s.root, repo)]));
    return { ...r, calls: s.calls() };
  };
  test('a target repo @sa-* alias that differs from tiers refuses to start with exit 5', () => {
    const r = drifted('repo');
    expect(r.code).toBe(EXIT_ALIAS_DRIFT);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, reason: 'alias_drift' });
    expect(r.calls.some(c => c.startsWith('workflow run'))).toBe(false);
  });
  test('a drifted global alias also refuses; health --cwd runs the same check', () => {
    expect(drifted('global').code).toBe(EXIT_ALIAS_DRIFT);
    const repo = join(process.env.SUPERAGENT_HOME ?? '', '..', 'repo');
    const h = captured(() => main(['health', '--cwd', repo]));
    expect(h.code).toBe(EXIT_ALIAS_DRIFT);
    expect((JSON.parse(h.out) as { alias_drift: string[] }).alias_drift).toHaveLength(1);
  }, 30000);
});

// Value: protects=health JSON summary/verbose and check failures; seam=native subprocess fixture; no_claim=live provider acceptance.
describe('health upstream reporting', () => {
  test('global hooks contamination only warns and preserves health status', () => {
    const root = tmp(),
      config = join(tmp(), 'gitconfig');
    for (const name of ['pre-commit', 'pre-push', '.backup']) writeFileSync(join(root, name), '');
    writeFileSync(config, `[core]\n\thooksPath = ${root}\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = check([]);
      expect(warn).not.toHaveBeenCalled();
      writeFileSync(join(root, 'prepare-commit-msg'), '');
      expect(check([]).code).toBe(before.code);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        'prepare-commit-msg；可能被 lefthook/husky install 写入全局 hooksPath'
      );
      expect(existsSync(join(root, 'prepare-commit-msg'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
  const check = (
    files: string[],
    exitCode = 0,
    verbose = false,
    consoleError?: string,
    tick: Record<string, unknown> = {}
  ) => {
    const fixture = stub([]);
    writeFileSync(
      join(fixture.root, 'home/tick.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        collect: { ok: true },
        publish: { ok: true },
        orca: { ok: true },
        console: { ok: true },
        failover: { ok: true },
        actions: { ok: true },
        ...tick,
      })
    );
    if (consoleError) {
      mkdirSync(join(fixture.root, 'home/console'), { recursive: true });
      writeFileSync(join(fixture.root, 'home/console/error'), consoleError);
    }
    const home = tmp();
    const capabilities = JSON.parse(readFileSync(join(WETAMP, 'capabilities.json'), 'utf8')) as {
      use: Record<string, string>;
    }[];
    for (const capability of capabilities)
      for (const [provider, skill] of Object.entries(capability.use)) {
        const dir = join(home, `.${provider}`, 'skills', skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), 'fixture');
      }
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const checkSpawn = <
      const In extends Bun.SpawnOptions.Writable = 'ignore',
      const Out extends Bun.SpawnOptions.Readable = 'pipe',
      const Err extends Bun.SpawnOptions.Readable = 'pipe',
    >(
      cmd: string[] | (Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err> & { cmd: string[] }),
      options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>
    ): Bun.SyncSubprocess<Out, Err> => {
      const command = Array.isArray(cmd) ? cmd : cmd.cmd;
      return nativeSpawnSync(
        command[0] === join(WETAMP, 'scripts', 'check-upstream-clean.sh')
          ? [
              process.execPath,
              '-e',
              `process.stdout.write(${JSON.stringify(files.join('\n'))}); process.exit(${String(exitCode)})`,
            ]
          : command,
        Array.isArray(cmd) ? options : cmd
      );
    };
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(checkSpawn);
    try {
      const result = captured(() => main(['health', ...(verbose ? ['--verbose'] : [])]));
      return { code: result.code, json: JSON.parse(result.out) };
    } finally {
      spy.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  };
  test('dirty upstream gives a reason and count, expanding files only with --verbose', () => {
    const files = Array.from({ length: 45 }, (_, i) => `packages/file-${String(i)}.ts`);
    const summary = check(files);
    expect(summary.code).toBe(1);
    expect(summary.json).toMatchObject({
      ok: false,
      reason: 'upstream_dirty',
      upstream_clean: false,
      upstream_file_count: 45,
    });
    expect(summary.json).not.toHaveProperty('upstream_files');
    expect(JSON.stringify(summary.json)).not.toContain(files[0]);
    const detail = check(files, 0, true);
    expect(detail.code).toBe(1);
    expect(detail.json.upstream_files).toEqual(files);
  });
  test('empty successful upstream check reports zero files without a dirty reason', () => {
    const result = check([]);
    expect(result.json).toMatchObject({ upstream_clean: true, upstream_file_count: 0 });
    expect(result.json).not.toHaveProperty('reason');
    const failed = check([], 0, false, undefined, { ntfy_sync: { ok: false, error: 'offline' } });
    expect(failed.code).toBe(1);
    expect(failed.json.tick.messages).toContain('ntfy 回收失败：offline');
  });
  test('failed upstream check with empty output cannot report clean', () => {
    const result = check([], 1);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      upstream_clean: false,
      reason: 'upstream_check_failed',
    });
  });
});

describe('decide (archon stub)', () => {
  const packageRework = (s: ReturnType<typeof stub>): void => {
    writeFileSync(
      join(s.ledger.gen_dir, 'plan.json'),
      JSON.stringify({
        packages: [
          { id: 'core', risk: 'G1', milestone: 'm1', signoff: 'human' },
          { id: 'api', risk: 'G1', milestone: 'm1', deps: ['core'] },
        ],
      })
    );
    const workflow = join(s.ledger.gen_dir, '.archon/workflows', s.ledger.workflow);
    mkdirSync(workflow, { recursive: true });
    writeFileSync(
      join(workflow, `${s.ledger.workflow}.yaml`),
      Bun.YAML.stringify({
        nodes: [
          { id: 'package-attempt-core' },
          { id: 'package-attempt-api' },
          { id: 'attempt-m1' },
        ],
      })
    );
  };
  test('approve signals the exact wait occurrence in the background', async () => {
    const s = stub([humanWait(), run('running')]);
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(0);
    expect(await eventually(s.calls, 'workflow signal')).toBe(
      'workflow signal r --event sa.human.m2 --resume-at 2099-01-01T00:00:00.000Z --data {"decision":"approve"} --json'
    );
  });
  test('approve refuses a run that is not at a signoff gate', () => {
    const s = stub([run('running')]);
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(1);
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
  });
  test('approve past the plan deadline is refused without signalling', () => {
    const s = stub([humanWait(), run('running')]);
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2020-01-01T00:00:00Z', packages: [{ id: 'core' }] })
    );
    const { code, out } = captured(() => main(['decide', 'sa1', 'approve']));
    expect(code).toBe(1);
    expect(out).toContain('deadline');
    expect(s.calls().some(c => c.startsWith('workflow signal'))).toBe(false);
  });
  test('reject ends the paused run through abandon', () => {
    const s = stub([humanWait()]);
    expect(captured(() => main(['decide', 'sa1', 'reject'])).code).toBe(0);
    expect(loadLedger('sa1').intervention_events?.at(-1)).toMatchObject({
      action: 'cancel',
      reason: 'rejected',
      ok: true,
    });
    expect(s.calls()).toContain('workflow abandon r --json');
  });
  test('reject --pkg advances the target and later packages, rejects natively, then resumes', () => {
    const approval = { nodeId: 'human-m1' };
    const s = stub([run('paused', { metadata: { approval } })]);
    packageRework(s);
    expect(
      captured(() => main(['decide', 'sa1', 'reject', '--pkg', 'core', '--hint', 'use X'])).code
    ).toBe(0);
    expect(s.calls()).toContain('workflow reject r use X --json');
    expect(s.calls()).toContain('workflow resume r --detach --json');
    expect(readFileSync(join(s.ledger.gen_dir, 'hints/core.md'), 'utf8')).toBe('use X\n');
    for (const scope of ['.packages/core', '.packages/api', 'm1'])
      expect(readFileSync(join(s.ledger.gen_dir, 'attempts', scope), 'utf8')).toBe('1');
  });
  test('reject --pkg rolls counters back when native reject fails', () => {
    const s = stub([run('paused', { metadata: { approval: { nodeId: 'human-m1' } } })]);
    packageRework(s);
    fixtureOptions(s.dir, { rejectReply: { ok: false, error: 'injected reject failure' } });
    expect(() => main(['decide', 'sa1', 'reject', '--pkg', 'core', '--hint', 'use X'])).toThrow(
      /injected reject failure/
    );
    for (const scope of ['.packages/core', '.packages/api', 'm1'])
      expect(existsSync(join(s.ledger.gen_dir, 'attempts', scope))).toBe(false);
    expect(s.calls().some(call => call.startsWith('workflow resume'))).toBe(false);
  });
  test('retry --hint writes the package hint, then resumes', () => {
    const failed = run('failed', {
      nodes: [
        { nodeId: 'start-m1', state: 'completed' },
        { nodeId: 'code-core', state: 'failed' },
      ],
    });
    const s = stub([failed, failed]);
    expect(
      captured(() => main(['decide', 'sa1', 'retry', '--pkg', 'core', '--hint', 'use X'])).code
    ).toBe(0);
    expect(readFileSync(join(s.root, 'gen', 'hints', 'core.md'), 'utf8')).toBe('use X\n');
    expect(s.calls()).toContain('workflow resume r --detach --json');
  });
  test('retry --hint rejects a package outside the plan (no path from user text)', () => {
    stub([run('failed', { nodes: [{ nodeId: 'code-core', state: 'failed' }] })]);
    expect(() => main(['decide', 'sa1', 'retry', '--pkg', '../x', '--hint', 'h'])).toThrow(/--pkg/);
  });
  test('retry on an escalated gate fails clearly instead of re-running the same verdict', () => {
    stub([run('failed', { nodes: [{ nodeId: 'gate-m1-r3', state: 'failed' }] })]);
    expect(() => main(['decide', 'sa1', 'retry'])).toThrow(/gate-m1-r3 escalated/);
  });
});

describe('brief / land (archon stub)', () => {
  const withArtifacts = (status: RunView['status'], files: Record<string, unknown>): string => {
    const s = stub([]);
    const art = join(s.root, 'out', 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    for (const [f, v] of Object.entries(files)) writeFileSync(join(art, f), JSON.stringify(v));
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(run(status, { output_root: join(s.root, 'out') }))
    );
    return art;
  };
  test('brief: one line per gate round with verdict, reason and debt count, ≤20 lines', () => {
    const art = withArtifacts('completed', {
      'gate-m1-r1.json': { verdict: 'fix', reason: 'review_failed', debt: [] },
      'gate-m1-r1.review.json': {},
      'gate-m1-r2.json': { verdict: 'pass', reason: null, debt: ['d1'] },
      'land.json': { commands: ['git switch main', 'git merge --ff-only sa/sa1'] },
    });
    const { code, out } = captured(() => main(['brief', 'sa1']));
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toStartWith('sa1 completed');
    expect(lines[1]).toStartWith('receipt: completed - unclassified →');
    expect(lines).toContain('gate-m1-r1: unknown debt=0');
    expect(lines).toContain('gate-m1-r2: unknown debt=0');
    expect(lines).toContain('git merge --ff-only sa/sa1');
    expect(lines).toContain(`evidence: ${art}`);
    expect(lines.length).toBeLessThanOrEqual(20);
  });
  test('report: states, review rounds, first pass, escalations, node seconds, debt, recoveries', () => {
    const art = withArtifacts('failed', {
      'gate-m1-r1.json': {
        decision: { kind: 'debt', reason: null, evidence: [], debt: ['d1', 'd2'] },
      },
      'gate-m2-r1.json': {
        decision: { kind: 'repair', reason: 'review_failed', evidence: [], debt: [] },
      },
      'gate-m2-r2.json': {
        decision: { kind: 'repair', reason: 'review_failed', evidence: [], debt: [] },
      },
      'gate-m2-r3.json': {
        decision: { kind: 'block', reason: 'review_failed+review_limit', evidence: [], debt: [] },
      },
    });
    const nodes = [
      { nodeId: 'code-core', state: 'completed', durationMs: 61_400 },
      { nodeId: 'review-m1-r1', state: 'completed', durationMs: 30_000 },
      { nodeId: 'gate-m2-r3', state: 'failed', durationMs: 100 },
    ];
    const root = join(art, '..', '..', '..', '..');
    writeFileSync(
      join(root, 'stub', 'get-000.json'),
      JSON.stringify(run('failed', { output_root: join(root, 'out'), nodes }))
    );
    const home = process.env.SUPERAGENT_HOME ?? '';
    const l = JSON.parse(readFileSync(join(home, 'runs', 'sa1.json'), 'utf8')) as Ledger;
    writeFileSync(join(home, 'runs', 'sa1.json'), JSON.stringify({ ...l, recoveries: ['t'] }));
    const { code, out } = captured(() => main(['report', '--full']));
    expect(code).toBe(0);
    const { usage, full_usage, ...counts } = JSON.parse(out) as Record<string, unknown>;
    expect(full_usage).toMatchObject({ label: '全量（ccusage）', total: null });
    // 桩输出没有事件：没有调用，用量是 unknown 而不是 0（F-22 细节见 report.test.ts）
    expect(usage).toMatchObject({ total: { calls: 0, input: 'unknown' }, unreadable: [] });
    expect(counts).toMatchObject({
      runs: 1,
      debt: 2,
      'escalate:review_failed+review_limit': 1,
      first_pass: 1,
      'node_s:code': 61,
      'node_s:gate': 0,
      'node_s:review': 30,
      recoveries: 1,
      'rounds:1': 1,
      'rounds:3': 1,
      'state:failed': 1,
      metrics: { firstPass: 0, firstPass_unknown: 0 },
      unreadable: [],
    });
    // An unreadable ledger is reported explicitly rather than inferred from a missing repo.
    writeFileSync(join(home, 'runs', 'gone.json'), '{"run_id":"gone"');
    const bad = captured(() => main(['report', '--full']));
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.out) as { unreadable: string[] }).unreadable[0]).toStartWith('gone: ');
  });
  test('land prints land.json; exits 1 before the land node ran', () => {
    withArtifacts('completed', { 'land.json': { commands: ['c'] } });
    expect(captured(() => main(['land', 'sa1'])).out).toContain('"c"');
    expect(() => main(['land', 'sa1', '--apply'])).toThrow(
      'legacy delivery removed; run is terminal'
    );
    expect(() => main(['accept', 'sa1'])).toThrow('legacy delivery removed; run is terminal');
    withArtifacts('running', {});
    expect(captured(() => main(['land', 'sa1'])).code).toBe(1);
  });
  test('integration states stay typed and land --apply retries PUBLISH without legacy delivery', () => {
    const s = stub([run('failed')]),
      output = join(s.root, 'home'),
      dirty = run('failed', {
        output_root: output,
        nodes: [
          { nodeId: 'integrate-m1.resync-m1', state: 'completed' },
          { nodeId: 'integrate-m1.publish-m1', state: 'failed' },
        ],
      }),
      art = join(output, 'artifacts/runs/r');
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(dirty));
    mkdirSync(art, { recursive: true });
    writeFileSync(
      join(art, 'publish-m1.json'),
      JSON.stringify({ status: 'dirty', reason: 'target_dirty', paths: ['untracked: "dirty.txt"'] })
    );
    expect(classifyRun(s.ledger, dirty).state).toBe('target_dirty');
    const status = captured(() => main(['wait', 'sa1', '--timeout', '1']));
    expect(JSON.parse(status.out).receipt).toMatchObject({
      reason: 'target_dirty',
      evidence_path: join(art, 'publish-m1.json'),
      action: 'superagent land --apply sa1',
    });
    writeFileSync(join(art, 'publish-m1.json'), JSON.stringify({ reason: 'target_advanced' }));
    const advanced = run('failed', {
      output_root: output,
      nodes: [{ nodeId: 'integrate-m1.publish-m1', state: 'failed' }],
    });
    expect(classifyRun(s.ledger, advanced).state).toBe('target_advanced');
    writeFileSync(join(art, 'publish-m1.json'), JSON.stringify({ reason: 'review_stale' }));
    expect(classifyRun(s.ledger, advanced).state).toBe('review_stale');
    writeFileSync(join(art, 'resync-m1.json'), JSON.stringify({ status: 'conflict' }));
    const conflict = run('failed', {
      output_root: output,
      nodes: [{ nodeId: 'integrate-m1.resync-m1', state: 'failed' }],
    });
    expect(classifyRun(s.ledger, conflict).state).toBe('sync_conflict');
    writeFileSync(
      join(art, 'resolve-resync-m1-decision.json'),
      JSON.stringify({
        decision: { kind: 'block', reason: 'coder_needs', evidence: [], debt: [] },
      })
    );
    mkdirSync(join(s.root, 'gen/.archon/workflows/sa-sa1'), { recursive: true });
    writeFileSync(
      join(s.root, 'gen/.archon/workflows/sa-sa1/sa-sa1.yaml'),
      'nodes:\n  - id: attempt-m1\n  - id: resolve-resync-m1-decision\n'
    );
    const blockedResolve = run('failed', {
      output_root: output,
      nodes: [{ nodeId: 'integrate-m1.resolve-resync-m1-decision', state: 'failed' }],
    });
    expect(classifyRun(s.ledger, blockedResolve)).toMatchObject({
      state: 'held:gate',
      node: 'integrate-m1.resolve-resync-m1-decision',
    });
    writeFileSync(
      join(art, 'publish-m1.json'),
      JSON.stringify({ status: 'dirty', reason: 'target_dirty', paths: ['untracked: "dirty.txt"'] })
    );
    expect(captured(() => main(['land', 'sa1', '--apply'])).code).toBe(0);
    expect(s.calls()).toContain('workflow resume r --detach --json');
  });
  test('LAND CLI prints a missing-target reason and returns failure without merge commands', () => {
    withArtifacts('failed', {
      'land.json': { commands: [], reason: 'land_target_unknown', action: 'Choose a local branch' },
    });
    const result = captured(() => main(['land', 'sa1']));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ commands: [], reason: 'land_target_unknown' });
  });
});

test('supervise tick wakes all four native due continuation classes', () => {
  const s = stub([run('running')]);
  const ids = ['timed', 'event', 'scheduled', 'retry'];
  for (const [index, id] of ids.entries())
    writeFileSync(
      ledgerPath(`sa${index + 1}`),
      JSON.stringify({ ...s.ledger, run_id: `sa${index + 1}`, archon_run_id: id })
    );
  s.due.mockReturnValue(ids);
  const snapshot = spyOn(archonMod, 'getRun').mockImplementation(id => ({ ...run('running'), id }));
  try {
    expect(captured(() => main(['supervise-tick'])).code).toBe(0);
    expect(s.calls().filter(call => call.startsWith('workflow wake'))).toHaveLength(4);
    expect(s.due).toHaveBeenCalledTimes(1);
  } finally {
    snapshot.mockRestore();
  }
});

test('supervise tick starts no wakes when native due query is empty', () => {
  const s = stub([run('running')]);
  s.due.mockReturnValue([]);
  expect(captured(() => main(['supervise-tick'])).code).toBe(0);
  expect(s.calls().filter(call => call.startsWith('workflow wake'))).toHaveLength(0);
});

test('supervise tick reports due query errors without waking', () => {
  const s = stub([run('running')]);
  s.due.mockImplementation(() => {
    throw new Error('due query unavailable');
  });
  const result = captured(() => main(['supervise-tick']));
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).actions).toContainEqual({
    run_id: 'continuations',
    action: 'error',
    ok: false,
    error: 'due query unavailable',
  });
  expect(s.calls().filter(call => call.startsWith('workflow wake'))).toHaveLength(0);
});

describe('supervise-tick (archon + supervisor stubs)', () => {
  const syncDecisions = async () => ({ accepted: 0, ignored: 0, failed: 0 });
  const publishDecisions = async () => undefined;
  const supervised = (
    refresh?: () => Promise<unknown>,
    sync?: (snapshot: Snapshot) => Promise<unknown>
  ): Promise<number> =>
    superviseTickCli(
      refresh,
      sync,
      {},
      undefined,
      undefined,
      undefined,
      syncDecisions,
      publishDecisions
    );
  test('fast tick excludes cleanup and maintenance retains cleanup tasks', () => {
    const s = stub([run('completed')]);
    s.gc.mockReturnValue([
      { run_id: 'old', object: 'run', action: 'skipped', reason: 'retained' },
      { run_id: 'gone', object: 'run', action: 'removed', reason: 'terminal' },
    ]);
    s.scratch.mockReturnValue([
      { path: '/tmp/kept', action: 'skipped', reason: 'live' },
      { path: '/tmp/gone', action: 'removed', reason: 'exited' },
    ]);
    const { code, out } = captured(() => main(['supervise-tick'])),
      result = JSON.parse(out);
    expect(code).toBe(0);
    expect(out.split('\n')).toHaveLength(1);
    expect(result).toMatchObject({
      actions: [],
      skipped_terminal: 0,
      gc: [],
      scratch: [],
      gc_skipped: 0,
      scratch_skipped: 0,
    });
    maintenanceTick(join(s.root, 'home'), {
      memory: () => undefined,
      reflection: () => undefined,
      gc: s.gc,
      scratch: s.scratch,
    });
    expect(s.gc).toHaveBeenCalledTimes(1);
    expect(s.scratch).toHaveBeenCalledTimes(1);
  });
  test('terminal cache skips unchanged runs and invalidates on ledger or revision changes', () => {
    const s = stub([run('completed')]),
      db = revisionDb();
    s.due.mockReturnValue([]);
    const gets = () => s.calls().filter(call => call.startsWith('workflow get r')).length;
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 1 });
    expect(gets()).toBe(1);
    writeFileSync(ledgerPath('sa1'), JSON.stringify({ ...s.ledger, transcript: 'changed' }));
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 1 });
    db.run("update remote_agent_workflow_runs set last_activity_at = 'changed' where id = 'r'");
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(gets()).toBe(3);
    db.close();
  });
  test('failed runs settle only without a future deadline', () => {
    const s = stub([run('failed')]),
      db = revisionDb();
    s.due.mockReturnValue([]);
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 1 });
    writeFileSync(
      join(s.ledger.gen_dir, 'plan.json'),
      JSON.stringify({ packages: [], deadline: '2099-01-01T00:00:00.000Z' })
    );
    writeFileSync(ledgerPath('sa1'), JSON.stringify({ ...s.ledger, transcript: 'changed' }));
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    db.close();
  });
  test('unchanged permanent errors are counted until their ledger input changes', () => {
    const s = stub([run('completed')]),
      path = ledgerPath('sa1');
    writeFileSync(path, JSON.stringify({ ...s.ledger, controller: undefined }));
    expect(captured(() => main(['supervise-tick'])).code).toBe(1);
    const repeated = captured(() => main(['supervise-tick']));
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.out)).toMatchObject({ actions: [], repeated_errors: 1 });
    writeFileSync(
      path,
      JSON.stringify({ ...s.ledger, controller: undefined, transcript: 'changed' })
    );
    expect(captured(() => main(['supervise-tick']))).toMatchObject({ code: 1 });
    writeFileSync(path, JSON.stringify(s.ledger));
    expect(captured(() => main(['supervise-tick'])).code).toBe(0);
    expect(s.calls().some(call => call.startsWith('workflow get r '))).toBe(true);
  });
  test('snapshot executors merge terminal cache entries from other groups', () => {
    const s = stub([run('completed')]),
      snapshot = activateEngineFixture(s);
    for (const id of ['sa1', 'sa2'])
      writeFileSync(
        ledgerPath(id),
        JSON.stringify({
          ...s.ledger,
          run_id: id,
          engine_snapshot: snapshot,
          controller: undefined,
        })
      );
    expect(cliMod.superviseTick({ runs: ['sa1'], noGlobal: true })).toMatchObject({
      actions: [{ run_id: 'sa1', action: 'error' }],
    });
    expect(cliMod.superviseTick({ runs: ['sa2'], noGlobal: true })).toMatchObject({
      actions: [{ run_id: 'sa2', action: 'error' }],
    });
    expect(
      Object.keys(
        JSON.parse(readFileSync(join(s.root, 'home/supervise-terminal.json'), 'utf8'))
      ).sort()
    ).toEqual(['sa1', 'sa2']);
  });
  test('snapshot executor reads and queries revisions only for selected ledgers', () => {
    const s = stub([run('completed')]),
      snapshot = activateEngineFixture(s),
      db = revisionDb();
    writeFileSync(
      ledgerPath('sa2'),
      JSON.stringify({ ...s.ledger, run_id: 'sa2', archon_run_id: 'r2', engine_snapshot: snapshot })
    );
    db.run("insert into remote_agent_workflow_runs values ('r2', 'completed', 'a', 'b', '{}')");
    const read = spyOn(fs, 'readFileSync'),
      revisions = spyOn(archonMod, 'reportRunRevisions');
    fixtureSpies.push(read, revisions);
    cliMod.superviseTick({ runs: ['sa1'], noGlobal: true });
    expect(
      read.mock.calls.filter(([path]) => String(path).endsWith('/runs/sa1.json'))
    ).not.toHaveLength(0);
    expect(
      read.mock.calls.filter(([path]) => String(path).endsWith('/runs/sa2.json'))
    ).toHaveLength(0);
    expect(revisions).toHaveBeenCalledWith(['r']);
    db.close();
  });
  test('activated scheduler groups real ledgers without entering an executor', () => {
    const s = stub([run('completed')]),
      snapshot = activateEngineFixture(s);
    expect(cliMod.superviseTick({ schedule: true })).toMatchObject({
      groups: [{ snapshot, runs: ['sa1'] }],
      global: { actions: [] },
    });
    expect(s.calls().some(call => call.startsWith('workflow get'))).toBe(false);
  });
  test('scheduler grouping keeps actionable changes and classifies unavailable snapshots', () => {
    const s = stub([run('completed')]),
      stat = { mtimeMs: 1, size: 2 },
      revision = 'revision',
      cache = { sa1: JSON.stringify(['r', 1, 2, revision]) },
      input: Parameters<typeof cliMod.scheduleTickGroups>[0] = [[s.ledger, stat, s.root]],
      revisions = new Map([['r', revision]]);
    expect(cliMod.scheduleTickGroups(input, cache, revisions, {}, new Set()).groups).toEqual([]);
    for (const [asks, due, changed] of [
      [{ 'sa1:hold': { status: 'pending' } }, new Set<string>(), stat],
      [{}, new Set(['r']), stat],
      [{}, new Set<string>(), { mtimeMs: 2, size: 2 }],
    ] as const)
      expect(
        cliMod.scheduleTickGroups([[s.ledger, changed, s.root]], cache, revisions, asks, due).groups
      ).toEqual([{ snapshot: s.root, runs: ['sa1'] }]);
    const missing: Parameters<typeof cliMod.scheduleTickGroups>[0] = ['done', 'failed'].map(
      run_id => [
        { ...s.ledger, run_id, archon_run_id: run_id },
        stat,
        undefined,
        run_id === 'done' ? 'completed' : 'failed',
      ]
    );
    expect(cliMod.scheduleTickGroups(missing, {}, null, {}, new Set()).unavailable).toEqual({
      count: 1,
      runs: ['failed'],
    });
  });
  test('scheduler skips rejected runs only after pending asks are resolved', () => {
    const s = stub([run('cancelled')]),
      input: Parameters<typeof cliMod.scheduleTickGroups>[0] = [
        [{ ...s.ledger, rejected: s.ledger.archon_run_id }, { mtimeMs: 1, size: 2 }, s.root],
      ];
    expect(cliMod.scheduleTickGroups(input, {}, null, {}, undefined).groups).toEqual([]);
    expect(
      cliMod.scheduleTickGroups(input, {}, null, { 'sa1:hold': { status: 'pending' } }, undefined)
        .groups
    ).toEqual([{ snapshot: s.root, runs: ['sa1'] }]);
  });
  test('snapshot tick CLI leaves global console and Orca work to the scheduler', async () => {
    const s = stub([run('completed')]),
      calls = { refresh: 0, sync: 0 },
      out = spyOn(console, 'log').mockImplementation(() => undefined),
      refresh = async () => void calls.refresh++,
      sync = async () => void calls.sync++,
      snapshot = { at: new Date().toISOString(), summary: {}, rows: [] } as Snapshot;
    try {
      await superviseTickCli(refresh, sync, {}, async () => snapshot);
      expect(existsSync(join(s.root, 'home/heartbeat.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(s.root, 'home/tick.json'), 'utf8'))).toMatchObject({
        collect: { ok: true },
        publish: { ok: true },
        orca: { ok: true },
      });
      const globalTick = readFileSync(join(s.root, 'home/tick.json'), 'utf8');
      activateEngineFixture(s);
      await superviseTickCli(refresh, sync, { runs: ['sa1'], noGlobal: true });
      expect(calls).toEqual({ refresh: 1, sync: 1 });
      expect(readFileSync(join(s.root, 'home/tick.json'), 'utf8')).toBe(globalTick);
    } finally {
      out.mockRestore();
    }
  });
  test('tick completes and observes each minute, reclaims every 300 seconds, and isolates reclaim failure', async () => {
    const s = stub([run('completed')]),
      c = new coordModule.Coordination({ sa: join(s.root, 'home'), runs: () => [] });
    let now = 0;
    const r = new Reclaimer(c, () => now),
      complete = spyOn(r, 'complete'),
      observe = spyOn(r, 'observe'),
      reclaim = spyOn(r, 'reclaim');
    const out = spyOn(console, 'log').mockImplementation(() => undefined),
      snapshot = { at: new Date().toISOString(), summary: {}, rows: [] } as Snapshot;
    try {
      const tick = () =>
        superviseTickCli(
          async () => undefined,
          async () => undefined,
          {},
          async () => snapshot,
          () => reclaimTick(now, r)
        );
      await tick();
      now = 299_999;
      await tick();
      now = 300_000;
      await tick();
      expect([
        complete.mock.calls.length,
        observe.mock.calls.length,
        reclaim.mock.calls.length,
      ]).toEqual([3, 3, 2]);
      rmSync(join(s.root, 'home/heartbeat.json'));
      reclaim.mockImplementation(() => {
        throw new Error('fixture reclaim');
      });
      now = 600_000;
      await tick();
      const record = JSON.parse(readFileSync(join(s.root, 'home/tick.json'), 'utf8'));
      expect(record.reclaim).toMatchObject({ ok: false, error: 'fixture reclaim' });
      expect(record.reclaim.duration_ms).toBeNumber();
      expect(existsSync(join(s.root, 'home/heartbeat.json'))).toBe(true);
    } finally {
      out.mockRestore();
    }
  });
  test('heartbeat exposes non-empty scheduler groups and unavailable runs', async () => {
    const s = stub([run('completed')]),
      out = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await superviseTickCli(
        async () => undefined,
        async () => undefined,
        { schedule: true }
      );
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).not.toHaveProperty('groups');
      const snapshot = activateEngineFixture(s);
      await superviseTickCli(
        async () => undefined,
        async () => undefined,
        { schedule: true }
      );
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
        groups: [{ snapshot, runs: ['sa1'] }],
      });
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).not.toHaveProperty('unavailable');
      for (const run_id of ['sa1', 'sa2'])
        writeFileSync(
          ledgerPath(run_id),
          JSON.stringify({
            ...s.ledger,
            run_id,
            archon_run_id: run_id,
            engine_snapshot: join(s.root, 'missing'),
          })
        );
      await superviseTickCli(
        async () => undefined,
        async () => undefined,
        { schedule: true }
      );
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).unavailable).toEqual({
        count: 2,
        runs: ['sa1', 'sa2'],
      });
    } finally {
      out.mockRestore();
    }
  });
  test('heartbeat records every fast-stage duration before launching maintenance', async () => {
    const s = stub([run('completed')]);
    const out = spyOn(console, 'log').mockImplementation(() => undefined);
    let launched = 0;
    try {
      await superviseTickCli(
        async () => undefined,
        async () => undefined,
        {},
        undefined,
        undefined,
        () => launched++
      );
      const record = JSON.parse(readFileSync(join(s.root, 'home/tick.json'), 'utf8'));
      expect(
        [
          'reclaim',
          'collect',
          'publish',
          'console',
          'ntfy_sync',
          'actions',
          'ntfy_publish',
          'failover',
          'orca',
        ].every(stage => typeof record[stage]?.duration_ms === 'number')
      ).toBe(true);
      expect(launched).toBe(1);
    } finally {
      out.mockRestore();
    }
  });
  test('an unresolved ask prevents terminal skipping and remains live', () => {
    const s = stub([run('cancelled')]),
      db = revisionDb();
    s.due.mockReturnValue([]);
    cliMod.superviseTick();
    const path = join(s.root, 'home', 'asks.json');
    writeFileSync(path, JSON.stringify({ 'sa1:fixture': { status: 'pending' } }));
    expect(cliMod.superviseTick()).toMatchObject({ skipped_terminal: 0 });
    expect(s.calls().filter(call => call.startsWith('workflow get r'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('sa1:fixture');
    db.close();
  });
  test('ORCA1 sync runs after tick and its failure preserves both tick exit codes', async () => {
    for (const failed of [false, true]) {
      const s = stub([humanWait()]);
      if (failed) writeFileSync(join(s.root, 'home', 'asks.json'), '{');
      const out = spyOn(console, 'log').mockImplementation(() => undefined);
      const err = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const baseline = await supervised(
          async () => undefined,
          async () => undefined
        );
        expect(baseline).toBe(failed ? 1 : 0);
        for (const returned of [false, true]) {
          const printed = out.mock.calls.length;
          const exit = await supervised(
            async () => undefined,
            async () => {
              expect(out.mock.calls.length).toBe(printed);
              if (!failed)
                expect(readFileSync(join(s.root, 'home', 'asks.json'), 'utf8')).toContain(
                  'pending'
                );
              if (returned) return { error: 'injected\nreason' };
              throw new Error('injected\nreason');
            }
          );
          expect(exit).toBe(0);
          expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
            error_count: failed ? 2 : 1,
            errors: failed
              ? [
                  expect.stringContaining('commander failover failed: asks '),
                  expect.stringContaining('orca sync failed: injected'),
                ]
              : [expect.stringContaining('orca sync failed: injected')],
          });
          expect(err).not.toHaveBeenCalled();
        }
        expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(s.calls()).not.toContain('workflow wake --json');
    }
  });
  for (const failed of [false, true]) {
    test(`HF8 injected console failure preserves tick exit ${failed ? 1 : 0}`, async () => {
      const s = stub([humanWait()]);
      if (failed) writeFileSync(join(s.root, 'home', 'asks.json'), '{');
      const out = spyOn(console, 'log').mockImplementation(() => undefined);
      const err = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const message = 'refresh injected\noriginal error';
        expect(
          await supervised(() => {
            throw new Error(message);
          })
        ).toBe(failed ? 1 : 0);
        const result = JSON.parse(String(out.mock.calls[0]?.[0]));
        expect(result).toMatchObject({ action_count: 1, error_count: failed ? 3 : 1 });
        expect(result.errors).toEqual([
          `console refresh failed: ${message}`,
          ...(failed ? [expect.stringContaining('commander failover failed: asks ')] : []),
        ]);
        expect(result.details[0]).toMatchObject({ action: failed ? 'error' : 'ask', ok: !failed });
        expect(err).not.toHaveBeenCalled();
        expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(s.calls()).not.toContain('workflow wake --json');
    });
  }
  test('supervise tick rotates three generations and refuses a symlink log', async () => {
    const s = stub([humanWait()]),
      log = join(s.root, 'home/supervise-tick.log'),
      target = join(s.root, 'large.log');
    writeFileSync(`${log}.1`, 'one');
    writeFileSync(`${log}.2`, 'two');
    writeFileSync(`${log}.3`, 'old');
    writeFileSync(log, '');
    fs.truncateSync(log, 10 * 1024 * 1024 + 1);
    await superviseTickCli(
      async () => undefined,
      async () => undefined
    );
    expect(statSync(`${log}.1`).size).toBe(10 * 1024 * 1024 + 1);
    expect(readFileSync(`${log}.2`, 'utf8')).toBe('one');
    expect(readFileSync(`${log}.3`, 'utf8')).toBe('two');
    writeFileSync(target, '');
    fs.truncateSync(target, 10 * 1024 * 1024 + 1);
    symlinkSync(target, log);
    await superviseTickCli(
      async () => undefined,
      async () => undefined
    );
    expect(fs.lstatSync(log).isSymbolicLink()).toBe(true);
  });
  test('HF8 CLI still ticks when refreshConsole rejects an ambiguous legacy owner', async () => {
    const s = stub([humanWait()]);
    // Parent spies do not cross the CLI process boundary. Keep real cleanup confined
    // to this fixture, as scratch.test.ts does, rather than scanning operator sessions.
    const preload = join(s.root, 'scratch-preload.cjs');
    writeFileSync(
      preload,
      `const scratch = require(${JSON.stringify(join(WETAMP, 'hooks/scratch.cjs'))});
Object.assign(scratch, scratch.createScratch(${JSON.stringify(join(s.root, 'scratch'))}));\n`
    );
    writeFileSync(
      join(s.root, 'home', 'web.json'),
      JSON.stringify({
        pid: process.pid,
        port: 0,
        token: 'synthetic',
        started_at: new Date().toISOString(),
      })
    );
    const p = Bun.spawn([BIN, 'supervise-tick', '--json'], {
      env: {
        ...process.env,
        BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ''} --preload=${preload}`.trim(),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    expect(await p.exited).toBe(0);
    const result = JSON.parse(out);
    expect(result.errors).toEqual([
      'console refresh failed: console owner ambiguous; legacy PID migration refused: argv',
    ]);
    expect(result).toMatchObject({ action_count: 1, error_count: 1 });
    expect(result.details[0]).toMatchObject({ action: 'ask', ok: true });
    expect(err).toBe('');
    expect(await eventually(s.calls, 'workflow wake r --json')).toBeDefined();
    expect(s.calls()).not.toContain('workflow wake --json');
  });
  test('maintenance is nonblocking and never owns supervise.lock', () => {
    const sa = join(tmp(), 'home');
    mkdirSync(sa, { recursive: true });
    const held = archonMod.lock(join(sa, 'maintenance.lock'));
    if (!held.ok) throw new Error('maintenance lock not taken');
    expect(maintenanceTick(sa)).toMatchObject({
      maintenance: { skipped: 'maintenance_running', duration_ms: 0 },
    });
    held.release();
    const calls: string[] = [];
    const result = maintenanceTick(sa, {
      memory: () => {
        const heartbeat = archonMod.lock(join(sa, 'supervise.lock'));
        expect(heartbeat.ok).toBe(true);
        if (heartbeat.ok) heartbeat.release();
        calls.push('memory');
      },
      reflection: () => calls.push('reflection'),
      gc: () => {
        calls.push('gc');
        return [];
      },
      scratch: () => {
        calls.push('scratch');
        return [];
      },
    });
    expect(calls).toEqual(['memory', 'reflection', 'gc', 'scratch']);
    expect(result).toMatchObject({ maintenance: { ok: true } });
  });
});

describe('RCPT consumed decision receipts', () => {
  test('RCPT brief/status select the latest answer for this run, including out-of-order asks', () => {
    const s = stub([run('completed')]);
    const receipt = (body: string, at?: string) => ({ key: body, body, ...(at ? { at } : {}) });
    const saved = {
      'sa1:latest': {
        status: 'approved',
        receipt: receipt('最新答复', '2026-10-11T12:00:00.000Z'),
      },
      'other:signoff': {
        status: 'approved',
        receipt: receipt('其他run', '2026-10-12T12:00:00.000Z'),
      },
      'sa1:older': { status: 'approved', receipt: receipt('较早答复', '2026-10-11T11:00:00.000Z') },
      'sa1:legacy': { status: 'approved', receipt: receipt('旧版答复') },
      'sa1:pending': { status: 'pending' },
    };
    writeFileSync(join(s.root, 'home', 'asks.json'), JSON.stringify(saved));
    const lines = captured(() => main(['brief', 'sa1'])).out.split('\n');
    expect(lines).toContain('receipt: 最新答复');
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(captured(() => main(['status', 'sa1'])).out).receipt).toBe('最新答复');
  });
});

describe('explicit continuation (supervise-tick, archon stub)', () => {
  /** 失败在 failedNode 的 run；gen 带 attempt-m1 节点；artifacts 按 files 写入。 */
  const held = (failedNode: string, files: Record<string, unknown> = {}, attempt = true) => {
    const s = stub([]);
    const art = join(s.root, 'out', 'artifacts', 'runs', 'r');
    mkdirSync(art, { recursive: true });
    for (const [f, v] of Object.entries(files)) writeFileSync(join(art, f), JSON.stringify(v));
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify(
        run('failed', {
          output_root: join(s.root, 'out'),
          nodes: [{ nodeId: failedNode, state: 'failed' }],
        })
      )
    );
    const pkg = { accept: [], risk: 'G1', milestone: 'm1' };
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({
        deadline: '2099-01-01T00:00:00Z',
        packages: [
          { ...pkg, id: 'core' },
          { ...pkg, id: 'api' },
        ],
      })
    );
    const wf = join(s.root, 'gen', '.archon', 'workflows', 'sa-sa1');
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, 'sa-sa1.yaml'),
      attempt ? 'nodes:\n  - id: attempt-m1\n' : 'nodes: []\n'
    );
    return { ...s, art };
  };
  const tick = (expectedCode = 0): Record<string, unknown>[] => {
    const { code, out } = captured(() => main(['supervise-tick']));
    expect(code).toBe(expectedCode);
    return JSON.parse(out).actions as Record<string, unknown>[];
  };
  const resumes = (calls: string[]): number =>
    calls.filter(c => c.startsWith('workflow resume')).length;
  const gate = (reason: string) => ({
    verdict: 'escalate',
    reason,
    milestone: 'm1',
    debt: [],
    decision: { kind: 'block', reason, evidence: ['events:code-core:0'], debt: [] },
  });

  test('false handback auto-retries once with correction, then remains held', () => {
    const s = held('verify-core', { 'verify-core.json': gate('false_handback') });
    const workflow = join(s.root, 'gen', '.archon', 'workflows', 'sa-sa1', 'sa-sa1.yaml');
    writeFileSync(workflow, 'nodes:\n  - id: attempt-m1\n  - id: package-attempt-core\n');
    expect(tick()[0]).toMatchObject({ action: 'auto_retry', ok: true, reason: 'false_handback' });
    expect(readFileSync(join(s.root, 'gen', 'hints', 'core.md'), 'utf8')).toContain(
      '最后一条回复才输出 JSON'
    );
    expect(loadLedger('sa1').auto_retries).toHaveLength(1);
    expect(tick(EXIT.failed)[0]).toMatchObject({
      action: 'none',
      held: true,
      state: 'held:recovery_admission_unknown',
    });
    expect(resumes(s.calls())).toBe(0);
    expect(s.calls().filter(call => call.startsWith('workflow run '))).toHaveLength(1);
    expect(s.calls().find(call => call.startsWith('workflow run '))).toContain('--supersedes r');
    expect(loadLedger('sa1').auto_retries).toHaveLength(1);
  });

  test('stale continuation guards reject non-owner, status races, and rejected runs without ledger writes', () => {
    const stale = (responses: RunView[], edit: (ledger: Ledger) => void = () => {}) => {
      const s = stub(responses),
        engine = join(s.root, 'home/engine');
      mkdirSync(engine, { recursive: true });
      symlinkSync(realpathSync(join(WETAMP, '..')), join(engine, 'current'));
      s.ledger.engine_snapshot = join(s.root, 'missing-engine');
      edit(s.ledger);
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      return s;
    };
    const unchanged = (args: string[], throws = false) => {
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      if (throws) expect(() => main(args)).toThrow();
      else expect(captured(() => main(args)).code).toBe(1);
      expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
    };
    stale([run('failed')], ledger => ledger.controller!.pid++);
    unchanged(['resume', 'sa1'], true);

    stale([run('failed'), run('paused')]);
    expect(continuationOnCurrent('sa1').current).toBe(true);
    unchanged(['resume', 'sa1']);

    stale([run('failed')], ledger => (ledger.rejected = 'r'));
    unchanged(['recover', 'sa1']);

    const served = stale([run('failed')]),
      current = join(served.root, 'home/engine/current');
    unlinkSync(current);
    mkdirSync(join(served.root, 'other-engine'));
    symlinkSync(join(served.root, 'other-engine'), current);
    unchanged(['resume', 'sa1']);
  });

  test('stale held-gate retry carries attempts, hints, and approvals but rejects stale review checkpoints', () => {
    const s = held('verify-core', {
        'verify-core.json': { decision: gate('coder_needs').decision },
      }),
      plan = JSON.parse(readFileSync(fixturePlan(s.root, s.root), 'utf8')) as Plan;
    fixtureSpies.push(spyOn(generatorModule, 'generate').mockImplementation(fastGenerate));
    const gen = generate(plan, 'sa1', true);
    mkdirSync(join(gen.dir, 'hints'), { recursive: true });
    mkdirSync(join(gen.dir, 'approvals'), { recursive: true });
    writeFileSync(join(gen.dir, 'approvals/verify-core.json'), '{"approved":true}\n');
    mkdirSync(join(gen.dir, 'review-checkpoints'), { recursive: true });
    writeFileSync(join(gen.dir, 'review-checkpoints/m1.json'), '{"stale":true}\n');
    activateEngineFixture(s);
    s.ledger.gen_dir = gen.dir;
    s.ledger.engine_snapshot = join(s.root, 'missing-engine');
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    expect(
      captured(() => main(['decide', 'sa1', 'retry', '--pkg', 'core', '--hint', 'retry hint'])).code
    ).toBe(0);
    const adopted = loadLedger('sa1');
    expect(adopted).toMatchObject({
      archon_run_id: 'r2',
      adoptions: [expect.objectContaining({ from: 'r', to: 'r2' })],
    });
    for (const [path, value] of [
      ['attempts/.packages/core', '1'],
      ['hints/core.md', 'retry hint\n'],
      ['approvals/verify-core.json', '{"approved":true}\n'],
    ])
      expect(readFileSync(join(adopted.gen_dir, path), 'utf8')).toBe(value);
    expect(existsSync(join(adopted.gen_dir, 'review-checkpoints/m1.json'))).toBe(false);
  });

  test('empty unfinished delivery stays held with original blockers and needs in status and wait', () => {
    const blockers = ['需求尚未明确'];
    const needs = [{ cap: 'requirement_decision', why: '缺少输入', minimal_ask: '补充需求' }];
    const result = saCheck.disposition(
      JSON.stringify({ status: 'partial', blockers, needs }),
      true,
      {
        ok: true,
        diff_hash: 'empty',
        same: false,
        no_changes: true,
      }
    );
    held('verify-core', { 'verify-core.json': { ...result, ok: true, milestone: 'm1' } });
    for (const command of ['status', 'wait']) {
      const response = captured(() => main([command, 'sa1', '--timeout', '1']));
      const out = JSON.parse(response.out);
      expect(out.state).toBe('held:gate');
      expect(out.reason).toStartWith('needs:');
      expect(out.delivery).toContainEqual({ tag: 'verify-core', decision: result.decision });
      expect(out.delivery[0].decision).toMatchObject({ reason: 'coder_needs', blockers, needs });
    }
  });
  test('later coder_needs outrank an earlier failure and retry the existing package scope', () => {
    const blockers = ['scope conflict'];
    const needs = [{ cap: 'scope_decision', why: 'conflict', minimal_ask: 'choose scope' }];
    const result = gate('coder_needs');
    Object.assign(result.decision, { blockers, needs });
    const s = held('soldier-core', { 'verify-core.json': { ...result, milestone: 'm1' } });
    const view = JSON.parse(readFileSync(join(s.dir, 'get-000.json'), 'utf8')) as RunView;
    view.nodes!.push({ nodeId: 'verify-core', state: 'failed' });
    writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(view));
    appendFileSync(
      join(s.root, 'gen/.archon/workflows/sa-sa1/sa-sa1.yaml'),
      '  - id: package-attempt-core\n'
    );
    const status = JSON.parse(captured(() => main(['status', 'sa1'])).out);
    expect(status).toMatchObject({ state: 'held:gate', node: 'verify-core' });
    expect(status.delivery).toContainEqual({ tag: 'verify-core', decision: result.decision });
    expect(captured(() => main(['brief', 'sa1'])).out).toContain('superagent decide sa1 retry');
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(0);
    expect(readFileSync(join(s.root, 'gen/attempts/.packages/core'), 'utf8')).toBe('1');
    expect(existsSync(join(s.root, 'gen/attempts/m1'))).toBe(false);
  });
  test('decide stays refused when an earlier failure has no structured control artifact', () => {
    held('soldier-core');
    const status = JSON.parse(captured(() => main(['status', 'sa1'])).out);
    expect(status).toMatchObject({ state: 'failed', node: 'soldier-core' });
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(1);
  });
  test('single delivery decision: green redline self-report has identical status, brief and board projections', () => {
    const s = held('gate-m1-r1', {
      'verify-core.coder.json': {
        status: 'blocked',
        error_class: 'redline',
        needs: [{ cap: 'network' }],
        milestone: 'm1',
      },
      'gate-m1-r1.json': {
        ...gate('coder_redline'),
        decision: saCheck.deliveryDecision({
          rechecks: [{ ok: true, diff_hash: '', same: false }],
          reviewRounds: saCheck.reviewRoundLimit(loadTiers().policy),
        }).decision,
      },
    });
    const status = JSON.parse(captured(() => main(['status', 'sa1'])).out);
    const brief = captured(() => main(['brief', 'sa1'])).out;
    const view = JSON.parse(readFileSync(join(s.dir, 'get-000.json'), 'utf8')) as RunView;
    const board = detailOf(s.ledger, rowOf(s.ledger, view, { now: Date.now() }));
    expect(status.needs).toBeUndefined();
    expect(brief).not.toContain('need ');
    expect(brief).toContain('gate-m1-r1: pass debt=0');
    expect(board.needs).toEqual([]);
    expect(board.gates[0]).toMatchObject({ verdict: 'pass', reason: null });
  });
  test('M2-05 repair-p failed without green evidence enters an existing hold and accepts retry', () => {
    const s = held('repair-p');
    const r = JSON.parse(readFileSync(join(s.dir, 'get-000.json'), 'utf8')) as RunView;
    r.nodes = [{ nodeId: 'start-m1', state: 'completed' }, ...(r.nodes ?? [])];
    setGet(s.root, r);
    const planFile = join(s.root, 'gen', 'plan.json');
    const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { packages: { id: string }[] };
    plan.packages[0].id = 'p';
    writeFileSync(planFile, JSON.stringify(plan));
    patchLedger(s.root, {
      auto_retries: [{ milestone: 'm1', reason: 'coder:repair-p', at: '2026-10-10T10:00:00Z' }],
    });
    expect(tick()[0]).toMatchObject({
      action: 'none',
      held: true,
      reason: expect.stringContaining('coder'),
    });
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(0);
    expect(s.calls()).toContain('workflow resume r --detach --json');
  });
  test('I5 latest settle red evidence does not inherit first verify green; unknown reasons are suspect', () => {
    const s = held('settle-core', {
      'verify-core.json': { ok: true },
      'settle-core.json': {
        ok: false,
        decision: gate('repair_exhausted:acceptance_failed').decision,
      },
    });
    expect(tick()).toEqual([]);
    expect(
      classifyRun(
        s.ledger,
        run('failed', {
          output_root: join(s.root, 'out'),
          nodes: [{ nodeId: 'settle-core', state: 'failed' }],
        })
      ).state
    ).toBe('failed');
    expect(resumes(s.calls())).toBe(0);
    const u = held('gate-m1-r1', { 'gate-m1-r1.json': { reason: 'new_failure' } });
    expect(tick()[0]).toMatchObject({
      action: 'none',
      held: true,
      reason: expect.stringContaining('engine_suspect'),
    });
    expect(existsSync(join(u.root, 'home/incidents/sa1/sample.json'))).toBe(true);
  });
  test('only a recorded permission decision surfaces a current need', () => {
    const s = held('gate-m1-r1', { 'gate-m1-r1.json': gate('coder_redline') });
    expect(tick()).toEqual([]);
    const status = JSON.parse(captured(() => main(['status', 'sa1'])).out);
    expect(status.needs).toMatchObject([{ tag: 'gate-m1-r1', cap: 'permission' }]);
    expect(captured(() => main(['brief', 'sa1'])).out).toContain('need permission');
    expect(resumes(s.calls())).toBe(0);
  });
  test('terminal gate decisions refuse retry without changing attempts', () => {
    const terminal = held('gate-m1-r6', {
      'gate-m1-r6.json': gate('review_failed+review_limit'),
    });
    expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(1);
    expect(existsSync(join(terminal.root, 'gen', 'attempts', 'm1'))).toBe(false);
    expect(resumes(terminal.calls())).toBe(0);
    for (const sample of [
      { files: { 'gate-m1-r3.json': gate('finding_stuck') }, error: 'evidence missing' },
      {
        files: {
          'gate-m1-r3.json': gate('finding_stuck'),
          'gate-m1-r3.ledger.json': { review_rounds_used: { m1: 6 } },
        },
        error: 'exhausted review rounds',
      },
    ]) {
      const s = held('gate-m1-r3', sample.files);
      writeFileSync(join(s.root, 'gen', 'policy.json'), JSON.stringify(loadTiers().policy));
      expect(() => captured(() => main(['decide', 'sa1', 'retry']))).toThrow(sample.error);
      expect(existsSync(join(s.root, 'gen', 'attempts', 'm1'))).toBe(false);
      expect(resumes(s.calls())).toBe(0);
    }
  });

  test.each(['gate-m1-rresync1', 'fix-resync-m1-r2', 'resync-base-m1'])(
    'resync node %s retries the owning milestone',
    node => {
      const s = held(node, { [`${node}.json`]: gate('coder_partial') });
      const result = captured(() => main(['decide', 'sa1', 'retry']));
      expect(result.code, result.out).toBe(0);
      expect(readFileSync(join(s.root, 'gen', 'attempts', 'm1'), 'utf8')).toBe('1');
    }
  );

  /** 每个挂起原因一个场景：类型 Record<Hold, …> 让 HOLD_POLICY 新增一行而没有场景时编译失败。 */
  const patchLedger = (root: string, patch: Partial<Ledger>): void =>
    writeFileSync(
      join(root, 'home', 'runs', 'sa1.json'),
      JSON.stringify({ ...loadLedger('sa1'), ...patch })
    );
  const setGet = (root: string, r: RunView): void =>
    writeFileSync(join(root, 'stub', 'get-000.json'), JSON.stringify(r));
  const scenes: Record<Hold, () => { s: ReturnType<typeof held>; first: object }> = {
    signoff: () => {
      const s = held('x');
      setGet(s.root, humanWait());
      return { s, first: { action: 'ask', event: 'sa.human.m2', ask: 'ask-1' } };
    },
    deadline: () => {
      const s = held('environment');
      const plan = JSON.parse(readFileSync(join(s.root, 'gen', 'plan.json'), 'utf8')) as object;
      writeFileSync(
        join(s.root, 'gen', 'plan.json'),
        JSON.stringify({ ...plan, deadline: '2020-01-01T00:00:00Z' })
      );
      return { s, first: { action: 'cancel', reason: 'deadline', ok: true } };
    },
    gate: () => {
      const s = held('gate-m1-r1', { 'gate-m1-r1.json': gate('invalid_review') });
      return { s, first: { action: 'none', held: true, ok: true } };
    },
    coder: () => ({
      s: held('code-api'),
      first: { action: 'none', held: true, ok: true },
    }),
    coder_budget: () => {
      const s = held('code-core');
      setGet(
        s.root,
        run('failed', {
          working_path: '/preserved/worktree',
          nodes: [
            {
              nodeId: 'code-core',
              state: 'failed',
              execution: {
                lifecycle: {
                  status: 'failed',
                  error: 'typed failure',
                  providerFailure: { class: 'budget_exceeded', evidence: 'typed' },
                },
              },
            },
          ],
        } as unknown as Partial<RunView>)
      );
      return { s, first: { action: 'none', held: true, ok: true } };
    },
    environment: () => ({
      s: held('environment'),
      first: { action: 'none', held: true, ok: true },
    }),
    paused: () => ({ s: held('x'), first: {} }),
    no_change: () => {
      const s = held('gate-m1-r2', { 'gate-m1-r2.json': gate('no_change') });
      return { s, first: {} };
    },
    needs: () => ({
      s: held('gate-m1-r1', {
        'gate-m1-r1.json': gate('coder_needs'),
        'verify-core.coder.json': {
          status: 'blocked',
          error_class: 'env',
          needs: [{ cap: 'net', why: 'w', minimal_ask: 'm' }],
          milestone: 'm1',
        },
      }),
      first: {},
    }),
    redline: () => ({
      s: held('verify-api', {
        'verify-api.json': { milestone: 'm1', decision: gate('coder_redline').decision },
        'code-api.coder.json': {
          status: 'blocked',
          error_class: 'redline',
          needs: [],
          milestone: 'm1',
        },
      }),
      first: {},
    }),
    coder_blocked: () => ({
      s: held('verify-core', {
        'verify-core.json': { decision: gate('coder_error:sandbox_denied').decision },
      }),
      first: {},
    }),
    review_limit: () => ({
      s: held('gate-m1-r3', { 'gate-m1-r3.json': gate('review_failed+review_limit') }),
      first: {},
    }),
    review_not_independent: () => {
      const s = held('gate-m1-r1', {
        'gate-m1-r1.json': gate('review_not_independent:same_model'),
      });
      appendFileSync(
        join(s.root, 'gen', '.archon', 'workflows', 'sa-sa1', 'sa-sa1.yaml'),
        '  - id: attempt-review-m1-r1\n'
      );
      return { s, first: {} };
    },
    engine_suspect: () => ({ s: held('settle-core'), first: {} }),
    approval: () => {
      const s = held('x');
      setGet(
        s.root,
        run('paused', { metadata: { approval: { nodeId: 'review', pauseId: 'p1' } } })
      );
      return { s, first: {} };
    },
    stalled: () => {
      const s = held('x');
      setGet(
        s.root,
        run('running', {
          metadata: {
            execution_owner: { host: hostname(), pid: process.pid },
            tool_call_attention: [
              {
                streamId: 'stream-1',
                nodeId: 'code-core',
                provider: 'codex',
                kind: 'progress',
                toolCallId: 'call-1',
                name: 'exec',
                startedAt: '2026-10-18T00:00:00.000Z',
                lastProgressAt: '2026-10-18T00:01:00.000Z',
                raisedAt: '2026-10-18T00:02:00.000Z',
                thresholdMs: 60_000,
              },
            ],
          },
        } as unknown as Partial<RunView>)
      );
      return { s, first: {} };
    },
    auto_recover: () => {
      const lost = run('running', { metadata: { execution_owner: LOST } });
      const s = held('x');
      setGet(s.root, lost);
      runsDb(LOST);
      patchLedger(s.root, { auto_recover_paused: 'effects_unknown' });
      return { s, first: {} };
    },
    acceptance_adjudication: () => ({
      s: held('verify-core', {
        'verify-core.json': {
          decision: gate('acceptance_adjudication').decision,
          adjudication: {
            diff_hash: 'diff',
            contract_hash: 'contract',
            command: 'bun test',
            failed_tests: ['suite::case'],
            failure_digest: 'digest',
          },
        },
      }),
      first: {},
    }),
  };
  test('P2 approval of diff milestone retries that milestone and preserves prior approvals', () => {
    const artifact = (command: string) => ({
      decision: gate('acceptance_adjudication').decision,
      adjudication: {
        diff_hash: 'diff',
        contract_hash: 'contract',
        command,
        failed_tests: [`${command}::case`],
        failure_digest: `digest-${command}`,
      },
    });
    const s = held('diff-m1-r1', { 'diff-m1-r1.json': artifact('bun test b') });
    const prior = artifact('bun test a').adjudication;
    mkdirSync(join(s.ledger.gen_dir, 'approvals'), { recursive: true });
    writeFileSync(
      join(s.ledger.gen_dir, 'approvals/diff-m1-r1.json'),
      JSON.stringify({ ...prior, approvals: [prior] })
    );
    expect(captured(() => main(['brief', 'sa1'])).out).toContain('superagent decide sa1 approve');
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(0);
    expect(readFileSync(join(s.ledger.gen_dir, 'attempts/m1'), 'utf8')).toBe('1');
    expect(s.calls().some(call => call.startsWith('workflow run sa-sa1 '))).toBe(true);
    const saved = JSON.parse(
      readFileSync(join(s.ledger.gen_dir, 'approvals/diff-m1-r1.json'), 'utf8')
    );
    expect(saved.approvals.map((a: { command: string }) => a.command)).toEqual([
      'bun test a',
      'bun test b',
    ]);
  });

  test.each(['approve', 'reject', 'retry', 'resume', 'recover'])(
    'intervene leaves the ledger untouched when completed run refuses %s',
    action => {
      const s = stub([run('completed')]);
      const before = readFileSync(ledgerPath('sa1'), 'utf8');
      const args = ['resume', 'recover'].includes(action)
        ? [action, 'sa1']
        : ['decide', 'sa1', action];
      expect(captured(() => main(args)).code).toBe(1);
      expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
      expect(s.calls().some(c => /workflow (resume|run|cancel|abandon|signal)/.test(c))).toBe(
        false
      );
    }
  );

  test('intervene refuses approve past deadline without recording an event', () => {
    const { s } = scenes.signoff();
    writeFileSync(
      join(s.root, 'gen', 'plan.json'),
      JSON.stringify({ deadline: '2020-01-01T00:00:00Z' })
    );
    const before = readFileSync(ledgerPath('sa1'), 'utf8');
    expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(1);
    expect(readFileSync(ledgerPath('sa1'), 'utf8')).toBe(before);
  });

  test('intervene records failed decide only after execution and excludes private error contents', () => {
    const { s } = scenes.signoff();
    patchLedger(s.root, { intervention_events: [] });
    const signal = spyOn(archonMod, 'signalHuman').mockImplementation(() => {
      expect(loadLedger('sa1').intervention_events).toEqual([]);
      return { ok: false, reason: 'token=synthetic-private-message' };
    });
    try {
      expect(captured(() => main(['decide', 'sa1', 'approve'])).code).toBe(1);
      const events = loadLedger('sa1').intervention_events!;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'decide', ok: false, error: 'exit:1' });
      expect(['cli', 'commander']).toContain(events[0].source);
      expect(JSON.stringify(events)).not.toContain('synthetic-private-message');
    } finally {
      signal.mockRestore();
    }
  });

  for (const node of ['verify-core', 'settle-core']) {
    for (const reason of ['coder_redline', 'future_reason', '']) {
      test(`${node} ${reason || 'missing'} asks without model launch`, () => {
        const s = held(
          node,
          reason ? { [`${node}.json`]: { milestone: 'm1', decision: gate(reason).decision } } : {}
        );

        const expected =
          reason === 'coder_redline'
            ? 'redline'
            : reason === 'coder_needs'
              ? 'needs'
              : reason.startsWith('coder_error:')
                ? 'coder_blocked'
                : 'engine_suspect';
        if (reason) expect(tick()).toEqual([]);
        else
          expect(tick()[0]).toMatchObject({
            action: 'none',
            reason: expect.stringContaining(expected),
          });
        expect(resumes(s.calls())).toBe(0);
      });
    }
  }
  for (const reason of [
    'invalid_review+review_limit',
    'review_not_independent:reviewer_unknown',
    'review_not_independent:author_unknown',
  ]) {
    test(`gate ${reason} cannot silently auto retry`, () => {
      const s = held('gate-m1-r3', { 'gate-m1-r3.json': gate(reason) });

      expect(tick()).toEqual([]);
      expect(resumes(s.calls())).toBe(0);
    });
  }
});

describe('HF9 decision titles', () => {
  const artifact = (file: string, data: unknown) => {
    const out = data as { verdict?: string; reason?: string };
    return (file.startsWith('verify-') || file.startsWith('gate-')) && file.split('.').length === 2
      ? {
          ...out,
          decision: fixtureDecision(
            out.verdict === 'pass' ? 'advance' : 'block',
            out.reason ?? null
          ),
        }
      : data;
  };
  const setup = () => {
    const s = stub([]),
      repo = join(s.root, 'BestIFA');
    mkdirSync(repo);
    cpSync(join(s.root, 'gen'), join(repo, 'gen'), { recursive: true });
    Object.assign(s.ledger, { repo, gen_dir: join(repo, 'gen'), stalled: 3 });
    writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
    const plan = {
      deadline: '2099-01-01T00:00:00Z',
      budget: { enforcement: 'hard', launches: 1, weighted_tokens: 100 },
      packages: [
        {
          id: 'W4',
          title: 'W4验收',
          milestone: 'm1',
          accept: [{ cmd: 'synthetic-check', timeout_s: 1 }],
        },
      ],
    };
    writeFileSync(join(s.ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
    const wf = join(s.ledger.gen_dir, '.archon/workflows/sa-sa1');
    mkdirSync(wf, { recursive: true });
    writeFileSync(
      join(wf, 'sa-sa1.yaml'),
      'nodes:\n  - id: attempt-m1\n' +
        Array.from({ length: 61 }, (_, i) => `  - id: n${i}\n`).join('')
    );
    const r = run('failed', {
      output_root: join(repo, 'out'),
      nodes: [
        ...Array.from({ length: 13 }, (_, i) => ({ nodeId: `n${i}`, state: 'completed' })),
        { nodeId: 'verify-W4', state: 'failed' },
      ],
    });
    const art = join(repo, 'out/artifacts/runs/r');
    mkdirSync(art, { recursive: true });
    const put = (file: string, data: unknown): void =>
      writeFileSync(join(art, file), JSON.stringify(artifact(file, data)));
    put('verify-W4.json', { reason: 'acceptance_failed', failed: ['synthetic-check'] });
    put('verify-W4.coder.json', {
      milestone: 'm1',
      error_class: 'redline',
      blockers: ['只读检索命令被拒：无法确认shell写入目标（解析失败）'],
      needs: [{ cap: 'network', why: '依赖', minimal_ask: '请补齐依赖下载能力' }],
    });
    put('gate-m1-r3.json', {
      verdict: 'pass',
      rounds: 3,
      reason: 'review_not_independent:same_model',
    });
    put('gate-m1-r3.ledger.json', { blocking: [{ id: 'R1-1' }] });
    writeFileSync(
      join(s.dir, 'get-000.json'),
      JSON.stringify({ ...r, events: [{ event_type: 'node_started', step_name: 'code-W4' }] })
    );
    return { s, r, put, art };
  };
  const details: Record<string, string> = {
    redline: '将军命中红线',
    needs: '证据缺失',
    coder_blocked: '将军受执行约束阻断',
    review_limit: '轮次3，未决1',
    review_not_independent: 'same_model',
    approval: '等待批准',
    signoff: '验收/评审通过',
  };
  for (const [hold, policy] of Object.entries(HOLD_POLICY) as [Hold, Policy][]) {
    if (policy.do !== 'ask' && policy.do !== 'signoff') continue;
    if (hold === 'stalled' || hold === 'auto_recover') continue;
    test(`HF9 ${hold}: project, node, evidence, truthful actions and ≤200 characters`, () => {
      const { s, r } = setup();
      const node = hold.startsWith('review')
        ? 'gate-m1-r3'
        : hold === 'signoff'
          ? 'human-m1'
          : 'verify-W4';
      r.metadata = { approval: { nodeId: node, type: 'merge_review' } };
      const q = decisionQuestion(
        s.ledger,
        r,
        { state: node.startsWith('gate-') ? 'held:gate' : 'failed', exit: 1, node },
        hold
      );
      expect(q).toContain('BestIFA/');
      expect(q).toContain(node);
      expect(q).toContain('已完成13/62节点');
      expect(q).toContain(details[hold] ?? '验收失败');
      expect(q).toContain('是=');
      expect(q).toContain('否=终止整个run（保留证据）');
      expect(q).not.toContain('放行');
      expect(q).not.toContain('synthetic-check');
      expect(Array.from(q).length).toBeLessThanOrEqual(200);
      if (policy.do === 'ask' && policy.yes === 'retry')
        expect(q).toContain('重跑m1累计验收→评审一次');
    });
  }
  const bestIFA = () => {
    const f = setup(),
      plan = JSON.parse(readFileSync(join(f.s.ledger.gen_dir, 'plan.json'), 'utf8')) as Plan;
    plan.packages = Array.from({ length: 11 }, (_, i) => ({
      ...plan.packages[0],
      id: `W${i + 1}`,
      title: `W${i + 1}验收`,
    }));
    writeFileSync(join(f.s.ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
    f.r.nodes = [
      ...['W1', 'W2', 'W3'].flatMap(id =>
        ['code', 'verify', 'repair', 'settle'].map(kind => ({
          nodeId: `${kind}-${id}`,
          state: 'completed',
        }))
      ),
      { nodeId: 'start-m1', state: 'completed' },
      { nodeId: 'verify-W4', state: 'failed' },
    ];
    return f;
  };
  test('HF9 R3 maximum identifiers and unbounded schema names preserve reasons, facts, actions and marker', () => {
    // schema: id ≤64, milestone ≤32; repo basename ≤255 on disk, title has no maximum.
    for (const hold of ['signoff'] as Hold[]) {
      const { s, r, put } = bestIFA();
      const oldRepo = s.ledger.repo,
        repo = join(s.root, 'R'.repeat(255));
      mkdirSync(repo);
      cpSync(s.ledger.gen_dir, join(repo, 'gen'), { recursive: true });
      Object.assign(s.ledger, { repo, gen_dir: join(repo, 'gen'), engine_hash: 'old-engine' });
      r.output_root = join(oldRepo, 'out');
      const plan = JSON.parse(readFileSync(join(s.ledger.gen_dir, 'plan.json'), 'utf8')) as Plan;
      const m = 'M'.repeat(32);
      plan.packages = plan.packages.slice(0, 4).map((p, i) => ({
        ...p,
        id: `W${String(i)}`.padEnd(64, 'x'),
        milestone: m,
        title: '长标题'.repeat(1000),
      }));
      writeFileSync(join(s.ledger.gen_dir, 'plan.json'), JSON.stringify(plan));
      const wf = join(s.ledger.gen_dir, '.archon/workflows/sa-sa1/sa-sa1.yaml');
      writeFileSync(
        wf,
        `nodes:\n  - id: attempt-${m}\n` +
          [
            ...plan.packages.slice(0, 3).map(p => `settle-${p.id}`),
            hold === 'signoff'
              ? `human-${m}`
              : hold === 'review_limit'
                ? `gate-${m}-r3`
                : `verify-${plan.packages[3].id}`,
          ]
            .map(id => `  - id: ${id}\n`)
            .join('')
      );
      const node =
        hold === 'signoff'
          ? `human-${m}`
          : hold === 'review_limit'
            ? `gate-${m}-r3`
            : `verify-${plan.packages[3].id}`;
      r.nodes = [
        ...plan.packages.slice(0, 3).map(p => ({ nodeId: `settle-${p.id}`, state: 'completed' })),
        { nodeId: node, state: 'failed' },
      ];
      if (hold === 'review_limit') {
        put(`${node}.json`, { rounds: 3, reason: 'coder_redline+review_limit' });
        put(`${node}.ledger.json`, { blocking: [{ id: 'R1' }] });
      }
      const q = decisionQuestion(s.ledger, r, { state: 'held:gate', exit: 1, node }, hold);
      const policy = HOLD_POLICY[hold];
      expect(policy.do === 'ask' || policy.do === 'signoff').toBe(true);
      if (policy.do === 'ask' || policy.do === 'signoff') expect(q).toContain(policy.text);
      expect(q).toContain('已完成3/5节点');
      if (hold !== 'signoff') expect(q).toContain('将新开run从首个节点重跑');
      expect(q).toContain('是=');
      expect(q).toContain('否=终止整个run（保留证据）');
      expect(q).toMatch(/；\[sa:[a-f0-9]{32}\]$/);
      expect(Array.from(q).length).toBeLessThanOrEqual(200);
    }
  });
  test.each(['code', 'repair'])(
    'HF10 explicit retry at %s-W4 bumps only the package count',
    kind => {
      const { s, r, put } = bestIFA();
      const node = `${kind}-W4`;
      s.ledger.workflow_hash = engineHash();
      appendFileSync(
        join(s.ledger.gen_dir, '.archon/workflows/sa-sa1/sa-sa1.yaml'),
        '  - id: package-attempt-W4\n'
      );
      put(`${node}.json`, { reason: 'coder_redline' });
      r.nodes = [
        { nodeId: 'start-m1', state: 'completed' },
        { nodeId: node, state: 'failed' },
      ];
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(r));
      expect(captured(() => main(['decide', 'sa1', 'retry'])).code).toBe(0);
      expect(readFileSync(join(s.ledger.gen_dir, 'attempts/.packages/W4'), 'utf8')).toBe('1');
      expect(existsSync(join(s.ledger.gen_dir, 'attempts/m1'))).toBe(false);
      expect(s.calls()).toContain('workflow resume r --detach --json');
    }
  );
  test.each(['NaN', 'null', '-1', '1.5', '9007199254740991'])(
    'HF10 invalid or exhausted package counter %s fails without writing',
    raw => {
      const { s, r, put } = bestIFA();
      s.ledger.workflow_hash = engineHash();
      appendFileSync(
        join(s.ledger.gen_dir, '.archon/workflows/sa-sa1/sa-sa1.yaml'),
        '  - id: package-attempt-W4\n'
      );
      put('code-W4.json', { reason: 'coder_redline' });
      r.nodes = [{ nodeId: 'code-W4', state: 'failed' }];
      writeFileSync(ledgerPath('sa1'), JSON.stringify(s.ledger));
      writeFileSync(join(s.dir, 'get-000.json'), JSON.stringify(r));
      const path = join(s.ledger.gen_dir, 'attempts/.packages/W4');
      mkdirSync(join(s.ledger.gen_dir, 'attempts/.packages'), { recursive: true });
      writeFileSync(path, raw);
      expect(() => captured(() => main(['decide', 'sa1', 'retry']))).toThrow(/attempt counter/);
      expect(readFileSync(path, 'utf8')).toBe(raw);
      expect(existsSync(join(s.ledger.gen_dir, 'attempts/m1'))).toBe(false);
      expect(s.calls().some(c => c.startsWith('workflow resume'))).toBe(false);
    }
  );
});

describe('launch intents (run + supervise-tick reconcile)', () => {
  const tickOut = (): Record<string, unknown>[] =>
    JSON.parse(captured(() => main(['supervise-tick'])).out).actions as Record<string, unknown>[];
  /** 意图 sa2（工作流 sa-sa2），启动进程 pid、started_at 可调；archon.db 的 runs 表按 rows 建。 */
  const intent = (pid: number, rows: string[], startedAt = '2020-01-01T00:00:00.000Z') => {
    const s = stub([run('completed')]);
    const ledger = {
      ...s.ledger,
      run_id: 'sa2',
      archon_run_id: '',
      workflow: 'sa-sa2',
      started_at: startedAt,
    };
    mkdirSync(join(s.root, 'home', 'intents'), { recursive: true });
    const file = join(s.root, 'home', 'intents', 'sa2.json');
    writeFileSync(file, JSON.stringify({ ledger, host: hostname(), pid }));
    const db = new Database(join(s.root, 'home', 'archon', 'archon.db'));
    db.run(
      'create table remote_agent_workflow_runs (id text, workflow_name text, status text, metadata text)'
    );
    for (const id of rows)
      db.run("insert into remote_agent_workflow_runs values (?, 'sa-sa2', 'running', '{}')", [id]);
    db.close();
    return { ...s, file };
  };
  test('run writes the intent before starting and removes it once the ledger is saved', () => {
    const s = stub([]);
    const repo = featureRepo(s.root);
    fixtureSpies.push(spyOn(generatorModule, 'generate').mockImplementation(fastGenerate));
    process.env.SUPERAGENT_WRITE_ROOTS = s.root;
    const plan = fixturePlan(s.root, repo);
    const dir = join(s.root, 'home', 'intents');
    fixtureOptions(s.dir, { snapshotIntents: dir });
    expect(captured(() => main(['run', plan])).code).toBe(0);
    expect(readFileSync(join(s.root, 'at-run'), 'utf8').trim()).toMatch(
      /^\d{8}-\d{6}-[0-9a-f]{4}\.json$/
    );
    expect(readdirSync(dir)).toEqual([]);
  });
  test('a dead launcher whose archon run exists gets its ledger written; the intent goes away', () => {
    const s = intent(LOST.pid, ['r2']);
    expect(tickOut()[0]).toEqual({
      run_id: 'sa2',
      action: 'reconcile',
      ok: true,
      archon_run_id: 'r2',
    });
    expect(loadLedger('sa2')).toMatchObject({
      archon_run_id: 'r2',
      workflow: 'sa-sa2',
      reconciled_at: expect.any(String),
    });
    expect(existsSync(s.file)).toBe(false);
    expect(s.calls().filter(c => c.startsWith('workflow run'))).toEqual([]);
  });
  test('no archon run: concluded once on the intent, never restarted; a live or recent launcher is left alone', () => {
    const s = intent(LOST.pid, []);
    expect(tickOut()[0]).toMatchObject({
      run_id: 'sa2',
      action: 'reconcile',
      ok: false,
      reason: expect.stringContaining('superagent run'),
    });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))).toMatchObject({
      no_run_at: expect.any(String),
    });
    expect(tickOut().filter(x => x.run_id === 'sa2')).toEqual([]);
    expect(existsSync(ledgerPath('sa2'))).toBe(false);
    expect(s.calls().filter(c => c.startsWith('workflow run'))).toEqual([]);
    const live = intent(process.pid, ['r2']);
    expect(tickOut().filter(x => x.run_id === 'sa2')).toEqual([]);
    expect(existsSync(live.file)).toBe(true);
    const recent = intent(LOST.pid, ['r2'], new Date().toISOString());
    expect(tickOut().filter(x => x.run_id === 'sa2')).toEqual([]);
    expect(existsSync(recent.file)).toBe(true);
  });
  test('two archon runs with the same workflow name are not guessed: error, intent kept', () => {
    const s = intent(LOST.pid, ['r2', 'r3']);
    expect(tickOut()[0]).toMatchObject({
      run_id: 'sa2',
      action: 'error',
      error: expect.stringContaining('2 archon runs'),
    });
    expect(existsSync(s.file)).toBe(true);
  });
});

describe('lock (flock, real processes)', () => {
  const SRC = JSON.stringify(join(import.meta.dir, '..', 'src', 'archon.ts'));
  /** 子进程：取锁后打印 ok，再执行 body；readLine 读子进程 stdout 的下一行。 */
  function child(path: string, body: string, pre = '') {
    const p = Bun.spawn(
      [
        'bun',
        '-e',
        `const { lock } = await import(${SRC}); ${pre} const l = lock(${JSON.stringify(path)}); console.log(l.ok); ${body}`,
      ],
      { stdout: 'pipe', stderr: 'inherit' }
    );
    const reader = p.stdout.getReader();
    let buf = '';
    const readLine = async (): Promise<string> => {
      while (!buf.includes('\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`child exited before a line: ${buf}`);
        buf += new TextDecoder().decode(value);
      }
      const line = buf.slice(0, buf.indexOf('\n'));
      buf = buf.slice(line.length + 1);
      return line;
    };
    return { p, readLine };
  }
  test('while a child process holds the lock, the parent gets locked', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, 'await Bun.sleep(60_000);');
    try {
      expect(await c.readLine()).toBe('true');
      expect(archonMod.lock(path)).toEqual({ ok: false, reason: 'locked' });
    } finally {
      c.p.kill('SIGKILL');
      await c.p.exited;
    }
  });
  test('once the holder is SIGKILLed the parent gets the lock immediately', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, 'await Bun.sleep(60_000);');
    expect(await c.readLine()).toBe('true');
    c.p.kill('SIGKILL');
    await c.p.exited;
    const l = archonMod.lock(path);
    expect(l.ok).toBe(true);
    if (l.ok) l.release();
  });
  test('three concurrent processes each holding 300ms: exactly one gets the lock', async () => {
    const root = tmp();
    const path = join(root, 'x.lock');
    const go = join(root, 'go');
    // 三个子进程都就绪后同时放行，持锁 300ms 覆盖其余两个的尝试
    const wait = `console.log('ready'); while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);`;
    const cs = [0, 1, 2].map(() => child(path, 'await Bun.sleep(300);', wait));
    for (const c of cs) expect(await c.readLine()).toBe('ready');
    writeFileSync(go, '');
    const got = await Promise.all(cs.map(c => c.readLine()));
    await Promise.all(cs.map(c => c.p.exited));
    expect(got.filter(x => x === 'true')).toHaveLength(1);
    expect(got.filter(x => x === 'false')).toHaveLength(2);
  });
  test('after release (holder still alive) another process gets the lock', async () => {
    const path = join(tmp(), 'x.lock');
    const c = child(path, "l.release(); console.log('released'); await Bun.sleep(60_000);");
    try {
      expect(await c.readLine()).toBe('true');
      expect(await c.readLine()).toBe('released');
      const l = archonMod.lock(path);
      expect(l.ok).toBe(true);
      if (l.ok) l.release();
    } finally {
      c.p.kill('SIGKILL');
      await c.p.exited;
    }
  });
});

test.each(['verify-a', 'settle-a', 'diff-m1-r3', 'gate-m1-r3'])(
  'NO_HOLD failed %s is terminal without a hold',
  nodeId => {
    const r = run('failed', { nodes: [{ nodeId, state: 'failed' }] });
    const c = classify(r);
    expect(c).toEqual({ state: 'failed', exit: EXIT.failed, node: nodeId });
    expect(cliMod.holdOf({} as Ledger, r, c)).toBeUndefined();
  }
);

// prettier-ignore
test('last_activity aggregates adopted runs and exposes missing history honestly', () => {
  const ledger = { archon_run_id: 'new', repo: '/repo', adoptions: [{ from: 'old', to: 'new', at: '', engine_from: null, engine_to: '', reason: '' }] };
  const row = (id: string, type: string, at: string) => ({ id: 'e', workflow_run_id: id, event_type: type, step_name: 'code', step_index: null, created_at: at, data: {} });
  const old = row('old', 'tool_called', '2026-10-16T01:00:00Z');
  const query = (args: string[]) => ({ events: args[2] === 'old' ? [old] : [] });
  expect(cliMod.lastActivity(ledger, query)).toEqual({ latest: { run_id: 'old', node: 'code', at: old.created_at, type: 'tool_called' }, complete: true, missing: [] });
  const current = { ...row('new', 'provider_event', '2026-10-16T02:00:01Z'), data: { attemptId: 'a', seq: 1, observedAt: '2026-10-16T02:00:00Z', event: { type: 'agent_message_chunk', text: 'PRIVATE' } } };
  const activity = cliMod.lastActivity(ledger, args => ({ events: args[2] === 'new' ? [current] : [old] }));
  expect(activity.latest?.run_id).toBe('new');
  expect(activity.latest?.type).toBe('agent_message_chunk');
  expect(JSON.stringify(activity)).not.toContain('PRIVATE');
  expect(cliMod.lastActivity(ledger, () => { throw new Error('offline'); })).toEqual({ latest: null, complete: false, missing: ['old', 'new'] });
});

// prettier-ignore
test('E2BIG preflight gate failure is engine evidence, never a review verdict', () => {
  const failed = run('failed', { nodes: [{ nodeId: 'gate-m1', state: 'failed', error: 'engine_execution_boundary: oversized INPUTS_C1' }] });
  const s = stub([failed]);
  expect(classifyRun(s.ledger, failed).state).toBe('held:engine_suspect');
});

// prettier-ignore
test('reclaim command prints the structured one-shot result', () => {
  stub([]);
  const result = captured(() => main(['reclaim', '--json']));
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({
    transferred: [],
    unclaimed: [],
    skipped: [],
    skip_reasons: {},
    pending: [],
    historical: [],
  });
});
